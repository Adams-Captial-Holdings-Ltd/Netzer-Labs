import { describe, it, expect } from 'vitest';
import { formatTurnFooter, humanizeToolName, toolStepSuffix } from './humanize.js';

describe('humanizeToolName', () => {
  it('de-mangles builtin tool names', () => {
    expect(humanizeToolName('web_search')).toBe('web search');
    expect(humanizeToolName('')).toBe('a tool');
  });

  it('labels vendor MCP tools with the server and strips the vendor re-prefix', () => {
    expect(humanizeToolName('mcp__slack__slack_search_public')).toBe('Slack: search public');
    expect(humanizeToolName('mcp__slack__slack_read_channel')).toBe('Slack: read channel');
  });

  it('strips AgentCore target prefixes', () => {
    expect(humanizeToolName('mcp__aws-gateway__demo-tools___get_weather')).toBe(
      'Aws gateway: get weather',
    );
  });
});

describe('toolStepSuffix', () => {
  it('shows no step label for the first tool call (0-based index 0)', () => {
    expect(toolStepSuffix(0)).toBe('');
  });

  it('numbers subsequent calls by their 1-based ordinal', () => {
    // The regression this guards: a 1-based callIndex would make the first tool
    // render "(step 2)". With the correct 0-based contract, index 1 is the
    // SECOND tool and reads "(step 2)".
    expect(toolStepSuffix(1)).toBe(' (step 2)');
    expect(toolStepSuffix(2)).toBe(' (step 3)');
    expect(toolStepSuffix(4)).toBe(' (step 5)');
  });
});

describe('formatTurnFooter', () => {
  const result = {
    modelId: 'us.anthropic.claude-sonnet-4-6',
    latencyMs: 2100.4,
    costUsd: 0.0312,
    toolCallCount: 0,
    inputTokens: 12_300,
  };
  const on = { showFooter: true, showContext: false };

  it('renders model tail, latency, and cost with no tool segment for a tool-less turn', () => {
    expect(formatTurnFooter(result, 200_000, on)).toBe('\n\n_claude-sonnet-4-6 · 2100ms · $0.0312_');
  });

  it('pluralizes the tool count ("1 tool", "3 tools")', () => {
    // The regression this guards: the footer rendered "· 3 tool" on every
    // multi-tool turn on Telegram, both Slack paths, and the dashboard.
    expect(formatTurnFooter({ ...result, toolCallCount: 1 }, 200_000, on)).toContain('· 1 tool_');
    expect(formatTurnFooter({ ...result, toolCallCount: 3 }, 200_000, on)).toContain('· 3 tools_');
  });

  it('appends the context segment when showContext is on', () => {
    expect(formatTurnFooter(result, 200_000, { showFooter: true, showContext: true })).toBe(
      '\n\n_claude-sonnet-4-6 · 2100ms · $0.0312 · 12.3k/200.0k ctx (6%)_',
    );
  });

  it('renders a context-only footer when only showContext is on', () => {
    expect(formatTurnFooter(result, 200_000, { showFooter: false, showContext: true })).toBe(
      '\n\n_ctx: 12.3k/200.0k (6%)_',
    );
  });

  it('renders nothing when both flags are off', () => {
    expect(formatTurnFooter(result, 200_000, { showFooter: false, showContext: false })).toBe('');
  });
});
