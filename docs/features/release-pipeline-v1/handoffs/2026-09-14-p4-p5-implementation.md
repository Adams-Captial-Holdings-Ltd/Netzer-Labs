---
feature: release-pipeline-v1
document_role: session-handoff
status: current
observed_at: 2026-09-14
as_of_commit: b27ac382cef20103b0bbbc0ab642cf45cb12c8b0
session_slug: p4-p5-implementation
supersedes: 2026-09-11-p4-p5-specification.md
---

# Session handoff: P4 and P5, built and committed locally, not yet cleaned up or verified

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-14 |
| Feature folder | `docs/features/release-pipeline-v1/` |
| Branch worked on | `feature/release-pipeline-p4-p5` (the implementation) and `feature/release-pipeline-v1` (this handoff) |
| Branch it merges into next | `development` (both branches) |
| AWS environment that branch reaches | none: `feature/*` deploys nothing |
| Commit at session start | `feature/release-pipeline-p4-p5` at `4b3393e` (the red tests, on `origin/development` `271339bc`); `feature/release-pipeline-v1` at `1203fc9` |
| Commit at session end | `db116ba` and `b27ac38` on `feature/release-pipeline-p4-p5`, plus the commit that adds this file on `feature/release-pipeline-v1` |
| Pushed | no; both branches exist only in `C:\dev\_netzer-release` |
| PR | none |
| Deployed | nothing |

## 2. Current state summary

The Gauntlet IMPLEMENTATION phase for WI-1 is complete. Nothing is pushed.

- **P5, the digest pin, is built.** The 11 red tests from `4b3393e` are green. The proof's one remaining red is the known Windows path-separator test.
- **P4, the drift disarm, is built.** The schedule is commented out, and the DATED DISARM comment carries the evidence and the restore condition.
- **Authorship:** Codex (`gpt-5.6-terra`) wrote the implementation from the frozen work order, in one attempt. After Claude's inspection and a fresh Opus review, Claude corrected comments and docs in nine of the ten files and removed one redundant shell test. §4.2 logs authorship per file.
- **Commits:** `db116ba` (P4), then `b27ac38` (P5), local only.

The next session is CLEANUP (Claude on sonnet, scope-locked), then VERIFICATION. The resume prompt is `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-cleanup-handoff.md`.

**The disarm does nothing until it merges.** Scheduled workflows run from the default branch, `development`, so the schedule keeps failing daily until this branch lands there.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **The driver tests count raw strings across whole files.** `workflowStep` bounds a step from its `- name:` line to the next one, and the buildspec checks use `indexOf`, which finds the first occurrence. A comment can satisfy or break them:
  - `deploy.yml` must hold exactly two `CCE_IMAGE_DIGEST: ${{ steps.orchimg.outputs.digest }}`;
  - `deploy.ts` must hold exactly one `env.CCE_IMAGE_DIGEST = `;
  - buildspec.yml's first `RepoDigests` and first `sha256:*` must come after `docker push $IMAGE_URI:$COMMIT_SHA`;
  - the drift resolve step must hold exactly two `*@sha256:*)`.
- **The image rollback class pinned by digest before P5.** `rollback-classes.ts` builds `repo@digest` from the manifest's `images[]` or `imageDigest`, and throws when a manifest has neither. A deploy made before P5 therefore rolls back by digest too, as long as the local driver recorded it.
- **`scripts/rollback.ts` holds the only `ShellLike` and the only `runRollback` caller.** Its merge-over-`process.env` contract is the whole story. The explicit `CCE_PAPERCLIP_TEARDOWN` forward in `synthEnv` changes nothing for that shell. Its value is that the key shows in the logged synth env.
- **`synthEnv` spreads `synthInputs` first,** so the explicit `CCE_IMAGE_DIGEST` key after it always wins. `SYNTH_INPUT_ALLOWLIST` (`manifest.ts:92`) does not need the digest.
- **The digest's inputs are all in scope.** `deploy.yml` sets `AWS_REGION` at workflow level (`:46`). Build + Push, CDK deploy and Complete fresh Paperclip bootstrap are steps of the one `deploy` job, so `steps.orchimg.outputs.digest` reaches both consumers.
- **buildspec.yml is `version: 0.2` with no `env.shell`.** It already relies on plain shell variables (`COMMIT_SHA`, `IMAGE_URI`) surviving across commands and phases. The digest block uses only POSIX `case`, `$( )` and `export`.

### 3.2 Critical files

