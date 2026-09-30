/**
 * The Paperclip HTTP transport.
 *
 * SHAPE. One private `invoke()` core, two public exits — `request()` returns
 * the parsed body, `rawRequest()` returns `{data, status, headers}` — and nine
 * mechanical resource methods over the top. Error
 * normalization is injected at exactly ONE seam, the `catch` in `invoke()`:
 * there is no per-method try/catch below it and both public exits go through
 * it, so a caller cannot reach an un-normalized error the way Linear's
 * standalone `LinearGraphQLClient.request()` lets you.
 *
 * THE KILL SWITCH IS CHECKED AT EVERY INVOKE, AND BEFORE THE BREAKER.
 * `paperclip_disabled` has been registered in `kill-switches-repo.ts` since
 * before this file existed with zero callers; it gets its first one here,
 * deliberately at the bottom of the stack rather than at a route, so no future
 * caller can bypass it — the same reasoning as `src/lib/bedrock/guard.ts`'s
 * `guardedBedrockSend`. Ordering matters: a deliberately switched-off
 * integration must answer `PaperclipDisabledError` even while the breaker is
 * open, never `PaperclipUnavailableError`.
 *
 * TWO DELIBERATE DIVERGENCES FROM LINEAR:
 *
 *  TIMEOUTS. Linear has none anywhere in its six hand-written files. We take
 *  10 s reads / 20 s writes (`config.ts`) because the ALB `idleTimeout` is
 *  4000 s and a hung Paperclip must not hold a Fargate request slot for over an
 *  hour. A caller's own `signal` is combined with ours, never replaced.
 *
 *  RETRY AND BREAKER. Linear ships zero retry, backoff, jitter, breaker or
 *  idempotency key by design: it hands you a typed error and the policy is the
 *  app's. We keep a policy because the reconciler is the durability layer of a
 *  single internal service — but the whole policy is a plain injectable object,
 *  `PAPERCLIP_NO_RETRY` turns it off, the rules are narrow (GETs and writes
 *  carrying an `idempotencyKey` only, never a 4xx except 429), and when the
 *  server names its own wait we obey it rather than our jitter.
 *
 * THIS FILE MINTS NO IDENTIFIER. It never synthesizes an `X-Paperclip-Run-Id`:
 * a fabricated one passes the header guard and dies at a Postgres 23503 foreign
 * key violation on `issues_checkout_run_id_heartbeat_runs_id_fk` rather than a
 * clean 4xx, proven by the probe "FI-4: a fabricated run id passes the header
 * guard and reaches the heartbeat FK". An absent run id is omitted, never sent
 * empty — the probe "C-3 (CHARACTERIZATION): which agent write shapes require
 * X-Paperclip-Run-Id" proves an empty header is treated identically to an
 * absent one, so sending `''` buys nothing and hides intent.
 */
import { logger } from '../../observability/logger.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { loadPaperclipConfig, paperclipConfig, type PaperclipConfig, type PaperclipConfigInput } from './config.js';
import { getPaperclipLockState } from './runtime-lock.js';
import {
  PaperclipCompanyMismatchError,
  PaperclipDisabledError,
  PaperclipPaginationTruncatedError,
  PaperclipRatelimitedError,
  PaperclipUnavailableError,
  parsePaperclipError,
  type PaperclipRequestContext,
} from './error.js';
import {
  ISSUE_LIST_DEFAULT_LIMIT,
  MAX_ISSUE_COMMENT_LIMIT,
  PAPERCLIP_RUN_ID_HEADER,
  type PaperclipAgent,
  type PaperclipCommentsQuery,
  type PaperclipCreateCommentBody,
  type PaperclipCreateIssueBody,
  type PaperclipCreateIssueResponse,
  type PaperclipErrorBody,
  type PaperclipFetch,
  type PaperclipHealth,
  type PaperclipIssue,
  type PaperclipIssueComment,
  type PaperclipIssueDetail,
  type PaperclipIssueListQuery,
  type PaperclipUpdateIssueBody,
  type PaperclipWakeupBody,
  type PaperclipWakeupResponse,
} from './types.js';

/**
 * HARD-CODED, and that is the point: Linear builds its User-Agent from
 * `process.env.npm_package_name`, which resolves to the CONSUMER's package at
 * runtime, so every downstream app misreports itself as the SDK. Do not copy
 * that line.
 */
const USER_AGENT = 'netzar-os/0.0.1';

// ── Retry policy ──────────────────────────────────────────────────────────

