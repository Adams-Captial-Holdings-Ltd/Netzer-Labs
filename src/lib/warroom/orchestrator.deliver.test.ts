import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every external dependency of the orchestrator so we can drive its
// responder-selection + deliver wiring deterministically, with no AWS/Bedrock.
// vi.hoisted ensures the spies exist before the hoisted vi.mock factories and
// the (ESM-hoisted) import of orchestrator.js run.
const h = vi.hoisted(() => {
  const state = { seq: 0 };
  return {
    state,
    getMeeting: vi.fn(),
    publishTurn: vi.fn(async (_m: string, _s: string, _t: string, content: string) => ({ seq: ++state.seq, content })),
    getHistory: vi.fn(async () => [] as unknown[]),
    emit: vi.fn(),
    isKillSwitchActive: vi.fn(async () => ({ active: false })),
    runAgentTurn: vi.fn(async (req: { agentId: string }) => ({
      text: `reply from ${req.agentId}`,
      modelId: 'm', costUsd: 0, latencyMs: 1, inputTokens: 1, outputTokens: 1, toolCallCount: 0,
    })),
  };
});

vi.mock('./meetings-repo.js', () => ({ getMeeting: h.getMeeting }));
vi.mock('./publisher.js', () => ({ publishTurn: h.publishTurn, getHistory: h.getHistory }));
vi.mock('./events.js', () => ({ getChannel: () => ({ emit: h.emit }) }));
vi.mock('../state/kill-switches-repo.js', () => ({ isKillSwitchActive: h.isKillSwitchActive }));
vi.mock('../../agent/agent-loop.js', () => ({
  runAgentTurn: h.runAgentTurn,
  KillSwitchActiveError: class KillSwitchActiveError extends Error {},
  CostCapExceededError: class CostCapExceededError extends Error {},
}));
vi.mock('../../observability/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { orchestrateWarroomTurn } from './orchestrator.js';

const ROOM = { meetingId: 'm1', status: 'active', title: 'Incident', participants: ['main', 'ops', 'research'] };
type Delivered = { kind: 'agent' | 'system'; agentId?: string; text: string };

describe('orchestrateWarroomTurn — delivery + @mention targeting (Telegram brain)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.seq = 0;
    h.getMeeting.mockResolvedValue(ROOM);
    h.getHistory.mockResolvedValue([]);
    h.isKillSwitchActive.mockResolvedValue({ active: false });
  });

  it('open message: every participant replies and is delivered, in order', async () => {
    const got: Delivered[] = [];
    await orchestrateWarroomTurn({ meetingId: 'm1', userTurnSeq: 1, userText: 'what should we check first?', deliver: (m) => { got.push(m as Delivered); } });
    const agents = got.filter((d) => d.kind === 'agent');
    expect(agents.map((d) => d.agentId)).toEqual(['main', 'ops', 'research']);
    expect(agents.map((d) => d.text)).toEqual(['reply from main', 'reply from ops', 'reply from research']);
    expect(h.runAgentTurn).toHaveBeenCalledTimes(3);
  });

  it('runs every room turn with the guardrail skipped (innocent prompts must not be blocked)', async () => {
    const got: Delivered[] = [];
    await orchestrateWarroomTurn({ meetingId: 'm1', userTurnSeq: 1, userText: 'Hey, I need your opinion, guys.', deliver: (m) => { got.push(m as Delivered); } });
    expect(h.runAgentTurn).toHaveBeenCalledTimes(3);
    for (const call of h.runAgentTurn.mock.calls) {
      expect((call[0] as { skipGuardrail?: boolean }).skipGuardrail).toBe(true);
    }
  });

  it('@mention: only the tagged agent runs and is delivered', async () => {
    const got: Delivered[] = [];
    await orchestrateWarroomTurn({ meetingId: 'm1', userTurnSeq: 1, userText: '@ops what is the rollback plan?', deliver: (m) => { got.push(m as Delivered); } });
    const agents = got.filter((d) => d.kind === 'agent');
    expect(agents.map((d) => d.agentId)).toEqual(['ops']);
    expect(h.runAgentTurn).toHaveBeenCalledTimes(1);
    expect((h.runAgentTurn.mock.calls[0][0] as { agentId: string }).agentId).toBe('ops');
  });

  it('multiple tags: only those agents run, in participant order', async () => {
    const got: Delivered[] = [];
    await orchestrateWarroomTurn({ meetingId: 'm1', userTurnSeq: 1, userText: '@research and @main please weigh in', deliver: (m) => { got.push(m as Delivered); } });
    expect(got.filter((d) => d.kind === 'agent').map((d) => d.agentId)).toEqual(['main', 'research']);
    expect(h.runAgentTurn).toHaveBeenCalledTimes(2);
  });

  it('empty room: delivers a system note and runs no agents', async () => {
    h.getMeeting.mockResolvedValue({ ...ROOM, participants: [] });
    const got: Delivered[] = [];
    await orchestrateWarroomTurn({ meetingId: 'm1', userTurnSeq: 1, userText: 'hello', deliver: (m) => { got.push(m as Delivered); } });
    expect(got.some((d) => d.kind === 'system')).toBe(true);
    expect(h.runAgentTurn).not.toHaveBeenCalled();
  });

  it('guardrail block: delivers a system note for the blocked agent, never its block text as a reply', async () => {
    // research's turn is blocked by the guardrail; main and ops answer normally.
    h.runAgentTurn.mockImplementation(async (req: { agentId: string }) =>
      req.agentId === 'research'
        ? { text: 'This request was blocked by content policy.', blocked: true, modelId: 'm', costUsd: 0, latencyMs: 1, inputTokens: 1, outputTokens: 1, toolCallCount: 0 }
        : { text: `reply from ${req.agentId}`, modelId: 'm', costUsd: 0, latencyMs: 1, inputTokens: 1, outputTokens: 1, toolCallCount: 0 },
    );
    const got: Delivered[] = [];
    await orchestrateWarroomTurn({ meetingId: 'm1', userTurnSeq: 1, userText: 'what should we check first?', deliver: (m) => { got.push(m as Delivered); } });

    const agents = got.filter((d) => d.kind === 'agent');
    // research produced NO agent reply, and the raw block text never leaks as one.
    expect(agents.map((d) => d.agentId)).toEqual(['main', 'ops']);
    expect(agents.some((d) => d.text.includes('blocked by content policy'))).toBe(false);
    // Instead, a system note names the blocked agent.
    expect(got.some((d) => d.kind === 'system' && /research.*blocked by the safety guardrail/i.test(d.text))).toBe(true);
    // The block doesn't abort the round — all three still ran.
    expect(h.runAgentTurn).toHaveBeenCalledTimes(3);
  });

  it('warroom_disabled: does nothing (no agents, no delivery)', async () => {
    h.isKillSwitchActive.mockResolvedValue({ active: true });
    const got: Delivered[] = [];
    await orchestrateWarroomTurn({ meetingId: 'm1', userTurnSeq: 1, userText: 'hi', deliver: (m) => { got.push(m as Delivered); } });
    expect(got).toEqual([]);
    expect(h.runAgentTurn).not.toHaveBeenCalled();
  });
});
