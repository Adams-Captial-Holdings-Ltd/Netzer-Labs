/**
 * SLACK PARITY FOR THE COMMAND-SCOPE RULE (CLAUDE.md, "chat surface parity").
 *
 * The rule Telegram now enforces — a command acts on the bot that received it,
 * unless the message OPENS by addressing another agent — has to mean the same
 * thing here, because Slack's workspace `/events` path resolves its command
 * through the very same `pickAgent`, whose Rule 2 matches `@agent` ANYWHERE.
 *
 * The workspace bot's own identity IS 'main', so the WHOSE-BOARD half is
 * near-invisible on this route. The WHAT-WAS-WRITTEN half is not: before the
 * narrowing, `/mission new Ask @research about the reconciler` typed in Slack
 * was filed on research's board under the title "Ask about the reconciler" —
 * the `@research` deleted as though it had been an address — while the same
 * words typed at Slack's per-agent research app were filed correctly and
 * verbatim. Two Slack paths, one sentence, two different rows.
 *
 * Driven through the REAL `/slack/events` route with REAL HMAC-SHA256 `v0:`
 * signatures (the bad-signature control below proves the gate is live), the
 * REAL `pickAgent`, the REAL `runCommand` and the REAL `missionCommand`. Only
 * the Slack Web API, the ACL and the agent loop are stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const h = vi.hoisted(() => ({
  error: vi.fn(),
  postMessage: vi.fn(
    async (): Promise<{ ok: boolean; ts?: string; error?: string }> => ({ ok: true, ts: '1.0' }),
  ),
  createBoardMission: vi.fn(),
  listBoardMissions: vi.fn(async () => []),
  listBoardMissionsByStatus: vi.fn(async () => []),
  setBoardMissionStatus: vi.fn(async () => true),
  getSession: vi.fn(),
  runAgentTurn: vi.fn(),
  clearSession: vi.fn(async () => {}),
}));

vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: h.error, debug: vi.fn() },
  truncateForLog: (s: string) => s,
}));
vi.mock('./send.js', () => ({
  postMessage: h.postMessage,
  updateMessage: vi.fn(async () => ({ ok: true })),
  uploadFile: vi.fn(async () => ({ ok: true })),
  describeSenderError: (e: unknown) => String(e),
  defaultBotToken: () => 'xoxb-test',
}));
vi.mock('./multi-agent.js', () => ({ getSlackAgentCredsAsync: vi.fn(async () => null) }));
vi.mock('./media.js', () => ({
  processSlackFiles: vi.fn(async () => []),
  stageLabel: () => '',
  deliverSlackMedia: vi.fn(async () => {}),
}));
vi.mock('../../lib/missions/mission-acl.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/missions/mission-acl.js')>(
    '../../lib/missions/mission-acl.js',
  );
  return {
    AmbiguousMissionPrefixError: real.AmbiguousMissionPrefixError,
    createBoardMission: h.createBoardMission,
    listBoardMissions: h.listBoardMissions,
    listBoardMissionsByStatus: h.listBoardMissionsByStatus,
    setBoardMissionStatus: h.setBoardMissionStatus,
  };
});
vi.mock('../../lib/state/sessions-repo.js', () => ({
  getSession: h.getSession,
  appendTurns: vi.fn(async () => {}),
  clearSession: h.clearSession,
  setModelOverride: vi.fn(async () => {}),
  setWarroomMode: vi.fn(async () => {}),
}));
vi.mock('../../lib/config/agent-loader.js', () => ({
  listKnownAgents: () => ['main', 'ops', 'research'],
  loadAgent: vi.fn(async (id: string) => ({ id, model: '', displayName: id })),
  invalidateAgentCache: vi.fn(),
}));
vi.mock('../../agent/agent-loop.js', () => ({ runAgentTurn: h.runAgentTurn }));
vi.mock('../../lib/state/agents-repo.js', () => ({ updateAgent: vi.fn(), getAgent: vi.fn() }));
vi.mock('../../lib/config/invalidation-publisher.js', () => ({ publishInvalidation: vi.fn() }));
vi.mock('../../lib/identity/owner-alias.js', () => ({ resolveOwnerChatId: () => undefined }));
vi.mock('../../lib/state/identities-repo.js', () => ({ resolveCanonical: vi.fn(async () => null) }));
vi.mock('../../lib/state/kill-switches-repo.js', () => ({
  isKillSwitchActive: vi.fn(async () => ({ active: false })),
}));

// The mission TOOLS, so the tool half of the scope can be driven against the
// same ACL doubles as the command half. Only the tools' own outbound edges are
// mocked; `mission-tools.ts` itself is the real module.
vi.mock('../../lib/scheduler/delivery.js', () => ({
  deliverToReplyChat: vi.fn(async () => true),
}));
vi.mock('../../lib/state/inter-agent-tasks-repo.js', () => ({
  sendInterAgent: vi.fn(async () => ({})),
}));
vi.mock('../../lib/bedrock/client.js', () => ({ converseTurn: vi.fn() }));

import { buildSlackRouter } from './handler.js';
import '../../lib/tools/mission-tools.js'; // side-effect registration
import { tools } from '../../lib/tools/registry.js';

const SIGNING_SECRET = 'a-real-slack-signing-secret';

const MISSION = {
  id: 'abc12345-1111-4111-8111-111111111111',
  ownerAgent: 'main',
  createdByAgent: 'main',
  createdByChat: 'slack:C1:U9',
  title: 'Fix the reconciler',
  body: 'Fix the reconciler',
  priority: 50,
  status: 'open' as const,
  createdAt: '2026-08-21T10:00:00.000Z',
  updatedAt: '2026-08-21T10:00:00.000Z',
};

let eventSeq = 0;

/**
 * POST a signed message event to the workspace `/events` route and wait for the
 * OBSERVABLE, not the response: the route acks first and processes async.
 */
