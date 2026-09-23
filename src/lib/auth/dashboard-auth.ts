import { timingSafeEqual, createHash } from 'node:crypto';
import {
  lookupToken,
  touchLastUsed,
  seedRootToken,
  hashToken,
  isExpired,
  type TokenPrincipal,
  type TokenRole,
} from '../state/tokens-repo.js';
import {
  profileIdForLegacyRole,
  resolveCapabilities,
  requireCapability,
  type Capability,
  type CustomProfile,
} from './permissions.js';
import { logger } from '../../observability/logger.js';

let rootSeeded = false;

export type { TokenPrincipal };

/**
 * The env break-glass token (DASHBOARD_TOKEN) is FULL owner admin, always. It
 * is authenticated by env equality, not by a user row, so we stamp it with the
 * owner profile id and the legacy admin role. Never weaken this — recovery from
 * a lockout is rotating DASHBOARD_TOKEN.
 */
const ROOT_PROFILE_ID = 'owner';
const ROOT_ROLE: TokenRole = 'admin';

/**
 * Resolve the RBAC profile id for a principal. A user-session token carries its
 * own profileId; a legacy per-operator token (or anything without a profileId)
 * maps its 3-rung role onto the matching templated profile so the ONE capability
 * gate works for every principal shape.
 */
export function profileIdForPrincipal(p: TokenPrincipal): string {
  return p.profileId ?? profileIdForLegacyRole(p.role);
}

/**
 * The effective capability set for a principal. The env root token is owner
 * (all capabilities); everyone else resolves through their profile id. A custom
 * profile record (loaded by the caller from users-repo) can be passed so its
 * capability set is used; without it, a custom profile id resolves to no
 * capabilities (fail closed).
 */
export function capabilitiesForPrincipal(
  p: TokenPrincipal,
  customProfile?: CustomProfile | null,
): readonly Capability[] {
  return resolveCapabilities(profileIdForPrincipal(p), customProfile);
}

/**
 * The unified authorization gate. Every dashboard/member route MUST enforce
 * access through this (or requireCapability in permissions.ts) — do NOT also run
 * the legacy requiredRole + ROLE_RANK comparison. A principal passes when its
 * resolved profile holds the required capability; the env root token (owner)
 * always passes. Returns true/false; the caller emits the 403.
 */
export function principalHasCapability(
  p: TokenPrincipal,
  required: Capability,
  customProfile?: CustomProfile | null,
): boolean {
  return requireCapability(profileIdForPrincipal(p), required, customProfile)
    .allowed;
}

export async function authenticateDashboardToken(
  raw: string,
): Promise<TokenPrincipal | null> {
  if (!raw) return null;

  const envToken = process.env.DASHBOARD_TOKEN;

  // Always try env token first for zero-latency backward compatibility.
  // This also handles the case where the DDB table doesn't exist yet.
  if (envToken && envToken !== 'REPLACE_ME' && raw.length === envToken.length) {
    try {
      if (timingSafeEqual(Buffer.from(raw), Buffer.from(envToken))) {
        const hash = createHash('sha256').update(envToken).digest('hex');
        // Seed the root token into DDB in the background (best-effort)
        if (!rootSeeded) {
          rootSeeded = true;
          seedRootToken(envToken).catch(() => {});
        }
        // Root is revokable: honor the DDB record's active/expiry. Fail CLOSED
        // on a real lookup error so a *revoked* root token can't be honored
        // merely because the revoke row was momentarily unreadable (throttle,
        // IAM blip, network). The one exception is the genuine bootstrap window
        // where the table does not exist yet (ResourceNotFoundException): there
        // is no revoke list to consult, so allow. Recovery from an accidental
        // revoke is rotating DASHBOARD_TOKEN.
        let linkedUserId: string | undefined;
        try {
          const record = await lookupToken(hash);
          if (record && (!record.active || isExpired(record))) {
            return null;
          }
          // Decision 1: the root token owns durable conversations only once an
          // admin has linked it to a person.
          linkedUserId = record?.linkedUserId;
        } catch (err) {
          const name = err instanceof Error ? err.name : '';
          if (name !== 'ResourceNotFoundException') {
            logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'dashboard-auth: root-token revoke check failed; denying (fail-closed)',
            );
            return null;
          }
          // table absent (first boot) — no revoke list exists, fall through to allow
        }
        // Keep the root token's lastUsedAt fresh so /whoami reflects real
        // activity instead of freezing at createdAt. Best-effort: the row may
        // not exist yet (seedRootToken is in-flight) and the table may be
        // absent during bootstrap, so swallow failures the same way the
        // per-operator path (below) does.
        touchLastUsed(hash).catch(() => {});
        return {
          tokenHash: hash,
          label: 'Root token',
          hashPrefix16: hash.slice(0, 16),
          // Break-glass: stamp the env token as owner so the unified capability
          // gate grants it every capability. role stays 'admin' for backward
          // compatibility with any remaining role-rank readers during cutover.
          role: ROOT_ROLE,
          profileId: ROOT_PROFILE_ID,
          ...(linkedUserId ? { linkedUserId } : {}),
        };
      }
    } catch {
      // timingSafeEqual can throw on length mismatch in edge cases
    }
  }

  // Try DDB lookup for per-operator tokens
  try {
    const tokenHash = hashToken(raw);
    const record = await lookupToken(tokenHash);
    if (record && record.active && !isExpired(record)) {
      touchLastUsed(tokenHash).catch(() => {});
      return {
        tokenHash,
        label: record.label,
        hashPrefix16: tokenHash.slice(0, 16),
        role: record.role,
        ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
        // Wave 4a: carry the user binding so the unified capability gate can
        // resolve the principal's profile. Legacy per-operator tokens have
        // neither field and fall back to role→profile in profileIdForPrincipal.
        ...(record.userId ? { userId: record.userId } : {}),
        ...(record.profileId ? { profileId: record.profileId } : {}),
        ...(record.linkedUserId ? { linkedUserId: record.linkedUserId } : {}),
      };
    }
  } catch {
    // DDB table may not exist, IAM may not be configured, X-Ray context missing
  }

  return null;
}

/**
 * True if `hash` is the sha256 of the env root token (DASHBOARD_TOKEN). The root
 * token is env-authenticated and may have no row in the dashboard-tokens table,
 * so callers that re-validate a token by hash (e.g. the Jarvis voice handshake)
 * must treat it the way authenticateDashboardToken does — allow it, honoring only
 * an explicit inactive/expired DDB record — instead of failing closed on a
 * missing row. Recovery from an accidental revoke is rotating DASHBOARD_TOKEN.
 */
export function isRootTokenHash(hash: string): boolean {
  const envToken = process.env.DASHBOARD_TOKEN;
  if (!envToken || envToken === 'REPLACE_ME') return false;
  return createHash('sha256').update(envToken).digest('hex') === hash;
}

export function extractBearerToken(
  authHeader: string | undefined,
  queryToken?: string,
): string {
  if (authHeader) {
    return authHeader.replace(/^Bearer\s+/i, '');
  }
  return queryToken ?? '';
}
