import { signal, computed } from '@preact/signals';
import { api, setDashboardUser, type WhoAmI } from './api';

export type Role = 'viewer' | 'operator' | 'admin';

// Mirror of the backend role matrix (src/adapters/dashboard/handler.ts:130).
// Higher number = more privilege.
export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

const ROLE_KEY = 'cce_role';
const LABEL_KEY = 'cce_label';
const EMAIL_KEY = 'cce_email';
const PROFILE_KEY = 'cce_profile_id';
const CAPS_KEY = 'cce_capabilities';

function readCachedRole(): Role | null {
  try {
    const v = localStorage.getItem(ROLE_KEY);
    return v === 'viewer' || v === 'operator' || v === 'admin' ? v : null;
  } catch {
    return null;
  }
}

function readCachedString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readCachedCaps(): string[] {
  try {
    const raw = localStorage.getItem(CAPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    // Missing/corrupt cache → fail closed to no capabilities; the nav simply
    // hides capability-gated items until /whoami resolves.
    return [];
  }
}

// Hydrate optimistically from the last-known role so a HARD REFRESH doesn't
// flash the role-gated nav items (e.g. Cost, Security) in a moment after
// /whoami resolves. Without this the signal starts null, the sidebar treats
// that as viewer, and operator/admin tabs pop in once whoami returns.
// The backend authorizes every route regardless, so this only affects what
// the nav SHOWS, never what the token can actually do.
export const currentRole = signal<Role | null>(readCachedRole());
export const currentLabel = signal<string | null>(readCachedString(LABEL_KEY));

// Wave 4b identity: the logged-in human (email), their assigned profile id, and
// the flat capability set the profile resolves to. Same optimistic-hydration
// rationale as currentRole — these drive capability-aware nav/route gates for
// the new profiles (analyst, owner, custom) without flashing on refresh. The
// backend remains the authority; this only governs what the UI shows.
export const currentEmail = signal<string | null>(readCachedString(EMAIL_KEY));
export const currentProfileId = signal<string | null>(readCachedString(PROFILE_KEY));
export const currentCapabilities = signal<string[]>(readCachedCaps());

// Seed the audit-identity header from the cached email so requests made on a
// hard refresh (before /whoami resolves) are still attributed to the right
// human. loadRole() re-stamps it authoritatively once whoami returns.
if (currentEmail.value) setDashboardUser(currentEmail.value);

/**
 * Fetch the caller's identity from the backend once after login. The backend is
 * the real authority (every route re-checks capabilities); this just lets the UI
 * hide controls the token can't use instead of showing them and 403ing. The
 * resolved identity is cached so the next hard refresh hydrates without a flash.
 */
export async function loadRole(): Promise<void> {
  try {
    const who: WhoAmI = await api.whoami();
    currentRole.value = who.role;
    currentLabel.value = who.label;
    currentEmail.value = who.email;
    currentProfileId.value = who.profileId;
    currentCapabilities.value = Array.isArray(who.capabilities) ? who.capabilities : [];
    // Stamp the audit-identity header with the authoritative email (falls back
    // to the label when a token-only principal has no email).
    setDashboardUser(who.email ?? who.label ?? '');
    try {
      localStorage.setItem(ROLE_KEY, who.role);
      if (who.label) localStorage.setItem(LABEL_KEY, who.label);
      else localStorage.removeItem(LABEL_KEY);
      if (who.email) localStorage.setItem(EMAIL_KEY, who.email);
      else localStorage.removeItem(EMAIL_KEY);
      if (who.profileId) localStorage.setItem(PROFILE_KEY, who.profileId);
      else localStorage.removeItem(PROFILE_KEY);
      localStorage.setItem(CAPS_KEY, JSON.stringify(currentCapabilities.value));
    } catch {
      // localStorage unavailable (private mode/quota) — caching is best-effort.
    }
  } catch {
    // request() already handles 401 by clearing the token and reloading. For
    // any other failure, keep the last-known (cached) role if we have one, and
    // otherwise fail closed to the lowest privilege so a transient error never
    // reveals a privileged surface on a first-ever load.
    currentRole.value = currentRole.value ?? 'viewer';
  }
}

export function hasRole(need: Role): boolean {
  const r = currentRole.value;
  if (r === null) return false;
  return ROLE_RANK[r] >= ROLE_RANK[need];
}

/**
 * Capability gate for the UI. Mirrors the backend hasCapability
 * (src/lib/auth/permissions.ts): a flat set-membership check, no implied
 * hierarchy. Use this for the new profiles (analyst, owner, custom) and any new
 * surface; the legacy hasRole() check stays for the existing role-gated routes
 * so nothing regresses.
 *
 * Fails closed: an unresolved capability set (pre-whoami, or a transient whoami
 * failure) returns false, so a capability-gated control is hidden until the
 * backend confirms the grant.
 */
export function hasCapability(cap: string): boolean {
  return currentCapabilities.value.includes(cap);
}

// Reactive convenience for components that want to recompute when the identity
// changes (e.g. the sidebar). Components can also call hasCapability() directly
// inside a render — reading currentCapabilities.value subscribes them.
export const capabilities = computed<string[]>(() => currentCapabilities.value);
