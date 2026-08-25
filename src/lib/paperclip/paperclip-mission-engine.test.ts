import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PaperclipDisabledError } from './error.js';
import {
  expectPaperclipError,
  paperclipIssue,
  paperclipTestClient,
  TEST_COMPANY as COMPANY,
  TEST_ISSUE_ID as ISSUE_ID,
} from './test-helpers.js';
import * as projection from './mission-projection.js';
import { UnknownAgentError } from './mission-projection.js';
import { createPaperclipMissionEngine } from './paperclip-mission-engine.js';
import type { Mission } from '../state/mission-tasks-repo.js';
import type { PaperclipAgent, PaperclipIssue } from './types.js';

// Fakes only; a routed fetch stands in for the whole service.
const MAIN_UUID = 'a0000000-0000-4000-8000-000000000001';
const ANALYST_UUID = 'a0000000-0000-4000-8000-000000000002';

const AGENTS: PaperclipAgent[] = [
  {
    id: MAIN_UUID, name: 'Main', role: 'ceo', status: 'active', reportsTo: null,
    adapterType: 'http', adapterConfig: null, metadata: { netzarAgentId: 'main' },
  },
  {
    id: ANALYST_UUID, name: 'Analyst', role: 'ic', status: 'active', reportsTo: MAIN_UUID,
    adapterType: 'http', adapterConfig: null, metadata: { netzarAgentId: 'analyst' },
  },
];

function issue(overrides: Partial<PaperclipIssue> = {}): PaperclipIssue {
  return paperclipIssue({
    title: 'Ship the thing',
    description: 'body text',
    priority: 'high',
    assigneeAgentId: MAIN_UUID,
    updatedAt: '2026-08-21T01:00:00.000Z',
    ...overrides,
  });
}

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm-1111',
    ownerAgent: 'main',
    createdByAgent: 'main',
    createdByChat: 'chat-1',
    title: 'Ship the thing',
    body: 'body text',
    priority: 'high',
    status: 'open',
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

interface Routed {
  fetchFn: typeof fetch;
  calls: Array<{ method: string; path: string; body: unknown }>;
}

/**
 * Routes on method + path so the engine's real call ORDER is what is asserted.
 * Each route sees its own zero-based call index, because `paginateAll` walks
 * until an EMPTY page and a route that replayed one row forever would spin.
 */
