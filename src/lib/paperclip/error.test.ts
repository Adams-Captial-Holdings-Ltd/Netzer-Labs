import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  parsePaperclipError,
  PaperclipAuthError,
  PaperclipCheckoutNotSelfError,
  PaperclipCompanyMismatchError,
  PaperclipConflictError,
  PaperclipDisabledError,
  PaperclipError,
  PaperclipInvalidInputError,
  PaperclipProjectPausedError,
  PaperclipRatelimitedError,
  PaperclipRunIdRequiredError,
  PaperclipUnavailableError,
  PaperclipUnknownError,
  CHECKOUT_NOT_SELF_MESSAGE,
  PROJECT_PAUSED_MESSAGES,
  RUN_ID_REQUIRED_MESSAGE,
  toValidationIssues,
  type PaperclipErrorType,
} from './error.js';

// Fakes only. No network is reachable from this file.
const request = { method: 'GET', path: '/api/issues/abc', query: { limit: '5' } };

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

/** Every member of the union, written out so a new one fails this file first. */
const ALL_TYPES: PaperclipErrorType[] = [
  'disabled',
  'run_id_required',
  'auth',
  'checkout_not_self',
  'ratelimited',
  'conflict',
  'project_paused',
  'invalid_input',
  'company_mismatch',
  'unavailable',
  'pagination_truncated',
  'unknown',
];

