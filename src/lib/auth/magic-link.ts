/**
 * Magic-link token primitives — TRUE passwordless.
 *
 * This module is pure crypto + helpers. It NEVER touches DynamoDB. Storage of
 * the magic-link state row (PK=MAGIC#<sha256(rawToken)>, SK=STATE) lives in
 * users-repo; the raw token lives ONLY in the emailed link and is shown to a
 * human exactly once. We persist the sha256 hash so a leaked table dump cannot
 * be replayed as a working link.
 *
 * There are no passwords anywhere in this flow. No argon2, no bcrypt, no
 * credential items. A magic-link token is the only secret, it is single-use,
 * and it is TTL-bounded (72h for invites, 15m for logins).
 *
 * Mirrors the hashing convention in tokens-repo (sha256 hex of the raw value)
 * so both subsystems hash the same way.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Why a magic-link token was minted. Drives TTL + the post-consume action. */
export type MagicLinkPurpose = 'invite' | 'login';

/** Default lifetimes, in milliseconds. Security spec: invite 72h, login 15m. */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
export const LOGIN_TTL_MS = 15 * 60 * 1000;

export function ttlMsForPurpose(purpose: MagicLinkPurpose): number {
  return purpose === 'invite' ? INVITE_TTL_MS : LOGIN_TTL_MS;
}

/** A freshly minted magic-link token. The `raw` value is emitted exactly once. */
export interface MagicLinkToken {
  /** High-entropy raw token. Goes in the emailed link ONLY; never persisted. */
  raw: string;
  /** sha256(raw) hex. This is the value persisted as PK=MAGIC#<hash>. */
  hash: string;
  purpose: MagicLinkPurpose;
  /** ISO timestamp the token was created. */
  createdAt: string;
  /** ISO timestamp after which the token is rejected. */
  expiresAt: string;
  /** Epoch SECONDS for the DynamoDB `ttl` attribute (GC backstop only). */
  ttl: number;
}

/**
 * sha256 of a raw magic-link token, hex-encoded. Matches tokens-repo.hashToken
 * so the two subsystems are byte-for-byte consistent.
 */
export function hashMagicToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Mint a magic-link token. 32 random bytes (256 bits) hex-encoded, well above
 * any brute-force budget. Returns both the raw value (to email) and the hash
 * (to persist). The caller is responsible for the storage write.
 */
export function generateMagicToken(
  purpose: MagicLinkPurpose,
  now: number = Date.now(),
): MagicLinkToken {
  const raw = randomBytes(32).toString('hex');
  const hash = hashMagicToken(raw);
  const expiresMs = now + ttlMsForPurpose(purpose);
  return {
    raw,
    hash,
    purpose,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    // DDB TTL is GC-only and can lag ~48h; expiry is enforced in code below.
    ttl: Math.floor(expiresMs / 1000),
  };
}

/**
 * True when the row's ISO expiry is in the past. A present-but-unparseable
 * expiresAt counts as EXPIRED (fail closed): corrupted data must not read as
 * a forever-valid token. (The consume path's conditional write enforces
 * expiry independently; this helper backs the pre-consume validity check.)
 */
export function isMagicTokenExpired(
  row: { expiresAt?: string },
  now: number = Date.now(),
): boolean {
  if (!row.expiresAt) return false;
  const ts = Date.parse(row.expiresAt);
  return !Number.isFinite(ts) || ts <= now;
}

/** Reasons a magic-link token can be rejected at verify time. */
export type MagicLinkRejection = 'not_found' | 'expired' | 'consumed';

export interface MagicLinkVerifyResult {
  ok: boolean;
  /** Set only when ok === false. Callers MUST collapse this to a uniform 404. */
  reason?: MagicLinkRejection;
}

/**
 * Pure verification of an already-loaded magic-link row against a raw token.
 *
 * This does NOT perform the single-use consume — that is a conditional DDB
 * write in users-repo (SET consumedAt IF attribute_not_exists(consumedAt)), so
 * two concurrent verifies can never both win. This helper is the in-memory gate
 * the consume path layers on top of, and the surface that route handlers use to
 * decide the response.
 *
 * IMPORTANT for the caller: a missing/expired/consumed token MUST return an
 * identical 404 to the client. Do not leak which of the three it was. The
 * `reason` field here is for server-side audit only.
 */
export function verifyMagicToken(
  raw: string,
  row:
    | {
        purpose?: MagicLinkPurpose;
        expiresAt?: string;
        consumedAt?: string;
      }
    | null
    | undefined,
  opts: { expectedPurpose?: MagicLinkPurpose; now?: number } = {},
): MagicLinkVerifyResult {
  const now = opts.now ?? Date.now();
  if (!raw || !row) return { ok: false, reason: 'not_found' };
  // Purpose mismatch (an invite token replayed on the login verify route, or
  // vice versa) is treated as not_found so the two flows can't be crossed.
  if (opts.expectedPurpose && row.purpose !== opts.expectedPurpose) {
    return { ok: false, reason: 'not_found' };
  }
  if (row.consumedAt) return { ok: false, reason: 'consumed' };
  if (isMagicTokenExpired(row, now)) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/**
 * Constant-time equality of two hex hashes. Used when a caller has both the
 * recomputed hash of a presented raw token and a stored hash and wants to
 * compare without a timing side-channel. Length mismatch returns false safely.
 */
export function magicHashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Build the absolute link a magic-link email points at. The base URL comes from
 * SERVER CONFIG only (CCE_DASHBOARD_URL / DASHBOARD_URL), NEVER from a request
 * Host or X-Forwarded-Host header — that was a prior security finding (an
 * attacker controlling Host could redirect the link to a phishing origin).
 *
 * Path is /accept?token=<raw> for invites and /verify?token=<raw> for logins.
 * Returns null when no server-config base URL is set, so callers fail closed
 * (refuse to send a link to nowhere) rather than emit a relative or attacker
 * controlled URL.
 */
export function buildMagicLink(
  purpose: MagicLinkPurpose,
  rawToken: string,
  baseUrl: string | undefined = process.env.CCE_DASHBOARD_URL ??
    process.env.DASHBOARD_URL,
): string | null {
  if (!baseUrl) return null;
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return null;
  const path = purpose === 'invite' ? 'accept' : 'verify';
  return `${trimmed}/${path}?token=${encodeURIComponent(rawToken)}`;
}
