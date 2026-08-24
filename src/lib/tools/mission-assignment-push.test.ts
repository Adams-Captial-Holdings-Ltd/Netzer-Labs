/**
 * THE ASSIGNMENT PUSH (A3-12) — the half of assignment that was pull-only.
 *
 * `create_mission` has always dropped a note in the owner's INBOX, which nobody
 * reads until the owner's next turn. This is the push: the same fact posted
 * into the chat the handoff happened in, from ONE emission site, through the
 * shared pure formatter, over the one push primitive.
 *
 * WHAT THIS FILE ASSERTS THAT A PURE TEST CANNOT. `format.test.ts` pins the
 * words and scans that the emission site is unique; only a behavioural test can
 * show that the SAME words come out on Telegram and on BOTH Slack send paths,
 * that the dashboard gets nothing, and that a dead surface cannot fail a
 * mission that was already created. The two outbound modules are the only
 * mocks — the formatter and the push router are the real ones, because a test
 * that mocked those would be asserting its own doubles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mission } from '../state/mission-tasks-repo.js';

// Typed with their real parameter lists so `mock.calls[n][i]` is checked: the
// point of these assertions is WHICH argument carries the copy.
const { telegramMock, slackMock, createMock, interAgentMock, credsMock } = vi.hoisted(() => ({
  credsMock: vi.fn((agentId: string) =>
    Promise.resolve(
      agentId === 'research'
        ? { botToken: 'xoxb-RESEARCH-APP', signingSecret: 's' }
        : undefined,
    ),
  ),
  telegramMock: vi.fn(
    (_agentId: string, _chatId: string, _text: string, _opts?: unknown) =>
      Promise.resolve({ ok: true }),
  ),
  slackMock: vi.fn((_channel: string, _text: string, _opts?: unknown) =>
    Promise.resolve({ ok: true }),
  ),
  createMock: vi.fn(),
  interAgentMock: vi.fn((_args: Record<string, unknown>) => Promise.resolve({})),
}));

vi.mock('../../adapters/telegram/send.js', () => ({ sendMessage: telegramMock }));
vi.mock('../../adapters/slack/send.js', () => ({ postMessage: slackMock }));
// The per-agent Slack apps' credential store. Only the `app-` id shape reaches
// it; a main-bot id never asks, which is itself asserted below.
vi.mock('../../adapters/slack/multi-agent.js', () => ({
  getSlackAgentCredsAsync: credsMock,
}));
vi.mock('../missions/mission-acl.js', () => ({
  createBoardMission: createMock,
  listBoardMissions: vi.fn(() => Promise.resolve([])),
  listBoardMissionsByStatus: vi.fn(() => Promise.resolve([])),
  setBoardMissionStatus: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../state/inter-agent-tasks-repo.js', () => ({ sendInterAgent: interAgentMock }));
vi.mock('../config/agent-loader.js', () => ({
  listKnownAgents: () => ['main', 'ops', 'research'],
  loadAgent: vi.fn(() => Promise.resolve({ id: 'ops', role: 'operations' })),
}));

import './mission-tools.js';
import { tools } from './registry.js';

const MISSION: Mission = {
  id: 'abc12345-1111-4111-8111-111111111111',
  ownerAgent: 'ops',
  createdByAgent: 'research',
  createdByChat: 'owner:emmanuel',
  title: 'Ship the reconciler',
  body: 'With a watermark overlap.',
  priority: 80,
  status: 'open',
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
};

/** The exact sentence formatAssignmentPush produces for MISSION. */
const EXPECTED = 'Mission [abc12345] "Ship the reconciler" assigned to ops by research (P80).';

const ARGS = { title: 'Ship the reconciler', body: 'With a watermark overlap.', owner: 'ops' };

