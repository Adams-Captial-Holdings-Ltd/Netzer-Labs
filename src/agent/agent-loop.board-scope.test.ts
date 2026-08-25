/**
 * `AgentTurnRequest.boardAgentId` → `ToolContext.boardAgentId`, asserted on the
 * REAL agent loop.
 *
 * WHY THIS FILE EXISTS AT ALL, when two surface tests already have
 * "command scope" in their names. Both of them (`handler.command-scope.test.ts`
 * on Telegram and on Slack) `vi.mock` the whole agent loop and then HAND-BUILD
 * the ToolContext in a local `ctxFor` helper that reproduces the spread at
 * `agent-loop.ts`'s tool-dispatch site line for line — the Slack one says so in
 * its own comment. That proves the handler passes `boardAgentId` on the
 * REQUEST, and it proves the tools read it off the CONTEXT, and it proves
 * nothing whatsoever about the one line that joins them: a copy of the code
 * under test cannot fail when the code under test is deleted.
 *
 * So the gap was exactly one line wide and it was load-bearing on both chat
 * surfaces at once. `boardAgentId` is what makes `create_mission` from a
 * per-agent Telegram bot or a per-agent Slack app land on THAT agent's board
 * instead of the session's; drop the spread and every mission silently opens
 * on `main` — no error, no log, and both command-scope suites still green.
 *
 * The mocks below are the `turn-refusal.test.ts` set: stores and Bedrock only,
 * so `runAgentTurn` itself is the real function and the tool-dispatch path is
 * really walked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { converseStreamTurnWithFallback, send, invoke } = vi.hoisted(() => ({
  converseStreamTurnWithFallback: vi.fn(),
  send: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../lib/bedrock/client.js', () => ({
  bedrockClient: () => ({ send }),
  converseStreamTurnWithFallback,
  converseStreamTurn: vi.fn(),
  getAffinityModel: (_a: string, _c: string, m: string) => m,
  modelRejectsTemperature: () => false,
  withRetry: <T>(_modelId: string, _tries: number, fn: () => Promise<T>) => fn(),
}));
vi.mock('../lib/tools/registry.js', () => ({ tools: { listFor: () => [], invoke } }));
vi.mock('../lib/mcp/mcp-tools.js', () => ({
  mcpToolsFor: vi.fn(async () => []),
  isMcpToolName: () => false,
  invokeMcpTool: vi.fn(),
}));
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
vi.mock('../lib/state/rate-limits-repo.js', () => ({
  checkAndConsume: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: 0 })),
}));
vi.mock('../lib/safety/exfil-guard.js', () => ({
  scanForExfil: vi.fn(async () => ({ matches: [] })),
  redactMatches: (t: string) => t,
  getActivePatterns: vi.fn(async () => []),
  buildStreamingRedactor: vi.fn(async () => (t: string) => t),
}));
vi.mock('../lib/config/agent-loader.js', () => ({
  loadAgent: vi.fn(async () => ({ id: 'main', systemPrompt: 'you are main', model: 'model-x' })),
}));
vi.mock('../lib/state/runtime-config-repo.js', () => ({ getConfig: vi.fn(async () => undefined) }));
vi.mock('../lib/cost/ledger-gate.js', () => ({
  admitTurnSpend: vi.fn(async () => ({
    admitted: true,
    finalize: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  })),
}));
vi.mock('../lib/state/panic-state-repo.js', () => ({ tryAcquirePanic: vi.fn() }));

import { runAgentTurn } from './agent-loop.js';

/** One tool round, then a plain answer — the shortest path through dispatch. */
function oneToolCall(): void {
  converseStreamTurnWithFallback.mockResolvedValue({
    text: '',
    modelId: 'model-x',
    stopReason: 'tool_use',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    costUsd: 0,
  });
  send
    .mockResolvedValueOnce({
      stopReason: 'tool_use',
      usage: {},
      output: {
        message: {
          content: [{ toolUse: { name: 'list_missions', toolUseId: 'tu-1', input: {} } }],
        },
      },
    })
    .mockResolvedValueOnce({
      stopReason: 'end_turn',
      usage: {},
      output: { message: { content: [{ text: 'here is the board' }] } },
    });
  invoke.mockResolvedValue({ text: 'no missions' });
}

/** The context the loop actually handed the tool. */
function dispatchedCtx(): Record<string, unknown> {
  expect(invoke, 'the turn never reached tool dispatch').toHaveBeenCalledTimes(1);
  return invoke.mock.calls[0][2] as Record<string, unknown>;
}

const req = {
  agentId: 'main',
  chatId: 'chat-1',
  userText: '/missions',
  history: [],
  surface: 'telegram' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the agent loop forwards the BOARD scope onto every ToolContext', () => {
  it('hands the tool the request`s boardAgentId, not the turn agent', async () => {
    // The shipped shape this pins: a per-agent Telegram bot (`/tg/research/
    // webhook`) or a per-agent Slack app answers as the SESSION agent while
    // its board is the BOT's. Delete the spread at the dispatch site and this
    // comes back `undefined`, `create_mission` falls through to `ctx.agentId`,
    // and the mission opens on the wrong agent's board with nothing raised.
    oneToolCall();
    await runAgentTurn({ ...req, boardAgentId: 'research' });
    expect(dispatchedCtx().boardAgentId).toBe('research');
    expect(dispatchedCtx().agentId).toBe('main');
  });

  it('OMITS the key entirely on a surface with one identity, never sends undefined', async () => {
    // The tools read `ctx.boardAgentId ?? ctx.agentId`, so an explicit
    // `undefined` would behave the same — but the spread is conditional on
    // purpose and `toolCtx` is logged and compared elsewhere. Absent means
    // absent: the dashboard and the main Slack bot pass no board scope at all.
    oneToolCall();
    await runAgentTurn(req);
    expect(dispatchedCtx()).not.toHaveProperty('boardAgentId');
  });

  it('forwards it unchanged on EVERY tool call of a multi-tool turn', async () => {
    // The spread is inside the per-block loop, not hoisted above it. A future
    // edit that builds the context once outside would still pass the case
    // above; this one fails if the second call gets a different scope.
    converseStreamTurnWithFallback.mockResolvedValue({
      text: '', modelId: 'model-x', stopReason: 'tool_use',
      inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, costUsd: 0,
    });
    send
      .mockResolvedValueOnce({
        stopReason: 'tool_use',
        usage: {},
        output: {
          message: {
            content: [
              { toolUse: { name: 'list_missions', toolUseId: 'tu-1', input: {} } },
              { toolUse: { name: 'create_mission', toolUseId: 'tu-2', input: {} } },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        usage: {},
        output: { message: { content: [{ text: 'done' }] } },
      });
    invoke.mockResolvedValue({ text: 'ok' });

    await runAgentTurn({ ...req, boardAgentId: 'research' });
    expect(invoke).toHaveBeenCalledTimes(2);
    for (const call of invoke.mock.calls) {
      expect((call[2] as Record<string, unknown>).boardAgentId).toBe('research');
    }
  });
});

describe('the agent loop forwards only caller-held Paperclip run provenance', () => {
  it('hands a dispatched turn runId to the invoked tool unchanged', async () => {
    oneToolCall();
    await runAgentTurn({ ...req, surface: 'system', runId: 'paperclip-minted-run-id' });
    expect(dispatchedCtx().runId).toBe('paperclip-minted-run-id');
  });

  it('omits runId entirely for an ordinary chat turn', async () => {
    oneToolCall();
    await runAgentTurn(req);
    expect(dispatchedCtx()).not.toHaveProperty('runId');
  });
});
