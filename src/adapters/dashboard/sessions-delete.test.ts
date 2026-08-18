import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * DELETE /sessions — authorization contract for Delete Chat.
 *
 * The security property under test is that ownership is decided from the
 * STORED row against the AUTHENTICATED principal, never from anything the
 * client sends. A hand-edited chatId must not reach another user's
 * conversation, and must not be distinguishable from a chatId that does not
 * exist (otherwise the route is an enumeration oracle for other users' chats).
 *
 * These drive the REAL buildDashboardRouter through app.request() with the
 * sessions repo mocked, so every authorization branch actually executes. The
 * negative cases assert that deleteSession was NOT called — a route that
 * deletes first and rejects afterwards would still pass a status-only check.
 *
 * Capability tiers (permissions.ts): viewer has no agents:write; operator has
 * agents:write but NOT security:write; admin has both.
 */

const { authenticateDashboardToken, getSession, deleteSession, writeAudit, send } = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(),
  getSession: vi.fn(),
  deleteSession: vi.fn(),
  writeAudit: vi.fn(),
  send: vi.fn(),
}));

// dashboardIdentity() hashes the bearer into `dashboard:<tokenHash>`, so these
// tokenHashes are what the stored row's `userId` is compared against.
function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

const OPERATOR_IDENTITY = 'dashboard:hash-operator';
const ADMIN_IDENTITY = 'dashboard:hash-admin';
const SOMEONE_ELSE = 'dashboard:hash-a-different-user';

// Keep the REAL capability resolution; stub only token extraction/authentication
// so auth is driven by role string (same approach as usage-all-agents.test.ts).
vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => authenticateDashboardToken(raw),
  };
});

vi.mock('../../lib/state/sessions-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/sessions-repo.js')>();
  return {
    ...actual,
    getSession: (agentId: string, chatId: string) => getSession(agentId, chatId),
    deleteSession: (agentId: string, chatId: string) => deleteSession(agentId, chatId),
  };
});

vi.mock('../../lib/audit/audit-writer.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/audit/audit-writer.js')>();
  return { ...actual, writeAudit: (event: unknown) => writeAudit(event) };
});

// Defensive: nothing in this route should reach DDB, but the router builds many
// others, so keep AWS out of the process entirely.
vi.mock('../../lib/state/ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';

const AGENT = 'main';
const CHAT = 'dashboard:1750000000000';

function makeApp() {
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  return app;
}

function del(role: string | undefined, query = `?agentId=${AGENT}&chatId=${encodeURIComponent(CHAT)}`) {
  const headers: Record<string, string> = {};
  if (role) headers.Authorization = `Bearer ${role}`;
  return makeApp().request(`/api/sessions${query}`, { method: 'DELETE', headers });
}

const readJson = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

/** A stored session row owned by `userId`. */
function sessionOwnedBy(userId: string | undefined) {
  return {
    agentId: AGENT,
    chatId: CHAT,
    turns: [{ role: 'user', text: 'hello', ts: 1 }],
    updatedAt: 1,
    ...(userId === undefined ? {} : { userId }),
  };
}

beforeEach(() => {
  authenticateDashboardToken.mockReset();
  getSession.mockReset();
  deleteSession.mockReset();
  writeAudit.mockReset();
  send.mockReset();
  authenticateDashboardToken.mockImplementation(async (raw: string) => principalFor(raw));
  deleteSession.mockResolvedValue(undefined);
  writeAudit.mockResolvedValue(undefined);
});

describe('DELETE /sessions — the owner', () => {
  it('deletes their own chat and removes exactly that row', async () => {
    getSession.mockResolvedValue(sessionOwnedBy(OPERATOR_IDENTITY));

    const res = await del('operator');

    expect(res.status).toBe(200);
    await expect(readJson(res)).resolves.toMatchObject({ deleted: true, agentId: AGENT, chatId: CHAT });
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith(AGENT, CHAT);
  });

  it('records an audit row that is not an admin override', async () => {
    getSession.mockResolvedValue(sessionOwnedBy(OPERATOR_IDENTITY));

    await del('operator');

    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'data_purged',
        agentId: AGENT,
        chatId: CHAT,
        detail: expect.objectContaining({
          scope: 'session',
          requestedBy: OPERATOR_IDENTITY,
          viaAdminOverride: false,
        }),
      }),
    );
  });
});

