/**
 * The emergency kill phrase inside a War Room.
 *
 * The regression this pins: when a room is active, both entry points divert the
 * person's message into `orchestrateWarroomTurn`, which calls `runAgentTurn`
 * with a multi-speaker TRANSCRIPT and no `origin` — machine text. So the origin
 * gate, which correctly closed the Paperclip dispatch hole, also silenced the
 * phrase for a HUMAN typing it into a room on Telegram and the dashboard.
 *
 * The fix checks the human's RAW message at the entry points, before it is ever
 * published as a transcript line. This file covers the shared decision and the
 * two things that must NOT happen (an agent halting the fleet; a stale line
 * re-halting on a later round). The per-surface wiring — that each entry point
 * actually calls this before publishTurn and renders the confirmation — is
 * proven against the real adapters in:
 *   src/adapters/telegram/warroom-kill-phrase.test.ts
 *   src/adapters/dashboard/warroom-kill-phrase.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  tryAcquirePanic: vi.fn(),
  writeAudit: vi.fn(async (_row: { action?: string }) => {}),
  publishTurn: vi.fn(async (_m: string, _s: string, _t: string, content: string) => ({
    seq: 7,
    content,
  })),
  emit: vi.fn(),
  getMeeting: vi.fn(),
  getHistory: vi.fn(async () => [] as unknown[]),
  isKillSwitchActive: vi.fn(async () => ({ active: false })),
  converseStreamTurn: vi.fn(),
}));

// --- warroom deps -----------------------------------------------------------
vi.mock('./publisher.js', () => ({ publishTurn: h.publishTurn, getHistory: h.getHistory }));
vi.mock('./events.js', () => ({ getChannel: () => ({ emit: h.emit }) }));
vi.mock('./meetings-repo.js', () => ({ getMeeting: h.getMeeting }));

// --- agent-loop deps: the REAL loop runs, only its leaves are stubbed --------
vi.mock('../state/panic-state-repo.js', () => ({ tryAcquirePanic: h.tryAcquirePanic }));
vi.mock('../audit/audit-writer.js', () => ({ writeAudit: h.writeAudit }));
vi.mock('../bedrock/client.js', () => ({
  bedrockClient: () => ({}),
  converseStreamTurn: h.converseStreamTurn,
  modelRejectsTemperature: () => false,
}));
vi.mock('../tools/registry.js', () => ({ tools: { listFor: () => [], invoke: vi.fn() } }));
vi.mock('../state/kill-switches-repo.js', () => ({
  isKillSwitchActive: h.isKillSwitchActive,
  KillSwitchActiveError: class extends Error {},
}));
vi.mock('../memory/context-builder.js', () => ({ buildMemoryContext: vi.fn(async () => '') }));
vi.mock('../state/inter-agent-tasks-repo.js', () => ({
  listInbox: vi.fn(async () => []),
  markStatus: vi.fn(),
}));
vi.mock('../state/hive-mind-repo.js', () => ({ recentHive: vi.fn(async () => []) }));
vi.mock('../usage/token-tracker.js', () => ({
  recordUsage: vi.fn(),
  getDailyCostUsd: vi.fn(async () => 0),
  SpendIndeterminateError: class extends Error {},
}));
vi.mock('../state/cost-cap-repo.js', () => ({
  getEffectiveCostCap: vi.fn(async () => 50),
  isCostCapEnforced: vi.fn(async () => false),
}));
vi.mock('../state/rate-limits-repo.js', () => ({
  checkAndConsume: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../safety/exfil-guard.js', () => ({
  scanForExfil: vi.fn(async () => ({ matches: [] })),
  redactMatches: (t: string) => t,
  getActivePatterns: vi.fn(async () => []),
  buildStreamingRedactor: vi.fn(async () => (t: string) => t),
}));
vi.mock('../config/agent-loader.js', () => ({ loadAgent: vi.fn() }));
vi.mock('../state/runtime-config-repo.js', () => ({ getConfig: vi.fn(async () => undefined) }));
vi.mock('../cost/ledger-gate.js', () => ({
  admitTurnSpend: vi.fn(async () => ({
    admitted: true,
    finalize: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  })),
}));

import { haltWarroomOnKillPhrase } from './kill-phrase.js';
import { orchestrateWarroomTurn } from './orchestrator.js';

const PHRASE = 'STOP-firm-sentry-3a2f';
const ROOM = {
  meetingId: 'm1',
  status: 'active',
  title: 'Incident',
  participants: ['main'],
};

const turn = (type: 'user' | 'agent', speaker: string, content: string, seq: number) => ({
  meetingId: 'm1',
  seq,
  speaker,
  type,
  content,
  ts: `2026-08-21T00:00:0${seq}.000Z`,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EMERGENCY_KILL_PHRASE = PHRASE;
  h.getMeeting.mockResolvedValue(ROOM);
  h.getHistory.mockResolvedValue([]);
  h.isKillSwitchActive.mockResolvedValue({ active: false });
  h.tryAcquirePanic.mockResolvedValue({ acquired: true, state: { active: true, generation: 1 } });
});

afterEach(() => {
  delete process.env.EMERGENCY_KILL_PHRASE;
});

describe('a human typing the phrase into an active War Room still halts the fleet', () => {
  it('engages the same panic freeze and returns the same confirmation as chat', async () => {
    const text = await haltWarroomOnKillPhrase({
      meetingId: 'm1',
      rawText: `ok that is enough ${PHRASE}`,
      surface: 'telegram',
    });
    expect(h.tryAcquirePanic).toHaveBeenCalledWith(
      'emergency kill phrase received',
      'telegram:warroom:m1',
    );
    // Byte-for-byte the copy runAgentTurn gives a chat surface — both call
    // engageEmergencyHalt, which is the point of putting it there.
    expect(text).toBe(
      'EMERGENCY HALT engaged. Every kill switch is on and new agent turns are frozen. Restore from the dashboard panic/kill-switch controls when you are ready.',
    );
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'emergency_kill_phrase', result: 'blocked' }),
    );
  });

  it('names the surface it came from, so the two entry points are distinguishable', async () => {
    await haltWarroomOnKillPhrase({ meetingId: 'm1', rawText: PHRASE, surface: 'dashboard' });
    expect(h.tryAcquirePanic).toHaveBeenCalledWith(
      'emergency kill phrase received',
      'dashboard:warroom:m1',
    );
  });

  it('records the confirmation on the transcript and the meeting channel', async () => {
    await haltWarroomOnKillPhrase({ meetingId: 'm1', rawText: PHRASE, surface: 'dashboard' });
    expect(h.publishTurn).toHaveBeenCalledWith(
      'm1',
      'system',
      'system',
      expect.stringContaining('EMERGENCY HALT engaged'),
    );
    expect(h.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system_note', seq: 7 }),
    );
  });

  it('confirms honestly when the halt is already engaged, or could not be engaged', async () => {
    h.tryAcquirePanic.mockResolvedValueOnce({
      acquired: false,
      state: { active: true, generation: 2 },
    });
    expect(
      await haltWarroomOnKillPhrase({ meetingId: 'm1', rawText: PHRASE, surface: 'telegram' }),
    ).toContain('already engaged');

    h.tryAcquirePanic.mockRejectedValueOnce(new Error('ddb down'));
    expect(
      await haltWarroomOnKillPhrase({ meetingId: 'm1', rawText: PHRASE, surface: 'telegram' }),
    ).toContain('could NOT be engaged');
  });

  it('still returns the confirmation when the transcript write fails', async () => {
    h.publishTurn.mockRejectedValueOnce(new Error('ddb down'));
    const text = await haltWarroomOnKillPhrase({
      meetingId: 'm1',
      rawText: PHRASE,
      surface: 'dashboard',
    });
    expect(text).toContain('EMERGENCY HALT engaged');
  });

  it('leaves ordinary room messages completely alone', async () => {
    expect(
      await haltWarroomOnKillPhrase({
        meetingId: 'm1',
        rawText: 'can we stop the deploy for a second?',
        surface: 'telegram',
      }),
    ).toBeNull();
    expect(h.tryAcquirePanic).not.toHaveBeenCalled();
    expect(h.publishTurn).not.toHaveBeenCalled();
  });

  it('is dormant when no phrase is configured', async () => {
    delete process.env.EMERGENCY_KILL_PHRASE;
    expect(
      await haltWarroomOnKillPhrase({ meetingId: 'm1', rawText: PHRASE, surface: 'telegram' }),
    ).toBeNull();
    expect(h.tryAcquirePanic).not.toHaveBeenCalled();
  });
});

/**
 * The trap in the obvious repair. `orchestrateWarroomTurn` sees an assembled
 * multi-speaker transcript, never a person's raw message, so the phrase must
 * NOT be honoured there. These run the real orchestrator against the real agent
 * loop, so what is being tested is the shipped gate and not a restatement of it.
 * The turn is allowed to fail further down (this file stubs the gate's leaves,
 * not a whole working Bedrock path) — the gate runs first, so "no panic, no
 * halt audit" is a claim about the gate and nothing else.
 */
