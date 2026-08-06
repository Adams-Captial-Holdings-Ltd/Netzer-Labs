/**
 * Jarvis route + resource authority (JARVIS-PLAN.md NORMATIVE Reference
 * Contracts C). This single server module is the source of truth for BOTH:
 *   - the resource → minRole map (consumed by `authorize-read.ts` AND the
 *     manifest endpoint — there is no divergent copy), and
 *   - the route → minRole map (mirrors the live `web/src/App.tsx` route
 *     table; a CI route-drift test asserts they match).
 *
 * The frontend consumes the `GET /api/jarvis/manifest` RESPONSE for its
 * allowed-routes list. It does NOT derive routes from `NAV_ITEMS` and there
 * is NO `ROUTES_BY_ROLE` copy in the relay. This prevents enum drift (R8).
 */

export type JarvisRole = 'viewer' | 'operator' | 'admin';

/** Role ranking — the single comparison used by both the HTTP path and Jarvis. */
export const ROLE_RANK: Record<JarvisRole, number> = { viewer: 0, operator: 1, admin: 2 };

// ── Query resources (the closed launch enum) ────────────────────────
// Excluded ENTIRELY (not role-gated): tokens, config, all */export CSV,
// agent file/history, inbox, GDPR export. `posture` is deferred (no
// GET /api/posture handler) — `notifications` already surfaces alarms +
// active kill switches (reconciled decision 5).
export type JarvisResource =
  | 'agents'
  | 'agent_health'
  | 'agent_health_single'
  | 'sessions'
  | 'usage'
  | 'usage_daily'
  | 'cost_today'
  | 'audit'
  | 'kill_switches'
  | 'notifications'
  | 'vectors'
  | 'missions'
  | 'memories'
  | 'scheduled'
  | 'hive'
  | 'addons'
  | 'tier';

export interface ResourceMeta {
  minRole: JarvisRole;
  description: string;
  acceptedParams: string[];
}

/**
 * Resource → minRole + metadata. Per Reference Contracts C the entire launch
 * set is viewer-level EXCEPT `audit`, raised to operator (it carries
 * operational detail and could narrate too much to a viewer). `authorize-read`
 * enforces this exact table; the manifest filter is defense-in-depth + UX.
 */
export const RESOURCE_META: Record<JarvisResource, ResourceMeta> = {
  agents: { minRole: 'viewer', description: 'Registered agents: count, model, integrations.', acceptedParams: [] },
  agent_health: { minRole: 'viewer', description: 'Per-agent health rollup (healthy/degraded/idle/error).', acceptedParams: [] },
  agent_health_single: { minRole: 'viewer', description: 'One agent: error rate + latency.', acceptedParams: ['agentId'] },
  sessions: { minRole: 'viewer', description: 'Recent sessions and last activity.', acceptedParams: [] },
  usage: { minRole: 'viewer', description: 'Token usage + cost for a period.', acceptedParams: ['agentId', 'days'] },
  usage_daily: { minRole: 'viewer', description: 'Per-day cost; peak day.', acceptedParams: ['agentId', 'days'] },
  cost_today: { minRole: 'viewer', description: "Today's USD spend.", acceptedParams: [] },
  audit: { minRole: 'operator', description: 'Audit counts + notable action types.', acceptedParams: ['days'] },
  kill_switches: { minRole: 'viewer', description: 'Active kill switches + reasons (read-only).', acceptedParams: [] },
  notifications: { minRole: 'viewer', description: 'Actionable alerts (alarms, cost, active switches).', acceptedParams: [] },
  vectors: { minRole: 'viewer', description: 'Knowledge-base document count.', acceptedParams: ['scope'] },
  missions: { minRole: 'viewer', description: 'Open missions + priority.', acceptedParams: ['owner'] },
  memories: { minRole: 'viewer', description: 'Memories for a chat (chatId required).', acceptedParams: ['agentId', 'chatId'] },
  scheduled: { minRole: 'viewer', description: 'Scheduled tasks and next runs.', acceptedParams: ['agentId'] },
  hive: { minRole: 'viewer', description: 'Recent hive-mind entries.', acceptedParams: ['limit'] },
  addons: { minRole: 'viewer', description: 'Integration / add-on status.', acceptedParams: [] },
  tier: { minRole: 'viewer', description: 'Deployment tier + cost cap.', acceptedParams: [] },
};

export const JARVIS_RESOURCES: readonly JarvisResource[] = Object.keys(
  RESOURCE_META,
) as JarvisResource[];

export function isJarvisResource(v: unknown): v is JarvisResource {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RESOURCE_META, v);
}

