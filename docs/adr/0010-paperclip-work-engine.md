# ADR 0010 — Paperclip is the missions work engine

**Status:** Accepted (2026-08-18, Paperclip integration plan §34; amended 2026-08-18, see "Amendment" below)

## Context

Missions v2 ([ADR 0009](0009-mission-container-model.md)) built the durable
work container inside Netzar's own DynamoDB. The Paperclip integration plan
replaces that storage and execution layer: **Paperclip becomes the system of
record for work items**, run self-hosted on Netzar's AWS as an unmodified
pinned artifact, while Netzar keeps agent execution, identity, authorization,
cost controls, guardrails, memory, scheduling, chat surfaces, and the existing
four `/api/missions*` wire contracts.

This ADR ratifies the plan's decision log. Per the plan's Phase 0 instruction,
DL-1 … DL-9 are lifted **verbatim** below — not paraphrased — so the decisions
cannot drift in translation. Cross-references of the form `§N`, `R-N`, and
`Stage N` refer to sections of that implementation plan.

## Hard constraints

These three are prohibitions, not preferences. Re-litigating them requires
superseding this ADR.

1. **No plugin-based event delivery.** Paperclip's plugin bus is a trap for
   this integration: it is `new Map()`, delivery is at-most-once, events are
   dropped silently whenever the worker is not `running`, and the spec wrongly
   documents at-least-once (R2). Low-latency notification rides Paperclip's
   HTTP adapter push; durability comes from the polling reconciler (DL-3).
   Never a plugin.
2. **Never synthesize Paperclip run ids.** `issues.checkout_run_id` is a real
   foreign key to `heartbeat_runs.id`, and the route guard only checks the
   header is non-empty — a fabricated UUID fails at write with SQLSTATE
   `23503`, not a clean 4xx (R3, proven live by test FI-4). Run ids come only
   from Paperclip-minted runs; degraded mode operates run-less and self-wakes.
3. **`desiredCount: 1`.** Paperclip runs as exactly one Fargate task (DL-8).
   Scaling it out is not a tuning knob; it is a design change that needs a new
   ADR.

## Amendment (2026-08-18) — the pinned artifact carries one committed patch

DL-9 (no fork, no embedded packages) stands, with one narrowly-scoped,
user-approved exception recorded here. First-milestone contract testing (test
I3) proved that pinned release `v2026.722.0` — and upstream `master` at the
time — does not implement the `updatedSince` predicate that DL-3's durable
poll requires; the server ignores the parameter and returns the full issue
list. Every viable path changed a plan decision, and the user chose to patch
our self-hosted copy.

The deployed Paperclip artifact is therefore the pinned immutable digest
**plus** [`vendor/paperclip/updated-since.patch`](../../vendor/paperclip/updated-since.patch)
(37 lines: route parsing/validation and an indexed millisecond-resolution
strict-greater-than filter served by the pre-existing
`issues_company_updated_idx`), applied at image build time by
[`vendor/paperclip/Dockerfile`](../../vendor/paperclip/Dockerfile). No schema
change, no other source change, no `:latest`.

#### Amendment to the amendment (2026-08-21) — the filter is LOSSY, and a caller must overlap

**The predicate this amendment ratified above is a correctness hazard, and this
paragraph supersedes it.** "An indexed millisecond-resolution strict-greater-than
filter" is compiled as `updated_at >= watermark + 1ms`. That `+1ms` exists for a
real reason — `updated_at` stores MICROSECONDS while every API caller only ever
observes the millisecond-truncated value, so a plain `>` would re-return a row at
its own watermark forever. But the same truncation makes the predicate lossy in
the other direction, and the patch's own comment is silent about it: **any row
whose true timestamp falls in `[T, T+1ms)` and was not already in the page that
produced `T` is lost permanently.** Concurrent writes land in the same millisecond
routinely, so this is an everyday case, not a corner.

**A caller must therefore never pass its last-seen stamp back.** The poll contract
is: query `updatedSince = (max updatedAt actually PROCESSED) - poll_overlap_ms`,
and deduplicate client-side on the pair `(id, updatedAt)`, comparing `updatedAt`
as the raw string the server sent. `poll_overlap_ms` seeds to `2000`
(`scripts/lib/seed-defaults.ts`); the implementation is
[`src/lib/paperclip/watermark.ts`](../../src/lib/paperclip/watermark.ts) and
[`src/lib/paperclip/reconciler.ts`](../../src/lib/paperclip/reconciler.ts).

