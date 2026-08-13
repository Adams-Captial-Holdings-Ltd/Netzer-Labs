---
feature: persistent-workspaces
document_role: handoff
status: current
observed_at: 2026-08-13
as_of_commit: ef7c6c010db4d5535a78c03265ead0a411b13977
---

# Persistent agent workspaces handoff

- Branch: `feature/conversation-history` (linked worktree
  `.worktrees/conversation-history`, based on `development` at `27cde44`,
  post PR #34/#35/#36); merge target: `development`.
- Pushed: yes (WIP push at the user's request; see the deviation note below).
  PR: none yet. Deployment: none.
- Phases: M0 (document delivery) and M1 (conversation persistence) merged via
  PRs #34/#36. **M1.5 (this branch): per-user conversation ownership + full
  durable transcripts + idempotency + deep links — backend complete and green,
  frontend `Chat.tsx` mid-refactor with web typecheck RED (4 known errors).**
  M2 (durable artifacts) and M3 (PPTX + editing) not started.
- Blockers: none technical. The session was paused mid-frontend at the user's
  request and pushed WITHOUT the full pre-push validation list — an explicit,
  user-approved deviation from `development.md` step 7. The resuming session
  owes: the four `Chat.tsx` fixes, `npm run build`, both web gates, and the
  first-ever run of `conversations-repo.integration.test.ts` against Floci,
  all BEFORE any PR.
- Last required checks: root `npm run typecheck` clean; focused suites green
  (repo 15/15, router 7/7, authz-matrix run 115/115, stream contract 6/6,
  GDPR 4/4; legacy regression suites untouched-green). Baseline on untouched
  `27cde44` (Windows): 7 failed files / 20 failed tests, all pre-existing
  (6 `scripts/` env-only + the documented `jarvis.flow` credential-chain
  flake, reproduced twice). Full details and exact failing set: session log.
- Smallest next action: fix the four web-typecheck errors in
  `web/src/pages/Chat.tsx` — the exact edits are enumerated in §6.1 of the
  session log below.

Session index (newest first):

- [2026-08-13-conversation-ownership-durable-messages](handoffs/2026-08-13-conversation-ownership-durable-messages.md)
  — current session (M1.5 build, paused mid-frontend).
- M1 session (PR #36, `feature/chat-history`): predates the `handoffs/`
  convention in this folder; its record is the previous revision of this file
  (`git log -- docs/features/persistent-workspaces/HANDOFF.md`, commit
  `f132a9c`) and the PR #36 commit message.

Authorities: [README](README.md),
[ADR 0010](../../adr/0010-conversation-ownership-and-durable-messages.md),
[ADR 0002](../../adr/0002-single-tenant.md),
[ADR 0009](../../adr/0009-mission-container-model.md).
