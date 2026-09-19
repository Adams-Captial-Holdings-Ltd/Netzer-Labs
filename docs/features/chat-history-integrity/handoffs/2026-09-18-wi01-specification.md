---
feature: chat-history-integrity
document_role: session-handoff
status: current
observed_at: 2026-09-18
as_of_commit: b7990c777bbf912a2918337e2c1bba77d6e258d9
session_slug: wi01-specification
supersedes: 2026-09-17-backmerge-machine-transfer.md
---

# Session handoff: WI-0.1 specification (baseline, red state, conflict map)

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-18 (Gauntlet Loop, `DIRECT_COORDINATOR / SPECIFICATION`, Claude Opus 5) |
| Feature folder | `docs/features/chat-history-integrity/` |
| Branch worked on | `fix/backmerge-production-hotfixes` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `9e832da` (`271339b` + two docs commits), 3 behind `origin/development` `9e8e42b` |
| Commits made by this session | Rebase onto `9e8e42b` (both docs commits were already upstream, see 4.3). Then `5f376e19558e71d4ff82dd18369814348002fde6` and `b7990c777bbf912a2918337e2c1bba77d6e258d9` (tests only), then this file and `HANDOFF.md` in one docs commit. |
| Commit at session end | That docs commit: `git rev-parse fix/backmerge-production-hotfixes` |
| Pushed | **No.** `origin/fix/backmerge-production-hotfixes` is still the 2026-09-17 backup at `9e832da`. The local branch was rebased, so the next push is a **force-push** and needs the owner's explicit authorization. |
| PR | none |
| Deployed | no |
| Clone | `/Users/emmanueladams/Documents/Netzar OS/_netzer-backmerge`, a normal clone (macOS) |

This session wrote tests and docs only. No production code changed. The implementation is the next session's job.

## 2. Current state summary

