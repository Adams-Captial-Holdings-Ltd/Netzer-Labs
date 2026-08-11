# Missions v2 — architecture audit

Audit of the Netzer OS **Missions** feature against the **Projects** feature in
the personal ClaudeClaw OS, and a recommendation for what Missions should become.

Every claim about current behaviour below was read out of the code. Findings are
labelled **EXISTS** / **PARTIAL** / **ABSENT**. Where the two systems disagree
with their own documentation, the code wins.

## Current disposition (reconciled 2026-08-11)

This audit is preserved as **dated evidence**, including its failed approaches
and historical claims. It is not the current architectural or delivery
authority. [ADR 0009](adr/0009-mission-container-model.md) is the durable
authority; its accepted decision is **no `scopeId`, no migration**. The active
queue is [the reconciled backlog](missions-v2-backlog.md), and source code is
ultimate truth.

The verified Missions source snapshot is commit `d767a36`, reachable from both
`development` and `origin/production`. The reconciliation changes documentation
only. Those are Git merge-state facts, **not** deployment evidence: the
repository does not establish that Missions v2 was deployed. MISSION-001/002/003
and the `hotfix/missions-authz` branch cited below
are historical claims: their commits are unreachable and their implementations
are absent from verified current source. They must not be described as complete,
shipped, merged, deployed, or recoverable.

- Netzer OS: this repository, branch `development`.
- ClaudeClaw OS: `claudeclaw-os`, branch `main` — a separate personal/OSS system,
  not a fork of this one. Referenced as a source of design lessons only.

---

## 1. Executive recommendation

> **Current disposition — historical recommendation.** The former "Ship" and
> "Done" language in this section is not verified current state. The current
> architecture and active work are governed by
> [ADR 0009](adr/0009-mission-container-model.md) and
> [the reconciled backlog](missions-v2-backlog.md), respectively.

**Reframe the concept, keep the name, port ideas rather than code.**

Missions today is not a mission system. It is a per-agent kanban card: one
DynamoDB row with 11 fields and four statuses, which nothing ever executes. It
should become a **container for a goal** — an outcome, the work toward it, and
what that work produced — with today's flat mission becoming a single task
inside it.

Three things follow, in this order:

1. **Ship the authorization and audit fixes first.** They are live today, they
   are not gated on the redesign, and they are small. Done — see §12.
2. **Reshape the domain before there is production volume.** The table needs no
   infrastructure change to hold the new shape, so this is a code-and-migration
   change, not a deploy-the-platform change.
3. **Wire execution to the durable path that already exists.** Netzer already
   runs EventBridge Scheduler → SQS → an in-Fargate drain with a DLQ and retry
   semantics. Missions should use it rather than acquire a second one.

What we are explicitly **not** doing: adopting ClaudeClaw's implementation,
introducing a `Project` noun, threading `tenantId` through every repository, or
adding an AWS service. The recommendation is deliberately the smallest reshape
that lets the feature hold real work.

---

## 2. Current state — Netzer Missions

### Product model

A user (or an agent) creates a mission from a prompt. Haiku picks an owner agent.
The mission appears as a card in one of four kanban columns on the Missions tab.
A human drags it between columns. That is the whole lifecycle.

There is no notion of a desired outcome distinct from the prompt, no completion
criteria, and no output. "Done" means a human moved a card.

### Domain model — EXISTS, flat

`src/lib/state/mission-tasks-repo.ts` defines one entity:

```
Mission { id, ownerAgent, createdByAgent, createdByChat, title, body,
          priority (0-100), status, assignmentReason?, dueAt?,
          createdAt, updatedAt }
MISSION_STATUSES = open | in_progress | done | cancelled
PK = AGENT#<ownerAgent>   SK = MISSION#<isoCreated>#<id>
GSI1PK = STATUS#<status>#AGENT#<owner>   GSI1SK = PRIORITY#<padded>#<createdAt>
```

**ABSENT:** sub-tasks, artifacts, outcomes, milestones, dependencies, execution
runs, comments, history. There is no second SK prefix under the mission
partition, so there is nowhere to put them without a schema change.

Adjacent but unrelated: `inter-agent-tasks-repo.ts` (a 7-day-TTL DM queue —
`create_mission` posts a note to it, with no foreign key back) and
`hive-mind-repo.ts` (dated notes, `PK = DATE#…`).

### Architecture

| Layer | What exists |
|---|---|
| Frontend | `web/src/pages/Missions.tsx` — Preact, 4-column kanban, create/detail/reassign modals |
| API | Four routes on the catch-all dashboard router (`src/adapters/dashboard/handler.ts`) |
| Service | None. Routes call the repo directly. |
| Persistence | `claudeclaw-mission-tasks`, one GSI (`infra/lib/dynamo-stack.ts`) |
| Execution | **None** |
| Agent tools | `create_mission` / `list_missions` / `update_mission` (`src/lib/tools/mission-tools.ts`) |
| CLI | `scripts/mission.ts` |

Routes:

| Method | Path | Capability | Calls |
|---|---|---|---|
| GET | `/api/missions?owner=` | `missions:read` | `listMissionsForAgent(owner, 100)` |
| POST | `/api/missions` | `agents:write` | `autoAssign()` → `createMission()` |
| POST | `/api/missions/:owner/:id/status` | `agents:write` | `updateMissionStatus()` |
| POST | `/api/missions/:owner/:id/reassign` | `agents:write` | `reassignMission()` |

