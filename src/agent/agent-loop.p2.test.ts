/**
 * P2 (step 4) — the agent loop's half of the turn lifecycle.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p2-proof.sh rows A-1..A-3,
 * B-5..B-7, C-1, C-2). What each block pins:
 *
 *   - Stop really stops the model (plan MSG-03): the turn's AbortSignal reaches the
 *     model call, an abort mid-stream returns what had streamed as a `stopped`
 *     result instead of throwing, and no tool round or synthesis starts afterwards.
 *     A stopped turn still costs money — the partial generation was billed — so it
 *     settles its spend admission with an estimate rather than releasing the hold as
 *     if nothing ran.
 *   - Tool start and end (decisions 37 + 41): each call reports its id and its
 *     arguments (capped at 1 KB, marked when shortened) BEFORE it runs, and its
 *     result (capped at 2 KB, marked when shortened) AFTER, on every branch —
 *     including one a kill switch stopped mid-turn.
 *   - Decision 50: the deployed dashboard did not stream because the Bedrock
 *     guardrail ran in its default synchronous stream mode, which holds the whole
 *     answer until generation ends (decision 51 measured it on real Bedrock). A
 *     guarded streamed turn now asks for the asynchronous mode, and the runtime
 *     switch `bedrock/guardrail_stream_mode = sync` puts it back.
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
      { toolSpec: { name: 'web_search', description: 'search the web', inputSchema: { json: { type: 'object' } } } },
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

/** One non-streamed tool-loop response carrying a single tool call. */
function toolRound(input: Record<string, unknown>, toolUseId = 'tu-1') {
  return {
    stopReason: 'tool_use',
    output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId, name: 'web_search', input } }] } },
    usage: { inputTokens: 5, outputTokens: 5 },
  };
}

const finalRound = {
  stopReason: 'end_turn',
  output: { message: { role: 'assistant', content: [{ text: 'All done.' }] } },
  usage: { inputTokens: 5, outputTokens: 5 },
};

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

const baseReq = {
  agentId: 'main',
  chatId: 'dashboard:1750000000001',
  userText: 'what broke the staging rollout?',
  history: [],
  surface: 'dashboard' as const,
};

