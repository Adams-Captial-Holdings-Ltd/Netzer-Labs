---
feature: librechat-chat-ui
document_role: handoff
status: current
observed_at: 2026-08-25
as_of_commit: 06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710
---

# LibreChat chat UI port handoff

- Branch: `feature/librechat-chat-ui` (canonical checkout: the full clone at
  `C:\dev\_netzer-librechat` — NOT a linked worktree, see ledger M6; a
  reference copy of this docs folder also sits untracked in
  `C:\dev\Netzer-Labs\docs\features\librechat-chat-ui\`); merge target:
  `development`.
- Pushed: no. PR: none. Deployment: none (staging comes only via the
  `development → qa → staging` promotion after merge).
- Phases/tasks: CHATUI-000 (Phase 0) ~80% done but **unverified and
  uncommitted** — a builder agent wrote the extraction
  (`web/src/lib/chat/*`, two golden test files, `web/dev/` mock-SSE plugin,
  modified `Chat.tsx` + `web/vite.config.ts`) and its verification never ran.
  CHATUI-001…007 pending. See [plan.md](plan.md).
- Blockers: none technical; previous session ended at a usage limit.
- Last required checks actually run: baseline `npm test` twice on the untouched
  branch (5 files / 1 test failing, pre-existing — exact list in the session
  log §7); `node scripts/ci/feature-knowledge.mjs` OK;
  `node scripts/ci/docs-links.mjs` OK. Nothing has been run against the
  builder's changes.
- Smallest next action: from `C:\dev\_netzer-librechat`, run
  `npx vitest run src/adapters/dashboard/chat-stream.test.ts src/adapters/dashboard/chat-helpers.test.ts`
  and continue with session log §6.2.

Session index (newest first):
- [2026-08-25-phase-0-scaffolding.md](handoffs/2026-08-25-phase-0-scaffolding.md)

Authorities: [README](README.md), [approved plan / phase backlog](plan.md).
