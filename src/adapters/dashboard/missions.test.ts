/**
 * Phase 7's acceptance, executed.
 *
 * The centrepiece is ENVELOPE EQUALITY: every one of the four routes, and every
 * 400/403/404 shape they can produce, is driven TWICE through the REAL
 * `buildDashboardRouter()` — once with the flag off (the legacy DynamoDB stack)
 * and once with it on (the Paperclip ACL) — and the two responses are compared
 * as RAW TEXT, not as parsed objects. Raw text pins key ORDER as well as key
 * set, which is what "byte-for-byte" means and what `toEqual` would let slide.
 *
 * Both stacks are fed identical rows, so any difference in the bytes is a
 * difference the ACL introduced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// ── The flag, and the ACL functions behind it ─────────────────────────────
const { flag, acl } = vi.hoisted(() => ({
  flag: { on: false },
  acl: {
    listBoardMissions: vi.fn(),
    listBoardMissionsByStatus: vi.fn(),
    createBoardMission: vi.fn(),
    setBoardMissionStatus: vi.fn(),
    reassignBoardMission: vi.fn(),
    toWireMission: vi.fn(),
    missionEngine: vi.fn(),
    __setMissionEngineForTest: vi.fn(),
  },
}));
vi.mock('../../lib/missions/mission-acl.js', () => ({
  paperclipRoutingEnabled: () => flag.on,
  ...acl,
}));

// ── The legacy repo behind the legacy stack ───────────────────────────────
const { repo } = vi.hoisted(() => ({
  repo: {
    listMissionsForAgent: vi.fn(),
    listMissionsByStatus: vi.fn(),
    createMission: vi.fn(),
    updateMissionStatus: vi.fn(),
    reassignMission: vi.fn(),
  },
}));
vi.mock('../../lib/state/mission-tasks-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/mission-tasks-repo.js')>();
  return { ...actual, ...repo };
});

const { switches } = vi.hoisted(() => ({
  switches: {} as Record<string, { active: boolean; reason?: string }>,
}));
vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return {
    ...actual,
    isKillSwitchActive: vi.fn((name: string) =>
      Promise.resolve(switches[name] ?? { active: false }),
    ),
  };
});

const { assign } = vi.hoisted(() => ({ assign: vi.fn() }));
vi.mock('../../lib/tools/mission-tools.js', () => ({ autoAssign: assign }));

vi.mock('../../lib/config/agent-loader.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/config/agent-loader.js')>();
  return { ...actual, listKnownAgents: () => ['main', 'research'] };
});

vi.mock('../../lib/audit/audit-writer.js', () => ({
  writeAudit: vi.fn(() => Promise.resolve()),
  writeAuditOrThrow: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  truncateForLog: (s: string) => s,
}));

// ── Auth: the bearer IS the tier, as in authz-matrix.test.ts ──────────────
function principalFor(raw: string): TokenPrincipal | null {
  const id = raw.replace(/^Bearer\s+/i, '');
  if (id === 'viewer' || id === 'operator' || id === 'admin') {
    return { tokenHash: `hash-${id}`, label: id, hashPrefix16: id, role: id };
  }
  // Admin RANK (clears the legacy ladder) carrying the VIEWER capability set —
  // the capability-drifted principal the per-route gate exists for.
  if (id === 'capless') {
    return {
      tokenHash: 'hash-capless',
      label: 'capless',
      hashPrefix16: 'capless',
      role: 'admin',
      profileId: 'viewer',
    };
  }
  return null;
}
vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (authHeader?: string) => (authHeader ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
  };
});

import { buildDashboardRouter } from './handler.js';
import { registerMissionRoutes } from './missions.js';
import { RESOURCE_META } from '../../lib/jarvis/route-manifest.js';
import { CAPABILITIES } from '../../lib/auth/permissions.js';
import {
  PaperclipDisabledError,
  PaperclipInvalidInputError,
  PaperclipRatelimitedError,
  PaperclipUnavailableError,
} from '../../lib/paperclip/error.js';
import { UnknownAgentError } from '../../lib/paperclip/mission-projection.js';

const ISSUE = 'aaaaaaaa-1111-4111-8111-111111111111';

/** One row, identical on both stacks, so a byte difference can only be the ACL's. */
const ROW = {
  id: ISSUE,
  ownerAgent: 'main',
  createdByAgent: 'dashboard',
  createdByChat: 'dashboard:hash-admin',
  title: 'Ship the ACL',
  body: 'Byte for byte.',
  priority: 'medium',
  status: 'open',
  assignmentReason: 'explicit assignment',
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
};