describe('turn lifecycle (P2) — agent loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    killState.dispatchKilled = false;
    getConfig.mockResolvedValue(undefined);
    tryAcquirePanic.mockResolvedValue({ acquired: false, state: { active: false, generation: 0 } });
    converseStreamTurnWithFallback.mockResolvedValue(streamed('end_turn', 'hello'));
    delete process.env.BEDROCK_GUARDRAIL_ID;
    delete process.env.BEDROCK_GUARDRAIL_VERSION;
  });
  afterEach(() => {
    delete process.env.BEDROCK_GUARDRAIL_ID;
  });

  it('stops the model when the turn is aborted', async () => {
    const ac = new AbortController();
    converseStreamTurnWithFallback.mockImplementation(
      async (_input: unknown, callbacks: { onChunk?: (t: string) => void }) => {
        callbacks.onChunk?.('Partial ans');
        ac.abort();
        throw abortError();
      },
    );

    const res = await runAgentTurn({ ...baseReq, onChunk: vi.fn(), abortSignal: ac.signal });

    // The signal travels WITH the model call, so the SDK can cancel the request.
    const input = converseStreamTurnWithFallback.mock.calls[0]![0] as { abortSignal?: AbortSignal };
    expect(input.abortSignal).toBe(ac.signal);
    // A deliberate stop is not an error: the partial answer comes back, marked.
    expect(res).toMatchObject({ stopped: true, text: 'Partial ans' });
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  it('gives a turn with no live viewer no chunk callback', async () => {
    // The model-fallback wrapper decides whether a mid-stream failure may switch
    // models by counting the chunks it forwarded through this callback (H2: two
    // models are never spliced into one reply the person SAW). A scheduled or
    // Paperclip turn has nobody watching, so before P2 it passed no callback and a
    // mid-stream failure could still fall back. Stop tracking must not take that
    // away: it only matters where there is a viewer to stop.
    await runAgentTurn({ ...baseReq });

    const callbacks = converseStreamTurnWithFallback.mock.calls[0]![1] as { onChunk?: unknown };
    expect(callbacks.onChunk).toBeUndefined();
  });

  it('starts no tool round after the turn is aborted', async () => {
    const ac = new AbortController();
    // The stream finished on its own with tool_use, but the person pressed Stop
    // while it ran: nothing may be dispatched and no further model call made.
    converseStreamTurnWithFallback.mockImplementation(async () => {
      ac.abort();
      return streamed('tool_use');
    });
    // Were a round started anyway, it would get a normal answer, so what fails is
    // the assertion below and not a crash on an empty response.
    bedrockSend.mockResolvedValue(finalRound);

    const res = await runAgentTurn({ ...baseReq, onChunk: vi.fn(), abortSignal: ac.signal });

    expect(bedrockSend).not.toHaveBeenCalled();
    expect(toolsInvoke).not.toHaveBeenCalled();
    expect(res).toMatchObject({ stopped: true });
  });

  it('settles the spend of a stopped turn', async () => {
    const ac = new AbortController();
    converseStreamTurnWithFallback.mockImplementation(
      async (_input: unknown, callbacks: { onChunk?: (t: string) => void }) => {
        callbacks.onChunk?.('Partial answer text, several words long.');
        ac.abort();
        throw abortError();
      },
    );

    await runAgentTurn({ ...baseReq, onChunk: vi.fn(), abortSignal: ac.signal });

    // The model ran and was billed for it. Releasing the hold would hide that from
    // the daily cap, so the stopped turn settles with an estimate instead.
    expect(finalize).toHaveBeenCalledTimes(1);
    const settled = finalize.mock.calls[0]![0] as { costUsd: number; inputTokens: number; outputTokens: number };
    expect(settled.costUsd).toBeGreaterThan(0);
    expect(settled.inputTokens).toBeGreaterThan(0);
    expect(settled.outputTokens).toBeGreaterThan(0);
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it('reports each tool call with its id, input and result', async () => {
    converseStreamTurnWithFallback.mockResolvedValue(streamed('tool_use'));
    bedrockSend.mockResolvedValueOnce(toolRound({ query: 'staging rollout' })).mockResolvedValueOnce(finalRound);
    toolsInvoke.mockResolvedValue({ text: '3 pages found', isError: false });
    const onToolEvent = vi.fn();
    const onToolResult = vi.fn();

    await runAgentTurn({ ...baseReq, onToolEvent, onToolResult });

    expect(onToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'web_search',
        callIndex: 0,
        toolUseId: 'tu-1',
        input: JSON.stringify({ query: 'staging rollout' }),
        inputTruncated: false,
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'web_search',
        callIndex: 0,
        toolUseId: 'tu-1',
        output: '3 pages found',
        isError: false,
        truncated: false,
      }),
    );
    // Start before end: the start fires before the tool runs, the result after.
    expect(onToolEvent.mock.invocationCallOrder[0]!).toBeLessThan(onToolResult.mock.invocationCallOrder[0]!);
  });

  it('caps a long tool input and output and marks them', async () => {
    converseStreamTurnWithFallback.mockResolvedValue(streamed('tool_use'));
    bedrockSend.mockResolvedValueOnce(toolRound({ query: 'x'.repeat(5000) })).mockResolvedValueOnce(finalRound);
    toolsInvoke.mockResolvedValue({ text: 'y'.repeat(10_000), isError: false });
    const onToolEvent = vi.fn();
    const onToolResult = vi.fn();

    await runAgentTurn({ ...baseReq, onToolEvent, onToolResult });

    const started = onToolEvent.mock.calls[0]![0] as { input: string; inputTruncated: boolean };
    expect(started.input.length).toBeLessThanOrEqual(1024);
    expect(started.inputTruncated).toBe(true);
    const ended = onToolResult.mock.calls[0]![0] as { output: string; truncated: boolean };
    expect(ended.output.length).toBeLessThanOrEqual(2048);
    expect(ended.output.startsWith('yyyy')).toBe(true);
    expect(ended.truncated).toBe(true);
    // The model itself still receives the whole result; only the report is capped.
    const secondRound = bedrockSend.mock.calls[1]![0] as { input: { messages: Array<{ content: unknown[] }> } };
    expect(JSON.stringify(secondRound.input.messages)).toContain('y'.repeat(10_000));
  });

  it('reports a result for a tool the kill switch stopped', async () => {
    converseStreamTurnWithFallback.mockResolvedValue(streamed('tool_use'));
    bedrockSend
      .mockImplementationOnce(async () => {
        // An operator trips tool_dispatch_disabled while the round is in flight.
        killState.dispatchKilled = true;
        return toolRound({ query: 'anything' });
      })
      .mockResolvedValueOnce(finalRound);
    const onToolResult = vi.fn();

    await runAgentTurn({ ...baseReq, onToolEvent: vi.fn(), onToolResult });

    expect(toolsInvoke).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: 'tu-1', isError: true }));
    const ended = onToolResult.mock.calls[0]![0] as { output: string };
    expect(ended.output).toMatch(/kill switch/i);
  });

  it('streams with the guardrail checking alongside by default', async () => {
    process.env.BEDROCK_GUARDRAIL_ID = 'gr-test';

    await runAgentTurn({ ...baseReq, onChunk: vi.fn() });

    const input = converseStreamTurnWithFallback.mock.calls[0]![0] as { guardrail?: unknown };
    expect(input.guardrail).toEqual({ id: 'gr-test', version: 'DRAFT', streamMode: 'async' });
  });

  it('checks first when the guardrail stream switch says sync', async () => {
    process.env.BEDROCK_GUARDRAIL_ID = 'gr-test';
    getConfig.mockImplementation(async (category: string, key: string) =>
      category === 'bedrock' && key === 'guardrail_stream_mode' ? 'sync' : undefined,
    );

    await runAgentTurn({ ...baseReq, onChunk: vi.fn() });

    const input = converseStreamTurnWithFallback.mock.calls[0]![0] as { guardrail?: unknown };
    expect(input.guardrail).toEqual({ id: 'gr-test', version: 'DRAFT', streamMode: 'sync' });
  });
});
