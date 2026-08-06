import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TokenRecord } from '../state/tokens-repo.js';

// Control lookupToken; keep hashToken / isExpired real so we exercise the
// genuine expiry + hashing logic.
const lookupMock = vi.fn<(hash: string) => Promise<TokenRecord | null>>();
vi.mock('../state/tokens-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/tokens-repo.js')>();
  return {
    ...actual,
    lookupToken: (hash: string) => lookupMock(hash),
    touchLastUsed: () => Promise.resolve(),
    seedRootToken: () => Promise.resolve(),
  };
});

import { authenticateDashboardToken } from './dashboard-auth.js';

const ENV_TOKEN = 'r'.repeat(64); // root token, fixed length
const OP_TOKEN = 'o'.repeat(40); // operator token, different length

function record(over: Partial<TokenRecord>): TokenRecord {
  return {
    tokenHash: 'h',
    label: 'l',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    active: true,
    role: 'operator',
    ...over,
  };
}

describe('authenticateDashboardToken', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    process.env.DASHBOARD_TOKEN = ENV_TOKEN;
  });

  it('rejects empty input', async () => {
    expect(await authenticateDashboardToken('')).toBeNull();
  });

  it('rejects an unknown token', async () => {
    lookupMock.mockResolvedValue(null);
    expect(await authenticateDashboardToken('nope')).toBeNull();
  });

  it('accepts the env root token as admin when DDB record is active', async () => {
    lookupMock.mockResolvedValue(record({ role: 'admin', active: true }));
    const p = await authenticateDashboardToken(ENV_TOKEN);
    expect(p?.role).toBe('admin');
    expect(p?.label).toBe('Root token');
  });

  it('fails CLOSED (denies) for the env root token when the revoke lookup throws a real error', async () => {
    // M3: a throttle / IAM blip / network error reading the revoke row must not
    // let a possibly-revoked root token through. Deny.
    lookupMock.mockRejectedValue(new Error('throttled'));
    const p = await authenticateDashboardToken(ENV_TOKEN);
    expect(p).toBeNull();
  });

  it('still allows the env root token during bootstrap when the table does not exist', async () => {
    // The one fail-open exception: there is no revoke list to consult yet.
    const notFound = Object.assign(new Error('Requested resource not found'), {
      name: 'ResourceNotFoundException',
    });
    lookupMock.mockRejectedValue(notFound);
    const p = await authenticateDashboardToken(ENV_TOKEN);
    expect(p?.role).toBe('admin');
  });

  it('rejects the env root token once its DDB record is revoked', async () => {
    lookupMock.mockResolvedValue(record({ role: 'admin', active: false }));
    expect(await authenticateDashboardToken(ENV_TOKEN)).toBeNull();
  });

  it('rejects the env root token once its DDB record is expired', async () => {
    lookupMock.mockResolvedValue(
      record({ role: 'admin', active: true, expiresAt: '2000-01-01T00:00:00.000Z' }),
    );
    expect(await authenticateDashboardToken(ENV_TOKEN)).toBeNull();
  });

  it('returns the stored role for an active per-operator token', async () => {
    lookupMock.mockResolvedValue(record({ role: 'viewer', active: true }));
    const p = await authenticateDashboardToken(OP_TOKEN);
    expect(p?.role).toBe('viewer');
  });

  it('rejects an inactive per-operator token', async () => {
    lookupMock.mockResolvedValue(record({ active: false }));
    expect(await authenticateDashboardToken(OP_TOKEN)).toBeNull();
  });

  it('rejects an expired per-operator token even when active', async () => {
    lookupMock.mockResolvedValue(
      record({ active: true, expiresAt: '2000-01-01T00:00:00.000Z' }),
    );
    expect(await authenticateDashboardToken(OP_TOKEN)).toBeNull();
  });

  it('honors a future expiry on a per-operator token', async () => {
    lookupMock.mockResolvedValue(
      record({ active: true, role: 'operator', expiresAt: '2999-01-01T00:00:00.000Z' }),
    );
    const p = await authenticateDashboardToken(OP_TOKEN);
    expect(p?.role).toBe('operator');
    expect(p?.expiresAt).toBe('2999-01-01T00:00:00.000Z');
  });
});