async function drive(
  text: string,
  waitFor: 'reply' | 'turn' = 'reply',
  signature?: string,
): Promise<Response> {
  const settled = new Promise<void>((resolve) => {
    if (waitFor === 'reply') {
      // Wrap whatever the case configured rather than replacing it, so a case
      // can make the post FAIL and still be woken when it happens.
      const configured = h.postMessage.getMockImplementation();
      h.postMessage.mockImplementation(async () => {
        const out = configured ? await configured() : { ok: true, ts: '1.0' };
        resolve();
        return out;
      });
    } else {
      h.runAgentTurn.mockImplementation(async () => {
        resolve();
        return { text: 'ok', modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0' };
      });
    }
  });

  const body = JSON.stringify({
    type: 'event_callback',
    event_id: `Ev${++eventSeq}`,
    event: {
      type: 'message',
      channel: 'C1',
      channel_type: 'im',
      user: 'U9',
      text,
      ts: '1755734400.0001',
    },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig =
    signature ??
    'v0=' + createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex');

  const res = await buildSlackRouter().request('/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-signature': sig,
      'x-slack-request-timestamp': ts,
    },
    body,
  });
  if (res.status !== 200) return res;
  await settled;
  await new Promise((r) => setTimeout(r, 0));
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  h.getSession.mockResolvedValue(null);
  h.createBoardMission.mockResolvedValue(MISSION);
  h.postMessage.mockImplementation(async () => ({ ok: true, ts: '1.0' }));
  h.runAgentTurn.mockResolvedValue({
    text: 'ok',
    modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
  });
});

afterEach(() => {
  delete process.env.SLACK_SIGNING_SECRET;
});

describe('slack /events: the signature gate this suite drives through is real', () => {
  it('rejects a forged signature with 401 before any command runs', async () => {
    const res = await drive('/missions', 'reply', 'v0=' + '0'.repeat(64));
    expect(res.status).toBe(401);
    expect(h.listBoardMissionsByStatus).not.toHaveBeenCalled();
  });
});

