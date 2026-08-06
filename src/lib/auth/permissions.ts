/**
 * RBAC capability taxonomy + profiles (Wave 4a auth-core).
 *
 * This is the single source of truth for "what a principal may do". The
 * dashboard had a 3-rung role ladder (viewer < operator < admin) gated by a
 * numeric ROLE_RANK comparison. That ladder is preserved as TEMPLATED PROFILES
 * here, but enforcement moves to a CAPABILITY check so we can express finer
 * grained roles (e.g. analyst = reads + cost, no security controls) and fully
 * custom profiles without inventing new rungs.
 *
 * A capability is a coarse permission mapped to a dashboard tab / route group.
 * A profile is a named set of capabilities. requireCapability() is the ONE gate
 * everything funnels through — do NOT reintroduce a parallel role-rank check.
 *
 * Custom profiles are stored as rows in the claudeclaw-users table (single-table
 * design, no new table) and resolved by id at request time; see users-repo for
 * the read/write. This module only knows how to RESOLVE a profileId + optional
 * custom-capability set into the effective capability set, and to check it.
 */

/**
 * Capability taxonomy. Each entry maps to a dashboard tab / route group:
 *
 *   dashboard:read    BASE read grant. Kept as a coarse umbrella for back-compat
 *                     (whoami / status / the legacy GET ladder). The per-tab
 *                     reads below SPLIT this umbrella so a custom profile can
 *                     grant a single tab without granting the whole dashboard.
 *                     Every templated profile that used to hold dashboard:read
 *                     now ALSO holds the per-tab reads that cover the same tabs,
 *                     so templated behaviour is identical (see Wave 5 note below).
 *
 *   --- Wave 5 per-tab read caps (granular RBAC) ---
 *   overview:read     Overview tab — agents/sessions/kill-switch/cost/usage
 *                     summary cards rendered on `/`.
 *   agents:read       Agents tab — agent roster + health + file views.
 *   chat:read         Chat tab — test-turn console (its read-only session/memory
 *                     surfaces; the POST test-turn mutation stays operator-gated).
 *   sessions:read     Sessions tab — session list + export.
 *   usage:read        Usage tab — usage reads + daily rollup + export.
 *   audit:read        Audit Log tab — audit list + export.
 *   vectors:read      Knowledge tab — vector/document list (ingest/delete stay
 *                     agents:write).
 *   missions:read     Missions tab — mission list (create/status/reassign stay
 *                     agents:write).
 *   memories:read     Memories tab — memory reads.
 *   hive:read         Hive Mind tab — hive reads.
 *   scheduled:read    Scheduled tab — scheduled-task list (delete stays
 *                     agents:write).
 *   warroom:read      War Room tab — war-room reads.
 *   kill-switches:read  Kill-switch LIST read. VIEWER-TIER — the Overview renders a
 *                     kill-switch SUMMARY card from this list, so every templated
 *                     profile (viewer up) must hold it or the Overview 403s. The
 *                     KillSwitches PAGE route's TRIP action stays gated on
 *                     security:write (admin/owner); only this GET read is viewer-held.
 *                     (Wave 5 fix: this read previously sat at admin/owner-only,
 *                     which broke the templated viewer's Overview summary card.)
 *
 *   agents:write      routine mutations — agents, missions, vectors, GDPR export.
 *   cost:read         cost dashboard + usage reads.
 *   cost:write        cost-cap edits, AWS budget sync.
 *   posture:read      security-posture card reads (encryption/secrets/backup
 *                     status). Operator-tier READ — NO IAM, NO mutations.
 *   integrations:read connected-surface inventory + secrets-metadata posture
 *                     reads (never secret VALUES). Operator-tier READ.
 *   compliance:read   SOC 2 / HIPAA compliance gap-analysis reads: the control
 *                     catalog scored against live posture evidence, plus the
 *                     read-only AI analyst that explains a control's current
 *                     requirement + remediation. Operator-tier READ — it only
 *                     re-reads the SAME posture signals posture:read exposes and
 *                     invokes a model for a written explanation; NO mutations.
 *   security:read     IAM-adjacent security reads (DLP, kill-switch, IAM
 *                     surface). Admin/owner-only — stricter than posture:read.
 *   security:write    flip kill switches, panic, DLP rules, drift, IAM apply.
 *   tokens:write      mint / revoke per-operator bearer tokens.
 *   members:read      list members (users) + view their profiles.
 *   members:write     invite / change-role / disable members, custom-profile CRUD.
 *   config:write      runtime-config writes (tunables, alert recipients).
 *   owner:admin       deployment-level ownership — manage OTHER owners and the
 *                     break-glass surface. OWNER-ONLY. This is the capability
 *                     that keeps the hierarchy strict: an admin holds every
 *                     other capability but NOT this one, so an admin can never
 *                     mint or become an owner (no self-escalation past admin).
 *
 * Adding a capability is additive; never repurpose an existing string. A new
 * capability lands ONLY in the profiles you name below (and in owner, which is
 * ALL_CAPABILITIES); it is denied everywhere else by default (fail closed).
 */
