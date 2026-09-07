---
feature: paperclip
document_role: index
status: current
observed_at: 2026-09-07
as_of_commit: f0c26fbd2824862399d8357d26050662e7644870
implemented_by:
  - src/lib/paperclip/mission-projection.ts
  - src/lib/paperclip/client.ts
  - src/lib/paperclip/config.ts
  - src/lib/paperclip/agent-map.ts
  - src/lib/paperclip/mission-engine.ts
  - src/lib/paperclip/paperclip-mission-engine.ts
  - src/lib/paperclip/reconciler.ts
  - src/lib/paperclip/watermark.ts
  - src/lib/paperclip/dispatch-worker.ts
  - src/lib/missions/mission-acl.ts
  - src/lib/missions/format.ts
  - src/lib/state/mission-tasks-repo.ts
  - src/adapters/dashboard/missions.ts
  - src/adapters/dashboard/paperclip-dispatch.ts
  - src/adapters/dashboard/handler.ts
  - src/lib/tools/mission-tools.ts
  - src/lib/tools/paperclip-tools.ts
  - src/lib/tools/privacy-tools.ts
  - src/lib/state/kill-switches-repo.ts
  - scripts/mission.ts
  - scripts/paperclip-bootstrap.ts
  - scripts/lib/paperclip/bootstrap-secret.ts
  - src/ops/paperclip-phase-probe.ts
  - tests/fixtures/paperclip-bootstrap.ts
  - vendor/paperclip/Dockerfile
  - vendor/paperclip/updated-since.patch
  - docker-compose.paperclip.yml
  - infra/lib/database-stack.ts
  - infra/lib/filesystem-stack.ts
  - infra/lib/network-stack.ts
  - infra/lib/secrets-stack.ts
  - infra/lib/paperclip-stack.ts
  - infra/bin/app.ts
  - infra/lib/constants.ts
  - .github/workflows/deploy.yml
  - scripts/deploy.ts
  - scripts/teardown.ts
  - scripts/cost-estimate.mjs
  - scripts/lib/cost-gate.ts
  - scripts/lib/lifecycle/deploy-phases.ts
  - web/src/pages/Missions.tsx
  - web/src/lib/glossary.ts
  - web/src/lib/missions-hierarchy.ts
tested_by:
  - src/lib/paperclip/mission-projection.test.ts
  - src/lib/paperclip/client.test.ts
  - src/lib/paperclip/paperclip-mission-engine.test.ts
  - src/lib/paperclip/client.paperclip.integration.test.ts
  - src/lib/paperclip/reconciler.test.ts
  - src/lib/paperclip/dispatch-worker.test.ts
  - src/adapters/dashboard/missions.test.ts
  - src/adapters/dashboard/paperclip-dispatch.test.ts
  - src/lib/tools/mission-tools.test.ts
  - src/lib/tools/paperclip-tools.test.ts
  - src/lib/missions/format.test.ts
  - src/adapters/dashboard/authz-matrix.test.ts
  - src/lib/state/kill-switches-repo.test.ts
  - infra/lib/database-stack.test.ts
  - infra/lib/filesystem-stack.test.ts
  - infra/lib/paperclip-stack.test.ts
  - scripts/lib/cost-gate.test.ts
  - scripts/lib/lifecycle/paperclip-image-pipeline.test.ts
  - scripts/lib/paperclip/bootstrap-secret.test.ts
  - src/ops/paperclip-phase-probe.test.ts
  - src/adapters/dashboard/missions-hierarchy.test.ts
decisions:
  - docs/adr/0010-paperclip-work-engine.md
  - docs/adr/0009-mission-container-model.md
evidence:
  - docs/features/paperclip/implementation-plan.md
  - docs/features/paperclip/plan-audit.md
---

# Paperclip integration

## 1. Start Here

This folder documents the integration that makes Paperclip — an open-source
agent work-tracking system, self-hosted as a pinned container — the system of
record behind Netzar's Missions feature. **Everything needed to continue this
work is in this folder or is linked from it.** Nothing lives in a chat log or a
scratchpad any more.

Read in this order:

| # | Read | For |
|---|---|---|
| 1 | [HANDOFF.md](HANDOFF.md) | Where the work stands right now, and the single next action |
| 2 | [ADR 0010](../../adr/0010-paperclip-work-engine.md) | The ratified decisions — DL-1 … DL-9 verbatim, the hard constraints, the 2026-08-18 patch amendment |
| 3 | [plan-audit.md](plan-audit.md) | The 16 wrong citations and 4 structural defects in the plan — **read before the plan, not after** |
| 4 | [implementation-plan.md](implementation-plan.md) | The historical §1–§34 design study, phased build sheet and append-only execution addenda |
| 5 | [handoffs/](handoffs/2026-08-18-codex-review.md) | Session history: what was already tried, and why it failed |

**Source code is the ultimate truth for present behavior.** Where a document
and the implementation disagree, the code wins; inspect it and correct the
document.

### The one rule about the plan

[implementation-plan.md](implementation-plan.md) is the blueprint for Phases
2–10, and it is **historical** — true when written on 2026-08-18, not
maintained since. Two things have already overtaken it:

