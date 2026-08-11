# Missions v2 — implementation backlog

Executable work packages for the architecture in
[ADR 0009](adr/0009-mission-container-model.md). The
[audit](missions-v2-audit.md) is dated evidence, not an executable authority.

## Reconciled current truth (2026-08-11)

**Source is authoritative.** The verified Missions source snapshot is commit
`d767a36` (`docs(missions): merge Missions v2 audit, architecture, backlog and
handoff`), reachable from both `development` and
`origin/production`. This is a Git merge-state observation, **not** deployment
evidence: the repository contains no evidence that Missions v2 was deployed.

[ADR 0009](adr/0009-mission-container-model.md) is the durable authority. Its
accepted decision is **no `scopeId`, no migration**: legacy flat rows remain
untouched and readable, and new Missions use the new shape only. The audit
retains earlier, superseded recommendations for traceability; its current
disposition is recorded there.

The former hotfix entries MISSION-001 through MISSION-003 are historical claims,
not completed work: each is `claimed_unverified`, has no reachable commit, and
is absent from verified current source. They are not active work packages.

Each task is independently completable and reviewable. Work in dependency order.
A task is **Complete** only when implementation, tests, typecheck, acceptance
criteria and the `handoff.md` update are all done — generated code alone is not
completion.

**Verified file paths** are marked ✅. **Speculative** paths (files that do not
exist yet) are marked ⬜ and are proposals, not facts.

**Repo rules that apply to every task:** run the FULL `npm test` before pushing
(stated in both `CLAUDE.md` and `CONTRIBUTING.md`); relative imports end in `.js`
(`NodeNext`); TypeScript is `strict` with `noUnusedLocals`/`noUnusedParameters`;
there is **no** lint or format tooling in this repo, so do not add a `lint` step
to a definition of done.

---

## Status summary

| ID | Name | Milestone | Status |
|---|---|---|---|
| MISSION-001 | Gate Jarvis reads on capabilities | Historical hotfix claim | Claimed implemented — unverified |
| MISSION-002 | Central audit in ToolRegistry | Historical hotfix claim | Claimed implemented — unverified |
| MISSION-003 | Audit mission mutations | Historical hotfix claim | Claimed implemented — unverified |
| MISSION-010 | Record verified baseline | 0 | Evidence recorded |
| MISSION-011 | Domain types + state machine | 1 | Not Started |
| MISSION-012 | Mission repo on the existing table | 1 | Not Started |
| MISSION-014 | Mission authorization predicate + mutation authority | 1 | Not Started |
| MISSION-015 | Mission sub-router | 2 | Not Started |
| MISSION-016 | Task authoring | 2 | Not Started |
| MISSION-017 | Mission list + detail UI | 2 | Not Started |
| MISSION-018 | Approval gates + event timeline | 2 | Not Started |
| MISSION-019 | Dispatch ready tasks | 3 | Not Started |
| MISSION-020 | Execute tasks in queue-drain | 3 | Not Started |
| MISSION-021 | Failure taxonomy + retry ladder | 3 | Not Started |
| MISSION-022 | Heartbeat + orphan sweep | 3 | Not Started |
| MISSION-023 | Injected mission contract | 3 | Not Started |
| MISSION-024 | Derived artifacts + evidence gates | 3 | Not Started |
| MISSION-025 | Cancellation propagation | 3 | Not Started |
| MISSION-026 | Full mission audit coverage | 4 | Not Started |
| MISSION-027 | Mission authorization-boundary tests | 4 | Not Started |
| MISSION-028 | Soft delete + retention | 4 | Not Started |
| MISSION-029 | Cost attribution by task kind | 4 | Not Started |
| MISSION-030 | UX states + progress | 5 | Not Started |
| MISSION-031 | Integration tests (LocalStack) | 6 | Not Started |
| MISSION-032 | E2E happy + failure paths | 6 | Not Started |
| MISSION-034 | DLQ depth alarm | 6 | Not Started |

---

# Historical hotfix claims — current disposition: unverified

