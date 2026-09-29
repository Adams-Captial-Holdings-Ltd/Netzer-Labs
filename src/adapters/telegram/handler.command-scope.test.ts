/**
 * WHICH BOT ANSWERED IS WHICH AGENT A COMMAND ACTS ON (CLAUDE.md, "chat surface
 * parity").
 *
 * The defect this pins was data corruption, not a rendering difference:
 * `/mission new …` typed at the RESEARCH bot reached
 * `createBoardMission({ownerAgent:'main'})`, so the mission landed on main's
 * board and `/mission done <id>` then transitioned main's rows. Slack's
 * per-agent app passes its own `agentId` to `runCommand` and got the identical
 * command right — same user, same bot identity, same words, two different
 * boards.
 *
 * So this drives the REAL webhook, with the REAL secret verification (a real
 * `x-telegram-bot-api-secret-token`, compared timing-safely by the real
 * `verifyTelegramSecret`), the REAL `pickAgent`, the REAL `runCommand` and the
 * REAL `missionCommand`, for BOTH bot routes, and compares what the Mission ACL
 * is handed. Only the ACL, the Telegram API and the agent loop are stubbed —
 * everything between the HTTP request and `createBoardMission` is production
 * code, because the bug lived in the wiring between them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  error: vi.fn(),
  sendMessage: vi.fn(
    async (): Promise<{ ok: boolean; messageId?: number; error?: string }> => ({
      ok: true,
      messageId: 1,
    }),
  ),
  editMessage: vi.fn(async () => ({ ok: true })),
  createBoardMission: vi.fn(),
  listBoardMissions: vi.fn(async () => []),
  listBoardMissionsByStatus: vi.fn(async () => []),
  setBoardMissionStatus: vi.fn(async () => true),
  getSession: vi.fn(),
  runAgentTurn: vi.fn(),
  clearSession: vi.fn(async () => {}),
  setWarroomMode: vi.fn(async () => {}),
  setModelOverride: vi.fn(async () => {}),
  updateAgent: vi.fn(async () => {}),
  createMeeting: vi.fn(async () => ({
    meetingId: 'room-1',
    title: 'War Room',
    status: 'active' as const,
  })),
  getMeeting: vi.fn(async () => null),
  publishTurn: vi.fn(async () => ({ seq: 1 })),
  orchestrateWarroomTurn: vi.fn(async () => {}),
}));

vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: h.error, debug: vi.fn() },
  truncateForLog: (s: string) => s,
}));
vi.mock('./send.js', () => ({
  sendMessage: h.sendMessage,
  editMessage: h.editMessage,
  sendChatAction: vi.fn(async () => {}),
  sendVoice: vi.fn(async () => {}),
  sendPhoto: vi.fn(async () => {}),
  knownAgents: () => ['main', 'research'],
}));
vi.mock('../../lib/missions/mission-acl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/missions/mission-acl.js')>();
  return {
    // The REAL module first, then the board FUNCTIONS as doubles. The ACL's
    // pure predicates are rules, not substrate: enumerating exports here left
    // `canReadBoard` undefined, and `list_missions` calls it before it reads
    // the board (`mission-tools.ts:408`), so the parity case below died with a
    // TypeError instead of proving which board the tool read.
    ...actual,
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
  setModelOverride: h.setModelOverride,
  setWarroomMode: h.setWarroomMode,
}));
vi.mock('../../lib/config/agent-loader.js', () => ({
  listKnownAgents: () => ['main', 'ops', 'research'],
  loadAgent: vi.fn(async (id: string) => ({ id, model: '', displayName: id })),
  invalidateAgentCache: vi.fn(),
}));
vi.mock('../../agent/agent-loop.js', () => ({ runAgentTurn: h.runAgentTurn }));
vi.mock('../../lib/state/agents-repo.js', () => ({ updateAgent: h.updateAgent, getAgent: vi.fn() }));
vi.mock('../../lib/config/invalidation-publisher.js', () => ({ publishInvalidation: vi.fn() }));
vi.mock('../../lib/warroom/meetings-repo.js', () => ({
  createMeeting: h.createMeeting,
  getMeeting: h.getMeeting,
  endMeeting: vi.fn(),
}));
vi.mock('../../lib/warroom/publisher.js', () => ({ publishTurn: h.publishTurn }));
vi.mock('../../lib/warroom/orchestrator.js', () => ({
  parseMentions: () => [],
  orchestrateWarroomTurn: h.orchestrateWarroomTurn,
}));
vi.mock('../../lib/warroom/kill-phrase.js', () => ({
  haltWarroomOnKillPhrase: vi.fn(async () => null),
}));
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

import { buildTelegramRouter } from './handler.js';
import '../../lib/tools/mission-tools.js'; // side-effect registration
import { tools } from '../../lib/tools/registry.js';

const SECRET = 'a-real-webhook-secret-token';

const MISSION = {
  id: 'abc12345-1111-4111-8111-111111111111',
  ownerAgent: 'research',
  createdByAgent: 'research',
  createdByChat: '42',
  title: 'Fix the reconciler',
  body: 'Fix the reconciler',
  priority: 'medium',
  status: 'open' as const,
  createdAt: '2026-08-21T10:00:00.000Z',
  updatedAt: '2026-08-21T10:00:00.000Z',
};

/**
 * Post to one bot's webhook and wait for the OBSERVABLE, not the response: the
 * route acks first and processes fire-and-forget.
 */