- **ADR 0010's amendment supersedes its "no Paperclip source changes" premise.**
  The pinned release does not implement `updatedSince` at all, which invalidated
  the plan's mandatory durable reconciler feed. The self-hosted copy now carries
  one approved patch.
- **[plan-audit.md](plan-audit.md) corrects 16 of its citations**, two of which
  are paths that do not exist. Check a citation there before you follow it.

## 2. What Paperclip does today

Present in the current source and working tree:

Paperclip is live in staging as the missions system of record; the 2026-09-06 live critic found the inbound dispatch push being rejected and one agent's adapter missing a working push URL, and both were fixed and merged to `development` (`#159`, `277095e`). Phase 1 (hierarchy on the wire, parent-owned delegation, the detail modal) is code-complete, validated by the full suite in both flag states on `feat/paperclip-p1-hierarchy` `f0c26fb`, and pending promotion (see [HANDOFF.md](HANDOFF.md)).

- **A patched, pinned artifact and disposable live harness.**
  `vendor/paperclip/` builds `netzer-paperclip:2026.722.0-netzar.1` from an
  immutable upstream digest plus the approved `updatedSince` patch;
  `docker-compose.paperclip.yml` runs it with PostgreSQL 17. The bootstrap paths
  create exactly one company, mapped HTTP agents and their API keys without
  logging secrets.
- **A typed HTTP client and Mission engine.** Every operation crosses
  Paperclip's authenticated API; Netzar never reads its Postgres directly.
  Pagination, rate limits, circuit breaking, idempotent writes, per-actor key
  selection and the `paperclip_disabled` kill switch live in the shared client
  boundary.
- **Durable observation plus low-latency dispatch.** The reconciler polls the
  patched `updatedSince` feed with overlap-and-dedupe and ships in observing
  mode. The inbound dispatch route acknowledges with 202, durably claims a
  `(runId, issueId)` pair, and hands the genuine Paperclip run id to the worker;
  it never fabricates one.
- **The Missions anti-corruption layer.** The existing four
  `/api/missions*` contracts and capability gates are served through a
  `MissionEngine`, with the legacy handlers retained as one whole router-level
  rollback path. There is no per-request fallback from Paperclip to DynamoDB.
  Mission provenance is recorded on the Netzar side so Paperclip-origin work is
  included in privacy exports.
- **Cross-surface mission parity.** Dashboard, Jarvis, Telegram, Slack, Discord
  and CLI formatting share the same mission vocabulary. Assignment push is an
  honest notification path; the two native Paperclip verbs are exposed through
  the approved `paperclip_*` tools; successful `paperclip_*` mutations write one `tool_invoke` audit record; mission-tool mutations do not (P49).
- **The widened public Mission model.** The board and every text surface use six
  ordered states (`open`, `in_progress`, `blocked`, `in_review`, `done`,
  `cancelled`) and four priority bands (`critical`, `high`, `medium`, `low`).
  The old public `dueAt` / `due_at` field is removed. The Missions page renders
  all six lanes, and `scripts/mission.ts` uses the real list/create routes and a
  bounded owner-board scan for `show`.
- **Default-install infrastructure in source.** `CCE-Database`,
  `CCE-Filesystem` and `CCE-Paperclip` are always part of the CDK stack set.
  Their resources provision at T1–T3, while an ordinary T0 Hobby install stays
  exempt; the workflow uses a one-directional environment override so Tier 0
  staging still exercises Paperclip. `CCE_PAPERCLIP_ENABLED` no longer controls
  synthesis or cost. During rollout it remains only the router switch between
  the Paperclip and retained legacy handlers.
- **A same-run fresh-install path.** The deploy workflow builds the pinned image,
  applies exclusive Paperclip IAM before consumers need it, populates the
  deploy-owned secret fields, lands the service parked, runs migrations and
  starts it in one workflow run. The money gate includes Aurora, EFS and the fixed
  `desiredCount: 1` Paperclip task wherever the substrate provisions; teardown
  routes the three stacks through the normal CDK destroy path.
- **An internal Paperclip operator console.** The shipped React board is served
  in authenticated mode, but it is not attached to Netzar's ALB and is never
  linked from the Netzar SPA. Operators reach port 3100 only through an
  AWS-authenticated ECS Exec/SSM tunnel. This network boundary contains the
  pinned artifact's open email-signup route until upstream provides a safe
  signup control or a separately reviewed access-controlled listener exists. The plan replaces SSM-only access with a host-based bridge on missions.staging.pgnos.ai (plan B-1..B-6) once Phase 1 and 8.5 land.

The behavior above is present in source and deployed to staging: the Paperclip
base went green in run `33067242593` on `ac70509`, and the staging contract
probe went green in run `33783021194` on `47a69db` with all eight CloudWatch
markers (section 3).

## 3. Current status and current source commit

Source: `development` `277095e` (Phase 0 `#156` merged, P0-2 dispatch-push fix `#159` merged); staging `dd16ca4` (Deploy run `34021795520`, pre-dates both); Phase 1 (hierarchy, delegation, detail modal) validated by the full suite in both flag states on `feat/paperclip-p1-hierarchy` `f0c26fb`, not yet pushed or promoted — see [the close-out handoff](handoffs/2026-09-07-p1-hierarchy-closeout.md).

