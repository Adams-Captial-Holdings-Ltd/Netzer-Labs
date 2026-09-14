---
feature: deliverables-parity
document_role: handoff
status: current
observed_at: 2026-09-14
as_of_commit: d91efaf25d53546bc1cd06763f55405460e67a8f
---

# Deliverables parity handoff

- **Branch:** `chore/deliverables-parity`, in the normal clone `C:\dev\_netzer-diag`,
  from `origin/development` at `271339bc8b2feea85e6c31b115fdd34e757a72e2`.
  Commits: `1a29a40` (this folder), `b1e2a19` (capture gate), `bc462df` (replay
  contract), `2af1e4f` (specification close), `d91efaf` (replay implementation),
  then the session-close docs. **Merge target:** `development`, and only with the
  user's approval.
- **Local-only branch:** `diag/prod-capture` is `origin/production` `de244e6`
  plus overlays of `scripts/diagnostics/deliverables` (`f7194c1`, `51e85cb`,
  `b62849e`). It exists to run the harness on production's code. Never push it;
  delete it when W1 closes.
- **AWS environment:** none. `chore/*` deploys nothing, per the
  [branch mapping](../../../development.md#branch-to-environment-mapping). This
  work has made no AWS call.
- **Pushed:** no. **PR:** none. **Deployed:** no.
- **Work item:** round 1, W1 (Step 0 telemetry and the E1 output-budget
  ablation). Gauntlet IMPLEMENTATION is complete: the replay contract is green,
  and `replay.ts` has a `main()` that is a dry run unless told to spend. CLEANUP
  is next, then a fresh VERIFICATION. The replay has never run against Bedrock.
- **Blockers:** Step 0 needs an AWS sign-in and the user's go. Also open:
  production failure examples, System A's files, the incident's exact prompt
  wording, approval for up to $30 of replay spend, and a separate approval for
  the judge, which must state that System A runs Sonnet 5 and the replay Sonnet 4.6.
- **Last required checks**, at `d91efaf` plus the close docs:
  - `npm test` with AWS credentials stripped: 5 files failed, 238 passed,
    1 skipped; 1 test failed, 3108 passed, 6 skipped (95.90 s), the same five
    files as the baseline. Typecheck clean. `node scripts/ci/feature-knowledge.mjs`
    OK; `node scripts/ci/docs-links.mjs` OK: 140 markdown files, 1747 internal links;
    `git diff --check` clean.
  - Diagnostic suite on the production overlay `b62849e`: 15 of 15 (capture 2,
    replay contract 10, prompts contract 3).
  - Dry run of `replay.ts`, twice: plan and estimate printed, nothing sent. Every
    `--spend` refusal checked behind emulator placeholder credentials.
  - Not run: `npm run build`, both web commands, `npm run local:test:integration`.
    They are pre-push gates, and no push is planned.
- **Smallest next action:** in a fresh session, start Gauntlet CLEANUP from
  `~/.claude/plans/claude-bedrock-deliverables-handoff.md`.

## Session log index

Newest first:

- [2026-09-14: W1 replay implementation](handoffs/2026-09-14-w1-replay-implementation.md)
- [2026-09-11: W1 harness specification](handoffs/2026-09-11-w1-harness-specification.md)
- [2026-09-10: deliverables gap diagnosis](handoffs/2026-09-10-deliverables-gap-diagnosis.md), back-filled

Authorities: [README](README.md), [feature knowledge framework](../README.md).
