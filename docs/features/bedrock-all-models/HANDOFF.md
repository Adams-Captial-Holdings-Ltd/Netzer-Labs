---
feature: bedrock-all-models
document_role: handoff
status: current
observed_at: 2026-09-14
as_of_commit: 1b6797ab643b08df0d39fd16de95f8a51876e551
---

# Bedrock all-models handoff

- Branch: `feature/bedrock-all-models`, cut from `origin/development` at
  `271339bc8b2feea85e6c31b115fdd34e757a72e2`, in the normal clone
  `C:\dev\_netzer-allmodels` (not a linked worktree); merge target:
  `development`. Per the
  [branch-to-environment mapping](../../../development.md#branch-to-environment-mapping),
  a `feature/*` branch reaches no AWS environment.
- Pushed: **no**, local commits only. PR: none. Deployment: none. Nothing from
  this campaign runs anywhere, and production is still Claude-only.
- Phases/tasks:
  - **WI-0 is complete.**
  - **WI-1 IMPLEMENTATION is complete. CLEANUP is next, then VERIFICATION.**
    - Specification `82d8473`; Codex build `10dc36c`. Inspection 1 returned REVISE.
    - Correction 1: tests `b220259` and `99df8a5`, then the Codex build `1c4379f`.
      Claude's check and the fresh inspection 2 both found that a client
      constructor that throws stopped discovery from ever retrying.
    - Correction 2: tests `0e2ca86`, then the Codex build `1b6797a`.
    - A fresh Opus inspection 3 returned APPROVED. Two low findings are
      carried into CLEANUP.
    - F7 is an accepted consequence: a non-Claude default model's context
      window now comes from the registry.
  - The owner directed on 2026-09-14 that Codex writes every build and
    correction, and Claude checks each one.

  Work items are defined in the [plan](plan.md#work-items-dependency-order).
- Blockers:
  - **Back-merge.** Production-only hotfixes are **not** ancestors of
    `origin/development`: `1abba67`, `d828124`, `1124118`, `8c14b3f` and the
    branch `hotfix/empty-turn-poisoning` (`3bffea6`), all on `origin/production`.
    - The WI-1 build session last re-checked this on 2026-09-14. The
      correction session did not re-check it.
    - The hotfixes change `agent-loop.ts`, `handler.ts`, `commands.ts` and
      `iam-stack.ts`.
    - **WI-2 through WI-9 must not start** until all five are ancestors of
      `origin/development` and the branch is rebased.
    - If the back-merge has not landed when WI-2's SPECIFICATION opens, stop and
      ask whether this campaign raises that PR itself.
  - **Consent.** Each of these needs the owner's explicit consent, separately,
    every time:
    - provider approval and `aws login`;
    - every push, PR, merge or promotion;
    - every deploy dispatch and every runtime-config write;
    - every live Bedrock call: the capability probe, the roll-call, and any first
      call to a provider, which accepts its Marketplace terms for the shared
      staging and production account.

    The full list is the plan's
    [consent gates](plan.md#consent-gates-carried-verbatim-into-every-handoff).
  - **Disk space.** On 2026-09-14 the C: drive swung between 1.3 GB and 5.6 GB
    free. WI-5's synth and WI-7's full validation need room.
- Last required checks, run in the clone by the correction session on
  2026-09-14:
  - `npx vitest run src/lib/bedrock` at `1b6797a`: 7 files, 104 tests passed.
  - `npm run typecheck` at `1b6797a`: exit 0.
  - `npm test` at `1b6797a`: files 5 failed | 241 passed | 1 skipped; tests
    1 failed | 3191 passed | 6 skipped. The red files are the same five
    pre-existing ones. The baseline is in the
    [WI-0 session handoff](handoffs/2026-09-13-wi0-setup.md), section 7.
  - `node scripts/ci/feature-knowledge.mjs`, with this session's docs staged:
    `feature-knowledge: OK`.
  - `node scripts/ci/docs-links.mjs`: `docs-links: 141 markdown files · 1788
    internal links checked · 74 external links skipped`, then `docs-links: OK`.
  - `git diff --check`: exit 0, for each Codex build before its commit and with
    `--cached` for the staged docs.
  - Not run: `npm run build`, the two `web/` checks and
    `npm run local:test:integration`. They belong to WI-7's full validation,
    before any push.
- Smallest next action: start WI-1 CLEANUP in a fresh session. The Gauntlet
  handoff is kept outside the repo, at
  `C:\Users\EmmanuelAdams\.claude\plans\bedrock-all-models-handoff.md`.

Session index (newest first):

- [2026-09-14 wi1-correction](handoffs/2026-09-14-wi1-correction.md) ← newest
- [2026-09-13 wi0-setup](handoffs/2026-09-13-wi0-setup.md)

Authorities: [README](README.md), [approved plan](plan.md),
[ADR 0003](../../adr/0003-bedrock-inference-profiles.md),
[ADR 0011](../../adr/0011-every-bedrock-model-for-agents.md) (proposed),
[feature knowledge framework](../README.md).