P0-0 (the Dockerfile build-stage npm fetch timeout) shipped and deployed:
staging run `33989570600` at `9873f28` is green and equal to the bar. The
staging environment variable `CCE_PAPERCLIP_ENABLED=1` was set 2026-09-05 and
took effect at staging Deploy run 34004002068 (2026-09-06T01:28Z, `5a5bf65`) -- Paperclip is LIVE in staging now, not pending the dispatch fix's deploy (which only repairs the push); the repo-level variable stays `0`
and the production environment sets none. The legacy
router remains intentionally present until the separately reviewed retirement
gate has two clean production weeks of evidence.

The 2026-09-06 Phase 0 live critic (staging `dd16ca4`, run 34021795520) found the inbound dispatch push rejected 400 `invalid_body` on every attempt and the Research agent's adapter missing a push `url`; both are fixed on `fix/paperclip-p0-2-dispatch-push` (`0e09c9e` fix(paperclip): accept the real adapter push, whose issue id rides under context; `cd4c664` fix(paperclip): reconcile a reused agent's adapter config and arm dispatch slugs from the environment), PR pending against `development`.

Required execution order from here: Phase 0 (P0-0 done/deployed; P0-1 live PASS -- board read confirmed over the tunnel 2026-09-06; P0-3 live PASS on refusal and list, its update case confounded by the P0-2 dispatch defect; P0-2 fixed on `fix/paperclip-p0-2-dispatch-push`, live re-check pending that branch's deploy and the bootstrap repair with `PAPERCLIP_DISPATCH_SLUGS=main,research`) → Phase 1 (hierarchy, including P1-3 parent-
owner delegation) → Phase 8.5 → the same-origin UI/session bridge → Phases
10–12 → the final legacy retirement. The volatile pass/fail counts and exact
next action belong in [HANDOFF.md](HANDOFF.md), not this index.

## 4. Source of truth

Read this table top-down. **A row beats every row below it** where they
conflict.

| Rank | Concern | Authority | Use it for |
|---|---|---|---|
| 1 | Present runtime behavior | [the code](../../../src/lib/paperclip/mission-projection.ts) and its [tests](../../../src/lib/paperclip/mission-projection.test.ts) | What the system actually does today. Beats every document. |
| 2 | Ratified architecture | [ADR 0010](../../adr/0010-paperclip-work-engine.md) | DL-1 … DL-9, the hard constraints, the 2026-08-18 patch amendment |
| 3 | Volatile state | [HANDOFF.md](HANDOFF.md) | Branch, PR, deploy state, blockers, the next action |
| 4 | Plan corrections | [plan-audit.md](plan-audit.md) | The 16 wrong citations and 4 structural defects. Beats the plan. |
| 5 | Design and build sheet | [implementation-plan.md](implementation-plan.md) | §1–§34: why this architecture, and the phase-by-phase plan for Phases 2–10 |
| 6 | Session history | [handoffs/](handoffs/2026-08-18-updated-since-patch-and-phase-0.md) | What was already attempted and why it failed. Never a statement of present state. |
| — | Exactly what runs in the harness | [Dockerfile](../../../vendor/paperclip/Dockerfile) + [patch](../../../vendor/paperclip/updated-since.patch) | The byte-exact artifact; re-evaluate on every re-pin |
| — | Live contract evidence | [integration test](../../../src/lib/paperclip/client.paperclip.integration.test.ts) | I3 and FI-4, the two proven contracts |
| — | Superseded storage model | [ADR 0009](../../adr/0009-mission-container-model.md) | What Missions v2 was; the wire contract and roles that survive |

**Not an authority:** the `.superpowers/sdd/` task briefs and `progress.md`
ledger are local, gitignored, per-machine scratch. Do not cite them.

## 5. Implementation map

