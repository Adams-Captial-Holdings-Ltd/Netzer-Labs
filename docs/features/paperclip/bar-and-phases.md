---
feature: paperclip
document_role: decision
status: accepted
observed_at: 2026-08-20
as_of_commit: 87a8fa8072008ece181d6226c0c989ab89d0e884
---

# Paperclip Integration — The Bar and the Phase Decomposition

**Status:** contract document. Every later builder and critic works from this.
**Precedence (unchanged from the plan preamble):** running code > ADR 0010 > `docs/features/paperclip/plan-audit.md` > `docs/features/paperclip/implementation-plan.md`. **Added here:** a green contract probe against the pinned artifact beats all four.
**Pinned artifact:** `netzer-paperclip:2026.722.0-netzar.1` = upstream release **`v2026.722.0`** (tag, not `2026.722.0` — `GET /releases/tags/2026.722.0` is a 404) pinned by immutable digest, plus `vendor/paperclip/updated-since.patch` applied at build time by `vendor/paperclip/Dockerfile`. (Superseded by the v2026.916.1 re-pin, which deleted the patch: ADR 0019.)

---

## Part A — The Bar

Each criterion is written so a critic with fresh context can hold work against it blind. Cite the criterion ID in review.

### A1. API fidelity — "matches Paperclip's own documented API and its passing contract probes exactly"

Source for every item below is **Packet 1** (source read of `paperclipai/paperclip` at tag `v2026.722.0`) unless marked otherwise.

**A1-1 — Path construction is not uniform and must not be guessed.**
Only `companyRoutes` is mounted with a prefix (`api.use("/companies", companyRoutes(...))`, `server/src/app.ts:240`); every other router is mounted bare on the `/api` router (`app.ts:249, 261, 305`) and declares full paths. Therefore:
- company-scoped: `/api/companies/{cid}/issues`, `/issues/count`, `/approvals`, `/agents`, `/activity`, `/search`
- single-resource: **flat** `/api/issues/{id}`, `/api/work-products/{id}`, `/api/approvals/{id}`, `/api/heartbeat-runs/{runId}`
- `/api/health` (`health.ts:112` mounted at `app.ts:229-238`), `/api/openapi.json` (`openapi.ts:6650`, `app.ts:239`)
**Test:** no string in `src/lib/paperclip/` builds `/api/companies/{cid}/issues/{id}`. Grep is the test.

**A1-2 — Auth is `Authorization: Bearer <token>`. There is no `x-api-key`.**
The brief's assumption was wrong; zero occurrences in the fetched sources (`middleware/auth.ts:157`). The same bearer slot resolves board keys (`:229`), agent keys SHA-hashed against `agentApiKeys` (`:254-259`), or a local agent JWT (`:262`).
**Test:** grep `src/lib/paperclip/` for `x-api-key` returns nothing; a unit test asserts the built header is exactly `Authorization: Bearer <token>`.

**A1-3 — The run-id header is spelled `X-Paperclip-Run-Id`, sent only when a genuine run is held, and never synthesized.**
Read at `auth.ts:155`; cross-checked against a JWT's `run_id` claim with 422 `code: "agent_jwt_run_id_mismatch"` on mismatch (`auth.ts:281-292`). `requireAgentRunId` is a *local closure* at `routes/issues.ts:3482`, not exported middleware — GitHub code search returns zero hits for it because the file exceeds the code-search index limit, so "I searched and it doesn't exist" is not evidence.
**Test:** (a) a unit test asserts the header is **omitted**, not empty, when no run is held; (b) a lint rule or test asserts no `randomUUID()`/`uuid()` call exists anywhere under `src/lib/paperclip/` (ADR 0010 hard constraint 2 — a fabricated id fails at write with SQLSTATE 23503, not a clean 4xx).

**A1-4 — Error envelope: the human string is always on `error`. Never `message`, never `detail`.**
`server/src/middleware/error-handler.ts`. `code` exists only when an `HttpError` set `details.code`; many in-route errors call `res.status(n).json({error})` directly and carry **no** `code` (`issues.ts:8819, 8831`; `agents.ts:3423, 3430`). Zod failures → `400 {error:"Validation error", details:[zod issues]}`. Unmatched `/api/*` → `404 {error:"API route not found"}` (`app.ts:390-392`).
**Test:** the client's error parser must degrade cleanly when `code` is absent, and must never read `message`/`detail` as the primary human string.

**A1-5 — The issue list returns a bare JSON array with no envelope, no `total`, no `nextOffset`.**
Page until a short page (which is exactly what `/count` does internally, `issues.ts:4994-4998`). Totals come from `GET /api/companies/{cid}/issues/count`. `view=compact` sets `ETag` + `Cache-Control: private, must-revalidate` and 304s on `If-None-Match` (`issues.ts:4829-4831, 4899-4900`).
**Test:** a probe asserts the 200 body is an `Array`, not an object.

> **CORRECTED BY PROBE 2026-08-21 — there is no totals endpoint.** `GET /api/companies/{cid}/issues/count` is an *attention query*, not a board total: without `attention=blocked` it answers `400 {"error":"issues/count currently requires attention=blocked"}`, and with it the number is a count of blocked issues. Observed by the probe "characterized: /issues/count is an attention query, not a totals endpoint". **Paging to a short page is the only way to size a board**, which is what Phase 5's paging must be designed against — do not plan a `total` it can read.

**A1-6 — Comments paginate by cursor and default to `desc`.**
`after` / `afterCommentId`, `order` = `asc` only when the lowercased value is `asc`, otherwise `desc`; `limit` clamped to `MAX_ISSUE_COMMENT_LIMIT = 500`. A client that assumes ascending default reads the wrong end of the thread.
**Test:** probe asserts default order is newest-first.

**A1-7 — Sorting and limits are narrow.**
`sortField` accepts **only** the literal `updated`; `sortDir` `asc|desc`; `limit` over 1000 is **silently clamped** (`clampIssueListLimit`), `limit <= 0` is a 400. Defaults 500/max 1000.

