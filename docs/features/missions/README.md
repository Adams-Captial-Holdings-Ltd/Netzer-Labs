---
feature: missions
document_role: index
status: current
observed_at: 2026-08-11
as_of_commit: d767a368bca3cbb32e0abfc50a42cd3a001c64fa
implemented_by:
  - src/lib/state/mission-tasks-repo.ts
  - src/lib/tools/mission-tools.ts
  - src/adapters/dashboard/handler.ts
  - web/src/pages/Missions.tsx
tested_by:
  - src/lib/tools/mission-tools.test.ts
  - src/lib/tools/mission-tools.authz.test.ts
decisions:
  - docs/adr/0009-mission-container-model.md
approved_work:
  - docs/missions-v2-backlog.md
evidence:
  - docs/missions-v2-audit.md
---

# Missions

## 1. Start Here

This index describes the verified implementation snapshot at
`d767a368bca3cbb32e0abfc50a42cd3a001c64fa`. Start with the implementation and
tests below; source code is the ultimate truth for present behavior. Then read
the volatile [HANDOFF](HANDOFF.md), the accepted
[ADR 0009](../../adr/0009-mission-container-model.md), approved
[backlog](../../missions-v2-backlog.md), and historical
[audit](../../missions-v2-audit.md). The ADR governs durable architecture; the
backlog is the only approved execution queue; the audit is evidence, not a
current specification.

## 2. What Missions does today

Missions is currently a persistent, per-agent task queue with four kanban
statuses: `open`, `in_progress`, `done`, and `cancelled`. It stores one flat
mission row, can create/list/change-status/reassign it through the dashboard,
and exposes `create_mission`, `list_missions`, and `update_mission` to agents.
Creation can use Haiku auto-assignment; an assignment to another agent attempts
an inter-agent inbox notification.

It is not the ADR 0009 multi-agent work container yet: there are no mission
tasks, events, artifacts, human approval gates, or execution/retry path. The
existing scheduler drains scheduled tasks, not Missions.

## 3. Current status and current source commit

The source snapshot is
`d767a368bca3cbb32e0abfc50a42cd3a001c64fa` (`d767a36`), which is reachable from
the reviewed branch history. This is source and Git-reachability evidence only;
it is not deployment evidence.

This documentation starts from
`946ac3f7312179a085cc6cd7b568e0e609920864`, authored on the since-merged
`feature/missions-knowledge-system` branch and now reachable from `development`
through pull request #12. That is dated operational documentation evidence, not
a self-updating promise and not the implementation snapshot. Deployment remains
unverified from repository evidence.

## 4. Source of truth

| Concern | Authority | Use it for |
|---|---|---|
| Implementation | [code](../../../src/lib/state/mission-tasks-repo.ts) | Present runtime behavior |
| Durable decisions | [ADR 0009](../../adr/0009-mission-container-model.md) | Accepted architecture |
| Approved work | [Missions v2 backlog](../../missions-v2-backlog.md) | Executable follow-up |
| Evidence and history | [Missions v2 audit](../../missions-v2-audit.md) | Dated findings and reconciliation |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, command, and next-action state |

## 5. Implementation map

| Area | Verified location | Present behavior |
|---|---|---|
| Repository | [mission-tasks-repo.ts](../../../src/lib/state/mission-tasks-repo.ts) | Creates, lists, status-updates, and reassigns flat per-agent rows. |
| Agent tools | [mission-tools.ts](../../../src/lib/tools/mission-tools.ts) | Registers create/list/update tools; list and update refuse another agent's owner id. |
| Dashboard routes | [handler.ts](../../../src/adapters/dashboard/handler.ts) | `GET /api/missions?owner=` lists up to 100; `POST /api/missions` creates; owner/id status and reassign routes mutate. |
| UI | [Missions.tsx](../../../web/src/pages/Missions.tsx) | Four-column Preact board with create, detail, and reassign actions; its all-agent view requests every known agent separately. |
| CLI | [mission.ts](../../../scripts/mission.ts) | Provides list/show/create commands, but list sends `?agent=` while the route reads `owner`, and show calls an absent detail route. |
| Permissions | [permissions.ts](../../../src/lib/auth/permissions.ts) | Read requires `missions:read`; create/status/reassign require `agents:write`. |
| DynamoDB | [dynamo-stack.ts](../../../infra/lib/dynamo-stack.ts) | Uses `claudeclaw-mission-tasks`, generic `PK`/`SK`, and `gsi1-status-agent-priority`; current rows partition on `AGENT#<owner>`. |
| Scheduler dependencies | [queue-drain.ts](../../../src/lib/scheduler/queue-drain.ts) | No Mission dependency today: the EventBridge Scheduler/SQS drain handles scheduled tasks only. ADR execution reuse is approved future work. |
| Tests | [mission-tools.test.ts](../../../src/lib/tools/mission-tools.test.ts) and [mission-tools.authz.test.ts](../../../src/lib/tools/mission-tools.authz.test.ts) | Covers assignment-response parsing and current self-only tool checks; no Missions repository, route, or integration coverage exists. |