async function drive(
  botAgentId: string,
  text: string,
  waitFor: 'reply' | 'turn' | 'warroom' = 'reply',
): Promise<void> {
  const settled = new Promise<void>((resolve) => {
    if (waitFor === 'warroom') {
      // The war-room branch answers with neither a command reply nor an agent
      // turn — publishing the turn into the room IS the observable.
      h.publishTurn.mockImplementation(async () => {
        resolve();
        return { seq: 1 };
      });
    } else if (waitFor === 'reply') {
      // Wrap whatever the case configured rather than replacing it, so a test
      // can make the send FAIL and still be woken when it happens.
      const configured = h.sendMessage.getMockImplementation();
      h.sendMessage.mockImplementation(async () => {
        const out = configured ? await configured() : { ok: true, messageId: 1 };
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
  const res = await buildTelegramRouter().request(`/${botAgentId}/webhook`, {
    method: 'POST',
    headers: {
      'x-telegram-bot-api-secret-token': SECRET,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1755734400,
        chat: { id: 42 },
        from: { id: 99, is_bot: false },
        text,
      },
    }),
  });
  expect(res.status).toBe(200);
  await settled;
  // The observable resolves INSIDE the send; let the handler's continuation
  // (the `!sent.ok` check) run before the case asserts on it.
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  h.getSession.mockResolvedValue(null);
  h.createBoardMission.mockResolvedValue(MISSION);
  h.sendMessage.mockImplementation(async () => ({ ok: true, messageId: 1 }));
  h.runAgentTurn.mockResolvedValue({
    text: 'ok',
    modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
  });
});

afterEach(() => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

describe('telegram: a command acts on the bot that received it', () => {
  it('opens the mission on RESEARCH’s board when the research bot is driven', async () => {
    await drive('research', '/mission new Fix the reconciler');
    expect(h.createBoardMission).toHaveBeenCalledWith(
      expect.objectContaining({ ownerAgent: 'research', createdByAgent: 'research' }),
    );
  });

  it('opens the mission on MAIN’s board when the main bot is driven', async () => {
    await drive('main', '/mission new Fix the reconciler');
    expect(h.createBoardMission).toHaveBeenCalledWith(
      expect.objectContaining({ ownerAgent: 'main', createdByAgent: 'main' }),
    );
  });

  it('reads the board of the bot that was asked, not always main’s', async () => {
    await drive('research', '/missions');
    expect(h.listBoardMissionsByStatus).toHaveBeenCalledWith('research', 'open', 15);
  });

  it('transitions a row on the receiving bot’s board', async () => {
    await drive('research', '/mission done abc12345');
    expect(h.setBoardMissionStatus).toHaveBeenCalledWith('research', 'abc12345', 'done');
  });

  it('lets an EXPLICIT agent prefix out-rank the bot token it was typed at', async () => {
    // `/research /missions` at the main bot: the person named an agent, and a
    // person naming one beats the token that happened to carry the words.
    await drive('main', '/research /missions');
    expect(h.listBoardMissionsByStatus).toHaveBeenCalledWith('research', 'open', 15);
  });

  it('lets an EXPLICIT @mention out-rank the bot token too', async () => {
    await drive('main', '@ops /missions');
    expect(h.listBoardMissionsByStatus).toHaveBeenCalledWith('ops', 'open', 15);
  });

  it('keeps the wrong-board fix when the reply cannot be delivered at all', async () => {
    // The scope must not be a property of the happy path.
    h.sendMessage.mockResolvedValue({ ok: false, error: 'Bad Request: chat not found' });
    await drive('research', '/mission new Fix the reconciler');
    expect(h.createBoardMission).toHaveBeenCalledWith(
      expect.objectContaining({ ownerAgent: 'research' }),
    );
  });

  it('leaves ordinary chat’s session stickiness exactly where it was', async () => {
    // THE SCOPED HALF OF THE FIX, pinned so it cannot drift into the other
    // half. The `getSession('main', chatId)` sticky source and `pickAgent`'s
    // `'main'` default are pre-existing behaviour: on any bot, a non-command
    // message still runs the turn the picker chose. Only the COMMAND scope
    // moved to the bot identity; changing this line would change which history
    // every existing Telegram conversation resumes from.
    await drive('research', 'hello there', 'turn');
    expect(h.getSession).toHaveBeenCalledWith('main', '42');
    expect(h.runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'main', surface: 'telegram' }),
    );
  });

  it('and hands the turn a reply target that names the BOT, since the agent is not it', async () => {
    // The producer half of the out-of-band push identity (CLAUDE.md, "chat
    // surface parity" — Telegram runs one bot per agent just as Slack runs one
    // app per agent). This is the exact chain the wrong-token defect took: the
    // RESEARCH bot's webhook, a turn the sticky default answers as MAIN, and a
    // push built later from `replyChatId`. With a bare `42` the delivery layer
    // had only `main` to send over, so it called Telegram with the main bot's
    // token for a chat that bot cannot open — 403, or another conversation
    // entirely. Everything this handler sends itself still uses the bare id.
    await drive('research', 'hello there', 'turn');
    expect(h.runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'main', replyChatId: '42:bot-research' }),
    );
    expect(h.sendMessage).toHaveBeenCalledWith('research', '42', '…', expect.anything());
  });
});

