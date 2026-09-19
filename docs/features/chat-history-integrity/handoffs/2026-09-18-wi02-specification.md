---
feature: chat-history-integrity
document_role: session-handoff
status: current
observed_at: 2026-09-18
as_of_commit: 56e37b05c655dcdc364086f9310b5c3e3d3b1dff
session_slug: wi02-specification
supersedes: 2026-09-18-wi01-verification.md
---

# Session handoff: WI-0.2 specification (runtime turn ceiling and stored-turn byte budget)

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-18 (Gauntlet Loop, `DIRECT_COORDINATOR / SPECIFICATION`, WI-0.2). Claude Opus 5 coordinated. No Codex and no subagents. |
| Feature folder | `docs/features/chat-history-integrity/` |
| Branch worked on | `fix/turn-ceiling-byte-budget`, new, created at `9f1cd58`. The parked `wip/docgen-crash-turn-ceiling` (`ef0768f` code, `3706dd2` docs) stays untouched as the source. |
| Branch it merges into next | `development`, after WI-0.1 (PR #176) lands |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `9f1cd58` (the verified back-merge) |
| Commits made by this session | `56e37b0`, the red state (tests only), and one docs commit: this file and `HANDOFF.md` |
| Commit at session end | That docs commit: `git rev-parse fix/turn-ceiling-byte-budget` |
| Pushed | This branch: **no**. On the owner's authorization, this session force-pushed `fix/backmerge-production-hotfixes` (`9e832da...9f1cd58`, with lease) and opened [PR #176](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/176) into `development`. |
| PR | #176 (WI-0.1): 9/9 checks green, `MERGEABLE`/`CLEAN`, not merged. Merging is the owner's call. |
| Deployed | no |
| Clone | `/Users/emmanueladams/Documents/Netzar OS/_netzer-turn-ceiling`. It is a **standalone clone with its own `.git`, not a linked worktree** (the handoff called it one). |

## 2. Current state summary

- **G0 failed, and the owner resolved it.** `origin/development` is still `9e8e42b`. README section 4a's checks fail there (C1-C4; only C5 passes) and pass on `origin/production`, the positive control (7.1).
- **Owner decisions, 2026-09-18, this session:**
  - Q1: the nine picks keep their original author, `e.adams@personalgrowthcs.com`, with `emmanuelmadams4@gmail.com` as committer.
  - Q2: push, open the PR, and stack WI-0.2 now on `9f1cd58`. Merging stays the owner's call. Once it lands, confirm the base by content.
  - Line 51: fix the last sentence of `request-lifecycle.md` line 51 inside WI-0.2's PR. This is phase-scoped.
- **WI-0.1 is pushed and has a PR.** The full `development.md` step 7 list on `9f1cd58` equals the baseline (7.2). Then this session ran `git push --force-with-lease=fix/backmerge-production-hotfixes:9e832da` and opened PR #176. CI is 9/9 green. **The PR is not merged.**
- **WI-0.2 red state is `56e37b0`, tests only.** 13 tests fail for the intended reasons, and the 16 pre-existing tests in those files pass. Typecheck fails only on the two missing exports (7.5).
- **The spec corrects the parked design in one place.** The byte trim cuts only at a user turn and never stores turns over budget (4.3). The parked code could leave an assistant turn first in the window, which is a new path to permanent chat poisoning (M29).
- The proof is `~/.claude/plans/netzar-chat-plan/wi-0.2-proof.sh`: AC-0.2-1..6 as executable checks, with negative controls on the checks that only prove absence (7.6). AC-0.2-7 is `wi-0.2-full-validation.sh`.
- The owner asked whether documents can be unlimited in size. **Answered, no decision taken.**
  - A higher ceiling still caps a document at one model call's output.
  - Unbounded size needs an incremental tool: section-by-section appends, the draft in S3, and one build at the end. README section 2.3 already says so.
  - No approved work item covers it. Plan line 190 freezes `generate_document` until deliverables-parity E1.
  - It was offered as a proposed P4 item, for the owner to approve. It is outside WI-0.2.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **The seam at `9f1cd58` matches `fdda55c`'s lines.**
  - `TURN_MAX_TOKENS` is defined at `src/agent/agent-loop.ts:79` and used at `:1021`, `:1169-1170` and `:1307-1308`.
  - `runAgentTurn` (`:641`) calls `runAdmittedTurn` (`:759`) at `:667`.
  - `getConfig` is already imported (`:36`), and `TOOL_TURN_LIMIT = 8` (`:59`).
- **Nothing guards against an assistant turn first in the history.**
  - `turnsToMessages` (`:519-524`) maps stored turns to Converse messages one for one.
  - `src/lib/bedrock/client.ts:229-230` appends the new user message after them.
  - The repo records that Converse enforces strict alternation (`agent-loop.ts:1281-1286`, where an adjacent user turn threw `ValidationException`). The same rule is also given in `sessions-repo.ts:104-106`.
- **`appendTurns` (`src/lib/state/sessions-repo.ts:215-324`)**
  - Its `PutCommand` replaces the whole item.
  - The count trim is at `:237-238`. The "ingest before evicting" backstop is `decideIngest` (`:77-87`), so byte-evicted turns must be counted in `evicted`.
  - It has 7 call sites: dashboard (`handler.ts:2002`, `:2282`), Slack (`:550`, `:817`), Telegram (`:561`), `agent/scheduler.ts:183` and `lib/scheduler/queue-drain.ts:176`. The trim therefore covers every surface from one place.
- **Item size.**
  - Each stored turn is a map of `{role, text, ts, surface?}`. Its non-text overhead is about 49 bytes (Inferred from DynamoDB's sizing rules), inside the parked flat 64.
  - The item's other attributes are small scalars; `firstMessage` is at most 120 characters.
  - So a window of at most 300,000 bytes keeps the item under 400KB with roughly 100KB of headroom.
- **Mapped diagrams (`docs/diagrams.map`).** `architecture-security.md` maps `agent-loop.ts`. `request-lifecycle.md` maps `agent-loop.ts` and `sessions-repo.ts`.
- **The knob is admin-gated.** Every non-GET `/config` write needs `admin` (`src/adapters/dashboard/handler.ts:242`).
- **Models.** The production model ids are Sonnet 4.5/4.6, Haiku 4.5 and Opus 4.7, plus their `-1m` variants. `claude-3-5-haiku`, whose output tops out at 8192, appears only in test fixtures.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/agent/agent-loop.ts` | Turn loop; the three model calls | AC-0.2-2 (five `maxTokens` sites, one resolve) |
| `src/lib/state/sessions-repo.ts` | Session item; `appendTurns` | AC-0.2-3, the byte-budget judgment |
| `src/agent/agent-loop.max-tokens.test.ts` | Ceiling tests | `getConfig` hoisted; 6 resolver tests plus 1 initial-call test |
| `src/lib/state/sessions-repo.persistence.test.ts` | Trim unit tests | 5 tests with alternating-role fixtures |
| `src/lib/state/sessions-repo.byte-budget.test.ts` | New: `appendTurns` with DynamoDB mocked | Proves the trim is wired at the storage seam |

### 3.3 Patterns and conventions to follow

- A check that proves absence ("no adapter changed", "nothing outside scope") gets a negative control before its PASS is trusted (P18).
- Check that test expectations can be met with a throwaway replica in the scratchpad, never in the checkout (7.7).
- Transcript fixtures alternate roles. All-assistant fixtures cannot see an alternation bug (M29).

## 4. Work completed

### 4.1 Tasks finished

- [x] G0 by content, with a positive control. Owner Q1 and Q2.
- [x] Step 0: read `development.md`, sections *Feature work*, *How to develop a new feature, end to end*, *Automated tests*, *AWS safety*, *Known local limitations* and *Branch to environment mapping*.
- [x] WI-0.1 landing: the full step 7 list on `9f1cd58`, the force-push with lease, PR #176 (CI 9/9 green).
- [x] Baseline on the rebase base, in both clones (7.2, 7.3).
- [x] Seam pinned (3.1). AC-0.2-1..7 frozen.
- [x] Red state `56e37b0`, the proof script and its negative controls, and a replica check of the new expectations.
- [x] Owner decision on line 51. `CODEX_ELIGIBILITY` classified, and the Codex work order written.
- [x] This log and `HANDOFF.md`, in one local docs commit.
- [ ] Merge PR #176. That is the owner's call.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `src/agent/agent-loop.max-tokens.test.ts` | `getConfig` hoisted; resolver block plus initial-call test | Red for AC-0.2-2 |
| `src/lib/state/sessions-repo.persistence.test.ts` | `trimTurnsToBudget` block (5 tests) | Red for AC-0.2-3 |
| `src/lib/state/sessions-repo.byte-budget.test.ts` | Created | Red for AC-0.2-3 at the storage seam |
| This file, `HANDOFF.md` | Created, rewritten | Session log and current state |

No source file changed.

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| **The byte trim cuts only at a user turn and never stores turns over budget.** `kept` may be empty. | The parked rule: cut anywhere, and always keep the newest turn | The parked rule can leave an assistant turn first in the window. That happens when the cut lands on a large user turn, or when "keep the newest" keeps only the reply. Every later request would then start with an assistant message (M29). The parked reason, "an empty window would break role alternation", is wrong: an empty history plus the new user message is valid. A user turn's size is not bounded by the output ceiling, so "keep it anyway" can still write an item over 400KB. Dropped turns still reach ingest through `evicted`. |
| A whitespace-only config value falls back to 8192 | Accept the parked code's 1024 | This keeps the parked test's intent. `Number('  ')` is `0`, and `0` is finite, so the resolver must trim first. |
| New branch `fix/turn-ceiling-byte-budget` at `9f1cd58` | Rebase `wip/docgen-crash-turn-ceiling` | SPECIFICATION ports tests only, and the source transplant is IMPLEMENTATION's job. The parked branch stays the untouched source. It is also the backup on origin (`3706dd2`). |
| "All three model calls" is proven by AC-0.2-2 plus one initial-call test | A test that drives the tool loop and the synthesis call | The grep is exact: five `maxTokens: turnMaxTokens`, zero of the constant, one resolve inside `runAdmittedTurn` before the first use. Driving `TOOL_TURN_LIMIT` rounds through mocks costs far more and proves nothing extra. |
| README 4a's `maxTokens` bullet is amended in WI-0.2's PR to accept either form | Leave 4a alone | Once WI-0.2 lands, the literal `maxTokens: TURN_MAX_TOKENS` count becomes 0 and 4a would report the fix missing. `development.md` step 6: the code wins, so correct the document. Phase-scoped. |
| Line 51's last sentence is fixed in WI-0.2 | Keep production's bytes as technical debt | Owner decision. WI-0.2 changes the very ceiling that sentence describes, and the same PR has to update this mapped diagram anyway. |
| Baseline taken from the step 7 run on `9f1cd58` (`_netzer-backmerge`) plus `typecheck` and `npm test` in this clone | Run everything twice | It is the same tree. The second run proves this clone's `node_modules` agree. `web/node_modules` is missing here (6.3). |
| `graft` not built for this clone | `graft build` | It writes an untracked `graft/` into the checkout, and that path is not gitignored. `git grep` gives exact occurrences of these literal identifiers. |
| G0's read-only checks ran before the Step-0 declaration | Declare first | The handoff numbered G0 before Step 0. Nothing was edited before the declaration. One-time; P19 fixes the next handoff. |
| `CODEX_ELIGIBILITY: YES`, `IMPLEMENTATION_PROVIDER: CODEX` (gpt-5.6-terra medium) | Claude Opus | The behavior is frozen by 13 red tests and an executable proof. The change is a transplant of two parked helpers, with two specified corrections, into two known files. The docs are specified line by line. The architecture is settled. |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The trim cuts only at a user turn; the enforced bound replaces "re-measure" | README sections 2.3, 2.4 and 4a, the `sessions-repo.ts` header, and both diagrams, in IMPLEMENTATION (work order) | Pending |
| WI-0.1 pushed, PR #176 green, WI-0.2 red at `56e37b0` | `HANDOFF.md` | Yes |

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

## 6. Pending work

### 6.1 Smallest next action

WI-0.2 IMPLEMENTATION: Codex `gpt-5.6-terra` (medium) carries out `~/.claude/plans/netzar-chat-plan/wi-0.2-codex-work-order.md`, with at most one build attempt and one narrow correction. Claude Opus then inspects the diff and untracked files, commits locally, and reruns `wi-0.2-proof.sh` until every line passes.

### 6.2 Immediate next steps

1. IMPLEMENTATION (above), then CLEANUP, then VERIFICATION, each in a fresh session.
2. After the owner merges PR #176, check `origin/development` against README 4a by content. If `development` moved past `9f1cd58`'s tree, rebase this branch onto it and rerun the proof with `WI02_BASE=development`.
3. Before WI-0.2's push, run the full step 7 list (`wi-0.2-full-validation.sh`), after `npm --prefix web ci` in this clone.

### 6.3 Blockers and open questions

- [ ] **Merge PR #176.** It is the owner's call, and CI is 9/9 green. WI-0.2 cannot land before it.
- [ ] **Non-streaming tool rounds above 8192 output tokens.** Whether they finish is Unknown. The tool-loop rounds are `ConverseCommand` calls with no client timeout set in `client.ts`. The default stays 8192, so nothing changes until an admin raises `agent/max_output_tokens`. Exercise one long tool round before raising it in production.
- [ ] **Proposed P4 item: an incremental document tool for documents of unbounded size.** Offered to the owner, not approved. Outside WI-0.2.
- [ ] `web/node_modules` is missing in this clone (traps).

### 6.4 Deferred, and why

- Measuring builder memory at the 32,768 maximum: `MAX_TOTAL_CELLS` bounds builds regardless of spec size, and README section 2.4 will say the larger spec size is unmeasured.
- Any per-agent ceiling: the parked design is global on purpose, so agents created later inherit it.

## 7. Verification actually performed

Every command in this section ran with AWS credential sources stripped. Exit codes were not piped (M13).

### 7.1 G0: README section 4a by content, braced refs, extract line counts

| Check | `origin/development` `9e8e42b` | `origin/production` `de244e6` (control) | `9f1cd58` |
|---|---|---|---|
| C1 `git grep TOOL_LOOP_MAX_TOKENS -- src infra` | exit 0 (**fail**) | exit 1 | exit 1 |
| C2 `maxTokens: TURN_MAX_TOKENS` ×5 | 0 (1416 lines) **fail** | 5 | 5 (1427 lines) |
| C3 Haiku id | 0 (461 lines) **fail** | 1 | 1 |
| C4 `assertPdfRenderable` + `toPdfSafeText` exported | 0 + 0 (84 lines) **fail** | 1 + 1 | 2 |
| C5 one `function repairEmptyTurns` | 1 | 1 | 1 |
| `agent-loop.max-tokens.test.ts` exists | **no** | yes | yes; passes in `npm test` |

### 7.2 Full step 7 list on `9f1cd58` (`wi-0.1-full-validation.sh`, `_netzer-backmerge`, 2026-09-19T02:51Z)

typecheck 0, `npm test` 0 (245 files, 3196 tests), build 0, web typecheck 0, web build 0, `local:verify` 0 ("talking to a local emulator"), integration **1**: `scripts/destroy.integration.test.ts` `checkSecrets`, the Floci gap (38 passed, 25 skipped), docs-links 0, feature-knowledge 0, diff-check 0, docs-assets 0, and diagrams-drift (PR context) 0. The tree was clean afterwards. Each fast step's log tail was read to confirm it really ran.

### 7.3 Baseline in this clone at `9f1cd58`

`npm run typecheck` exit 0. `npm test` exit 0: 245 files and 3196 tests pass.

### 7.4 Push and PR

- `git push --force-with-lease=fix/backmerge-production-hotfixes:9e832da origin fix/backmerge-production-hotfixes`: `+ 9e832da...9f1cd58 (forced update)`.
- PR #176 into `development`: 9 checks passing, 0 failing, `MERGEABLE`/`CLEAN`.

### 7.5 Red state at `56e37b0`

- `npx vitest run` on the three WI-0.2 test files: 13 failed and 16 passed. The failures are 6 × `resolveTurnMaxTokens is not a function`, 5 × `trimTurnsToBudget is not a function`, `expected 8192 to be 16384`, and `expected 450271 to be less than 409600`.
- `tsc --noEmit`: exactly two TS2305 errors, the missing exports. Two TS7006 errors that cascaded from them were removed by typing the lambda.
- `git diff --check` is clean.

### 7.6 `wi-0.2-proof.sh` at `56e37b0`

- `tests` FAIL: 13 failed and 58 passed of 71. The 58 are WI-0.1's proof, intact.
- `typecheck` FAIL.
- AC-0.2-1a PASS, 1b FAIL, 2 FAIL, 3 FAIL.
- 4-drift PASS (no source change yet), 4-content FAIL.
- 5 PASS, 6 PASS, diff-check PASS.

Negative control: an untracked `src/adapters/zz-negative-control.ts` made AC-0.2-5 and AC-0.2-6 **FAIL**. Once it was removed, both passed and the tree was clean.

### 7.7 Replica check of the new expectations (scratchpad, not the checkout)

The parked trim with the user-boundary rule was run on each new test's inputs. Results:

| Case | Result |
|---|---|
| fits | 2 kept, 0 dropped |
| oldest | kept `cc`, and kept + dropped rebuilds the input |
| boundary | user-first, `cc` |
| huge newest exchange | 0 kept, all dropped |
| `€` window | 258,656 bytes, user-first, 4 kept |
| `appendTurns` scenario | 8 kept, user-first, newest exchange `gg`, JSON about 257KB |

The resolver with trimming gives 8192, 16384, 32768, 1024, and 8192 for each of the four junk values.

## 8. Environment state

- macOS. Node 24. Floci `netzer-os-floci` has been up and healthy for 5 weeks on `127.0.0.1:4566`.
- `_netzer-turn-ceiling`: branch `fix/turn-ceiling-byte-budget`, clean after the docs commit. `wip/docgen-crash-turn-ceiling` is untouched.
- `_netzer-backmerge`: `fix/backmerge-production-hotfixes` at `9f1cd58`, equal to origin, clean.
- `_netzer-devmd-amend`: not touched.

## 9. Related documents

- [HANDOFF](../HANDOFF.md) and [README](../README.md), section 4a
- [2026-09-18 WI-0.1 verification log](2026-09-18-wi01-verification.md), the ledger's source
- [2026-09-17 docgen-crash-wip-transfer](2026-09-17-docgen-crash-wip-transfer.md), the parked work and its two known test defects
- Outside the repo, in `~/.claude/plans/netzar-chat-plan/`: `wi-0.2-codex-work-order.md`, `wi-0.2-proof.sh`, `wi-0.2-full-validation.sh`, and the plan (section 10, P0 step 2)