| Area | Verified location | Present behavior |
|---|---|---|
| Projection and public domain | `src/lib/paperclip/mission-projection.ts`, `src/lib/state/mission-tasks-repo.ts` | Seven Paperclip states project into six ordered Mission states (only `backlog`/`todo` collapse to `open`); priority is the four-band enum end to end; unassigned issues reject with a typed error; Paperclip text is neutralized before prompting; public `dueAt` is gone |
| Client and engine | `src/lib/paperclip/client.ts`, `config.ts`, `agent-map.ts`, `mission-engine.ts`, `paperclip-mission-engine.ts` | Authenticated API boundary with pagination, timeout/rate-limit errors, retry-safe writes, circuit breaking, actor-key selection and no synthesized run ids |
| Reconciler | `src/lib/paperclip/reconciler.ts`, `watermark.ts` | Observing poller over the patched feed; overlaps the stored max timestamp, dedupes `(id, updatedAt)`, refuses corrupt or unfiltered feeds, and advances the watermark conditionally |
| Inbound dispatch | `src/adapters/dashboard/paperclip-dispatch.ts`, `src/lib/paperclip/dispatch-worker.ts` | Constant-time shared-secret check, fast 202 acknowledgement, durable one-shot claim, genuine run-id propagation, refusal-aware retry/recovery |
| Missions ACL and privacy | `src/lib/missions/mission-acl.ts` (`canReadBoard`, `canMutateMission`), `src/adapters/dashboard/missions.ts`, `src/lib/tools/privacy-tools.ts` | Preserves the four `/api/missions*` envelopes/capability gates, resolves the public 8-character reference without silent ambiguity, and joins Netzar-side provenance into privacy exports |
| Mission surfaces and tools | `src/lib/missions/format.ts`, `src/lib/tools/mission-tools.ts`, `src/lib/tools/paperclip-tools.ts` | One status/priority vocabulary across chat surfaces; assignment notification parity; exact approved Paperclip verbs; one audit record per successful mutation |
| Dashboard and CLI | `web/src/pages/Missions.tsx`, `web/src/lib/glossary.ts`, `scripts/mission.ts` | Six ordered kanban lanes, four priority labels and no due-date rendering; CLI list uses `owner`, create sends the actual route body, and show scans bounded real owner boards because no detail route exists |
| Harness and artifact | `docker-compose.paperclip.yml`, `vendor/paperclip/` | Builds and runs the immutable pinned image plus the approved `updatedSince` patch with PostgreSQL 17; `npm run test:paperclip:up/down/all` |
| Bootstrap | `tests/fixtures/paperclip-bootstrap.ts`, `scripts/paperclip-bootstrap.ts` | Better Auth first-admin flow; exactly-one-company check; company/agent/key provisioning; secret-safe, fail-closed idempotency |
| Kill switch and authz pin | `src/lib/state/kill-switches-repo.ts`, `src/adapters/dashboard/authz-matrix.test.ts` | `paperclip_disabled` is permanent and checked at the transport/ACL boundary; the four mission routes keep their coarse authorization envelopes and capability decisions |
| Database and filesystem | `infra/lib/database-stack.ts`, `infra/lib/filesystem-stack.ts` | Aurora Serverless v2 PG 17 (0.5 ACU floor, tiered ceiling, deletion protection, RETAIN, backups) and encrypted EFS/logging; resources are empty at ordinary T0 and provisioned at T1+ or the environment override |
| Service and reachability | `infra/lib/paperclip-stack.ts`, `infra/lib/network-stack.ts`, `infra/bin/app.ts` | Fixed `desiredCount: 1` ARM64 task, Cloud Map discovery at `paperclip.claudeclaw.internal:3100`, dedicated SG reachability, one-company bootstrap contract, and the same named stack set regardless of router-flag value |
| Deploy workflow | `.github/workflows/deploy.yml`, `scripts/lib/lifecycle/deploy-phases.ts` | Pinned image build, early exclusive IAM, secret population, first bootstrap/migration and full redeploy occur in the same workflow run; migration/park escape hatches remain explicit |
| Provisioning, cost and teardown | `infra/lib/constants.ts`, `scripts/deploy.ts`, `scripts/lib/cost-gate.ts`, `scripts/cost-estimate.mjs`, `scripts/teardown.ts` | One predicate provisions Paperclip at T1+ or the staging override; the router flag does not change synth; the money gate includes Aurora/EFS/Paperclip Fargate wherever provisioned; teardown sends all three stacks through CDK destroy |

## 5b. Using the client (`src/lib/paperclip/client.ts`)

Every fenced block in this section is **executed** by
`src/lib/paperclip/readme.test.ts`, which also asserts the block is byte-identical
to the code it runs. Editing one without the other fails the suite, so these
snippets cannot silently rot.

**Constructing one.** In a deployed task use `paperclipClientFromEnvironment()`,
which reads env plus the `paperclip/base_url` runtime-config key. Everywhere
else, hand the constructor the four values directly. Construction is
**synchronous and total**: a missing base URL, company or agent key throws
`PaperclipDisabledError` here, naming the remediation, rather than becoming a
request to `undefined/api/…`.

<!-- CODE_SECTION: construct -->
```ts
const paperclip = new PaperclipClient({
  baseUrl: 'https://paperclip.internal',
  companyId: '00000000-0000-4000-8000-000000000001',
  agentKeys: { main: 'agent-key-for-main' },
  defaultActor: 'main',
});
```

**Reading a board.** The issue list answers a **bare array** — no envelope, no
`total`, no `nextOffset` — so a sweep pages until an empty page. `paginateAll()`
walks serially on purpose: identical concurrent reads coalesce, but *distinct*
concurrent reads for one actor are what trip `429 Too many concurrent
issue-list requests`. Reaching its page bound with rows still on the board
raises `PaperclipPaginationTruncatedError` rather than returning a short array —
this surface has no totals endpoint to catch an undercount against.

<!-- CODE_SECTION: paginate -->
```ts
const page = await paperclip.listIssues({
  updatedSince: '2026-08-20T00:00:00.000Z',
  sortField: 'updated',
  limit: 2,
});
const everything = await page.paginateAll();
```

The filters above survive to page 2 without being repeated: the page holds a
refetch closure captured at construction, and `fetchNext()` merges the cursor
over it.

**Catching a failure.** Every failure is a `PaperclipError` with a `type`
discriminant, the HTTP `status`, the parsed `body`, the `request` context and the
untouched original on `raw`. Rate limits carry the whole budget, and
`advertisedWaitMs()` is the wait the server actually asked for — never `NaN`,
even when the header is not a number.