export const CAPABILITIES = [
  'dashboard:read',
  // Wave 5 per-tab read caps (granular RBAC). The first 13 are viewer-tier and
  // together cover exactly the tabs the old coarse dashboard:read exposed
  // (including the Overview kill-switch SUMMARY card).
  'overview:read',
  'agents:read',
  'chat:read',
  'sessions:read',
  'usage:read',
  'audit:read',
  'vectors:read',
  'missions:read',
  'memories:read',
  'hive:read',
  'scheduled:read',
  'warroom:read',
  // Viewer-tier read: the kill-switch LIST. The Overview summary card reads it,
  // so viewer holds it. The trip MUTATION stays security:write (admin/owner).
  'kill-switches:read',
  'agents:write',
  'cost:read',
  'cost:write',
  'posture:read',
  'integrations:read',
  'compliance:read',
  'security:read',
  'security:write',
  'tokens:write',
  'members:read',
  'members:write',
  'config:write',
  'owner:admin',
  // Seat administration (absorbed from PR #42's seat/workspace design, minus
  // the EC2-workspace surface). Seats bind a dashboard user to a SeatPolicy
  // (allowed models / tools / spend limit) and receive per-seat Bedrock usage
  // attribution. Held by org-admin + owner only — a plain admin does NOT
  // manage seats (additive fail-closed default).
  'seats:read',
  'seats:write',
  'seat-policies:read',
  'seat-policies:write',
  // Org-wide usage attribution reads (per-seat Bedrock rows) vs a seat user's
  // own rows. usage:self:read is the seat-user tier; usage:org:read is the
  // org-admin tier.
  'usage:org:read',
  'usage:self:read',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(v: unknown): v is Capability {
  return typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v);
}

/** Templated profile ids, least → most privileged. seat-user is the floor
 * (below viewer: no per-tab reads, only its own seat/usage); org-admin sits
 * between admin and owner (admin plus the seat-administration plane). */
export const TEMPLATED_PROFILE_IDS = [
  'seat-user',
  'viewer',
  'analyst',
  'operator',
  'admin',
  'org-admin',
  'owner',
] as const;

export type TemplatedProfileId = (typeof TEMPLATED_PROFILE_IDS)[number];

/**
 * Full capability set, used by `owner` and the env break-glass token. Derived
 * from CAPABILITIES so a newly added capability is automatically granted to
 * owner (owner is, by definition, all-powerful) and to nobody else by default.
 */
export const ALL_CAPABILITIES: readonly Capability[] = [...CAPABILITIES];

/**
 * Templated profiles. Each is a capability set built by additive layering so
 * the privilege ordering is obvious and a new capability lands in exactly the
 * profiles we name.
 *
 *  viewer   — read-only across the dashboard.
 *  analyst  — viewer + cost reads (FinOps / reporting; no mutations).
 *  operator — analyst + day-to-day mutations (agents, cost-cap, config) +
 *             security-posture / integrations READS (posture:read,
 *             integrations:read). No IAM-adjacent security:read, no mutations.
 *  admin    — operator + security controls + token + member management. Holds
 *             every capability EXCEPT owner:admin, so admin < owner strictly.
 *  owner    — everything (== ALL_CAPABILITIES, the only profile with owner:admin).
 *
 * posture:read / integrations:read are operator-tier READS, so they layer in at
 * OPERATOR_CAPS and flow up to admin (additive) and owner (ALL_CAPABILITIES).
 * They never reach viewer/analyst. security:read/security:write stay admin/owner
 * (IAM + mutations), strictly above the posture/integrations reads.
 *
 * WAVE 5 (granular RBAC): the coarse dashboard:read umbrella is SPLIT into per-tab
 * read caps. To keep templated behaviour IDENTICAL, viewer now holds the base
 * dashboard:read AND the 13 per-tab viewer reads (overview/agents/chat/sessions/
 * usage/audit/vectors/missions/memories/hive/scheduled/warroom/kill-switches) —
 * exactly the surfaces the old viewer saw. kill-switches:read is VIEWER-TIER:
 * the Overview renders a kill-switch SUMMARY card from the list, so viewer must
 * hold the read or the Overview 403s. The kill-switch TRIP mutation stays
 * security:write (admin/owner) — only the GET read moved to viewer. Custom
 * profiles may grant any SUBSET of these per-tab reads independently; templated
 * profiles preserve the original tab coverage.
 */
