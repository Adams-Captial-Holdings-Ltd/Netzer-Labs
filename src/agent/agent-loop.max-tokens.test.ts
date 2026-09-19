/**
 * Every model call in a turn must carry an explicit output ceiling.
 *
 * The first fix for the empty-turn poisoning raised the ceiling on the
 * TOOL-LOOP rounds only. The initial streamed call kept falling through to
 * `maxTokens ?? 1024` in lib/bedrock/client.ts, and for a turn that never
 * reaches tool use that is the ONLY call there is — so production still
 * returned `outputTokens: 1024, stopReason: max_tokens` after deploying,
 * and a document still could not fit in a reply.
 *
 * This pins the initial call specifically, because that is the one that was
 * missed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { tryAcquirePanic, converseStreamTurnWithFallback, writeAudit, getConfig } = vi.hoisted(() => ({
  tryAcquirePanic: vi.fn(),
  converseStreamTurnWithFallback: vi.fn(),
  writeAudit: vi.fn(async () => {}),
  // Hoisted so the tests below can drive it; a binding that exists only
  // inside the vi.mock factory is a ReferenceError at module scope.
  getConfig: vi.fn(async (_category: string, _key: string): Promise<string | undefined> => undefined),
}));

vi.mock('../lib/bedrock/client.js', () => ({
  bedrockClient: () => ({}),
  converseStreamTurn: vi.fn(),
  converseStreamTurnWithFallback,
  getAffinityModel: (_a: string, _c: string, primary: string) => primary,
  modelRejectsTemperature: () => false,
  withRetry: (_m: string, _n: number, fn: () => unknown) => fn(),
}));
vi.mock('../lib/tools/registry.js', () => ({ tools: { listFor: () => [], invoke: vi.fn() } }));
vi.mock('../lib/state/kill-switches-repo.js', () => ({
  isKillSwitchActive: vi.fn(async () => ({ active: false })),
  KillSwitchActiveError: class extends Error {},
}));
vi.mock('../lib/memory/context-builder.js', () => ({ buildMemoryContext: vi.fn(async () => '') }));
vi.mock('../lib/state/inter-agent-tasks-repo.js', () => ({
  listInbox: vi.fn(async () => []),
  markStatus: vi.fn(),
}));
vi.mock('../lib/state/hive-mind-repo.js', () => ({ recentHive: vi.fn(async () => []) }));
vi.mock('../lib/audit/audit-writer.js', () => ({ writeAudit }));
vi.mock('../lib/usage/token-tracker.js', () => ({
  recordUsage: vi.fn(),
  getDailyCostUsd: vi.fn(async () => 0),
  SpendIndeterminateError: class extends Error {},
}));
vi.mock('../lib/state/cost-cap-repo.js', () => ({
  getEffectiveCostCap: vi.fn(async () => 50),
  isCostCapEnforced: vi.fn(async () => false),
}));
vi.mock('../lib/state/rate-limits-repo.js', () => ({
  checkAndConsume: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../lib/safety/exfil-guard.js', () => ({
  scanForExfil: vi.fn(async () => ({ matches: [] })),
  redactMatches: (t: string) => t,
  getActivePatterns: vi.fn(async () => []),
  buildStreamingRedactor: vi.fn(async () => (t: string) => t),
}));
vi.mock('../lib/config/agent-loader.js', () => ({
  loadAgent: vi.fn(async () => ({
    id: 'main',
    displayName: 'Main',
    model: 'us.anthropic.claude-sonnet-4-6',
    systemPrompt: 'You are a test agent.',
  })),
}));
vi.mock('../lib/state/runtime-config-repo.js', () => ({ getConfig }));
vi.mock('../lib/cost/ledger-gate.js', () => ({
  admitTurnSpend: vi.fn(async () => ({
    admitted: true,
    finalize: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  })),
}));
vi.mock('../lib/state/panic-state-repo.js', () => ({ tryAcquirePanic }));

import { runAgentTurn, resolveTurnMaxTokens } from './agent-loop.js';

describe('turn output ceiling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockResolvedValue(undefined);
    tryAcquirePanic.mockResolvedValue({ acquired: false, state: { active: false, generation: 0 } });
    converseStreamTurnWithFallback.mockResolvedValue({
      text: 'hello',
      modelId: 'us.anthropic.claude-sonnet-4-6',
      stopReason: 'end_turn',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      costUsd: 0,
    });
  });

  const req = (userText: string) => ({
    agentId: 'main',
    chatId: 'chat-ceiling',
    userText,
    history: [],
    surface: 'telegram' as const,
  });

  it('passes an explicit maxTokens on the INITIAL streamed call', async () => {
    await runAgentTurn(req('build me a pdf'));
    expect(converseStreamTurnWithFallback).toHaveBeenCalled();
    const input = converseStreamTurnWithFallback.mock.calls[0]?.[0];
    expect(input?.maxTokens).toBeDefined();
  });

  it('does not leave the initial call on the 1024 default that truncated documents', async () => {
    await runAgentTurn(req('build me a pdf'));
    const input = converseStreamTurnWithFallback.mock.calls[0]?.[0];
    expect(input.maxTokens).toBeGreaterThan(1024);
  });

  it('sends the runtime-configured ceiling, not the built-in constant', async () => {
    getConfig.mockImplementation(async (category: string, key: string) =>
      category === 'agent' && key === 'max_output_tokens' ? '16384' : undefined,
    );
    await runAgentTurn(req('build me a long report'));
    const input = converseStreamTurnWithFallback.mock.calls[0]?.[0];
    expect(input.maxTokens).toBe(16384);
  });

  it('accepts a ceiling stored as a number, and the turn still runs', async () => {
    // getConfig returns the stored attribute unchecked despite its string type,
    // so a ceiling saved as a number arrives as a number. `raw?.trim()` threw on
    // it, which failed the whole turn.
    getConfig.mockImplementation(async (category: string, key: string) =>
      category === 'agent' && key === 'max_output_tokens' ? (16384 as unknown as string) : undefined,
    );
    await expect(resolveTurnMaxTokens()).resolves.toBe(16384);
    await expect(runAgentTurn(req('build me a long report'))).resolves.toBeDefined();
    expect(converseStreamTurnWithFallback.mock.calls[0]?.[0].maxTokens).toBe(16384);
  });
});

/**
 * The ceiling must be tunable without a deploy, the same way every other
 * tunable in this repo is: the runtime-config table, category `agent`, key
 * `max_output_tokens`, which the dashboard /config route already writes.
 *
 * It is GLOBAL, not per-agent - a newly created agent inherits it with no
 * extra setup, which is the question that prompted this.
 */
