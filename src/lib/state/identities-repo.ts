/**
 * Identities repo — cross-surface identity claim (C4).
 *
 * One canonical user can span Telegram chats and Slack user ids
 * (WhatsApp later). The mapping lets the memory + session layers
 * use a single namespace per real person instead of one per surface.
 *
 * Schema:
 *
 *   Forward link (surface → canonical):
 *     PK = SURFACE#<surface>#<surfaceUserId>
 *     SK = CLAIM
 *     canonicalId, claimedAt, surface, surfaceUserId
 *
 *   Reverse link (canonical → surface). Used to list every surface a
 *   canonical user has bound, for the "what do you know about me"
 *   flow:
 *     PK = CANONICAL#<canonicalId>
 *     SK = SURFACE#<surface>#<surfaceUserId>
 *
 *   Pending claim code (TTL 10 min):
 *     PK = CODE#<code>
 *     SK = STATE
 *     surface, surfaceUserId, canonicalId, expiresAt, ttl
 *
 * The claim flow is:
 *   1. User on surface A says "claim my identity" → startClaim()
 *      generates a 6-digit code, writes a pending row, returns the
 *      code to the user.
 *   2. User on surface B (already linked to canonicalId X, or a new
 *      surface that creates X) says "complete claim 123456" →
 *      completeClaim() consumes the pending row and writes both the
 *      forward and reverse links binding A to X.
 *
 * A canonical id is generated on first claim and persists across
 * surfaces. The bot uses `resolveCanonical()` at the top of every
 * adapter handler to rewrite the chatId before it touches downstream
 * code, so memories and sessions are stored against the canonical id.
 *
 * Rollback: CCE_IDENTITY_RESOLUTION_DISABLED=1 forces
 * resolveCanonical() to return undefined, which makes adapters fall
 * back to the legacy per-surface chatId shape.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { logger } from '../../observability/logger.js';

const TABLE = process.env.TABLE_IDENTITIES ?? 'claudeclaw-identities';

export type IdentitySurface = 'telegram' | 'slack' | 'whatsapp';

export interface ClaimedLink {
  canonicalId: string;
  surface: IdentitySurface;
  surfaceUserId: string;
  claimedAt: string;
}

export interface PendingClaim {
  code: string;
  /** Canonical id the claim will bind TO. If the originating surface
   * has not been canonicalized yet, we generate one here so the user
   * who starts the claim also gets a canonical id (single-surface
   * mode). */
  canonicalId: string;
  surface: IdentitySurface;
  surfaceUserId: string;
  expiresAt: string;
}

const CODE_TTL_SEC = 10 * 60;
const CODE_LEN = 6;

function isDisabled(): boolean {
  return process.env.CCE_IDENTITY_RESOLUTION_DISABLED === '1';
}

function generateCode(): string {
  // 6 digit code, leading zeros allowed. Even distribution.
  const buf = randomBytes(4).readUInt32BE(0) % 10 ** CODE_LEN;
  return String(buf).padStart(CODE_LEN, '0');
}

/**
 * Look up the canonical id for a (surface, surfaceUserId) pair.
 * Returns undefined when there is no link (the caller should fall
 * back to the legacy per-surface chatId).
 */