/**
 * AND THE TOOLS ACT ON THE SAME BOARD THE COMMANDS DO — the half the command
 * fix left open, and the reason it is asserted HERE rather than in a tool test.
 *
 * Moving `/missions` to the receiving bot's board while `list_missions` stayed
 * on the turn agent's did not fix one board, it created two. In one chat on
 * `/tg/research/webhook`:
 *
 *     /missions      -> "1 Open mission for research: [abc12345] ..."
 *     list_missions  -> "No Open missions for main."
 *
 * The ref the board reply teaches the user to copy, refused by the agent
 * standing next to the board that printed it — and `create_mission` writing
 * where `/mission new` does not. Same class as the original defect: data
 * corruption, not a rendering difference.
 *
 * Each case therefore drives BOTH halves in one run and compares the board id
 * they were handed, rather than asserting a literal in each: a hardcoded pair
 * can drift apart while both stay green, and the property is that they are the
 * SAME, whatever it is. The ToolContext is built the way `agent-loop.ts` builds
 * it from an `AgentTurnRequest`, which is the one link this test double stands
 * in for.
 */
describe('telegram: the tools read the board the commands wrote to', () => {
  const ctxFor = (req: Record<string, unknown>): Record<string, unknown> => ({
    agentId: req.agentId,
    chatId: req.chatId,
    ...(req.replyChatId ? { replyChatId: req.replyChatId } : {}),
    ...(req.boardAgentId ? { boardAgentId: req.boardAgentId } : {}),
  });

  /** The `h.*` doubles are untyped `vi.fn()`s, so their calls need widening. */
  const firstArg = (m: { mock: { calls: unknown[] } }): never =>
    (m.mock.calls as unknown as unknown[][])[0][0] as never;

  /** Drive an ordinary turn on `bot` and return the ToolContext it produces. */
  async function toolCtx(bot: string): Promise<Record<string, unknown>> {
    await drive(bot, 'what is on my board', 'turn');
    return ctxFor(firstArg(h.runAgentTurn) as Record<string, unknown>);
  }

  it('answers list_missions from the SAME board /missions reads', async () => {
    await drive('research', '/missions');
    const commandBoard = firstArg(h.listBoardMissionsByStatus);
    expect(commandBoard).toBe('research');

    vi.clearAllMocks();
    const ctx = await toolCtx('research');
    // The sticky picker still answers as main — that is the whole trap.
    expect(ctx.agentId).toBe('main');
    await tools.invoke('list_missions', {}, ctx as never);
    expect(firstArg(h.listBoardMissionsByStatus)).toBe(commandBoard);
  });

  it('transitions the SAME board /mission done transitions', async () => {
    await drive('research', '/mission done abc12345');
    const commandBoard = firstArg(h.setBoardMissionStatus);

    vi.clearAllMocks();
    const ctx = await toolCtx('research');
    await tools.invoke(
      'update_mission',
      { mission_id: 'abc12345', status: 'done' },
      ctx as never,
    );
    expect(firstArg(h.setBoardMissionStatus)).toBe(commandBoard);
  });

  it('creates on the SAME board /mission new creates on', async () => {
    await drive('research', '/mission new Fix the reconciler');
    const commandOwner = (firstArg(h.createBoardMission) as { ownerAgent: string }).ownerAgent;

    vi.clearAllMocks();
    const ctx = await toolCtx('research');
    // No explicit `owner`, so this runs the auto-assign path — whose failure
    // fallback is "the agent in the room", the one place create_mission names a
    // board rather than being handed one. (`converseTurn` is a bare stub here,
    // so the Haiku call throws and the fallback is what runs.)
    await tools.invoke(
      'create_mission',
      { title: 'Fix the reconciler', body: 'Fix the reconciler' },
      ctx as never,
    );
    expect((firstArg(h.createBoardMission) as { ownerAgent: string }).ownerAgent).toBe(
      commandOwner,
    );
  });

  it('leaves a single-identity surface exactly where it was', async () => {
    // The main bot passes a boardAgentId that equals the turn agent, and every
    // surface with ONE identity per conversation (Slack per-agent, the
    // dashboard) passes none at all — where the tool must fall back to
    // `ctx.agentId`, which is the pre-existing behaviour this must not change.
    await tools.invoke('list_missions', {}, { agentId: 'ops', chatId: '42' } as never);
    expect(h.listBoardMissionsByStatus).toHaveBeenCalledWith('ops', 'open', 15);
  });
});

