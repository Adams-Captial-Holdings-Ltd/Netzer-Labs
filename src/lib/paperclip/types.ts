/**
 * Every Paperclip WIRE shape the integration needs, in one file.
 *
 * A2-16: wire types are strictly separated from domain types, and
 * `mission-projection.ts` is the ONLY crossing point between them. Nothing in
 * here describes a Netzar domain object, and nothing in here is constructed by
 * hand outside a Paperclip request or response.
 *
 * PROVENANCE. Request schemas below are transcribed from Paperclip's zod
 * validators at the pinned artifact; response shapes are far weaker evidence.
 * Per A1-16 nothing here cites a Paperclip source line number: each shape names
 * the method + path, the observed behaviour, and - where one exists - the probe
 * in `tests/contract/paperclip-routes.paperclip.integration.test.ts` that proves
 * it. Where a response shape is UNVERIFIED it says so and stays minimal rather
 * than guessing.
 *
 * A1-15 IS NARROWER THAN THE BAR ASSUMED, and this changes how a type here is
 * widened. `GET /api/openapi.json` is snapshotted to
 * `tests/contract/openapi.snapshot.json` by the probe "A1-15: GET
 * /api/openapi.json is snapshotted, and it types no response field". That
 * document is authoritative for REQUEST BODY FIELD NAMES and their enums, for
 * security, and for route existence - it is how the `task_bridge` key scope in
 * the A1-9 probe was resolved. It is authoritative for nothing else, and the
 * same probe pins the two counterexamples so this claim cannot quietly widen
 * again: `GET /api/companies/{companyId}/issues` declares exactly TWO
 * parameters, `companyId` and `view`, while the route reads far more of them -
 * `updatedSince`, the whole reason A1-8 exists, is absent from the document
 * entirely - and `POST /api/companies/{companyId}/issues` declares `status`
 * REQUIRED while every create probe in the suite omits it and is answered 201.
 * A `parameters` list and a `required` list in that document are not facts.
 *
 * It is NOT authoritative for responses either: at the pinned artifact every
 * success response in it is typed `{"type":"object","additionalProperties":{}}`,
 * so it names no response field at all, and the bar's rule "any field the
 * projection reads must exist in it" is unsatisfiable as written. The probe
 * asserts that opacity so an artifact bump that starts typing responses goes red
 * instead of silently changing what this file may rely on.
 *
 * Until then a RESPONSE type here may be widened only by a probe that asserts
 * the field on a live body. Every response field typed below is asserted by a
 * named probe; anything not asserted is left out and marked UNVERIFIED.
 *
 * A1-1: path construction is not uniform. Company-scoped collections live at
 * `/api/companies/{companyId}/...`; every single-resource operation is FLAT
 * (`/api/issues/{id}`, `/api/work-products/{id}`, `/api/approvals/{id}`).
 * There is no `/api/companies/{companyId}/issues/{id}`.
 *
 * A1-2: authentication is `Authorization: Bearer <token>` for board keys, agent
 * keys and local agent JWTs alike. There is no `x-api-key`.
 *
 * C-10: this is the ONE wire-shape file. There is no `dispatch-types.ts` and no
 * `reconciler-types.ts`, and a later phase that adds one breaks A2-16. Part B
 * Phase 1 also names `PaperclipDispatchBody`/`PaperclipDispatchContext`,
 * `ReconcilerWatermark`, `IssueChange`, `ReconcileAction` and `SweepResult` as
 * contents of this file. They are DEFERRED, not dropped, and the deferral is
 * recorded here so it is not mistaken for the gap that invites a second types
 * file. Phases 5 and 6 add them to THIS file.
 *
 * THE DEFERRAL RULE AND THE EVIDENCE RULE ARE ONE RULE, and stating them apart
 * is what made the deferral above look inconsistent with what ships. Several
 * shapes here have no reader either - `PaperclipApproval`,
 * `PaperclipUpdateWorkProductBody`, `PaperclipIssueDetail`,
 * `PaperclipCheckoutBody`, `PaperclipCommentsQuery`, `ISSUE_LIST_DEFAULT_LIMIT`
 * and `MAX_ISSUE_COMMENT_LIMIT` are read by nothing in `src/` or `tests/` today,
 * because Phase 1's whole deliverable IS the wire-shape file and its readers
 * arrive in Phase 2. The line is not "has a reader"; it is EVIDENCE. A shape a
 * probe has driven, or whose request schema the OpenAPI snapshot pins, is a
 * measurement and ships whether or not anything reads it yet. A shape with
 * neither - the five deferred above, none of which any probe here sends or
 * receives - is a guess wearing a name, and naming it would freeze the guess
 * into the file the next phase trusts.
 */

import type {
  CreateIssueBody,
  PaperclipIssueStatus,
  PaperclipIssueView,
  PriorityBand,
} from './mission-projection.js';

// C-6: the shipped projection's export names are canonical. The status union,
// the priority union, the issue row and the create body are re-exported from
// there rather than forked here, so there is exactly one definition of each and
// no drift between the wire module and the crossing point.
export type { CreateIssueBody, PaperclipIssueStatus, PaperclipIssueView, PriorityBand };

