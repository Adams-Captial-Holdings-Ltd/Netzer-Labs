# ADR 0009 — Missions are the durable work container for multi-agent collaboration

**Status:** Accepted (2026-08, Missions v2 design)

> **Superseding note (2026-08-18).** [ADR 0010](0010-paperclip-work-engine.md)
> supersedes this ADR's **storage and execution model**: Paperclip becomes the
> system of record for work items, and the Mission/MissionTask/MissionEvent row
> design in `claudeclaw-mission-tasks` retires when the integration plan's ACL
> cutover and retirement stage complete. The `/api/missions*` wire contract,
> the capability model, and the coordinator/approval roles defined here remain
> authoritative. Backlog items MISSION-011 … MISSION-034 in the
> [missions v2 backlog](../missions-v2-backlog.md) evaporate under ADR 0010 and
> close with a pointer to it at retirement; this ADR's status flips to
> Superseded in that same change, not before.

## Context

Netzer already has four agent-collaboration primitives, and every one of them is
messaging or memory rather than work:

| Primitive | What it does | Persistence |
|---|---|---|
| `ask_agent` (`src/lib/tools/agent-tools.ts`) | A asks B a question, gets an answer. Audited `agent_delegation` | ephemeral |
| `inter-agent-tasks` (`src/lib/state/inter-agent-tasks-repo.ts`) | Async note queue, `PK=AGENT#<toAgent>`, intent `fyi`/`request` | **7-day TTL**, no outcome |
| `hive-mind` (`src/lib/state/hive-mind-repo.ts`) | Cross-agent shared facts | durable, but memory not work |
| War Room (`src/lib/warroom/`) | Synchronous multi-agent meeting | turns, not deliverables |

None of them has a status, an outcome, artifacts, or a notion of done. Work that
several agents contribute to over time has nowhere to live.

`Missions` looks like it was reaching for exactly that and stopped:
`src/lib/state/mission-tasks-repo.ts` is a single flat row — 11 fields, four
statuses, `PK = AGENT#<ownerAgent>` — with no sub-tasks, artifacts, outcomes or
history, and **nothing executes it**. The complete consumer set is four files,
all CRUD/read. The `GSI1PK = STATUS#…` index exists only to paint kanban columns.

Worse, the agent-tool layer enforces `owner !== ctx.agentId → refuse` on both
read and update (`src/lib/tools/mission-tools.ts:231,288`). That rule is correct
for a private per-agent card and **actively prevents collaboration**: an agent
cannot read a mission it is working on unless it is the sole owner.

A validated design for this already exists in the personal ClaudeClaw OS
(`Projects`). It is a source of design lessons, not a specification — it is
single-user, has no authorization concept whatsoever, and runs every agent with
`permissionMode: 'bypassPermissions'`.

## Decision

**A Mission is the durable, tracked work container in which several agents
collaborate toward a stated outcome, under human approval.** It is not a user's
record and not a workspace — it is scoped by *which agents are working on it*.

### Shape

Three row types in the existing `claudeclaw-mission-tasks` table:

| Entity | PK | SK |
|---|---|---|
| Mission | `MISSION#<id>` | `META` |
| MissionTask | `MISSION#<id>` | `TASK#<seq>#<taskId>` |
| MissionEvent | `MISSION#<id>` | `EVENT#<iso>#<id>` |

GSI1 is repurposed, not extended:

- Mission rows — `GSI1PK = MSTATUS#<status>`, `GSI1SK = PRIORITY#<pad>#<createdAt>`
- Task rows — `GSI1PK = AGENT#<assignedAgent>#<status>`, same sort key

The task index is the work-pull index an agent needs, and it partitions per
agent rather than concentrating on one key.

Artifacts are **derived** from `DELIVERABLE:` lines in task results, never
stored. Ceremony cost is **derived** from `assignedAgent === coordinator`.

### Roles

- **Coordinator = the `main` agent.** It triages a mission, decomposes it into
  tasks and staffs them. `main` is already the system's hub —
  `src/lib/config/agent-loader.ts:235` falls back to `BUILTIN_AGENTS.main`, the
  mission create route already defaults `owner = 'main'`, and other builtin
  agents' prompts instruct users to "redirect them to the main agent".
- **Humans approve.** The coordinator proposes; a human activates the plan and
  accepts the result. An agent never decides a mission is complete.

### Staffing is not authorization

Two separate concerns, deliberately not fused:

- **Staffing** (product): `team` is an optional pin — a set of agent ids.
  `null` means the coordinator staffs freely. Assigning outside a pin is
  possible but requires an audited `overrideReason`. This is ported from
  Projects, which enforces exactly this at assignment time with the coordinator
  always exempt.