**Evidence.** The probe *"C-2 (BLOCKING): a truncated watermark loses rows, and
overlap-and-dedupe delivers them exactly once"* re-polls a row at its own observed
`updatedAt` and asserts the row is ABSENT; reproduces a same-millisecond collision
between two writes and asserts that a naive watermark set to the shared stamp
returns NEITHER sibling; then runs two overlapping polls the way the reconciler
does and asserts that dedupe on `` `${id}@${updatedAt}` `` yields every row it
wrote exactly once, with at least one row genuinely arriving twice.

**Corollary (A8), and an honest limit on it.** Paperclip stamps `updated_at` from
two clocks — the database's `now()` on insert, Node's `new Date()` on update — so a
watermark is never exact and no caller may treat it as an equality. The overlap is
load-bearing, not defensive. **But no probe measures the SIZE of that skew, so
nothing establishes that `poll_overlap_ms` bounds it — UNVERIFIED.** What the
overlap is proven to fix is the C-2/M30 truncation hazard, a fixed 1 ms window;
reading it as skew insurance is a hope, not a measurement. A row stamped by the
slower clock below a cursor the faster clock already moved past is not recovered by
this arithmetic. Bounding it needs a probe that inserts and updates under load and
records the observed disagreement, and that probe does not exist. `poll_overlap_ms`
is runtime-config precisely so an operator can raise it without a deploy when one
does.

**Second, independent loss channel: PAGING MUST BE KEYSET, NOT OFFSET.** The sort
key is the filter column and `updated_at` only ever moves forward, so under
`sortDir=asc` any write that re-stamps a row already read moves it to the tail and
shifts every row behind it DOWN one index. With a fixed `updatedSince` window and a
walking `offset`, the row at the next page's first offset slides into the prefix
already read and is never returned — while the re-stamped row IS returned, at
wall-clock now, dragging the high-water mark past its own victim and putting it
permanently below the next poll's `max - overlap` floor. The shift direction is
always skip, never duplicate. This is ordinary behaviour on an active board, not an
unlucky interleaving, and it is independent of C-2: fixing the predicate does not
touch it.

The poll therefore re-anchors every page on a VALUE: page *N+1* queries
`updatedSince = (max updatedAt of page N) - 1ms` with `offset = 0`. A page returns
the smallest `limit` rows at or above its floor, so every row it did NOT return is
at or above that page's max — re-anchoring there can skip nothing, whatever moved
meanwhile, and a re-stamped row simply reappears later in the same sweep as a new
`(id, updatedAt)` pair. `- 1ms` makes the next window inclusive of the max and the
rows sharing its millisecond, which costs one re-read boundary row per page.
`offset` survives only as the fallback for the one case a value anchor cannot
advance — a whole page inside a single millisecond — and inside such a tie group
the skip is LIVE AGAIN, because the walk there is positional.

**Correction (round 3): capping the advance at the sweep's START instant does NOT
close that residual, and an earlier draft of this paragraph said it did.** The next
poll's floor is `watermarkTo - poll_overlap_ms`, and `watermarkTo` is only bounded
*above* by the sweep's start instant — it can sit far above a row skipped inside a
tie group while still below that instant. Worked counterexample: a two-row tie at
`11:59:50.000Z` and a third row at `11:59:56.000Z`, one tie member re-stamped
mid-walk. The second member is never served, the cursor advances to
`11:59:56.000Z`, the next floor becomes `11:59:54.000Z`, and the skipped row is
permanently beneath it. The start-instant cap remains, but for its own narrower
reason: the sweep read the board as of the instant it began, so a cursor past that
instant would claim coverage of a window the sweep never queried.

What actually closes the residual is a SECOND cap, at the tie millisecond itself.
When the fallback fires, every row on that page sits at one stamp `S` (the patch
serves `>= since + 1ms` and the fallback condition is `pageMax - 1 <= since`), and
the positional walk that follows is anchored at `S - 1ms`, so every row it can drop
carries a stamp at or above `S`. Holding the cursor at or below `S` leaves the next
poll's floor at `S - poll_overlap_ms`, below all of them, and the row is re-read
rather than lost. The cap is applied only when some id was observed at two
different `updatedAt` values during the sweep, which is a NECESSARY condition for
the skip: a shift drops a row only if the row that moved to the tail had already
been read, and such a row is necessarily read again at its new stamp because
`updated_at` only moves forward and the sweep pages to exhaustion. A sweep over a
quiet board therefore advances exactly as it would without the cap. Because this
bound holds at any page size, `poll_page_limit` needs no floor.