function build(on: boolean): Hono {
  flag.on = on;
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  return app;
}

function req(app: Hono, path: string, method = 'GET', tier = 'admin', body?: unknown) {
  const headers: Record<string, string> = { Authorization: `Bearer ${tier}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return app.request(`/api${path}`, init);
}

/** Drive the SAME request through both stacks and return `{status, text}` for each. */
async function both(
  path: string,
  method = 'GET',
  tier = 'admin',
  body?: unknown,
): Promise<{ legacy: { status: number; text: string }; aclRes: { status: number; text: string } }> {
  const l = await req(build(false), path, method, tier, body);
  const a = await req(build(true), path, method, tier, body);
  return {
    legacy: { status: l.status, text: await l.text() },
    aclRes: { status: a.status, text: await a.text() },
  };
}

beforeEach(() => {
  for (const key of Object.keys(switches)) delete switches[key];
  for (const fn of Object.values(repo)) fn.mockReset();
  for (const fn of Object.values(acl)) fn.mockReset();
  assign.mockReset();
  // Happy-path defaults: the two stacks return the SAME data.
  repo.listMissionsForAgent.mockResolvedValue([ROW]);
  acl.listBoardMissions.mockResolvedValue([ROW]);
  repo.createMission.mockResolvedValue(ROW);
  acl.createBoardMission.mockResolvedValue(ROW);
  repo.updateMissionStatus.mockResolvedValue(true);
  acl.setBoardMissionStatus.mockResolvedValue(true);
  repo.reassignMission.mockResolvedValue(ROW);
  acl.reassignBoardMission.mockResolvedValue(ROW);
});

// ═══════════════════════════════════════════════════════════════════════════
// ACCEPTANCE 3 — envelope equality, field for field, byte for byte.
// ═══════════════════════════════════════════════════════════════════════════
describe('ACCEPTANCE 3: the ACL response is byte-identical to the recorded legacy response', () => {
  it('R1 GET /missions — {owner, count, missions}', async () => {
    const { legacy, aclRes } = await both('/missions?owner=main');
    expect(legacy.status).toBe(200);
    expect(legacy.text).toBe(
      JSON.stringify({ owner: 'main', count: 1, missions: [ROW] }),
    );
    expect(aclRes.status).toBe(legacy.status);
    expect(aclRes.text).toBe(legacy.text);
  });

  it('R1 defaults `owner` to main and does not validate it (unknown owner is 200/count:0, never 404)', async () => {
    repo.listMissionsForAgent.mockResolvedValue([]);
    acl.listBoardMissions.mockResolvedValue([]);
    const { legacy, aclRes } = await both('/missions');
    expect(legacy.text).toBe(JSON.stringify({ owner: 'main', count: 0, missions: [] }));
    expect(aclRes.status).toBe(200);
    expect(aclRes.text).toBe(legacy.text);
    expect(acl.listBoardMissions).toHaveBeenCalledWith('main', 100);
  });

  it('R2 POST /missions — 201 {mission}, and BOTH stacks stamp the same createdByChat', async () => {
    const { legacy, aclRes } = await both('/missions', 'POST', 'admin', {
      prompt: 'Ship the ACL',
      agentId: 'main',
    });
    expect(legacy.status).toBe(201);
    expect(legacy.text).toBe(JSON.stringify({ mission: ROW }));
    expect(aclRes.status).toBe(201);
    expect(aclRes.text).toBe(legacy.text);
    expect(acl.createBoardMission.mock.calls[0][0]).toEqual(
      repo.createMission.mock.calls[0][0],
    );
    expect(acl.createBoardMission.mock.calls[0][0].createdByChat).toBe('dashboard:hash-admin');
  });

  it('R2 degrades an auto-assign failure to main + a 201, on both stacks', async () => {
    assign.mockRejectedValue(new Error('haiku down'));
    const { legacy, aclRes } = await both('/missions', 'POST', 'admin', { prompt: 'no agent' });
    expect(legacy.status).toBe(201);
    expect(aclRes.status).toBe(201);
    expect(acl.createBoardMission.mock.calls[0][0]).toMatchObject({
      ownerAgent: 'main',
      assignmentReason: 'auto-assign failed; defaulted to main',
    });
  });

  it('R3 POST /missions/:owner/:id/status — {ok, owner, id, status}, echoing the REQUEST params', async () => {
    const { legacy, aclRes } = await both(`/missions/main/aaaaaaaa/status`, 'POST', 'admin', {
      status: 'done',
    });
    expect(legacy.text).toBe(
      JSON.stringify({ ok: true, owner: 'main', id: 'aaaaaaaa', status: 'done' }),
    );
    expect(aclRes.status).toBe(legacy.status);
    expect(aclRes.text).toBe(legacy.text);
  });

  it('R4 POST /missions/:owner/:id/reassign — {ok, mission}', async () => {
    const { legacy, aclRes } = await both(`/missions/main/${ISSUE}/reassign`, 'POST', 'admin', {
      ownerAgent: 'research',
    });
    expect(legacy.text).toBe(JSON.stringify({ ok: true, mission: ROW }));
    expect(aclRes.status).toBe(legacy.status);
    expect(aclRes.text).toBe(legacy.text);
  });

  it('a row without assignmentReason omits it and the retired dueAt key on both stacks', async () => {
    const bare = { ...ROW } as Record<string, unknown>;
    delete bare.assignmentReason;
    repo.listMissionsForAgent.mockResolvedValue([bare]);
    acl.listBoardMissions.mockResolvedValue([bare]);
    const { legacy, aclRes } = await both('/missions');
    expect(legacy.text).not.toContain('assignmentReason');
    expect(legacy.text).not.toContain('dueAt');
    expect(aclRes.text).toBe(legacy.text);
  });

  // ── every 400 / 404 shape ──────────────────────────────────────────────
  const ERROR_CASES: Array<{
    name: string;
    path: string;
    body?: unknown;
    expected: string;
    status: number;
    arrange?: () => void;
  }> = [
    {
      name: 'R2 missing_prompt (unparseable body)',
      path: '/missions',
      expected: JSON.stringify({ error: 'missing_prompt' }),
      status: 400,
    },
    {
      name: 'R2 missing_prompt (whitespace prompt)',
      path: '/missions',
      body: { prompt: '   ' },
      expected: JSON.stringify({ error: 'missing_prompt' }),
      status: 400,
    },
    {
      name: 'R2 unknown_agent — key is `agentId`, `valid` is the known list',
      path: '/missions',
      body: { prompt: 'x', agentId: 'ghost' },
      expected: JSON.stringify({
        error: 'unknown_agent',
        agentId: 'ghost',
        valid: ['main', 'research'],
      }),
      status: 400,
    },
    {
      name: 'R3 missing_status (no body)',
      path: '/missions/main/m1/status',
      expected: JSON.stringify({ error: 'missing_status' }),
      status: 400,
    },
    {
      name: 'R3 missing_status (falsy status)',
      path: '/missions/main/m1/status',
      body: { status: '' },
      expected: JSON.stringify({ error: 'missing_status' }),
      status: 400,
    },
    {
      name: 'R3 invalid_status — `valid` in MISSION_STATUSES order',
      path: '/missions/main/m1/status',
      body: { status: 'nope' },
      expected: JSON.stringify({
        error: 'invalid_status',
        status: 'nope',
        valid: ['open', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'],
      }),
      status: 400,
    },
    {
      name: 'R3 not_found — echoes the request owner + id',
      path: '/missions/main/m1/status',
      body: { status: 'done' },
      expected: JSON.stringify({ error: 'not_found', owner: 'main', id: 'm1' }),
      status: 404,
      arrange: () => {
        repo.updateMissionStatus.mockResolvedValue(false);
        acl.setBoardMissionStatus.mockResolvedValue(false);
      },
    },
    {
      name: 'R4 missing_ownerAgent',
      path: '/missions/main/m1/reassign',
      body: {},
      expected: JSON.stringify({ error: 'missing_ownerAgent' }),
      status: 400,
    },
    {
      name: 'R4 unknown_agent — key is `agentId` despite the request field being `ownerAgent`',
      path: '/missions/main/m1/reassign',
      body: { ownerAgent: 'ghost' },
      expected: JSON.stringify({
        error: 'unknown_agent',
        agentId: 'ghost',
        valid: ['main', 'research'],
      }),
      status: 400,
    },
    {
      name: 'R4 not_found',
      path: '/missions/main/m1/reassign',
      body: { ownerAgent: 'research' },
      expected: JSON.stringify({ error: 'not_found', owner: 'main', id: 'm1' }),
      status: 404,
      arrange: () => {
        repo.reassignMission.mockResolvedValue(null);
        acl.reassignBoardMission.mockResolvedValue(null);
      },
    },
  ];

  for (const c of ERROR_CASES) {
    it(`${c.name} is byte-identical on both stacks`, async () => {
      c.arrange?.();
      const { legacy, aclRes } = await both(c.path, 'POST', 'admin', c.body);
      expect(legacy.status).toBe(c.status);
      expect(legacy.text).toBe(c.expected);
      expect(aclRes.status).toBe(c.status);
      expect(aclRes.text).toBe(c.expected);
    });
  }

  it('the per-route capability 403 is byte-identical on both stacks (admin rank, viewer caps)', async () => {
    for (const [path, body] of [
      ['/missions', { prompt: 'x' }],
      ['/missions/main/m1/status', { status: 'done' }],
      ['/missions/main/m1/reassign', { ownerAgent: 'research' }],
    ] as const) {
      const { legacy, aclRes } = await both(path, 'POST', 'capless', body);
      expect(legacy.status).toBe(403);
      expect(legacy.text).toBe(
        JSON.stringify({ error: 'forbidden', requiredCapability: 'agents:write' }),
      );
      expect(aclRes.status).toBe(403);
      expect(aclRes.text).toBe(legacy.text);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ACCEPTANCE 1 — the legacy ladder still answers, WITH THE ACL ARMED.
// ═══════════════════════════════════════════════════════════════════════════
describe('ACCEPTANCE 1: authz-matrix invariance with the ACL registered', () => {
  it('viewer POST /missions is the exact legacy ladder body, and NO handler runs', async () => {
    for (const on of [false, true]) {
      const res = await req(build(on), '/missions', 'POST', 'viewer', { prompt: 'x' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'forbidden',
        requiredRole: 'operator',
        yourRole: 'viewer',
      });
    }
    // The middleware returns BEFORE `await next()`, so neither stack's body ran.
    expect(acl.createBoardMission).not.toHaveBeenCalled();
    expect(repo.createMission).not.toHaveBeenCalled();
  });

  it('viewer GET /missions still passes the ladder and reaches the ACL (minTier viewer)', async () => {
    const res = await req(build(true), '/missions', 'GET', 'viewer');
    expect(res.status).not.toBe(403);
    expect(acl.listBoardMissions).toHaveBeenCalled();
  });

  it('the routes are on the DASHBOARD router — an unauthenticated call still 401s from its middleware', async () => {
    const app = build(true);
    const res = await app.request('/api/missions', { method: 'GET' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(acl.listBoardMissions).not.toHaveBeenCalled();
  });

  it('dashboard_read_disabled still wins over everything on the GET, ACL armed', async () => {
    switches.dashboard_read_disabled = { active: true, reason: 'maintenance' };
    const res = await req(build(true), '/missions');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'dashboard_read_disabled',
      reason: 'maintenance',
    });
    expect(acl.listBoardMissions).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ACCEPTANCE 2 — route-manifest.ts and permissions.ts unchanged.
// ═══════════════════════════════════════════════════════════════════════════
describe('ACCEPTANCE 2: no manifest entry and no new capability', () => {
  it('missions stays a viewer-tier Jarvis resource accepting only `owner`', () => {
    expect(RESOURCE_META.missions).toEqual({
      minRole: 'viewer',
      description: 'Open missions + priority.',
      acceptedParams: ['owner'],
    });
  });

  it('the ACL introduced no capability — the two mission gates are the pre-existing ones', () => {
    const missionCaps = CAPABILITIES.filter((c) => c.startsWith('missions:'));
    expect(missionCaps).toEqual(['missions:read']);
    expect(CAPABILITIES).toContain('agents:write');
    expect(CAPABILITIES.some((c) => c.includes('paperclip'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ACCEPTANCE 7 — two off-switches, neither a silent fallback.
// ═══════════════════════════════════════════════════════════════════════════
describe('ACCEPTANCE 7a: PAPERCLIP_ENABLED=false — the ACL is not mounted, legacy serves', () => {
  it('every route is served by the DynamoDB repo, and no ACL function is called', async () => {
    const app = build(false);
    await req(app, '/missions');
    await req(app, '/missions', 'POST', 'admin', { prompt: 'x', agentId: 'main' });
    await req(app, '/missions/main/m1/status', 'POST', 'admin', { status: 'done' });
    await req(app, '/missions/main/m1/reassign', 'POST', 'admin', { ownerAgent: 'research' });

    expect(repo.listMissionsForAgent).toHaveBeenCalled();
    expect(repo.createMission).toHaveBeenCalled();
    expect(repo.updateMissionStatus).toHaveBeenCalled();
    expect(repo.reassignMission).toHaveBeenCalled();
    for (const fn of Object.values(acl)) expect(fn).not.toHaveBeenCalled();
  });

  it('and with the flag ON the legacy repo is unreachable — one stack or the other, never both', async () => {
    const app = build(true);
    await req(app, '/missions');
    await req(app, '/missions', 'POST', 'admin', { prompt: 'x', agentId: 'main' });
    await req(app, '/missions/main/m1/status', 'POST', 'admin', { status: 'done' });
    await req(app, '/missions/main/m1/reassign', 'POST', 'admin', { ownerAgent: 'research' });
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('ACCEPTANCE 7b: paperclip_disabled — ACL mounted, 503, and NO mid-request fallback', () => {
  const CALLS: Array<[string, string, unknown]> = [
    ['/missions', 'GET', undefined],
    ['/missions', 'POST', { prompt: 'x', agentId: 'main' }],
    ['/missions/main/m1/status', 'POST', { status: 'done' }],
    ['/missions/main/m1/reassign', 'POST', { ownerAgent: 'research' }],
  ];

  for (const [path, method, body] of CALLS) {
    it(`${method} ${path} refuses with 503 {error:'paperclip_disabled'} and touches neither stack's store`, async () => {
      switches.paperclip_disabled = { active: true, reason: 'incident 42' };
      const res = await req(build(true), path, method, 'admin', body);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: 'paperclip_disabled',
        reason: 'incident 42',
      });
      // The refusal is RETURNED. It never reads DynamoDB instead.
      for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
      for (const fn of Object.values(acl)) expect(fn).not.toHaveBeenCalled();
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// The rungs only the ACL has. Driven on a bare router with injected deps, so
// the gate order and the transport-error mapping are asserted directly.
// ═══════════════════════════════════════════════════════════════════════════
describe('ACL-only rungs: gate order and transport-error mapping', () => {
  function bare(deps: Partial<Parameters<typeof registerMissionRoutes>[1]> = {}) {
    const app = new Hono();
    registerMissionRoutes(app as never, {
      hasCapability: () => Promise.resolve(true),
      identity: () => 'dashboard:test',
      killSwitch: () => Promise.resolve({ active: false }),
      knownAgents: () => ['main', 'research'],
      assign: () => Promise.resolve({ owner: 'main', reason: 'r' }),
      list: () => Promise.resolve([]),
      create: () => Promise.resolve(ROW as never),
      setStatus: () => Promise.resolve(true),
      reassign: () => Promise.resolve(ROW as never),
      ...deps,
    });
    return app;
  }

  it('AUTHORIZATION FIRST: an unauthorized caller gets 403, never the switch reason', async () => {
    // The switch `reason` is operator free text. Answering the switch ahead of
    // the capability gate would hand an incident note to a principal the
    // legacy stack answered `403 forbidden` — an authorization-ordering
    // inversion. The 403 must win, and the reason must not appear.
    const app = bare({
      killSwitch: () =>
        Promise.resolve({ active: true, reason: 'INCIDENT-42: customer PII in board titles' }),
      hasCapability: () => Promise.resolve(false),
    });
    const res = await app.request('/missions');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      requiredCapability: 'missions:read',
    });
    expect(await (await app.request('/missions')).text()).not.toContain('INCIDENT-42');
  });

  it('and an AUTHORIZED caller still gets the 503 before any Paperclip call', async () => {
    const list = vi.fn(() => Promise.resolve([]));
    const res = await bare({
      killSwitch: () => Promise.resolve({ active: true, reason: 'off' }),
      hasCapability: () => Promise.resolve(true),
      list,
    }).request('/missions');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'paperclip_disabled', reason: 'off' });
    expect(list).not.toHaveBeenCalled();
  });

  it('ONE SHAPE: the pre-flight refusal and the mid-sequence one are byte-identical', async () => {
    // Two rungs, one condition. The mid-sequence path used to drop `reason`,
    // which gave a client two bodies for the same refusal.
    const killSwitch = () => Promise.resolve({ active: true, reason: 'off' });
    const gate = await bare({ killSwitch }).request('/missions');

    const midSequence = await bare({
      killSwitch: () => Promise.resolve({ active: false, reason: 'off' }),
      list: () => Promise.reject(new PaperclipDisabledError()),
    }).request('/missions');

    expect(gate.status).toBe(503);
    expect(midSequence.status).toBe(503);
    // The mid-sequence rung re-reads the switch, so it recovers the same
    // `reason` the gate would have printed. Compared as BYTES, because two
    // bodies for one refusal is exactly what a `toEqual`-style consumer trips
    // on and what round 1 shipped.
    const gateBody = await gate.text();
    expect(await midSequence.text()).toBe(gateBody);
    expect(JSON.parse(gateBody)).toEqual({ error: 'paperclip_disabled', reason: 'off' });
  });

  it('R1 denies missions:read with the legacy capability envelope', async () => {
    const res = await bare({ hasCapability: () => Promise.resolve(false) }).request('/missions');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      requiredCapability: 'missions:read',
    });
  });

  it('a PaperclipDisabledError thrown MID-SEQUENCE is returned as the same 503, never as legacy data', async () => {
    const res = await bare({
      setStatus: () => Promise.reject(new PaperclipDisabledError()),
    }).request('/missions/main/m1/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'paperclip_disabled' });
  });

  it('a Paperclip 404 becomes the byte-identical legacy not_found', async () => {
    const res = await bare({
      setStatus: () => Promise.reject(new PaperclipInvalidInputError({ status: 404 })),
    }).request('/missions/main/m1/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(
      JSON.stringify({ error: 'not_found', owner: 'main', id: 'm1' }),
    );
  });

  it('an UnknownAgentError becomes the legacy unknown_agent 400 (key `agentId`)', async () => {
    const res = await bare({
      reassign: () => Promise.reject(new UnknownAgentError({ slug: 'ghost' }, ['main'])),
    }).request('/missions/main/m1/reassign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerAgent: 'research' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'unknown_agent',
      agentId: 'ghost',
      valid: ['main'],
    });
  });

  it('a transport outage is 503 paperclip_unavailable — LOUD, never a short board', async () => {
    const res = await bare({
      list: () => Promise.reject(new PaperclipUnavailableError({ status: 502 })),
    }).request('/missions');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'paperclip_unavailable' });
  });

  it('a 429 carries Retry-After through', async () => {
    const headers = new Headers({ 'retry-after': '30' });
    const res = await bare({
      list: () => Promise.reject(new PaperclipRatelimitedError({ status: 429, headers })),
    }).request('/missions');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({ error: 'paperclip_ratelimited' });
  });

  it('an unmappable throw is rethrown, so it lands on the legacy 500 internal_error rung', async () => {
    const app = bare({ list: () => Promise.reject(new Error('kaboom')) });
    app.onError((_e, c) => c.json({ error: 'internal_error' }, 500));
    const res = await app.request('/missions');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P1-2 — the hierarchy fields reach the ENVELOPE, and only additively.
//
// R1 re-maps nothing: it answers `{owner, count, missions: rows}` with the
// rows the ACL handed it. That is exactly what this pair pins — that the four
// additive keys survive the route untouched AND that a row without them is
// still byte-identical to the legacy stack's answer.
// ═══════════════════════════════════════════════════════════════════════════
describe('P1-2: R1 carries the additive hierarchy fields for a Paperclip-backed row', () => {
  const PARENT = 'bbbbbbbb-2222-4222-8222-222222222222';

  /** A wire row as `toWireMission` builds it: the ten legacy keys, then P1-2's. */
  const HIERARCHY_ROW = {
    ...ROW,
    parentId: PARENT,
    paperclipStatus: 'blocked',
    blockerAttention: { state: 'needs_attention', reason: 'attention_required' },
    childCount: 2,
  };

  it('passes all four keys through in the ACL\'s order, byte for byte', async () => {
    acl.listBoardMissions.mockResolvedValue([HIERARCHY_ROW]);
    const res = await req(build(true), '/missions?owner=main');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      JSON.stringify({ owner: 'main', count: 1, missions: [HIERARCHY_ROW] }),
    );
  });

  it('carries only the two identifier-free blockerAttention keys — no counts, no samples', async () => {
    // The measured wire object has eight keys and two of them
    // (`sampleBlockerIdentifier`, `sampleStalledBlockerIdentifier`) are
    // Paperclip issue identifiers, which this envelope has never exposed.
    acl.listBoardMissions.mockResolvedValue([HIERARCHY_ROW]);
    const res = await req(build(true), '/missions?owner=main');
    const body = (await res.json()) as { missions: Array<Record<string, unknown>> };
    expect(Object.keys(body.missions[0].blockerAttention as object)).toEqual(['state', 'reason']);
    expect(await (await req(build(true), '/missions?owner=main')).text()).not.toContain('sampleBlockerIdentifier');
  });

  it('and a row WITHOUT them is still byte-identical to the legacy stack', async () => {
    const { legacy, aclRes } = await both('/missions?owner=main');
    expect(aclRes.text).toBe(legacy.text);
    for (const key of ['parentId', 'paperclipStatus', 'blockerAttention', 'childCount']) {
      expect(aclRes.text).not.toContain(key);
    }
  });
});
