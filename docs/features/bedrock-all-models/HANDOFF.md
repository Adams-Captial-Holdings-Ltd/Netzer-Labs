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
- Phases/tasks: **WI-0** is the active task. Its documentation half (this
  folder, ADR 0011, the plan copy) completes with the commit that adds this
  file; its environment half (`npm ci --ignore-scripts` for the root and `web/`,
  then the `npm test` / `npm run typecheck` baseline) is the coordinator's and
  is pending. Next: **WI-1 SPECIFICATION**, which writes
  `src/lib/bedrock/capabilities.test.ts`, `catalog.test.ts` and
  `models-pricing.test.ts` red for the intended reason, commits them locally
  and freezes the Codex work order outside the checkout. Work items are defined
  in the [plan](plan.md#work-items-dependency-order).
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
  - Baseline `npm test` / `npm run typecheck`: **pending, run by the
    coordinator.** `npm ci` was still installing while WI-0's documentation was
    written, so no Vitest, `tsc` or build command ran in that session. Record
    the baseline's red files in the WI-1 session handoff before any source
    change. Earlier Windows baselines on other branches carried five known-red
    files (four `scripts/**` shebang parse failures and one path-separator
    assertion in `scripts/lib/lifecycle/rollback-classes.test.ts`); verify
    rather than assume.
- Smallest next action: once `npm ci` has finished in
  `C:\dev\_netzer-allmodels`, run `npm test` and `npm run typecheck` on the
  untouched tree and write the known-red files into the WI-1 session handoff;
  then write `src/lib/bedrock/capabilities.test.ts` red for the intended reason.

Session index (newest first):

- [2026-09-13 wi0-setup](handoffs/2026-09-13-wi0-setup.md) ← newest

Authorities: [README](README.md), [approved plan](plan.md),
[ADR 0003](../../adr/0003-bedrock-inference-profiles.md),
[ADR 0011](../../adr/0011-every-bedrock-model-for-agents.md) (proposed),
[feature knowledge framework](../README.md).
