import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.CONFIG_BUCKET = 'test-config-bucket';
});
vi.mock('../state/agents-repo.js', () => ({
  getAgent: vi.fn(async () => null),
  listAgents: vi.fn(async () => []),
}));

import { S3Client } from '@aws-sdk/client-s3';
import { loadAgent, invalidateAgentCache } from './agent-loader.js';

type Served = string | Error;
function stubS3(objects: Record<string, Served>) {
  return vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (cmd: { input: { Key: string } }) => {
    const body = objects[cmd.input.Key];
    if (body === undefined) throw Object.assign(new Error('no such key'), { name: 'NoSuchKey' });
    if (body instanceof Error) throw body;
    return { Body: { transformToString: async () => body } };
  }) as never);
}
const yamlFor = (yaml: Served, withPrompt = true) => ({
  ...(withPrompt ? { 'agents/intake/CLAUDE.md': 'you are intake' } : {}),
  'agents/intake/agent.yaml': yaml,
});
const toolsOf = async (yaml: string) => {
  stubS3(yamlFor(yaml));
  return (await loadAgent('intake')).tools;
};

beforeEach(() => invalidateAgentCache(undefined, { refresh: false }));
afterEach(() => vi.restoreAllMocks());

describe('agent.yaml top-level document shape', () => {
  it('a comments-only agent.yaml means no allowlist', async () => {
    expect(await toolsOf('# tools: [get_time]\n\n# config pending\n')).toBeUndefined();
  });

  it('a top-level list or scalar document denies', async () => {
    expect(await toolsOf('- get_time\n- list_missions\n')).toEqual([]);

    invalidateAgentCache(undefined, { refresh: false });
    vi.restoreAllMocks();
    expect(await toolsOf('just-a-scalar\n')).toEqual([]);
  });
});