describe('the assembled transcript can never halt the fleet', () => {
  it('an AGENT reply containing the phrase does not halt', async () => {
    h.getHistory.mockResolvedValue([
      turn('user', 'u1', 'what is the rollback plan?', 1),
      turn('agent', 'main', `you could always type ${PHRASE} to stop everything`, 2),
    ]);
    await orchestrateWarroomTurn({
      meetingId: 'm1',
      userTurnSeq: 3,
      userText: 'thanks, anything else?',
    });
    expect(h.tryAcquirePanic, 'an agent halted the fleet with its own words').not.toHaveBeenCalled();
    expect(h.writeAudit.mock.calls.map((c) => c[0].action)).not.toContain(
      'emergency_kill_phrase',
    );
  });

  it('a STALE human line does not re-halt on a later round', async () => {
    // A transcript that already carries the phrase from an earlier round. The
    // new message is innocent, so nothing may fire: the halt is driven by the
    // message just received, once, at the entry point.
    h.getHistory.mockResolvedValue([
      turn('user', 'u1', `enough ${PHRASE}`, 1),
      turn('agent', 'main', 'halting.', 2),
    ]);
    await orchestrateWarroomTurn({
      meetingId: 'm1',
      userTurnSeq: 3,
      userText: 'ok we are back, where were we?',
    });
    expect(h.tryAcquirePanic, 'a stale transcript line re-halted the fleet').not.toHaveBeenCalled();

    // And the entry point agrees: the new raw message is not the phrase.
    expect(
      await haltWarroomOnKillPhrase({
        meetingId: 'm1',
        rawText: 'ok we are back, where were we?',
        surface: 'dashboard',
      }),
    ).toBeNull();
    expect(h.tryAcquirePanic).not.toHaveBeenCalled();
  });

  it('halts exactly once for one phrase message, and never publishes it as a turn', async () => {
    // The raw message is checked BEFORE publishTurn, so the phrase never
    // becomes a transcript line — which is what makes a later re-halt
    // impossible by construction rather than by luck.
    await haltWarroomOnKillPhrase({
      meetingId: 'm1',
      rawText: `enough ${PHRASE}`,
      surface: 'telegram',
    });
    expect(h.tryAcquirePanic).toHaveBeenCalledTimes(1);
    const userTurns = h.publishTurn.mock.calls.filter((c) => c[2] === 'user');
    expect(userTurns, 'the phrase was written into the transcript').toEqual([]);
  });
});
