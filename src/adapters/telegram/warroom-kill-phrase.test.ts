/**
 * Telegram War Room entry point.
 *
 * A message arriving while a room is active is diverted to the room instead of
 * the chat turn, so it never reaches the `origin: 'human_chat'` call site. This
 * drives the real webhook and the real `haltWarroomOnKillPhrase` ->
 * `engageEmergencyHalt` path, with only the panic store, the Telegram API and
 * the transcript writes stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  tryAcquirePanic: vi.fn(),
  writeAudit: vi.fn(async (_row: { action?: string }) => {}),
  sendMessage: vi.fn(async () => ({ ok: true, messageId: 1 })),
  publishTurn: vi.fn(async (_m: string, _s: string, _t: string, content: string) => ({
    meetingId: 'm1',
    seq: 7,
    speaker: 'system',
    type: 'system',
    content,
    ts: '2026-08-21T00:00:00.000Z',
  })),
  emit: vi.fn(),
  getMeeting: vi.fn(),
  orchestrateWarroomTurn: vi.fn(async () => {}),
  getSession: vi.fn(),
}));

vi.mock('./send.js', () => ({
  sendMessage: h.sendMessage,
  sendChatAction: vi.fn(async () => {}),
  editMessage: vi.fn(async () => {}),
  sendVoice: vi.fn(async () => {}),
  sendPhoto: vi.fn(async () => {}),
  knownAgents: () => [],
}));
vi.mock('./verify.js', () => ({ verifyTelegramSecret: () => true }));
vi.mock('../../lib/warroom/meetings-repo.js', () => ({ getMeeting: h.getMeeting }));
vi.mock('../../lib/warroom/publisher.js', () => ({ publishTurn: h.publishTurn }));
vi.mock('../../lib/warroom/events.js', () => ({ getChannel: () => ({ emit: h.emit }) }));
vi.mock('../../lib/warroom/orchestrator.js', () => ({
  orchestrateWarroomTurn: h.orchestrateWarroomTurn,
}));
vi.mock('../../lib/state/sessions-repo.js', () => ({
  getSession: h.getSession,
  appendTurns: vi.fn(async () => {}),
}));
vi.mock('../../agent/commands.js', () => ({ runCommand: vi.fn(async () => null) }));
vi.mock('../../agent/picker.js', () => ({ pickAgent: () => ({ agentId: 'main', cleanText: '' }) }));
vi.mock('../../lib/identity/owner-alias.js', () => ({ resolveOwnerChatId: () => undefined }));
vi.mock('../../lib/state/identities-repo.js', () => ({ resolveCanonical: vi.fn(async () => null) }));
vi.mock('../../lib/audit/audit-writer.js', () => ({ writeAudit: h.writeAudit }));
// agent-loop leaves: the REAL engageEmergencyHalt runs, its store does not.
vi.mock('../../lib/state/panic-state-repo.js', () => ({ tryAcquirePanic: h.tryAcquirePanic }));

import { buildTelegramRouter } from './handler.js';

const PHRASE = 'STOP-firm-sentry-3a2f';

/**
 * The webhook acks first and processes the message fire-and-forget, so wait for
 * the reply rather than for the response — the reply IS the observable.
 */
async function send(text: string): Promise<void> {
  const replied = new Promise<void>((resolve) => {
    h.sendMessage.mockImplementation(async () => {
      resolve();
      return { ok: true, messageId: 1 };
    });
  });
  await buildTelegramRouter().request('/main/webhook', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 's', 'content-type': 'application/json' },
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
  await replied;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EMERGENCY_KILL_PHRASE = PHRASE;
  process.env.TELEGRAM_WEBHOOK_SECRET = 's';
  h.getSession.mockResolvedValue({ turns: [], activeWarroomId: 'm1' });
  h.getMeeting.mockResolvedValue({ meetingId: 'm1', status: 'active', participants: ['main'] });
  h.tryAcquirePanic.mockResolvedValue({ acquired: true, state: { active: true, generation: 1 } });
});

afterEach(() => {
  delete process.env.EMERGENCY_KILL_PHRASE;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

describe('telegram War Room: a person typing the phrase halts the fleet', () => {
  it('halts, replies with the confirmation, and never runs the room turn', async () => {
    await send(`ok that is enough ${PHRASE}`);
    expect(h.tryAcquirePanic).toHaveBeenCalledWith(
      'emergency kill phrase received',
      'telegram:warroom:m1',
    );
    expect(h.sendMessage).toHaveBeenCalledWith(
      'main',
      '42',
      expect.stringContaining('EMERGENCY HALT engaged'),
      expect.anything(),
    );
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'emergency_kill_phrase', result: 'blocked' }),
    );
    // Not fanned out to the agents, and not published as a user turn — so the
    // phrase never reaches a later round's transcript.
    expect(h.orchestrateWarroomTurn).not.toHaveBeenCalled();
    expect(h.publishTurn.mock.calls.filter((c) => c[2] === 'user')).toEqual([]);
  });

  it('leaves an ordinary room message on the normal path', async () => {
    h.publishTurn.mockResolvedValueOnce({
      meetingId: 'm1',
      seq: 3,
      speaker: '99',
      type: 'user',
      content: 'what is the rollback plan?',
      ts: '2026-08-21T00:00:00.000Z',
    });
    const orchestrated = new Promise<void>((resolve) => {
      h.orchestrateWarroomTurn.mockImplementation(async () => {
        resolve();
      });
    });
    await buildTelegramRouter().request('/main/webhook', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 's', 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 2,
        message: {
          message_id: 11,
          date: 1755734400,
          chat: { id: 42 },
          from: { id: 99, is_bot: false },
          text: 'what is the rollback plan?',
        },
      }),
    });
    await orchestrated;
    expect(h.tryAcquirePanic).not.toHaveBeenCalled();
    expect(h.publishTurn).toHaveBeenCalledWith('m1', '99', 'user', 'what is the rollback plan?');
  });
});
