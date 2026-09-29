---
feature: chat-history-integrity
document_role: session-handoff
status: current
observed_at: 2026-09-19
as_of_commit: 974399bcadb9c7845df5f7755b343a1790f02d13
session_slug: wi02-verification
supersedes: 2026-09-19-wi02-cleanup.md
---

# Session handoff: WI-0.2 verification (a fresh critic: FAIL on one criterion, the README stamp)

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-19 (Gauntlet Loop, `DIRECT_COORDINATOR / VERIFICATION`, WI-0.2). Claude Opus 5 acted as a fresh critic: it ran every check and changed nothing under test. No Codex (`CODEX_REVIEW: OFF`, and WI-0.2's Codex budget is spent). No subagents. |
| Feature folder | `docs/features/chat-history-integrity/` |
| Branch worked on | `chore/wi02-cleanup`, in the standalone clone `_netzer-turn-ceiling` |
| Branch it merges into next | `development`. The push and the PR each need their own explicit authorization. |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `974399b` (the cleanup `d1876b1` plus its docs commit), on `origin/development` at `b152b7a` |
| Commits made by this session | One docs commit: this file and `HANDOFF.md`. No source, test, diagram or README change. |
| Commit at session end | That docs commit: `git rev-parse chore/wi02-cleanup` |
| Pushed | **No.** Nothing was pushed this session. |
| PR | None. |
| Deployed | no |

## 2. Current state summary

- **WI-0.2 VERIFICATION: FAIL, on one criterion (4.3).** Moving the README stamp to `d1876b1` certifies section 2.1's list of consumers that "read through `getSession`". The code contradicts one of them: Jarvis replays its own durable turns through `jarvis-memory-repo.loadRecent` and never calls `getSession` (3.1). This routes to a fresh **CLEANUP** (wrong cleanup text), not to IMPLEMENTATION: it is a doc defect, with no code defect and no runtime risk.
- **Everything else passes at `974399b`:**
  - AC-0.2-1..6: the proof, every line PASS, exit 0, 0 changed paths (7.1).
  - AC-0.2-7: the full step 7 list equals the baseline (7.2).
  - Both mapped diagrams render with the pinned renderer (7.3).
  - The cleanup changes no behavior and no test (7.4), and fixes 1, 2, 3, 4, 6 and 7 are true against the code.
  - Fix 5's `tested_by` and its dates are true.
  - The whole WI-0.2 delta stays in scope, parity included (7.7).
- **Open for the owner:** the non-string config test (unchanged). Push and PR authorization only after the CLEANUP rerun, a fresh VERIFICATION PASS, and the step 7 list on that exact HEAD.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **Jarvis is not a `getSession` consumer.**
  - `src/adapters/dashboard/jarvis.ts` imports `loadRecent as loadJarvisMemory` from `src/lib/state/jarvis-memory-repo.ts` (lines 87-90) and replays those turns at `:658` (the text-session seed) and `:2355` (the voice recap).
  - Neither `jarvis.ts` nor `src/lib/jarvis/` imports `sessions-repo`, so `repairEmptyTurns` never sees a Jarvis turn.
  - Jarvis is safe anyway. `jarvis-memory-repo.ts` `appendTurn` trims the text and returns without writing when it is empty, so an empty Jarvis turn is never stored. `buildSeedMessages` (`jarvis.ts:1450`) repairs alternation but has no empty-text filter of its own.
  - Both facts were already true at `f64d1e0`, the README's previous stamp.
- **The dashboard TLDR bar replays no turns.** `web/src/components/TldrBar.tsx` posts `{ tab, data }`, the tab's client-side data, to `/api/tldr`. `src/adapters/dashboard/tldr.ts` summarizes that in one prompt and never reads the sessions table. So "the dashboard TLDR path reads through `getSession`" is at best indirect: the tab's data may come from a `getSession`-backed route.
- **The dashboard's direct reads of the sessions table build no Bedrock messages.** `handler.ts:2049`, `:2065` and `:3644` are list and export queries that use a `ProjectionExpression`.
- **Why a stored window never starts with a reply.**
  - All seven `appendTurns` callers write a `[user, assistant]` pair: `dashboard/handler.ts:2002` and `:2282`, `slack/handler.ts:550` and `:817`, `telegram/handler.ts:561`, `agent/scheduler.ts:183` and `lib/scheduler/queue-drain.ts:176`.
  - `MAX_TURNS` is 20, an even number, so count eviction keeps a user turn first. The byte trim cuts at a user turn.
  - README 2.3's "a stored history never starts with a reply" therefore holds for turns the current code writes. Inferred from those facts.
- **`resolveTurnMaxTokens` cannot throw on a non-string stored value** (`agent-loop.ts:100-107`).
  - The chain is a `typeof` guard, then `Number()`, then a `Number.isFinite` fallback to 8192, then the 1024-32768 clamp.
  - So a stored number such as `16384` gives 16384, and an object gives 8192.
  - This comes from reading the code, not from executing it. It is the case the owner's pinning-test question is about.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `docs/features/chat-history-integrity/README.md` | The feature index, stamped at `d1876b1` | Fix 5, and the one FAIL (4.3) |
| `src/adapters/dashboard/jarvis.ts`, `src/lib/state/jarvis-memory-repo.ts` | Jarvis's own turn store and its replay path | Contradict README 2.1's consumer list |
| `src/agent/agent-loop.ts`, `src/lib/state/sessions-repo.ts` | The ceiling, the trim and the ingest backstop | Fixes 1-3, the behavior-equivalence check (7.4) and the mutation check (7.6) |
| `src/adapters/dashboard/handler.ts:232-242` | Role rules for `/config` | Fix 6 |
| `~/.claude/plans/netzar-chat-plan/wi-0.2-proof.sh`, `wi-0.2-full-validation.sh` | AC-0.2-1..6 and AC-0.2-7 | 7.1 and 7.2 |

### 3.3 Patterns and conventions to follow

- A claim of the form "every X goes through Y" is checked by listing X from the code, through imports and call sites. Checking that Y exists is not enough. The examples a sentence names are claims too (M36).
- For a work item that merged before its VERIFICATION, run AC-0.2-5 and AC-0.2-6's filters over the whole item as well, from the merge's first parent (P24).

## 4. Work completed

### 4.1 Tasks finished

- [x] Step 0: read root `development.md` and `docs/features/README.md`. Declared the governing sections and steps before the first command (P19 honored).
- [x] Restored state from the handoff, the Gauntlet state file and the cleanup log. Checked the refs against `git fetch` (7.1).
- [x] AC-0.2-1..6 (7.1), AC-0.2-7 (7.2), the P21 render (7.3).
- [x] Read `git diff b152b7a 974399b` in full and judged the seven fixes against the code (7.4).
- [x] Re-checked the README's code claims with my own checks (7.5), plus one mutation check (7.6) and the whole-item scope (7.7).
- [x] Wrote this log and `HANDOFF.md`, and ran the docs gates (7.8).
- [ ] CLEANUP rerun, then a fresh VERIFICATION.

### 4.2 Files modified

| File | Change | Author | Rationale |
|---|---|---|---|
| This file | Created | Claude | Session log |
| `HANDOFF.md` | Current state and the session index | Claude | `docs/features/README.md` section 6a |

Nothing under test changed. The mutation check (7.6) edited `agent-loop.ts` in the working tree for one test run and restored it with `git checkout`. The tree was clean afterwards, at `974399b`.

### 4.3 Decisions made

**Verdict per criterion**, at `974399b`. The code there equals `d1876b1`'s, because `d1876b1..974399b` touches only the three docs files.

| Criterion | Result | Evidence |
|---|---|---|
| AC-0.2-1a, 1b, 2, 3, 4-drift, 4-content, 5, 6 | PASS | The proof, exit 0 (7.1) |
| AC-0.2-7 (full step 7 = baseline) | PASS | 246 files and 3209 tests; integration 38 passed, 25 skipped, 1 failed, the Floci gap (7.2) |
| P21: both mapped diagrams render | PASS | Pinned `mmdc` 10.9.1, exit 0 on each block (7.3) |
| Cleanup changes no behavior | PASS | Identical comment-stripped transpile of both sources (7.4) |
| Cleanup changes no test | PASS | No `*.test.ts` in `b152b7a..974399b`, and none in `56e37b0..c58da7c` (7.4) |
| Fix 1: the clamp comment, `agent-loop.ts:81-84` | PASS | 1460 lines. The comment sits at 81-84. `MAX_TURN_WINDOW_BYTES = 300_000` (`sessions-repo.ts:50`). The trim keeps a suffix that fits the budget and moves the cut forward only |
| Fix 2: the `trimTurnsToBudget` reason and its pointer | PASS | The stored window is replayed first (`agent-loop.ts:1021-1024`). `stripBlockedTurns` drops only block notices, so a leading reply reaches Bedrock. The alternation note exists at the post-loop synthesis call (`:1316-1321`) |
| Fix 3: why `byteEvicted` joins `evicted` | PASS | `decideIngest` ingests on `evictedCount > 0` (`sessions-repo.ts:132-142`). `appendTurns` passes `evicted.length` (`:312`). `pending` is sliced from the untrimmed `combined` (`:381`) |
| Fix 4: README 2.3 names the three model calls | PASS | `converseStreamTurnWithFallback` (`agent-loop.ts:1046-1054`), the tool-loop round (`:1202-1203`), the synthesis `ConverseCommand` (`:1340-1341`) |
| Fix 5a: `tested_by` gains the two WI-0.2 test files | PASS | `agent-loop.max-tokens.test.ts` and `sessions-repo.byte-budget.test.ts`, the two new files of red `56e37b0`. `feature-knowledge: OK` |
| Fix 5b: 2.5, 3a and 4 carry their own dates | PASS | 2.5: `264d024`, 2026-09-19. 3a and 4: 2026-08-24 |
| Fix 5c: the stamp moved to `d1876b1` | **FAIL** | README 2.1: "Every consumer that converts stored turns into Bedrock messages — the agent loop, the dashboard TLDR path, Jarvis — reads through `getSession`". Jarvis does not (3.1): it has no `sessions-repo` import in `jarvis.ts` or `src/lib/jarvis/`, and its turns come from `jarvis-memory-repo.loadRecent` (`jarvis.ts:87-90`, `:658`, `:2355`). The sentence dates to `9d72979` (2026-08-24) and was already false at `f64d1e0`. The stamp now certifies it as checked on 2026-09-19, against the cleanup's own precaution P23 |
| Fix 6: `architecture-security.md:70` | PASS, a genuine fix | `handler.ts:241` lets `/config/cost/watch_enabled` writes through at viewer rank. So the old "`/config` writes are admin-only" was false. `:242` makes every other `/config` write admin-only, including `agent/max_output_tokens` |
| Fix 7: `request-lifecycle.md:52` | PASS, a clarification | The old line ("all three model calls") was true. Naming the calls matches README 2.3 and the code, and makes the note checkable. The drift gate forced the edit (M34), but it corrects no falsehood and adds no noise |

**Classification** (user constraint 4). Nothing was patched here: VERIFICATION does not write the artifact.

| Finding | Class | Route |
|---|---|---|
| F1: README 2.1 names Jarvis, and loosely the TLDR bar, as consumers that read through `getSession` | Phase-scoped to WI-0.2 CLEANUP. The sentence predates WI-0.2, but the cleanup's stamp re-certified it, just as it re-dated 3a and 4 and corrected 2.5 to keep the stamp honest | CLEANUP (6.1) |
| F2: 2.3's production observation ("left production still returning `outputTokens: 1024` after deploying") is past tense and undated | Cosmetic. P23 asks for a date on time-bound observations | CLEANUP may fold it in |
| F3: Jarvis's exposure to an empty stored turn | None: the write-side guard exists (3.1) | No action |

**One-time decision.** This log was drafted in the session scratchpad while the gates ran, so the tested tree stayed byte-identical to `974399b` with 0 changed paths. The proof's AC-0.2-5 and AC-0.2-6 and its `status` line count untracked files. The log moved into the feature folder afterwards (P25).

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Jarvis replays `jarvis-memory-repo` turns, not `getSession`'s, and refuses empty text on write | README 2.1, by the CLEANUP rerun. This session must not edit the artifact under review | No: handed to CLEANUP (6.1) |
| VERIFICATION's result and the routing | `HANDOFF.md` and the Gauntlet state file | Yes |

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

## 6. Pending work

### 6.1 Smallest next action

WI-0.2 CLEANUP rerun, in a fresh session: Claude Opus, no Codex. Its steps:

1. Correct README 2.1's consumer sentence to match the code (3.1, M36). Optionally, date 2.3's production observation (F2).
2. Re-check every README code claim, listing each "every X" from imports and call sites.
3. Settle the stamp.
4. Run the proof and the docs gates.

The code needs no change.

### 6.2 Immediate next steps

1. **CLEANUP** (6.1), on `chore/wi02-cleanup`, on top of this session's docs commit. README-only, so no mapped diagram is involved.
2. **VERIFICATION**, fresh, of the corrected README. The rest of this session's results stand while the code is unchanged. The proof and the full step 7 list run again on the new HEAD.
3. **Owner:** push and PR authorization for `chore/wi02-cleanup`, only after 2 passes and the step 7 list has run on that exact HEAD.

### 6.3 Blockers and open questions

- [ ] **Pin the non-string config value with a test? The owner's call.** This is unchanged from the implementation log's 6.3, and the recommendation is still (b), a SPECIFICATION amendment: AC-0.2-2 becomes 8 ceiling tests and AC-0.2-7 becomes 3210 tests. This session read the guard and did not execute it (3.1).
- [ ] **Push and PR for this branch.** Not authorized, and not yet due (6.2).
- [ ] **Non-streaming tool rounds above 8192 output tokens.** Whether they finish is still Unknown. The "unlimited ceiling" request is a proposed new work item (Gauntlet state file, decision 14), not WI-0.2.

### 6.4 Deferred, and why

- The cleanup log's three README debts and the `mission-tools.ts:150` line citation (its 6.4) are unchanged. They were not re-classified here.
- The full step 7 list at this session's docs commit. That commit is docs only, and the branch goes back to CLEANUP, so the list runs again on the final HEAD before any push (6.2).

## 7. Verification actually performed

Every test and proof command in this section ran with AWS credential sources stripped: `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` unset, `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` set to `/dev/null`, and `AWS_EC2_METADATA_DISABLED=true`. Exit codes were captured unpiped (M13).

### 7.1 State and AC-0.2-1..6 at `974399b`

- **Refs.**
  - `chore/wi02-cleanup` is at `974399b`, and the tree was clean.
  - After the proof's `git fetch`, `origin/development` is still `b152b7a`. Its parents are `264d024` and `c58da7c`.
  - The local `development` is stale at `9e8e42b`, 24 commits behind. Neither script reads it: the proof diffs `origin/${BASE}`, and `diagrams-drift.mjs` diffs `origin/<base>...HEAD`.
  - Floci `netzer-os-floci` is up and healthy on `127.0.0.1:4566`.
- **`WI02_BASE=development bash wi-0.2-proof.sh`: exit 0.**
  - `tests`: 6 files, 71 passed.
  - `typecheck`, AC-0.2-1a, 1b, 2, 3, 4-drift, 4-content, 5 and 6, and `diff-check`: all PASS.
  - The drift log reads "8 mapped diagrams, all paths valid" and "no drift across 7 changed file(s)".
  - `status: 0 changed paths`.

### 7.2 AC-0.2-7: the full step 7 list at `974399b`

`WI02_BASE=development bash wi-0.2-full-validation.sh` ran from 2026-09-19T18:20:14Z to 18:20:51Z. Every command ran.

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | 4 s |
| `npm test` | 0 | 246 files passed (246), 3209 tests passed (3209), 20.36 s |
| `npm run build` | 0 | |
| `npm --prefix web run typecheck` | 0 | |
| `npm --prefix web run build` | 0 | |
| `npm run local:verify` | 0 | All checks passed |
| `npm run local:test:integration` | 1 | Files: 1 failed, 8 passed, 2 skipped. Tests: 1 failed, 38 passed, 25 skipped (64). The one failure is `scripts/destroy.integration.test.ts > checkSecrets ... schedule-deleted`, with `expected 'pass' to be 'warn'`: the Floci gap (`development.md`, known limitation 9) |
| `node scripts/ci/docs-links.mjs` | 0 | `docs-links: OK` |
| `node scripts/ci/feature-knowledge.mjs` | 0 | `feature-knowledge: OK` |
| `git diff --check` | 0 | |
| `node scripts/ci/docs-assets.mjs` (extra) | 0 | `docs-assets: OK` |
| `diagrams-drift.mjs`, PR context (extra) | 0 | No drift across 7 changed files |

`status-after: 0 changed paths`. This equals the baseline recorded for `c58da7c` and `b152b7a`.

### 7.3 P21: both mapped diagrams render

The cached pinned `mmdc` 10.9.1 ran on each Mermaid block:

- `request-lifecycle.md`: one block, fenced at lines 7-45. Exit 0, 36,436-byte SVG.
- `architecture-security.md`: one block, fenced at lines 16-53. Exit 0, 21,623-byte SVG.

The two edited lines, 52 and 70, sit outside the fences.

### 7.4 The cleanup diff, `b152b7a..974399b`, read in full

- **Scope.** 7 files: the two sources (comments only), README, `HANDOFF.md`, the cleanup log, and one note line in each diagram. `d1876b1..974399b` touches only the three docs files.
- **Behavior.** A `node` script ran `typescript`'s `transpileModule` with `removeComments: true` on `git show <rev>:<file>`. The output is identical at `b152b7a` and `974399b` for `src/agent/agent-loop.ts` (31,833 bytes) and `src/lib/state/sessions-repo.ts` (10,216 bytes).
- **Tests.**
  - `git diff --name-only b152b7a 974399b -- '*.test.ts' '*.spec.ts' tests/` is empty.
  - `git diff --stat 56e37b0 c58da7c -- '*.test.ts'` is empty, so the Codex build left the red tests untouched.
- **The seven fixes**, judged in 4.3.

### 7.5 README code claims, re-checked with this session's own checks

These checks ran at `974399b`, whose code equals `d1876b1`'s. The following all PASS:

- `stripBlockedTurns` exists.
- `function repairEmptyTurns` exists once, in `sessions-repo.ts`, and `getSession` returns `repairEmptyTurns(...)` (`:235`).
- `truncatedNotice` is on both return paths (`:1136`, `:1380`).
- `agent-loop.ts` has no `maxTokens: 1024`. `?? 1024` is in `bedrock/client.ts`, and the initial call carries `maxTokens: turnMaxTokens`.
- The ceiling's constants are 8192, 1024 and 32_768.
- The max-tokens test names `converseStreamTurnWithFallback`.
- `pdf.ts` exports both functions, uses Helvetica and names DOCX.
- The War Room route has `pdf_render_failed`, 422, and three or more `toPdfSafeText(` calls. The `?` pin is at `warroom-transcript.test.ts:242`.
- `264d024` is #176, dated 2026-09-19, and an ancestor of HEAD.
- The three builders exist.
- `355c397` is the root commit and has `maxTokens: 1024`.
- `MAX_TOTAL_CELLS = 200_000`, with the "Split it into several" message.
- No `TOOL_LOOP_MAX_TOKENS` in `src` or `infra`.
- `runAgentTurn` calls `runAdmittedTurn`.
- The dated 4a observations: at `9e8e42b` only the `repairEmptyTurns` check passes, and at `6d43213` all five code checks pass. The "five test files pass" half of 4a at `6d43213` was not rerun.

The following were checked by reading the code:

- `cellText` strips C0 characters (`types.ts:99`).
- `MAX_CELL_LEN = 32_767` (`types.ts:72`).
- Rows given as objects throw "must be an array" (`types.ts:145`), and `builders.test.ts` passes in 7.1.

One check, 4a's `6d43213` line, first printed FAIL. The cause was my own awk quoting inside an `eval` string (section 5, the new trap). Checked by hand, all five code checks pass.

**The one false claim** is README 2.1's consumer list, for Jarvis (3.1, 4.3). The dashboard's direct reads of the sessions table (`handler.ts:2049`, `:2065`, `:3644`) all use a projection.

### 7.6 Mutation check on 2.3's "pins the initial call"

The check deleted `maxTokens: turnMaxTokens,` from the initial `converseStreamTurnWithFallback` call (`agent-loop.ts:1054`) and ran `npx vitest run src/agent/agent-loop.max-tokens.test.ts`. The run exited 1, with 3 tests failing: "passes an explicit maxTokens on the INITIAL streamed call", "does not leave the initial call on the 1024 default…" and "sends the runtime-configured ceiling…".

`git checkout` then restored the file. The tree was clean afterwards, at `974399b`. The claim holds.

### 7.7 The whole WI-0.2 delta, `264d024..974399b`

The delta holds 12 paths: the two sources, three test files, two diagrams, and five docs under `docs/features/chat-history-integrity/`. AC-0.2-6's allowed-path filter passes them all, and none is under `src/adapters/`, so AC-0.2-5 holds too. Scope and parity hold for the implementation as well as for the cleanup (P24).

### 7.8 The docs commit

These ran on the final text of this file and `HANDOFF.md`, before the docs commit, with this file included through `git add -N`:

- `node scripts/ci/feature-knowledge.mjs`: exit 0, `feature-knowledge: OK`.
- `node scripts/ci/docs-links.mjs`: exit 0, "187 markdown files · 2737 internal links checked", `docs-links: OK`.
- `git diff --check`: exit 0.

The proof's rerun at the docs commit is recorded in the Gauntlet state file, because this file is part of that commit.

### 7.9 Not run, and why

- The full step 7 list at the docs commit (6.4).
- Any probe of a non-string `max_output_tokens` value. It is the owner's open question, and a pinning test belongs to a SPECIFICATION amendment (6.3).
- Anything against AWS, staging or production.

## 8. Environment state

- macOS, Node 24.3.0.
- `_netzer-turn-ceiling`:
  - `chore/wi02-cleanup`, clean after the docs commit, local only.
  - `fix/turn-ceiling-byte-budget` (`c58da7c`) and `wip/docgen-crash-turn-ceiling` (`3706dd2`) are untouched.
  - The local `development` is stale at `9e8e42b`.
  - The gitignored `.env` and `web/node_modules` are present.
- `_netzer-backmerge` and `_netzer-devmd-amend`: not touched.
- Outside the repo: this session's scratchpad holds the proof and full-validation logs and the rendered SVGs.

## 9. Related documents

- [HANDOFF](../HANDOFF.md) and [README](../README.md)
- [2026-09-19 WI-0.2 cleanup log](2026-09-19-wi02-cleanup.md): the seven fixes, the drift gate (M34), and this ledger's source
- [2026-09-18 WI-0.2 implementation log](2026-09-18-wi02-implementation.md): the Codex build, its correction, and the owner's non-string question (its 6.3)
- [2026-09-18 WI-0.2 specification log](2026-09-18-wi02-specification.md): the acceptance criteria
- Outside the repo, in `~/.claude/plans/netzar-chat-plan/`: `wi-0.2-proof.sh`, `wi-0.2-full-validation.sh`, and the plan (section 10, P0 steps 2 and 3)