There is no `GET /api/missions/:id`, no `DELETE`, no cross-agent list and no
status-filtered list. The SPA compensates by fanning out one request per agent
and filtering client-side.

### Strengths

- **The platform underneath is strong.** 32 DynamoDB tables on a uniform
  `PK`/`SK` + `GSI1PK`/`GSI1SK` convention, all pay-per-request with PITR, CMEK
  and `RETAIN`. A durable scheduled-work path with a DLQ. A real capability model
  with seven profiles and custom-profile support. A dual-write audit log with an
  S3 Object-Lock mirror and a break-glass always-audited set. Structured pino
  logging plus EMF metrics, alarms and a dashboard.
- **The table needs no change to hold a better model.** PK/SK are generic
  strings; GSI1 is keyed on generic attributes.
- **Status validation at the route** rejects non-`MissionStatus` values before
  they can corrupt the GSI partition — with a comment recording the incident that
  motivated it.
- **The agent-tool layer already enforces per-agent ownership** on read and
  update, and its tests assert the repo was *not* called, not merely that an
  error came back.

### Weaknesses

- **Missions are inert.** The schema is execution-shaped and nothing executes it.
  `src/agent/scheduler.ts` demonstrates the pattern (conditional-write claim,
  in-flight sentinel, retry) and it was never applied here.
- **Owner is the partition key.** `reassignMission` is a non-transactional
  cross-partition put-then-delete; its own comment concedes a crash leaves a
  duplicate. Both mutation paths list 200 rows and prefix-match in application
  code, so an id-prefix collision hits the wrong record and mission #201 is
  unreachable (returns 404).
- **`toMission()` casts `status` with no runtime validation** — whatever is in
  DynamoDB is trusted on read.
- **TTL is configured on the table but never written**, so missions are immortal
  and there is no retention story.
- **Two authorization mechanisms are live in one middleware** — the capability
  model and a legacy `ROLE_RANK` ladder — which `src/lib/auth/permissions.ts`
  explicitly warns against.
- **Test coverage is 10 unit assertions with all I/O mocked.** No test exists for
  the repo at all, none for any route, none for `reassignMission`'s partial
  failure. `src/adapters/dashboard/authz-matrix.test.ts` — the file named for
  authz coverage — contains no mission entries.
- **`scripts/mission.ts` is shipping and broken.** It sends `?agent=` where the
  route reads `owner`, and calls `GET /api/missions/:id`, a route that has never
  existed. Nothing caught it.

---

## 3. Current state — ClaudeClaw Projects

### Product model

One operator turns a one-line ask into governed, budgeted agent work behind two
human approval gates. Lifecycle:
`new → requirements → awaiting_approval → in_progress → project_review → done`,
with deliberate back-loops and `cancelled`.

A Project is explicitly *"a thin grouping layer over mission_tasks"* — there is
no separate Mission entity. Its work items are ordinary task rows tagged with a
`project_id`, reusing the existing claim/execute path unchanged.

### Domain model — EXISTS

`Project` (lifecycle, budget, team, requirements/plan/synthesis markdown, value
score) → `MissionTask` (prompt, assigned agent, status, result, retry count,
heartbeat, kind ∈ build|review|defect|polish|pm) → `ProjectSprint`.
`ProjectCost` and `Deliverable` are both **derived**, never stored.

### Architecture

SQLite (`better-sqlite3`, WAL) in a single local file shared by ~18 processes.
Preact SPA polling every 8s. Telegram as the only notification transport. Agents
are YAML files on disk. Schema evolution is imperative code in `db.ts`, including
data-rewriting `UPDATE`s that run on every process boot.

### Execution model — the part that works

Two rails over one queue. A `setInterval` worker claims tasks for every agent
that has no process of its own, gated in order by: orphan reconciliation,
in-process concurrency cap (3), fleet budget, capacity cooldown, stall sweep,
cancelled-project purge, starvation fallback, and a per-project spend breaker.
Prompt assembly layers persona, fleet roster, skills, operator preferences, the
task prompt, and finally a server-injected project contract. The agent runs, the
result is classified, and completion is gated on typed evidence.

### Strengths

- **Failure-*kind* taxonomy.** A provider capacity wall is a different failure
  class from a task failure and must not consume the task's retry budget — or the
  whole queue burns into the same wall. This is the best single idea in either
  repo.
- **Sleep-until-stated-reset.** The provider's own reset time is scraped from the
  error text and slept until, clamped to a sane range, instead of exponential
  backoff. Its comment: outages run 4–5h, so blind 30-minute probes would fire
  ~8 useless wake-ups.
- **Length-guarded failure classification.** Output ≤400 characters *and* matching
  a limit pattern is a capacity failure; a long deliverable that merely discusses
  rate limits is not. One constant, precisely placed.
- **Server-injected binding contract, appended last.** Scope, format and exit
  criteria travel from the database to the executing agent rather than through an
  intermediate model's paraphrase. Stated principle: *"prose in a persona fails
  under load; an injected block does not."*
- **Typed evidence gates.** "A review without a `VERDICT:` did not review" turns a
  soft quality norm into a machine-checkable postcondition.
