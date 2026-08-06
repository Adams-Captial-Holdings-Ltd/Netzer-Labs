/**
 * Users repo — Wave 4a multi-user + RBAC (single self-hosted deployment).
 *
 * Login is TRUE MAGIC-LINK PASSWORDLESS. NO passwords are ever stored, NO
 * argon2/bcrypt, NO credential items. The only secret material this repo
 * touches is a magic-link token, and even that lives here only as a sha256
 * hash — the raw token exists solely inside the emailed link.
 *
 * Single-table design on the ONE `claudeclaw-users` table. Two item shapes
 * are co-located:
 *
 *   User profile (one per user):
 *     PK     = USER#<uuid>
 *     SK     = PROFILE
 *     GSI1PK = EMAIL#<emailLower>   GSI1SK = USER   (index `gsi1-email`)
 *     fields: userId, email, emailLower, profileId (RBAC role/profile id),
 *             status in {invited,active,disabled}, invitedBy, invitedAt,
 *             activatedAt, lastLoginAt, disabledAt.
 *
 *   Magic-link token (invite or login; single-use):
 *     PK = MAGIC#<sha256(rawToken)>   SK = STATE
 *     fields: userId, purpose in {invite,login}, createdAt, expiresAt,
 *             ttl = floor(expiresAt/1000), consumedAt.
 *
 * There is NO separate invitations table — invites are just a user row in
 * status=invited plus a magic token row with purpose=invite. The `ttl`
 * attribute is a GC backstop only: single-use is enforced by a conditional
 * write on consumedAt, and expiry is enforced in code, not by relying on
 * DynamoDB's async TTL deletion. This mirrors the tokens-repo / identities-repo
 * conventions (lib-dynamodb DocumentClient via ddb(), PK/SK prefix handled
 * internally, ConsistentRead on point lookups of security-sensitive rows).
 *
 * The per-user SESSION token (carrying userId+profileId) is NOT stored here;
 * it lives in `claudeclaw-dashboard-tokens` (tokens-repo). Revocation of a
 * user's sessions on disable / role-downgrade is the caller's job via
 * tokens-repo.revokeTokensForUser(userId); see contractNotes.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { logger } from '../../observability/logger.js';

const TABLE = process.env.TABLE_USERS ?? 'claudeclaw-users';

/** GSI that lets us resolve a login email → user row. Mirrors the CDK
 * `gsi1-email` index on the users table (GSI1PK/GSI1SK, projection ALL). */
const EMAIL_INDEX = 'gsi1-email';

const PROFILE_SK = 'PROFILE';
const MAGIC_SK = 'STATE';
/** Constant GSI1 sort key for profile rows — one user per email, so the sort
 * key is fixed and the email partition holds at most one item. */
const EMAIL_GSI_SK = 'USER';

/** Invite magic links live for 72h; login magic links for 15m. */
export const INVITE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

export type UserStatus = 'invited' | 'active' | 'disabled';
export const USER_STATUSES: readonly UserStatus[] = ['invited', 'active', 'disabled'];

export type MagicPurpose = 'invite' | 'login';
export const MAGIC_PURPOSES: readonly MagicPurpose[] = ['invite', 'login'];

export interface UserProfile {
  userId: string;
  email: string;
  emailLower: string;
  /** RBAC profile/role id (templated owner/admin/... or a custom profile id). */
  profileId: string;
  status: UserStatus;
  invitedBy: string;
  invitedAt: string;
  /** Set when the invite is accepted (status → active). */
  activatedAt?: string;
  /** Set on every successful login/verify. */
  lastLoginAt?: string;
  /** Set when the user is disabled (status → disabled). */
  disabledAt?: string;
}

export interface MagicToken {
  /** sha256(rawToken) — the lookup key. The raw token is never stored. */
  tokenHash: string;
  userId: string;
  purpose: MagicPurpose;
  createdAt: string;
  expiresAt: string;
  /** Set the moment the token is consumed; single-use is enforced on this. */
  consumedAt?: string;
}

function userPk(userId: string): string {
  return `USER#${userId}`;
}

function magicPk(tokenHash: string): string {
  return `MAGIC#${tokenHash}`;
}

function emailGsiPk(emailLower: string): string {
  return `EMAIL#${emailLower}`;
}

