---
feature: release-pipeline-v1
document_role: session-handoff
status: current
observed_at: 2026-09-13
as_of_commit: 4b3393e232d7169082b8f50d5920ceba0ea1b92f
session_slug: p4-p5-specification
supersedes: 2026-09-10-p4-p5-planning.md
---

# Session handoff: P4 and P5, specified by red tests, not built

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-11. It resumed on 2026-09-13 after two interruptions |
| Feature folder | `docs/features/release-pipeline-v1/` |
| Branch worked on | `feature/release-pipeline-p4-p5` (red tests only) and `feature/release-pipeline-v1` (this handoff) |
| Branch it merges into next | `development` (both branches) |
| AWS environment that branch reaches | none: `feature/*` deploys nothing |
| Commit at session start | `feature/release-pipeline-p4-p5` cut from `origin/development` `271339bc`, with no upstream; `feature/release-pipeline-v1` at `4a01b6e` |
| Commit at session end | `4b3393e` on `feature/release-pipeline-p4-p5` (the red-test checkpoint), plus the commit that adds this file on `feature/release-pipeline-v1` |
| Pushed | no; both branches exist only in `C:\dev\_netzer-release` |
| PR | none |
| Deployed | nothing |

## 2. Current state summary

The Gauntlet SPECIFICATION phase for WI-1 (P4, disarm the drift schedule; P5, pin the orchestrator by image digest) is complete.

Four test seams, S1–S4, are written and confirmed red for the intended reasons. They are committed locally as `4b3393e` on `feature/release-pipeline-p4-p5`. **No implementation code has been written.**

One acceptance criterion changed: AC-4 now requires an **empty** digest, not an absent key, when a manifest has none (Q4, §4.3).

The next session is IMPLEMENTATION. Codex (`gpt-5.6-terra`) builds from the work order at `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-codex-workorder.md`, and Claude inspects the result. The resume prompt is `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-implementation-handoff.md`.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **The rollback shell merges; it does not replace.** `scripts/rollback.ts:150-161` ("ShellLike contract: merge opts.env OVER process.env") passes `{ ...process.env, ...opts.env }` to every child.
  - The approved plan's site 3 and the comment at `rollback-classes.ts:913` both assume `synthEnv` *replaces* the child's environment.
  - A key left out of `synthEnv` is therefore inherited from the operator's shell. That is what Q4 closes.
- **Callers, measured on the untouched branch** with graft (index outside the clone):
  - `cdkEnvBag` ← `cdkDeployStacks` (`scripts/deploy.ts:1620`) and `assembleManifest` (`:1825`);
  - `infraDiffAndMaybeDeploy` ← `runRollback` (`rollback-classes.ts:594`, dry run, and `:663`);
  - `ComputeStack` ← `infra/bin/app.ts` and `paperclip-stack.test.ts` (`computeTemplateUnguarded`);
  - `ECR_LIFECYCLE_POLICY` ← `ensureEcrLifecyclePolicy` and `rollback-classes.test.ts` only.
- **Nothing else parses the orchestrator image string.** A grep over `src`, `scripts`, `infra` and `.github`, including the power-switch handler, finds one parser: `cdk-drift.yml:69`, which P5 already rewrites.
- **The claudex runner's gate.** A delegated build needs `git status --porcelain --untracked-files=all` to be empty, a `--proof`, and artifacts outside the checkout. It fails if the builder moves HEAD.

### 3.2 Critical files

| File | Why |
|---|---|
| `infra/lib/compute-stack.test.ts` | S1: the shared `synthCompute` seven-stack harness and the image-pin suite |
| `scripts/lib/lifecycle/rollback-classes.test.ts` | S3 (infra class, after the tier tests) and S4 (ECR lifecycle policy) |
| `scripts/lib/lifecycle/paperclip-image-pipeline.test.ts` | S2: six source-level driver checks; `workflowStep(name, source)` |
| `scripts/rollback.ts:150-161` | the merge contract behind Q4 |

### 3.3 Patterns and conventions to follow

- **When a real adapter merges the env a fake records,** assert on the effective env, `{ CCE_IMAGE_DIGEST: <stale>, ...env }`. The fake alone would pass while the leak stayed open.
- **When a sibling already contains the pattern,** count occurrences instead of using `toContain`. The Paperclip `*@sha256:*)` parse would otherwise make the drift check vacuous.
- **A red test whose sibling is green validates the assertion's form.** S1's `:ci` guard passing today shows the image JSON holds `/claudeclaw-orchestrator:ci` as one contiguous chunk, so S1's `@sha256:` assertion is the right shape.

## 4. Work completed

### 4.1 Tasks finished

