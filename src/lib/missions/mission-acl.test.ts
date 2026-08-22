/**
 * The ACL's own semantics: the two-stack flag, the provenance join that makes
 * the GDPR export whole again, owner scoping, prefix resolution, and the losses
 * this layer refuses to hide.
 *
 * Nothing here touches DynamoDB, Paperclip or Bedrock: the engine is injected
 * and the provenance repo is an in-memory map.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { flag } = vi.hoisted(() => ({ flag: { value: undefined as string | undefined } }));
vi.mock('../../config/env.js', () => ({
  loadEnv: () => ({ CCE_PAPERCLIP_ENABLED: flag.value }),
}));

const { provStore } = vi.hoisted(() => ({
  provStore: new Map<string, Record<string, unknown>>(),
}));
vi.mock('../state/mission-provenance-repo.js', () => ({
  putMissionProvenance: vi.fn((row: { missionId: string }) => {
    provStore.set(row.missionId, row as Record<string, unknown>);
    return Promise.resolve();
  }),
  getMissionProvenance: vi.fn((ids: readonly string[]) =>
    Promise.resolve(
      new Map(ids.filter((id) => provStore.has(id)).map((id) => [id, provStore.get(id)])),
    ),
  ),
  listProvenanceForChat: vi.fn((chatId: string) =>
    Promise.resolve([...provStore.values()].filter((r) => r.createdByChat === chatId)),
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
vi.mock('../state/mission-tasks-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/mission-tasks-repo.js')>();
  return { ...actual, ...repo };
});

vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  truncateForLog: (s: string) => s,
}));

import type { Mission, MissionStatus } from '../state/mission-tasks-repo.js';
import type { MissionEngine } from '../paperclip/mission-engine.js';
import { UnknownAgentError, type ProjectedMission } from '../paperclip/mission-projection.js';
import { PaperclipError } from '../paperclip/error.js';
import { createPaperclipMissionEngine } from '../paperclip/paperclip-mission-engine.js';
import { paperclipTestClient } from '../paperclip/test-helpers.js';
import {
  AmbiguousMissionPrefixError,
  __setMissionEngineForTest,
  createBoardMission,
  listBoardMissions,
  listBoardMissionsByStatus,
  paperclipRoutingEnabled,
  reassignBoardMission,
  setBoardMissionStatus,
  toWireMission,
} from './mission-acl.js';

const ISSUE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ISSUE_B = 'bbbbbbbb-2222-4222-8222-222222222222';

function projected(over: Partial<ProjectedMission> = {}): ProjectedMission {
  return {
    id: ISSUE_A,
    identifier: 'NZR-42',
    ownerAgent: 'main',
    createdByAgent: 'paperclip',
    createdByChat: 'paperclip',
    title: 'Ship the ACL',
    body: 'Byte for byte.',
    priority: 50,
    status: 'open',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    bodyTruncated: false,
    ...over,
  };
}

interface EngineSpies {
  engine: MissionEngine;
  listMissions: ReturnType<typeof vi.fn>;
  createMission: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  reassign: ReturnType<typeof vi.fn>;
}

function fakeEngine(rows: ProjectedMission[] = [projected()]): EngineSpies {
  const listMissions = vi.fn(() => Promise.resolve(rows));
  const createMission = vi.fn(() => Promise.resolve(rows[0]));
  const setStatus = vi.fn(() => Promise.resolve(rows[0]));
  const reassign = vi.fn(() => Promise.resolve(rows[0]));
  const engine = {
    listMissions,
    createMission,
    setStatus,
    reassign,
    getMission: vi.fn(() => Promise.resolve(rows[0])),
    comment: vi.fn(() => Promise.resolve()),
  } as unknown as MissionEngine;
  __setMissionEngineForTest(engine);
  return { engine, listMissions, createMission, setStatus, reassign };
}

beforeEach(() => {
  flag.value = undefined;
  provStore.clear();
  __setMissionEngineForTest(undefined);
  for (const fn of Object.values(repo)) fn.mockReset();
});

// ───────────────────────────────────────────────────────────────────────────
describe('the flag picks ONE WHOLE STACK (C-8)', () => {
  it('unset / "0" leaves the DynamoDB stack serving and never builds an engine', async () => {
    repo.listMissionsForAgent.mockResolvedValue([]);
    repo.updateMissionStatus.mockResolvedValue(true);
    repo.reassignMission.mockResolvedValue(null);
    repo.createMission.mockResolvedValue({ id: 'legacy' });
    const spies = fakeEngine();

    expect(paperclipRoutingEnabled()).toBe(false);
    await listBoardMissions('main', 100);
    await setBoardMissionStatus('main', 'x', 'done');
    await reassignBoardMission('main', 'x', 'research');
    await createBoardMission({
      ownerAgent: 'main',
      createdByAgent: 'dashboard',
      createdByChat: 'dashboard:abc',
      title: 't',
      body: 'b',
    });

    expect(repo.listMissionsForAgent).toHaveBeenCalledWith('main', 100);
    expect(repo.updateMissionStatus).toHaveBeenCalledWith('main', 'x', 'done');
    expect(repo.reassignMission).toHaveBeenCalledWith('main', 'x', 'research');
    expect(repo.createMission).toHaveBeenCalledTimes(1);
    expect(spies.listMissions).not.toHaveBeenCalled();
    expect(spies.createMission).not.toHaveBeenCalled();
    expect(spies.setStatus).not.toHaveBeenCalled();
    expect(spies.reassign).not.toHaveBeenCalled();
  });

  it('"1" and "true" arm the Paperclip stack and the repo is never read', async () => {
    for (const value of ['1', 'true', 'TRUE']) {
      flag.value = value;
      const spies = fakeEngine();
      expect(paperclipRoutingEnabled()).toBe(true);
      await listBoardMissions('main', 100);
      expect(spies.listMissions).toHaveBeenCalledWith({
        ownerAgent: 'main',
        limit: 100,
        maxPages: 1,
      });
      expect(repo.listMissionsForAgent).not.toHaveBeenCalled();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('toWireMission — the envelope crossing', () => {
  it('drops `identifier` and `bodyTruncated`, so a ProjectedMission serialises as a legacy Mission', () => {
    const wire = toWireMission(projected({ bodyTruncated: true }));
    expect(wire).not.toHaveProperty('identifier');
    expect(wire).not.toHaveProperty('bodyTruncated');
    expect(Object.keys(wire)).toEqual([
      'id',
      'ownerAgent',
      'createdByAgent',
      'createdByChat',
      'title',
      'body',
      'priority',
      'status',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('OMITS assignmentReason and dueAt on absence — the key is absent, never null', () => {
    const json = JSON.parse(JSON.stringify(toWireMission(projected())));
    expect('assignmentReason' in json).toBe(false);
    expect('dueAt' in json).toBe(false);
  });

  it('restores the three fields Paperclip has no source for, in legacy key order', () => {
    const wire = toWireMission(projected(), {
      missionId: ISSUE_A,
      createdByChat: 'dashboard:hash',
      createdByAgent: 'dashboard',
      assignmentReason: 'explicit assignment',
      dueAt: '2026-09-01T00:00:00.000Z',
    });
    expect(wire.createdByChat).toBe('dashboard:hash');
    expect(wire.createdByAgent).toBe('dashboard');
    expect(Object.keys(wire)).toEqual([
      'id',
      'ownerAgent',
      'createdByAgent',
      'createdByChat',
      'title',
      'body',
      'priority',
      'status',
      'assignmentReason',
      'dueAt',
      'createdAt',
      'updatedAt',
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('create writes the provenance row that the export depends on', () => {
  it('keys provenance on the PAPERCLIP issue id, not the minted idempotency seed', async () => {
    flag.value = '1';
    const spies = fakeEngine([projected({ id: ISSUE_B })]);

    const mission = await createBoardMission({
      ownerAgent: 'main',
      createdByAgent: 'dashboard',
      createdByChat: 'dashboard:token-hash',
      title: 'Ship the ACL',
      body: 'Byte for byte.',
      assignmentReason: 'explicit assignment',
    });

    const seed = spies.createMission.mock.calls[0][0] as Mission;
    expect(seed.id).not.toBe(ISSUE_B); // the idempotency-key seed, not the wire id
    expect(mission.id).toBe(ISSUE_B);
    expect(provStore.get(ISSUE_B)).toMatchObject({
      missionId: ISSUE_B,
      createdByChat: 'dashboard:token-hash',
      createdByAgent: 'dashboard',
      assignmentReason: 'explicit assignment',
    });
    expect(mission.createdByChat).toBe('dashboard:token-hash');
    expect(mission.assignmentReason).toBe('explicit assignment');
  });

  it('a later list JOINS the provenance back on, so createdByChat is never the literal "paperclip"', async () => {
    flag.value = '1';
    fakeEngine([projected({ id: ISSUE_B })]);
    await createBoardMission({
      ownerAgent: 'main',
      createdByAgent: 'dashboard',
      createdByChat: 'dashboard:token-hash',
      title: 'Ship the ACL',
      body: 'Byte for byte.',
      assignmentReason: 'explicit assignment',
    });

    const [row] = await listBoardMissions('main', 100);
    expect(row.createdByChat).toBe('dashboard:token-hash');
    expect(row.assignmentReason).toBe('explicit assignment');
  });

  it('a row with NO provenance (opened in Paperclip\'s own UI) still renders, with the keys absent', async () => {
    flag.value = '1';
    fakeEngine([projected()]);
    const [row] = await listBoardMissions('main', 100);
    expect(row.createdByChat).toBe('paperclip');
    expect('assignmentReason' in row).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('owner scoping and prefix resolution', () => {
  it('a mission addressed to the WRONG owner is not found — the engine is owner-blind, the ACL is not', async () => {
    flag.value = '1';
    const spies = fakeEngine([]);
    expect(await setBoardMissionStatus('research', ISSUE_A, 'done')).toBe(false);
    expect(await reassignBoardMission('research', ISSUE_A, 'main')).toBeNull();
    expect(spies.setStatus).not.toHaveBeenCalled();
    expect(spies.reassign).not.toHaveBeenCalled();
  });

  it('resolves an 8-char prefix to the full issue uuid before calling the engine', async () => {
    flag.value = '1';
    const spies = fakeEngine([projected()]);
    expect(await setBoardMissionStatus('main', ISSUE_A.slice(0, 8), 'in_progress')).toBe(true);
    expect(spies.setStatus).toHaveBeenCalledWith(ISSUE_A, 'in_progress');
  });

  /**
   * The read-amplification bound. Legacy resolved a mutation inside ONE
   * `Limit: 200` Query; unbounded, this walked `paginateAll`'s 100-page default
   * and held an issue-list slot open for as many round trips as the board is
   * long — the A1-10 hazard, whose measured ceiling is 8 DISTINCT concurrent
   * reads per actor.
   */
  it('a mutation reads the legacy window in ONE page — never a walk over the whole board (A1-10)', async () => {
    flag.value = '1';
    const spies = fakeEngine([projected()]);
    await setBoardMissionStatus('main', ISSUE_A, 'done');
    await reassignBoardMission('main', ISSUE_A, 'research');
    expect(spies.listMissions).toHaveBeenCalledTimes(2);
    for (const call of spies.listMissions.mock.calls) {
      expect(call[0]).toEqual({ ownerAgent: 'main', limit: 200, maxPages: 1 });
    }
  });

  /**
   * THE SAME BOUND, DRIVEN THROUGH THE REAL ENGINE AND THE REAL `paginateAll`.
   *
   * The test above counts ENGINE calls, which proves the ACL's intent and
   * nothing about the wire: a mocked engine never reaches `PaperclipPage`. A
   * bounded WALK (`maxPages: 2`) satisfies that assertion and still hard-fails
   * here, because `paginateAll` terminates on an empty page and raises
   * `PaperclipPaginationTruncatedError` when a board is longer than one page —
   * a 503 on the route, an `isError` on the tool, for a row legacy's
   * `Limit: 200` Query mutated with a 200.
   *
   * So this drives a 300-row owner board through a counting `fetchFn` and pins
   * both halves: ONE issue-list read per mutation, and a row well inside the
   * legacy window still mutates.
   */
  describe('a board longer than the window, on the real wire', () => {
    const OWNER_UUID = 'a0000000-0000-4000-8000-000000000001';
    const BOARD_SIZE = 300;
    const rowId = (i: number) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`;
    /** Row 5 — deep inside legacy's 200-row window, and past the first page only if we walk. */
    const TARGET = rowId(5);

    function board() {
      const issueReads: Array<Record<string, string>> = [];
      const rows = Array.from({ length: BOARD_SIZE }, (_, i) => ({
        id: rowId(i),
        identifier: `NZR-${i}`,
        title: `row ${i}`,
        description: null,
        status: 'todo',
        priority: 'medium',
        assigneeAgentId: OWNER_UUID,
        createdByAgentId: null,
        createdAt: '2026-08-20T10:00:00.000Z',
        updatedAt: '2026-08-20T10:00:00.000Z',
      }));
      const fetchFn = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
        const url = new URL(String(input));
        const json = (payload: unknown) =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (url.pathname.endsWith('/agents')) {
          return json([
            {
              id: OWNER_UUID,
              name: 'Main',
              role: 'ceo',
              status: 'active',
              reportsTo: null,
              adapterType: 'http',
              adapterConfig: null,
              metadata: { netzarAgentId: 'main' },
            },
          ]);
        }
        if (url.pathname.endsWith('/issues') && (init.method ?? 'GET') === 'GET') {
          const q = Object.fromEntries(url.searchParams);
          issueReads.push(q);
          const offset = Number(q.offset ?? '0');
          const limit = Number(q.limit ?? '100');
          return json(rows.slice(offset, offset + limit));
        }
        // PATCH /api/issues/:id, then the re-read the engine projects from.
        const id = url.pathname.split('/').pop() ?? '';
        return json(rows.find((r) => r.id === id) ?? rows[0]);
      }) as unknown as typeof fetch;
      return { fetchFn, issueReads };
    }

    function armRealEngine(fetchFn: typeof fetch) {
      flag.value = '1';
      __setMissionEngineForTest(
        createPaperclipMissionEngine({ client: paperclipTestClient({ fetchFn }) }),
      );
    }

    it('mutates a row inside the legacy window instead of 503-ing the whole board', async () => {
      const { fetchFn } = board();
      armRealEngine(fetchFn);
      // The regression this pins: a bounded WALK threw
      // `PaperclipPaginationTruncatedError` here, converting ~200 mutations per
      // owner into hard failures legacy answered 200.
      await expect(setBoardMissionStatus('main', TARGET, 'done')).resolves.toBe(true);
      await expect(reassignBoardMission('main', TARGET, 'main')).resolves.toMatchObject({
        id: TARGET,
      });
    });

    it('and an 8-char prefix of that row resolves, exactly as it did on DynamoDB', async () => {
      const { fetchFn } = board();
      armRealEngine(fetchFn);
      await expect(setBoardMissionStatus('main', TARGET.slice(0, 8), 'done')).resolves.toBe(true);
    });

    it('costs exactly ONE issue-list read, bounded by the legacy window (A1-10)', async () => {
      const { fetchFn, issueReads } = board();
      armRealEngine(fetchFn);
      await setBoardMissionStatus('main', TARGET, 'done');
      expect(issueReads).toEqual([
        expect.objectContaining({ limit: '200', offset: '0', assigneeAgentId: OWNER_UUID }),
      ]);
    });

    it('and a plain board read is one bounded read too — the SPA fan-out surface', async () => {
      const { fetchFn, issueReads } = board();
      armRealEngine(fetchFn);
      const rows = await listBoardMissions('main', 100);
      expect(rows).toHaveLength(100);
      expect(issueReads).toEqual([expect.objectContaining({ limit: '100', offset: '0' })]);
    });
  });

  /**
   * C-16. Two missions sharing an 8-char prefix used to mutate whichever one the
   * sweep happened to return first — on a sweep this ACL claims no ordering for.
   * There was no correct answer to preserve, so refusing is a fix rather than a
   * contract break, and the refusal is NOT a `PaperclipError`: it must fall past
   * `paperclipFailure`'s 503/404 rungs onto the 500 rung a thrown mutation
   * already took on the legacy stack, not invent a shape.
   */
  const TWIN = `${ISSUE_A.slice(0, 8)}-3333-4333-8333-333333333333`;

  it('an 8-char prefix matching TWO missions is REFUSED, not silently resolved to the first (C-16)', async () => {
    flag.value = '1';
    const spies = fakeEngine([projected(), projected({ id: TWIN })]);
    const prefix = ISSUE_A.slice(0, 8);
    await expect(setBoardMissionStatus('main', prefix, 'done')).rejects.toBeInstanceOf(
      AmbiguousMissionPrefixError,
    );
    await expect(reassignBoardMission('main', prefix, 'research')).rejects.toBeInstanceOf(
      AmbiguousMissionPrefixError,
    );
    expect(spies.setStatus).not.toHaveBeenCalled();
    expect(spies.reassign).not.toHaveBeenCalled();
    const err = await setBoardMissionStatus('main', prefix, 'done').catch((e: unknown) => e);
    // Not a PaperclipError, so no route rung claims it and no NEW wire shape exists.
    expect(err).not.toBeInstanceOf(PaperclipError);
    expect((err as Error).message).toContain(ISSUE_A);
    expect((err as Error).message).toContain(TWIN);
  });

  it('a FULL id still resolves when another row shares its 8-char prefix', async () => {
    flag.value = '1';
    // TWIN first: the old single-pass `find` would have returned it for the
    // exact id below, because an exact match is also a `startsWith` match.
    const spies = fakeEngine([projected({ id: TWIN }), projected()]);
    expect(await setBoardMissionStatus('main', ISSUE_A, 'done')).toBe(true);
    expect(spies.setStatus).toHaveBeenCalledWith(ISSUE_A, 'done');
  });

  it('reassigning to the CURRENT owner short-circuits: no write, updatedAt untouched', async () => {
    flag.value = '1';
    const spies = fakeEngine([projected()]);
    const row = await reassignBoardMission('main', ISSUE_A, 'main');
    expect(spies.reassign).not.toHaveBeenCalled();
    expect(row?.updatedAt).toBe('2026-08-20T10:00:00.000Z');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the losses this layer refuses to hide', () => {
  it('a status filter is applied client-side, because the engine deliberately offers none', async () => {
    flag.value = '1';
    const spies = fakeEngine([
      projected({ id: ISSUE_A, status: 'open' }),
      projected({ id: ISSUE_B, status: 'done' }),
    ]);
    const rows = await listBoardMissionsByStatus('main', 'done' as MissionStatus, 15);
    expect(rows.map((r) => r.id)).toEqual([ISSUE_B]);
    // No `status` reached the wire filter — an unrecognized one is a silent 200 [].
    expect(spies.listMissions.mock.calls[0][0]).not.toHaveProperty('status');
  });

  it('a truncated sweep PROPAGATES rather than returning a short board that looks complete', async () => {
    flag.value = '1';
    const boom = new Error('pagination truncated');
    __setMissionEngineForTest({
      listMissions: () => Promise.reject(boom),
    } as unknown as MissionEngine);
    await expect(listBoardMissions('main', 100)).rejects.toBe(boom);
  });

  it('re-applies the legacy 100-row cap on top of paginateAll', async () => {
    flag.value = '1';
    const many = Array.from({ length: 150 }, (_, i) =>
      projected({ id: `${i}`.padStart(8, '0') + '-1111-4111-8111-111111111111' }),
    );
    fakeEngine(many);
    expect((await listBoardMissions('main', 100)).length).toBe(100);
  });
});

// ───────────────────────────────────────────────────────────────────────────
/**
 * `UnknownAgentError` ARRIVES FROM TWO SEMANTICALLY DIFFERENT PLACES and the
 * ACL must not collapse them. As a SCOPING parameter it is "which partition am
 * I reading", which legacy answered with an empty list; as an ASSIGNMENT TARGET
 * it is "put this work on that agent", which legacy answered with a 400. Mapping
 * the class to one status made an empty board into a hard failure for every
 * agent present in Netzar and absent from Paperclip's `metadata.netzarAgentId`
 * map — a newly added agent, an unrun bootstrap, or just an unexpired cache.
 */
describe('a scoping owner outside the agent map is an EMPTY BOARD; a target is still an error', () => {
  const unmapped = (slug: string) => new UnknownAgentError({ slug }, ['main']);

  it('listBoardMissions answers [] — the legacy empty partition, not a throw', async () => {
    flag.value = '1';
    __setMissionEngineForTest({
      listMissions: (opts: { ownerAgent?: string }) =>
        Promise.reject(unmapped(opts.ownerAgent ?? '')),
    } as unknown as MissionEngine);
    await expect(listBoardMissions('newbie', 100)).resolves.toEqual([]);
  });

  it('so setBoardMissionStatus reports the legacy 404 signal (false), not an error', async () => {
    flag.value = '1';
    __setMissionEngineForTest({
      listMissions: (opts: { ownerAgent?: string }) =>
        Promise.reject(unmapped(opts.ownerAgent ?? '')),
    } as unknown as MissionEngine);
    await expect(setBoardMissionStatus('newbie', 'aaaaaaaa', 'done' as MissionStatus)).resolves.toBe(
      false,
    );
  });

  it('and reassignBoardMission reports the legacy 404 signal (null)', async () => {
    flag.value = '1';
    __setMissionEngineForTest({
      listMissions: (opts: { ownerAgent?: string }) =>
        Promise.reject(unmapped(opts.ownerAgent ?? '')),
    } as unknown as MissionEngine);
    await expect(reassignBoardMission('newbie', 'aaaaaaaa', 'main')).resolves.toBeNull();
  });

  it('THE CATCH IS NOT AN AMNESTY: an error naming a DIFFERENT slug still propagates', async () => {
    flag.value = '1';
    const targetErr = unmapped('someone-else');
    __setMissionEngineForTest({
      listMissions: () => Promise.reject(targetErr),
    } as unknown as MissionEngine);
    await expect(listBoardMissions('main', 100)).rejects.toBe(targetErr);
  });

  it('a reassign TARGET outside the map propagates, so the route can answer 400', async () => {
    flag.value = '1';
    const targetErr = unmapped('newbie');
    __setMissionEngineForTest({
      listMissions: () => Promise.resolve([projected()]),
      reassign: () => Promise.reject(targetErr),
    } as unknown as MissionEngine);
    await expect(reassignBoardMission('main', ISSUE_A, 'newbie')).rejects.toBe(targetErr);
  });

  it('a create TARGET outside the map propagates too', async () => {
    flag.value = '1';
    const targetErr = unmapped('newbie');
    __setMissionEngineForTest({
      createMission: () => Promise.reject(targetErr),
    } as unknown as MissionEngine);
    await expect(
      createBoardMission({
        ownerAgent: 'newbie',
        createdByAgent: 'dashboard',
        createdByChat: 'dashboard:hash',
        title: 't',
        body: 'b',
      }),
    ).rejects.toBe(targetErr);
  });
});

// ───────────────────────────────────────────────────────────────────────────
/**
 * The provenance row is the ONLY thing that makes a Paperclip-origin mission
 * visible to its own subject's GDPR export, so an issue that lands without one
 * is the C-11 silent-loss shape re-entered through a different door.
 */
describe('a failed provenance write UNWINDS the create rather than orphaning it', () => {
  it('cancels the issue and rethrows, so no live mission is invisible to the export', async () => {
    flag.value = '1';
    const boom = new Error('ddb down');
    const setStatus = vi.fn(() => Promise.resolve(projected({ status: 'cancelled' })));
    __setMissionEngineForTest({
      createMission: () => Promise.resolve(projected()),
      setStatus,
    } as unknown as MissionEngine);
    const prov = await import('../state/mission-provenance-repo.js');
    vi.mocked(prov.putMissionProvenance).mockRejectedValueOnce(boom);

    await expect(
      createBoardMission({
        ownerAgent: 'main',
        createdByAgent: 'dashboard',
        createdByChat: 'dashboard:hash',
        title: 't',
        body: 'b',
      }),
    ).rejects.toBe(boom);
    expect(setStatus).toHaveBeenCalledWith(ISSUE_A, 'cancelled');
  });

  it('still rethrows the ORIGINAL failure when the compensating cancel also fails', async () => {
    flag.value = '1';
    const boom = new Error('ddb down');
    __setMissionEngineForTest({
      createMission: () => Promise.resolve(projected()),
      setStatus: () => Promise.reject(new Error('paperclip down too')),
    } as unknown as MissionEngine);
    const prov = await import('../state/mission-provenance-repo.js');
    vi.mocked(prov.putMissionProvenance).mockRejectedValueOnce(boom);

    await expect(
      createBoardMission({
        ownerAgent: 'main',
        createdByAgent: 'dashboard',
        createdByChat: 'dashboard:hash',
        title: 't',
        body: 'b',
      }),
    ).rejects.toBe(boom);
  });
});
