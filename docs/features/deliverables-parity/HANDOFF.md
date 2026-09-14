---
feature: deliverables-parity
document_role: handoff
status: current
observed_at: 2026-09-13
as_of_commit: bc462df16f9e06f0d9f7233515c974d13f27610b
---

# Deliverables parity handoff

- **Branch:** `chore/deliverables-parity`, in the normal clone `C:\dev\_netzer-diag`,
  from `origin/development` at `271339bc8b2feea85e6c31b115fdd34e757a72e2`.
  Commits: `1a29a40` (this folder), `b1e2a19` (capture gate), `bc462df` (replay
  contract), then the session-close docs. **Merge target:** `development`, and
  only with the user's approval.
- **Local-only branch:** `diag/prod-capture` is `origin/production` `de244e6`
  plus overlays of `scripts/diagnostics/deliverables` (`f7194c1`, `51e85cb`). It
  exists to run the harness on production's code. Never push it; delete it when
  W1 closes.
- **AWS environment:** none. `chore/*` deploys nothing, per the
  [branch mapping](../../../development.md#branch-to-environment-mapping). This
  work has made no AWS call.
- **Pushed:** no. **PR:** none. **Deployed:** no.
- **Work item:** round 1, W1 (Step 0 telemetry and the E1 output-budget
  ablation). Gauntlet SPECIFICATION is complete. IMPLEMENTATION is next: make
  `replay.diag.ts` green, without running the replay.
- **Blockers:** Step 0 needs an AWS sign-in and the user's go. Also open:
  production failure examples, System A's files, the incident's exact prompt
  wording, approval for up to $30 of replay spend, and a separate approval for
  the judge.
- **Last required checks:**
  - Baseline on `271339b`, AWS credentials stripped: `npm test` 5 files failed,
    238 passed, 1 skipped, all five known; typecheck clean; both docs gates OK.
  - After, at `bc462df` plus the close docs: `npm test` 5 files failed, 238 passed, 1 skipped; 1 test failed, 3108 passed, 6 skipped (100.99 s), the same five files as the baseline;
    typecheck clean; `node scripts/ci/feature-knowledge.mjs` OK;
    `node scripts/ci/docs-links.mjs` OK: 139 files, 1719 internal links; `git diff --check` clean.
  - Capture gate: development 2/2 (first call 1024), production overlay 2/2
    (first call 8192), and a forced-wrong expectation red as intended.
  - Replay contract on the production overlay: 13/13 red on `not implemented`.
  - Not run: `npm run build`, both web commands, `npm run local:test:integration`.
    They are pre-push gates, and no push is planned.
- **Smallest next action:** in a fresh session, start Gauntlet IMPLEMENTATION
  from `~/.claude/plans/claude-bedrock-deliverables-handoff.md`.

## Session log index

Newest first:

- [2026-09-11: W1 harness specification](handoffs/2026-09-11-w1-harness-specification.md)
- [2026-09-10: deliverables gap diagnosis](handoffs/2026-09-10-deliverables-gap-diagnosis.md), back-filled

Authorities: [README](README.md), [feature knowledge framework](../README.md).
