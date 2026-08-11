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

- **Core abstraction** — a Mission is the durable, tracked work container in
  which **several agents collaborate** toward a stated outcome under human
  approval. It is scoped by which agents work on it, not by a user or workspace.
  Netzer's four existing agent-collaboration primitives (`ask_agent`,
  `inter-agent-tasks`, `hive-mind`, War Room) are all messaging or memory; none
  tracks work. Missions is the missing durable container.
- **Coordinator** — the `main` agent triages a mission into tasks and staffs
  them; a human approves the plan and accepts the result.
- **Entities** — `Mission` (`PK=MISSION#<id>`, `SK=META`), `MissionTask`
  (`SK=TASK#<seq>#<taskId>`), `MissionEvent` (`SK=EVENT#<iso>#<id>`). Task kinds
  `build | review | fix`. Artifacts are **derived** from `DELIVERABLE:` lines and
  ceremony cost from `assignedAgent === coordinator` — neither is stored.
- **Staffing vs authorization** — kept separate. `team` is an optional staffing
  pin (`null` = coordinator staffs freely; assigning outside it needs an audited
  `overrideReason`). Authorization is independent: an agent may read a mission
  iff it has a task on it or is the coordinator.
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
- **Autonomy** — Gate 1 (`planned → active`) may auto-approve under
  `{ maxEstimatedUsd, maxTasks }`, off by default. **Gate 2 (`review → done`) can
  never be auto-approved by any policy.**
- **Retries** — side-effecting tools are flagged in the registry. A run that
  fired none may auto-retry; a run that did is marked needs-human-requeue.
  Capacity failures never consume retry budget.
- **Tenancy** — per [ADR 0002](docs/adr/0002-single-tenant.md) the **deployment
  is the tenant boundary**. There is **no `scopeId`** and no user/team scope —
  see DEC-008.

## 4. Scope

**In scope:** the three entities and state machine; repo on the existing table;
`missions:write` + the agent-access predicate; a mission sub-router with a
service layer; coordinator planning and staffing; task authoring; mission
list/detail UI; two approval gates with the Gate-1 auto-approve policy; task
execution with failure taxonomy, bounded retries, side-effect-gated retry,
heartbeat and cancellation; derived artifacts and evidence gates; audit
coverage; agent-access tests; retention; one DLQ alarm.

**Out of scope (deliberately):** any `scopeId` / user or team scoping · data
migration (legacy rows are archived in place, not converted) · multi-tenant PK
refactor · sprints/milestones · cross-mission dependencies · templates · search
index · notifications · value/ROI reporting · Playwright/browser E2E · Step
Functions or any workflow engine · event sourcing/CQRS · any new AWS service
beyond one CloudWatch alarm.

Do not expand V1 because a capability would eventually be useful. Add it to
[the backlog](docs/missions-v2-backlog.md) under a later milestone instead.

## 5. Non-negotiable rules

1. **Authorization is server-side and identity comes from the authenticated
   principal** — never from a request body or query parameter. The approver
   identity is derived from the principal, never from a request field.
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
- **No `scopeId`.** Missions are scoped by participating agents, not by users or
  teams. See DEC-008.
- **Agent access** — read a mission iff you have a task on it or are the
  coordinator; write a task iff assigned or coordinator; transition/cancel is
  coordinator-or-human. Replaces today's self-only rule, which blocks
  collaboration.
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

- Design grilling complete — DEC-008..016 recorded in §15. Every previously
  blocked question is now answered.
- Adversarial production security audit — [docs/security-findings-2026-08-11.md](docs/security-findings-2026-08-11.md)

**In progress** — none.

**Next** — two independent tracks:
1. **Security hotfix (urgent, unrelated to Missions)** — the four findings in
   §16. `GET /api/config/*` is a live credential exposure to the lowest
   privilege tier and should be first.
2. **Missions v2** — `MISSION-011` (domain types + state machine), then
   `MISSION-012`. The backlog still describes the pre-grilling design in places;
   reconcile it against §3 and DEC-008..016, which are authoritative.

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

