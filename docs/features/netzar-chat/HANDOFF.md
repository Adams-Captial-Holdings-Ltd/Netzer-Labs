---
feature: netzar-chat
document_role: handoff
status: current
observed_at: 2026-08-27
as_of_commit: 3cf4c34c359f74afc04dc258a3da90876fa05a37
---

# Netzar Chat handoff

- Branch: `feature/librechat-chat-ui` in the full clone at
  `C:\dev\_netzer-librechat`; merge target `development`. 19 commits ahead.
- Pushed: no. PR: none. Deployment: none.
- Phases: CHATUI-000 through CHATUI-006 are built and every one has been
  accepted by a blind critic against two frozen bars. CHATUI-007 (ship) is the
  only phase left.
- Donor code: 826 donor lines render, 780 byte-identical (94.4%), verified by an
  independent diff rather than by claim. See
  [the session log](handoffs/2026-08-27-phases-1-6-and-harvest.md).
- Last checks actually run, all on `3cf4c34`: root typecheck exit 0, root build
  exit 0, web typecheck exit 0, web build exit 0 (chat chunk 80.31 kB gzip),
  chat golden tests 70/70, docs-links OK, feature-knowledge OK,
  `git diff --check` clean, roll-call ROLLCALL_PASS 84/84, tour anchors present.
  Full `npm test`: 6 files / 2 tests failing — 5 files / 1 test are the
  documented pre-existing baseline, and the sixth
  (`src/lib/vectors/durability.repro.test.ts`) passes 7/7 standalone with Floci
  up, so it is contention in the parallel run and not a regression.
- Smallest next action: open the PR into `development`. Then merge on green CI
  and promote `development -> qa -> staging`. **The Deploy run is the gate, not
  the merge** — a red or cancelled run reopens the phase. Verify on real staging
  afterwards: streaming cadence, live tool statuses, the agent and model
  roll-call, both themes, mobile. Production is manual-dispatch with a typed
  confirmation and needs a separate human go-ahead.

Session index (newest first):
- [2026-08-27-phases-1-6-and-harvest.md](handoffs/2026-08-27-phases-1-6-and-harvest.md)
- [2026-08-25-phase-0-extraction.md](handoffs/2026-08-25-phase-0-extraction.md)
- [2026-08-25-phase-0-scaffolding.md](handoffs/2026-08-25-phase-0-scaffolding.md)

Authorities: [README](README.md), [approved plan / phase backlog](plan.md).