A cold start is `now - poll_overlap_ms`, never epoch: this artifact has no totals
endpoint (`GET .../issues/count` answers `400 "issues/count currently requires
attention=blocked"`), so an epoch start is an unbounded page walk on the first
tick of every fresh deploy.

The patch's own doc comment on `IssueFilters.updatedSince` is amended in the same
change to state the consequence alongside the mechanism, so the two cannot
disagree.

**Re-pin rule:** on every future artifact bump, first check whether upstream
has implemented `updatedSince`; the patch is dropped in the same change the
moment a release carries it natively.

## Relationship to ADR 0009

This ADR supersedes the *storage and execution model* of ADR 0009: the
Mission/MissionTask/MissionEvent row design in `claudeclaw-mission-tasks` stops
being the system of record when the ACL cutover completes. ADR 0009's wire
contract (`/api/missions*`), capability model (`missions:read`,
`agents:write`), and coordinator/approval roles are unchanged and remain
authoritative. ADR 0009 keeps status Accepted until the plan's retirement
stage completes; it carries a superseding note pointing here.

## Decision log (DL-1 … DL-9, lifted verbatim from the implementation plan §34)

### DL-1 — Paperclip is the system of record for work items (service vs. embedded, part 1)

**Decision.** Paperclip's `issues` table replaces Netzar's `Mission` as the durable work container.
Netzar's Missions surface becomes a projection.

**Evidence.** `NETZAR: src/lib/state/mission-tasks-repo.ts` is 229 lines of flat CRUD: 11 fields,
4 statuses, no sub-tasks, no dependencies, no execution engine, no automatic writer, no seeder, no
tests. `NETZAR: docs/adr/0009-mission-container-model.md` is Accepted-but-unstarted with a 28-item
backlog at 0 done, and `docs/features/missions/HANDOFF.md:14-16` confirms it. Paperclip already ships
nearly all of ADR-0009's target: sub-items (`issues.parent_id` self-FK, `WITH RECURSIVE` at
`PAPERCLIP: server/src/services/issues.ts:5505-5520`), dependencies (`issue_relations` with a real DB
CHECK at `packages/db/src/migrations/0049_flawless_abomination.sql:13`), approval gates
(`approvals` + `issue_approvals` + `review_policy`), artifacts (`issue_work_products`), and a per-item
audit trail (`activity_log`).

**Alternatives considered.** (a) Build ADR-0009 in Netzar — the M1-M6 backlog: 28 recorded items, 24 active, 20 of them approved and unstarted.
(b) Keep Missions as-is and integrate Paperclip only for new "projects" — two work models, permanently.
(c) Use Paperclip only as a viewer over Netzar data — impossible without a shared datastore.

**Why chosen.** Buying ADR-0009's target instead of building it is the entire point of the exercise.
Alternative (a) is months of work reproducing something that already exists in production-grade form;
(b) guarantees a permanent two-model split; (c) collapses into the rejected shared-database option.

**Trade-offs.** A new external dependency and a new datastore enter the deployment. Netzar's operational
surface grows by one service, one database, one filesystem. The Missions board becomes dependent on a
service that is pinned to a single task (DL-8).

**Reversibility.** **Moderate.** The wire contract is preserved (DL-4), so reverting means restoring the
four handler bodies and re-pointing them at the untouched DynamoDB table. Work created in Paperclip
during the period would need exporting. Reversibility decays with time-in-production, which is why
Stage 7 (retiring `mission-tasks-repo.ts`) is deliberately last and gated on two clean weeks.

---

### DL-2 — Service boundary, not shared database (data ownership)

**Decision.** Netzar never touches Paperclip's Postgres. Every read and write crosses an authenticated
HTTP boundary.

**Evidence.** `grep -ril "row level security" packages/db/src/migrations` → 0 files;
`grep -ril "create policy" …` → 0 files, across all **221** migrations. The tenant boundary is
application code only: `PAPERCLIP: server/src/routes/authz.ts` (`assertCompanyAccess:75`,
`hasCompanyAccess:157`, `getAccessibleResource:182`). The service layer is not tenant-safe on its own:
`issueService.getById` resolves by uuid or identifier with **no** company predicate
(`services/issues.ts:5934-5944`), `update` re-reads `where(eq(issues.id, id))` only (`:7549-7553`),
`remove` deletes `where(eq(issues.id, id))` only (`:8006-8010`). The business rules live above the data:
`assertTransition` (`:184-189`) validates only the destination status and **discards `from`**, and there
is **no CHECK constraint on `issues.status`** — in a schema that *does* CHECK `cases.status`,
`pipeline_stages.kind`, `pipeline_cases.terminal_kind` and `issue_relations.type`. Writing rows directly
bypasses `assertAgentIssueMutationAllowed`, `decideIssueAccess`, `assertNoBlockingCycles`
(`:5007-5042`), the one-assignee rule (`:7592-7594`), in_progress-requires-assignee (`:7595-7597`),
in_progress-requires-no-unresolved-blockers (`:7598-7618`), the self-correcting identifier-minting
transaction (`:7161-7179`), the partial unique dedupe indexes, and every `activity_log` write.

