/**
 * FROZEN acceptance tests for Work Platform step 6: the closed-sign-up probe
 * (decision 31; ledger A91). Written by the coordinator BEFORE any production
 * code. Do not edit without the owner's yes: the step gate pins this file's sha256.
 *
 * Approver accounts come from a pool made in ONE private sign-up window; sign-up
 * is then closed for good. Paperclip reads that flag only at boot, and an ECS
 * rollback can bring back a task that has it open, so the orchestrator proves it
 * closed at start and every 60 s as part of the runtime lock.
 *
 * The probe is side-effect free ONLY for an address that already exists (step 2,
 * spike b3): 422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL while sign-up is open (no
 * user is created), 400 EMAIL_PASSWORD_SIGN_UP_DISABLED once it is closed. So
 * with no known address the probe sends nothing. Anything it cannot prove is
 * `unknown` (the Paperclip surface stays latched closed), never `clean`.
 */
import { describe, it, expect, vi } from 'vitest';
import { combineLockVerdicts, readSignUpProbe } from './sign-up-probe.js';
import type { LockVerdict } from './runtime-lock.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CLOSED = () => json(400, { code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED', message: 'Email and password sign up is not enabled' });
const OPEN = () => json(422, { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', message: 'User already exists. Use another email.' });

function probe(answer: () => Response | Promise<Response>, over: Partial<Parameters<typeof readSignUpProbe>[0]> = {}) {
  const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => answer());
  const verdict = readSignUpProbe({ fetchFn: fetchFn as unknown as typeof fetch, baseUrl: 'http://paperclip.internal:3100/',
    probeEmail: 'lock-auditor-ab12@netzer.invalid', windowOpen: false, ...over });
  return { fetchFn, verdict };
}

describe('the closed-sign-up probe', () => {
  it('closed sign-up is clean', async () => {
    const { verdict } = probe(CLOSED);
    expect(await verdict).toEqual({ verdict: 'clean' });
  });

  it('asks Paperclip to sign up the known existing address, with no credentials and no redirects', async () => {
    const { fetchFn, verdict } = probe(CLOSED);
    await verdict;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe('http://paperclip.internal:3100/api/auth/sign-up/email');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    const body = JSON.parse(String(init?.body)) as { email: string; password: string; name: string };
    expect(body.email).toBe('lock-auditor-ab12@netzer.invalid');
    expect(body.password.length).toBeGreaterThanOrEqual(24);
  });

  it('uses a fresh random password on every probe', async () => {
    const first = probe(CLOSED); await first.verdict;
    const second = probe(CLOSED); await second.verdict;
    const pw = (h: typeof first) => (JSON.parse(String(h.fetchFn.mock.calls[0]![1]?.body)) as { password: string }).password;
    expect(pw(first)).not.toBe(pw(second));
  });

  it('open sign-up is a violation: sign_up_open', async () => {
    const { verdict } = probe(OPEN);
    const result = await verdict;
    expect(result.verdict).toBe('violated');
    expect(result.verdict === 'violated' && result.violations.map((v) => v.code)).toEqual(['sign_up_open']);
  });

  it.each([200, 201])('a %i answer means a user was created: sign_up_open, never clean', async (status) => {
    const { verdict } = probe(() => json(status, { user: { id: 'u1' } }));
    const result = await verdict;
    expect(result.verdict).toBe('violated');
    expect(result.verdict === 'violated' && result.violations[0]?.code).toBe('sign_up_open');
  });

  it('a violation detail never carries the probe address', async () => {
    const { verdict } = probe(OPEN);
    expect(JSON.stringify(await verdict)).not.toContain('netzer.invalid');
  });

  it.each([
    ['a 400 with another code', () => json(400, { code: 'INVALID_EMAIL' })],
    ['a 400 with no body', () => new Response('', { status: 400 })],
    ['a 400 that is not JSON', () => new Response('<html>bad request</html>', { status: 400 })],
    ['a 422 with another code', () => json(422, { code: 'PASSWORD_TOO_SHORT' })],
    ['a 401', () => json(401, {})],
    ['a 403', () => json(403, {})],
    ['a 404', () => json(404, {})],
    ['a 408', () => json(408, {})],
    ['a 429 from rate limiting', () => json(429, { code: 'TOO_MANY_REQUESTS' })],
    ['a 500', () => json(500, {})],
    ['a 503', () => json(503, {})],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'http://elsewhere/' } })],
  ])('%s proves nothing: unknown sign_up_probe_unprovable', async (_name, answer) => {
    const { verdict } = probe(answer);
    expect(await verdict).toEqual({ verdict: 'unknown', reason: 'sign_up_probe_unprovable' });
  });

  it('a network error proves nothing and never rejects', async () => {
    const { verdict } = probe(() => { throw new TypeError('fetch failed'); });
    await expect(verdict).resolves.toEqual({ verdict: 'unknown', reason: 'sign_up_probe_unprovable' });
  });

  it.each([undefined, '', '   '])('with the probe address %j it sends NOTHING and is unknown', async (probeEmail) => {
    const { fetchFn, verdict } = probe(OPEN, { probeEmail });
    expect(await verdict).toEqual({ verdict: 'unknown', reason: 'sign_up_probe_email_missing' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  describe('inside the one setup window', () => {
    it('open sign-up is expected, but the surface stays latched: unknown sign_up_window_open', async () => {
      const { verdict } = probe(OPEN, { windowOpen: true });
      expect(await verdict).toEqual({ verdict: 'unknown', reason: 'sign_up_window_open' });
    });
    it('the window never turns an open sign-up into clean, whatever the answer', async () => {
      for (const answer of [OPEN, () => json(200, {}), () => json(500, {})]) {
        const { verdict } = probe(answer, { windowOpen: true });
        expect((await verdict).verdict).toBe('unknown');
      }
    });
    it('a closed sign-up is clean even if the window flag was left on', async () => {
      const { verdict } = probe(CLOSED, { windowOpen: true });
      expect(await verdict).toEqual({ verdict: 'clean' });
    });
  });
});

describe('combining the runtime lock with the probe', () => {
  const clean: LockVerdict = { verdict: 'clean' };
  const unknown: LockVerdict = { verdict: 'unknown', reason: 'paperclip_unreachable' };
  const violatedA: LockVerdict = { verdict: 'violated', violations: [{ code: 'native_runner_on', detail: 'a' }] };
  const violatedB: LockVerdict = { verdict: 'violated', violations: [{ code: 'sign_up_open', detail: 'b' }] };

  it('clean only when both are clean', () => {
    expect(combineLockVerdicts(clean, clean)).toEqual(clean);
  });
  it('one unknown makes the whole verdict unknown, keeping its reason', () => {
    expect(combineLockVerdicts(clean, { verdict: 'unknown', reason: 'sign_up_probe_unprovable' }))
      .toEqual({ verdict: 'unknown', reason: 'sign_up_probe_unprovable' });
    expect(combineLockVerdicts(unknown, clean)).toEqual(unknown);
  });
  it('a proven violation beats a failed read, in either order', () => {
    expect(combineLockVerdicts(unknown, violatedB)).toEqual(violatedB);
    expect(combineLockVerdicts(violatedA, unknown)).toEqual(violatedA);
  });
  it('two violations are both reported', () => {
    const both = combineLockVerdicts(violatedA, violatedB);
    expect(both.verdict === 'violated' && both.violations.map((v) => v.code)).toEqual(['native_runner_on', 'sign_up_open']);
  });
});
