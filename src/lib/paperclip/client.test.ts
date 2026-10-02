import { readFile, readdir } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PaperclipClient,
  PaperclipPage,
  __resetPaperclipCompanyPin,
  PAPERCLIP_NO_RETRY,
  PAPERCLIP_RETRY_POLICY,
  type PaperclipClientOptions,
} from './client.js';
import {
  PaperclipCompanyMismatchError,
  PaperclipDisabledError,
  PaperclipError,
  PaperclipInvalidInputError,
  PaperclipPaginationTruncatedError,
  PaperclipRatelimitedError,
  PaperclipUnavailableError,
} from './error.js';
import {
  expectPaperclipError,
  paperclipIssue as issue,
  paperclipTestClient,
  TEST_COMPANY as COMPANY,
  TEST_ISSUE_ID as ISSUE_ID,
} from './test-helpers.js';
import type { PaperclipIssue } from './types.js';

// ── Fakes. No real network call is ever made from this file. ───────────────

const OTHER_COMPANY = 'c0ffee00-0000-4000-8000-0000000000ff';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

interface Recorder {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
}

/** Answers each call from `responses` in order, replaying the last one forever. */
function recorder(responses: Array<Response | (() => Response | Promise<Response>)>): Recorder {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (typeof next === 'function') return next();
    // A Response body is single-use, so clone per call.
    return next.clone();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function client(fetchFn: typeof fetch, overrides: Partial<PaperclipClientOptions> = {}) {
  return paperclipTestClient({
    agentKeys: { main: 'key-main', analyst: 'key-analyst' },
    fetchFn,
    retry: { ...PAPERCLIP_NO_RETRY, sleep: async () => {} },
    ...overrides,
  });
}

// ── A2-9 ──────────────────────────────────────────────────────────────────

describe('construction', () => {
  it('A2-9: the constructor throws synchronously, so a misconfigured install never reaches fetch', () => {
    expect(() => new PaperclipClient({ companyId: COMPANY, agentKeys: { main: 'k' } })).toThrow(
      PaperclipDisabledError,
    );
  });

  /**
   * ONE NETZAR DEPLOYMENT = ONE PAPERCLIP COMPANY, the accepted architectural
   * invariant. It is what makes the tenant-safety of Paperclip's ~735
   * company-scoped handlers irrelevant to us, so it must fail CLOSED and it must
   * fail at CONSTRUCTION — after the instance exists it is too late to promise
   * that no request was made.
   */
  describe('the one-company invariant', () => {
    afterEach(__resetPaperclipCompanyPin);

    it('refuses a second company at construction, before any request can be made', () => {
      __resetPaperclipCompanyPin();
      const fetchFn = vi.fn();
      paperclipTestClient({ fetchFn });                       // pins TEST_COMPANY
      expect(() => paperclipTestClient({ companyId: OTHER_COMPANY, fetchFn })).toThrow(
        PaperclipDisabledError,
      );
      // The point of "at construction": nothing was ever sent.
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('names both companies, so the failure is diagnosable rather than just loud', () => {
      __resetPaperclipCompanyPin();
      paperclipTestClient();
      try {
        paperclipTestClient({ companyId: OTHER_COMPANY });
        expect.unreachable('a second company id must not construct');
      } catch (err) {
        expect((err as Error).message).toContain(COMPANY);
        expect((err as Error).message).toContain(OTHER_COMPANY);
      }
    });

    it('still allows any number of clients on the SAME company', () => {
      // The control: the invariant is one COMPANY, not one client. Per-agent
      // and per-timeout clients are ordinary and must keep working.
      __resetPaperclipCompanyPin();
      expect(() => {
        paperclipTestClient();
        paperclipTestClient({ readTimeoutMs: 1 });
        paperclipTestClient({ defaultActor: 'main' });
      }).not.toThrow();
    });
  });
});

// ── A2-10 ─────────────────────────────────────────────────────────────────

describe('header assembly', () => {
  it('A2-10: headers assemble in the documented order and the User-Agent is ours, never the consumer package', async () => {
    const rec = recorder([jsonResponse(issue())]);
    await client(rec.fetchFn, { headers: { 'x-caller': 'dashboard' } }).getIssue(ISSUE_ID);
    const headers = rec.calls[0]?.init.headers as Record<string, string>;

    expect(Object.keys(headers)).toEqual(['authorization', 'x-caller', 'user-agent']);
    expect(headers.authorization).toBe('Bearer key-main');
    expect(headers['user-agent']).toBe('netzar-os/0.0.1');
    // Linear reads process.env.npm_package_name here, which resolves to the
    // CONSUMER's package at runtime. Never copied.
    expect(headers['user-agent']).not.toContain('undefined');
  });

  it('A2-10: bearer prefixing is idempotent and a Headers instance survives the spread', async () => {
    const rec = recorder([jsonResponse(issue())]);
    await client(rec.fetchFn, {
      agentKeys: { main: 'Bearer already-prefixed' },
      headers: new Headers({ 'x-trace': 'abc' }),
    }).getIssue(ISSUE_ID);
    const headers = rec.calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer already-prefixed');
    // D11: spreading a raw Headers instance yields {} and drops every header.
    expect(headers['x-trace']).toBe('abc');
  });

  it('A2-10: the actor option picks which agent key signs the request', async () => {
    const rec = recorder([jsonResponse(issue())]);
    await client(rec.fetchFn).getIssue(ISSUE_ID, { actor: 'analyst' });
    expect((rec.calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer key-analyst');
  });

  it('A1-3: an absent run id is OMITTED, never sent empty, and one is never synthesized', async () => {
    const rec = recorder([jsonResponse({ id: 'x', body: 'b', createdAt: 'now' })]);
    const paperclip = client(rec.fetchFn);
    await paperclip.addComment(ISSUE_ID, { body: 'hello' });
    expect(Object.keys(rec.calls[0]?.init.headers as Record<string, string>)).not.toContain('X-Paperclip-Run-Id');

    await paperclip.addComment(ISSUE_ID, { body: 'hello' }, { runId: 'run-from-caller' });
    expect((rec.calls[1]?.init.headers as Record<string, string>)['X-Paperclip-Run-Id']).toBe('run-from-caller');
  });

  it('A2-9: an actor with no key is a typed disabled error naming the actors that do have one', async () => {
    const rec = recorder([jsonResponse(issue())]);
    const err = await expectPaperclipError(
      () => client(rec.fetchFn).getIssue(ISSUE_ID, { actor: 'ghost' }),
      PaperclipDisabledError,
      '"ghost"',
    );
    expect(err.body?.remediation).toContain('analyst, main');
    expect(rec.calls).toHaveLength(0);
  });
});

// ── A2-11 ─────────────────────────────────────────────────────────────────

describe('timeouts (A2-11, our divergence from Linear, which has none)', () => {
  it('forces redirects to error even when an untyped caller supplies follow', async () => {
    const rec = recorder([jsonResponse(issue())]);
    const options = { redirect: 'follow' } as unknown as Partial<PaperclipClientOptions>;
    await client(rec.fetchFn, options).getIssue(ISSUE_ID);
    expect(rec.calls[0]?.init.redirect).toBe('error');
  });

  function hangingFetch(): typeof fetch {
    return (async (_input: Parameters<typeof fetch>[0], init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        // Real `fetch` rejects immediately when handed an already-aborted
        // signal; the fake has to as well or a combined signal that fired
        // before the call would hang forever.
        if (init.signal?.aborted) reject(init.signal.reason);
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
  }

  it('A2-11: a GET aborts at the read timeout while a write of the same age is still in flight', async () => {
    const paperclip = client(hangingFetch(), { readTimeoutMs: 20, writeTimeoutMs: 5_000 });
    await expectPaperclipError(() => paperclip.getIssue(ISSUE_ID), PaperclipUnavailableError, '');

    let writeSettled = false;
    void paperclip.addComment(ISSUE_ID, { body: 'x' }).catch(() => {
      writeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(writeSettled).toBe(false);
  });

  it('A2-11: a caller signal is combined with ours rather than replacing it', async () => {
    const controller = new AbortController();
    const paperclip = client(hangingFetch(), { readTimeoutMs: 5_000 });
    const inFlight = paperclip.getIssue(ISSUE_ID, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller changed its mind')), 5);
    await expectPaperclipError(() => inFlight, PaperclipUnavailableError, '');
  });

  it('A2-11: undestructured RequestInit keys are re-spread into fetch, and cannot clobber the header block', async () => {
    const rec = recorder([jsonResponse(issue())]);
    await client(rec.fetchFn, { keepalive: true }).getIssue(ISSUE_ID);
    const init = rec.calls[0]?.init as RequestInit & { keepalive?: boolean };
    expect(init.keepalive).toBe(true);
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key-main');
  });
});

// ── A2-12 ─────────────────────────────────────────────────────────────────

describe('retry and breaker (A2-12, argued not assumed)', () => {
  const retryable = { ...PAPERCLIP_RETRY_POLICY, sleep: async () => {}, random: () => 1 };

  it('A2-12: a GET retries a transient failure up to three attempts', async () => {
    const rec = recorder([
      () => jsonResponse({ error: 'boom' }, { status: 503 }),
      () => jsonResponse({ error: 'boom' }, { status: 503 }),
      () => jsonResponse([issue()]),
    ]);
    const page = await client(rec.fetchFn, { retry: retryable }).listIssues();
    expect(rec.calls).toHaveLength(3);
    expect(page.nodes).toHaveLength(1);
  });

  it('A2-12: three attempts is the ceiling, not a floor', async () => {
    const rec = recorder([() => jsonResponse({ error: 'boom' }, { status: 503 })]);
    await expectPaperclipError(
      () => client(rec.fetchFn, { retry: retryable }).listIssues(),
      PaperclipUnavailableError,
      'Boom',
    );
    expect(rec.calls).toHaveLength(3);
  });

  it('A2-12: a 4xx is never retried, and a 429 is', async () => {
    const fourxx = recorder([() => jsonResponse({ error: 'Validation error' }, { status: 400 })]);
    await expectPaperclipError(
      () => client(fourxx.fetchFn, { retry: retryable }).listIssues(),
      PaperclipInvalidInputError,
      'Validation error',
    );
    expect(fourxx.calls).toHaveLength(1);

    const limited = recorder([
      () => jsonResponse({ error: 'Search rate limit exceeded', retryAfterSeconds: 1 }, { status: 429 }),
      () => jsonResponse([issue()]),
    ]);
    await client(limited.fetchFn, { retry: retryable }).listIssues();
    expect(limited.calls).toHaveLength(2);
  });

  it('A2-12: a write retries ONLY when its body carries an idempotencyKey', async () => {
    const plain = recorder([() => jsonResponse({ error: 'boom' }, { status: 503 })]);
    await expectPaperclipError(
      () => client(plain.fetchFn, { retry: retryable }).addComment(ISSUE_ID, { body: 'x' }),
      PaperclipUnavailableError,
      'Boom',
    );
    expect(plain.calls).toHaveLength(1);

    const idempotent = recorder([() => jsonResponse({ error: 'boom' }, { status: 503 })]);
    await expectPaperclipError(
      () =>
        client(idempotent.fetchFn, { retry: retryable }).createIssue({
          title: 'x',
          idempotencyKey: 'netzar-mission:m1',
        }),
      PaperclipUnavailableError,
      'Boom',
    );
    expect(idempotent.calls).toHaveLength(3);
  });

  it('A2-12: the backoff is full jitter, base 250 ms, capped at 4 s', async () => {
    const delays: number[] = [];
    const rec = recorder([() => jsonResponse({ error: 'boom' }, { status: 503 })]);
    await expectPaperclipError(
      () =>
        client(rec.fetchFn, {
          retry: { ...PAPERCLIP_RETRY_POLICY, attempts: 6, random: () => 1, sleep: async (ms) => void delays.push(ms) },
        }).listIssues(),
      PaperclipUnavailableError,
      'Boom',
    );
    // random() === 1 is the top of the full-jitter window, so these are the
    // ceilings: 250, 500, 1000, 2000, then capped at 4000.
    expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000]);

    const halved: number[] = [];
    const rec2 = recorder([() => jsonResponse({ error: 'boom' }, { status: 503 })]);
    await expectPaperclipError(
      () =>
        client(rec2.fetchFn, {
          retry: { ...PAPERCLIP_RETRY_POLICY, random: () => 0.5, sleep: async (ms) => void halved.push(ms) },
        }).listIssues(),
      PaperclipUnavailableError,
      'Boom',
    );
    expect(halved).toEqual([125, 250]);
  });

  it('A2-12: five consecutive failed CALLS open the breaker AT THE SHIPPED POLICY, 30 s half-opens it, one success closes it', async () => {
    let clock = 0;
    const rec = recorder([() => jsonResponse({ error: 'boom' }, { status: 503 })]);
    // The SHIPPED policy, not PAPERCLIP_NO_RETRY. Under `attempts: 3` a failing
    // call makes three fetches, so a breaker that counted attempts would open
    // after the SECOND call while its own remediation string told the operator
    // it had seen five. Demonstrating the threshold only where an attempt
    // happens to equal a call demonstrates it in a configuration production
    // never selects.
    const paperclip = client(rec.fetchFn, {
      retry: { ...PAPERCLIP_RETRY_POLICY, sleep: async () => {} },
      now: () => clock,
    });

    for (let i = 0; i < 4; i += 1) {
      await expectPaperclipError(() => paperclip.listIssues(), PaperclipUnavailableError, 'Boom');
    }
    // Twelve fetches, four failed calls, breaker still closed.
    expect(rec.calls).toHaveLength(12);
    await expectPaperclipError(() => paperclip.listIssues(), PaperclipUnavailableError, 'Boom');
    expect(rec.calls).toHaveLength(15);

    // Open: refused without reaching fetch, and the remediation names the same
    // five the operator can count in the log.
    const open = await expectPaperclipError(
      () => paperclip.listIssues(),
      PaperclipUnavailableError,
      'circuit breaker is open',
    );
    expect(open.body?.remediation).toContain('5 consecutive transient failures');
    expect(rec.calls).toHaveLength(15);

    // Half-open after the cooldown: one call goes through.
    clock = PAPERCLIP_RETRY_POLICY.breakerCooldownMs;
    rec.calls.length = 0;
    const healthy = recorder([jsonResponse([issue()])]);
    const closing = client(healthy.fetchFn, { retry: PAPERCLIP_NO_RETRY, now: () => clock });
    await closing.listIssues();
    expect(healthy.calls).toHaveLength(1);
  });

  it('A2-12: PAPERCLIP_NO_RETRY is the documented escape hatch and really makes one attempt', async () => {
    const rec = recorder([() => jsonResponse({ error: 'boom' }, { status: 503 })]);
    await expectPaperclipError(
      () => client(rec.fetchFn, { retry: PAPERCLIP_NO_RETRY }).listIssues(),
      PaperclipUnavailableError,
      'Boom',
    );
    expect(rec.calls).toHaveLength(1);
  });
});

// ── The kill switch (C-12 / A30) ──────────────────────────────────────────

describe('the paperclip_disabled kill switch', () => {
  const disabled = async () => ({ active: true, reason: 'incident 42' });

  it('C-12: the switch is checked at EVERY invoke, so no client method can bypass it', async () => {
    const rec = recorder([jsonResponse(issue())]);
    const paperclip = client(rec.fetchFn, { killSwitch: disabled });
    const everyMethod: Array<[string, () => Promise<unknown>]> = [
      ['listIssues', () => paperclip.listIssues()],
      ['getIssue', () => paperclip.getIssue(ISSUE_ID)],
      ['createIssue', () => paperclip.createIssue({ title: 'x' })],
      ['patchIssue', () => paperclip.patchIssue(ISSUE_ID, { title: 'x' })],
      ['listComments', () => paperclip.listComments(ISSUE_ID)],
      ['addComment', () => paperclip.addComment(ISSUE_ID, { body: 'x' })],
      ['listAgents', () => paperclip.listAgents()],
      ['wakeAgent', () => paperclip.wakeAgent('agent-1')],
      ['getHealth', () => paperclip.getHealth()],
      ['request', () => paperclip.request('GET', '/api/anything')],
      ['rawRequest', () => paperclip.rawRequest('GET', '/api/anything')],
    ];
    for (const [name, call] of everyMethod) {
      const err = await expectPaperclipError(call, PaperclipDisabledError, 'incident 42');
      expect(err.request?.method, name).toBeTruthy();
    }
    expect(rec.calls, 'no method reached fetch while the switch was set').toHaveLength(0);
  });

  it('A2-12: the kill switch is checked BEFORE the breaker, so a switched-off integration never reports unavailable', async () => {
    let clock = 0;
    let active = false;
    const rec = recorder([() => jsonResponse({ error: 'boom' }, { status: 503 })]);
    const paperclip = client(rec.fetchFn, {
      retry: PAPERCLIP_NO_RETRY,
      now: () => clock,
      killSwitch: async () => (active ? { active: true, reason: 'switched off' } : { active: false }),
    });
    for (let i = 0; i < 5; i += 1) {
      await expectPaperclipError(() => paperclip.listIssues(), PaperclipUnavailableError, 'Boom');
    }
    active = true;
    await expectPaperclipError(() => paperclip.listIssues(), PaperclipDisabledError, 'switched off');
  });
});

// ── A2-13 / A2-14 / A2-20 ─────────────────────────────────────────────────

describe('response handling', () => {
  it('A2-13: an ALB/proxy HTML 502 becomes a typed error, not a JSON parse crash', async () => {
    const rec = recorder([
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    ]);
    const err = await expectPaperclipError(
      () => client(rec.fetchFn).getIssue(ISSUE_ID),
      PaperclipUnavailableError,
      'responded 502',
    );
    expect(err.body?.error).toContain('502 Bad Gateway');
  });

  it('A2-13: a Content-Type application/json body that does not parse degrades to text instead of a raw SyntaxError', async () => {
    // Linear calls response.json() with NO try/catch, so this case escapes both
    // of its public exits un-normalized.
    const rec = recorder([
      new Response('{"truncated по', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);
    const err = await expectPaperclipError(
      () => client(rec.fetchFn).getIssue(ISSUE_ID),
      PaperclipError,
      'responded 200',
    );
    expect(err).not.toBeInstanceOf(SyntaxError);
    // The unparseable text survives onto the message beside the summary.
    expect(err.message).toContain('truncated');
  });

  it('A2-13: a BODYLESS success is a success, not a parse failure', async () => {
    // UNVERIFIED against the artifact: no probe has produced a 204 on this
    // surface, and every write any probe drove answered with a JSON body. This
    // is the shape a `Promise<void>` method would answer with, and treating it
    // as a failed parse would be a client-manufactured error.
    const rec = recorder([new Response(null, { status: 204 })]);
    await expect(client(rec.fetchFn).request('DELETE', '/api/issues/x')).resolves.toBeUndefined();
  });

  it('A2-13: the success predicate is stronger than response.ok - a 200 carrying an error envelope is a failure', async () => {
    const rec = recorder([jsonResponse({ error: 'Board access required' }, { status: 200 })]);
    await expectPaperclipError(
      () => client(rec.fetchFn).getIssue(ISSUE_ID),
      PaperclipError,
      'Board access required',
    );
  });

  it('A2-14/A2-20: request and rawRequest normalize to the SAME error class through one seam', async () => {
    const rec = recorder([() => jsonResponse({ error: 'Agent run id required' }, { status: 401 })]);
    const paperclip = client(rec.fetchFn);
    const viaRequest = await expectPaperclipError(
      () => paperclip.request('POST', '/api/issues/x/release'),
      PaperclipError,
      'Agent run id required',
    );
    const viaRaw = await expectPaperclipError(
      () => paperclip.rawRequest('POST', '/api/issues/x/release'),
      PaperclipError,
      'Agent run id required',
    );
    expect(viaRaw.constructor).toBe(viaRequest.constructor);
    expect(viaRaw.type).toBe('run_id_required');
  });

  it('A2-14: rawRequest exposes the response metadata that request() deliberately hides', async () => {
    const rec = recorder([
      jsonResponse([issue()], { headers: { 'x-paperclip-request-cache': 'coalesced', etag: 'W/"1"' } }),
    ]);
    const raw = await client(rec.fetchFn).rawRequest<PaperclipIssue[]>('GET', '/api/companies/x/issues');
    expect(raw.status).toBe(200);
    expect(raw.headers.get('x-paperclip-request-cache')).toBe('coalesced');
    expect(raw.headers.get('etag')).toBe('W/"1"');
    expect(raw.data).toHaveLength(1);
  });

  it('A1-10: the rate-limit budget survives all the way to the typed error a caller catches', async () => {
    const rec = recorder([
      jsonResponse({ error: 'Search rate limit exceeded', retryAfterSeconds: 30 }, {
        status: 429,
        headers: { 'retry-after': '30', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0' },
      }),
    ]);
    const err = (await expectPaperclipError(
      () => client(rec.fetchFn).listIssues(),
      PaperclipRatelimitedError,
      'Search rate limit exceeded',
    )) as PaperclipRatelimitedError;
    expect(err.retryAfter).toBe(30);
    expect(err.limit).toBe(60);
    expect(err.remaining).toBe(0);
  });
});

// ── Company-id pinning ────────────────────────────────────────────────────

describe('company-id pinning', () => {
  it('rejects any response whose companyId differs, on the one body proven to carry it', async () => {
    // The heartbeat run row from POST /api/agents/{id}/wakeup is the ONLY
    // response in the proven surface that carries companyId.
    const rec = recorder([jsonResponse({ id: 'run-1', companyId: OTHER_COMPANY, agentId: 'a', status: 'queued' })]);
    const err = await expectPaperclipError(
      () => client(rec.fetchFn).wakeAgent('agent-1'),
      PaperclipCompanyMismatchError,
      OTHER_COMPANY,
    );
    expect(err.type).toBe('company_mismatch');
  });

  it('accepts our own companyId, and is a no-op on the rows that carry no such field', async () => {
    const ours = recorder([jsonResponse({ id: 'run-1', companyId: COMPANY, agentId: 'a', status: 'queued' })]);
    await expect(client(ours.fetchFn).wakeAgent('agent-1')).resolves.toMatchObject({ id: 'run-1' });

    // PaperclipIssueView has no companyId and no probe asserts one on an issue
    // row, so the guard is latent there rather than active.
    const issues = recorder([jsonResponse([issue()])]);
    await expect(client(issues.fetchFn).listIssues()).resolves.toBeInstanceOf(PaperclipPage);
  });

  it('rejects a mismatched row anywhere in an array response, not just the first', async () => {
    const rec = recorder([jsonResponse([{ id: '1', companyId: COMPANY }, { id: '2', companyId: OTHER_COMPANY }])]);
    await expectPaperclipError(
      () => client(rec.fetchFn).request('GET', '/api/anything'),
      PaperclipCompanyMismatchError,
      OTHER_COMPANY,
    );
  });
});

// ── A2-15 pagination ──────────────────────────────────────────────────────

describe('pagination (A2-15)', () => {
  it('A2-15: an unpopulated page is safe-empty and its fetchNext is a no-op returning the same page', async () => {
    const empty = new PaperclipPage<PaperclipIssue>();
    expect(empty.nodes).toEqual([]);
    expect(empty.hasMore).toBe(false);
    expect(await empty.fetchNext()).toBe(empty);
    expect(await empty.paginateAll()).toEqual([]);
  });

  it('A2-15: the refetch closure carries page-1 filters to page 2, and the caller cannot drop them', async () => {
    const rec = recorder([
      () => jsonResponse([issue({ id: 'i1' }), issue({ id: 'i2' })]),
      () => jsonResponse([issue({ id: 'i3' })]),
    ]);
    const page = await client(rec.fetchFn).listIssues({
      limit: 2,
      status: 'todo',
      updatedSince: '2026-08-20T00:00:00.000Z',
    });
    expect(page.hasMore).toBe(true);

    const next = await page.fetchNext();
    const secondUrl = new URL(rec.calls[1]?.url as string);
    expect(secondUrl.searchParams.get('status')).toBe('todo');
    expect(secondUrl.searchParams.get('updatedSince')).toBe('2026-08-20T00:00:00.000Z');
    expect(secondUrl.searchParams.get('limit')).toBe('2');
    expect(secondUrl.searchParams.get('offset')).toBe('2');
    expect(next.nodes.map((row) => row.id)).toEqual(['i3']);
  });

  it('A2-15: paginateAll returns a flat array and stops at the first EMPTY page, never a merely short one', async () => {
    // A short page is ambiguous here because an oversized limit is silently
    // clamped, so the sweep pays one extra read rather than risk losing rows.
    const rec = recorder([
      () => jsonResponse([issue({ id: 'i1' }), issue({ id: 'i2' })]),
      () => jsonResponse([issue({ id: 'i3' })]),
      () => jsonResponse([]),
    ]);
    const all = await (await client(rec.fetchFn).listIssues({ limit: 2 })).paginateAll();
    expect(all.map((row) => row.id)).toEqual(['i1', 'i2', 'i3']);
    expect(rec.calls).toHaveLength(3);
  });

  it('A1-8: paginateAll THROWS at its page bound rather than returning a silent undercount', async () => {
    // A board that never ends. Returning the three rows it managed to read
    // would be indistinguishable from an exhausted board, and this artifact has
    // no totals endpoint to check the count against — the same silent row loss
    // A1-8 exists to forbid, manufactured on our side of the wire.
    const rec = recorder([() => jsonResponse([issue()])]);
    const page = await client(rec.fetchFn).listIssues({ limit: 1 });
    const err = await expectPaperclipError(
      () => page.paginateAll(3),
      PaperclipPaginationTruncatedError,
      'more still to read',
    );
    expect(err.type).toBe('pagination_truncated');
    expect(rec.calls).toHaveLength(3);
  });

  it('A2-15/A2-18: comments page on `after`, and `afterCommentId` is never sent because it is not representable', async () => {
    const rec = recorder([
      () => jsonResponse([{ id: 'c1', body: 'a', createdAt: 'x' }, { id: 'c2', body: 'b', createdAt: 'x' }]),
      () => jsonResponse([{ id: 'c3', body: 'c', createdAt: 'x' }]),
    ]);
    const page = await client(rec.fetchFn).listComments(ISSUE_ID, { limit: 2 });
    await page.fetchNext();
    const secondUrl = new URL(rec.calls[1]?.url as string);
    expect(secondUrl.searchParams.get('after')).toBe('c2');
    expect(secondUrl.searchParams.get('afterCommentId')).toBeNull();

    // The erasure is a compile-time fact, not a runtime check. This line must
    // not compile: `afterCommentId` is an exact alias of `after` and the
    // precedence when both are sent is recorded, never asserted.
    // @ts-expect-error afterCommentId is erased from the caller's vocabulary
    void client(rec.fetchFn).listComments(ISSUE_ID, { afterCommentId: 'c2' });
  });
});

// ── Guards the artifact forced ────────────────────────────────────────────

describe('artifact-forced guards', () => {
  it('A1-14: the string onBehalfOfUserId never appears in any serialized request body', async () => {
    const rec = recorder([jsonResponse({ id: 'x', body: 'b', createdAt: 'n' })]);
    const paperclip = client(rec.fetchFn);
    await paperclip.createIssue({ title: 'x', description: 'd' });
    await paperclip.patchIssue(ISSUE_ID, { status: 'done' });
    await paperclip.addComment(ISSUE_ID, { body: 'x' });
    await paperclip.wakeAgent('agent-1', { reason: 'x' });
    expect(rec.calls).not.toHaveLength(0);
    for (const call of rec.calls) {
      expect(String(call.init.body ?? '')).not.toContain('onBehalfOfUserId');
    }
  });
});

/**
 * A1-3 and A1-14 as a SOURCE scan, in the unit lane.
 *
 * The identical scan already exists in `client.paperclip.integration.test.ts` —
 * but that file is `.integration.test.ts`, excluded from `vitest.config.ts`, and
 * sits inside `describe.skipIf(!process.env.PAPERCLIP_TEST_AUTH_SECRET)`. So a
 * new source file containing `randomUUID` would pass `npm test` AND the
 * LocalStack integration lane, and only `npm run test:paperclip:all` would catch
 * it. This copy is the one that runs on every push.
 */
describe('source guards over this directory (A1-3, A1-14, A2-17, A2-21, A2-22)', () => {
  it('no module mints an identifier, names onBehalfOfUserId, writes != null, imports a package, or carries a forbidden name', async () => {
    const directory = new URL('./', import.meta.url);
    const all = await readdir(directory);
    const modules = all.filter((name) => name.endsWith('.ts') && !name.includes('.test.'));
    expect(modules.length, 'the scan matched no files, so every assertion below is vacuous').toBeGreaterThan(5);

    // A2-22 / C-8 / C-10: three names are forbidden by a settled decision, not
    // by taste. `disabled-mission-engine.ts` (C-8: the kill switch lives inside
    // the transport and the rollout flag lives at the router, so a third engine
    // has nothing to do); `agent-id-map.ts` and `reconciler-types.ts` (C-10:
    // canonical names are `agent-map.ts` and one `types.ts`). This is a
    // not-contains rather than an inventory equality on purpose — an equality
    // would be a tripwire pointed at Phase 5's own files.
    for (const forbidden of ['disabled-mission-engine.ts', 'agent-id-map.ts', 'reconciler-types.ts', 'dispatch-types.ts']) {
      expect(modules, `${forbidden} is forbidden by a settled decision`).not.toContain(forbidden);
    }

    let imports = 0;
    for (const name of all.filter((entry) => entry.endsWith('.ts'))) {
      const source = await readFile(new URL(name, directory), 'utf8');
      // `test-helpers.ts` is a TEST module that happens not to carry `.test.`
      // in its name, which is also why `tsconfig.build.json` excludes it by
      // name. Classing it as production here would forbid the `vitest` import
      // that lets its assertions produce a real diff.
      const production = !name.includes('.test.') && name !== 'test-helpers.ts';

      if (production) {
        // A1-3 / ADR hard constraint 2. The identical scan exists in
        // `client.paperclip.integration.test.ts`, but that lane is excluded from
        // `vitest.config.ts` and skipped without a live artifact, so a new
        // module containing `randomUUID` would pass `npm test`. This copy is the
        // one that runs on every push.
        expect(source, `A1-3: ${name} must never synthesize a Paperclip run id`).not.toMatch(/\brandomUUID\b/);
        expect(source, `A1-3: ${name} must never synthesize a Paperclip run id`).not.toMatch(/\buuid\s*\(/i);
        expect(source, `A1-14: ${name} must never serialize onBehalfOfUserId`).not.toMatch(/onBehalfOfUserId/);
        // A2-17, the half a projection suite cannot cover: having normalized
        // nullability once, nothing re-tests for null with the loose-equality
        // idiom. A single `!= null` downstream is the tell that somebody stopped
        // trusting the normalization and started re-deriving it.
        expect(source, `A2-17: ${name} must not use != null`).not.toMatch(/!=\s*null/);
      }

      // A2-21, stricter than Linear and stated as such: Linear vendored
      // graphql-request to reach ONE runtime dependency and separately imports
      // `graphql` without declaring it. Our target is literally zero, so for a
      // PRODUCTION module the check is not "every bare specifier is in
      // package.json dependencies" — it is that there is no bare specifier at
      // all. Test files may reach for a devDependency (`vitest`, and
      // `typescript` for the downlevel emit in `bundle.test.ts`); neither ships.
      const allowedPackages = production ? [] : ['vitest', 'typescript'];
      if (production) {
        // A1-2: one credential shape, `Authorization: Bearer <key>`. The name
        // may appear in a comment saying the alternative does not exist; it may
        // never appear on a line of code, which is what excluding leading `*`
        // and `//` lines tests.
        const code = source
          .split(/\r?\n/)
          .filter((line) => !/^\s*(\*|\/\/)/.test(line))
          .join(' ');
        expect(code, `A1-2: ${name} must not set an x-api-key header`).not.toMatch(/x-api-key/i);
      }
      for (const [, specifier] of source.matchAll(/\bfrom\s+'([^']+)'/g)) {
        imports += 1;
        const allowed =
          specifier.startsWith('.') || specifier.startsWith('node:') || allowedPackages.includes(specifier);
        expect(allowed, `A2-21: ${name} imports the package ${specifier}`).toBe(true);
      }
    }
    expect(imports, 'the import scan matched nothing, so it proved nothing').toBeGreaterThan(20);
  });
});
