import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('./ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('./ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});

import { isExpired, isTokenRole, linkTokenToUser, TOKEN_ROLES } from './tokens-repo.js';

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

/**
 * Owner decision 1: a token with no user of its own is bound to ONE user by an
 * audited admin action, and the binding never moves. The condition expression is
 * what makes "never moves" true under a race, so it is asserted directly.
 */
describe('linkTokenToUser', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    PK: 'TOKEN#h', SK: 'META', tokenHash: 'h', label: 'Root token', createdAt: 'x', lastUsedAt: 'x',
    createdBy: 'system', active: true, role: 'admin', ...over,
  });

  beforeEach(() => send.mockReset());

  it('links a token with no user behind a condition that makes the link immutable', async () => {
    send.mockResolvedValueOnce({ Items: [row()] }).mockResolvedValueOnce({});

    await expect(linkTokenToUser('h', 'user-a', 'dashboard:hash-admin')).resolves.toBe('linked');

    const update = send.mock.calls[1]?.[0]?.input as Record<string, unknown>;
    expect(update.Key).toEqual({ PK: 'TOKEN#h', SK: 'META' });
    expect(update.ConditionExpression).toContain('attribute_not_exists(linkedUserId)');
    expect(update.ConditionExpression).toContain('attribute_not_exists(userId)');
    expect((update.ExpressionAttributeValues as Record<string, unknown>)[':u']).toBe('user-a');
  });

  it('refuses a token that does not exist, without writing', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    await expect(linkTokenToUser('h', 'user-a', 'x')).resolves.toBe('not_found');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses a session token, which already has its own user', async () => {
    send.mockResolvedValueOnce({ Items: [row({ userId: 'user-b' })] });
    await expect(linkTokenToUser('h', 'user-a', 'x')).resolves.toBe('session_token');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses to move a link that already exists', async () => {
    send.mockResolvedValueOnce({ Items: [row({ linkedUserId: 'user-b' })] });
    await expect(linkTokenToUser('h', 'user-a', 'x')).resolves.toBe('already_linked');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports a race lost to another admin as already linked, not as a failure', async () => {
    send
      .mockResolvedValueOnce({ Items: [row()] })
      .mockRejectedValueOnce(Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' }));
    await expect(linkTokenToUser('h', 'user-a', 'x')).resolves.toBe('already_linked');
  });

  it('does not swallow any other write error', async () => {
    send.mockResolvedValueOnce({ Items: [row()] }).mockRejectedValueOnce(new Error('throttled'));
    await expect(linkTokenToUser('h', 'user-a', 'x')).rejects.toThrow('throttled');
  });
});