- [x] Branch cut; baseline recorded (§7).
- [x] graft index built outside the clone; callers recorded (§3.1).
- [x] Red tests S1–S4 written, each confirmed red for the intended reason (§7).
- [x] Red-test checkpoint committed locally as `4b3393e`.
- [x] `codex doctor` passes. CODEX_ELIGIBILITY: YES. Work order written.
- [ ] Implementation: the next session.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `infra/lib/compute-stack.test.ts` | The seven-stack construction is lifted into `synthCompute`, and the War Room assertions are unchanged. New suite *orchestrator image pin (P5)*: a digest pins both containers, a malformed digest throws, and an empty digest keeps the tag | S1 |
| `scripts/lib/lifecycle/rollback-classes.test.ts` | Two rebuild-from-git tests (the digest is replayed; a pre-digest manifest gets `''`). The ECR lifecycle test expects exactly one rule | S3, S4 |
| `scripts/lib/lifecycle/paperclip-image-pipeline.test.ts` | `DRIFT`/`BUILDSPEC` readers and `workflowStep(name, source)`. New suite *orchestrator image digest reaches every driver (P5)*, with six tests | S2 |
| this file, `HANDOFF.md` | new; current state and session index | framework §6a |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| **Q4 (with the user, 2026-09-11):** the rollback's `synthEnv` always carries `CCE_IMAGE_DIGEST: target.imageDigest ?? ''`. AC-4 now reads "the manifest's digest, or `''` when it has none" | the approved conditional spread, with the key absent | The real shell merges over `process.env`, so only an explicit `''` stops a digest exported in the operator's shell from pinning a rollback of a pre-digest manifest. Recorded as an amendment at the end of the approved plan |
| Correct the false "REPLACES" comment at `rollback-classes.ts:913` in the same edit | file it | The new line's rationale would otherwise contradict a comment fifteen lines above it |
| S2 finished by the coordinator (Opus) | resume the interrupted Sonnet writer | Its spec was complete, and it had left only the helper plumbing |
| S4 written by Opus, not Sonnet | route it to Sonnet | It shares S3's file, and one writer per file |
| `graft/.cache` moved out of the clone, not deleted | delete it; add `graft/` to `.git/info/exclude` | Non-destructive, and no config change |
| The work order and the IMPLEMENTATION prompt live under `~/.claude/plans` | the session scratchpad | The scratchpad is session-scoped; the next session has to read them |
| `development.md` steps 3 (Floci) and 7 (the nine commands) deferred to VERIFICATION | run them now | Nothing in SPECIFICATION uses Floci, and starting Docker is the user's call |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The rollback shell merges env over `process.env` | the corrected comment at `rollback-classes.ts:913` (the code is the authority), in IMPLEMENTATION | no; lands with the implementation |
| The findings in the 2026-09-10 log's 3.1 | `README.md` §7 | no; still scheduled for P5's docs step |

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

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it any time with `npm run local:verify`, which requires account id `000000000000`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS**, Floci 1.6.0, Docker 28.3.2, Node 24.3.0, on 2026-08-10. | Windows and Linux behaviour is **not** covered by that verification. See M6. |
| A3 | Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. | Local development validates plumbing, never model behaviour. Tool use is unreachable locally by design. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; deployment is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const). | A `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception. |
| A6 | AWS console access for this account is root-user sign-in via `aws login` with the `netzer-root` profile. | The `netzer-dev` SSO profile is known broken. Do not burn time on it. |

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

### 5.5 Appended this session (2026-09-08, forgery corpus and release CI)

| # | Entry | Detail |
|---|---|---|
| M9 | **Reconnaissance was done in a dirty tree and three "facts" were wrong on the branch.** `scripts/update/shim.ts`'s `RELEASE_REPO` reads the *organisation* in `C:\dev\Netzer-Labs` because of an uncommitted local edit; on `origin/development` it is a **personal account**. | Verify every inherited claim with `git show origin/development:<path>`, never by reading the working tree. |
| M10 | **A mutation harness caught two vacuous mutations in its own first run.** `JSON.stringify(x, null, 0)` is a no-op, and neutering one of the two digest loops leaves the other catching the swap. | A mutation that does not mutate reads exactly like a vacuous test. Check that the mutation changed behaviour before concluding the test is weak. |
| M11 | **`release.yml` initially invoked a module with no entry point.** `sign-promotion.ts` is import-safe by design, so `npx tsx sign-promotion.ts` would have defined its exports and exited 0 having signed nothing. | When CI invokes a TS module directly, prove the CLI executes — run it and check the exit code. `build-release-entry.ts` is the pattern. |
| A7 | **`src/lib/vectors/durability.repro.test.ts` is hermetic**, contrary to `development.md` (~:617). `S3Client.prototype.send` is replaced by `vi.spyOn` backed by an in-memory `Map`; `embedMany` is mocked; the CDK half is `Template.fromStack`. Proven: 7/7 pass with `AWS_PROFILE`/keys/`AWS_CONFIG_FILE` stripped and the metadata endpoint disabled. | Do not exclude it from a gate "because of AWS". Gap report filed; `development.md` not edited (needs approval). |
| A8 | **The AWS session was live this session**, not expired as the plan assumed (`aws sts get-caller-identity` → root, acct `239887088812`). | Re-measure session state; do not inherit it. |
| T1 | **Four baseline test files fail at collection because vite-node does not strip `#!/usr/bin/env node`** from a `.mjs` imported by a test. The `SyntaxError` is reported against the *importer's* comment block, which sends you to the wrong file. | Proven: deleting that one line from `scripts/ci/docs-links.mjs` turns the suite from "failed to collect" into 19 passing tests. Exactly the four test files importing a shebanged module are red. |
| T2 | **The Bash tool truncates large heredocs** and silently eats backslashes inside them. A `.replace(/\\/g, '/')` became `.replace(/\/g, '/')` and produced a syntax error hundreds of lines away. | Use the Write tool for any file with regexes or nested quoting. |
| T3 | **`$?` after a pipeline is the last command's status**, so `cmd | tail` always reports 0. Three CLI exit codes initially read as "all pass". | Capture the status without a pipe, or use `PIPESTATUS`. |

