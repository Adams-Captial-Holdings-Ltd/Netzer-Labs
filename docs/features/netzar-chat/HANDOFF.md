---
feature: netzar-chat
document_role: handoff
status: current
observed_at: 2026-09-21
as_of_commit: eee0a83d7cfd98cc498bf0a509da345925c1183c
---

# Netzar Chat handoff

- Branch state: the work was merged into `development` by PR #129 (merge
  `b3b427497d63d8f4d1faa147b46c9681c19bc460`, 2026-08-27). It is present on
  `origin/qa` and `origin/staging`, and is not present on `origin/production`.
  Per the branch-to-environment mapping, staging is the only AWS environment
  reached; production remains untouched.
- Phases: CHATUI-000 through CHATUI-006 are built and blind-critic accepted.
  CHATUI-007 is superseded; CHATUI-008 owns the remaining authenticated staging
  verification and full-journey blind critic.
- The documentation refresh merged as **PR `#182`** into `development`
  (`08f85db9d264c925ea22272b1386fbaed266b852`, 2026-09-21); its head branch
  `docs/wi-0.4-chat-docs` was deleted on `origin` and locally. That closed the
  last P0 work item, and a fresh whole-goal critic then passed the six-line P0
  exit gate at that commit.
- Current work lives on `feat/f1-test-foundations`, cut from
  `origin/development` at `08f85db`; merge target `development`. Pushed: **no**.
  **PR: none.** Deployment: none. This frontmatter still stamps `eee0a83`
  deliberately: every commit since then changes only Markdown under
  `docs/features/netzar-chat/`, so the source its claims describe is
  byte-identical, and moving the stamp would re-date every undated claim beneath
  it for no reason.
- Baseline recorded before any change on this branch, on 2026-09-21 at
  `08f85db`, alone in the checkout and with credentials stripped: the full
  `development.md` step 7 list **matches the baseline** — `npm test` 247 files /
  3215 tests exit 0, `guard-violations: 0`; `npm run local:test:integration` 38
  passed, 25 skipped, 1 failed, the known Floci `ListSecrets` gap
  (`destroy.integration.test.ts > checkSecrets … schedule-deleted`), confirmed by
  name and documented under *Known local limitations* item 9; all 11 other gates
  exit 0; 0 changed paths left behind. The emulator answering on `4566` was
  identified as `netzer-os-floci` / `floci/floci:1.6.0` **before** that
  integration result was read — a stray LocalStack there turns the one expected
  failure into a pass.
- Blockers: none for this documentation work. CHATUI-008 is blocked on **owner
  decision 6** — a dedicated spend-capped staging token and agent, authorized
  per run — before the authenticated staging QA and the dependent full-journey
  blind critic can start.
- Smallest next action: build the F1 test foundations — a thin local end-to-end
  harness that drives the Chat screen and reloads a conversation, and one added
  CI lane that runs it on every pull request. The authenticated staging half of
  F1 cannot start until owner decision 6's token exists. Promotion of
  `development` → `qa` → `staging` is owner decision 18, is still due, and needs
  its own authorization — the `qa` → `staging` merge runs a full
  `cdk deploy --all`.

Session index (newest first):
- [2026-09-21-final-p0-verification.md](handoffs/2026-09-21-final-p0-verification.md)
- [2026-09-21-wi-0.4-landing.md](handoffs/2026-09-21-wi-0.4-landing.md)
- [2026-09-20-wi-0.4-verification.md](handoffs/2026-09-20-wi-0.4-verification.md)
- [2026-09-20-wi-0.4-cleanup.md](handoffs/2026-09-20-wi-0.4-cleanup.md)
- [2026-09-20-wi-0.4-implementation.md](handoffs/2026-09-20-wi-0.4-implementation.md)
- [2026-09-20-wi-0.4-specification.md](handoffs/2026-09-20-wi-0.4-specification.md)
- [2026-08-27-phases-1-6-and-harvest.md](handoffs/2026-08-27-phases-1-6-and-harvest.md)
- [2026-08-25-phase-0-extraction.md](handoffs/2026-08-25-phase-0-extraction.md)
- [2026-08-25-phase-0-scaffolding.md](handoffs/2026-08-25-phase-0-scaffolding.md)

Authorities: [README](README.md), [approved plan / phase backlog](plan.md).