- The branch is `origin/development` `9e8e42b` plus two local test-only commits that put WI-0.1 in a red state, plus this docs commit. None of the nine picks is applied.
- **Baseline on `9e8e42b` is green** except the one documented Floci gap (section 7.1). The 2026-09-11 red files, the typecheck out-of-memory crash and the docs-assets failure did not reproduce.
- **Red state** (section 7.2): production's tests for the four fixes fail against development for the intended reasons, and one new War Room test fails because development garbles emoji into a PDF that still returns 200.
- **The empty-turn repair is already on development.** `9d72979` (#96) and `8c14b3f` (#103) have the same `git patch-id` over `src` (`b34159d15310`), per file too. Picking `8c14b3f` adds no code; only its docs hunk conflicts.
- A `git merge-tree` simulation of all nine picks ends with `pdf.ts`, `types.ts` and `sessions-repo.ts` byte-identical to production, `agent-loop.ts` auto-merged (+18/−7), and conflicts only in docs and in the two pre-ported test files (section 3.1).

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **Target blobs** (`git rev-parse <ref>:<path>`, 10 chars). Development equals production's pre-fix state for every file the fixes touch, except `agent-loop.ts` and `handler.ts`:

  | File | development | after the nine picks = production |
  |---|---|---|
  | `src/lib/documents/pdf.ts` | `2d28de2558` | `c0491444da` (d828124); with #170's slice `285f601624` (= production) |
  | `src/lib/documents/types.ts` | `7c40520caf` | `4d1114f1e8` |
  | `src/lib/state/sessions-repo.ts` | `851eef5941` | `a8d3a7bfb9` |
  | `src/agent/agent-loop.max-tokens.test.ts` | absent | `3214ab6b08` |
  | `src/lib/documents/builders.test.ts` | `eef0e12227` | `4e8e994aed` |
  | `src/lib/state/sessions-repo.persistence.test.ts` | `6c57d1f7e1` | `9e18441646` |
  | `src/agent/agent-loop.history.test.ts` | `820751f1b8` | `820751f1b8` (already equal) |
  | `src/adapters/dashboard/warroom-transcript.test.ts` | `863338ab82` | production `dcfd2ed873`; this branch adds one test on top |

- **Model call sites.** Development and production have the same three calls in `src/agent/agent-loop.ts`: the initial `converseStreamTurnWithFallback` (development `:1008`, no `maxTokens`) and two `ConverseCommand` calls (`:1154`, `:1295`, both on `TOOL_LOOP_MAX_TOKENS`). Production spells `maxTokens: TURN_MAX_TOKENS` five times over those three calls. The simulation reproduces exactly five.
- **Conflict map** from `git merge-tree --write-tree --merge-base=<c>^ <cur> <c>`, chained with `git commit-tree` (no ref or working-tree change):

  | Pick | Conflicts | Rule |
  |---|---|---|
  | `8c14b3f` | `HANDOFF.md`, `sessions-repo.persistence.test.ts` | keep ours for both; the `src` hunks are already on development |
  | `844a831` | `architecture-security.md`, `request-lifecycle.md` | `request-lifecycle.md` patch equals `9d72979`'s: keep ours. `architecture-security.md` differs from `9d72979`'s wording: reconcile, one description of the guard |
  | `1abba67` | `agent-loop.max-tokens.test.ts` | keep ours (production's final blob). `agent-loop.ts` merges cleanly |
  | `333ef6b` | `agent-loop.max-tokens.test.ts` | keep ours |
  | `5193ced` | none | docs apply cleanly |
  | `1124118` | none | |
  | `8c7b07e` | `architecture-compute.md`, `architecture-data.md` | add production's drift-gate annotation to development's text |
  | `d828124` | `sessions-repo.persistence.test.ts` | keep ours; `pdf.ts`, `types.ts`, `sessions-repo.ts`, `agent-loop.ts`, `README.md` apply cleanly |
  | `3bffea6` | `architecture-security.md`, `request-lifecycle.md` | add the annotations to development's text |
  | `4765612` | `architecture-security.md`, `handler.ts`, `warroom-transcript.test.ts` | **do not pick whole** (its scroll UI is out of scope and the route already exists on development via `f8863b0`). Apply only the `pdf.ts` delta and the route's substitution + 422 hunk |

  Later rows were computed on trees that still held earlier markers, so treat them as a map, not a guarantee.
- **War Room route on development** (`src/adapters/dashboard/handler.ts`, `GET /warroom-transcripts/:id`, about `:3195-3240`): passes raw transcript text to `buildPdf` with no `try`. Production's version wraps every string in `toPdfSafeText` and turns a thrown build into `422 {error:'pdf_render_failed'}`. Once `d828124`'s guard lands, development's route would 500 on the first emoji.
- **Mapped diagrams** (`docs/diagrams.map`): `agent-loop.ts` → `architecture-security.md`, `request-lifecycle.md`; `handler.ts` → `architecture-security.md`; `sessions-repo.ts` → `request-lifecycle.md`; `infra/lib/constants.ts` → `architecture-compute.md`, `architecture-data.md`; `pdf.ts` and `types.ts` are unmapped. In PR context `scripts/ci/diagrams-drift.mjs` fails if a mapped source changes and its diagram does not.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/agent/agent-loop.ts:1008` | Initial model call | Still passes no `maxTokens` on `9e8e42b` |
| `src/lib/documents/pdf.ts` | `buildPdf` | No guard on development; pdfkit writes UTF-16 code units as WinAnsi bytes |
| `src/adapters/dashboard/handler.ts` | War Room transcript route | Needs #170's substitution + 422 slice |
| `src/adapters/dashboard/warroom-transcript.test.ts` | Route tests | Production's emoji test + this branch's substitution test |

### 3.3 Patterns and conventions to follow

- Pick in production order with `git cherry-pick -x`, resolving each conflict before the next pick. Never commit a conflict marker. The #170 slice is not a cherry-pick; its commit message names `4765612` and what was taken.
- Commit as `Emmanuel Adams <emmanuelmadams4@gmail.com>` (owner decision, 2026-09-18). Commits stay local.
- Run tests with AWS credential sources stripped (section 7).

## 4. Work completed

### 4.1 Tasks finished

- [x] Step-0 read of `development.md` (Testing Netzar OS features, Automated tests, AWS safety, Feature work, How to develop a new feature, Branch to environment mapping, Long-lived branches, Maintenance rules) and `docs/features/README.md` sections 6, 6a, 7.
- [x] Fetched; `origin/development` = `9e8e42b`, `origin/production` = `de244e6`, unchanged since the PLAN.
- [x] Rebased the branch onto `origin/development` (4.3).
- [x] Full baseline on `9e8e42b`, credentials stripped (7.1).
- [x] Red state: two test-only commits (7.2).
- [x] Pinned the `9d72979` reconciliation, the conflict map and the mapped-diagram impact (3.1).
- [x] Folded the claudex round-1 findings (4.3).
- [ ] Implementation. Next session.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `src/agent/agent-loop.max-tokens.test.ts` | Added, production blob | RED for AC-0.1-2 |
| `src/lib/documents/builders.test.ts` | Production blob | RED for AC-0.1-4 |
| `src/lib/state/sessions-repo.persistence.test.ts` | Production blob | RED for AC-0.1-5 (`d828124` part) |
| `src/adapters/dashboard/warroom-transcript.test.ts` | Production blob + one new test | RED for AC-0.1-6 |
| `docs/features/chat-history-integrity/handoffs/2026-09-18-wi01-specification.md` | Created | This log |
| `docs/features/chat-history-integrity/HANDOFF.md` | Rewritten in place | Current state and session index |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Rebase onto `9e8e42b` | Merge `origin/development` (the old claudex plan's finding 6 forbade a rebase) | The owner-approved Gauntlet plan (2026-09-18, line 320) says rebase, and supersedes the claudex plan. Both docs commits were already upstream (`54b3f12`), so the rebase left no commits of our own; `HANDOFF.md` took development's newer version, which only added the docgen index line. |
| Port production's final test blobs whole | Port each pick's intermediate test state | The red state must hold the final expectations. The cost is the test-file conflicts in 3.1, all resolved "keep ours". |
| The new War Room test asserts `?` substitution | Assert only "PDF or 422, never 500" | Development returns 200 today, so a status-only test would be green. The garbled text is the defect that proves substitution is missing. The 422 path is a backstop no real input reaches (`toPdfSafeText` and the guard share `renderable`), so it is left to review, not a mocked test. |
| BR-001 is moot | Keep the collapse-by-path step | Conflicts are resolved inside each pick and never committed. Its check survives: no conflict marker reachable at `HEAD`. |
| BR-002 kept as two dry-runs | | In the implementation proof list; baseline indicators in 7.3. |
| BR-003 kept, scoped to code | | AC-0.1-1 (`-- src infra`), per M20 |
| Provider: Claude Opus | Codex terra (policy BALANCED) | The code picks auto-merge, but the War Room slice is a hand-applied partial hunk in a diverged `handler.ts`, the diagram text needs reconciling, and PDF safety needs judgment. A Codex work order would cost more to write and inspect than the ~25 lines it would produce. |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| `9d72979` equals `8c14b3f` over `src` by patch-id | `HANDOFF.md` | Yes |
| Development's War Room PDF export garbles non-WinAnsi text with a 200 | README, when the slice lands | No: it describes code this branch does not have yet |
| The `development.md` Automated tests table is stale (now 244 files, 3174 tests, all passing on `9e8e42b`) | `development.md` | No: needs the owner's approval (see M9) |

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

## 6. Pending work

### 6.1 Smallest next action

Run the Gauntlet `DIRECT_COORDINATOR / IMPLEMENTATION` handoff for WI-0.1 (section 0 of `~/.claude/plans/ponytail-claudex-loop-grill-me-ticklish-dijkstra.md`) in a fresh Opus session.

### 6.2 Immediate next steps

1. Cherry-pick the nine commits with `-x`, in production order, resolving each conflict by the rules in 3.1.
2. Apply #170's slice by hand: `pdf.ts` to production's blob `285f601624`, and the route's `toPdfSafeText` + `422` hunk into development's existing route.
3. Reconcile the four mapped diagrams: one description of the empty-turn guard in `architecture-security.md`, production's drift-gate annotations, and a development-worded annotation for the War Room slice.
4. Run the proofs in the implementation handoff, then write the session log and update `HANDOFF.md`.

### 6.3 Blockers and open questions

- [ ] **Push and PR.** Not authorized. The branch was rebased, so a push is a force-push over the `9e832da` backup. Ask the owner.
- [ ] **The 2026-09-18 `development.md` amendment** (the plan's section 9 process-gap diff) is approved but not applied. It needs one yes/no re-confirm in the applying session, and its own docs-only branch off `development`.
- [ ] **`development.md` Automated tests table is stale** (M9; now 244 files, 3174 tests, all passing). Reporting only; amending needs approval.
- [ ] **Note:** `1124118` (Haiku id) takes effect only through a CDK deploy. This branch deploys nothing.

### 6.4 Deferred, and why

- **#90, #91, #168 and the rest of #170** stay out of scope (owner, 2026-09-18). Do not promote `staging → production` until their ancestry is reconciled.
- **WI-0.2** (`wip/docgen-crash-turn-ceiling`) rebases after this back-merge lands.
- **The Windows `spawn npm ENOENT` fix** (M16) stays a separate `fix/*` branch.

## 7. Verification actually performed

Every command ran on this Mac with `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` unset, and `AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true`. Exit codes were captured unpiped (M13).

### 7.1 Baseline on `9e8e42b` (2026-09-19 00:40Z, before any change)

| Command | Result |
|---|---|
| `npm run typecheck` (alone, first) | exit 0, 8 s |
| `npm test` | exit 0: 244 files, 3174 tests passed |
| `npm test` (second run) | exit 0: 244 files, 3174 tests passed |
| `npm run build` | exit 0 |
| `npm --prefix web run typecheck` | exit 0 |
| `npm --prefix web run build` | exit 0 |
| `node scripts/ci/docs-links.mjs` | exit 0 |
| `node scripts/ci/feature-knowledge.mjs` | exit 0 |
| `node scripts/ci/docs-assets.mjs` | exit 0 (docs/assets 1.98 MB) |
| `node scripts/ci/diagrams-drift.mjs` | exit 0 (path validation only, no PR context) |
| `git diff --check` | exit 0 |
| `npm run local:verify` | exit 0 (after `cp .env.local.example .env`, what `npm run local` does) |
| `npm run local:test:integration` | exit 1: 1 failed, 8 passed, 2 skipped files; the one failure is the documented `scripts/destroy.integration.test.ts > checkSecrets … schedule-deleted` |

`npm ls --depth=0` exited 0 at the root and in `web/`, so no `npm ci` was needed. Not run: `npm run local` (it starts dev servers) and `docs-mermaid` / `runnable-blocks` (not in the `development.md` list).

### 7.2 Red state (tests only, after `5f376e1` and `b7990c7`)

| Test file | Result on development's code | Reason |
|---|---|---|
| `src/agent/agent-loop.max-tokens.test.ts` | 0/2 | the initial call has no `maxTokens` |
| `src/lib/documents/builders.test.ts` | 15/28 | no `assertPdfRenderable`, no cell budgets, no cell validation |
| `src/lib/state/sessions-repo.persistence.test.ts` | 11/14 | `t.text?.trim is not a function` on non-string stored text |
| `src/agent/agent-loop.history.test.ts` | 7/7 | already on development (`9d72979`) |
| `src/adapters/dashboard/warroom-transcript.test.ts` | 6/7 | production's emoji test passes (no guard yet); the new substitution test fails: text reads `Ship it Ø=Þ€ done '` |
| `npm run typecheck` | exit 2 | TS2305 ×3: `assertPdfRenderable` (pdf.ts), `MAX_CELL_LEN` and `MAX_TOTAL_CELLS` (types.ts) |

### 7.3 Content checks and promotion indicators (at `b7990c7`)

- `git grep -n TOOL_LOOP_MAX_TOKENS -- src infra`: 5 hits, exit 0 (AC-0.1-1 fails, as expected).
- `maxTokens: TURN_MAX_TOKENS` in `agent-loop.ts`: 0 (production: 5). Haiku suffix, `export function assertPdfRenderable`, `export function toPdfSafeText`: absent.
- `function repairEmptyTurns`: exactly one definition (`src/lib/state/sessions-repo.ts:105`), as on production.
- BR-002 (a) `git merge-tree --write-tree origin/production HEAD`: 14 conflicted files. (b) `origin/staging` + `HEAD`: conflict-free; that candidate against `origin/production`: 14 conflicted files, including the #90/#91/#168/#170 paths. Re-run after the picks and compare.

## 8. Environment state

- macOS, Node 24.3.0, npm 11.4.2, Docker 28.3.2.
- Floci (`netzer-os-floci`, `127.0.0.1:4566`) was already running; this session did not start or stop it.
- This clone now has a `.env` (gitignored), copied from `.env.local.example`. Read the dangerous-commands list before running any unfamiliar `npm run` script here (M8).
- No dev servers were started.

## 9. Related documents

- [HANDOFF](../HANDOFF.md) and [README](../README.md)
- [2026-09-17 back-merge log](./2026-09-17-backmerge-machine-transfer.md), the predecessor on this stream
- [2026-09-17 docgen-crash log](./2026-09-17-docgen-crash-wip-transfer.md), the parallel stream whose ledger is merged above
- [`development.md`](../../../../development.md) and the [feature knowledge framework](../../README.md)