export interface PaperclipRetryPolicy {
  /** Total attempts, not extra attempts. 1 disables retry entirely. */
  attempts: number;
  baseMs: number;
  capMs: number;
  /**
   * Consecutive failed CALLS that open the breaker — not failed attempts. With
   * `attempts: 3` those differ by 3x, and the operator-facing remediation string
   * says "consecutive transient failures", so counting attempts would make the
   * breaker's own message false to the person reading it at 3am.
   */
  breakerThreshold: number;
  /** How long the breaker stays open before it half-opens. */
  breakerCooldownMs: number;
  /** Injected so a test asserts the backoff schedule instead of sleeping it. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Ceiling on a wait the SERVER asked for. A 429's own `Retry-After` is a floor
 * on the backoff, not a suggestion — but an upstream that answers `Retry-After:
 * 86400` must not park a poll for a day, so the honoured wait is clamped here
 * and the call fails instead. A module constant rather than a policy field: it
 * is not one of the seven knobs A2-12 names and nothing has ever set it.
 */
const MAX_RETRY_AFTER_MS = 30_000;

export const PAPERCLIP_RETRY_POLICY: PaperclipRetryPolicy = {
  attempts: 3,
  baseMs: 250,
  capMs: 4_000,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
};

/** The escape hatch: a caller can turn the policy off. */
export const PAPERCLIP_NO_RETRY: PaperclipRetryPolicy = { ...PAPERCLIP_RETRY_POLICY, attempts: 1 };

// ── Options and results ───────────────────────────────────────────────────

/**
 * Extends `RequestInit`, and every key this client does not name is re-spread
 * into `fetch`, so `keepalive`, `cache` and a caller `signal` work for free;
 * redirects are fixed to 'error'. `headers` is destructured out in the
 * constructor precisely so the rest-spread cannot clobber the assembled
 * header block.
 */
export interface PaperclipClientOptions extends RequestInit, PaperclipConfigInput {
  fetchFn?: typeof fetch;
  retry?: PaperclipRetryPolicy;
  /** Injected so a test drives the switch without touching DynamoDB. */
  killSwitch?: typeof isKillSwitchActive;
  now?: () => number;
}

/**
 * A2-14's own shape: the parsed body plus `headers` and `status`. Nothing is
 * lifted out of `headers` into a named field —
 * `raw.headers.get('x-paperclip-request-cache')` is already the whole answer,
 * and a copy would just be a second thing to keep in sync.
 */
export interface PaperclipRawResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

export interface PaperclipInvokeOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Names the agent slug whose key signs this request; unset means the
   * configured default. C-9 settled the field name: `actor`, never `as`.
   */
  actor?: string;
  /**
   * A run id the CALLER already holds. Never synthesized here, never sent
   * empty, omitted entirely when absent.
   */
  runId?: string;
  signal?: AbortSignal;
}

// ── Pagination ────────────────────────────────────────────────────────────

/**
 * The erasure repeated on the captured variables type and not only on the
 * public method signature — Linear repeats its `Omit<>` at every layer that
 * redeclares the variables, and a page that quietly re-widened the type would
 * hand the erased names back to the caller through `fetchNext`.
 */
export type CommentsPageVariables = Omit<PaperclipCommentsQuery, 'afterCommentId' | 'order'>;

export interface PaperclipPageCursor {
  offset?: number;
  after?: string;
}

/**
 * A container holding a refetch closure captured at construction, so the
 * filters from page 1 survive to page N and a caller cannot drop them.
 * Linear's equivalent wraps them in `defaultConnection()` to inject a page size
 * when only a cursor is present; ours does that inside each resource method's
 * closure, where the right default is actually known.
 *
 * `hasMore` is a non-nullable boolean and the cursor is nullable, matching
 * Linear's `PageInfo`. The page is seeded SAFE-EMPTY, so an unpopulated page is
 * never `undefined`-shaped.
 *
 * ONE DIVERGENCE, stated rather than hidden: Linear's `fetchNext()` mutates and
 * returns `this`. Ours returns a NEW page and leaves the old one intact — the
 * only case that returns `this` is the exhausted no-op, which is the behaviour
 * A2-15 actually names.
 */
export class PaperclipPage<TNode, TVars extends object = Record<string, never>> {
  readonly nodes: readonly TNode[];
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  readonly nextCursor?: string;
  private readonly variables: TVars;
  private readonly refetch?: (variables: TVars & PaperclipPageCursor) => Promise<PaperclipPage<TNode, TVars>>;

