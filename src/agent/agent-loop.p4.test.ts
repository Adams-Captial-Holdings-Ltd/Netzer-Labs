/**
 * P3 (step 5) — the agent loop's half of attachments: a document block's NAME.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p3-proof.sh row K-7).
 *
 * Bedrock's DocumentBlock `name` may contain only letters, digits, single spaces,
 * hyphens, parentheses and square brackets (AWS SDK reference, DocumentBlock.name),
 * and a request that breaks it is rejected whole. buildUserContent cleaned names with
 * /[^A-Za-z0-9._-]/g, which KEEPS dots and underscores — so every PDF a person
 * attached ("report.pdf") was sent with a name Bedrock refuses. P3 sends more
 * documents down this path (Word, text, CSV, Markdown), so the name must be one
 * Bedrock accepts. The local Bedrock is a stub that validates nothing (development.md,
 * Known local limitations 1), which is why this is pinned here and not observed.
 *
 * The mock harness is agent-loop.p2.test.ts's, copied verbatim (the models and
 * repos a turn touches), so this file drives the real runAgentTurn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  tryAcquirePanic,
  converseStreamTurnWithFallback,
  bedrockSend,
  toolsInvoke,
  writeAudit,
  getConfig,
  recordUsage,
  finalize,
  abortHold,
  killState,
  buildStreamingRedactor,
  registryState,
} = vi.hoisted(() => ({
  tryAcquirePanic: vi.fn(),
  converseStreamTurnWithFallback: vi.fn(),
  bedrockSend: vi.fn(),
  toolsInvoke: vi.fn(),
  writeAudit: vi.fn(async () => {}),
  getConfig: vi.fn(async (_category: string, _key: string): Promise<string | undefined> => undefined),
  recordUsage: vi.fn(async () => true),
  finalize: vi.fn(async (_actuals: { costUsd: number; modelId: string; inputTokens: number; outputTokens: number }) => {}),
  abortHold: vi.fn(async () => {}),
  killState: { dispatchKilled: false },
  buildStreamingRedactor: vi.fn(async () => (t: string) => t),
  registryState: { description: 'search the web' },
}));

vi.mock('../lib/bedrock/client.js', () => ({
  bedrockClient: () => ({ send: bedrockSend }),
  converseStreamTurn: vi.fn(),
  converseStreamTurnWithFallback,
  getAffinityModel: (_a: string, _c: string, primary: string) => primary,
  modelRejectsTemperature: () => false,
  withRetry: (_m: string, _n: number, fn: () => unknown) => fn(),
}));
vi.mock('../lib/tools/registry.js', () => ({
  tools: {
    listFor: () => [
      { toolSpec: { name: 'web_search', description: registryState.description, inputSchema: { json: { type: 'object' } } } },
    ],
    invoke: toolsInvoke,
  },
}));
vi.mock('../lib/state/kill-switches-repo.js', () => ({
  // Only `tool_dispatch_disabled` is ever active, and only once a test flips it.
  // The turn-start checks run before the model call; the mid-turn check runs after
  // a tool round's response, which is where the tests flip it.
  isKillSwitchActive: vi.fn(async (name: string) => ({
    active: name === 'tool_dispatch_disabled' && killState.dispatchKilled,
  })),
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
  recordUsage,
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
  buildStreamingRedactor,
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
  admitTurnSpend: vi.fn(async () => ({ admitted: true, finalize, abort: abortHold })),
}));
vi.mock('../lib/state/panic-state-repo.js', () => ({ tryAcquirePanic }));

import { runAgentTurn } from './agent-loop.js';

const MODEL = 'us.anthropic.claude-sonnet-4-6';

/** A settled streamed call, as converseStreamTurnWithFallback returns it. */
function streamed(stopReason: string, text = '') {
  return {
    text,
    modelId: MODEL,
    stopReason,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    costUsd: 0,
    latencyMs: 1,
  };
}

const baseReq = {
  agentId: 'main',
  chatId: 'dashboard:1750000000001',
  userText: 'summarise these',
  history: [],
  surface: 'dashboard' as const,
};


/** P4 tool results must reach the dashboard without leaking storage URLs to the model. */
function toolRound(name = 'web_search') {
  return {
    stopReason: 'tool_use',
    output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'p4-tu-1', name, input: {} } }] } },
    usage: { inputTokens: 5, outputTokens: 5 },
  };
}
const finalRound = {
  stopReason: 'end_turn',
  output: { message: { role: 'assistant', content: [{ text: 'The report is ready.' }] } },
  usage: { inputTokens: 5, outputTokens: 5 },
};
const artifact = {
  artifactId: 'f78d0000-0000-4000-8000-000000000001', version: 2,
  fileName: 'report.pdf', contentType: 'application/pdf', createdAt: '2026-09-25T00:00:00.000Z',
};

describe('P4 agent loop artifact dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    killState.dispatchKilled = false;
    getConfig.mockResolvedValue(undefined);
    tryAcquirePanic.mockResolvedValue({ acquired: false, state: { active: false, generation: 0 } });
    converseStreamTurnWithFallback.mockResolvedValue(streamed('tool_use'));
    bedrockSend.mockResolvedValueOnce(toolRound()).mockResolvedValueOnce(finalRound);
    buildStreamingRedactor.mockResolvedValue((t: string) => t);
  });
  afterEach(() => { delete process.env.BEDROCK_GUARDRAIL_ID; });

  it('P4 loop returns URL free artifact descriptors without sending them to the model', async () => {
    toolsInvoke.mockResolvedValue({ text: 'Saved report to this conversation.', artifacts: [artifact] });
    const response = await runAgentTurn({ ...baseReq, userId: 'dashboard:user:p4-owner' });
    expect((response as typeof response & { artifacts?: unknown[] }).artifacts, 'tool-produced artifact references must reach the surface').toEqual([artifact]);
    const modelInput = JSON.stringify((bedrockSend.mock.calls[1]![0] as { input: { messages: unknown } }).input.messages);
    expect(modelInput).toContain('Saved report');
    expect(modelInput).not.toMatch(/f78d0000|X-Amz-|s3Bucket|s3Key/);
  });

  it('P4 loop passes the turn abort signal into a tool before it can store', async () => {
    const abort = new AbortController();
    toolsInvoke.mockResolvedValue({ text: 'Done.' });
    await runAgentTurn({ ...baseReq, userId: 'dashboard:user:p4-owner', abortSignal: abort.signal });
    expect(toolsInvoke).toHaveBeenCalledOnce();
    expect(toolsInvoke.mock.calls[0]![2], 'tool context must carry the same abort signal')
      .toMatchObject({ abortSignal: abort.signal });
  });
});
