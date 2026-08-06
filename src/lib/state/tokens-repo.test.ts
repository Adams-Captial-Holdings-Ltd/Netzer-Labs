import { describe, it, expect } from 'vitest';
import { isExpired, isTokenRole, TOKEN_ROLES } from './tokens-repo.js';

describe('isTokenRole', () => {
  it('accepts the three known roles', () => {
    for (const r of TOKEN_ROLES) expect(isTokenRole(r)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const v of ['', 'root', 'superuser', undefined, null, 1, {}]) {
      expect(isTokenRole(v)).toBe(false);
    }
  });
});

describe('isExpired', () => {
  const NOW = Date.parse('2026-05-28T00:00:00.000Z');

  it('treats a missing expiry as never-expiring', () => {
    expect(isExpired({}, NOW)).toBe(false);
  });

  it('treats a future expiry as not expired', () => {
    expect(isExpired({ expiresAt: '2999-01-01T00:00:00.000Z' }, NOW)).toBe(false);
  });

  it('treats a past expiry as expired', () => {
    expect(isExpired({ expiresAt: '2000-01-01T00:00:00.000Z' }, NOW)).toBe(true);
  });

  it('ignores an unparseable expiry rather than locking out', () => {
    expect(isExpired({ expiresAt: 'not-a-date' }, NOW)).toBe(false);
  });
});