/** Normalize an email for the GSI lookup: trimmed + lowercased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** sha256 hex of the raw magic-link token. Only the hash is ever persisted. */
export function hashMagicToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function isMagicPurpose(v: unknown): v is MagicPurpose {
  return typeof v === 'string' && (MAGIC_PURPOSES as readonly string[]).includes(v);
}

function isUserStatus(v: unknown): v is UserStatus {
  return typeof v === 'string' && (USER_STATUSES as readonly string[]).includes(v);
}

/** Map a raw profile DDB item to a clean UserProfile, dropping key attrs. */
function toUserProfile(item: Record<string, unknown>): UserProfile {
  return {
    userId: String(item.userId ?? ''),
    email: String(item.email ?? ''),
    emailLower: String(item.emailLower ?? ''),
    profileId: String(item.profileId ?? ''),
    status: isUserStatus(item.status) ? item.status : 'disabled',
    invitedBy: String(item.invitedBy ?? ''),
    invitedAt: String(item.invitedAt ?? ''),
    ...(item.activatedAt ? { activatedAt: String(item.activatedAt) } : {}),
    ...(item.lastLoginAt ? { lastLoginAt: String(item.lastLoginAt) } : {}),
    ...(item.disabledAt ? { disabledAt: String(item.disabledAt) } : {}),
  };
}

function toMagicToken(item: Record<string, unknown>): MagicToken {
  return {
    tokenHash: String(item.tokenHash ?? ''),
    userId: String(item.userId ?? ''),
    purpose: isMagicPurpose(item.purpose) ? item.purpose : 'login',
    createdAt: String(item.createdAt ?? ''),
    expiresAt: String(item.expiresAt ?? ''),
    ...(item.consumedAt ? { consumedAt: String(item.consumedAt) } : {}),
  };
}

/** True if a token's expiresAt is in the past (code-enforced expiry; the TTL
 * attribute is only a GC backstop). */
export function isMagicTokenExpired(t: { expiresAt?: string }, now = Date.now()): boolean {
  if (!t.expiresAt) return true;
  const ts = Date.parse(t.expiresAt);
  return !Number.isFinite(ts) || ts <= now;
}

/**
 * Create a user invite: writes the USER profile row (status=invited) and a
 * MAGIC token row (purpose=invite). Returns the new user plus the RAW token
 * — the only place the raw token ever exists. The caller emails a link
 * <DASHBOARD_URL>/accept?token=<raw> built from server config (never from a
 * request Host header) and audits the action.
 *
 * The profile write is conditioned on the email not already being taken
 * (one active row per email via the GSI), and the magic write on a hash
 * collision being impossible — both throw ConditionalCheckFailedException
 * on conflict so the caller can surface a clean error.
 */
export async function createUserInvite(args: {
  userId: string;
  email: string;
  profileId: string;
  invitedBy: string;
  ttlMs?: number;
  now?: number;
}): Promise<{ user: UserProfile; rawToken: string; token: MagicToken }> {
  const emailLower = normalizeEmail(args.email);
  if (!emailLower) {
    throw new Error('createUserInvite: email is required');
  }
  const nowMs = args.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Enforce one user per email up front. The profile PutCommand below is
  // conditioned on the USER# PK being new, but two different userIds for the
  // SAME email would both pass that check, so we guard on the GSI first.
  const existing = await getUserByEmail(emailLower);
  if (existing) {
    throw new Error(`createUserInvite: a user already exists for ${emailLower}`);
  }

  const user: UserProfile = {
    userId: args.userId,
    email: args.email.trim(),
    emailLower,
    profileId: args.profileId,
    status: 'invited',
    invitedBy: args.invitedBy,
    invitedAt: nowIso,
  };

  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: userPk(user.userId),
        SK: PROFILE_SK,
        GSI1PK: emailGsiPk(emailLower),
        GSI1SK: EMAIL_GSI_SK,
        ...user,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );

  const expiresAtMs = nowMs + (args.ttlMs ?? INVITE_TOKEN_TTL_MS);
  const { rawToken, token } = await createMagicToken({
    userId: user.userId,
    purpose: 'invite',
    expiresAtMs,
    now: nowMs,
  });

  logger.info({ userId: user.userId, profileId: user.profileId }, 'user invited');
  return { user, rawToken, token };
}

