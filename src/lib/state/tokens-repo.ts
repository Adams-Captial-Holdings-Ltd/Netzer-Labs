import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createHash, randomBytes } from 'node:crypto';
import { ddb } from './ddb.js';
import { publishInvalidation } from '../config/invalidation-publisher.js';
import { teardownSessionsForToken } from '../voice/session-registry.js';

const TABLE = process.env.TABLE_DASHBOARD_TOKENS ?? 'claudeclaw-dashboard-tokens';

/**
 * Operator roles, least → most privileged.
 *  - viewer:   read-only (GET endpoints)
 *  - operator: day-to-day mutations (agents, missions, vectors, GDPR export)
 *  - admin:    security controls (kill switches, panic, DLP, token mgmt)
 *
 * Legacy tokens written before roles existed have no `role` attribute and
 * are treated as `admin` so existing operators are never locked out of the
 * controls they relied on. Re-issue scoped tokens to tighten them.
 */
export type TokenRole = 'viewer' | 'operator' | 'admin';
export const TOKEN_ROLES: readonly TokenRole[] = ['viewer', 'operator', 'admin'];
const LEGACY_ROLE: TokenRole = 'admin';

export function isTokenRole(v: unknown): v is TokenRole {
  return typeof v === 'string' && (TOKEN_ROLES as readonly string[]).includes(v);
}

function coerceRole(raw: unknown): TokenRole {
  return isTokenRole(raw) ? raw : LEGACY_ROLE;
}

export interface TokenRecord {
  tokenHash: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  createdBy: string;
  active: boolean;
  role: TokenRole;
  /** ISO timestamp after which the token is rejected. Omitted = never. */
  expiresAt?: string;
  /**
   * Wave 4a multi-user: the user this session token was minted for, and the
   * RBAC profile that was in effect at mint time. Both omitted on legacy
   * per-operator tokens and on the env root token (which is owner by env, not
   * by a user row). Carried so revokeTokensForUser() can find every live
   * session for a user on disable / role downgrade, and so dashboard-auth can
   * resolve a session straight to user+profile.
   */
  userId?: string;
  profileId?: string;
}

export interface TokenPrincipal {
  tokenHash: string;
  label: string;
  hashPrefix16: string;
  role: TokenRole;
  expiresAt?: string;
  /** Wave 4a: user + RBAC profile when this principal came from a user session. */
  userId?: string;
  profileId?: string;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** True if a record/principal carries an expiry that is in the past. */
export function isExpired(t: { expiresAt?: string }, now = Date.now()): boolean {
  if (!t.expiresAt) return false;
  const ts = Date.parse(t.expiresAt);
  return Number.isFinite(ts) && ts <= now;
}

export async function lookupToken(tokenHash: string): Promise<TokenRecord | null> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND SK = :sk',
      ExpressionAttributeValues: {
        ':pk': `TOKEN#${tokenHash}`,
        ':sk': 'META',
      },
      ConsistentRead: true,
    }),
  );
  const item = out.Items?.[0];
  if (!item) return null;
  return mapTokenItem(item);
}

export async function touchLastUsed(tokenHash: string): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `TOKEN#${tokenHash}`, SK: 'META' },
      UpdateExpression: 'SET lastUsedAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }),
  ).catch(() => {});
}

/**
 * Wave 4a: bind a session token to a user + RBAC profile. Passed to createToken
 * by the magic-link accept/verify flows. Omitted by legacy per-operator tokens.
 *
 * GSI2 (gsi2-user) is keyed GSI2PK=USER#<userId> so revokeTokensForUser() can
 * find every live session for a user without a full table scan. We only stamp
 * the GSI keys when a userId is supplied, so legacy/system tokens stay out of
 * the per-user index.
 */
export interface SessionUserBinding {
  userId: string;
  profileId: string;
}

export async function createToken(
  label: string,
  createdBy: string,
  role: TokenRole = 'operator',
  expiresInDays?: number,
  binding?: SessionUserBinding,
): Promise<{ raw: string; record: TokenRecord }> {
  const raw = randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const now = new Date().toISOString();
  const safeRole = isTokenRole(role) ? role : 'operator';
  let expiresAt: string | undefined;
  let ttlEpoch: number | undefined;
  if (expiresInDays && expiresInDays > 0) {
    const ms = Date.now() + expiresInDays * 86_400_000;
    expiresAt = new Date(ms).toISOString();
    // DDB TTL is GC only (can lag ~48h); expiry is enforced in auth code.
    ttlEpoch = Math.floor(ms / 1000);
  }
  const userFields = binding
    ? {
        userId: binding.userId,
        profileId: binding.profileId,
        // Per-user revocation index: see revokeTokensForUser.
        GSI2PK: `USER#${binding.userId}`,
        GSI2SK: `TOKEN#${tokenHash}`,
      }
    : {};
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `TOKEN#${tokenHash}`,
        SK: 'META',
        tokenHash,
        label,
        createdAt: now,
        lastUsedAt: now,
        createdBy,
        active: true,
        role: safeRole,
        ...(expiresAt ? { expiresAt } : {}),
        ...(ttlEpoch ? { ttl: ttlEpoch } : {}),
        ...userFields,
      },
    }),
  );
  return {
    raw,
    record: {
      tokenHash,
      label,
      createdAt: now,
      lastUsedAt: now,
      createdBy,
      active: true,
      role: safeRole,
      ...(expiresAt ? { expiresAt } : {}),
      ...(binding ? { userId: binding.userId, profileId: binding.profileId } : {}),
    },
  };
}

