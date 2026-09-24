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

describe('chat attachments (P3) — agent loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    killState.dispatchKilled = false;
    getConfig.mockResolvedValue(undefined);
    tryAcquirePanic.mockResolvedValue({ acquired: false, state: { active: false, generation: 0 } });
    converseStreamTurnWithFallback.mockResolvedValue(streamed('end_turn', 'Here is the summary.'));
    buildStreamingRedactor.mockResolvedValue((t: string) => t);
  });
  afterEach(() => {
    delete process.env.BEDROCK_GUARDRAIL_ID;
  });

  it('names a document block with characters Bedrock accepts', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await runAgentTurn({
      ...baseReq,
      onChunk: vi.fn(),
      attachments: [
        { kind: 'document', format: 'pdf', name: 'Q3_report.v2  (final).pdf', bytes },
        { kind: 'document', format: 'txt', name: '..._.', bytes },
      ],
    });

    const input = converseStreamTurnWithFallback.mock.calls[0]![0] as {
      userContent: Array<{ document?: { name?: string } }>;
    };
    const names = input.userContent.flatMap((b) => (b.document ? [b.document.name ?? ''] : []));
    expect(names).toHaveLength(2);
    for (const name of names) {
      // Bedrock's rule: letters, digits, single whitespace, hyphens, parentheses,
      // square brackets — nothing else, and never empty.
      expect(name, JSON.stringify(name)).toMatch(/^[A-Za-z0-9 ()[\]-]+$/);
      expect(name, JSON.stringify(name)).not.toMatch(/\s{2}/);
      expect(name.trim(), JSON.stringify(name)).toBe(name);
    }
    // The file's own words survive where they can, so the model can tell the two apart.
    expect(names[0]).toContain('Q3');
    expect(new Set(names).size).toBe(2);
  });
});