The following records are preserved audit evidence. The cited commits
`74c74be`, `de5ea42`, and `a44d072` are not reachable from this repository, and
the cited `hotfix/missions-authz` branch does not exist here. Verified current
source does not contain these implementations. Do not treat any claim below as
complete, shipped, merged, deployed, or recoverable; choose and approve fresh
work before reimplementation or evidence recovery. See
[the reconciliation](#reconciled-current-truth-2026-08-11).

## MISSION-001 — Gate Jarvis reads on capabilities, not just role rank

**Historical claim:** claimed implemented, unverified · cited commit `74c74be` (unreachable)

**Objective.** Close a privilege escalation where a principal reads by voice what
it is 403'd from on HTTP.

**Why.** `authorizeRead` gated only on `ROLE_RANK`. `roleForProfileId` resolves
any profile that does not hold a full legacy role template down to `viewer`,
which includes `seat-user` (`dashboard:read` + `usage:self:read`, and none of the
per-tab reads). A seat user correctly denied `GET /api/missions` could read every
agent's missions — and every other viewer-tier resource — through the Jarvis
`query` tool.

**Existing implementation.** ✅ `src/lib/jarvis/authorize-read.ts`,
✅ `src/lib/jarvis/route-manifest.ts`, ✅ `src/adapters/dashboard/jarvis.ts`,
✅ `src/lib/auth/route-capability.ts`.

**Implementation.** `ResourceMeta` gained a `capability` field carrying the
capability the resource's HTTP twin enforces. `authorizeRead` requires it in
addition to `minRole` and became async to resolve custom profiles through the
existing `principalHasRouteCapability` helper.

Both walls are kept because they disagree in opposite directions: `audit:read` is
viewer-tier in `permissions.ts` while `audit` is operator-tier in the manifest
(role wall keeps a viewer out); `seat-user` clears the viewer rung while holding
no per-tab read (capability wall keeps it out). Requiring both is always at least
as strict as either alone.

Capabilities were mapped to what each HTTP route actually enforces. `/api/notifications`,
`/api/addons` and `/api/tier` carry **no** capability gate, so they map to
`dashboard:read`; naming a narrower capability would make Jarvis stricter than
HTTP, a behaviour change rather than a fix.

**Acceptance criteria.** ✅ A `seat-user` principal is denied `missions` and every
resource whose capability it lacks. ✅ A full viewer still passes every
viewer-tier resource. ✅ Every resource declares a capability. ✅ All 92 Jarvis
tests pass.

**Risks.** Mis-mapping a capability silently narrows access — mitigated by the
"still allows a full viewer everything at viewer tier" test.

## MISSION-002 — Central audit in ToolRegistry.invoke

**Historical claim:** claimed implemented, unverified · cited commit `de5ea42` (unreachable)

**Objective.** Make "which agent used which tool on whose behalf" answerable from
the audit log for every tool.

**Why.** ✅ `src/lib/tools/registry.ts` emitted four EMF metrics and zero audit
rows. Only 5 of ~20 tool modules self-audited, so `create_mission`, every
`memory_*`/`vector_*` tool and every MCP tool left no durable trail.

**Implementation.** A private `#audit` helper on `ToolRegistry` writes the
existing `tool_invoke` action on every dispatch path: success, handler-returned
error, thrown error, unknown tool, and allowlist denial. Denials record
`result: 'blocked'` rather than `'error'` — that is the row an operator filters
for when hunting prompt injection. Tool **arguments are deliberately not
recorded**: they are model-generated and can carry secrets the redactor does not
cover.

**Acceptance criteria.** ✅ Each dispatch path emits exactly one row with actor,
tool name, latency and outcome. ✅ Denial records `blocked`. ✅ A serialized row
never contains argument values.

**Risks.** Audit rides the same `ddb()` singleton, so suites counting DDB sends
see an extra call — ✅ `src/lib/tools/dynamodb-tools.test.ts` was updated to stub
the writer. Future suites asserting send counts must do the same.

## MISSION-003 — Audit mission create, status change and reassign

**Historical claim:** claimed implemented, unverified · cited commit `a44d072` (unreachable)

**Why.** None of the four mission routes wrote an audit row, so "who cancelled
this mission" was unanswerable — while `seat_created` and
`alert_recipient_added` both audited.

**Implementation.** Added `mission_created` / `mission_status_changed` /
`mission_reassigned` to the action union in ✅ `src/lib/audit/audit-writer.ts` and
emitted them from the three mutating routes in
✅ `src/adapters/dashboard/handler.ts`. `mission_created` records whether the
owner was named explicitly or chosen by Haiku auto-assign, because auto-assign
feeds attacker-influenced text to a model that then selects an owner.

**Deliberately not done.** Cross-agent `create_mission` is **not** blocked.
Delegation and auto-assign are the designed behaviour of the tool; a self-only
rule would break both and an attacker could bypass it by omitting `owner`. The
gap was attribution, not authorization.

---

# Milestone 0 — Baseline

## MISSION-010 — Record the verified baseline

**Historical status:** Evidence recorded; this is not a claim that the proposed
Missions v2 runtime is complete.

**Objective.** Establish what passes *before* any change, so pre-existing
failures are never mistaken for regressions.

**Findings (2026-08-11, `origin/production` clean):**

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm test` | **1 file / 2 tests failed**, 1926 passed (1928) |

The 2 failures are ✅ `src/adapters/dashboard/jarvis.flow.test.ts` —
*"drives a navigate tool_call and writes a jarvis_navigate audit row"* and
*"forwards a show_card tool_call to the browser and reports ok to the model"*.
**They pass when that file is run in isolation**, so this is cross-file test
pollution, and it is present on untouched `production`.

**Any future run showing exactly these 2 failures is at baseline, not regressed.**

Not verified and must not be assumed: `npm run lint` and `npm run format` **do
not exist** (no ESLint/Prettier/Biome/editorconfig in the repo); `npm run e2e`
does not exist (Playwright configs are present but `@playwright/test` is not a
dependency and no workflow runs them); `npm run test:integration` requires
LocalStack via `docker compose -f docker-compose.test.yml`.

---

# Milestone 1 — Foundation

## MISSION-011 — Mission domain types and state machine

**Goal.** A pure, dependency-free module defining Mission / MissionTask /
MissionEvent and the legal transitions.

**Why.** Business logic is currently spread across route handlers and the repo,
with no service layer — the root cause of authorization being enforced
inconsistently at three layers.

**Existing.** ✅ `src/lib/state/mission-tasks-repo.ts` (types to supersede).

**Implementation.** Define the entities from
[audit §9](missions-v2-audit.md#9-target-domain-model). Export
`canTransition(from, to)` and a `MISSION_STATES` / `TASK_STATES` const array with
types derived from it — matching the existing `MISSION_STATUSES` pattern so the
runtime list and the type cannot drift. No I/O, no AWS imports.

**Files.** ⬜ `src/lib/missions/types.ts`, ⬜ `src/lib/missions/state.ts`,
⬜ `src/lib/missions/state.test.ts`.

**Dependencies.** None.

**Testing.** Every legal transition allowed; every illegal one refused; terminal
states have no outgoing edges; `draft → planned` refused with zero tasks;
`cancelled` reachable from every non-terminal state and from no terminal one.

**Acceptance.** Table-driven test enumerating the full transition matrix passes.
`npm run typecheck` clean. No import outside the module except `node:crypto`.

**Risks.** Over-modelling. Six mission states and five task states is the ceiling;
adding one requires an ADR note.

## MISSION-012 — Mission repository on the existing table

**Goal.** Persist the three row types in `claudeclaw-mission-tasks` with no CDK
change.

**Why.** `ownerAgent` in the partition key forces a non-transactional
cross-partition move on reassign and a 200-row list-and-prefix-scan on every
mutation.

**Existing.** ✅ `src/lib/state/mission-tasks-repo.ts`, ✅ `src/lib/state/ddb.ts`,
✅ `infra/lib/dynamo-stack.ts` (table + `gsi1-status-agent-priority`).

**Implementation.** Keys per audit §9. Reassign becomes a single-item
`UpdateCommand` on the attribute plus the GSI1 segment. Reads validate `status`
against the runtime list instead of casting — `toMission()` currently trusts
whatever is in the table.

**Files.** ⬜ `src/lib/missions/repo.ts`, ⬜ `src/lib/missions/repo.test.ts`.

**Database.** New SK prefixes in the existing table. GSI1 repurposed. **No CDK
change** — PK/SK are generic strings and GSI1 keys on generic attributes.

**Dependencies.** MISSION-011.

**Testing.** Unit with a mocked `ddb()`: key construction for all three row
types; `getMission` returns tasks and events in one query; reassign issues one
`UpdateCommand` and no delete; an unknown persisted status is rejected rather
than cast.

**Acceptance.** No `DeleteCommand` on the reassign path. No call site lists >1
page to find a mission by id. `cdk synth` output byte-identical to baseline.

**Risks.** Getting the GSI1 value format wrong strands rows outside every query.
Assert the exact composed strings in tests.

## MISSION-014 — Mission authorization predicate and mutation authority

**Goal.** Implement ADR 0009's authorization boundary: an agent may read a
mission when it has a task on that mission or is the coordinator; it may update
a task when assigned to it or when it is the coordinator. Mission transitions
and cancellation remain coordinator-or-human actions.

**Why.** Staffing (`team`) is an optional, audited product pin and must not be
used as authorization. There is no user, team, or workspace scope on a Mission.

**Existing.** ✅ `src/lib/auth/permissions.ts` (`Capability`, profile sets),
✅ `src/lib/auth/route-capability.ts`.

**Implementation.** Put the Mission predicate in the shared service layer so
routes and agent tools make the same decision. Preserve the human/coordinator
transition gate and require an audited override reason for assignment outside a
team pin. Do not add a `scopeId`, a scope-derivation module, or a legacy-row
migration.

**Files.** ⬜ `src/lib/missions/service.ts`, ⬜ `src/lib/missions/service.test.ts`.

**Dependencies.** MISSION-011, MISSION-012.

**Testing.** A task assignee and coordinator can read as allowed; an unrelated
agent is denied; only the assignee or coordinator can update a task; and only a
coordinator or human can transition or cancel. An assignment outside a team pin
requires and records an override reason.

**Acceptance.** Routes and agent tools share one tested predicate. Staffing
never becomes an ACL, and Mission persistence contains no `scopeId`.

**Risks.** A route-specific check can drift from tool authorization; exercise
both callers against the shared service.

---

# Milestone 2 — Core mission experience

## MISSION-015 — Mission sub-router

**Goal.** Missions get a dedicated Hono sub-router with the service layer between
routes and repo.

**Why.** Missions currently live on the catch-all dashboard router, unlike
seats/warroom/compliance which have their own.

**Existing.** ✅ `src/server.ts` (mount order — specific routers must precede the
`/api` catch-all), ✅ `src/adapters/dashboard/handler.ts` (routes to migrate),
✅ `scripts/mission.ts` (broken: sends `?agent=` where the route reads `owner`;
calls `GET /api/missions/:id`, which has never existed).

**Implementation.** `buildMissionsRouter()` following the warroom/seats pattern.
Routes: list by mission status and caller authorization, get one with tasks and
events, create, transition, update. Authorization in the service layer so agent
tools share it. Fix or delete
`scripts/mission.ts` in the same change.

**Files.** ⬜ `src/adapters/dashboard/missions.ts`, ⬜ `src/lib/missions/service.ts`,
✅ `src/server.ts`, ✅ `scripts/mission.ts`.

**Dependencies.** MISSION-012, MISSION-014.

**Testing.** Route contract tests — none exist today. Every route: 401
unauthenticated, 403 without capability, 200 with. Invalid transition → 409.
Unknown mission → 404.

**Acceptance.** Router mounted before the catch-all. Every route capability-gated.
`scripts/mission.ts` works against the live API or is removed.

**Risks.** Mount-order mistakes shadow routes silently — assert ordering in a test.

## MISSION-016 — Task authoring

**Goal.** A human can add, edit, reorder and remove tasks on a `draft`/`planned`
mission.

**Why.** Manual authoring must work before generated planning. Usability before
automation.

**Dependencies.** MISSION-015.

**Testing.** Tasks cannot be added to a terminal mission. Sequence stays stable
across reorder. Editing a `running` task's prompt is refused.

**Acceptance.** Full task CRUD on non-terminal missions; refused on terminal ones.

## MISSION-017 — Mission list and detail UI

**Goal.** Replace the per-agent kanban with a scope-wide list plus a detail view.

**Why.** ✅ `web/src/pages/Missions.tsx` fans out one request per agent and filters
client-side because no cross-agent list route exists. MISSION-015 makes that
unnecessary.

**Existing.** ✅ `web/src/pages/Missions.tsx`, ✅ `web/src/lib/api.ts`,
✅ `web/src/components/` (`Skeleton`, `ErrorState`, `Badge`, `Modal`, `Toast`).

**Implementation.** List queries by scope+status. Detail shows outcome, tasks,
timeline and artifacts. Reuse existing components; do not introduce a UI library.

**Dependencies.** MISSION-015, MISSION-016.

**Acceptance.** No client-side fan-out remains. `npm --prefix web run typecheck`
and `build` pass.

**Risks.** Scope creep into a general redesign. Only the Missions page changes.

## MISSION-018 — Approval gates and event timeline

**Goal.** `planned → active` and `review → done` require an explicit human action,
each recorded as a MissionEvent.

**Why.** "Done" currently means someone dragged a card. Enterprise needs an
attributable approval.

**Dependencies.** MISSION-015, MISSION-017.

**Security.** The approver is the authenticated principal, never a request-body
field. This is exactly the mistake ClaudeClaw made — see
[audit §6](missions-v2-audit.md#6-do-not-port) item 2.

**Testing.** Gate transitions require the capability. The recorded approver
matches the authenticated principal and ignores any body-supplied identity.

**Acceptance.** Both gates emit a MissionEvent and an audit row naming the
principal. A body-supplied approver identity is ignored.

---

# Milestone 3 — Agent execution

## MISSION-019 — Dispatch ready tasks on activation

**Goal.** Activating a mission enqueues its ready tasks durably.

**Existing.** ✅ `src/lib/scheduler/eb-scheduler.ts`,
✅ `src/lib/scheduler/queue-drain.ts`, ✅ `infra/lib/messaging-stack.ts`
(`claudeclaw-scheduled-fire` + DLQ, `maxReceiveCount: 5`).

**Implementation.** Enqueue `{ kind: 'mission_task', missionId, taskId }` to the
**existing** queue. Add a `kind` discriminator to the drain; absent `kind` means
the legacy scheduled-task payload, so in-flight messages keep working.

**AWS.** None. Reusing the queue avoids a parallel architecture.

**Dependencies.** MISSION-012, MISSION-018.

**Testing.** Activation enqueues one message per ready task and none for blocked
ones. A legacy payload without `kind` still routes to the scheduled-task handler.

**Risks.** A malformed discriminator could black-hole scheduled tasks. Test the
legacy path explicitly.

## MISSION-020 — Execute mission tasks in queue-drain

**Goal.** A dispatched task runs an agent turn and persists its result.

**Existing.** ✅ `src/lib/scheduler/queue-drain.ts` (claim → run → deliver → mark),
✅ `src/agent/agent-loop.ts`.

**Implementation.** Claim with `ConditionExpression` on `status = 'queued'`, so
at-most-once does not depend on a single-claimer invariant — the flaw in
ClaudeClaw's boot-time blanket requeue. Run the turn, persist result, emit a
MissionEvent, enqueue the next ready task.

**Dependencies.** MISSION-019, MISSION-023.

**Testing.** Two concurrent claims: exactly one wins, the loser does not run.
A crash between claim and result leaves the task recoverable (MISSION-022).

**Acceptance.** Under concurrency a task executes at most once. Results persist
with the run's agent and timing.

## MISSION-021 — Failure taxonomy and bounded retry ladder

**Goal.** Provider capacity walls do not consume a task's retry budget.

**Why.** The best idea in either repo. Without it a queue burns its entire retry
budget into the same wall — the reason ClaudeClaw built the distinction.

**Implementation.** Classify before completing: capacity failure → requeue with
`notBefore`, retry count untouched; task failure → bounded ladder with backoff;
empty/evidence-less output → empty run. Adopt the length-guarded classifier
(short output **and** a limit pattern) so a long deliverable that merely discusses
rate limits is not misclassified.

**Do not port** the local-timezone reset parsing or the fleet-wide cooldown — in a
shared deployment one credential's wall must not halt everyone.

**Dependencies.** MISSION-020.

**Testing.** Capacity failure leaves retry count unchanged. Task failure
increments and stops at the cap. A long result mentioning rate limits is **not**
classified as capacity.

**Blocked on open question:** retries re-run agent turns with real side effects
and no idempotency key. Decide idempotency keys vs effect staging **before**
merging.

## MISSION-022 — Heartbeat and orphan reconciliation

**Goal.** A task whose executor died returns to the queue; a slow-but-live task
never does.

**Implementation.** Renew `heartbeatAt` while running. A sweep guarded by the
existing ✅ `src/lib/state/runner-lease.ts` reclaims stale rows, gated on
heartbeat age **and** start age **and** the sweeping process's own in-flight set —
all three layers, which is what makes ClaudeClaw's version safe.

**Note.** `runner-lease` is deliberately **fail-open** (a store error returns
`true`). Acceptable for a sweep guarded by the three checks above; do not assume
it is a mutex.

**Testing.** A live task with a fresh heartbeat is never reclaimed. A task stale
past the threshold is. A process never reclaims its own in-flight task.

## MISSION-023 — Injected mission contract

**Goal.** Outcome, scope and deliverable format reach the executing agent from the
database, appended last.

**Why.** *"Prose in a persona fails under load; an injected block does not."*
Constraints must not survive only as an intermediate model's paraphrase.

**Dependencies.** MISSION-012.

**Testing.** The contract block is present and last in the assembled prompt. A
mission with no outcome still produces a valid prompt.

**Security.** Mission text is user/agent-supplied and crosses into an agent's
context — see the residual-risk note in
[audit §12](missions-v2-audit.md#12-security-and-multi-tenancy). Bound its length
and strip control characters.

## MISSION-024 — Derived artifacts and evidence gates

**Goal.** Artifacts are parsed from `DELIVERABLE:` lines; a review task with no
`VERDICT:` is not accepted as a review.

**Why.** Derived-not-declared means no second bookkeeping system to drift.

**Implementation.** Parse on read; do not persist an artifact row in V1.

**Testing.** Multiple deliverable lines yield multiple artifacts. A review with no
verdict is rejected. A non-review task is not verdict-gated.

**Risks.** Substring matching is a weak contract — ClaudeClaw flags this
limitation honestly in its own docs. Acceptable for V1; revisit with structured
output.

## MISSION-025 — Cancellation propagation

**Goal.** Cancelling a mission stops queued and running tasks without clobbering a
result that landed first.

**Implementation.** The runner re-reads the row as source of truth before writing
a result, and a terminal-state guard prevents a post-completion side-effect throw
from reverting a completed task.

**Testing.** Cancel between claim and result does not produce a `completed` task.
A result landing just before cancel is preserved.

---

# Milestone 4 — Enterprise controls

## MISSION-026 — Full mission audit coverage

**Goal.** Every mission lifecycle event is auditable, including execution.

**Existing.** ✅ `src/lib/audit/audit-writer.ts` (MISSION-003 added three actions).

**Implementation.** Extend to task execution, approvals, failures and retries.
Evaluate whether approval events belong in `ALWAYS_AUDITED_ACTIONS` so they
survive the `audit_log_disabled` kill switch.

**Acceptance.** An administrator can answer all of: who created, who approved,
which agent ran what, what was produced, what failed, what was retried, who
accepted.

## MISSION-027 — Mission authorization-boundary tests

**Goal.** Prove that Mission access follows ADR 0009's task/coordinator
predicate, not a caller-supplied boundary or staffing pin.

**Why.** No Mission authorization test exists at the HTTP layer today, and
✅ `src/adapters/dashboard/authz-matrix.test.ts` — the file named for authz
coverage — has no mission entries.

**Testing.** An unrelated agent is denied read, task update, transition, and
cancel. A task assignee has only the task-level authority granted by ADR 0009;
the coordinator and human have their distinct authorities. A team pin cannot
grant read access, and an outside-pin assignment requires the audited override.

**Acceptance.** Every Mission route has an authorization-boundary denial test and
entries in `authz-matrix.test.ts`; no test or implementation introduces
`scopeId`.

## MISSION-028 — Soft delete and retention

**Goal.** Cancelled and completed missions are retained under an explicit policy.

**Why.** The table has a `ttl` attribute that **no repo code ever writes**, so
missions are immortal; ClaudeClaw hard-deletes 24h after cancel. Neither is
acceptable for enterprise audit.

**Implementation.** Soft-delete flag plus a deliberate TTL on terminal missions.
Audit rows are never TTL'd with the mission.

**Acceptance.** No hard delete anywhere. Retention configurable. Audit history
outlives the mission.

## MISSION-029 — Cost attribution by task kind

**Goal.** Per-mission cost, split by work / review / defect.

**Existing.** ✅ `src/lib/usage/token-tracker.ts`, ✅ `claudeclaw-token-usage`
(`gsi1-agent-time`).

**Implementation.** Tag usage with the mission and task; derive the split rather
than storing it. Surfaces quality tax and failure tax instead of laundering them
into "work".

**Dependencies.** MISSION-020.

---

# Milestone 5 — UX completion

## MISSION-030 — Progress, artifacts and all UI states

**Goal.** Every state a user can land in is designed: empty, loading, error,
permission-denied, running, failed, awaiting-approval, cancelled, archived.

**Scope guard.** Only the Missions pages. Do not redesign unrelated Netzer UI.

**Acceptance.** No unhandled state renders blank. Permission-denied is distinct
from empty. A failed task shows its reason and retry count.

---

# Milestone 6 — Production hardening

## MISSION-031 — Integration tests on LocalStack

**Existing.** ✅ `vitest.integration.config.ts` (`*.integration.test.ts`,
`fileParallelism: false`), ✅ `docker-compose.test.yml`, ✅ `.github/workflows/ci.yml`
(LocalStack `dynamodb,s3,sqs,kms,secretsmanager,iam,scheduler` already enabled).

**Testing.** Real DynamoDB round-trips for all three row types; GSI1 queries for
Mission status and assigned-agent task status; legacy flat rows remain readable
and untouched; SQS enqueue → drain.

**Acceptance.** `npm run test:integration` passes locally and in CI.

## MISSION-032 — End-to-end happy and failure paths

**Objective.** Cover create → plan → approve → execute → review → complete, plus
capacity failure, task failure with retry exhaustion, and cancel mid-run.

**Blocked on a decision.** Playwright configs exist at
✅ `tests/e2e/jarvis/playwright.config.ts` but `@playwright/test` is **not a
dependency**, there is **no** `e2e` npm script, and **no workflow runs them**.
Either adopt Playwright properly (dependency + script + CI job) or write these as
integration tests. Do not assume an E2E runner exists. In either runner, prove
the task/coordinator authorization boundary and human acceptance gate; do not
add a scope field or legacy-data migration as test preconditions.

---

## Retired IDs (not active work)

| ID | Former package | Disposition | Current truth |
|---|---|---|---|
| MISSION-013 | Migration and dual-read shim | Retired | ADR 0009 accepts no Mission legacy migration. Flat rows remain readable and untouched; new Missions use the new shape only. |
| MISSION-033 | Migration and rollback validation | Retired | It exists only to validate the rejected migration, so it has no remaining purpose. |

## MISSION-034 — DLQ depth alarm on scheduled-fire

**Goal.** A poison mission-task message raises an alarm instead of failing
silently.

**Why.** ✅ `claudeclaw-scheduled-fire-dlq` exists with `maxReceiveCount: 5` but
has **no depth alarm**, unlike the extensions DLQs. Once missions ride this path,
that gap becomes a silent failure mode.

**Existing.** ✅ `infra/lib/observability-stack.ts` (alarm → `claudeclaw-ops-alerts`
SNS pattern), ✅ `infra/lib/messaging-stack.ts`.

**AWS.** One CloudWatch alarm. **The only infrastructure change in this backlog.**

**Testing.** `npx cdk synth` includes the alarm; `npx cdk diff` shows the alarm
and nothing else.

**Risks.** This one task requires a real `cdk deploy` — per `CLAUDE.md`, a full
`cdk deploy` can shift env-backed tunables such as the cost cap, so it must not
be bundled with app-code deploys.
