/**
 * The mission tools' ownership checks, run against BOTH SUBSTRATES.
 *
 * WHY THIS FILE IS PARAMETRIZED RATHER THAN MOCKED AT ONE LEVEL. `mission-tools.ts`
 * is one of the four callers Phase 7 repointed at the ACL, and its repointing is
 * asserted by a GREP (`repo-imports.test.ts`) — a rule about the module graph,
 * which cannot say a single thing about behaviour. This file was that behaviour,
 * and while it mocked `mission-tasks-repo.js` directly it only ever exercised
 * whichever stack the ambient environment selected: CI runs flag-off, so with
 * `CCE_PAPERCLIP_ENABLED=1` — the configuration this phase exists to ship — three
 * of its five cases failed, and nothing on the Paperclip path was covered at all.
 *
 * So the flag is a MOCK SEAM here (the same one `mission-acl.test.ts` uses) and
 * every case below runs twice: once with the legacy DynamoDB repo behind the real
 * ACL, once with an injected Paperclip engine behind it. Nothing about the tools
 * is mocked, and the ACL is the real one — a regression that repointed either
 * tool back at the repo fails the Paperclip half of every case.
 *
 * The two stacks are fed rows that project to the SAME wire mission, so the tool
 * TEXT is asserted as one literal on both — the tools' half of the envelope
 * equality the routes prove.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { flag } = vi.hoisted(() => ({ flag: { value: undefined as string | undefined } }));
vi.mock('../../config/env.js', () => ({
  loadEnv: () => ({ CCE_PAPERCLIP_ENABLED: flag.value }),
}));

const {
  createMissionMock,
  listByStatusMock,
  listForAgentMock,
  updateStatusMock,
  reassignMock,
  listKnownAgentsMock,
} = vi.hoisted(() => ({
  createMissionMock: vi.fn(),
  listByStatusMock: vi.fn(),
  listForAgentMock: vi.fn(),
  updateStatusMock: vi.fn(),
  reassignMock: vi.fn(),
  listKnownAgentsMock: vi.fn(),
}));

vi.mock('../state/mission-tasks-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/mission-tasks-repo.js')>();
  return {
    ...actual,
    createMission: createMissionMock,
    listMissionsByStatus: listByStatusMock,
    listMissionsForAgent: listForAgentMock,
    updateMissionStatus: updateStatusMock,
    reassignMission: reassignMock,
  };
});
// The provenance join the ACL performs on every Paperclip read. Empty is the
// default: most cases assert scoping, not the C-11 restore. It is ARMABLE
// because the mutation rule reads `createdByAgent`, and on the Paperclip stack
// that field comes from this join — the projection itself only says
// `'paperclip'`. A stack that could not arm it could not tell an
// owner-or-creator predicate from an owner-only one.
const { getProvenanceMock } = vi.hoisted(() => ({ getProvenanceMock: vi.fn() }));
vi.mock('../state/mission-provenance-repo.js', () => ({
  getMissionProvenance: getProvenanceMock,
  putMissionProvenance: vi.fn(() => Promise.resolve()),
  listProvenanceForChat: vi.fn(() => Promise.resolve([])),
}));
// `create_mission` chains `.catch()` onto this call, so the mock has to return
// a promise — a bare `vi.fn()` answers `undefined` and the tool throws before
// it returns. It only fires on a CROSS-BOARD create, which is exactly what the
// identity cases at the bottom of this file make.
vi.mock('../state/inter-agent-tasks-repo.js', () => ({
  sendInterAgent: vi.fn(() => Promise.resolve()),
}));
vi.mock('../config/agent-loader.js', () => ({
  listKnownAgents: listKnownAgentsMock,
  loadAgent: vi.fn(),
}));
vi.mock('../bedrock/client.js', () => ({ converseTurn: vi.fn() }));

import type { Mission } from '../state/mission-tasks-repo.js';
import type { MissionEngine } from '../paperclip/mission-engine.js';
import type { ProjectedMission } from '../paperclip/mission-projection.js';
import { __setMissionEngineForTest } from '../missions/mission-acl.js';
import './mission-tools.js'; // side-effect registration
import { tools } from './registry.js';

const ctx = { agentId: 'research', chatId: 'owner:emmanuel' };

/** A full issue uuid whose 8-char prefix is what `list_missions` would print. */
const MISSION_ID = 'abc12345-1111-4111-8111-111111111111';
const PREFIX = MISSION_ID.slice(0, 8);