  constructor(
    init: {
      nodes?: readonly TNode[];
      hasMore?: boolean;
      nextOffset?: number;
      nextCursor?: string;
      variables?: TVars;
      refetch?: (variables: TVars & PaperclipPageCursor) => Promise<PaperclipPage<TNode, TVars>>;
    } = {},
  ) {
    this.nodes = init.nodes ?? [];
    this.hasMore = init.hasMore ?? false;
    this.nextOffset = init.nextOffset;
    this.nextCursor = init.nextCursor;
    this.variables = init.variables ?? ({} as TVars);
    this.refetch = init.refetch;
  }

  /**
   * The variables captured when this page was built, then the cursor — last, so
   * a caller cannot pin the page it is leaving. That order is the criterion:
   * the filters of page 1 reach page N and the caller cannot drop them.
   */
  async fetchNext(): Promise<PaperclipPage<TNode, TVars>> {
    if (!this.hasMore || !this.refetch) return this;
    const cursor: PaperclipPageCursor = {};
    if (this.nextOffset !== undefined) cursor.offset = this.nextOffset;
    if (this.nextCursor !== undefined) cursor.after = this.nextCursor;
    // One cast, at the one place two partial layers become one whole.
    return this.refetch({ ...this.variables, ...cursor } as TVars & PaperclipPageCursor);
  }

  /**
   * The flat `T[]`, or a THROW. `maxPages` is a hard stop rather than an
   * optimism budget: this artifact has NO totals endpoint (the probe
   * "characterized: /issues/count is an attention query, not a totals endpoint"
   * shows `issues/count` answering 400 without `attention=blocked`), so paging
   * to an empty page is the only way to size a board and a sweep needs a bound.
   *
   * Hitting that bound with rows still on the board raises
   * `PaperclipPaginationTruncatedError` instead of returning a short array.
   * Returning one would hand a caller an undercount it has no way to detect —
   * on a surface with no total to check it against, that is the same silent
   * row loss A1-8 exists to forbid, manufactured client-side.
   */
  async paginateAll(maxPages = 100): Promise<TNode[]> {
    const all: TNode[] = [...this.nodes];
    let page: PaperclipPage<TNode, TVars> = this;
    for (let seen = 1; page.hasMore; seen += 1) {
      if (seen >= maxPages) {
        throw new PaperclipPaginationTruncatedError({
          body: {
            error: `Paperclip pagination stopped after ${maxPages} pages with ${all.length} rows and more still to read`,
            remediation: 'raise maxPages, or narrow the query with updatedSince',
          },
        });
      }
      const next = await page.fetchNext();
      if (next === page) break;
      all.push(...next.nodes);
      page = next;
    }
    return all;
  }
}

// ── Header assembly ───────────────────────────────────────────────────────

/**
 * Spreading a raw `Headers` instance yields `{}` and silently drops every
 * header, so all three `HeadersInit` forms are normalized BEFORE the spread or
 * the documented order is a lie. The `Headers` constructor already accepts all
 * three, so it does the normalizing rather than a hand-rolled branch.
 */
