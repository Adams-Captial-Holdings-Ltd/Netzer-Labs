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
import { admitTurnSpend } from '../lib/cost/ledger-gate.js';

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
function toolRound(input: Record<string, unknown>, toolUseId = 'tu-1', name = 'web_search') {
  return {
    stopReason: 'tool_use',
    output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId, name, input } }] } },
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
    buildStreamingRedactor.mockResolvedValue((t: string) => t);
    registryState.description = 'search the web';
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

/**
 * The step 4 review (six read-only reviewers, 2026-09-23), written BEFORE the fix.
 *
 *   - The real SDK does not always throw on a Stop: over HTTP/2 an abort after the
 *     response headers ends the event stream cleanly, so the call RETURNS what had
 *     streamed with no usage (reproduced by two reviewers against the repo's own
 *     SDK). The turn must still count as stopped and settle a real estimate.
 *   - A stopped turn's estimate must err on the safe side (the ledger's own rule):
 *     the files and the tool list the prompt carried, the tool arguments it re-sent,
 *     the real usage of every call before the Stop, and the ceiling of a cut call
 *     that shows no output while it runs.
 *   - Tool inputs and results now reach the browser and the transcript, so they pass
 *     the same block-severity redactor as the reply; the database lookup tool's raw
 *     result is not passed on at all (owner decision 53); a failed tool's text loses
 *     its account ids and ARNs. The model still receives every raw result.
 *   - A Stop inside a tool round starts nothing more, and a turn stopped before it
 *     began reserves no spend at all.
 */