- **Derived-not-declared artifacts.** The evidence line the gate already enforces
  *is* the registry. No second bookkeeping system to drift.
- **Heartbeat + three-layer orphan sweep** (heartbeat gate, `started_at` age gate,
  caller's own in-flight exclude set) — production-grade, correctly reasoned.
- **Cost attribution by task kind** (work / review / defect / ceremony), which
  makes quality tax and failure tax visible instead of laundered into "work".
- **Value score fused into the accept action** — you cannot close the work without
  answering "was it worth it".
- **Stall sweep alongside event triggers**, closing the deadlock blind spot every
  purely event-driven engine has.

### Weaknesses

- **No authorization of any kind.** No user, org, tenant, role or permission
  concept. Auth is one shared bearer token or one cookie session.
- **The only lifecycle authorization predicate is forgeable** — `agent_id` comes
  straight out of the request body, and the frontend hardcodes `'main'`. The code
  half-knows this: clearing a gate as a non-`main` id sends a warning rather than
  refusing.
- **Every agent run uses `permissionMode: 'bypassPermissions'`** plus
  `allowDangerouslySkipPermissions` — unrestricted host tool access per task.
- **A personal Obsidian vault is load-bearing.** Client brand context, deliverable
  resolution and project.md sync all depend on `~/Documents/SecondBrain`.
  Deliverable existence is `fs.existsSync` on local disk.
- **Correctness rests on convention.** "Call this ONCE, from the main process
  only", enforced by a comment, alongside an unguarded blanket requeue at boot.
- **The retry ladder retries non-idempotent work** — agent runs that write files,
  commit to git and send live email, with no idempotency key.
- **Hard-delete purge** of cancelled projects 24h after cancel, no soft-delete.
- **Gate proliferation.** A dozen distinct 409 conditions, several added within
  days of each other — a system still discovering its own rules.

---

## 4. Missions vs Projects capability matrix

| Capability | Netzer Missions | ClaudeClaw Projects | Verdict |
|---|---|---|---|
| Create | EXISTS (prompt → row) | EXISTS (+ duplicate check, type, budget) | Merge — keep Netzer's route, adopt outcome + type |
| Desired outcome / completion criteria | ABSENT | EXISTS (`## Done when`) | **Adopt** |
| Planning / task decomposition | ABSENT | PARTIAL (LLM-driven, no programmatic decomposer) | Adopt shape, human-authorable first |
| Sub-tasks | ABSENT | EXISTS | **Adopt** |
| Milestones / sprints | ABSENT | EXISTS (sprints) | Design for later |
| Dependencies between work items | ABSENT | ABSENT | Do not build |
| Agent assignment | EXISTS (Haiku auto-assign) | EXISTS (explicit + team) | Strong in Missions — keep |
| Multi-agent collaboration | PARTIAL (inter-agent note) | EXISTS (team, kinds) | Design for later |
| Human approval gates | ABSENT | EXISTS (two gates) | **Adopt**, reduced to two transitions |
| Execution | **ABSENT** | EXISTS | **Adopt** onto Netzer's durable path |
| Retries | ABSENT | EXISTS (kind-aware ladder) | **Adopt** |
| Failure taxonomy | ABSENT | EXISTS | **Adopt** — best idea in either repo |
| Timeouts | ABSENT | EXISTS | **Adopt** |
| Cancellation | PARTIAL (status only) | EXISTS (cross-process, polled) | Adopt |
| Resumability | ABSENT | PARTIAL (state durable, run restarts) | Adopt the durable half |
| Heartbeat / orphan recovery | ABSENT | EXISTS (three-layer) | **Adopt** |
| Concurrency control | ABSENT | PARTIAL (per-process only) | Redesign — use conditional claim |
| Idempotency | ABSENT | PARTIAL (claim only, not effects) | Redesign — open question |
| Scheduling | ABSENT for missions; EXISTS platform-wide | PARTIAL | Reuse Netzer's |
| Progress tracking | PARTIAL (column position) | EXISTS (per-task + cost bar) | Adopt |
| Artifacts / deliverables | ABSENT | EXISTS (derived) | **Adopt derived approach** |
| Evidence gates on completion | ABSENT | EXISTS (typed per kind) | **Adopt** |
| Context / memory propagation | ABSENT | EXISTS (layered prompt + injected contract) | Adopt the injected contract |
| Activity history | ABSENT | PARTIAL (implicit) | **Build** — MissionEvent |
| Notifications | ABSENT | EXISTS (Telegram-only, interactive) | Design for later; do not port transport |
| Comments / collaboration | ABSENT | PARTIAL (backlog notes) | Do not build in V1 |
| Permissions | PARTIAL (capability at route, ownership at tool) | **ABSENT** | Strong in Missions — extend |
| Agent membership / access | PARTIAL (self-only, blocks collaboration) | ABSENT (no auth at all) | **Redesign** — access derived from having work on the mission |
| Agent staffing | PARTIAL (Haiku picks one owner) | EXISTS (team pin, coordinator staffs) | **Adopt** Projects' staffing model |
| Tenant isolation | ABSENT by decision (ADR 0002) | ABSENT | Correct as-is — deployment is the boundary |
| Audit logs | Now EXISTS (this work) | ABSENT | Strong in Missions |
| Observability | EXISTS platform-wide, none mission-specific | PARTIAL | Extend Netzer's |
| Cost / usage tracking | EXISTS platform-wide | EXISTS per project, split by kind | **Adopt the by-kind split** |
| Value measurement | ABSENT | EXISTS (score fused into accept) | Design for later |
| Templates | ABSENT | PARTIAL (type defaults) | Design for later |
| Search | ABSENT | ABSENT | Do not build |
| Reporting | ABSENT | EXISTS (deterministic dossier) | Design for later |
| Retention / soft delete | ABSENT (TTL unused) | ABSENT (hard delete) | **Build** |
| Enterprise admin controls | PARTIAL (platform-wide) | ABSENT | Extend Netzer's |

---

## 5. What we should keep

**From Netzer, unchanged:**

- The capability model and its profile templates — including the rule that a
  grant can never exceed the actor's own set.
- The audit writer: dual-write, WORM mirror, always-audited break-glass set,
  PII-redacted detail.
- The DynamoDB conventions — generic `PK`/`SK`, `GSI1PK`/`GSI1SK`, PPR, PITR,
  CMEK, `RETAIN`.
- The durable scheduled-work path and its DLQ; `runner-lease` for periodic loops.
- Hono sub-router composition, pino logging, EMF metrics, the alarm→SNS pattern.
- Haiku auto-assign, including its re-validation of the model's answer against
  the known-agent list.
- Route-level status validation before values reach an index partition.

**From ClaudeClaw, as ideas:**

The failure-kind taxonomy; sleep-until-stated-reset; the length-guarded
classifier; the server-injected binding contract appended last; typed per-kind
evidence gates; derived-not-declared artifacts; heartbeat plus three-layer orphan
sweep; cost split by task kind; the stall sweep; epoch-stamped grandfathering of
new policy so tightening a rule never bricks in-flight work.

---

## 6. Do not port

Everything below stays in ClaudeClaw. Grouped by why.

**Security — would be a vulnerability here**

1. `permissionMode: 'bypassPermissions'` / `allowDangerouslySkipPermissions` on
   every agent run. Netzer's tool allowlist and kill switches are the model.
2. Caller-asserted `agent_id` from the request body as an authorization
   predicate. Netzer authenticates a principal; identity must never come from a
   request body.
3. A single global dashboard token as the identity model.
4. Chat-id string equality as approval authorization.
5. Notification callbacks looping through `127.0.0.1` with the token in the query
   string.

**Personal-system coupling — cannot work in a deployed service**

6. `~/Documents/SecondBrain` as load-bearing storage.
7. `fs.existsSync` as the deliverable-completion gate.
8. Filesystem writes as a side effect of a state transition.
9. A client model encoded as folder naming conventions.
10. Telegram to one hardcoded chat id as the only transport.
11. Agents as on-disk YAML files.
12. launchd/systemd `execSync` process management; local `spawn()` engine
    adapters; a localhost model gateway as the overflow path.
13. Hardcoded operator name and hardcoded agent ids inside gates. Gates need
    role/capability indirection, not literals.

**Would not scale or would corrupt data**

14. SQLite single-file + WAL shared by ~18 processes.
15. "Exactly one worker process, by convention" plus an unguarded blanket requeue.
16. Per-process in-memory concurrency caps — effective parallelism is
    processes × 3 with no global admission control.
17. A fleet-wide capacity cooldown triggered by one account's wall. In shared
    tenancy that is one tenant halting everyone.
18. Wall-clock reset parsing in the machine's local timezone. Adopt the idea, not
    the implementation.
19. Boot-time data-rewriting `UPDATE`s as a migration system.
20. Hard-delete purge of cancelled work — unacceptable for enterprise audit.
21. Plaintext storage of requirements, plans, prompts and results while chat
    bodies are encrypted — inverted sensitivity for what becomes customer data.

**Product-unnecessary**

22. Economics constants derived from one person's 14 days of spend.
23. The vendored `skills/project-management/SKILL.md` — 382 lines of WBS/CPM/EVM
    methodology with zero references from `src/`.
24. Gate proliferation. Adopt two gates, not twelve.

---

## 7. Missing enterprise capabilities

Absent from **both** systems.

### Required for V1

- **Mission-scoped authorization.** Access decided by a scope on the record, not
  by a query parameter.
- **A durable, resumable execution record.** Which run, which agent, what it
  produced, what failed, what was retried.
- **Mission lifecycle history.** Who created, changed, approved, cancelled — an
  append-only per-mission timeline, distinct from the platform audit log.
- **Soft delete and retention.** The table has a TTL attribute that nothing
  writes; ClaudeClaw hard-deletes. Neither is acceptable.
- **Route-level contract tests.** The current mission routes have none, and the
  broken CLI is the evidence of what that costs.

### Important later

- Cost attribution per mission, split by task kind.
- Notifications on approval-needed and failure, on a transport abstraction.
- Concurrency/admission control across tasks.
- Bulk operations and mission search.
- Templates.

### Future / optional

- Cross-mission dependencies, multi-agent negotiation, value/ROI reporting,
  external issue-tracker sync, per-mission budget enforcement.

---

## 8. Product model recommendation

**A Mission is the durable, tracked work container in which several agents
collaborate toward a stated outcome, under human approval.**

This is the framing correction that drove the final design. Netzer already has
four agent-collaboration primitives — `ask_agent`, `inter-agent-tasks`,
`hive-mind` and War Room — and every one is **messaging or memory**. None tracks
work: none has a status, an outcome, artifacts, or a notion of done, and
`inter-agent-tasks` evaporates after 7 days. Missions is the missing durable
work container, which is why its schema looked execution-shaped but inert.

- **Purpose** — give multi-agent work somewhere durable to live, with an
  outcome, a record of who did what, and evidence of what was produced.
- **Scoped by agents, not people.** A Mission is not a user's record and not a
  workspace. It is scoped by which agents are working on it.
- **Core workflow** — a human states the outcome → the **coordinator agent
  (`main`)** triages it into tasks and staffs them → a human approves the plan →
  assigned agents execute → a human watches and intervenes → a review agent
  emits a verdict → a human accepts.
- **Role of agents** — plan, staff, execute, review. An agent never decides a
  mission is complete.
- **Role of humans** — define the outcome, approve the plan, accept the result.
  Two gates, not twelve.
- **Completion** — a human accepts at `review → done`. Task completion is
  machine-checked against per-kind evidence; mission completion is a human act.

---

## 9. Target domain model

Three entities, one existing table, no new GSI, no new AWS service.

| Entity | PK | SK | Responsibility |
|---|---|---|---|
| Mission | `MISSION#<id>` | `META` | Outcome, status, team pin, coordinator |
| MissionTask | `MISSION#<id>` | `TASK#<seq>#<taskId>` | One unit of work + execution state |
| MissionEvent | `MISSION#<id>` | `EVENT#<iso>#<id>` | Append-only history |

```
Mission { id, title, outcome, status, kind?, team: string[] | null,
          coordinator: 'main', autoApproved: boolean, createdBy,
          estimatedUsd?, createdAt, updatedAt, completedAt? }

MissionTask { id, missionId, seq, title, prompt,
              kind: 'build' | 'review' | 'fix',
              assignedAgent, status, result?, error?,
              retryCount, firedSideEffect: boolean,
              notBefore?, heartbeatAt?, startedAt?, completedAt? }

MissionEvent { id, missionId, actor, action, from?, to?, detail }
```

GSI1 is repurposed, not extended:

- Mission rows — `GSI1PK = MSTATUS#<status>`, `GSI1SK = PRIORITY#<pad>#<createdAt>`
- Task rows — `GSI1PK = AGENT#<assignedAgent>#<status>`, same sort key

The task index is the work-pull index an agent needs, and it partitions per
agent instead of concentrating on one key. `ownerAgent` leaves the partition key
entirely, which removes the cross-partition move and the 200-row prefix scan.

**Derived, never stored:** artifacts (from `DELIVERABLE:` lines in results) and
ceremony cost (from `assignedAgent === coordinator`).

**No `scopeId`.** An earlier draft added one "because it is free now". That was
wrong: Netzer has no grouping concept to map it onto — `UserProfile` has no team
field, `Seat` binds one user to a policy, and the PR #42 Workspace entities were
deliberately not ported (`src/lib/admin/seat-model.ts:4-9`). A field permanently
holding `default` is speculative generality, and the retrofit it avoided is a
`GSI1PK` backfill measured in hours.

### Staffing is not authorization

Two concerns, deliberately kept separate:

| | Mechanism | Character |
|---|---|---|
| **Staffing** | `team` — optional pin, `null` = coordinator staffs freely. Assigning outside the pin needs an audited `overrideReason` | Soft product constraint, overridable |
| **Authorization** | Agent may read a mission iff it has a task on it or is the coordinator; may write a task iff assigned or coordinator; transitions are coordinator-or-human | Hard security predicate |

Ported from Projects, which enforces the pin at assignment time with the
coordinator always exempt (`src/dashboard.ts:3520-3528`). Fusing the two would
turn a product dial into a security boundary, so loosening staffing would
silently loosen access.

### State model

```
Mission:  draft -> planned -> active -> review -> done
                     ^__________________|
          cancelled  (from any non-terminal state)

Task:     queued -> running -> completed | failed | cancelled
```

`draft → planned` requires ≥1 task. `planned → active` is the human go-gate.
`review → done` is the human accept-gate. `review → planned` is send-back. A
mission has no `failed` state — its tasks do, which avoids a state whose only job
is to mirror a child.

---

## 10. Target technical architecture

```
Preact SPA  ->  ALB  ->  Hono missions sub-router
                              |
                              +-> mission service (state machine, authz)
                              |        |
                              |        +-> mission repo -> DynamoDB
                              |        +-> writeAudit   -> audit-log + S3 WORM
                              |
                              +-> enqueue -> scheduled-fire SQS
                                                 |
                                          queue-drain (Fargate)
                                                 |
                                    runAgentTurn -> Bedrock
                                                 |
                                          result -> repo + MissionEvent
```

Business logic lives in a mission service module, not in route handlers and not
in the repo — the current code has no service layer at all, which is why
authorization is inconsistent across three layers.

---

## 11. AWS fit

Every component already exists. **Zero new AWS services; zero CDK change for the
data model.**

| Need | Existing resource |
|---|---|
| Persistence | `claudeclaw-mission-tasks` (generic PK/SK, GSI1 on generic attrs) |
| Durable job dispatch | EventBridge Scheduler → `claudeclaw-scheduled-fire` SQS |
| Job execution | `queue-drain.ts` in the Fargate service |
| Failure containment | `claudeclaw-scheduled-fire-dlq` (maxReceiveCount 5) |
| Leader election | `runner-lease` on the `queue-lease` table |
| LLM | Bedrock Runtime + `claudeclaw-default` guardrail |
| Audit | `claudeclaw-audit-log` + `claudeclaw-audit-lock` (Object Lock) |
| Metrics/alarms | EMF + CloudWatch MetricFilter → `claudeclaw-ops-alerts` SNS |

The one infrastructure gap worth closing is a CloudWatch alarm on
`claudeclaw-scheduled-fire-dlq` depth. The queue has a DLQ but no alarm, unlike
the extensions DLQs — so once missions ride this path, a poison message would be
silent.

**Considered and rejected:** Step Functions (multi-step orchestration is not yet
needed and a hand-rolled two-state machine is cheaper to reason about); a second
SQS queue (a message-kind discriminator on the existing one avoids a parallel
architecture); API Gateway (not provisioned — the orphan `execute-api` IAM grant
should be removed, not fulfilled); RDS (DynamoDB is the only persistence and the
access patterns are key-based).

---

## 12. Security and multi-tenancy

> **Current disposition — superseded design.** This section preserves the
> earlier scope-based recommendation and hotfix assertions as audit evidence.
> ADR 0009 rejects a Mission `scopeId` and legacy-data migration. The current
> Mission authorization model is task-assignee/coordinator based; staffing is
> not authorization. See [ADR 0009](adr/0009-mission-container-model.md) and
> [the reconciled backlog](missions-v2-backlog.md#reconciled-current-truth-2026-08-11).

### Isolation boundary

Per [ADR 0002](adr/0002-single-tenant.md), **the deployment is the tenant
boundary** — resource isolation is at the AWS account level. That ADR is Accepted
and explicitly prices the alternative (threading `tenantId` through every PK) at
roughly two weeks plus indefinite ongoing risk, worth it only when the customer
base is large and per-customer revenue small.

The gap that actually matters today is therefore **authorization within a
deployment**. New mission rows carry a `scopeId` from day one — the team/workspace
boundary inside a deployment — because it is free on a new row shape and
expensive to retrofit. It defaults to `default`, which is behaviour-preserving.
No other repository changes.

### Authorization rules

- `scopeId` is derived from the authenticated principal, never from a request
  parameter.
- A dedicated `missions:write` capability, so mission mutation stops sharing
  `agents:write` with every other agent mutation.
- Authorization is enforced in the service layer, which both the routes and the
  agent tools call — closing the gap where the repo is reachable without a check.

### Fixed in this work

Shipped on `hotfix/missions-authz`:

- **Jarvis privilege escalation (highest severity).** `authorizeRead` gated only
  on `ROLE_RANK`, and `roleForProfileId` resolves any profile lacking a full
  legacy role template down to `viewer` — including `seat-user`, which holds no
  per-tab reads at all. A seat user correctly 403'd on `GET /api/missions` could
  read every agent's missions, and every other viewer-tier resource, by voice.
  `RESOURCE_META` now carries the capability its HTTP twin enforces and
  `authorizeRead` requires both walls.
- **No audit on tool dispatch.** `ToolRegistry.invoke` emitted metrics and no
  audit rows; only 5 of ~20 tool modules self-audited. Auditing centrally covers
  every tool including future ones.
- **No audit on mission mutations.** `mission_created` / `mission_status_changed`
  / `mission_reassigned` added and emitted.

### Assessed and deliberately not "fixed"

- **`GET /api/missions?owner=<any>` is not a privilege escalation.** `missions:read`
  is viewer-tier by design and this is a single-tenant operator dashboard whose
  "All agents" board is a product feature. The agent-tool ownership check governs
  agent-to-agent reads, a different threat model that legitimately gets a
  different answer. Scoping arrives with `scopeId`, not as a hotfix.
- **Cross-agent `create_mission` is the designed behaviour**, not a missing
  check. Delegation and Haiku auto-assign are the point of the tool; a self-only
  rule would break both, and an attacker could bypass it by omitting `owner`. The
  real gap was attribution, now closed by `mission_created` recording whether the
  owner was named explicitly or chosen by the model.

### Known residual risk

Mission `title`/`body` are attacker-influenceable text that (a) is fed to Haiku,
whose output selects an owner, and (b) is echoed into the target agent's
inter-agent inbox, which the agent loop drains into context. The blast radius is
bounded — the model's answer is re-validated against the known-agent list — but
the text-into-another-agent's-context path is a genuine prompt-injection surface
and is carried into the backlog rather than silently designed around.

---

## 13. Reliability and execution model

- **Dispatch** — activating a mission enqueues ready tasks to
  `claudeclaw-scheduled-fire` as `{ kind: 'mission_task', missionId, taskId }`.
  Durable: EventBridge Scheduler buffers into SQS with 4-day retention.
- **Claim** — conditional write on `status = 'queued'`. A loser sees zero
  modified items and backs off, so at-most-once claiming does not depend on a
  single-claimer invariant.
- **Timeout** — a bounded per-task deadline aborts the run and routes into the
  failure ladder.
- **Failure taxonomy** — capacity failures requeue with `notBefore` and do **not**
  consume retry budget; task failures use a bounded retry ladder; a review task
  with no verdict is treated as an empty run.
- **Liveness** — `heartbeatAt` renewed while running; an orphan sweep guarded by
  `runner-lease` reclaims rows stale beyond a threshold, gated on heartbeat age,
  start age, and the sweeping process's own in-flight set.
- **Cancellation** — the mission service writes terminal status; the runner
  re-reads the row as source of truth before writing a result, so a cancel that
  lands mid-run is not clobbered.
- **Dead letter** — after 5 receives a message lands in the existing DLQ. An
  alarm on its depth is required before missions ride this path.

**Open risk:** the retry ladder would retry agent runs with real side effects.
Idempotency keys or effect staging must be decided before retries ship.

---

## 14. Build now vs later

> **Current disposition — historical proposal.** This matrix records the
> proposal evaluated at the time of the audit. Current executable work is only
> [the reconciled backlog](missions-v2-backlog.md); ADR 0009 governs any
> conflict, including its rejection of `scopeId` and migration work.

| Capability | Build Now | Design For Later | Do Not Build | Reason |
|---|---|---|---|---|
| Mission container + tasks + events | ✅ | | | The current row cannot hold work |
| Coordinator agent plans + staffs | ✅ | | | Without it there is no multi-agent collaboration |
| Agent access derived from having work | ✅ | | | Today's self-only rule blocks the feature |
| Task kinds build/review/fix + evidence gates | ✅ | | | Makes done machine-checkable and failure tax visible |
| Gate-1 auto-approve policy | ✅ | | | Small; Gate 2 must never be automatable |
| Side-effecting tool flag gating retry | ✅ | | | Retries would otherwise re-send email |
| `scopeId` / user or team scoping | | | ✅ | No grouping concept exists to map it onto |
| Mission service layer + state machine | ✅ | | | Authorization is inconsistent without one |
| Owner out of the partition key | ✅ | | | Removes the duplicate + collision bug class |
| `missions:write` capability | ✅ | | | Mutation shares `agents:write` today |
| Mission audit + event timeline | ✅ | | | Enterprise cannot answer "who changed this" |
| Soft delete + retention | ✅ | | | TTL configured, never written |
| Task execution on the existing SQS path | ✅ | | | The feature is inert without it |
| Failure taxonomy + bounded retries | ✅ | | | Naive retry burns the queue into a quota wall |
| Heartbeat + orphan sweep | ✅ | | | Otherwise a dead task is stuck forever |
| Injected mission contract | ✅ | | | Scope must not survive only as paraphrase |
| Derived artifacts + evidence gates | ✅ | | | Makes "done" machine-checkable |
| Route + repo + isolation tests | ✅ | | | Zero today; the broken CLI is the evidence |
| DLQ depth alarm | ✅ | | | Poison messages are silent today |
| Cost per mission by task kind | | ✅ | | Needs execution data first |
| Notifications | | ✅ | | Needs a transport abstraction |
| Sprints / milestones | | ✅ | | Tasks + a `phase` attribute cover V1 |
| Templates | | ✅ | | Wait for repeated real missions |
| Value score / ROI reporting | | ✅ | | Good idea; not load-bearing |
| Multi-agent collaboration | | ✅ | | Single assignee is enough to prove execution |
| Full multi-tenant PK refactor | | ✅ | | ADR 0002 defers it on explicit evidence |
| Cross-mission dependencies | | | ✅ | No demand; large state-machine cost |
| Step Functions / workflow engine | | | ✅ | Two states do not need an orchestrator |
| Event sourcing / CQRS | | | ✅ | Events are history here, not the store |
| Plugin system / policy language | | | ✅ | Capability model already covers it |
| Search index | | | ✅ | GSI1 by status and by agent covers real queries |
| Gantt / CPM / EVM | | | ✅ | Vendored in ClaudeClaw, referenced by nothing |

---

## 15. Migration strategy

> **Current disposition — superseded and retired.** The strategy below is kept
> as evidence of the rejected approach. ADR 0009 accepts **no Mission legacy
> migration**: flat rows stay readable and untouched, while new Missions use the
> new shape only. The related backlog IDs are retired in
> [the reconciled backlog](missions-v2-backlog.md#retired-ids-not-active-work).

Incremental, never a rewrite. Existing missions keep working throughout.

1. **Add, don't replace.** New row shapes go into the same table under new SK
   prefixes. Old rows are untouched and keep serving reads.
2. **Dual-read shim.** The repo reads both shapes and normalizes to the new type,
   so routes and the SPA see one model during transition.
3. **Backfill.** Each legacy mission becomes a Mission plus one MissionTask,
   preserving id, timestamps, priority, owner and status. Idempotent, re-runnable,
   with a dry-run mode. Legacy rows are retained, not deleted, until the shim is
   removed — that is the rollback.
4. **Cut the UI over** once the shim is live, then retire the shim in a later
   release.

**Reusable unchanged:** the table and its GSI, the capability model, the audit
writer, Haiku auto-assign, route status validation, the SQS path.
**Requires refactor:** the repo (key shape), the four routes (service layer),
`Missions.tsx`, `mission-tools.ts`.
**Deprecate:** the client-side all-agent fan-out (replaced by a status query); `scripts/mission.ts` in its current broken form.
**Schema migration:** yes, data-level only — no CDK change.

---

## 16. Recommended implementation sequence

> **Current disposition — historical sequence.** Do not execute this sequence.
> It contains the superseded scope and migration work. Use
> [the reconciled backlog](missions-v2-backlog.md) for approved active work and
> [ADR 0009](adr/0009-mission-container-model.md) for architecture.

Full detail with acceptance criteria in [the backlog](missions-v2-backlog.md).

| Milestone | Outcome |
|---|---|
| Hotfix | Authorization + audit fixes. **Done** |
| 0 — Baseline | Verified build/test/synth state recorded before any change |
| 1 — Foundation | Domain model, state machine, repo, migration, capability |
| 2 — Core experience | Routes, task authoring, mission UI, approval gates |
| 3 — Agent execution | Dispatch, execution, failure ladder, heartbeat, artifacts |
| 4 — Enterprise controls | Audit coverage, scope isolation tests, retention, cost |
| 5 — UX completion | Progress, artifacts, empty/loading/error/permission states |
| 6 — Hardening | Integration + E2E, migration and rollback validation, DLQ alarm |

---

## 17. Risks and open questions

> **Current disposition — partly superseded.** The `scopeId` and backfill
> questions below were resolved by ADR 0009: neither is part of the accepted
> Mission architecture. Other observations remain historical evidence until
> re-verified against source.

1. **Production mission volume is unknown.** It determines whether the backfill is
   an online dual-read or a one-shot job. Must be measured before Milestone 1.
2. **`scopeId` has no source.** Principals carry `userId`/`profileId`/`role` but no
   workspace. V1 defaults to `default`; a real source is a Milestone 4 decision
   and a product question, not just an engineering one.
3. **Retry over non-idempotent side effects.** Blocking for Milestone 3. Options:
   idempotency keys per task run, or staging effects until a run is confirmed.
4. **Prompt injection via mission text** into another agent's context (§12).
   Needs a decision on sanitizing or structurally isolating inter-agent notes.
5. **`jarvis.flow.test.ts` has 2 pre-existing failures** under the full suite that
   pass in isolation — test pollution, present on untouched `production`. Not
   caused by this work, but it weakens the regression signal and should be fixed.
6. **No lint or format tooling exists** in the repo, and Playwright E2E specs
   exist but are not installed or run in CI. Milestone 6 must not assume either.
7. **Two authorization mechanisms remain live** in the dashboard middleware
   (capabilities plus the legacy role rank). This work made Jarvis require both
   rather than removing one, because they disagree in opposite directions.
   Collapsing them is a separate, larger piece of work.

---

## 18. Final proposed Mission experience

> **Current disposition — superseded walkthrough.** This scenario is retained
> to show the prior proposal. Its Mission `scopeId`, scope-based authorization,
> and any legacy-data migration implication are rejected by ADR 0009; current
> work must follow [the reconciled backlog](missions-v2-backlog.md).

A realistic enterprise walkthrough under the target architecture.

**Creation.** A compliance lead opens Missions and creates *"Produce a SOC 2
evidence pack for Q3 access reviews."* They state the outcome — *a reviewed
evidence pack covering all Q3 access changes, with exceptions flagged* — and pick
a deliverable format. The mission is created `draft`, `scopeId` from their
principal, and `mission_created` lands in the audit log.

**Planning.** They ask for a proposed plan. The planner drafts four tasks: pull
access-change records, cross-reference against approvals, draft the pack, review
it. The lead edits one prompt, deletes a redundant task, and saves. The mission
moves `draft → planned` — allowed because it now has tasks.

**Approval.** Nothing has executed. The lead reviews the plan and the estimated
cost, then activates. `planned → active` is the go-gate, recorded as a
MissionEvent naming them, and the three ready tasks are enqueued.

**Execution.** `queue-drain` claims each task with a conditional write, assembles
the prompt — persona, task, then the **mission contract appended last** carrying
the outcome, scope and deliverable format straight from the row — and runs the
agent turn. Heartbeats tick. Task 1 hits a provider capacity wall; it is
classified as `capacity`, requeued past the stated reset, and **burns no retry
budget**. Task 2 completes and emits `DELIVERABLE: s3://.../q3-access-diff.csv`.

**Collaboration and intervention.** The lead watches progress per task, sees task
3's output drifting, and cancels it. The runner re-reads the row before writing
its result, so the cancel is not clobbered. They edit the prompt and requeue.

**Review.** The review task returns without a `VERDICT:` line. The evidence gate
rejects it as an empty run rather than accepting a review that did not review. It
retries and comes back with `VERDICT: PASS` plus two flagged exceptions.

**Artifacts.** The mission page lists three artifacts, derived from the
`DELIVERABLE:` lines the gate already enforced — no separate registry to drift.

**Completion.** All tasks terminal, so the mission moves to `review`. The lead
reads the pack and accepts. `review → done` is the accept-gate; a human closed
it, not an agent.

**Afterwards.** An administrator can answer, from the audit log and the mission
timeline: who created it, who approved it, which agent ran which task with which
tools, what each produced, what failed, what was retried, and who accepted the
result. None of those questions was answerable before this work.