const VIEWER_CAPS: readonly Capability[] = [
  // Base coarse grant, kept for back-compat (whoami / status / legacy GET ladder).
  'dashboard:read',
  // Per-tab viewer reads — the 13 surfaces the old coarse dashboard:read exposed.
  'overview:read',
  'agents:read',
  'chat:read',
  'sessions:read',
  'usage:read',
  'audit:read',
  'vectors:read',
  'missions:read',
  'memories:read',
  'hive:read',
  'scheduled:read',
  'warroom:read',
  // Kill-switch LIST read backs the Overview summary card, so it is viewer-tier.
  // The kill-switch TRIP mutation stays security:write (admin/owner).
  'kill-switches:read',
];

const ANALYST_CAPS: readonly Capability[] = [...VIEWER_CAPS, 'cost:read'];

const OPERATOR_CAPS: readonly Capability[] = [
  ...ANALYST_CAPS,
  'agents:write',
  'cost:write',
  'config:write',
  'members:read',
  // Operator-tier READS: security-posture cards + integrations inventory +
  // SOC 2 / HIPAA compliance gap analysis. Read-only — IAM-adjacent
  // security:read and all security:write stay admin/owner-only. compliance:read
  // only re-reads the same posture signals posture:read exposes (plus a
  // read-only model explainer), so it sits in the same operator-tier read band.
  'posture:read',
  'integrations:read',
  'compliance:read',
];

const ADMIN_CAPS: readonly Capability[] = [
  ...OPERATOR_CAPS,
  'security:read',
  'security:write',
  'tokens:write',
  'members:write',
  // NOTE: kill-switches:read is now VIEWER-tier (it backs the Overview summary
  // card), so it is already inherited here via ...OPERATOR_CAPS → ...VIEWER_CAPS.
  // The kill-switch TRIP mutation is what admin/owner gates (security:write).
];

/**
 * seat-user — the FLOOR profile (below viewer). A seat user is a consumer of
 * the deployment, not an operator of it: they hold the coarse dashboard:read
 * umbrella (whoami / status) plus their OWN usage read, and none of the
 * per-tab reads, so every tab beyond their own seat surface 403s. Absorbed
 * from PR #42's seat-user, minus workspace:self (no workspace surface).
 */
const SEAT_USER_CAPS: readonly Capability[] = [
  'dashboard:read',
  'usage:self:read',
];

/**
 * org-admin — admin plus the seat-administration plane (seats, seat policies,
 * org-wide usage attribution). Strictly between admin and owner: a plain
 * admin cannot touch seats; org-admin still lacks owner:admin so it can never
 * mint or become an owner.
 */
const ORG_ADMIN_CAPS: readonly Capability[] = [
  ...ADMIN_CAPS,
  'seats:read',
  'seats:write',
  'seat-policies:read',
  'seat-policies:write',
  'usage:org:read',
  'usage:self:read',
];

export const TEMPLATED_PROFILES: Record<
  TemplatedProfileId,
  readonly Capability[]
> = {
  'seat-user': SEAT_USER_CAPS,
  viewer: VIEWER_CAPS,
  analyst: ANALYST_CAPS,
  operator: OPERATOR_CAPS,
  admin: ADMIN_CAPS,
  'org-admin': ORG_ADMIN_CAPS,
  owner: ALL_CAPABILITIES,
};