export async function seedRootToken(envToken: string): Promise<void> {
  const tokenHash = hashToken(envToken);
  const existing = await lookupToken(tokenHash);
  if (existing) return;
  const now = new Date().toISOString();
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `TOKEN#${tokenHash}`,
        SK: 'META',
        tokenHash,
        label: 'Root token',
        createdAt: now,
        lastUsedAt: now,
        createdBy: 'system',
        active: true,
        role: 'admin',
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  ).catch(() => {});
}

export async function listTokens(): Promise<TokenRecord[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :type',
      ExpressionAttributeValues: { ':type': 'TOKEN_LIST' },
      ScanIndexForward: false,
    }),
  ).catch(() => ({ Items: [] as Record<string, unknown>[] }));
  // Fallback: scan if GSI doesn't exist yet
  if (!out.Items?.length) {
    const scan = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: { ':pk': 'TOKEN_LIST', ':sk': 'ALL' },
      }),
    ).catch(() => ({ Items: [] as Record<string, unknown>[] }));
    if (!scan.Items?.length) {
      // Use scan as last resort
      const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
      const scanResult = await ddb().send(
        new ScanCommand({
          TableName: TABLE,
          FilterExpression: 'SK = :sk',
          ExpressionAttributeValues: { ':sk': 'META' },
        }),
      );
      return (scanResult.Items ?? []).map(mapTokenItem);
    }
  }
  return (out.Items ?? []).map(mapTokenItem);
}

function mapTokenItem(i: Record<string, unknown>): TokenRecord {
  return {
    tokenHash: i.tokenHash as string,
    label: i.label as string,
    createdAt: i.createdAt as string,
    lastUsedAt: i.lastUsedAt as string,
    createdBy: i.createdBy as string,
    active: i.active as boolean,
    role: coerceRole(i.role),
    ...(i.expiresAt ? { expiresAt: i.expiresAt as string } : {}),
    ...(typeof i.userId === 'string' ? { userId: i.userId } : {}),
    ...(typeof i.profileId === 'string' ? { profileId: i.profileId } : {}),
  };
}

export async function revokeToken(tokenHash: string): Promise<boolean> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `TOKEN#${tokenHash}`, SK: 'META' },
        UpdateExpression: 'SET active = :f',
        ExpressionAttributeValues: { ':f': false },
        ConditionExpression: 'attribute_exists(PK)',
      }),
    );
    // Jarvis H4: fan out a token_revoked invalidation so peer tasks drop any
    // live voice session for this tokenHash, and tear down our own immediately.
    void publishInvalidation('token_revoked', tokenHash);
    void teardownSessionsForToken(tokenHash, 'token_revoked');
    return true;
  } catch {
    return false;
  }
}

/**
 * Find every session token bound to a user. Uses the per-user GSI (gsi2-user,
 * GSI2PK=USER#<userId>); falls back to a filtered scan when the index is not
 * provisioned yet (mirrors listTokens' GSI→scan fallback). Returns the token
 * hashes. Never throws — returns [] on any read failure so a caller can still
 * proceed to disable the user even if the index is unreachable.
 */
async function tokenHashesForUser(userId: string): Promise<string[]> {
  const fromIndex = await ddb()
    .send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'gsi2-user',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': `USER#${userId}` },
      }),
    )
    .catch(() => null);
  if (fromIndex?.Items?.length) {
    return fromIndex.Items.map((i) => i.tokenHash as string).filter(Boolean);
  }
  // Index absent or empty — fall back to a scan filtered by userId. This is a
  // rare admin path (disable / role downgrade), so the scan cost is acceptable.
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
  const scan = await ddb()
    .send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'userId = :uid AND SK = :sk',
        ExpressionAttributeValues: { ':uid': userId, ':sk': 'META' },
      }),
    )
    .catch(() => ({ Items: [] as Record<string, unknown>[] }));
  return (scan.Items ?? []).map((i) => i.tokenHash as string).filter(Boolean);
}

/**
 * Revoke EVERY live session token for a user. Called on disable and on role
 * downgrade so a now-less-privileged (or disabled) user cannot keep operating
 * on a session minted under their old profile. Revokes each token through the
 * same path as revokeToken so the per-token invalidation + voice-session
 * teardown fan out for each. Returns the count revoked. Never throws.
 */
export async function revokeTokensForUser(userId: string): Promise<number> {
  if (!userId) return 0;
  const hashes = await tokenHashesForUser(userId);
  let revoked = 0;
  for (const hash of hashes) {
    if (await revokeToken(hash)) revoked += 1;
  }
  return revoked;
}