const WIRE_ROW: Mission = {
  id: MISSION_ID,
  ownerAgent: 'research',
  createdByAgent: 'research',
  createdByChat: 'owner:emmanuel',
  title: 'Ship the ACL',
  body: 'Byte for byte.',
  priority: 'medium',
  status: 'open',
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
};

/** The Paperclip row that projects to exactly `WIRE_ROW`. */
const PROJECTED_ROW: ProjectedMission = {
  ...WIRE_ROW,
  identifier: 'NZR-42',
  createdByAgent: 'paperclip',
  createdByChat: 'paperclip',
  bodyTruncated: false,
};

interface EngineSpies {
  listMissions: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  createMission: ReturnType<typeof vi.fn>;
}

function injectEngine(rows: ProjectedMission[]): EngineSpies {
  const listMissions = vi.fn(() => Promise.resolve(rows));
  const setStatus = vi.fn(() => Promise.resolve(rows[0]));
  // The engine echoes the seed back as a projected row, which is what the real
  // one does. The ACL then joins the provenance it just wrote over that row, so
  // `createdByAgent` reaches the caller by the same two-step route as in
  // production — the projection itself only ever says `'paperclip'`.
  const createMission = vi.fn((seed: Mission) =>
    Promise.resolve({ ...PROJECTED_ROW, id: seed.id, ownerAgent: seed.ownerAgent }),
  );
  __setMissionEngineForTest({
    listMissions,
    setStatus,
    getMission: vi.fn(),
    createMission,
    reassign: vi.fn(),
    comment: vi.fn(),
  } as unknown as MissionEngine);
  return { listMissions, setStatus, createMission };
}

/** One mutation the substrate accepted: `{owner?, id, status}`, however it got there. */
interface StatusWrite {
  id: string;
  status: string;
}

interface Stack {
  name: string;
  flagValue: string | undefined;
  /** Arm the substrate with one open mission owned by `research`. */
  arm(): void;
  /** Arm the substrate with one mission that reads back as exactly `row`. */
  armRow(row: Mission): void;
  /** The owner each scoped list read was made for, on the substrate that served it. */
  listedOwners(): string[];
  /** Status mutations that actually reached the substrate. */
  statusWrites(): StatusWrite[];
  /** The rows `create_mission` handed the substrate, as the substrate saw them. */
  createdRows(): Mission[];
  /** Nothing reached the OTHER substrate — the flag picks one whole stack (C-8). */
  expectOtherStackUntouched(): void;
}

let engine: EngineSpies;