describe('DELETE /sessions — someone else\'s chat', () => {
  it('refuses to delete a chat owned by another user', async () => {
    getSession.mockResolvedValue(sessionOwnedBy(SOMEONE_ELSE));

    const res = await del('operator');

    expect(res.status).toBe(404);
    // The security assertion that matters: the row was never touched.
    expect(deleteSession).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('is indistinguishable from a chat that does not exist', async () => {
    getSession.mockResolvedValue(sessionOwnedBy(SOMEONE_ELSE));
    const notMine = await del('operator');
    const notMineBody = await notMine.text();

    getSession.mockResolvedValue(null);
    const missing = await del('operator');
    const missingBody = await missing.text();

    // Same status AND same bytes — no enumeration oracle for other users' ids.
    expect(notMine.status).toBe(missing.status);
    expect(notMineBody).toBe(missingBody);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('refuses a row that carries no owner at all (legacy / other surface)', async () => {
    getSession.mockResolvedValue(sessionOwnedBy(undefined));

    const res = await del('operator');

    expect(res.status).toBe(404);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('does not treat an undefined stored owner as matching an unknown identity', async () => {
    // Guards the `session.userId !== undefined` half of the ownership test: if
    // that were dropped, an unauthenticated-ish identity could match undefined.
    getSession.mockResolvedValue(sessionOwnedBy(undefined));

    const res = await del('operator');

    expect(res.status).toBe(404);
    expect(deleteSession).not.toHaveBeenCalled();
  });
});

describe('DELETE /sessions — admin override', () => {
  it('lets an admin delete another user\'s chat and flags it in the audit', async () => {
    getSession.mockResolvedValue(sessionOwnedBy(SOMEONE_ELSE));

    const res = await del('admin');

    expect(res.status).toBe(200);
    expect(deleteSession).toHaveBeenCalledWith(AGENT, CHAT);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ requestedBy: ADMIN_IDENTITY, viaAdminOverride: true }),
      }),
    );
  });

  it('lets an admin delete an ownerless legacy row', async () => {
    getSession.mockResolvedValue(sessionOwnedBy(undefined));

    const res = await del('admin');

    expect(res.status).toBe(200);
    expect(deleteSession).toHaveBeenCalledWith(AGENT, CHAT);
  });
});

describe('DELETE /sessions — gates and inputs', () => {
  it('rejects a principal without agents:write', async () => {
    getSession.mockResolvedValue(sessionOwnedBy('dashboard:hash-viewer'));

    const res = await del('viewer');

    expect(res.status).toBe(403);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request', async () => {
    const res = await del(undefined);

    expect(res.status).toBe(401);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('requires a chatId', async () => {
    const res = await del('operator', `?agentId=${AGENT}`);

    expect(res.status).toBe(400);
    await expect(readJson(res)).resolves.toMatchObject({ error: 'chatId_required' });
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('does not resolve a session before the capability gate has passed', async () => {
    // Ordering check: a viewer must be turned away before any row is read, so a
    // denied principal cannot use timing/side effects to probe for existence.
    await del('viewer');

    expect(getSession).not.toHaveBeenCalled();
  });
});

describe('DELETE /sessions — repeated attempts', () => {
  it('answers 404 on a second delete instead of throwing', async () => {
    getSession.mockResolvedValueOnce(sessionOwnedBy(OPERATOR_IDENTITY));
    const first = await del('operator');
    expect(first.status).toBe(200);

    // The row is gone now, so the repo reports nothing.
    getSession.mockResolvedValue(null);
    const second = await del('operator');

    expect(second.status).toBe(404);
    // Still exactly one destructive call across both attempts.
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });
});
