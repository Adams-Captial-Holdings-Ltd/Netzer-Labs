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


import { createHash } from 'node:crypto';

describe('review: tool policy and audit', () => {
  it('an empty role allowlist offers no tools and blocks a model-named call', async () => {
    loadAgent.mockResolvedValueOnce({ id: 'main', systemPrompt: 'p', model: 'model-x', tools: [] });
    oneToolCall('list_missions');
    await runAgentTurn({ ...req, surface: 'dashboard' });
    expect(advertised()).not.toContain('list_missions');
    expect(invoke).not.toHaveBeenCalled();
    expect(audits('tool_invoke')[0]).toMatchObject({ result: 'blocked', detail: { reason: 'not_in_role_allowlist' } });
  });

  it('an AI step blocks a model-named remote write without an allowlist', async () => {
    oneToolCall('mcp__crm__update');
    await runAgentTurn({ ...req, toolPolicy: { aiStep: true } });
    expect(invokeMcpTool).not.toHaveBeenCalled();
    expect(audits('tool_invoke')[0]).toMatchObject({ result: 'blocked', detail: { reason: 'write_denied_in_ai_step' } });
  });

  it('hashes the exact JSON input and records the surface', async () => {
    const input = { z: 'one', a: 2 };
    oneToolCall('list_missions', input);
    await runAgentTurn({ ...req, surface: 'dashboard' });
    expect(audits('tool_invoke')[0]).toMatchObject({ surface: 'dashboard', detail: {
      argsHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    } });
  });

  it('a thrown tool becomes an error result and keeps the message out of audit', async () => {
    invoke.mockRejectedValueOnce(new Error('PATIENT-PRIVATE-THROW'));
    oneToolCall('list_missions');
    await expect(runAgentTurn(req)).resolves.toMatchObject({ text: 'done' });
    expect(audits('tool_invoke')[0]).toMatchObject({ result: 'error' });
    expect(JSON.stringify(writeAudit.mock.calls)).not.toContain('PATIENT-PRIVATE-THROW');
    expect(JSON.stringify(send.mock.calls)).toContain("Tool 'list_missions' failed.");
  });

  it('a turn without tools still audits its correlation', async () => {
    converseStreamTurnWithFallback.mockResolvedValueOnce({ text: 'done', modelId: 'model-x', stopReason: 'end_turn',
      inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, costUsd: 0 });
    const turn = await runAgentTurn({ ...req, runId: 'run-9', correlation: { issueId: 'issue-7', attemptNo: 3 } });
    expect(audits('agent_turn')[0].detail).toMatchObject({ turnId: turn.turnId, runId: 'run-9', issueId: 'issue-7', attemptNo: 3 });
  });
});