const STACKS: Stack[] = [
  {
    name: 'legacy DynamoDB stack (flag off)',
    flagValue: undefined,
    arm() {
      this.armRow(WIRE_ROW);
    },
    armRow(row: Mission) {
      listByStatusMock.mockResolvedValue([row]);
      listForAgentMock.mockResolvedValue([row]);
      updateStatusMock.mockResolvedValue(true);
    },
    listedOwners() {
      return [...listByStatusMock.mock.calls, ...listForAgentMock.mock.calls].map(
        (call) => call[0] as string,
      );
    },
    statusWrites() {
      return updateStatusMock.mock.calls.map((call) => ({
        id: call[1] as string,
        status: call[2] as string,
      }));
    },
    createdRows() {
      return createMissionMock.mock.calls.map((call) => call[0] as Mission);
    },
    expectOtherStackUntouched() {
      expect(engine.listMissions).not.toHaveBeenCalled();
      expect(engine.setStatus).not.toHaveBeenCalled();
      expect(engine.createMission).not.toHaveBeenCalled();
    },
  },
  {
    name: 'Paperclip stack (CCE_PAPERCLIP_ENABLED=1)',
    flagValue: '1',
    arm() {
      this.armRow(WIRE_ROW);
    },
    armRow(row: Mission) {
      // Owner comes off the projection, creator off the provenance join — the
      // same split the real stack has, so both stacks still hand the tools the
      // SAME wire mission.
      engine = injectEngine([{ ...PROJECTED_ROW, id: row.id, ownerAgent: row.ownerAgent }]);
      getProvenanceMock.mockResolvedValue(
        new Map([
          [
            row.id,
            {
              missionId: row.id,
              createdByAgent: row.createdByAgent,
              createdByChat: row.createdByChat,
            },
          ],
        ]),
      );
    },
    listedOwners() {
      return engine.listMissions.mock.calls.map(
        (call) => (call[0] as { ownerAgent: string }).ownerAgent,
      );
    },
    statusWrites() {
      return engine.setStatus.mock.calls.map((call) => ({
        id: call[0] as string,
        status: call[1] as string,
      }));
    },
    createdRows() {
      return engine.createMission.mock.calls.map((call) => call[0] as Mission);
    },
    expectOtherStackUntouched() {
      expect(createMissionMock).not.toHaveBeenCalled();
      expect(listByStatusMock).not.toHaveBeenCalled();
      expect(listForAgentMock).not.toHaveBeenCalled();
      expect(updateStatusMock).not.toHaveBeenCalled();
      expect(reassignMock).not.toHaveBeenCalled();
    },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  getProvenanceMock.mockResolvedValue(new Map());
  listKnownAgentsMock.mockReturnValue(['main', 'research', 'ops']);
  listByStatusMock.mockResolvedValue([]);
  listForAgentMock.mockResolvedValue([]);
  updateStatusMock.mockResolvedValue(true);
  // `create_mission` reads `mission.id` back off the substrate for the ref it
  // prints, so the legacy repo has to answer with the row it was handed. The
  // Paperclip half of this is in `injectEngine`. Armed once here rather than
  // per stack: it is the substrate's default behaviour, not a case's setup.
  createMissionMock.mockImplementation((args: Mission) =>
    Promise.resolve({ ...WIRE_ROW, ...args, id: MISSION_ID }),
  );
  // Every case arms its own stack; an engine is always injected so the
  // legacy-stack cases can assert it was never reached.
  engine = injectEngine([PROJECTED_ROW]);
  __setMissionEngineForTest(undefined);
});