**Alternatives considered.** (a) Shared database (Option D) — Netzar reads/writes Paperclip's Postgres
directly. (b) Shared domain layer — import `@paperclipai/db` and call the services in-process.
(c) A read-only replica for Netzar queries.

**Why chosen.** (a) converts an application-enforced tenant boundary into **no** boundary and silently
discards ~1,500 lines of transition policy — it is the option that looks cheapest and is worst.
(b) is DL-9's territory: `@paperclipai/db` bundles a patched native Postgres and Netzar has zero
Postgres at all three layers (declared deps, application source, CDK infra). (c) still requires a
Postgres client Netzar does not have, and read-only access to a schema with no RLS is still a schema
coupling to a project shipping ~1 stable/week.

**Trade-offs.** Every write pays HTTP latency and can fail independently. The ACL must translate
Paperclip's error envelopes into Netzar's. In exchange, **every guard runs** and the schema stays
upstream's problem.

**Reversibility.** **High** for the boundary itself — it is a client module. Effectively **irreversible
in the other direction**: once you have taken the shared-DB shortcut you cannot un-write the rows that
bypassed the guards.

---

### DL-3 — Poll for durability, push for latency (event transport)

**Decision.** `GET /api/companies/{cid}/issues?updatedSince=…&sortField=updated&sortDir=asc&limit=500`
is the source of truth. The `http` adapter push is a latency hint and a run-id carrier, never delivery.
The value passed as `updatedSince` is `(max updatedAt actually processed) - poll_overlap_ms`, NOT the
last-seen watermark, and the caller deduplicates on `(id, updatedAt)` — see the 2026-08-21 amendment
above, which supersedes `>= watermark + 1ms`. Paging is KEYSET — each page re-anchors `updatedSince` on
the previous page's max rather than walking an `offset` over a fixed window, because offset paging over
a mutable set sorted on its own filter column silently SKIPS rows (see the amendment). The sweep pages
SERIALLY and never fans out over offsets:
`A1-10` shape (b) is a per-actor in-flight coalescer where identical concurrent reads coalesce safely
and DISTINCT ones are refused with `429 "Too many concurrent issue-list requests for this
actor/client"`.

**Evidence — the negative half.** No outbound webhooks: the only webhook table is
`plugin_webhook_deliveries` (`PAPERCLIP: packages/db/src/schema/plugin_webhooks.ts`), whose header says
*inbound* and which has no `target_url`, `attempt_count`, `next_retry_at`, or outgoing signature column;
the only webhook capability is `webhooks.receive` (`packages/shared/src/constants.ts:1392`), there is no
`webhooks.send`. No outbox: no `*_outbox`, `*_event_deliveries`, `*_subscriptions` or `webhook_endpoints`
table exists. The bus is RAM: `server/src/services/plugin-event-bus.ts:151` is `new Map()`, and
`publishPluginDomainEvent` is `void bus.emit(...).catch(() => {})`. Delivery is at-most-once and drops
silently: `server/src/services/plugin-worker-manager.ts:2066-2067` opens with
`if (status !== "running") return;` and the ack type is `void`
(`packages/plugins/sdk/src/protocol.ts:1104`) — while `doc/plugins/PLUGIN_SPEC.md:576-582` claims
"at least once". Even the affirmative half is constrained: `ctx.http.fetch` blocks private IP ranges
(`plugin-host-services.ts:196-200`).

**Evidence — the positive half.** *Replaced 2026-08-21. The paragraph this supersedes claimed
`updatedSince` lands as `gt(issues.updatedAt, since)` upstream at the pinned release. That is wrong
twice over: the Amendment above records that upstream IGNORES the parameter entirely — the whole reason
a patch exists — and the claim was carried by Paperclip source line numbers, which A1-16 does not accept
as authority. Method, path, observed behaviour and the probe that proves it, instead:*

