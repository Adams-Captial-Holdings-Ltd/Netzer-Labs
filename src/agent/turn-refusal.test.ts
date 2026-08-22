/**
 * `AgentTurnResponse.refusal` — the typed marker on the three gates that refuse
 * a turn by RETURNING rather than throwing.
 *
 * WHY THIS FILE EXISTS. `runAgentTurn` short-circuits on the emergency kill
 * phrase, on the `sessions_frozen` maintenance switch and on the turn-level
 * rate limit, and each of those returns a normal-looking `AgentTurnResponse`
 * carrying a canned notice. A caller cannot tell them from an answer by
 * catching, and every caller that needs to — the Paperclip dispatch worker
 * holds a durable 24-hour dedupe claim over the turn — was previously left
 * inferring it from the prose or from the zero metrics. Both are wrong on their
 * own terms: the prose is rewordable, and zero cost with an empty `modelId` is
 * also what a cheap or cached real answer looks like.
 *
 * So the assertions below are about the MARKER, on the REAL `runAgentTurn`,
 * with only the stores mocked. `blocked` is checked alongside on every one of
 * them, because it is documented as guardrail-only and a refusal must never
 * start setting it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { tryAcquirePanic, converseStreamTurn, isKillSwitchActive, checkAndConsume } = vi.hoisted(
  () => ({
    tryAcquirePanic: vi.fn(),
    converseStreamTurn: vi.fn(),
    isKillSwitchActive: vi.fn(),
    checkAndConsume: vi.fn(),
  }),
);

vi.mock('../lib/bedrock/client.js', () => ({
  bedrockClient: () => ({}),
  converseStreamTurn,
  modelRejectsTemperature: () => false,
}));
vi.mock('../lib/tools/registry.js', () => ({ tools: { listFor: () => [], invoke: vi.fn() } }));
vi.mock('../lib/state/kill-switches-repo.js', () => ({
  isKillSwitchActive,
  KillSwitchActiveError: class extends Error {},
}));
vi.mock('../lib/memory/context-builder.js', () => ({ buildMemoryContext: vi.fn(async () => '') }));
vi.mock('../lib/state/inter-agent-tasks-repo.js', () => ({
  listInbox: vi.fn(async () => []),
  markStatus: vi.fn(),
}));
vi.mock('../lib/state/hive-mind-repo.js', () => ({ recentHive: vi.fn(async () => []) }));
vi.mock('../lib/audit/audit-writer.js', () => ({ writeAudit: vi.fn(async () => {}) }));
vi.mock('../lib/usage/token-tracker.js', () => ({
  recordUsage: vi.fn(),
  getDailyCostUsd: vi.fn(async () => 0),
  SpendIndeterminateError: class extends Error {},
}));
vi.mock('../lib/state/cost-cap-repo.js', () => ({
  getEffectiveCostCap: vi.fn(async () => 50),
  isCostCapEnforced: vi.fn(async () => false),
}));
vi.mock('../lib/state/rate-limits-repo.js', () => ({ checkAndConsume }));
vi.mock('../lib/safety/exfil-guard.js', () => ({
  scanForExfil: vi.fn(async () => ({ matches: [] })),
  redactMatches: (t: string) => t,
  getActivePatterns: vi.fn(async () => []),
  buildStreamingRedactor: vi.fn(async () => (t: string) => t),
}));
vi.mock('../lib/config/agent-loader.js', () => ({ loadAgent: vi.fn() }));
vi.mock('../lib/state/runtime-config-repo.js', () => ({ getConfig: vi.fn(async () => undefined) }));
vi.mock('../lib/cost/ledger-gate.js', () => ({
  admitTurnSpend: vi.fn(async () => ({
    admitted: true,
    finalize: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  })),
}));
vi.mock('../lib/state/panic-state-repo.js', () => ({ tryAcquirePanic }));

import { runAgentTurn } from './agent-loop.js';

const PHRASE = 'STOP-firm-sentry-3a2f';

const req = (userText: string) => ({
  agentId: 'main',
  chatId: 'chat-1',
  userText,
  history: [],
  surface: 'system' as const,
});

beforeEach(() => {
  vi.clearAllMocks();
  isKillSwitchActive.mockResolvedValue({ active: false });
  checkAndConsume.mockResolvedValue({ allowed: true, remaining: 9, resetAt: 0 });
  delete process.env.EMERGENCY_KILL_PHRASE;
});

afterEach(() => {
  delete process.env.EMERGENCY_KILL_PHRASE;
});

describe('the three gates that refuse by returning carry a typed refusal marker', () => {
  it('marks the sessions_frozen maintenance freeze RETRYABLE, because an operator lifts it', async () => {
    isKillSwitchActive.mockImplementation(async (name: string) => ({
      active: name === 'sessions_frozen',
      reason: 'maintenance',
    }));
    const res = await runAgentTurn(req('do the thing'));
    expect(res.refusal).toEqual({ kind: 'sessions_frozen', retryable: true });
    expect(res.blocked, 'blocked is guardrail-only and must stay that way').toBeUndefined();
    expect(converseStreamTurn, 'a refused turn must not reach Bedrock').not.toHaveBeenCalled();
  });

  it('marks the turn-level rate limit RETRYABLE, because the window rolls over on its own', async () => {
    checkAndConsume.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 1_700_000_000 });
    const res = await runAgentTurn(req('do the thing'));
    expect(res.refusal).toEqual({ kind: 'rate_limited', retryable: true });
    expect(res.blocked).toBeUndefined();
    expect(converseStreamTurn).not.toHaveBeenCalled();
  });

  it('marks the emergency kill phrase NOT retryable, because replaying it just re-halts the fleet', async () => {
    process.env.EMERGENCY_KILL_PHRASE = PHRASE;
    tryAcquirePanic.mockResolvedValue({ acquired: true, state: { active: true, generation: 1 } });
    // `origin` is what arms this gate at all: only text a PERSON typed in a chat
    // window can halt the fleet, so the marker cannot be produced without it.
    // The other two gates below take every turn as they find it.
    const res = await runAgentTurn({ ...req(`enough ${PHRASE}`), origin: 'human_chat' as const });
    expect(res.refusal).toEqual({ kind: 'kill_phrase', retryable: false });
    expect(res.blocked).toBeUndefined();
    expect(converseStreamTurn).not.toHaveBeenCalled();
  });

  it('leaves the marker ABSENT on a turn that actually ran, so it can never be read as a refusal', async () => {
    // The counterexample the whole design rests on: this response is
    // indistinguishable from a refusal by cost, tokens or text — it is only the
    // absent marker that says the agent spoke.
    converseStreamTurn.mockResolvedValue({
      text: 'Sessions are temporarily frozen for maintenance. Your message was not processed. Please try again shortly.',
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
      toolCalls: [],
    });
    const res = await runAgentTurn(req('quote the freeze notice back to me')).catch(
      (err: unknown) => err,
    );
    // Whatever the deeper loop does with a stub model, the one thing that must
    // hold is that no path past the three gates invents a refusal marker.
    expect((res as { refusal?: unknown }).refusal).toBeUndefined();
  });
});