| File | Why |
|---|---|
| `infra/lib/compute-stack.ts` ("Per-deploy image pin") | the digest resolution and the malformed-digest guard; both `fromEcrRepository` consumers |
| `scripts/deploy.ts` (after `resolveImageDigest`; `cdkEnvBag`) | the assignment and the allowlist entry |
| `scripts/lib/lifecycle/rollback-classes.ts` (`synthEnv`) | the Q4 line |
| `scripts/lib/lifecycle/bootstrap-state.ts` (`ECR_LIFECYCLE_POLICY`) | the single retention rule |
| `.github/workflows/deploy.yml` (`id: orchimg`) | the CI producer and its two consumers |
| `.github/workflows/cdk-drift.yml` | the disarm and the live-digest parse |
| `buildspec.yml` (after the pushes; the image-only branch) | the CodeBuild producer and `$IMAGE_URI@$DIGEST` |

### 3.3 Patterns and conventions to follow

- **After a delegated build, check encoding before you read the diff.** For every changed file, compare non-ASCII byte counts and look for a BOM, `â€` and U+FFFD.
- **A builder's "Deviations: none" is a claim, not evidence.** Codex reported none, yet two comment updates the order named were missing. Check every named item, including comments no test can see.
- **Split a mixed file by whole hunks when they separate cleanly.** Filter `git diff -- <file>` to the wanted hunks and `git apply --cached` the patch. The working tree never moves.

## 4. Work completed

### 4.1 Tasks finished

- [x] Baseline re-checked: the clone was clean at `4b3393e`, `origin/development` was still `271339bc`, and 8.7 GiB were free.
- [x] Work order filled in: disarm date 2026-09-14; 39 of 39 scheduled runs failed through 2026-09-13; the failing step re-confirmed on run `34769872440`.
- [x] `codex doctor` (0.153.0) exited 0.
- [x] Codex build, attempt 1 of 1: 1330 s, and only the 10 allowed files touched.
- [x] Claude inspection: scope, encoding, Codex's command log, the whole diff, the proof, typecheck, `git diff --check`, the YAML parse, 17 related test files and both docs gates.
- [x] Fresh read-only Opus inspector: REVISE. Two high findings were comments the work order named but were never updated, one medium was a corrected comment that still gave the wrong reason, and nine were low. Its hand traces confirmed the runtime logic on every path, and every P5 test is met by executable lines, not comments.
- [x] Claude applied the review fixes: the two comments the order named, the misleading teardown-forward and retention comments, the unpullable-fallback and `cdkEnvBag` explanations, the pull_request restore note and the disarm layout, the `.env.reference` annotations, two doc sentences, and the redundant `None` test. Cosmetic findings went to CLEANUP's candidate list. Every gate was rerun afterwards (§7)
- [x] Two local commits, P4 first.
- [x] CLEANUP resume prompt written.
- [ ] CLEANUP and VERIFICATION: the next sessions.

### 4.2 Files modified

| File | Change | Author |
|---|---|---|
| `infra/lib/compute-stack.ts` | Resolves `CCE_IMAGE_DIGEST` first and throws at synth on a malformed one; both containers use the resolved reference | Codex; the comment's driver and fallback sentences by Claude |
| `scripts/deploy.ts` | `env.CCE_IMAGE_DIGEST = imageDigest` once the digest resolves; the `cdkEnvBag` entry | Codex; both comments by Claude |
| `scripts/lib/lifecycle/rollback-classes.ts` | `CCE_IMAGE_DIGEST: target.imageDigest ?? ''` in `synthEnv`; wording at the top, in the error string and in the rebuild comment | Codex; the teardown-forward comment by Claude |
| `scripts/lib/lifecycle/bootstrap-state.ts` | Rule 1 deleted; the doc comment rewritten for one rule | Codex; the doc comment's order and wording by Claude |
| `.github/workflows/deploy.yml` | `id: orchimg`, the guarded digest output, two consumers | Codex |
| `.github/workflows/cdk-drift.yml` | P4: schedule disarmed, DATED DISARM, two false comments fixed. P5: digest parse and forward | Codex; the DATED DISARM layout, the pull_request note, the resolve-step comment and the removal of a redundant `None` test by Claude |
| `buildspec.yml` | Digest captured after the push; the image-only swap by digest | Codex; the unified-branch comment by Claude |
| `.env.reference` | `CCE_IMAGE_DIGEST` entry; `CCE_IMAGE_TAG` as the fallback | Codex; both annotations rewritten by Claude |
| `docs/lifecycle.md` | The rebuild replays the digest, or `''` | Codex; the sentence order by Claude |
| `docs/runbooks/rollback-bad-image.md` | Pinning by digest; fix path 3(a) rewritten | Codex; "nothing needs rebuilding" added by Claude |
| This file, `HANDOFF.md` and `README.md` §7, on `feature/release-pipeline-v1` | This session's log and the feature's current state | Claude |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| A read-only Opus subagent inspected the diff | `runner.py inspect --host claude` | `claude` is not on the Git Bash PATH here (T9). A subagent needs no CLI and spends no Codex quota |
| Claude applied the review fixes itself; the one narrow Codex correction went unused | `runner.py build --resume … --feedback` | Every accepted finding was comment or doc text, plus one provably redundant shell test, and the replacement text was already written. A Codex round would have spent quota and about 20 minutes retyping it. The plan capped corrections at one; it did not require one. No Codex review of Claude's edits ran: CONSERVE keeps Codex review off by default, and VERIFICATION's fresh critic covers them |
| Cosmetic findings went to CLEANUP, not into these commits | Fix everything now | The implementation commits carry the work order plus corrections of wrong or missing statements, and nothing else |
| Split P4 from P5 by whole hunks with `git apply --cached` | Copy the file out, revert its P5 hunks, then restore it | The first two of the file's four hunks are pure P4 and apply on their own; the working tree never moves |
| No full `npm test` and no nine commands this phase | Run them now | They belong to VERIFICATION (AC-10). The 17 test files that reference the touched artifacts ran instead, as extra evidence |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The rollback shell merges env over `process.env` | the corrected comment above the `CCE_PAPERCLIP_TEARDOWN` forward in `rollback-classes.ts` | yes, in `b27ac38` |
| Under digest pinning, an untagged-expiry rule deletes pinned images | the `ECR_LIFECYCLE_POLICY` doc comment | yes, in `b27ac38` |
| Why the drift schedule is off, and what restores it | the DATED DISARM comment in `cdk-drift.yml` | yes, in `db116ba` |
| Where P4 and P5 stand, and what they filed | `README.md` §7 | yes, in this session's docs commit |

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