// ADR 0009 :93-96 splits the two paths, and the owner's 2026-09-05 decision
// instantiates it for Netzar: an agent may READ any board in the company, and
// may MUTATE a mission only if it owns or created it. So a foreign owner id is
// no longer a refusal by itself — it is one only when the row it names is
// one this agent neither owns nor opened, which is knowable only after the row
// has been resolved.
describe.each(STACKS)('mission tool authorization — $name', (stack: Stack) => {
  beforeEach(() => {
    flag.value = stack.flagValue;
    stack.arm();
  });

  // ADR 0009 :93-96 is the reason the old refusal is gone: reads are scoped by
  // PARTICIPATION, not by ownership ("an agent may read a mission iff it has a
  // task on that mission, or it is the coordinator"), which the owner's
  // 2026-09-05 decision instantiates for Netzar as "read any board in the
  // company". Only MUTATION stays narrow, and that half is asserted below.
  //
  // THIS CASE PROVES THE TOOL, NOT THE RULE. The rule is `canReadBoard` and its
  // truth table is in `mission-acl.test.ts`; what is asserted here is that
  // `list_missions` ASKS it and then actually reads the board it was given.
  it("list_missions reads another agent's board", async () => {
    const out = await tools.invoke('list_missions', { owner: 'ops' }, ctx);
    expect(out.isError).toBeFalsy();
    // P31: assert the READ REACHED THE SUBSTRATE, scoped to the named board.
    // `out.isError` being falsy is not enough on its own — a tool that quietly
    // returned an empty board without reading anything would satisfy it.
    expect(stack.listedOwners()).toEqual(['ops']);
    stack.expectOtherStackUntouched();
  });

  it('list_missions defaults to the calling agent', async () => {
    const out = await tools.invoke('list_missions', {}, ctx);
    expect(stack.listedOwners()).toEqual(['research']);
    expect(out.isError).toBeFalsy();
    // Re-pinned in Phase 8: `list_missions` now renders through the shared
    // mission formatter, so a tool answer and a `/missions` reply speak one
    // vocabulary - the kanban's column and four-band priority labels.
    expect(out.text).toBe('1 Open mission for research:\n[abc12345] Medium Open — Ship the ACL');
    stack.expectOtherStackUntouched();
  });

  it('list_missions allows naming yourself explicitly', async () => {
    const out = await tools.invoke('list_missions', { owner: 'research' }, ctx);
    expect(stack.listedOwners()).toEqual(['research']);
    // Re-pinned in Phase 8: `list_missions` now renders through the shared
    // mission formatter, so a tool answer and a `/missions` reply speak one
    // vocabulary - the kanban's column and four-band priority labels.
    expect(out.text).toBe('1 Open mission for research:\n[abc12345] Medium Open — Ship the ACL');
    stack.expectOtherStackUntouched();
  });

  // ADR 0009 :93-96: "it may write a task iff that task is assigned to it, or
  // it is the coordinator" — owner-or-creator for Netzar. `research` is neither.
  it('update_mission refuses an agent that neither owns nor created the mission', async () => {
    stack.armRow({ ...WIRE_ROW, ownerAgent: 'ops', createdByAgent: 'ops' });
    const out = await tools.invoke(
      'update_mission',
      { mission_id: PREFIX, owner: 'ops', status: 'cancelled' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.text).toBe("You can only update missions you own or created (owner 'research').");
    // The refusal lands AFTER resolution and BEFORE the write: the creator is
    // knowable only from the row, so the board is read once and nothing is
    // written. Asserting the read (P31) is what makes this a proof that the
    // PREDICATE refused, rather than that the tool never got that far.
    expect(stack.listedOwners()).toEqual(['ops']);
    expect(stack.statusWrites()).toEqual([]);
    stack.expectOtherStackUntouched();
  });

  it('update_mission lets the CREATOR transition a mission owned by another agent', async () => {
    // The delegation P0-3 unblocks: `research` opened this one for `ops`, and
    // can still transition it.
    stack.armRow({ ...WIRE_ROW, ownerAgent: 'ops', createdByAgent: 'research' });
    const out = await tools.invoke(
      'update_mission',
      { mission_id: PREFIX, owner: 'ops', status: 'done' },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(out.text).toBe(`Mission ${PREFIX} → Done.`);
    // P31: the write REACHED the substrate. A tool that printed the happy
    // sentence and wrote nothing would satisfy an `isError`-only assertion.
    const writes = stack.statusWrites();
    expect(writes.length).toBe(1);
    expect(writes[0].status).toBe('done');
    expect(writes[0].id).toBe(stack.flagValue === undefined ? PREFIX : MISSION_ID);
    // And it was scoped to the board that was NAMED, not to the caller's own.
    if (stack.flagValue === undefined) {
      expect(updateStatusMock.mock.calls[0][0]).toBe('ops');
    }
    // The read this authorization cost, scoped to the board that was NAMED.
    //
    // ON THE PAPERCLIP STACK that is the WHOLE cost: the row the tool resolved
    // in order to authorize is the row `setBoardMissionStatus` then writes
    // against, so a cross-board update is one board read, not two (A1-10).
    //
    // ON LEGACY IT IS NOT, and this assertion cannot see the difference. The
    // flag-off path ignores the resolved row and calls
    // `repoUpdateMissionStatus`, which re-scans the board itself
    // (`mission-tasks-repo.ts:184`) — but that function is mocked whole here, so
    // its scan never runs and never lands in `listedOwners()`. A cross-board
    // update on legacy really costs TWO reads. It cost zero before, because it
    // was refused before the ACL; the extra read is the price of knowing who
    // created the row, and it is charged only on the cross-board branch.
    expect(stack.listedOwners()).toEqual(['ops']);
    stack.expectOtherStackUntouched();
  });

  it('update_mission still works on your own missions', async () => {
    const out = await tools.invoke('update_mission', { mission_id: PREFIX, status: 'done' }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.text).toBe(`Mission ${PREFIX} → Done.`);
    const writes = stack.statusWrites();
    expect(writes.length).toBe(1);
    expect(writes[0].status).toBe('done');
    // Legacy resolves the prefix inside the repo, so the PREFIX is what crosses
    // into it; the ACL resolves before the engine, so the FULL uuid is what
    // crosses. Asserted exactly, per stack, rather than as `startsWith(PREFIX)`
    // — which the unresolved prefix satisfies too and would let an ACL that
    // forgot to resolve pass this test.
    expect(writes[0].id).toBe(stack.flagValue === undefined ? PREFIX : MISSION_ID);
    // And the write was scoped to the caller's own board, on both stacks: legacy
    // passes the owner to the repo, the ACL resolves inside an owner-scoped read.
    if (stack.flagValue === undefined) {
      expect(updateStatusMock.mock.calls[0][0]).toBe('research');
    } else {
      expect(stack.listedOwners()).toEqual(['research']);
    }
    stack.expectOtherStackUntouched();
  });

  // ── ONE IDENTITY STAMPS THE CREATOR AND JUDGES IT ──────────────────────────
  //
  // `ctx.agentId` is the SESSION actor; `ctx.boardAgentId` is the BOARD this
  // chat addresses (`agent-loop.ts:178-197`). They differ exactly where one
  // surface runs several bots and the picker can answer as someone else — on
  // Telegram the sticky default answers `main` inside another bot's webhook.
  //
  // If `create_mission` stamped the session actor while `update_mission` asked
  // about the board, then ON THAT SURFACE the agent that opened a mission is
  // refused as its creator. That fails closed, so no test of a refusal would
  // have caught it; what it breaks is the delegation this piece exists to ship,
  // and it breaks it on ONE surface, which is the shape of bug CLAUDE.md's
  // parity rule is about. The two cases below pin both directions: the board
  // identity is stamped and may act, and the session identity alone may not
  // inherit what the board identity created.
  const boardCtx = { agentId: 'main', boardAgentId: 'research', chatId: 'owner:emmanuel' };

  it('stamps the BOARD identity as creator, and that identity may then transition the row', async () => {
    const created = await tools.invoke(
      'create_mission',
      { owner: 'ops', title: 'Ship the ACL', body: 'Byte for byte.' },
      boardCtx,
    );
    expect(created.isError).toBeFalsy();
    // P31: the create REACHED the substrate, and the creator it recorded is the
    // BOARD agent. `ctx.agentId` is `main` here, and `main` must not appear.
    const rows = stack.createdRows();
    expect(rows.length).toBe(1);
    expect(rows[0].createdByAgent).toBe('research');
    expect(rows[0].ownerAgent).toBe('ops');

    // Read that same row back and transition it with the SAME ctx. The row is
    // built FROM what the create recorded, not from a literal, so the two
    // halves cannot drift apart without this failing: a create that stamped
    // `main` arms a row created by `main`, which the update then refuses.
    stack.armRow({
      ...WIRE_ROW,
      ownerAgent: rows[0].ownerAgent,
      createdByAgent: rows[0].createdByAgent,
    });
    const out = await tools.invoke(
      'update_mission',
      { mission_id: PREFIX, owner: 'ops', status: 'done' },
      boardCtx,
    );
    expect(out.isError).toBeFalsy();
    // P31 again: the transition reached the substrate, it was not just narrated.
    const writes = stack.statusWrites();
    expect(writes.length).toBe(1);
    expect(writes[0].status).toBe('done');
    expect(writes[0].id).toBe(stack.flagValue === undefined ? PREFIX : MISSION_ID);
  });

  it('refuses the SESSION identity alone on a mission the BOARD identity created', async () => {
    await tools.invoke(
      'create_mission',
      { owner: 'ops', title: 'Ship the ACL', body: 'Byte for byte.' },
      boardCtx,
    );
    const rows = stack.createdRows();
    stack.armRow({
      ...WIRE_ROW,
      ownerAgent: rows[0].ownerAgent,
      createdByAgent: rows[0].createdByAgent,
    });
    // Same mission, same session actor, no board scope — so `self` is `main`,
    // and `main` neither owns this row nor created it: `research` did, as the
    // board. The refusal is what proves the creator stamped above is the BOARD
    // identity and not the session one; if it were the session one, `main`
    // would inherit the mutation right and this update would land.
    const out = await tools.invoke(
      'update_mission',
      { mission_id: PREFIX, owner: 'ops', status: 'cancelled' },
      { agentId: 'main', chatId: 'owner:emmanuel' },
    );
    expect(out.isError).toBe(true);
    expect(out.text).toBe("You can only update missions you own or created (owner 'main').");
    expect(stack.statusWrites()).toEqual([]);
  });
});
