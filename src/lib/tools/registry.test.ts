import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tools } from './registry.js';
import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';

const spec: BedrockTool = {
  toolSpec: { name: 'gated_tool', description: 't', inputSchema: { json: { type: 'object' } } },
};

const ctx = (agentId: string) => ({ agentId, chatId: 'c1' });

describe('ToolRegistry.invoke allowedAgents enforcement', () => {
  const impl = vi.fn(async () => ({ text: 'ran' }));

  beforeEach(() => {
    impl.mockClear();
    tools.register('gated_tool', {
      spec,
      invoke: impl,
      allowedAgents: new Set(['ops']),
    });
  });

  it('runs the handler for an allowed agent', async () => {
    const out = await tools.invoke('gated_tool', {}, ctx('ops'));
    expect(out.text).toBe('ran');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('blocks a disallowed agent at dispatch, without running the handler', async () => {
    const out = await tools.invoke('gated_tool', {}, ctx('research'));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/not authorized/i);
    expect(impl).not.toHaveBeenCalled();
  });

  it('an empty/unset allowlist means every agent (backwards compatible)', async () => {
    const openImpl = vi.fn(async () => ({ text: 'open' }));
    tools.register('open_tool', { spec, invoke: openImpl });
    const out = await tools.invoke('open_tool', {}, ctx('anyone'));
    expect(out.text).toBe('open');
    expect(openImpl).toHaveBeenCalledTimes(1);
  });
});
