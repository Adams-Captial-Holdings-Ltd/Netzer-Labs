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
import { describe, it, expect } from 'vitest';
import { normalizeScope } from './store.js';

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
