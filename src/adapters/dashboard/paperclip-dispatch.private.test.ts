/**
 * FROZEN ACCEPTANCE TEST: Work Platform step 2 (SPECIFICATION checkpoint).
 *
 * Written by the coordinator BEFORE any production code. The builder makes it
 * pass and MUST NOT edit it (the step gate pins its sha256). It REPLACES
 * `paperclip-dispatch.mount.test.ts`, which pins the old public mount and is
 * deleted by the same change.
 *
 * WHAT THIS PINS (ADR 0014 item 3, dispatch_path decision, Jev 0.99): the
 * Paperclip dispatch endpoint lives on a SECOND, private listener, and the
 * public :3000 app denies it by ABSENCE. A peer-IP check would fail open behind
 * the Cloudflare tunnel (it arrives on loopback), and the ALB and WAF never see
 * tunnel traffic, so the denial has to be in the code of the public app:
 *
 *   - `buildApp(env)` (the public listener) answers 404 for EVERY method on
 *     /api/paperclip/dispatch, with or without a valid bearer, and the request
 *     never reaches the dashboard bearer middleware (so no auth_failure audit row
 *     is written for it). The denial is narrow: other /api paths behave as before.
 *   - `buildPrivateDispatchApp(deps)` (the private listener, its own port) serves
 *     ONLY POST /api/paperclip/dispatch, with the same contract as before, plus
 *     the lock latch: while the latch is closed an AUTHENTICATED dispatch gets a
 *     real 503 {error:'paperclip_locked', code} and no work is enqueued; an
 *     unauthenticated caller still gets 401 (the latch state is never leaked).
 *
 * Everything AWS-shaped is mocked, as in the old mount test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env.js';

const SECRET = 'dispatch-secret-7d2f9a41c0';
// `loadEnv()` memoizes the first parse; set the secret BEFORE the first request so the public app's
// (absent) route could not be rescued by a missing secret, which would answer 401 instead of 404.
process.env.PAPERCLIP_DISPATCH_SECRET = SECRET;

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

import { buildApp, buildPrivateDispatchApp } from '../../server.js';
import {
  __resetPaperclipLockForTest,
  enforceStartupLock,
} from '../../lib/paperclip/runtime-lock.js';

const env = {
  NODE_ENV: 'production',
  PORT: 3000,
  LOG_LEVEL: 'info',
  AWS_REGION: 'us-east-1',
} as unknown as Env;

const body = {
  netzarAgentId: 'main',
  issueId: 'a1b2c3d4-0000-4000-8000-000000000001',
  runId: '11111111-2222-4333-8444-555555555555',
};
const dispatchBody = JSON.stringify(body);
const PATH = '/api/paperclip/dispatch';
const asJson = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', ...extra });

beforeEach(() => {
  authenticateSpy.mockClear();
  auditSpy.mockClear();
  __resetPaperclipLockForTest();
});
afterEach(() => __resetPaperclipLockForTest());

describe('the PUBLIC app denies the dispatch route by absence', () => {
  it('POST with a VALID bearer is 404, byte-for-byte the not-found body, and never reaches the dashboard middleware', async () => {
    const res = await buildApp(env).request(PATH, {
      method: 'POST',
      headers: asJson({ authorization: `Bearer ${SECRET}` }),
      body: dispatchBody,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', path: PATH });
    expect(authenticateSpy, 'the dashboard bearer middleware must not see a denied dispatch').not.toHaveBeenCalled();
    expect(auditSpy, 'a denied dispatch must not write auth_failure audit rows').not.toHaveBeenCalled();
  });

  it('POST with no bearer is also 404 (a 401 would confirm the route exists)', async () => {
    const res = await buildApp(env).request(PATH, { method: 'POST', headers: asJson(), body: dispatchBody });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', path: PATH });
    expect(authenticateSpy).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PUT', 'PATCH', 'DELETE'])('%s on the dispatch path is 404 too', async (method) => {
    const res = await buildApp(env).request(PATH, {
      method,
      headers: asJson({ authorization: `Bearer ${SECRET}` }),
    });
    expect(res.status).toBe(404);
    expect(authenticateSpy).not.toHaveBeenCalled();
  });

  it('CONTROL: the denial is narrow. An unmatched /api path still reaches the dashboard middleware, so the spies above are real', async () => {
    const res = await buildApp(env).request('/api/not-a-real-dashboard-route', {
      method: 'POST',
      headers: asJson(),
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(authenticateSpy).toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth_failure', surface: 'dashboard' }));
  });
});

describe('the PRIVATE app serves the dispatch route and nothing else', () => {
  const makeDeps = () => ({
    secret: () => SECRET,
    killSwitch: (async () => ({ active: false })) as never,
    knownAgents: () => ['main'],
    enabledAgents: async () => ['main'],
    claim: vi.fn(async () => true),
    work: vi.fn(async () => {}),
  });

  it('a valid dispatch is accepted with 202 and the work is enqueued once', async () => {
    const deps = makeDeps();
    const res = await buildPrivateDispatchApp(deps).request(PATH, {
      method: 'POST',
      headers: asJson({ authorization: `Bearer ${SECRET}` }),
      body: dispatchBody,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, accepted: true, issueId: body.issueId });
    expect(deps.work).toHaveBeenCalledTimes(1);
  });

  it('a wrong bearer is 401 and enqueues nothing', async () => {
    const deps = makeDeps();
    const res = await buildPrivateDispatchApp(deps).request(PATH, {
      method: 'POST',
      headers: asJson({ authorization: 'Bearer not-the-secret' }),
      body: dispatchBody,
    });
    expect(res.status).toBe(401);
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.work).not.toHaveBeenCalled();
  });

  it('no secret configured is still a fail-closed 401 reason:no_secret', async () => {
    const deps = { ...makeDeps(), secret: () => undefined };
    const res = await buildPrivateDispatchApp(deps).request(PATH, {
      method: 'POST',
      headers: asJson({ authorization: `Bearer ${SECRET}` }),
      body: dispatchBody,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', reason: 'no_secret' });
  });

  it('mounts no other route: health, the dashboard API and the wrong method are all 404', async () => {
    const app = buildPrivateDispatchApp(makeDeps());
    for (const [method, path] of [
      ['GET', '/health'],
      ['GET', '/ready'],
      ['POST', '/api/test-turn'],
      ['GET', '/api/config/paperclip/base_url'],
      ['GET', PATH],
    ] as const) {
      const res = await app.request(path, { method, headers: asJson({ authorization: `Bearer ${SECRET}` }) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it('while the lock latch is CLOSED an authenticated dispatch is a real 503 paperclip_locked carrying the code, and nothing is claimed or enqueued', async () => {
    await enforceStartupLock({
      read: async () => ({ verdict: 'unknown', reason: 'paperclip_unreachable' }),
      attempts: 1,
      sleep: async () => {},
    });
    const deps = makeDeps();
    const res = await buildPrivateDispatchApp(deps).request(PATH, {
      method: 'POST',
      headers: asJson({ authorization: `Bearer ${SECRET}` }),
      body: dispatchBody,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'paperclip_locked', code: 'unknown:paperclip_unreachable' });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.work).not.toHaveBeenCalled();
  });

  it('while the latch is closed an UNauthenticated caller still gets 401, so the latch state is never leaked', async () => {
    await enforceStartupLock({
      read: async () => ({ verdict: 'unknown', reason: 'paperclip_unreachable' }),
      attempts: 1,
      sleep: async () => {},
    });
    const res = await buildPrivateDispatchApp(makeDeps()).request(PATH, {
      method: 'POST',
      headers: asJson({ authorization: 'Bearer wrong' }),
      body: dispatchBody,
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('paperclip_locked');
  });

  it('the bearer is never written to a log line (the route logs a reason enum only)', async () => {
    const { logger } = await import('../../observability/logger.js');
    const lines: unknown[] = [];
    const spies = (['warn', 'info', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        lines.push(args);
      }) as never),
    );
    await buildPrivateDispatchApp(makeDeps()).request(PATH, {
      method: 'POST',
      headers: asJson({ authorization: 'Bearer leaked-bearer-value-123' }),
      body: dispatchBody,
    });
    for (const s of spies) s.mockRestore();
    expect(JSON.stringify(lines)).not.toContain('leaked-bearer-value-123');
  });
});