/**
 * AN `@agent` INSIDE A COMMAND'S PAYLOAD IS CONTENT, NOT ROUTING.
 *
 * The wrong-board bug had a second door, and it is the same door: the picker's
 * Rule 2 matches `@agent` ANYWHERE, so scoping a command on "the picker said
 * mention" re-opened exactly the corruption the scope fix closed — this time
 * triggered by the user's own prose. `/mission new` is the first command in
 * this repo whose argument is free-form, so `@main` in a title is now ordinary
 * English, and treating it as an address both moved the mission to the wrong
 * board AND deleted the word from what was stored.
 *
 * Two distinct assertions per case, because the defect had two halves: WHOSE
 * board, and WHAT was written on it.
 */
describe('telegram: an @agent inside a command payload does not steer the command', () => {
  it('opens “Ask @main to review the ACL” on RESEARCH’s board, title intact', async () => {
    await drive('research', '/mission new Ask @main to review the ACL');
    expect(h.createBoardMission).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerAgent: 'research',
        createdByAgent: 'research',
        title: 'Ask @main to review the ACL',
        body: 'Ask @main to review the ACL',
      }),
    );
  });

  it('refuses “/missions @main” as a bad status instead of reading main’s board', async () => {
    // `/missions` takes a STATUS. Once `@main` stops being routing it becomes
    // what it literally is — an argument that is not a status — and the honest
    // answer is to say so. What must never happen again is the old one: the
    // marker silently consumed as routing and MAIN'S board handed back to
    // someone who was talking to research.
    await drive('research', '/missions @main');
    expect(h.listBoardMissionsByStatus).not.toHaveBeenCalled();
    expect(h.listBoardMissions).not.toHaveBeenCalled();
    expect(h.sendMessage).toHaveBeenCalledWith(
      'research',
      expect.anything(),
      expect.stringContaining("Unknown status '@main'"),
      expect.anything(),
    );
  });

  it('transitions the RECEIVING bot’s row when the ref is followed by an @agent', async () => {
    await drive('research', '/mission done abc12345 @main');
    expect(h.setBoardMissionStatus).toHaveBeenCalledWith('research', 'abc12345 @main', 'done');
  });

  it('still lets a LEADING @agent address another bot, payload @agent and all', async () => {
    // The exception survives the narrowing: an addressee opens the message.
    await drive('research', '@ops /mission new Ask @main to review the ACL');
    expect(h.createBoardMission).toHaveBeenCalledWith(
      expect.objectContaining({ ownerAgent: 'ops', title: 'Ask @main to review the ACL' }),
    );
  });

  it('leaves ordinary chat’s handling of a mid-sentence @agent untouched', async () => {
    // THE SCOPED HALF, again. Narrowing applies to COMMAND routing only. A
    // non-command message that mentions an agent mid-sentence still routes to
    // the picker's choice with the marker stripped, exactly as before — that is
    // pre-existing chat behaviour and changing it is a different change.
    await drive('research', 'hey @ops can you look at this', 'turn');
    expect(h.runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'ops', userText: 'hey can you look at this' }),
    );
  });
});