function routed(routes: Record<string, (callIndex: number) => unknown>, statusFor: Record<string, number> = {}): Routed {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const perRoute = new Map<string, number>();
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const key = `${method} ${url.pathname}`;
    calls.push({ method, path: url.pathname, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: `no route for ${key}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    const index = perRoute.get(key) ?? 0;
    perRoute.set(key, index + 1);
    return new Response(JSON.stringify(route(index)), {
      status: statusFor[key] ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function engineOver(routes: Routed, killSwitchActive = false) {
  return createPaperclipMissionEngine({
    client: paperclipTestClient({
      fetchFn: routes.fetchFn,
      killSwitch: async () => (killSwitchActive ? { active: true, reason: 'incident 42' } : { active: false }),
    }),
  });
}

const AGENTS_ROUTE = `GET /api/companies/${COMPANY}/agents`;
const ISSUES_ROUTE = `GET /api/companies/${COMPANY}/issues`;
const CREATE_ROUTE = `POST /api/companies/${COMPANY}/issues`;
const DETAIL_ROUTE = `GET /api/issues/${ISSUE_ID}`;
const PATCH_ROUTE = `PATCH /api/issues/${ISSUE_ID}`;
const COMMENT_ROUTE = `POST /api/issues/${ISSUE_ID}/comments`;

describe('createPaperclipMissionEngine', () => {
  it('A2-19: the whole engine is built from a one-line fetch resolver - no network, no DI container, no mocking library', async () => {
    const routes = routed({ [AGENTS_ROUTE]: () => AGENTS, [ISSUES_ROUTE]: (n) => (n === 0 ? [issue()] : []) });
    const missions = await engineOver(routes).listMissions();
    expect(missions).toHaveLength(1);
    expect(missions[0]?.ownerAgent).toBe('main');
    expect(missions[0]?.identifier).toBe('NZR-1');
  });

  /**
   * `maxPages: 1` IS A ONE-PAGE READ, not a one-page walk.
   *
   * `paginateAll(1)` can only THROW on a non-empty board — its loop tests the
   * bound before it can ever return the page in hand — so 1 was an unusable
   * value and reading it as "this page, then stop" costs no caller anything. It
   * is the primitive the ACL needs to reproduce legacy's single `Limit: n`
   * Query, and the point is what does NOT happen: no second read, and no
   * `PaperclipPaginationTruncatedError` on a board that has more rows.
   */
  it('maxPages: 1 reads ONE page and stops — no terminator read, no truncation throw', async () => {
    const full = Array.from({ length: 3 }, (_, i) =>
      issue({ id: `f000000${i}-0000-4000-8000-00000000000${i}`, identifier: `NZR-${i}` }),
    );
    // Every issue-list call answers a FULL page, so `hasMore` is permanently
    // true and any walk at all would either read again or throw.
    const routes = routed({ [AGENTS_ROUTE]: () => AGENTS, [ISSUES_ROUTE]: () => full });
    const missions = await engineOver(routes).listMissions({ limit: 3, maxPages: 1 });
    expect(missions).toHaveLength(3);
    expect(routes.calls.filter((c) => c.path.endsWith('/issues'))).toHaveLength(1);
  });

  it('every other maxPages keeps paginateAll`s all-or-throw contract', async () => {
    const routes = routed({ [AGENTS_ROUTE]: () => AGENTS, [ISSUES_ROUTE]: () => [issue()] });
    await expect(engineOver(routes).listMissions({ maxPages: 2 })).rejects.toThrow(
      /pagination stopped after 2 pages/,
    );
  });

  it('the projection is IMPORTED, not re-derived: every mapped value equals mission-projection`s own output', async () => {
    const routes = routed({ [AGENTS_ROUTE]: () => AGENTS, [ISSUES_ROUTE]: (n) => (n === 0 ? [issue({ status: 'in_review', priority: 'critical' })] : []) });
    const [projected] = await engineOver(routes).listMissions();
    // Literals, not `projection.toMissionStatus('in_review')` — computing the
    // expectation from the function under test passes even when it is wrong.
    // Since Phase 9 the literal is `in_review` itself: the status has a lane.
    expect(projected?.status).toBe('in_review');
    expect(projected?.priority).toBe('critical');
  });

  it('C-15: priority and the widened statuses now both project exactly', async () => {
    // Phase 9 removes both avoidable losses: `blocked` has its own lane and
    // the shared Mission domain carries Paperclip's exact priority band.
    const routes = routed({ [AGENTS_ROUTE]: () => AGENTS, [ISSUES_ROUTE]: (n) => (n === 0 ? [issue({ status: 'blocked', priority: 'high' })] : []) });
    const [projected] = await engineOver(routes).listMissions();
    expect(projected?.status).toBe('blocked');
    expect(projected?.priority).toBe('high');
  });

  it('A2-17: NO single unprojectable row can blank the board, whatever the projection threw', async () => {
    // Three different failure modes, three different exception types, all three
    // skipped. The third is the one that matters on an artifact bump:
    // `PaperclipIssueStatus` is hand-transcribed from the committed OpenAPI
    // snapshot, so an eighth server status makes `toMissionStatus` throw a plain
    // `Error` — and a catch narrowed to the projection's two NAMED classes would
    // reject the whole `listMissions()` for one new row.
    const routes = routed({
      [AGENTS_ROUTE]: () => AGENTS,
      [ISSUES_ROUTE]: (n) =>
        n === 0
          ? [
              issue({ id: 'unassigned', assigneeAgentId: null }),
              issue({ id: 'ghost-agent', assigneeAgentId: 'a0000000-0000-4000-8000-00000000ffff' }),
              issue({ id: 'future-status', status: 'archived' as never }),
              issue(),
            ]
          : [],
    });
    const missions = await engineOver(routes).listMissions();
    expect(missions.map((row) => row.id)).toEqual([ISSUE_ID]);
  });

  it('A2-17: a transport failure is NOT swallowed by the row skip - an empty board and a dead network stay distinguishable', async () => {
    const routes = routed({ [AGENTS_ROUTE]: () => AGENTS, [ISSUES_ROUTE]: () => [issue()] });
    const engine = engineOver(routes, true);
    await expectPaperclipError(() => engine.listMissions(), PaperclipDisabledError, 'incident 42');
  });


  it('listMissions maps an ownerAgent slug onto the proven assigneeAgentId filter', async () => {
    const routes = routed({ [AGENTS_ROUTE]: () => AGENTS, [ISSUES_ROUTE]: () => [] });
    await engineOver(routes).listMissions({ ownerAgent: 'analyst' });
    expect(routes.calls.at(-1)?.path).toContain('/issues');
    await expect(engineOver(routes).listMissions({ ownerAgent: 'ghost' })).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it('A1-3: createMission uses the Mission`s own id as the idempotency key and mints nothing', async () => {
    const routes = routed({
      [AGENTS_ROUTE]: () => AGENTS,
      [CREATE_ROUTE]: () => ({ id: ISSUE_ID, updatedAt: 'x' }),
      [DETAIL_ROUTE]: () => issue(),
    });
    await engineOver(routes).createMission(mission({ id: 'm-abc' }));
    const created = routes.calls.find((call) => call.method === 'POST');
    expect((created?.body as { idempotencyKey: string }).idempotencyKey).toBe('netzar-mission:m-abc');
  });

  it('A1-13: the create body on the wire omits status and carries allowDuplicate, the shape the dedup replay was proven on', async () => {
    const routes = routed({
      [AGENTS_ROUTE]: () => AGENTS,
      [CREATE_ROUTE]: () => ({ id: ISSUE_ID, updatedAt: 'x' }),
      [DETAIL_ROUTE]: () => issue(),
    });
    await engineOver(routes).createMission(mission({ id: 'm-abc', status: 'in_progress' }));
    const created = routes.calls.find((call) => call.method === 'POST');
    // `status` never reaches the wire even from an in_progress Mission: A1-13
    // omits it so the server default applies. An unrecognized status is a
    // silent 200 here (`listFilterValidation`), so a wrong one would not fail
    // loudly - it would come back as truth through `project(created.id)`.
    expect(created?.body).not.toHaveProperty('status');
    // The probe proved `200 + deduplicated: true` for a body carrying BOTH
    // fields; this write is auto-retried, so it sends both.
    expect(created?.body).toMatchObject({ idempotencyKey: 'netzar-mission:m-abc', allowDuplicate: true });
  });

  it('createMission projects the PROVEN detail row, never the create response whose fields nothing asserts', async () => {
    const routes = routed({
      [AGENTS_ROUTE]: () => AGENTS,
      // Deliberately a create response carrying only the fields any probe has
      // ever asserted on it.
      [CREATE_ROUTE]: () => ({ id: ISSUE_ID, updatedAt: 'x', assigneeAgentId: MAIN_UUID }),
      [DETAIL_ROUTE]: () => issue({ title: 'the real title' }),
    });
    const created = await engineOver(routes).createMission(mission());
    expect(created.title).toBe('the real title');
    expect(routes.calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('createSubtask uses the proven company create route with parentId and the canonical agent map', async () => {
    const parentId = 'b0000000-0000-4000-8000-000000000009';
    const routes = routed({
      [AGENTS_ROUTE]: () => AGENTS,
      [CREATE_ROUTE]: () => ({ id: ISSUE_ID, updatedAt: 'x' }),
      [DETAIL_ROUTE]: () => issue({ assigneeAgentId: ANALYST_UUID }),
    });
    const created = await engineOver(routes).createSubtask(
      parentId,
      mission({ id: 'subtask-abc', ownerAgent: 'analyst' }),
      { actor: 'main', runId: 'paperclip-minted-run-id' },
    );
    const write = routes.calls.find((call) => call.method === 'POST');
    expect(write?.path).toBe(`/api/companies/${COMPANY}/issues`);
    expect(write?.body).toMatchObject({
      parentId,
      assigneeAgentId: ANALYST_UUID,
      idempotencyKey: 'netzar-mission:subtask-abc',
      allowDuplicate: true,
    });
    expect(created.ownerAgent).toBe('analyst');
    expect(routes.calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('setStatus reads the current assignee first, so `open` projects to todo rather than backlog', async () => {
    const routes = routed({
      [AGENTS_ROUTE]: () => AGENTS,
      [DETAIL_ROUTE]: () => issue(),
      [PATCH_ROUTE]: () => issue(),
    });
    await engineOver(routes).setStatus(ISSUE_ID, 'open');
    const patched = routes.calls.find((call) => call.method === 'PATCH');
    expect(patched?.body).toEqual({ status: 'todo' });
  });

  it('setStatus on an unassigned issue patches to backlog and then refuses to project it, rather than inventing an owner', async () => {
    const routes = routed({
      [AGENTS_ROUTE]: () => AGENTS,
      [DETAIL_ROUTE]: () => issue({ assigneeAgentId: null }),
      [PATCH_ROUTE]: () => issue(),
    });
    await expect(engineOver(routes).setStatus(ISSUE_ID, 'open')).rejects.toBeInstanceOf(
      projection.UnassignedIssueError,
    );
    expect(routes.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ status: 'backlog' });
  });

  it('reassign maps a slug to a uuid, and an unknown slug never reaches the wire', async () => {
    const routes = routed({
      [AGENTS_ROUTE]: () => AGENTS,
      [DETAIL_ROUTE]: () => issue({ assigneeAgentId: ANALYST_UUID }),
      [PATCH_ROUTE]: () => issue(),
    });
    const engine = engineOver(routes);
    await engine.reassign(ISSUE_ID, 'analyst');
    expect(routes.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ assigneeAgentId: ANALYST_UUID });

    const before = routes.calls.length;
    await expect(engine.reassign(ISSUE_ID, 'ghost')).rejects.toBeInstanceOf(UnknownAgentError);
    expect(routes.calls).toHaveLength(before);
  });

  it('comment posts run-less, which is the shape the ACL needs', async () => {
    const routes = routed({ [COMMENT_ROUTE]: () => ({ id: 'c1', body: 'hi', createdAt: 'x' }) });
    await engineOver(routes).comment(ISSUE_ID, 'hi');
    expect(routes.calls).toEqual([{ method: 'POST', path: `/api/issues/${ISSUE_ID}/comments`, body: { body: 'hi' } }]);
  });

  it('C-12: the kill switch reaches every engine method without the engine ever checking it', async () => {
    const routes = routed({ [AGENTS_ROUTE]: () => AGENTS });
    const engine = engineOver(routes, true);
    for (const call of [
      () => engine.listMissions(),
      () => engine.getMission(ISSUE_ID),
      () => engine.createMission(mission()),
      () => engine.createSubtask(ISSUE_ID, mission()),
      () => engine.setStatus(ISSUE_ID, 'done'),
      () => engine.reassign(ISSUE_ID, 'main'),
      () => engine.comment(ISSUE_ID, 'hi'),
    ]) {
      await expectPaperclipError(call, PaperclipDisabledError, 'incident 42');
    }
    expect(routes.calls).toHaveLength(0);
  });
});

describe('layering guards', () => {
  it('A2-19: mission-engine.ts - the interface everything depends on - imports no transport', async () => {
    const source = await readFile(new URL('./mission-engine.ts', import.meta.url), 'utf8');
    for (const forbidden of ["'./client.js'", "'./error.js'", "'./config.js'", "'./agent-map.js'"]) {
      expect(source, `mission-engine.ts must not import ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('A2-16: mission-projection.ts is the single wire-to-domain crossing point', async () => {
    const engine = await readFile(new URL('./paperclip-mission-engine.ts', import.meta.url), 'utf8');
    expect(engine).toContain("from './mission-projection.js'");
  });

  it('A2-24: the projection export inventory drops the retired lossy priority converters', () => {
    for (const canonical of [
      'toIssueStatus', 'toMissionStatus',
      'missionToIssueCreate', 'issueToMission', 'neutralizeForPrompt',
    ] as const) {
      expect(typeof projection[canonical], canonical).toBe('function');
    }
    expect(projection).not.toHaveProperty('toPriorityBand');
    expect(projection).not.toHaveProperty('toPriorityScore');
  });
});