/**
 * Mint a magic-link token for an EXISTING user (login flow, or a re-issued
 * invite). Generates randomBytes(32) hex, stores ONLY the sha256 hash with a
 * `ttl` GC backstop, and returns the raw token for the emailed link. The
 * write is conditioned on the hash PK being new (a 256-bit collision is
 * effectively impossible; the guard is belt-and-suspenders against replay of
 * a hash that somehow already exists).
 */
export async function createMagicToken(args: {
  userId: string;
  purpose: MagicPurpose;
  expiresAtMs: number;
  now?: number;
}): Promise<{ rawToken: string; token: MagicToken }> {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashMagicToken(rawToken);
  const nowMs = args.now ?? Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(args.expiresAtMs).toISOString();
  const token: MagicToken = {
    tokenHash,
    userId: args.userId,
    purpose: args.purpose,
    createdAt,
    expiresAt,
  };
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: magicPk(tokenHash),
        SK: MAGIC_SK,
        ...token,
        // GC backstop only; expiry + single-use are enforced in code.
        ttl: Math.floor(args.expiresAtMs / 1000),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  return { rawToken, token };
}

/**
 * Look up a magic token by its RAW value (hashed here, never logged). Returns
 * null when the hash is unknown. Callers MUST still check expiry/consumption
 * (use consumeMagicToken for the single-use path). Point lookup is consistent
 * so the consume path immediately sees its own writes.
 */
export async function getMagicToken(rawToken: string): Promise<MagicToken | null> {
  const tokenHash = hashMagicToken(rawToken);
  const out = await ddb().send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: magicPk(tokenHash), SK: MAGIC_SK },
      ConsistentRead: true,
    }),
  );
  if (!out.Item) return null;
  return toMagicToken(out.Item as Record<string, unknown>);
}

/**
 * Consume a magic token single-use by its RAW value. Atomically stamps
 * consumedAt with a conditional write that requires the token to (a) exist,
 * (b) not already be consumed, and (c) not be expired (expiresAt > now). On
 * success returns the consumed token; on any failed precondition returns null
 * so the caller responds with a single, identical "invalid or expired" error
 * (no oracle that distinguishes missing vs expired vs replayed).
 *
 * Single-use is the conditional write, not the TTL: even if DynamoDB's async
 * TTL sweep lags, a replayed token fails the attribute_not_exists(consumedAt)
 * guard.
 */
export async function consumeMagicToken(
  rawToken: string,
  opts?: { purpose?: MagicPurpose; now?: number },
): Promise<MagicToken | null> {
  const tokenHash = hashMagicToken(rawToken);
  const nowMs = opts?.now ?? Date.now();
  const consumedAt = new Date(nowMs).toISOString();
  const nowIso = consumedAt;
  try {
    const out = await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: magicPk(tokenHash), SK: MAGIC_SK },
        UpdateExpression: 'SET consumedAt = :c',
        ConditionExpression:
          'attribute_exists(PK) AND attribute_not_exists(consumedAt) AND expiresAt > :now' +
          (opts?.purpose ? ' AND purpose = :purpose' : ''),
        ExpressionAttributeValues: {
          ':c': consumedAt,
          ':now': nowIso,
          ...(opts?.purpose ? { ':purpose': opts.purpose } : {}),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    if (!out.Attributes) return null;
    return toMagicToken(out.Attributes as Record<string, unknown>);
  } catch (err) {
    // ConditionalCheckFailedException = unknown / expired / already-consumed /
    // wrong-purpose. All collapse to "invalid" by design (no enumeration
    // oracle). Anything else is a real DDB fault and is surfaced.
    const name = (err as { name?: string })?.name;
    if (name === 'ConditionalCheckFailedException') return null;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'consumeMagicToken failed (non-conditional)',
    );
    throw err;
  }
}

/**
 * Resolve a user by email via the `gsi1-email` GSI. Accepts a raw or already
 * normalized email; normalizes internally. Returns null when no user exists.
 */
