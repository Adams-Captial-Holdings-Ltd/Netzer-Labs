import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// Drive auth by token string so we can exercise the real middleware wiring
// (authenticate -> requiredRole -> 401/403/next) through app.request(),
// with no AWS in the loop.
function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  // Keep the real capability resolution (capabilitiesForPrincipal et al.) — the
  // Wave 4b /whoami handler calls it through the dashboard-auth import, so the
  // mock MUST expose it or whoami throws and 500s. Only the token-extraction /
  // authentication entrypoints are stubbed so we can drive auth by role string.
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (authHeader?: string) => (authHeader ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
  };
});

vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return {
    ...actual,
    isKillSwitchActive: () => Promise.resolve({ active: false }),
  };
});

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';

function req(path: string, method: string, role?: string) {
  // Mount under /api exactly like server.ts so the prefix is stripped for
  // route matching while c.req.path still carries it for the role check.
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  const headers: Record<string, string> = {};
  if (role) headers.Authorization = `Bearer ${role}`;
  return app.request(`/api${path}`, { method, headers });
}

describe('dashboard middleware enforcement', () => {
  it('returns 401 without a valid token', async () => {
    expect((await req('/whoami', 'GET')).status).toBe(401);
    expect((await req('/agents', 'GET', 'bogus')).status).toBe(401);
  });

  it('lets a viewer read but reports their role via /whoami', async () => {
    const res = await req('/whoami', 'GET', 'viewer');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'viewer' });
  });

  it('blocks a viewer from flipping kill switches (needs security:write)', async () => {
    const res = await req('/kill-switches', 'POST', 'viewer');
    expect(res.status).toBe(403);
    // The legacy rank gate is relaxed to viewer; the in-route security:write
    // capability check is now the gate that denies a viewer.
    expect(await res.json()).toMatchObject({ requiredCapability: 'security:write' });
  });

  it('blocks an operator from kill switches and token management', async () => {
    expect((await req('/kill-switches', 'POST', 'operator')).status).toBe(403);
    expect((await req('/tokens', 'GET', 'operator')).status).toBe(403);
  });

  it('blocks a viewer from reading the token list (admin only)', async () => {
    expect((await req('/tokens', 'GET', 'viewer')).status).toBe(403);
  });

  it('blocks operator-level GDPR purge but not the lower-risk export', async () => {
    expect((await req('/export?chatId=c', 'DELETE', 'operator')).status).toBe(403);
    // GET /export is viewer/operator-level, so it passes the middleware
    // (the handler then 400s on the missing chatId — proving it got past auth).
    expect((await req('/export', 'GET', 'viewer')).status).toBe(400);
  });
});