async function create(ctx: Record<string, unknown>) {
  return tools.invoke('create_mission', ARGS, {
    agentId: 'research',
    chatId: 'owner:emmanuel',
    ...ctx,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue(MISSION);
});

describe('the same sentence reaches every surface that has a chat to push into', () => {
  it('Telegram: a bare chat id goes to sendMessage', async () => {
    await create({ replyChatId: '12345678', surface: 'telegram' });
    expect(telegramMock).toHaveBeenCalledTimes(1);
    expect(telegramMock.mock.calls[0][2]).toBe(EXPECTED);
    expect(slackMock).not.toHaveBeenCalled();
  });

  it('Telegram PER-AGENT BOT posts as THAT BOT, not as the turn agent', async () => {
    // THE OTHER FORGOTTEN PATH, and the same defect as the per-agent Slack app
    // one surface over: Telegram runs a bot per agent (`/tg/:agentId/webhook`)
    // and `sendMessage(agentId, …)` picks the token by agent id. The turn agent
    // is NOT that bot — the sticky default answers as `main` inside the
    // research bot's chat, which is the executed chain this pins — so a push
    // built from a bare chat id went out over TOKEN-MAIN and Telegram answered
    // 403. The FIRST argument is the assertion: it is what selects the token.
    // `delivery.telegram-identity.test.ts` makes the same point on the wire.
    await tools.invoke(
      'create_mission',
      ARGS,
      {
        agentId: 'main',
        chatId: 'owner:emmanuel',
        replyChatId: '42:bot-research',
        surface: 'telegram',
      } as never,
    );
    expect(telegramMock).toHaveBeenCalledTimes(1);
    expect(telegramMock.mock.calls[0][0]).toBe('research');
    // And the identity segment is routing metadata, never part of the chat id.
    expect(telegramMock.mock.calls[0][1]).toBe('42');
    // Same sentence, same formatter; only the author changed with the turn.
    expect(telegramMock.mock.calls[0][2]).toBe(EXPECTED.replace('by research', 'by main'));
  });

  it('Slack MAIN BOT: slack:<channel> goes to postMessage', async () => {
    await create({ replyChatId: 'slack:C0MAIN', surface: 'slack' });
    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(slackMock.mock.calls[0][0]).toBe('C0MAIN');
    expect(slackMock.mock.calls[0][1]).toBe(EXPECTED);
  });

  it('Slack MAIN BOT asks for no per-agent token, so the workspace one is used', async () => {
    // The absence is the assertion: `postMessage` falls back to
    // process.env.SLACK_BOT_TOKEN when `tokenOverride` is absent, which is
    // correct HERE and wrong on the path below.
    await create({ replyChatId: 'slack:C0MAIN', surface: 'slack' });
    expect(credsMock).not.toHaveBeenCalled();
    expect(slackMock.mock.calls[0][2]).toEqual({});
  });

  it('Slack PER-AGENT APP posts as THAT APP, not as the main bot', async () => {
    // THE FORGOTTEN PATH, and the previous round's test for it could not fail.
    // It varied only `threadTs` — and BOTH Slack send paths build replyChatId
    // from the same channel/thread expression, so a threaded id proves nothing
    // about which app is speaking. It is the TOKEN that differs: everything the
    // per-agent handler sends carries `tokenOverride: creds.botToken`, and a
    // push built from a channel-only id carried none, so the notice arrived
    // from the MAIN bot — or, when the main bot is not in that channel, from
    // nobody, with a warn line as the only trace. The id now records the app.
    await create({
      replyChatId: 'slack:C0AGENT:app-research:1712345678.000100',
      surface: 'slack',
    });
    expect(credsMock).toHaveBeenCalledWith('research');
    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(slackMock.mock.calls[0][0]).toBe('C0AGENT');
    expect(slackMock.mock.calls[0][1]).toBe(EXPECTED);
    expect(slackMock.mock.calls[0][2]).toEqual({
      threadTs: '1712345678.000100',
      tokenOverride: 'xoxb-RESEARCH-APP',
    });
  });

  it('and falls back to the workspace token rather than dropping the push when the app is gone', async () => {
    // A deleted per-agent app, or a DDB read that failed: a message from the
    // wrong bot still beats a message nobody sent.
    credsMock.mockResolvedValueOnce(undefined);
    await create({ replyChatId: 'slack:C0AGENT:app-ghost', surface: 'slack' });
    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(slackMock.mock.calls[0][1]).toBe(EXPECTED);
    expect(slackMock.mock.calls[0][2]).toEqual({});
  });

  it('the copy is byte-identical across all three, because there is one formatter', async () => {
    // The regression this guards is the one A3 exists for: three surfaces each
    // assembling their own string. There is no seam here to assemble in — the
    // adapters never see a Mission.
    await create({ replyChatId: '12345678' });
    await create({ replyChatId: 'slack:C0MAIN' });
    await create({ replyChatId: 'slack:C0AGENT:app-research:1712345678.000100' });
    const sent = [
      telegramMock.mock.calls[0][2],
      slackMock.mock.calls[0][1],
      slackMock.mock.calls[1][1],
    ];
    expect(new Set(sent).size).toBe(1);
  });
});

describe('the marked parity gap', () => {
  it('the DASHBOARD gets no push, and nothing pretends it did', async () => {
    // Not an oversight: the dashboard handler passes no replyChatId at all, and
    // deliverToReplyChat answers false for dashboard:/system:/delegation: ids.
    // The comment at the call site names CLAUDE.md, the missing primitive and
    // the fallback; format.test.ts asserts that comment exists.
    await create({ surface: 'dashboard' });
    await create({ replyChatId: 'dashboard:sess-1', surface: 'dashboard' });
    expect(telegramMock).not.toHaveBeenCalled();
    expect(slackMock).not.toHaveBeenCalled();
  });
});

describe('the push is additive, never load-bearing', () => {
  it('a dead surface does not fail a mission that was already created', async () => {
    // The swallowing catch, and why it is not empty: at this point the mission
    // EXISTS. Turning a successful create into `isError: true` because Slack
    // 500d would make the model retry and open a second mission.
    slackMock.mockRejectedValueOnce(new Error('slack 503'));
    const out = await create({ replyChatId: 'slack:C0MAIN' });
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain('Mission abc12345 created');
  });

  it('but an undelivered push is NEVER reported as a delivered one', async () => {
    // The half that made the wrong-bot defect invisible: the surfaces report a
    // 403 or a `not_in_channel` by RETURNING `{ ok: false }`, not by throwing,
    // and the result used to be discarded — so the receipt the model relays to
    // the room said the same thing whether the notice arrived or not.
    // `{ ok: false }` is how postMessage reports `not_in_channel` — the exact
    // shape a per-agent app that was never invited to the channel comes back
    // with, and the shape sendMessage answers a 403 with.
    slackMock.mockResolvedValueOnce({ ok: false });
    const out = await create({ replyChatId: 'slack:C0MAIN' });
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain('Mission abc12345 created');
    expect(out.text).toContain('This chat was not notified; ops still has it in their inbox.');
  });

  it('and says nothing about delivery when the push did arrive', async () => {
    const out = await create({ replyChatId: 'slack:C0MAIN' });
    expect(out.text).not.toContain('not notified');
  });

  it('a thrown surface is undelivered too, not silently fine', async () => {
    slackMock.mockRejectedValueOnce(new Error('slack 503'));
    const out = await create({ replyChatId: 'slack:C0MAIN' });
    expect(out.text).toContain('This chat was not notified');
  });

  it('does NOT replace the inbox note — assignment is push AND pull', async () => {
    // The push reaches the ROOM; the inbox note reaches the OWNER on its next
    // turn. Dropping either one loses a different reader.
    await create({ replyChatId: 'slack:C0MAIN' });
    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(interAgentMock).toHaveBeenCalledTimes(1);
    expect(interAgentMock.mock.calls[0][0]).toMatchObject({ toAgent: 'ops' });
  });

  it('stays silent when the mission is assigned to the agent already in the room', async () => {
    // Same guard the inbox note has used since it shipped. Announcing "assigned
    // to research by research" to the chat that just asked for it is noise.
    createMock.mockResolvedValue({ ...MISSION, ownerAgent: 'research' });
    await tools.invoke(
      'create_mission',
      { ...ARGS, owner: 'research' },
      { agentId: 'research', chatId: 'owner:emmanuel', replyChatId: 'slack:C0MAIN' } as never,
    );
    expect(slackMock).not.toHaveBeenCalled();
    expect(interAgentMock).not.toHaveBeenCalled();
  });
});
