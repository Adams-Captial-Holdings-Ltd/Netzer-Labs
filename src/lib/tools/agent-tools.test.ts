import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getConfigMock, listKnownAgentsMock, runAgentTurnMock, writeAuditMock } =
  vi.hoisted(() => ({
    getConfigMock: vi.fn(),
    listKnownAgentsMock: vi.fn(),
    runAgentTurnMock: vi.fn(),
    writeAuditMock: vi.fn(),
  }));

vi.mock('../state/runtime-config-repo.js', () => ({ getConfig: getConfigMock }));
vi.mock('../config/agent-loader.js', () => ({ listKnownAgents: listKnownAgentsMock }));
vi.mock('../audit/audit-writer.js', () => ({ writeAudit: writeAuditMock }));
vi.mock('../../agent/agent-loop.js', () => ({ runAgentTurn: runAgentTurnMock }));
vi.mock('../state/inter-agent-tasks-repo.js', () => ({
  listInbox: vi.fn(),
  markStatus: vi.fn(),
  sendInterAgent: vi.fn(),
}));
vi.mock('../state/hive-mind-repo.js', () => ({
  logToHive: vi.fn(),
  recentHive: vi.fn(),
  searchHiveByTopic: vi.fn(),
  searchHiveText: vi.fn(),
}));

import './agent-tools.js'; // side-effect registration
import { tools } from './registry.js';

const ctx = {
  agentId: 'main',
  chatId: 'owner:emmanuel',
  surface: 'telegram' as const,
  replyChatId: '12345',
};

beforeEach(() => {
  vi.clearAllMocks();
  getConfigMock.mockResolvedValue(undefined);
  listKnownAgentsMock.mockReturnValue(['main', 'research', 'ops']);
  runAgentTurnMock.mockResolvedValue({
    text: 'here is what I found',
    costUsd: 0.02,
    blocked: false,
    modelId: 'm',
    latencyMs: 5,
    inputTokens: 1,
    outputTokens: 1,
    toolCallCount: 0,
  });
});

describe('ask_agent', () => {
  it('runs a one-shot nested turn and relays the answer', async () => {
    const out = await tools.invoke('ask_agent', { to_agent: 'research', question: 'dig into X' }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain('research answered:');
    expect(out.text).toContain('here is what I found');
    expect(runAgentTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'research',
        chatId: 'delegation:main:owner:emmanuel',
        history: [],
        surface: 'system',
        delegationDepth: 1,
      }),
    );
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent_delegation', result: 'ok' }),
    );
  });

  it('folds context into the question', async () => {
    await tools.invoke(
      'ask_agent',
      { to_agent: 'research', question: 'summarize', context: 'user cares about Q3' },
      ctx,
    );
    expect(runAgentTurnMock.mock.calls[0][0].userText).toContain('Context from main: user cares about Q3');
  });

  it('refuses at delegation depth 1 (no chains)', async () => {
    const out = await tools.invoke(
      'ask_agent',
      { to_agent: 'research', question: 'x' },
      { ...ctx, delegationDepth: 1 },
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain('depth limit');
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it('refuses self-ask', async () => {
    const out = await tools.invoke('ask_agent', { to_agent: 'main', question: 'x' }, ctx);
    expect(out.isError).toBe(true);
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it('refuses unknown agents and lists known ones', async () => {
    const out = await tools.invoke('ask_agent', { to_agent: 'ghost', question: 'x' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.text).toContain('research');
  });

  it('honors the delegation/enabled kill flag', async () => {
    getConfigMock.mockImplementation(async (_c: string, k: string) =>
      k === 'enabled' ? '0' : undefined,
    );
    const out = await tools.invoke('ask_agent', { to_agent: 'research', question: 'x' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.text).toContain('switched off');
  });

  it('honors the allowlist', async () => {
    getConfigMock.mockImplementation(async (_c: string, k: string) =>
      k === 'allowed_agents' ? 'ops' : undefined,
    );
    const out = await tools.invoke('ask_agent', { to_agent: 'research', question: 'x' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.text).toContain('not allowed');
  });

  it('caps the input size', async () => {
    const out = await tools.invoke(
      'ask_agent',
      { to_agent: 'research', question: 'x'.repeat(2100) },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain('2000');
  });

  it('truncates long replies to delegation/max_reply_chars', async () => {
    getConfigMock.mockImplementation(async (_c: string, k: string) =>
      k === 'max_reply_chars' ? '300' : undefined,
    );
    runAgentTurnMock.mockResolvedValue({
      text: 'y'.repeat(1000), costUsd: 0, blocked: false,
      modelId: 'm', latencyMs: 1, inputTokens: 1, outputTokens: 1, toolCallCount: 0,
    });
    const out = await tools.invoke('ask_agent', { to_agent: 'research', question: 'x' }, ctx);
    expect(out.text.length).toBeLessThan(400);
    expect(out.text).toContain('…');
  });

  it('surfaces a blocked nested turn as an error, audited as blocked', async () => {
    runAgentTurnMock.mockResolvedValue({
      text: 'BLOCKED', costUsd: 0, blocked: true,
      modelId: 'm', latencyMs: 1, inputTokens: 1, outputTokens: 1, toolCallCount: 0,
    });
    const out = await tools.invoke('ask_agent', { to_agent: 'research', question: 'x' }, ctx);
    expect(out.isError).toBe(true);
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'blocked' }),
    );
  });

  it('fails soft when the nested turn throws', async () => {
    runAgentTurnMock.mockRejectedValue(new Error('bedrock down'));
    const out = await tools.invoke('ask_agent', { to_agent: 'research', question: 'x' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.text).toContain('bedrock down');
  });
});