/**
 * A2-19. The named promise alias that appears in every client and engine
 * signature, the way Linear writes `LinearFetch<Response>`. It lives in this
 * file rather than in `client.ts` so that `mission-engine.ts` - the interface
 * every consumer depends on - can use it without importing the transport.
 */
export type PaperclipFetch<T> = Promise<T>;

/**
 * A1-3. The run-id header spelling, pinned once. It is sent ONLY when a genuine
 * run is held and is OMITTED - never sent empty - otherwise. A run id is never
 * synthesized: a fabricated one passes the header guard and fails at the write
 * with a foreign-key violation rather than a clean 4xx, proven by the shipped
 * probe "FI-4: a fabricated run id passes the header guard and reaches the
 * heartbeat FK".
 */
export const PAPERCLIP_RUN_ID_HEADER = 'X-Paperclip-Run-Id';

/**
 * A1-7. Issue-list paging constants.
 *
 * THE THREE NUMBERS THEMSELVES ARE UNVERIFIED, and saying so is the point. Every
 * probe that could pin one needs a board with more rows than the number - more
 * than 500 issues, more than 1000 issues, more than 500 comments on one issue -
 * and the disposable harness holds a couple of hundred rows at most, so a probe
 * asserting any of them would pass on a board too small to distinguish 500 from
 * 5000. They come from a source read, which A1-16 does not accept as authority.
 *
 * WHAT IS PROVEN is the BEHAVIOUR each one describes, which is what a caller
 * actually depends on: the probe "A1-7: sortField accepts only `updated`, limit
 * over the max is clamped, limit<=0 is a 400" sends a `limit` five times
 * `ISSUE_LIST_MAX_LIMIT` and is answered 200 with a shorter page - so an
 * oversized limit is SILENTLY CLAMPED rather than rejected, and a caller may
 * never read "I asked for N and got fewer" as "the board holds fewer than N".
 * The same probe observes `limit <= 0` answered 400.
 *
 * Settle the numbers by producing them - write past each threshold once and read
 * the page length back - not by transcribing them again.
 */
export const ISSUE_LIST_DEFAULT_LIMIT = 500;
/** A `limit` above this is SILENTLY clamped, not rejected; `limit <= 0` is a 400. */
export const ISSUE_LIST_MAX_LIMIT = 1000;
/**
 * A1-6. The comment `limit` is understood to be clamped to this. THE NUMBER AND
 * THE CLAMP ARE BOTH UNVERIFIED, for the reason above: distinguishing a clamp
 * from a short thread needs more than 500 comments on ONE issue, which the
 * disposable harness cannot hold. What IS proven is that `limit` is read at all
 * (`limit=2` returns two rows of a five-row thread) and that `limit=0` is
 * silently ignored rather than rejected - see `PaperclipCommentsQuery.limit`.
 */
export const MAX_ISSUE_COMMENT_LIMIT = 500;

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/**
 * A1-4. The human-readable string is ALWAYS on `error` - never `message`, never
 * `detail`. `code` exists only when the thrown error carried one; many in-route
 * failures respond with a bare `{error}` and no code, so those are matched on
 * the string in exactly one place (the parser), never at a call site (A1-11).
 */