## 6. Current business/state rules

- A new mission is `open`; the runtime status set is exactly `open`, `in_progress`, `done`, and `cancelled`.
- The repository lists by owner and status; the dashboard defaults an omitted owner to `main` and accepts any requested owner after the caller passes `missions:read`.
- Agent tools default owner to the calling agent and reject a foreign owner on both list and update. This is current legacy behavior, not the ADR 0009 access predicate.
- Dashboard mutations require `agents:write`; the status route rejects values outside the runtime status set, but it does not enforce a transition matrix.
- Reassignment requires a known target agent and currently moves a row between owner partitions.
- Priorities are numeric (default `50`) and are included in the status index ordering. Optional assignment rationale and due date are carried on the flat row.

## 7. Known runtime risks and approved next work

These are current runtime risks, not fixes claimed by this documentation change.

| Risk | Evidence | Approved next work |
|---|---|---|
| CLI contract mismatch | `?agent=` and the absent detail endpoint make list/show diverge from the routes. | [MISSION-015](../../missions-v2-backlog.md#mission-015--mission-sub-router) includes fixing or removing the CLI with the route contract. |
| Scan cap, ambiguous prefixes, non-transactional reassign | Mutations list only 200 rows, prefix-match ids, then reassign with separate put/delete writes. | [MISSION-012](../../missions-v2-backlog.md#mission-012--mission-repository-on-the-existing-table). |
| No central ToolRegistry audit | The registry emits metrics but no audit row. Historical [MISSION-002](../../missions-v2-backlog.md#mission-002--central-audit-in-toolregistryinvoke) is `claimed_unverified`, not completed work; no active backlog item directly owns this cross-tool audit gap. | Record fresh approved work before implementation. |
| UI per-agent fanout | The all-agent board uses one capped request per known agent. | [MISSION-017](../../missions-v2-backlog.md#mission-017--mission-list-and-detail-ui). |
| Missing Missions repository, route, and integration coverage | Current coverage is mocked tool parsing/ownership only. | [MISSION-012](../../missions-v2-backlog.md#mission-012--mission-repository-on-the-existing-table), [MISSION-015](../../missions-v2-backlog.md#mission-015--mission-sub-router), and [MISSION-031](../../missions-v2-backlog.md#mission-031--integration-tests-on-localstack). |
| MISSION-001 through MISSION-003 claims | They are historical `claimed_unverified` records with no reachable commit and absent current source. | Do not treat them as shipped, deployed, or recoverable; use the [reconciled backlog](../../missions-v2-backlog.md#historical-hotfix-claims--current-disposition-unverified) before approving fresh work. |

## 8. Exact focused and full validation commands

Focused current checks:

```powershell
npx vitest run src/lib/tools/mission-tools.test.ts src/lib/tools/mission-tools.authz.test.ts
npx vitest run scripts/ci/docs-links.test.ts
node scripts/ci/docs-links.mjs
```

Full repository validation before push:

```powershell
npm run typecheck
npm run build
npm --prefix web run typecheck
npm --prefix web run build
npm test
npm run local:test:integration
git diff --check
git status --short
```

`npm run local:test:integration` uses the existing Floci environment. Do not run
`npm run test:integration:up` or `npm run test:integration:all`: the project
guidance records a LocalStack collision with Floci and unsafe teardown behavior
on a middle-command failure. A skipped environment is not a passing result.

## 9. Related documents

- [Operational HANDOFF](HANDOFF.md)
- [Feature knowledge framework](../README.md), the specification this document conforms to
- [ADR 0009 — Mission container model](../../adr/0009-mission-container-model.md)
- [Missions v2 backlog](../../missions-v2-backlog.md)
- [Missions v2 audit](../../missions-v2-audit.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)
- [Repository agent guidance](../../../AGENTS.md)
