# Netzer OS Missions — engineering handoff

Operational state for the Missions v2 work. Written so the next engineer or agent
can continue **without access to the conversation that produced it**.

This file is operational state, not marketing. If it disagrees with the code,
**the code wins** — inspect the implementation and fix this file.

---

## 1. Mission

Turn Netzer's `Missions` feature from a per-agent kanban card into a container
for real work: a stated outcome, the tasks undertaken toward it, and the evidence
of what those tasks produced.

Today a mission is one DynamoDB row with 11 fields and four statuses, and
**nothing executes it**. The schema is execution-shaped but inert. The goal is
the smallest reshape that lets the feature hold real work, reusing the platform
that already exists rather than adding to it.

## 2. Product outcome

An enterprise user should be able to: state an outcome → generate or author the
work → approve the plan → have agents execute it → watch progress and intervene →
review the artifacts → accept the result. Agents execute and propose. **Humans
approve and accept** — an agent never decides a mission is complete.

## 3. Current architecture decision

Full reasoning: [ADR 0009](docs/adr/0009-mission-container-model.md) and
[the audit](docs/missions-v2-audit.md).

- **Core abstraction** — a Mission is a goal container. A MissionTask is a unit
  of work. Today's flat mission becomes a Mission holding one task.
- **Entities** — `Mission` (`PK=MISSION#<id>`, `SK=META`), `MissionTask`
  (`SK=TASK#<seq>#<taskId>`), `MissionEvent` (`SK=EVENT#<iso>#<id>`). Artifacts
  are **derived** from `DELIVERABLE:` lines, never stored.
- **State** — `draft → planned → active → review → done`, plus `cancelled` from
  any non-terminal state. Tasks: `queued → running → completed|failed|cancelled`.
  A mission has no `failed` state; its tasks do.
- **Execution** — reuse the existing durable path: EventBridge Scheduler →
  `claudeclaw-scheduled-fire` SQS → `queue-drain.ts` in Fargate, extended with a
  message-`kind` discriminator. No new queue, no new service.
- **Persistence** — the existing `claudeclaw-mission-tasks` table. **No CDK
  change for the data model**: PK/SK are generic strings and GSI1 keys on generic
  `GSI1PK`/`GSI1SK`.
- **Permissions** — the existing capability model, plus a new `missions:write`.
  Authorization moves into a service layer that both routes and agent tools call.
- **Tenancy** — per [ADR 0002](docs/adr/0002-single-tenant.md) the **deployment
  is the tenant boundary**. New mission rows carry a `scopeId` (team/workspace
  *within* a deployment) defaulting to `default`. No other repo changes.

## 4. Scope

**In scope:** the three entities and state machine; repo on the existing table;
migration with a dual-read shim; `missions:write` + scope derivation; a mission
sub-router with a service layer; task authoring; mission list/detail UI; two
approval gates; task execution with failure taxonomy, bounded retries, heartbeat
and cancellation; derived artifacts and evidence gates; audit coverage; scope
isolation tests; soft delete and retention; one DLQ alarm.

**Out of scope (deliberately):** multi-tenant PK refactor · sprints/milestones ·
cross-mission dependencies · templates · search index · notifications · value/ROI
reporting · multi-agent collaboration · Step Functions or any workflow engine ·
event sourcing/CQRS · any new AWS service beyond one CloudWatch alarm.

Do not expand V1 because a capability would eventually be useful. Add it to
[the backlog](docs/missions-v2-backlog.md) under a later milestone instead.

## 5. Non-negotiable rules

1. **Authorization is server-side and identity comes from the authenticated
   principal** — never from a request body or query parameter. `scopeId` and the
   approver identity are both derived from the principal.
2. **Never weaken an existing authorization check.** If two mechanisms disagree,
   require both; do not pick the looser one.
3. **Reuse existing AWS services.** One CloudWatch alarm (MISSION-034) is the
   only infrastructure addition sanctioned by this plan.
4. **Do not introduce a parallel architecture** — no second auth system,
   persistence abstraction, task system, logging system or job queue.