describe('slack /events: an @agent inside a command payload does not steer the command', () => {
  it('files “Ask @research about the reconciler” on MAIN’s board, title intact', async () => {
    await drive('/mission new Ask @research about the reconciler');
    expect(h.createBoardMission).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerAgent: 'main',
        createdByAgent: 'main',
        title: 'Ask @research about the reconciler',
        body: 'Ask @research about the reconciler',
      }),
    );
  });

  it('still lets a LEADING @agent address another bot, payload @agent and all', async () => {
    await drive('@ops /mission new Ask @research about the reconciler');
    expect(h.createBoardMission).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerAgent: 'ops',
        title: 'Ask @research about the reconciler',
      }),
    );
  });

  it('reads MAIN’s board for a bare /missions', async () => {
    await drive('/missions');
    expect(h.listBoardMissionsByStatus).toHaveBeenCalledWith('main', 'open', 15);
  });

  it('still honours a leading /agent prefix on a command', async () => {
    await drive('/research /missions');
    expect(h.listBoardMissionsByStatus).toHaveBeenCalledWith('research', 'open', 15);
  });
});

describe('slack /events: ordinary chat routing is untouched', () => {
  it('still routes a mid-sentence @mention in non-command chat to that agent', async () => {
    // The narrowing is a COMMAND-routing rule. Chat still behaves exactly as
    // it did — same picker choice, same stripped text — because changing that
    // is a session-model change, not this fix.
    await drive('hey @ops can you look at this', 'turn');
    expect(h.runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'ops', userText: 'hey can you look at this' }),
    );
  });
});

/**
 * THE SESSION SCOPE, MIRRORED (CLAUDE.md, "chat surface parity").
 *
 * A command has TWO scopes and Slack's workspace path has to keep them apart
 * for the same reason Telegram does. Its board literal is 'main' — this
 * endpoint IS the workspace bot — but `targetAgentId` is the picker's answer,
 * so a mid-sentence `@ops` makes them disagree. `/newchat` must follow the
 * SESSION, because the session is the row the ordinary turn in the same
 * conversation writes; scoping it on the board literal would clear a row
 * nothing reads and answer "Conversation cleared." anyway.
 */
describe('slack /events: a session command follows the session, not the board', () => {
  it('clears the session the next ordinary turn in this chat would write to', async () => {
    await drive('/newchat @ops');
    expect(h.clearSession).toHaveBeenCalledWith('ops', 'slack:C1');
    expect(h.clearSession).not.toHaveBeenCalledWith('main', 'slack:C1');

    // The control that makes the literal above mean something: the same words
    // without the slash run the turn as 'ops' too.
    vi.clearAllMocks();
    await drive('hello @ops', 'turn');
    expect(h.runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'ops' }));
  });

  it('and the board half of the SAME message still resolves to this bot', async () => {
    await drive('/mission new Ask @ops about the reconciler');
    expect(h.createBoardMission).toHaveBeenCalledWith(
      expect.objectContaining({ ownerAgent: 'main', title: 'Ask @ops about the reconciler' }),
    );
  });
});

/**
 * THE COMMAND REPLY'S SEND RESULT IS NOT DISCARDED (A3-10), and this surface is
 * where discarding it was WORST.
 *
 * Telegram's identical site was hardened in this phase; Slack's was not, and
 * `postMessage` never throws — a missing or placeholder token and the
 * `slack_posting` kill switch both come back as `{ ok: false, error }`. So a
 * refused `/missions` reply was dropped in total silence on Slack alone: the
 * command reported success to nobody, and a board that vanished looked exactly
 * like a board that was quiet. There is no second channel to apologise on,
 * because the channel is the thing that failed.
 */
