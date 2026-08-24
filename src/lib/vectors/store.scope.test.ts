/**
 * Scope-folding regression guard.
 *
 * Scopes are operator-supplied (`knowledgeScope` in `agents/<id>/agent.yaml`,
 * free-form and unvalidated) and the documented format includes values like
 * `agent:ops`. The write path folded a scope to a safe S3 segment; the read
 * path interpolated the raw string. So `agent:ops` was written to
 * `index/agent_ops/` and listed from `index/agent:ops/` — every lookup came
 * back empty, with no error and nothing actually missing.
 *
 * Both paths now go through `normalizeScope`. These tests pin that.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// store.ts captures INDEX_BUCKET at module load, so this must be set before
// the import below is evaluated. vi.hoisted runs above the import graph.
vi.hoisted(() => {
  process.env.VECTORS_BUCKET = 'test-index-bucket';
});
import { normalizeScope, indexPrefixFor, keyFor } from './store.js';

describe('normalizeScope', () => {
  it('folds the documented `agent:<id>` scope form', () => {
    // store.ts's own docblock advertises "agent:ops" as a scope.
    expect(normalizeScope('agent:ops')).toBe('agent_ops');
  });

  it('folds every character S3 prefixes should not carry', () => {
    expect(normalizeScope('tenant:acme corp/2026')).toBe('tenant_acme_corp_2026');
  });

  it('leaves an already-safe scope untouched', () => {
    expect(normalizeScope('default')).toBe('default');
    expect(normalizeScope('agent_ops-v2')).toBe('agent_ops-v2');
  });

  it('is idempotent, so re-folding a stored scope cannot drift', () => {
    for (const raw of ['agent:ops', 'default', 'tenant:acme corp', 'a/b/c']) {
      expect(normalizeScope(normalizeScope(raw))).toBe(normalizeScope(raw));
    }
  });

  it('never emits a character that would split an S3 prefix', () => {
    expect(normalizeScope('a/b')).not.toContain('/');
  });
});

/**
 * The invariant that actually matters.
 *
 * Testing `normalizeScope` alone did NOT pin it. Reverting `iterateRows` to a
 * hand-built `index/${scope}/` template left every test above green while
 * reads silently returned empty again -- verified by mutation, not assumed.
 * This drives the REAL read path and asserts the prefix S3 is actually asked
 * for, which is the property the incident violated.
 */
describe('the read path lists the prefix the write path writes', () => {
  afterEach(() => vi.restoreAllMocks());

  async function prefixAskedFor(scope: string): Promise<string> {
    const { S3Client } = await import('@aws-sdk/client-s3');
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({ Contents: [] } as never);
    const { iterateRows } = await import('./store.js');
    for await (const _ of iterateRows(scope)) void _;
    const cmd = send.mock.calls[0][0] as unknown as { input: { Prefix: string } };
    return cmd.input.Prefix;
  }

  it('asks S3 for the folded prefix, not the raw scope', async () => {
    expect(await prefixAskedFor('agent:ops')).toBe('index/agent_ops/');
  });

  it('asks for a prefix the written key actually falls under', async () => {
    const { keyFor } = await import('./store.js');
    for (const scope of ['agent:ops', 'tenant:acme corp/2026', 'default']) {
      const prefix = await prefixAskedFor(scope);
      expect(keyFor(scope, 'doc-1').startsWith(prefix)).toBe(true);
    }
  });
});
