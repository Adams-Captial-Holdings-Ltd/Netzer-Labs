---
feature: bedrock-all-models
document_role: handoff
status: current
observed_at: 2026-09-17
as_of_commit: 94e36864e76e7f7e1bfa4c1b5743f543f10bbaad
---

# Bedrock all-models handoff

- Branch: `feature/bedrock-all-models`, cut from `origin/development` at
  `271339bc8b2feea85e6c31b115fdd34e757a72e2`, in the normal clone
  `C:\dev\_netzer-allmodels` (not a linked worktree); merge target:
  `development`. Per the
  [branch-to-environment mapping](../../../development.md#branch-to-environment-mapping),
  a `feature/*` branch reaches no AWS environment.
- Tip before the machine-transfer docs commit:
  `94e36864e76e7f7e1bfa4c1b5743f543f10bbaad`. The last code commit is
  `1b6797ab643b08df0d39fd16de95f8a51876e551`.
- Pushed: not yet at the time of writing; the coordinator pushes this branch to
  origin under the same name immediately after this commit as an
  owner-approved backup (no PR, no merge, no deploy) - confirm with
  `git ls-remote origin refs/heads/feature/bedrock-all-models`.
  - The owner approved that one backup push on 2026-09-17. Every later push,
    PR, merge or promotion still needs its own consent.
- PR: none. Deployment: none. Nothing from this campaign runs anywhere, and
  production is still Claude-only.
- Machine transfer (2026-09-17): development is moving off this Windows PC to a
  new Windows PC and a Mac.
  - The campaign's non-git state (plans, gauntlet folder, progress page,
    scratchpads) goes into the private devkit
    `https://github.com/emmanuelmadams4-lgtm/netzer-devkit`.
  - The [machine-transfer session log](handoffs/2026-09-17-machine-transfer.md)
    maps every file, in section 8 and Appendix A.
- Phases/tasks:
  - **WI-0 is complete.**
  - **WI-1 IMPLEMENTATION is complete. CLEANUP is next, then VERIFICATION.**
    Gauntlet state: DIRECT_COORDINATOR / CLEANUP.
    - Specification `82d8473`; Codex build `10dc36c`. Inspection 1 returned REVISE.
    - Correction 1: tests `b220259` and `99df8a5`, then the Codex build `1c4379f`.
      Claude's check and the fresh inspection 2 both found that a client
      constructor that throws stopped discovery from ever retrying.
    - Correction 2: tests `0e2ca86`, then the Codex build `1b6797a`.
    - A fresh Opus inspection 3 returned APPROVED. Two low findings are
      carried into CLEANUP as test-first items: I3-1 and I3-2.
    - CLEANUP has not started. Nothing happened on this campaign after
      2026-09-14 15:53 (UTC-4).
    - F7 is an accepted consequence: a non-Claude default model's context
      window now comes from the registry.
  - The owner directed on 2026-09-14 that Codex writes every build and
    correction, and Claude checks each one. The builder is gpt-5.6-sol at high
    effort, through the claudex runner.

  Work items are defined in the [plan](plan.md#work-items-dependency-order).
- Blockers:
  - **Back-merge.** Production-only hotfixes are **not** ancestors of
    `origin/development`: `1abba67`, `d828124`, `1124118`, `8c14b3f` and the
    branch `hotfix/empty-turn-poisoning` (`3bffea6`), all on `origin/production`.
    - Re-checked on 2026-09-17 without fetching; all five checks still exit 1.
      - This clone's `FETCH_HEAD` is from 2026-09-14 10:00 (UTC-4).
      - The main checkout's refs, fetched 2026-09-16 10:04, agree:
        `origin/development` is still `271339b`.
    - The hotfixes change `agent-loop.ts`, `handler.ts`, `commands.ts` and
      `iam-stack.ts`.
    - **WI-2 through WI-9 must not start** until all five are ancestors of
      `origin/development` and the branch is rebased. Fetch and re-check first.
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
  - **ADR number clash.** This branch's
    [ADR 0011](../../adr/0011-every-bedrock-model-for-agents.md) and
    `feature/release-pipeline-v1`'s `0011-release-artifact-identity.md` share
    a number. Renumber whichever merges into `development` second.
  - **Machine-bound tooling.** The paths below must be translated on the new machine:
    - `seed-generator.mjs` lines 7-8 hard-code Windows paths;
    - the resume prompt's `--cli` path no longer exists even on this PC. Use
      the `codex` CLI on PATH.
  - **Disk space.** This PC's C: drive had 2.9 GB free on 2026-09-17. Measure
    the new machine before WI-5's synth and WI-7's full validation.
- Last required checks:
  - Code, run in the clone by the correction session on 2026-09-14:
    - `npx vitest run src/lib/bedrock` at `1b6797a`: 7 files, 104 tests passed.
    - `npm run typecheck` at `1b6797a`: exit 0.
    - `npm test` at `1b6797a`: files 5 failed | 241 passed | 1 skipped; tests
      1 failed | 3191 passed | 6 skipped. The red files are the same five
      pre-existing ones. The baseline is in the
      [WI-0 session handoff](handoffs/2026-09-13-wi0-setup.md), section 7.
    - Not run: `npm run build`, the two `web/` checks and
      `npm run local:test:integration`. They belong to WI-7's full validation,
      before any push beyond the backup.
  - Docs, run in the clone by the machine-transfer session on 2026-09-17:
    - `node scripts/ci/feature-knowledge.mjs`: `feature-knowledge: OK`, both
      at `94e3686` and with this session's docs staged.
    - `node scripts/ci/docs-links.mjs`: `docs-links: OK`, both at `94e3686`
      and with this session's docs staged. The link counts are in the session
      log, section 7.
- Smallest next action: start WI-1 CLEANUP in a fresh session from the resume
  handoff.
  - On this PC it is `C:\Users\EmmanuelAdams\.claude\plans\bedrock-all-models-handoff.md`.
  - On a new machine, after the devkit restore, it is
    `~/.claude/plans/bedrock-all-models-handoff.md` (devkit
    `claude/plans/bedrock-all-models-handoff.md`).
  - It is embedded verbatim in the machine-transfer session log, Appendix A.

Session index (newest first):

- [2026-09-17 machine-transfer](handoffs/2026-09-17-machine-transfer.md) ← newest
- [2026-09-14 wi1-correction](handoffs/2026-09-14-wi1-correction.md)
- [2026-09-13 wi0-setup](handoffs/2026-09-13-wi0-setup.md)

Authorities: [README](README.md), [approved plan](plan.md),
[ADR 0003](../../adr/0003-bedrock-inference-profiles.md),
[ADR 0011](../../adr/0011-every-bedrock-model-for-agents.md) (proposed),
[feature knowledge framework](../README.md).