export interface PaperclipErrorBody {
  error: string;
  code?: string;
  /**
   * THE FIVE FIELDS FROM HERE TO `grantId` ARE UNVERIFIED, and the marker is the
   * point rather than a caveat. No probe in
   * `tests/contract/paperclip-routes.paperclip.integration.test.ts` asserts or
   * records one - and note what the suite's `expectErrorEnvelope` does and does
   * NOT do: it pins the human string to `error` and forbids `message`/`detail`,
   * so a body carrying any of these five would sail past it unnoticed. Their
   * absence is therefore unproven as well as their presence. The committed
   * `openapi.snapshot.json` is no help either - it types the shared `Error`
   * schema without them, and the string `remediation` occurs ZERO times anywhere
   * in that document. Neither of the two
   * evidence sources this file accepts has produced one, so the semantic prose
   * that used to stand here ("present only on the redacted skill-policy denial",
   * "a string, or an object for the structured-connection code set") was the
   * same defect this file deleted from `PaperclipHeartbeatRunStatus` and refused
   * for `PaperclipHealthUnhealthy.error`: a plausible value asserted from
   * nowhere.
   *
   * This matters most for `remediation`, because A2-7 makes
   * `remediation ?? error ?? code` the message preference chain - so Phase 2's
   * parser reads the least-evidenced field FIRST. Keep it optional and keep the
   * chain's `??` fallbacks; produce a body carrying one before narrowing any
   * type below, and delete the ones no probe ever reproduces.
   *
   * UNVERIFIED - no probe in this suite has seen this field and it appears zero
   * times in the committed OpenAPI snapshot.
   */
  reason?: string;
  /** UNVERIFIED, as `reason`. Widened, not narrowed, precisely because nothing has observed its shape. */
  remediation?: string | Record<string, unknown>;
  /** UNVERIFIED, as `reason`. */
  connection?: Record<string, unknown>;
  /** UNVERIFIED, as `reason`. */
  subject?: Record<string, unknown>;
  /** UNVERIFIED, as `reason`. */
  grantId?: string;
  /**
   * Understood to carry the raw zod issue array on a validation 400 and an
   * echoed value otherwise. UNVERIFIED in the same sense as the five above - no
   * probe asserts it; the suite's `detailsOf` only RENDERS it opportunistically
   * into a failure message, which never runs on a green suite. It is typed
   * `unknown`, so unlike them it commits this file to nothing: a caller must
   * narrow it before reading, and `PaperclipValidationIssue` below is the shape
   * to narrow TO if that narrowing succeeds, not a promise that it will.
   */
  details?: unknown;
  /**
   * A1-10. Present on BOTH 429 shapes and on nothing else, and it is a NUMBER of
   * seconds whose decimal string is also the `Retry-After` header - a client may
   * read either and gets the same value. Both shapes are observed on live
   * bodies; neither is transcribed.
   *
   * (a) THE SEARCH BUCKET, proven by the probe "A1-10 (BLOCKING): the search 429
   * - Retry-After, retryAfterSeconds and the X-RateLimit headers". `GET
   * /api/companies/{companyId}/search` and `GET
   * /api/companies/{companyId}/search/extract` draw on ONE bucket per agent
   * actor; draining it serially answers 429 `Search rate limit exceeded` with no
   * `code`, `X-RateLimit-Remaining: 0` and the `Retry-After` header. A second
   * agent is unaffected, so the refusal is per-actor and does not stall a board.
   *
   * (b) THE ISSUE-LIST COALESCER, proven by the probe "A1-10 (BLOCKING): the
   * issue-list retry is a coalescer, not a rate limit, and identical reads never
   * trip it". `GET /api/companies/{companyId}/issues` answers 429 `Too many
   * concurrent issue-list requests for this actor/client` when too many DISTINCT
   * list reads are in flight for one actor. It is NOT a rate limit and carries
   * NO X-RateLimit headers - it carries `X-Paperclip-Request-Cache: retry` - and
   * waiting the advertised seconds clears it, which the probe does.
   *
   * TWO CORRECTIONS TO A1-10 THE PROBES FORCED, both of which change how a
   * caller must be written. The X-RateLimit pair does NOT ride on every response:
   * a search request rejected by validation never reaches the limiter and
   * carries neither header, and the issue list never carries them at all. And
   * the bar's remedy - "no parallel identical list requests" - is backwards:
   * identical concurrent reads COALESCE onto one computation and are never
   * refused, while distinct concurrent reads (a sweep fanning out over offsets)
   * are exactly what trips the refusal.
   */
  retryAfterSeconds?: number;
}

/**
 * The shape a zod issue is expected to take inside `PaperclipErrorBody.details`
 * on a 400. UNVERIFIED, as `details` itself: this is a narrowing TARGET, never a
 * claim about a live body, and it exists only so a caller narrows to a named
 * shape instead of indexing `unknown`.
 */
