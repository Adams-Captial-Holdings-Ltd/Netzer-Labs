---
feature: missions
document_role: handoff
status: current
observed_at: 2026-08-18
as_of_commit: a7ab7a325487c6ea06a3158f88d8cd45b73e0b53
---

# Missions handoff

- **Supersession in progress (2026-08-18):**
  [ADR 0010](../../adr/0010-paperclip-work-engine.md) makes Paperclip the
  future system of record for work items; the Missions v2 storage/execution
  model in [ADR 0009](../../adr/0009-mission-container-model.md) now carries a
  superseding note, and the backlog queue MISSION-011 … MISSION-034 evaporates
  under it (closing formally at the plan's retirement stage). Integration work
  lives in the [paperclip feature folder](../paperclip/HANDOFF.md) on branch
  `codex/paperclip-integration`. The `/api/missions*` wire contract,
  capabilities, and current runtime behavior are unchanged today.
- Branch: `development`; merge target: `qa`. The `feature/missions-knowledge-system`
  branch was merged through pull request #12 and deleted; do not look for it.
- Pushed: yes (the documentation-contract state above). Deployment: unverified;
  Git reachability is not deployment evidence.
- Phases/tasks: T1-T6 complete; active task: none. The Missions v2
  implementation queue in the [backlog](../../missions-v2-backlog.md) was never
  started and is now superseded rather than pending — see the first bullet.
- Blockers: none for the documentation contract. The Missions runtime risks in
  [README section 7](README.md#7-known-runtime-risks-and-approved-next-work)
  remain open and are owned by backlog items, not by this handoff.
- Last required checks: **not run in this change.** The documentation-framework
  commit that produced this state was authored on a machine with no Node
  runtime, so `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`,
  and `npx vitest run scripts/ci/feature-knowledge.test.ts` could not execute
  locally. Docs CI on `development` is the first real execution. A skipped check
  is not a passing result.
- Known local limitation: targeted Vitest did not collect tests in a Windows
  linked worktree; startup failed with `Cannot read directory "../../../../../../../.."`
  and could not resolve `vitest.config.ts`. Run the suite from a normal checkout.
- Smallest next action: read the Docs CI result for the latest `development`
  push and fix any contract failure it reports.

## Session log index

Newest first. Every session that works in this folder adds one file to
`handoffs/`, copied from the
[session handoff template](../HANDOFF-TEMPLATE.md), and links it here.

| Session | Date | Summary |
|---|---|---|
| _none yet_ | — | The per-session protocol was adopted on 2026-08-12, after the sessions summarised above. The next session to touch Missions writes the first entry, seeding its carried-forward ledger from the template. |

The two facts above that a future session would otherwise rediscover — the
checks that could not run on a Node-less machine, and the Windows linked-worktree
Vitest failure — are already carried in the template's seed ledger as **M5** and
**M6**. Do not delete them from your session handoff when you copy it forward.

Authorities: [README](README.md), [feature knowledge framework](../README.md),
[ADR 0009](../../adr/0009-mission-container-model.md),
[backlog](../../missions-v2-backlog.md), [audit](../../missions-v2-audit.md).