### 5.8 Appended this session (2026-09-14, P4/P5 implementation)

| # | Entry | Detail |
|---|---|---|
| T9 | **The claudex runner's Claude inspector can't launch here: `claude` is not on the Git Bash PATH.** `runner.py inspect --host claude --builder codex` makes Claude the inspector and resolves the CLI with `shutil.which("claude")`. `%LOCALAPPDATA%\AnthropicClaude\claude.exe` is the desktop app, not Claude Code. | Use a fresh read-only Opus subagent as the inspector, or pass `--cli` a Claude Code binary whose version you have checked. |
| A13 | **Scheduled workflows run from the default branch, and that is `development`** (`gh repo view --json defaultBranchRef`). | A schedule change on a feature branch does nothing until it merges into `development`. Until then the old schedule keeps firing, and failing. |
| T10 | **Scheduled `cdk-drift` runs land 3–4 h after their 13:00 UTC cron** (16:04 and 16:52 UTC on 2026-09-12 and 2026-09-13). | Re-count `gh run list --event schedule` just before quoting a number, and quote it with its end date. |
| T11 | **Codex's patch tool misread this checkout's UTF-8 em-dashes as cp1252.** Four `apply_patch` calls failed verification with `â€”` in their expected lines; Codex recovered with narrower patches. | After any Codex build here, compare non-ASCII byte counts and look for `â€`, a BOM and U+FFFD in every changed file before trusting the diff. The 2026-09-14 build came back clean. |
| T12 | **Codex writes LF-only lines into CRLF working-tree files**, so git warns "LF will be replaced by CRLF the next time Git touches it". | Cosmetic: `core.autocrlf=true` normalizes on commit, and `git diff` compares normalized text. A whole-file line-ending change does not show up as churn. |
| A13a | **`npm run typecheck` writes `tsconfig.tsbuildinfo`**, which is gitignored. | Expect it in a "files modified since" sweep. It is not a scope violation. |

## 6. Pending work

### 6.1 Smallest next action

Open a fresh session and paste the Gauntlet resume prompt at `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-cleanup-handoff.md`.

### 6.2 Immediate next steps

1. **CLEANUP** (Claude on sonnet, scope-locked). The candidates are listed in the resume prompt. Judge each one; don't apply them blindly.
2. **VERIFICATION**, with a fresh Opus critic:
   - the hermetic synth matrix (AC-8) and the drift-parse harness (AC-9);
   - the mutation check, including reverting Q4's line;
   - the nine `development.md` commands, with Floci (AC-10).
3. **Push and PR:** the user's call, once VERIFICATION passes.

### 6.3 Blockers and open questions

- [ ] **Rollout gate.** Before promoting `qa → staging`, read both orchestrator repos' ECR lifecycle policies and re-apply them without the untagged rule. This needs `aws login` and the owner's consent.
- [ ] **The disarm does nothing until it merges into `development`.** The schedule keeps failing daily until then, and the 2026-10-01 escalation date in `cdk-drift.yml` runs regardless.
- [ ] **Docker Desktop is stopped.** VERIFICATION's `npm run local:test:integration` needs it, and starting it is the user's call.

### 6.4 Deferred, and why

- The plan's "Filed, not acted on" list is unchanged; `README.md` §7 now summarises it.
- Cosmetic findings from this session's inspection went to CLEANUP's candidate list, not into the implementation commits.