describe('turn lifecycle (P2) — agent loop, review fixes', () => {
  const KEY = 'AKIAIOSFODNN7EXAMPLE';

  beforeEach(() => {
    vi.clearAllMocks();
    killState.dispatchKilled = false;
    getConfig.mockResolvedValue(undefined);
    tryAcquirePanic.mockResolvedValue({ acquired: false, state: { active: false, generation: 0 } });
    converseStreamTurnWithFallback.mockResolvedValue(streamed('end_turn', 'hello'));
    buildStreamingRedactor.mockResolvedValue((t: string) => t);
    registryState.description = 'search the web';
    delete process.env.BEDROCK_GUARDRAIL_ID;
    delete process.env.BEDROCK_GUARDRAIL_VERSION;
  });
  afterEach(() => {
    delete process.env.BEDROCK_GUARDRAIL_ID;
  });

  /** What the second model call (the one after a tool round) was sent. */
  const secondCallMessages = () =>
    JSON.stringify((bedrockSend.mock.calls[1]![0] as { input: { messages: unknown } }).input.messages);

  it('treats a stream that ended quietly after a Stop as stopped, and settles its spend', async () => {
    const ac = new AbortController();
    converseStreamTurnWithFallback.mockImplementation(
      async (_input: unknown, callbacks: { onChunk?: (t: string) => void }) => {
        callbacks.onChunk?.('Partial answer text, several words long.');
        ac.abort();
        // No throw: the stream just ended, and Bedrock never sent its usage.
        return { ...streamed('unknown', 'Partial answer text, several words long.'), inputTokens: 0, outputTokens: 0 };
      },
    );

    const res = await runAgentTurn({ ...baseReq, onChunk: vi.fn(), abortSignal: ac.signal });

    expect(res).toMatchObject({ stopped: true });
    expect(finalize).toHaveBeenCalledTimes(1);
    const settled = finalize.mock.calls[0]![0];
    expect(settled.inputTokens).toBeGreaterThan(0);
    expect(settled.outputTokens).toBeGreaterThan(0);
    expect(settled.costUsd).toBeGreaterThan(0);
  });

  it('counts the attached files when it settles a stopped turn', async () => {
    const ac = new AbortController();
    converseStreamTurnWithFallback.mockImplementation(
      async (_input: unknown, callbacks: { onChunk?: (t: string) => void }) => {
        callbacks.onChunk?.('Partial');
        ac.abort();
        throw abortError();
      },
    );
    const pdf = new Uint8Array(400_000);

    await runAgentTurn({
      ...baseReq,
      onChunk: vi.fn(),
      abortSignal: ac.signal,
      attachments: [
        { kind: 'image', format: 'png', bytes: new Uint8Array(1_000) },
        { kind: 'document', format: 'pdf', name: 'deck.pdf', bytes: pdf },
      ],
    });

    // The billed prompt carried both files. At least 1,600 tokens for an image (the
    // most one image costs after Bedrock scales it down) and a document by its size.
    const settled = finalize.mock.calls[0]![0];
    expect(settled.inputTokens).toBeGreaterThanOrEqual(1_600 + pdf.byteLength / 4);
  });

  it('counts the tool list the model was sent when it settles a stopped turn', async () => {
    registryState.description = 'd'.repeat(40_000);
    const ac = new AbortController();
    converseStreamTurnWithFallback.mockImplementation(async () => {
      ac.abort();
      throw abortError();
    });

    await runAgentTurn({ ...baseReq, onChunk: vi.fn(), abortSignal: ac.signal });

    // The tool specs ride on every call; here they are 40,000 characters.
    expect(finalize.mock.calls[0]![0].inputTokens).toBeGreaterThanOrEqual(10_000);
  });

  it('settles a Stop in a later tool round in the safe direction', async () => {
    const ac = new AbortController();
    converseStreamTurnWithFallback.mockResolvedValue({ ...streamed('tool_use'), inputTokens: 50_000, outputTokens: 5 });
    bedrockSend
      .mockResolvedValueOnce(toolRound({ query: 'q'.repeat(40_000) })) // round 1: 5 in, 5 out
      .mockImplementationOnce(async () => {
        ac.abort(); // round 2 is cut while it runs
        throw abortError();
      });
    toolsInvoke.mockResolvedValue({ text: 'ok', isError: false });

    const res = await runAgentTurn({ ...baseReq, onChunk: vi.fn(), abortSignal: ac.signal });

    expect(res).toMatchObject({ stopped: true });
    const settled = finalize.mock.calls[0]![0];
    // Every call before the Stop keeps its real usage; the cut call adds an estimate
    // that includes the tool arguments it re-sent (10,000 tokens here).
    expect(settled.inputTokens).toBeGreaterThanOrEqual(50_000 + 5 + 10_000);
    // A call that does not stream shows none of its output before the cut, so what it
    // may have generated counts at its ceiling (TURN_MAX_TOKENS, 8,192).
    expect(settled.outputTokens).toBeGreaterThanOrEqual(5 + 5 + 8_192);
  });

  it('starts no further tool once the turn is stopped mid-round', async () => {
    const ac = new AbortController();
    converseStreamTurnWithFallback.mockResolvedValue(streamed('tool_use'));
    bedrockSend
      .mockResolvedValueOnce({
        stopReason: 'tool_use',
        output: { message: { role: 'assistant', content: [
          { toolUse: { toolUseId: 'tu-1', name: 'web_search', input: { query: 'a' } } },
          { toolUse: { toolUseId: 'tu-2', name: 'web_search', input: { query: 'b' } } },
        ] } },
        usage: { inputTokens: 5, outputTokens: 5 },
      })
      .mockResolvedValue(finalRound);
    toolsInvoke.mockImplementationOnce(async () => {
      ac.abort(); // the person presses Stop while tool 1 runs
      return { text: 'first result', isError: false };
    });

    const res = await runAgentTurn({ ...baseReq, onChunk: vi.fn(), abortSignal: ac.signal });

    expect(toolsInvoke).toHaveBeenCalledTimes(1);
    expect(bedrockSend).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ stopped: true });
  });

  it('stops during the synthesis that follows the last tool round', async () => {
    const ac = new AbortController();
    converseStreamTurnWithFallback.mockResolvedValue(streamed('tool_use'));
    let calls = 0;
    bedrockSend.mockImplementation(async () => {
      calls += 1;
      if (calls <= 8) return toolRound({ query: `round ${calls}` }, `tu-${calls}`); // the tool budget
      ac.abort();
      throw abortError();
    });
    toolsInvoke.mockResolvedValue({ text: 'found', isError: false });

    const res = await runAgentTurn({ ...baseReq, onChunk: vi.fn(), abortSignal: ac.signal });

    expect(calls).toBe(9);
    expect(res).toMatchObject({ stopped: true });
  });

  it('starts no paid work for a turn stopped before it began', async () => {
    const ac = new AbortController();
    ac.abort();

    const res = await runAgentTurn({ ...baseReq, onChunk: vi.fn(), abortSignal: ac.signal });

    expect(res).toMatchObject({ stopped: true, text: '' });
    expect(admitTurnSpend).not.toHaveBeenCalled();
    expect(converseStreamTurnWithFallback).not.toHaveBeenCalled();
  });

  it("hides a secret in a tool's input and result before they leave the loop", async () => {
    buildStreamingRedactor.mockResolvedValue((t: string) => t.split(KEY).join('[REDACTED]'));
    converseStreamTurnWithFallback.mockResolvedValue(streamed('tool_use'));
    bedrockSend.mockResolvedValueOnce(toolRound({ query: `key ${KEY}` })).mockResolvedValueOnce(finalRound);
    toolsInvoke.mockResolvedValue({ text: `found ${KEY} in the config`, isError: false });
    const onToolEvent = vi.fn();
    const onToolResult = vi.fn();

    // No onChunk: a surface that shows tool payloads without streaming text is covered too.
    await runAgentTurn({ ...baseReq, onToolEvent, onToolResult });

    const started = onToolEvent.mock.calls[0]![0] as { input: string };
    const ended = onToolResult.mock.calls[0]![0] as { output: string };
    expect(started.input).not.toContain(KEY);
    expect(started.input).toContain('[REDACTED]');
    expect(ended.output).not.toContain(KEY);
    expect(ended.output).toContain('[REDACTED]');
    // The model still receives the raw result, exactly as before P2.
    expect(secondCallMessages()).toContain(`found ${KEY}`);
    // And a turn nobody watches still gets no chunk callback (H2, correction C1).
    const callbacks = converseStreamTurnWithFallback.mock.calls[0]![1] as { onChunk?: unknown };
    expect(callbacks.onChunk).toBeUndefined();
  });

  it("does not pass on the database lookup tool's raw result (decision 53)", async () => {
    converseStreamTurnWithFallback.mockResolvedValue(streamed('tool_use'));
    bedrockSend
      .mockResolvedValueOnce(toolRound({ table: 'sessions' }, 'tu-1', 'dynamodb_query'))
      .mockResolvedValueOnce(finalRound);
    toolsInvoke.mockResolvedValue({ text: 'user-b wrote: my salary is 90k', isError: false });
    const onToolResult = vi.fn();

    await runAgentTurn({ ...baseReq, onToolEvent: vi.fn(), onToolResult });

    const ended = onToolResult.mock.calls[0]![0] as { output: string; isError: boolean; toolUseId: string };
    expect(ended.toolUseId).toBe('tu-1');
    expect(ended.isError).toBe(false);
    expect(ended.output).not.toContain('salary');
    expect(ended.output).toMatch(/not shown/i);
    // The model still receives it (who that tool may read is the owner's open question A172).
    expect(secondCallMessages()).toContain('my salary is 90k');
  });

  it("scrubs account ids and ARNs from a failed tool's result", async () => {
    converseStreamTurnWithFallback.mockResolvedValue(streamed('tool_use'));
    bedrockSend.mockResolvedValueOnce(toolRound({ query: 'x' })).mockResolvedValueOnce(finalRound);
    toolsInvoke.mockResolvedValue({
      text: "Tool 'web_search' failed: AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/task-role/abc is not authorized",
      isError: true,
    });
    const onToolResult = vi.fn();

    await runAgentTurn({ ...baseReq, onToolEvent: vi.fn(), onToolResult });

    const ended = onToolResult.mock.calls[0]![0] as { output: string; isError: boolean };
    expect(ended.isError).toBe(true);
    expect(ended.output).not.toMatch(/123456789012|arn:aws/);
    expect(ended.output).toMatch(/not authorized/); // what went wrong survives
    // The model keeps the raw text, which is what it recovers from.
    expect(secondCallMessages()).toContain('123456789012');
  });

  it('reads the guardrail stream switch regardless of case and spaces', async () => {
    process.env.BEDROCK_GUARDRAIL_ID = 'gr-test';
    const modeFor = async (value: unknown): Promise<string | undefined> => {
      converseStreamTurnWithFallback.mockClear();
      getConfig.mockImplementation(async (category: string, key: string) =>
        category === 'bedrock' && key === 'guardrail_stream_mode' ? (value as string) : undefined,
      );
      await runAgentTurn({ ...baseReq, onChunk: vi.fn() });
      return (converseStreamTurnWithFallback.mock.calls[0]![0] as { guardrail?: { streamMode?: string } })
        .guardrail?.streamMode;
    };

    expect(await modeFor(' SYNC ')).toBe('sync');
    expect(await modeFor('Sync')).toBe('sync');
    expect(await modeFor('async')).toBe('async');
    expect(await modeFor(1)).toBe('async');
    expect(await modeFor(true)).toBe('async');
  });
});
