---
feature: delete-chat
document_role: handoff
status: current
observed_at: 2026-08-17
as_of_commit: b201bd8f389ae6eb9d3533f199d956aad68f85c4
---

# Delete Chat handoff

- Branch: `development`; merge target: `qa`. Built directly on `development` by
  explicit instruction rather than on a `feature/` branch — a one-time deviation
  from [development.md step 8](../../../development.md#how-to-develop-a-new-feature-end-to-end),
  recorded in the session log below.
- Pushed: see the session log; committed locally and pushed are different states.
  PR: none. Deployment: none — `development` reaches no AWS environment.
- Phases/tasks: implementation and unit coverage complete; active task: none.
- Blockers: none.
- Last required checks: all nine documented pre-push commands ran. `typecheck`,
  `build`, web `typecheck`, web `build`, `docs-links`, `feature-knowledge` and
  `git diff --check` all pass; `local:test:integration` is 38/1 with the
  documented Floci `ListSecrets` gap. Baseline `npm test` on untouched
  `b201bd8f389ae6eb9d3533f199d956aad68f85c4` was **6 files / 14 tests failing**
  before any change; after, **6 files / 3 failing** with passing up 2012 → 2036
  and every deterministic failure unchanged. Per-command results and the
  flake analysis are in the session log's section 7.
- Smallest next action: none outstanding. Live end-to-end (including the
  cross-user delete and a direct DynamoDB check) is recorded in the session log.

Authorities: [README](README.md),
[feature knowledge framework](../README.md),
[local development guide](../../../development.md).

## Session index

- [2026-08-17 — delete-chat](handoffs/2026-08-17-delete-chat.md) (newest)