`GET /api/companies/{cid}/issues?updatedSince=<ISO one hour in the future>&limit=1` answers `200 []`
against a board the same probe first asserts is NON-EMPTY, and `?updatedSince=<ISO with no UTC offset>`
answers `400` with an `error` string naming `updatedSince` — probe *"A1-8 (BLOCKING): updatedSince one
hour in the future returns an empty list"*. Those two signals together are the only thing that
distinguishes a patched image from an unpatched one, because an unpatched image answers the first with
`200` and the FULL UNFILTERED LIST and the second with `200` as well. The filter is strict at
millisecond resolution and lossy in `[T, T+1ms)` — probe *"C-2 (BLOCKING): a truncated watermark loses
rows, and overlap-and-dedupe delivers them exactly once"*. Ordering is caller-controlled by name
(`sortField=updated` is the only accepted value; anything else is a `400`), but **no probe asserts the
ORDER of two returned rows**, so a sweep computes its high-water mark as `max()` over rows processed
rather than reading the last row of the last page.

**Consequence for any poller (BLOCKING).** Because an unimplemented query parameter is silently ignored
rather than rejected, a reconciler cannot tell a filtered poll from an unfiltered one by its result.
`src/lib/paperclip/reconciler.ts` therefore runs both signals above as a BOOT PROBE before its first
sweep and REFUSES TO SWEEP — permanently, loudly, for the life of the process — if either fails.

**The push payload — UNVERIFIED.** The `http` adapter push carries
`{...payloadTemplate, agentId, runId, context}`, where `context.issueId` comes from the issue-assignment
wakeup's context snapshot. *The two Paperclip source-line citations that carried these claims were
removed on 2026-08-21 under A1-16: no probe drives an outbound push, so this shape is a source reading
and not a measurement. It is recorded because DL-3 depends on the push being a run-id carrier, and it is
marked because nothing proves it.*

**Alternatives considered.** (a) Classical event-driven integration (Option F) — webhooks or an outbox.
(b) A Paperclip plugin publishing to SQS. (c) The company live-events WebSocket as the primary feed.
(d) The cursor-paginated activity feed as the primary feed.

**Why chosen.** (a) does not exist and building it means forking (DL-9). (b) is R2 — the bus drops
events and cannot reach a private IP anyway. (c) `LiveEvent.id` is a **process-local counter starting at
0** (`server/src/services/live-events.ts:10`) that resets on restart with no Last-Event-ID replay — it
is a doorbell, not a ledger. (d) an agent key gets an unfiltered, **attribution-stripped**
(`routes/activity.ts:152-168` nulls `agentId`, `runId`, `responsibleUserId` and `details`) tail with all
filters forbidden (`:139-149`) — enough for recovery, not enough to be primary.

**Trade-offs.** A Netzar-side reconciler is **mandatory** — it is not an optimization, and the POC's
push-only mode is explicitly not shippable. End-to-end latency degrades to the poll interval whenever a
push is lost. The reconciler needs a broad standard-scope key (R11) because `task_bridge` keys are
403'd on the exact route it requires (`routes/issues.ts:5706-5710`).

**Reversibility.** **High.** If Paperclip ever ships durable outbound webhooks, the reconciler becomes
a backstop and its interval lengthens. The projection, the ACL and the client are unaffected.

---

### DL-4 — Netzar keeps its `/api/missions*` wire contract (routing ownership, part 1)

**Decision.** The four mission routes keep their paths, request bodies, response envelopes and
capability gates. Their handler bodies are re-implemented over Paperclip. Changes are **additive only**.

**Evidence.** The ACL surface is a 7-call-site swap: four routes in
`NETZAR: src/adapters/dashboard/handler.ts` (`GET /missions` :3096, `POST /missions` :3110,
`POST /missions/:owner/:id/status` :3171, `POST /missions/:owner/:id/reassign` :3203); three agent tools
in `src/lib/tools/mission-tools.ts` (`create_mission` :108, `list_missions` :202, `update_mission` :258);
two read-only consumers, `src/adapters/dashboard/jarvis.ts:1258` and `src/lib/tools/privacy-tools.ts:87`.
The 411-line Preact kanban at `web/src/pages/Missions.tsx` speaks exactly those four routes.
`missions:read` is viewer-tier (`src/lib/auth/permissions.ts:100`) and mission mutation is `agents:write`
(operator-tier, `:58`).

**Alternatives considered.** (a) Expose Paperclip's REST API directly to the SPA. (b) Design a new
Netzar mission API shaped like Paperclip's. (c) Proxy `/api/paperclip/*` through Netzar with no
translation.