<!-- CODE_SECTION: errors -->
```ts
try {
  await paperclip.getIssue('a1b2c3d4-0000-4000-8000-000000000001');
} catch (err) {
  if (err instanceof PaperclipRatelimitedError) {
    await sleep(err.advertisedWaitMs() ?? 1_000);
  } else if (err instanceof PaperclipError) {
    logger.warn({ type: err.type, status: err.status, path: err.request?.path }, err.message);
  }
}
```

**When the integration is switched off.** The `paperclip_disabled` kill switch is
checked inside the transport at **every** invoke and *before* the circuit
breaker, so no caller can bypass it and a deliberately disabled integration never
looks like an outage.

<!-- CODE_SECTION: killswitch -->
```ts
const failure = await paperclip.getHealth().catch((err: unknown) => err);
// PaperclipDisabledError, not PaperclipUnavailableError:
// "paperclip_disabled kill switch active: …"
```

## 6. Current business/state rules

- One Netzar deployment maps to one Paperclip company (DL-5).
- Each installation owns one stable, independently generated Paperclip Better
  Auth session-signing secret in its Secrets Manager record. Setup or CI may
  seed an absent/placeholder field, but later deploys preserve the stored value;
  a GitHub environment secret is only an optional first-write override for a
  Netzer-operated environment, never a fleet-wide customer credential.
- Unassigned Paperclip issues are rejected by the projection with a typed error;
  the ACL filters them rather than inventing an owner.
- The reconciler queries `updatedSince` from
  `max processed updatedAt - poll_overlap_ms` and dedupes `(id, updatedAt)`
  client-side. That overlap is load-bearing because Postgres stores microseconds
  while the API exposes millisecond-truncated timestamps; the old `+1ms`
  watermark rule is superseded.
- Paperclip run ids are **never** synthesized (ADR 0010 hard constraint 2; a
  source assertion in the integration test forbids `randomUUID` anywhere in
  `src/lib/paperclip/`).
- `paperclip_disabled` remains a permanent emergency control. It is evaluated at
  every client invocation and at the ACL refusal boundary; a disabled engine is
  never disguised as a successful legacy fallback.
- Netzar never touches Paperclip's Postgres (DL-2). Every read and write crosses
  an authenticated HTTP boundary.
- Public Missions have six ordered states and four priority bands. `dueAt` is no
  longer part of the public Mission, tool or dashboard contract.
- The Paperclip board is an operator-only break-glass surface. Use a named AWS
  identity, resolve the running `claudeclaw[-suffix]-paperclip` task and its
  `paperclip-server` runtime id, then open an
  `AWS-StartPortForwardingSession` session to remote port `3100`. Browse only
  `http://localhost:3100`, use an individually named Paperclip account, and
  close the session when finished. Shared logins and public ALB/hostname rules
  are not supported while the pinned artifact allows unauthenticated signup.
  The planned same-origin UI/session bridge (missions.staging.pgnos.ai) will
  replace this break-glass tunnel for ordinary board access; it is plan items
  B-1..B-6 in missions-engine-plan.md, after Phase 1 and 8.5; it does not exist
  yet.
- Any agent may list any board in the company; an agent may mutate a mission it
  owns or created (ADR 0009 :93-96, instantiated 2026-09-05); the identity that
  acts on a board is the board scope (`boardAgentId`, else the session agent)
  for creation and for judgment alike; parent-owner delegation shipped in P1-3a
  (`mission-acl.ts` `canMutateMission`, third OR-arm).
  Dashboard routes keep their capability gates.
- Flipping `CCE_PAPERCLIP_ENABLED` hides legacy DynamoDB missions from the board
  (DL-7, no migration); staging had 2, both cancelled, before the flip.
- Paperclip 2026.722.0 does not dedupe wakeups by `idempotencyKey`; the orchestrator's `(runId, issueId)` claim is the only guard.
- `tool_invoke` audit rows are written only by tools that call `writeAudit` (`paperclip_add_comment`, `paperclip_create_subtask`); mission tools do not.

### Paperclip task-definition variables the probe made necessary

- `PAPERCLIP_ALLOWED_HOSTNAMES` = the Cloud Map hostname the orchestrator dials (`paperclip.<app>.internal`). In `authenticated`/`private` mode the pinned image's private-hostname guard answers 403 to every request, `/api/health` included, whose Host is neither loopback nor on this list; the list replaces `config.json`'s `server.allowedHostnames`. Found by run 33733071639.
- `PAPERCLIP_BIND=lan` beside `HOST=0.0.0.0`. The bind mode resolves as `PAPERCLIP_BIND` ?? `config.json` `server.bind` ?? inferred from `HOST`, and `loopback` forces the listener onto 127.0.0.1 whatever `HOST` says; the EFS `config.json` holds `loopback`, so a re-booted task without this variable answers only its own localhost health check. Found by run 33773788920.

Both task-definition variables are pinned by literal tests in `infra/lib/paperclip-stack.test.ts`; the migrate task carries neither.

### Bootstrap variables (not on the task definition)

- `PAPERCLIP_DISPATCH_SLUGS` = a comma-separated list of Netzar agent slugs to arm with a live dispatch `url` at bootstrap time; `main` is always kept even if omitted or the value is malformed. Read by `scripts/paperclip-bootstrap.ts`'s `specsFromEnv` via `parseDispatchSlugs`. Made necessary by the 2026-09-06 live critic (Research had no `url`), not by the probe.