export async function resolveCanonical(
  surface: IdentitySurface,
  surfaceUserId: string,
): Promise<string | undefined> {
  if (isDisabled()) return undefined;
  try {
    const out = await ddb().send(
      new GetCommand({
        TableName: TABLE,
        Key: { PK: `SURFACE#${surface}#${surfaceUserId}`, SK: 'CLAIM' },
      }),
    );
    const item = out.Item;
    if (!item || typeof item.canonicalId !== 'string') return undefined;
    return item.canonicalId;
  } catch (err) {
    logger.warn(
      {
        surface,
        surfaceUserId,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      'identities resolve failed; falling back to surface chatId',
    );
    return undefined;
  }
}

/**
 * Start a new claim. Generates a code that the user pastes on the
 * OTHER surface to bind the two together. If the originating surface
 * already has a canonical id, the new pending claim reuses it (the
 * code lets a new surface join the existing canonical). Otherwise we
 * mint a fresh canonical id now.
 */
export async function startClaim(args: {
  surface: IdentitySurface;
  surfaceUserId: string;
}): Promise<PendingClaim> {
  const existing = await resolveCanonical(args.surface, args.surfaceUserId);
  const canonicalId = existing ?? randomUUID();
  const code = generateCode();
  const expiresAtMs = Date.now() + CODE_TTL_SEC * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `CODE#${code}`,
        SK: 'STATE',
        code,
        canonicalId,
        surface: args.surface,
        surfaceUserId: args.surfaceUserId,
        expiresAt,
        ttl: Math.floor(expiresAtMs / 1000),
      },
    }),
  );
  return {
    code,
    canonicalId,
    surface: args.surface,
    surfaceUserId: args.surfaceUserId,
    expiresAt,
  };
}

/**
 * Complete a pending claim from a different surface. Looks up the
 * code, validates it has not expired, and writes both link rows
 * binding the new surface to the existing canonical id. The pending
 * row is deleted on success so the code cannot be replayed.
 */
export async function completeClaim(args: {
  code: string;
  surface: IdentitySurface;
  surfaceUserId: string;
}): Promise<{ ok: true; canonicalId: string } | { ok: false; reason: string }> {
  const code = args.code.trim();
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, reason: 'code must be a 6-digit number' };
  }
  const out = await ddb().send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `CODE#${code}`, SK: 'STATE' },
    }),
  );
  const pending = out.Item as PendingClaim | undefined;
  if (!pending) return { ok: false, reason: 'unknown or expired code' };
  if (
    pending.surface === args.surface &&
    pending.surfaceUserId === args.surfaceUserId
  ) {
    return {
      ok: false,
      reason: 'complete the claim from a different surface than the one that started it',
    };
  }
  const expiresAtMs = Date.parse(pending.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) {
    return { ok: false, reason: 'code expired; ask the bot for a new one' };
  }

  const canonicalId = pending.canonicalId;
  const now = new Date().toISOString();

  // Write both link rows for the SOURCE surface (the one that started
  // the claim) and the TARGET surface (the one completing it).
  const sourceLink: ClaimedLink = {
    canonicalId,
    surface: pending.surface,
    surfaceUserId: pending.surfaceUserId,
    claimedAt: now,
  };
  const targetLink: ClaimedLink = {
    canonicalId,
    surface: args.surface,
    surfaceUserId: args.surfaceUserId,
    claimedAt: now,
  };
  await Promise.all([
    ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `SURFACE#${sourceLink.surface}#${sourceLink.surfaceUserId}`,
          SK: 'CLAIM',
          ...sourceLink,
        },
      }),
    ),
    ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `SURFACE#${targetLink.surface}#${targetLink.surfaceUserId}`,
          SK: 'CLAIM',
          ...targetLink,
        },
      }),
    ),
    ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `CANONICAL#${canonicalId}`,
          SK: `SURFACE#${sourceLink.surface}#${sourceLink.surfaceUserId}`,
          ...sourceLink,
        },
      }),
    ),
    ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `CANONICAL#${canonicalId}`,
          SK: `SURFACE#${targetLink.surface}#${targetLink.surfaceUserId}`,
          ...targetLink,
        },
      }),
    ),
    // Burn the pending code so it cannot be replayed.
    ddb().send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `CODE#${code}`, SK: 'STATE' },
      }),
    ),
  ]);
  return { ok: true, canonicalId };
}

/**
 * List every surface link bound to a canonical user. Used for the
 * "what surfaces do I have linked" tool and for memory consolidation.
 */
export async function listLinks(canonicalId: string): Promise<ClaimedLink[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `CANONICAL#${canonicalId}`,
        ':prefix': 'SURFACE#',
      },
    }),
  );
  return (out.Items ?? []).map((i) => ({
    canonicalId,
    surface: i.surface as IdentitySurface,
    surfaceUserId: String(i.surfaceUserId ?? ''),
    claimedAt: String(i.claimedAt ?? ''),
  }));
}
