---
feature: netzar-chat
document_role: session-handoff
status: current
observed_at: 2026-09-21
as_of_commit: ea0a28fc81e9bce3c290345b69e50dd292ca7adb
session_slug: f1-specification
supersedes: 2026-09-21-final-p0-verification.md
---

# Session handoff: F1 SPECIFICATION — test foundations, step 2 of 9

## 1. Session metadata

| Field | Value |
|---|---|
| Gauntlet phase | `SPECIFICATION`, work item **F1 — test foundations** |
| Overall step | **step 2 of 9 — F1.** 1 of 9 finished (P0, complete and exit-gated at `08f85db`). Re-derived, not carried |
| Roadmap in force | the **9-step** list. Owner decision 30 was ACCEPTED in this session and is recorded as **decision 31** |
| Checkout | `_netzer-turn-ceiling`, a standalone clone (`git rev-parse --git-common-dir` = `.git`, M31) |
| Branch | `feat/f1-test-foundations`, cut at `origin/development` @ `08f85db`; merge target `development` |
| HEAD | `ea0a28fc81e9bce3c290345b69e50dd292ca7adb` (the decision-28 landing commit) |
| Session type | **ATTENDED.** No overnight window is open |
| Model | Claude Opus 5. **No Codex** — a SPECIFICATION writes no implementation. One read-only subagent (6.6) |
| Deployment | **none.** Nothing pushed, no PR, nothing promoted past `development`, no AWS API called |
| Verdict | Red established and proved for the right reason; two-tier acceptance written; provider selected. **No implementation.** |

## 2. Step-0 declaration (netzer-os-development-process)

Read with the Read tool only, before any command in the repository — **M39/M46 not repeated
this session**: root `development.md`; [`docs/features/README.md`](../../README.md); the carried
ledger, section 5 of
[`2026-09-21-wi-0.4-landing.md`](2026-09-21-wi-0.4-landing.md) (lines 129-947), which was the
newest log in this folder when the session opened.

Governing sections by heading name:

