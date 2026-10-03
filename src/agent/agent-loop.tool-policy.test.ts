/**
 * FROZEN acceptance tests for Work Platform step 5 (B4 tool policy, B6 turn ID,
 * correlation and PHI-safe audit), asserted on the REAL agent loop. The mock
 * set is `agent-loop.board-scope.test.ts`'s: stores and Bedrock only.
 * Do not edit without the owner's yes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { converseStreamTurnWithFallback, send, invoke, invokeMcpTool, mcpToolsFor, loadAgent, writeAudit } = vi.hoisted(() => ({
  converseStreamTurnWithFallback: vi.fn(),
  send: vi.fn(),
  invoke: vi.fn(),
  invokeMcpTool: vi.fn(),
  mcpToolsFor: vi.fn(),
  loadAgent: vi.fn(),
  writeAudit: vi.fn(async (_event: Record<string, unknown>) => {}),
}));

const spec = (name: string) => ({ toolSpec: { name, description: name, inputSchema: { json: { type: 'object' } } } });
const BUILT_IN = ['list_missions', 'send_dm', 'paperclip_add_comment'];
const READ_ONLY = new Set(['list_missions']);

vi.mock('../lib/bedrock/client.js', () => ({
  bedrockClient: () => ({ send }),
  converseStreamTurnWithFallback,
  converseStreamTurn: vi.fn(),
  getAffinityModel: (_a: string, _c: string, m: string) => m,
  modelRejectsTemperature: () => false,
  withRetry: <T>(_modelId: string, _tries: number, fn: () => Promise<T>) => fn(),
}));
vi.mock('../lib/tools/registry.js', () => ({
  tools: { listFor: () => BUILT_IN.map(spec), invoke, isReadOnly: (name: string) => READ_ONLY.has(name) },
}));
vi.mock('../lib/mcp/mcp-tools.js', () => ({
  mcpToolsFor,
  isMcpToolName: (name: string) => name.startsWith('mcp__'),
  invokeMcpTool,
}));
vi.mock('../lib/state/kill-switches-repo.js', () => ({
  isKillSwitchActive: vi.fn(async () => ({ active: false })),
  KillSwitchActiveError: class extends Error {},
}));
vi.mock('../lib/memory/context-builder.js', () => ({ buildMemoryContext: vi.fn(async () => '') }));
vi.mock('../lib/state/inter-agent-tasks-repo.js', () => ({ listInbox: vi.fn(async () => []), markStatus: vi.fn() }));
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
  checkAndConsume: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: 0 })),
}));
vi.mock('../lib/safety/exfil-guard.js', () => ({
  scanForExfil: vi.fn(async () => ({ matches: [] })),
  redactMatches: (t: string) => t,
  getActivePatterns: vi.fn(async () => []),
  buildStreamingRedactor: vi.fn(async () => (t: string) => t),
}));
vi.mock('../lib/config/agent-loader.js', () => ({ loadAgent }));
vi.mock('../lib/state/runtime-config-repo.js', () => ({ getConfig: vi.fn(async () => undefined) }));
vi.mock('../lib/cost/ledger-gate.js', () => ({
  admitTurnSpend: vi.fn(async () => ({ admitted: true, finalize: vi.fn(async () => {}), abort: vi.fn(async () => {}) })),
}));
vi.mock('../lib/state/panic-state-repo.js', () => ({ tryAcquirePanic: vi.fn() }));

import { runAgentTurn } from './agent-loop.js';

const SECRET_ARG = 'PATIENT-JANE-DOE';
const SECRET_RESULT = 'RESULT-SECRET-TEXT';

/** One tool round (the model calls `name`), then a plain answer. */
function oneToolCall(name: string, input: Record<string, unknown> = { note: SECRET_ARG }): void {
  converseStreamTurnWithFallback.mockResolvedValue({
    text: '', modelId: 'model-x', stopReason: 'tool_use',
    inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, costUsd: 0,
  });
  send
    .mockResolvedValueOnce({ stopReason: 'tool_use', usage: {}, output: { message: { content: [{ toolUse: { name, toolUseId: 'tu-1', input } }] } } })
    .mockResolvedValueOnce({ stopReason: 'end_turn', usage: {}, output: { message: { content: [{ text: 'done' }] } } });
}

const req = { agentId: 'main', chatId: 'chat-1', userText: 'do the work', history: [], surface: 'system' as const };
const audits = (action: string) => writeAudit.mock.calls.map(([event]) => event).filter((event) => event.action === action);
/** Everything the model was offered on the first call, as text. */
const advertised = () => JSON.stringify(converseStreamTurnWithFallback.mock.calls[0]);

beforeEach(() => {
  vi.clearAllMocks();
  loadAgent.mockResolvedValue({ id: 'main', systemPrompt: 'you are main', model: 'model-x' });
  mcpToolsFor.mockResolvedValue([spec('mcp__crm__lookup'), spec('mcp__crm__update')]);
  invoke.mockResolvedValue({ text: SECRET_RESULT });
  invokeMcpTool.mockResolvedValue({ text: SECRET_RESULT });
});

