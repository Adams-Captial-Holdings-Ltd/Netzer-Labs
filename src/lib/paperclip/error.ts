/**
 * The Paperclip error taxonomy: one base class, nine leaves, one total dispatch
 * table, one idempotent parser.
 *
 * Three places this is deliberately stricter than Linear's `error.ts`:
 *
 * (1) The base class restores its own prototype and stamps its own name, so
 *     `instanceof` holds for every leaf under a downlevel emit. Linear does this
 *     only on its transport error, never on `LinearError`. Proven against a real
 *     ES5 emit by `bundle.test.ts`, not asserted about the source.
 * (2) `parseNumber` rejects `NaN`. Linear's `Number(value) ?? undefined` does
 *     not — `??` never fires for `NaN` — so `retry-after: soon` yields a
 *     well-typed wrong number that lands in a caller's backoff.
 * (3) `Retry-After` is read in BOTH legal forms. RFC 9110 §10.2.3 allows
 *     delta-seconds or an IMF-fixdate; Linear parses only the first, so a
 *     date-form header becomes `NaN` there. The pinned artifact has only ever
 *     been observed sending delta-seconds (probe "A1-10 (BLOCKING): the search
 *     429 - Retry-After, retryAfterSeconds and the X-RateLimit headers"), so the
 *     date branch is defensive against a future proxy, not against the artifact.
 *
 * Nothing here splits a manufactured suffix back off a message the way Linear's
 * `.split(": {")[0]` does: `client.ts` never appends one. It passes the summary
 * as a SEPARATE message candidate, so no legitimate server string containing
 * `": {"` can be truncated and there is no strip to keep in sync with an append.
 */
import type { PaperclipErrorBody, PaperclipValidationIssue } from './types.js';

/** The request half of the post-mortem set. */
export interface PaperclipRequestContext {
  method: string;
  path: string;
  query?: Record<string, string>;
}

/** Twelve members, each with a row in `ERROR_CONSTRUCTORS` below. */
export type PaperclipErrorType =
  | 'disabled'
  | 'run_id_required'
  | 'auth'
  | 'checkout_not_self'
  | 'ratelimited'
  | 'conflict'
  | 'project_paused'
  | 'invalid_input'
  | 'company_mismatch'
  | 'unavailable'
  | 'pagination_truncated'
  | 'unknown';

/**
 * THE RESPONSE STRINGS THAT CHANGE AN OUTCOME, matched here in the parser and
 * nowhere else — A1-11's rule. Every one of them is a string match against a
 * server message, so all four are fragile by construction: the day Paperclip
 * rewords one, that case degrades to the plain rung its status already earns
 * (`auth` for the two 401/403 strings, `conflict` for the pause pair) — the
 * correct failure direction, and the reason nothing downstream matches strings
 * itself.
 *
 * Observed by the probe "A1-11 (BLOCKING): the checkout and release contract
 * strings, observed rather than transcribed":
 *   - 401 `Agent run id required` on `POST /api/issues/{id}/release` with no
 *     run held — observed again by "C-3 (CHARACTERIZATION): which agent write
 *     shapes require X-Paperclip-Run-Id", which is also what proves an EMPTY
 *     run-id header is treated identically to an absent one.
 *   - 403 `Agent can only checkout as itself` on `POST
 *     /api/issues/{id}/checkout` driven with a second agent's key.
 * Both are recorded in `tests/contract/artifact-characterization.json` under
 * `runIdBoundary` and `checkoutReleaseContract`.
 */
export const RUN_ID_REQUIRED_MESSAGE = 'Agent run id required';
export const CHECKOUT_NOT_SELF_MESSAGE = 'Agent can only checkout as itself';