5. **Do not blindly port ClaudeClaw.** It is a reference, not a specification.
   See [audit §6 "Do not port"](docs/missions-v2-audit.md#6-do-not-port).
6. **Migrations must be reversible.** Never delete legacy rows in the same
   release that writes new ones.
7. **Business logic lives in the service layer**, not in route handlers, not in
   the repo, not in React components.
8. **Run the FULL `npm test` before pushing**, not a scoped run — stated in both
   `CLAUDE.md` and `CONTRIBUTING.md`.
9. **Never claim a command passed unless it actually ran.** Record results in §17.
10. **Do not mark a task complete on generated code alone** — see the definition
    of done in the backlog preamble.
11. **Chat surface parity** (`CLAUDE.md`): a chat UX change on one surface must be
    mirrored on Telegram, Slack and dashboard chat, or explicitly skipped with a
    comment at the skipped call site.

## 6. Development framework

**Verified only.** Anything not listed was not confirmed.

| Area | Verified |
|---|---|
| Language / runtime | TypeScript `strict`, Node **20** (`.nvmrc`, `engines`, `node:20-alpine`) |
| Module system | `NodeNext` — **every relative import must end in `.js`** |
| TS strictness | `strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `isolatedModules`; path alias `@/* → src/*` |
| Package manager | **npm** (`package-lock.json`, `npm ci`) |
| Backend | **Hono** ^4 + `@hono/node-server`; sub-router factories mounted in `src/server.ts` |
| Frontend | **Preact** + `preact/hooks`, Vite, `wouter-preact`, Tailwind |
| Database | **DynamoDB** only (no RDS/Aurora). AWS SDK v3 `lib-dynamodb`. Hand-written repos in `src/lib/state/` — no ORM |
| Infrastructure | **AWS CDK** `aws-cdk-lib` ^2.170, 18 stacks, `npx tsx infra/bin/app.ts` |
| Compute | ECS **Fargate** (ARM64) behind an ALB; autoscaled, **multi-instance at T1+** |
| Auth | Bespoke: magic-link passwordless + hashed bearer tokens in DDB. **No Cognito** |
| Authorization | Flat capability model, 7 templated profiles + custom profiles (`src/lib/auth/permissions.ts`) |
| Testing | **Vitest** ^2.1 — unit (`src/**/*.test.ts`) and integration (`*.integration.test.ts` on LocalStack) |
| Logging | **pino** JSON to stdout; `logger.info({fields}, 'message')` — object first |
| Metrics | CloudWatch **EMF** via log lines; no synchronous `PutMetricData` |
| Secrets | **Secrets Manager** (6 secrets, CMEK). **SSM Parameter Store is not used**. Live tunables in the `runtime-config` DDB table |
| Config validation | **zod** in `src/config/env.ts`; fails fast in production on missing/placeholder config |

**Does not exist — do not assume it:** ESLint, Prettier, Biome, editorconfig
(**no lint or format step at all**) · `npm run e2e` · `@playwright/test` as a
dependency · API Gateway · Step Functions · RDS · Cognito · SSM Parameter Store.

## 7. Important repository locations

| Path | Why it matters |
|---|---|
| `src/lib/state/mission-tasks-repo.ts` | The current flat Mission. What MISSION-012 supersedes |
| `src/adapters/dashboard/handler.ts` | The four mission routes (`/api/missions*`) on the catch-all router |
| `src/lib/tools/mission-tools.ts` | Agent tools + Haiku auto-assign |
| `web/src/pages/Missions.tsx` | The kanban UI and its client-side all-agent fan-out |
| `scripts/mission.ts` | CLI — **currently broken** against the live API |
| `src/lib/auth/permissions.ts` | Capability union, profile templates, the one gate |
| `src/lib/auth/route-capability.ts` | Async principal → capability resolution (custom profiles) |
| `src/lib/audit/audit-writer.ts` | Audit action union, dual write, always-audited set |
| `src/lib/scheduler/queue-drain.ts` | The durable SQS consumer missions will extend |
| `src/lib/scheduler/eb-scheduler.ts` | One-shot EventBridge schedule upsert/delete |
| `src/lib/state/runner-lease.ts` | Leader election for periodic loops (**fail-open**) |
| `infra/lib/dynamo-stack.ts` | All 32 tables. `MissionTasksTable` + `gsi1-status-agent-priority` |
| `infra/lib/messaging-stack.ts` | `claudeclaw-scheduled-fire` + DLQ |
| `src/server.ts` | Router composition — **specific routers must precede the `/api` catch-all** |

## 8. Data model

**Current (implemented):** one row per mission.

```
PK = AGENT#<ownerAgent>
SK = MISSION#<isoCreated>#<id>
GSI1PK = STATUS#<status>#AGENT#<owner>
GSI1SK = PRIORITY#<padded 3>#<isoCreated>
fields: id, ownerAgent, createdByAgent, createdByChat, title, body,
        priority(0-100), status, assignmentReason?, dueAt?, createdAt, updatedAt
```

Known defects in this shape: owner is in the PK, so reassign is a
non-transactional cross-partition put-then-delete; both mutation paths list 200
rows and prefix-match in application code; `toMission()` casts `status` with no
runtime validation; the table's `ttl` attribute is **never written**.

**Target (not yet implemented — MISSION-012):** see §3. Update this section when
the schema actually changes, not when it is planned.

## 9. Mission state model

```
draft -> planned -> active -> review -> done
           ^__________________|
cancelled  (from any non-terminal state)
```

`draft → planned` requires ≥1 task. `planned → active` is the human go-gate.
`review → done` is the human accept-gate. `review → planned` is send-back.
Tasks: `queued → running → completed | failed | cancelled`.

**Do not add a state without recording the reason here and in ADR 0009.** Six
mission states is the ceiling. A mission deliberately has no `failed` state.

## 10. Security model

- **Tenant boundary = the deployment** ([ADR 0002](docs/adr/0002-single-tenant.md)).
  Isolation is at the AWS account level; there is no `tenantId` in any PK.
- **`scopeId`** is the team/workspace boundary within a deployment, on new mission
  rows only, defaulting to `default`. **Derived from the principal, never from
  input.**
- **Capabilities**: `missions:read` (viewer-tier) and a new `missions:write`
  (operator-tier, MISSION-014). Mutations currently share `agents:write`.
- **Two authorization mechanisms are live** in the dashboard middleware — the
  capability model and a legacy `ROLE_RANK` ladder. They **disagree in opposite
  directions**, so Jarvis now requires *both*. Collapsing them is separate work.
- **Known risks:** mission `title`/`body` are attacker-influenceable text that is
  fed to Haiku (whose output selects an owner) and echoed into the target agent's
  inter-agent inbox, which the agent loop drains into context. Blast radius is
  bounded by re-validating the model's answer against the known-agent list, but
  the text-into-another-agent's-context path is a real prompt-injection surface.
  Addressed partly in MISSION-023.
- **Cross-agent mission creation is permitted by design** (delegation +
  auto-assign). The control is attribution via `mission_created`, not refusal.

## 11. AWS integration

| Service | Purpose for Missions | Resource | Failure consideration |
|---|---|---|---|
| DynamoDB | All mission state | `claudeclaw-mission-tasks` + `gsi1-status-agent-priority`; PPR, PITR, CMEK, RETAIN | PITR covers recovery; a wrong GSI1 value strands rows outside every query |
| SQS | Durable task dispatch | `claudeclaw-scheduled-fire` (+ DLQ, `maxReceiveCount: 5`, 4-day retention) | **DLQ has no depth alarm** — MISSION-034 |
| EventBridge Scheduler | Deferred/retry dispatch | group `claudeclaw`, `ActionAfterCompletion: DELETE` | Boot backfill re-arms missing schedules |
| ECS Fargate | Runs the drain | service `claudeclaw-service`, ARM64, autoscaled | Multi-instance at T1+; claims must be conditional writes |
| Bedrock | Agent turns + Haiku auto-assign | Runtime + `claudeclaw-default` guardrail | Capacity walls must not consume retry budget |
| CloudWatch | Metrics, alarms | EMF → MetricFilter → `claudeclaw-ops-alerts` SNS | No mission-specific alarm yet |
| S3 | WORM audit mirror | `claudeclaw-audit-lock` (Object Lock, T2+) | Unset bucket is a supported tier-<2 no-op |

**Not used and not to be introduced:** API Gateway (the orphan `execute-api` IAM
grant should be removed, not fulfilled) · Step Functions · RDS/Aurora · Cognito ·
SSM Parameter Store.

## 12. Testing strategy

| Level | Scope | Where |
|---|---|---|
| Unit | State transitions, key construction, classification, capability logic | `src/**/*.test.ts` |
| Integration | Real DDB round-trips, GSI queries, migration, SQS → drain | `*.integration.test.ts` (LocalStack) |
| Authorization | Every route: 401 / 403 / 200; body-supplied identity ignored | Route tests + `authz-matrix.test.ts` |
| Scope isolation | Cross-scope read/write/transition denied; seat-user denied via HTTP **and** Jarvis | MISSION-027 |
| Failure / retry | Capacity vs task failure; retry budget; orphan reclaim | MISSION-021, MISSION-022 |
| E2E | create → plan → approve → execute → review → complete | **Blocked** — see MISSION-032 |

Mission routes have **zero** tests today, and `authz-matrix.test.ts` contains no
mission entries despite its name. That is the gap MISSION-015 and MISSION-027
close.

**Gotcha:** `ToolRegistry.invoke` now audits every dispatch, and the audit writer
uses the same `ddb()` singleton. Any suite asserting DDB send counts must stub
`../audit/audit-writer.js` — see `src/lib/tools/dynamodb-tools.test.ts`.

## 13. Commands

Verified in `package.json` / CI:

```bash
npm ci                      # install
npm run dev                 # local server
npm run build               # tsc -p tsconfig.build.json
npm run typecheck           # tsc --noEmit
npm test                    # vitest run  (FULL suite — required before push)
npm run test:integration    # vitest --config vitest.integration.config.ts
npm run test:integration:all# compose up --wait && integration && down -v
npm run synth               # cdk synth
npm run deploy:cloud        # image-only deploy (no CDK) — safe for app changes
npm --prefix web run typecheck
npm --prefix web run build
```

**Do not use** (verified absent): `npm run lint`, `npm run format`, `npm run e2e`.

Per `CLAUDE.md`: `npm run deploy:cloud` is image-only and safe for app changes; a
full `cdk deploy` can shift env-backed tunables such as the cost cap, so do not
run it to ship app code. Only MISSION-034 needs a real `cdk deploy`.

## 14. Implementation progress

**Completed**

- `MISSION-001` Jarvis reads gated on capabilities, not just role rank
- `MISSION-002` Central audit in `ToolRegistry.invoke`
- `MISSION-003` Audit mission create / status change / reassign
- `MISSION-010` Verified baseline recorded (§17)
- Audit, ADR 0009 and this backlog written

**In progress** — none. Awaiting review of the architecture before domain code.

**Next** — `MISSION-011` (domain types + state machine), then `MISSION-012`.

**Later** — Milestones 2–6, per [the backlog](docs/missions-v2-backlog.md).

## 15. Decisions made

**DEC-001 — Mission becomes a container; MissionTask becomes the work unit.**
Why: a flat row cannot express an outcome, its work, or its artifacts, and there
is no second SK prefix to put them under. Alternatives: harden the flat model
(would need the reshape later anyway, against production data); add `Project`
above `Mission` (a second noun for one concept). Consequence: a data migration
with a dual-read shim; no CDK change.
Full text: [ADR 0009](docs/adr/0009-mission-container-model.md).

**DEC-002 — Deployment stays the tenant boundary; `scopeId` on new rows only.**
Why: [ADR 0002](docs/adr/0002-single-tenant.md) is Accepted and prices the PK
refactor at ~2 weeks plus indefinite scoping risk, warranted only when the
customer base is large and per-customer revenue small — neither is true.
Consequence: the real gap (authorization *within* a deployment) gets fixed;
adding team scoping later is an attribute change on two row types.

**DEC-003 — Security fixes shipped separately, first.**
Why: live, not gated on the redesign, reviewable in isolation.
Consequence: `hotfix/missions-authz` off `production`, needs backporting.

**DEC-004 — Reuse `claudeclaw-scheduled-fire`; no new queue.**
Why: the path already has a DLQ and retry semantics; a second queue would be a
parallel architecture. Consequence: `queue-drain` gains a `kind` discriminator,
and payloads without `kind` must keep routing to the scheduled-task handler.

**DEC-005 — Jarvis requires the capability *and* the role rank.**
Why: the two models disagree in opposite directions — `audit:read` is viewer-tier
in `permissions.ts` while `audit` is operator-tier in the manifest, and
`seat-user` clears the viewer rung while holding no per-tab read. Requiring both
is always at least as strict as either. Alternative (capability only) would have
**widened** viewer access to audit. Consequence: two mechanisms remain live;
collapsing them is separate work.

**DEC-006 — Cross-agent `create_mission` stays permitted.**
Why: delegation and Haiku auto-assign are the designed behaviour; a self-only
rule breaks both and is bypassable by omitting `owner`. The gap was attribution.
Consequence: `mission_created` records whether the owner was explicit or
model-chosen. Revisit if abuse appears.

**DEC-007 — No separate architecture document.**
Why: audit §8–§13 plus ADR 0009 already specify domain, state, execution, AWS,
security and reliability. A fourth doc would be a second copy to keep in sync,
against this repo's own "numbers live in one place" discipline.

## 16. Known issues

**Pre-existing (not introduced by this work)**

- `src/adapters/dashboard/jarvis.flow.test.ts` — 2 tests fail under the full
  suite and pass in isolation. Cross-file test pollution, present on untouched
  `production`. Weakens the regression signal.
- `scripts/mission.ts` is broken against the live API: sends `?agent=` where the
  route reads `owner`, and calls `GET /api/missions/:id`, a route that has never
  existed. Colourizes on statuses that are not real `MissionStatus` values.
- `reassignMission` is a non-transactional cross-partition put-then-delete; its
  own comment concedes a crash leaves a duplicate.
- Both mission mutation paths list up to 200 rows and prefix-match ids, so an
  8-character collision hits the wrong record and mission #201 is unreachable.
- `toMission()` casts `status` with no runtime validation.
- The mission table's `ttl` attribute is configured but never written.
- Two authorization mechanisms live in the dashboard middleware.
- `claudeclaw-scheduled-fire-dlq` has no depth alarm.
- `claudeclaw-ingest` queue and `src/lambdas/extension-deployer.ts` are
  provisioned/written but unwired.
- No lint or format tooling exists. Playwright specs exist but are not installed
  or run.
- The daily DDB→S3 export omits `spendLedger`, `agents`, `dashboardTokens`,
  `runtimeConfig`, `users` and all four `jarvis*` tables (PITR still covers them).

**Introduced by this work** — none known. The suite shows the same 2 pre-existing
failures before and after.

## 17. Tests last run

**Baseline — `origin/production`, clean tree, 2026-08-11**

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm test` | **1 file / 2 tests failed**, 1926 passed (1928) — `jarvis.flow.test.ts`, pre-existing |

**After the hotfix — `hotfix/missions-authz` @ `a44d072`, 2026-08-11**

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm test` | **1 file / 2 tests failed**, 1935 passed (1937) — same 2 pre-existing failures; +9 new tests passing |

Not run: `npm run test:integration` (needs LocalStack), `npx cdk synth`, web
typecheck/build — no web files were changed by the hotfix.

## 18. Git state

- **`hotfix/missions-authz`** — off `production`. Head `a44d072`. Three commits:
  `74c74be` Jarvis capability gate · `de5ea42` central tool audit · `a44d072`
  mission audit events. **Not pushed. No PR opened.** Needs backport to
  `development` per `CONTRIBUTING.md`.
- **`feature/missions-v2`** — off `development` (`72888fe`). Documentation only:
  this file, `docs/missions-v2-audit.md`, `docs/missions-v2-backlog.md`,
  `docs/adr/0009-mission-container-model.md`, `docs/adr/README.md` index entry.
  **No source changes. Not pushed.**
- **Migrations:** none written or run.
- **Deployment:** nothing deployed.

## 19. Next agent instructions

**Read first:** this file, then
[ADR 0009](docs/adr/0009-mission-container-model.md), then
[audit §8–§13](docs/missions-v2-audit.md#8-product-model-recommendation), then
[the backlog](docs/missions-v2-backlog.md).

**Before writing code:**

1. `git status` and confirm your branch. Domain work goes on `feature/missions-v2`.
2. Run `npm test` and confirm you see **exactly the 2 `jarvis.flow.test.ts`
   failures**. More than that means something regressed before you started.
3. Read the file a task names before changing it. Do not trust this document's
   description of code over the code.

**Current task: `MISSION-011`** — domain types and the state machine.

Objective: a pure module (no I/O, no AWS imports) defining Mission / MissionTask /
MissionEvent plus `canTransition`. Derive the state type from a runtime `as const`
array so the two cannot drift — mirror the existing `MISSION_STATUSES` pattern in
`src/lib/state/mission-tasks-repo.ts`.

Files: `src/lib/missions/types.ts`, `src/lib/missions/state.ts`,
`src/lib/missions/state.test.ts` (all new).

Tests that must pass: the new state test, plus the full `npm test` at baseline.

**Constraints:** relative imports end in `.js` · no new dependency · no new AWS
service · six mission states is the ceiling · authorization identity always comes
from the principal.

**Must NOT change in this task:** `src/lib/state/mission-tasks-repo.ts` (still
serving production), the four existing routes, `web/src/pages/Missions.tsx`, any
`infra/` file.

**Known risks:** over-modelling. If a task seems to need a seventh state or a
fourth entity, stop and record why here before adding it.

**Definition of done:** module compiles under `strict`; the transition matrix is
covered by a table-driven test; `npm run typecheck` clean; `npm test` at baseline;
§14 and §17 of this file updated.

**Blocking questions to resolve before their tasks start** (do not guess):

- **MISSION-013** — how many missions exist in production? Decides online
  dual-read vs one-shot backfill.
- **MISSION-021** — idempotency keys or effect staging? Retries would re-run
  agent turns with real side effects.
- **MISSION-032** — adopt Playwright properly (dependency + script + CI job) or
  write these as integration tests?

## 20. Last updated

- **Date:** 2026-08-11
- **Branch:** `feature/missions-v2` (docs) · `hotfix/missions-authz` @ `a44d072` (code)
- **Active task:** none — awaiting architecture review before `MISSION-011`