**Why chosen.** (a) would leak Paperclip's vocabulary, its uuids and its 7-status enum into the product
UI, and would require exposing Paperclip through the public ALB with its own auth — a far larger attack
surface. (b) turns a 7-call-site swap into a UI rewrite plus a capability-matrix change plus a Jarvis
route-manifest change. (c) is (a) with extra steps and still leaks the vocabulary.

**Trade-offs.** The status projection is lossy in one direction — `in_review` and `blocked` both collapse
to `open` — and priority does not round-trip (0-100 ↔ 4 bands). Both are pinned by table tests (S6-S8,
P4) and both are resolved by the Stage 6 UI work rather than by contract change.

**Reversibility.** **Very high.** The contract is the abstraction; swapping the implementation back is a
handler-body revert behind the `PAPERCLIP_ENABLED` flag.

---

### DL-5 — One Netzar deployment = one Paperclip company (identity mapping, part 1)

**Decision.** Each Netzar deployment maps to exactly one Paperclip `companies` row. Staging gets its own
**Paperclip instance**, not a second company inside one instance.

**Evidence.** Netzar has no Organization / Workspace / Team / Company / Tenant entity:
`grep -rn "orgId\|organizationId\|tenantId\|workspaceId\|teamId\|companyId" --include=*.ts src/` returns
**zero** matches; `UserProfile` has no team field (`NETZAR: src/lib/state/users-repo.ts:72-88`); `Seat`
binds one user to one policy (`src/lib/admin/seat-model.ts`); **ADR 0002 (Accepted)** makes the AWS
deployment the tenant boundary; **ADR 0009** explicitly rejects a mission `scopeId` "because Netzer has
no grouping concept to map it onto". On the Paperclip side `issues.company_id` is NOT NULL,
`companies.issue_prefix` is globally unique, and `issues.identifier` is globally unique.

**Alternatives considered.** (a) One company per Netzar agent. (b) One company per seat/user.
(c) Multiple companies in one Paperclip instance for staging/prod separation.

**Why chosen.** (a) and (b) invent a Netzar concept that ADR 0002 and ADR 0009 have already declined to
invent, and they would fragment cross-agent visibility — which is one of the things being bought.
(c) makes Paperclip's application-only tenant isolation load-bearing across a prod/staging boundary,
which is precisely the property DL-2 refuses to rely on; Paperclip's own cloud multi-tenancy is
per-tenant managed stacks anyway (`PAPERCLIP: server/src/services/cloud-instance.ts`).

**Trade-offs.** With one company, Paperclip's zero-RLS posture is never load-bearing — **but that is a
property of the deployment, not of the code**. The day a second company is created, `authz.ts` is the
only thing standing between them. Test T6 exists to notice that day. Staging costs a second Aurora +
EFS + task.

**Reversibility.** **Low-ish.** Splitting one company into several later means re-parenting issues, and
`companies.issue_prefix` / `issues.identifier` are globally unique — identifiers cannot be reused.
Get the prefix (`NZR`) right at creation.

---

### DL-6 — Routing is hybrid: Netzar proposes, Paperclip records and arbitrates (agent + routing ownership)

**Decision.** Netzar's coordinator (`main`) proposes the assignee at create time; Paperclip holds the
`assignee_agent_id` column and therefore arbitrates; a human in Paperclip's board can override and that
override wins; escalation on failure is delegated to Paperclip's recovery ladder.

**Evidence.** **Paperclip cannot route.** Assignment is an explicit column. `agents.capabilities` is
free text and search-only (`PAPERCLIP: packages/db/src/schema/agents.ts:25`) — nothing consumes it as a
routing input. The single piece of computed routing in the entire codebase is the recovery **org-chart
manager ladder** (`server/src/services/recovery/service.ts:2527/2580`: assignee.reportsTo →
creator.reportsTo → role `cto` → role `ceo`), which is escalation, not dispatch. **Netzar's routing is
weak but real:** `src/agent/picker.ts` is 63 lines of regex (slash command → @mention → sticky →
`'main'`), but `src/lib/tools/mission-tools.ts` already runs a Haiku 4.5 `autoAssign()` (`:54`) that
picks an owner from agent system-prompt briefs and re-validates against `listKnownAgents()`
(`:58`; allow-list check in `parseAssignResponse`, `:85-106`, at `:98`) — and `handler.ts:3145-3156` calls it from the route with a `'main'` fallback on failure.
ADR 0009 makes coordinator = the `main` agent explicit.

**Alternatives considered.** (a) `paperclip-chooses` — build a capability router in Paperclip.
(b) `netzar-chooses` — Netzar assigns and Paperclip's board is a read-only mirror.