/**
 * UNVERIFIED — transcribed from A1-11, produced by no probe. Reaching either
 * string needs a project driven to its budget hard stop, which nothing in
 * `tests/contract/paperclip-routes.paperclip.integration.test.ts` does; the
 * `checkoutReleaseContract` characterization says so in as many words ("the two
 * pause strings the bar also names are absent because no probe here can drive a
 * project to its budget hard stop"). They are mapped rather than asserted: the
 * cost of the wording being stale is that a paused project reads as a plain
 * `conflict`, which is where it lands today anyway.
 *
 * Mapping them at all is what A1-11 is for. A paused project and an ordinary
 * `Issue checkout conflict` are both 409 and have OPPOSITE remedies — stop
 * versus retry — so a caller that cannot tell them apart retries into a wall.
 * Both strings share one type: the distinction between them is which pause it
 * is, not what the caller should do, and the exact server text survives on
 * `.body.error` for a post-mortem either way.
 */
export const PROJECT_PAUSED_MESSAGES: readonly string[] = [
  'Project is paused because its budget hard-stop was reached',
  'Project is paused',
];

export interface PaperclipErrorInit {
  type?: PaperclipErrorType;
  notSent?: boolean;
  status?: number;
  body?: PaperclipErrorBody;
  request?: PaperclipRequestContext;
  issues?: PaperclipValidationIssue[];
  raw?: unknown;
  /**
   * Response headers, consumed only by `PaperclipRatelimitedError`'s
   * constructor. Deliberately not one of the seven retained fields: the one
   * subclass that needs them keeps what it parses.
   */
  headers?: Headers;
  /** Last-resort message candidate, e.g. a `TypeError` raised by `fetch`. */
  message?: string;
}

/**
 * A leaf cannot be handed a contradictory `type`: it is unrepresentable rather
 * than runtime-checked.
 */
type LeafInit = Omit<PaperclipErrorInit, 'type'>;

/**
 * Empty string, `null`, `undefined` AND non-numeric input all yield `undefined`.
 * Exported because `config.ts` parses env numbers with the same hazard and a
 * second hand-rolled number parser is a second place for `NaN` to leak.
 */
export function parseNumber(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const DEFAULT_MESSAGE = 'Unknown error from Paperclip';

/**
 * Preference chain `remediation ?? error ?? code ?? raw message`, deduplicated
 * through a `Set`, joined with `" - "`, first candidate capitalized.
 *
 * The default lands on the EMPTY case. Linear writes `…join(" - ") ??
 * defaultError`, which is dead code — `join` always returns a string, so a
 * zero-candidate error there gets `message === ""` and never the default.
 *
 * `remediation` is read first and is the least-evidenced field in `types.ts`:
 * no probe has ever produced one and the string occurs zero times in the
 * committed OpenAPI snapshot, which is exactly why every `??` fallback stays.
 * `init.message` is last and is where `client.ts` puts `Paperclip GET /path
 * responded 502`, so every transport failure names the call that failed without
 * anything being spliced into the server's own words.
 */
function buildMessage(type: PaperclipErrorType, init: PaperclipErrorInit): string {
  const body = init.body;
  const remediation = typeof body?.remediation === 'string' ? body.remediation : undefined;
  const [first, ...rest] = Array.from(
    new Set(
      [remediation, body?.error, body?.code, init.message]
        .filter((candidate): candidate is string => candidate !== undefined)
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.length > 0),
    ),
  );
  if (first === undefined) return `${DEFAULT_MESSAGE} (${type})`;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' - ');
}

/**
 * One thrown exception, N inspectable structured sub-errors. Linear's
 * `LinearGraphQLError` is a class that deliberately does not extend `Error`;
 * ours is the same idea with one fewer moving part, because
 * `PaperclipValidationIssue` is already declared in `types.ts`, the one
 * wire-shape file, and re-declaring it as a class here would fork the shape it
 * pins. The narrowing lives here; the shape stays there.
 *
 * `details` is marked UNVERIFIED in `types.ts` in BOTH directions, so this
 * narrows defensively and answers `undefined` rather than asserting.
 */
export function toValidationIssues(details: unknown): PaperclipValidationIssue[] | undefined {
  if (!Array.isArray(details)) return undefined;
  const issues = details.filter((entry): entry is PaperclipValidationIssue => {
    if (typeof entry !== 'object' || entry === null) return false;
    const candidate = entry as Record<string, unknown>;
    return Array.isArray(candidate.path) && typeof candidate.message === 'string';
  });
  return issues.length > 0 ? issues : undefined;
}