### Observed org and goals shapes (staging, run 33783021194, values never logged)

These are the redacted shapes the probe recorded from the pinned artifact through the orchestrator's own path. Phase 8.5 types `org.ts` and `goals.ts` against them, not against the OpenAPI's `additionalProperties: {}`.

- `org` — 200, `application/json`, an array of agents: `{id, name, role, status, reports: [{id, name, role, status, reports: []}]}` (nested `reports` is the hierarchy).
- `whoami` (`/api/agents/me`) — 200, an object whose top-level keys include `access {canAssignTasks, grants[], membership}`, `adapterConfig`, `adapterType`, `budgetMonthlyCents`, `capabilities`, `chainOfCommand`, `companyId`, `createdAt`, `defaultEnvironmentId`, `errorReason`, `icon`, `id`, `lastHeartbeatAt`, `metadata`, `name`, `orgChainHealth`, `pauseReason`, `pausedAt`, `permissions`, `reportsTo`, `role`, `runtimeConfig`, `spentMonthlyCents`, `status`, `title`, `updatedAt`, `urlKey`.
- `goals-list` — 200, an empty array on a fresh company.
- `org-svg` — 200, `image/svg+xml`, a document containing `<svg`.
- `goal-create` — 201; `goal-get`, `goal-update`, `goal-delete` — 200; all four return the same goal object `{companyId, createdAt, description, id, level, ownerAgentId (null), parentId (null), status, title, updatedAt}`.

### Observed dispatch and board shapes (staging, 2026-09-06, values never logged)

Measured by the Phase 0 live critic (staging `dd16ca4`, run 34021795520) over the SSM tunnel and by direct read of the pinned image source. Values are never recorded; only shapes.

- `GET /api/missions?owner=<agent>` -- 200, `{owner: string, count: number, missions: [{assignmentReason, body, createdAt, createdByAgent, createdByChat, id: uuid, ownerAgent, priority, status, title, updatedAt}]}`. `POST /api/missions` -- 201, `{mission: <same row shape>}`.
- `GET /api/config/paperclip` -- `{category, values{enabled_agents, ...}}`; `POST /api/config/paperclip/enabled_agents` -- 200, `{ok, category, key, value}`.
- `GET /api/companies/{cid}/agents` -- the two Netzar http agents (Main, Research) each carry `{adapterType, adapterConfig, metadata.netzarAgentId, role, ...}` (measured on Main; Research shares the shape minus `url`); two `claude_local` agents (Summarizer, Reflection Coach) are also present, paused, and were not probed. The armed Main agent's `adapterConfig` keys are `[headers(authorization), method, payloadTemplate, timeoutMs, url]` and its `payloadTemplate` is `{netzarAgentId: <slug>}`; an agent not in `PAPERCLIP_DISPATCH_SLUGS` at bootstrap time has `adapterConfig` keys `[method, payloadTemplate, timeoutMs]` -- no `url`, so it cannot receive a push.
- `POST /agents/:id/wakeup` -- 202 body keys include `agentId, companyId, contextSnapshot{actorId, forceFreshSession, triggeredBy, wakeReason, wakeSource, wakeTriggerDetail}, continuationAttempt, createdAt, id, invocationSource, resultJson, status, wakeupRequestId` (and more); waking an agent that is not the caller's own returns 403 `{error:'Agent can only invoke itself'}`.
- Orchestrator rejection log line, one per bad push: `{env, level:40, msg:'paperclip dispatch body rejected', reason:'invalid_body', service, time}`.
- The adapter push body itself (pinned image `/app/server/src/adapters/http/execute.ts:13`, digest pinned at `vendor/paperclip/Dockerfile:20` -- read from source and confirmed by the live 400s, not a captured log line, since the body is never logged): `{netzarAgentId, agentId, runId, context: {issueId, wakeReason, taskId, taskKey, wakeSource, wakeTriggerDetail, ...}}`, headers `content-type: application/json` plus whatever is configured under `adapterConfig.headers` (ours: `authorization`); there is no `X-Paperclip-*` header. The issue id rides under `context.issueId`, not top-level -- the defect this branch's dispatch-parser fix corrects.

### Issue hierarchy and blocking (staging, 2026-09-06)

Measured by the Phase 0 live critic (P1-1) creating a small parent/child/blocked-by fixture over the tunnel and reading it back through every route that could plausibly carry hierarchy or dependency state, on staging `dd16ca4` — before the Phase 1 code existed. To be re-confirmed live in Piece F, after Phase 1 deploys (see [the close-out handoff](handoffs/2026-09-07-p1-hierarchy-closeout.md)).

