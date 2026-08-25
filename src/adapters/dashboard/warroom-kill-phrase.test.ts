/**
 * Dashboard War Room entry point: POST /:id/turn.
 *
 * Proves the halt happens HERE, on the raw body the person typed, before the
 * message becomes a transcript line — driving the real router and the real
 * `haltWarroomOnKillPhrase` -> `engageEmergencyHalt` path, with only the panic
 * store and the transcript writes stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  tryAcquirePanic: vi.fn(),
  writeAudit: vi.fn(async (_row: { action?: string }) => {}),
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
}));

vi.mock('../../lib/warroom/meetings-repo.js', () => ({
  getMeeting: h.getMeeting,
  createMeeting: vi.fn(),
  endMeeting: vi.fn(),
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
  listMyMeetings: vi.fn(),
  deleteMeeting: vi.fn(),
}));
vi.mock('../../lib/warroom/publisher.js', () => ({
  publishTurn: h.publishTurn,
  getHistory: vi.fn(async () => []),
}));
vi.mock('../../lib/warroom/events.js', () => ({
  getChannel: () => ({ emit: h.emit, latestSeq: 0, since: () => [], subscribe: () => () => {} }),
  removeChannel: vi.fn(),
}));
vi.mock('../../lib/warroom/orchestrator.js', () => ({
  orchestrateWarroomTurn: h.orchestrateWarroomTurn,
}));
vi.mock('../../lib/state/kill-switches-repo.js', () => ({
  isKillSwitchActive: vi.fn(async () => ({ active: false })),
  KillSwitchActiveError: class extends Error {},
}));
vi.mock('../../lib/audit/audit-writer.js', () => ({ writeAudit: h.writeAudit }));
vi.mock('../../lib/auth/dashboard-auth.js', () => ({
  authenticateDashboardToken: vi.fn(async () => ({ label: 'Root token' })),
  extractBearerToken: (a?: string) => a?.replace('Bearer ', ''),
  principalHasCapability: () => true,
  profileIdForPrincipal: () => 'owner',
}));
vi.mock('../../lib/state/ddb.js', () => ({ ddb: () => ({ send: vi.fn() }) }));
// agent-loop leaves: the REAL engageEmergencyHalt runs, its store does not.
vi.mock('../../lib/state/panic-state-repo.js', () => ({ tryAcquirePanic: h.tryAcquirePanic }));

import { buildWarroomRouter } from './warroom.js';

const PHRASE = 'STOP-firm-sentry-3a2f';

const post = (content: string) =>
  buildWarroomRouter().request('/m1/turn', {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify({ speaker: 'dashboard', content }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EMERGENCY_KILL_PHRASE = PHRASE;
  h.getMeeting.mockResolvedValue({ meetingId: 'm1', status: 'active', participants: ['main'] });
  h.tryAcquirePanic.mockResolvedValue({ acquired: true, state: { active: true, generation: 1 } });
});

afterEach(() => {
  delete process.env.EMERGENCY_KILL_PHRASE;
});

describe('dashboard War Room: a person typing the phrase halts the fleet', () => {
  it('halts, tells the person, and never runs the room turn', async () => {
    const res = await post(`ok that is enough ${PHRASE}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      halted: true,
      text: expect.stringContaining('EMERGENCY HALT engaged'),
    });
    expect(h.tryAcquirePanic).toHaveBeenCalledWith(
      'emergency kill phrase received',
      'dashboard:warroom:m1',
    );
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'emergency_kill_phrase', result: 'blocked' }),
    );
    // Not fanned out to the agents, and not published as a user turn — so the
    // phrase never reaches a later round's transcript.
    expect(h.orchestrateWarroomTurn).not.toHaveBeenCalled();
    expect(h.publishTurn.mock.calls.filter((c) => c[2] === 'user')).toEqual([]);
  });

  it('shows the confirmation in the transcript the SSE client renders', async () => {
    await post(PHRASE);
    expect(h.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system_note',
        text: expect.stringContaining('EMERGENCY HALT engaged'),
      }),
    );
  });

  it('leaves an ordinary message on the normal path', async () => {
    const res = await post('what is the rollback plan?');
    expect(res.status).toBe(200);
    expect(h.tryAcquirePanic).not.toHaveBeenCalled();
    expect(h.publishTurn).toHaveBeenCalledWith(
      'm1',
      'dashboard',
      'user',
      'what is the rollback plan?',
    );
    expect(h.orchestrateWarroomTurn).toHaveBeenCalled();
  });
});