## 7. Verification actually performed

| Command | Result |
|---|---|
| `git status --porcelain --untracked-files=all`, at session start | empty; HEAD `4b3393e` |
| `timeout 30 git ls-remote origin development` | `271339bc…` |
| `gh run list … --workflow cdk-drift.yml --event schedule` (14:20 UTC) | 39 runs, 39 failed, 2026-08-06 → 2026-09-13 |
| `gh run view 34769872440 --json jobs` | failed at `Run aws-actions/configure-aws-credentials@7474bc4…` |
| `codex doctor` (0.153.0) | exit 0; one warning: the checkout is not on a Dev Drive |
| Codex build (`runner.py build … --model gpt-5.6-terra --effort medium`) | completed, exit 0, 1330 s. Its own report is not evidence |
| Scope, after the build | exactly the 10 allowed files modified; nothing untracked; HEAD unmoved; no stash |
| Encoding, per changed file | no BOM, mojibake or U+FFFD; non-ASCII bytes unchanged apart from deleted text |
| Proof (three files), Claude's rerun on Codex's snapshot | exit 1, for the known Windows red alone; everything else passes |
| `npm run typecheck`, same snapshot | exit 0 |
| `git diff --check`, same snapshot | exit 0 |
| YAML parse of `deploy.yml`, `cdk-drift.yml` and `buildspec.yml` | 0 errors, 0 warnings; the drift `on:` holds only `workflow_dispatch`; two steps carry the digest |
| 17 related test files (`npx vitest run …`) | 17 files and 339 tests passed |
| `node scripts/ci/docs-links.mjs`, on `feature/release-pipeline-p4-p5` | exit 0 |
| `node scripts/ci/feature-knowledge.mjs`, on `feature/release-pipeline-p4-p5` | exit 0 |
| Fresh read-only Opus inspector, over Codex's snapshot | REVISE: 2 high and 1 medium, all comments; 9 low. Its hand traces confirmed the runtime logic, and every P5 test is met by executable lines |
| Scope, after Claude's review fixes | exactly the 10 allowed files modified; nothing untracked; HEAD still `4b3393e` |
| Encoding, after the fixes | no BOM, mojibake or U+FFFD. Every file Claude touched has CRLF on every line; `deploy.yml` keeps Codex's LF-only lines (cosmetic) |
| YAML parse, after the fixes | 0 errors, 0 warnings; the drift `on:` holds only `workflow_dispatch`; two `deploy.yml` steps carry the digest |
| Proof (three files), after the fixes | exit 1, for the known Windows red alone: 110 passed, 1 failed (111) |
| `npm run typecheck`, after the fixes | exit 0 |
| `git diff --check`, after the fixes | exit 0 |
| 17 related test files, after the fixes | 17 files and 339 tests passed |
| `node scripts/ci/docs-links.mjs` and `node scripts/ci/feature-knowledge.mjs` on `feature/release-pipeline-p4-p5`, after the fixes | both exit 0 |
| `commit.sh` dry run | the P4-only patch (hunks 1–2 of the 5 in `cdk-drift.yml`) mentions no digest and applies to the index cleanly |
| `commit.sh --commit` | `db116ba` (P4), then `b27ac38` (P5), on `4b3393e`. The P4 commit mentions no digest; afterwards `git status` and `git diff HEAD` are empty, so the committed tree is the tested one |
| `node scripts/ci/feature-knowledge.mjs`, on `feature/release-pipeline-v1` with this file | exit 0, run at session close with this file, `HANDOFF.md` and `README.md` §7 in place |
| `node scripts/ci/docs-links.mjs`, on `feature/release-pipeline-v1` with this file | exit 0, run at session close with the same files in place |
| **Not run in this session** | The full `npm test`, `npm run build`, `npm --prefix web run typecheck`, `npm --prefix web run build` and `npm run local:test:integration` belong to VERIFICATION (AC-10), as do the synth matrix, the drift harness and the mutation check. A real deploy can't be verified without AWS |

## 8. Environment state

- **Tools:** Docker Desktop is stopped. The AWS session is expired. `C:` had 8.7 GiB free on 2026-09-14.
- **Clone:** `C:\dev\_netzer-release` is left on `feature/release-pipeline-p4-p5` at `b27ac38`, clean. Typecheck rewrote `tsconfig.tsbuildinfo`, which is gitignored. `.baseline/p4p5-spec/` is still git-excluded.
- **Scratch outside the repo:** the claudex run artifacts (prompt, event log, `result.json`) and the inspection files are in the session scratchpad, which is disposable. The filled work order is at `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-codex-workorder.md`.
- **Active processes:** none started by this session are still running.
- **Primary checkout:** `C:\dev\Netzer-Labs` was not touched.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-09-11-p4-p5-specification.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