describe('slack: an undelivered command reply is not silent', () => {
  it('logs at error level when the post is refused', async () => {
    h.postMessage.mockImplementation(async () => ({
      ok: false,
      error: 'slack_posting kill switch active',
    }));
    await drive('/missions');
    expect(h.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'slack_posting kill switch active' }),
      'command reply undelivered; the user saw nothing',
    );
  });

  it('says nothing when the reply lands', async () => {
    await drive('/missions');
    expect(h.error).not.toHaveBeenCalled();
  });
});

/**
 * AND THE TOOLS ACT ON THE SAME BOARD THE COMMANDS DO — the Slack half of the
 * mirror in `../telegram/handler.command-scope.test.ts` (CLAUDE.md, "chat
 * surface parity"), and it was the half nothing here caught: the workspace
 * bot's command scope resolves to `'main'` while a MID-SENTENCE `@research`
 * makes the turn agent `'research'`, so one conversation had TWO BOARDS.
 *
 *     /mission new ask @research about it   -> wrote to MAIN's board
 *     hey there @research open one for me   -> the tool wrote to RESEARCH's
 *
 * Each case drives BOTH halves in one run and compares the board id they were
 * handed rather than asserting a literal in each: a hardcoded pair can drift
 * apart while both stay green, and the property is that they are the SAME,
 * whatever it is. The ToolContext is built the way `agent-loop.ts` builds it
 * from an `AgentTurnRequest`, which is the one link this double stands in for.
 */
describe('slack: the tools read the board the commands wrote to', () => {
  const ctxFor = (req: Record<string, unknown>): Record<string, unknown> => ({
    agentId: req.agentId,
    chatId: req.chatId,
    ...(req.replyChatId ? { replyChatId: req.replyChatId } : {}),
    ...(req.boardAgentId ? { boardAgentId: req.boardAgentId } : {}),
  });

  /** The `h.*` doubles are untyped `vi.fn()`s, so their calls need widening. */
  const firstArg = (m: { mock: { calls: unknown[] } }): never =>
    (m.mock.calls as unknown as unknown[][])[0][0] as never;

  /** Drive an ordinary turn whose text mentions an agent mid-sentence. */
  async function toolCtx(): Promise<Record<string, unknown>> {
    await drive('hey there @research open one for me', 'turn');
    const ctx = ctxFor(firstArg(h.runAgentTurn) as Record<string, unknown>);
    // The picker answers as research — that is the whole trap.
    expect(ctx.agentId).toBe('research');
    return ctx;
  }

  it('answers list_missions from the SAME board /missions reads', async () => {
    await drive('/missions');
    const commandBoard = firstArg(h.listBoardMissionsByStatus);

    vi.clearAllMocks();
    const ctx = await toolCtx();
    await tools.invoke('list_missions', {}, ctx as never);
    expect(firstArg(h.listBoardMissionsByStatus)).toBe(commandBoard);
  });

  it('transitions the SAME board /mission done transitions', async () => {
    await drive('/mission done abc12345');
    const commandBoard = firstArg(h.setBoardMissionStatus);

    vi.clearAllMocks();
    const ctx = await toolCtx();
    await tools.invoke('update_mission', { mission_id: 'abc12345', status: 'done' }, ctx as never);
    expect(firstArg(h.setBoardMissionStatus)).toBe(commandBoard);
  });

  it('creates on the SAME board /mission new creates on', async () => {
    await drive('/mission new ask @research about it');
    const commandOwner = (firstArg(h.createBoardMission) as { ownerAgent: string }).ownerAgent;

    vi.clearAllMocks();
    const ctx = await toolCtx();
    // No explicit `owner`, so this runs the auto-assign path — whose failure
    // fallback is "the agent in the room", the one place create_mission names a
    // board rather than being handed one. (`converseTurn` is a bare stub here,
    // so the Haiku call throws and the fallback is what runs.)
    await tools.invoke('create_mission', { title: 'ask about it', body: 'ask about it' }, ctx as never);
    expect((firstArg(h.createBoardMission) as { ownerAgent: string }).ownerAgent).toBe(commandOwner);
  });
});