// ── The base class ────────────────────────────────────────────────────────

/** Seven fields, and the original always survives on `raw`. */
export class PaperclipError extends Error {
  readonly type: PaperclipErrorType;
  readonly status?: number;
  readonly code?: string;
  readonly body?: PaperclipErrorBody;
  readonly request?: PaperclipRequestContext;
  readonly issues?: PaperclipValidationIssue[];
  readonly raw?: unknown;
  readonly notSent?: boolean;

  constructor(init: PaperclipErrorInit = {}) {
    const type = init.type ?? 'unknown';
    super(buildMessage(type, init));
    this.name = new.target.name;
    this.type = type;
    this.status = init.status;
    // The SAME expression `typeForResponse` dispatches on. A field recording a
    // code the dispatch never saw would make a post-mortem disagree with the
    // taxonomy it produced.
    this.code = init.body?.code;
    this.body = init.body;
    this.request = init.request;
    this.issues = init.issues ?? toValidationIssues(init.body?.details);
    this.raw = init.raw;
    this.notSent = init.notSent;
    // `new.target` makes these two lines cover every subclass at once.
    Object.setPrototypeOf(this, new.target.prototype);
    if (typeof Error.captureStackTrace === 'function') Error.captureStackTrace(this, new.target);
  }
}

// ── Leaf subclasses: one line each, binding only their type ───────────────

export class PaperclipDisabledError extends PaperclipError {
  constructor(init: LeafInit = {}) { super({ ...init, type: 'disabled' }); }
}
/** A runtime lock refusal, separate from the operator kill switch. */
export class PaperclipLockClosedError extends PaperclipDisabledError {
  readonly lockCode: string;
  constructor(init: LeafInit, code: string) { super(init); this.lockCode = code; }
}
export class PaperclipRunIdRequiredError extends PaperclipError {
  constructor(init: LeafInit = {}) { super({ ...init, type: 'run_id_required' }); }
}
export class PaperclipAuthError extends PaperclipError {
  constructor(init: LeafInit = {}) { super({ ...init, type: 'auth' }); }
}
/** A1-11: the 403 an agent gets for checking out AS ANOTHER AGENT. Not a key problem — no retry, no re-auth, fix the `agentId` in the body. */
export class PaperclipCheckoutNotSelfError extends PaperclipError {
  constructor(init: LeafInit = {}) { super({ ...init, type: 'checkout_not_self' }); }
}
export class PaperclipConflictError extends PaperclipError {
  constructor(init: LeafInit = {}) { super({ ...init, type: 'conflict' }); }
}
/** A1-11: a 409 that means STOP, unlike its `conflict` sibling which means retry. Both pause strings land here; see `PROJECT_PAUSED_MESSAGES` for why they are UNVERIFIED. */
export class PaperclipProjectPausedError extends PaperclipError {
  constructor(init: LeafInit = {}) { super({ ...init, type: 'project_paused' }); }
}
export class PaperclipInvalidInputError extends PaperclipError {
  constructor(init: LeafInit = {}) { super({ ...init, type: 'invalid_input' }); }
}
export class PaperclipCompanyMismatchError extends PaperclipError {
  constructor(init: LeafInit = {}) { super({ ...init, type: 'company_mismatch' }); }
}
export class PaperclipUnavailableError extends PaperclipError {
  constructor(init: LeafInit = {}) { super({ ...init, type: 'unavailable' }); }
}
/**
 * The only leaf `typeForResponse` never produces: it is raised by
 * `PaperclipPage.paginateAll` when the page bound is reached with rows still on
 * the board. A truncated sweep that returned a plain array would be
 * indistinguishable from an exhausted one, and this artifact has NO totals
 * endpoint to cross-check against (probe "characterized: /issues/count is an
 * attention query, not a totals endpoint"), so a silent undercount is exactly
 * the hazard A1-8 exists to forbid. Loud beats short.
 */