| field | route | observed type | list row? | detail? | note |
|---|---|---|---|---|---|
| `parentId` | 201 of company create and `/children`; `GET /api/issues/{id}`; list row | `string uuid \| null` | YES (full and `view=compact`) | YES | Persisted on 201 and re-read; `?parentId=<uuid>` returns exactly the children (200); `?parentId=<malformed>` -> 500. |
| `blockedByIssueIds` | request only (company create, PATCH) | array of uuid strings (request) | n/a | n/a | Never echoed back; the response name is `blockedBy`. |
| `blockedBy` | 201 bodies, detail | `array<object{activeRecoveryAction?, assigneeAgentId, assigneeUserId, id, identifier, priority, status, title}>` | NO | YES | Element is an object, not a bare uuid. |
| `blocks` | 201 bodies, detail | same element shape as `blockedBy` | NO | YES | Reciprocal of `blockedBy` on the blocking issue. |
| `blockerAttention` | list row (full and compact), detail | `object{state, reason, unresolvedBlockerCount, coveredBlockerCount, stalledBlockerCount, attentionBlockerCount, sampleBlockerIdentifier, sampleStalledBlockerIdentifier}` | YES | YES | The only blocking-related signal on a LIST row; `state` seen: `none`, `needs_attention`. |
| `children` / `childCount` | -- | ABSENT | NO | NO | Not on any 201, list row, or detail. Derive via `?parentId=` or `diagnostics/subtree`. |
| `ancestors` | detail only | `array<object{...,goal,goalId,id,identifier,priority,project,projectId,status,title}>` | NO | YES | Length 1 per child (the parent); empty on the parent. |
| `status` | everywhere | enum string | YES | YES | `blockedByIssueIds` does NOT itself produce `status:'blocked'`; the graph does not drive status in either direction. |
| `requestDepth` | 201, list, detail | `number` | YES | YES | Company route with `parentId`: 0. `/children` route: 1. Not tree depth -- set by which create route was used. |
| `GET /api/issues/{id}/diagnostics/subtree` | agent key: 200 | `{..., nodeCount, nodes: array<{..., depth, parentId, ...}>, ...}` | -- | -- | This IS the children/descendant listing, with per-node `parentId` and `depth`. |
| `PATCH /api/issues/{id}` `blockedByIssueIds` | -- | -- | -- | -- | `[]` clears; a non-empty array REPLACES the prior set (not append). |
| `blockParentUntilDone` (request, `/children` only) | boolean | n/a | n/a | n/a | Writes a `blockedBy` entry naming the child onto the *parent*; not reachable from the company create route. |
| `GET /api/issues/{id}/diagnostics/blockers` | agent key: 200 | `{blockers: array<{...}>, readiness{allBlockersDone, isDependencyReady, ...}, ...}` | -- | -- | Lists only the blockers actually gating run-claiming (e.g. a `blockParentUntilDone` edge), not every `parentId` child. |
| `GET /api/issues/{id}/tree-control/state` | 403 with the agent key | `{error}` | -- | -- | Not agent-callable. |
| `executionState` | 201, list row (full only, dropped by `view=compact`), detail | `null` observed | YES (full) | YES | Never expressed blocking in this run. |
| `activeRun`, `lastActivityAt` | list row only | `null`, string | YES | NO | The only two keys the list row carries that detail lacks. |
| `relations` | -- | ABSENT | NO | NO | The key some prior notes referenced does not exist on this artifact. |
| `relatedWork` | company-route 201, detail | `object{inbound, outbound}` | NO | YES | Absent from the `/children` 201 body (which does carry `referencedIssueIdentifiers`) -- the two create routes return different key sets (54 vs 52 keys); not a parent/child relation carrier (empty here). |
| `GET /api/issues/{id}/runs` | agent key: 200 | `array<object{adapterType, agentId, continuationAttempt, createdAt, environment, environmentLease, errorCode, finishedAt, invocationSource, lastUsefulActionAt, livenessReason, livenessState, logBytes, nextAction, responsibleUserId, resultJson, retryExhaustedReason, retryOfRunId, runId, scheduledRetryAt, scheduledRetryAttempt, scheduledRetryReason, startedAt, status, usageJson}>` | -- | -- | Used to attribute the status flips: the parent's first run ended `cancelled` with `errorCode:"issue_dependencies_blocked"`. |

