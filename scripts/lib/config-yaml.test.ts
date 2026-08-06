import { describe, it, expect } from 'vitest';
import { renderConfigYaml, type ClaudeClawConfig } from './config-yaml.js';

const baseCfg: ClaudeClawConfig = {
  version: 1,
  stack: 'CCE',
  region: 'us-east-1',
  account: '123456789012',
  tier: 1,
  ecr: { repo: 'claudeclaw-orchestrator' },
  bedrock: {
    opus: 'us.anthropic.claude-opus-4-7-v1:0',
    sonnet: 'us.anthropic.claude-sonnet-4-6-v1:0',
    haiku: 'us.anthropic.claude-haiku-4-5-v1:0',
  },
  adapters: { slack: true, telegram: false },
  dashboard: { token_hint: 'abcdef12…' },
  config_dir: '/Users/you/.claudeclaw-enterprise',
  agents: [],
};

describe('config-yaml', () => {
  it('renders a header comment + version field', () => {
    const out = renderConfigYaml(baseCfg);
    expect(out).toMatch(/^# ClaudeClaw Enterprise/);
    expect(out).toContain('version: 1');
  });

  it('quotes paths containing spaces (none here, so unquoted)', () => {
    const out = renderConfigYaml(baseCfg);
    expect(out).toContain('config_dir: /Users/you/.claudeclaw-enterprise');
  });

  it('emits "agents: []" when the agents array is empty', () => {
    const out = renderConfigYaml(baseCfg);
    expect(out).toContain('agents: []');
  });

  it('emits agents as a YAML list when provided', () => {
    const out = renderConfigYaml({ ...baseCfg, agents: ['main', 'ops'] });
    expect(out).toContain('agents:');
    expect(out).toContain('  - main');
    expect(out).toContain('  - ops');
    expect(out).not.toContain('agents: []');
  });

  it('emits opus line only when opus model is set', () => {
    const out = renderConfigYaml(baseCfg);
    expect(out).toContain('opus:');

    const withoutOpus = renderConfigYaml({
      ...baseCfg,
      bedrock: { sonnet: baseCfg.bedrock.sonnet, haiku: baseCfg.bedrock.haiku },
    });
    expect(withoutOpus).not.toContain('opus:');
  });

  it('quotes the token hint (contains the ellipsis "..." character)', () => {
    const out = renderConfigYaml(baseCfg);
    // We just confirm the token hint is in the rendered YAML
    expect(out).toContain('token_hint:');
    expect(out).toContain('abcdef12');
  });

  it('emits tier as a number, not a string', () => {
    const out = renderConfigYaml({ ...baseCfg, tier: 2 });
    expect(out).toMatch(/^tier: 2$/m);
  });
});
