import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * Lockdown for the generic runtime-config write under the COST category.
 *
 * The cost-watch toggle (cost/watch_enabled) is operator-writable via this
 * endpoint, but the daily cap (cost/daily_cap_usd) MUST go through POST /cost-cap
 * (numeric validation + AWS Budget sync + cost_cap_updated audit) and cost-watch
 * bookkeeping keys are server-only. Without the allowlist, a config:write
 * operator could set the cap or mutate bookkeeping through this generic path,
 * bypassing the dedicated route entirely. These tests drive the real dashboard
 * router and lock the allowlist + role gate.
 */

const { setConfig, getConfig, authenticateDashboardToken, writeAudit } = vi.hoisted(() => ({
  setConfig: vi.fn(async () => {}),
  getConfig: vi.fn(async () => null),
  authenticateDashboardToken: vi.fn(),
  writeAudit: vi.fn(async () => {}),
}));

function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => authenticateDashboardToken(raw),
  };
});

vi.mock('../../lib/state/runtime-config-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/runtime-config-repo.js')>();
  return { ...actual, setConfig, getConfig };
});

vi.mock('../../lib/audit/audit-writer.js', () => ({ writeAudit }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';

function post(path: string, role: string) {
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${role}`, 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'true' }),
  });
}

beforeEach(() => {
  setConfig.mockReset();
  getConfig.mockReset().mockResolvedValue(null);
  authenticateDashboardToken.mockReset().mockImplementation(async (raw: string) => principalFor(raw));
  writeAudit.mockReset();
});

describe('POST /config/cost/:key allowlist', () => {
  it('allows operator to set cost/watch_enabled (config:write)', async () => {
    const res = await post('/api/config/cost/watch_enabled', 'operator');
    expect(res.status).toBe(200);
    expect(setConfig).toHaveBeenCalledWith('cost', 'watch_enabled', 'true', expect.anything());
  });

  it('rejects setting cost/daily_cap_usd here and never writes (must use /cost-cap)', async () => {
    const res = await post('/api/config/cost/daily_cap_usd', 'admin');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('forbidden_key');
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('rejects cost-watch bookkeeping keys (server-only) and never writes', async () => {
    const res = await post('/api/config/cost/watch_last_run', 'admin');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('forbidden_key');
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('denies a viewer the watch toggle (legacy role gate keeps it operator+) and never writes', async () => {
    const res = await post('/api/config/cost/watch_enabled', 'viewer');
    expect(res.status).toBe(403);
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('allows admin to set cost/report_async_enabled (the async report toggle)', async () => {
    const res = await post('/api/config/cost/report_async_enabled', 'admin');
    expect(res.status).toBe(200);
    expect(setConfig).toHaveBeenCalledWith('cost', 'report_async_enabled', 'true', expect.anything());
  });

  it('denies an operator the async report toggle (admin-only) and never writes', async () => {
    const res = await post('/api/config/cost/report_async_enabled', 'operator');
    expect(res.status).toBe(403);
    expect(setConfig).not.toHaveBeenCalled();
  });
});