### 5.6 Appended this session (2026-09-10, P4/P5 planning)

| # | Entry | Detail |
|---|---|---|
| M12 | **The release plan's line citations drifted.** On `development`, `deploy.yml`'s `CCE_IMAGE_TAG` sites are `:934`/`:1051`, not `:928`/`:1046`. | Grep for the quoted content; treat line numbers as hints. |
| M13 | **graft's index is the main checkout's**, and all five P5 files there differ from `development`. | In a sibling clone, build a separate index with `graft --dir <path outside the clone> build <clone>`. Treat main-checkout answers as informational only. |
| A9 | **Docker Desktop is a per-user install and was stopped at session start.** | Start it with `powershell.exe -NoProfile -Command 'Start-Process "$env:LOCALAPPDATA/Programs/DockerDesktop/Docker Desktop.exe"'`, then confirm with `docker info`. |
| A10 | **CI writes no deploy manifest.** | `deploy:rollback` only covers deploys made by the local driver. |
| A11 | **The AWS session was expired on 2026-09-10.** It was live on 2026-09-08 (A8). | Re-measure every session, and ask before running `aws login`. |
| T4 | **`codex` is not on PATH.** The VS Code extension's `codex.exe` is 0.153.0; `~/.codex/.sandbox-bin/codex.exe` is 0.153.4. | Run `codex doctor` before delegating. Never infer model availability from the model list alone. |
| T5 | **A control's comments can outlive the control.** `cdk-drift.yml` failed 36 of 36 scheduled runs (2026-08-06 → 2026-09-10), each at `configure-aws-credentials`, while its comments still said it runs daily. | Read `gh run list` before citing a control as live. |

### 5.7 Appended this session (2026-09-11 → 2026-09-13, P4/P5 specification)

| # | Entry | Detail |
|---|---|---|
| M14 | **The approved plan's site 3 rested on a false premise.** It said `synthEnv` *replaces* the child's environment. `scripts/rollback.ts:150` merges it over `process.env`, and the comment at `rollback-classes.ts:913` repeats the false claim. | Before designing a test against an injected fake, read the real adapter behind it. The fake shell records `opts.env` verbatim, so a test on the fake alone would have passed while an exported digest leaked. |
| M15 | **The first baseline ran with 221 MiB of disk free and a graft build alongside it.** It took 971 s (292 s on 2026-09-08) and added a sixth red: `durability.repro` hit its 5 s timeout in three tests. | Isolated re-runs passed 7/7, twice. Check free disk before a full run (`codex doctor` reports it), and run nothing heavy alongside the suite. |
| A12 | **`src/lib/vectors/durability.repro.test.ts` is hermetic, re-confirmed on 2026-09-13** with AWS credentials stripped and the session expired. | Its reds under load are timeouts, not AWS. This reinforces A7. |
| T6 | **graft writes `graft/.cache/telemetry-repo-id.json` into the repo it indexes, even with `--dir`.** | Move it out before any clean-checkout gate; the claudex runner refuses a dirty tree. `graft callers` can't find `export const` objects, so use `graft grep` for those. |
| T7 | **`docker info` and `git ls-remote` can hang here.** `docker info` hung with Docker Desktop stopped. `ls-remote` printed the ref, then hung until `timeout` killed it. | Wrap both in `timeout`, and trust the printed output over the exit code. |
| T8 | **A background agent's partial edits survive a session end.** The interrupted S2 writer left two of its three edits and none of its tests. | After a resume, `git diff` every file an interrupted agent owned before continuing. |