describe('resolveTurnMaxTokens', () => {
  beforeEach(() => vi.clearAllMocks());

  it('falls back to the built-in default when nothing is configured', async () => {
    getConfig.mockResolvedValue(undefined);
    expect(await resolveTurnMaxTokens()).toBe(8192);
  });

  it('uses a configured override', async () => {
    getConfig.mockResolvedValue('16384');
    expect(await resolveTurnMaxTokens()).toBe(16384);
  });

  it('clamps above the ceiling rather than accepting anything', async () => {
    getConfig.mockResolvedValue('999999');
    expect(await resolveTurnMaxTokens()).toBe(32768);
  });

  it('clamps below the floor, since a document cannot be emitted at all there', async () => {
    getConfig.mockResolvedValue('10');
    expect(await resolveTurnMaxTokens()).toBe(1024);
  });

  it('ignores junk rather than sending NaN to Bedrock', async () => {
    // '  ' matters: Number('  ') is 0, which is finite, so an untrimmed check
    // clamps it to the floor instead of falling back to the default.
    for (const junk of ['', 'lots', 'null', '  ']) {
      getConfig.mockResolvedValue(junk);
      expect(await resolveTurnMaxTokens()).toBe(8192);
    }
  });

  it('never throws when the config lookup fails - a turn must not break on it', async () => {
    getConfig.mockRejectedValue(new Error('ddb down'));
    await expect(resolveTurnMaxTokens()).resolves.toBe(8192);
  });
});