**DEC-008 — Missions are the container for multi-agent collaboration; there is
no `scopeId`.** Why: Netzer's four collaboration primitives are all messaging or
memory, so durable multi-agent work has no home. A Mission is scoped by which
agents work on it. An earlier draft added a `scopeId` "because it is free now" —
wrong: no grouping concept exists to map it onto (`UserProfile` has no team
field, `Seat` binds one user, PR #42 Workspaces deliberately not ported per
`src/lib/admin/seat-model.ts:4-9`), and the retrofit it avoided is a `GSI1PK`
backfill measured in hours. Consequence: keys are `GSI1PK = MSTATUS#<status>`
for missions and `AGENT#<assignedAgent>#<status>` for tasks — the latter is the
work-pull index and partitions per agent.

**DEC-009 — Staffing and authorization are separate mechanisms.** `team` is an
optional staffing pin (`null` = coordinator staffs freely; outside-pin
assignment needs an audited `overrideReason`), ported from Projects
(`src/dashboard.ts:3520-3528`, coordinator always exempt). Authorization is
independent and hard. Why: fusing them turns a product dial into a security
boundary, so loosening staffing would silently loosen access.

**DEC-010 — The `main` agent is the coordinator.** It triages a mission into
tasks and staffs them; a human approves. Why: `main` is already the hub —
`agent-loader.ts:235` falls back to `BUILTIN_AGENTS.main`, the create route
already defaults `owner = 'main'`, and other builtin prompts say "redirect them
to the main agent". Consequence: the coordinator's plan is LLM output, so the
human gate is its only check.

**DEC-011 — Agent access is derived from having work.** Read a mission iff you
have a task on it or are the coordinator; write a task iff assigned or
coordinator; transition/cancel is coordinator-or-human. Replaces the self-only
`owner === ctx.agentId` rule at `mission-tools.ts:231,288`, which blocks
collaboration. Still refuses an unrelated injected agent (no task → no access).
Consequence: `mission-tools.authz.test.ts` encodes the old rule as a security
contract and must be deliberately rewritten, proving the new predicate still
contains injection.

**DEC-012 — Task kinds are `build | review | fix`.** A `review` with no
`VERDICT:` did not review. `fix` is rework from a failed review, which makes
failure tax visible. Projects' `polish` (needs brand assets Netzer lacks) and
`pm` (derivable from coordinator assignment) are not ported.

**DEC-013 — Gate 1 may auto-approve; Gate 2 never can.** Policy
`{ maxEstimatedUsd, maxTasks }`, off by default. Taken from Projects
(`src/db.ts:3516` — "Gate 2 … is NEVER auto-approved"). Why: auto-approving a
plan risks bounded spend; auto-approving output means nobody looked at it. Bound
is USD rather than Projects' "sessions" because Netzer already meters spend.

**DEC-014 — Side-effecting tools are flagged; retry is gated on them.** Add
`sideEffecting: true` to handlers that touch the outside world (email,
Salesforce). `ToolRegistry.invoke` already wraps every dispatch, so it records
whether a run fired one. Runs that fired none auto-retry; runs that did are
marked needs-human-requeue. Capacity failures fail before doing work, so they
always requeue and never consume retry budget. Alternatives (per-call
idempotency keys, effect staging) deferred — larger, and this is honest about
where we cannot retry safely.

**DEC-015 — No data migration.** Legacy flat mission rows stay in the table,
readable and untouched; new missions are written in the new shape only. Why:
the board was never really used in production. Consequence: MISSION-013 loses
its dual-read shim — the riskiest task in the backlog — and rollback is trivial
because nothing is rewritten. Revisit only if real legacy missions are found.

**DEC-016 — Workflow coverage is integration tests, not Playwright.** Drive
create → plan → approve → execute → review → complete through the API against
LocalStack via `vitest.integration.config.ts`, which CI already runs. Why:
`@playwright/test` is not a dependency, there is no `e2e` script and no workflow
runs the two orphaned configs; adopting it would make a half-abandoned tool
everyone's problem, for UI coverage that is about to change anyway.

**DEC-007 — No separate architecture document.**
Why: audit §8–§13 plus ADR 0009 already specify domain, state, execution, AWS,
security and reliability. A fourth doc would be a second copy to keep in sync,
against this repo's own "numbers live in one place" discipline.

## 16. Known issues

### Live security findings — see [docs/security-findings-2026-08-11.md](docs/security-findings-2026-08-11.md)

An adversarial audit of the `production` source (6 dimensions, each finding
attacked by an independent skeptic) returned **26 surviving findings, 5
refuted**. These are **pre-existing**, present in the deployed environment, and
NOT introduced by the Missions work. The four that matter most:

