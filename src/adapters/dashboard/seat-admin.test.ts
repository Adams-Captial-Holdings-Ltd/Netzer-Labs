import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// Bearer string -> principal, mirroring authz-matrix.test.ts: the token IS the
// templated profile id; capability resolution stays REAL so these tests prove
// the actual gates, not a stub of them. seat-user principals carry a userId
// (magic-link session shape); the org-admin/admin/owner shapes vary to cover
// the /me identity edge (owner break-glass has NO userId).
function principalFor(raw: string): TokenPrincipal | null {
  const id = raw.replace(/^Bearer\s+/i, '');
  if (id === 'seat-user') {
    return {
      tokenHash: 'hash-seat-user',
      label: 'seat user',
      hashPrefix16: 'seatuser',
      role: 'viewer',
      profileId: 'seat-user',
      userId: 'user-1',
    };
  }
  if (id === 'org-admin') {
    return {
      tokenHash: 'hash-org-admin',
      label: 'org admin',
      hashPrefix16: 'orgadmin',
      role: 'admin',
      profileId: 'org-admin',
      userId: 'user-admin',
    };
  }
  if (id === 'viewer' || id === 'operator' || id === 'admin') {
    return { tokenHash: `hash-${id}`, label: id, hashPrefix16: id, role: id };
  }
  if (id === 'owner') {
    return {
      tokenHash: 'hash-owner',
      label: 'Root token',
      hashPrefix16: 'owner',
      role: 'admin',
      profileId: 'owner',
    };
  }
  return null;
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (authHeader?: string) =>
      (authHeader ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
  };
});

vi.mock('../../lib/audit/audit-writer.js', () => ({
  writeAudit: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  truncateForLog: (s: string) => s,
}));

const repo = {
  getSeat: vi.fn(),
  getSeatForUser: vi.fn(),
  getSeatPolicy: vi.fn(),
  listSeatPolicies: vi.fn(),
  listSeats: vi.fn(),
  listSeatUsage: vi.fn(),
  listSeatUsageForSeat: vi.fn(),
  putSeat: vi.fn(),
  putSeatPolicy: vi.fn(),
};
vi.mock('../../lib/admin/seat-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/admin/seat-repo.js')>();
  return {
    ...actual,
    getSeat: (...a: unknown[]) => repo.getSeat(...a),
    getSeatForUser: (...a: unknown[]) => repo.getSeatForUser(...a),
    getSeatPolicy: (...a: unknown[]) => repo.getSeatPolicy(...a),
    listSeatPolicies: (...a: unknown[]) => repo.listSeatPolicies(...a),
    listSeats: (...a: unknown[]) => repo.listSeats(...a),
    listSeatUsage: (...a: unknown[]) => repo.listSeatUsage(...a),
    listSeatUsageForSeat: (...a: unknown[]) => repo.listSeatUsageForSeat(...a),
    putSeat: (...a: unknown[]) => repo.putSeat(...a),
    putSeatPolicy: (...a: unknown[]) => repo.putSeatPolicy(...a),
  };
});

import { buildSeatAdminRouter } from './seat-admin.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';

const seat = {
  seatId: 'seat-1',
  userId: 'user-1',
  status: 'active',
  policyId: 'pol-1',
  createdAt: '2026-07-01T00:00:00.000Z',
  createdBy: 'org admin',
  updatedAt: '2026-07-01T00:00:00.000Z',
  updatedBy: 'org admin',
};
const policy = {
  policyId: 'pol-1',
  label: 'Default',
  allowedModels: ['us.anthropic.claude-haiku-4-5'],
  allowedTools: [],
  createdAt: '2026-07-01T00:00:00.000Z',
  createdBy: 'org admin',
  updatedAt: '2026-07-01T00:00:00.000Z',
  updatedBy: 'org admin',
};