/**
 * THE OTHER HALF OF THE SCOPE, AND THE REGRESSION THAT PROVED IT IS A DIFFERENT
 * HALF.
 *
 * Moving the BOARD scope to the bot identity is correct. Moving the SESSION
 * scope with it is not, and it is not a smaller mistake — it is the same class
 * of mistake pointed the other way. `/newchat`, `/reset`, `/status`,
 * `/context`, `/warroom`, `/endroom` and `/model` read and WRITE the session
 * and agent records the next ordinary message in the same conversation reads.
 * Scope them to the bot on a non-main Telegram bot and every one of them
 * reports success against a row nothing reads: "Conversation cleared." with the
 * history intact, `history: 0 turn(s)` on a live session, a war-room flag the
 * check below never looks at.
 *
 * So each case here drives the RESEARCH bot and asserts the id the command
 * touched is the SAME id ordinary chat touches on that bot — which the control
 * drive in each case establishes rather than assumes.
 */
describe('telegram: a session command acts on the session ordinary chat uses', () => {
  it('/newchat clears the session the next ordinary turn would write to', async () => {
    await drive('research', '/newchat');
    expect(h.clearSession).toHaveBeenCalledWith('main', '42');
    expect(h.clearSession).not.toHaveBeenCalledWith('research', '42');

    // The control: that same bot's ordinary turn runs as 'main'. Without this
    // line the assertion above is a hardcoded literal; with it, the two are
    // pinned to each other.
    vi.clearAllMocks();
    await drive('research', 'hello there', 'turn');
    expect(h.runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main' }));
  });

  it('/warroom arms the flag on the session the war-room check actually reads', async () => {
    await drive('research', '/warroom planning');
    // The trailing undefined is the conversation owner, which only the dashboard
    // passes (it alone checks who owns a conversation).
    expect(h.setWarroomMode).toHaveBeenCalledWith('main', '42', 'room-1', undefined);
    expect(h.setWarroomMode).not.toHaveBeenCalledWith('research', '42', 'room-1', undefined);

    // And the room really routes: with the flag on that session, the next
    // message on the same bot is published to the room instead of falling
    // through to an ordinary turn. This is the assertion the previous shape
    // failed — it armed 'research' while this reader is 'main', so the room
    // never engaged and left an orphaned active meeting behind.
    vi.clearAllMocks();
    h.getSession.mockResolvedValue({ turns: [], activeWarroomId: 'room-1' });
    h.getMeeting.mockResolvedValue({
      meetingId: 'room-1',
      title: 'War Room',
      status: 'active',
    } as never);
    await drive('research', 'what is the plan', 'warroom');
    expect(h.publishTurn).toHaveBeenCalledWith('room-1', '99', 'user', 'what is the plan');
    expect(h.runAgentTurn).not.toHaveBeenCalled();
  });

  it('/status reports the live session rather than an empty one', async () => {
    h.getSession.mockResolvedValue({ turns: [{ role: 'user', text: 'hi', ts: 1 }] });
    await drive('research', '/status');
    expect(h.getSession).toHaveBeenCalledWith('main', '42');
    expect(h.sendMessage).toHaveBeenCalledWith(
      'research',
      expect.anything(),
      expect.stringContaining('history: 1 turn(s)'),
      expect.anything(),
    );
  });

  it('/model edits the agent that will answer the next message', async () => {
    await drive('research', '/model reset');
    expect(h.updateAgent).toHaveBeenCalledWith('main', { model: undefined });
    expect(h.updateAgent).not.toHaveBeenCalledWith('research', expect.anything());
  });

  it('and the two scopes are live in ONE conversation, not one or the other', async () => {
    // The whole point: on the research bot, the same chat gets the board of
    // the bot it typed at AND the session its own chat uses. A fix that only
    // ever moved one id could not satisfy both of these in one run.
    await drive('research', '/mission new Fix the reconciler');
    expect(h.createBoardMission).toHaveBeenCalledWith(
      expect.objectContaining({ ownerAgent: 'research' }),
    );
    await drive('research', '/newchat');
    expect(h.clearSession).toHaveBeenCalledWith('main', '42');
  });
});

describe('the command reply’s send result is not discarded (A3-10)', () => {
  it('logs the undelivered reply at error level instead of dropping it', async () => {
    // The last link in the silent-loss chain. `sendMessage` now bounds on the
    // rendered length so an oversize board arrives — but if the send fails for
    // any other reason there is no second channel to apologise on, so the only
    // honest remedy left is to say so where an operator can see it. Before the
    // fix this call site ignored the result entirely and nothing, anywhere,
    // recorded that the user had been answered with silence.
    h.sendMessage.mockResolvedValue({ ok: false, error: 'Bad Request: chat not found' });
    await drive('research', '/missions');
    expect(h.error).toHaveBeenCalledWith(
      expect.objectContaining({
        boardAgentId: 'research',
        sessionAgentId: 'main',
        error: 'Bad Request: chat not found',
      }),
      'command reply undelivered; the user saw nothing',
    );
  });

  it('says nothing when the reply lands', async () => {
    await drive('research', '/missions');
    expect(h.error).not.toHaveBeenCalled();
  });
});
