# ADR 0009 — Missions become a work container, not a task row

**Status:** Accepted (2026-08, Missions v2 audit)

## Context

`Missions` today is a flat, single-row entity: 11 fields, four statuses, one
DynamoDB item per mission (`src/lib/state/mission-tasks-repo.ts`). Its key shape
is `PK = AGENT#<owner>` / `SK = MISSION#<isoCreated>#<id>`, with one GSI
(`gsi1-status-agent-priority`) whose only consumer is the kanban board.

Three facts drove this ADR:

1. **Nothing executes a mission.** The complete set of callers of the five repo
   functions is `src/adapters/dashboard/handler.ts` (HTTP CRUD),
   `src/adapters/dashboard/jarvis.ts` (voice read), `src/lib/tools/privacy-tools.ts`
   (GDPR export) and `src/lib/tools/mission-tools.ts` (agent tools). No worker,
   Lambda or scheduler ever reads status `open` and acts on it. The
   `GSI1PK = STATUS#…` index exists to paint columns, and `listMissionsByStatus`
   has exactly one caller.
2. **The entity cannot express the work.** There are no sub-tasks, artifacts,
   outcomes, dependencies, execution runs, comments or history, and no second SK
   prefix under the mission partition in which to put them.
3. **Owner is the partition key.** Because `ownerAgent` is in the PK, reassigning
   a mission is a non-transactional cross-partition put-then-delete whose own
   comment acknowledges that a crash leaves a duplicate. Both mutation paths also
   list up to 200 rows and prefix-match in application code, so an 8-character id
   collision hits the wrong record and mission #201 is unreachable.

A second implementation of the same idea exists in the personal ClaudeClaw OS
(`Projects` + `mission-worker`), which does execute work. It is a useful source
of design lessons but is welded to a single machine (SQLite, local filesystem,
`bypassPermissions` on every agent run, a forgeable caller-asserted `agent_id`
as its only authorization predicate) and is explicitly not a specification.

## Decision

**A Mission becomes the container for a goal; a MissionTask becomes the unit of
work.** Three row types share the existing `claudeclaw-mission-tasks` table:

| Entity | PK | SK |
|---|---|---|
| Mission | `MISSION#<id>` | `META` |
| MissionTask | `MISSION#<id>` | `TASK#<seq>#<taskId>` |
| MissionEvent | `MISSION#<id>` | `EVENT#<iso>#<id>` |

Today's flat missions migrate to a Mission holding exactly one MissionTask.

Supporting decisions taken at the same time:

- **The name `Mission` is kept.** It is already the noun in the SPA, the CLI, the
  `missions:read` capability and the route table. Adopting ClaudeClaw's "Project"
  would introduce a second noun for one concept.
- **`ownerAgent` leaves the partition key** and becomes an attribute plus a GSI
  segment, which removes the cross-partition move and the 200-row scan entirely.
- **Artifacts are derived, not stored** — parsed from `DELIVERABLE:` lines in task
  results on read, so there is no second bookkeeping system to drift.
- **A `scopeId` is carried on the new rows from day one**, per
  [ADR 0002](0002-single-tenant.md). The deployment remains the tenant boundary;
  `scopeId` is the team/workspace boundary *within* a deployment and defaults to
  `default`, which is behaviour-preserving. It is added here only because it is
  free on a new row shape and expensive to retrofit.
- **No new AWS services and no CDK change for the data model.** The table's PK/SK
  are generic strings and GSI1 is keyed on generic `GSI1PK`/`GSI1SK`
  (`infra/lib/dynamo-stack.ts`), so new SK prefixes and repurposed GSI1 values
  need no infrastructure change. Execution reuses the existing durable path
  (EventBridge Scheduler → `claudeclaw-scheduled-fire` SQS → `queue-drain.ts`),
  extended with a message-kind discriminator.

## Consequences

Good:

- Missions can finally express an outcome, the work toward it, and what was
  produced — the three things the current row cannot hold.
- Reassignment becomes a single-item attribute update. The put-then-delete
  duplicate window and the id-prefix collision class both disappear.
- Every child row of a mission is in one partition, so loading a mission with its
  tasks and history is one query rather than a scan.
- Zero infrastructure change means the migration ships through
  `npm run deploy:cloud` (image-only) rather than a `cdk deploy`.
- Adding team scoping later is an attribute change on two row types instead of a
  PK rewrite across 13 repos.

Bad:

- Existing mission rows must be migrated; a dual-read shim is required during the
  transition, and the old and new shapes coexist in one table meanwhile.
- One partition per mission caps a single mission's task+event volume at the
  10 GB partition limit. This is not a practical constraint for human-scale work
  but is a real ceiling, and it is the reason events are not the primary store.
- `scripts/mission.ts` and the Missions SPA page both assume the flat shape and
  must change together with the repo.

## Alternatives considered

- **Keep the flat model and only harden it** (fix authz, add audit, add
  execution). Smallest change and genuinely tempting, but a single row cannot
  carry an outcome, its tasks, or its artifacts, so every later capability would
  need the reshape anyway — at that point against production data instead of
  before it.
- **Introduce `Project` above `Mission`, mirroring ClaudeClaw.** Rejected: it
  adds a second noun for the same concept and silently redefines every existing
  use of "mission" in the UI, CLI, capability strings and docs to mean the
  smaller thing.
- **A separate table per entity.** Rejected: loading a mission would become three
  queries across three tables with no transactional story, and it would add three
  CDK resources to solve a problem the existing generic PK/SK already solves.
- **Full multi-tenant `TENANT#` keys now.** Rejected by
  [ADR 0002](0002-single-tenant.md), which is Accepted and prices this at roughly
  two weeks plus indefinite "did I remember to scope this query?" risk, warranted
  only when the customer base is large and per-customer revenue small. Neither is
  true today.