**Why chosen.** (a) there is no code to do it; you would be building a router inside a repo you have
decided not to fork (DL-9). (b) discards the human reassignment affordance, the assignability guard
(`assertAssignableAgent`, `services/issues.ts:7622`) and the recovery ladder — i.e. most of what
Paperclip is being adopted *for*.

**Trade-offs.** Reassignment is last-write-wins across two systems, resolved by the reconciler on the
next sweep. Escalation semantics are now Paperclip's, which means `agents.reports_to` must be populated
and one agent must hold role `ceo` — join-request approval refuses outright if the company has no active
CEO (`PAPERCLIP: server/src/routes/access.ts:4226-4231`). This is a real provisioning obligation, not a
cosmetic one.

**Reversibility.** **High.** Both halves are independently switchable: stop sending `assigneeAgentId` at
create to get (a); stop honouring board reassignment to get (b).

---

### DL-7 — No mission data migration (data ownership, part 2)

**Decision.** `claudeclaw-mission-tasks` is left untouched. New missions are written to Paperclip only.
An optional idempotent one-shot import runs **only** if a live row count says otherwise.

**Evidence.** The repo's own **Accepted** ADR says so: `NETZAR: docs/adr/0009-mission-container-model.md`
line 123 heading "### No `scopeId`, no migration", lines 133-134 ("Legacy flat mission rows are **not
migrated**"), lines 144-149 ("No migration means the riskiest task in the plan disappears… Rollback is
trivial"). The superseded migration plan is marked *"Current disposition — superseded and retired"* at
`docs/missions-v2-audit.md:720-746`. Corroborating: exactly 5 write call sites, all human- or
LLM-triggered on demand; **no** scheduler, queue-drain, cron, ingest, seeder or migration ever writes a
mission; `src/agent/agent-loop.ts` (the per-turn hot path) imports `inter-agent-tasks-repo` and
`hive-mind-repo` but **not** `mission-tasks-repo`; `scripts/demo/seed-fleet-activity.ts` deliberately
omits missions; `scripts/migrations/index.ts:32` is `MIGRATIONS = []`; and `scripts/mission.ts` is
broken in 2 of 3 commands (`list` sends `?agent=` where the route reads `owner`; `show` calls a
nonexistent detail route expecting a `tasks[]` concept that has never existed) — **the CLI was written
against an imaginary schema and nobody noticed**, which is not the fingerprint of a system carrying
production traffic.

**Alternatives considered.** (a) Full migration of every row into Paperclip. (b) Dual-write with
eventual cutover. (c) Lazy migration on first read.

**Why chosen.** (a) is the riskiest task in any integration and buys nothing if the table is empty.
(b) creates the two-shapes-coexisting bug class ADR 0009 explicitly wanted to avoid — and is retained
only as a *shadow probe* in Stage 4, whose Paperclip rows are disposable. (c) permanently couples the
new code to the legacy shape.

**Trade-offs.** If Q1's row count is non-trivial, the legacy rows become invisible to the new UI. The
import script (`idempotencyKey = "netzar-mission:<id>"`, replays return `200` + `deduplicated: true`,
serialized on `pg_advisory_xact_lock`) is the answer, and is re-runnable by construction.

**Reversibility.** **Total.** Nothing is rewritten. The rows stay readable and never expire (the table
declares `timeToLiveAttribute: 'ttl'` but `createMission` never writes `ttl`).

---

### DL-8 — Paperclip is pinned to a single Fargate task (deployment ownership)

**Decision.** Paperclip gets its own ECS service with `desiredCount: 1`, **no** autoscaling, and
`minHealthyPercent: 0 / maxHealthyPercent: 100`.

**Evidence.** `PAPERCLIP: server/src/services/workspace-runtime.ts` keeps node-local state: `spawn(...)`
at `:829` and `:5535-5540`; git worktrees on local disk at `:3038, :3180, :3409, :3733`; an in-process
port registry at `:5528-5529`; and a **process-local** worktree cleanup lock at `:3545`. Netzar's own
service autoscales 2→N (`NETZAR: infra/lib/compute-stack.ts:1192-1206`) and uses 100/200 healthy
percentages for zero-downtime rolls (`:1184-1185`) — the exact inverse of what Paperclip needs, so that
the old task releases its worktrees and port reservations before the new one claims them.

**Alternatives considered.** (a) Run Paperclip in Netzar's existing service as a sidecar.
(b) `desiredCount: 2+` with EFS shared across tasks. (c) Blue/green with 100/200.

**Why chosen.** (a) inherits Netzar's autoscaling policy — the failure this decision exists to prevent.
(b) even with shared EFS, two tasks collide on the same worktree paths and the in-process lock does not
coordinate them. (c) two tasks briefly coexist, which is exactly (b).

**Trade-offs.** Paperclip is a **single point of failure** with a rolling-restart gap (R18). The
reconciler's retry semantics must tolerate roughly a minute of 5xx, and the ACL must degrade the board
rather than empty it. Deploys should be scheduled outside business hours until an HA story exists.

**Reversibility.** **Conditional on Q4.** `execution_workspace_runtime_leases` exists in the schema and
*might* be cross-node safe; reading it end-to-end is the only thing that would relax the pin. Until
then, treat `desiredCount: 1` as a hard constraint documented in the CDK, not a default.

---

### DL-9 — No fork, no embedded packages (fork vs. upstream dependency; UI ownership)

**Decision.** Consume Paperclip as a published container image, pinned by CalVer tag. Do not fork, do
not vendor, do not import `@paperclipai/*` into Netzar's build. Netzar owns all product UI;
`SERVE_UI=false` initially.

**Evidence — velocity.** 19 CalVer stables between Mar 18 and Jul 22 (≈1/week, median gap ~7 days,
minimum 1 day); canary on every merge to `master`; one release carried "44 commits from 13
contributors"; PR numbers advanced from #9982 to #11588 in roughly four weeks (~1,600 PRs/month). Stables
carry an explicit "Upgrade Guide" section and have shipped documented breaking changes.
**Evidence — surface.** `server/` is ~527k LOC across 60 route modules; `packages/db` carries 221
sequential migrations gated by both `check-migration-numbering.ts` and a static SQL analyzer
`check-migration-safety.ts` that run on typecheck and build; the two files you would immediately want to
touch are `server/src/services/issues.ts` (**9,152 lines**) and `server/src/routes/issues.ts`
(**12,670 lines**, of which `PATCH /issues/:id` alone is ~1,500).
**Evidence — embedding.** `@paperclipai/db`'s `createDb` is Postgres-only with no dialect abstraction
(`packages/db/src/client.ts:111-115`) and the package physically bundles a patched native Postgres
(`packages/db/package.json:37-39` `bundleDependencies: ["embedded-postgres"]`). In-repo `exports` point
at raw `.ts` and are swapped to `dist` only by `publishConfig` at publish time, so a submodule / `file:`
/ vendored copy breaks Netzar's plain `tsc -p tsconfig.build.json` with `rootDir: src`. `@paperclipai/
shared`'s `.` barrel is **2,514 lines** of Paperclip's whole ontology. Netzar has zero Postgres at all
three layers. Licensing is **not** the constraint: MIT across all 33 manifests with no CLA and no DCO —
a fork is legally trivial, which is exactly why the cost must be argued on engineering grounds.

**Alternatives considered.** (a) Fork into Netzar's monorepo (Option C). (b) Embed `@paperclipai/db` +
`@paperclipai/shared` as libraries (Option B). (c) Track the `latest` Docker tag. (d) Serve Paperclip's
own SPA as the Missions UI.

**Why chosen.** (a) you would pay the integration tax *and* the maintenance tax forever, and every merge
conflicts in the two largest files. (b) `packages/db` is a datastore migration wearing a dependency's
clothes. (c) at ~1 stable/week with documented breaking changes, `latest` is an outage generator.
(d) leaks Paperclip's vocabulary and branding into the product and adds an attack surface; Paperclip's
own docs are explicit that branding/white-labelling should not be counted on.

**Trade-offs.** The API client is **hand-written** — there is no published SDK and no committed OpenAPI
spec file (only an in-process `GET /api/openapi.json` at `server/src/routes/openapi.ts:7713`). Every
assumption must be contract-tested (§28.5), including the eight behaviour probes OpenAPI cannot express.
Upstream fixes you want arrive on upstream's schedule; upstream bugs you hit must be worked around or
upstreamed (frictionless licensing helps here).

**Residual allowance.** Narrow, pinned subpath imports from `@paperclipai/shared` (its
`"./*": "./dist/*.js"` export genuinely allows `/frontmatter`, `/network-bind`) are permitted if a
genuine need appears. Not part of the base plan; buys nothing today.

**Reversibility.** **High** in the direction of pinning (bump a tag). **Low** in the direction of
forking — once forked, the divergence compounds at ~1 stable/week and is effectively permanent.
