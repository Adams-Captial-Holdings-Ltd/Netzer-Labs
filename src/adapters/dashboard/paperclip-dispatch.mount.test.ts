/**
 * MOUNT POSITION, PROVEN BY EXECUTION RATHER THAN BY SOURCE ORDER.
 *
 * Comparing `indexOf` offsets in `server.ts` shows that one line precedes
 * another; it does not show that Hono's registration order is what decides
 * which handler answers, nor that a later sub-router's `router.use('*')` is
 * skipped for a path an earlier mount already claimed. Those are the two
 * load-bearing semantics, and they are only observable by issuing a request
 * through the real `buildApp`.
 *
 * What makes the observation unambiguous is a FINGERPRINT that only one of the
 * two candidate handlers can produce:
 *   - the dispatch route, with no `PAPERCLIP_DISPATCH_SECRET` configured,
 *     answers `401 {error:'unauthorized', reason:'no_secret'}` — the `reason`
 *     key is its and its alone;
 *   - the dashboard router's bearer middleware answers a BARE
 *     `401 {error:'unauthorized'}` and, on the way, calls
 *     `authenticateDashboardToken` and writes an `auth_failure` audit row.
 *
 * So "the dashboard middleware never ran" is asserted three ways: the response
 * body's shape, the authenticate spy, and the audit spy. The control request at
 * the bottom drives an unmatched `/api/**` path through the SAME app instance to
 * show the spies do fire when the catch-all really is reached — without it, all
 * three assertions could pass because the mocks were mis-wired.
 *
 * Everything AWS-shaped is mocked. Nothing here reaches DynamoDB or Bedrock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../config/env.js';

// The dispatch route reads the secret through `loadEnv()`, which parses
// `process.env` on first call and memoizes. Deleting the var BEFORE that first
// call is what arms the `no_secret` fingerprint above; vitest gives this file
// its own module registry, so the memo starts cold here.
delete process.env.PAPERCLIP_DISPATCH_SECRET;

const { authenticateSpy, auditSpy } = vi.hoisted(() => ({
  authenticateSpy: vi.fn(() => Promise.resolve(null)),
  auditSpy: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return { ...actual, authenticateDashboardToken: authenticateSpy };
});

vi.mock('../../lib/audit/audit-writer.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/audit/audit-writer.js')>();
  return { ...actual, writeAudit: auditSpy };
});

vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive: () => Promise.resolve({ active: false }) };
});

import { buildApp } from '../../server.js';

const env = {
  NODE_ENV: 'production',
  PORT: 3000,
  LOG_LEVEL: 'info',
  AWS_REGION: 'us-east-1',
} as unknown as Env;

const dispatchBody = JSON.stringify({
  netzarAgentId: 'main',
  issueId: 'a1b2c3d4-0000-4000-8000-000000000001',
  runId: '11111111-2222-4333-8444-555555555555',
});

beforeEach(() => {
  authenticateSpy.mockClear();
  auditSpy.mockClear();
});

describe('/api/paperclip is mounted BEFORE the /api dashboard catch-all (execution, not source order)', () => {
  it('a dispatch request is answered by the dispatch route, and never reaches the dashboard bearer middleware', async () => {
    const res = await buildApp(env).request('/api/paperclip/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: dispatchBody,
    });

    expect(res.status).toBe(401);
    // The `reason` key is the dispatch route's fingerprint. The dashboard
    // middleware's 401 body has no `reason`, so this alone rules it out.
    expect(await res.json()).toEqual({ error: 'unauthorized', reason: 'no_secret' });
    expect(
      authenticateSpy,
      'the dashboard router\'s use(*) ran on a path an earlier mount had already claimed',
    ).not.toHaveBeenCalled();
    expect(
      auditSpy,
      'every dispatch would spam the security audit log with auth_failure rows',
    ).not.toHaveBeenCalled();
  });

  it('CONTROL: an unmatched /api path DOES reach that middleware, so the spies above are real', async () => {
    // Same app, same absence of a bearer. The dashboard router's use('*') runs
    // on any path under /api, matched or not — which is exactly why a mount
    // after it would 401 every dispatch and audit-log each one.
    const res = await buildApp(env).request('/api/not-a-real-dashboard-route', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(authenticateSpy).toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth_failure', surface: 'dashboard' }),
    );
  });
});
