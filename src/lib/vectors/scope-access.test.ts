import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { Capability } from '../auth/permissions.js';
import { canReadScope, scopeHash, normalizeScope, PUBLIC_SCOPES, RESERVED_SCOPE_PREFIX } from './scope-access.js';

const READ = new Set<Capability>(['vectors:read']);
const PRIVATE = new Set<Capability>(['vectors:read', 'knowledge:private:read' as Capability]);
const NONE = new Set<Capability>();

describe('NZR-5 canReadScope', () => {
  it('exposes the public scopes and the reserved prefix', () => {
    expect(PUBLIC_SCOPES).toEqual(['default', 'shared']);
    expect(RESERVED_SCOPE_PREFIX).toBe('chat_');
  });

  it.each(['default', 'shared'])('%s is readable with vectors:read and not without', (scope) => {
    expect(canReadScope(READ, scope)).toBe(true);
    expect(canReadScope(NONE, scope)).toBe(false);
  });

  it.each(['DEFAULT', 'shared_', 'shared ', 'ops_private', 'finance.private', 'chat_x', 'no_such_scope'])(
    '%s needs knowledge:private:read',
    (scope) => {
      expect(canReadScope(READ, scope)).toBe(false);
      expect(canReadScope(PRIVATE, scope)).toBe(true);
    },
  );

  it('refuses the empty string for everyone', () => {
    expect(canReadScope(PRIVATE, '')).toBe(false);
  });

  it('hashes the normalized name to 12 hex chars', () => {
    const expected = createHash('sha256').update('finance_private').digest('hex').slice(0, 12);
    expect(scopeHash('finance.private')).toBe(expected);
    expect(scopeHash('finance_private')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('normalizeScope folds like the store does', () => {
    expect(normalizeScope('finance/private')).toBe('finance_private');
    expect(normalizeScope('agent:ops')).toBe('agent_ops');
  });
});