## 6. Pending work

### 6.1 Smallest next action

Open a fresh session and paste the Gauntlet resume prompt at `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-implementation-handoff.md`.

### 6.2 Immediate next steps

1. **IMPLEMENTATION.**
   - Fill the work order's placeholders: the disarm date, and the scheduled run count from `gh`.
   - Re-run `codex doctor`.
   - Delegate through the claudex runner with `gpt-5.6-terra`.
   - Claude then reads the whole diff and reruns the proof.
2. **CLEANUP**, then **VERIFICATION**: a fresh Opus critic, the hermetic synth matrix, the drift-parse harness, the mutation check, and the nine `development.md` commands with Floci.

### 6.3 Blockers and open questions

- [ ] **Rollout gate.** Before promoting `qa → staging`, read both orchestrator repos' ECR lifecycle policies and re-apply them without rule 1. This needs `aws login` and the owner's consent.
- [ ] **Codex model.** `gpt-5.6-terra` is listed in `~/.codex/models_cache.json` but has not been proven runnable. The first delegation proves it. If it's rejected: stop and report; no silent escalation.
- [ ] **Docker Desktop is stopped.** VERIFICATION's `npm run local:test:integration` needs it, and starting it is the user's call.

### 6.4 Deferred, and why

Unchanged from the 2026-09-10 log. Everything in the plan's "Filed, not acted on" list belongs to P6, P9, v1.1, or P3's reconciliation.

## 7. Verification actually performed

| Command | Result |
|---|---|
| `npm run typecheck`, baseline on `271339bc` (2026-09-11) | exit 0 |
| `npm test`, baseline on `271339bc` (2026-09-11) | exit 1. Six files and four tests red: the five known Windows reds, plus `durability.repro` (three 5 s timeouts under load; see M15) |
| `npx vitest run src/lib/vectors/durability.repro.test.ts`, twice, AWS profile and keys stripped (2026-09-13) | 7/7 passed on both runs |
| `npx vitest run infra/lib/compute-stack.test.ts`, after S1 | 2 red as intended (a digest renders `:ci`; `bogus` is accepted). 3 passed: the `:ci` guard and both War Room tests |
| `npx vitest run scripts/lib/lifecycle/rollback-classes.test.ts`, after S3 and S4 | 3 red as intended ("expected undefined to be 'sha256:bbbb…'"; "expected 'sha256:eeee…' to be ''"; two rules against one), plus the known Windows red. 24 passed |
| `npx vitest run scripts/lib/lifecycle/paperclip-image-pipeline.test.ts`, after S2 | 6 red as intended, each on its own missing forward: the `cdkEnvBag` entry, the `env.CCE_IMAGE_DIGEST` assignment, `id: orchimg`, zero of the two consumers, the drift step's `case "$IMAGE" in`, and buildspec's `RepoDigests`. The other 72 tests in the file pass |
| `npm run typecheck`, with the red tests | exit 0 |
| `git diff --check`, on the red-test commit | exit 0 (only git's LF-to-CRLF notice for `infra/lib/compute-stack.test.ts`) |
| `codex doctor` (the VS Code extension binary, 0.153.0) | 2026-09-11: exit 1, 221 MiB free. 2026-09-13: exit 0, auth configured, a disk warning at 4.7 GiB |
| `node scripts/ci/feature-knowledge.mjs`, on `feature/release-pipeline-v1` with this file | exit 0, run at session close with this file and the updated `HANDOFF.md` in place |
| `node scripts/ci/docs-links.mjs`, on `feature/release-pipeline-v1` with this file | exit 0, run at session close with this file and the updated `HANDOFF.md` in place |
| **Not run in this session** | `npm run build`, `npm --prefix web run typecheck`, `npm --prefix web run build` and `npm run local:test:integration` are the VERIFICATION phase's (AC-10). The synth matrix and drift harness are also VERIFICATION's. A real deploy can't be verified without AWS |

## 8. Environment state

- **Tools:** Docker Desktop is stopped (`docker info` hangs). The AWS session is expired. `C:` had 13.7 GB free on 2026-09-13.
- **Clone:** `C:\dev\_netzer-release` is left on `feature/release-pipeline-p4-p5`, clean, at `4b3393e`. `.baseline/p4p5-spec/` holds the baseline JSON (git-excluded).
- **Scratch outside the repo:** the graft index and its moved `.cache` are in the session scratchpad, which is disposable.
- **Active processes:** none started by this session are still running.
- **Primary checkout:** `C:\dev\Netzer-Labs` was not touched.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-09-10-p4-p5-planning.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
