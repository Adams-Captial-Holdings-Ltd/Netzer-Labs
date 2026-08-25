/**
 * `/missions` and `/mission` — the Missions board's cross-surface entry point.
 *
 * WHY THERE IS NO TELEGRAM TEST, NO SLACK TEST AND NO DASHBOARD TEST HERE, and
 * why that is the point rather than a gap: the surfaces have NO mission code to
 * test. `runCommand` is the surface-agnostic router every chat entry point
 * already calls, so a command lands on Telegram, both Slack send paths and the
 * dashboard by construction. What a per-surface test could still catch — a path
 * that forgot to render `cmd.reply` — is asserted by counting call sites per
 * file in `src/lib/missions/format.test.ts`, which is the only way to state a
 * property of the form "four code paths, not three surfaces".
 *
 * The Mission ACL is mocked, never the formatter: the copy is pinned once, in
 * the pure test beside it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { listMock, listByStatusMock, createMock, setStatusMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  listByStatusMock: vi.fn(),
  createMock: vi.fn(),
  setStatusMock: vi.fn(),
}));

vi.mock('../lib/missions/mission-acl.js', async () => {
  // The error CLASS is the real one: the router branches on `instanceof`, so a
  // mock class would make the ambiguous-prefix branch untestable through the
  // router - which is exactly the branch that used to answer "board
  // unavailable" for a working board.
  const real = await vi.importActual<typeof import('../lib/missions/mission-acl.js')>(
    '../lib/missions/mission-acl.js',
  );
  return {
    AmbiguousMissionPrefixError: real.AmbiguousMissionPrefixError,
    listBoardMissions: listMock,
    listBoardMissionsByStatus: listByStatusMock,
    createBoardMission: createMock,
    setBoardMissionStatus: setStatusMock,
  };
});
vi.mock('../lib/config/agent-loader.js', () => ({
  listKnownAgents: () => ['main', 'ops', 'research'],
  loadAgent: vi.fn(),
  invalidateAgentCache: vi.fn(),
}));
vi.mock('../lib/state/agents-repo.js', () => ({ updateAgent: vi.fn() }));
vi.mock('../lib/config/invalidation-publisher.js', () => ({ publishInvalidation: vi.fn() }));
vi.mock('../lib/state/sessions-repo.js', () => ({
  clearSession: vi.fn(),
  setModelOverride: vi.fn(),
  setWarroomMode: vi.fn(),
  getSession: vi.fn(async () => null),
}));
vi.mock('../lib/warroom/meetings-repo.js', () => ({
  createMeeting: vi.fn(),
  getMeeting: vi.fn(),
  endMeeting: vi.fn(),
}));
vi.mock('../lib/warroom/orchestrator.js', () => ({ parseMentions: () => [] }));

import type { Mission } from '../lib/state/mission-tasks-repo.js';
import { AmbiguousMissionPrefixError } from '../lib/missions/mission-acl.js';
import { runCommand } from './commands.js';

const ROW: Mission = {
  id: 'abc12345-1111-4111-8111-111111111111',
  ownerAgent: 'research',
  createdByAgent: 'research',
  createdByChat: 'owner:emmanuel',
  title: 'Ship the reconciler',
  body: 'With a watermark overlap.',
  priority: 'high',
  status: 'open',
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
};
const SIBLING: Mission = { ...ROW, id: 'abc12345-2222-4222-8222-222222222222' };

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([ROW]);
  listByStatusMock.mockResolvedValue([ROW]);
  createMock.mockResolvedValue(ROW);
  setStatusMock.mockResolvedValue(true);
});

describe('/missions', () => {
  it('defaults to the open column, the same default the board opens on', async () => {
    const out = await runCommand('research', 'owner:emmanuel', '/missions');
    expect(listByStatusMock).toHaveBeenCalledWith('research', 'open', 15);
    expect(out?.reply).toBe(
      '1 Open mission for research:\n[abc12345] High Open — Ship the reconciler',
    );
  });

  it('accepts "all" without inventing a fifth status', async () => {
    await runCommand('research', 'owner:emmanuel', '/missions all');
    expect(listMock).toHaveBeenCalledWith('research', 15);
    expect(listByStatusMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown status instead of asking the board for it', async () => {
    // The regression this guards: an unrecognized status is a silent `200 []`
    // on the Paperclip list filter, not a 400 — so an unvalidated word here
    // would report an EMPTY BOARD for a typo.
    const out = await runCommand('research', 'owner:emmanuel', '/missions in-review');
    expect(out?.reply).toContain("Unknown status 'in-review'");
    expect(listByStatusMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('is scoped to the addressed agent, never a caller-supplied owner', async () => {
    // Missions are per-agent state. The tools take an `owner` argument and
    // refuse a foreign one; the command takes none at all, so there is nothing
    // to refuse.
    await runCommand('ops', 'owner:emmanuel', '/missions');
    expect(listByStatusMock).toHaveBeenCalledWith('ops', 'open', 15);
  });
});

describe('/mission', () => {
  it('renders one card for a resolved 8-char ref', async () => {
    const out = await runCommand('research', 'owner:emmanuel', '/mission abc12345');
    expect(out?.reply).toContain('[abc12345] Ship the reconciler');
    expect(out?.reply).toContain('Open · High priority · owner research');
  });

  it('REFUSES an ambiguous ref on a read, the same answer the mutation gives', async () => {
    // The shipped defect, reproduced: with two missions sharing prefix
    // `abc12345`, `/mission abc12345` rendered exactly ONE card for the nearer
    // row and never said the prefix was ambiguous — while `/mission done
    // abc12345` on the same board in the same turn raised
    // AmbiguousMissionPrefixError. A read that denies a collision the mutation
    // refuses over is the A3-4 failure, not a UX nit.
    listMock.mockResolvedValue([ROW, SIBLING]);
    const out = await runCommand('research', 'owner:emmanuel', '/mission abc12345');
    expect(out?.reply).toContain('pass one of these full ids');
    expect(out?.reply).toContain('matches 2 of');
  });

  it('resolves a ref past the row the LIST shows — same window as the mutation', async () => {
    // The other half, and it was silent in the direction that matters: the read
    // used MISSION_LIST_LIMIT (15) rows, so on a 40-row board `/mission
    // aaaaaa30` answered "No mission matches" for a mission `/mission done
    // aaaaaa30` happily transitioned. Row 30 is past the display limit and
    // inside the resolve window.
    const board: Mission[] = Array.from({ length: 40 }, (_, i) => ({
      ...ROW,
      id: `aaaaaa${String(i).padStart(2, '0')}-1111-4111-8111-111111111111`,
      title: `row ${i}`,
    }));
    listMock.mockResolvedValue(board);
    const out = await runCommand('research', 'owner:emmanuel', '/mission aaaaaa30');
    expect(listMock).toHaveBeenCalledWith('research', 200);
    expect(out?.reply).toContain('[aaaaaa30] row 30');
  });

  it('hands the RAW ref to the ACL on a mutation, so an ambiguous prefix refuses', async () => {
    // The regression this guards is the one the ACL's AmbiguousMissionPrefixError
    // exists for: legacy `find(startsWith)` transitioned the FIRST row in an
    // unordered sweep, i.e. the wrong mission. A mutation must never resolve a
    // prefix in the command router.
    await runCommand('research', 'owner:emmanuel', '/mission done abc12345');
    expect(setStatusMock).toHaveBeenCalledWith('research', 'abc12345', 'done');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('reports the ACL\'s false as "no match", the legacy 404 signal', async () => {
    setStatusMock.mockResolvedValue(false);
    const out = await runCommand('research', 'owner:emmanuel', '/mission done deadbeef');
    expect(out?.reply).toBe("No mission matches 'deadbeef' for research.");
  });

  it('answers an ambiguous MUTATION as a user error, not as an outage', async () => {
    // THE REGRESSION, and it mislabelled a working board as a broken one: the
    // ACL raises AmbiguousMissionPrefixError from the mutation path, the
    // router's catch did not distinguish it, so `/mission done <prefix>`
    // answered "Mission board unavailable: Mission id 'abc12345' matches 2 …".
    // Two different conditions, and the outage sentence is the wrong one - the
    // board was fine and the ref was short.
    setStatusMock.mockRejectedValue(
      new AmbiguousMissionPrefixError('research', 'abc12345', [ROW.id, SIBLING.id]),
    );
    const out = await runCommand('research', 'owner:emmanuel', '/mission done abc12345');
    expect(out?.reply).not.toContain('unavailable');
    expect(out?.reply).toContain('pass one of these full ids');
    // And it is the SAME sentence the read path gives for the same input.
    listMock.mockResolvedValue([ROW, SIBLING]);
    const read = await runCommand('research', 'owner:emmanuel', '/mission abc12345');
    expect(out?.reply).toBe(read?.reply);
  });

  it('opens a mission owned by the addressed agent, with no Haiku round trip', async () => {
    const out = await runCommand('research', 'owner:emmanuel', '/mission new Ship the reconciler');
    expect(createMock).toHaveBeenCalledWith({
      ownerAgent: 'research',
      createdByAgent: 'research',
      createdByChat: 'owner:emmanuel',
      title: 'Ship the reconciler',
      body: 'Ship the reconciler',
      priority: 'medium',
      assignmentReason: 'opened from a chat command',
    });
    expect(out?.reply).toContain('[abc12345] Ship the reconciler');
  });
});

describe('the swallowing catch', () => {
  it.each([
    ['/missions', () => listByStatusMock.mockRejectedValue(new Error('paperclip unavailable'))],
    ['/mission abc12345', () => listMock.mockRejectedValue(new Error('paperclip unavailable'))],
    ['/mission done abc12345', () => setStatusMock.mockRejectedValue(new Error('paperclip unavailable'))],
    ['/mission new x', () => createMock.mockRejectedValue(new Error('paperclip unavailable'))],
  ])('%s answers instead of throwing when the remote board fails', async (text, arrange) => {
    // THE REGRESSION THIS GUARDS: runCommand's five chat call sites all `await`
    // it unguarded. A throw here 500s the Telegram webhook — which then retries
    // the same message for ~60 seconds — and both Slack event routes. Unlike
    // /status, this command talks to a REMOTE board, so it really can throw.
    arrange();
    const out = await runCommand('research', 'owner:emmanuel', text);
    expect(out?.reply).toBe('Mission board unavailable: paperclip unavailable');
  });

  it('still says something rather than posting a blank message', async () => {
    // An empty catch body — correct for a fire-and-forget status callback — is
    // wrong here: the surface would edit its placeholder to nothing. The
    // dashboard's Missions tab settled the same argument with an ErrorState.
    listByStatusMock.mockRejectedValue(new Error(''));
    const out = await runCommand('research', 'owner:emmanuel', '/missions');
    expect(out?.reply.length).toBeGreaterThan(0);
  });
});

describe('discoverability', () => {
  it('lists both commands in /help, so every surface advertises them', async () => {
    const help = await runCommand('research', 'owner:emmanuel', '/help');
    expect(help?.reply).toContain(
      '/missions [open|in_progress|blocked|in_review|done|cancelled|all]',
    );
    // Backticked placeholders, not `<id>`: the dashboard renders /help through
    // `marked` + DOMPurify, which emits `<id>` as an unknown HTML element and
    // then strips it, so the angle-bracket idiom advertises these commands to
    // that surface with the arguments MISSING. See MISSION_HELP_LINES.
    expect(help?.reply).toContain('/mission `id`');
    expect(help?.reply).toContain('/mission new `title`');
    expect(help?.reply).toContain('/mission done `id`');
  });
});
