---
feature: chat-history-integrity
document_role: session-handoff
status: current
observed_at: 2026-09-19
as_of_commit: 87c07b7
session_slug: wi03-specification
supersedes: 2026-09-19-wi02-verification-final.md
---

# Session handoff: WI-0.3 specification — the AWS test guard

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-19 (Gauntlet Loop, `DIRECT_COORDINATOR / SPECIFICATION`, WI-0.3). Claude Opus 5, no Codex (`CODEX_ELIGIBILITY: NO`), no subagents. |
| Feature folder | `docs/features/chat-history-integrity/` |
| Branch worked on | `fix/test-credential-isolation`, cut from `origin/development` @ `0f41b53`, in the standalone clone `_netzer-turn-ceiling` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `0f41b53` (`origin/development`, PR #179 merged) |
| Commits made by this session | One test-only commit, `87c07b7`. No source change, no config change, no dependency change. |
| Pushed | **No.** |
| PR | None. |
| Deployed | no |

## 2. Current state summary

- **WI-0.3 is in SPECIFICATION.** The red state exists and fails for the right reason. Nothing is implemented.
- The failing evidence is `src/__test-utils__/aws-guard.test.ts` (`87c07b7`): 5 tests, 4 of which fail at HEAD because no guard is armed, and all 5 of which fail in a shell that carries `AWS_PROFILE`.
- Acceptance criteria **AC-0.3-1 … AC-0.3-7** are defined, each with its exact command, in `netzar-chat-plan/wi-0.3-proof.sh` and `netzar-chat-plan/wi-0.3-full-validation.sh`. Both live **outside** the repository (P15).
- A re-amendment of `development.md`'s AWS-safety paragraph is **drafted, not applied**. It needs a fresh yes/no from the owner in the conversation that applies it.

## 3. Codebase understanding

### 3.1 The seam, pinned at `0f41b53`

| Fact | Evidence |
|---|---|
| The repo has **no** `setupFiles` or `globalSetup`, in either vitest config or anywhere else outside `web/` | `grep -rn "setupFiles\|globalSetup" --include="*.ts" --include="*.json" --include="*.mjs" . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=graft --exclude-dir=web` exits 1; `npm test` reports `setup 0ms` |
| `vitest.config.ts` collects `src/**/*.test.ts`, `infra/**/*.test.ts`, `scripts/**/*.test.ts` | `vitest.config.ts:7` |
| A setup file therefore changes collection only if it is itself named `*.test.ts` inside those roots | same include list |
| `cost-cap.ts:68` calls `syncBudgetToDailyCap(dailyCapUsd).catch(() => null)` | `src/adapters/dashboard/cost-cap.ts:68` |
| `syncBudgetToDailyCap` calls STS `GetCallerIdentity`, then Budgets `DescribeBudget` + `UpdateBudget`, and swallows every error | `src/lib/aws/budget-writer.ts:36-49`, `:56-83` |
| `_accountId` seeds from `process.env.AWS_ACCOUNT_ID`, so STS is skipped when that is set — Budgets is still called | `budget-writer.ts:25`, `:36-37` |
| Exactly two files mention `budget-writer`: `cost-cap.ts` and `authz-matrix.test.ts` | `grep -rln budget-writer src/` |
| The only existing mock style is one line: `vi.mock('../../lib/aws/budget-writer.js', () => ({ syncBudgetToDailyCap: () => Promise.resolve(null) }));` | `src/adapters/dashboard/authz-matrix.test.ts:157-159` |
| `cost-cap.test.ts` has 7 tests; 2 of them reach the POST write path (`:109`, `:158`) | run: 7 passed; `cost-cap.test.ts:109-127`, `:149-159` |
| The integration lane is a separate config and deliberately makes real SDK calls, at `127.0.0.1:4566` — not `*.amazonaws.com` | `vitest.integration.config.ts` |

### 3.2 Setup file, not per-test — and why

**Setup file.** `test.setupFiles` is the only seam that reaches every worker, covers all 246 collected files, and keeps covering files added later. Per-test mocking cannot do either: it would mean editing 246 files today and remembering to edit every new one, which is the same discipline problem that produced this work item.

Per-test still has one job, narrowly: **`cost-cap.test.ts` gets its own `budget-writer` mock**, in `authz-matrix.test.ts`'s existing style. The setup file stops the dial; the mock removes the intent to dial. Both, because the setup file is a machine-wide safety net and the mock is what makes this one test honest about what it exercises.

**Two layers, because either alone is insufficient:**

1. **Credential neutralisation.** Delete `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` from `process.env`; point `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` at `os.devNull`; set `AWS_EC2_METADATA_DISABLED=true`. The SDK then fails at credential resolution, **before** any socket. Done once at setup time, not continuously, so a test that sets its own credentials afterwards (`src/__test-utils__/localstack.ts:139-140`) is unaffected.
2. **A tripwire.** Patch `http.request`, `http.get`, `https.request`, `https.get`; if the host matches `*.amazonaws.com`, record it and throw. Layer 1 alone is silent — and silence is what got us here, because `budget-writer.ts` swallows. The tripwire must therefore **survive the swallow**: it records the host, and an `afterEach` registered by the setup file fails the test on any recorded hit, whether or not the caller ever saw the throw.

`fetch` is not patched: the AWS SDK v3 in Node dials through `@smithy/node-http-handler`, i.e. `http`/`https`, not `fetch`. `http.get` is patched separately from `http.request` because Node's `get` calls the module-local `request`, not the export.

### 3.3 What is actually dangerous on this machine — Observed 2026-09-19

This corrects the premise carried in the WI-0.3 handoff, and it changes how the work has to be proved.

| Checked | Result |
|---|---|
| `env \| grep -i '^AWS'` | nothing set |
| `ls -la ~/.aws` | one file: `config`. **No `credentials` file.** |
| `grep -nE '^\[' ~/.aws/config` | `[profile netzer-root]`, `[profile netzer-process]`. **No `[default]`.** |
| credential sources in that config | `netzer-root`: region only. `netzer-process`: region + `credential_process` |
| `~/.aws/sso/cache`, `~/.aws/cli/cache` | absent |

So an un-stripped `npm test` **in a clean shell resolves no credentials at all** and does not dial. The live danger is conditional: exporting `AWS_PROFILE=netzer-process` makes `credential_process` produce real credentials, and the Budgets `UpdateBudget` becomes a real call. That is precisely why the standing constraint strips `AWS_PROFILE` first.

The consequence for the acceptance criteria is the important part: **a gate that simply runs `npm test` in a clean shell and finds it green proves nothing** — it is green by construction, the exact P18 failure. AC-0.3-2 therefore **plants well-formed fake static credentials** so the provider chain resolves and the guard is actually exercised. The live `netzer-process` profile is never used: no AWS mutation is authorized (constraint 8), and a fake key is a faithful stand-in because the guard's behaviour does not depend on which credentials resolve.

### 3.4 One correction to the incoming handoff

The handoff's "WHY IT EXISTS" says root `development.md` "names `src/lib/vectors/durability.repro.test.ts` as reaching the real staging vectors bucket". As merged in PR #178 (`33d9126`), the paragraph says the opposite: *"`src/lib/vectors/durability.repro.test.ts` stubs S3 and the Bedrock embedder; it is not the AWS-reaching test."* (`development.md:617-618`). The document is right and the handoff line is stale. `cost-cap.test.ts` is the AWS-reaching test, and the only one.

## 4. Decisions and classifications

### 4.1 Decisions taken this session

| # | Decision | Why |
|---|---|---|
| 1 | Setup file (`test.setupFiles`), not per-test | Only seam that reaches every worker and every future file (3.2) |
| 2 | Two layers: credential neutralisation **and** a tripwire | Layer 1 is silent; `budget-writer.ts` swallows, so silence is indistinguishable from safety (3.2) |
| 3 | The tripwire survives a swallowed throw, via a recorded-hit check in `afterEach` | A throw alone is caught by the caller and the suite stays green — the original defect, reproduced in the guard |
| 4 | The guard publishes its contract on `globalThis`, not by module export | Keeps the guard's file location an implementation choice, and avoids depending on setup-file and test-file module caches being the same instance |
| 5 | The guard file goes at the repository **root**, not under `src/` | A root file is not compiled into `dist` by `tsconfig.build.json`, so no production artifact changes. `vitest.config.ts` is already a root `.ts`, so `npm run typecheck` covers it |
| 6 | AC-0.3-2 plants **fake** credentials rather than running with a clean shell or the live profile | A clean shell resolves nothing here, so the gate would be green by construction; the live profile would be a real AWS call (3.3) |
| 7 | `cost-cap.test.ts` gets a `budget-writer` mock in `authz-matrix.test.ts`'s existing one-line style | Item 3 of the brief. A second style would be a second thing to maintain |

### 4.2 Classified, not patched

| Finding | Class | Route |
|---|---|---|
| The handoff's stale `durability.repro.test.ts` claim (3.4) | Documentation drift in a handoff, not in the repo | Corrected here; `development.md` is already right |
| `budget-writer.ts` swallows every error, so a real failed AWS call is invisible in tests and in production | Technical debt, pre-existing and deliberate ("best-effort by design", `budget-writer.ts:4-7`) | Not patched. Out of WI-0.3 scope |
| `~/.aws/config`'s `netzer-process` profile can mint real credentials from any shell | Environment, not code | Not patched. It is the reason the guard exists |

### 4.3 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| `~/.aws` has no `[default]` profile and no credentials file, so the exposure is conditional on `AWS_PROFILE` | Ledger A36, and the drafted `development.md` re-amendment | Yes |
| A disarmed amazonaws.com probe exits non-zero via an unhandled `ENOTFOUND`, so exit code alone cannot score the tripwire | Ledger trap, and `wi-0.3-proof.sh` AC-0.3-4 | Yes |

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

## 6. Pending work

### 6.1 Smallest next action

Implement the guard: add `vitest.setup.ts` at the repository root, name it in `vitest.config.ts`'s `test.setupFiles`, and add the one-line `budget-writer` mock to `cost-cap.test.ts`. Then run `netzar-chat-plan/wi-0.3-proof.sh` (scored mode, `WI03_CREDS=plant`) and `netzar-chat-plan/wi-0.3-full-validation.sh`.

### 6.2 Open for the owner

1. **The `development.md` re-amendment (drafted, NOT applied).** Once the guard lands, the AWS-safety paragraph's closing instruction is wrong: it tells the reader to hand-strip. The drafted diff is in section 6.3. Applying it needs a fresh yes/no **in the conversation that applies it** (process skill), exactly as PR #178's amendment did.
2. **The Automated tests table.** `npm test` moves from "246 files, 3209 tests" to 247 files / 3215 tests once the guard's own test file lands. Same approval, same PR.
3. **Owner decision 18 is still due and not started**: promote `development` → `qa` → `staging`, each its own PR, each confirmed before the push. The staging merge deploys (`cdk deploy --all`). Production stays blocked (#90, #91, #168, #170).

### 6.3 Drafted `development.md` re-amendment — do NOT apply without approval

Replaces the closing instruction of the AWS-safety paragraph (`development.md:611-621` as merged in `33d9126`). The first six lines of that paragraph stay exactly as they are.

```diff
-`src/lib/vectors/durability.repro.test.ts` stubs S3 and the Bedrock embedder;
-it is not the AWS-reaching test. Until a Vitest AWS guard lands, never run
-`npm test` with ambient credentials: unset `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`,
-`AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, then run
-`AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true npm test`.
+`src/lib/vectors/durability.repro.test.ts` stubs S3 and the Bedrock embedder;
+it is not the AWS-reaching test.
+
+That is now handled for you, and hand-stripping is no longer required.
+`vitest.setup.ts` loads into every worker before any test file and does two
+things: it removes `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
+and `AWS_SESSION_TOKEN` from the environment and points the config and
+credentials files at the null device, so the SDK's provider chain resolves
+nothing; and it arms a tripwire on `http`/`https` that refuses any request to a
+`*.amazonaws.com` host, records it, and **fails the test that made it** even
+when the caller swallows the error — which `budget-writer.ts` does.
+`src/adapters/dashboard/cost-cap.test.ts` also mocks `budget-writer` directly,
+so that suite no longer has any intent to call AWS.
+
+`src/__test-utils__/aws-guard.test.ts` proves both layers are armed. If it ever
+fails, treat `npm test` as unsafe again and strip by hand until it is fixed:
+unset the four variables above, then run
+`AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true npm test`.
```

A second hunk adds the guard as a fifth AWS-safety layer, since the existing
fourth layer ("No credentials on the machine") does not hold on a machine with
a usable `~/.aws` profile:

```diff
 4. **No credentials on the machine.** The verified machine has no `~/.aws`
    directory and no `AWS_*` shell variables, so the default credential chain has
    nothing to fall back to.
+5. **A hermetic test suite.** `vitest.setup.ts` neutralises every credential
+   source inside the test process and fails any test that dials
+   `*.amazonaws.com`. Layer 4 is a property of one machine; this one travels
+   with the repository.
```

## 7. Commands actually run, and their results

Every command below was run in `_netzer-turn-ceiling` on 2026-09-19. Exit codes were captured unpiped (M13).

### 7.1 Baseline, recorded before any change (development.md step 4)

At `0f41b53`, credentials stripped:

```
npm test  exit=0
 Test Files  246 passed (246)
      Tests  3210 passed (3210)
   Duration  20.68s
npx vitest list --filesOnly  exit=0  -> 246 files
npx vitest run src/adapters/dashboard/cost-cap.test.ts  exit=0  -> 7 passed
```

The full step 7 list was **not** run. It is a pre-push gate and nothing is pushed
in a specification phase; `AC-0.3-7` owns it for the implementation phase.

### 7.2 The red state

`npx vitest run src/__test-utils__/aws-guard.test.ts`, credentials stripped, at `87c07b7`:

```
exit=1
 Test Files  1 failed (1)
      Tests  4 failed | 1 passed (5)
 × the unit config loads a setup file into every worker
   -> expected 'import { defineConfig } from 'vitest…' to match /setupFiles\s*:/
 × is armed in this worker              -> expected undefined to be defined
 × refuses and records a dial ...       -> expected undefined to be true
 × fails a test even when the caller swallows the error
                                        -> expected undefined to be true
```

Every failure is "the guard is not installed". None is a syntax error, a bad
fixture, a missing credential or an unrelated baseline failure.

**Negative control for the one test that passed.** `neutralises every ambient
credential source` passes in a shell that has already been hand-stripped — which
is green by construction. Re-run with `AWS_PROFILE=netzer-process` exported (the
realistic un-stripped shell):

```
exit=1
 Tests  5 failed (5)
 × neutralises every ambient credential source
   -> AWS_PROFILE must be unset: expected 'netzer-process' to be undefined
```

No SDK client is constructed in that run, so nothing invoked `credential_process`
and no AWS call was made.

### 7.3 The proof script, rehearsed in the red state

`WI03_CREDS=strip bash netzar-chat-plan/wi-0.3-proof.sh` at `87c07b7` (P32):

```
PASS  AC-0.3-1 collection: 246 baseline files intact, +1 guard test file
FAIL  AC-0.3-2 npm test: exit=1 files=? tests=? (want 0 / 247 / 3215)
FAIL  AC-0.3-3 tripwire: not assessable, AC-0.3-2 did not complete green
FAIL  AC-0.3-4 negative control: exit=1, want a FAILED test naming the probe host
PASS  AC-0.3-5 cost-cap.test.ts: 7/7 with the budget-writer mock
FAIL  AC-0.3-5 mutation: no budget-writer mock in cost-cap.test.ts to remove
PASS  AC-0.3-6 scope: 1 path(s), all inside the seam
PASS  AC-0.3-6 dependencies: package.json and the lockfile unchanged
FAILS=4
```

Four FAILs, each of them "the guard does not exist yet"; three PASSes that measure
real things and would catch a regression today. The tree was clean afterwards.

The AC-0.3-4 log is what produced the exit-code trap above:

```
 ✓ src/__test-utils__/__planted-violation.test.ts (1 test) 12ms
 ⎯ Unhandled Errors ⎯
 Error: getaddrinfo ENOTFOUND netzar-guard-probe.amazonaws.com
 Test Files  1 passed (1)   Tests  1 passed (1)   Errors  1 error
```

Disarmed, the swallowing test **passes** and vitest still exits 1. That is also
the direct evidence that the probe is a real dial, and why AC-0.3-4 requires a
FAILED test plus the violation line rather than a non-zero exit.

### 7.4 Acceptance criteria

| ID | What it requires | Exact command |
|---|---|---|
| AC-0.3-1 | Collection unchanged: all 246 baseline files still collected, the only addition being `src/__test-utils__/aws-guard.test.ts` | `npx vitest list --filesOnly`, diffed against `netzar-chat-plan/wi-0.3-baseline-files.txt` (`comm -23` = 0, `comm -13` = that one path) |
| AC-0.3-2 | `npm test` green with **no** hand-stripping, in a shell whose credentials resolve: 247 files / 3215 tests, exit 0 | `env -u AWS_PROFILE AWS_ACCESS_KEY_ID=AKIAGUARDPROBE0000000 AWS_SECRET_ACCESS_KEY=guard-probe-not-a-real-secret-value AWS_REGION=us-east-1 npm test` |
| AC-0.3-3 | Zero `*.amazonaws.com` dials in that run | `grep -c 'NETZAR-AWS-GUARD VIOLATION'` on AC-0.3-2's log = 0, **gated on AC-0.3-2 exiting 0** |
| AC-0.3-4 | The tripwire can fail, and defeats a swallow (P18/P28): a planted test that dials and swallows must FAIL and name the host | `wi-0.3-proof.sh` AC-0.3-4 — writes `src/__test-utils__/__planted-violation.test.ts`, runs it, removes it, and requires `Tests N failed` + the violation line + the probe host |
| AC-0.3-5 | `cost-cap.test.ts` keeps its meaning (7/7), and its mock is load-bearing: with the mock removed in the working tree, the guard catches the Budgets dial. Tree restored, `git status --short` empty | `npx vitest run src/adapters/dashboard/cost-cap.test.ts`, then `wi-0.3-proof.sh`'s mutation block. **Runs after AC-0.3-4**, which is what licenses trusting the tripwire |
| AC-0.3-6 | Scope: changed paths ⊆ {`vitest.config.ts`, the guard file, `aws-guard.test.ts`, `cost-cap.test.ts`, `docs/features/chat-history-integrity/**`}; no production `src/` file; `package.json` and the lockfile unchanged | `git diff --name-only origin/development HEAD`, filtered; `git diff --quiet origin/development HEAD -- package.json package-lock.json` |
| AC-0.3-7 | `development.md` step 7 in full = baseline, run with **no** stripping | `FV_CREDS=plant FV_BASE=development bash netzar-chat-plan/wi-0.3-full-validation.sh` — all 11 gates exit 0; integration 38 passed / 25 skipped / 1 failed (the Floci `checkSecrets` gap); `guard-violations: 0` |

`wi-0.3-proof.sh` scores AC-0.3-1 … AC-0.3-6 and exits non-zero on any FAIL.
`wi-0.3-full-validation.sh` scores AC-0.3-7 and is parameterised by `FV_REPO`,
`FV_BASE` and `FV_CREDS` (`strip` | `plant` | `inherit`).

### 7.5 Not run, and why

| Command | Why not |
|---|---|
| The step 7 full validation list | A pre-push gate. Nothing is pushed in a specification phase. AC-0.3-7 owns it. |
| `npm test` without stripping, in scored (`plant`) mode | Forbidden until WI-0.3 lands: with credentials resolving and no guard, `cost-cap.test.ts` would run a real Budgets `UpdateBudget` (P32). |
| Anything using `AWS_PROFILE=netzer-process` against the SDK | Its `credential_process` mints real credentials. No AWS mutation is authorized (constraint 8). The one run that exported that name constructed no SDK client. |
| `npm run local` / Floci | Not needed: no integration suite this phase. |
| `graft build` in this checkout | It would write an untracked `graft/` into the clone (carried trap). The seam is four known files, read directly and cited above. |
