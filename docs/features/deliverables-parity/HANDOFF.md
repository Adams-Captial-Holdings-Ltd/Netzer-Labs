---
feature: deliverables-parity
document_role: handoff
status: current
observed_at: 2026-09-13
as_of_commit: 271339bc8b2feea85e6c31b115fdd34e757a72e2
---

# Deliverables parity handoff

- **Branch:** `chore/deliverables-parity`, in the normal clone `C:\dev\_netzer-diag`,
  from `origin/development` at `271339bc8b2feea85e6c31b115fdd34e757a72e2`.
  **Merge target:** `development`, and only with the user's approval.
- **AWS environment:** none. `chore/*` deploys nothing, per the
  [branch mapping](../../../development.md#branch-to-environment-mapping). This
  work has made no AWS call.
- **Pushed:** no. **PR:** none. **Deployed:** no.
- **Work item:** round 1, W1 (Step 0 telemetry and the E1 output-budget
  ablation). Gauntlet phase SPECIFICATION, in progress: this folder and the
  baseline are done; the capture gate and the replay specification are next.
- **Blockers:** the open asks in the newest session log, section 6.3: an AWS
  sign-in for Step 0, production failure examples, System A's files, approval
  for up to $30 of replay spend, and a separate approval for the judge.
- **Last required checks:** baseline on `271339b` with AWS credentials stripped:
  `npm test` 5 files failed, 238 passed, 1 skipped (1 test failed, 3108 passed,
  6 skipped), all five known; `npm run typecheck` clean;
  `node scripts/ci/feature-knowledge.mjs` OK; `node scripts/ci/docs-links.mjs` OK;
  `git diff --check` clean.
- **Smallest next action:** add `scripts/diagnostics/deliverables/capture.diag.ts`
  and run it on this branch.

## Session log index

Newest first:

- [2026-09-11: W1 harness specification](handoffs/2026-09-11-w1-harness-specification.md)
- [2026-09-10: deliverables gap diagnosis](handoffs/2026-09-10-deliverables-gap-diagnosis.md), back-filled

Authorities: [README](README.md), [feature knowledge framework](../README.md).