export interface PaperclipValidationIssue {
  path: Array<string | number>;
  message: string;
  code: string;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/**
 * The issue fields this integration reads.
 *
 * A2-16 again, and the reason this is an ALIAS rather than a declaration: the
 * shipped `mission-projection.ts` already declares this exact row as
 * `PaperclipIssueView`, and `issueToMission()` takes that type. Two structurally
 * identical declarations are assignable to each other today and diverge silently
 * the day either side is widened, so there is one declaration and this is the
 * wire module's name for it.
 *
 * Proven present by the probe "route reachability: every documented integration
 * point responds and the projection fields are present", which asserts each key
 * against a real detail response AND against a live list row - a different code
 * path, and the one the reconciler actually projects from.
 *
 * The full row is much wider - the list route spreads the whole service row and
 * appends run-handoff and recovery fields - but nothing here may read a field no
 * probe asserts, so the extra fields are deliberately untyped.
 */
export type PaperclipIssue = PaperclipIssueView;

/**
 * `GET /api/issues/{id}` returns the same row plus a hydrated association
 * bundle (project, goal, ancestors, documents, relations, review state, run
 * handoffs). That bundle is UNVERIFIED and intentionally not typed. The OpenAPI
 * snapshot cannot settle it either (see the A1-15 note in the file header - it
 * types every response as an opaque object), so widening this needs a probe
 * that asserts the field on a live detail response.
 */
export type PaperclipIssueDetail = PaperclipIssue;

/**
 * `POST /api/companies/{companyId}/issues`.
 *
 * A1-13: `idempotencyKey` is a BODY field, not a header, and the key must be
 * deterministic - never random - because the server retains keys for 7 days and
 * a later retry would otherwise create a duplicate. A 200 carrying
 * `deduplicated: true` is a SUCCESS. Proven by the probe "A1-13: replaying an
 * idempotencyKey yields one issue and deduplicated: true".
 *
 * `status` IS OMITTED, by A1-13, and `missionToIssueCreate` omits it. The
 * omitted form is the only one any probe exercises, and it is answered 201
 * (`boardMutationGuard["POST /api/companies/{companyId}/issues"]`, from the
 * A1-17 characterization probe, whose create body carries no `status`). The
 * unassigned row that probe creates is then checked out with
 * `expectedStatuses: ['todo','backlog']` for a recorded 200, so such a row
 * lands in ONE OF todo or backlog.
 *
 * WHICH of the two, and what an ASSIGNED create defaults to, are UNVERIFIED: no
 * probe reads `.status` off a created row and `backlog` appears zero times in
 * artifact-characterization.json. The bar's "todo with an assignee, backlog
 * without" is transcribed prose, not an observation - treat the default as
 * unknown until a probe asserts the field. The failure direction is benign
 * here: the ACL never reads the default, it re-reads the row.
 *
 * The OpenAPI document declares `status` required on this operation, which the
 * omitted form contradicts and the artifact accepts anyway - see the A1-15 note
 * in the file header. The field stays on `CreateIssueBody` as an optional
 * because nothing has characterized what the server does with it; sending it is
 * UNVERIFIED, and `listFilterValidation` shows an unrecognized status is a
 * silent 200 rather than a 400, so a wrong value would not announce itself.
 */
export interface PaperclipCreateIssueBody extends CreateIssueBody {
  /**
   * A1-13's mandatory duplicate-guard flag. Optional on the TYPE, `true` on
   * every body this repo sends.
   *
   * What the flag itself does is UNVERIFIED: the A1-13 probe sends
   * `allowDuplicate: true` on both of its calls without varying it, so it
   * settles the `idempotencyKey` replay and nothing about the guard. What that
   * does establish is the body shape the proven `200 + deduplicated: true`
   * replay was observed on - `idempotencyKey` AND `allowDuplicate: true`
   * together - which is why `createMission` sends exactly that pair on a write
   * `client.ts` auto-retries. The spelling is also one of the 28 properties of
   * `POST /api/companies/{companyId}/issues` in the committed
   * `tests/contract/openapi.snapshot.json`, re-checked byte for byte by A1-15.
   * It stays optional until the probe named in the Phase 1 handoff exists: send
   * `allowDuplicate: false` against a duplicate title and record the outcome.
   */
  allowDuplicate?: boolean;
}

/**
 * The create response is an issue row. On a replayed `idempotencyKey` the same
 * row comes back with `deduplicated: true` and HTTP 200 rather than 201.
 */
export interface PaperclipCreateIssueResponse extends PaperclipIssue {
  deduplicated?: boolean;
}

/**
 * `PATCH /api/issues/{id}`. THE WEAKEST SHAPE IN THIS FILE, and the marker is
 * the point.
 *
 * WHERE THESE NAMES COME FROM: the committed `tests/contract/openapi.snapshot.
 * json`, which the A1-15 probe re-checks byte for byte and which IS
 * authoritative for request field names. That operation declares 29 properties
 * and NO `required` array; only the six a caller here actually sends are typed,
 * because a field nothing produces is a compile-time obstacle rather than a
 * contract.
 *
 * WHAT IS NOT PROVEN, in either direction:
 *   - The response body. The snapshot declares an opaque `200` object with
 *     `additionalProperties: {}` and no `properties`, and no probe asserts a
 *     single field of it. `PaperclipIssue` is the shape the client narrows TO,
 *     not a shape anything has observed on this route.
 *   - `status` and `assigneeAgentId`. The only PATCH any probe has ever driven
 *     is `{title}` on an unassigned, status-omitted issue, inside the `boardMutationGuard`
 *     characterization - and that records a 200, it does not assert one.
 *   - The run-id rule. Plan text says a run id is needed only when the issue is
 *     `in_progress` AND assigned to the actor; `runIdBoundary` records
 *     `requiresRunId: false` for PATCH on an unassigned, status-omitted issue and
 *     nothing more. That is not a per-route property.
 *
 * Produce the probes before narrowing anything below.
 */
export interface PaperclipUpdateIssueBody {
  title?: string;
  description?: string;
  status?: PaperclipIssueStatus;
  /** A uuid, or `null` to unassign. */
  assigneeAgentId?: string | null;
  priority?: PriorityBand;
}

/**
 * `GET /api/companies/{companyId}/issues`, which answers with a BARE ARRAY -
 * no envelope, no `total`, no `nextOffset` (A1-5). Page until a short page.
 *
 * THERE IS NO TOTALS ENDPOINT AT THIS ARTIFACT. The bar (A1-5) says totals come
 * from `GET /api/companies/{companyId}/issues/count`; the probe "characterized:
 * /issues/count is an attention query, not a totals endpoint" observes that
 * route answering `400 {"error":"issues/count currently requires
 * attention=blocked"}` without that parameter, and `200 {count}` with it - a
 * blocked-issue count, not a board total. Paging to a short page is therefore
 * the ONLY way to size a board, which is what the reconciler must be designed
 * against.
 *
 * A1-8 - the single most dangerous fact in this integration: query params are
 * read ad hoc with NO strict schema, so a param this server does not implement
 * is SILENTLY IGNORED and the caller gets 200 with the full unfiltered list.
 * Adding a field here is therefore never enough; it needs a probe that proves
 * the server acts on it.
 */
export interface PaperclipIssueListQuery {
  /** Default 500. Above `ISSUE_LIST_MAX_LIMIT` is silently clamped; `<= 0` is a 400. */
  limit?: number;
  /**
   * The mechanism "page until a short page" rests on, so a silently-ignored
   * `offset` would give a sweep an identical page 1 forever. Proven acted on by
   * the probe "A1-5 (BLOCKING): offset pages the list, and a negative offset is
   * a 400", which reads two single-row pages at offsets 0 and 1 and asserts
   * they differ; a negative or non-numeric value is a 400 naming `offset`, and
   * an offset past the end is an empty 200.
   */
  offset?: number;
  /** A1-7: the literal `updated` is the ONLY accepted value; anything else is a 400. */
  sortField?: 'updated';
  /**
   * UNVERIFIED, and the only field in this file that was shipping without a
   * provenance note. The NAME is accepted — the probe "A1-7: sortField accepts
   * only `updated`, limit over the max is clamped, limit<=0 is a 400" sends
   * `sortDir=asc` and gets a 200 — but no probe asserts the ORDER of two
   * returned rows, and A1-8 is this surface's own demonstration that a 200 on a
   * parameter proves nothing about it being acted on. Nothing in `src/` sends
   * it; a probe that reads two rows and asserts their order is what would
   * promote this.
   */
  sortDir?: 'asc' | 'desc';
  /**
   * Proven acted on by the probe "A1-7: the status, assigneeAgentId and
   * parentId filters are acted on, not silently ignored". An UNKNOWN status is
   * not a 400 - it is an empty 200 - so a caller that builds this from
   * unvalidated input gets silence, not an error.
   *
   * A SINGLE VALUE, deliberately. An earlier revision typed this
   * `PaperclipIssueStatus | PaperclipIssueStatus[]` and the client joined an
   * array with commas - a guess at a wire form no probe has ever sent, on a
   * filter whose failure mode is a silent empty 200 rather than a 400. Widen
   * it the day a probe pins the multi-value serialization; until then the
   * domain `open`, which fans out to three Paperclip statuses, is filtered
   * client-side or not at all.
   */
  status?: PaperclipIssueStatus;
  /**
   * A UUID, or the literal string `null` for unassigned - both proven by the
   * A1-7 filter probe. A malformed value is a 422 carrying
   * `assigneeAgentId must be a UUID or 'null'`.
   */
  assigneeAgentId?: string | 'null';
  /**
   * Proven acted on by the A1-7 filter probe. THIS ONE MUST BE VALIDATED BEFORE
   * IT IS SENT: unlike its two siblings a malformed value is not a clean 4xx -
   * the probe records the outcome under `listFilterValidation` in
   * `artifact-characterization.json` - so the ACL cannot rely on the server to
   * reject a bad id here.
   */
  parentId?: string;
  /**
   * The only accepted value; switches to the ETag-cached compact projection,
   * which is a genuinely narrower row. Proven by the probe "A1-5: view=compact
   * is an ETagged projection that still carries every field the projection
   * reads", which also asserts `Cache-Control: private, must-revalidate`, the
   * `X-Paperclip-Request-Cache` marker, and a 304 on `If-None-Match`.
   */
  view?: 'compact';
  /**
   * NOT upstream at the pinned release - supplied by the vendored patch. On an
   * unpatched build it is silently ignored and the poll returns the whole world
   * with a 200, so the reconciler must refuse to start until the probe
   * "A1-8 (blocking): updatedSince in the future returns an empty list" is
   * green. Must be ISO 8601 with an explicit UTC offset or the patched server
   * answers 400. The predicate is a STRICT `updatedAt > value`, observed by the
   * probes "C-2 (BLOCKING): a truncated watermark loses rows" and "I3:
   * updatedSince is a strict greater-than watermark" - which is why a caller
   * must subtract an overlap rather than pass its last-seen watermark directly.
   * (The ADR amendment's `>= value + 1ms` is superseded by those probes.)
   */
  updatedSince?: string;
}

/**
 * `POST /api/issues/{id}/checkout`. A1-11: the body is exactly these two
 * fields, `expectedStatuses` is non-empty, and passing an agentId other than
 * the actor's own is a 403. An agent actor must also hold a real run id.
 *
 * THE ERROR STRINGS, AND WHICH ONES ARE PROVEN. A1-11 requires these mapped in
 * one place - the parser - from proven text, never string-matched at a call
 * site. The probe "A1-11 (BLOCKING): the checkout and release contract strings,
 * observed rather than transcribed" drives a second agent's key against this
 * route and observes:
 *   - 403 `Agent can only checkout as itself`
 *   - 401 `Agent run id required` when the actor holds no run
 *   - 409 `Issue checkout conflict` when no expected status matches
 *   - 400 `Validation error` on an empty `expectedStatuses`
 * The two PAUSE strings the bar also names - `Project is paused because its
 * budget hard-stop was reached` and `Project is paused` - are UNVERIFIED: they
 * need a project driven to a budget hard stop, which no probe here does.
 *
 * `error.ts` maps them anyway, behind an explicit UNVERIFIED marker, because a
 * paused 409 and an `Issue checkout conflict` 409 carry opposite remedies - stop
 * versus retry - and collapsing both to a bare conflict makes the retry loop
 * hammer a project that has hit its budget hard stop. Produce them with a probe
 * when one can drive the hard stop, then delete the marker. Until then the
 * mapping is argued, not proven, and `error.ts` says so at its definition.
 */
export interface PaperclipCheckoutBody {
  agentId: string;
  expectedStatuses: [PaperclipIssueStatus, ...PaperclipIssueStatus[]];
}

/**
 * A1-11: `POST /api/issues/{id}/release` takes NO validated body - the agent id
 * comes from the actor, never from the caller - and answers with the issue row.
 * Asserted field by field against a live 200 by the A1-11 probe, which also
 * observes that release demands a run id (401 `Agent run id required`) even
 * though comments and PATCH do not (C-3).
 */
export type PaperclipReleaseResponse = PaperclipIssue;

// No `PaperclipCheckoutResponse`. A successful checkout body is UNVERIFIED: the
// A1-11 probe asserts release's 200 field by field and only RECORDS checkout's
// status code, so an alias claiming the two shapes are equal would be exactly
// the source-read claim A1-16 refuses. Declare it with the probe that proves it.

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * A comment as returned by `GET /api/issues/{id}/comments`, which is a bare
 * array. Only these three fields are relied on, and all three are asserted on a
 * live body by the probe "A1-6 (BLOCKING): comments default to desc, and the
 * cursor pages are acted on". The
 * rest of the row (author identity, derived-author provenance, presentation and
 * metadata) is UNVERIFIED and untyped because nothing here reads it.
 */
export interface PaperclipIssueComment {
  id: string;
  body: string;
  createdAt: string;
}

/**
 * A1-6. Comments are the one genuinely cursor-paginated surface.
 *
 * A1-8 APPLIES HERE HARDEST, which is why every field below carries its own
 * evidence rather than sharing one sentence. `GET /api/issues/{id}/comments`
 * declares NO query parameter at all in the committed `openapi.snapshot.json` -
 * only its path `id` - so the document cannot tell an implemented name from an
 * unimplemented one, and an unimplemented one is not an error: the probe
 * "A1-6 (BLOCKING): comments default to desc, and the cursor pages are acted on"
 * sends `?zzzUnknown=1` and is answered 200 with the WHOLE thread, recorded
 * under `commentPagination` in `artifact-characterization.json`. A name typed
 * here without a probe would therefore compile, run, return 200, and silently
 * hand a paging caller page 1 forever.
 *
 * Every field below is proven acted on by that probe, which posts five comments
 * to one issue - a thread long enough that a page of two and a mid-thread cursor
 * cannot be confused with the full list - and reads six pages of it.
 */
export interface PaperclipCommentsQuery {
  /**
   * The cursor. Proven acted on: `after=<the middle row of the default page>`
   * returns exactly the rows OLDER than that row and never replays the row
   * itself, so a caller pages by passing the oldest id it has seen.
   */
  after?: string;
  /**
   * An ALIAS of `after`, proven by the same probe: both names, given the same
   * id, return the same page id-for-id. Which one wins when BOTH are sent is
   * recorded under `commentPagination` rather than claimed here - nothing in
   * this integration sends both, and the precedence is a source fact this file
   * may not transcribe (A1-16).
   */
  afterCommentId?: string;
  /**
   * Defaults to `desc` - newest first - and a client that assumes ascending
   * reads the wrong end of the thread. Both values are read on a live body.
   */
  order?: 'asc' | 'desc';
  /**
   * Proven acted on: `limit=2` against a five-comment thread returns exactly the
   * first two rows of the default page.
   *
   * TWO THINGS ARE NOT PROVEN AND BEHAVE UNLIKE THE ISSUE LIST. Clamping to
   * `MAX_ISSUE_COMMENT_LIMIT` is UNVERIFIED - see that constant; the harness
   * cannot hold 500 comments on one issue, so no probe here can distinguish a
   * clamp from a coincidence. And `limit=0` is NOT the issue list's 400: the
   * probe records it silently ignored, answering 200 with the full thread, so a
   * caller that computes a page size and reaches zero gets everything rather
   * than an error.
   */
  limit?: number;
}

/** `POST /api/issues/{id}/comments`. `body` is required and non-empty. */
export interface PaperclipCreateCommentBody {
  body: string;
  /**
   * A2-18: an unrepresentable value beats a runtime-validated one. The enum is
   * declared on this request body in the committed OpenAPI snapshot, which
   * A1-15 holds to the artifact, so widening this to `string` would let a
   * caller write a value the server rejects.
   */
  authorType?: 'user' | 'agent' | 'system';
  presentation?: unknown;
  metadata?: unknown;
  reopen?: boolean;
  resume?: boolean;
  interrupt?: boolean;
}

// ---------------------------------------------------------------------------
// Agents and wakeup
// ---------------------------------------------------------------------------

/**
 * An agent as returned by `GET /api/companies/{companyId}/agents` and
 * `GET /api/agents/{id}`. These fields are observed against a running instance
 * by `tests/fixtures/paperclip-bootstrap.ts`, which reads every one of them
 * while provisioning the org chart; the rest of the row is UNVERIFIED.
 *
 * `metadata.netzarAgentId` is how a Paperclip agent uuid maps back to a Netzar
 * agent slug. Nothing else in the row is a stable cross-system identity.
 */
export interface PaperclipAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  reportsTo: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

/** `POST /api/agents/{id}/wakeup`. Every field is optional. */
export interface PaperclipWakeupBody {
  source?: 'timer' | 'assignment' | 'on_demand' | 'automation';
  triggerDetail?: 'manual' | 'ping' | 'callback' | 'system';
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  forceFreshSession?: boolean;
}

/**
 * A heartbeat run's lifecycle status. OPEN, and it stays open until a probe
 * drives a run through the lifecycle.
 *
 * ONE MEMBER HAS PROVENANCE. `queued` is what a freshly created run carries on
 * the body the A1-12 probe reads, recorded under `wakeupDefaults` in
 * `artifact-characterization.json`. Nothing else is known: the OpenAPI snapshot
 * types this response as an opaque object and contains the literals `queued`,
 * `scheduled_retry`, `interrupted` and `succeeded` ZERO times anywhere in the
 * document, and no research read transcribes a heartbeat-run body at all. An
 * earlier revision of this file named eight members from none of those sources
 * and the probe then asserted the run's status against that list, which would
 * have gone red against CORRECT server behaviour the first time a wakeup landed
 * in any other status - a retry, or a run that completes fast enough to be past
 * `queued` by the time the response is serialized.
 *
 * `(string & {})` keeps `queued` as an editor completion while accepting any
 * value the server sends. Narrow it by producing the lifecycle, not by naming
 * it: drive a run to completion and cancel one via
 * `POST /api/heartbeat-runs/{runId}/cancel` - a route the snapshot confirms is
 * mounted - and record what comes back.
 */
export type PaperclipHeartbeatRunStatus = 'queued' | (string & {});

/**
 * The heartbeat run row created by a successful `POST /api/agents/{id}/wakeup`.
 *
 * Every field below is asserted present on a live body by the probe "A1-12:
 * /wakeup discriminates on the body, never on the status code". The row is
 * much wider than this (~45 columns of process, log, retry, liveness and
 * issue-comment telemetry); those are UNVERIFIED for this integration's
 * purposes and deliberately untyped, because nothing here reads them and a
 * typed field that no probe asserts is a guess.
 *
 * A1-12: the client must NEVER adopt this id as its own run id. The only
 * legitimate source of an `X-Paperclip-Run-Id` is inbound dispatch.
 */
export interface PaperclipHeartbeatRun {
  id: string;
  companyId: string;
  agentId: string;
  /**
   * OPEN, for the same reason `status` below is. The four members are the
   * REQUEST enum of `POST /api/agents/{id}/wakeup` (`PaperclipWakeupBody.source`),
   * which the OpenAPI snapshot does pin - but this is a RESPONSE row, and the
   * A1-12 probe establishes only that the key is present and that it echoes the
   * value the request sent. Nothing has observed what lands here when the server
   * itself starts a run (a timer sweep, a retry), so closing the set would make
   * a correct server response a compile-time lie on this row - exactly the
   * inference the file refuses one field below.
   */
  invocationSource: 'timer' | 'assignment' | 'on_demand' | 'automation' | (string & {});
  /**
   * OPEN, as `invocationSource`. The A1-12 probe omits `triggerDetail` from the
   * request entirely and RECORDS what came back (`manual`, under
   * `wakeupDefaults` in `artifact-characterization.json`) rather than asserting
   * it - so the one value anything here has seen is server-chosen, and the other
   * three are lifted from the request enum.
   */
  triggerDetail: 'manual' | 'ping' | 'callback' | 'system' | (string & {}) | null;
  status: PaperclipHeartbeatRunStatus;
  wakeupRequestId: string | null;
  responsibleUserId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A1-12. The skipped envelope, returned with the same status code as a run.
 *
 * `reason` is a plain string on purpose. The value the A1-12 probe reproduces
 * deterministically is recorded under `wakeupDefaults` in
 * `artifact-characterization.json` rather than asserted; the artifact also emits
 * `issue_execution_deferred` from the same builder when the named issue already
 * has a live execution run, so pinning `reason` to a single literal would
 * mis-type that second shape as a run. Do not narrow it without a probe that
 * produces every member.
 */
export interface PaperclipWakeupSkipped {
  status: 'skipped';
  reason: string;
  message: string;
  issueId: string | null;
  executionRunId: string | null;
  executionAgentId: string | null;
  executionAgentName: string | null;
}

/**
 * A1-12: `/wakeup` answers with the SAME status code for both outcomes, so the
 * status code decides nothing. The probe records that code rather than asserting
 * it - the bar's own correction to A1-12 says to, and the committed OpenAPI
 * snapshot declares yet another value for this operation than the one the live
 * artifact sends, which is precisely why no code here may depend on either.
 *
 * DISCRIMINATE ON `'reason' in response`. The run row carries no `reason` key
 * and the skipped envelope always does, both asserted by the probe "A1-12:
 * /wakeup discriminates on the body, never on the status code", which produces
 * the skip deterministically by naming an issue id that does not resolve in the
 * company rather than waiting for one to happen. `in` is also the only test that
 * narrows this union at compile time now that the run's own `status` is an open
 * string (see `PaperclipHeartbeatRunStatus`); `response.status === 'skipped'` is
 * the equivalent runtime check but no longer narrows the type.
 *
 * NEVER discriminate on `'status' in response`: BOTH bodies carry a `status`
 * key, so the presence test classifies every successful wakeup as a skip and the
 * union becomes undiscriminable. That trap is asserted in both directions by the
 * same probe.
 */
export type PaperclipWakeupResponse = PaperclipHeartbeatRun | PaperclipWakeupSkipped;

// ---------------------------------------------------------------------------
// Work products
// ---------------------------------------------------------------------------

export type PaperclipWorkProductType =
  | 'preview_url'
  | 'runtime_service'
  | 'pull_request'
  | 'branch'
  | 'commit'
  | 'artifact'
  | 'document';

export type PaperclipWorkProductStatus =
  | 'active'
  | 'ready_for_review'
  | 'approved'
  | 'changes_requested'
  | 'merged'
  | 'closed'
  | 'failed'
  | 'archived'
  | 'draft';

/**
 * The work-product row `POST /api/issues/{id}/work-products` answers with. Each
 * field is asserted on a live 201 by the probe "A1-17 (CHARACTERIZATION):
 * boardMutationGuard across all five write shapes with an agent key". The row
 * is wider (project, execution workspace, runtime service, external id, url,
 * review state, health, metadata); those stay UNVERIFIED and untyped.
 */
export interface PaperclipWorkProduct {
  id: string;
  issueId: string;
  type: PaperclipWorkProductType;
  provider: string;
  title: string;
  status: PaperclipWorkProductStatus;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * `GET /api/health`. The detail level depends on the caller, and the split is
 * measured by the probe "health body by actor: every field PaperclipHealthOk
 * types is on a live body", which issues one request with NO `Authorization`
 * header and one with an agent key, asserts the exact key set of each and pins
 * both to `artifact-characterization.json`.
 *
 * What that probe observed: an anonymous caller gets `status`, `deploymentMode`,
 * `deploymentExposure`, `bootstrapStatus`, `bootstrapInviteActive`,
 * `databaseBackup` and `warnings`; an authenticated caller gets those plus
 * `version`, `serverVersion`, `serverInfo`, `authReady` and `features`. Every
 * field is optional here because the anonymous body is asserted to be a strict
 * subset of the authenticated one, so one type covers both.
 *
 * The OpenAPI document declares only eight of these twelve and is silent about
 * `deploymentExposure`, `serverVersion`, `authReady` and `features` - which is
 * exactly why they need the probe. The probe asserts the anti-invention
 * direction too: every field named below must appear on a live body, so a field
 * cannot be added here from a source read.
 *
 * `databaseBackup`, `serverInfo` and `features` stay opaque because nothing in
 * this integration reads inside them.
 */
export interface PaperclipHealthOk {
  status: 'ok';
  deploymentMode?: string;
  deploymentExposure?: string;
  version?: string;
  serverVersion?: string;
  serverInfo?: unknown;
  authReady?: boolean;
  features?: Record<string, unknown>;
  bootstrapStatus?: 'ready' | 'bootstrap_pending';
  bootstrapInviteActive?: boolean;
  databaseBackup?: Record<string, unknown>;
  warnings?: Array<{ code: string; message: string }>;
}

/**
 * UNVERIFIED, in full, and it must stay marked. This is the 503 the health route
 * is understood to answer when the database probe throws, and no probe in this
 * suite has seen it: reaching it needs the database killed underneath a running
 * server, which the harness does not do. Its sibling `PaperclipHealthOk` has a
 * named probe and a recorded key set; this one has neither, and the file header's
 * rule is that an unasserted response shape says so.
 *
 * `status: 'unhealthy'` is kept as the union's discriminant. `error` is typed
 * `string` rather than the literal a source read supplies - `database_unreachable`
 * and `serverVersion` both appear ZERO times in the committed OpenAPI snapshot -
 * because a literal nothing has observed is the same defect as an invented enum.
 */
export interface PaperclipHealthUnhealthy {
  status: 'unhealthy';
  version?: string;
  serverVersion?: string;
  error: string;
}

export type PaperclipHealth = PaperclipHealthOk | PaperclipHealthUnhealthy;