function resolveHeaders(headers: RequestInit['headers']): Record<string, string> {
  return headers ? Object.fromEntries(new Headers(headers)) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ONE NETZAR DEPLOYMENT = ONE PAPERCLIP COMPANY. An ACCEPTED ARCHITECTURAL
 * INVARIANT, not defensive coding, and the owner's decision is that it is
 * permanent and enforced HERE rather than by review.
 *
 * What it buys: Paperclip has ~735 company-scoped handlers and whether every
 * one of them is tenant-safe is UNVERIFIED. This invariant is what makes that
 * question irrelevant — if the process only ever addresses one company, a
 * cross-tenant handler bug has no second tenant to leak into. That argument
 * holds only while the invariant does, so a second company must not be able to
 * appear quietly; it has to be impossible.
 *
 * The first constructed client pins the company id for the life of the process
 * and every later client is checked against it, at CONSTRUCTION, beside the
 * missing-base-url and missing-agent-key fail-fasts in `paperclipConfig` and in
 * the same typed `PaperclipDisabledError` shape. It fails CLOSED: the throw
 * happens before the instance exists, so a mis-scoped client cannot reach
 * `invoke` and cannot make a request.
 *
 * This is NOT the same check as `assertCompanyScope` further down. That one
 * reads a company id off a RESPONSE and catches Paperclip answering for someone
 * else; this one catches US asking. Neither implies the other.
 */
let pinnedCompanyId: string | undefined;

/** Test seam, in `__setSqsClient`'s shape. Production never calls it. */
export function __resetPaperclipCompanyPin(): void {
  pinnedCompanyId = undefined;
}

// ── The client ────────────────────────────────────────────────────────────

export class PaperclipClient {
  readonly config: PaperclipConfig;
  private readonly fetchFn: typeof fetch;
  private readonly retry: PaperclipRetryPolicy;
  private readonly killSwitch: typeof isKillSwitchActive;
  private readonly now: () => number;
  private readonly baseHeaders: Record<string, string>;
  private readonly requestInit: RequestInit;
  private breakerFailures = 0;
  private breakerOpenedAt: number | undefined;

  /**
   * SYNCHRONOUS and total: a missing base URL, company or agent key throws
   * `PaperclipDisabledError` here, naming the secret path and the runtime-config
   * key, rather than becoming a request to `undefined/api/…`. A company id that
   * disagrees with the one this process already pinned throws the same way, for
   * the reason recorded above `pinnedCompanyId`.
   */
  constructor(options: PaperclipClientOptions = {}) {
    const {
      baseUrl, companyId, agentKeys, defaultActor, readTimeoutMs, writeTimeoutMs,
      fetchFn, retry, killSwitch, now,
      headers,
      ...rest
    } = options;
    this.config = paperclipConfig({ baseUrl, companyId, agentKeys, defaultActor, readTimeoutMs, writeTimeoutMs });
    // The one-company invariant, enforced before any field of this instance is
    // usable. `paperclipConfig` has already rejected an absent or blank company
    // id, so `this.config.companyId` is a real value by here.
    if (pinnedCompanyId !== undefined && pinnedCompanyId !== this.config.companyId) {
      throw new PaperclipDisabledError({
        body: {
          error: `Paperclip is not configured: one Netzar deployment addresses exactly one Paperclip company, and this process is already pinned to ${pinnedCompanyId} (got ${this.config.companyId})`,
          remediation:
            'this is an accepted architectural invariant, not a tunable — run a second Netzar deployment for a second company rather than a second company id in this one',
        },
      });
    }
    pinnedCompanyId = this.config.companyId;
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.retry = retry ?? PAPERCLIP_RETRY_POLICY;
    this.killSwitch = killSwitch ?? isKillSwitchActive;
    this.now = now ?? Date.now;
    this.baseHeaders = resolveHeaders(headers);
    this.requestInit = rest;
  }

  // ── The two public exits ────────────────────────────────────────────────

  /** The parsed body, which is what almost every caller wants. */
  async request<T>(method: string, path: string, opts: PaperclipInvokeOptions = {}): PaperclipFetch<T> {
    return (await this.invoke<T>(method, path, opts)).data;
  }

  /** The body plus the response metadata a rate-limit-aware caller needs. */
  async rawRequest<T>(
    method: string,
    path: string,
    opts: PaperclipInvokeOptions = {},
  ): PaperclipFetch<PaperclipRawResponse<T>> {
    return this.invoke<T>(method, path, opts);
  }

  // ── Resource methods: mechanical and uniform ────────────────────────────

  /**
   * `GET /api/companies/{companyId}/issues`, which answers a BARE ARRAY — no
   * envelope, no `total`, no `nextOffset` (proven by "A1-5: the issue list
   * answers with a bare Array, not an envelope"). `hasMore` is therefore
   * inferred, and an empty page ends the sweep.
   *
   * CONCURRENCY, and it is the opposite of the obvious advice: identical
   * concurrent reads COALESCE and are never refused, while DISTINCT concurrent
   * reads for one actor are exactly what trips `429 Too many concurrent
   * issue-list requests for this actor/client`. A sweep fanning out over offsets
   * is the shape that gets refused, which is why `paginateAll` walks serially.
   */
  async listIssues(
    query: PaperclipIssueListQuery = {},
    opts: PaperclipInvokeOptions = {},
  ): PaperclipFetch<PaperclipPage<PaperclipIssue, PaperclipIssueListQuery>> {
    const limit = query.limit ?? ISSUE_LIST_DEFAULT_LIMIT;
    const offset = query.offset ?? 0;
    const variables: PaperclipIssueListQuery = { ...query, limit };
    const nodes = await this.request<PaperclipIssue[]>('GET', this.issuesPath(), {
      ...opts,
      query: { ...variables, offset },
    });
    return new PaperclipPage<PaperclipIssue, PaperclipIssueListQuery>({
      nodes,
      // TERMINATE ON AN EMPTY PAGE, NOT A SHORT ONE. The obvious predicate is
      // `nodes.length >= limit`, and it is wrong here: an oversized `limit` is
      // SILENTLY CLAMPED rather than rejected (probe "A1-7: sortField accepts
      // only 'updated', limit over the max is clamped, limit<=0 is a 400"), and
      // `ISSUE_LIST_MAX_LIMIT` is itself marked UNVERIFIED in `types.ts` — so a
      // clamped full page looks short and a short-page sweep would stop with
      // rows still on the board. An empty page is unambiguous (probe "A1-5
      // (BLOCKING): offset pages the list": an offset past the end is a 200
      // with []), and it costs exactly one extra read per sweep.
      hasMore: nodes.length > 0,
      nextOffset: offset + nodes.length,
      variables,
      // The captured closure. The page size is re-applied here — Linear's
      // `defaultConnection` equivalent — so a cursor-only refetch is never
      // page-size-less.
      refetch: (next) => this.listIssues({ ...next, limit: next.limit ?? limit }, opts),
    });
  }

  getIssue(issueId: string, opts: PaperclipInvokeOptions = {}): PaperclipFetch<PaperclipIssueDetail> {
    return this.request<PaperclipIssueDetail>('GET', `/api/issues/${encodeURIComponent(issueId)}`, opts);
  }

  /**
   * Replaying an `idempotencyKey` answers 200 with the SAME id and
   * `deduplicated: true` rather than 409 (probe "A1-13"), which is what makes a
   * create retryable at all.
   */
  createIssue(
    body: PaperclipCreateIssueBody,
    opts: PaperclipInvokeOptions = {},
  ): PaperclipFetch<PaperclipCreateIssueResponse> {
    return this.request<PaperclipCreateIssueResponse>('POST', this.issuesPath(), { ...opts, body });
  }

  /**
   * UNVERIFIED, and loudly. `PATCH /api/issues/{id}` is the weakest row in the
   * entire proven surface: only `{title}` on an unassigned, status-omitted issue has
   * ever been driven (by the `boardMutationGuard` characterization), NOTHING
   * asserts its response body, and `{status}` / `{assigneeAgentId}` — the two
   * writes the mission engine is built on — have never been sent by any probe.
   * The conditional run-id rule ("only when in_progress and assigned to the
   * actor") is a plan claim with no probe behind it. The request field names
   * come from the committed OpenAPI snapshot, which IS authoritative for names.
   * New probes belong in the next phase; until then treat a green call here as
   * unproven.
   */
  patchIssue(
    issueId: string,
    body: PaperclipUpdateIssueBody,
    opts: PaperclipInvokeOptions = {},
  ): PaperclipFetch<PaperclipIssue> {
    return this.request<PaperclipIssue>('PATCH', `/api/issues/${encodeURIComponent(issueId)}`, { ...opts, body });
  }

  /**
   * The thread is newest-first, and TWO query names are erased from the
   * caller's vocabulary rather than validated at runtime:
   *
   *  `afterCommentId`, because the probe "A1-6 (BLOCKING): comments default to
   *  desc, and the cursor pages are acted on" proves it is an id-for-id ALIAS
   *  of `after` and the precedence when both are sent is recorded, never
   *  asserted.
   *
   *  `order`, because `after` is a strictly-OLDER cursor. Under the default
   *  `desc` the oldest row of a page is the correct next cursor; under `order:
   *  'asc'` that same row is the NEWEST one, and asking for everything older
   *  than it re-reads the page just read — a duplicate-page walk with no error.
   *  No probe pins how `after` composes with `asc`, so the safe move is to make
   *  the combination unrepresentable rather than to guess a cursor for it. The
   *  wire still accepts `order`; `types.ts` still types it; this method does
   *  not offer it. Restore it the day a probe pins an ascending cursor.
   */
  async listComments(
    issueId: string,
    query: CommentsPageVariables = {},
    opts: PaperclipInvokeOptions = {},
  ): PaperclipFetch<PaperclipPage<PaperclipIssueComment, CommentsPageVariables>> {
    const limit = query.limit ?? MAX_ISSUE_COMMENT_LIMIT;
    const variables: CommentsPageVariables = { ...query, limit };
    const nodes = await this.request<PaperclipIssueComment[]>(
      'GET',
      `/api/issues/${encodeURIComponent(issueId)}/comments`,
      { ...opts, query: { ...variables } },
    );
    // Newest-first, so the LAST row is the oldest and therefore the cursor.
    const oldest = nodes.at(-1);
    return new PaperclipPage<PaperclipIssueComment, CommentsPageVariables>({
      nodes,
      // Same rule as the issue list, for a sharper reason: `limit=0` here is
      // NOT the issue list's 400 — the probe records it silently ignored,
      // answering 200 with the whole thread — so page length tells a caller
      // even less about the server's intent than it does there.
      hasMore: oldest !== undefined,
      nextCursor: oldest?.id,
      variables,
      refetch: (next) => this.listComments(issueId, { ...next, limit: next.limit ?? limit }, opts),
    });
  }

  /** Proven run-less on an unassigned, status-omitted issue; see `runIdBoundary`. */
  addComment(
    issueId: string,
    body: PaperclipCreateCommentBody,
    opts: PaperclipInvokeOptions = {},
  ): PaperclipFetch<PaperclipIssueComment> {
    return this.request<PaperclipIssueComment>('POST', `/api/issues/${encodeURIComponent(issueId)}/comments`, {
      ...opts,
      body,
    });
  }

  listAgents(opts: PaperclipInvokeOptions = {}): PaperclipFetch<PaperclipAgent[]> {
    return this.request<PaperclipAgent[]>(
      'GET',
      `/api/companies/${encodeURIComponent(this.config.companyId)}/agents`,
      opts,
    );
  }

  /**
   * The ONE response in this whole surface proven to carry `companyId` (the
   * probe "A1-12: /wakeup discriminates on the body, never on the status code"),
   * which makes it the only place company-id pinning is currently more than a
   * latent guard. Discriminate the union on `'reason' in body` — never on
   * `'status' in body`, which BOTH branches carry, and never on the status code,
   * which is identical for both.
   */
  wakeAgent(
    agentId: string,
    body: PaperclipWakeupBody = {},
    opts: PaperclipInvokeOptions = {},
  ): PaperclipFetch<PaperclipWakeupResponse> {
    return this.request<PaperclipWakeupResponse>('POST', `/api/agents/${encodeURIComponent(agentId)}/wakeup`, {
      ...opts,
      body,
    });
  }

  /** The one route proven to answer without any `Authorization` header at all. */
  getHealth(opts: PaperclipInvokeOptions = {}): PaperclipFetch<PaperclipHealth> {
    return this.request<PaperclipHealth>('GET', '/api/health', opts);
  }

  private issuesPath(): string {
    return `/api/companies/${encodeURIComponent(this.config.companyId)}/issues`;
  }

  // ── The core ───────────────────────────────────────────────────────────

  private async invoke<T>(
    method: string,
    path: string,
    opts: PaperclipInvokeOptions,
  ): Promise<PaperclipRawResponse<T>> {
    const query = normalizeQuery(opts.query);
    const request: PaperclipRequestContext = { method, path, query };

    const lock = getPaperclipLockState();
    if (lock.closed) {
      throw new PaperclipDisabledError({
        request,
        body: {
          error: `Paperclip runtime lock closed: ${lock.code}`,
          remediation: 'check the paperclip lock verdict log line',
        },
      });
    }

    // (1) THE KILL SWITCH, at every invoke and BEFORE the breaker.
    // `isKillSwitchActive` is itself fail-open on a DDB error, so an outage
    // reads as "not switched off" rather than bricking the integration.
    const gate = await this.killSwitch('paperclip_disabled');
    if (gate.active) {
      throw new PaperclipDisabledError({
        request,
        body: {
          error: `paperclip_disabled kill switch active: ${gate.reason ?? 'no reason recorded'}`,
          remediation: 'clear paperclip_disabled from the dashboard Kill switches tab',
        },
      });
    }

    // (2) THE BREAKER, second.
    if (this.breakerBlocks()) {
      throw new PaperclipUnavailableError({
        request,
        body: {
          error: 'Paperclip circuit breaker is open',
          remediation: `${this.retry.breakerThreshold} consecutive transient failures; it half-opens ${this.retry.breakerCooldownMs} ms after the last one`,
        },
      });
    }

    const retryable = method === 'GET' || hasIdempotencyKey(opts.body);
    const attempts = retryable ? Math.max(1, this.retry.attempts) : 1;

    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.attempt<T>(method, path, query, request, opts);
        this.breakerFailures = 0;
        this.breakerOpenedAt = undefined;
        return result;
      } catch (err) {
        // The one seam. `parsePaperclipError` is idempotent, so an
        // already-typed error passes straight through.
        const error = parsePaperclipError(err, { request });
        const transient = error.type === 'unavailable' || error.type === 'ratelimited';
        if (!transient) throw error; // never a 4xx except 429
        const wait = attempt >= attempts - 1 ? undefined : this.waitBefore(attempt + 1, error);
        if (wait === undefined) {
          // ONE per failed CALL, not one per attempt. Counting attempts would
          // open a 5-threshold breaker after two `listIssues()` calls under the
          // shipped 3-attempt policy, while telling the operator it took five.
          this.noteTransientFailure();
          throw error;
        }
        await (this.retry.sleep ?? defaultSleep)(wait);
      }
    }
  }

  private async attempt<T>(
    method: string,
    path: string,
    query: Record<string, string> | undefined,
    request: PaperclipRequestContext,
    opts: PaperclipInvokeOptions,
  ): Promise<PaperclipRawResponse<T>> {
    const url = new URL(`${this.config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    const token = this.tokenFor(opts.actor, request);
    const hasBody = opts.body !== undefined;
    const ours = AbortSignal.timeout(
      method === 'GET' ? this.config.readTimeoutMs : this.config.writeTimeoutMs,
    );
    const callerSignal = opts.signal ?? this.requestInit.signal ?? undefined;
    const signal = callerSignal ? AbortSignal.any([ours, callerSignal]) : ours;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        ...this.requestInit,
        redirect: 'error',
        method,
        signal,
        headers: {
          // The documented order: content-type, then auth, then the caller's
          // headers, then the User-Agent that nobody may override.
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          // Idempotent bearer prefixing.
          authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
          ...this.baseHeaders,
          // An absent run id is OMITTED, never sent empty (see the file header).
          ...(opts.runId ? { [PAPERCLIP_RUN_ID_HEADER]: opts.runId } : {}),
          'user-agent': USER_AGENT,
        },
        body: hasBody ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      // A transport failure, an abort, or one of our timeouts: no status.
      throw parsePaperclipError(err, { request });
    }

    const { parsed, text, empty } = await readBody(response);

    // Strictly stronger than `response.ok`. A well-formed 200 carrying an
    // `{error}` envelope is deliberately treated as a failure, and so is a 200
    // whose body did not parse as JSON. A BODYLESS success (a 204, or a 200 with
    // an empty body) is a success: no probe has seen one on this surface, but a
    // method typed `Promise<void>` would otherwise fail on the one shape that
    // most obviously answers it.
    const ok =
      response.ok && text === undefined && (empty === true || (parsed !== undefined && !isErrorShaped(parsed)));
    if (!ok) {
      throw parsePaperclipError(
        new Error(`Paperclip ${request.method} ${request.path} responded ${response.status}`),
        {
          status: response.status,
          headers: response.headers,
          request,
          body: errorBodyFrom(parsed, text),
        },
      );
    }

    this.assertCompany(parsed, request);
    return { data: parsed as T, status: response.status, headers: response.headers };
  }

  /**
   * COMPANY-ID PINNING, and an honest note about its reach. This rejects any
   * response — or any row of an array response — carrying a `companyId` that is
   * not ours. Today exactly ONE proven body carries the field: the heartbeat run
   * row from `POST /api/agents/{id}/wakeup` (probe "A1-12"). `PaperclipIssueView`
   * has no `companyId` and no probe asserts one on any issue row, so on every
   * other route this is a latent guard rather than active protection. It is
   * written to fire wherever the field appears rather than only where it is
   * proven, because a field that starts appearing is exactly the case that must
   * not slip through.
   */
  private assertCompany(value: unknown, request: PaperclipRequestContext): void {
    const rows = Array.isArray(value) ? value : [value];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const companyId = row.companyId;
      if (typeof companyId !== 'string' || companyId === this.config.companyId) continue;
      throw new PaperclipCompanyMismatchError({
        request,
        body: {
          error: `Paperclip answered for company ${companyId}, expected ${this.config.companyId}`,
          remediation: 'check PAPERCLIP_COMPANY_ID against the deployed Paperclip tenant',
        },
      });
    }
  }

  private tokenFor(actor: string | undefined, request: PaperclipRequestContext): string {
    const slug = actor ?? this.config.defaultActor;
    const token = this.config.agentKeys[slug];
    if (!token) {
      throw new PaperclipDisabledError({
        request,
        body: {
          error: `No Paperclip agent key for actor ${JSON.stringify(slug)}`,
          remediation: `re-run scripts/paperclip-bootstrap.ts; known actors: ${Object.keys(this.config.agentKeys).sort().join(', ')}`,
        },
      });
    }
    return token;
  }

  private breakerBlocks(): boolean {
    if (this.breakerOpenedAt === undefined) return false;
    if (this.now() - this.breakerOpenedAt >= this.retry.breakerCooldownMs) {
      // Half-open: this one call goes through. A success closes the breaker
      // (failures reset to zero); a failure pushes the count past the threshold
      // again and re-opens it.
      this.breakerOpenedAt = undefined;
      return false;
    }
    return true;
  }

  private noteTransientFailure(): void {
    this.breakerFailures += 1;
    if (this.breakerFailures >= this.retry.breakerThreshold && this.breakerOpenedAt === undefined) {
      this.breakerOpenedAt = this.now();
      logger.warn(
        { failures: this.breakerFailures, cooldownMs: this.retry.breakerCooldownMs },
        'paperclip circuit breaker opened',
      );
    }
  }

  /**
   * How long to wait before attempt `attemptsSoFar + 1`, or `undefined` when
   * the answer is "do not retry at all".
   *
   * Full jitter — uniform over [0, min(cap, base * 2^n)] — EXCEPT that a 429
   * naming its own wait sets the FLOOR. Parsing `Retry-After` into a typed
   * error and then backing off on `Math.random() * 250` would retry roughly
   * four times inside the window the server just named, which is how a client
   * turns one refusal into a burst. The advertised wait is clamped by
   * `MAX_RETRY_AFTER_MS`; past that the call fails now rather than parking a poll.
   */
  private waitBefore(attemptsSoFar: number, error: unknown): number | undefined {
    const ceiling = Math.min(this.retry.capMs, this.retry.baseMs * 2 ** (attemptsSoFar - 1));
    const jittered = (this.retry.random ?? Math.random)() * ceiling;
    const advertised =
      error instanceof PaperclipRatelimitedError ? error.advertisedWaitMs() : undefined;
    if (advertised === undefined) return jittered;
    if (advertised > MAX_RETRY_AFTER_MS) return undefined;
    return Math.max(jittered, advertised);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeQuery(
  query: Record<string, string | number | boolean | undefined> | undefined,
): Record<string, string> | undefined {
  if (!query) return undefined;
  const entries = Object.entries(query).filter(
    (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}

function hasIdempotencyKey(body: unknown): boolean {
  return isRecord(body) && typeof body.idempotencyKey === 'string' && body.idempotencyKey.length > 0;
}

/**
 * Linear calls `response.json()` with NO try/catch, so a proxy answering
 * `Content-Type: application/json` with an empty or truncated body throws a raw
 * `SyntaxError` that escapes both public exits un-normalized. We read the text
 * once and parse it ourselves, so that case degrades to the text branch and
 * becomes a typed error like every other failure.
 */
async function readBody(response: Response): Promise<{ parsed?: unknown; text?: string; empty?: boolean }> {
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  if (raw === '') return { empty: true };
  if (!contentType.startsWith('application/json')) return { text: raw };
  try {
    return { parsed: JSON.parse(raw) as unknown };
  } catch {
    return { text: raw };
  }
}

function isErrorShaped(parsed: unknown): boolean {
  return isRecord(parsed) && typeof parsed.error === 'string';
}

/**
 * Folds whatever came back into `PaperclipErrorBody`, and appends NOTHING.
 * Linear manufactures a `${summary}: ${JSON.stringify(...)}` suffix here so its
 * error class can split it back off at `": {"` — an inverse pair that truncates
 * any legitimate message containing that sequence. The summary travels
 * separately, as the raw `Error` handed to `parsePaperclipError`, so both halves
 * reach `.message` and nothing has to be un-spliced.
 */
function errorBodyFrom(parsed: unknown, text: string | undefined): PaperclipErrorBody | undefined {
  if (isErrorShaped(parsed)) return parsed as unknown as PaperclipErrorBody;
  const detail = (text ?? (parsed === undefined ? '' : JSON.stringify(parsed))).trim().slice(0, 300);
  return detail.length > 0 ? { error: detail } : undefined;
}

/**
 * The production entry point: env plus runtime-config in, a constructed client
 * out. Throws the same typed `PaperclipDisabledError` the constructor does when
 * the install is not configured, so "not configured" and "broken" never look
 * alike at a call site.
 */
export async function paperclipClientFromEnvironment(
  overrides: PaperclipClientOptions = {},
): Promise<PaperclipClient> {
  const resolved = await loadPaperclipConfig();
  return new PaperclipClient({ ...resolved, ...overrides });
}
