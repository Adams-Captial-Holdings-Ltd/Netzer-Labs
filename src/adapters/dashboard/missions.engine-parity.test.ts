/**
 * THE LAYER `missions.test.ts` CANNOT SEE.
 *
 * That suite mocks `mission-acl.js` wholesale, which is right for pinning the
 * four ROUTE envelopes but blinds it to everything the ACL itself decides. A
 * whole class of contract break lives in that blind spot, and one of them
 * shipped: `engine.listMissions` resolves `ownerAgent` through
 * `toUuidOrThrow(...)` before it reaches the wire, so an owner slug that Netzar
 * knows but Paperclip's `metadata.netzarAgentId` map does not — a newly added
 * agent, a bootstrap that has not run, an agent-map cache that has not expired —
 * threw `UnknownAgentError` on a mere SCOPING parameter and surfaced as
 * `400 unknown_agent` where legacy answered `200 {count:0}` (R1) or
 * `404 not_found` (R3/R4). Reachable from the UNEDITED SPA: `Missions.tsx:110`
 * renders an error board on a rejected fetch, and the "All agents" fan-out at
 * `:100` swallows it, so a whole agent's lane vanished silently.
 *
 * So this file wires the REAL `buildDashboardRouter()` to the REAL
 * `mission-acl.ts` and stubs only the ENGINE — the seam one layer below the ACL
 * — and diffs raw response bytes against the legacy DynamoDB stack fed identical
 * data. The two agent lists are deliberately DIFFERENT, because that skew is the
 * permanent condition this phase runs in: Netzar's `listKnownAgents()` returns
 * `main, research, newbie`; the injected Paperclip map knows only `main`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// The router flag. `mission-acl.ts` reads it through `loadEnv()` on every call.
const { flag } = vi.hoisted(() => ({ flag: { value: undefined as string | undefined } }));
vi.mock('../../config/env.js', async (importActual) => {
  const actual = await importActual<typeof import('../../config/env.js')>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), CCE_PAPERCLIP_ENABLED: flag.value }) };
});

// Provenance: an in-memory map, so the C-11 join is real rather than mocked away.
const { provStore } = vi.hoisted(() => ({ provStore: new Map<string, Record<string, unknown>>() }));
vi.mock('../../lib/state/mission-provenance-repo.js', () => ({
  putMissionProvenance: vi.fn((row: { missionId: string }) => {
    provStore.set(row.missionId, row as Record<string, unknown>);
    return Promise.resolve();
  }),
  getMissionProvenance: vi.fn((ids: readonly string[]) =>
    Promise.resolve(
      new Map(ids.filter((id) => provStore.has(id)).map((id) => [id, provStore.get(id)])),
    ),
  ),
}));

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

vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive: vi.fn(() => Promise.resolve({ active: false })) };
});

const { assign } = vi.hoisted(() => ({ assign: vi.fn() }));
vi.mock('../../lib/tools/mission-tools.js', () => ({ autoAssign: assign }));

// NETZAR's agent list. Note `newbie`, which Paperclip's map below does NOT know.
vi.mock('../../lib/config/agent-loader.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/config/agent-loader.js')>();
  return { ...actual, listKnownAgents: () => ['main', 'research', 'newbie'] };
});

vi.mock('../../lib/audit/audit-writer.js', () => ({
  writeAudit: vi.fn(() => Promise.resolve()),
  writeAuditOrThrow: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  truncateForLog: (s: string) => s,
}));

function principalFor(raw: string): TokenPrincipal | null {
  const id = raw.replace(/^Bearer\s+/i, '');
  if (id === 'viewer' || id === 'operator' || id === 'admin') {
    return { tokenHash: `hash-${id}`, label: id, hashPrefix16: id, role: id };
  }
  return null;
}
vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
  };
});

import { buildDashboardRouter } from './handler.js';
import { __setMissionEngineForTest } from '../../lib/missions/mission-acl.js';
import type { MissionEngine } from '../../lib/paperclip/mission-engine.js';
import {
  UnknownAgentError,
  type ProjectedMission,
} from '../../lib/paperclip/mission-projection.js';

const ISSUE = 'aaaaaaaa-1111-4111-8111-111111111111';

/** The ONLY slug Paperclip's `metadata.netzarAgentId` map carries here. */
const PAPERCLIP_SLUGS = ['main'];

function projected(over: Partial<ProjectedMission> = {}): ProjectedMission {
  return {
    id: ISSUE,
    identifier: 'NZR-42',
    ownerAgent: 'main',
    createdByAgent: 'dashboard',
    createdByChat: 'paperclip',
    title: 'Ship the ACL',
    body: 'Byte for byte.',
    priority: 'medium',
    status: 'open',
    bodyTruncated: false,
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    ...over,
  };
}

