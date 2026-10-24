/**
 * Per-role AUTHORIZATION MATRIX — the safety net for the Wave 5/6 gate tightening.
 *
 * Drives the REAL routers through app.request() (no AWS in the loop) and asserts,
 * for a representative principal per templated tier, that every gated route
 * agrees in BOTH directions:
 *
 *   - A DENY shows up as HTTP 403 with the documented { requiredCapability }.
 *   - An ALLOW shows up as anything that is NOT 403 (the handler may then 200 /
 *     400 / 404 / 502 against the mocked repos — we only assert the GATE passed).
 *
 * Tiers (templated profiles, least → most privileged):
 *   viewer   — read-only.
 *   operator — viewer + routine mutations (agents:write, cost:write, config:write)
 *              + posture:read. NO security:write.
 *   admin    — operator + security:write (+ everything except owner:admin).
 *   owner    — everything (the env break-glass shape).
 *
 * The gate resolution under test is the SAME capability machinery the routes use
 * (permissions.ts + dashboard-auth.ts + route-capability.ts); only the token-auth
 * entrypoints are stubbed so we can drive auth by a role/profile string.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// ── Auth: drive by token string -> principal. The bearer is the templated
// profile id; owner is the env break-glass shape (label 'Root token', owner
// profile). Keep the REAL capability resolution (route-capability.ts imports
// principalHasCapability / profileIdForPrincipal from here) — only the
// token-extraction / authentication entrypoints are stubbed.
function principalFor(raw: string): TokenPrincipal | null {
  const id = raw.replace(/^Bearer\s+/i, '');
  if (id === 'viewer' || id === 'operator' || id === 'admin') {
    return { tokenHash: `hash-${id}`, label: id, hashPrefix16: id, role: id };
  }
  if (id === 'owner') {
    // The env break-glass token: owner profile, label 'Root token', role admin
    // (matches dashboard-auth's ROOT shape). Resolves to ALL_CAPABILITIES.
    return {
      tokenHash: 'hash-owner',
      label: 'Root token',
      hashPrefix16: 'owner',
      role: 'admin',
      profileId: 'owner',
    };
  }
  return null;
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (authHeader?: string, queryToken?: string) =>
      (authHeader ?? '').replace(/^Bearer\s+/i, '') || (queryToken ?? ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
  };
});

// Kill switches: never block (the warroom router 503s on warroom_disabled; the
// dashboard middleware 503s reads on dashboard_read_disabled). Keep the real
// ALL_KILL_SWITCHES export so the handler's name validation still works.
vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return {
    ...actual,
    isKillSwitchActive: () => Promise.resolve({ active: false }),
    setKillSwitch: () => Promise.resolve(),
  };
});

// Mission storage: allowed reads return an empty board without touching DDB.
// Mutations omit a body and stop at validation after the authorization gate.
vi.mock('../../lib/state/mission-tasks-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/mission-tasks-repo.js')>();
  return { ...actual, listMissionsForAgent: () => Promise.resolve([]) };
});

// Audit is fire-and-forget everywhere; stub so nothing reaches DDB.
vi.mock('../../lib/audit/audit-writer.js', () => ({
  writeAudit: () => Promise.resolve(),
}));

// Seat repo: the matrix only proves the GATE; an allowed list returns empty.
vi.mock('../../lib/admin/seat-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/admin/seat-repo.js')>();
  return { ...actual, listSeats: () => Promise.resolve({ items: [] }) };
});

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  truncateForLog: (s: string) => s,
}));

// ── War Room downstream: stub the repos/orchestrator so an ALLOWED mutation
// doesn't touch AWS. We only care that the gate passed.
vi.mock('../../lib/warroom/meetings-repo.js', () => ({
  createMeeting: () => Promise.resolve({ meetingId: 'm1', status: 'active' }),
  getMeeting: () => Promise.resolve({ meetingId: 'm1', status: 'active' }),
  endMeeting: () => Promise.resolve(),
  deleteMeeting: () => Promise.resolve(),
  addParticipant: () => Promise.resolve(1),
  removeParticipant: () => Promise.resolve(1),
  listMyMeetings: () => Promise.resolve([]),
}));
vi.mock('../../lib/warroom/publisher.js', () => ({
  publishTurn: () => Promise.resolve({ seq: 1, speaker: 'dashboard', content: 'hi', ts: 0 }),
  getHistory: () => Promise.resolve([]),
}));
vi.mock('../../lib/warroom/events.js', () => ({
  getChannel: () => ({ emit: () => {}, since: () => [], subscribe: () => () => {}, latestSeq: 0 }),
  removeChannel: () => {},
}));
vi.mock('../../lib/warroom/orchestrator.js', () => ({
  orchestrateWarroomTurn: () => Promise.resolve(),
}));

// ── Posture downstream readers: return empty card sets so an ALLOWED read 200s.
vi.mock('../../lib/aws/waf-reader.js', () => ({ readWafPosture: () => Promise.resolve([]) }));
vi.mock('../../lib/aws/network-reader.js', () => ({ readNetworkPosture: () => Promise.resolve([]) }));
vi.mock('../../lib/aws/guardduty-reader.js', () => ({ readGuardDutyPosture: () => Promise.resolve([]) }));
vi.mock('../../lib/security/posture-repo.js', () => ({ getSecurityPosture: () => Promise.resolve([]) }));
vi.mock('../../lib/posture/iam-reader.js', () => ({ fetchIamPosture: () => Promise.resolve({}) }));
vi.mock('../../lib/posture/iam-evaluator.js', () => ({ evaluateIamPosture: () => ({ cards: [] }) }));
vi.mock('../status/data.js', () => ({ assembleStatusData: () => Promise.resolve({ alarms: [], canary: { total: 0, windowHours: 24, uptimePct: null, lastResult: 'ok', lastFiredAt: null }, sourceErrors: [] }) }));
vi.mock('../../lib/aws/cloudtrail-reader.js', () => ({ fetchCloudTrailPostureCards: () => Promise.resolve([]) }));

// ── Panic downstream.
vi.mock('../../lib/state/panic-state-repo.js', () => ({
  getCurrentPanicState: () => Promise.resolve({ active: false }),
  tryAcquirePanic: () => Promise.resolve({ acquired: true, state: { active: true } }),
  releasePanic: () => Promise.resolve({ active: false }),
  forceReleasePanic: () => Promise.resolve({ released: true, state: { active: false } }),
}));

// ── IAM copilot downstream + runtime-config (status/apply read apply_enabled).
vi.mock('../../lib/aws/iam-copilot.js', () => ({
  draftPolicy: () => Promise.resolve({ policyDocument: '{}', explanation: '' }),
  validatePolicy: () => Promise.resolve([]),
  applyIam: () => Promise.resolve({ arn: 'arn:aws:iam::x' }),
}));

// ── Cost downstream.
vi.mock('../../lib/aws/cost-reader.js', () => ({
  readCostSummary: () => Promise.resolve({ available: true }),
  readCostRisks: () => Promise.resolve({ available: true }),
}));
vi.mock('../../workers/cost-watch.js', () => ({
  runCostWatchOnce: () => Promise.resolve({ ran: true, alerted: false }),
}));
vi.mock('../../lib/state/cost-cap-repo.js', () => ({
  getEffectiveCostCap: () => Promise.resolve(100),
  setDailyCostCap: () => Promise.resolve(),
}));
vi.mock('../../lib/aws/budget-writer.js', () => ({
  syncBudgetToDailyCap: () => Promise.resolve(null),
}));

// runtime-config: cost watch toggle write + iam apply_enabled read. Default the
// config getter to undefined; iam/apply_enabled !== 'true' so /apply short-
// circuits to its own 403 — but only AFTER the security:write gate, which is
// what we assert (an admin/owner reaching apply, a viewer/operator blocked at
// the cap gate).
const getConfig = vi.fn(
  (_cat?: string, _key?: string): Promise<string | undefined> => Promise.resolve(undefined),
);
const setConfig = vi.fn(
  (_cat?: string, _key?: string, _val?: string, _opts?: unknown): Promise<void> =>
    Promise.resolve(),
);
vi.mock('../../lib/state/runtime-config-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/runtime-config-repo.js')>();
  return {
    ...actual,
    getConfig: (cat: string, key: string) => getConfig(cat, key),
    getConfigCategory: () => Promise.resolve({}),
    setConfig: (cat: string, key: string, val: string, opts?: unknown) => setConfig(cat, key, val, opts),
  };
});

// MCP servers repo: an ALLOWED PUT /mcp shouldn't touch DDB. We only prove the
// gate; a save echoes the (empty) list back.
vi.mock('../../lib/mcp/servers-repo.js', () => ({
  listMcpServers: () => Promise.resolve([]),
  saveMcpServers: (servers: unknown[]) => Promise.resolve(servers),
}));

import { buildWarroomRouter } from './warroom.js';
import { buildNetworkPostureRouter } from './posture-network.js';
import { buildSecurityPostureRouter } from './posture-security.js';
import { buildIamPostureRouter } from './posture-iam.js';
import { buildObservabilityPostureRouter } from './posture-observability.js';
import { buildIamCopilotRouter } from './iam-copilot.js';
import { buildPanicRouter } from './panic.js';
import { buildSeatAdminRouter } from './seat-admin.js';
import { buildCostCapRouter } from './cost-cap.js';
import { buildCostRouter } from './cost.js';
import { buildIntegrationsRouter } from './integrations.js';
import { buildDashboardRouter } from './handler.js';

type Tier = 'viewer' | 'operator' | 'admin' | 'owner';
const ALL_TIERS: Tier[] = ['viewer', 'operator', 'admin', 'owner'];

/** Mount a single router under a prefix and issue one request. */
function call(
  build: () => Hono<{ Variables: { principal: TokenPrincipal } }>,
  prefix: string,
  path: string,
  method: string,
  tier: Tier,
  body?: unknown,
): Promise<Response> {
  const app = new Hono();
  app.route(prefix, build());
  const headers: Record<string, string> = { Authorization: `Bearer ${tier}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  // A router mounted at `prefix` with a `/` route matches the prefix WITHOUT a
  // trailing slash (Hono strips it), so request the bare prefix for the root
  // route; append the sub-path for everything else.
  const url = path === '/' ? prefix : `${prefix}${path}`;
  return Promise.resolve(app.request(url, init));
}

/** Issue a request against the FULL dashboard router (mounted at /api). */
function dash(path: string, method: string, tier: Tier, body?: unknown): Promise<Response> {
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  const headers: Record<string, string> = { Authorization: `Bearer ${tier}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(`/api${path}`, init));
}

