---
feature: paperclip
document_role: index
status: current
observed_at: 2026-09-03
as_of_commit: 53dfc2a4df90bbce2936374db38fc58f85c22e45
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
  the approved `paperclip_*` tools; successful mutations write one audit record.
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
  signup control or a separately reviewed access-controlled listener exists.

The behavior above is present in source. The Paperclip base is also verified in
staging at run `33067242593` on `ac70509`; the staging contract-probe completion
diff remains local and has not yet produced deployment evidence.

## 3. Current status and current source commit

The current source commit is `53dfc2a` on `development`, and it is deployed to
staging: run `33783021194` at `47a69db` (the `qa` → `staging` promotion of that
commit) is green and includes the staging contract probe, which ran as a
one-shot task from the live orchestrator task definition and found all eight
CloudWatch markers. The probe's first two live runs each found a real defect,
both fixed with one variable on the Paperclip service task definition (section
6). The legacy router and `CCE_PAPERCLIP_ENABLED` remain intentionally present
until the separately reviewed retirement gate has two clean production weeks of
evidence.

Still not implemented in the required execution order: Phase 8.5, the Four
Pillars work in Phases 10–12, and the final legacy retirement. The
volatile pass/fail counts and exact next action belong in
[HANDOFF.md](HANDOFF.md), not this index.

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
| Missions ACL and privacy | `src/lib/missions/mission-acl.ts`, `src/adapters/dashboard/missions.ts`, `src/lib/tools/privacy-tools.ts` | Preserves the four `/api/missions*` envelopes/capability gates, resolves the public 8-character reference without silent ambiguity, and joins Netzar-side provenance into privacy exports |
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

### Paperclip task-definition variables the probe made necessary

- `PAPERCLIP_ALLOWED_HOSTNAMES` = the Cloud Map hostname the orchestrator dials (`paperclip.<app>.internal`). In `authenticated`/`private` mode the pinned image's private-hostname guard answers 403 to every request, `/api/health` included, whose Host is neither loopback nor on this list; the list replaces `config.json`'s `server.allowedHostnames`. Found by run 33733071639.
- `PAPERCLIP_BIND=lan` beside `HOST=0.0.0.0`. The bind mode resolves as `PAPERCLIP_BIND` ?? `config.json` `server.bind` ?? inferred from `HOST`, and `loopback` forces the listener onto 127.0.0.1 whatever `HOST` says; the EFS `config.json` holds `loopback`, so a re-booted task without this variable answers only its own localhost health check. Found by run 33773788920.

Both are pinned by literal tests in `infra/lib/paperclip-stack.test.ts`; the migrate task carries neither.

### Observed org and goals shapes (staging, run 33783021194, values never logged)

These are the redacted shapes the probe recorded from the pinned artifact through the orchestrator's own path. Phase 8.5 types `org.ts` and `goals.ts` against them, not against the OpenAPI's `additionalProperties: {}`.

- `org` — 200, `application/json`, an array of agents: `{id, name, role, status, reports: [{id, name, role, status, reports: []}]}` (nested `reports` is the hierarchy).
- `whoami` (`/api/agents/me`) — 200, an object whose top-level keys include `access {canAssignTasks, grants[], membership}`, `adapterConfig`, `adapterType`, `budgetMonthlyCents`, `capabilities`, `chainOfCommand`, `companyId`, `createdAt`, `defaultEnvironmentId`, `errorReason`, `icon`, `id`, `lastHeartbeatAt`, `metadata`, `name`, `orgChainHealth`, `pauseReason`, `pausedAt`, `permissions`, `reportsTo`, `role`, `runtimeConfig`, `spentMonthlyCents`, `status`, `title`, `updatedAt`, `urlKey`.
- `goals-list` — 200, an empty array on a fresh company.
- `org-svg` — 200, `image/svg+xml`, a document containing `<svg`.
- `goal-create` — 201; `goal-get`, `goal-update`, `goal-delete` — 200; all four return the same goal object `{companyId, createdAt, description, id, level, ownerAgentId (null), parentId (null), status, title, updatedAt}`.

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| The orchestrator image build runs under QEMU and sits on npm's socket-inactivity timeout | Three of seven staging deploy attempts on 2026-09-03 failed or stalled in `Build + Push (linux/arm64)` before any code ran; lockfiles and Dockerfile unchanged | One `npm_config_fetch_timeout` line in the Dockerfile `[build]` stage, or stop installing `aws-cdk-lib` in the image build; its own PR |
| Paperclip is a single service task | [ADR 0010](../../adr/0010-paperclip-work-engine.md) DL-8 and `infra/lib/paperclip-stack.ts` pin `desiredCount: 1` with no autoscaling | Keep the pin until upstream supports shared node identity; expect a restart gap rather than pretending this is HA |
| The first T1+ install creates an always-on database/task floor | [Cost guide](../../cost-guide.md) and `scripts/cost-estimate.mjs` price about $104/month for the Paperclip substrate | Keep Paperclip out of ordinary T0; require the existing money confirmation before deploy and show the Paperclip lines in that gate |
| The vendored `updatedSince` patch can diverge from upstream | [ADR 0010 amendment](../../adr/0010-paperclip-work-engine.md) | Re-evaluate every artifact re-pin and drop the patch when an upstream release implements the proven contract |
| Node-vs-Postgres clock skew beyond the configured overlap can still lose a row | `src/lib/paperclip/watermark.ts` documents the exact limit; overlap fixes truncation, not unbounded clock skew | Monitor watermark lag and keep `paperclip/poll_overlap_ms` sized from observed clocks |
| Legacy retirement is not yet allowed | [bar-and-phases.md](bar-and-phases.md) Phase 9 requires two clean production weeks and a separately reviewed final commit | Keep the router switch, legacy handlers and `paperclip_disabled`; delete only after the production evidence gate |
| Phase 8.5 and Four Pillars Phases 10–12 are still outstanding | [HANDOFF](HANDOFF.md) | The probe is green; continue in the recorded order (8.5 from the observed shapes below, then the UI/session bridge, then 10–12) |

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
