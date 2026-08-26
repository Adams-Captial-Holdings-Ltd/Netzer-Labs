---
feature: netzer-chat
document_role: handoff
status: current
observed_at: 2026-08-25
as_of_commit: 554656e7289f407f2e7ad6ddcf14261964168739
---

# LibreChat chat UI port handoff

- Branch: `feature/netzer-chat` (canonical checkout: the full clone at
  `C:\dev\_netzer-librechat` — NOT a linked worktree, see ledger M6; a
  reference copy of this docs folder also sits untracked in
  `C:\dev\Netzer-Labs\docs\features\netzer-chat\`); merge target:
  `development`.
- Pushed: no. PR: none. Deployment: none (staging comes only via the
  `development → qa → staging` promotion after merge).
- Phases/tasks: CHATUI-000 (Phase 0) — the extraction is written and, as of
  this update, **verified for the first time**, but still **uncommitted**
  (`web/src/lib/chat/*`, two golden test files, `web/dev/` mock-SSE plugin,
  modified `Chat.tsx` + `web/vite.config.ts`). CHATUI-001…007 pending. See
  [plan.md](plan.md).
- Blockers: none technical; the session that wrote the extraction ended at a
  usage limit before running its own verification.

## Phase 0 status, corrected

The two session logs disagreed, and the disagreement is resolved by running the
code rather than by choosing a document.
[`2026-08-25-phase-0-extraction.md`](handoffs/2026-08-25-phase-0-extraction.md)
§6.1 claimed "Phase 0 leaves no loose ends", but its §7 *After changes* column
was entirely `(recorded at session close below)` placeholders — the session
ended before any of it ran, so nothing supported that claim. The framework's
tie-break applies: **the code wins**.

Running the documented next action settles it. The extraction is sound; what
was missing was evidence, not correctness.

| Check | Result |
|---|---|
| `npx vitest run src/adapters/dashboard/chat-stream.test.ts src/adapters/dashboard/chat-helpers.test.ts` | **pass** — 2 files, 54 tests (32 + 22) |
| `npm run typecheck` | **pass** — clean |
| `npm --prefix web run typecheck` | **pass** — clean |

Genuinely **not run** against these changes, and not to be recorded as passing:
`npm test` (full), `npm run build`, `npm --prefix web run build`,
`npm run local:test:integration`, `git diff --check`, and both documentation
gates. Note also that the full `npm test` has five pre-existing failures on an
untouched base — four are ledger entry **A7** (a Windows-only Vitest failure
importing `.mjs`: `docs-links`, `feature-knowledge`, `runnable-blocks`,
`sync-deprecations`) and the fifth is a Windows path separator in
`scripts/lib/lifecycle/rollback-classes.test.ts`. Compare a future run against
that list, not against zero.

## Uncommitted work in the tree

Left in place and not committed, per **P6** — it belongs to the extraction
session, not to this documentation update:

- modified: `web/src/pages/Chat.tsx`, `web/vite.config.ts`
- untracked: `src/adapters/dashboard/chat-helpers.test.ts`,
  `src/adapters/dashboard/chat-stream.test.ts`, `web/src/lib/chat/`, `web/dev/`

## Smallest next action

Commit the Phase 0 extraction — it now has evidence behind it — then run the
full pre-push validation list, since none of it has been run against these
changes. Phase 1 of the port plan follows.

## Session index

Newest first:

- [2026-08-25 — Phase 0 extraction](handoffs/2026-08-25-phase-0-extraction.md)
  — supersedes the scaffolding log below
- [2026-08-25 — Phase 0 scaffolding](handoffs/2026-08-25-phase-0-scaffolding.md)

Authorities: [README](README.md), [approved plan / phase backlog](plan.md).