async function expectDenied(res: Response, cap: string): Promise<void> {
  expect(res.status).toBe(403);
  const json = (await res.json()) as Record<string, unknown>;
  expect(json.requiredCapability).toBe(cap);
}

/** Allowed == the gate passed: any non-403 status. */
function expectAllowed(res: Response): void {
  expect(res.status).not.toBe(403);
}

beforeEach(() => {
  getConfig.mockReset();
  getConfig.mockResolvedValue(undefined);
  setConfig.mockReset();
  setConfig.mockResolvedValue(undefined);
});

// ───────────────────────────────────────────────────────────────────────────
// Route catalog: each entry is one gated route + the capability it requires +
// the lowest tier that should be ALLOWED. We then assert allow/deny for ALL
// four tiers against that boundary (matrix, both directions).
// ───────────────────────────────────────────────────────────────────────────

interface RouteCase {
  name: string;
  cap: string;
  /** Tiers at or above this index in ALL_TIERS are allowed. */
  minTier: Tier;
  run: (tier: Tier) => Promise<Response>;
  /**
   * When true, a denied tier may be blocked by a COARSER upstream gate (e.g. the
   * cost router's operator-tier read middleware blocks a viewer before the
   * per-route cost:write check), so we assert only HTTP 403, not the specific
   * { requiredCapability } body. The capability decision itself is still pinned
   * at the unit level. Default false (assert the exact requiredCapability body).
   */
  denyMayBeCoarse?: boolean;
}

