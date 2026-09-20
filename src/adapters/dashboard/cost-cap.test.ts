import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// Router-to-client CONTRACT test. The audit's key gap was that nothing locked
// the response JSON KEY NAMES, so the frontend silently drifted from the
// backend. These tests drive the REAL buildCostCapRouter through app.request()
// (no AWS in the loop) and assert the exact response keys the dashboard reads.

// Drive auth by token string -> principal role, exactly like
// handler.middleware.test.ts. 'admin'/'operator'/'viewer' map to that role.
function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  // Keep the real capability resolution (principalHasCapability /
  // profileIdForPrincipal) — the POST gate now resolves cost:write through
  // route-capability.ts, which imports those from here. Only the
  // token-extraction / authentication entrypoints are stubbed so we drive auth
  // by role string.
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (authHeader?: string) => (authHeader ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
  };
});

// State layer mocked so no DDB / AWS is touched. resolveEffectiveCostCap drives
// BOTH the dailyCapUsd value and its source from one call, so the two can never
// be mocked into disagreement (that independence was the original bug).
const resolveEffectiveCostCap = vi.fn();
const setDailyCostCap = vi.fn();
vi.mock('../../lib/state/cost-cap-repo.js', () => ({
  resolveEffectiveCostCap: () => resolveEffectiveCostCap(),
  setDailyCostCap: (cap: number, opts: { updatedBy?: string }) => setDailyCostCap(cap, opts),
}));

const getConfig = vi.fn();
vi.mock('../../lib/state/runtime-config-repo.js', () => ({
  getConfig: (ns: string, key: string) => getConfig(ns, key),
}));

// Audit is fire-and-forget; stub it so nothing reaches DDB.
const writeAudit = vi.fn((_event: unknown) => Promise.resolve());
vi.mock('../../lib/audit/audit-writer.js', () => ({
  writeAudit: (event: unknown) => writeAudit(event),
}));

// The POST route mirrors the cap to AWS Budgets and swallows the error, so the
// real call would reach STS + Budgets in whatever account resolves. Stubbed, as
// in authz-matrix.test.ts: with credentials neutralised it already resolves null.
vi.mock('../../lib/aws/budget-writer.js', () => ({
  syncBudgetToDailyCap: () => Promise.resolve(null),
}));

import { buildCostCapRouter } from './cost-cap.js';

// res.json() is typed as Promise<unknown>; read it as a plain record so the
// assertion matchers accept it and we can index keys freely.
const readJson = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

function makeApp() {
  const app = new Hono();
  app.route('/api/cost-cap', buildCostCapRouter());
  return app;
}

function req(method: string, role: string | undefined, body?: unknown) {
  const headers: Record<string, string> = {};
  if (role) headers.Authorization = `Bearer ${role}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return makeApp().request('/api/cost-cap', init);
}

beforeEach(() => {
  resolveEffectiveCostCap.mockReset();
  resolveEffectiveCostCap.mockResolvedValue({ capUsd: 100, source: 'env-default' });
  setDailyCostCap.mockReset();
  getConfig.mockReset();
  writeAudit.mockReset();
});

describe('cost-cap router contract', () => {
  it('GET returns exactly { dailyCapUsd, source } with source=runtime-config when a positive override is enforced', async () => {
    resolveEffectiveCostCap.mockResolvedValue({ capUsd: 250, source: 'runtime-config' });

    const res = await req('GET', 'operator');
    expect(res.status).toBe(200);
    const json = await readJson(res);

    // Lock the KEY SET so any future drift (rename/add) fails CI.
    expect(Object.keys(json).sort()).toEqual(['dailyCapUsd', 'source']);
    expect(typeof json.dailyCapUsd).toBe('number');
    expect(json.dailyCapUsd).toBe(250);
    expect(json.source).toBe('runtime-config');
  });

  it('GET reports source=env-default when the effective cap fell back to the default', async () => {
    resolveEffectiveCostCap.mockResolvedValue({ capUsd: 100, source: 'env-default' });

    const res = await req('GET', 'operator');
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json).toEqual({ dailyCapUsd: 100, source: 'env-default' });
  });

  it('POST accepts { dailyCapUsd } from an admin and echoes the contract keys', async () => {
    resolveEffectiveCostCap.mockResolvedValue({ capUsd: 500, source: 'runtime-config' });
    setDailyCostCap.mockResolvedValue(undefined);

    const res = await req('POST', 'admin', { dailyCapUsd: 500, reason: 'q2 budget' });
    expect(res.status).toBe(200);

    // The write actually reached the repo with the parsed number.
    expect(setDailyCostCap).toHaveBeenCalledWith(500, expect.objectContaining({ updatedBy: 'admin' }));

    const json = await readJson(res);
    expect(json).toMatchObject({ ok: true, dailyCapUsd: 500, source: 'runtime-config' });

    // Re-GET after save returns the persisted value under the same keys.
    const after = await req('GET', 'operator');
    const afterJson = await readJson(after);
    expect(Object.keys(afterJson).sort()).toEqual(['dailyCapUsd', 'source']);
    expect(afterJson.dailyCapUsd).toBe(500);
  });

  it('POST rejects a non-numeric dailyCapUsd with 400 and never writes', async () => {
    const res = await req('POST', 'admin', { dailyCapUsd: 'lots' });
    expect(res.status).toBe(400);
    expect(setDailyCostCap).not.toHaveBeenCalled();
  });

  it('POST rejects dailyCapUsd = 0 with 400 and never writes (0 is not a hard stop; use the kill switch)', async () => {
    const res = await req('POST', 'admin', { dailyCapUsd: 0 });
    expect(res.status).toBe(400);
    // A stored 0 would be ignored by getEffectiveCostCap() and silently fall
    // back to the default, so the write must be refused, not accepted.
    expect(setDailyCostCap).not.toHaveBeenCalled();
  });

  it('POST rejects a negative dailyCapUsd with 400 and never writes', async () => {
    const res = await req('POST', 'admin', { dailyCapUsd: -5 });
    expect(res.status).toBe(400);
    expect(setDailyCostCap).not.toHaveBeenCalled();
  });

  it('enforces caps: GET needs operator+, POST needs cost:write (operator+)', async () => {
    resolveEffectiveCostCap.mockResolvedValue({ capUsd: 100, source: 'env-default' });
    setDailyCostCap.mockResolvedValue(undefined);

    expect((await req('GET', undefined)).status).toBe(401); // no token
    expect((await req('GET', 'viewer')).status).toBe(403); // below operator
    // POST loosened to cost:write (operator-tier, product-approved): a viewer is
    // denied, but an operator is now ALLOWED (was admin-only before).
    expect((await req('POST', 'viewer', { dailyCapUsd: 10 })).status).toBe(403);
    expect((await req('POST', 'operator', { dailyCapUsd: 10 })).status).toBe(200);
  });
});