// ── Routes (mirror web/src/App.tsx static route table) ──────────────
export interface RouteMeta {
  route: string;
  label: string;
  section: string;
  minRole: JarvisRole;
}

/**
 * The navigable route table. Mirrors the static routes in App.tsx (the
 * `:param` detail routes and NotFound are excluded — navigate('/agents/main')
 * is validated as "/agents is allowed"). `/jarvis` is always present.
 *
 * minRole mirrors the per-route gate in App.tsx, collapsed onto the Jarvis
 * role rung (viewer < operator < admin). App.tsx gates each route with a
 * <RequireCapability need="…"> wrapper; the CI drift test maps that capability
 * to the LOWEST templated-profile tier that holds it (see route-manifest.test.ts
 * CAPABILITY_MIN_ROLE). Wave 5 split the coarse dashboard:read umbrella into the
 * 12 per-tab viewer reads (overview/agents/chat/sessions/usage/audit/vectors/
 * missions/memories/hive/scheduled/warroom):read — all viewer-tier, so the data
 * routes stay minRole 'viewer'. /kill-switches keeps its security:write route
 * gate (admin), beside the new admin-only kill-switches:read LIST-read cap.
 */
export const ROUTE_TABLE: readonly RouteMeta[] = [
  { route: '/', label: 'Overview', section: 'Core', minRole: 'viewer' },
  // Getting Started is the ungated onboarding checklist (replaces the old
  // OnboardingWizard modal); every authenticated principal can open it.
  { route: '/getting-started', label: 'Getting Started', section: 'Account', minRole: 'viewer' },
  // Seat administration gates on seats:read (held by org-admin/owner only).
  // In the 3-rung Jarvis role space that collapses to the admin rung: an
  // admin-rank principal WITHOUT seats:read still hits the in-page capability
  // empty-state; the backend re-checks every route.
  { route: '/seats', label: 'Seats', section: 'Team', minRole: 'admin' },
  // Seat self-service gates on usage:self:read (seat-user floor tier), which
  // collapses to the viewer rung.
  { route: '/my-seat', label: 'My Seat', section: 'Account', minRole: 'viewer' },
  { route: '/agents', label: 'Agents', section: 'Core', minRole: 'viewer' },
  { route: '/chat', label: 'Chat', section: 'Core', minRole: 'viewer' },
  // Model Playground gates on chat:read in App.tsx (viewer tier), same as Chat.
  { route: '/playground', label: 'Playground', section: 'Core', minRole: 'viewer' },
  { route: '/jarvis', label: 'Jarvis', section: 'Core', minRole: 'viewer' },
  { route: '/sessions', label: 'Sessions', section: 'Operations', minRole: 'viewer' },
  { route: '/usage', label: 'Usage', section: 'Operations', minRole: 'viewer' },
  { route: '/cost', label: 'Cost', section: 'Operations', minRole: 'operator' },
  { route: '/audit', label: 'Audit Log', section: 'Operations', minRole: 'viewer' },
  { route: '/vectors', label: 'Knowledge', section: 'Advanced', minRole: 'viewer' },
  { route: '/missions', label: 'Missions', section: 'Advanced', minRole: 'viewer' },
  { route: '/memories', label: 'Memories', section: 'Advanced', minRole: 'viewer' },
  { route: '/hive', label: 'Hive Mind', section: 'Advanced', minRole: 'viewer' },
  { route: '/scheduled', label: 'Scheduled', section: 'Advanced', minRole: 'viewer' },
  { route: '/warroom', label: 'War Room', section: 'Collaboration', minRole: 'viewer' },
  // App.tsx gates Integrations on the `integrations:read` capability, an
  // operator-tier READ (OPERATOR_CAPS — operator/admin/owner), so the navigable
  // minRole is operator. This matches the pre-Wave-4 baseline (RequireRole
  // need="operator"); it is NOT the admin-only security:read gate.
  { route: '/integrations', label: 'Integrations', section: 'Collaboration', minRole: 'operator' },
  // The Members page is READABLE at operator tier. App.tsx gates it on the
  // `members:read` capability (RequireCapability, not RequireRole); members:read
  // lives in the operator/admin/owner profiles, so the navigable minRole is
  // operator. In-page mutations gate separately on members:write (admin/owner).
  { route: '/members', label: 'Members', section: 'Team', minRole: 'operator' },
  // App.tsx gates Security Posture on `posture:read`, an operator-tier READ
  // (OPERATOR_CAPS — operator/admin/owner), so the navigable minRole is operator.
  // This matches the pre-Wave-4 baseline (RequireRole need="operator"); it is NOT
  // the admin-only security:read (IAM) gate, which stays on the control surfaces.
  { route: '/security-posture', label: 'Security Posture', section: 'Security', minRole: 'operator' },
  // Compliance gates on `compliance:read` in App.tsx, an operator-tier READ
  // (OPERATOR_CAPS, i.e. operator/admin/owner), so the navigable minRole is
  // operator, the same band as Security Posture and Integrations.
  { route: '/compliance', label: 'Compliance', section: 'Security', minRole: 'operator' },
  { route: '/kill-switches', label: 'Kill Switches', section: 'Security', minRole: 'admin' },
  { route: '/dlp', label: 'DLP', section: 'Security', minRole: 'admin' },
  { route: '/panic', label: 'Panic', section: 'Security', minRole: 'admin' },
  { route: '/rate-limits', label: 'Rate Limits', section: 'Security', minRole: 'admin' },
  { route: '/alerting', label: 'Alerting', section: 'Security', minRole: 'admin' },
  { route: '/settings', label: 'Settings', section: 'Account', minRole: 'viewer' },
];