/** The legacy row the DynamoDB stack is fed, matching the projection field for field. */
const LEGACY_ROW = {
  id: ISSUE,
  ownerAgent: 'main',
  createdByAgent: 'dashboard',
  createdByChat: 'dashboard:hash-admin',
  title: 'Ship the ACL',
  body: 'Byte for byte.',
  priority: 'medium',
  status: 'open',
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
};

/**
 * The engine seam. `toUuidOrThrow` is reproduced faithfully: the SCOPING
 * argument of `listMissions` and the TARGET argument of `reassign`/`createMission`
 * both throw `UnknownAgentError`, which is precisely why the ACL cannot treat
 * the class as one thing.
 */
function engineWithMap(): MissionEngine {
  const guard = (slug: string) => {
    if (!PAPERCLIP_SLUGS.includes(slug)) throw new UnknownAgentError({ slug }, PAPERCLIP_SLUGS);
  };
  return {
    listMissions: vi.fn(async (opts: { ownerAgent?: string } = {}) => {
      if (opts.ownerAgent !== undefined) guard(opts.ownerAgent);
      return [projected()];
    }),
    getMission: vi.fn(async () => projected()),
    createMission: vi.fn(async (m: { ownerAgent: string }) => {
      guard(m.ownerAgent);
      return projected();
    }),
    setStatus: vi.fn(async () => projected({ status: 'done' })),
    reassign: vi.fn(async (_id: string, ownerAgent: string) => {
      guard(ownerAgent);
      return projected({ ownerAgent });
    }),
    comment: vi.fn(async () => undefined),
  } as unknown as MissionEngine;
}

function build(on: boolean): Hono {
  flag.value = on ? '1' : undefined;
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  return app;
}

function req(app: Hono, path: string, method = 'GET', body?: unknown) {
  const headers: Record<string, string> = { Authorization: 'Bearer admin' };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return app.request(`/api${path}`, init);
}

/** Drive the SAME request through both stacks; compare raw bytes, not parsed objects. */
async function both(path: string, method = 'GET', body?: unknown) {
  const l = await req(build(false), path, method, body);
  const a = await req(build(true), path, method, body);
  return {
    legacy: { status: l.status, text: await l.text() },
    acl: { status: a.status, text: await a.text() },
  };
}

beforeEach(() => {
  provStore.clear();
  for (const fn of Object.values(repo)) fn.mockReset();
  assign.mockReset();
  __setMissionEngineForTest(engineWithMap());
  // The legacy stack behaves the way the real repo does: an owner with no
  // partition is an EMPTY list, and a mission not under `AGENT#<owner>` is a
  // miss — never an error.
  repo.listMissionsForAgent.mockImplementation((owner: string) =>
    Promise.resolve(owner === 'main' ? [LEGACY_ROW] : []),
  );
  repo.updateMissionStatus.mockImplementation((owner: string) =>
    Promise.resolve(owner === 'main'),
  );
  repo.reassignMission.mockImplementation((owner: string, _id: string, newOwner: string) =>
    Promise.resolve(owner === 'main' ? { ...LEGACY_ROW, ownerAgent: newOwner } : null),
  );
  repo.createMission.mockResolvedValue(LEGACY_ROW);
});

