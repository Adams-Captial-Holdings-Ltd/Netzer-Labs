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
// honest default here: these cases assert scoping, not the C-11 restore.
vi.mock('../state/mission-provenance-repo.js', () => ({
  getMissionProvenance: vi.fn(() => Promise.resolve(new Map())),
  putMissionProvenance: vi.fn(() => Promise.resolve()),
  listProvenanceForChat: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../state/inter-agent-tasks-repo.js', () => ({ sendInterAgent: vi.fn() }));
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
  priority: 50,
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
}

function injectEngine(rows: ProjectedMission[]): EngineSpies {
  const listMissions = vi.fn(() => Promise.resolve(rows));
  const setStatus = vi.fn(() => Promise.resolve(rows[0]));
  __setMissionEngineForTest({
    listMissions,
    setStatus,
    getMission: vi.fn(),
    createMission: vi.fn(),
    reassign: vi.fn(),
    comment: vi.fn(),
  } as unknown as MissionEngine);
  return { listMissions, setStatus };
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
  /** The owner each scoped list read was made for, on the substrate that served it. */
  listedOwners(): string[];
  /** Status mutations that actually reached the substrate. */
  statusWrites(): StatusWrite[];
  /** Nothing reached the OTHER substrate — the flag picks one whole stack (C-8). */
  expectOtherStackUntouched(): void;
}

let engine: EngineSpies;

const STACKS: Stack[] = [
  {
    name: 'legacy DynamoDB stack (flag off)',
    flagValue: undefined,
    arm() {
      listByStatusMock.mockResolvedValue([WIRE_ROW]);
      listForAgentMock.mockResolvedValue([WIRE_ROW]);
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
    expectOtherStackUntouched() {
      expect(engine.listMissions).not.toHaveBeenCalled();
      expect(engine.setStatus).not.toHaveBeenCalled();
    },
  },
  {
    name: 'Paperclip stack (CCE_PAPERCLIP_ENABLED=1)',
    flagValue: '1',
    arm() {
      engine = injectEngine([PROJECTED_ROW]);
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
    expectOtherStackUntouched() {
      expect(listByStatusMock).not.toHaveBeenCalled();
      expect(listForAgentMock).not.toHaveBeenCalled();
      expect(updateStatusMock).not.toHaveBeenCalled();
      expect(reassignMock).not.toHaveBeenCalled();
    },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  listKnownAgentsMock.mockReturnValue(['main', 'research', 'ops']);
  listByStatusMock.mockResolvedValue([]);
  listForAgentMock.mockResolvedValue([]);
  updateStatusMock.mockResolvedValue(true);
  // Every case arms its own stack; an engine is always injected so the
  // legacy-stack cases can assert it was never reached.
  engine = injectEngine([PROJECTED_ROW]);
  __setMissionEngineForTest(undefined);
});

// Missions are per-agent state. An agent naming another agent's owner id must
// be refused on both the read and the write path; without these checks any
// prompt-injected agent could read or cancel another agent's queue.
describe.each(STACKS)('mission tool ownership checks — $name', (stack: Stack) => {
  beforeEach(() => {
    flag.value = stack.flagValue;
    stack.arm();
  });

  it('list_missions refuses a foreign owner', async () => {
    const out = await tools.invoke('list_missions', { owner: 'ops' }, ctx);
    expect(out.isError).toBe(true);
    // The refusal is ABOVE the ACL: neither substrate is read at all.
    expect(listByStatusMock).not.toHaveBeenCalled();
    expect(listForAgentMock).not.toHaveBeenCalled();
    expect(engine.listMissions).not.toHaveBeenCalled();
  });

  it('list_missions defaults to the calling agent', async () => {
    const out = await tools.invoke('list_missions', {}, ctx);
    expect(stack.listedOwners()).toEqual(['research']);
    expect(out.isError).toBeFalsy();
    // Re-pinned in Phase 8: `list_missions` now renders through the shared
    // mission formatter, so a tool answer and a `/missions` reply speak one
    // vocabulary - the kanban's column labels and its `P<n>` badge.
    expect(out.text).toBe('1 Open mission for research:\n[abc12345] P50 Open — Ship the ACL');
    stack.expectOtherStackUntouched();
  });

  it('list_missions allows naming yourself explicitly', async () => {
    const out = await tools.invoke('list_missions', { owner: 'research' }, ctx);
    expect(stack.listedOwners()).toEqual(['research']);
    // Re-pinned in Phase 8: `list_missions` now renders through the shared
    // mission formatter, so a tool answer and a `/missions` reply speak one
    // vocabulary - the kanban's column labels and its `P<n>` badge.
    expect(out.text).toBe('1 Open mission for research:\n[abc12345] P50 Open — Ship the ACL');
    stack.expectOtherStackUntouched();
  });

  it('update_mission refuses a foreign owner', async () => {
    const out = await tools.invoke(
      'update_mission',
      { mission_id: PREFIX, owner: 'ops', status: 'cancelled' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(updateStatusMock).not.toHaveBeenCalled();
    expect(engine.setStatus).not.toHaveBeenCalled();
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
});
