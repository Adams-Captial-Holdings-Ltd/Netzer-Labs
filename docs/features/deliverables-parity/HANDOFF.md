---
feature: deliverables-parity
document_role: handoff
status: current
observed_at: 2026-09-14
as_of_commit: 6f4e09ef571c2b387e2068e871fac0bb39d8056b
---

# Deliverables parity handoff

- **Branch:** `chore/deliverables-parity`, in the normal clone `C:\dev\_netzer-diag`,
  from `origin/development` at `271339bc8b2feea85e6c31b115fdd34e757a72e2`.
  - Commits: `1a29a40` (this folder), `b1e2a19` (capture gate), `bc462df` (replay
    contract), `2af1e4f` (specification close), `d91efaf` (replay implementation),
    `86e616e` (implementation close), `6f4e09e` (replay cleanup), then the
    session-close docs.
  - **Merge target:** `development`, and only with the user's approval.
- **Local-only branch:** `diag/prod-capture` is `origin/production` `de244e6`
  plus overlays of `scripts/diagnostics/deliverables` (`f7194c1`, `51e85cb`,
  `b62849e`, `3bb9300`). It exists to run the harness on production's code. Never
  push it; delete it when W1 closes.
- **AWS environment:** none. `chore/*` deploys nothing, per the
  [branch mapping](../../../development.md#branch-to-environment-mapping). This
  work has made no AWS call.
- **Pushed:** no. **PR:** none. **Deployed:** no.
- **Work item:** round 1, W1 (Step 0 telemetry and the E1 output-budget
  ablation).
  - Gauntlet CLEANUP is complete: three behaviour-neutral edits to the replay,
    written by Codex (`gpt-5.6-luna`) at the user's request and verified by Claude.
  - A fresh VERIFICATION is next. The replay has never run against Bedrock.
- **Blockers:** Step 0 needs an AWS sign-in and the user's go. Also open:
  - production failure examples;
  - System A's files;
  - the incident's exact prompt wording;
  - approval for up to $30 of replay spend;
  - a separate approval for the judge, which must state that System A runs
    Sonnet 5 and the replay Sonnet 4.6.
- **Last required checks**, at `6f4e09e` plus the close docs:
  - `npm test` with AWS credentials stripped: 5 files failed, 238 passed,
    1 skipped; 1 test failed, 3108 passed, 6 skipped (83.97 s). These are the
    same five files as the baseline.
  - Typecheck clean.
  - `node scripts/ci/feature-knowledge.mjs` OK.
  - `node scripts/ci/docs-links.mjs` OK: 141 markdown files, 1775 internal links.
  - `git diff --check` clean.
  - Diagnostic suite on the production overlay `3bb9300`: 15 of 15 (capture 2,
    replay contract 10, prompts contract 3).
  - The replay CLI's golden master (three dry runs, seven refusals, the prompt
    export), run behind emulator placeholder credentials: byte-identical before
    and after the cleanup.
  - Not run: `npm run build`, both web commands, `npm run local:test:integration`.
    They are pre-push gates, and no push is planned.
- **Smallest next action:** in a fresh session, start Gauntlet VERIFICATION from
  `~/.claude/plans/claude-bedrock-deliverables-handoff.md`.

## Session log index

Newest first:

- [2026-09-14: W1 replay cleanup](handoffs/2026-09-14-w1-replay-cleanup.md)
- [2026-09-14: W1 replay implementation](handoffs/2026-09-14-w1-replay-implementation.md)
- [2026-09-11: W1 harness specification](handoffs/2026-09-11-w1-harness-specification.md)
- [2026-09-10: deliverables gap diagnosis](handoffs/2026-09-10-deliverables-gap-diagnosis.md), back-filled

Authorities: [README](README.md), [feature knowledge framework](../README.md).
