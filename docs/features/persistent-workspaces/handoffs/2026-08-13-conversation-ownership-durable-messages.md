---
feature: persistent-workspaces
document_role: session-handoff
status: current
observed_at: 2026-08-13
as_of_commit: ef7c6c010db4d5535a78c03265ead0a411b13977
session_slug: conversation-ownership-durable-messages
supersedes: none
---

<!-- Frontmatter retained so this file keeps its place in the feature folder
     (docs/features/README.md §2-§4). Body follows the handoff template. -->

# Handoff: Per-user conversation ownership + durable transcripts (M1.5)

## Session Metadata

- Created: 2026-08-13
- Project: `C:\dev\Netzer-Labs` (worktree `.worktrees/conversation-history`)
- Branch: `feature/conversation-history` → merges into `development`; reaches
  **no** AWS environment ([branch mapping](../../../../development.md#branch-to-environment-mapping))
- Commits: start `27cde44` → end `ef7c6c0` (+ `88c03e6` docs). **Pushed.** No PR yet. Not deployed.
- Session duration: one working session, paused mid-frontend at user request

## Current State Summary

Built the two follow-ups the feature README names as approved next work after
M1 (PR #36): **full transcript retention** (M1 caps a reopened conversation at
the 20-turn session window) and **per-user conversations** (M1's sidebar reads
agent-scoped `GET /sessions?agentId=`, which is org-visible and needs
`sessions:read`). **The entire backend delta is implemented and green.** The
frontend refactor of `web/src/pages/Chat.tsx` is mid-flight: web typecheck is
**RED with exactly four known errors**, each enumerated with its fix in
[Immediate Next Steps](#immediate-next-steps). The Floci integration suite has
not run this session, so the new integration test has never executed.

Pushed WIP at the user's request **before** the full pre-push validation list —
an explicit, user-approved deviation from `development.md` step 7, recorded
here rather than glossed. Nothing in the verification table is claimed as run
that did not run.

## Codebase Understanding

### Architecture Overview

- **The agent loop is persistence-agnostic.** `runAgentTurn`
  (`src/agent/agent-loop.ts:484`) takes caller-supplied `history: Turn[]` and
  never reads or writes storage; every caller does
  `getSession → runAgentTurn → appendTurns`. All conversation wiring therefore
  lands in the callers, and the loop was not touched.
- **Conversations ride the existing sessions table** (ADR 0010), like
  `jarvis-memory-repo` does with its own `JARVIS#` partition. Two new item
  types, zero infra change: owner meta `USER#<ownerId>` / `CONV#<convId>`, and
  messages `CONV#<convId>` / `MSG#<pad13(ms)>#<0|1>#<uuid>`. Neither carries
  `ttl`, so DynamoDB never expires them.
- **`conversationId` IS the session `chatId`** (`dashboard:c_<uuid>`), so M1's
  `isPersistentChat`, the 20-turn window, memory ingest and model override all
  keep working unchanged. The session row remains the *model context*; the
  message items are the *product transcript*. They are allowed to differ.
- **Ownership is structural, not a filter.** The meta is only ever read under
  the caller's own partition, so another user's conversation is
  indistinguishable from a nonexistent one — uniform 404, no existence leak.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `src/lib/state/conversations-repo.ts` | Owner meta + durable messages, ownership, idempotency fence | The whole data model lives here |
| `src/adapters/dashboard/conversations.ts` | `GET /api/conversations[/:id]`, `chat:read` | The owner-scoped read API the rail consumes |
| `src/adapters/dashboard/handler.ts` (stream route, ~`:1599-1880`) | Send path | Pre-stream ownership 404 + duplicate 409; `persistTurn` + `conversation` SSE event inside the `!blocked` block |
| `src/lib/state/sessions-repo.ts` | M1 window/TTL/ingest + `isPersistentChat` | Must keep working untouched; `appendTurns` is a full-item Put that drops unlisted attributes |
| `web/src/pages/Chat.tsx` | Chat UI | **Incomplete** — the four typecheck errors are all here |
| `src/adapters/dashboard/test-turn-attachments.test.ts:81-86` | Partial module mock | The harness pattern every stream-route test copies |
| `src/lib/state/identities-repo.integration.test.ts:15-33` | Floci skeleton | Env + `TABLE_*` must be set **before** the dynamic import |

### Key Patterns Discovered

- Repo unit tests mock the client, not the SDK:
  `vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }))`, then assert on
  `send.mock.calls[i][0].input`. No `aws-sdk-client-mock` in this repo.
- Route tests drive the **real** router via `app.request()`, stubbing only the
  token-auth entrypoints so real capability resolution still runs.
- Partial module mocks (`async (importActual) => ({ ...actual, fn: mock })`)
  keep the parts of a module that are themselves the contract under test —
  e.g. the real `conversationOwnerId` and `isConversationChatId`.
- Error-shape house style: `{error:'unauthorized'}` 401,
  `{error:'forbidden', requiredCapability}` 403, uniform `{error:'not_found'}` 404.
- Timestamps in the sessions table are **epoch seconds**; `formatRelativeTime`
  takes seconds while `formatLocalTime` takes milliseconds.
- No cursor pagination exists anywhere in this API; the house style is bounded
  materialize → sort → slice.

## Work Completed

### Tasks Finished

- [x] Rescoped the approved plan after PR #36 landed mid-planning; branch based on `27cde44`
- [x] Recorded the untouched-branch baseline before any change
- [x] ADR 0010 written (storage, ownership, idempotency, stream-disconnect behavior)
- [x] `conversations-repo` + unit tests (15/15), test-first
- [x] Floci integration test **written** (never executed — see Blockers)
- [x] `conversations.ts` router + tests (7/7) + authz-matrix rows + `server.ts` mount
- [x] Stream-route wiring + contract tests (6/6); legacy-path regression suites re-run untouched-green
- [x] GDPR export/purge coverage of the durable items + tests (4/4)
- [x] Frontend `format.ts`, `api.ts`, `App.tsx` complete
- [ ] **`Chat.tsx` mid-refactor — web typecheck RED**
- [ ] Feature README update, how-it-works prose, full validation, manual pass, PR

### Verification Actually Performed

Never record a command as passing unless it ran. `not run` is an acceptable answer; a false `pass` is not.

| Command | Baseline (untouched `27cde44`) | After changes |
|---------|-------------------------------|---------------|
| `npm run typecheck` | not run separately | **clean** (run twice, last after GDPR wiring) |
| `npm test` | **7 failed / 176 passed files; 20 failed / 1941 passed / 6 skipped** | not re-run in full |
| `npm run build` | not run | not run |
| `npm --prefix web run typecheck` | not run | **RED — 4 known errors**, all in `Chat.tsx` |
| `npm --prefix web run build` | not run | not run |
| `npm run local:test:integration` | not run | not run (Docker/Floci never started) |
| `node scripts/ci/docs-links.mjs` | not run | **OK** — 79 files, 501 links |
| `node scripts/ci/feature-knowledge.mjs` | not run | **OK** |
| `git diff --check` | not run | clean |

Focused suites that did run, all green: repo 15/15 · router 7/7 ·
authz-matrix + server 115/115 · stream contract 6/6 · GDPR 4/4 · regression
re-runs (`test-turn-attachments` 6/6, `test-turn-costcap`,
`sessions-repo.persistence`, `sessions-repo.ingest`) 26 tests.

**Baseline detail** (all pre-existing, none caused by this work): four
`scripts/` files fail to parse (shebang in imported `.mjs`),
`buildspec-tag-normalization` needs `sh` (6 tests),
`rollback-classes` asserts POSIX separators (1 test) — all Windows-only,
CI on ubuntu is green — plus `src/adapters/dashboard/jarvis.flow.test.ts`
(13 tests, the documented credential-chain timeout flake, **reproduced twice**
per `development.md`'s procedure: once in the full run, once solo on a warm
transform cache).

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| `src/lib/state/conversations-repo.ts` + `.test.ts` + `.integration.test.ts` | New | Owner meta + durable messages in the sessions table |
| `src/adapters/dashboard/conversations.ts` + `.test.ts` | New | Owner-scoped list/detail under `chat:read` |
| `src/adapters/dashboard/handler.ts` | Edit, stream route only | Body fields; pre-stream 404/409; `persistTurn` + additive `conversation` SSE event; agent pinning |
| `src/adapters/dashboard/test-turn-conversations.test.ts` | New | Ownership / 409 / pinning / persistence / blocked / legacy-untouched |
| `src/adapters/dashboard/authz-matrix.test.ts` | Edit | Two conversation routes registered across all four tiers |
| `src/server.ts` | Edit | Mount `/api/conversations` before the `/api` catch-all |
| `src/lib/tools/privacy-tools.ts` + `.test.ts` | Edit / New | Export includes the durable transcript; purge deletes messages + meta for `dashboard:c_*` |
| `web/src/lib/format.ts` | Edit | `dateGroupLabel` — Today / Yesterday / Previous 7 days / Older |
| `web/src/lib/api.ts` | Edit | `ConversationSummary`, `ConversationMessageView`, `ConversationDetail` |
| `web/src/App.tsx` | Edit | `/chat/c/:conversationId` **before** `/chat/:agentId` |
| `web/src/pages/Chat.tsx` | Edit, **INCOMPLETE** | Server-minted ids, rail re-point, deep links, 409/404 handling |
| `docs/adr/0010-...md` | New | The storage/ownership/idempotency decision |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Build the delta **on top of** PR #36, undoing nothing | Replace M1's TTL/rail approach with the pre-#36 plan | M1 is correct and shipped; its README lists exactly this delta as next work |
| Ride the sessions table | New `conversations`/`messages` tables (War Room shape) | ~10 infra touchpoints per new table for no P0 benefit; jarvis precedent proves the pattern |
| `conversationId` == `chatId` | Separate id mapped to a chatId | One identifier, no mapping; `safeDashboardChatId` passes it through untouched |
| Time-sorted message SK `MSG#<pad13(ms)>#<0\|1>#<uuid>` | War Room `SEQ#` + `allocateSeq` counter | Both messages of a turn are written from one code path at one instant; a counter round-trip buys nothing |
| Send-path history stays `session.turns` | Always rebuild from durable messages | Sessions never expire post-M1, so rebuild solved a problem that no longer exists — smaller diff |
| Idempotency = `lastClientMessageId` on the meta | Dedicated idempotency items | The meta is already read for ownership: zero extra I/O; the composer sends serially so a retry is always the last message |
| No migration of pre-#36 conversations into the owner rail | Ownership-adoption markers with a conditional first-writer | Guessable timestamp ids + adoption races is real machinery for hours-old data; legacy chats stay reachable in the admin Sessions tab |

## Errors, Mistakes & Learnings

### Errors Encountered

| Error / Symptom | Cause | Resolution | Status |
|-----------------|-------|------------|--------|
| Router list tests 404 while detail tests passed | Hono strips the trailing slash: a router mounted at a prefix with a `/` route matches the **bare prefix** | Request `''` not `'/'` for the root route (the pattern `authz-matrix.test.ts:216-219` already documents) | Resolved |
| `expect(persistTurnMock).toHaveBeenCalled()` → "called 0 times", while the route worked | With `streamSSE` the handler body executes **as the response is consumed**; assertions before `await res.text()` observe nothing | Drain the stream first, then assert | Resolved |
| `TS18046: 'body' is of type 'unknown'` | `res.json()` returns `unknown` under this tsconfig | Cast at the call site: `(await res.json()) as { … }` | Resolved |
| Em-dashes became `â€"` in a source file | A PowerShell `(Get-Content -Raw) -replace … \| Set-Content -Encoding utf8` round-trip re-encoded existing UTF-8 bytes | Repaired with the Edit tool; grepped the tree for other mojibake (none) | Resolved |
| 13 `jarvis.flow.test.ts` tests time out at 5000ms | Pre-existing flake: mocked reads fall through to the real AWS credential chain (~2s each) | Not touched — reproduced twice and recorded as baseline | Open (pre-existing, documented) |

### Mistakes Made & Corrections

Carried forward from the repository ledger (`M1`–`M8`), then appended. Nothing
is deleted; a fixed entry is marked `RESOLVED (<commit>)` and stays.

| # | Mistake | Impact | Correction | Lesson |
|---|---------|--------|------------|--------|
| M1 | Feature-documentation conventions written on several pages at once | Copies drifted; no page was trustworthy | Single spec in the framework, machine-checked | One rule, one home, enforced by CI not discipline |
| M2 | Root `handoff.md` used as live operational state | Became a stale global handoff contradicting per-feature ones | Reduced to a one-sentence pointer; CI fails if it grows back | Operational state is per-feature; a global handoff always rots |
| M3 | `dynamo-stack.ts` header claims "All 14 DynamoDB tables" | It creates **32**; misled table-count work | Read the synthesized template, never the comment | Comments are not authorities |
| M4 | CodeBuild deploy branch default changed `main`→`production`, then reverted | Churn on a live CI path | Reverted in `4ce27a7`, doc fixes kept | Establish why it was reverted before re-applying |
| M5 | A handoff recorded checks as complete on a machine with no Node runtime | The next reader would have trusted an unverified contract | Disclosed; Docs CI became the first real execution | Disclosure is the minimum; running the check is the goal |
| M6 | Targeted Vitest run inside a Windows linked worktree | Startup failed, no tests collected | Ran from a normal checkout | *Superseded by A7 — the full suite does run in a worktree* |
| M7 | Assumed `npm run test:integration:up` was safe alongside the local stack | Starts LocalStack on 4566 and collides with Floci | Use `npm run local:test:integration` | One emulator on 4566, ever |
| M8 | Created `.env` while several lifecycle scripts default their env flag to **prod** and read it | Previously inert commands became genuinely dangerous | Catalogued in [dangerous commands](../../../../development.md#dangerous-commands-never-run-locally) | Read that list before any unfamiliar `npm run` |
| **M9** | Planned an entire feature against `8a66ba4` while a parallel session shipped overlapping work (PR #36) | The plan's core mechanism (rebuild context after session expiry) was obsolete before implementation started | `git fetch` + diffed the anchor files before writing code; rescoped to a delta and recorded it | **Re-fetch and re-read the anchors immediately before implementing a plan that was written earlier** |
| **M10** | Scaffolded a second feature folder (`docs/features/conversation-history/`) for work that belonged to `persistent-workspaces` | Would have split one feature's record across two folders — the exact failure M1 describes | Folded into the existing folder, deleted before any commit | Search `docs/features/` for an owning folder before creating one |
| **M11** | Used a PowerShell regex round-trip to edit a source file | Corrupted every em-dash in it | Repaired with Edit; grepped for further mojibake | Use the Edit tool for source files; PowerShell text rewriting is not encoding-safe here |

### Key Learnings

- **`streamSSE` executes the handler body lazily.** Any assertion about what a
  streaming route did must come *after* the response body is drained. This
  will bite every future test of `/test-turn/stream`.
- **hono 4.12.27's `StreamingApi.write` swallows write errors** (verified in
  `node_modules/hono/dist/utils/stream.js`), and nothing wires an abort signal
  into `runAgentTurn`. So a browser refresh mid-stream does **not** abort the
  turn: it completes server-side and persistence still runs. That is why P0
  needs no reconnect infrastructure — reload simply shows the finished reply.
- **Ownership by partition beats ownership by filter.** Reading the meta only
  under the caller's own partition means there is no cross-partition lookup to
  get wrong, and "not yours" and "doesn't exist" are the same code path.
- **Two representations of a conversation are fine if their roles are named.**
  Session `turns` = model context (rolling, trimmed, feeds memory ingest);
  message items = product transcript (durable, complete). Conflating them was
  the original design pressure to widen `MAX_TURNS`, which the item-size budget
  can't absorb.
- **The dashboard `userId` on session rows is a per-login token hash** and
  rotates on every magic-link sign-in — unusable for ownership. The stable id
  is `principal.userId`, absent for the root token and legacy minted tokens,
  hence the `userId ?? 'root' ?? token:<hashPrefix16>` ladder.

### Prevention / Future Guidance

Carried forward (`P1`–`P9`), then appended.

- **P1** Record a baseline before changing anything, or a pre-existing failure is indistinguishable from a regression you caused.
- **P2** Never record a command as passing unless it actually ran. Say what you skipped and why.
- **P3** Name the branch. Never write "ready for production" — four long-lived branches exist and only two reach AWS.
- **P4** Run the FULL `npm test` before pushing, never a scoped run ([CLAUDE.md](../../../../CLAUDE.md)).
- **P5** When a document and the code disagree, **the code wins**. Fix the document.
- **P6** Never force-add unrelated uncommitted work found in the tree; preserve it and hand it back.
- **P7** Delete a transient branch once it merges.
- **P8** Run `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/docs-links.mjs` before pushing docs changes.
- **P9** Never restate feature-documentation rules outside the framework.
- **P10** *(new)* Before implementing a plan written earlier in the session,
  `git fetch` and diff the files the plan anchors on. A parallel session can
  land overlapping work mid-planning (see M9).
- **P11** *(new)* Edit source files with the Edit tool, never a PowerShell
  regex round-trip — the re-encode corrupts non-ASCII characters (M11).
- **P12** *(new)* When testing a `streamSSE` route, `await res.text()` before
  asserting on any mock.
- **P13** *(new)* A new dashboard route that reads user data must be proven
  against a **non-owner** principal, not only an unauthenticated one. The
  404-not-403 shape is deliberate: it must not leak existence.

## Pending Work

### Immediate Next Steps

1. **Fix the four web-typecheck errors in `web/src/pages/Chat.tsx`** — the tail
   of the rail-render refactor, enumerated by `npm --prefix web run typecheck`:
   - `Chat.tsx(158)` — `conversations` state is still typed
     `useState<Conversation[]>`; that interface was replaced by
     `ConversationSummary` (already imported). Change the type argument.
   - `Chat.tsx(~526)` — rail rows still reference the removed `chatId` state:
     `c.chatId === chatId` → `c.conversationId === conversationId`;
     `openConversation(c.chatId)` → `openConversation(c.conversationId)`;
     `key={c.chatId}` → `key={c.conversationId}`. While here, apply the planned
     grouping: bucket rows by `dateGroupLabel(c.updatedAt)` (imported but
     unused → error TS6133) under Today / Yesterday / Previous 7 days / Older
     headers, and show each row's agent display name — the rail is now
     cross-agent.
   - `Chat.tsx(~578)` — header still renders `{chatId}`; render
     `{conversationId ?? 'new conversation'}`, keeping the `InfoTooltip`.
   - Re-run `npm --prefix web run typecheck` until clean, then
     `npm --prefix web run build`.
2. **Run the integration suite for the first time**: `npm run local:up`,
   `npm run local:provision`, then `npm run local:test:integration`. Expect
   39/40 — the new file adds one, and `destroy.integration` fails on the known
   Floci `ListSecrets` gap.
3. **Docs**: update the feature [README](../README.md) (what it does today,
   implementation map, close the two risk rows this branch fixes, add ADR 0010
   to `decisions:` and the new tests to `tested_by:`), and the
   `docs/how-it-works.md` prose about history coming from the session table.
4. **Full validation list, verbatim** (`development.md` step 7), all actually run.
5. **Manual local pass**: send → refresh → deep-link in a new tab → second
   conversation → switch between them → another owner's id returns 404 →
   Sessions tab still lists the underlying rows.
6. **PR into `development`**, one logical change; body must state the
   dashboard-only surface-parity note, the P1/P2 non-goals, and the
   legacy-conversation caveat.

### Blockers/Open Questions

- [ ] Blocker: `conversations-repo.integration.test.ts` has **never executed** —
      needs Docker Desktop running (`%LOCALAPPDATA%\Programs\DockerDesktop`),
      Floci up, and a `.env` created from `.env.local.example`.
- [ ] Open: whether the repo's `docs/features/HANDOFF-TEMPLATE.md` should be
      amended to this template's structure. That is a **process change**
      requiring explicit approval before editing — not done here.

### Deferred Items

- Rename, delete, auto-titles beyond first-message, cross-surface sidebar,
  message pagination, summaries, semantic retrieval, live-stream
  reconnect/resume, conversation support on the non-stream `/test-turn`,
  rehydrating kb chips / images / run-meta footers — all out of P0 by the
  approved plan.
- Ownership hardening of legacy raw-`chatId` sends, and adoption of pre-#36
  conversations into the owner rail — named follow-ups; legacy rows remain
  reachable via the admin Sessions tab.

## Context for Resuming Agent

### Important Context

**The backend is done and proven; only `Chat.tsx` is unfinished.** Do not
redesign anything — read [ADR 0010](../../../adr/0010-conversation-ownership-and-durable-messages.md)
first, then fix the four errors listed above.

**Do not undo PR #36.** M1 (session rows never expire for `dashboard:` chats,
plus the inline rail) is correct and shipped. This branch extends it: the rail
moves from agent-scoped `/sessions` to owner-scoped `/conversations`, and
reopen now serves the full durable transcript instead of the 20-turn window.

**The legacy path must stay byte-for-byte unchanged.** A send with a raw
`chatId` and no `conversationId` takes exactly the old code path — no ownership
read, no `persistTurn`, no `conversation` event. `test-turn-conversations.test.ts`
pins this; if it goes red, the change is wrong.

### Assumptions Made

- **A1** Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. Prove it with `npm run local:verify` (requires account `000000000000`).
- **A2** `development.md` was verified on macOS 2026-08-10; its local command set was re-verified on Windows 11 on 2026-08-13. Linux is unverified.
- **A3** Bedrock is a **stub** locally: fixed text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. Local runs validate plumbing, never model behavior; tool use is unreachable.
- **A4** `qa` deploys nothing, and merging to `production` deploys nothing on its own (`deploy.yml` is `workflow_dispatch` and requires typing `deploy`).
- **A5** Table names are compiled in at import time, so a `TABLE_*` override must be set **before** the first import.
- **A6** AWS console access is root-user sign-in via `aws login` with the `netzer-root` profile; the `netzer-dev` SSO profile is broken.
- **A7** Contrary to M6, the **full vitest suite does run in a Windows linked worktree** (verified 2026-08-13 at `8a66ba4`, and this whole session ran from one). Fall back to a normal clone only if startup actually fails.
- **A8** The Windows `npm test` baseline on `development` is **not green** — 7 failing files, none in `src/`. Check against the table above before blaming a change.

### Potential Gotchas

| Gotcha | Where the detail lives |
|--------|------------------------|
| A bare `KEY=` in `.env` becomes `''`; zod's `.optional()`/`.default()` only fire on `undefined`. Omit the line | [Environment variables](../../../../development.md#environment-variables) |
| Only `.env.local.example` works — `.env.example`, `.env.reference`, `.env.staging.example` all fail `loadEnv()` | [Environment variables](../../../../development.md#environment-variables) |
| `NODE_ENV=production` locally arms a fail-fast; the orchestrator refuses to start | [Environment variables](../../../../development.md#environment-variables) |
| `CCE_NAME_SUFFIX` renames tables but four modules read the unsuffixed literal anyway | [Environment variables](../../../../development.md#environment-variables) |
| Vite does not always use 5173 and binds `localhost` (IPv6) — read the URL it prints | [Troubleshooting](../../../../development.md#troubleshooting) |
| `GET /ready` returning `503` locally is **correct** (Slack/Telegram genuinely unconfigured) | [Starting development](../../../../development.md#starting-development) |
| A poisoned `claudeclaw-dashboard-tokens` row causes a permanent 401 with a correct token. Fix: `npm run local:provision` | [Troubleshooting](../../../../development.md#troubleshooting) |
| Floci answers `ConverseStream` with 501; the replay fallback fires **only** when `AWS_ENDPOINT_URL` is set | [Troubleshooting](../../../../development.md#troubleshooting) |
| `jarvis.flow.test.ts` times out intermittently — reproduce twice before chasing | [Troubleshooting](../../../../development.md#troubleshooting) |
| The IAM Copilot degrades **invisibly** locally: empty findings render as "validated clean" | [Known local limitations](../../../../development.md#known-local-limitations) |
| The cost waste scan reports a **false clean** and caches it 30 minutes | [Known local limitations](../../../../development.md#known-local-limitations) |
| `npm run doctor`/`status`/`verify` fail rather than skip against an empty emulator | [Known local limitations](../../../../development.md#known-local-limitations) |
| PowerShell 5.1 has no `&&`; chain with `; if ($?) { … }` | [Feature README §8](../README.md) |
| Docker Desktop is under `%LOCALAPPDATA%\Programs\DockerDesktop`, not Program Files | this folder's PR #36 record |
| `appendTurns` is a full-item Put that silently drops unlisted attributes (it already drops `activeWarroomId`) — never store conversation state on a session row | `src/lib/state/sessions-repo.ts` |
| `Chat.tsx` sends via raw `fetch`, bypassing the 60s GET cache — call `clearApiCache()` after a turn or the rail lags | `web/src/lib/api.ts` |
| Six `data-tour` anchors in `Chat.tsx` are asserted by the Playwright tour smoke — preserve them through the layout refactor | `web/src/lib/tour/steps.ts` |
| `:param` routes are exempt from the route-manifest drift test; a **static** `/chat/c` route would fail it | `src/lib/jarvis/route-manifest.test.ts` |

## Environment State

### Tools/Services Used

- Windows 11, Node 24.19.0, PowerShell 5.1
- `npm ci --ignore-scripts` completed for root **and** `web/` in the worktree
- Docker / Floci: **not started this session**

### Active Processes

- None left running at pause.

### Environment Variables

- Repo defaults only; **no `.env` in the worktree yet** — create it from
  `.env.local.example` before the integration suite. Names only, never values.

## Related Resources

- [Feature README](../README.md) · [canonical HANDOFF](../HANDOFF.md)
- [ADR 0010 — conversation ownership and durable messages](../../../adr/0010-conversation-ownership-and-durable-messages.md)
- [ADR 0002 — single tenant](../../../adr/0002-single-tenant.md) · [ADR 0009 — mission container model](../../../adr/0009-mission-container-model.md)
- [Feature knowledge framework](../../README.md) · [development.md](../../../../development.md) · [CONTRIBUTING.md](../../../../CONTRIBUTING.md)
- PR #36 (`f132a9c`) — the M1 conversation-persistence work this branch extends
