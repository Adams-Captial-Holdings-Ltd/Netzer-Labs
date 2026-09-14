---
feature: bedrock-all-models
document_role: handoff
status: current
observed_at: 2026-09-13
as_of_commit: 271339bc8b2feea85e6c31b115fdd34e757a72e2
---

# Bedrock all-models handoff

- Branch: `feature/bedrock-all-models`, cut from `origin/development` at
  `271339bc8b2feea85e6c31b115fdd34e757a72e2`, in the normal clone
  `C:\dev\_netzer-allmodels` (not a linked worktree); merge target:
  `development`. Per the
  [branch-to-environment mapping](../../../development.md#branch-to-environment-mapping),
  a `feature/*` branch reaches no AWS environment.
- Pushed: **no**, local commits only. PR: none. Deployment: none; nothing from
  this campaign runs anywhere, and production is still Claude-only.
- Phases/tasks: **WI-0 is complete.** Its documentation half (this folder,
  ADR 0011, the plan copy) landed in `d90af11`; its environment half is done:
  root `npm ci --ignore-scripts` (332 packages; `web/` dependencies are
  deferred until WI-4 needs them) and the baseline below.
  **WI-1 is built; independent inspection returned REVISE:**
  - Specification `82d8473`: 63 failing tests plus `model-seeds.ts` (87 generated seeds).
  - Build `10dc36c`, written by Codex gpt-5.6-sol. The coordinator's rerun passes: `src/lib/bedrock` 84
    tests, typecheck clean. The full suite shows no regressions.
  - A fresh read-only Opus inspection returned REVISE with two medium findings in
    `catalog.ts`: no discovery deadline or page cap, and no backoff after a failed refresh. It also made
    six low findings. One targeted correction, re-inspection, cleanup and verification come next.

  Work items are defined in the [plan](plan.md#work-items-dependency-order).
- Blockers:
  - **Back-merge.** Production-only hotfixes `1abba67`, `d828124`, `1124118`,
    `8c14b3f` and the branch `hotfix/empty-turn-poisoning` (`3bffea6`) are on
    `origin/production` and are **not** ancestors of `origin/development`.
    Re-checked in this clone on 2026-09-13 with `git merge-base --is-ancestor`
    against remote refs fetched at 22:21 (UTC-4). They change `agent-loop.ts`,
    `handler.ts`, `commands.ts` and `iam-stack.ts`, so **WI-2 through WI-9 must
    not start** until all five are ancestors of `origin/development` and the
    branch is rebased. WI-0 and WI-1 may proceed because `src/lib/bedrock/` is
    identical on both branches. A back-merge task was started separately on
    2026-09-10; if it has still not landed when WI-2's SPECIFICATION opens,
    stop and ask whether this campaign raises that PR itself.
  - **Consent.** Provider approval, `aws login`, every push, PR, merge or
    promotion, every deploy dispatch, every runtime-config write, and every
    live Bedrock call (the capability probe, the roll-call, and any first call
    to a provider, which accepts its Marketplace terms for the shared
    staging/production account) need the owner's explicit consent, separately,
    each time. The full list is the plan's
    [consent gates](plan.md#consent-gates-carried-verbatim-into-every-handoff).
- Last required checks, run in the clone with the new files staged (the
  untouched-tree baseline is in the
  [session handoff](handoffs/2026-09-13-wi0-setup.md), section 7):
  - `node scripts/ci/feature-knowledge.mjs` — `feature-knowledge: OK`.
  - `node scripts/ci/docs-links.mjs` — `docs-links: 140 markdown files · 1758 internal links checked · 74 external links skipped`, then `docs-links: OK`.
  - `git diff --check` — clean (exit 0), for the working tree and with `--cached` for the staged files.
  - Baseline, run by the coordinator on 2026-09-13 in this clone on the
    untouched code (base `271339b`; the WI-0 commit `d90af11` touches no code):
    - `npm run typecheck` — exit 0 (23 s).
    - `npm test` — exit 1 (155 s). `Test Files 5 failed | 238 passed | 1 skipped (244)`;
      `Tests 1 failed | 3108 passed | 6 skipped (3115)`. The five red files, all
      pre-existing:
      - `scripts/release/sync-deprecations.test.ts`, `scripts/ci/runnable-blocks.test.ts`,
        `scripts/ci/feature-knowledge.test.ts` and `scripts/ci/docs-links.test.ts`
        fail at collection with `SyntaxError: Invalid or unexpected token` (the
        known `#!` shebang parse failure).
      - `scripts/lib/lifecycle/rollback-classes.test.ts > infra class > deploys the archived assembly with --app and diffs first`
        fails a deep-equal on the `cdk diff --app` arguments.
    - `CredentialsProviderError: Your session has expired` is logged by some
      tests but fails none. Full logs are kept outside the repo, under
      `C:\Users\EmmanuelAdams\.claude\gauntlet\bedrock-all-models\baseline\`.
- Smallest next action: write failing tests for the inspection's accepted
  findings (discovery deadline, page cap, failure backoff, frozen defaults,
  fail-closed config reads, dated/undated dedupe), then run the one targeted
  correction. The Gauntlet handoff is kept outside
  the repo, at `C:\Users\EmmanuelAdams\.claude\plans\bedrock-all-models-handoff.md`.

Session index (newest first):

- [2026-09-13 wi0-setup](handoffs/2026-09-13-wi0-setup.md) ← newest

Authorities: [README](README.md), [approved plan](plan.md),
[ADR 0003](../../adr/0003-bedrock-inference-profiles.md),
[ADR 0011](../../adr/0011-every-bedrock-model-for-agents.md) (proposed),
[feature knowledge framework](../README.md).