describe('PaperclipError', () => {
  it('A2-1: the base error retains all seven post-mortem fields and never discards the original', () => {
    const original = new TypeError('fetch failed');
    const err = parsePaperclipError(original, {
      status: 409,
      request,
      body: { error: 'Issue checkout conflict', code: 'nope', details: [{ path: ['status'], message: 'bad', code: 'invalid' }] },
    });

    expect(err.type).toBe('conflict');
    expect(err.status).toBe(409);
    expect(err.code).toBe('nope');
    expect(err.body?.error).toBe('Issue checkout conflict');
    expect(err.request).toEqual(request);
    expect(err.issues).toEqual([{ path: ['status'], message: 'bad', code: 'invalid' }]);
    expect(err.raw).toBe(original);
  });

  it('A2-2: every error type has a row in the dispatch table, and dispatch is a lookup not a switch', () => {
    for (const type of ALL_TYPES) {
      // A code that literally names a type is the one code form this parser
      // accepts, so this drives `ERROR_CONSTRUCTORS` as BOTH the membership test
      // and the dispatch in a single call — which is why there is one table
      // rather than the two Linear keeps.
      const err = parsePaperclipError(new Error('x'), { status: 200, body: { error: 'e', code: type } });
      expect(err.type).toBe(type);
      expect(err).toBeInstanceOf(PaperclipError);
    }
  });

  it('A2-3: parsePaperclipError is idempotent', () => {
    const once = parsePaperclipError(new Error('boom'), { status: 500, request });
    expect(parsePaperclipError(once)).toBe(once);
    expect(parsePaperclipError(once, { status: 400 })).toBe(once);
  });

  it.each([
    [403, undefined, PaperclipAuthError, 'auth'],
    [401, 'Wrong key', PaperclipAuthError, 'auth'],
    [401, RUN_ID_REQUIRED_MESSAGE, PaperclipRunIdRequiredError, 'run_id_required'],
    [429, 'Search rate limit exceeded', PaperclipRatelimitedError, 'ratelimited'],
    [409, 'Issue checkout conflict', PaperclipConflictError, 'conflict'],
    [422, "assigneeAgentId must be a UUID or 'null'", PaperclipConflictError, 'conflict'],
    [400, 'Validation error', PaperclipInvalidInputError, 'invalid_input'],
    [404, 'not found', PaperclipInvalidInputError, 'invalid_input'],
    [500, 'Internal server error', PaperclipUnavailableError, 'unavailable'],
    [502, 'bad gateway', PaperclipUnavailableError, 'unavailable'],
    [418, 'teapot', PaperclipUnknownError, 'unknown'],
  ])('A2-4: HTTP %i maps onto the documented rung', (status, error, Expected, type) => {
    const err = parsePaperclipError(new Error('x'), {
      status: status as number,
      body: error === undefined ? undefined : { error: error as string },
    });
    expect(err).toBeInstanceOf(Expected as typeof PaperclipError);
    expect(err.type).toBe(type);
  });

  it('A1-11: all three checkout/release strings are mapped in the parser, and only there', async () => {
    const source = await readFile(new URL('./error.ts', import.meta.url), 'utf8');
    const parse = (status: number, error: string): PaperclipError =>
      parsePaperclipError(new Error('x'), { status, body: { error } });

    // OBSERVED, by the probe "A1-11 (BLOCKING): the checkout and release
    // contract strings, observed rather than transcribed" and recorded in
    // `checkoutReleaseContract`: 403 on POST /api/issues/{id}/checkout driven
    // with a second agent's key.
    const notSelf = parse(403, CHECKOUT_NOT_SELF_MESSAGE);
    expect(notSelf).toBeInstanceOf(PaperclipCheckoutNotSelfError);
    expect(notSelf.type).toBe('checkout_not_self');
    // Any other 403 keeps the plain auth rung.
    expect(parse(403, 'Forbidden').type).toBe('auth');

    // UNVERIFIED: no probe drives a project to its budget hard stop, so these
    // two strings are transcribed from A1-11 rather than observed. Mapping them
    // is the point - a paused project and an ordinary checkout conflict are
    // both 409 with OPPOSITE remedies (stop vs retry).
    for (const paused of PROJECT_PAUSED_MESSAGES) {
      const err = parse(409, paused);
      expect(err).toBeInstanceOf(PaperclipProjectPausedError);
      expect(err.type).toBe('project_paused');
      // The exact server text survives for a post-mortem.
      expect(err.body?.error).toBe(paused);
    }
    // The observed 409 the pause pair must be told apart from stays `conflict`.
    expect(parse(409, 'Issue checkout conflict')).toBeInstanceOf(PaperclipConflictError);

    // "in ONE place (the parser), never string-matched at a call site": every
    // literal lives in error.ts, and every other module reads the constants.
    for (const literal of [RUN_ID_REQUIRED_MESSAGE, CHECKOUT_NOT_SELF_MESSAGE, ...PROJECT_PAUSED_MESSAGES]) {
      expect(source, `${literal} must be declared in error.ts`).toContain(literal);
    }
    const otherModules = await Promise.all(
      ['client.ts', 'config.ts', 'agent-map.ts', 'mission-engine.ts', 'paperclip-mission-engine.ts', 'mission-projection.ts', 'types.ts'].map(
        (name) => readFile(new URL(`./${name}`, import.meta.url), 'utf8'),
      ),
    );
    for (const [index, module] of otherModules.entries()) {
      for (const literal of [CHECKOUT_NOT_SELF_MESSAGE, ...PROJECT_PAUSED_MESSAGES]) {
        expect(
          module.split('\n').filter((line) => line.includes(literal) && !line.trim().startsWith('*')),
          `module ${index} must not match "${literal}" outside a comment`,
        ).toEqual([]);
      }
    }
  });

  it('A2-4: no status at all - a network failure, an abort or our own timeout - is unavailable', () => {
    const err = parsePaperclipError(new TypeError('fetch failed'));
    expect(err).toBeInstanceOf(PaperclipUnavailableError);
    expect(err.status).toBeUndefined();
  });

  it('A2-4: a semantic code that names a type beats the HTTP status', () => {
    const err = parsePaperclipError(new Error('x'), {
      status: 500,
      body: { error: 'looks like a server error', code: 'ratelimited' },
    });
    expect(err).toBeInstanceOf(PaperclipRatelimitedError);
  });

  it('A2-4: an unrecognized details code falls through to the status ladder rather than short-circuiting it', () => {
    // Linear short-circuits here and answers Unknown; we keep the status, which
    // is the one piece of information we always have.
    const err = parsePaperclipError(new Error('x'), {
      status: 429,
      body: { error: 'Search rate limit exceeded', code: 'SOME_VENDOR_CODE' },
    });
    expect(err).toBeInstanceOf(PaperclipRatelimitedError);
    expect(err.code).toBe('SOME_VENDOR_CODE');
  });

  it('A2-5: the rate-limit error carries the whole budget and both 429 shapes reach it', () => {
    const search = parsePaperclipError(new Error('x'), {
      status: 429,
      body: { error: 'Search rate limit exceeded', retryAfterSeconds: 12 },
      headers: headers({ 'retry-after': '12', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0' }),
    }) as PaperclipRatelimitedError;
    expect(search.retryAfter).toBe(12);
    expect(search.retryAfterSeconds).toBe(12);
    expect(search.limit).toBe(60);
    expect(search.remaining).toBe(0);
    expect(search.requestCache).toBeUndefined();

    const coalescer = parsePaperclipError(new Error('x'), {
      status: 429,
      body: { error: 'Too many concurrent issue-list requests for this actor/client', retryAfterSeconds: 2 },
      headers: headers({ 'retry-after': '2', 'x-paperclip-request-cache': 'retry' }),
    }) as PaperclipRatelimitedError;
    expect(coalescer.requestCache).toBe('retry');
    expect(coalescer.limit).toBeUndefined();
  });

  it('A2-5: a non-numeric or empty retry-after becomes undefined, never NaN', () => {
    const err = parsePaperclipError(new Error('x'), {
      status: 429,
      body: { error: 'slow down' },
      headers: headers({ 'retry-after': 'soon', 'x-ratelimit-remaining': '' }),
    }) as PaperclipRatelimitedError;
    expect(err.retryAfter).toBeUndefined();
    expect(err.remaining).toBeUndefined();
  });

  it('A2-6: sub-errors are inspectable structured values, not thrown errors', () => {
    expect(toValidationIssues([{ path: ['title'], message: 'Required', code: 'invalid_type' }])).toEqual([
      { path: ['title'], message: 'Required', code: 'invalid_type' },
    ]);
    // One thrown exception, N sub-errors: none of these is an Error.
    for (const issue of toValidationIssues([{ path: [], message: 'x', code: 'y' }]) ?? []) {
      expect(issue).not.toBeInstanceOf(Error);
    }
    expect(toValidationIssues('not an array')).toBeUndefined();
    expect(toValidationIssues([{ nope: true }])).toBeUndefined();
  });

  it('A2-7: candidates are capitalized, deduplicated, joined with a dash, and NEVER truncated', () => {
    const err = parsePaperclipError(new Error('Paperclip GET /api/issues responded 400'), {
      status: 400,
      body: {
        remediation: 'pass a uuid',
        // A legitimate server string containing `": {"`. Linear splits its
        // message at that sequence to undo an append it manufactured itself,
        // which truncates this one; nothing here appends, so nothing strips.
        error: 'assigneeAgentId must be a UUID or null, got: {"id":7}',
        code: 'pass a uuid',
      },
    });
    // remediation first and capitalized, the duplicate `code` folded away by the
    // Set, and the transport's own summary last as a separate candidate.
    expect(err.message).toBe(
      'Pass a uuid - assigneeAgentId must be a UUID or null, got: {"id":7} - Paperclip GET /api/issues responded 400',
    );
  });

  it('A2-5: Retry-After is honoured in BOTH legal forms, and garbage in either yields undefined not NaN', () => {
    const at = new Date(Date.now() + 4_000).toUTCString();
    const dated = parsePaperclipError(undefined, { status: 429, headers: headers({ 'retry-after': at }) });
    expect((dated as PaperclipRatelimitedError).advertisedWaitMs()).toBeGreaterThan(2_000);
    expect((dated as PaperclipRatelimitedError).advertisedWaitMs()).toBeLessThanOrEqual(4_000);

    for (const junk of ['soon', 'tomorrow-ish', '']) {
      const err = parsePaperclipError(undefined, { status: 429, headers: headers({ 'retry-after': junk }) });
      expect((err as PaperclipRatelimitedError).retryAfter, junk).toBeUndefined();
      expect((err as PaperclipRatelimitedError).advertisedWaitMs(), junk).toBeUndefined();
    }
  });

  it('A2-7: a zero-candidate error gets the default message rather than an empty string', () => {
    const err = parsePaperclipError({}, { status: 500 });
    expect(err.message).toContain('Unknown error from Paperclip');
    expect(err.message).not.toBe('');
  });

  it('A2-8: instanceof survives for every exported subclass, and each keeps its own name', () => {
    const subclasses = [
      PaperclipDisabledError,
      PaperclipRunIdRequiredError,
      PaperclipAuthError,
      PaperclipRatelimitedError,
      PaperclipConflictError,
      PaperclipInvalidInputError,
      PaperclipCompanyMismatchError,
      PaperclipUnavailableError,
      PaperclipUnknownError,
    ];
    for (const Subclass of subclasses) {
      const err = new Subclass({ body: { error: 'x' } });
      expect(err).toBeInstanceOf(Subclass);
      expect(err).toBeInstanceOf(PaperclipError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(Subclass.name);
      expect(err.stack).toBeTruthy();
    }
  });
});