**A1-8 — Unknown query params are silently ignored. This is the single most dangerous fact in the integration.**
The issue-list route reads params ad hoc off `req.query` with no strict schema. Sending `updatedSince` to a build without the patch returns **200 with the full unfiltered list** — a silent data-correctness trap, not a loud error. The stock pinned release does not implement `updatedSince` (verified absent at both `v2026.722.0` and `v2026.817.0`; present only on master, PR #9050, released in `v2026.818.0-beta.1`).
**Mandatory test (blocking, runs in CI and at reconciler start):** `GET /api/companies/{cid}/issues?updatedSince=<now + 1h>&limit=1` must return `[]`. If it returns rows, the patch is absent and the reconciler must refuse to start rather than silently reprocess the world.

**A1-9 — The reconciler key must be STANDARD scope, proven by a negative probe.**
A `task_bridge`-scoped key is hard-403'd on the company-wide list with `{error:"Task bridge keys cannot use company-wide issue list APIs"}` (`issues.ts:4639`). A task_bridge key *looks* more secure and silently breaks the reconciler.
**Test:** the bootstrap script prints the minted scope, and a probe asserts the reconciler key gets 200 while a task_bridge key gets 403 with that exact string.

**A1-10 — Two distinct 429s, both must honor `Retry-After`.**
(a) the search token bucket on `/search` and `/search/extract` (`{error:"Search rate limit exceeded", retryAfterSeconds}`, plus `X-RateLimit-Limit`/`-Remaining` on every response); (b) the issue-list **in-flight coalescer** — not a rate limit — `{error:"Too many concurrent issue-list requests for this actor/client", retryAfterSeconds}` (`issues.ts:4874-4881`). Every list response carries `X-Paperclip-Request-Cache`.
**Test:** the reconciler serializes polls per company (no parallel identical list requests), and a unit test asserts `Retry-After` is honored on both shapes.

> **CORRECTED BY PROBE 2026-08-21 — both shapes are now observed, and two claims above are wrong.** The probes "A1-10 (BLOCKING): the search 429 - Retry-After, retryAfterSeconds and the X-RateLimit headers" and "A1-10 (BLOCKING): the issue-list retry is a coalescer, not a rate limit, and identical reads never trip it" produce both 429s against the pinned artifact. What holds: both bodies carry `retryAfterSeconds` as a **number** whose decimal string is also the `Retry-After` header; the search refusal is `Search rate limit exceeded` with `X-RateLimit-Remaining: 0` and **no `code`**; `/search` and `/search/extract` share one bucket, scoped **per agent actor** (a second agent is unaffected); every issue-list response does carry `X-Paperclip-Request-Cache`, and the refusal carries it as `retry`.
>
> What is wrong: (1) **the X-RateLimit pair is not on every response** — a search request rejected by validation never reaches the limiter and carries neither header, and the issue list never carries them at all, so a client reading its budget off an arbitrary response reads `null`. (2) **The remedy is backwards.** Identical concurrent list reads *coalesce* onto one computation and are never refused (64 of them all answer 200); what trips the refusal is the number of **distinct** list reads in flight for one actor. A sweep that fans out over offsets is the hazard; a sweep that repeats one query is not. Serializing *distinct* reads per actor is the rule, not "no parallel identical requests".

**A1-11 — Checkout/release contracts are exact.**
Checkout body is exactly `{agentId: uuid, expectedStatuses: nonempty enum[]}`; 403 `"Agent can only checkout as itself"` when `req.actor.agentId !== body.agentId` (`issues.ts:8831`); 409 `"Project is paused because its budget hard-stop was reached"` / `"Project is paused"` (`:8819`). Release takes **no validated body** — the agent id comes from the actor, not the body.
**Test:** these three strings are mapped to typed errors in one place (the parser), never string-matched at a call site.

**A1-12 — `/wakeup`: discriminate on the body's `status`, never on the HTTP status code. CORRECTED BY PROBE 2026-08-20.**
> **This criterion was wrong as first written and is superseded by the artifact.** It claimed `/wakeup` answers **202** for both the run and the skipped envelope. The live `GET /api/openapi.json` at the pinned digest declares **200** (plus 400/401/403), and the run case was observed returning `status: "queued"`, not `"skipped"`. The original claim came from a source read of a ~400 KB route module — the same class of claim **A1-16** already distrusts, now shown to be as unreliable about status codes as about line numbers.
>
> The bar's own precedence rule resolves this: *a green contract probe against the pinned artifact beats all four documents*, and that includes this one. Treat every **unprobed** status code in A1 as provisional until a probe pins it.

What is actually established: the response is typed in the OpenAPI as an undocumented `{type: "object", additionalProperties: {}}`, so the document guarantees no field at all; the request body takes `source` (`timer|assignment|on_demand|automation`), `triggerDetail` (`manual|ping|callback|system`), `reason`, `payload`, `idempotencyKey` and `forceFreshSession`; and the route accepts board session, board API key, or agent bearer auth.
**Test:** a characterization probe records the real status code and both real body shapes rather than asserting them; the client returns a discriminated union keyed on the body's `status` field; and it **never** adopts a returned run id as `X-Paperclip-Run-Id`.

**A1-13 — Create-issue body: status omitted, idempotency in the body.**
`idempotencyKey` is a **body field** (not a header), `allowDuplicate: true` is mandatory, `status` is deliberately omitted so the server default applies (todo with an assignee, backlog without). A `200` carrying `deduplicated: true` is a **success**, normalized by the ACL to `201`.
**Test:** replaying the same key twice yields one issue and a 200+`deduplicated:true` on the second call. Note the 7-day retention on `issue_create_idempotency_keys` — a retry after a week creates a duplicate; the key format must be deterministic, never random.

**A1-14 — `onBehalfOfUserId` is never serialized.**
Attribution spoofing is audited server-side. **Test:** a unit test asserts the string `onBehalfOfUserId` never appears in any serialized request body.

**A1-15 — The authoritative response-shape contract is `GET /api/openapi.json`, snapshotted at the pinned digest.**
Packet 1 explicitly could not transcribe most success-response object literals — `PATCH /api/issues/{id}` alone spans ~1,150 lines. `server/src/routes/openapi.ts` (212 KB) was never parsed; the document it builds is the only machine-readable contract and no OpenAPI file is committed upstream.
**Test:** the snapshot is checked in, diffed on every artifact bump, and any field the projection reads must exist in it.

**A1-16 — Line numbers from the implementation plan are not authority.**
Packet 1 read the pinned tag; Packet 4's plan was written against a different, larger revision (`routes/issues.ts` 12,670 lines vs ~404 KB at the tag) and `plan-audit.md` already found **16 wrong citations**, including two hard fabrications and a systematic +92/+100 offset across the whole `schema/issues.ts` family. Concretely: checkout is `issues.ts:8811` in Packet 1 and implied ~`:8850` in Packet 4; release `:8895` vs `:10662`; comments POST `:9669` vs `:11616`; force-release `:8929` vs `:10696`.
**Rule:** no comment, doc, or commit message in this integration may cite `PAPERCLIP: routes/issues.ts:<line>` as authority. Cite **method + path + observed behavior + the probe name that proves it**.

**A1-17 — `boardMutationGuard()` is uncharacterized and sits in front of every `/api` route (`app.ts:228`).**
It may reject agent-actor mutations before any handler runs. Nothing in either packet characterizes it.
**Test:** a probe drives one write of each shape (create, PATCH, comment, checkout, work-product) with an **agent** key and records the outcome. Until that probe is green, no write path may be declared done.

**A1-18 — Version and artifact hygiene.**
The tag is `v2026.722.0`. The deployed image is pinned by digest, never `:latest` (ADR 0010 DL-9). The build's `test "$ARCH" = "arm64"` self-check (`scripts/lib/lifecycle/cloud-build.ts:82`) is retained for the Paperclip build — the upstream artifact is a multi-arch index, so a wrong-platform builder silently produces amd64 that crash-loops with "exec format error".
**Re-pin rule (ADR amendment):** on every artifact bump, first check whether upstream now implements `updatedSince`; the patch is dropped in the same change the moment a release carries it natively.

---

### A2. Client craft — "at the level of Linear's official TypeScript SDK"

Source for every item is **Packet 2** (`linear/linear`, `packages/sdk/src`, read in full for the six hand-written files).

**A2-1 — One base error class that discards nothing.**
`LinearError` carries seven optional fields — `type`, `errors[]`, `query`, `variables`, `data`, `status`, `raw` (`error.ts`). Our `PaperclipError` carries: `type`, `status`, `code`, `body`, `request {method, path, query}`, `issues[]`, `raw`. The original error is always retained on `raw` for post-mortem.

**A2-2 — Leaf subclasses + table dispatch, never a switch.**
14 three-line subclasses and `const errorConstructorMap: Record<Type, typeof LinearError>` resolved as `map[type] ?? LinearError`. Adding an error kind is one enum entry, one 3-line subclass, one map row.

**A2-3 — The parser is idempotent.**
`parseLinearError` opens with `if (error instanceof LinearError) return error;` — essential once a transport layer and a client layer both normalize. Ours must do the same.

**A2-4 — Semantic code beats HTTP status.**
Linear's ladder: `errors[0].extensions.type` wins; status is fallback `403→Forbidden, 429→Ratelimited, 4xx→Auth, 500→Internal, 5xx→Network, else Unknown`. Ours: Paperclip's `details.code` (the structured-connection code set) wins; fallback `401 "Agent run id required" → RunIdRequired`, `403→Auth`, `429→Ratelimited`, `409/422→Conflict`, `400/404→InvalidInput`, `5xx/network/timeout→Unavailable`.

**A2-5 — The rate-limit error carries the whole budget, not just the failure.**
`RatelimitedLinearError` is the only subclass that adds fields and it adds seven, parsed in its constructor via a private `parseNumber()` that maps `""`/null/undefined to `undefined` rather than `NaN`. Ours carries `retryAfter` (header), `retryAfterSeconds` (body), `limit`, `remaining`, and `requestCache` (`X-Paperclip-Request-Cache`). The SDK supplies data; the caller owns policy.

**A2-6 — A non-Error value object for sub-errors.**
`LinearGraphQLError` deliberately does not extend `Error`: one thrown exception, N inspectable structured sub-errors on `.errors[]` with `type`/`message`/`userError`/`path`. Ours maps Zod `details[]` → `PaperclipValidationIssue { path, message, code }`.

**A2-7 — Readable messages by construction.**
De-duplicate candidate strings through a `Set`, join with `" - "`, strip appended JSON with `split(": {")[0]`; preference chain `remediation ?? error ?? code ?? "Unknown error from Paperclip"`.

**A2-8 — `instanceof` survives transpilation.**
`Object.setPrototypeOf(this, X.prototype)` plus a guarded `if (typeof Error.captureStackTrace === "function")`.

**A2-9 — Fail fast at construction with a remediation location in the message.**
Linear throws synchronously when neither credential is present, with the URL to create one. Ours throws when `base_url` or the credential is missing, naming the secret path (`/claudeclaw[-suffix]/paperclip`) and the runtime-config key. **`getConfig` is fail-open on a DynamoDB error, so a missing base URL must become `PaperclipDisabledError`, never a request to `undefined`.**

**A2-10 — Header assembly by spread order; do not copy the User-Agent line.**
Idempotent bearer prefixing (`startsWith("Bearer ")` guard), user headers spread after auth and before User-Agent. Packet 2 flags that `process.env.npm_package_name` resolves to the *consumer's* package at runtime — **do not copy it**; hard-code `netzar-os/<version>`.

**A2-11 — Options `extends RequestInit`; timeouts are our deliberate divergence.**
Linear captures undestructured keys as `...opts` and re-spreads into `fetch`, so `signal`/`keepalive` work for free — and has **no timeout at all**. We add explicit 10 s read / 20 s write timeouts because the ALB `idleTimeout` is 4000 s (`infra/lib/compute-stack.ts:952-963`) and a hung Paperclip must not consume a Fargate request slot. Document the divergence in-file.

**A2-12 — Retry is our second deliberate divergence and must be argued, not assumed.**
Linear ships **zero** retry, backoff, jitter, circuit breaker, or idempotency key by design — the SDK hands you a typed `RatelimitedLinearError` and the policy is the app's. We retain a retry loop + circuit breaker because the reconciler is the durability layer of a single internal service, but: retry only GETs and writes carrying an `idempotencyKey`; never retry 4xx except 429; 3 attempts, full jitter, base 250 ms, cap 4 s; breaker opens after 5 consecutive transient failures, half-opens at 30 s, closes on one success; the kill switch is checked **before** the breaker; the policy is injectable so a caller can turn it off.

**A2-13 — Strict success predicate + content-type sniffing.**
Linear's guard is stricter than `response.ok`: `typeof result !== "string" && response.ok && !result.errors && result.data`. `getResult()` calls `.json()` only when Content-Type starts with `application/json`, else `.text()`, folded into the error as `{error: <text>}` — so an ALB/proxy HTML 502 becomes a typed error, not a JSON parse crash. Required.

**A2-14 — `request` vs `rawRequest` split.**
`request()` returns the parsed body; `rawRequest()` returns `{...result, headers, status}`. Rate-limit headers and `X-Paperclip-Request-Cache` stay reachable without polluting every call site.

**A2-15 — Pagination as a container with a captured refetch closure.**
Linear's `Connection<Node>` holds `_fetch`, built at the operation layer as `connection => this.fetch({...variables, ...connection})` so **filters from page 1 survive to page N and the caller cannot drop them**. `PageInfo` types the termination flag as non-nullable `boolean` and the cursor as nullable. `fetchNext()` is a safe no-op when exhausted and returns `this`. `paginate(fn, args)` lives on the shared base class and returns a flat `T[]`.
Ours: `PaperclipPage<T> { nodes, hasMore, nextOffset|nextCursor, fetchNext(): Promise<this> }` over **offset/limit** for issues (Paperclip has no cursors there) and over `after`/`afterCommentId` for comments; plus `paginateAll()`; plus safe-empty seeding so an unpopulated page is never `undefined`-shaped.

**A2-16 — Wire types strictly separated from domain types, crossed once.**
Linear imports all wire types under one alias (`import * as L from "./_generated_documents.js"`), and a domain class never structurally equals its wire type — the constructor is the single crossing point. Ours: `src/lib/paperclip/types.ts` holds every wire shape (**one file**; there is no `dispatch-types.ts` and no `reconciler-types.ts`), and `mission-projection.ts` is the only crossing point.

**A2-17 — Nullability normalized exactly once; scalar coercion is total and never throws.**
Every constructor assignment is `data.x ?? undefined`; always-present timestamps use `?? new Date()`, optional ones `?? undefined`; `parseDate`/`parseJson` are try/catch helpers returning `undefined` so one malformed field degrades one field, not the whole response. Downstream code never writes `!= null`.

**A2-18 — `Omit<>` erases bound parameters.**
`comments(variables?: Omit<L.Issue_CommentsQueryVariables, "id">)` — a contradictory id is unrepresentable rather than runtime-validated. Ours: `listComments(issueId, opts: Omit<ListCommentsQuery, 'issueId'>)`.

**A2-19 — The request function is a TYPE, not a client dependency.**
`type LinearRequest = <R, V>(doc, vars?) => Promise<R>`; models hold `protected _request`. This is what makes the client swappable and the models mockable without network. Ours: `MissionEngine` and `paperclip-tools.ts` depend on the **interface**, never on `client.ts`. Named promise alias `PaperclipFetch<T>` in every signature.

**A2-20 — Error normalization injected at one seam.**
`this.client.request(...).catch(e => { throw parseLinearError(e) })` in the client constructor means zero generated try/catch. One seam, not per-method.

**A2-21 — Zero new runtime dependencies.**
Linear vendored graphql-request specifically to reach one runtime dep. Our client is fetch + the existing AWS SDK; adding an HTTP library fails this criterion.

**A2-22 — Concentration, not volume.**
23 KB of hand-written code in six reviewable files (`error.ts` at 10 KB is the largest — the signal about where craft was spent) against ~14 MB generated. Ours mirrors the concentration: `error.ts`, `client.ts` (transport), `types.ts`, `config.ts`, `utils.ts` small and named; per-resource methods mechanical and uniform.

**A2-23 — Tests that Linear actually has, that we must have.**
(a) **Executable README** — every documented snippet lives in `readme.test.ts` behind `CODE_SECTION` markers, compiled and run, so docs cannot silently rot. (b) **Local mock HTTP server over real fetch** (`_mock.ts` `createTestServer()` with a recorded `requests` array) asserting on captured request bodies — including that the refetch closure still carries the original filters. (c) A shared `expectError(fn, Class, messageSubstring)` helper with `expect.unreachable("Expected an error")`, so error-path tests are as cheap to write as happy-path ones. (d) A **bundle test** that re-runs the suite against the built artifact.

**A2-24 — Deprecate with an alias and a migration sentence, never a silent break.**
`export const LinearWebhooks = LinearWebhookClient` carrying an `@deprecated` line that names the replacement. Applies to every rename in this integration (notably the mission-projection export names, see C-6).

---

### A3. Surface cohesion — "as cohesive as `onToolEvent` parity"

Source: **Packet 3**. Today the Missions **board** is dashboard-only; the Missions **tools** are already cross-surface for free because they ride the tool registry (`src/lib/tools/registry.ts:89-98`, which has no surface dimension anywhere).

**A3-1 — The contract is declared once, in the surface-agnostic layer.**
`onToolEvent?: (event: {name: string; callIndex: number}) => void` sits on `AgentTurnRequest` at `src/agent/agent-loop.ts:87` — not on any adapter's signature. Missions' cross-surface piece goes beside `src/lib/media/process.ts` / `src/agent/commands.ts`, in `src/lib/`, never in an adapter.

**A3-2 — The doc comment on the type is normative enough to implement a fourth surface from.**
`agent-loop.ts:78-86` states what fires it, what each field means, the indexing convention, which helper renders it, and the failure policy. That is the bar for the new module's header.

**A3-3 — One emission site, wrapped in a try/catch that swallows.**
`agent-loop.ts:988-997`, catch body intentionally empty ("Status callbacks are best-effort; a surface bug must not kill the turn"). If a feature fires from several places, the shared piece is in the wrong layer.

**A3-4 — Every user-visible string and numbering rule lives in a pure shared module with its own unit test.**
`humanizeToolName` (`src/lib/tools/humanize.ts:19`), `toolStepSuffix` (`:52`), `formatTurnFooter` (`:81`); pinned by `humanize.test.ts:22-35`, which catches an off-by-one in **one** test instead of three integration tests. Missions needs `formatMissionList(rows)` / `formatMissionCard(row)` in the same shape.

**A3-5 — Four code paths, not three surfaces.**
Telegram (`src/adapters/telegram/handler.ts`), Slack main (`src/adapters/slack/handler.ts` ~503-712), **Slack per-agent with `tokenOverride`** (~309-500), dashboard stream (`src/adapters/dashboard/handler.ts:1600`). Missing the per-agent Slack path is the classic failure and there is a comment recording a real bug caused by exactly that (`slack/handler.ts:480-484`).

**A3-6 — Throttle state is reset on repaint.**
`lastSent = ''` + `lastEditAt = Date.now()` (telegram `:299-300`; slack `:411-412`, `:632-633`) so the next text chunk repaints immediately. Telegram/Slack hold a 1400 ms text throttle; the dashboard has none and needs none.

**A3-7 — The dashboard gets a typed SSE event plus a render branch with documented precedence.**
Server writes `event: '<name>'` alongside `chunk`/`tool`/`media`/`kb`/`image`/`artifact`/`final`/`error`/`done`; client adds a branch in `flushEvent()` (`web/src/pages/Chat.tsx:398-450`) with a try/catch that ignores malformed JSON (`:416`) and a render branch (`:721-749`).

**A3-8 — Duplicated `web/` copy carries a pointer comment in both directions.**
`src/lib/tools/humanize.ts:74-77` does this for the footer and `Chat.tsx:706-707` points back. The step-suffix duplication at `Chat.tsx:415` has **no** such comment — that is the one place the reference example is imperfect. Do not repeat it.

**A3-9 — Verify the payload carries what every surface needs to render.**
The dashboard structurally cannot render the footer's context segment because `inputTokens` is absent from the `final` event (`handler.ts:1787-1795`). A parity gap baked into the wire format is still a parity gap.

**A3-10 — The error path and the oversize path are mirrored, not just the happy path.**
`Something went wrong: <msg.slice(0,300)>` into the same placeholder on Telegram (`:436-445`) and both Slack paths (`:496-500`, `:708-712`); enforcement refusals mapped to codes before `event:'error'` on the dashboard (`:1836-1847`). Oversize fallback splits at 3000 (Telegram) / 35000 (Slack).

**A3-11 — Genuine gaps get a comment at every skipped call site naming CLAUDE.md.**
Four exemplars exist: `slack/handler.ts:460-464` and `:676-680`, `telegram/handler.ts:362-368`, `dashboard/handler.ts:2068-2071`. **Missions currently has zero such comments anywhere in the chat adapters — by the CLAUDE.md rule that omission is itself the defect**, and closing it is in scope.

**A3-12 — Concretely, for Missions, "cohesive" means all of:**
- `/missions [status]`, `/mission new <title>`, `/mission done <id>` added to the shared router `src/agent/commands.ts:59` — every surface picks them up free, because all five call sites already invoke `runCommand` (`telegram:152`, `slack:336`, `slack:543`, `dashboard:1641`, `dashboard:2077`). They must also appear in `HELP_TEXT` (`commands.ts:45-57`).
- A shared pure formatter, unit-tested, used by Telegram and **both** Slack paths, with the dashboard JSX kept in step per A3-8.
- An assignment **push**: the plumbing exists — `AgentTurnRequest.replyChatId` (`agent-loop.ts:129-133`) is threaded into `ToolContext` (`:998-1006`); Telegram passes the chat id (`telegram:319`), Slack passes `slack:<channel>[:threadTs]` (`slack:430`, `:650`). Today assignment is pull-only via `sendInterAgent` (`mission-tools.ts:180-195`).
- Authorization stays at the tool level (`mission-tools.ts:226-232`, `279-286`) because chat surfaces have no capability model.
- Docs updated in the same PR: `docs/how-it-works.md:43, 53, 75` and `docs/diagrams/request-lifecycle.md:33`.
- The **full** `npm test`, never a scoped run — the parity tests that matter are pure-module tests under `src/lib/`.

---

## Part B — Phase decomposition

Nine phases. Each is one builder + one critic. Already built and **not** re-litigated: `paperclip_disabled` registered (`kill-switches-repo.ts:109, 152, 299`, asserted at `authz-matrix.test.ts:590-594`) — but **inert, zero callers**; `src/lib/paperclip/mission-projection.ts` + its 181-line test; the patched image + `vendor/paperclip/Dockerfile`; the local harness and `tests/fixtures/paperclip-bootstrap.ts`; Phase 1 substrate (`database-stack.ts`, `filesystem-stack.ts`, the ungated `paperclipSecurityGroup` and `/claudeclaw/paperclip` secret) — gated off.

---

### Phase 1 — Contract probes and wire types
**Goal:** freeze what the pinned artifact actually does, locally, before a line of client logic depends on a guess.
**Creates:** `src/lib/paperclip/types.ts` (one file — wire shapes, `PaperclipDispatchBody`/`Context`, `ReconcilerWatermark`, `IssueChange`, `ReconcileAction`, `SweepResult`); `tests/contract/paperclip-routes.paperclip.integration.test.ts`; `tests/contract/openapi.snapshot.json`; `package.json` scripts `test:paperclip:up|down|all`.
**Changes:** `docker-compose.paperclip.yml` if the harness needs the patched image tag pinned by digest.
**Depends on:** the existing local harness + bootstrap fixture.
**Acceptance:**
1. All 19 integration points from the route table respond, with status codes and the presence of every field the projection reads recorded.
2. **A1-8 probe green:** `updatedSince=<now+1h>` returns `[]`.
3. **A1-9 probe green:** task_bridge key → 403 with the exact string; standard key → 200.
4. Fabricated run id on checkout produces the FK failure, not a clean 4xx (proves ADR hard constraint 2 empirically).
5. **A1-17 probe:** `boardMutationGuard` characterized for all five write shapes with an agent key.
6. **Open question R4 settled:** create a comment via `POST /api/issues/{id}/comments` and assert whether `issues.updated_at` moves. Record the answer in the handoff.
7. **Run-id boundary settled:** probe whether `POST /issues/{id}/comments` and `PATCH /issues/{id}` require `X-Paperclip-Run-Id` for a run-less agent actor (Packet 1 and Packet 4 disagree — see C-3).
8. `GET /api/openapi.json` snapshotted and committed.
**Judged against:** A1 (all).

---

### Phase 2 — The client (C1), config, agent map, engine interface
**Goal:** a transport worth the Linear comparison, with the kill switch finally wired to something.
**Creates:** `src/lib/paperclip/client.ts`, `error.ts`, `config.ts`, `agent-map.ts` (**canonical name — never `agent-id-map.ts`**), `mission-engine.ts` (the interface), `paperclip-mission-engine.ts` (the only implementation), plus colocated tests and a local mock-server test.
**Changes:** `src/config/env.ts` (+9 keys, `PAPERCLIP_AGENT_KEYS_JSON` / `PAPERCLIP_DISPATCH_SECRET` spellings); `scripts/lib/seed-defaults.ts` (`paperclip/poll_interval_ms`, `poll_overlap_ms`, `poll_page_limit`, `reconciler_mode='shadow'`, `enabled_agents=[]` — **not** `reconciler_watermark`, which is state).
**Does not create:** `disabled-mission-engine.ts` (see C-8).
**Depends on:** Phase 1.
**Acceptance:** every A2 criterion demonstrable by a named test; kill switch checked at **every** `invoke` inside the client so no caller can bypass it; the `randomUUID` lint/test guard green; `onBehalfOfUserId` absence test green; company-id pinning rejects any response whose companyId differs; `mission-projection.ts` imported, not re-derived.
**Judged against:** A2 (all), A1-2/3/4/10/11/12/13/14.

---

### Phase 3 — Image pipeline (the plan's Phase 1.5)
**Goal:** one path, no local Docker, that builds the patched image into the operator's own ECR and records its digest.
**Changes:** `scripts/lib/lifecycle/cloud-build.ts` — parameterize the Dockerfile path and build context (buildspec line `docker build ... -f Dockerfile .` at `:81`) through `CloudBuildOptions`, defaulting to today's behavior so the orchestrator path stays byte-identical; **keep the `test "$ARCH" = "arm64"` gate at `:82`**. `scripts/deploy.ts` — a second `runCloudBuild` beside `:334-343` and its digest resolution. `.github/workflows/deploy.yml` — mirror it (`:207-229` region); CI does **not** run `scripts/deploy.ts`. `scripts/lib/lifecycle/deploy-phases.ts:576-614` — a Paperclip `ContainerImageRecord` (`paperclip-server`, `linux/arm64`). `scripts/teardown.ts:786` — a second `cloudBuildNames(paperclipEcrRepo)` sweep (project, role, role policy, log group). `docs/out-of-band-catalog.json` — a row for the Paperclip CodeBuild project beside `paperclip-ecr-repo` at `:29-37`.
**Depends on:** nothing in Phases 1-2 (can run in parallel).
**Acceptance:** a deploy builds and pushes the patched image; the manifest carries its digest; `npm run teardown` leaves no `claudeclaw[-suffix]-paperclip-cloud-build*` resources; both drivers changed in the same commit; `cdk ls` unchanged.
**Judged against:** A1-18, Part D.

---

### Phase 4 — Paperclip service stack and tenant bootstrap
**Goal:** the patched image running in the customer account, with one company, one responsible user, N agents and N+1 keys.
**Creates:** `infra/lib/paperclip-stack.ts`, `infra/lib/paperclip-stack.test.ts`, `scripts/paperclip-bootstrap.ts`.
**Changes:** `infra/bin/app.ts` (instantiate after Compute), `infra/lib/compute-stack.ts` (three `EcsSecret.fromSecretsManager` lines + extend `allSecretArns` at `:228-244` — **a required CDK edit**, the execution role grants on exactly six ARNs today), `.github/workflows/deploy.yml` (populate secrets — `put-secret-value` appears **zero** times today).
**Depends on:** Phase 3.
**Acceptance:** `DesiredCount === 1`; **no** `ScalableTarget` for this service; `MinimumHealthyPercent 0` / `MaximumPercent 100`; health path `/api/health` on port 3100; DB ingress source is the Paperclip SG, **not** the Fargate SG; `httpsListener` handled as `undefined` (both real environments set `DOMAIN_NAME` empty — `deploy.yml:121-127, :136-139`); re-running the bootstrap is a provable no-op (zero new agents, zero new keys); `main` holds role `ceo`; every agent carries `metadata.netzarAgentId`; `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE` asserted unset; no token ever printed.
**Judged against:** A1-1/2/9/18, Part D.

---

### Phase 4.5 — The Paperclip operator console, internal only

> Numbered 4.5 for the same reason Phase 1.5 was: a piece of the plan discovered missing from this
> decomposition after it was written, not a renumbering. **This phase was absent from the first nine
> and was added on author challenge** — the decomposition covered plan §16.1-§16.5 (the Netzar-side
> board upgrades) and silently dropped §16.6-§16.7.

**Goal:** Paperclip's own React board reachable as an **operator console**, and reachable by nobody else.

**The decision it implements, restated so it is not re-litigated:** Paperclip's UI is **not** integrated
into Netzar's UI. `@paperclipai/ui` is not a dependency — Netzar is Preact + `wouter-preact` +
`@preact/signals`, Paperclip is React 19, and Paperclip ships **no CORS middleware**, so its components
could not call its API from Netzar's origin regardless. Netzar's board stays Netzar's; this phase
exposes Paperclip's board *beside* it, for operators.

**Changes:** `infra/lib/paperclip-stack.ts` — `SERVE_UI=true`, `PAPERCLIP_PUBLIC_URL` set to the exact
ops hostname, a **second** listener rule on a distinct host matched before the Netzar rule.
`docs/features/paperclip/` — the operator runbook.

**Depends on:** Phase 4.

**Acceptance:**
1. `PAPERCLIP_DEPLOYMENT_MODE=authenticated`. **Never `local_trusted`** — that makes every request an
   instance admin with no credential at all.
2. `PAPERCLIP_PUBLIC_URL` matches the ops hostname **exactly**. `boardMutationGuard` builds its
   trusted-origin set from `localhost:3100`, `127.0.0.1:3100`, the request `Host`/`X-Forwarded-Host`
   and this variable; get it wrong and every board mutation 403s with
   `"Board mutation requires trusted browser origin"`. This is the same guard the Phase 1 A1-17 probe
   characterized — reuse that probe's evidence rather than rediscovering it.
3. Reachable **internal-only** (private ALB / VPN / Cloudflare Access), reusing the cloudflared
   connector pattern the dashboard already has, with its own access policy.
4. **No link anywhere in the Netzar SPA.** A `Sidebar.tsx` entry would put it one click from every
   operator-tier user. Operators reach it by bookmark. A test greps `web/` for the ops hostname.
5. Named operator accounts only; no shared login.
6. **Blocked-on note carried from A23:** the ALB HTTPS listener exists only when `DOMAIN_NAME` is set,
   and **both real environments deliberately set it empty**. This phase therefore cannot assume a
   listener to attach to, and must either provision its own or degrade explicitly — decide before
   building, not during.

**Why it stays strictly internal — four code facts, not caution:**
- Its auth plane is **disjoint** from Netzar's: Better Auth cookie sessions versus opaque bearer tokens
  and a 32-capability matrix. No SSO, no shared session, no capability mapping — and Netzar's
  `revokeTokensForUser` does not reach it.
- It is a **second, unsynchronized authorization surface** over the same data: 21 Paperclip permission
  keys beside Netzar's 32 capabilities across 7 profiles.
- It leaks the entire Paperclip vocabulary — companies, issue prefixes, projects, pipelines, routines,
  secrets, workspaces — which is precisely what the ACL exists to prevent.
- It is a materially larger attack surface than the API alone.

**What it buys, and why skipping it is expensive:** the escape hatches live here —
`POST /issues/{id}/admin/force-release`, `GET /issues/{id}/diagnostics/blockers|wakes|subtree`, the
watchdog routes, `GET /issues/{id}/recovery-actions`, `GET /companies/{cid}/live-runs`,
`POST /heartbeat-runs/{runId}/cancel`. It is also **the only place a human can override an
assignment**, which the ratified routing decision explicitly relies on: Netzar proposes, Paperclip
records and arbitrates, and a human override in Paperclip's board wins. Without this phase that clause
is unimplementable.

**Explicitly NOT reused** (plan §16.6): the Issues kanban (Netzar has one), Timeline/audit (Netzar has
its own audit surface with PII redaction and WORM at tier ≥ 2), and Workspaces/Pipelines/Cases/
Routines/Secrets/PluginManager (out of scope — exposing them invites someone to start using them).
`IssueDetail` is linked for operators, never embedded. `Approvals` is the strongest **later** candidate,
because human approval gates are the largest capability Netzar is buying and Paperclip's implementation
is complete.

**Judged against:** A1-17, and plan §16.6-§16.7.

---

### Phase 5 — Reconciler, shadow then active
**Goal:** the durability layer. Highest-risk component; ships observing only.
**Creates:** `src/lib/paperclip/reconciler.ts`, `watermark.ts` (**canonical — never `watermark-repo.ts`**), tests.
**Changes:** `src/index.ts` — `startPaperclipReconciler()` beside `startQueueDrain()` (`:73`), `startCanary()` (`:88`), `startWebhookMonitor()` (`:89`). **Not `src/server.ts`** — it is 166 lines with zero background loops (plan-audit P1-F1).
**Depends on:** Phases 2, 4.
**Acceptance:** leader election via `tryAcquireRunnerLease` from `src/lib/state/runner-lease.ts` with `ttlMs` above the poll interval; pagination to exhaustion before the watermark advances; watermark never moves backwards and never moves on a partial page; cold start begins at `now - poll_overlap_ms`, **not** epoch; overlap-and-dedupe test (same `(id, updatedAt)` twice yields one candidate); lease loss stops the sweep; shadow mode performs zero writes; **promotion is a config write, not a deploy** — flipping `paperclip/reconciler_mode` and `poll_interval_ms` takes effect within the cache window with no `cdk deploy` and no task restart; 48 h shadow with zero unhandled errors and watermark lag below one interval; poll interval floor 15 s (every agent-key request issues an undebounced `UPDATE agent_api_keys SET last_used_at`).
**Judged against:** A1-5/7/8/9/10/15, A2-12/15.

---

### Phase 6 — Inbound dispatch route and worker
**Goal:** latency, and the only legitimate source of a run id.
**Creates:** `src/adapters/dashboard/paperclip-dispatch.ts` (202-ACK), `src/lib/paperclip/dispatch-worker.ts` (**a separate file from the route**, per §27.1).
**Changes:** `src/server.ts` — mount `/api/paperclip` **before** the `/api` catch-all; `src/agent/agent-loop.ts:246-261` — reuse the `<hive_context>` angle-bracket neutralization at ingest.
**Depends on:** Phase 5 (the reconciler is the mandatory mitigation for dispatch loss and must be live first).
**Acceptance:** 202 returns before the work promise settles; 401 on wrong/absent secret; 400 on malformed body; unknown agent rejected; duplicate `(runId, issueId)` is a no-op returning `202 {deduplicated:true}` and **never** a 4xx; the run id reaches the client layer; `runAgentTurn` is called (never `runAdmittedTurn`, never Bedrock directly — the cost cap depends on the admission wrapper reaching exactly one of finalize/abort); history is caller-supplied; `result.blocked` turns are never persisted; **`POST /api/test-turn` is not reused** (it runs the turn synchronously at `handler.ts:2085-2098` and would blow the adapter's `timeoutMs`); exactly one agent's `adapterConfig.url` is pointed at the route to begin with; rollback is blanking that URL — a data edit, no deploy.
**Judged against:** A1-3/12/17, A2-1..14.

---

### Phase 7 — ACL cutover (C3) with the wire contract byte-identical
**Goal:** `/api/missions*` served from Paperclip with zero change to `web/`.
**Creates:** `src/adapters/dashboard/missions.ts` exporting `registerMissionRoutes(router: Hono)`.
**Changes:** `src/adapters/dashboard/handler.ts` — **extract, do not delete**: lift the four inline bodies (`:3096`, `:3110`, `:3171`, `:3203`) into `legacyListMissions` / `legacyCreateMission` / `legacyUpdateMissionStatus` / `legacyReassignMission` that stay in the file; register the ACL routes **on the same router instance** in front of them behind `PAPERCLIP_ENABLED`. `src/adapters/dashboard/jarvis.ts:1256-1260` and `src/lib/tools/privacy-tools.ts:87` repointed at the same ACL. `src/lib/tools/mission-tools.ts` bodies swapped at `:170`, `:245-246`, `:295` — names and schemas unchanged.
**Depends on:** Phases 2, 5, 6.
**Acceptance:**
1. `src/adapters/dashboard/authz-matrix.test.ts` passes **completely unchanged** — including the exact-equality viewer-deny body `{error:'forbidden', requiredRole:'operator', yourRole: tier}` at `:513-518`, which comes from the legacy ladder at `handler.ts:826-831` and only fires because `requiredRole()` (`:209-247`) has no `/missions` case. **Do not mount a sub-router and do not add a `/missions → viewer` relaxation.** If this test needs an edit, the contract is broken — fix the ACL, not the test.
2. `src/lib/jarvis/route-manifest.ts` and `src/lib/auth/permissions.ts` unchanged.
3. Envelope equality against a recorded legacy response, field for field, for all four routes plus every 400/403/404 shape.
4. `web/src/pages/Missions.tsx` unchanged, all four operations plus the detail modal exercised by hand.
5. The GDPR export still returns the subject's missions with identical field names (see C-11 — this is a blocking gate, not a nice-to-have).
6. `neutralizeForPrompt` actually called at the Jarvis and agent-loop boundaries, with the `</hive_context><system>ignore prior instructions` string in the test.
7. Two off-switches, neither a silent fallback: `PAPERCLIP_ENABLED=false` → ACL router not mounted, legacy serves; `paperclip_disabled` → ACL mounted, returns `503 {error:'paperclip_disabled'}` and **does not** fall back mid-request.
**Judged against:** A1 (all), A2-19/20.

---

### Phase 8 — Cross-surface Missions parity and the new agent verbs
**Goal:** Missions stops being dashboard-only, and the new Paperclip-native verbs land under the addon pattern.
**Creates:** `src/lib/missions/format.ts` (pure, tested) + `format.test.ts`; `src/lib/tools/paperclip-tools.ts`.
**Changes:** `src/agent/commands.ts` (router + `HELP_TEXT`), all four chat code paths, `web/src/pages/Chat.tsx` if a new SSE event is added, `src/server.ts:46-60` (side-effect import — a tools module not imported there registers nothing and fails silently), `docs/how-it-works.md`, `docs/diagrams/request-lifecycle.md`.
**Depends on:** Phase 7.
**Acceptance:** every A3 criterion; specifically — the shared formatter is used by Telegram and **both** Slack paths; the per-agent Slack path is not forgotten; a comment naming CLAUDE.md sits at every genuinely skipped call site (there are zero today); `registerAddon({id:'paperclip', killSwitch:'paperclip_disabled', defaultOn:true})` surfaces on `GET /api/addons`; every new tool gates at **invoke** time, never registration; run-less envelope respected (no checkout attempt without a run id); `create_mission`'s toolSpec JSON byte-identical to before; `ToolResult.text` free of presigned URLs; FULL `npm test`.
**Judged against:** A3 (all), A2-19.

---

### Phase 8.5 — Org hierarchy and goals in agent context

> **Added on author request**, not discovered as a gap. The original decomposition treated Paperclip's
> org chart as operator-only scenery and did not carry goals at all. Both are real capability Netzar
> does not have, and both are reachable by an ordinary agent key.

**Goal:** Netzar agents can see where they sit in the org, who they escalate to, and what they are
working toward — and goals become a first-class Netzar concept.

**The fact that makes this cheap, verified against the running artifact 2026-08-20:** every route below
is `x-paperclip-authorization: {actor: "board_or_agent"}` and accepts `AgentBearerAuth`. An agent
holding its own Paperclip key reads these directly; no board session, no operator console, no new
permission model.

| Route | Use |
|---|---|
| `GET /api/companies/{cid}/org` | the hierarchy as JSON — **response schema is `additionalProperties: {}`, i.e. undocumented** |
| `GET /api/companies/{cid}/org.svg` / `.png` | **server-rendered** chart |
| `GET`/`POST /api/companies/{cid}/goals`, `GET`/`PATCH`/`DELETE /api/goals/{id}` | the goal tree |
| `GET /api/agents/me`, `/me/inbox-lite`, `/me/inbox/mine` | "who am I, what is mine" in one call |

**Goal shape (authoritative, from the live OpenAPI):** `title` (required), `description`,
`level ∈ company|team|agent|task`, `status ∈ planned|active|achieved|cancelled`, `parentId` (self-FK,
so goals nest), `ownerAgentId`.

**Creates:** `src/lib/paperclip/org.ts` and `goals.ts` (projections, beside `mission-projection.ts`);
`src/lib/tools/paperclip-tools.ts` gains `paperclip_list_goals`, `paperclip_set_goal`,
`paperclip_whoami`; a goals surface on the Missions page.

**Depends on:** Phases 2 and 8.

**Acceptance:**
1. **Probe the org JSON before writing a line against it.** Its schema is undocumented — exactly the
   condition that made **A1-12** wrong. Characterize, then type.
2. **The org chart renders from `org.svg`, not from a reimplementation.** Netzar is Preact, Paperclip
   is React 19; a server-rendered image is the whole point and the lazy correct answer. Fetch it
   server-side through the ACL and serve it from Netzar's origin — Paperclip ships **no CORS**, so the
   browser cannot fetch it cross-origin.
3. **Goals cross the ACL like everything else.** `companyId`, `ownerAgentId` and Paperclip's uuids do
   not reach a Netzar surface; the projection maps agent uuid → Netzar slug the way `agent-map.ts`
   already does. Neither system learns the other's vocabulary.
4. **Every string from the org chart or a goal is neutralized before it enters a prompt.** Goal titles
   and agent names can originate from another agent or from Paperclip's own UI, so this is a widened
   injection surface. `neutralizeForPrompt` exists, is tested, and is currently called by **nothing**
   (**C-13**) — this phase is one of the places that must call it.
5. **Org context is opt-in per agent and bounded, not injected into every turn.** See the caution below.
6. `TOOL_TURN_LIMIT` is **8**. Three new tools compete with existing ones for the same budget — ship
   `paperclip_whoami` and `paperclip_list_goals` first and justify any third.
7. Cross-surface per **A3**: goals render through a shared pure formatter used by Telegram and **both**
   Slack paths, not just the dashboard.

**The caution that needs an explicit decision before building:** the appeal here is "agents understand
the hierarchy", and the naive implementation is to inject the org chart and goal tree into every
agent's system context. That bills tokens on **every turn of every agent forever**, grows with the org,
and competes with the context the agent actually needs for the task in front of it. The recommendation
is **pull, not push**: expose it as tools the agent calls when it needs to escalate or check alignment,
and inject at most a one-line "you report to X" into standing context. If you want the full chart in
every prompt, that is a deliberate, separately-priced choice — the same shape as the install-cost
decision, and it should be recorded the same way.

**What this unlocks that the ACL alone does not:** `agents.reports_to` is the **only** computed routing
in Paperclip — the recovery ladder walks `assignee.reportsTo → creator.reportsTo → role 'cto' →
role 'ceo'`. Once agents can read that graph, escalation stops being a Netzar-side guess and becomes a
question they can answer.

---

### Phase 9 — Install by default, projection widening, retirement
**Goal:** Paperclip provisions on a standard install; the lossy projection goes away; the legacy path is removed last and separately gated.
**Changes:** see Part D for the install half. Projection half: `MISSION_STATUSES` widened to six, `web/src/lib/glossary.ts` `statusLabel`, `web/src/pages/Missions.tsx` COLUMNS `:37` → six lanes, priority switched to the 4-band enum, `dueAt` removed (interface `:31` and render sites `:263, :343, :370`), `due_at` dropped from `mission-tools.ts:178`, `scripts/mission.ts` rewritten (`list` sends `?agent=` where the route reads `owner`; `show` calls a route that has never existed).
**Depends on:** Phase 8; the retirement step additionally gated on two clean weeks in production.
**Acceptance:** `npx cdk ls` prints the same stack set with and without `CCE_PAPERCLIP_ENABLED`, asserted by a test; the money gate prices Paperclip unconditionally at the tiers that get it; teardown routes the new stacks through `cdk-destroy`; the board shows six lanes; both CLI commands work for the first time; the `invalid_status` guard at `handler.ts:3183-3191` is **kept** (nothing writes to the GSI any more, but Paperclip has no CHECK constraint on `issues.status` and `assertTransition` validates only the destination); the legacy handler functions and `PAPERCLIP_ENABLED` are deleted only in the final, separately-reviewed commit; `paperclip_disabled` stays permanently.
**Judged against:** Part D, A1-15, A3-4.

---

## Part C — Open questions and contradictions

Each item: the disagreement, the decision needed, the recommendation.

**C-1 — `updatedSince` does not exist upstream at the pinned tag.**
Packet 1 verified zero occurrences at `v2026.722.0` **and** `v2026.817.0`, in both `routes/issues.ts` and `services/issues.ts`. Packet 4's plan text cites `services/issues.ts:5587-5591` for `gt(issues.updatedAt, since)` — that is *our patch*, not upstream. **Decision:** none needed on the mechanism; the ADR amendment already ratifies the patch. **Required:** the A1-8 boot probe, because an unpatched build fails silently with a 200. Plus the re-pin rule — drop the patch the moment a release carries `updatedSince` natively.

**C-2 — The watermark predicate contradicts itself, and the ADR's version is a correctness hazard.**
Plan §13.3.1 says strict `>` with a 2000 ms overlap and client-side `(id, updatedAt)` dedupe. ADR amendment says the ratified predicate is `updated_at >= watermark + 1ms`. **`updated_at` is microsecond `timestamptz` and API callers see millisecond-truncated values** — so storing a truncated max `T` and querying `>= T + 1ms` permanently loses any row whose true `updated_at` falls in `[T, T+1ms)` that was not in the processed page. **Decision needed (blocking Phase 5).** **Recommend:** query `>= (maxUpdatedAt − poll_overlap_ms)` with client-side dedupe on `(id, updatedAt)`, which is lossless under truncation; treat the ADR's `+1ms` as superseded and amend the ADR in the same PR. Prove it with a probe that writes two issues inside the same millisecond and asserts both are seen exactly once.

**C-3 — Packets disagree on where a run id is required.**
Packet 1: `requireAgentRunId` gates checkout (`:8850`), release (`:8900`), and **thread interactions/comments** (`:9034`, `:3583`). Packet 4 route 10 says `POST /issues/{id}/comments` needs **no** run id, and says PATCH needs one only when the existing status is `in_progress` **and** the issue is assigned to the actor. The ACL comments as a run-less actor, so this is load-bearing. **Decision:** settle by probe in Phase 1, not by reading. **Recommend:** design the ACL to work run-less and degrade to `wakeup` if the probe shows comments require a run.

**C-4 — Line-number citations across the plan are from a different revision.**
Beyond the 16 wrong citations `plan-audit.md` already found, Packet 1 and Packet 4 disagree systematically on `routes/issues.ts` offsets (checkout 8811 vs ~8850; release 8895 vs 10662; comments 9669 vs 11616; force-release 8929 vs 10696) and on `services/issues.ts` constants (114-115 vs 137-138). **Decision:** adopt A1-16 as a hard rule. **Recommend:** a review checklist item — any PR citing a Paperclip line number is rejected.

**C-5 — Response shapes are largely unverified and `openapi.ts` was never parsed.**
Packet 1 confirmed request schemas exactly and error codes, but transcribed almost no success bodies. **Recommend:** the Phase 1 OpenAPI snapshot is the contract; the projection may only read fields present in it.

**C-6 — The plan's projection function names do not match the shipped file.**
Shipped `src/lib/paperclip/mission-projection.ts` exports `toIssueStatus`, `toMissionStatus`, `toPriorityBand`, `toPriorityScore`, `missionToIssueCreate`, `issueToMission`, `neutralizeForPrompt`. The plan (§13.7/§17.4) names `missionStatusToIssueStatus`, `statusToMission`/`issueStatusToMissionStatus`, `priorityToBand`, `bandToPriority`/`priorityToNumber`, `missionToCreateIssue`. **Decision:** code wins — **shipped names are canonical**; the plan text is historical. If any rename is genuinely wanted, do it with an alias plus a migration sentence (A2-24), never a silent break.

**C-7 — Dual-write vs "do not dual-write" (direct reversal).**
§25.4 is titled "Dual-read / dual-write: not needed" and says "Do not do it here"; §12.8 calls a dual-write fallback split-brain. §30 Stage 4 prescribes exactly a dual-write probe and makes its divergence count a GO/NO-GO gate. The probe has no implementation anywhere (no file, no phase, no interface, no test). **Recommend (already the assembled §27.1 position):** **shadow READ comparator only** — the legacy read serves the user, the ACL read runs alongside, a pure field-by-field divergence comparison is logged, and **nothing is written on either side**. Delete the Stage 4 dual-write language from the plan in the same PR.

**C-8 — `PAPERCLIP_ENABLED` fall-through vs handler deletion.**
§29.4 and Stages 4-6 need the legacy handlers live to fall through to; §17.1/§27.1 as drafted delete the four inline bodies at cutover, and Phase 7's rollback was "revert the commit". **Recommend:** **extract, do not delete** (Phase 7 above). Phase 7's primary rollback becomes a flag flip; the deletion is the last step of Phase 9, gated on two clean weeks. Related: the flag is a **router-level switch picking one whole stack or the other** — a per-request fallback is forbidden, and that prohibition belongs in a code comment and in the ADR.

**C-9 — The MissionEngine abstraction was orphaned.**
§13.2 declared three files that appeared nowhere in §17's tree, §17.2's call graph, §26's phases, or §27's build sheet — the plan's central interface contract was unimplementable as written. **Recommend:** build **two** files (`mission-engine.ts`, `paperclip-mission-engine.ts`); **drop `disabled-mission-engine.ts`** — the kill switch lives inside C1 so every method already throws `PaperclipDisabledError`, and the rollout flag lives at the router. Also settle the option-field name: §13.2 uses `as`, §26 Phase 4 uses `actor`. **Recommend `actor`.**

**C-10 — Five specified files had no §27 row (~530 LOC silently dropped).**
`config.ts`, `dispatch-worker.ts`, `agent-map.ts`, `docker-compose.paperclip.yml`, `tests/fixtures/paperclip-bootstrap.ts`. **Recommend:** all five are real; `dispatch-worker.ts` stays a **separate file** from the route so the 202 path is trivially testable. Canonical names: `agent-map.ts` (never `agent-id-map.ts`), `watermark.ts` (never `watermark-repo.ts`), one `types.ts` (never `dispatch-types.ts` + `reconciler-types.ts`).

**C-11 — The GDPR export hole. This is the sharpest correctness risk in the whole map.**
`privacy-tools.ts:117-118` filters missions by `m.createdByChat === chatId`; `issueToMission` hardcodes `createdByChat: 'paperclip'` (`mission-projection.ts:172`). Every Paperclip-origin mission therefore silently disappears from a user's `forget_me` export — a compliance regression with no test coverage. **Decision needed before Phase 7 ships.** **Recommend:** do not try to round-trip the chat id through Paperclip (there is no `metadata` column on `issues`, and a system comment is fragile at scale). Instead write a Netzar-side provenance row at create time (`PK=CHAT#<chatId>`, `SK=ISSUE#<issueId>`, following the existing `claudeclaw-hook-idempotency` item pattern) and have `privacy-tools.ts` join on it. Ship the test in the same PR. Also keep the existing policy of **not** deleting missions on purge (`privacy-tools.ts:1-16`).

**C-12 — `paperclip_disabled` is registered but inert.**
Grep returns only the three registration sites and the test; zero callers. **Recommend:** the gate goes inside `client.ts` at every `invoke` (copying the `salesforce-tools.ts:46-52` `gate()` shape), so no future caller can bypass it.

**C-13 — `neutralizeForPrompt` exists, is tested, and is called by nothing.**
`jarvis.ts:1256-1260` returns raw Mission rows straight into a speaking model's context. **Recommend:** call it at the Jarvis boundary, at the dispatch-worker ingest, and anywhere Paperclip text enters hive context; test with the real hostile string.

**C-14 — A second and third read path bypass the ACL.**
`jarvis.ts:1256-1260` (own `listMissionsForAgent(owner, 100)`, hand-reproduced `{owner, count, missions}` envelope) and `mission-tools.ts` (which additionally uses `listMissionsByStatus`, a function no HTTP route reaches). Rewriting only `handler.ts:3101` leaves the Missions tab and the voice co-pilot reporting different boards. **Recommend:** all three repointed in Phase 7; add a grep-based test that `mission-tasks-repo.js` is imported only by `handler.ts` (the legacy functions) until retirement.

**C-15 — Both round-trips are lossy and the UI silently eats the loss.**
`toPriorityScore(toPriorityBand(73)) === 80`; `blocked → open`, `in_review → in_progress`. `Missions.tsx:189-191` filters lanes by exact equality with no fallback, so an unmapped status vanishes from every column. The four dashboard routes are *accidentally* safe on priority because `handler.ts:3160-3167` never passes one (always the repo default 50), but `create_mission` sets arbitrary priorities and those rows come back through the same GET. **Recommend:** assert the lossiness explicitly in tests (as the existing test already does at `:87-89`), expose `paperclipStatus` and `blockedBy` as additive fields immediately, and fix the lanes in Phase 9.

**C-16 — Legacy repo bugs: decide which are preserved byte-for-byte.**
(a) 200-row mutation horizon (`mission-tasks-repo.ts:143, 180`) — a mission that reads fine 404s on write. (b) 8-char prefix collision (`:144, 181`) — `Array.find` picks the newest match, and `startsWith('')` matches everything. (c) non-transactional reassign put-then-delete (`:190-210`) — the same id can be live in two partitions, and `Missions.tsx:91-107` flattens without deduping. (d) unvalidated status cast on read (`:223`). **Recommend:** preserve the 8-char prefix contract (the tool advertises it at `mission-tools.ts:268`) and add an ambiguity error when two rows match; **do not** preserve the 200-row horizon (Paperclip resolves by id — previously-404ing writes will start succeeding, which is correct but is not byte-for-byte, and no test covers it either way); keep echoing the **request** id in the status 200 body to preserve the pinned shape, and log the resolved uuid alongside.

**C-17 — Dispatch route auth: two incompatible designs.**
§13.4/§15.6 want an operator bearer + `principalHasRouteCapability('agents:write')` + a `hashPrefix16` pin against runtime-config. §26 Phase 6 step 2 prefers a constant-time compare against `PAPERCLIP_DISPATCH_SECRET`. **Recommend the shared secret:** it does not widen the human authz model, `src/lib/auth/permissions.ts` needs no change, and `authz-matrix.test.ts` is untouched. Audit every rejection, rotate on schedule, and record that the secret is plaintext at rest in Paperclip's `adapter_config` jsonb.

**C-18 — New tool naming: two schemes.**
§17.8 says `mission_children` / `mission_comment` / `mission_attach` / `mission_block` / `mission_request_review`; §26 Phase 8 says `paperclip_create_subtask` / `paperclip_add_comment` / `paperclip_attach_work_product` / `paperclip_request_approval` / `paperclip_block_on`. **Recommend the `paperclip_*` scheme** — `mission_*` reads as a sibling of the three legacy names that models already know, inviting confusion. Ship the two highest-value verbs first (`TOOL_TURN_LIMIT` is 8, `agent-loop.ts:59`).

**C-19 — Config-plane and naming drift (mechanical, fix by find-and-replace).**
Reconciler cadence/mode: env vars (§8.5.1) vs runtime-config (§23.3/§27.1) — **runtime-config wins**, because Phase 5's "promotion is a config write, not a deploy" only holds there. Secret name `/claudeclaw/paperclip-keys` vs `/claudeclaw/paperclip` — **the latter, as shipped**. Secret field names: `agent_keys_json`/`dispatch_token` (§15.5) vs `agent_keys`/`dispatch_secret` — **the shipped spelling wins** (`secrets-stack.ts:113-118`); a mismatch produces a task that cannot start with a `ResourceInitializationError`, not an application error. Env vars: `PAPERCLIP_AGENT_KEYS_JSON` / `PAPERCLIP_DISPATCH_SECRET`, not the §29.4 spellings. Port: **3100, never `PORT=3000`** (§22.5 closes what §5.2 left open). Stage 4 gate arithmetic says "all seven metrics" over an eight-row table.

**C-20 — Unknowns that stay unknown until measured.**
The search rate limiter's numeric budget is injected at construction, not a source constant. The MCP server package's tool names are **not** a route mapping and were not treated as evidence. `doc/CLI.md` route mappings are unverified and demonstrably imprecise. `doc/API.md` does not exist. Whether all ~735 company-scoped handlers are tenant-safe is unconfirmed (irrelevant today because one deployment = one company, but re-opened by any of the five triggers in §15.7). Nothing in Packet 1 was exercised against a running instance — Phase 1 is the first execution.

**C-21 — Repo/backlog narrative claims are unverified.**
Star counts, "production-ready", "Discord/Twitter" came from summarizer prose. "222 migrations" is really 221 files (0126 and 0130 absent); "120 schema files" is 116; the "32-item backlog" is 28 IDs with 2 blocked and 2 retired. Do not repeat these numbers in commit messages or docs.

**C-22 — Missions parity is absent from the plan entirely.**
Packet 4 mentions chat-surface parity once, as a "LOW" Phase 10 risk. Packet 3 shows the Missions board shipped dashboard-first with **no comment at any skipped call site**, which under CLAUDE.md is itself the defect. **Recommend:** Phase 8 is not optional scope; A3 is a third of the Bar.

---

## Part D — Install by default

### What gates it off today

`CCE_PAPERCLIP_ENABLED` is a bare `process.env.X === '1'` read with **seven** homes, not five:

1. `infra/bin/app.ts:63-76` — the synth gate for `CCE-Database` + `CCE-Filesystem`.
2. `scripts/deploy.ts:444` — phase-a stack list (`...(paperclipEnabled ? ['Database','Filesystem'] : [])`).
3. `scripts/deploy.ts:461-464` — the out-of-band `ensureEcrRepo(env, paperclipEcrRepo)` call.
4. `scripts/deploy.ts:1253` — `cdkEnvBag`, the `.env` → synth **allowlist**.
5. `scripts/lib/lifecycle/manifest.ts:105-110` — `SYNTH_INPUT_ALLOWLIST` (a rollback re-synth without it would drop a deployed Aurora and EFS from the assembly).
6. `scripts/lib/lifecycle/teardown-plan.ts:174-180` — `currentAppStackNames`, deciding `cdk-destroy` vs direct `DeleteStack`.
7. `.github/workflows/deploy.yml:195-197` (CI ECR ensure) and `:311` (`vars.CCE_PAPERCLIP_ENABLED` into the synth env) — **plus** `scripts/lib/cost-gate.ts:32-43, 72-105` (the money gate).

### The end state, and how to get there

Convert from pattern B (env flag) to pattern A (always constructed, gated internally on tier), which `infra/bin/app.ts` already states twice as the house rule (`:131-133` SecurityStack, `:147-149` BackupStack).

**Step 1 — Tier-shape it before defaulting it on.**
Add a field to `TierShape` (`infra/lib/constants.ts:222-245`) beside the existing `paperclipAuroraMaxAcu` (`:239`, 1/2/4/8 at `:258/:270/:296/:313`). T0 Hobby off; T1+ on. Today **only the ceiling is tiered** — the 0.5 min-ACU floor is explicitly not (`infra/lib/database-stack.ts:64-70`), and min ACU is what bills continuously, so an untiered default-on puts roughly **$50/mo of always-on cost on every hobby install** for a retained, deletion-protected cluster the client cannot casually tear down. This is recorded as a Trap at `handoffs/2026-08-20-phase-2-readiness.md:296`.

**Step 2 — Move the construction out of the `if`.**
`infra/bin/app.ts:63-76` → unconditional `DatabaseStack` + `FilesystemStack` + `PaperclipStack`, each with an explicit `addDependency(network)`, gating internally on the tier field so a T0 synth produces a stack that creates no resources but still resolves cleanly.

**Step 3 — Make every remaining home unconditional in the same commit.**
- `scripts/deploy.ts:444` — names always in the phase-a list; `:461-464` — ECR repo always ensured.
- `.github/workflows/deploy.yml:195-197` — drop the `[ "$CCE_PAPERCLIP_ENABLED" = "1" ]` guard; add the Paperclip image build beside `:207-229`.
- `scripts/lib/lifecycle/teardown-plan.ts` — move `Database`, `Filesystem`, `Paperclip` into `ALWAYS_ON_STACK_SUFFIXES` (`:151-166`) and delete the conditional at `:178-180`. This list is the machine-readable definition of "installs by default" and must mirror `app.ts` exactly.
- `scripts/lib/cost-gate.ts:32-43, 72-105` — price it unconditionally at the tiers that get it; fold the figure into `FALLBACK_RANGES` and add a real line item to `scripts/cost-estimate.mjs` (which has no Aurora/EFS/RDS line at all today); revisit the monthly budget default in `infra/lib/cost-guardrails-stack.ts` (moved 650→600 precisely because the substrate was off).
- `.env.example:132-137` — rewrite the block; keep `CCE_PAPERCLIP_ENABLED` only as an **escape hatch** (`=0` forces off), and keep its `cdkEnvBag` (`deploy.ts:1253`) and `SYNTH_INPUT_ALLOWLIST` (`manifest.ts:105-110`) entries for exactly that reason. Note `PAPERCLIP_BETTER_AUTH_SECRET` is consumed in phase b and correctly needs **no** `cdkEnvBag` entry — do not cargo-cult that fix.

**Step 4 — Close the teardown and catalog gaps (Phase 3 work, listed here because it is install hygiene).**
`scripts/teardown.ts:786` sweeps `cloudBuildNames(names.ecrRepo)` — the orchestrator repo only — so a Paperclip cloud build leaves `claudeclaw[-suffix]-paperclip-cloud-build`, its IAM role, its role policy and its log group behind. Add the second sweep and a `docs/out-of-band-catalog.json` row, remembering that the catalog only **reports**; the delete is hand-written.

### Risks, named

- **Silent success on a mismatched gate.** `cdk deploy A B C` throws only when the *total* selected count is zero, so a phase-a list naming `CCE-Database` while synth omitted it exits 0 and creates no Aurora. **Mitigation:** all homes change in one commit, and a test asserts the phase-a name list against `npx cdk ls` output (the `teardown-plan.test.ts` pattern). Verify `cdk ls` prints the same set with and without the env var.
- **Two deploy drivers.** CI does not run `scripts/deploy.ts`; it runs `npx cdk deploy --all` at `deploy.yml:356` and hand-mirrors every step. Anything added to one and not the other is absent on the path that actually reaches staging and production.
- **RETAIN + deletionProtection is not a clean slate.** Both substrate stacks are `RemovalPolicy.RETAIN` (`database-stack.ts:80`, `filesystem-stack.ts:57, 77`) and the cluster is `deletionProtection: true` (`:79`). A rolled-back stack leaves DELETE_SKIPPED orphans: the **fixed-name log group** (`filesystem-stack.ts:70-78`) blocks the retry at the same point, while the **EFS — whose name is a tag, not a unique key — succeeds and creates a second filesystem you pay for twice**. Check for orphans before any re-deploy.
- **Do not retro-gate already-deployed RETAIN resources.** `paperclipSecurityGroup` (`network-stack.ts:113-127`) and `/claudeclaw[-suffix]/paperclip` (`secrets-stack.ts:113-118`) are ungated and live in staging. Removing them makes CloudFormation DELETE_SKIP them, and Secrets Manager names are unique keys, so a later re-arm fails `ResourceExistsException` with a 7-day recovery window.
- **The HTTPS listener usually does not exist.** `compute-stack.ts:115` types it optional and it is only created when `DOMAIN_NAME` is set (`:1005, :1043`); both real environments set it empty on purpose (`deploy.yml:121-127, :136-139`) because there is no Route 53 zone or ACM cert and the ALB is internal behind a Cloudflare Tunnel. Priorities 1 and 2 are taken, and at `cloudFrontEnabled` tiers the default action is 403 so a new rule needs its own condition.
- **CI populates no secrets.** `put-secret-value` appears **zero** times in `deploy.yml`, so `/claudeclaw-staging/paperclip` stays `REPLACE_ME` on the CI path. A default-on Paperclip whose container reads that secret as an essential container fails the rollout exactly the way the cloudflared connector did — which is why the readiness-gate pattern (`deploy.ts:380-427`, `deploy.yml:246-286`) exists.
- **`cdkEnvBag` is an allowlist.** A variable in `.env` but absent from `deploy.ts:1199-1319` never reaches the cdk child process. That boundary silently disarmed `CCE_PAPERCLIP_ENABLED` once already (M22).
- **ARM64 is non-negotiable and easy to lose.** The whole compute plane is `CpuArchitecture.ARM64`; the pinned Paperclip artifact is a multi-arch index, so a wrong-platform builder silently produces amd64 that crash-loops. Keep `cloud-build.ts:82`.
- **Diagram drift gate.** `infra/bin/app.ts` maps to `docs/diagrams/architecture-compute.md` and `compute-stack.ts` to three diagrams in `docs/diagrams.map`; an edit without a diagram update or a prepended `drift-gate:` verification note fails CI, and the checker diffs committed changes only.
---

## Part E — The Four Pillars phases

Added 2026-08-21 on author decision. **Netzar OS is pillar 4, the Agentic OS**, so pillars 1–3 are
product surface this integration must deliver rather than leave upstream. The scope expansion is
recorded as [§35 of the implementation plan](implementation-plan.md#35-addendum--the-four-pillars-scope-expansion);
these are the phases that implement it.

All three are judged against **A1** (fidelity to the real artifact), **A2** (client craft) and **A3**
(cross-surface cohesion), plus the pillar-specific criteria below.

---

### Phase 10 — Pillar 1: approvals, review gates and verification

**Goal:** "Declare intent. Agents work. You verify the output" becomes a real loop in Netzar, not a
binary accept/reject.

**Why this is the first pillar phase:** approvals are the single largest capability ADR 0009 designed
and never built, and Paperclip's implementation is complete. This is the clearest value-for-effort in
the whole integration.

**Creates:** `src/lib/paperclip/approvals.ts` (projection); approval verbs in
`src/lib/tools/paperclip-tools.ts`; an approvals surface on the Missions detail view; `format.ts`
entries so approvals render on every chat surface.

**Depends on:** Phases 2 and 7.

**Acceptance:**
1. **`request-revision` is implemented, not just approve/reject.** `POST /api/approvals/{id}/request-revision`
   and `/resubmit` are what make verification a loop. A phase that ships only approve/reject has missed
   the pillar and must be sent back.
2. Approval state renders on **all four chat code paths** (Telegram, Slack main, Slack per-agent,
   dashboard) through one shared pure formatter with its own unit test, per **A3-4**.
3. An approval decision is a **human** act by default. If an agent can approve, that is a separate,
   explicitly-flagged capability, not a side effect.
4. Approval comments are **untrusted input** — they reach a prompt only through the injection defense,
   not through `neutralizeForPrompt` alone.
5. Work products and documents (`GET`/`POST /api/issues/{id}/work-products`, the `documents/{key}`
   family with revisions and annotations) are surfaced read-only first. Document **locking**
   (`/lock`, `/unlock`) is not exposed until there is a concurrency story.
6. **Routines are explicitly OUT of this phase.** They collide with Netzar's own scheduler and need the
   decision in §35.2 first. Shipping both schedulers without that decision creates two sources of truth
   for recurring work.

---

### Phase 11 — Pillar 2: governance, scoped secrets and the client-facing chart

**Goal:** roles, permissions and boundaries are visible and enforced; the org chart is something a
prospect looks at and immediately understands.

**Note:** the chart *rendering* lands in Phase 8.5 and the operator console in Phase 4.5. This phase
completes the pillar — governance and secret scoping — and makes the chart client-facing.

**Creates:** `src/lib/paperclip/org.ts` governance projection; a client-facing org view.

**Depends on:** Phases 4.5 and 8.5.

**Acceptance:**
1. **The §16.6 reversal is recorded in the ADR, not just here.** The plan files the org chart as
   operator-only; the author wants it client-facing. Reversing a ratified position in a phase document
   alone is how positions get silently re-litigated later.
2. **An explicit deny-list of what must never reach a client view**: Paperclip company ids, issue
   identifiers and internal uuids, agent API keys, cost and budget figures, other tenants' anything.
   Enforced by a test that asserts the serialized payload against that list, not by review.
3. The chart is served **from Netzar's origin** — Paperclip ships no CORS, so a browser cannot fetch it
   directly. Proxy `org.svg` server-side.
4. `GET /api/companies/{cid}/org` is **characterized by probe before it is typed**. Its body is
   `additionalProperties: {}` — undocumented. This is the exact condition that made **A1-12** wrong.
5. Scoped secrets (`GET /api/agents/me/secrets`, `POST /api/agents/me/secrets/{key}/value`) are surfaced
   **only** as "which secrets exist for this agent" — never values, never through a chat surface, never
   in a tool result. A test asserts no secret value can leave the ACL.
6. Governance (`PATCH /api/agents/{id}/permissions`) does **not** become a second authorization plane
   over Netzar's own. Paperclip permissions govern what an agent may do **inside Paperclip**; Netzar's
   32-capability matrix continues to govern everything else, and the two are documented as disjoint.

---

### Phase 12 — Pillar 3: Agent Employee Training

**Goal:** design, train and evaluate AI employees — Skill Studio, shared skills, and evals with saved
test runs.

**The largest pillar (37 routes) and the one with no Netzar equivalent to extend.** It is new product
surface, not a projection of something existing, so it carries the most design risk and should ship in
the order below rather than all at once.

**Creates:** `src/lib/paperclip/skills.ts`; a Skills surface in the dashboard; skill verbs in
`paperclip-tools.ts`.

**Depends on:** Phase 10.

**Acceptance, in shipping order:**
1. **Read before write.** Ship the catalog and a skill's detail first (`GET /api/skills/catalog`,
   `/catalog/{catalogId}`, `GET /api/companies/{cid}/skills`, `.../skills/{skillId}`, `.../versions`).
   No authoring until reading is proven.
2. **Skill governance ships in the SAME phase as skill authoring, never after.** A skill is executable
   instruction text delivered into an agent's context: a careless or hostile one is prompt injection
   and capability escalation that Netzar's guardrails do not currently see. `GET`/`PUT` `skill-policy`
   and `POST /skill-policy/evaluate` are the control, and `POST .../skills/{skillId}/audit` is the
   record. Authoring without policy is a blocking rejection.
3. **Evals are the point, not a nice-to-have.** `test-inputs` + `skill-test-run-templates` + `test-runs`
   are what make "evaluate your AI employees" real. A phase that ships Skill Studio without saved test
   runs has shipped an editor, not training.
4. `POST /api/agents/{id}/skills/sync` is the binding step — a test proves an agent's skill set actually
   changes, rather than the UI merely claiming it did.
5. **"Performance reviews for agents" is NOT built until a probe locates a route for it.** No such route
   was found in the 475-path document. It may be a UI composition over test runs and activity. Treat it
   as unverified; do not design against a feature named only on a marketing page.
6. Skill bodies, comments and titles are untrusted input and go through the injection defense.
7. Fork/star/comment (`fork`, `fork-precheck`, `star`, `comments`) are **deliberately deferred** — they
   are collaboration polish and none of them is load-bearing for the pillar's promise.

---

### What is deliberately not built in any pillar phase

- **Routines**, until the two-scheduler decision in §35.2 is made.
- **Workspaces, pipelines, cases, plugins, sandbox providers** — Netzar owns execution; exposing these
  invites someone to start using Paperclip's execution plane, which the architecture exists to prevent.
- **Paperclip's Timeline/audit UI** — Netzar has its own audit surface with PII redaction and WORM at
  tier ≥ 2. Two audit surfaces over one dataset is worse than one.
- **Document locking**, until there is a concurrency story.
- **Performance reviews**, until a route is found.

---

## Part F — Reuse Paperclip, do not rebuild it

Added 2026-08-21 on author direction: *"you don't have to rebuild from scratch — use Paperclip and
convert what the local Paperclip code has, and have it run inside Netzar on AWS."*

Everything in this part was **verified by execution against the pinned artifact on 2026-08-21**, not
read from a document. Where a claim is unproven it says so.

### F.1 The finding that changes the plan: the UI already ships, built, and serves

Plan §16.6 rules "rebuild in Netzar" for the Issues board and treats `@paperclipai/ui` as unusable.
That ruling is **half right and half expensive.** It is right that the package cannot be imported —
`ui/package.json` declares `react ^19.2.7`, **no `exports`** and **no `files`**, so there are no
importable modules and Netzar is Preact. It is wrong that the UI must therefore be rebuilt.

**Proven, by running it:**

| Step | Evidence, 2026-08-21 |
|---|---|
| The pinned image ships the UI **source** | `/app/ui` — 29 MB |
| It also ships the **built bundle** | `/app/ui/dist` — 13 MB, with `index.html` |
| The server looks somewhere else | it resolves `"../ui-dist"`, i.e. `/app/server/ui-dist`, which **does not exist** in the image |
| One symlink bridges the gap | `ln -s /app/ui/dist /app/server/ui-dist` |
| With `SERVE_UI=true`, the real SPA serves | `GET /` → **200**, `text/html`, the genuine Paperclip document |
| Its assets serve too | `/assets/index-*.js` → **200**, **6,484,747 bytes** |

So the entire Paperclip UI — Issues, IssueDetail, Approvals, OrgChart, Skills, Timeline, Goals, and
every other page — is **one Dockerfile line away from running**, inside the customer's own AWS account,
on the container this plan already deploys. Rebuilding any of it in Preact is work that buys nothing
except vocabulary control.

**Runtime branding hooks exist.** `index.html` carries `PAPERCLIP_RUNTIME_BRANDING_START` /
`_END` markers, and the server reads `PAPERCLIP_LOGO_SVG` plus `PAPERCLIP_FAVICON_START` / `_END`.
**Caveat, and it is load-bearing:** §33 records that Paperclip's own documentation says
branding/white-labelling **should not be counted on**. The hooks are real and they work; they are not a
supported contract. Use them, pin the artifact, and re-verify on every re-pin — exactly the rule the
`updatedSince` patch already lives under.

### F.2 What this changes

1. **Pillar UIs are surfaced, not rebuilt.** Phases 10–12 change from "build an approvals surface / a
   skills surface in Preact" to "serve Paperclip's, same-origin, branded, behind Netzar's auth." The
   37-route Training pillar in particular stops being months of frontend work.
2. **`SERVE_UI` flips to `true`** on the deployed service, and `vendor/paperclip/Dockerfile` gains the
   symlink. Both are one-line changes with a rebuild.
3. **Same-origin proxying is mandatory, and it is also the CORS fix.** Paperclip ships **no CORS
   middleware**, so a browser cannot call it cross-origin. Serving it through Netzar's own origin at a
   path prefix removes the problem rather than working around it.
4. **§16.6 is amended, not discarded.** Its four *reasons* still hold — disjoint auth planes, a second
   authorization surface, vocabulary leakage, a wider attack surface. What changes is the conclusion:
   those are arguments for **controlling access to** Paperclip's UI, not for rewriting it.
5. **The auth bridge becomes the hard problem, and it is the real work of this approach.** Paperclip
   uses Better Auth **cookie sessions**; Netzar uses opaque bearer tokens and a 32-capability matrix.
   There is no SSO between them and Netzar's `revokeTokensForUser` does not reach Paperclip. Any design
   that shows Paperclip's UI to a Netzar user must mint and revoke a Paperclip session on that user's
   behalf, and **that is a blocking design decision before Phases 10–12 start.**

### F.3 Delegation and co-owned projects — what the artifact actually supports

Verified against the live 475-path document and by probe on 2026-08-21, then corrected by a pinned
live request probe on 2026-08-24. Per **A1-16**, routes are cited by method and path only.

**R1 — delegation works today, with zero Paperclip changes, in two calls an agent can make itself:**
`POST /api/issues/{id}/children` (carrying `assigneeAgentId`) then `POST /api/agents/{id}/wakeup`. Both
are `actor: board_or_agent`.

**Corrected request shape:** `POST /api/issues/{id}/children` accepts **one child object** and rejects
an array. A title-only object defaults to backlog, medium, unassigned and `requestDepth: 1`; an
explicit `assigneeAgentId` persists. Therefore the route itself provides no five-child/one-request
turn-budget win. `wakeup` takes an `idempotencyKey`, so that call is safe to retry. Phase 8's native
single-child verb uses the already idempotency-proven company issue-create route with `parentId`
instead: it preserves the same child relation without claiming replay safety the `/children` route
has not demonstrated.

**The trap in the surface — do not use `suggest_tasks` for autonomous delegation.**
`POST /api/issues/{id}/interactions` with kind `suggest_tasks` looks perfect: a whole task tree, per-task
`assigneeAgentId`, and `continuationPolicy: wake_assignee_on_accept`. But `/interactions/{id}/accept`,
`/reject` and `/respond` are **`actor: board`** — board-only. An agent that calls it **stalls until a
human clicks.** Reserve it for the deliberate human-in-the-loop path; use `/children` for autonomous
delegation.

**R2 — co-owned projects have no first-class model, and the plan must stop implying they do.**
`POST /api/companies/{cid}/projects` takes `leadAgentId` — a **single nullable uuid**, not an array.
Grep of the whole document for `participantAgentId`, `watcher`, `subscriber`, `follower`, `collaborat`
returns **zero** hits. The one membership-shaped route,
`PUT /api/companies/{cid}/resource-memberships/me/projects/{projectId}`, is **board-only** and is a human
starring a project in their own sidebar — an agent bearer token cannot call it at all.

Two further constraints force the shape:
- `executionPolicy.stages[].participants[]` is the only structured multi-agent-on-one-issue concept, and
  it means **reviewers**, not collaborators. `approvalsNeeded` has an enum of literally **`[1]`**.
- `POST /api/issues/{id}/checkout` is an **exclusive compare-and-swap lock** (`{agentId, expectedStatuses}`),
  released by `/release`, and `assigneeAgentId` is singular.

**Therefore co-ownership is one parent issue + N assigned sibling children + `blockedByIssueIds` for
ordering — a Netzar-side convention over Paperclip primitives.** Any design that puts several agents on
one issue will fight the checkout lock. Nothing in Paperclip will persist or enforce "co-owned"; if the
product needs that concept it is Netzar's to model.

### F.4 The best answer to the client-facing ask was not the org chart

`GET /api/companies/{cid}/timeline` is **the only fully-typed response schema in this entire area** —
every other one is `additionalProperties: {}`. It is `actor: board_or_agent` and filterable by
`projectId`, `goalId`, `issueId` and a time window.

It returns `actors[]`, `spans[]`, `events[]` with `kind: created|commented|approved|delegated|assigned`,
and — the important part — **`edges[]` with `kind: delegation|assignment|mention`**, each carrying
`fromActorId`, `toActorId`, `issueId` and `at`.

That is an **observed** collaboration graph: who actually delegated to whom, on what, and when.

The org chart, by contrast, is built on `reportsTo` — a **static, hand-set** uuid appearing in only three
routes. It shows the *declared* hierarchy. It is worth showing, but it does not by itself demonstrate
agents working together, because nothing keeps it honest.

**Recommendation:** show a prospect **both**, and lead with the timeline. The chart says how the
organization is *meant* to work; the timeline proves how it *did*. Scoped by `projectId` it becomes a
per-project "how these agents worked together" view, which is much closer to the stated goal — and it is
self-maintaining, where the chart rots the moment someone forgets to set `reportsTo`.

Because it is the one typed schema here, it is also the only part of this surface a client can be written
against without probing first.