export function isTemplatedProfileId(v: unknown): v is TemplatedProfileId {
  return (
    typeof v === 'string' &&
    (TEMPLATED_PROFILE_IDS as readonly string[]).includes(v)
  );
}

/**
 * A custom profile: an admin-defined named capability set. Stored in the users
 * table. `capabilities` is validated/filtered to known Capability strings on
 * resolution so an unknown string in storage can never widen a grant.
 */
export interface CustomProfile {
  profileId: string;
  label: string;
  capabilities: readonly Capability[];
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * The legacy 3-rung TokenRole maps onto a templated profile so existing
 * per-operator tokens (and the requiredRole matrix) keep working under the
 * unified capability gate. admin → admin, operator → operator, viewer → viewer.
 * This is the bridge that lets us run ONE enforcement mechanism instead of the
 * old role-rank gate AND a new capability gate side by side.
 */
export function profileIdForLegacyRole(
  role: 'viewer' | 'operator' | 'admin',
): TemplatedProfileId {
  return role;
}

/**
 * Resolve a profileId (plus, for custom profiles, the stored custom-profile
 * record) into the effective capability set.
 *
 *  - Templated id  → its fixed capability set.
 *  - Custom id     → the custom record's capabilities, FILTERED to known
 *                    capabilities (defensive: storage can't widen a grant
 *                    via an unknown/garbage string).
 *  - Unknown id with no record → empty set (fail closed: no capabilities).
 *
 * Resolution NEVER throws; an unresolvable profile yields zero capabilities so
 * a corrupt/missing profile locks the principal out instead of opening up.
 */
export function resolveCapabilities(
  profileId: string,
  customProfile?: CustomProfile | null,
): readonly Capability[] {
  if (isTemplatedProfileId(profileId)) {
    return TEMPLATED_PROFILES[profileId];
  }
  if (customProfile && customProfile.profileId === profileId) {
    return customProfile.capabilities.filter(isCapability);
  }
  return [];
}

/**
 * True when the capability set contains the required capability. owner's set is
 * ALL_CAPABILITIES so it always passes. This is intentionally a plain set
 * membership check — capabilities are flat, there is no implied hierarchy.
 */
export function hasCapability(
  capabilities: readonly Capability[],
  required: Capability,
): boolean {
  return capabilities.includes(required);
}

/**
 * The ONE gate. Resolve a profile to its capabilities and assert the required
 * one is present. Returns a structured result so a route can emit a uniform 403
 * without re-deriving anything. Do NOT pair this with a separate role-rank check.
 */
export interface CapabilityCheck {
  allowed: boolean;
  required: Capability;
  /** The capabilities the principal actually holds (for a 403 body / audit). */
  held: readonly Capability[];
}

export function requireCapability(
  profileId: string,
  required: Capability,
  customProfile?: CustomProfile | null,
): CapabilityCheck {
  const held = resolveCapabilities(profileId, customProfile);
  return { allowed: hasCapability(held, required), required, held };
}

/**
 * Subset check used to bound a privilege grant by the actor's own privilege:
 * an inviter/role-changer may only grant a capability set that is a SUBSET of
 * their own (no self-escalation, no granting caps you don't hold). Returns the
 * offending capabilities (granted-minus-actor) so the caller can name them in
 * a 403; an empty array means the grant is within bounds.
 */
export function capabilitiesExceeding(
  granted: readonly Capability[],
  actor: readonly Capability[],
): readonly Capability[] {
  const actorSet = new Set(actor);
  return granted.filter((cap) => !actorSet.has(cap));
}

/**
 * Convenience used by the member-management routes: may an actor (holding
 * `actorCaps`) assign `targetProfileId` (templated or custom) to someone else?
 * True only when the target profile's effective capabilities are a subset of
 * the actor's. This enforces "granted caps ⊆ actor caps" at the profile level
 * so an admin cannot mint an owner, and an operator cannot mint an admin.
 */
export function canAssignProfile(
  actorCaps: readonly Capability[],
  targetProfileId: string,
  targetCustomProfile?: CustomProfile | null,
): boolean {
  const targetCaps = resolveCapabilities(targetProfileId, targetCustomProfile);
  // A profile that resolves to nothing is never assignable (would be a no-op
  // role that also signals a misconfigured/unknown profileId).
  if (targetCaps.length === 0) return false;
  return capabilitiesExceeding(targetCaps, actorCaps).length === 0;
}
