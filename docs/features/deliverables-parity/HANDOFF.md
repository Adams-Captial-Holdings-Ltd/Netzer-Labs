---
feature: deliverables-parity
document_role: handoff
status: current
observed_at: 2026-09-17
as_of_commit: cf0397f18b770ed522d22fc55039c132186a3b83
---

# Deliverables parity handoff

- **Branch:** `chore/deliverables-parity`, in the normal clone `C:\dev\_netzer-diag`,
  from `origin/development` at `271339bc8b2feea85e6c31b115fdd34e757a72e2`.
  - Commits:
    - `1a29a40` (this folder), `b1e2a19` (capture gate) and `bc462df` (replay contract);
    - `2af1e4f` (specification close), `d91efaf` (replay implementation) and `86e616e` (implementation close);
    - `6f4e09e` (replay cleanup), `b65f528` (cleanup close) and `f6410d9` (verification close);
    - `936957a`, `86651b6` and `d06a379` (the A12 contract), then `5512279` (the A12 implementation);
    - then `cf0397f` (the A12 session close docs) and the 2026-09-17 machine-transfer handoff.
  - **Merge target:** `development`, and only with the user's approval.
- **Local-only branch:** `diag/prod-capture` is `origin/production` `de244e6`
  plus overlays of `scripts/diagnostics/deliverables` (`f7194c1`, `51e85cb`,
  `b62849e`, `3bb9300`, `4cc8503`).
  - It exists to run the harness on production's code, and Step 2 must run from it.
  - Never push it; delete it when W1 closes.
  - 2026-09-17, owner override: `chore/deliverables-parity` is pushed as a backup (no PR) right after the machine-transfer commit; `diag/prod-capture` stays unpushed and is carried as a git bundle.
- **AWS environment:** none. `chore/*` deploys nothing, per the
  [branch mapping](../../../development.md#branch-to-environment-mapping). This
  work has made no AWS call.
- **Pushed:** not yet at the time of writing. The coordinator pushes this
  branch to origin under the same name immediately after the 2026-09-17
  machine-transfer commit, as an owner-approved backup (no PR, no merge, no
  deploy). Confirm with `git ls-remote origin refs/heads/chore/deliverables-parity`.
  `diag/prod-capture` is not pushed; it is devkit `bundles/diag-prod-capture.bundle`.
  **PR:** none. **Deployed:** no.
- **Work item:** round 1, W1 (Step 0 telemetry and the E1 output-budget
  ablation).
  - The W1 harness passed Gauntlet VERIFICATION on 2026-09-14.
  - A12 is settled. At the user's choice, the replay's $30 cap now also covers
    guardrail units and calls that cannot be metered, and a credential error
    stops a campaign.
  - Codex `gpt-5.6-luna` wrote `5512279`. It was verified on 2026-09-15 by two
    fresh Opus critics and a mutation check that caught 9 of 9 planted wrong
    implementations.
  - The replay has never run against Bedrock. Step 0 is next.
  - On 2026-09-17 the campaign's state was handed off for the move to a new
    Windows PC and a Mac. Non-git state goes to the private devkit; see that
    session log's section 8.
- **Blockers:** Step 0 needs an AWS sign-in and the user's go. Also open:
  - production failure examples;
  - System A's files;
  - the incident's exact prompt wording;
  - whether the deployed guardrail matches production's CDK policies, which
    size the allowance (Step 0 reads it);
  - approval for up to $30 of replay spend;
  - a separate approval for the judge, which must state that System A runs
    Sonnet 5 and the replay Sonnet 4.6.
- **Last required checks**, at `5512279` plus the session close docs:
  - `npm test` with AWS credentials stripped: 5 files failed, 238 passed,
    1 skipped; 1 test failed, 3108 passed, 6 skipped. These are the same five
    files as the baseline, which this session re-recorded at `f6410d9`.
  - Typecheck clean.
  - `node scripts/ci/feature-knowledge.mjs` OK.
  - `node scripts/ci/docs-links.mjs` OK: 143 markdown files, 1833 internal links.
  - `git diff --check` clean.
  - Replay contract on this branch: 16 of 16. Diagnostic suite on the overlay
    `4cc8503`: 18 of 18.
  - CLI golden master, behind the P12 tripwire and a network tripwire:
    - 13 of 16 cases byte-identical to `936957a`;
    - the three guardrail plans print the hand-derived allowance ($229.34 and
      $229.38);
    - no connection attempted.
  - Not run: `npm run build`, both web commands, `npm run local:test:integration`.
    They are pre-push gates. The 2026-09-17 push is a backup, not a promotion,
    and every commit after `5512279` changes only this folder.
  - At the 2026-09-17 machine-transfer commit, docs only:
    `node scripts/ci/feature-knowledge.mjs` OK; `node scripts/ci/docs-links.mjs` OK: 144 markdown files, 1867 internal links.
- **Smallest next action:** when the user has signed in to AWS and says go, start
  W1 Step 0 from `~/.claude/plans/claude-bedrock-deliverables-handoff.md`. On a
  new machine, restore first with Appendix A of the
  [2026-09-17 machine-transfer log](handoffs/2026-09-17-machine-transfer.md).

## Session log index

Newest first:

- [2026-09-17: machine transfer](handoffs/2026-09-17-machine-transfer.md)
- [2026-09-14: W1 A12 spend hardening](handoffs/2026-09-14-w1-a12-spend-hardening.md)
- [2026-09-14: W1 harness verification](handoffs/2026-09-14-w1-harness-verification.md)
- [2026-09-14: W1 replay cleanup](handoffs/2026-09-14-w1-replay-cleanup.md)
- [2026-09-14: W1 replay implementation](handoffs/2026-09-14-w1-replay-implementation.md)
- [2026-09-11: W1 harness specification](handoffs/2026-09-11-w1-harness-specification.md)
- [2026-09-10: deliverables gap diagnosis](handoffs/2026-09-10-deliverables-gap-diagnosis.md), back-filled

Authorities: [README](README.md), [feature knowledge framework](../README.md).