export class PaperclipPaginationTruncatedError extends PaperclipError {
  constructor(init: LeafInit = {}) { super({ ...init, type: 'pagination_truncated' }); }
}
export class PaperclipUnknownError extends PaperclipError {
  constructor(init: LeafInit = {}) { super({ ...init, type: 'unknown' }); }
}

/**
 * `Retry-After` in BOTH legal RFC 9110 §10.2.3 forms — delta-seconds, or an
 * IMF-fixdate resolved against the clock now. Garbage in either form yields
 * `undefined`, never `NaN`: `Number('soon')` and `Date.parse('soon')` are both
 * `NaN` and both are rejected here, which is the whole reason `advertisedWaitMs`
 * can never hand a `NaN` to a `setTimeout`. A date already in the past clamps to
 * zero rather than going negative.
 */
function retryAfterSeconds(raw: string | null | undefined, now = Date.now()): number | undefined {
  const seconds = parseNumber(raw);
  if (seconds !== undefined) return seconds;
  if (raw === null || raw === undefined || raw === '') return undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, (at - now) / 1_000) : undefined;
}

/**
 * The only subclass that adds fields, and it carries the whole budget rather
 * than just the failure. TWO independent 429 shapes reach here, both proven,
 * which is why every field is optional and a caller reads whichever arrived:
 *
 *  - THE SEARCH BUCKET, per the probe "A1-10 (BLOCKING): the search 429 -
 *    Retry-After, retryAfterSeconds and the X-RateLimit headers" — carries
 *    `X-RateLimit-Limit`/`-Remaining`, `Retry-After`, a numeric
 *    `retryAfterSeconds`, and no `code`.
 *  - THE ISSUE-LIST COALESCER, per "A1-10 (BLOCKING): the issue-list retry is a
 *    coalescer, not a rate limit, and identical reads never trip it" — carries
 *    `X-Paperclip-Request-Cache: retry` and NO `X-RateLimit-*` at all.
 *
 * The SDK supplies the data. `client.ts`'s retry policy is the one consumer
 * that acts on it, and a caller who turns retry off still gets these numbers.
 */
export class PaperclipRatelimitedError extends PaperclipError {
  readonly retryAfter?: number;
  readonly retryAfterSeconds?: number;
  readonly limit?: number;
  readonly remaining?: number;
  readonly requestCache?: string;

  constructor(init: LeafInit = {}) {
    super({ ...init, type: 'ratelimited' });
    const headers = init.headers;
    this.retryAfter = retryAfterSeconds(headers?.get('retry-after'));
    this.retryAfterSeconds =
      typeof init.body?.retryAfterSeconds === 'number' ? init.body.retryAfterSeconds : undefined;
    this.limit = parseNumber(headers?.get('x-ratelimit-limit'));
    this.remaining = parseNumber(headers?.get('x-ratelimit-remaining'));
    this.requestCache = headers?.get('x-paperclip-request-cache') ?? undefined;
  }

  /**
   * The wait the SERVER asked for, in milliseconds, or `undefined` when it
   * asked for none. Both proven shapes are read and the larger wins: a response
   * carrying both is asking to be obeyed on the longer one. Non-numeric header
   * values are already `undefined` rather than `NaN`, so this can never hand a
   * `NaN` to a `setTimeout`.
   */
  advertisedWaitMs(): number | undefined {
    const seconds = [this.retryAfterSeconds, this.retryAfter].filter(
      (value): value is number => value !== undefined,
    );
    return seconds.length === 0 ? undefined : Math.max(...seconds) * 1_000;
  }
}

/**
 * The one dispatch table, and the runtime membership test behind the
 * semantic-code branch. Adding a `PaperclipErrorType` member fails to compile
 * until it has a row here. No `?? PaperclipError` fallback: the `Record` is
 * total by construction and `type` comes from `typeForResponse`, which returns
 * that same union, so the fallback Linear needs — its map is partial — could
 * never fire here.
 */