function visible(minRole: JarvisRole, role: JarvisRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

// ── Manifest slice (role-filtered routes + resources, pure) ─────────
export interface ManifestRoute {
  route: string;
  label: string;
  section: string;
}
export interface ManifestResource {
  resource: JarvisResource;
  description: string;
  acceptedParams: string[];
  minRole: JarvisRole;
}

/**
 * Pure, role-filtered slice of the route + resource tables. The live
 * `voiceEnabled` / `jarvisEnabled` flags are composed by the manifest
 * endpoint (they require DDB reads, so they do not live here).
 */
export function buildManifestSlice(role: JarvisRole): {
  role: JarvisRole;
  routes: ManifestRoute[];
  resources: ManifestResource[];
} {
  const routes = ROUTE_TABLE.filter(
    (r) => r.route === '/jarvis' || visible(r.minRole, role),
  ).map((r) => ({ route: r.route, label: r.label, section: r.section }));

  const resources = JARVIS_RESOURCES.filter((res) =>
    visible(RESOURCE_META[res].minRole, role),
  ).map((res) => ({
    resource: res,
    description: RESOURCE_META[res].description,
    acceptedParams: RESOURCE_META[res].acceptedParams,
    minRole: RESOURCE_META[res].minRole,
  }));

  return { role, routes, resources };
}

/**
 * Whether a navigate target is allowed for a role. Accepts the exact route
 * or a dynamic child of an allowed base (e.g. `/agents/main` under `/agents`).
 * `/jarvis` is always allowed.
 */
export function isRouteAllowed(role: JarvisRole, target: string): boolean {
  const path = target.split('?')[0].replace(/\/+$/, '') || '/';
  // Reject path-traversal segments — `/settings/../kill-switches` must not pass
  // the prefix check and let a viewer be navigated onto an above-role route
  // after the browser normalizes the `..`.
  if (path.split('/').includes('..')) return false;
  for (const r of ROUTE_TABLE) {
    if (r.route !== '/jarvis' && !visible(r.minRole, role)) continue;
    if (path === r.route) return true;
    if (r.route !== '/' && path.startsWith(r.route + '/')) return true;
  }
  return false;
}

/**
 * Resolve a loose navigate target to the closest ALLOWED route for the role.
 * Speech mishears route names, so accept exact paths, label matches ("Memories"
 * / "memories" / "memory"), and path tails. Returns null when nothing is a
 * confident match (the caller then asks the user instead of guessing wrong).
 */
export function resolveRoute(role: JarvisRole, raw: string): string | null {
  const cleaned = (raw ?? '').toLowerCase().trim();
  if (!cleaned) return null;
  const asPath = cleaned.startsWith('/') ? cleaned : '/' + cleaned;
  if (isRouteAllowed(role, asPath)) return asPath.split('?')[0].replace(/\/+$/, '') || '/';
  const allowed = ROUTE_TABLE.filter((r) => r.route === '/jarvis' || visible(r.minRole, role));
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const w = norm(cleaned);
  if (!w) return null;
  // exact label / path-tail
  let hit = allowed.find((r) => norm(r.label) === w || norm(r.route) === w);
  // one contains the other (≥4 chars so short words don't over-match)
  if (!hit && w.length >= 4) hit = allowed.find((r) => { const l = norm(r.label); return l.includes(w) || w.includes(l); });
  // shared 4-char prefix (e.g. "memory" → "memories")
  if (!hit && w.length >= 4) hit = allowed.find((r) => norm(r.label).startsWith(w.slice(0, 4)));
  return hit ? hit.route : null;
}