- **Authorization** (security): an agent may read a mission iff it has a task on
  that mission, or it is the coordinator. It may write a task iff that task is
  assigned to it, or it is the coordinator. Transitions and cancellation are
  coordinator-or-human only.

Fusing them would turn a product dial into a security boundary, so loosening
staffing would silently loosen access. They stay independent.

### Task kinds

`build | review | fix`. A `review` that emits no `VERDICT:` did not review and
is treated as an empty run. `fix` is rework from a failed review, which is what
makes failure tax visible instead of hidden inside a longer build.

Projects' `polish` and `pm` are not ported: `polish` gates on brand assets that
do not exist here, and `pm` is derivable from the coordinator assignment.

### Autonomy

Gate 1 (`planned → active`) may be auto-approved under a policy
`{ maxEstimatedUsd, maxTasks }`, off by default. **Gate 2 (`review → done`) can
never be auto-approved by any policy.** This asymmetry is taken directly from
Projects (`src/db.ts:3516` — *"Gate 2 (the finished build) is NEVER
auto-approved"*): auto-approving a plan risks bounded spend, while
auto-approving output means nobody ever looked at it.

The bound is estimated USD rather than Projects' "sessions" because Netzer
already meters spend (spend-ledger, `runtime-config cost/daily_cap_usd`, tier
caps) and has no session unit.

### Execution and retries

Reuse the existing durable path — EventBridge Scheduler →
`claudeclaw-scheduled-fire` SQS → `queue-drain.ts` — with a message-`kind`
discriminator. No new queue, no new AWS service.

Side-effecting tools are flagged (`sideEffecting: true`) in the tool registry.
A run that fired none may auto-retry on the bounded ladder; a run that fired one
is marked needs-human-requeue rather than retried. Capacity failures fail before
doing work, so they always requeue and **never consume retry budget**.

### No `scopeId`, no migration

There is no user, team or workspace scope on a Mission. An earlier draft of this
ADR added a `scopeId` "because it is free now"; that was wrong. Netzer has no
grouping concept to map it to — `UserProfile` has no team field, `Seat` binds one
user to a policy, and the Workspace entities from PR #42 were deliberately not
ported (`src/lib/admin/seat-model.ts:4-9`). A field permanently holding the
literal `default` is speculative generality, and the retrofit it was avoiding is
a `GSI1PK` backfill measured in hours at human scale.

Legacy flat mission rows are **not migrated**. They stay in the table, readable
and untouched; new missions are written in the new shape only.

## Consequences

Good:

- Multi-agent work finally has somewhere durable to live, alongside the four
  messaging primitives that already exist.
- The authorization predicate becomes *more* precise than today: collaboration
  is enabled while an unrelated injected agent, having no task, is still refused.
- No CDK change for the data model. PK/SK are generic strings and GSI1 keys on
  generic attributes (`infra/lib/dynamo-stack.ts`), so this ships through
  `npm run deploy:cloud` rather than a `cdk deploy`.
- No migration means the riskiest task in the plan disappears, along with an
  entire class of two-shapes-coexisting bugs. Rollback is trivial: nothing is
  rewritten.
- Ceremony cost and artifacts are derived, so there is no second bookkeeping
  system to drift.

Bad:

- The existing kanban UI and `mission-tools.ts` ownership rule both change.
  `mission-tools.authz.test.ts` encodes the self-only rule as a security
  contract and must be rewritten — deliberately, with the new predicate proved
  to still refuse an unrelated agent.
- Legacy rows and new rows coexist in one table indefinitely. Accepted: they use
  disjoint key prefixes and the old UI path is retired.
- One partition per mission caps its task+event volume at DynamoDB's 10 GB
  partition limit. Not a practical constraint for human-scale work, and it is
  why events are history rather than the primary store.
- The coordinator's plan is LLM output. The human approval gate is its only
  check, which is why Gate 2 can never be automated away.

## Alternatives considered

- **Keep Missions as a per-agent card and harden it.** Rejected: it would leave
  multi-agent work with no home, and the self-only authz rule would keep
  preventing the collaboration the feature exists for.
- **Scope missions to a user or workspace.** Rejected on evidence: no grouping
  concept exists, and Missions is about agents collaborating, not people sharing.
- **`team` as an access-control list.** Rejected: Projects deliberately makes it
  a soft, overridable staffing constraint. Turning it into an ACL fuses a product
  dial with a security boundary.
- **Introduce `Project` above `Mission`, mirroring Projects' naming.** Rejected:
  a second noun for one concept, and it silently redefines every existing use of
  "mission" in the UI, CLI, `missions:read` capability and route table.
- **Full multi-tenant `TENANT#` keys.** Rejected by
  [ADR 0002](0002-single-tenant.md), which is Accepted and prices this at ~2
  weeks plus indefinite scoping risk, warranted only when the customer base is
  large and per-customer revenue small. Neither is true.
