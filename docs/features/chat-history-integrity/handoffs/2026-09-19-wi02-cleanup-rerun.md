---
feature: chat-history-integrity
document_role: session-handoff
status: current
observed_at: 2026-09-19
as_of_commit: e1cdc118ce7503f81ebd16f867bd345ede99f37b
session_slug: wi02-cleanup-rerun
supersedes: 2026-09-19-wi02-verification.md
---

# Session handoff: WI-0.2 cleanup rerun (README 2.1 and section 4 corrected, stamp at `e036f7a`)

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-19 (Gauntlet Loop, `DIRECT_COORDINATOR / CLEANUP` rerun, WI-0.2). Claude Opus 5, no Codex (`CODEX_IN_CLEANUP: OFF`; WI-0.2's Codex budget is spent), no subagents. |
| Feature folder | `docs/features/chat-history-integrity/` |
| Branch worked on | `chore/wi02-cleanup`, in the standalone clone `_netzer-turn-ceiling` |
| Branch it merges into next | `development`. The push and the PR each need their own explicit authorization. |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `e036f7a` (the verification's docs commit), on `origin/development` at `b152b7a` |
| Commits made by this session | `e1cdc11`: README only. Then one docs commit: this file and `HANDOFF.md`. No source, test or diagram change. |
| Commit at session end | That docs commit: `git rev-parse chore/wi02-cleanup` |
| Pushed | **No.** Nothing was pushed this session. |
| PR | None. |
| Deployed | no |

## 2. Current state summary

- **WI-0.2 CLEANUP rerun: done.** Ready for a fresh VERIFICATION.
  - **F1 (VERIFICATION's one failure), fixed.** README 2.1 now names the paths that replay a stored chat transcript to Bedrock. All of them read through `getSession`: the dashboard, Slack and Telegram adapters, the two scheduled-task runners and the Paperclip dispatch worker. It also says why Jarvis and the TLDR bar are not among them (3.1).
  - **F2, fixed.** 2.3's production observation is dated 2026-08-24.
  - **F4, found and fixed.** The full re-check found one more false claim. Section 4 said `generate_document`'s "spec validation ... [is] unchanged", which has been false since `389476b` (2026-08-25).
- **The stamp is `e036f7a`, observed 2026-09-19.** All 56 README claim checks pass there (7.2), and `e1cdc11`'s code is identical.
- **Gates.**
  - At `e1cdc11`, the proof passes every line and exits 0, with 0 changed paths (7.4).
  - The docs gates exit 0 on the final text (7.3, 7.5).
- **Open for the owner:** the non-string config test (unchanged), and push and PR authorization, which follows a VERIFICATION PASS and the step 7 list on that exact HEAD.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

Every row below was observed at `e036f7a`.

- **The agent loop has 11 callers, and only 8 replay a stored transcript.**
  - It builds each request from `req.history` (`agent-loop.ts:1021-1025`), and `turnsToMessages` copies each turn's text into one block as it is (`:548-553`).
  - Direct `runAgentTurn({` calls: `dashboard/handler.ts:1917` and `:2262`, `slack/handler.ts:471` and `:739`, `telegram/handler.ts:416`, `agent/scheduler.ts:170`, `lib/scheduler/queue-drain.ts:126`, `agent/canary.ts:75`, `lib/tools/agent-tools.ts:115`, and `lib/warroom/orchestrator.ts:211`.
  - The eleventh is `lib/paperclip/dispatch-worker.ts:502`, through `const runTurn = deps.runTurn ?? runAgentTurn` (`:480`).
- **All 8 replaying callers read the session through `getSession`.** Each sets `const history = session?.turns ?? []` just after a `getSession` call:
  - dashboard `:1908-1909` and `:2257-2258`
  - Slack `:396-397`, and `:648-659` with the legacy-id fallback at `:650`
  - Telegram `:379-381`
  - scheduler `:168-169`
  - queue drain `:124-125`
  - Paperclip `:499-500`, through `readSession = deps.getSessionFn ?? getSession` (`:481`)
- **No production code injects the Paperclip aliases.** Nothing outside tests passes `getSessionFn` or `runTurn`.
- **The other 3 callers pass `history: []`:** the canary, the delegate-to-agent tool and the War Room.
- **The sessions table is named in 7 files.** Only `sessions-repo` reads chat turns from it:
  - `dashboard/handler.ts` makes three reads (`:2049`, `:2065`, `:3644`), and each projects no `turns`.
  - `dashboard/jarvis.ts:1161`, Jarvis's `sessions` tool, is a scan that projects no `turns`.
  - `jarvis-memory-repo.ts` is Jarvis's own partition of the same table.
  - `dynamodb-tools.ts` is the agent's query tool. It can return raw rows, turns included, but as tool-result data, not as conversation turns (A30).
  - `config/env.ts` and `security/posture-repo.ts` only name the table.
- **Jarvis is outside that path set.**
  - `jarvis.ts` imports `loadRecent as loadJarvisMemory` and replays through `buildSeedMessages`.
  - Nothing in Jarvis imports `sessions-repo`. `jarvis-memory-repo.ts:4` names it only in a comment.
  - Its `appendTurn` trims the text and returns when it is empty (`:68-69`). It is the repo's only write.
- **The TLDR bar replays nothing.** `TldrBar.tsx:31` posts `{ tab, data }`, and `tldr.ts:76-77` summarizes that alone.
- **Four paths send stored chat turns to Bedrock flattened, not as turns.** None of them is a replay path.
  - **Memory ingest.** `memory-ingest.ts:137-151` sends evicted turns as one text prompt. Both of its callers are in `sessions-repo` (`:382`, `:464`), and both take the stored turns from `getSession` (`:290`, `:459`).
  - **The dashboard's cross-surface peek.** `handler.ts:1888-1900` reads the owner's recent turns through `getSession` and writes them into an `<other_surfaces>` system-prompt note.
  - **The privacy tool's export.** `privacy-tools.ts:82` reads the session through `getSession` and returns it as tool data.
  - **The agent's DynamoDB tool.** It reads raw rows, without `getSession` (A30).
- **Of the 12 Bedrock request sites outside the agent loop, only memory ingest's sends stored chat turns** (above). The other 11:
  - Seven build their input from something other than chat turns: the playground (`handler.ts:1664`), cost analyst, IAM copilot, compliance analyst, memory consolidator, `mission-tools.ts`, and the embedder.
  - Nova Canvas generates images from its own tool arguments.
  - Jarvis's stream (`jarvis.ts:695`) replays Jarvis's own store.
  - The TLDR route (`tldr.ts:86`) and the knowledge Q&A route (`handler.ts:2831`) send what the browser posted.
- **The source comment's general claim is true as written.** `sessions-repo.ts:155-157` says "every consumer that turns stored turns into Bedrock messages goes through" `getSession`, and names no consumer. So no source change was needed.
- **There are eight `appendTurns` writers, not seven.** The eighth is Paperclip's `writeTurns` (`dispatch-worker.ts:482`, `:619-624`). All eight store a user-then-assistant pair.
- **`generate_document`'s spec validation changed in `389476b` (2026-08-25).**
  - That commit changed `validateDocumentSpec` and `validateSpreadsheetSpec` in `types.ts`, adding the row-array checks and the total-cell budget. The tool calls both (`document-generation-tools.ts:230-232`).
  - The tool file itself has no commit since the README opened (`9d72979`, 2026-08-24).

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `docs/features/chat-history-integrity/README.md` | The artifact under repair | F1, F2 and F4, and the stamp |
| `src/lib/paperclip/dispatch-worker.ts` | Paperclip's mission dispatch | The replay path and writer that name-based greps miss (M37) |
| `src/lib/state/jarvis-memory-repo.ts`, `src/adapters/dashboard/jarvis.ts` | Jarvis's own turn store and its replay | Why Jarvis sits outside 2.1's set |
| `src/lib/documents/types.ts`, `src/lib/tools/document-generation-tools.ts` | Spec validation, and the tool that calls it | F4 |
| `~/.claude/plans/netzar-chat-plan/wi-0.2-readme-claims.sh` | This session's claim check, outside the repo | 7.2 |

### 3.3 Patterns and conventions to follow

- To list "every X", grep each seam's name without its call parenthesis as well, so `deps.<fn> ?? <fn>` aliases count (P26).
- Re-check a README sentence by sentence, including "unchanged" and "not covered" sentences (P27).

## 4. Work completed

### 4.1 Tasks finished

- [x] Step 0: read root `development.md` and `docs/features/README.md`, and declared the governing sections and steps before the first command (P19).
- [x] Restored state from the handoff, the Gauntlet state file (section 0 and STATUS agree) and the verification log. `git fetch` confirmed `origin/development` at `b152b7a`. `974399b..e036f7a` touches docs only.
- [x] Listed every replay path and every reader of the sessions table from imports and call sites (3.1).
- [x] Re-checked every README code claim at `e036f7a` (7.2).
- [x] Corrected README 2.1 (F1), 2.3's date (F2) and section 4 (F4), and moved the stamp. Committed `e1cdc11`.
- [x] Ran the docs gates (7.3), the proof at `e1cdc11` (7.4), P24's whole-item scope filter, and the docs gates on this file and `HANDOFF.md` (7.5).
- [ ] A fresh VERIFICATION.

### 4.2 Files modified

| File | Change | Author | Rationale |
|---|---|---|---|
| `README.md` | 2.1's replay paths, 2.3's date, 4's spec-validation sentence, and the stamp (`e1cdc11`) | Claude | F1, F2, F4 |
| This file | Created | Claude | Session log |
| `HANDOFF.md` | Current state and the session index | Claude | `docs/features/README.md` section 6a |

### 4.3 Decisions made

- **2.1 defines its set by behavior.**
  - The set is "every path that replays a stored chat transcript to Bedrock as conversation turns", and 2.1 names its members.
  - Memory ingest and the agent's DynamoDB tool are left out of the README. They pass turns to Bedrock only as one flattened prompt or as query data, which the empty-block rejection cannot reach.
- **F4 is in scope.** The bar asks that every README code claim be true at the new stamp, and moving the stamp would have re-certified section 4's sentence, just as F1's was. The fix is the smallest one: the sentence now says the spec validation changed and points at 2.4 and 2.5.
- **The stamp is `e036f7a`, the tree the 56 checks ran against.** A README cannot name its own commit. `e1cdc11` changes only the README.
- **One-time decision.** This file was drafted in the session scratchpad while the proof ran on `e1cdc11`, so the proof saw a clean committed HEAD. It moved into the feature folder afterwards (P25, applied to a CLEANUP session).

**Classification** (user constraint 4):

| Finding | Class | Route |
|---|---|---|
| F1: 2.1 named Jarvis and the TLDR path as `getSession` readers | Phase-scoped (VERIFICATION's FAIL) | Fixed, `e1cdc11` |
| F2: 2.3's production observation was undated | Cosmetic, phase-scoped | Fixed, `e1cdc11` |
| F4: section 4 said the spec validation was unchanged | Phase-scoped: the stamp would re-certify it (M38) | Fixed, `e1cdc11` |
| F5: the verification log's 3.1 says "All seven `appendTurns` callers" | Log-only, and the inference still holds with eight | Recorded here (M37) |
| F6: the knowledge Q&A route (`handler.ts:2826-2828`) sends browser-posted history text to Bedrock with no empty-text guard | Technical debt, unrelated to WI-0.2. It is per request and never stored, so it cannot poison a chat. Whether the page ever posts an empty turn is Unknown | Not patched |
| The three README debts in the cleanup log (6.4) | Technical debt, unchanged | Not patched |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The replay paths, Jarvis's write guard and the TLDR bar's input | README 2.1 | Yes, `e1cdc11` |
| 2.3's production observation dates to 2026-08-24 | README 2.3 | Yes, `e1cdc11` |
| `generate_document`'s spec validation changed after the folder opened | README section 4 | Yes, `e1cdc11` |
| This session's result and routing | `HANDOFF.md` and the Gauntlet state file | Yes |

## 5. Carried-forward mistakes, assumptions and precautions

> Copied forward from the previous session handoff, then appended to. Nothing is
> deleted. An entry that is fixed is marked `RESOLVED (<commit>)` and stays.

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

| M9 | The `development.md` Automated tests table records `npm test` as "178 files, 1927 tests, all passing". | A reader treats a failing baseline as a regression they caused. | Measured on a clean clone of untouched `development`: **192 files, 2135 tests, 7 files / 3 tests failing**. Reported to the owner; the document was NOT amended, because that needs approval. | Re-measure the baseline yourself. Do not trust that table. |
| M10 | Web gates were run without `web/node_modules` installed, and the resulting `TS7026` errors were briefly read as a pre-existing code defect. | Nearly recorded an environment artifact as a real baseline failure — the exact shape of **M5**. | Ran `npm --prefix web ci` first; both web gates then passed cleanly. | `npm ci` at the root does NOT install `web/`. Install it before believing any web gate result. |
| M11 | The first two baseline runs were done inside a Windows linked worktree, hit **M6**, and the failures were then over-corrected as "just the worktree". | Two wrong statements in a row: first that the baseline was clean, then that the failures were an artifact. | Ran a normal clone, per M6. The failures are real *and* the suite is flaky — three runs gave 10, 5 and 7 failing files. | M6 is real, but it is not an excuse. Confirm on a normal clone before either believing or dismissing a failure. |
| M12 | The output ceiling was raised on the TOOL-LOOP rounds only. The initial streamed call passes no `maxTokens` and falls through to `?? 1024` in `lib/bedrock/client.ts`. | Shipped to production as a fix, and production still returned `outputTokens: 1024 / stopReason: max_tokens` four minutes later. Documents still could not fit. | Renamed to `TURN_MAX_TOKENS` and applied at all four call sites; `agent-loop.max-tokens.test.ts` pins the initial call and was verified to FAIL when reverted. | When raising a limit, grep every call site that can reach the provider. For a turn that never uses a tool, the initial call is the ONLY call. |
| M13 | A command's exit code was masked by piping to `head`/`tail` — twice: once letting a failing `feature-knowledge` gate through to a push, once letting a TS6133 error reach CI. | A P8 violation went out, and CI caught a typecheck error that should have been caught locally. | Run gates unpiped and capture `$?` directly, or redirect to a file and grep that. | `cmd \| tail` reports TAIL's exit code, not cmd's. Never gate on a piped command. |
### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it any time with `npm run local:verify`, which requires account id `000000000000`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS**, Floci 1.6.0, Docker 28.3.2, Node 24.3.0, on 2026-08-10. | Windows and Linux behaviour is **not** covered by that verification. See M6. |
| A3 | Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. | Local development validates plumbing, never model behaviour. Tool use is unreachable locally by design. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; deployment is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const). | A `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception. |
| A6 | AWS console access for this account is root-user sign-in via `aws login` with the `netzer-root` profile. | The `netzer-dev` SSO profile is known broken. Do not burn time on it. |

| A7 | The prod orchestrator task runs **4096 MiB** (Tier 2, `claudeclaw-orchestrator:9`), not the 1024 MiB of Tier 0. | Verified from the live task definition 2026-08-24. Do not reason about prod OOM from `constants.ts` Tier 0 values. |
| A8 | Prod log retention on `/claudeclaw/orchestrator` is **90 days**; staging is **7**. | Verified 2026-08-24. Anything older than 90 days is simply not answerable from logs. |
| A9 | Of the AWS profiles, only `default` (root) authenticates. `netzer-dev` SSO is broken — this is **A6**, and it is still true. | Confirmed again 2026-08-24. Read A6 before burning time on SSO. |
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

| An empty assistant turn poisons a chat permanently via Bedrock validation. | This feature's [README](../README.md) |
| `generate_document` needs the whole spec inline, so it is the tool most likely to hit any output ceiling. | This feature's [README](../README.md), section 3 |

### Added 2026-09-17 (machine transfer)

> Appended by the 2026-09-17 transfer session. The IDs continue the carried
> ledger. The plan reserved M14–M17 for its session close, with the meanings
> recorded below, so a resumed session must not append them again.

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P10 | Before you resume an interrupted claudex loop, compare the plan's SHA-256 with the last round's `plan_sha256` in its `result.json`, and read the last entry of the review log. | fac066ed accepted its round-1 findings and scripted the revisions, but never applied them. The plan copies still hash to the round-1 input. |
| P11 | Commit the session handoff before starting long background work. Write each result into it as the result arrives. | The 09-10 handoff sat untracked for six days with an empty section 7, while its results existed only in `%TEMP%`. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M14 | Production hotfix PRs #103–#106 (2026-08-24/25) were never back-merged into `development`. That 17-day lag stalled `staging → production` PR #61, which was closed unmerged on 2026-09-09. | The next promotion hits the same conflicts. Resolving them toward staging silently reverts fixes that production runs. | Back-merge by cherry-pick on `fix/backmerge-production-hotfixes`, and verify by content. For example, `git grep -n TOOL_LOOP_MAX_TOKENS -- src infra` must print nothing and exit 1, and `TURN_MAX_TOKENS` must be on every turn call. | Cherry-picks never become ancestors. `merge-base --is-ancestor` and `git cherry` stay negative forever, so check content. |
| M15 | `git merge origin/production` looked like the way to back-merge "the four fixes". | It carries every production-only hotfix: #90, #91, #103–#106, #168 and #170. | Cherry-pick only the nine commits of #103–#106. That was the owner's decision Q2, 2026-09-11. | Read `git log --first-parent origin/development..origin/production` before choosing a merge over a cherry-pick. |
| M16 | An earlier note assumed `npm run local` failed only under the Claude preview tool. | On Windows 11 with Node 24.19.0, it provisions Floci fully, then dies with `spawn npm ENOENT` even from a plain Git Bash shell. The one-command setup never starts the app on Windows. | After provisioning, use the documented secondary workflow: `npm run dev` and `npm --prefix web run dev`. The code fix (`scripts/local/dev.mjs:79-80`) is deferred; see section 6.4. | On Windows, `spawn('npm')` without a shell cannot find `npm.cmd`. Reproduce in a plain shell before blaming a tool. |
| M17 | The 2026-09-11 baseline ran `npm run typecheck` while dev servers, Floci and other sessions were running. The machine had 1.4 GB of 15.7 GB RAM free. | `tsc --noEmit` died after 29 s with "Zone Allocation failed - process out of memory", exit 134. Typecheck has no valid baseline yet. | Not re-run yet. Stop the dev servers once `/health` is verified, then run typecheck alone and record both attempts. | An out-of-memory crash is an environment result, not a code result. Re-run it alone before classifying it. |
| M18 | Session fac066ed was interrupted mid-loop at about 14:57 on 2026-09-11. All of its state lived in `%TEMP%`: an untracked handoff, an unapplied plan revision, and a review log with no round-1 result. | Six days later no branch showed that the loop had run, and a machine transfer would have lost it. | This session committed the 09-10 handoff (`a4bad74`) and recorded the loop's state here. The devkit archives the scratchpad. | Apply P10 and P11. |
| M19 | `TaskStop` on the background `npm run dev` (task `bci09pe7j`, stopped at 14:54 on 2026-09-11) was taken as having stopped the orchestrator. | The orchestrator kept running and writing to that task's output file until at least 2026-09-13 23:59:35Z. The file reached 817 KB. | On 2026-09-17, nothing listened on ports 3000, 5173 or 4566. | After stopping a dev server on Windows, confirm with `netstat -ano` that its port is free, and kill the process tree by PID if it is not. |
| M20 | Round 1 accepted BR-003's absence check exactly as written: `git grep -n TOOL_LOOP_MAX_TOKENS` must print nothing and exit 1. The check is not scoped to code. | It can never pass. On 2026-09-17, `origin/production` itself had 5 hits, all in docs: `docs/diagrams/request-lifecycle.md` twice and the append-only 2026-08-24 session log three times. The session handoffs name the constant too. | Scope the check to code: `git grep -n TOOL_LOOP_MAX_TOKENS -- src infra` prints nothing and exits 1. On `origin/production`, the same check over `src infra scripts web` exits 1. The resumed loop must amend the revised plan's Verification 2. | A textual absence check must exclude history. Run it against the reference branch (here `origin/production`) before adopting it as an acceptance criterion. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A10 | `origin/development` stayed at `271339b` from 2026-09-07 22:29 until at least the main checkout's fetch of 2026-09-16 10:04 (-04:00). | Verified from the `origin/development` reflog and from `FETCH_HEAD`, which lists `development`, `qa`, `staging` and `production`. So plan finding 6 ("development moves about 7 commits a day") did not hold in that window. Re-fetch before relying on this. |
| A11 | The owner's 2026-09-11 authorization to push `fix/backmerge-production-hotfixes` and open a PR into `development` was given to session fac066ed. | It is recorded in `PLAN-REVIEW-LOG.md`. The 2026-09-17 transfer push of this branch is a separate approval, for a backup only. A resumed session re-confirms with the owner before it pushes the finished back-merge or opens the PR. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| The claudex Q1 step switches Codex MCPs off in `~/.codex/config.toml` and restores them only when the loop ends, so an interrupted loop leaves them off. | This log, section 6.3 |
| `picks.sh`, `validate.sh` and `red1.sh` hard-code `REPO=/c/dev/_netzer-backmerge`, and `red1.sh` uses the Git-Bash-only `MSYS_NO_PATHCONV`. | This log, Appendix A |
| The 2026-09-11 baseline on `271339b` has six red test files and one "Worker exited unexpectedly" error. | This log, section 7.2 |
| `node scripts/ci/docs-assets.mjs` fails on `271339b` because `docs/diagrams/system-flow.excalidraw` is 2.3 MB, over the 2 MB budget. This is pre-existing. | This log, section 7.2 |

### Merged 2026-09-18 from the parallel docgen-crash-wip-transfer ledger

> The 2026-09-17 [docgen-crash-wip-transfer](./2026-09-17-docgen-crash-wip-transfer.md)
> log appended its own entries from P10, M14 and A10, colliding with the
> back-merge ledger above. Its own instruction: "renumber the later entries rather
> than drop either". Text is verbatim; only the IDs changed (P10→P12, P11→P13,
> M14→M21, M15→M22, M16→M23, A10→A12, A11→A13). References inside the text keep
> their original numbers and point at that log.

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P12 | Before resuming a `wip/*` backup branch, check what `origin/development` and `origin/production` now contain for the files it edits. | `wip/docgen-crash-turn-ceiling` edits the same `maxTokens` sites and `appendTurns` that `fix/backmerge-production-hotfixes` is bringing to `development`. |
| P13 | When a session leaves work uncommitted, write or update its dated session log too, and prefer committing to a `wip/*` branch before closing. | The 2026-08-25 WIP had no session log and sat uncommitted for 23 days on a disk that later filled to 99%. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M21 | On 2026-08-25 the owner asked whether he could raise the token limit himself, and the agent started building the feature. The owner then said he was only asking. | An unrequested, unfinished feature was left in the tree. | The agent stopped and answered the question. The code is kept as a backup on `wip/docgen-crash-turn-ceiling` (`ef0768f`), not merged. | Answer the question first. Build only when asked. |
| M22 | The 2026-08-25 work ended with uncommitted changes, and the only record was the rewritten canonical `HANDOFF.md`. No dated session log was written or updated. | A reader of `handoffs/` would not know the WIP existed. The only copy was one linked worktree. | Committed to a backup branch on 2026-09-17, and this log records it. | See P11. |
| M23 | `HANDOFF.md` recorded the new tests as "not passing" with a single named cause (the unhoisted `getConfig` mock). There was no run log. | Hoisting the mock alone will not make the suite green. A whitespace-only value resolves to 1024, but the test expects 8192. The byte-trim tests may not be failing at all. | Recorded in section 3.1 and in `HANDOFF.md`. Not fixed, because this session only makes a backup. | "Not passing" without a run log is a claim. Name each failing test and its cause, and keep the output. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A12 | A push of `wip/docgen-crash-turn-ceiling` starts no workflow. | Verified 2026-09-17 against this branch's `.github/workflows/` push triggers: `branch-guard` fires for qa, staging and production; `ci` and `docs-ci` for development, qa, staging and production; `deploy` for staging only. `cdk-drift` runs on a schedule. Re-check if a workflow is added. |
| A13 | The WIP was written in Claude Code session `2485d76c-309a-47fd-a199-1154b9f7d82c` (2026-08-24 17:12Z to 2026-08-25 12:47Z). Its scratchpad scripts (`add-knob.py`, `knob-tests.py`) no longer exist. | Verified from the transcript's timestamps and the missing `%TEMP%` folder. Commit `ef0768f` is now the only copy of the work, apart from the tool inputs recorded in that transcript. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| `Number('  ')` is `0`, not `NaN`. An `!raw \|\| !Number.isFinite(...)` junk check lets a whitespace-only value through as zero. | [docgen-crash-wip-transfer](./2026-09-17-docgen-crash-wip-transfer.md), section 3.1 |
| A mock created inside a `vi.mock` factory cannot be reached from test bodies. Hoist it with `vi.hoisted`. | [docgen-crash-wip-transfer](./2026-09-17-docgen-crash-wip-transfer.md), section 3.3 |

### Added 2026-09-18 (WI-0.1 specification)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P14 | Map a cherry-pick sequence before touching the branch: `git merge-tree --write-tree --merge-base=<c>^ <cur> <c>`, chained with `git commit-tree`. | It lists every conflict of every pick without moving a ref or the working tree. It showed that `4765612` cannot be picked whole. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M24 | Assumed that porting production's final test blobs ahead of the picks would let the picks apply cleanly. | None; the simulation caught it. `8c14b3f`, `1abba67`, `333ef6b` and `d828124` conflict on those test files. | Resolve each by keeping ours, then check `git hash-object <file>` equals `git rev-parse origin/production:<file>`. | A pick carries its own version of a file. Only the last pick that touches a file matches its final blob. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A14 | On the macOS machine (16 GB RAM, about 4 GB free+inactive), `npm run typecheck` exits 0 in about 8 s on `9e8e42b`. | Observed 2026-09-18. M17's out-of-memory crash did not reproduce here. Re-run alone if it ever does. |
| A15 | With every AWS credential source stripped, the full `npm test` on `9e8e42b` is green: 244 files, 3174 tests, on two consecutive runs. | Observed 2026-09-18. So on this machine a red run is not explained by a lapsed AWS session. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| `~/.aws` exists on the Mac, so `development.md`'s fourth AWS-safety layer ("no credentials on the machine") does not hold there. Strip credential sources for every test run. | This log, section 7 |
| Development's War Room PDF export returns 200 for emoji, with text like `Ship it Ø=Þ€ done '`. Production's own emoji test cannot see that; the substitution test can. | This log, section 7.2 |

### Added 2026-09-18 (WI-0.1 implementation)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P15 | Keep a delegated build's work order, proof script, run artifacts and session-log draft outside the checkout. | The runner refuses a dirty checkout, and any file inside it would enter Codex's diff. |
| P16 | After a Codex build, read the event stream (`stdout.txt` in the run directory) for `mcp_tool_call` items, not just the diff. | `~/.codex/config.toml` enables MCP servers, including `computer-use` and `node_repl`, which act outside the workspace sandbox. The runner forbids extra flags that could disable them. This session's build made none. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M25 | Treated the conflict map as the expected outcome. `333ef6b` and `d828124` did not conflict, and `5193ced` did (on `HANDOFF.md`). | None: the pick loop acted on each pick's observed state. | Section 3.1 records the actual outcome. | Resolve by the state git reports, and verify by blob afterwards. |
| M26 | This session's chat status said four picks resolved empty. It was five: `81c9d0e`, `7ba28f8`, `ce185de`, `d8bad53`, `246bd2b`. | A wrong count in chat, corrected before this log. | Recounted from the pick log. | Count from the saved log, never from memory. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A16 | Codex `gpt-5.6-terra` at medium effort, through `codex-build` (workspace-write), can run this repo's `vitest` and `tsc` in its sandbox. | Observed 2026-09-18: it reported 58/58, and the host's rerun agreed. One build only. |
| A17 | With every AWS credential source stripped, the full `npm test` on `6d43213` is green: 245 files, 3196 tests. | Observed 2026-09-18, one run. The +1 file and +22 tests are the ported production tests. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| `git diff -U0` shows an unchanged first line as context. Comparing an approved diff's `-`/`+` lines against it can report a false mismatch; compare the resulting text instead. | This log, section 7.8 |
| Codex's config defaults to `gpt-5.6-sol` / `xhigh`. A runner call without `--model` and `--effort` inherits it. | This log, section 3.3 |

### Added 2026-09-18 (WI-0.1 cleanup)

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M27 | Compared the War Room route with a shell function that ran `git show $1:src/adapters/dashboard/handler.ts`. The Bash tool's shell on this Mac is zsh, which reads `$1:s…` as its `:s` substitution modifier and asked git for `HEADd/handler.ts`. Both extracts came out empty, and `cmp` reported them equal. | For one command, "route equals production" rested on two empty files. The zero line count caught it before anything was recorded. | Reran with `"${r}:path"`. Both extracts have 64 lines and are equal (7.2). | Two empty extracts are always equal. Check each extract's size before trusting `cmp`, and brace a parameter when a `:` follows it. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| `request-lifecycle.md`'s history-poisoning bullet (production's `3bffea6` text) says the tool loop's ceiling is `TOOL_LOOP_MAX_TOKENS`. On both branches the code has `TURN_MAX_TOKENS` on all three calls. The sentence is stale and carried verbatim; it is not a WI-0.1 defect. | This log, sections 3.1 and 4.3 |
| Production's War Room note in `architecture-security.md` says the route is *gained*. That is true only on production. Do not replace the back-merge's own note with it. | This log, section 3.1 |

### Added 2026-09-18 (WI-0.1 verification)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P17 | Run mutation tests (RED-2) and full validation one after the other, never side by side, and start full validation only after `git status --porcelain` is empty. | A validation run that overlaps a mutation measures the mutant. This session ran them in sequence. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M28 | Checked README 4a's baseline claim with `git show $B:src/…` inside `$(…)`. zsh read `:s` as a modifier again (M27) and printed "bad substitution". `grep -c` on the empty input then printed `0`, which is exactly the "fails on the baseline" answer the check expected. | Two baseline results briefly rested on empty input. The error text caught it before anything was recorded. | Reran with `"${B}:path"` and printed each file's line count (7.7). | M27 again, in a worse form: when the expected answer is "absent", an empty extract agrees with it. Brace every ref, and print the extract's size next to any zero. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A18 | With every AWS credential source stripped, the full `npm test` on `fdda55c` is green: 245 files, 3196 tests. | Observed 2026-09-18, one run (22 s). The same count as at `6d43213`. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| Line 1 of `request-lifecycle.md` (the #96 drift-gate note) also names `TOOL_LOOP_MAX_TOKENS`. It records what #96 did at the time and is identical on all three refs. It is not the stale sentence; only line 51 is. | This log, section 3.1 |
| A conflict-resolved pick's patch-id differs from its original's even when the pick adds nothing. Compare the `+`/`-` line sets per file instead. | This log, sections 3.3 and 7.5 |


### Added 2026-09-18 (WI-0.2 specification)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P18 | Before trusting a PASS from a check that proves absence ("no adapter changed", "nothing outside scope"), run it once against a planted violation. | The WI-0.2 proof's scope checks ran inside `bash -c` with a non-exported `BASE`. `git diff origin/` then failed silently, and both checks passed on nothing (M30). A stray untracked adapter file exposed it. |
| P19 | Put the Step-0 declaration ahead of any gate in a Gauntlet handoff's numbered steps. | This session's handoff numbered G0 first, so G0's read-only checks ran before the declaration. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M29 | The parked `trimTurnsToBudget` (`ef0768f`) cut the window anywhere and always kept the newest turn. Its reason was that an empty window breaks role alternation. | The stored window could start with an assistant turn: a cut landing on a large user turn, or only the reply kept. Every later request would then start with an assistant message, a new path to permanent chat poisoning. All six parked fixtures were assistant-only, so none could see it. | The spec rule: cut only at a user turn, never store over budget, and `kept` may be empty. Pinned in `56e37b0`. | Transcript fixtures alternate roles. An empty history is valid; a history that starts with the reply is not. |
| M30 | The proof's AC-0.2-5 and AC-0.2-6 used `$BASE` inside `bash -c` without exporting it. | Both would have passed on any tree. | `export BASE`, plus a negative control that must FAIL and then PASS once the planted file is removed (7.6). | P18 |
| M31 | The handoff called `_netzer-turn-ceiling` a linked worktree. | `Netzer-Labs`' `git worktree list` does not show it, and its remote refs are separate. | `git rev-parse --git-common-dir` returns `.git`: it is a standalone clone. Local-only commits from `_netzer-backmerge` reach it through `git fetch ../_netzer-backmerge <branch>`. | Confirm clone or worktree with `--git-common-dir`, not from the handoff. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A19 | With credentials stripped, the full step 7 list on `9f1cd58` equals the baseline: `npm test` 245 files and 3196 tests; integration 38 passed, 25 skipped, 1 failed (the Floci gap). | Observed 2026-09-18, one run in `_netzer-backmerge`. `typecheck` and `npm test` gave the same result in `_netzer-turn-ceiling`. |
| A20 | Every production model id accepts `maxTokens` 32,768. | Inferred from the Claude 4.x model families, not checked on Bedrock. Re-check if a model id with a smaller output limit is added (`claude-3-5-haiku` tops out at 8192 and appears only in fixtures). |
| A21 | Bedrock Converse rejects a conversation whose first message is the assistant's. | Inferred. The repo records strict alternation at `agent-loop.ts:1281-1286`. Not reproduced here, because this session made no live calls. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| `graft` has no index for `_netzer-turn-ceiling`, and `graft build` would write an untracked `graft/` into the checkout. | This log, section 4.3 |
| `diagrams-drift.mjs` diffs `origin/<base>...HEAD`, so it sees committed changes only. Until WI-0.1 lands, WI-0.2's base is `origin/fix/backmerge-production-hotfixes`, not `development`. | `wi-0.2-proof.sh` (`WI02_BASE`) |
| `_netzer-turn-ceiling` has no `web/node_modules`. The web typecheck and web build in step 7 fail there until `npm --prefix web ci` runs. | This log, section 6.3 |

### Added 2026-09-18 (WI-0.2 implementation)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P20 | A proof that a delegated builder must run inside its sandbox must need no network and no `.git` writes, or its work order must say how to run the proof's steps without them. | `wi-0.2-proof.sh` runs `git fetch`. In Codex's workspace-write sandbox that failed with `cannot open '.git/FETCH_HEAD': Operation not permitted`. The work order's sandbox note let the build run the steps directly instead of editing the script. |
| P21 | Render every Mermaid block a change touches with the pinned renderer before committing: `node scripts/ci/docs-mermaid.mjs`, or the cached `mmdc` for one block. | M33: a parse error passed every grep-based check in the proof. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M32 | Codex build 1 trimmed the config value with `raw?.trim()`, trusting `getConfig`'s declared `string \| undefined`. | A value stored as a DynamoDB Number would throw outside the `.catch`, and every turn on every surface would fail. The frozen tests give `getConfig` only strings, `undefined` or a rejection, so none of them can see it. | `typeof raw === 'string' ? raw.trim() : raw`, in the correction round (`3ae63b4`). The replica check shows build 1 throwing on every numeric value and `3ae63b4` returning a number (7.8). | A declared type on a value read from DynamoDB is a cast, not a check. `repairEmptyTurns` already learned this for turn text. |
| M33 | Codex build 1 put a `;` inside a Mermaid sequence-diagram message in `request-lifecycle.md`. | The diagram no longer parsed (`mmdc` 10.9.1: `Parse error on line 36`). Docs CI's `docs-mermaid` gate would have failed the PR, while every proof line passed. | The message now uses commas (`3ae63b4`). Both mapped diagrams render. | In a sequence-diagram message, `;` and `#` are syntax. Render, don't grep (P21). |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A22 | Codex `gpt-5.6-terra` (medium), through `codex-build`, can take one narrow correction by resuming its build session (`--resume <result.json> --feedback <file>`, same model and effort). | Observed 2026-09-18: build 1 took 251 s and the correction 36 s. Neither made an MCP tool call (P16). |
| A23 | With every AWS credential source stripped, the full `npm test` on `3ae63b4` is green: 246 files, 3209 tests. | Observed 2026-09-18, one run (19 s). |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| `git grep` prints only `Binary file src/lib/state/runtime-config-repo.ts matches` for that file, so its lines cannot be read that way. Use `grep -a`. The cause was not investigated. | This log, section 7.3 |
| In Codex's sandbox, `.git` is read-only and binding `127.0.0.1` is denied. Its own full `npm test` shows `src/lib/paperclip/client.mock-server.test.ts` failing with `listen EPERM`. That is an environment result. | This log, section 3.1 |

### Added 2026-09-19 (WI-0.2 cleanup)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P22 | Before editing a file that `docs/diagrams.map` lists as a source, even one comment, plan the mapped diagram's change for the same branch. If the diagram truly needs no change, leave the source alone or ask the owner first. | M34. The drift gate cannot tell a comment from code, and its approval escape hatch is not implemented. |
| P23 | Before moving a feature README's `observed_at`/`as_of_commit`, re-check every code claim at the new commit, and give time-bound observations (production logs, "as of") their own dates in the text. | The stamp re-dates every undated claim under it. README section 4 said "As of `observed_at`". |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M34 | The post-merge CLEANUP handoff scoped the work to comments in `agent-loop.ts` and `sessions-repo.ts` and required every proof line to pass, but did not notice that AC-0.2-4-drift would then fail. Before the merge, the branch's diff against its base already held both diagrams; on a new branch off `development` it does not. | A comment-only cleanup would have failed the proof and Docs CI (7.6). | Found by reading the drift script before the first edit. Both diagrams got real fixes (findings 6 and 7). | When the base of a piece of work changes, re-derive which gates depend on the diff. |
| M35 | This session's first README claim check had two over-strict greps. C4 failed on any mention of the sessions table outside the repo, and C14b looked for the C0 strip in `docx.ts`. | Two false FAILs at `b152b7a`. | Both traced by reading the code (3.1). The checks now test the claims themselves (7.5). | A FAIL from a grep check is a lead, not a finding. Read the code before classifying it. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A24 | With credentials stripped, the full `npm test` gives 246 files and 3209 tests at `b152b7a` and at `d1876b1`. | Observed 2026-09-19, one run each (26.37 s and 19.40 s). |
| A25 | Bedrock rejects a request whose first message is the assistant's, and nothing in the agent loop reorders or drops a leading assistant turn: `agent-loop.ts:1021-1023` builds the request as `turnsToMessages(stripBlockedTurns(req.history))` plus the new message. | The code path was read this session. The Bedrock rule comes from the parked comment and M29 and was not re-tested live. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| A handoff pasted into a new session can predate the state file's section 0. Compare both against `git fetch` before acting. | This log, section 4.3 |

### Added 2026-09-19 (WI-0.2 verification)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P24 | When a work item merged before its VERIFICATION, run the proof as specified. Then also run AC-0.2-5 and AC-0.2-6's filters over the whole item, from the merge's first parent: `git diff --name-only <merge>^1 HEAD`. | With `WI02_BASE=development`, the proof's `touched()` sees only the post-merge delta, so the proof alone no longer covers the implementation's scope. |
| P25 | Keep a VERIFICATION session's log outside the tree until the gates have run, then move it in. | The bar asks for a clean committed HEAD, and the proof's AC-0.2-5, AC-0.2-6 and `status` line count untracked files. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M36 | The WI-0.2 cleanup's README claim check (22 PASS) moved the stamp to `d1876b1` over README 2.1's "Every consumer that converts stored turns into Bedrock messages — the agent loop, the dashboard TLDR path, Jarvis — reads through `getSession`". That session saw `jarvis-memory-repo.ts` and judged the sentence still true, because Jarvis keeps its own partition. But the sentence names Jarvis as reading through `getSession`, and Jarvis never does. False since `9d72979` (2026-08-24). | The stamp certifies a false claim. WI-0.2 VERIFICATION FAIL on fix 5 (the 2026-09-19 verification log, 4.3). | Routed to a fresh CLEANUP. | "Every X goes through Y" is checked by listing X from the code, through imports and call sites, and each example the sentence names is a claim of its own. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A26 | At `974399b`, with credentials stripped, the full step 7 list equals the baseline. `npm test`: 246 files and 3209 tests. Integration: 38 passed, 25 skipped and 1 failed, the Floci `checkSecrets` gap. | Observed 2026-09-19, one run of 37 s for the whole list. |
| A27 | The cleanup `b152b7a..974399b` is comment-only in `src/`. `ts.transpileModule` with `removeComments` gives identical output for both changed files at both commits. | Observed 2026-09-19. |
| A28 | Jarvis never stores an empty turn: `jarvis-memory-repo.ts` `appendTurn` trims the text and returns without writing when it is empty. Its replay path, `buildSeedMessages`, has no empty-text filter of its own. | Read 2026-09-19, not executed. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| `_netzer-turn-ceiling`'s local `development` ref is stale (`9e8e42b`). The proof and `diagrams-drift.mjs` read `origin/development`, so they are unaffected. A hand-typed `git diff development` is not. | The 2026-09-19 verification log, section 7.1 |
| A shell check that nests `awk '{print $NF}'` inside a double-quoted `eval` string gets `\$` wrong and fails with an awk syntax error. That is M35 again: a FAIL from the check is a lead. | The 2026-09-19 verification log, section 7.5 |

### Added 2026-09-19 (WI-0.2 cleanup rerun)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P26 | For an "every X" claim, also grep each seam's name without its call parenthesis, so callers bound through a dependency-injection alias (`deps.runTurn ?? runAgentTurn`) are counted. | M37. |
| P27 | Re-check a README's claims sentence by sentence, including negative ones ("unchanged", "not covered"), rather than a remembered list of claims. | M38. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M37 | The WI-0.2 verification listed replay paths and `appendTurns` writers by call-site name. It missed Paperclip's dispatch worker, which binds `runTurn`, `readSession` and `writeTurns` as `deps.* ?? <name>` (`dispatch-worker.ts:480-482`). | Its 3.1 says "All seven `appendTurns` callers", and there are eight. A README list built from it would have left out a replay path. | This log's 3.1 lists the agent loop's 11 callers and the 8 writers. | P26. |
| M38 | README section 4 said `generate_document`'s "spec validation ... [is] unchanged". That has been false since `389476b` (2026-08-25), the same commit that added README 2.4 and 2.5 about those changes. The WI-0.2 cleanup's 22 checks and the verification's re-check both skipped section 4's sentences, so `d1876b1`'s stamp certified it. | A second false claim under the stamp. | Corrected in `e1cdc11` (checks 4-a to 4-c). | P27. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A29 | At `e036f7a` the 56 README claim checks in `wi-0.2-readme-claims.sh` all pass, and `e1cdc11`'s code is identical. | Observed 2026-09-19, one run (7.2). |
| A30 | The agent's DynamoDB tool (`dynamodb-tools.ts`) can return raw session rows, turns included, without `getSession`. Bedrock gets them as tool-result data, not as conversation turns, so an empty turn cannot become an empty content block. | Read 2026-09-19: the `sessions` allowlist entry sets no `attributes`, so every attribute is projected, and the file has no replay call. The serialization into the tool result was not traced. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| The Bash tool's shell is zsh. There `$R:src/x` applies zsh's `:s` modifier, and `${PIPESTATUS[0]}` is empty. Write `${R}:`, capture exit codes unpiped, or run checks from a bash script file. | This log, sections 7.2 and 7.3 |
| A grep check on exact message text or same-line tokens fails on formatting: a lowercase `docx` (`pdf.ts:78`), or a `422,` on the next line (`handler.ts:3245`). That is M35 again. | This log, section 7.2 |

## 6. Pending work

### 6.1 Smallest next action

**Superseded by 6.5.** The owner said yes to the pinning test, so a SPECIFICATION amendment comes first, and the VERIFICATION below follows it.

A fresh WI-0.2 VERIFICATION of the corrected README, as a new session with Claude Opus and no Codex. The critic:

1. re-checks 2.1, 2.3's date and section 4 against the code, independently;
2. runs the proof and the full step 7 list on the exact HEAD.

### 6.2 Immediate next steps

1. **VERIFICATION** (6.1).
2. **On PASS:** mark WI-0.2 VERIFIED, and emit WI-0.3 SPECIFICATION (plan section 10, P0 step 3).
3. **Owner:** push and PR authorization for `chore/wi02-cleanup`, only after 2 and the step 7 list on that exact HEAD.

### 6.3 Blockers and open questions

- [ ] **Pin the non-string config value with a test? The owner's call.** This is unchanged, and the recommendation is still (b), a SPECIFICATION amendment: AC-0.2-2 becomes 8 ceiling tests and AC-0.2-7 becomes 3210 tests.
- [ ] **Push and PR for this branch.** Not authorized, and not yet due.
- [ ] **Non-streaming tool rounds above 8192 output tokens.** Whether they finish is still Unknown. The "unlimited ceiling" request is a proposed new work item, not WI-0.2.

### 6.4 Deferred, and why

- **The full step 7 list.**
  - It runs before a push, and this session pushes nothing.
  - `src/`, `infra/`, `web/`, `scripts/` and `tests/` are identical to `974399b`, where it equaled the baseline.
- **Unchanged items.**
  - The cleanup log's three README debts.
  - F6.
  - The `mission-tools.ts:150` line citation.

### 6.5 Owner answers, after this session's two commits

The owner answered the open questions on 2026-09-19:

1. **Pinning test: yes**, option (b). The next session is a SPECIFICATION amendment, and 6.1's VERIFICATION follows it.
2. **F4 stays** ("fix it").
3. **Push and PR for `chore/wi02-cleanup`: yes**, after a fresh VERIFICATION PASS and the step 7 list on the exact HEAD.
4. **Promote `development → qa → staging`: yes**, after that PR merges. Production stays blocked.
5. **"Unlimited ceiling": (c).** Large documents go through the incremental document tool, which is approved for P4 but not built yet. The 8192 default stays.
6. **Land `docs/npm-test-credential-strip`: yes.** This session:
   - rebased it onto `b152b7a` (`b7ab004`);
   - ran the full step 7 list on `aeb20a7`, which equals the baseline: 246 files and 3209 tests; integration 38 passed, 25 skipped, 1 failed, the Floci gap;
   - pushed it and opened [PR #178](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/178) into `development`. It is not merged.
7. **Refresh `development.md`'s test table: yes.** That is `aeb20a7`, in PR #178. Only the `npm test` and integration rows changed.

**One-time decision.** The step 7 list for `aeb20a7` ran in `_netzer-turn-ceiling`, on a detached checkout of that exact commit.
- Why: the worktree has no `node_modules`, and the two commits' package files are identical.
- Afterwards, the clone went back to `chore/wi02-cleanup`, clean.

## 7. Verification actually performed

No test ran outside the proof. The proof strips the AWS credential sources itself. Exit codes were captured unpiped (M13).

### 7.1 State

- `chore/wi02-cleanup` was at `e036f7a`, and the tree was clean.
- After `git fetch origin development`, `origin/development` is `b152b7a`.
- `git diff --name-only 974399b e036f7a` lists only `HANDOFF.md` and the verification log, so VERIFICATION's executed results carry to this code.

### 7.2 README claim checks at `e036f7a`

The checks come from `~/.claude/plans/netzar-chat-plan/wi-0.2-readme-claims.sh`. It reads the commit through `git grep` and `git show`, never the working tree.

- **First run: 54 checks, 2 FAILs.** Both were my own greps, not README errors:
  - 2.5-a looked for `DOCX`, but the error says "Generate it as docx instead" (`pdf.ts:78`).
  - 2.5-h looked for `422` on the same line as `pdf_render_failed`, but it sits on the next line (`handler.ts:3245`).
- **Second run: both commands fixed, and 2.3-m and 4-c added. 56 PASS, exit 0.**

Its helpers, as run:

```bash
R=$(git rev-parse "${1:-HEAD}^{commit}") || exit 98
AL=src/agent/agent-loop.ts SR=src/lib/state/sessions-repo.ts H=src/adapters/dashboard/handler.ts
J=src/adapters/dashboard/jarvis.ts JM=src/lib/state/jarvis-memory-repo.ts T=src/lib/documents/types.ts
P=src/lib/documents/pdf.ts DW=src/lib/paperclip/dispatch-worker.ts DT=src/lib/tools/document-generation-tools.ts
W="$H src/adapters/slack/handler.ts src/adapters/telegram/handler.ts src/agent/scheduler.ts src/lib/scheduler/queue-drain.ts $DW"
n()    { git grep -cE -e "$1" "$R" -- "${@:2}" | awk -F: '{s+=$NF} END{print s+0}'; }   # matching lines, summed
has()  { git grep -qE -e "$1" "$R" -- "${@:2}"; }
hasF() { git grep -qF -e "$1" "$R" -- "${@:2}"; }
show() { git show "$R:$1"; }
c4a()  { local r=$1 a b c d   # README 4a's five code checks at rev $1, one P/F letter each
  if git grep -q TOOL_LOOP_MAX_TOKENS "$r" -- src infra; then printf F; else printf P; fi
  a=$(git grep -c "maxTokens: TURN_MAX_TOKENS" "$r" -- src/agent/agent-loop.ts | awk -F: '{print $NF}')
  b=$(git grep -c "maxTokens: turnMaxTokens" "$r" -- src/agent/agent-loop.ts | awk -F: '{print $NF}')
  if [ "${a:-0}" = 5 ] || [ "${b:-0}" = 5 ]; then printf P; else printf F; fi
  if git grep -q "claude-haiku-4-5-20251001-v1:0" "$r" -- infra/lib/constants.ts; then printf P; else printf F; fi
  c=$(git grep -cE "^export (async )?function (assertPdfRenderable|toPdfSafeText)" "$r" -- src/lib/documents/pdf.ts | awk -F: '{s+=$NF} END{print s+0}')
  if [ "$c" = 2 ]; then printf P; else printf F; fi
  d=$(git grep -c "function repairEmptyTurns" "$r" -- src | awk -F: '{s+=$NF} END{print s+0}')
  if [ "$d" = 1 ]; then printf P; else printf F; fi; }
export R AL SR H J JM T P DW DT W; export -f n has hasF show c4a
fails=0
chk() { local r=PASS; bash -c "$3" >/dev/null 2>&1 || { r=FAIL; fails=$((fails+1)); }
  printf '| %s | %s | `%s` | %s |\n' "$1" "$2" "${3//|/\\|}" "$r"; }
```

| # | Claim | Command | Result |
|---|---|---|---|
| carry | src, infra, web, scripts and tests unchanged since 974399b, so VERIFICATION's executed results carry | `git diff --quiet 974399b $R -- src infra web scripts tests` | PASS |
| 1-a | 1: `stripBlockedTurns` is the guardrail-notice guard | `has "^export function stripBlockedTurns" $AL` | PASS |
| 1-b | 1: every turn replays the stored history | `has "const cleanHistory = stripBlockedTurns\(req\.history\);" $AL && has "\.\.\.turnsToMessages\(cleanHistory\)," $AL` | PASS |
| 1-c | 1: each stored turn becomes one text block as is (an empty turn, an empty block) | `has "content: \[\{ text: t\.text \}\]," $AL` | PASS |
| 2.1-a | 2.1: `getSession` returns `repairEmptyTurns(...)` | `has "turns: repairEmptyTurns\(" $SR` | PASS |
| 2.1-b | 2.1: empty, whitespace-only or absent text gets `NO_RESPONSE_NOTICE` | `has "typeof t\.text === .string. && t\.text\.trim\(\) \? t : \{ \.\.\.t, text: NO_RESPONSE_NOTICE \}" $SR` | PASS |
| 2.1-c | 2.1: the agent loop has 11 callers: 10 direct `runAgentTurn({` plus Paperclip's `runTurn` alias | `[ $(n "runAgentTurn\(\{" src ":!*.test.ts" ":!$AL") = 10 ] && hasF "const runTurn = deps.runTurn ?? runAgentTurn;" $DW` | PASS |
| 2.1-d | 2.1: 8 of them pass the stored session's turns as `history` | `[ $(n "const history = session\?\.turns \?\? \[\];" $W) = 8 ]` | PASS |
| 2.1-e | 2.1: each of those 8 sessions was read by `getSession` (Paperclip: `readSession`) at most 12 lines above | `for f in $W; do show $f \| awk "/(getSession\|readSession)\(/{l=NR} /const history = session\?\.turns/{if(!l\|\|NR-l>12)b=1} END{exit b}" \|\| exit 1; done` | PASS |
| 2.1-f | 2.1: `readSession` is `getSession` and `runTurn` is `runAgentTurn`; no non-test code injects either | `hasF "const readSession = deps.getSessionFn ?? getSession;" $DW && ! git grep -qE "getSessionFn\|runTurn:" $R -- src ":!*.test.ts" ":!$DW"` | PASS |
| 2.1-g | 2.1: the other 3 callers (canary, agent-tools, War Room) replay no stored history | `for f in src/agent/canary.ts src/lib/tools/agent-tools.ts src/lib/warroom/orchestrator.ts; do has "history: \[\]" $f \|\| exit 1; done` | PASS |
| 2.1-h | 2.1: the sessions table is named in exactly these 7 files | `[ "$(git grep -lE "TABLE_SESSIONS\|claudeclaw-sessions\|PREFIX\}-sessions" $R -- src ":!*.test.ts" \| sed "s/^$R://" \| tr "\n" " ")" = "src/adapters/dashboard/handler.ts src/adapters/dashboard/jarvis.ts src/config/env.ts src/lib/security/posture-repo.ts src/lib/state/jarvis-memory-repo.ts src/lib/state/sessions-repo.ts src/lib/tools/dynamodb-tools.ts " ]` | PASS |
| 2.1-i | 2.1: the dashboard's 3 direct reads and Jarvis's `sessions` scan all project, and never `turns` | `[ $(n "TableName: TABLE_SESSIONS" $H) = 3 ] && [ $(n "ProjectionExpression: (projection\|.PK, SK, updatedAt, modelOverride, messageCount, firstMessage, createdAt, surface, userId.)" $H) = 3 ] && has "^ +.PK, SK, updatedAt, modelOverride, messageCount, firstMessage, createdAt, surface, userId.;" $H && [ $(n "TableName: TABLE_SESSIONS" $J) = 1 ] && has "ProjectionExpression: .PK, SK, updatedAt, messageCount, surface, userId." $J` | PASS |
| 2.1-j | 2.1: the agent DynamoDB tool reads session rows as query data and never replays them | `! has "turnsToMessages\|converse\|stripBlockedTurns" src/lib/tools/dynamodb-tools.ts` | PASS |
| 2.1-k | 2.1: memory ingest gets stored turns only via `getSession` in sessions-repo, flattened into one prompt | `[ $(n "ingestEvictedTurns\(" src ":!*.test.ts" ":!src/agent/memory-ingest.ts") = 2 ] && [ $(n "ingestEvictedTurns\(" $SR) = 2 ] && [ $(n "const existing = await getSession\(agentId, chatId\);" $SR) = 2 ] && has "t\.role\}: .\{t\.text\}" src/agent/memory-ingest.ts` | PASS |
| 2.1-l | 2.1: Jarvis replays `jarvis-memory-repo` turns and nothing in Jarvis imports sessions-repo | `has "loadRecent as loadJarvisMemory" $J && [ $(n "loadJarvisMemory\(" $J) -ge 2 ] && has "function buildSeedMessages" $J && ! has "from .*sessions-repo" $J $JM src/lib/jarvis` | PASS |
| 2.1-m | 2.1: Jarvis's `appendTurn` refuses empty text and is its repo's only write | `has "const text = \(turn\.text \?\? ..\)\.trim\(\)\.slice\(0, MAX_TURN_TEXT\);" $JM && hasF "if (!principalHash \|\| !text) return;" $JM && [ $(n "new (PutCommand\|UpdateCommand\|BatchWriteCommand\|TransactWriteCommand)\(" $JM) = 1 ] && show $JM \| awk "/^export async function appendTurn\(/{a=1} a&&/new PutCommand\(/{f=1} /^}/{a=0} END{exit !f}"` | PASS |
| 2.1-n | 2.1: the TLDR bar posts `{ tab, data }` and its route reads no transcript | `has "post<\{ summary: string \}>\(./tldr., \{ tab, data \}\)" web/src/components/TldrBar.tsx && hasF "JSON.stringify(body.data ?? {})" src/adapters/dashboard/tldr.ts && ! has "TABLE_\|getSession\|sessions-repo\|loadRecent" src/adapters/dashboard/tldr.ts` | PASS |
| 2.2-a | 2.2: both return paths fall back to `truncatedNotice`, never empty text | `hasF "text: safeText \|\| truncatedNotice(initial.stopReason)," $AL && hasF "const finalText = lastText \|\| truncatedNotice(lastStopReason);" $AL` | PASS |
| 2.2-b | 2.2: `max_tokens` gets the cut-off, ask-smaller message; anything else `NO_RESPONSE_NOTICE` | `show $AL \| grep -A3 "^export function truncatedNotice" \| grep -q "Ask for a smaller piece" && show $AL \| grep -A4 "^export function truncatedNotice" \| grep -q ": NO_RESPONSE_NOTICE;"` | PASS |
| 2.3-a | 2.3, 3a: `1024` is the only literal `maxTokens` value agent-loop.ts ever held | `[ "$(git log -p -G"maxTokens: [0-9]" $R -- $AL \| grep -E "^[-+][^-+]" \| grep -oE "maxTokens: [0-9_]+" \| sort -u)" = "maxTokens: 1024" ]` | PASS |
| 2.3-b | 2.3: `generate_document` validates a spec taken whole from the tool call's arguments | `hasF "buildPdf(validateDocumentSpec(args.spec))" $DT` | PASS |
| 2.3-c | 2.3: runtime-config `agent/max_output_tokens`, default 8192, clamp 1024-32768 | `has "getConfig\(.agent., .max_output_tokens.\)" $AL && hasF "const TURN_MAX_TOKENS = 8192;" $AL && hasF "const TURN_MAX_TOKENS_FLOOR = 1024;" $AL && hasF "const TURN_MAX_TOKENS_CEILING = 32_768;" $AL && hasF "return Math.min(TURN_MAX_TOKENS_CEILING, Math.max(TURN_MAX_TOKENS_FLOOR, Math.trunc(parsed)));" $AL` | PASS |
| 2.3-d | 2.3: every `/config` write except `cost/watch_enabled` needs admin | `has "if \(subPath === ./config/cost/watch_enabled. && method !== .GET.\) return .viewer.;" $H && has "if \(subPath\.startsWith\(./config.\) && method !== .GET.\) return .admin.;" $H` | PASS |
| 2.3-e | 2.3, 4a: one `await resolveTurnMaxTokens()` in `runAdmittedTurn` (called by `runAgentTurn`) feeds 5 `maxTokens: turnMaxTokens` on the 3 calls | `[ $(n "maxTokens: turnMaxTokens" $AL) = 5 ] && [ $(n "await resolveTurnMaxTokens\(\)" src ":!*.test.ts") = 1 ] && hasF "const result = await runAdmittedTurn(req, spendAdmission);" $AL && show $AL \| awk "/^async function runAdmittedTurn\(/{a=NR} /await resolveTurnMaxTokens\(\)/{r=NR} a&&!s&&/converseStreamTurnWithFallback\(/{s=NR} /maxTokens: turnMaxTokens/{m[++k]=NR} /new ConverseCommand\(/{c[++j]=NR} a&&NR>a&&!f&&/^(export )?(async )?function /{f=NR} END{exit !(a<r&&r<s&&k==5&&j==2&&s<m[1]&&m[1]<c[1]&&c[1]<m[2]&&m[3]<c[2]&&c[2]<m[4]&&(!f\|\|f>m[5]))}"` | PASS |
| 2.3-f | 2.3: without `maxTokens` the client falls through to `?? 1024` | `has "\?\? 1024" src/lib/bedrock/client.ts` | PASS |
| 2.3-g | 2.3: a turn that never reaches tool use returns before the first tool-loop call | `t=$(show $AL \| grep -n "text: safeText \|\| truncatedNotice(initial.stopReason)," \| cut -d: -f1); c=$(show $AL \| grep -n "new ConverseCommand(" \| head -1 \| cut -d: -f1); [ -n "$t" ] && [ "$t" -lt "$c" ]` | PASS |
| 2.3-h | 2.3: the max-tokens test pins the initial streamed call (its revert-fails run is `carry`) | `hasF "converseStreamTurnWithFallback" src/agent/agent-loop.max-tokens.test.ts && hasF "INITIAL streamed call" src/agent/agent-loop.max-tokens.test.ts` | PASS |
| 2.3-i | 2.3: the daily cost cap refuses a turn before any model call | `t=$(show $AL \| grep -n "throw new CostCapExceededError(" \| head -1 \| cut -d: -f1); r=$(show $AL \| grep -n "const result = await runAdmittedTurn(" \| cut -d: -f1); [ -n "$t" ] && [ "$t" -lt "$r" ]` | PASS |
| 2.3-j | 2.3: `appendTurns` trims to `MAX_TURN_WINDOW_BYTES` (300,000), text bytes plus 64 per turn | `hasF "const MAX_TURN_WINDOW_BYTES = 300_000;" $SR && has "Buffer\.byteLength\(t\.text \?\? .., .utf8.\) \+ 64;" $SR && hasF "trimTurnsToBudget(byCount)" $SR` | PASS |
| 2.3-k | 2.3: byte-dropped turns join the evicted turns that feed memory ingest | `hasF "const evicted = [...countEvicted, ...byteEvicted];" $SR && has "evicted\.length" $SR` | PASS |
| 2.3-l | 2.3: all 8 writers store a user-then-assistant pair, and `MAX_TURNS` is 20 | `hasF "const MAX_TURNS = 20;" $SR && [ $(n "appendTurns\(" src ":!*.test.ts" ":!$SR") = 7 ] && [ $(n "await writeTurns\(" $DW) = 1 ] && for f in $W; do show $f \| awk "/(appendTurns\|writeTurns)\(/{w=NR;k=0} w&&NR>w&&NR<=w+12&&/role: .(user\|assistant)./{k++; if(k==1&&!/role: .user./)b=1; if(k==2&&!/role: .assistant./)b=1} END{exit b}" \|\| exit 1; done` | PASS |
| 2.3-m | 2.3: the production observation dates to 2026-08-24 (that session log's M12) | `l=docs/features/chat-history-integrity/handoffs/2026-08-24-empty-turn-poisoning.md; git show $R:$l \| grep -q "^observed_at: 2026-08-24" && git show $R:$l \| grep -q "production still returned .outputTokens: 1024"` | PASS |
| 2.5-a | 2.5: `assertPdfRenderable` throws and points at DOCX | `has "^export function assertPdfRenderable" $P && show $P \| awk "/^export function assertPdfRenderable/,/^}/" \| grep -q "Generate it as docx instead"` | PASS |
| 2.5-b | 2.5: `cellText` strips C0 control characters | `show $T \| awk "/^export function cellText/,/^}/" \| grep -q "u0000-"` | PASS |
| 2.5-c | 2.5: `MAX_CELL_LEN` is 32,767 and the builder test covers it | `hasF "export const MAX_CELL_LEN = 32_767;" $T && has "MAX_CELL_LEN\|32_?767\|32_?768" src/lib/documents/builders.test.ts` | PASS |
| 2.5-d | 2.5: rows that are not arrays throw | `[ $(n "must be an array" $T) -ge 1 ]` | PASS |
| 2.5-e | 2.5: `cellText` throws on an object or array cell | `show $T \| awk "/^export function cellText/,/^}/" \| grep -q "throw new Error("` | PASS |
| 2.5-f | 2.5: pdf.ts uses built-in Helvetica, WinAnsi only | `has "Helvetica" $P && has "WinAnsi" $P` | PASS |
| 2.5-g | 2.5: `toPdfSafeText` shares `renderable` with `assertPdfRenderable` | `has "^export function toPdfSafeText" $P && [ $(n "renderable\(" $P) -ge 3 ]` | PASS |
| 2.5-h | 2.5: the War Room route runs its text through `toPdfSafeText` and answers `422 pdf_render_failed` | `has "warroom-transcripts/:id" $H && [ $(n "toPdfSafeText\(" $H) -ge 3 ] && show $H \| grep -A1 "error: .pdf_render_failed." \| grep -q "^ *422,$"` | PASS |
| 2.5-i | 2.5: `warroom-transcript.test.ts` pins the `?` substitution | `has "toContain\(.Ship it \? done \?.\)" src/adapters/dashboard/warroom-transcript.test.ts` | PASS |
| 2.5-j | 2.5: `264d024` is #176's merge, dated 2026-09-19, in this history; `6d43213` exists | `git log -1 --format=%s 264d024 \| grep -q "#176" && [ "$(git log -1 --format=%cs 264d024)" = 2026-09-19 ] && git merge-base --is-ancestor 264d024 $R && git cat-file -e 6d43213^{commit}` | PASS |
| 3-a | 3: the three builders exist | `for f in pdf docx xlsx; do git cat-file -e $R:src/lib/documents/$f.ts \|\| exit 1; done` | PASS |
| 3a-a | 3a: `355c397` is the root commit and hard-codes `maxTokens: 1024` | `[ "$(git rev-list --max-parents=0 $R)" = "$(git rev-parse 355c397)" ] && git grep -q "maxTokens: 1024" 355c397 -- $AL` | PASS |
| 2.4-a | 2.4: the per-dimension bounds exist | `has "export const MAX_SHEETS =" $T && has "export const MAX_SHEET_ROWS =" $T` | PASS |
| 2.4-b | 2.4: `MAX_TOTAL_CELLS` is 200,000, asserted per table and sheet, with the split message | `hasF "export const MAX_TOTAL_CELLS = 200_000;" $T && hasF "Split it into several smaller documents" $T && [ $(n "assertCellBudget\(" $T) -ge 3 ]` | PASS |
| 4-a | 4: the tool file (kill switch, cost-cap re-check, S3) is unchanged since the README opened at `9d72979` | `[ "$(git log --diff-filter=A --format=%h $R -- docs/features/chat-history-integrity/README.md \| tail -1)" = 9d72979 ] && [ -z "$(git log --format=%h 9d72979..$R -- $DT)" ] && has "isKillSwitchActive\|KillSwitch" $DT && hasF "getDailyCostUsd(" $DT && has "PutObjectCommand" $DT` | PASS |
| 4-b | 4: its spec validation changed after that, in `389476b` (so "unchanged" is false for it) | `[ "$(git log --format=%h 9d72979..$R -- $T)" = 389476b ] && git show 389476b -- $T \| grep -q "^+.*assertCellBudget"` | PASS |
| 4-c | 4: the folder opened on 2026-08-24 (`9d72979`) | `[ "$(git log -1 --format=%cs 9d72979)" = 2026-08-24 ]` | PASS |
| 4a-a | 4a: no `TOOL_LOOP_MAX_TOKENS` in src or infra | `! git grep -q TOOL_LOOP_MAX_TOKENS $R -- src infra` | PASS |
| 4a-b | 4a: docs on production still mention the old name | `git grep -q TOOL_LOOP_MAX_TOKENS origin/production -- docs` | PASS |
| 4a-c | 4a: the Haiku id is in infra/lib/constants.ts | `hasF "claude-haiku-4-5-20251001-v1:0" infra/lib/constants.ts` | PASS |
| 4a-d | 4a: pdf.ts exports both functions | `[ $(n "^export (async )?function (assertPdfRenderable\|toPdfSafeText)" $P) = 2 ]` | PASS |
| 4a-e | 4a: exactly one `function repairEmptyTurns`, in sessions-repo | `[ $(n "function repairEmptyTurns" src) = 1 ] && has "function repairEmptyTurns" $SR` | PASS |
| 4a-f | 4a (dated 2026-09-18): the five code checks read FFFFP at `9e8e42b`, PPPPP at `6d43213`, and PPPPP here | `[ "$(c4a 9e8e42b)" = FFFFP ] && [ "$(c4a 6d43213)" = PPPPP ] && [ "$(c4a $R)" = PPPPP ]` | PASS |

Also read in the code, rather than grepped:

- The trim (`sessions-repo.ts:68-85`) walks back from the newest turn until the budget is exceeded. It then moves the cut forward to a user turn and keeps `turns.slice(cut)`, which may be empty.
- `toPdfSafeText` (`pdf.ts:56-60`) writes `?` for any code point `renderable` rejects.
- The tool's kill switch is `document_gen_disabled` (`document-generation-tools.ts:172`). Its cost-cap re-check is `getDailyCostUsd({ strict: true })` (`:191`), and it writes S3 with `PutObjectCommand` (`:247`).
- `origin/production` is `de244e6` in this clone (4a-b).

Not code claims, and not re-checked: Bedrock's own rejection message (section 1), and the dated production and measurement observations in 2.4, 2.5, 3a and section 4. The cleanup log's 6.4 already classifies the 3a-versus-4 disagreement.

### 7.3 Docs gates on the README, before `e1cdc11`

- `node scripts/ci/feature-knowledge.mjs`: exit 0, `feature-knowledge: OK`.
- `node scripts/ci/docs-links.mjs`:
  - Its exit code was first lost to zsh's `PIPESTATUS`.
  - Rerun unpiped: exit 0. Output: "187 markdown files · 2737 internal links checked", `docs-links: OK`.
- `git diff --check`: exit 0.

### 7.4 The proof at `e1cdc11`

- **Command:** `WI02_BASE=development bash wi-0.2-proof.sh`, from 2026-09-19T19:02:13Z to 19:02:21Z, on a clean committed HEAD. Exit 0.
- **`tests`:** 6 files passed (6), 71 tests passed (71).
- **Every other line PASS:** `typecheck`, AC-0.2-1a, 1b, 2, 3, 4-drift, 4-content, 5 and 6, and `diff-check`.
- **Drift log:** "8 mapped diagrams, all paths valid" and "no drift across 8 changed file(s)".
- **`status: 0 changed paths`.**
- **P24, the whole item:** `git diff --name-only b152b7a^1 HEAD` lists 13 paths. None is under `src/adapters/`, and none falls outside AC-0.2-6's filter.
- **Code identity:** `git diff --quiet e036f7a HEAD -- src infra web scripts tests` exits 0.

### 7.5 The docs commit

These ran on the final text of this file and `HANDOFF.md`, with this file included through `git add -N`. They ran again after this paragraph was written, with the same results.

- `node scripts/ci/feature-knowledge.mjs`: exit 0, `feature-knowledge: OK`.
- `node scripts/ci/docs-links.mjs`: exit 0. Output: "188 markdown files · 2770 internal links checked", `docs-links: OK`.
- `git diff --check`: exit 0.

The proof's rerun at the docs commit is recorded in the Gauntlet state file, because this file is part of that commit.

### 7.6 Not run, and why

- The full step 7 list, including `npm test` and the integration suite: 6.4.
- The mutation check on 2.3's "pins the initial call". The code is unchanged since `974399b`, where it failed 3 tests as expected (`carry`).
- Anything against AWS, staging or production.

## 8. Environment state

- macOS, Node 24.3.0.
- `_netzer-turn-ceiling`:
  - `chore/wi02-cleanup`, clean after the docs commit, local only.
  - `fix/turn-ceiling-byte-budget` (`c58da7c`) and `wip/docgen-crash-turn-ceiling` (`3706dd2`) are untouched.
  - The local `development` is stale at `9e8e42b`.
  - The gitignored `.env` and `web/node_modules` are present.
- `_netzer-backmerge` and `_netzer-devmd-amend`: not touched.
- Outside the repo:
  - `wi-0.2-readme-claims.sh` sits in `~/.claude/plans/netzar-chat-plan/`.
  - The proof logs are in this session's scratchpad.

## 9. Related documents

- [HANDOFF](../HANDOFF.md) and [README](../README.md)
- [2026-09-19 WI-0.2 verification log](2026-09-19-wi02-verification.md): the FAIL this session fixes, and this ledger's source
- [2026-09-19 WI-0.2 cleanup log](2026-09-19-wi02-cleanup.md): the seven fixes and the three README debts (its 6.4)
- [2026-09-18 WI-0.2 implementation log](2026-09-18-wi02-implementation.md): the owner's non-string question (its 6.3)
- Outside the repo, in `~/.claude/plans/netzar-chat-plan/`: `wi-0.2-proof.sh`, `wi-0.2-full-validation.sh`, `wi-0.2-readme-claims.sh`, and the plan (section 10, P0 steps 2 and 3)
