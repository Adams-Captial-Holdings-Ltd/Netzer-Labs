---
feature: persistent-workspaces
document_role: session-handoff
status: current
observed_at: 2026-08-13
as_of_commit: 27cde4415236261e69eab77074180da05fa15aae
session_slug: conversation-ownership-durable-messages
supersedes: none
---

# Session handoff: per-user conversations + full durable transcripts (P0 delta)

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-13 |
| Feature folder | `docs/features/persistent-workspaces/` |
| Branch worked on | `feature/conversation-history` (linked worktree `.worktrees/conversation-history`) |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `27cde4415236261e69eab77074180da05fa15aae` (post PR #34/#35/#36) |
| Commit at session end | TBD |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

This session builds the two follow-ups the feature README names as next work
after M1 (PR #36): **full transcript retention** (M1 caps a reopened
conversation at the 20-turn session window) and **per-user conversations**
(M1's sidebar reads agent-scoped `GET /sessions?agentId=`, which is org-visible
and needs `sessions:read`). Delta, per the approved plan (rescoped after PR #36
landed mid-planning): a `conversations-repo` riding the sessions table with
owner-partitioned meta items (`USER#<ownerId>/CONV#<chatId>`) and per-message
items (`CONV#<chatId>/MSG#…`, no ttl), a new owner-scoped
`GET /api/conversations[/:id]` router under `chat:read`, server-minted
unguessable ids for new conversations plus a `clientMessageId` idempotency
fence on the stream route, the M1 rail re-pointed at the new endpoints with
date grouping and a `/chat/c/:conversationId` deep-link route, and GDPR
export/purge coverage of the new items. The send path's model history stays
`session.turns` (sessions never expire after M1 — no rebuild needed).

**Session state at pause (user-requested mid-work handoff): the ENTIRE backend
delta is implemented and green** (repo + integration test file + router +
authz-matrix + stream wiring + GDPR; root `npm run typecheck` clean; all
focused suites pass; legacy-path regression suites re-run untouched-green).
**The frontend refactor of `web/src/pages/Chat.tsx` is mid-flight and web
typecheck is RED with exactly four known errors** — see §6.1 for the precise
remaining edits. The Floci integration suite has not been run yet this session
(Docker not started). Pushed to GitHub at the user's request BEFORE the full
pre-push validation list, as an explicit, user-approved deviation from
`development.md` step 7 recorded here; nothing in §7 is claimed as run that
did not run.

An earlier scaffold of this work lived briefly in
`docs/features/conversation-history/`; it was folded into this folder (one
feature, one folder) and deleted before any commit.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- `runAgentTurn` (`src/agent/agent-loop.ts:484`) is persistence-agnostic:
  callers do `getSession → runAgentTurn → appendTurns`. All conversation
  wiring lands in the callers; the loop is untouched.
- `appendTurns` (`src/lib/state/sessions-repo.ts`) is a full-item PutCommand
  that drops attributes not in its Item block. Never store conversation state
  on session rows; separate items only.
- Dashboard session rows carry `userId = dashboard:<sha256 tokenHash>`, which
  rotates on every magic-link login. Stable ownership identity is
  `principal.userId` (users-table uuid), absent on the root env token and
  legacy minted tokens — hence
  `conversationOwnerId = userId ?? 'root' (root token) ?? token:<hashPrefix16>`.
- There is NO ownership enforcement on `chatId` pre-this-session: any
  `chat:read` principal can continue any dashboard session, and M1's rail
  lists every user's chats to any `sessions:read` holder. This session closes
  both for the new conversation flow; legacy raw-`chatId` sends keep working
  and their hardening is a named follow-up.
- `hono@4.12.27` `StreamingApi.write` swallows write errors: a client refresh
  mid-SSE does not abort the handler, so the turn completes and persistence
  runs. Reload then shows the reply.
- The route-manifest drift test filters `<Route path>`s containing `:` — a
  `/chat/c/:conversationId` param route needs no `ROUTE_TABLE` entry; a static
  `/chat/c` route would fail it.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/adapters/dashboard/handler.ts` (stream route) | Send path | Pre-stream ownership/idempotency checks; persistTurn + `conversation` SSE event |
| `src/lib/state/sessions-repo.ts` | Window/TTL/ingest + `isPersistentChat` | M1 machinery that must keep working unchanged |
| `src/lib/state/jarvis-memory-repo.ts` | Rides sessions table, own PK prefix | Zero-infra storage precedent this delta copies |
| `src/adapters/dashboard/seat-admin.ts:100-118` | Router extraction pattern | Template for the conversations router |
| `src/adapters/dashboard/test-turn-attachments.test.ts:81-86` | Partial module mock | THE pattern for stream-route tests |
| `src/lib/state/identities-repo.integration.test.ts:15-33` | Floci integration skeleton | Env + TABLE_* before dynamic import |
| `web/src/pages/Chat.tsx` | M1 rail + send | Re-point rail, add deep links, keep data-tour anchors |

### 3.3 Patterns and conventions to follow

- Repo unit tests: `vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }))`,
  assert on `send.mock.calls[i][0].input` (exemplar `memories-repo.test.ts`).
- Table names are module-load constants (`process.env.TABLE_X ?? '…'`).
- Error shapes: `{error:'unauthorized'}` 401, `{error:'forbidden',
  requiredCapability}` 403, uniform `{error:'not_found'}` 404.
- Sessions-table timestamps are epoch seconds.
- Chat-surface parity (CLAUDE.md): dashboard-only UX; say so in the PR.

## 4. Work completed

(Updated as the session progresses.)

### 4.1 Tasks finished

- [x] Rescope after PR #36; plan updated; branch fast-forwarded to `27cde44`
- [x] Baseline recorded (§7); ADR 0010 drafted
- [x] `conversations-repo` + unit tests (15/15) + integration test FILE
      (written, not yet run — needs Floci)
- [x] Conversations router + tests (7/7) + authz-matrix rows (115/115) +
      `server.ts` mount
- [x] Stream-route wiring + contract tests (6/6); legacy regression suites
      (`test-turn-attachments`, `test-turn-costcap`,
      `sessions-repo.persistence`, `sessions-repo.ingest`) re-run
      untouched-green
- [x] GDPR export/purge coverage + tests (4/4)
- [ ] Frontend: `format.ts`, `api.ts`, `App.tsx` done; **`Chat.tsx`
      mid-refactor, web typecheck RED** (§6.1)
- [ ] Feature README/HANDOFF final update; how-it-works prose; full
      validation; manual local pass; PR

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `src/lib/state/conversations-repo.ts` (+ `.test.ts`, `.integration.test.ts`) | New | Owner meta + durable message items in the sessions table (ADR 0010) |
| `src/adapters/dashboard/conversations.ts` (+ `.test.ts`) | New | Owner-scoped GET list/detail router, `chat:read` |
| `src/adapters/dashboard/handler.ts` | Edit (stream route only) | Body fields `conversationId`/`startConversation`/`clientMessageId`; pre-stream ownership 404 + duplicate 409; `persistTurn` + additive `conversation` SSE event inside the `!blocked` block |
| `src/adapters/dashboard/test-turn-conversations.test.ts` | New | Ownership / 409 / pinning / persistence / blocked / legacy-untouched contract |
| `src/adapters/dashboard/authz-matrix.test.ts` | Edit | Two conversations routes registered (all four tiers ALLOWED on `chat:read`) |
| `src/server.ts` | Edit | Mount `/api/conversations` before the `/api` catch-all |
| `src/lib/tools/privacy-tools.ts` (+ `.test.ts`) | Edit/New | Export includes durable transcript; purge deletes messages + meta for `dashboard:c_*` |
| `web/src/lib/format.ts` | Edit | `dateGroupLabel` (Today/Yesterday/Previous 7 days/Older) |
| `web/src/lib/api.ts` | Edit | `ConversationSummary`/`ConversationMessageView`/`ConversationDetail` types |
| `web/src/App.tsx` | Edit | `/chat/c/:conversationId` route before `/chat/:agentId` |
| `web/src/pages/Chat.tsx` | Edit, **INCOMPLETE** | Server-minted id model, rail re-point, deep links, 409/404 handling — render blocks still reference removed state (§6.1) |
| `docs/adr/0010-conversation-ownership-and-durable-messages.md` | New | Storage/ownership/idempotency decision |
| `docs/features/persistent-workspaces/handoffs/…` (this file) | New | First session log in this folder |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Build delta on top of M1; undo nothing | Replace M1's TTL/rail approach with the pre-#36 plan | M1 is correct and shipped; README lists this delta as next work |
| conversationId == chatId (`dashboard:c_<uuid>`, server-minted) | Separate conversation id mapped to a chatId | One identifier, no mapping; safeDashboardChatId passes it through |
| No adoption/migration of pre-existing chatIds into the owner rail | Ownership-adoption marker items with conditional first-writer | Guessable timestamp ids + adoption races add real machinery for hours-old data; legacy rows stay reachable via the admin Sessions tab |
| Send-path history stays `session.turns` | Always rebuild from durable messages | Sessions never expire post-M1; rebuild solved a problem that no longer exists |
| Idempotency = `lastClientMessageId` fence on owner meta | Dedicated idempotency items | Meta already read for ownership; client sends serially |

Durable versions of these are in ADR 0010.

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Storage/ownership/idempotency design | `docs/adr/0010-conversation-ownership-and-durable-messages.md` | pending |
| Hono stream-disconnect behavior | ADR 0010 | pending |

## 5. Carried-forward mistakes, assumptions and precautions

> Copied forward from the seed ledger in
> [`HANDOFF-TEMPLATE.md`](../../HANDOFF-TEMPLATE.md) (this folder had no prior
> session handoffs), then appended to. Nothing is deleted. An entry that is
> fixed is marked `RESOLVED (<commit>)` and stays.

### 5.1 Process precautions

| # | Precaution | Why it exists |
|---|---|---|
| P1 | Record a baseline before changing anything. | Without it a pre-existing failure is indistinguishable from a regression you caused. |
| P2 | Never record a command as passing unless it actually ran. Say what you skipped and why. | See M5: a handoff once carried checks that no runtime could have executed. |
| P3 | Name the branch. Never write "ready for production". | Four long-lived branches exist and only two reach an AWS environment. |
| P4 | Run the FULL `npm test` before pushing, never a scoped run. | Required by [`CLAUDE.md`](../../../../CLAUDE.md). Scoped runs have hidden cross-module regressions here. |
| P5 | When a document and the code disagree, **the code wins**. Fix the document. | The framework's stated tie-break. |
| P6 | Never force-add unrelated uncommitted work you find in the tree. Preserve it and hand it back to its owner. | Stray files found during cleanup are somebody's in-flight work, not yours to merge. |
| P7 | Delete a transient branch once it merges. | Only `development`, `qa`, `staging`, `production` survive, so a handoff that names a branch names something that still exists. |
| P8 | Docs changes must pass `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/docs-links.mjs` before pushing. | Docs CI runs them anyway; failing there costs a round trip. |
| P9 | Never restate feature-documentation rules outside [the framework](../../README.md). | A second copy is exactly how these conventions drifted before — see M1. |

### 5.2 Mistakes already made, and their corrections

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M1 | Feature-documentation conventions were written on several pages at once. | The copies drifted and no page was trustworthy. | Single specification in [the framework](../../README.md), machine-checked by `scripts/ci/feature-knowledge.mjs`. | One rule, one home, enforced by CI rather than by discipline. |
| M2 | The repository-root `handoff.md` was used as live, writable operational state. | It became a stale global handoff that contradicted the per-feature ones. | Reduced to a one-sentence compatibility pointer; CI now fails if it grows back. | Operational state is per-feature. A global handoff always rots. |
| M3 | `infra/lib/dynamo-stack.ts` carries a header comment claiming "All 14 DynamoDB tables". | It creates **32**. The comment misled table-count work. | Read the synthesized template, never the comment. | Comments are not authorities. `infra/lib/constants.ts` and the synth output are. |
| M4 | The CodeBuild deploy branch default was changed from `main` to `production`, then reverted. | Churn on a live CI path; the doc fixes from that change were kept, the behaviour change was not. | Reverted in `4ce27a7`, doc fixes retained. | Do not re-apply this without first establishing why it was reverted. |
| M5 | A feature handoff recorded required checks as complete when the authoring machine had no Node runtime, so they could not have run. | The next reader would have trusted an unverified contract. | Disclosed explicitly in the handoff; Docs CI on `development` became the first real execution. | This is precisely what P2 exists to prevent. Disclosure is the minimum; running the check is the goal. |
| M6 | Targeted Vitest was run inside a Windows **linked worktree**. | Startup failed with `Cannot read directory "../../../../../../../.."` and could not resolve `vitest.config.ts`; no tests collected. | Ran from a normal checkout instead. | On Windows, run test suites from a normal clone. Dependency-free Node CI scripts are fine in a worktree; Vitest is not. |
| M7 | `npm run test:integration:up` was assumed safe alongside the local stack. | It starts LocalStack on port 4566 and collides with Floci. Two emulators must never run at once. | Use `npm run local:test:integration`, which passes `--env-file=.env`. | One emulator on 4566, ever. |
| M8 | `.env` was created for local development while several lifecycle scripts default their environment flag to **prod** and read `.env`. | Commands that were previously inert became genuinely dangerous. | Catalogued in [dangerous commands](../../../../development.md#dangerous-commands-never-run-locally). | Read that list before running any unfamiliar `npm run` script. |

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it any time with `npm run local:verify`, which requires account id `000000000000`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS** on 2026-08-10; the local command set was re-verified on Windows 11 on 2026-08-13. | Linux remains unverified. |
| A3 | Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. | Local development validates plumbing, never model behaviour. Tool use is unreachable locally by design. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; deployment is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const). | A `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception. |
| A6 | AWS console access for this account is root-user sign-in via `aws login` with the `netzer-root` profile. | The `netzer-dev` SSO profile is known broken. Do not burn time on it. |
| A7 | **Appended 2026-08-13 (this session):** contrary to M6, the FULL vitest suite runs in a Windows linked worktree (verified 2026-08-13 at `8a66ba4`: 1949 tests from `.worktrees/persistent-workspaces` after `npm ci --ignore-scripts`; PR #36's session also worked from `.worktrees/chat-history`). This session runs from `.worktrees/conversation-history` because a parallel session holds the main clone's checkout. If vitest startup ever fails in a worktree, fall back to a normal clone per M6 and record which behavior occurred. |
| A8 | **Appended 2026-08-13 (this session):** the Windows `npm test` baseline on `development` is NOT green: 5 `scripts/`-only test files fail (4 shebang parse errors + 1 POSIX path assert; none in `src/`; CI on ubuntu is green). Post-M1 expected shape: 5 failed / 178 passed files, 1 failed / 1960 passed tests; integration 38/39 with the known `destroy.integration` emulator gap. Verify against §7 before blaming a change. |

### 5.4 Known traps that cost time

Short pointers only. The owning document has the detail; do not copy it here.

| Trap | Where the detail lives |
|---|---|
| A bare `KEY=` in `.env` becomes `''`, and zod's `.optional()`/`.default()` only fire on `undefined`. Omit the line instead. | [Environment variables](../../../../development.md#environment-variables) |
| `.env.example`, `.env.reference` and `.env.staging.example` all fail `loadEnv()`. Only `.env.local.example` works. | [Environment variables](../../../../development.md#environment-variables) |
| `NODE_ENV=production` locally arms a deployed-task fail-fast; the orchestrator refuses to start. | [Environment variables](../../../../development.md#environment-variables) |
| `CCE_NAME_SUFFIX` renames tables but four modules read the unsuffixed literal anyway. | [Environment variables](../../../../development.md#environment-variables) |
| Vite does **not** always use port 5173, and binds `localhost` (IPv6 `::1`), so the IPv4 literal fails. Read the URL Vite prints. | [Troubleshooting](../../../../development.md#troubleshooting) |
| `GET /ready` returning `503` locally is **correct** — Slack and Telegram are genuinely unconfigured. | [Starting development](../../../../development.md#starting-development) |
| A poisoned row in `claudeclaw-dashboard-tokens` causes a permanent `401` with a correct token. Fix: `npm run local:provision`. | [Troubleshooting](../../../../development.md#troubleshooting) |
| Floci answers `ConverseStream` with 501; the replay-as-non-streaming fallback fires **only** when `AWS_ENDPOINT_URL` is set. | [Troubleshooting](../../../../development.md#troubleshooting) |
| `src/adapters/dashboard/jarvis.flow.test.ts` intermittently times out at 5000 ms. Pre-existing flake. Reproduce twice before chasing it. | [Troubleshooting](../../../../development.md#troubleshooting) |
| The IAM Copilot **degrades invisibly** locally: an empty findings list renders identically to "validated clean". | [Known local limitations](../../../../development.md#known-local-limitations) |
| The cost waste scan reports a **false clean** and caches it for 30 minutes. Local cost output is not meaningful. | [Known local limitations](../../../../development.md#known-local-limitations) |
| `npm run doctor`, `status` and `verify` fail rather than skip against an empty emulator. They give no useful local signal. | [Known local limitations](../../../../development.md#known-local-limitations) |
| Windows PowerShell 5.1 has no `&&`; chain with `; if ($?) { … }`. | [Feature README §8](../README.md) |
| Docker Desktop lives at `%LOCALAPPDATA%\Programs\DockerDesktop`, not Program Files. | [HANDOFF, PR #36 session](../HANDOFF.md) |

## 6. Pending work

### 6.1 Smallest next action

Fix the four web-typecheck errors in `web/src/pages/Chat.tsx` — they are the
tail of the rail-render refactor, enumerated exactly by
`npm --prefix web run typecheck`:

1. `Chat.tsx(158)` — the `conversations` state is still
   `useState<Conversation[]>`; the `Conversation` interface was replaced by
   `ConversationSummary` (already imported from `../lib/api`). Change the
   type argument.
2. `Chat.tsx(~526)` — the rail rows still use the removed `chatId` state:
   `const active = c.chatId === chatId` →
   `const active = c.conversationId === conversationId`;
   `openConversation(c.chatId)` → `openConversation(c.conversationId)`;
   the row key `key={c.chatId}` → `key={c.conversationId}`. While here, apply
   the planned date grouping: group `conversations` with
   `dateGroupLabel(c.updatedAt)` (imported, currently unused — error TS6133)
   into Today / Yesterday / Previous 7 days / Older section headers, and show
   the row's agent display name (agents list lookup) since the rail is now
   cross-agent.
3. `Chat.tsx(~578)` — the header still renders `{chatId}`; render
   `{conversationId ?? 'new conversation'}` (keep the `InfoTooltip`).
4. Re-run `npm --prefix web run typecheck` until clean, then
   `npm --prefix web run build`.

### 6.2 Immediate next steps

1. Finish §6.1, then eyeball the rail states (loading / empty / grouped).
2. Bring up Floci (`npm run local:up` + `npm run local:provision`; `.env` from
   `.env.local.example` if absent) and run
   `npm run local:test:integration` — expect 39/40 with the known
   `destroy.integration` gap; the new
   `conversations-repo.integration.test.ts` adds one file.
3. Update feature `README.md` (implementation map, "what it does today",
   risks table rows for the two closed gaps, frontmatter `implemented_by`/
   `tested_by`/`decisions` += ADR 0010) and `docs/how-it-works.md` prose;
   finalize this handoff + canonical `HANDOFF.md`.
4. Full validation list, verbatim (`development.md` step 7), all run.
5. Manual local pass (plan §Verification: send / refresh / deep-link /
   second conversation / cross-owner 404 / Sessions tab intact).
6. PR into `development`: one logical change; body states dashboard-only
   surface parity + P1/P2 non-goals + the pre-existing-conversation
   rail caveat (legacy chats stay in the admin Sessions tab only).

### 6.3 Blockers and open questions

- [ ] None currently.

### 6.4 Deferred, and why

- Rename/delete/auto-titles, cross-surface sidebar, pagination, summaries,
  stream reconnect, non-stream `/test-turn` conversations — out of P0 scope by
  the approved plan.
- Legacy raw-`chatId` ownership hardening + adoption of pre-existing
  conversations into the owner rail — named follow-up; legacy rows stay
  reachable via the admin Sessions tab.

## 7. Verification actually performed

Fill in the real result. `not run` is an acceptable and expected answer;
a false `pass` is not.

Focused suites actually run this session (all green, exit 0):
`conversations-repo.test.ts` 15/15 · `conversations.test.ts` 7/7 ·
`authz-matrix.test.ts` 102/102 + `server.test.ts` (115 total in that run) ·
`test-turn-conversations.test.ts` 6/6 · regression re-runs
`test-turn-attachments` 6/6, `test-turn-costcap`, `sessions-repo.persistence`,
`sessions-repo.ingest` (26 tests across the stream-wiring run) ·
`privacy-tools.test.ts` 4/4.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | not run separately (baseline `npm test` compiled clean aside from listed failures) | **clean** (run twice during the session, last after GDPR wiring) |
| `npm test` | **7 failed / 176 passed files (184); 20 failed / 1941 passed / 6 skipped tests (1967)** on untouched `27cde44`, Windows. Failing files: `scripts/ci/{docs-links,feature-knowledge,runnable-blocks}.test.ts` + `scripts/release/sync-deprecations.test.ts` (shebang parse errors), `scripts/release/buildspec-tag-normalization.test.ts` (6 tests, needs `sh`), `scripts/lib/lifecycle/rollback-classes.test.ts` (1 test, POSIX paths) — all `scripts/`, Windows-env-only, CI green on ubuntu; plus `src/adapters/dashboard/jarvis.flow.test.ts` (13 tests, the documented credential-chain timeout flake — reproduced twice per development.md's procedure: full run AND a solo warm-transform rerun, 13 failed / 5 passed, all `Test timed out in 5000ms`, on a freshly restarted machine). | |
| `npm run build` | not run | not run |
| `npm --prefix web run typecheck` | not run | **RED — 4 known errors** in `Chat.tsx` (mid-refactor; exact list in §6.1) |
| `npm --prefix web run build` | not run | not run |
| `npm run local:test:integration` | not run | not run (Docker/Floci not started this session; the new integration test file has never executed) |
| `node scripts/ci/docs-links.mjs` | not run | run at pause — see the commit carrying this file |
| `node scripts/ci/feature-knowledge.mjs` | not run | run at pause — see the commit carrying this file |
| `git diff --check` | not run | run at pause — clean |

Anything not run, and why: the session was paused mid-frontend at the user's
request and pushed WIP (explicit user-approved deviation from the
run-full-validation-before-pushing rule). `npm run build`, the web gates, and
the integration suite are owed by the resuming session BEFORE any PR.

## 8. Environment state

- **Tools and services**: Windows 11, Node 24.19.0; `npm ci --ignore-scripts`
  completed in the worktree for root AND `web/`. Docker/Floci not started
  this session.
- **Active processes**: none left running at pause.
- **Environment variables**: repo defaults only; no `.env` in the worktree yet
  (create from `.env.local.example` before the integration suite).
- **Uncommitted work left in the tree**: main clone checkout sits on
  `chore/canonical-repo-and-agent-worktrees` with untracked
  `fix-windows-test-suite/` — a parallel session's work, untouched per P6.
  This session works only in `.worktrees/conversation-history`.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