// ═══════════════════════════════════════════════════════════════════════════
// The regression the round-2 review executed by hand. An owner slug outside
// Paperclip's map is a SCOPE, not an assignment, and legacy never failed on it.
// ═══════════════════════════════════════════════════════════════════════════
describe('an owner Netzar knows but Paperclip does not maps to the LEGACY answer, not a 400', () => {
  it('R1 an unmapped owner is 200 {count:0}, byte-identical to the legacy empty partition', async () => {
    const { legacy, acl } = await both('/missions?owner=newbie');
    expect(acl.status).toBe(200);
    expect(acl.text).toBe(legacy.text);
    expect(acl.text).toBe('{"owner":"newbie","count":0,"missions":[]}');
  });

  it('R1 an owner NEITHER side has heard of is also 200 {count:0}, not a 404 and not a 400', async () => {
    const { legacy, acl } = await both('/missions?owner=ghost');
    expect(acl.status).toBe(200);
    expect(acl.text).toBe(legacy.text);
  });

  it('R3 an unmapped owner is the legacy 404 not_found, echoing the request params', async () => {
    const { legacy, acl } = await both('/missions/newbie/aaaaaaaa/status', 'POST', {
      status: 'done',
    });
    expect(acl.status).toBe(404);
    expect(acl.status).toBe(legacy.status);
    expect(acl.text).toBe(legacy.text);
    expect(acl.text).toBe('{"error":"not_found","owner":"newbie","id":"aaaaaaaa"}');
  });

  it('R4 an unmapped owner is the legacy 404 not_found', async () => {
    const { legacy, acl } = await both('/missions/newbie/aaaaaaaa/reassign', 'POST', {
      ownerAgent: 'main',
    });
    expect(acl.status).toBe(404);
    expect(acl.text).toBe(legacy.text);
    expect(acl.text).toBe('{"error":"not_found","owner":"newbie","id":"aaaaaaaa"}');
  });

  it('the mapped owner still returns the board, so the fix did not empty the happy path', async () => {
    const res = await req(build(true), '/missions?owner=main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; missions: Array<{ id: string }> };
    expect(body.count).toBe(1);
    expect(body.missions[0].id).toBe(ISSUE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The other half of the same class: a TARGET Paperclip cannot assign to is a
// real failure and must NOT be swallowed by the scoping catch.
// ═══════════════════════════════════════════════════════════════════════════
describe('an ASSIGNMENT TARGET outside the map still fails loudly', () => {
  it('R4 reassigning TO an unmapped agent is 400 unknown_agent, never a silent 200', async () => {
    const res = await req(build(true), '/missions/main/aaaaaaaa/reassign', 'POST', {
      ownerAgent: 'newbie',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'unknown_agent',
      agentId: 'newbie',
      valid: PAPERCLIP_SLUGS,
    });
  });

  it('R2 creating FOR an unmapped agent is 400 unknown_agent', async () => {
    const res = await req(build(true), '/missions', 'POST', {
      prompt: 'do the thing',
      agentId: 'newbie',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('unknown_agent');
  });

  it('an agent NEITHER side knows is byte-identical on both stacks (the ACL gate fires first)', async () => {
    const { legacy, acl } = await both('/missions', 'POST', {
      prompt: 'do the thing',
      agentId: 'ghost',
    });
    expect(acl.status).toBe(400);
    expect(acl.text).toBe(legacy.text);
    expect(acl.text).toBe(
      '{"error":"unknown_agent","agentId":"ghost","valid":["main","research","newbie"]}',
    );
  });

  /**
   * DOCUMENTED DIVERGENCE, NOT PARITY. `newbie` is assignable on the legacy
   * stack (DynamoDB writes any partition key) and NOT assignable on Paperclip,
   * which cannot represent an assignee it has no uuid for. There is no honest
   * 200 available: answering `{ownerAgent:'newbie'}` would claim a move that did
   * not happen. The 400 reuses the legacy `unknown_agent` shape so the SPA's
   * toast copy is unchanged; only `valid` narrows, to the slugs that would
   * actually work. Closing this properly is an agent-map bootstrap concern, not
   * a route concern.
   */
  it('and that divergence is exactly the legacy SHAPE, so no SPA copy changes', async () => {
    const { legacy, acl } = await both('/missions/main/aaaaaaaa/reassign', 'POST', {
      ownerAgent: 'newbie',
    });
    expect(legacy.status).toBe(200);
    expect(acl.status).toBe(400);
    const body = JSON.parse(acl.text) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error', 'agentId', 'valid']);
    expect(body.error).toBe('unknown_agent');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// With the skew removed, the happy paths are byte-identical through the REAL
// ACL — the check `missions.test.ts` performs against a mocked ACL, repeated
// one layer down where the projection and the provenance join actually run.
// ═══════════════════════════════════════════════════════════════════════════
describe('envelope equality through the REAL ACL, engine stubbed', () => {
  it('R3 status echoes the REQUEST owner/id and matches legacy byte for byte', async () => {
    const { legacy, acl } = await both('/missions/main/aaaaaaaa/status', 'POST', {
      status: 'done',
    });
    expect(acl.status).toBe(200);
    expect(acl.text).toBe(legacy.text);
    expect(acl.text).toBe('{"ok":true,"owner":"main","id":"aaaaaaaa","status":"done"}');
  });

  it('R1 rows carry NO `identifier` or `bodyTruncated` — the projection extras are stripped', async () => {
    const res = await req(build(true), '/missions?owner=main');
    const body = (await res.json()) as { missions: Array<Record<string, unknown>> };
    expect(Object.keys(body.missions[0])).toEqual(Object.keys(LEGACY_ROW));
  });

  it('R2 stamps createdByChat from the PRINCIPAL and joins it back off provenance', async () => {
    assign.mockResolvedValue({ owner: 'main', reason: 'haiku picked main' });
    const res = await req(build(true), '/missions', 'POST', { prompt: 'do the thing' });
    expect(res.status).toBe(201);
    const { mission } = (await res.json()) as { mission: Record<string, unknown> };
    // NOT the literal 'paperclip' the projection hardcodes — the C-11 restore.
    expect(mission.createdByChat).toBe('dashboard:hash-admin');
    expect(mission.assignmentReason).toBe('haiku picked main');
    expect(mission).not.toHaveProperty('identifier');
  });
});