describe('an AI step cannot write (B4)', () => {
  it('a write tool the model names anyway is not executed, and the denial is audited', async () => {
    oneToolCall('paperclip_add_comment');
    await runAgentTurn({ ...req, toolPolicy: { aiStep: true } });
    expect(invoke).not.toHaveBeenCalled();
    const rows = audits('tool_invoke');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolName: 'paperclip_add_comment', result: 'blocked', detail: { reason: 'write_denied_in_ai_step' } });
  });

  it('write tools and remote tools are not even offered to the model', async () => {
    oneToolCall('list_missions');
    await runAgentTurn({ ...req, toolPolicy: { aiStep: true } });
    expect(advertised()).toContain('list_missions');
    for (const hidden of ['send_dm', 'paperclip_add_comment', 'mcp__crm__lookup', 'mcp__crm__update']) {
      expect(advertised()).not.toContain(hidden);
    }
  });

  it('a read-only tool still runs', async () => {
    oneToolCall('list_missions');
    await runAgentTurn({ ...req, toolPolicy: { aiStep: true } });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a remote tool runs in an AI step only when the role allowlist names it', async () => {
    loadAgent.mockResolvedValue({ id: 'main', systemPrompt: 'p', model: 'model-x', tools: ['list_missions', 'mcp__crm__lookup'] });
    oneToolCall('mcp__crm__lookup');
    await runAgentTurn({ ...req, toolPolicy: { aiStep: true } });
    expect(invokeMcpTool).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    loadAgent.mockResolvedValue({ id: 'main', systemPrompt: 'p', model: 'model-x', tools: ['list_missions', 'mcp__crm__lookup'] });
    mcpToolsFor.mockResolvedValue([spec('mcp__crm__lookup'), spec('mcp__crm__update')]);
    oneToolCall('mcp__crm__update');
    await runAgentTurn({ ...req, toolPolicy: { aiStep: true } });
    expect(invokeMcpTool).not.toHaveBeenCalled();
  });

  it('a chat turn with no policy and no allowlist is unchanged: the write tool runs', async () => {
    oneToolCall('send_dm');
    await runAgentTurn({ ...req, surface: 'dashboard' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('the role allowlist from the agent`s own config (B4)', () => {
  beforeEach(() => {
    loadAgent.mockResolvedValue({ id: 'main', systemPrompt: 'p', model: 'model-x', tools: ['list_missions'] });
  });

  it('offers only the allowlisted tools, in a chat turn too', async () => {
    oneToolCall('list_missions');
    await runAgentTurn({ ...req, surface: 'dashboard' });
    expect(advertised()).toContain('list_missions');
    expect(advertised()).not.toContain('send_dm');
    expect(advertised()).not.toContain('mcp__crm__lookup');
  });

  it('refuses a tool outside the allowlist at dispatch and audits it', async () => {
    oneToolCall('send_dm');
    await runAgentTurn({ ...req, surface: 'dashboard' });
    expect(invoke).not.toHaveBeenCalled();
    expect(audits('tool_invoke')[0]).toMatchObject({ toolName: 'send_dm', result: 'blocked', detail: { reason: 'not_in_role_allowlist' } });
  });
});

describe('turn ID, correlation and PHI-safe audit (B6)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('every turn gets its own ID, returned to the caller and handed to the tool', async () => {
    oneToolCall('list_missions');
    const first = await runAgentTurn(req);
    expect(first.turnId).toMatch(UUID);
    expect((invoke.mock.calls[0][2] as { turnId?: string }).turnId).toBe(first.turnId);
    oneToolCall('list_missions');
    const second = await runAgentTurn(req);
    expect(second.turnId).not.toBe(first.turnId);
  });

  it('one audit row per tool call carries the IDs and an argument hash, never the arguments or the result', async () => {
    oneToolCall('list_missions');
    const result = await runAgentTurn({ ...req, runId: 'run-9', correlation: { issueId: 'iss-7', attemptNo: 3 } });
    const rows = audits('tool_invoke');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      toolName: 'list_missions', agentId: 'main', chatId: 'chat-1', result: 'ok',
      detail: { turnId: result.turnId, toolCallId: 'tu-1', runId: 'run-9', issueId: 'iss-7', attemptNo: 3 },
    });
    expect((rows[0].detail as { argsHash: string }).argsHash).toMatch(/^[0-9a-f]{64}$/);
    const everything = JSON.stringify(writeAudit.mock.calls);
    expect(everything).not.toContain(SECRET_ARG);
    expect(everything).not.toContain(SECRET_RESULT);
  });

  it('the turn`s own audit row carries the same turn ID and correlation', async () => {
    oneToolCall('list_missions');
    const result = await runAgentTurn({ ...req, runId: 'run-9', correlation: { issueId: 'iss-7', attemptNo: 3 } });
    const turn = audits('agent_turn').at(-1)!;
    expect(turn.detail).toMatchObject({ turnId: result.turnId, runId: 'run-9', issueId: 'iss-7', attemptNo: 3 });
  });

  it('a failing tool is audited as an error, still without its text', async () => {
    invoke.mockResolvedValue({ text: `failed on ${SECRET_ARG}`, isError: true });
    oneToolCall('list_missions');
    await runAgentTurn(req);
    expect(audits('tool_invoke')[0]).toMatchObject({ result: 'error' });
    expect(JSON.stringify(writeAudit.mock.calls)).not.toContain(SECRET_ARG);
  });

  it('a throwing audit store never breaks the turn', async () => {
    writeAudit.mockRejectedValue(new Error('audit down'));
    oneToolCall('list_missions');
    await expect(runAgentTurn(req)).resolves.toMatchObject({ text: 'done' });
  });
});