const TIER_INDEX: Record<Tier, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

const ROUTES: RouteCase[] = [
  // ── War Room mutations: agents:write (operator+). ──────────────────────────
  {
    name: 'War Room create (POST /)',
    cap: 'agents:write',
    minTier: 'operator',
    run: (t) => call(buildWarroomRouter, '/api/warroom', '/', 'POST', t, { title: 'x' }),
  },
  {
    name: 'War Room turn (POST /:id/turn)',
    cap: 'agents:write',
    minTier: 'operator',
    run: (t) => call(buildWarroomRouter, '/api/warroom', '/m1/turn', 'POST', t, { content: 'hi' }),
  },
  {
    name: 'War Room participants (POST /:id/participants)',
    cap: 'agents:write',
    minTier: 'operator',
    run: (t) => call(buildWarroomRouter, '/api/warroom', '/m1/participants', 'POST', t, { userId: 'u1' }),
  },
  {
    name: 'War Room end (POST /:id/end)',
    cap: 'agents:write',
    minTier: 'operator',
    run: (t) => call(buildWarroomRouter, '/api/warroom', '/m1/end', 'POST', t),
  },
  {
    name: 'War Room delete (DELETE /:id)',
    cap: 'agents:write',
    minTier: 'operator',
    run: (t) => call(buildWarroomRouter, '/api/warroom', '/m1', 'DELETE', t),
  },
  // ── Posture reads: posture:read (operator+). ───────────────────────────────
  {
    name: 'Posture network (GET /)',
    cap: 'posture:read',
    minTier: 'operator',
    run: (t) => call(buildNetworkPostureRouter, '/api/posture/network', '/', 'GET', t),
  },
  {
    name: 'Posture security (GET /)',
    cap: 'posture:read',
    minTier: 'operator',
    run: (t) => call(buildSecurityPostureRouter, '/api/posture/security', '/', 'GET', t),
  },
  {
    name: 'Posture iam (GET /)',
    cap: 'posture:read',
    minTier: 'operator',
    run: (t) => call(buildIamPostureRouter, '/api/posture/iam', '/', 'GET', t),
  },
  {
    name: 'Posture observability (GET /)',
    cap: 'posture:read',
    minTier: 'operator',
    run: (t) => call(buildObservabilityPostureRouter, '/api/posture/observability', '/', 'GET', t),
  },
  // ── Cost cap write: cost:write (operator+, product-approved loosen). ────────
  {
    name: 'Cost cap set (POST /)',
    cap: 'cost:write',
    minTier: 'operator',
    run: (t) => call(buildCostCapRouter, '/api/cost-cap', '/', 'POST', t, { dailyCapUsd: 10 }),
  },
  // ── Cost evaluate (run check now): cost:write (operator+). ──────────────────
  {
    name: 'Cost evaluate (POST /evaluate)',
    cap: 'cost:write',
    minTier: 'operator',
    // The cost router's middleware gates ALL routes on operator-tier reads, so a
    // viewer is blocked there (coarser gate) before the per-route cost:write
    // check. Still a hard 403; the cost:write decision is pinned at the unit
    // level below.
    denyMayBeCoarse: true,
    run: (t) => call(buildCostRouter, '/api/cost', '/evaluate', 'POST', t),
  },
  // ── IAM copilot: security:write (admin+). The router-wide middleware gates
  // EVERY route (draft/status/apply) on security:write, so /status (GET) proves
  // the gate cleanly without /apply's secondary apply_enabled 403. "IAM apply"
  // is gated by this exact same middleware.
  {
    name: 'IAM copilot (security:write middleware, via GET /status)',
    cap: 'security:write',
    minTier: 'admin',
    run: (t) => call(buildIamCopilotRouter, '/api/iam', '/status', 'GET', t),
  },
  // ── Panic (POST /): security:write (admin+). ───────────────────────────────
  {
    name: 'Panic trigger (POST /)',
    cap: 'security:write',
    minTier: 'admin',
    run: (t) => call(buildPanicRouter, '/api/panic', '/', 'POST', t, { reason: 'test' }),
  },
  // ── Seat administration: seats:read is org-admin/owner tier, so on the
  // linear viewer<operator<admin<owner ladder even a plain ADMIN is denied
  // (minTier owner). The org-admin + seat-user shapes are matrixed in
  // seat-admin.test.ts, which owns the full seat authz coverage.
  {
    name: 'Seat admin list (GET /seats)',
    cap: 'seats:read',
    minTier: 'owner',
    run: (t) => call(buildSeatAdminRouter, '/api/seats', '/', 'GET', t),
  },
  // ── MCP server write: admin-rank AND config:write. viewer/operator are
  // blocked by the admin ROLE_RANK check first (it returns { requiredRole:
  // 'admin' }), so the deny is coarse; the config:write check is defense in
  // depth. admin/owner hold config:write and pass.
  {
    name: 'MCP servers write (PUT /integrations/mcp)',
    cap: 'config:write',
    minTier: 'admin',
    denyMayBeCoarse: true,
    run: (t) => call(buildIntegrationsRouter, '/api/integrations', '/mcp', 'PUT', t, { servers: [] }),
  },
];