1. **CRITICAL — `GET /api/config/*` has no capability gate and returns live
   secrets in plaintext.** `handler.ts:2160,2178,2186`. A `seat-user` (whose
   entire capability set is `dashboard:read` + `usage:self:read`) can read
   OAuth/Salesforce refresh tokens, Slack client and per-agent signing secrets,
   and MCP bearer tokens. The router-wide gate only covers non-GET `/config`
   (`handler.ts:236`), so the GET comparison is `0 < 0` — always false. The
   leaked per-agent Slack `signingSecret` is the value verified at
   `src/adapters/slack/handler.ts:270`, turning a viewer-tier read into inbound
   event forgery. The SPA never calls `/api/config`, so gating it breaks nothing.
2. **HIGH — Jarvis `ROLE_RANK` bypass.** Fixed on `hotfix/missions-authz`,
   **not yet in production**.
3. **HIGH — any Telegram user can disable the Bedrock injection guardrail** via
   the ungated `/warroom` slash command (`src/agent/commands.ts:180`); War Room
   turns run `skipGuardrail: true` (`warroom/orchestrator.ts:223`) and the tool
   blocklist (`warroom/tool-policy.ts:6-10`) omits `ask_agent` and `log_to_hive`.
4. **HIGH — `dynamodb_query` binds reads to the agent partition but not the
   chat** (`src/lib/tools/dynamodb-tools.ts:110-115`); `ctx.chatId` is never
   referenced, so cross-chat memory and session transcripts are readable. Sibling
   tools (`memory-tools.ts`, `schedule-tools.ts`) all filter on `ctx.chatId`.

None of these is scheduled in the Missions backlog. **They need their own
hotfix branch and should not wait on Missions v2.**

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

## 18. Git and deployment state

Branch and environment rules: [development.md § Feature handoff](development.md#feature-handoff-handoffmd).
**"Production" alone is never a sufficient statement of intent** — name the
branch, and name the AWS environment it does or does not reach.

### Branch: `hotfix/missions-authz`

| | |
|---|---|
| Branched from | `production` |
| Head | `a44d072` |
| Merges into next | **`production`**, then backport to `development` and promote normally (`CONTRIBUTING.md`) |
| AWS environment on merge | production — stack `CCE`, resources `claudeclaw-*` |
| Pushed? | **No.** Local only |
| PR open? | **No** |
| Deployed? | **No.** Merging to `production` deploys nothing; `deploy.yml` is manual dispatch and requires typing `deploy` |

Commits: `74c74be` Jarvis capability gate · `de5ea42` central tool audit ·
`a44d072` mission audit events.

Because this branch has not been pushed, **all three security fixes are absent
from the deployed production environment.**

### Branch: `feature/missions-v2`

| | |
|---|---|
| Branched from | `development` (`72888fe`) |
| Head | `ebd9bf7` |
| Merges into next | **`development`** → then `qa` → `staging` → `production` |
| AWS environment on merge | **none.** `development` and `qa` deploy nowhere |
| Pushed? | **No.** Local only |
| PR open? | **No** |
| Deployed? | **No** — documentation only, nothing deployable |

Contents: this file, `development.md` (feature-handoff rules),
`docs/missions-v2-audit.md`, `docs/missions-v2-backlog.md`,
`docs/adr/0009-mission-container-model.md`, `docs/adr/README.md` index entry.
**No source, infrastructure, or web changes.**

### Environments

| Environment | Reached from | Stack | Resources | State |
|---|---|---|---|---|
| staging | `staging` branch, manual dispatch `env: staging` | `CCE-STAGING` | `claudeclaw-staging-*` | untouched by this work |
| production | `production` branch, manual dispatch `env: prod` | `CCE` | `claudeclaw-*` | untouched by this work |

**Migrations:** none written, none run.
**AWS:** nothing deployed, no `cdk deploy`, no `deploy:cloud`, no AWS credentials
used at any point in this work. Every finding about "production" in the audit was
derived by reading the `production` branch source, which is byte-identical to
`development` (verified: empty `git diff` over `src`, `infra`, `web`, `scripts`).
The live AWS account has **not** been scanned, so configuration drift outside CDK
is unassessed.

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