- What the dependency graph actually gates is **run claiming**, not `status`: a queued run for a blocked issue is cancelled with `errorCode:"issue_dependencies_blocked"`; `blockerAttention` counts a plain `parentId` child as an implicit blocker of its parent even without `blockParentUntilDone`.
- `status:"blocked"` is **not** dependency state on this artifact -- Paperclip rewrites status to `blocked` after an `adapter_failed` run, independent of the blocking graph.
- `blockedBy` / `blocks` appear only on the 201 create response and the detail read, never on a list row.
- There is no `children` or `childCount` key anywhere; enumerate children via `?parentId=<uuid>` or `GET /api/issues/{id}/diagnostics/subtree`.
- `PATCH .../blockedByIssueIds` REPLACES the set; `[]` clears it.

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| The orchestrator image build runs under QEMU and sits on npm's socket-inactivity timeout | Three of seven staging deploy attempts on 2026-09-03 failed or stalled in `Build + Push (linux/arm64)` before any code ran; lockfiles and Dockerfile unchanged | Shipped by P0-0 (2026-09-05): `ENV npm_config_fetch_timeout=600000` in the Dockerfile `[build]` stage, pinned by `scripts/lib/lifecycle/orchestrator-dockerfile.test.ts`. Two staging runs have completed since without exercising it: 33989570600's build-stage npm install took 251.6 s (bar 230.9 s), under the old 300 s default, and 34004002068's Build + Push took 396 s; the 600 s timeout was not exercised (A56). |
| Paperclip is a single service task | [ADR 0010](../../adr/0010-paperclip-work-engine.md) DL-8 and `infra/lib/paperclip-stack.ts` pin `desiredCount: 1` with no autoscaling | Keep the pin until upstream supports shared node identity; expect a restart gap rather than pretending this is HA |
| The first T1+ install creates an always-on database/task floor | [Cost guide](../../cost-guide.md) and `scripts/cost-estimate.mjs` price about $104/month for the Paperclip substrate | Keep Paperclip out of ordinary T0; require the existing money confirmation before deploy and show the Paperclip lines in that gate |
| The vendored `updatedSince` patch can diverge from upstream | [ADR 0010 amendment](../../adr/0010-paperclip-work-engine.md) | Re-evaluate every artifact re-pin and drop the patch when an upstream release implements the proven contract |
| Node-vs-Postgres clock skew beyond the configured overlap can still lose a row | `src/lib/paperclip/watermark.ts` documents the exact limit; overlap fixes truncation, not unbounded clock skew | Monitor watermark lag and keep `paperclip/poll_overlap_ms` sized from observed clocks |
| Legacy retirement is not yet allowed | [bar-and-phases.md](bar-and-phases.md) Phase 9 requires two clean production weeks and a separately reviewed final commit | Keep the router switch, legacy handlers and `paperclip_disabled`; delete only after the production evidence gate |
| Phase 8.5 and Four Pillars Phases 10–12 are still outstanding | [HANDOFF](HANDOFF.md) | Continue in the recorded order: Phase 0 (P0-2 live re-check and P0-3's update case after this branch's deploy and the bootstrap repair) → Phase 1 (including P1-3 parent-owner delegation) → 8.5 from the observed shapes in section 6 → the UI/session bridge → 10–12 |
| Dispatch was rejected on every push until the P0-2 fix; the research adapter had no url until the bootstrap reconcile runs | 2026-09-06 Phase 0 live critic (staging `dd16ca4`, run 34021795520): every push 400 `invalid_body`; Research's `adapterConfig` had no `url` and Paperclip escalated its issues to Main within ~1 s | Fixed on `fix/paperclip-p0-2-dispatch-push`; deploy this branch, run the bootstrap over the tunnel with `PAPERCLIP_DISPATCH_SLUGS=main,research`, then re-run the live critic for P0-2 and P0-3's update case |

## 8. Exact focused and full validation commands

The Paperclip live suite needs Docker **and** `PAPERCLIP_TEST_AUTH_SECRET` set
in the process environment — any value, never committed. The bootstrap fixture
shells out to `docker compose`, whose YAML interpolation refuses to parse
without it, so the *vitest* process needs it too. Without the variable the live
suite skips rather than fails.

```powershell
npm run test:paperclip:up
npx vitest run src/lib/paperclip/client.paperclip.integration.test.ts --config vitest.integration.config.ts
npx vitest run src/lib/paperclip/mission-projection.test.ts src/lib/paperclip/client.test.ts src/lib/paperclip/paperclip-mission-engine.test.ts src/lib/paperclip/reconciler.test.ts src/lib/paperclip/dispatch-worker.test.ts src/lib/paperclip/readme.test.ts src/adapters/dashboard/missions.test.ts src/adapters/dashboard/paperclip-dispatch.test.ts src/lib/missions/format.test.ts src/lib/tools/mission-tools.test.ts src/lib/tools/paperclip-tools.test.ts scripts/mission.test.ts
npx vitest run infra/lib/database-stack.test.ts infra/lib/filesystem-stack.test.ts infra/lib/paperclip-stack.test.ts infra/bin/app.stack-set.test.ts scripts/lib/cost-gate.test.ts scripts/lib/lifecycle/paperclip-image-pipeline.test.ts --maxWorkers=1 --minWorkers=1
npm run test:paperclip:down
```

`test:paperclip:all` chains with `&&`, so when a test fails the `down` step
never runs — clean the disposable stack up explicitly.

Docs gates, required before any push that touches this folder:

```powershell
node scripts/ci/feature-knowledge.mjs
node scripts/ci/docs-links.mjs
```

Phase 9 also requires both application typechecks and builds after the focused
suite. Exact most-recent results and any environmental full-suite baseline
belong in [HANDOFF.md](HANDOFF.md); this index lists commands, not transient
pass counts.

```powershell
npm run typecheck
npm run build
npm --prefix web run typecheck
npm --prefix web run build
```

Full pre-push suite: see
[development.md — How to develop a new feature](../../../development.md#how-to-develop-a-new-feature-end-to-end),
step 7. Run the **full** `npm test`, never a scoped run.

## 9. Related documents

- [Operational HANDOFF](HANDOFF.md) — current state and next action
- [Phase 1.5 — the Paperclip image pipeline](phase-1.5-image-pipeline.md) — the
  historical work definition for the image pipeline now implemented by the
  deploy lifecycle
- [Implementation plan](implementation-plan.md) and its [audit](plan-audit.md)
- [ADR 0010 — Paperclip is the missions work engine](../../adr/0010-paperclip-work-engine.md)
- [Feature knowledge framework](../README.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)
