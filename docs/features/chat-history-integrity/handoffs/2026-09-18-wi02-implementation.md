---
feature: chat-history-integrity
document_role: session-handoff
status: current
observed_at: 2026-09-18
as_of_commit: 3ae63b454381db5a8f02ec8679ab2d65316bf9d4
session_slug: wi02-implementation
supersedes: 2026-09-18-wi02-specification.md
---

# Session handoff: WI-0.2 implementation (runtime turn ceiling and stored-turn byte budget)

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-18 (Gauntlet Loop, `DIRECT_COORDINATOR / IMPLEMENTATION`, WI-0.2). Claude Opus 5 coordinated, inspected and proved. Codex `gpt-5.6-terra` (medium) wrote the code through `codex-build`. No subagents. |
| Feature folder | `docs/features/chat-history-integrity/` |
| Branch worked on | `fix/turn-ceiling-byte-budget`, in the standalone clone `_netzer-turn-ceiling` |
| Branch it merges into next | `development`, after WI-0.1 (PR #176) lands |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `d14a439` (the WI-0.2 specification docs, on the red `56e37b0`) |
| Commits made by this session | `3ae63b4`, the implementation (written by Codex, inspected and committed by Claude), and one docs commit: this file, `HANDOFF.md` and one README paragraph |
| Commit at session end | That docs commit: `git rev-parse fix/turn-ceiling-byte-budget` |
| Pushed | **No.** Nothing was pushed this session. |
| PR | None for WI-0.2. PR #176 (WI-0.1) is `OPEN`, not merged (`gh pr view 176`, this session). Merging is the owner's call. |
| Deployed | no |

## 2. Current state summary

- **WI-0.2 is implemented and committed locally at `3ae63b4`.** The proof passes on every line, twice (7.6). The full `npm test` gives 246 files and 3209 tests (7.7). That is the baseline plus the new file and 13 tests.
- **Codex used its whole budget: one build and one narrow correction.** Inspection rejected the build on two defects that every test and proof check had passed (4.3, M32, M33):
  - `raw?.trim()` threw on a non-string config value;
  - a `;` broke the Mermaid render of `request-lifecycle.md`.
  The correction fixed exactly those two lines.
- **Corrections A and B are both in.** A whitespace-only value gives 8192 (7.8). The trim cuts only at a user turn, has no keep-newest clamp, and `kept` may be empty (4.3).
- **Not run on this HEAD: the full step 7 list (AC-0.2-7).** It is due in VERIFICATION and before any push (6.2).
- **Five CLEANUP findings** (6.2) and **one question for the owner** (6.3): whether to pin the non-string case with a test. That test would change two frozen counts.
- `origin/development` is still `9e8e42b` and PR #176 is `OPEN`, so there was no rebase.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **`getConfig` does not check the stored value's type.** `src/lib/state/runtime-config-repo.ts:83-85` returns `item?.value` as `string | undefined` on the type alone. `getConfigCategory` checks `typeof item.value === 'string'` (`:115`). A row whose `value` was written as a DynamoDB Number therefore reaches callers as a JS number. Any caller that calls a string method on it can throw outside its own `.catch`.
- **Mermaid sequence-diagram message text cannot contain `;` or `#`.** A `;` ends the statement, so the rest of the line parses as a bare actor. The pinned renderer reports `Parse error … Expecting 'SOLID_OPEN_ARROW', … got 'NEWLINE'`. No sequence-diagram message under `docs/` used a `;` before this session. The proof's grep checks cannot see this; only a render can.
- **Docs CI renders every Mermaid block** (`node scripts/ci/docs-mermaid.mjs`, `.github/workflows/docs-ci.yml:70`, pinned `@mermaid-js/mermaid-cli@10.9.1`). It is not in `development.md` step 7's list. On this Mac the renderer and Puppeteer's Chrome are already in the npx cache (`~/.npm/_npx/e0b87bb3fb84adaa`), so one block renders offline with that cache's `mmdc`.
- **Codex's sandbox cannot run `wi-0.2-proof.sh` as written.** Its `git fetch` failed with `cannot open '.git/FETCH_HEAD': Operation not permitted`, so `.git` is read-only in the workspace-write sandbox as well as offline. It ran the script's steps directly, as the sandbox note allowed. Its full `npm test` also had one file fail for an environment reason: `src/lib/paperclip/client.mock-server.test.ts` could not bind `127.0.0.1` (`listen EPERM`).
- **Turn text reaching `turnBytes` is always a string.** `getSession` runs `repairEmptyTurns` (`sessions-repo.ts:232`), which replaces any non-string or empty `text` with a placeholder, so `Buffer.byteLength` cannot throw on a legacy numeric turn.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/agent/agent-loop.ts` | Turn loop; the three model calls | `resolveTurnMaxTokens()` and the five `maxTokens: turnMaxTokens` sites (AC-0.2-2); M32 |
| `src/lib/state/sessions-repo.ts` | Session item; `appendTurns` | `trimTurnsToBudget()` and its wiring (AC-0.2-3), Correction B |
| `src/lib/state/runtime-config-repo.ts` | `getConfig` | Returns the stored attribute with no type check (3.1) |
| `docs/diagrams/request-lifecycle.md`, `docs/diagrams/architecture-security.md` | Mapped diagrams | AC-0.2-4, the owner's line-51 decision, M33 |
| `~/.claude/plans/netzar-chat-plan/wi-0.2-codex-work-order.md` | The bounded work order, outside the checkout (P15) | Two corrections this session (4.3) |

### 3.3 Patterns and conventions to follow

- Guard a value read from DynamoDB with `typeof` before calling a string method on it, even when its declared type is `string`. `repairEmptyTurns` and `getConfigCategory` already do this (M32).
- Render a changed Mermaid block with the pinned renderer; a grep cannot see a parse error (P21).
- To test a function's committed text without touching the checkout, extract it from the file and run it with stubs in a scratch script (7.8). This extends the spec session's replica check (spec log, 3.3).

## 4. Work completed

### 4.1 Tasks finished

- [x] Step 0: read `development.md` in full and `docs/features/README.md`. Declared the governing sections and steps before the first command (P19 honored).
- [x] `git fetch origin`. PR #176 is `OPEN`; `origin/development` is still `9e8e42b`. So there was no rebase, and `WI02_BASE` keeps its default (`fix/backmerge-production-hotfixes`).
- [x] Red state re-confirmed at `d14a439` before delegating (7.1).
- [x] Codex build 1 (7.2). Inspection rejected it on two defects (7.3).
- [x] The one narrow correction (7.4). Re-inspected, and every scope and document constraint checked by content.
- [x] Committed `3ae63b4` locally (7.5). The proof passed twice and `npm test` passed (7.6, 7.7). Replica check of the resolver (7.8).
- [x] Promoted the byte budget into README section 2.3 (4.4). Wrote this log and `HANDOFF.md`, and ran the docs gates (7.9).
- [ ] CLEANUP and VERIFICATION, each in a fresh session.

### 4.2 Files modified

| File | Change | Author | Rationale |
|---|---|---|---|
| `src/agent/agent-loop.ts` | `TURN_MAX_TOKENS_FLOOR/CEILING`, exported `resolveTurnMaxTokens()`, one resolve in `runAdmittedTurn`, five `maxTokens: turnMaxTokens` | Codex (build and correction) | AC-0.2-2; Correction A; M32 |
| `src/lib/state/sessions-repo.ts` | `MAX_TURN_WINDOW_BYTES`, `turnBytes()`, exported `trimTurnsToBudget()`, `appendTurns` wiring, header | Codex (build) | AC-0.2-3; Correction B |
| `docs/diagrams/request-lifecycle.md` | Step text, a new ceiling note, line 51's last sentence | Codex (build and correction) | AC-0.2-4; owner decision; M33 |
| `docs/diagrams/architecture-security.md` | One output-ceiling note | Codex (build) | AC-0.2-4 |
| `docs/features/chat-history-integrity/README.md` | Sections 2.3, 2.4 and 4a (Codex); one byte-budget paragraph in 2.3 (Claude, docs commit) | Codex, Claude | AC-0.2-1b; 4.4 |
| This file, `HANDOFF.md` | Created, rewritten | Claude | Session log and current state |

No test file changed. No adapter, infra, package or lockfile changed.

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Correct the work order's BASELINE line to name `d14a439` as the branch head | Send it unchanged | It named `56e37b0` as the head. `d14a439` is docs-only (`git diff --stat 56e37b0 d14a439`: the spec log and `HANDOFF.md`), so the code baseline is the same. A wrong head invites a worker to check out a commit. |
| Add a sandbox note to the work order's PROOF: if `git fetch` is blocked, run the script's steps directly and do not edit the script | Leave Codex to find out | `wi-0.2-proof.sh` is the first proof in this campaign that runs `git fetch` (`wi-0.1-proof.sh` has none). `~/.codex/config.toml` sets no `network_access`, so the workspace-write sandbox is offline, and the fetch would fail with exit 8 before any check ran. The host reruns the full script anyway. |
| Reject Codex build 1 on two defects, and send the one narrow correction the budget allows | Opus writes the two fixes; accept and defer to CLEANUP | (1) `const trimmed = raw?.trim()` throws on a non-string value (3.1), which breaks the function's own "never throws" contract and the work order's "every other behavior matches the parked code". The parked `Number(raw)` never threw. The frozen tests cannot see it, because every test value is a string, `undefined` or a rejection. (2) The new `request-lifecycle.md` step text contained a `;`, and the pinned renderer failed on it (7.3). Both fixes are concrete and one line each. A Codex correction keeps authorship single, and the policy allows one. CLEANUP-grade wording nits were kept out of it (6.2). |
| No new test pins the non-string config value | Add one now | The tests are frozen for this phase. AC-0.2-2 counts 7 ceiling tests and AC-0.2-7 counts 3209, so a new test is a SPECIFICATION change. Reported in 6.3 for the owner and VERIFICATION. |
| Promote the byte budget into README section 2.3 in the docs commit | Leave it to CLEANUP | The spec log's 4.4 planned this promotion for IMPLEMENTATION, but the work order asked Codex only for the ceiling text, so the README said nothing about the budget. Closing a session owes the promotion (framework section 6a). |
| Leave the README's `observed_at`/`as_of_commit` (2026-08-24, `f64d1e0`) unchanged | Bump them to this session | Bumping re-asserts every README claim at `3ae63b4`, and this session re-verified only sections 2.3, 2.4 and 4a. Classified for CLEANUP (6.2, item 5). |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The trim cuts only at a user turn; the enforced bound replaces "re-measure" (planned by the spec log's 4.4) | The `sessions-repo.ts` header and both diagrams (`3ae63b4`); README section 2.3 (docs commit) | Yes |
| The ceiling is runtime-tunable, resolved once per turn, clamped 1024-32768 | README sections 2.3 and 4a, both diagrams (`3ae63b4`) | Yes |
| `getConfig` returns the stored attribute unchecked | The comment at `resolveTurnMaxTokens`'s `typeof` guard (`3ae63b4`) | Yes |
| Docs CI renders Mermaid; `;` and `#` are syntax in sequence messages | This log (P21, M33). It is Docs CI behavior, not feature behavior. | Log only |

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

## 6. Pending work

### 6.1 Smallest next action

WI-0.2 CLEANUP in a fresh session. Claude (Codex is off for cleanup) applies `/refactor` to the lines this work item touched, addresses the five findings below, reruns `wi-0.2-proof.sh`, and renders any Mermaid block it touches (P21).

### 6.2 Immediate next steps

1. **CLEANUP findings.** All five are phase-scoped comment or doc precision; none changes behavior.
   1. `src/agent/agent-loop.ts:81-84`: the clamp's doc comment says session items "grow toward DynamoDB's 400KB limit even with the byte-budget trim". After Correction B the trim holds the window at or under 300,000 bytes whatever the ceiling, as the `sessions-repo.ts` header now says. The parked comment is stale and contradicts that header.
   2. `src/lib/state/sessions-repo.ts:57-64`, the `trimTurnsToBudget` doc comment:
      - "later Converse calls require strict alternation" blurs the reason. A window that starts with a reply makes *every later request* start with the assistant's message.
      - It lacks the pointer the work order asked for: the strict-alternation note, `agent-loop.ts:1316-1321` at `3ae63b4` (`:1281-1286` at `9f1cd58`).
   3. `src/lib/state/sessions-repo.ts:289-292`: `appendTurns` lost the parked comment explaining why `byteEvicted` joins `evicted`. Without it, the `decideIngest` evict backstop is easy to break.
   4. README section 2.3 (line 80): "all three model calls — the initial streamed call and each tool-loop round" names two of the three and omits the post-loop synthesis call.
   5. README frontmatter:
      - `observed_at: 2026-08-24` and `as_of_commit: f64d1e0` now sit under sections that describe WI-0.2 code.
      - `tested_by` omits `src/agent/agent-loop.max-tokens.test.ts` and `src/lib/state/sessions-repo.byte-budget.test.ts`.
      - Bumping the stamp means re-checking every README claim at the new commit first.
2. **VERIFICATION**, in a fresh session:
   - Rerun the proof, then the full step 7 list: `wi-0.2-full-validation.sh`, after `npm --prefix web ci`.
   - Render both mapped diagrams.
   - Judge the owner's answer on 6.3.
3. After the owner merges PR #176, check `origin/development` against README section 4a by content. If `development` moved past `9f1cd58`'s tree, rebase this branch onto it and rerun the proof with `WI02_BASE=development`.

### 6.3 Blockers and open questions

- [ ] **Merge PR #176.** It is the owner's call, and CI is 9/9 green. WI-0.2 cannot land before it.
- [ ] **Pin the non-string config value with a test? Owner's call.**
  - *Discovered:* no test covers it. Every value the tests give `getConfig` is a string, `undefined` or a rejection (`agent-loop.max-tokens.test.ts:87-173`). On those inputs, build 1's `raw?.trim()` and the `typeof` guard return the same results (7.8), so no test can tell them apart. This was observed by reading the test file, not by a mutation run.
  - *Why it matters:* the regression means every turn fails, and a builder has already produced it once.
  - *Options:* (a) keep the comment and this log as the only guard; (b) a SPECIFICATION amendment that adds one ceiling test, making AC-0.2-2 "8 ceiling tests" and AC-0.2-7 "3210 tests".
  - *Recommendation:* (b). The mistake has already happened once (M32).
  - *What changes:* two frozen counts, and one test file.
- [ ] **Non-streaming tool rounds above 8192 output tokens.** Whether they finish is Unknown. Exercise one long tool round before raising `agent/max_output_tokens` in production. The default stays 8192.
- [ ] **Proposed P4 item: an incremental document tool for documents of unbounded size.** Offered to the owner, not approved. Outside WI-0.2.
- [ ] `web/node_modules` is missing in this clone. Run `npm --prefix web ci` before the step 7 list.

### 6.4 Deferred, and why

- The full step 7 list: `development.md` step 7 runs it before a push, and AC-0.2-7 assigns it to VERIFICATION and the pre-push check. This session pushes nothing.
- The CLEANUP findings: the correction round was kept to the two defects (4.3).

## 7. Verification actually performed

Every command in this section ran with AWS credential sources stripped. Exit codes were captured unpiped (M13). Codex's own reports are listed as claims, not evidence.

### 7.1 Red state at `d14a439`, before delegating

`wi-0.2-proof.sh` exited 1, the same as spec log 7.6: `tests` FAIL, 13 failed and 58 passed (71); `typecheck` FAIL; AC-0.2-1a PASS; 1b, 2 and 3 FAIL; 4-drift PASS; 4-content FAIL; 5, 6 and diff-check PASS; the tree clean. The reasons in the logs: 6× `resolveTurnMaxTokens is not a function`, 5× `trimTurnsToBudget is not a function`, 1× `expected 8192 to be 16384`, 1× `expected 450271 to be less than 409600` (vitest prints each twice), and 2× TS2305.

### 7.2 Codex build 1

- The runner ran with `build --host claude --builder codex --unreviewed-spec --model gpt-5.6-terra --effort medium`. `result.json` gives `status: completed`, base `d14a439`, 251 s, and `codex-cli 0.154.0`.
- The event stream holds 0 `mcp_tool_call` items (P16).
- **Claims, not evidence:** the proof's steps run directly all passed; its full `npm test` gave 245 passed and 1 failed (the `listen EPERM` file), 3204 passed and 5 skipped.

### 7.3 Inspection of build 1 (host)

- `git status`: 5 modified files, all in scope. 0 untracked, 0 staged. The three frozen test files are unchanged. `wip/docgen-crash-turn-ceiling` is still at `3706dd2`.
- The source diff matches the parked `ef0768f` (`git diff 3bffea6 ef0768f`) plus both corrections, with one exception: the `raw?.trim()` line (M32). The `appendTurns` wiring matches, apart from a dropped comment (6.2, item 3).
- **Render** of the extracted `request-lifecycle.md` block with `~/.npm/_npx/e0b87bb3fb84adaa/node_modules/.bin/mmdc` (10.9.1): the pre-build block exits 0; build 1's block exits 1 with `Parse error on line 36 … got 'NEWLINE'` (M33).
- `getConfig`: `runtime-config-repo.ts:83-85` against `:115` (3.1).

### 7.4 The correction round, and re-inspection

- The runner resumed build 1's result with the feedback file `codex-correction-1.md` and the same model and effort: `status: completed`, 36 s, 0 `mcp_tool_call` items.
- Codex changed exactly the two lines: the `typeof` guard with its comment, and the diagram step, which now reads "…version-fenced (skipped when blocked), MAX_TURN_WINDOW_BYTES drops oldest exchanges at a user-turn boundary and sends them to ingest".
- **Renders:** `request-lifecycle.md` exits 0 (a 36,436-byte SVG); `architecture-security.md` exits 0.
- **Checked by content:**
  - Line 1 of `request-lifecycle.md` is byte-identical (496 bytes).
  - In line 51, the 1,302-byte prefix before "The tool loop's output ceiling is" is identical. The new last sentence is "Every model call in the turn carries the ceiling resolved per turn (default `TURN_MAX_TOKENS` 8192, runtime-tunable) rather than the 1024 that could not hold a document spec."
  - Every line after it is present verbatim.
  - README 4a's dated closing paragraph is unchanged (204 bytes), and 4a contains the literal `maxTokens: turnMaxTokens`.

### 7.5 Commit

`3ae63b454381db5a8f02ec8679ab2d65316bf9d4`. Author and committer are both Emmanuel Adams `<emmanuelmadams4@gmail.com>`. It holds exactly the 5 inspected files (111 insertions, 16 deletions). The tree was clean afterwards.

### 7.6 `wi-0.2-proof.sh` at `3ae63b4`, twice

Both runs exited 0. `tests` gave 6 files and 71 passed. `typecheck`, AC-0.2-1a, 1b, 2, 3, 4-drift, 4-content, 5, 6 and diff-check all PASS. The two runs' PASS/FAIL lines are identical, and `status: 0 changed paths` after each. The drift log reads "8 mapped diagrams, all paths valid" and "no drift across 10 changed file(s)": the 3 test files, 2 spec docs and 5 implementation files since the base.

### 7.7 Full `npm test` at `3ae63b4`

Exit 0. 246 files passed (246), 3209 tests passed (3209), in 18.99 s. That is the 9f1cd58 baseline (245/3196) plus `sessions-repo.byte-budget.test.ts` and 13 tests. The tree was clean afterwards.

### 7.8 Replica check of `resolveTurnMaxTokens` (scratchpad script, not the checkout)

The function's committed text and its three constants were extracted from `src/agent/agent-loop.ts` and run with a stubbed `getConfig`. The same text was run a second time with build 1's `const trimmed = raw?.trim();` substituted.

| `getConfig` gives | `3ae63b4` | build 1 |
|---|---|---|
| number `16384` | 16384 | throws `TypeError` |
| number `0` | 8192 | throws `TypeError` |
| number `99999` | 32768 | throws `TypeError` |
| `'  '` | 8192 | 8192 |
| `' 16384 '` | 16384 | 16384 |
| `'abc'` | 8192 | 8192 |
| `undefined` | 8192 | 8192 |
| rejects | 8192 | 8192 |

### 7.9 The docs commit

These ran on the final text of this file, `HANDOFF.md` and the README paragraph, before the docs commit:

- `node scripts/ci/feature-knowledge.mjs`: exit 0, `feature-knowledge: OK`.
- `node scripts/ci/docs-links.mjs`: exit 0, "185 markdown files · 2674 internal links checked", `docs-links: OK`.
- `git diff --check`, with this new file included through `git add -N`: exit 0.

The proof's rerun at the docs commit is recorded in the Gauntlet state file, because this file is part of that commit.

### 7.10 Not run, and why

- The full step 7 list (AC-0.2-7): `build`, the web typecheck and web build (`web/node_modules` is missing here), and `local:test:integration`. It is due in VERIFICATION and before any push (6.4). `typecheck` and `npm test` from that list did run (7.6, 7.7).
- `node scripts/ci/docs-mermaid.mjs` over every block: only the two mapped diagrams this work item touched were rendered (7.3, 7.4).

## 8. Environment state

- macOS. Node 24. Codex CLI 0.154.0, logged in with ChatGPT. The `mmdc` 10.9.1 renderer is in the npx cache.
- `_netzer-turn-ceiling`: branch `fix/turn-ceiling-byte-budget`, clean after the docs commit, local only. `wip/docgen-crash-turn-ceiling` is untouched (`3706dd2`).
- `_netzer-backmerge` and `_netzer-devmd-amend`: not touched.
- Outside the repo: the work order (corrected, 4.3), both Codex run directories and the proof logs are in this session's scratchpad.

## 9. Related documents

- [HANDOFF](../HANDOFF.md) and [README](../README.md), sections 2.3, 2.4 and 4a
- [2026-09-18 WI-0.2 specification log](2026-09-18-wi02-specification.md), the ledger's source and the red state
- [2026-09-17 docgen-crash-wip-transfer](2026-09-17-docgen-crash-wip-transfer.md), the parked work
- Outside the repo, in `~/.claude/plans/netzar-chat-plan/`: `wi-0.2-codex-work-order.md`, `wi-0.2-proof.sh`, `wi-0.2-full-validation.sh`, and the plan (section 10, P0 step 2)