export async function getUserByEmail(email: string): Promise<UserProfile | null> {
  const emailLower = normalizeEmail(email);
  if (!emailLower) return null;
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: EMAIL_INDEX,
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK = :sk',
      ExpressionAttributeValues: {
        ':pk': emailGsiPk(emailLower),
        ':sk': EMAIL_GSI_SK,
      },
      Limit: 1,
    }),
  );
  const item = out.Items?.[0];
  if (!item) return null;
  return toUserProfile(item as Record<string, unknown>);
}

/** Fetch a single user profile by id. Returns null when not found. */
export async function getUser(userId: string): Promise<UserProfile | null> {
  const out = await ddb().send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: userPk(userId), SK: PROFILE_SK },
      ConsistentRead: true,
    }),
  );
  if (!out.Item) return null;
  return toUserProfile(out.Item as Record<string, unknown>);
}

/**
 * List every user profile. Filters to SK = PROFILE so co-located MAGIC token
 * rows are never returned. Used by the members admin list. (Scan is fine here:
 * the member roster of a single self-hosted deployment is small; mirrors how
 * agents-repo lists agents.)
 */
export async function listUsers(): Promise<UserProfile[]> {
  const out = await ddb().send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': PROFILE_SK },
    }),
  );
  return (out.Items ?? []).map((i) => toUserProfile(i as Record<string, unknown>));
}

/**
 * Set a user's RBAC profile id (role change). Bumps the row. The CALLER is
 * responsible for the privilege checks (granted caps ⊆ actor caps, no
 * self-change) and for calling tokens-repo.revokeTokensForUser(userId) on a
 * downgrade so existing sessions cannot retain the old, higher capability set.
 * Conditioned on the user existing.
 */
export async function setUserProfileId(userId: string, profileId: string): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: userPk(userId), SK: PROFILE_SK },
      UpdateExpression: 'SET profileId = :p',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':p': profileId },
    }),
  );
  logger.info({ userId, profileId }, 'user profile (role) changed');
}

/**
 * Mark the invite as accepted: flips status invited → active and stamps
 * activatedAt. Conditioned so it only fires from the `invited` state, making
 * the accept step idempotent-safe against a double POST. Returns the updated
 * profile, or null if the condition failed (already active/disabled/missing).
 */
export async function activateUser(
  userId: string,
  opts?: { now?: number },
): Promise<UserProfile | null> {
  const activatedAt = new Date(opts?.now ?? Date.now()).toISOString();
  try {
    const out = await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: userPk(userId), SK: PROFILE_SK },
        UpdateExpression: 'SET #status = :active, activatedAt = :at',
        ConditionExpression: 'attribute_exists(PK) AND #status = :invited',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':active': 'active',
          ':invited': 'invited',
          ':at': activatedAt,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    if (!out.Attributes) return null;
    logger.info({ userId }, 'user activated');
    return toUserProfile(out.Attributes as Record<string, unknown>);
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

/**
 * Disable a user: flips status → disabled and stamps disabledAt. The CALLER
 * must also call tokens-repo.revokeTokensForUser(userId) so the disabled user
 * cannot keep using a live session token, and forbid self-disable. Conditioned
 * on the user existing.
 */
export async function disableUser(userId: string, opts?: { now?: number }): Promise<void> {
  const disabledAt = new Date(opts?.now ?? Date.now()).toISOString();
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: userPk(userId), SK: PROFILE_SK },
      UpdateExpression: 'SET #status = :disabled, disabledAt = :at',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':disabled': 'disabled', ':at': disabledAt },
    }),
  );
  logger.info({ userId }, 'user disabled');
}

/**
 * Record a successful login: stamps lastLoginAt. Best-effort and non-throwing
 * on a conditional/transient miss (mirrors tokens-repo.touchLastUsed) — a
 * failed timestamp must never block an otherwise valid login. A non-conditional
 * fault is logged rather than swallowed.
 */
export async function recordLogin(userId: string, opts?: { now?: number }): Promise<void> {
  const lastLoginAt = new Date(opts?.now ?? Date.now()).toISOString();
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: userPk(userId), SK: PROFILE_SK },
        UpdateExpression: 'SET lastLoginAt = :at',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':at': lastLoginAt },
      }),
    );
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'ConditionalCheckFailedException') return;
    logger.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'recordLogin failed',
    );
  }
}
