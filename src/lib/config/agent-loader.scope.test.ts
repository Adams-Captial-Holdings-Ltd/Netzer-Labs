/**
 * Own-knowledge-scope resolution guard.
 *
 * `fetchKnowledgeScope` (which reads `agents/<id>/agent.yaml`) used to be
 * called only AFTER `fetchFromS3` had successfully read `agents/<id>/CLAUDE.md`.
 * An agent configured with an agent.yaml but no CLAUDE.md therefore fell
 * through to `BUILTIN_AGENTS[agentId] ?? BUILTIN_AGENTS.main` -- none of which
 * declare a knowledgeScope -- and silently searched the 'default' corpus. No
 * error, no log. The read is now hoisted into `loadAgent` so it also runs on
 * the builtin-fallback path.
 *
 * These drive the REAL `loadAgent`, not `fetchKnowledgeScope` in isolation.
 * The sibling guard in src/lib/vectors/store.scope.test.ts documents that
 * testing the helper alone did not pin the equivalent bug there; only driving
 * the real path did.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// agent-loader captures CONFIG_BUCKET into a module-level const at import, so
// it has to be set above the import graph. It must be set at all: with no
// bucket `fetchKnowledgeScope` short-circuits on its own `if (!bucket)` guard,
// and the agent.yaml-without-CLAUDE.md case could never be observed. The
// "no CLAUDE.md" branch is instead reached the way it is reached in
// production -- the object 404s.
vi.hoisted(() => {
  process.env.CONFIG_BUCKET = 'test-config-bucket';
});

// Keep DynamoDB out of it: loadAgent reads the agent row for the model
// override, and invalidateAgentCache can kick off a full agents scan.
vi.mock('../state/agents-repo.js', () => ({
  getAgent: vi.fn(async () => null),
  listAgents: vi.fn(async () => []),
}));

import { S3Client } from '@aws-sdk/client-s3';
import { loadAgent, invalidateAgentCache } from './agent-loader.js';

/** Serve S3 objects from a key -> body map; every other key 404s. */
function stubS3(objects: Record<string, string>) {
  return vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (cmd: {
    input: { Key: string };
  }) => {
    const body = objects[cmd.input.Key];
    if (body === undefined) {
      throw Object.assign(new Error('no such key'), { name: 'NoSuchKey' });
    }
    return { Body: { transformToString: async () => body } };
  }) as never);
}

beforeEach(() => {
  // loadAgent has a 5-minute in-memory cache keyed by agentId.
  // { refresh: false } skips the DDB agents scan the default path fires.
  invalidateAgentCache(undefined, { refresh: false });
});
afterEach(() => vi.restoreAllMocks());

describe('knowledge scope resolves without a CLAUDE.md', () => {
  it('reads agent.yaml for an agent that has no CLAUDE.md', async () => {
    stubS3({ 'agents/sales/agent.yaml': 'knowledgeScope: sales-corpus\n' });
    expect((await loadAgent('sales')).knowledgeScope).toBe('sales-corpus');
  });

  it('reads agent.yaml for a builtin agent that has no CLAUDE.md', async () => {
    // Different fallback branch: BUILTIN_AGENTS[agentId], not BUILTIN_AGENTS.main.
    stubS3({ 'agents/ops/agent.yaml': 'model: some-model\nknowledgeScope: ops-corpus\n' });
    expect((await loadAgent('ops')).knowledgeScope).toBe('ops-corpus');
  });

  it('falls back to the default scope when nothing is configured', async () => {
    stubS3({});
    expect((await loadAgent('ghost')).knowledgeScope).toBe('default');
  });

  it('still resolves from CLAUDE.md + agent.yaml without a second yaml GET', async () => {
    const send = stubS3({
      'agents/research/CLAUDE.md': 'You are Research.',
      'agents/research/agent.yaml': 'knowledgeScope: research-corpus\n',
    });
    expect((await loadAgent('research')).knowledgeScope).toBe('research-corpus');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