function req(path: string, token: string | null, init: RequestInit = {}) {
  const router = buildSeatAdminRouter();
  const headers: Record<string, string> = {
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  return router.request(path, { ...init, headers });
}

beforeEach(() => {
  for (const fn of Object.values(repo)) fn.mockReset();
  repo.listSeats.mockResolvedValue({ items: [seat] });
  repo.listSeatPolicies.mockResolvedValue({ items: [policy] });
  repo.listSeatUsage.mockResolvedValue({ items: [] });
  repo.listSeatUsageForSeat.mockResolvedValue({ items: [] });
  repo.getSeatPolicy.mockResolvedValue(policy);
  repo.getSeat.mockResolvedValue(seat);
  repo.getSeatForUser.mockResolvedValue(null);
  repo.putSeat.mockImplementation((s: unknown) => Promise.resolve(s));
  repo.putSeatPolicy.mockImplementation((p: unknown) => Promise.resolve(p));
  vi.mocked(writeAudit).mockClear();
});

describe('authn', () => {
  it('401s without a token on every route group', async () => {
    for (const path of ['/', '/policies', '/usage', '/me']) {
      const res = await req(path, null);
      expect(res.status).toBe(401);
    }
  });
});

describe('seat administration gates', () => {
  it.each([
    ['viewer', 403],
    ['operator', 403],
    ['admin', 403],
    ['seat-user', 403],
    ['org-admin', 200],
    ['owner', 200],
  ])('GET /seats as %s -> %i', async (token, status) => {
    const res = await req('/', token as string);
    expect(res.status).toBe(status);
  });

  it('plain admin cannot create a seat (seats:write is org-admin tier)', async () => {
    const res = await req('/', 'admin', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-2', policyId: 'pol-1' }),
    });
    expect(res.status).toBe(403);
    expect(repo.putSeat).not.toHaveBeenCalled();
  });

  it('org-admin creates a seat: validates the policy, refuses a second seat, audits', async () => {
    const created = await req('/', 'org-admin', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-2', policyId: 'pol-1' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { userId: string; status: string };
    expect(body.userId).toBe('user-2');
    expect(body.status).toBe('active');
    expect(vi.mocked(writeAudit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'seat_created', operatorLabel: 'org admin' }),
    );

    repo.getSeatForUser.mockResolvedValue(seat);
    const dup = await req('/', 'org-admin', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-1', policyId: 'pol-1' }),
    });
    expect(dup.status).toBe(409);
  });

  it('rejects an unknown policy and an invalid status', async () => {
    repo.getSeatPolicy.mockResolvedValue(null);
    const badPolicy = await req('/', 'org-admin', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-2', policyId: 'nope' }),
    });
    expect(badPolicy.status).toBe(400);

    const badStatus = await req('/', 'org-admin', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-2', policyId: 'pol-1', status: 'banana' }),
    });
    expect(badStatus.status).toBe(400);
  });

  it('PATCH /seats/:seatId updates status and audits', async () => {
    const res = await req('/seat-1', 'org-admin', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'suspended' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; updatedBy: string };
    expect(body.status).toBe('suspended');
    expect(body.updatedBy).toBe('org admin');
    expect(vi.mocked(writeAudit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'seat_updated' }),
    );
  });
});

describe('policy routes', () => {
  it('org-admin creates a policy with sanitized fields', async () => {
    const res = await req('/policies', 'org-admin', {
      method: 'POST',
      body: JSON.stringify({
        label: '  Team policy  ',
        allowedModels: ['us.anthropic.claude-haiku-4-5'],
        monthlySpendLimitUsd: 25,
        junk: 'dropped',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.label).toBe('Team policy');
    expect(body.monthlySpendLimitUsd).toBe(25);
    expect(body.junk).toBeUndefined();
  });

  it('seat-user cannot even read policies', async () => {
    const res = await req('/policies', 'seat-user');
    expect(res.status).toBe(403);
  });
});

describe('usage routes', () => {
  it('org usage requires usage:org:read and validates the date', async () => {
    expect((await req('/usage', 'admin')).status).toBe(403);
    expect((await req('/usage?date=07-01-2026', 'org-admin')).status).toBe(400);
    const ok = await req('/usage?date=2026-07-01', 'org-admin');
    expect(ok.status).toBe(200);
    expect(repo.listSeatUsage).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-07-01' }),
    );
  });
});

describe('self-service scoping', () => {
  it('GET /me returns only the CALLER\'s seat, resolved from the principal', async () => {
    repo.getSeatForUser.mockResolvedValue(seat);
    const res = await req('/me', 'seat-user');
    expect(res.status).toBe(200);
    expect(repo.getSeatForUser).toHaveBeenCalledWith('user-1');
    const body = (await res.json()) as { seat: { seatId: string } };
    expect(body.seat.seatId).toBe('seat-1');
  });

  it('GET /me/usage queries the caller seat partition only', async () => {
    repo.getSeatForUser.mockResolvedValue(seat);
    const res = await req('/me/usage?date=2026-07-01', 'seat-user');
    expect(res.status).toBe(200);
    expect(repo.listSeatUsageForSeat).toHaveBeenCalledWith(
      expect.objectContaining({ seatId: 'seat-1', date: '2026-07-01' }),
    );
  });

  it('404s when the caller has no seat, and for principals with no userId', async () => {
    repo.getSeatForUser.mockResolvedValue(null);
    expect((await req('/me', 'seat-user')).status).toBe(404);
    // owner break-glass has no userId -> no seat, even though caps allow.
    expect((await req('/me', 'owner')).status).toBe(404);
  });

  it('viewer lacks usage:self:read entirely', async () => {
    expect((await req('/me', 'viewer')).status).toBe(403);
  });
});