const ERROR_CONSTRUCTORS: Record<PaperclipErrorType, new (init?: LeafInit) => PaperclipError> = {
  disabled: PaperclipDisabledError,
  run_id_required: PaperclipRunIdRequiredError,
  auth: PaperclipAuthError,
  checkout_not_self: PaperclipCheckoutNotSelfError,
  ratelimited: PaperclipRatelimitedError,
  conflict: PaperclipConflictError,
  project_paused: PaperclipProjectPausedError,
  invalid_input: PaperclipInvalidInputError,
  company_mismatch: PaperclipCompanyMismatchError,
  unavailable: PaperclipUnavailableError,
  pagination_truncated: PaperclipPaginationTruncatedError,
  unknown: PaperclipUnknownError,
};

function isErrorType(value: string): value is PaperclipErrorType {
  return Object.prototype.hasOwnProperty.call(ERROR_CONSTRUCTORS, value);
}

/**
 * Semantic code beats HTTP status, with the unrecognized-code case decided
 * EXPLICITLY rather than left to fall out of the code.
 *
 * AN UNRECOGNIZED CODE FALLS THROUGH to the status ladder. Linear
 * short-circuits — `LinearGraphQLError` coerces an unknown `extensions.type` to
 * `Unknown` and `parseLinearError` reads `errors[0]?.type`, so there a 429
 * whose GraphQL error carries an unfamiliar type yields `UnknownLinearError`
 * and discards the rate limit it plainly had. Pinned by the test "A2-4: an
 * unrecognized details code falls through to the status ladder rather than
 * short-circuiting it".
 *
 * WHY THE ACCEPTED CODE SET IS NOT A TRANSCRIBED TABLE. No probe has ever
 * produced a body carrying `code`, and the committed OpenAPI snapshot types the
 * shared `Error` schema as `{error}` and nothing else. Inventing a vendor-code
 * table from prose is the defect A1-16 forbids, so the only codes honoured are
 * those that literally name one of our own types; every other code is retained
 * on `.code` for post-mortem and ignored for dispatch.
 *
 * 422 shares the `conflict` rung with 409 exactly as A2-4 specifies. The pinned
 * artifact's only observed 422 (`assigneeAgentId must be a UUID or 'null'`)
 * reads more like validation, but that status is RECORDED in
 * `tests/contract/artifact-characterization.json`, not asserted by a probe, and
 * a recorded status cannot outrank the bar. Nothing downstream turns on it:
 * both rungs are non-transient, so `client.ts` retries neither.
 */
function typeForResponse(
  status: number | undefined,
  body: PaperclipErrorBody | undefined,
): PaperclipErrorType {
  const code = body?.code;
  if (code !== undefined && isErrorType(code)) return code;
  // A network failure, an abort, or one of our own timeouts arrives with no
  // status at all.
  if (status === undefined) return 'unavailable';
  if (status === 401) return body?.error === RUN_ID_REQUIRED_MESSAGE ? 'run_id_required' : 'auth';
  if (status === 403) return body?.error === CHECKOUT_NOT_SELF_MESSAGE ? 'checkout_not_self' : 'auth';
  if (status === 429) return 'ratelimited';
  // The pause pair is 409 only; 422 keeps the plain `conflict` rung it shares.
  if (status === 409) {
    return body?.error !== undefined && PROJECT_PAUSED_MESSAGES.includes(body.error)
      ? 'project_paused'
      : 'conflict';
  }
  if (status === 422) return 'conflict';
  if (status === 400 || status === 404) return 'invalid_input';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}

export interface ParsePaperclipErrorContext {
  status?: number;
  body?: PaperclipErrorBody;
  headers?: Headers;
  request?: PaperclipRequestContext;
}

/**
 * Idempotent, which is essential the moment two layers both normalize — here,
 * the transport and the mission engine above it.
 */
export function parsePaperclipError(
  raw: unknown,
  ctx: ParsePaperclipErrorContext = {},
): PaperclipError {
  if (raw instanceof PaperclipError) return raw;
  const Constructor = ERROR_CONSTRUCTORS[typeForResponse(ctx.status, ctx.body)];
  return new Constructor({
    status: ctx.status,
    body: ctx.body,
    headers: ctx.headers,
    request: ctx.request,
    raw,
    message: raw instanceof Error ? raw.message : undefined,
  });
}
