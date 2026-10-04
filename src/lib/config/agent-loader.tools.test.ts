/**
 * The role tool allowlist (`tools` in agents/<id>/agent.yaml) is a security
 * control: it must be read the way the pack validator reads it (a real YAML
 * parse), an unexpected shape must deny rather than allow, and "could not
 * read" must never look like "no allowlist". Drives the REAL `loadAgent`.
 */
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
const toolsOf = async (yaml: string, withPrompt = true) => {
  stubS3(yamlFor(yaml, withPrompt));
  return (await loadAgent('intake')).tools;
};

beforeEach(() => invalidateAgentCache(undefined, { refresh: false }));
afterEach(() => vi.restoreAllMocks());

describe('the role allowlist is read with a real YAML parse', () => {
  it.each([
    ['a block list', 'model: m\ntools:\n  - get_time\n  - mcp__crm__lookup\n', ['get_time', 'mcp__crm__lookup']],
    ['a flow list', 'tools: [get_time, mcp__crm__lookup]\n', ['get_time', 'mcp__crm__lookup']],
    ['a list with no indent', 'tools:\n- get_time\n- list_missions\n', ['get_time', 'list_missions']],
    ['quoted names', 'tools:\n  - "get_time"\n  - \'list_missions\'\n', ['get_time', 'list_missions']],
    ['CRLF line ends', 'tools:\r\n  - get_time\r\n', ['get_time']],
    ['an empty list', 'tools: []\n', []],
  ])('%s', async (_name, yaml, expected) => {
    expect(await toolsOf(yaml)).toEqual(expected);
  });

  it('the same answer for an agent with no CLAUDE.md (the builtin-fallback path)', async () => {
    expect(await toolsOf('tools: [get_time]\n', false)).toEqual(['get_time']);
  });

  it('no `tools` key means no allowlist', async () => {
    expect(await toolsOf('model: m\nknowledgeScope: clinical\n')).toBeUndefined();
  });

  it('a `tools` line inside a block scalar is text, not the allowlist', async () => {
    expect(await toolsOf('persona: |\n  You may use these.\n  tools:\n    - mcp__crm__update\n')).toBeUndefined();
  });

  it('a nested `tools` key is not the allowlist', async () => {
    expect(await toolsOf('limits:\n  tools:\n    - mcp__crm__update\n')).toBeUndefined();
  });
});

describe('an unexpected shape denies, it never allows', () => {
  it.each([
    ['a string', 'tools: everything\n'],
    ['a map', 'tools:\n  get_time: true\n'],
    ['a list holding a non-string', 'tools:\n  - get_time\n  - 7\n'],
    ['a list holding a map', 'tools:\n  - name: get_time\n'],
    ['null', 'tools:\n'],
    ['YAML that does not parse', 'tools: [get_time\nmodel: : :\n'],
  ])('%s gives an empty allowlist', async (_name, yaml) => {
    expect(await toolsOf(yaml)).toEqual([]);
  });
});

describe('"could not read" is never "no allowlist"', () => {
  const blip = () => Object.assign(new Error('We encountered an internal error'), { name: 'InternalError' });

  it('a storage error on agent.yaml fails the load', async () => {
    stubS3(yamlFor(blip()));
    await expect(loadAgent('intake')).rejects.toThrow();
  });

  it('a storage error on agent.yaml fails the load on the builtin-fallback path too', async () => {
    stubS3(yamlFor(blip(), false));
    await expect(loadAgent('intake')).rejects.toThrow();
  });

  it('the failure is not cached: the next load reads the allowlist', async () => {
    stubS3(yamlFor(blip()));
    await loadAgent('intake').catch(() => {});
    vi.restoreAllMocks();
    stubS3(yamlFor('tools: [get_time]\n'));
    expect((await loadAgent('intake')).tools).toEqual(['get_time']);
  });

  it('a missing agent.yaml is normal: the agent loads with no allowlist', async () => {
    stubS3({ 'agents/intake/CLAUDE.md': 'you are intake' });
    expect((await loadAgent('intake')).tools).toBeUndefined();
  });
});