- `development.md` — *Feature work* → *How to develop a new feature, end to end* (**steps 1-6**
  run, **7-10** deliberately not, see below);
  [*Automated tests*](../../../../development.md#automated-tests);
  [*AWS safety*](../../../../development.md#aws-safety) including
  [*Dangerous commands*](../../../../development.md#dangerous-commands-never-run-locally);
  [*AWS dependency inventory*](../../../../development.md#aws-dependency-inventory) (DynamoDB
  and S3 both "Full, verified" — the fact the two-tier split rests on);
  [*Known local limitations*](../../../../development.md#known-local-limitations) items **1-4**
  (Bedrock stub, tool use unreachable, no `ConverseStream`, no embeddings), item **9** (the
  Floci `ListSecrets` gap) and item **14** (Playwright targets a deployed URL — **now stale,
  see A77**); *Testing Netzar OS features*;
  [*Branch to environment mapping*](../../../../development.md#branch-to-environment-mapping);
  *Long-lived branches*; *Maintenance rules*.
- [`docs/features/README.md`](../../README.md) — §2 The shape, §3 Frontmatter contract,
  §4 Vocabularies, §5 What the README carries, §6 What the HANDOFF carries, §6a Session
  handoffs and the carried-forward ledger, §7 Validation.

Numbered steps run, in documented order: **1** (branch from `development`), **2** (the folder
exists; this log started from the newest ledger and was written outside the tree, P25), **3**
(the environment was already up — confirmed, not started, and the emulator NAMED first, P50),
**4** (**baseline on the untouched branch before anything else**), **5** (test-first: this phase
writes the failing evidence and nothing else), **6** (this log, ledger §5 carried forward, the
feature `HANDOFF.md` updated in the same commit).

**Steps 7-10 deliberately NOT run, and not recorded as skipped.** Step 7 is a *pre-push* gate
and nothing is pushed here; **P36 does not fire** (no `src/`, `infra/`, `web/`, `scripts/`,
`tests/`, `package.json`, lockfile or `vitest.*` file is changed by this phase). The full list
was nonetheless run once, in full, as the step-4 baseline — running *more* than the documented
list is a normal decision; running fewer is a process change. Steps 8 and 9 need a push that has
not been authorized. Step 10 is owner decision 18, still due, and the `qa` → `staging` merge
runs a full `cdk deploy --all`.

## 3. State re-derived before anything else (P40, P41, P50)

| Check | Result |
|---|---|
| `git fetch origin` | exit 0 |
| `git rev-parse HEAD` (at open) | `08f85db9d264c925ea22272b1386fbaed266b852` |
| `git rev-parse origin/development` | `08f85db…` — **unmoved** |
| `origin/qa` / `origin/staging` / `origin/production` | `ac0cbcc` / `8299f04` / `de244e6` — all **unmoved** |
| `git rev-list --left-right --count origin/development...HEAD` | `0	0` |
| `git status --porcelain` | empty |
| `git rev-parse --git-common-dir` | `.git` — a standalone clone, not a worktree (M31) |
| `git worktree list` | exactly one entry |
| `git ls-remote --heads origin feat/f1-test-foundations` | **empty** — the new branch is genuinely unpushed |

All four tips match what the state file recorded. Nothing had to be reconciled.

### 3.1 Sole occupancy (P41) and the emulator's identity (P50)

| Check | Result |
|---|---|
| Any process naming the clone path | **none** but this session's own shell |
| `vitest`, `tsc --noEmit`, `runner.sh`, a Codex build in this clone | **none** |
| `.git/index.lock` | does not exist |
| **Port 4566** | `netzer-os-floci`, `floci/floci:1.6.0`, healthy, up 5 weeks — **Floci, not LocalStack** |
| Port 5173 | a Vite dev server owned by a different checkout (**A73**: it runs out of the Trash). Nothing on 3000 |

**P50 was honoured before any integration result was read.** The one expected integration failure
is Floci-specific; a stray LocalStack on 4566 makes that test *pass*, and the run stops matching
the baseline in the direction that looks like good news.

## 4. Starting state, before anything was changed (`development.md` step 4)

The full step 7 list, run **alone in the checkout**, credentials **stripped**, at `08f85db`,
17:33:43Z-17:34:24Z (41 s) — **= BASELINE**:

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 (4 s) |
| `npm test` | exit 0 (24 s) — **247 files / 3215 tests**, `guard-violations: 0` |
| `npm run build` | exit 0 (2 s) |
| `npm --prefix web run typecheck` | exit 0 (2 s) |
| `npm --prefix web run build` | exit 0 (3 s) |
| `npm run local:verify` | exit 0 — `sts:GetCallerIdentity` returned `000000000000` |
| `npm run local:test:integration` | **exit 1, as the baseline requires** — 38 passed, 25 skipped, **1 failed** |
| `node scripts/ci/docs-links.mjs` | exit 0 — 202 files / 3167 links |
| `node scripts/ci/feature-knowledge.mjs` | exit 0 |
| `git diff --check` | exit 0 |
| `node scripts/ci/docs-assets.mjs` | exit 0 — 1.98 MB |
| `diagrams-drift` (PR context, base `development`) | exit 0 |
| `status-after` | **0 changed paths** |

The single failure was confirmed **by name**, not by count:
`scripts/destroy.integration.test.ts > destroy completeness sweep > checkSecrets passes on a
clean prefix, flags an active secret, then warns once it is schedule-deleted`. That is
[Known local limitations](../../../../development.md#known-local-limitations) item 9 — Floci does
not list schedule-deleted secrets — and the test is correct and unmodified. Identical to **A71**.

## 5. Carried-forward mistakes, assumptions and precautions

> Carried forward **verbatim** from [`2026-09-21-final-p0-verification.md`](2026-09-21-final-p0-verification.md)
> section 5, then appended to. Both logs sit in this same feature folder, so **P45 does not fire**:
> no relative link needed repointing, and `diff` against the source lines shows **additions only**,
> checked by `diff` rather than by eye (**A66**). Inside a carried row, "This log" means the log the
> entry was first written in, not this one.
> Carried forward **verbatim** from [`2026-09-21-wi-0.4-landing.md`](2026-09-21-wi-0.4-landing.md)
> section 5 (lines 129-947), then appended to. Both logs sit in this same feature folder, so **P45 does
> not fire**: no relative link needed repointing, and `diff` against the source lines shows **additions
> only** — these preamble lines and the appended `Added 2026-09-21 (final P0 verification)` block,
> checked by `diff` rather than by eye (**A66**). Inside a carried row, "This log" means the log the
> entry was first written in, not this one.
> Carried forward **verbatim** from [`2026-09-20-wi-0.4-verification.md`](2026-09-20-wi-0.4-verification.md)
> section 5, then appended to. Both logs sit in this same feature folder, so **P45 does not fire**: no
> relative link needed repointing, and `diff` against the source lines shows **additions only** — the
> preamble lines above and the appended `Added 2026-09-21 (WI-0.4 landing)` block, checked by `diff`
> rather than by eye (**A66**). Inside a carried row, "This log" means the log the entry was first
> written in, not this one.
> Carried forward **verbatim** from `2026-09-20-wi-0.4-cleanup.md` section 5, then appended to.
> Both logs sit in this same feature folder, so **P45 does not fire**: no relative link needed
> repointing, and `diff` against the source lines shows additions only. Inside a carried row,
> "This log" means the log the entry was first written in, not this one.
> Carried forward **verbatim** from `2026-09-20-wi-0.4-implementation.md` section 5, then appended
> to. Both logs sit in this same feature folder, so **P45 does not fire**: no relative link needed
> repointing, and `diff` against the source lines is empty. Inside a carried row, "This log" means
> the log the entry was first written in, not this one.
> Carried forward **verbatim** from `2026-09-20-wi-0.4-specification.md` section 5, then appended
> to. Nothing is deleted. An entry that is fixed is marked `RESOLVED (<commit>)` and stays. The five
> relative links this carry repointed when the feature folder changed are listed in **P45** below,
> and in the specification log itself.
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

| An empty assistant turn poisons a chat permanently via Bedrock validation. | This feature's [README](../../chat-history-integrity/README.md) |
| `generate_document` needs the whole spec inline, so it is the tool most likely to hit any output ceiling. | This feature's [README](../../chat-history-integrity/README.md), section 3 |

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

> The 2026-09-17 [docgen-crash-wip-transfer](../../chat-history-integrity/handoffs/2026-09-17-docgen-crash-wip-transfer.md)
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
| `Number('  ')` is `0`, not `NaN`. An `!raw \|\| !Number.isFinite(...)` junk check lets a whitespace-only value through as zero. | [docgen-crash-wip-transfer](../../chat-history-integrity/handoffs/2026-09-17-docgen-crash-wip-transfer.md), section 3.1 |
| A mock created inside a `vi.mock` factory cannot be reached from test bodies. Hoist it with `vi.hoisted`. | [docgen-crash-wip-transfer](../../chat-history-integrity/handoffs/2026-09-17-docgen-crash-wip-transfer.md), section 3.3 |

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

### Added 2026-09-19 (WI-0.2 specification amendment)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P28 | When the code already passes, make the red a mutation. Commit the test first. Change only the guarded line, in the working tree. Run the one test file, restore with `git checkout -- <file>`, and check that `git status --short` prints nothing. | Owner decision 15. A mutation on an uncommitted tree mixes the red with the test edit. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M39 | This session ran one read-only command before its Step-0 declaration: a `grep` of the state file's headings and a `wc` of the framework page. | None. It changed nothing, and the declaration did not depend on it. It still broke P19's order. | The declaration came right after, and it named the slip. | Do Step 0's reading with the Read tool only. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A31 | `getConfig` returns the stored runtime-config attribute unchecked. A value stored as a number arrives as a number, whatever its `string` type says. | Observed 2026-09-19 at `runtime-config-repo.ts:69` and `:83-85`. Whether the dashboard's `/config` route can ever store a number was not traced. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| `src/lib/state/runtime-config-repo.ts` holds literal NUL bytes (`:57`, `:238`). `grep` prints "Binary file ... matches" or nothing for it, `git grep -n` prints nothing, and `git log -p` shows "Binary files ... differ". Use `grep -a`. | This log, sections 3.1 and 4.3 |

### Added 2026-09-19 (WI-0.2 verification, final)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P29 | When a criterion says a mutation makes one test fail **and no other**, run the whole suite under the mutation, not just that file. Restore, then confirm `git status --short` is empty. | A file-scoped run cannot see a failure in another file, so it cannot support an "only" claim. Here the whole suite gave 1 failed of 3210. |
| P30 | A verification that re-uses an earlier verification's result must first run the exact scoping diff that licenses the re-use, and must state which paths that diff does **not** cover. | The carried results were licensed by `git diff --quiet 974399b HEAD -- src infra web scripts tests ':!src/agent/agent-loop.max-tokens.test.ts'`, which says nothing about `docs/`. `docs/diagrams` was checked separately (0 files changed), and the Mermaid gate was re-run rather than carried. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A32 | At `c195a6e`, with every AWS credential source stripped, the full step 7 list equals the baseline: `typecheck`, `npm test` (246 files, 3210 tests), `build`, both `web` gates, `local:verify`, `docs-links`, `feature-knowledge`, `diff-check`, `docs-assets` and the PR-context `diagrams-drift` all exit 0; the integration suite is 38 passed, 25 skipped and 1 failed, the Floci `checkSecrets` gap. | Observed 2026-09-19 (2026-09-20T02:04Z), one run of 41 s for the whole list. |
| A33 | With `agent-loop.ts:104` mutated to `const trimmed = raw?.trim();`, the **whole** suite has exactly one failure: `turn output ceiling > accepts a ceiling stored as a number, and the turn still runs`, with `TypeError: raw?.trim is not a function` at `agent-loop.ts:104:24`. | Observed 2026-09-19, one run (1 failed, 3209 passed). The tree was clean after `git checkout --`. |
| A34 | Removing the initial streamed call's `maxTokens: turnMaxTokens` (`agent-loop.ts:1054`) now fails **4** tests in `agent-loop.max-tokens.test.ts`, not 3: the two initial-call tests, the configured-ceiling test and the pinning test. | Observed 2026-09-19. The earlier "3" predates `7b6bbf3`. |
| A35 | The War Room orchestrator is outside README 2.1's claim: it passes `history: []` and flattens its room transcript into the user message (`orchestrator.ts:205-216`). | Read 2026-09-19. Its own transcript store was not audited for empty turns; nothing in this work item touches it. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| `wi-0.2-readme-claims.sh` reports `FAILS=1` at any commit after `7b6bbf3`: its `carry` row omits the `':!src/agent/agent-loop.max-tokens.test.ts'` exclusion. The other 55 rows pass. The script lives outside the repository. | This log, sections 4.3 and 7.6 |

### Added 2026-09-19 (WI-0.3 specification)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P31 | In a red test that must not touch the network, gate every network call behind an assertion that the guard is armed. Put the assertion in the **same** test, before the call. | M40. "The guard will stop it" is circular while the guard does not exist yet. |
| P32 | Before the guard lands, run `wi-0.3-proof.sh` with `WI03_CREDS=strip`. The scored mode plants credentials, which would be an un-stripped `npm test` and is forbidden until WI-0.3 lands. | The script is the gate for a state that does not exist yet; rehearsing it must not break the standing constraint it exists to retire. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M40 | The first version of `aws-guard.test.ts` gated its 4th test on the patch being installed, but not its 5th. Unpatched, that 5th test called `https.request({ host: 'netzar-guard-probe.amazonaws.com' })` for real. | A red state whose own comment claimed it stayed offline made a real DNS lookup (12 ms, `ENOTFOUND`). No connection, no credentials, nothing sent. | The same `__netzarAwsGuard === true` assertion was added ahead of the call. Re-run: 4 failed, 1 passed, no lookup. | A test that proves a guard works must assume the guard is absent, because in the red state it is. |
| M41 | `wi-0.3-proof.sh`'s first dry run reported **AC-0.3-3 PASS** — "0 amazonaws.com dials" — from a run that had exited 1 and never completed. | The tripwire criterion was green by construction, which is the exact failure P18 exists to catch, in the gate written to enforce P18. | AC-0.3-3 is now gated on AC-0.3-2's exit code and reports "not assessable" otherwise. | Grepping a log for the absence of something proves nothing until you have checked the log is of a completed run. |
| M42 | The same dry run reported "AC-0.3-4 cleanup: 1 changed path left behind" and "AC-0.3-5 restore: 1 still dirty". | Two false FAILs. The changed path was the uncommitted red test, not anything the script had left. | Dirt is measured as a delta against `DIRT0`, captured at script start. | An absolute cleanliness check assumes a clean tree. Measure what you changed, not what you found. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A36 | On this Mac, `~/.aws` holds only `config`, with **no `credentials` file, no `[default]` profile** and no SSO or CLI cache, and no `AWS_*` variable is exported. So an un-stripped `npm test` in a clean shell resolves no credentials and does not dial. The exposure is conditional on `AWS_PROFILE=netzer-process`, whose `credential_process` mints real credentials. | Observed 2026-09-19. Re-check before relying on it: an `aws login`, a new profile or an exported key changes it. It does **not** weaken the standing constraint — it explains which shell makes it bite. |
| A37 | At `0f41b53` with credentials stripped, `npm test` is green: **246 files, 3210 tests**, exit 0, 20.7 s. `src/adapters/dashboard/cost-cap.test.ts` is 7 tests. `npx vitest list --filesOnly` gives the same 246 files, saved as `netzar-chat-plan/wi-0.3-baseline-files.txt`. | Observed 2026-09-19, one run each. Same counts as `c195a6e`. |
| A38 | The AWS SDK v3 in Node dials through `@smithy/node-http-handler`, i.e. `http`/`https`, not `fetch`. | Inferred from the SDK's Node request handler, not traced through `node_modules` this session. If a future SDK release moves to `fetch`, the tripwire misses it — AC-0.3-4 would still pass while AC-0.3-3 became meaningless, so re-run AC-0.3-5's mutation after any `@aws-sdk/*` bump. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| A planted `*.amazonaws.com` dial makes vitest exit non-zero **even when the guard is disarmed**: the test itself PASSES and vitest reports an unhandled `getaddrinfo ENOTFOUND`. Score the tripwire on a FAILED test plus the violation line, never on the exit code. | This log, section 7.3 |
| `~/.aws/config` has no `[default]` profile, so a "clean shell" run of `npm test` proves nothing about credential safety. Plant fake credentials to exercise the chain. | This log, section 3.3 |

### Added 2026-09-19 (WI-0.3 implementation)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P33 | Before writing a criterion of the form "remove the mock and the guard must fire", check that no earlier layer already stops the call. Name which layer the criterion is testing. | M43. Defence in depth makes the inner layer unreachable on that path, so the criterion fails against a correct implementation. |
| P34 | Commit the implementation before running a proof whose mutation block ends in `git checkout -- <file>`. | That restores from the **index**, not from HEAD. An uncommitted edit to the mutated file is discarded, silently. |
| P35 | When a brief's instruction and one of its own acceptance criteria cannot both hold, say so and pick the reading under which every criterion passes. Record it as a decision. | M44. Following the instruction literally would have shipped a guard that fails its own gate. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M43 | AC-0.3-5's mutation removed the `budget-writer` mock from `cost-cap.test.ts` and expected the tripwire to catch the Budgets dial. Layer 1 neutralises the credential chain, so the un-mocked call dies at `Could not load credentials from any providers` **before** a socket exists. | The proof could never exit 0 against a correct guard. Scored at `54cb972`: exit 0, 7/7 passed, no violation. | Owner-approved 2026-09-19: replaced with a control that restores fake credentials **inside** the test process, calls the real `syncBudgetToDailyCap`, and lets it swallow. The guard fails that test and names `sts.us-east-1.amazonaws.com` (7.3). | To test the inner layer of a defence in depth, defeat the outer one deliberately. A criterion that assumes the dial happens must say which layer is disarmed. |
| M44 | The brief said the tripwire should print the `NETZAR-AWS-GUARD VIOLATION` line **at the dial**. `src/__test-utils__/aws-guard.test.ts` dials three times on purpose and drains them, so a green full-suite run would have carried three violation lines. | AC-0.3-3 counts exactly those lines and requires zero, so the implementation would have failed its own gate. | The line is printed by the `afterEach` that reports undrained hits (3.2, decision 1). Every criterion passes. | A deliberate probe and a real leak look identical at the dial. They differ only in whether anyone drained them, which is knowable one test later. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A39 | `vitest.setup.ts` is **not** covered by `npm run typecheck`: `tsconfig.json:25` names `vitest.config.ts` by name rather than globbing root `.ts` files. `tsconfig.build.json` still keeps it out of `dist`, which is why the root was chosen. | Observed 2026-09-19 by reading both configs. Adding it to the include list is one line, and is outside AC-0.3-6's approved scope. |
| A40 | At `54cb972`, with credentials **planted** and no hand-stripping, `npm test` is green: 247 files, 3215 tests, exit 0 (21 s), zero violation lines. The full step 7 list equals the baseline; the integration suite is 38 passed, 25 skipped, 1 failed — the Floci `checkSecrets` gap, confirmed by test name. | Observed 2026-09-19, one full-validation run of 39 s (7.5). |
| A41 | A vitest `afterEach` that throws marks the **test** as failed (`Tests  1 failed`) and prints the thrown message in the run output. | Observed twice 2026-09-19: the planted-violation control (AC-0.3-4) and the budget-writer control (7.3). This is what lets the guard defeat a swallow. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| The guard's own test file dials `*.amazonaws.com` three times deliberately and drains them. Anything that logs at the dial therefore shows up in a **green** run and breaks AC-0.3-3's count. | This log, sections 3.2 and 4.1 |
| `git checkout -- <file>` restores from the index, not from HEAD, so it silently discards an uncommitted edit to that file. | This log, P34 |

### Added 2026-09-19 (WI-0.3 cleanup)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P36 | A file named in `vitest.config.ts`'s `setupFiles` is a config file. Changing it, **even by a comment only**, re-runs the full step 7 list, not just the docs gates. | The setup file executes in every worker before every test. "It is only a comment" is a claim about the diff, not about what ran. |

#### Mistakes already made, and their corrections (continued)

> This session added no new entry. Nothing was run out of order, no check gave a
> false result, and no edit had to be undone. The table above stands unchanged.

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A42 | At `e09d673`, with credentials **planted** and no hand-stripping, the proof is 9 PASS / `FAILS=0` / exit 0, and the full step 7 list equals the baseline: `npm test` 247 files and 3215 tests, `guard-violations: 0`, integration 38 passed / 25 skipped / 1 failed (the Floci `checkSecrets` gap, by name), all 11 other gates exit 0. | Observed 2026-09-19, one proof run and one full-validation run (38 s). Same numbers as `54cb972` (A40). |
| A43 | The tripwire matches the **first** host-bearing argument it finds. Node's own rule for `http.request(url, options)` is that `options` takes precedence, so a call passing both, whose `options.hostname` is the AWS host and whose URL is not, would be read as the URL's host and pass. | Read 2026-09-19 against node's documented merge, not reproduced. No caller in this repository passes both forms; `@smithy/node-http-handler` passes a single options object (A38). Classified as debt, not patched — changing it is a behaviour change. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| `wi-0.3-proof.sh`'s AC-0.3-6 path count grows as a branch grows: it counts the whole branch against `origin/development`, so it read 4 at `54cb972` and 7 after the docs and cleanup commits. The criterion is "all inside the seam", never a fixed number. | This log, section 7.2 |

### Added 2026-09-19 (WI-0.3 verification)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P37 | When a handoff states a path count, re-derive it **at the commit its stamp names** before calling either the handoff or the document wrong. | The AC-0.3-6 count tracks the branch: 7 at `e09d673`, 8 at `3f9c94e`. Both documents were right about their own commit; only the incoming handoff, which repeated 7 for HEAD, was stale. |
| P38 | Before accepting a guard that patches a builtin, prove nothing else reassigns that builtin. Grep the whole tree for assignments to it and for interception libraries, unpiped. | A single `http.request = …` later in a worker silently disarms layer 2, and every count in this work item would still look green. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M45 | This session ran `grep … \| head -5` and read the pipeline's exit code as grep's, concluding "0 = found" for the interception-library check. That is **M13**, committed inside a VERIFICATION whose job is to score exit codes. | One check was void for one turn. Caught immediately because the printed output was empty while the reported code said otherwise — the contradiction, not the code, is what exposed it. | Re-ran unpiped: grep exits 1, no interception library exists, and `package.json` declares none. | M13 is not a rule about `tail`. Any pipeline reports the LAST command's status. When a check's output and its exit code disagree, the exit code is the one that is lying. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A44 | At `3f9c94e`, with credentials **planted** and no hand-stripping, `wi-0.3-proof.sh` is 9 PASS / `FAILS=0` / exit 0 with 0 changed paths, and the full step 7 list equals the baseline: `npm test` 247 files / 3215 tests, `guard-violations: 0`, integration 38 passed / 25 skipped / 1 failed (the Floci `checkSecrets` gap, confirmed by name), all 11 other gates exit 0. | Observed 2026-09-19 by a fresh critic, one proof run and one full-validation run (38 s). Same numbers as `54cb972` (A40) and `e09d673` (A42). |
| A45 | Layer 1 neutralises the env, ini/process and IMDS members of the SDK's node provider chain, but **not** `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `_FULL_URI` or `AWS_WEB_IDENTITY_TOKEN_FILE` / `AWS_ROLE_ARN`. Layer 2 refuses the `*.amazonaws.com` call that either would eventually make, so no test can reach real AWS. | Read 2026-09-19 against `vitest.setup.ts:32-37,66-73`; none of the four is set on this machine (`env` grep exits 1). The container path's link-local fetch itself is not refused — it returns credentials only. Classified as debt (4.2), not patched. |
| A46 | Nothing outside `vitest.setup.ts` reassigns `http`/`https` `request` or `get` in `src`, `infra` or `scripts`, and no HTTP-interception library (`nock`, `msw`, `@mswjs`) is imported or declared. | Observed 2026-09-19, both greps unpiped and both exit 1. Re-run after any new test-tooling dependency. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| AC-0.3-6's path count is **7 at `e09d673` and 8 at `3f9c94e`**. A handoff that states one number for "HEAD" goes stale the moment a docs commit lands. Score the criterion, which is "all inside the seam". | This log, 3.1 (V4) and P37 |
| `wi-0.3-proof.sh` measures scope with two-dot `git diff --name-only $BASE HEAD`, while the handoff's V4 says three-dot. They agree **only while the merge base equals `origin/development`**. It does here (`merge-base` = `0f41b53` = `origin/development`). If `development` moves ahead, the two-dot form starts reporting development's own files as scope violations. | This log, 7.2 |

### Added 2026-09-19 (WI-0.3 landing)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P39 | A documentation amendment describes the branch it lands on, not the branch it was written on. Before amending `development.md` about behaviour that exists only on an unmerged branch, land that branch first — or word the amendment so it is true on the branch it merges into, and name the branches that lack the behaviour. | The drafted WI-0.3 amendment retires hand-stripping. Merged into `development` ahead of the guard, it would tell every reader of `development` that `npm test` is safe there, when it is not. The `tsconfig.json` line states the same fact mechanically: it type-checks a file that does not exist on `development`, so typecheck fails outright. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M46 | This session ran one read-only `grep -n "^## "` over two session logs, to find section offsets, **before** its Step-0 declaration. That is **M39**, repeated exactly, one session later. | None to the work: it changed nothing and the declaration did not rest on it. It broke P19's order again. | Declared in the Step-0 declaration itself, as M39 did. | M39's correction — "do Step 0's reading with the Read tool only" — covers the command you run to decide *where* to read. Looking up a section offset is still a command. Read the file, or let the declaration come first. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A47 | At `50cfd5b`, with credentials **planted** and no hand-stripping, the full step 7 list equals the baseline: `npm test` 247 files / 3215 tests, `guard-violations: 0`, integration 38 passed / 25 skipped / 1 failed (the Floci `checkSecrets` gap, confirmed by name), all 11 other gates exit 0, and 0 changed paths are left behind. | Observed 2026-09-19 (2026-09-20T03:49Z), one run of 50 s. Same numbers as `54cb972` (A40), `e09d673` (A42) and `3f9c94e` (A44). |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| The drafted amendment's new AWS-safety layer 5 says `vitest.setup.ts` neutralises "every credential source". **A45** says it does not. Narrow that sentence before the draft is applied, or `development.md` inherits the overstatement. | This log, 4.2 |

#### Standing assumptions (continued, this session)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A48 | At `fa3b294`, with every AWS credential source **stripped**, the full step 7 list equals the baseline: `npm test` 247 files / 3215 tests, `guard-violations: 0`, integration 38 passed / 25 skipped / 1 failed (the Floci `checkSecrets` gap, confirmed by name), all 11 other gates exit 0, 0 changed paths left behind. | Observed 2026-09-20T03:58:55Z–03:59:34Z, one run of 39 s, **alone in the checkout**. Same numbers as A40, A42, A44 and A47, which ran in `plant` mode. |

#### Process precautions (continued, this session)

| # | Precaution | Why it exists |
|---|---|---|
| P40 | A session log's "pushed" and "HEAD" fields are true only at the commit that contains them. Before acting on either, re-derive them with `git rev-parse HEAD`, `git rev-parse origin/<branch>` and `git status --porcelain`. | The incoming handoff, the state file's STOPPED block and the previous session's log each named a different HEAD (`50cfd5b` vs `fa3b294`) and a different push state. Only the repository was right. |
| P41 | When two agents may share a checkout, a passing validation run proves nothing. Establish sole occupancy first, then run the gates. | The collision's only real cost: two concurrent `npm run build` runs in one tree made an otherwise-matching step 7 result untrustworthy, and it had to be paid for with a second full run. |

### Added 2026-09-20 (`development.md` AWS-guard amendment)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P42 | When an approved edit adds an item to a numbered list or changes the numbers in a table row, re-read what sits **around** it — the list's lead-in sentence, the row's qualifier text — before applying it. Fix the surround in the same change or ask, but never ship a list whose lead-in contradicts it. | M47. The drafted amendment added a fifth AWS-safety layer under "Four independent layers:", and refreshing the `npm test` row's counts alone would have left it telling the reader to strip credentials on the same page that had just stopped requiring it. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M47 | The `development.md` re-amendment drafted in the WI-0.3 specification log section 6.3 adds a fifth AWS-safety layer, but its diff does not touch the lead-in sentence "Local development cannot reach a real AWS environment. Four independent layers:". | Applied verbatim, the page would have said "Four" and listed five — a self-contradiction introduced by the fix itself. Caught before the commit, so nothing shipped. | The one-word change was put to the owner in the applying conversation and approved there (4.2). The drafted text is otherwise unchanged apart from the layer-5 narrowing the handoff required. | A drafted diff is reviewed against the page it lands on, not only against itself. The `-`/`+` lines can be perfect while the paragraph around them goes wrong. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A49 | At `e76538d`, with every AWS credential source **stripped**, the full step 7 list equals the baseline: `npm test` 247 files / 3215 tests, `guard-violations: 0`, integration 38 passed / 25 skipped / 1 failed (the Floci `checkSecrets` gap, confirmed by name), all 11 other gates exit 0, 0 changed paths left behind. | Observed 2026-09-20T22:41:07Z–22:41:47Z, one run of 40 s, alone in the checkout (P41). Same numbers as A40, A42, A44, A47 and A48. |
| A50 | At `e76538d`, with well-formed **fake** credentials planted in the environment and no hand-stripping, `npm test` is green: 247 files / 3215 tests, exit 0, zero violation lines, 0 changed paths. | Observed 2026-09-20, one run. This is the run that evidences the amended claim "hand-stripping is no longer required"; the planted account does not exist, so a leaked dial would mutate nothing. The live `netzer-process` profile was never used (constraint 8). |
| A51 | `vitest.setup.ts` is now covered by `npm run typecheck`. | Observed 2026-09-20: `tsc -p tsconfig.json --listFiles` names the file after the `include` change, and `npm run typecheck` exits 0. This **resolves A39**. |

#### Known traps that cost time (continued)

> No new trap this session. The trap the landing log recorded — layer 5's "every credential source"
> overstatement — is **RESOLVED (`e76538d`)** by the narrowing in 4.1.


### Added 2026-09-20 (WI-0.4 specification)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P43 | For a documentation work item, establish what the gates **cannot** see before choosing the failing evidence. Run them on the untouched tree first. | Every docs gate is green at `eee0a83` while `netzar-chat/README.md` says the port is unimplemented and `HANDOFF.md` says it was never pushed. A gate proves shape; only a per-claim table proves truth. |
| P44 | Do not let a delegated builder write the session log. Its own record of what a session observed is the one artifact the session must author. | **P2/M5**. A builder that did not run the baseline cannot honestly record it, and the log is the file the honesty rules are checked against afterwards. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M48 | The proof's first `4-dep` row was written as "no landed CHATUI item still claims `deployment: none`". CHATUI-001..006 carry **no** `deployment` key at all, so the row passed by construction on the red tree. | A green-by-construction criterion inside the gate written to catch exactly that — **M41**, one work item later. | Rewritten as the positive claim: each of CHATUI-001..006 must *declare* a deployment that is not `none`, plus a new `4-evi` row that proves the staging claim against the repository (`b3b4274` is an ancestor of `origin/staging`). Red went 23 → 24. | State a criterion as what must be **present**, never as what must be absent, whenever the absent thing might never have existed. |
| M49 | The incoming handoff recorded, from WI-0.1's cleanup, that `request-lifecycle.md` line 51 still carried the stale `TOOL_LOOP_MAX_TOKENS` sentence, and WI-0.4 was framed partly around fixing it. | None — it was checked rather than assumed. At `eee0a83` the constant survives in exactly **one** place in the mapped diagrams: line 2 of `request-lifecycle.md`, the `drift-gate` provenance note, which records what PR #96 did and is correct history. The prose sentence was already fixed in WI-0.2. | Row `5-b` now pins that exact state (0 hits in `architecture-security.md`, exactly 1 in `request-lifecycle.md`) so a future edit cannot quietly reintroduce it. | A carried debt entry is a lead, not a finding — **M35**. Re-derive it at the current commit before scoping work around it. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A52 | At `eee0a83`, with every AWS credential source stripped, `npm test` is green: 247 files / 3215 tests, exit 0, 0 violation lines, 0 changed paths. | Observed 2026-09-20, one run. Same numbers as A48/A49/A50. |
| A53 | The LibreChat chat UI port is merged into `development` (PR **#129**, merge `b3b4274`, 2026-08-27) and is present on `origin/qa` and `origin/staging`, but **not** on `origin/production`. | Observed 2026-09-20 with `git merge-base --is-ancestor b3b4274 origin/<ref>`: exit 0 for development, qa and staging; non-zero for production. |
| A54 | **No** mapped diagram source is a `web/` file. `docs/diagrams.map` lists only paths under `infra/`, `src/` and `scripts/`, and neither `architecture-security.md` nor `request-lifecycle.md` mentions the Chat tab, `Chat.tsx` or LibreChat at all (grep exits 1). | Observed 2026-09-20. So WI-0.4's "update the mapped diagrams" obligation is **conditional and unmet**: a documentation-only refresh of the chat folder touches no mapped source, and no diagram has to move. Criteria `5-a`/`5-b` prove that rather than assume it. |
| A55 | The remote branch `feature/librechat-chat-ui` @ `60078be` still exists on `origin` and is fully contained in `development`. | Observed 2026-09-20 (`git ls-remote`, then `merge-base --is-ancestor` exit 0). `development.md` step 9 says a transient branch is deleted once it merges, so this is a live violation of the long-lived-branch rule. **Classified: technical debt, offered to the owner, not patched** — deleting a remote branch is outside this session's authorization. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| `docs/features/netzar-chat/plan.md` writes the doc owner as `paperclip/bar-and-phases.md`. That looks broken but is correct: read relative to `docs/features/`, the file is `docs/features/paperclip/bar-and-phases.md`. Do not "fix" it. | This log, 6.2 |
| Every documentation gate passes on a chat folder whose three documents are substantially false. Do not read a green Docs CI as a truthful folder. | This log, 4 and P43 |


### Added 2026-09-20 (WI-0.4 implementation)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P45 | When a session log moves into a **different** feature folder than the one its carried ledger was written in, repoint the carried ledger's relative links so they still resolve, and say in the log exactly which ones moved. The prose is carried verbatim; a link target is a mechanical address, not text. | This session's ledger came from `chat-history-integrity/handoffs/` and landed in `netzar-chat/handoffs/`. Five links (`./2026-09-17-docgen-crash-wip-transfer.md` ×3, "This feature's `../README.md`" ×2) pointed at the old folder. Carried untouched they would have failed `docs-links.mjs` or, worse, silently resolved to the **wrong** feature's README. |
| P46 | Before delegating, read the builder's own launch contract as well as the work order, and remove any instruction the two disagree about. | M50. The work order told Codex to commit before running the proof; the runner's delegated-build path tells the builder not to commit. The builder obeyed the runner, so the proof it was handed could not pass by construction, and its "FAILS=24" was an artifact rather than a result. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M50 | The WI-0.4 work order's PROOF block said "commit your changes before running it. One commit is enough". The `claudex-loop` runner's delegated-build path instructs the builder not to create commits. | None to the documents. But Codex reported `FAILS=24` — the untouched baseline — and could not evidence its own work, so the entire proof burden fell to the coordinator. A reader of the Codex report alone would have concluded the build failed. | The coordinator committed the three files (`bcb7258`) and ran the proof itself: `FAILS=1`, only row `6-d`. No correction round was spent, because the documents themselves were right. | A proof a delegated builder is forbidden to satisfy is not a proof. Check the work order against the launch mechanism, not only against the specification. This is **P20** in a new form: there the blocker was the sandbox, here it is the runner's own policy. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A56 | At `bcb7258`, `wi-0.4-proof.sh` reports **`FAILS=1`, exit 1**, and the only failing row is `6-d` (this session's own log, which `bcb7258` predates). The `CONTROL` row still reads `FAIL`, so the table can still fail. | Observed 2026-09-20, one run. Re-run after the log commit; the row flips there. |
| A57 | Codex `gpt-5.6-terra` at effort `high`, through `codex-build` (`workspace-write`), produced all three documents in **one** build of 560 s and stayed exactly inside the three-file seam: `git status --porcelain` listed those three paths and nothing else, and there were no untracked files. | Observed 2026-09-20. Usage: 1,037,183 input tokens (969,216 cached), 9,623 output. `codex-cli 0.154.0`. No MCP tool call appears in the run record (P16). |
| A58 | Every factual claim the new documents make was **re-derived from the repository by the coordinator, not accepted from the builder**: `web/src/pages/Chat.tsx` is 591 lines; `web/src/lib/chat/` holds 8 modules; `web/src/components/chat/` holds 17 top-level files plus `lc/`; `b3b427497d63d8f4d1faa147b46c9681c19bc460` is an ancestor of `origin/development`, `origin/qa` and `origin/staging` and **not** of `origin/production`; all seven files named in the frontmatter and the implementation map are Git-tracked; `chat-source-contract.test.ts` is tracked nowhere. | Observed 2026-09-20, each by its own command. All agreed with the document text. |
| A59 | `wi-0.4-proof.sh` was not modified by the build. Its SHA-256 is `31c048ea7632d30b42af3d60fc5b3c85752debaf3c0a21c6ead62a9985a8b32d` and its mtime is 2026-09-20T20:16:29, before the build started. | Observed 2026-09-20. It also lives outside the workspace, which Codex's `workspace-write` sandbox cannot write to. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| Codex's sandbox has no network, so `scripts/ci/docs-mermaid.mjs` cannot run there: it tries to fetch `@mermaid-js/mermaid-cli` and gets `ENOTFOUND registry.npmjs.org`. A builder reporting that gate as blocked is stating an environment result. Run it on the host. | This log, 7.2 |
| `plan.md` has **no** `**Dependencies.**` line at all, so "CHATUI-007 must not appear in a Dependencies line" is satisfied vacuously. Do not record it as a check that measured something. | This log, 6.3 |

### Added 2026-09-20 (WI-0.4 cleanup)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P47 | When a finding says "a row was removed from a table, confirm the remaining one is right", decide it by re-deriving whether the removed row's risk still holds **in the code**, never by checking whether its owning backlog item has landed. A mitigation landing is not the risk ending. | F3. The opacity-modifier row was dropped because CHATUI-001 had landed. CHATUI-001 added the alpha-capable `-a` keys **beside** the raw `var()` semantic keys rather than replacing them, so `bg-primary/10` still emits no CSS, and 177 occurrences of the pattern are still in `web/src`. The row was live, not stale. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M51 | The incoming CLEANUP handoff located F1's wording in "README §2 and §5". Section 5's implementation map carries no count at all — its `Chat UI` row names the directory and its behaviour, and nothing else. | None: it was checked before editing rather than assumed, so no true sentence was rewritten to fix a problem it did not have. | `grep -n 17` over the README returns three lines, exactly one of which is the claim (§2). Only §2 changed. | **M35/M49 again.** A handoff's *location* list is a lead, just as its findings are. Re-derive where a claim actually lives before editing there. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A60 | `web/src/components/chat/` holds 17 top-level files: 15 `.tsx` files that each export at least one component, plus `conversation-groups.ts` (a helper) and `useChatScroll.ts` (a hook), beside the `lc/` directory. | Observed 2026-09-20 by listing the directory and grepping each `.tsx` for an exported capitalised function or const. The 15 export **at least** one component each, so "15 component files" is the safe noun; "15 components" would undercount. |
| A61 | An opacity modifier on a plain semantic Tailwind key emits no CSS in this app, and 177 occurrences remain in `web/src` — **0** of them under `web/src/components/chat/`, `web/src/pages/Chat.tsx` or `web/src/lib/chat/`. | Observed 2026-09-20 by grep. The no-op itself is asserted by `web/tailwind.config.ts`'s own present-tense comment at the `-a` block, not re-proved by building the CSS. Classified as pre-existing, app-wide technical debt (6.3), offered to the owner and not patched. |
| A62 | At `b37f913`, `wi-0.4-proof.sh` is `FAILS=0`, exit 0, the `CONTROL` row still reads `FAIL`, and the 5 changed paths are all Markdown under `docs/features/netzar-chat/`. | Observed 2026-09-20, one run. The same numbers as the `401959d` baseline this phase started from. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| The Bash tool's shell is zsh, so an **unquoted** `--include=*.md` is glob-expanded before `grep` sees it and the command dies with `no matches found: --include=*.md`. Quote it: `--include='*.md'`. This is the zsh family of M27/M28 in a new place — the argument that fails is not a parameter expansion this time, it is a flag's value. | This log, 6.2 |


### Added 2026-09-20 (WI-0.4 verification)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P48 | Write a "the document must NOT say X" proof row so that markdown emphasis cannot dodge it. Match the claim, not one literal spelling of it — or assert the positive instead (**M48**). | Row `1-a` is `grep -qF "Pushed: no"` over `HANDOFF.md`. The file says `Pushed: **no**.`, which `grep -F` cannot match, so the row passes on the bold markers rather than on the claim. Here the document is genuinely truthful — the branch really is unpushed and the *feature* really did merge as PR #129 — but the row would pass identically on a **false** bolded "Pushed: **no**". |
| P49 | When a document's claim can be settled by *running* the build instead of by reading a source comment that asserts it, run the build. Keep the comment as the explanation, never as the evidence. | **M3**: comments are not authorities. CLEANUP correctly restored README §7's opacity row but rested its central claim on `web/tailwind.config.ts`'s own present-tense comment, and said so honestly (**A61**). One `npm --prefix web run build` plus a grep of the emitted CSS turns that assertion into proof (6.3), and the build output is gitignored so it costs nothing. |

#### Mistakes already made, and their corrections (continued)

> **This session added no new mistake.** Nothing ran out of order, no check returned a false result,
> no finding had to be withdrawn, and no edit had to be undone. The table above stands unchanged.
> Two things that *could* have become mistakes — a proof row that passes for the wrong reason, and a
> ledger count that disagrees with a re-derivation — are recorded as a precaution (P48) and an
> assumption (A65) rather than as errors, because neither made any document or any result wrong.

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A63 | `wi-0.4-proof.sh` reads `FAILS=24` at `eee0a83`, `FAILS=0` at `401959d`, `FAILS=0` at `b37f913` and `FAILS=0` at `ef804f7`, and the `CONTROL` row reads `FAIL` at **all four**. Changed Markdown paths: 0, 5, 5, 6. | Observed 2026-09-20 by the fresh critic, one run per commit. The control failing at every commit is what makes the red→green transition meaningful rather than a table that cannot fail (**P18**). This reproduces, independently, every number `HANDOFF.md`'s "last checks" line records. |
| A64 | **An opacity modifier on a raw `var()` semantic Tailwind key emits no CSS — proved by building, not asserted.** In the emitted sheet (`dist/web/assets/index-*.css`, 85,537 bytes) `.bg-primary\/10`, `.bg-primary\/5`, `.ring-primary\/50`, `.bg-danger\/10`, `.border-danger\/30`, `.bg-success\/10`, `.bg-warning\/10` and `.text-muted\/70` each occur **0** times, while `.bg-primary{` and `.bg-danger{` occur once each and the `-a` siblings `.bg-primary-a\/10`, `.bg-primary-a\/40`, `.bg-danger-a\/10`, `.border-danger-a\/40`, `.border-primary-a\/25` are all emitted. | Observed 2026-09-20, one `npm --prefix web run build` (exit 0) alone in the checkout. **This upgrades A61's evidence**, which explicitly rested on the config comment. Both controls fire, so the zeros are a real absence and not a grep artifact. Of the 23 escaped-slash rules in the whole sheet, every colour one is either a palette colour (`black/50`, `blue-500/10`, `pink-500/5`, `purple-500/10`, `white/90`) or an `-a` sibling. |
| A65 | The count of opacity modifiers on raw semantic keys in `web/src` is **181** by utility-prefix grep over every raw-`var()` key in `tailwind.config.ts`, and **177** when the `textColor` block is excluded. The 4-hit gap is exactly `text-muted/<n>`, whose key lives in `textColor` rather than `colors`. **0** either way under `web/src/components/chat/`, `web/src/pages/Chat.tsx` and `web/src/lib/chat/`. | Observed 2026-09-20. Per key: `primary` 97, `danger` 49, `warning` 15, `success` 13, `muted` 4, `surface` 2, `bg-sunken` 1. **A61's 177 is not wrong and neither is 181** — they are two defensible pattern sets, and the README row deliberately carries *no number*, only "zero in the chat subtree, the rest of `web/src` still has them", which both counts confirm. Say which pattern produced a count before comparing it to another. |
| A66 | Section 5 of `2026-09-20-wi-0.4-cleanup.md` differs from section 5 of `2026-09-20-wi-0.4-implementation.md` by **additions only**: `diff` emits 35 lines, every one a `>`, being the 4 preamble quote lines and the appended `Added 2026-09-20 (WI-0.4 cleanup)` block. Zero deletions, zero modifications. | Observed 2026-09-20 by extracting §5 from both at `ef804f7` and diffing. That is the machine definition of a verbatim carry, and it is how a carry should be checked (**do not eyeball it**). |
| A67 | Every `as_of_commit` in `docs/features/netzar-chat/` at `ef804f7` names an ancestor of HEAD: `HANDOFF.md`, `README.md`, `plan.md` and the specification log stamp `eee0a83`; the implementation log stamps `bcb7258`; the cleanup log stamps `b37f913`; the three 2026-08 logs stamp their own commits. | Observed 2026-09-20, `merge-base --is-ancestor` for all nine. The three canonical files stamping the *base* is correct, not stale: this work item changes **zero** files under `web/` or `src/`, so the source their claims describe is byte-identical at `eee0a83` and at `ef804f7`. Time-bound observations inside the text carry their own dates (**P23**). |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| Proof row `1-a` (`nope $HO "Pushed: no"`) passes because `HANDOFF.md` writes `Pushed: **no**` in bold, not because the claim is true. The claim *is* true here, verified separately with `git ls-remote --heads origin docs/wi-0.4-chat-docs` (empty). Do not read that row as evidence about push state. | This log, 6.4 and **P48** |
| `netzar-chat-plan/` is **not** in the checkout. It lives at `~/.claude/plans/netzar-chat-plan/`, so `bash netzar-chat-plan/wi-0.4-proof.sh` must be run from `~/.claude/plans`, not from the repository root. Running it from the repo gives "No such file or directory". | This log, 7.1 |
| `git check-ignore web/dist` exits 1, which looks like the web build would dirty the tree. It does not: `web/vite.config.ts:70` sets `outDir: '../dist/web'`, so the build writes to **root** `dist/`, which `.gitignore:7` covers. Check the configured `outDir` before concluding a build is unsafe to run. | This log, 6.3 |


### Added 2026-09-21 (WI-0.4 landing)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P50 | Before scoring an integration result against a baseline whose expected state is "1 failed", identify **which emulator** is answering on 4566. Name the image, not just the port. | The single expected failure is a **Floci-specific** gap: only Floci omits schedule-deleted secrets from `ListSecrets`, which is why `destroy.integration.test.ts > checkSecrets` fails. A stray LocalStack on the same port makes that test **pass**, so the run stops matching the baseline *in the direction that looks like good news*. `development.md` already forbids two emulators on 4566 (M7); this is the reason it matters at scoring time and not only at startup. |
| P51 | A landing session's own log belongs **on the branch it is landing**, committed and pushed before the merge, so the merged folder is complete. Its merge result cannot live in it (**P40**) and belongs in the state file. Budget for what that implies: a second CI cycle and a second full step-7 run on the new HEAD. | Otherwise the merged feature folder is missing the one log that records how it landed, and recovering it costs a second branch and a second PR. This is the shape WI-0.3's landing used (`4e9bd35`), and the handoff's "if the push adds a commit, step 7 runs again on the new HEAD" is the clause that pays for it. |

#### Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M52 | This session tallied the proof's passing rows with `grep -c "^PASS"`. The proof emits a Markdown **table**, so its rows read `\| 1-a \| … \| PASS \|` and nothing starts with `PASS`. The tally returned **0**. | **None. The wrong number was never recorded.** `0` contradicted the script's own `FAILS=0` and `exit 0`, which were already authoritative, so the contradiction was visible immediately; the format was re-derived in the same turn and the real count is **39**. | Re-counted with `grep -c 'PASS'` against the actual output format, and the row shape was printed alongside it as evidence rather than assumed. | **M27/M28/M35 in a new place.** A check that reads the wrong input returns a number, not an error. Here the wrong answer happened to be *implausible*, which is the only reason it was cheap — had the anchor matched by accident, `0` would have looked like a finding. Anchor a tally to the output format you have just looked at, and when a tally disagrees with the script's own summary line, the tally is what is wrong. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A68 | Two listeners exist on this machine and **neither is in this checkout**: port 4566 is `netzer-os-floci` (`floci/floci:1.6.0`, healthy, up 5 weeks), and port 5173 is a Vite dev server owned by a *different* clone, `Documents/Github Reposetories/Netzer-Labs/web/`. Nothing listens on 3000, so no orchestrator is driving Floci. | Observed 2026-09-21 via `docker ps` and `lsof`/`ps` on the listening PID. Sole occupancy of the **checkout** is what P41 requires, and it holds: no process names the clone, no `index.lock`, one worktree. Re-identify both before any future step-7 run — see **P50**. |
| A69 | At `d628359`, with every AWS credential source **stripped**, the full step 7 list equals the baseline: `npm test` 247 files / 3215 tests exit 0, `guard-violations: 0`; integration 38 passed / 25 skipped / 1 failed (the Floci `checkSecrets` gap, confirmed **by name**); all 11 other gates exit 0; 0 changed paths left behind. | Observed 2026-09-21T14:38:08Z–14:38:46Z, one run of 38 s, alone in the checkout (P41). Same numbers as A48, A49 and A52. `npm run local:verify` passed positively, returning account `000000000000`. |
| A70 | At `d628359`, `wi-0.4-proof.sh` reports **`FAILS=0`, exit 0, 39 rows PASS**, the `CONTROL` row still reads `FAIL`, and the 7 changed paths are every one a Markdown file under `docs/features/netzar-chat/`. The five documentation gates all exit 0: `docs-links` 201 files / 3122 links, `feature-knowledge` OK, `docs-mermaid` OK, `docs-assets` OK (1.98 MB), `git diff --check` 0. | Observed 2026-09-21, one run each, tree clean before and after. Reproduces the fresh critic's post-commit numbers at the same commit exactly. |

#### Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| The proof prints a Markdown table, so `grep -c "^PASS"` counts **zero** passing rows. Count `PASS` anywhere in the line, and prefer the script's own `FAILS=` summary and exit code over any hand tally. | This log, **M52** |
| A healthy container on 4566 is not automatically Floci. Confirm the image before reading an integration result as "the known failure". | This log, 3.1 and **P50** |


### Added 2026-09-21 (final P0 verification)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P52 | When scoring "no test reached AWS", grep the run log for the **host pattern itself**, not only for the guard's `NETZAR-AWS-GUARD VIOLATION` line. Then explain every hit. | The tripwire patches `http`/`https` `request`/`get` and deliberately **does not patch `fetch`** (the SDK dials node http, A38). So a `fetch` to an AWS host leaves the violation count at **0** while the log still names the host. A zero count is necessary, not sufficient. Here there was exactly one hit and it was proved to be a stub — see **A72** — but the count alone could never have told you that. |

#### Mistakes already made, and their corrections (continued)

> **This session added no new mistake.** Nothing ran out of order, no check returned a false result,
> no finding had to be withdrawn, and nothing had to be undone. The table above stands unchanged.
> One thing that *could* have become a mistake — reading `grep -q 'amazonaws.com'` exiting 0 as a gate
> failure — did not, because the hit was investigated to its source before anything was concluded. It is
> recorded as a precaution (**P52**) and an assumption (**A72**), not as an error.

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A71 | At `08f85db` — P0's final HEAD, the merge commit of PR #182 — with every AWS credential source **stripped**, the full step 7 list equals the baseline: `npm test` **247 files / 3215 tests**, exit 0, `guard-violations: 0`; integration **38 passed / 25 skipped / 1 failed**, the Floci `checkSecrets` gap confirmed **by name**; all 11 other gates exit 0; **0 changed paths**. Docs numbers: `docs-links` 202 files / 3167 links, `feature-knowledge` OK, `docs-assets` OK (1.98 MB), `git diff --check` 0, and `docs-mermaid` OK as an extra. `npm run local:verify` returned account `000000000000`. | Observed 2026-09-21T15:43:59Z-15:44:47Z, one run of 48 s, alone in the checkout (P41), emulator identified first (P50). Same numbers as A48, A49, A52 and A69 — the merge commit adds no file beyond `25f0694`'s. |
| A72 | The `npm test` log at `08f85db` contains the string `amazonaws.com` **exactly once**, and that line is a **fixture, not a dial**: `src/lib/mcp/mcp.test.ts:20` declares `https://abc.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp` and `:169` does `vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))`. The logged result is `MCP tools/list HTTP 500: boom`. | Observed 2026-09-21. **The proof is the 500 itself**: a host that does not exist cannot answer `500` — an unstubbed call would have produced `ENOTFOUND`. So no network call was made, and the guard's zero count is consistent rather than merely quiet. See **P52** for why this was checked at all. |
| A73 | The Vite dev server listening on `:5173` belongs to `/Users/emmanueladams/.Trash/Netzer-Labs/web` — a checkout that has been **moved to the Trash** and whose dev server is still running from there. Nothing listens on 3000. | Observed 2026-09-21 via `lsof -a -p <pid> -d cwd`. **This corrects A68**, which recorded the address as `Documents/Github Reposetories/Netzer-Labs/web`; that clone moved between 2026-09-21 morning and midday. Neither address is this clone, so sole occupancy of the checkout is unaffected — but a server running out of the Trash will vanish without warning the moment the Trash is emptied, so do not build anything on it. |
| A74 | Of the **seven** P0 merges into `development`, exactly **three** touched a file that `docs/diagrams.map` lists as a source — `264d024` (#176: `infra/lib/constants.ts`, `src/adapters/dashboard/handler.ts`, `src/agent/agent-loop.ts`, `src/lib/state/sessions-repo.ts`), `b152b7a` (#177) and `0f41b53` (#179) (both: `src/agent/agent-loop.ts`, `src/lib/state/sessions-repo.ts`) — and **all three carry both `docs/diagrams/architecture-security.md` and `docs/diagrams/request-lifecycle.md` in the same merge diff**. The other four (`33d9126`, `90586e8`, `eee0a83`, `08f85db`) touch **no** mapped source, so the obligation does not fire for them. | Observed 2026-09-21 by intersecting `git diff --name-only <merge>^1 <merge>` with the 35 source paths in `docs/diagrams.map` at HEAD, per merge. **This is A54 proved rather than assumed** for WI-0.4: `08f85db`'s eight changed paths are every one a Markdown file under `docs/features/netzar-chat/`. |


### Added 2026-09-21 (F1 specification)

#### Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P53 | The Gauntlet state file has two possible writers — the foreground session and a background comment-reply session. Before adding an owner-decision row, grep for the number you are about to use. | **M53**, below, is what happens otherwise. Done this session: the highest existing row was 30, so the new one is 31, confirmed by grep before it was written. |
| P54 | A proof row that COUNTS things in a config file must have its count re-derived against the real file before the row's first run. | This session's first draft of `L-i` counted job keys with `grep -cE "^  [a-z0-9-]+:$"`. That pattern also matches `push:` under `on:`, so it would have read **6** at HEAD — the exact number the row demands after F1 lands — and the row would have been **green by construction** in the gate written to catch that. **M41/M48 again, a third time.** Caught by running the count against `ci.yml` before the first execution; rewritten as an `awk` scan of the `jobs:` block, which reads 5 today. |
| P55 | Classify the implementation provider from **what can run the proof**, not from what can write the diff. | The approved plan classified this harness as `CODEX_ELIGIBILITY: YES` (WI-V.1, "bounded harness scaffolding"). It is not: the only row that proves the deliverable works, `L-k`, needs a Playwright browser download and a live dev server, and Codex's sandbox has **no network** — the same wall that stopped `docs-mermaid` running there in WI-0.4. A builder that cannot run its own proof returns guessed selectors and every iteration lands on the coordinator anyway. |

#### Mistakes already made, and their corrections (continued)

> **This session added no new mistake of its own.** Nothing ran out of order, no check returned a
> false result, no finding had to be withdrawn, and nothing had to be undone. Two things that
> *could* have become mistakes — a proof row that would have passed by construction, and a provider
> classification inherited from the plan without testing it against the sandbox — are recorded as
> precautions (**P54**, **P55**) rather than as errors, because neither reached a run or a handoff.
>
> **M53 is carried in for the first time.** It happened on 2026-09-21 and was recorded only in
> `netzar-chat-plan/overnight/ledger.txt`, outside the repository, so no feature-folder ledger has
> ever held it. It belongs here.

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M53 | A background comment-reply session and the foreground session edited the Gauntlet **state file** at the same moment, each writing its own STOP banner, replan handoff and owner-decision rows **29** and **30**. | The file carried **duplicate** rows for both numbers, and two different worked roadmaps (an 8-step guess and a 9-step list) for the same decision. | Caught by counting rows per number before replying, not by reading the prose. Reconciled by keeping the background session's rows — its 9-step list was the worked one, and it had already corrected its own "likely 8" guess — deleting the foreground duplicates, and merging in the two evidence points only the foreground session had. Decision 27 was reworded from "SUPERSEDED" to "ON HOLD" to match. | **P41 is about the repository checkout. It says nothing about the STATE FILE**, which a background session can write at any moment. Grep for the row number before you add it — **P53**. |

#### Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A75 | The chat mock (`CCE_CHAT_MOCK=1`) can drive the Chat screen locally but **cannot reload a conversation**. `GET /api/sessions/transcript` answers **`200 {"turns":[]}`** for every id, because `web/dev/mock-stream-plugin.ts:193` returns a hard-coded `json(res, { turns: [] })`, while `GET /api/sessions` returns **11** rows (`agentId, chatId, updatedAt, messageCount, firstMessage`) and `GET /api/agents` returns **19**. | Observed 2026-09-21 by **running it** (P49), not by reading the plugin: a Vite dev server was started with the flag on port 5199 and the three routes were fetched. So the sidebar lists conversations you can click and the transcript comes back empty every time. The server was stopped and `lsof` confirmed the port free (**M19**). |
| A76 | Playwright is used by **7** scripts under `tests/e2e/` and declared by **nothing**: absent from `package.json` and `web/package.json`, 0 entries in either lockfile, and not present in `node_modules`. Two shapes coexist — `@playwright/test` (`tour/`, `jarvis/`) and raw `playwright` (`battle/`, `cost/`, `iam/`, `knowledge/`, `perf/`) — and **no npm script and no workflow runs any of them**. | Observed 2026-09-21. The repository already says so itself: `tests/e2e/iam/README.md:9` (`npm i --no-save playwright  # not a project dependency`) and `docs/missions-v2-backlog.md:247-251, 771-774` ("Playwright configs are present but `@playwright/test` is not a dependency and no workflow runs them… **Blocked on a decision**"). Owner decision 7 is that decision; F1 is where it lands. |
| A77 | **`development.md` *Known local limitations* item 14 is stale.** It says "Playwright e2e and k6 load tests target a deployed URL with a real token. Repointing them at the local dashboard was not attempted." `tests/e2e/battle/run.mjs:13`, `tests/e2e/knowledge/run.mjs:7` and `tests/e2e/perf/run.mjs:7` already default `CCE_BASE` to `http://127.0.0.1:5180/dashboard` and intercept `/api` wholesale, so it has not only been attempted, it shipped. | Observed 2026-09-21. `cost/run.mjs:10-11`, `iam/run.mjs:8-9`, `tour/` and `jarvis/` do target a deployment, so the sentence is half true, which is what makes it misleading. **Classified: a gap report against `development.md`, offered to the owner, NOT patched** — the process skill forbids editing that page to fill a gap, and amending it needs approval for that specific change in the conversation that applies it. It matters to F1 because it is the page a reader consults before deciding whether a local browser gate is even possible. |
| A78 | At `ea0a28f`, `f1-proof.sh` reads **`FAILS=10`, exit 10** in the local tier (1 row correctly *not assessable*) and **`FAILS=4`, exit 4** in the staging tier, and the `CONTROL` row reads **FAIL** in both. | Observed 2026-09-21, one run per tier. The staging tier's `S-b` **passes** — `verify-staging.js` really does exist and really does target `staging.pgnos.ai` — which is what shows that tier is measuring something rather than failing uniformly. |

## 6. What this phase did

### 6.1 The scope fork, resolved by the owner

The incoming handoff carried a fork at its top: build **F1** if owner decision 30 was accepted,
the approved plan's full **V1** if it was declined, and **ask** if it was unanswered. It was
unanswered, established from three places rather than assumed — the state file's own "STILL OWED"
list, an empty notification queue, and the progress page, whose 16:28 thread ends *"Nothing is
approved and nothing gets built until you say yes, no, or edit the list."* The owner's later
17:24 comment asked for the prompt for step 2 and was anchored on **V1**, the old step, so it did
not settle which list was in force.

Everything that did not depend on the answer was completed first — Step-0, the state
re-derivation, sole occupancy, the emulator's identity and the whole baseline — and then one
question was asked, with discovered / why / options / recommendation / what changes (constraint 2).

**The owner accepted: build F1.** The 9-step roadmap is in force; this is **step 2 of 9**.
Recorded as **owner decision 31**.

### 6.2 The seam, pinned

`/graft` was **not** run: it has no index for this clone and `graft build` writes an untracked
`graft/` into the checkout (carried trap). The seam was pinned by direct reading at coordinator
level, with the roster's read-only breadth agent alongside it (6.6).

F1 is three parts, and the seam is **four files**:

| Part | Seam | State today |
|---|---|---|
| A thin local harness | `tests/e2e/chat/*` (the home the approved plan already named, `netzar-chat-plan.md:350`) | **does not exist** |
| …the route it needs | `web/dev/mock-stream-plugin.ts:189-194` | exists, but returns an empty transcript — see below |
| …made runnable | `package.json` (a pinned Playwright devDependency + one script) | Playwright declared nowhere (**A76**) |
| ONE CI lane | `.github/workflows/ci.yml` | **5** jobs today; F1 makes it 6 |

**The decisive find is that the harness is blocked on one line, not on a missing framework.**
`Chat.tsx:177-198` reloads a conversation through
`api.get('/sessions/transcript?agentId=…&chatId=…')` (`:184-186`). The mock answers that route
with a hard-coded `json(res, { turns: [] })` (`mock-stream-plugin.ts:193`), and says so in its own
comment: *"an empty array is the honest answer for a chat this process never persisted."* It was
honest when the plugin only had to make the chat screen **screenshottable**. F1 asks it to make a
reload **drivable**, which is a different job.

Proved by running it, not by reading the comment (**P49/M3**): with `CCE_CHAT_MOCK=1` on a dev
server, `/api/sessions` returns **11 conversations** and `/api/agents` **19 agents**, while
`/api/sessions/transcript` returns `200 {"turns":[]}` for every id. So you can list conversations
and click one, and nothing ever comes back. **A75.**

### 6.3 The ONE failing gate, and why its red is the right red

`netzar-chat-plan/f1-proof.sh` — one executable gate, outside the repository (**P25**), two tiers
selected by `F1_TIER`. Shape rows read the repository at a rev through `git show`, never the
working tree. At `ea0a28f`:

- **local tier: `FAILS=10`, exit 10**, one row correctly *not assessable*, `CONTROL` **FAIL**
- **staging tier: `FAILS=4`, exit 4**, `S-b` **PASS**, `CONTROL` **FAIL**

**The red is for the right reason, traced row by row** — not a syntax error, not a bad fixture,
not missing credentials, not a baseline failure (the baseline is green, section 4):

| Row | Why it is red | How that was established |
|---|---|---|
| `L-a` | `tests/e2e/chat/` does not exist | the directory listing of `tests/e2e/` — 14 files, 7 subdirs, no `chat/` |
| `L-b`-`L-e` | consequences of `L-a`: there is no spec to read | not independent evidence, and not claimed as such |
| `L-f` | the mock returns a hard-coded empty transcript | **run, not grepped** — `200 {"turns":[]}` from a live dev server (**A75**) |
| `L-g` | Playwright is declared nowhere | absent from both `package.json` files, **0** lockfile entries, absent from `node_modules`; the repo already says so (**A76**) |
| `L-h` | no npm script runs any e2e suite | the full script list was read; the nearest is the unrelated k6 `loadtest` |
| `L-i` | `ci.yml` has 5 jobs, and none runs a chat suite | an `awk` scan of the `jobs:` block, re-derived against the real file (**P54**) |
| `L-j` | correctly **not assessable** until `L-i`'s job exists | gated deliberately — an ungated row would pass on a tree with no job at all (**M41**) |
| `L-k` | `npm run e2e:chat` does not exist | the behavioural row; it goes green only when the suite really runs |
| `S-a`, `S-c`-`S-e` | no staging token has ever existed | `bar/staging/VERIFY.json` read first-hand: 1 pass (HTTP 200) and **4 sign-in FAILs**, *"no STAGING_TOKEN … cannot verify authed surfaces"* |

The `CONTROL` row is a planted falsehood (`development.md` claiming Floci implements
`ConverseStream`). It reads **FAIL** in both tiers, and it is reported **outside** the score — a
control folded into `FAILS` would keep the gate red forever. If it ever reads PASS the table is
broken, not green, and the script exits 97 (**P18**).

### 6.4 Acceptance criteria — TWO TIERS

This is decision 30's core mechanic. The split is not "AWS on staging, UI on development", and
getting it backwards costs money: `development.md`'s *AWS dependency inventory* records DynamoDB
and S3 as **"Full, verified"** under Floci, so storage-shape work is genuinely real locally.
What Floci **stubs** is Bedrock (*Known local limitations* 1-4). **Model-dependent behaviour is
real only on staging; storage shape is already real locally.**

**Tier 1 — local / CI. Cheap, runs on every pull request. No AWS, no model, no deployment.**

| ID | Criterion | Proof row |
|---|---|---|
| AC-F1-L1 | `tests/e2e/chat/` exists and holds at least one test source | `L-a` |
| AC-F1-L2 | the suite targets the **local** dev server with the mock, never a deployed URL | `L-b` |
| AC-F1-L3 | it opens the dashboard chat route | `L-c` |
| AC-F1-L4 | it sends a message and asserts a streamed reply arrives | `L-d` |
| AC-F1-L5 | it **reloads a conversation** and asserts the stored turns come back | `L-e` |
| AC-F1-L6 | the mock's `/api/sessions/transcript` replays what it streamed instead of a hard-coded `[]` | `L-f` |
| AC-F1-L7 | Playwright is a **pinned** devDependency (owner decision 7) | `L-g` |
| AC-F1-L8 | one npm script runs the suite by name | `L-h` |
| AC-F1-L9 | `ci.yml` runs it on `pull_request` in **exactly one added job** (5 → 6) | `L-i` |
| AC-F1-L10 | that job starts no emulator: the repo still declares exactly one `4566` service | `L-j` |
| AC-F1-L11 | **the suite actually runs and passes** | `L-k` |
| AC-F1-7 | the FULL `development.md` step 7 list, on the exact HEAD pushed, = baseline | `wi-0.3-full-validation.sh` |

AC-F1-L1 through L10 are **shape**. A green Docs CI once sat on three substantially false
documents (**P43**), so shape is evidence, never proof. **AC-F1-L11 is the proof**, and AC-F1-7
is the pre-push gate with no per-change opt-out. Note that `package.json` and `ci.yml` are both
touched, so **P36 fires** for IMPLEMENTATION: step 7 runs in full whether or not anything is
pushed.

**Tier 2 — staging. Real DynamoDB, real S3, real Bedrock, real spend. Each run authorized
separately (owner decision 6 + constraint 8).**

Written as concrete actions against the deployed environment, not as assertions about a mock. The
script already exists, outside this repository, at
`netzer-devkit/archive/netzar-chat-qa/verify-staging.js`; it signs in at
`https://staging.pgnos.ai/dashboard/` with `STAGING_TOKEN` and writes `bar/staging/VERIFY.json`.

| ID | Criterion — the action performed | Proof row |
|---|---|---|
| AC-F1-S1 | a spend-capped `STAGING_TOKEN` exists and is supplied by the owner for that run | `S-a` |
| AC-F1-S2 | the QA script exists and targets the deployed dashboard | `S-b` |
| AC-F1-S3 | sign in on all four surfaces (light/dark × desktop/mobile) and record **zero** failing checks | `S-c` |
| AC-F1-S4 | send a real turn and observe **>2 growth frames** — a Floci stub emits one chunk, so this is unfakeable locally | `S-d` |
| AC-F1-S5 | observe a **live tool status**, which the stub's `stopReason: end_turn` can never reach | `S-e` |

AC-F1-S4 and S5 are the two criteria that justify the whole tier: they are exactly the behaviours
*Known local limitations* 2 and 3 say are unreachable on a developer machine by design.

**The token is the critical path.** CHATUI-008 has been `work_state: blocked` on owner decision 6
since August, and nothing downstream of F1 can be staging-verified until it exists. The token is
never printed, never written into a file, and never committed.

### 6.5 Provider selection

```text
CODEX_ELIGIBILITY: NO
```

**Reason: the only row that proves the deliverable works cannot run in Codex's sandbox.** AC-F1-L11
needs a Playwright browser download and a live Vite dev server; Codex's workspace-write sandbox has
**no network** — the same wall that stopped `docs-mermaid` running there during WI-0.4. A builder
that cannot execute its own proof returns guessed selectors, and every iteration lands on the
coordinator anyway (**P55**).

This **corrects the approved plan**, which classified this work as `CODEX_ELIGIBILITY: YES —
bounded harness scaffolding` (WI-V.1, suggested model Terra). The plan's classification is sound
about the *diff* and wrong about the *proof*. The plan's other half agrees with this session:
WI-V.3, the CI lane, was already `CODEX_ELIGIBILITY: NO`.

```text
IMPLEMENTATION_PROVIDER: CLAUDE
CLAUDE_MODEL: OPUS for the spec and the mock route; SONNET permitted for the
              package.json and ci.yml wiring
CODEX_ATTEMPTS_USED: 0 for this work item
```

Selector work against a live DOM is iterative debugging, which is Opus's band. Adding a pinned
dependency, one npm script and one CI job that copies the five action SHAs already in the file is
mechanical, which is Sonnet's.

### 6.6 AGENTS

- **`ecc:code-explorer` (read-only) — RAN.** Given the clone path and the commit **explicitly**,
  because a subagent inherits the coordinator's cwd and would otherwise read a different tree and
  report clean. It answered five breadth questions (e2e infrastructure, the chat dev harness, CI
  workflows, the staging QA artefacts, the CHATUI blocks). Its report **corroborated every fact
  the coordinator had derived independently** and added two the coordinator did not have: the
  local-dev-server Playwright precedent that makes **A77** a stale-documentation finding, and
  `docs/missions-v2-backlog.md:247-251, 771-774`, where the repository already records Playwright
  as present-but-unadopted and "blocked on a decision". Nothing it reported was accepted without
  a path and line number.
- **`/graft` — NOT run**, with reason: no index for this clone, and `graft build` would write an
  untracked `graft/` into the checkout.
- **No writer agent** ran. `ecc:build-error-resolver` and `ecc:code-simplifier` are **forbidden**
  in a SPECIFICATION; this phase changes no source file at all.
- **No review fan-out.** It runs at IMPLEMENTATION exit, and there is no implementation diff.
- **`ecc:council` — NOT fired.** Its two triggers are a Three-Strike escalation (none: no gate
  failed twice) and an owner-decision fork. The scope fork **was** an owner fork, and the handoff
  is explicit that it is the owner's to answer directly — convening a council to guess an answer
  the owner can give in one word would be the wrong instrument.

### 6.7 Classified, reported, NOT patched

Constraint 4: every discovered problem is classified and never patched opportunistically.

- **A77 — `development.md` *Known local limitations* item 14 is stale.** A **gap report**, not an
  edit: the process skill forbids editing that page to fill a gap, and an amendment needs approval
  for that specific change in the conversation that applies it. *Situation:* scoping a local
  browser gate. *Location:* item 14. *Why it matters:* it is the page a reader consults before
  deciding whether a local browser gate is possible at all, and it says the thing F1 depends on was
  never attempted. *Recommendation:* narrow the sentence to the suites it is true of, and name the
  three that already target the local dev server. *The ask:* approval to amend that one item.
- **A76 / `docs/missions-v2-backlog.md:247-251, 771-774`** — Playwright present but unadopted,
  recorded there as "blocked on a decision". Owner decision 7 **is** that decision; F1 lands it.
  No backlog edit made here.
- **A61 / A65** — 177-181 dead opacity modifiers app-wide, **0** in the chat subtree. Unchanged,
  pre-existing, offered to the owner, still not patched.
- **A55** — `feature/librechat-chat-ui` merged but still on `origin`, against `development.md`
  step 9. Deleting a remote branch is outside this session's authorization.
- **A43**, **A45**, **P48** — carried, unchanged, still not patched.

## 7. Commands actually run, and their real results

Everything below ran. Nothing is recorded that did not (**P2**).

| # | Command | Result |
|---|---|---|
| 1 | `git fetch origin`, then `rev-parse` HEAD + all four tips | exit 0; every tip as section 3 records |
| 2 | `ps`/`grep` for occupancy, `test -e .git/index.lock`, `git worktree list` | sole occupancy; no lock; one worktree |
| 3 | `docker ps`, `lsof -nP -iTCP:3000,4566,5173 -sTCP:LISTEN` | 4566 = `netzer-os-floci` `floci/floci:1.6.0` healthy (**P50**) |
| 4 | `FV_CREDS=strip FV_BASE=development bash netzar-chat-plan/wi-0.3-full-validation.sh` | **= BASELINE**, section 4 |
| 5 | `grep -c 'NETZAR-AWS-GUARD VIOLATION'` over the npm-test log | **0** |
| 6 | `git switch -c feat/f1-test-foundations origin/development` | exit 0, clean, `ls-remote` empty |
| 7 | `cp` the final P0 verification log in; `diff -q` against its source | **byte-identical**, exit 0 |
| 8 | the five docs gates, unpiped (**M13**), pre-commit | all exit 0 — `docs-links` 203 files / 3201 links |
| 9 | `git commit` → `ea0a28f` | 2 paths, both Markdown under `docs/features/netzar-chat/` |
| 10 | the five docs gates again, **post-commit at `ea0a28f`** | all exit 0; tree clean |
| 11 | `F1_TIER=local bash netzar-chat-plan/f1-proof.sh` | **`FAILS=10`, exit 10**, `L-j` not assessable, `CONTROL` FAIL |
| 12 | `F1_TIER=staging bash netzar-chat-plan/f1-proof.sh` | **`FAILS=4`, exit 4**, `S-b` PASS, `CONTROL` FAIL |
| 13 | `CCE_CHAT_MOCK=1 npm --prefix web run dev -- --port 5199 --strictPort`, then fetch three routes | transcript `200 {"turns":[]}`; sessions `200`, 11 rows; agents `200`, 19 rows (**A75**) |
| 14 | kill the dev server, then `lsof -nP -iTCP:5199 -sTCP:LISTEN` | exit 1 — port released (**M19**) |
| 15 | `git status --porcelain` after every step | empty |

**Not run, and not claimed:** the full `development.md` step 7 list on this log's own commit. It
is a pre-push gate, nothing is pushed here, and this phase changes no `src/`, `infra/`, `web/`,
`scripts/`, `tests/`, `package.json`, lockfile or `vitest.*` file, so **P36 does not fire**. It
ran once as the step-4 baseline and runs in full on the exact HEAD that IMPLEMENTATION pushes.
Section 7's row 10 records the gate results for `ea0a28f`; the results for the commit that
contains *this file* are recorded in the Gauntlet state file, because a file cannot honestly
assert results for the commit it sits inside (**P40**).

## 8. Verdict and next action

**SPECIFICATION complete.** A single executable gate is red in both tiers, every FAIL traced to a
named absence or a measured behaviour; acceptance is written in two tiers with the staging tier
expressed as actions against real DynamoDB, S3 and Bedrock; the provider is selected with a reason
that contradicts the approved plan and says why. **No implementation was performed.**

Smallest next action: IMPLEMENTATION turns the **local tier** green — `tests/e2e/chat/`, the mock's
transcript route, a pinned Playwright devDependency with one npm script, and one added job in
`ci.yml`. The **staging tier** cannot start until the owner mints the spend-capped token
(decision 6); it is the critical path for everything after F1.
