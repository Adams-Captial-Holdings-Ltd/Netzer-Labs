---
feature: persistent-workspaces
document_role: handoff
status: current
observed_at: 2026-08-13
as_of_commit: 73383d0e0c0f06aa8010f5e0d4d246dfe7740e97
---

# Persistent agent workspaces handoff

- Branch: `feature/chat-history`; merge target: `development`.
- **Stacked on `feature/persistent-workspaces` (PR #34), which is open and
  green.** Both touch `web/src/pages/Chat.tsx`, so this branch was based on that
  one rather than on `development` to avoid a conflict on the `Message`
  interface and the SSE parser. **Merge #34 first.**
- Pushed: see below. PR: none for this branch yet. Deployment: none.
- Worked in `C:\dev\Netzer-Labs\.worktrees\chat-history`. **Not** the OneDrive
  copy — OneDrive sync locks files and broke `git worktree remove` there.
- Phases: M0 (document delivery, PR #34) complete. **M1 (conversation
  persistence) complete.** M2 (durable artifacts) and M3 (PPTX + editing) not
  started.
- Blockers: none for M1. **One product decision blocks M2**: whether artifacts
  are private to their creator or visible to everyone in the deployment.

## Baseline

Recorded on `development` (`8a66ba4`) before any change, Windows:

```
Test Files  5 failed | 176 passed | 1 skipped (182)
     Tests  1 failed | 1942 passed | 6 skipped (1949)
```

All five are pre-existing, Windows-only, and all in `scripts/` — four are parse
errors caused by importing `.mjs` helpers that begin with `#!/usr/bin/env node`
(vitest's transform cannot handle the shebang; proven by deleting one, which
made 7 tests pass), and the fifth asserts POSIX path separators. **None are in
`src/`.** CI on ubuntu-latest is green, so these do not gate anything.

## Commands actually run, after M1

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **5 failed / 178 passed files; 1 failed / 1960 passed tests** — the same five pre-existing failures, plus 6 new passing tests |
| `npm run build` | clean |
| `npm --prefix web run typecheck` | clean |
| `npm --prefix web run build` | built in 21.73s |
| `npm run local:test:integration` | **38/39 passed** — 7 of those are new |
| `node scripts/ci/docs-links.mjs` | see below |
| `node scripts/ci/feature-knowledge.mjs` | see below |
| `git diff --check` | see below |

The single integration failure is
`scripts/destroy.integration.test.ts > checkSecrets … schedule-deleted`, which
`development.md` documents as the expected result for this command
("31/32 passing, 1 known emulator gap" — now 38/39 with the new tests): Floci's
`ListSecrets` omits secrets scheduled for deletion. Not modified.

Docker Desktop lives at `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe`,
not under Program Files. `npm run local:verify` passed all five isolation checks
before provisioning.

## M1 as landed

- `isPersistentChat(chatId)` — a chat persists iff its id starts with
  `dashboard:`. Matched on the id rather than the surface because
  `setModelOverride` and `clearSession` also write the TTL and see nothing but
  the id.
- All **three** TTL write paths honour it. `appendTurns` omits the attribute
  from its `PutCommand` item (which also strips a `ttl` left on rows written
  before this change); `setModelOverride` and `clearSession` switch their
  `UpdateExpression` to `REMOVE #t` and drop the now-unused `:t` value, because
  DynamoDB rejects a declared-but-unused expression value.
- `web/src/pages/Chat.tsx` gains a conversation sidebar, resume-on-select, and
  `sessionStorage` persistence of the active `chatId`. It calls
  `clearApiCache()` after a turn — `send()` uses a raw `fetch`, so nothing
  otherwise invalidates the 60s GET cache and the new conversation would not
  appear in the list.
- The "New chat" confirm copy was corrected: it claimed the current messages
  "won't be recoverable", which is no longer true now that they persist.
- No new endpoint. `GET /api/sessions` and `GET /api/sessions/transcript`
  already existed and were used unchanged.

## Smallest next action

Merge PR #34, then open a PR for this branch into `development`.

After that, M2 (durable artifacts) — but answer the visibility question first.

Authorities: [README](README.md), [ADR 0002](../../adr/0002-single-tenant.md),
[ADR 0009](../../adr/0009-mission-container-model.md).