describe('authorization matrix — dedicated routers', () => {
  for (const route of ROUTES) {
    describe(route.name, () => {
      for (const tier of ALL_TIERS) {
        const allowed = TIER_INDEX[tier] >= TIER_INDEX[route.minTier];
        it(`${tier} is ${allowed ? 'ALLOWED' : 'DENIED'} (needs ${route.cap})`, async () => {
          const res = await route.run(tier);
          if (allowed) expectAllowed(res);
          else if (route.denyMayBeCoarse) expect(res.status).toBe(403);
          else await expectDenied(res, route.cap);
        });
      }
    });
  }
});

// ── Handler-mounted routes (full dashboard router, /api). ───────────────────

describe('authorization matrix — handler routes', () => {
  describe('Scheduled cancel (DELETE /scheduled/:agentId/:taskId) — agents:write', () => {
    for (const tier of ALL_TIERS) {
      const allowed = TIER_INDEX[tier] >= TIER_INDEX.operator;
      it(`${tier} is ${allowed ? 'ALLOWED' : 'DENIED'}`, async () => {
        const res = await dash('/scheduled/main/t1', 'DELETE', tier);
        if (allowed) {
          expectAllowed(res);
        } else {
          // viewer is blocked by the legacy requiredRole='operator' middleware
          // first (it returns { requiredRole:'operator' }); the explicit
          // agents:write capability check is defense in depth (it additionally
          // denies a custom operator-rank profile with agents:write stripped,
          // asserted at the decision level below). Either way it's a hard 403.
          expect(res.status).toBe(403);
        }
      });
    }
  });

  // Agent CRUD + channel connect are agents:write (operator+). Each request
  // omits a body so an ALLOWED tier fails fast at validation (400) without
  // touching DDB; the point is only that the GATE passed. A DENIED viewer is
  // blocked by the coarse requiredRole='operator' middleware first (hard 403);
  // the agents:write check is defense in depth (the custom operator-rank profile
  // with agents:write stripped is pinned at the decision level below).
  const AGENT_MUTATIONS: Array<{ name: string; path: string; method: string }> = [
    { name: 'Agent create (POST /agents/create)', path: '/agents/create', method: 'POST' },
    { name: 'Agent telegram connect (POST /agents/:id/telegram/connect)', path: '/agents/main/telegram/connect', method: 'POST' },
    { name: 'Agent slack connect (POST /agents/:id/slack/connect)', path: '/agents/main/slack/connect', method: 'POST' },
  ];
  for (const route of AGENT_MUTATIONS) {
    describe(`${route.name} — agents:write`, () => {
      for (const tier of ALL_TIERS) {
        const allowed = TIER_INDEX[tier] >= TIER_INDEX.operator;
        it(`${tier} is ${allowed ? 'ALLOWED' : 'DENIED'}`, async () => {
          const res = await dash(route.path, route.method, tier);
          if (allowed) expectAllowed(res);
          else expect(res.status).toBe(403);
        });
      }
    });
  }

  const MISSION_ROUTES: Array<{
    name: string;
    path: string;
    method: string;
    capability: 'missions:read' | 'agents:write';
    minTier: Tier;
  }> = [
    {
      name: 'Mission list (GET /missions)',
      path: '/missions',
      method: 'GET',
      capability: 'missions:read',
      minTier: 'viewer',
    },
    {
      name: 'Mission create (POST /missions)',
      path: '/missions',
      method: 'POST',
      capability: 'agents:write',
      minTier: 'operator',
    },
    {
      name: 'Mission status (POST /missions/:owner/:id/status)',
      path: '/missions/main/m1/status',
      method: 'POST',
      capability: 'agents:write',
      minTier: 'operator',
    },
    {
      name: 'Mission reassign (POST /missions/:owner/:id/reassign)',
      path: '/missions/main/m1/reassign',
      method: 'POST',
      capability: 'agents:write',
      minTier: 'operator',
    },
  ];
  for (const route of MISSION_ROUTES) {
    describe(`${route.name} — ${route.capability}`, () => {
      for (const tier of ALL_TIERS) {
        const allowed = TIER_INDEX[tier] >= TIER_INDEX[route.minTier];
        it(`${tier} is ${allowed ? 'ALLOWED' : 'DENIED'}`, async () => {
          const res = await dash(route.path, route.method, tier);
          if (allowed) {
            expectAllowed(res);
          } else {
            // viewer is stopped by the coarse legacy requiredRole='operator'
            // middleware before the route's capability gate; pin that exact
            // envelope so any route swap must reproduce it. The capability
            // decision itself (agents:write / missions:read) is pinned at the
            // decision level below.
            expect(res.status).toBe(403);
            expect(await res.json()).toEqual({
              error: 'forbidden',
              requiredRole: 'operator',
              yourRole: tier,
            });
          }
        });
      }
    });
  }

  describe('Kill switch trip (POST /kill-switches) — security:write', () => {
    for (const tier of ALL_TIERS) {
      const allowed = TIER_INDEX[tier] >= TIER_INDEX.admin;
      it(`${tier} is ${allowed ? 'ALLOWED' : 'DENIED'}`, async () => {
        const res = await dash('/kill-switches', 'POST', tier, {
          name: 'bedrock_global',
          active: true,
          reason: 'test',
        });
        if (allowed) {
          // admin/owner pass BOTH the legacy requiredRole=admin middleware AND
          // the explicit security:write capability check.
          expectAllowed(res);
        } else {
          // viewer/operator are blocked. viewer/operator fail the legacy
          // requiredRole=admin middleware first (requiredRole), which emits the
          // legacy { requiredRole:'admin' } 403 — still a hard DENY. We assert
          // 403 either way; the capability check is the defense-in-depth gate
          // that also blocks a custom admin-rank profile with security:write
          // stripped (covered by the unit test below).
          expect(res.status).toBe(403);
        }
      });
    }
  });

  describe('Cost watch toggle (POST /config/cost/watch_enabled) — config:write', () => {
    for (const tier of ALL_TIERS) {
      const allowed = TIER_INDEX[tier] >= TIER_INDEX.operator;
      it(`${tier} is ${allowed ? 'ALLOWED' : 'DENIED'}`, async () => {
        const res = await dash('/config/cost/watch_enabled', 'POST', tier, { value: 'true' });
        if (allowed) expectAllowed(res);
        else await expectDenied(res, 'config:write');
      });
    }
  });

  it('Rate-limits config write stays admin-only (UNCHANGED): operator DENIED, admin ALLOWED', async () => {
    // Defensive: the cost loosen must NOT have widened OTHER config categories.
    // rate_limits write is still gated by the legacy requiredRole=admin
    // middleware, so operator is blocked there.
    const op = await dash('/config/rate_limits/some_key', 'POST', 'operator', { value: '5' });
    expect(op.status).toBe(403);
    const admin = await dash('/config/rate_limits/some_key', 'POST', 'admin', { value: '5' });
    expect(admin.status).not.toBe(403);
  });

  // NZR-43: config reads are gated by the in-route category policy, which
  // answers every refusal with { error:'forbidden_category' } (no
  // requiredCapability, so the body is asserted directly).
  const CONFIG_READS: Array<{ name: string; path: string; minTier: Tier | null }> = [
    { name: 'Runtime config read (GET /config/power) — security:read', path: '/config/power', minTier: 'admin' },
    { name: 'Runtime config read (GET /config/oauth) — denied for every tier', path: '/config/oauth', minTier: null },
    { name: 'Runtime config read (GET /config/profile) — dashboard:read', path: '/config/profile', minTier: 'viewer' },
  ];
  for (const route of CONFIG_READS) {
    describe(route.name, () => {
      for (const tier of ALL_TIERS) {
        const allowed = route.minTier !== null && TIER_INDEX[tier] >= TIER_INDEX[route.minTier];
        it(`${tier} is ${allowed ? 'ALLOWED' : 'DENIED'}`, async () => {
          const res = await dash(route.path, 'GET', tier);
          if (allowed) {
            expect(res.status).toBe(200);
          } else {
            expect(res.status).toBe(403);
            expect(await res.json()).toEqual({ error: 'forbidden_category' });
          }
        });
      }
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Defense-in-depth UNIT check: the kill-switch capability gate must deny a
// custom admin-RANK profile whose security:write has been STRIPPED, even though
// it would clear the legacy requiredRole=admin middleware. This is the exact
// gap the explicit capability check closes; assert it at the decision level.
// ───────────────────────────────────────────────────────────────────────────

import {
  requireCapability,
  TEMPLATED_PROFILES,
  type Capability,
} from '../../lib/auth/permissions.js';
import {
  ALL_KILL_SWITCHES,
  KILL_SWITCH_META,
} from '../../lib/state/kill-switches-repo.js';

describe('Paperclip kill-switch inventory', () => {
  it('registers paperclip_disabled with integration metadata', () => {
    expect(ALL_KILL_SWITCHES).toContain('paperclip_disabled');
    expect((KILL_SWITCH_META as Record<string, unknown>).paperclip_disabled).toEqual({
      description: 'Disable the Paperclip integration.',
      category: 'Integrations',
    });
  });
});

describe('mission capability gates (defense in depth)', () => {
  it('denies a custom operator-rank profile with agents:write stripped on mutation', () => {
    const stripped: Capability[] = TEMPLATED_PROFILES.operator.filter((c) => c !== 'agents:write');
    const custom = {
      profileId: 'custom-op-no-mission-write',
      label: 'Operator without mission mutations',
      capabilities: stripped,
      createdBy: 'test',
      createdAt: '2026-01-01',
    };
    expect(requireCapability(custom.profileId, 'agents:write', custom).allowed).toBe(false);
  });

  it('denies a custom viewer-rank profile with missions:read stripped on read', () => {
    const stripped: Capability[] = TEMPLATED_PROFILES.viewer.filter((c) => c !== 'missions:read');
    const custom = {
      profileId: 'custom-viewer-no-mission-read',
      label: 'Viewer without mission reads',
      capabilities: stripped,
      createdBy: 'test',
      createdAt: '2026-01-01',
    };
    expect(requireCapability(custom.profileId, 'missions:read', custom).allowed).toBe(false);
  });
});

describe('kill-switch capability gate (defense in depth)', () => {
  it('denies a custom admin-rank profile with security:write stripped', () => {
    const stripped: Capability[] = TEMPLATED_PROFILES.admin.filter((c) => c !== 'security:write');
    const custom = {
      profileId: 'custom-admin-no-sec',
      label: 'Admin without kill switches',
      capabilities: stripped,
      createdBy: 'test',
      createdAt: '2026-01-01',
    };
    const decision = requireCapability('custom-admin-no-sec', 'security:write', custom);
    expect(decision.allowed).toBe(false);
  });

  it('allows a real admin/owner to trip switches (holds security:write)', () => {
    expect(requireCapability('admin', 'security:write').allowed).toBe(true);
    expect(requireCapability('owner', 'security:write').allowed).toBe(true);
  });

  it('denies operator/viewer at the security:write gate', () => {
    expect(requireCapability('operator', 'security:write').allowed).toBe(false);
    expect(requireCapability('viewer', 'security:write').allowed).toBe(false);
  });
});

describe('scheduled-cancel capability gate (defense in depth)', () => {
  it('denies a custom operator-rank profile with agents:write stripped', () => {
    const stripped: Capability[] = TEMPLATED_PROFILES.operator.filter((c) => c !== 'agents:write');
    const custom = {
      profileId: 'custom-op-no-agents',
      label: 'Operator without agent mutations',
      capabilities: stripped,
      createdBy: 'test',
      createdAt: '2026-01-01',
    };
    expect(requireCapability('custom-op-no-agents', 'agents:write', custom).allowed).toBe(false);
  });

  it('allows operator/admin/owner to cancel (hold agents:write)', () => {
    expect(requireCapability('operator', 'agents:write').allowed).toBe(true);
    expect(requireCapability('admin', 'agents:write').allowed).toBe(true);
    expect(requireCapability('owner', 'agents:write').allowed).toBe(true);
  });

  it('denies viewer at the agents:write gate', () => {
    expect(requireCapability('viewer', 'agents:write').allowed).toBe(false);
  });
});

describe('cost capability gates (decision level)', () => {
  it('cost:write is operator-tier: operator/admin/owner allowed, viewer denied', () => {
    expect(requireCapability('operator', 'cost:write').allowed).toBe(true);
    expect(requireCapability('admin', 'cost:write').allowed).toBe(true);
    expect(requireCapability('owner', 'cost:write').allowed).toBe(true);
    expect(requireCapability('viewer', 'cost:write').allowed).toBe(false);
  });

  it('config:write is operator-tier: operator/admin/owner allowed, viewer denied', () => {
    expect(requireCapability('operator', 'config:write').allowed).toBe(true);
    expect(requireCapability('admin', 'config:write').allowed).toBe(true);
    expect(requireCapability('owner', 'config:write').allowed).toBe(true);
    expect(requireCapability('viewer', 'config:write').allowed).toBe(false);
  });

  it('posture:read is operator-tier: operator/admin/owner allowed, viewer denied', () => {
    expect(requireCapability('operator', 'posture:read').allowed).toBe(true);
    expect(requireCapability('admin', 'posture:read').allowed).toBe(true);
    expect(requireCapability('owner', 'posture:read').allowed).toBe(true);
    expect(requireCapability('viewer', 'posture:read').allowed).toBe(false);
  });
});
