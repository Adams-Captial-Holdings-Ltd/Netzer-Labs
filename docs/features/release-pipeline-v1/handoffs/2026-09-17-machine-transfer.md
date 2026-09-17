---
feature: release-pipeline-v1
document_role: session-handoff
status: current
observed_at: 2026-09-17
as_of_commit: 06dc8aa4ca7db6b83c5815e331667866be9bd956
session_slug: machine-transfer
supersedes: 2026-09-14-p4-p5-cleanup.md
---

# Session handoff: P4 and P5 packed up for the machine transfer, VERIFICATION not started

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-17 |
| Feature folder | `docs/features/release-pipeline-v1/` |
| Branch worked on | `feature/release-pipeline-v1` (this file and `HANDOFF.md` only). `feature/release-pipeline-p4-p5` was only read, then checked out again at the end, unchanged |
| Branch it merges into next | `development` (both branches) |
| AWS environment that branch reaches | none: `feature/*` deploys nothing |
| Commit at session start | `feature/release-pipeline-v1` at `06dc8aa4ca7db6b83c5815e331667866be9bd956`; `feature/release-pipeline-p4-p5` at `4d36c247ad9bbfb3284b8587c660cac2d7935285` (checked out, clean) |
| Commit at session end | the commit that adds this file on `feature/release-pipeline-v1`, whose parent is `06dc8aa`. `feature/release-pipeline-p4-p5` is still at `4d36c24` |
| Pushed | not yet at the time of writing. The coordinator pushes `feature/release-pipeline-v1` and `feature/release-pipeline-p4-p5` to origin under the same names right after this commit, as owner-approved backups (no PR, no merge, no deploy). Confirm with `git ls-remote origin refs/heads/feature/release-pipeline-v1 refs/heads/feature/release-pipeline-p4-p5` |
| PR | none. The transfer opens none |
| Deployed | nothing |

## 2. Current state summary

The owner is moving Netzar OS development off this Windows 11 PC, whose `C:` drive had 3.0 GiB free at the start of this session and 2.5 GiB later in it, to a new Windows PC and a Mac. This session did no release work. It records where P4/P5 stands, so that a session on either new machine can resume without this PC.

- **VERIFICATION has not started.** The clone's HEAD reflog last moved at 2026-09-14 15:27:49 -0400, when the clone switched back to `feature/release-pipeline-p4-p5` after `06dc8aa`. The tree was clean at the start of this session. What the cleanup log ([`2026-09-14-p4-p5-cleanup.md`](./2026-09-14-p4-p5-cleanup.md)) describes is still the current state: built and cleaned up, but not verified.
- **The code and the docs are on two sibling branches, both cut from `development` at `271339bc`.**
  - The code is on `feature/release-pipeline-p4-p5`, in four commits (`271339bc..4d36c24`): `4b3393e` (the red tests), `db116ba` (the drift disarm), `b27ac38` (the digest pin) and `4d36c24` (the cleanup).
  - The docs are on this branch, `feature/release-pipeline-v1`: `06dc8aa`, plus the commit that adds this file.
  - Neither branch contains the other's commits.
- **Both branches are pushed on 2026-09-17, as owner-approved backups.** The verification handoff said "no push" and left pushing to the user. The owner has now made that call, for the transfer only.
  - There is no PR and no merge, so the P4 cdk-drift disarm still has no effect until it reaches `development` (A13), and the 2026-10-01 escalation date in `cdk-drift.yml` still applies.
  - When this file was written, `git ls-remote` showed neither branch on origin. The coordinator pushes both right after this commit.
- **The ECR retention gate is still applied.** It went in on 2026-09-14 at 19:20:54 UTC (staging) and 19:21:17 UTC (production). Before any `qa → staging` promotion, re-read both orchestrator repos' lifecycle policies (read-only). A local `npm run deploy` from pre-P5 code puts the untagged rule back.
- **The state that git doesn't hold goes to the private devkit repo** (`netzer-devkit`): the plans, the git-excluded `.baseline/` folder and the session scratchpads. §8 says where each one goes.
- **Two things don't carry over unchanged.**
  - The verification prompt's "five known Windows reds" were only ever measured on this PC, so a session on the Mac records its own baseline first (T14).
  - `feature/bedrock-all-models` also adds an ADR 0011 (T16).

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **The two branches don't overlap.**
  - `git log feature/release-pipeline-v1..feature/release-pipeline-p4-p5` lists exactly the four WI-1 commits, and the merge base is `271339bc`.
  - `feature/release-pipeline-p4-p5` has neither `9892afd` (P1, P2, P6) nor a `docs/features/release-pipeline-v1/` folder.
  - So a reviewer who reads one branch sees none of the other's changes. Run the docs gates for this folder on `feature/release-pipeline-v1`.
- **`.baseline/` is git-excluded only by this clone's `.git/info/exclude`.** That file isn't versioned, so a clone or a push doesn't carry the exclusion (T15).
- **ADR 0011 is claimed twice** (T16). This branch adds `docs/adr/0011-release-artifact-identity.md` (in `9892afd`). `feature/bedrock-all-models` adds `docs/adr/0011-every-bedrock-model-for-agents.md`.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `docs/features/release-pipeline-v1/HANDOFF.md` | The feature's current state | Updated with the push, the transfer and this file |
| `docs/features/release-pipeline-v1/handoffs/2026-09-14-p4-p5-cleanup.md` | The previous session log | Source of §5, carried verbatim |
| `.git/info/exclude` (not versioned) | Holds the line `.baseline/` | A new clone must re-add it (T15) |
| `.baseline/` (`run-gate.sh`, `capture.mjs`, `mutate.mjs`, `wf/a-corpus.mjs`, `wf/b-close.mjs`, and the `baseline/`, `after/` and `p4p5-spec/` gate reports; 3.5 MiB) | The 2026-09-07/08 release gate and mutation harness, and the P4/P5 specification baseline | Git doesn't track it, so it goes to the devkit's `archive/release-baseline/` |
| `docs/adr/0011-release-artifact-identity.md` | This feature's ADR | Its number collides with `feature/bedrock-all-models` (T16) |
| `~/.claude/plans/release-p4-p5-verification-handoff.md` | The VERIFICATION resume prompt | Embedded verbatim in Appendix A |

### 3.3 Patterns and conventions to follow

- **Carry §5 forward with a script, not by hand.** Cut the previous log's committed blob between its `## 5.` and `## 6.` headings, append your own entries below it, and compare the carried part byte for byte (§7).
- **Call a push that isn't a review request a backup.** A branch on origin with no PR changes nothing that the scheduled workflows or the deploys read.

## 4. Work completed

### 4.1 Tasks finished

- [x] Baseline: at session start the clone was clean on `feature/release-pipeline-p4-p5` at `4d36c24`. The reflog, free disk, remote refs and both docs gates on `feature/release-pipeline-v1` were recorded (§7).
- [x] Re-checked how the two branches relate, and what origin holds.
- [x] Confirmed the ADR 0011 clash on `feature/bedrock-all-models` in `C:\dev\_netzer-allmodels`.
- [x] Listed the campaign's state outside git, with the devkit path for each item (§8).
- [x] Wrote this file. §5 is carried verbatim and extended in §5.10, and Appendix A embeds the resume prompt verbatim.
- [x] Updated `HANDOFF.md`: the pushed state, the transfer, the smallest next action and the session index.
- [x] Reran both docs gates, then made one local commit on `feature/release-pipeline-v1`.
- [ ] Push both branches: the coordinator does this after this commit.
- [ ] VERIFICATION: the next working session, on a new machine.

### 4.2 Files modified

| File | Change | Author |
|---|---|---|
| `docs/features/release-pipeline-v1/handoffs/2026-09-17-machine-transfer.md` | New: this session log | Claude |
| `docs/features/release-pipeline-v1/HANDOFF.md` | `observed_at` and `as_of_commit` updated; the pushed state, the transfer, the blockers and the smallest next action rewritten; this file added to the top of the session index | Claude |

Nothing on `feature/release-pipeline-p4-p5` changed, and `.baseline/` wasn't touched.

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Record the push as a backup that changes nothing downstream | Say "pushed" with no qualifier | A pushed branch reads as ready for review. The disarm, the escalation date and the ECR re-read all depend on a merge that hasn't happened |
| `as_of_commit` is `06dc8aa`, this branch's tip before the commit | `4d36c24`, which the previous `HANDOFF.md` used | The transfer rules name the branch tip before this commit. §1 and `HANDOFF.md` name both tips |
| Embed the resume prompt verbatim, including its stale lines | Fix its "Unpushed; the only copy" line and its Windows paths | The Gauntlet reads the prompt as written, and an edited copy here would diverge from the devkit's copy. Appendix A lists the lines this file supersedes |
| Leave `README.md`, `development.md` and the ADRs alone | Renumber ADR 0011; add a Mac note to `development.md` | This task covers only the handoff and `HANDOFF.md`. The verification prompt forbids edits to `development.md`, and the renumbering depends on a merge order nobody has chosen |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| `.baseline/` is git-excluded only by `.git/info/exclude` | The devkit's `RESTORE.md` (the coordinator writes it) | no: it describes this clone, not the repository. Tracked as T15 |
| This branch's ADR 0011 collides with `feature/bedrock-all-models` | `docs/adr/README.md`, once the merge order is known | no: it can change until one branch merges. Tracked as T16 and in `HANDOFF.md` |
| The known reds were measured on Windows only | `development.md` (A2 says its guide was verified on macOS) | no: the verification prompt puts `development.md` off-limits. Tracked as T14 |

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

### 5.9 Appended this session (2026-09-14, P4/P5 cleanup)

| # | Entry | Detail |
|---|---|---|
| T13 | **`MSYS_NO_PATHCONV=1` also stops Git Bash translating `git -C /c/...`.** `MSYS_NO_PATHCONV=1 git -C /c/dev/_netzer-release show rev:path > file` failed with `cannot change to '/c/dev/_netzer-release'`, and the redirect left an empty file without stopping the script. | With `MSYS_NO_PATHCONV=1`, pass `-C C:/dev/_netzer-release`. Check a dumped file's size before reading it. |
| A14 | **Free disk on `C:` fell from 8.7 GiB to 5.3 GiB during 2026-09-14**, and nothing in this clone accounts for it. | Re-measure before VERIFICATION's full `npm test`: M15 shows what low disk does to that run. |
| M16 | **The implementation log recorded "17 related test files … 339 tests" without naming the files.** This session rebuilt a set of 17 by grepping the test files for the touched artifacts and got 349, so its commit guard refused to commit. A stash run then gave 349 at `b27ac38` too, file for file. The implementation session had run `scripts/lib/lifecycle/manifest.test.ts` (14 tests) where this session ran `scripts/up.test.ts` (24). | Record the exact command or file list beside any test count a later session will compare against. §7 lists this session's set. |

### 5.10 Added 2026-09-17 (machine transfer)

| # | Entry | Detail |
|---|---|---|
| A15 | **VERIFICATION still hadn't started on 2026-09-17.** The clone's HEAD reflog last moved at 2026-09-14 15:27:49 -0400. The tree was clean on `feature/release-pipeline-p4-p5` at `4d36c24`. | The cleanup log's §2, §6 and §7 still describe the current state. On a later date, re-measure before relying on them. |
| A16 | **Both branches are pushed on 2026-09-17 as owner-approved backups, with no PR and no merge.** Until then the verification handoff said "no push" and left pushing to the user. | A branch on origin hasn't merged. The disarm does nothing until it reaches `development` (A13), and the 2026-10-01 escalation date still applies. From this date the resume prompt's "No upstream; nothing pushed" and "Unpushed; the only copy" lines are out of date. Confirm with `git ls-remote origin refs/heads/feature/release-pipeline-p4-p5 refs/heads/feature/release-pipeline-v1`. |
| A17 | **Free disk on `C:` dropped again: 3.0 GiB at the start of this session on 2026-09-17, and 2.5 GiB later in it, while other agents worked in sibling clones.** It was 5.3 GiB late on 2026-09-14 (A14). | This PC can't run the full suite safely any more (M15). Run VERIFICATION on the new machine. |
| T14 | **The "five known Windows reds" were only ever measured on this Windows PC,** yet the verification prompt's AC-10 exempts them by name. | On the Mac or any new machine, record a fresh baseline on `271339bc` first (P1), and exempt only the reds that baseline shows. Don't assume the same five, or only five. |
| T15 | **`.baseline/` is git-excluded only by `.git/info/exclude`,** which isn't versioned, so a clone or a push doesn't carry the exclusion. | In a new clone, add the line `.baseline/` to `.git/info/exclude` before restoring the folder from the devkit's `archive/release-baseline/`. Otherwise `git status --porcelain --untracked-files=all` lists the folder, and VERIFICATION requires that output to be empty. |
| T16 | **Two unmerged branches each add an ADR 0011.** This branch adds `docs/adr/0011-release-artifact-identity.md` (`9892afd`). `feature/bedrock-all-models` adds `docs/adr/0011-every-bedrock-model-for-agents.md` (seen at `94e3686` in `C:\dev\_netzer-allmodels` on 2026-09-17). | Whichever branch merges into `development` second renumbers its ADR and fixes every link to it, including the one in this folder's `HANDOFF.md`. |
| T17 | **The earlier logs and the resume prompt give paths on the old Windows PC,** such as `C:\dev\_netzer-release`, `C:\Users\EmmanuelAdams\.claude\plans\…` and `%TEMP%` scratchpads. | Translate them with Appendix A's path map. The Git Bash notes (T13, `MSYS_NO_PATHCONV`, `cygpath`, PowerShell 5.1) and `-c windows.sandbox="elevated"` don't apply on macOS. |
| T18 | **This clone's origin is `https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs.git`,** but `development.md`'s "Initial setup" on this branch clones `emmanuelmadams4-lgtm/Netzer-Labs.git`. | Clone the fresh copy from the origin URL above, which is where the branches are pushed. Before following the other URL, check where it leads (see M9). |

## 6. Pending work

### 6.1 Smallest next action

Start VERIFICATION in a fresh session, on a new machine. First restore the devkit, and make a fresh clone of origin with `feature/release-pipeline-p4-p5` checked out (HEAD `4d36c247ad9bbfb3284b8587c660cac2d7935285`). Then paste in the resume prompt from Appendix A (devkit `claude/plans/release-p4-p5-verification-handoff.md`).

### 6.2 Immediate next steps

1. **Restore the devkit** by following its `RESTORE.md`, so that `~/.claude/plans/` holds the resume prompt, the approved plan and the work order (Appendix A).
2. **Make a fresh clone.**
   - `git clone https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs.git <dev-root>/_netzer-release`, then `git switch feature/release-pipeline-p4-p5`.
   - Confirm `git rev-parse HEAD` prints `4d36c247ad9bbfb3284b8587c660cac2d7935285`.
   - Also create `feature/release-pipeline-v1` locally from origin, because VERIFICATION commits its session log there.
   - A fresh clone has no git identity, so pass `-c user.name="Emmanuel Adams" -c user.email="emmanuelmadams4@gmail.com"` on each commit.
3. **Install dependencies** as `development.md` "Initial setup" says (`npm ci --ignore-scripts`). This session didn't run it.
4. **Optionally, restore `.baseline/`.** First add `.baseline/` to `.git/info/exclude` (T15), then copy the devkit's `archive/release-baseline/` into `.baseline/`. VERIFICATION doesn't read it; it holds the 2026-09-07/08 gate history and the P4/P5 specification baseline.
5. **Record a fresh suite baseline on the new machine** before judging AC-10 (T14).
6. **Run VERIFICATION as the prompt says,** translating its paths with the path map (T17). Its lines about being unpushed are out of date (A16).
7. **After a PASS, the next steps are the user's call.**
   - Opening a PR into `development`, and merging it, is the user's decision. That merge is what makes the disarm take effect.
   - Before `qa → staging`, re-read both ECR lifecycle policies. The read is read-only but needs `aws login`, so ask first.

### 6.3 Blockers and open questions

- [ ] Blocker: the drift disarm does nothing until it merges into `development`, and the 2026-10-01 escalation date in `cdk-drift.yml` applies regardless. Needs: a VERIFICATION PASS, then the user's PR and merge.
- [ ] Blocker: re-read both ECR lifecycle policies before `qa → staging`, because a local `npm run deploy` from pre-P5 code undoes the gate. Needs: a live `netzer-root` session, with the owner's consent.
- [ ] Blocker: `release.yml` still needs `RELEASE_SIGNING_KEY`. Needs: the owner's decision under the parent release plan.
- [ ] Blocker: VERIFICATION's `npm run local:test:integration` needs Docker for Floci, and nobody has checked Docker on the new machines. Needs: the user to start it. On Apple Silicon, Docker builds arm64 natively and amd64 under emulation.
- [ ] Question: which branch keeps ADR 0011 (T16)? Suggested resolution: whichever merges into `development` second renumbers.
- [ ] Question: which reds does the new machine show on `271339bc`? Suggested resolution: record that baseline before VERIFICATION judges AC-10 (T14).

### 6.4 Deferred, and why

- Everything the cleanup log's §6.4 defers stays deferred, and the plan's "Filed, not acted on" list is unchanged: scope discipline.
- The stale `ensureEcrLifecyclePolicy` docstring in `bootstrap-state.ts` stays filed, as the verification prompt says.
- Renumbering ADR 0011 is deferred until the merge order is known.

## 7. Verification actually performed

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `df -h /c` | 3.0G available of 238G (99% used) at session start | 2.5G available, just before this file was assembled |
| `git status --short --branch`, at session start | `## feature/release-pipeline-p4-p5` and nothing else; HEAD `4d36c24` | n/a |
| `git reflog --date=iso -12` | newest entry: `4d36c24 HEAD@{2026-09-14 15:27:49 -0400}: checkout: moving from feature/release-pipeline-v1 to feature/release-pipeline-p4-p5` | n/a |
| `git merge-base feature/release-pipeline-v1 feature/release-pipeline-p4-p5` | `271339bc8b2feea85e6c31b115fdd34e757a72e2` | n/a |
| `git log --oneline feature/release-pipeline-v1..feature/release-pipeline-p4-p5` | `4d36c24`, `b27ac38`, `db116ba`, `4b3393e` | n/a |
| `git log --oneline feature/release-pipeline-p4-p5..feature/release-pipeline-v1` | `06dc8aa`, `8d96ee0`, `913cae4`, `1203fc9`, `4a01b6e`, `9892afd` | n/a |
| `git ls-tree --name-only feature/release-pipeline-p4-p5 docs/features/` | no `release-pipeline-v1` folder | n/a |
| `timeout 30 git ls-remote origin refs/heads/feature/release-pipeline-v1 refs/heads/feature/release-pipeline-p4-p5 refs/heads/development` | exit 0; only `271339bc… refs/heads/development` came back, so neither feature branch is on origin | n/a: the push is the coordinator's step |
| `git -C C:/dev/_netzer-allmodels ls-tree --name-only feature/bedrock-all-models docs/adr/` | lists `docs/adr/0011-every-bedrock-model-for-agents.md`; that branch is at `94e36864e76e7f7e1bfa4c1b5743f543f10bbaad` | n/a |
| `du -sh .baseline` | 3.5M | n/a: not touched |
| `node scripts/ci/feature-knowledge.mjs`, on `feature/release-pipeline-v1` | exit 0, `feature-knowledge: OK`, at `06dc8aa` | exit 0, `feature-knowledge: OK`, with this file and `HANDOFF.md` staged |
| `node scripts/ci/docs-links.mjs`, on `feature/release-pipeline-v1` | exit 0: 143 Markdown files, 1804 internal links checked, 71 external links skipped | exit 0: 144 Markdown files, 1830 internal links checked, 71 external links skipped |
| `git diff --check` | exit 0 (clean tree) | `git diff --cached --check`: exit 0 |
| §5 carry check (script): this file's carried part against `git show HEAD:…/2026-09-14-p4-p5-cleanup.md`, from `## 5.` up to `## 6.` | n/a | equal: 17,932 bytes each, with the same SHA-256 (`0f93667f399117d7…`) |
| Appendix A check (script): the fenced prompt against `~/.claude/plans/release-p4-p5-verification-handoff.md` | n/a | equal: 15,244 bytes each, with the same SHA-256 (`53117ce3d46e88b3…`). The staged blob contains no CR, and every line in the working tree ends in CRLF |
| Secret-pattern grep over the staged diff: the transfer checklist of AWS access-key, GitHub token, Slack token, Anthropic key and private-key prefixes, plus runs of 40 or more base64 characters | n/a | no prefix hits. Every run of 40 or more characters is a commit SHA, a file path or a URL |
| `npm run typecheck`, `npm test`, `npm run build`, `npm --prefix web run typecheck`, `npm --prefix web run build`, `npm run local:test:integration` | not run | not run |

Anything not run, and why:

- The suite: this session only changed documentation, and the suite belongs to VERIFICATION on the new machine. This PC has 2.5 to 3.0 GiB free (A17).
- No AWS, `gh` or Docker command ran.
- Switching the clone back to `feature/release-pipeline-p4-p5` happens after this file is committed, so its result goes to the coordinator instead of into this file.

## 8. Environment state

- **Tools and services:** Windows 11 Pro, Git 2.55.0.windows.3 and Node v24.19.0. Nobody checked Docker Desktop this session; it was stopped on 2026-09-14. No AWS command ran. The 2026-09-14 `netzer-root` session is assumed expired, since `aws login` lasts about two hours.
- **Clone:** `C:\dev\_netzer-release`. Its origin is `https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs.git`. This session commits on `feature/release-pipeline-v1` and then switches back to `feature/release-pipeline-p4-p5` at `4d36c24`. It has no uncommitted work, and this session used no stash.
- **Pushed:** not yet at the time of writing. The coordinator pushes `feature/release-pipeline-v1` and `feature/release-pipeline-p4-p5` to origin under the same names right after this commit, as owner-approved backups (no PR, no merge, no deploy). Confirm with `git ls-remote origin refs/heads/feature/release-pipeline-v1 refs/heads/feature/release-pipeline-p4-p5`.
- **Environment variables:** none set or needed.
- **Active processes:** none.
- **Primary checkout:** `C:\dev\Netzer-Labs` wasn't touched.
- **Where each piece of state outside git goes in the devkit** (`https://github.com/emmanuelmadams4-lgtm/netzer-devkit`, private):

| What | Where on this PC | Devkit path |
|---|---|---|
| VERIFICATION resume prompt | `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-verification-handoff.md` | `claude/plans/release-p4-p5-verification-handoff.md` |
| Approved plan, work order, specification plan, parent release plan, earlier phase prompts | `C:\Users\EmmanuelAdams\.claude\plans\` | `claude/plans/` (each file listed in Appendix A) |
| `.baseline/`: `run-gate.sh`, `capture.mjs`, `mutate.mjs`, `wf/*.mjs`, gate reports in `baseline/`, `after/` and `p4p5-spec/` (3.5 MiB) | `C:\dev\_netzer-release\.baseline\`, git-excluded by `.git/info/exclude` | `archive/release-baseline/`. A new clone must re-add `.baseline/` to `.git/info/exclude` (T15) |
| Latest source of the progress page, `digest-pin-gauntlet.html` | `%TEMP%\claude\C--dev-Netzer-Labs\efa72f5c-4d1f-4809-aa74-19f1152c8023\scratchpad\` | `archive/scratch/efa72f5c/digest-pin-gauntlet.html` |
| ECR lifecycle policies before and after the gate: `ecr-policy-before-claudeclaw-orchestrator.json`, `ecr-policy-before-claudeclaw-staging-orchestrator.json`, `ecr-policy-after-claudeclaw-orchestrator.json` and `ecr-policy-after-claudeclaw-staging-orchestrator.json`. Also the applied `ecr-policy-new.json`, `apply-ecr-gate.sh` and `ecr-policy-check.mjs` | the same scratchpad | `archive/scratch/efa72f5c/` |
| The cleanup session's other working files (gate logs, tested diffs, backups of the six edited files) | the same scratchpad | `archive/scratch/efa72f5c/` |
| Older release working files from the implementation session (claudex build run, inspection logs, handoff drafts, commit patches) | `%TEMP%\claude\C--dev-Netzer-Labs\a0d7de9f-c832-4d58-86dd-899be1faf53f\scratchpad\` | `archive/scratch/a0d7de9f/` |
| Session transcripts | `C:\Users\EmmanuelAdams\.claude\projects\C--dev-Netzer-Labs\<id>.jsonl` | `claude/transcripts/<id>.jsonl.gz`, for `7d57a23b-60e8-4e7e-8653-597cf10e8788`, `a0d7de9f-c832-4d58-86dd-899be1faf53f` and `efa72f5c-4d1f-4809-aa74-19f1152c8023` |
| Campaign memory note `release-pipeline-p4-p5-campaign.md` | `C:\Users\EmmanuelAdams\.claude\projects\C--dev-Netzer-Labs\memory\` | `claude/memory/` |
| Gauntlet folder | none: `~/.claude/gauntlet/` holds only `bedrock-all-models` and `seats-pickers-hotfix` | n/a |
| Live progress page | `https://claude.ai/code/artifact/1fe42496-108e-4964-b8e0-b34d04b1c3af` | not a file; it stays online |

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-09-14-p4-p5-cleanup.md)
- [ADR 0011: release artifact identity](../../../adr/0011-release-artifact-identity.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
- The resume prompt and the campaign's plans: Appendix A, and devkit `claude/plans/`.

## Appendix A - Resume on a new machine

### A.1 Path map

| On the old PC (Windows) | On a new machine | Source |
|---|---|---|
| `C:\Users\EmmanuelAdams\.claude\plans\<file>` | `~/.claude/plans/<file>`, after running the devkit restore | devkit `claude/plans/<file>` |
| `C:\Users\EmmanuelAdams\.claude\gauntlet\<campaign>` | `~/.claude/gauntlet/<campaign>` | devkit `claude/gauntlet/<campaign>/`. This campaign has no gauntlet folder |
| `C:\dev\_netzer-release` | `<dev-root>/_netzer-release`: a fresh clone of origin with `feature/release-pipeline-p4-p5` checked out; also create `feature/release-pipeline-v1` locally | origin, `https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs.git` |
| `C:\dev\_netzer-release\.baseline\` | `<dev-root>/_netzer-release/.baseline/`, after adding `.baseline/` to `.git/info/exclude` | devkit `archive/release-baseline/` |
| `C:\dev\_netzer-allmodels` (`feature/bedrock-all-models`, for T16) | `<dev-root>/_netzer-allmodels` | that campaign's own handoff |
| `%TEMP%\claude\C--dev-Netzer-Labs\efa72f5c-…\scratchpad\` (cleanup session) | not needed to resume | devkit `archive/scratch/efa72f5c/` |
| `%TEMP%\claude\C--dev-Netzer-Labs\a0d7de9f-…\scratchpad\` (implementation session) | not needed to resume | devkit `archive/scratch/a0d7de9f/` |
| `codex.exe` under `AppData` (`~/.codex/.sandbox-bin/`, T4) | the `codex` CLI on PATH; pass its absolute path to `--cli` | n/a |
| `-c windows.sandbox="elevated"` | drop it on macOS | n/a |
| `cygpath`, `MSYS_NO_PATHCONV` (T13), PowerShell 5.1 notes | Windows and Git Bash only | n/a |
| Docker Desktop in `%LOCALAPPDATA%\Programs\DockerDesktop` (A9) | the new machine's Docker; on Apple Silicon it builds arm64 natively and amd64 under emulation | n/a |

### A.2 The plans this campaign cites, at devkit paths

- `claude/plans/release-p4-p5-verification-handoff.md`: the VERIFICATION resume prompt, embedded below.
- `claude/plans/implement-phases-p4-and-nested-clock.md`: the approved P4/P5 plan. Its closing "Amendment Q4" supersedes site 3, and its Verification section defines AC-8's matrix.
- `claude/plans/release-p4-p5-codex-workorder.md`: the frozen, filled Codex work order.
- `claude/plans/read-c-users-emmanueladams-claude-plans-staged-thompson.md`: the SPECIFICATION-phase plan.
- `claude/plans/plan-the-netzer-enterprise-ticklish-engelbart.md`: the parent v1.0.0 release plan.
- Earlier phase prompts and logs, kept as history: `claude/plans/release-p4-p5-handoff.md` (SPECIFICATION prompt), `claude/plans/release-p4-p5-implementation-handoff.md`, `claude/plans/c-users-emmanueladams-downloads-release-wise-tiger.md` (IMPLEMENTATION plan), `claude/plans/release-p4-p5-cleanup-handoff.md` and `claude/plans/release-p4-p5-cleanup-session-log.md`.

### A.3 The VERIFICATION resume prompt, verbatim

Devkit path: `claude/plans/release-p4-p5-verification-handoff.md`. On the old PC it was `C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-verification-handoff.md`: 15,244 bytes, LF line endings, no backtick fences. It is copied below unedited. This file overrides these of its lines:

- "No upstream; nothing pushed" and "Unpushed; the only copy": both branches are pushed as backups (A16).
- Every `C:\…` and Git Bash path: use the path map (T17).
- "the five known Windows reds": record the new machine's own baseline first (T14).
- "Docker Desktop is stopped": its state on the new machine is unknown.

`````text
GAUNTLET_MODE: DIRECT_COORDINATOR
GAUNTLET_PHASE: VERIFICATION

This is a Gauntlet Loop handoff for a fresh session.

Before doing substantive work, load/re-read the gauntlet-loop skill.
The mode and phase markers are authoritative.
Do not generate another generic Gauntlet prompt.
Do not restart completed phases.
Do not rely on prior conversation context.
Restore state from this handoff and execute only the named phase.

GOAL
Netzar OS Enterprise release plan, phases P4 and P5 (WI-1).
- P5: pin the orchestrator ECS task definition by image DIGEST wherever one is supplied.
  - Fallback order: CCE_IMAGE_DIGEST, then CCE_IMAGE_TAG → DEPLOY_SHA → gitSha(), then 'orchestrator-digest-unset'.
  - Every driver forwards the digest, and CI produces it.
- P4: disarm cdk-drift.yml's schedule without deleting the workflow.

APPROVED PLAN (the authoritative detail)
- Plan: C:\Users\EmmanuelAdams\.claude\plans\implement-phases-p4-and-nested-clock.md. Its closing "Amendment Q4" supersedes site 3, and its Verification section defines AC-8's matrix (step 2).
- Settled decisions:
  - Q1: deploy:cloud's image-only swap is pinned by digest.
  - Q2: delete ECR lifecycle rule 1.
  - Q3: defer :latest.
  - Q4 (2026-09-11): the rollback synthEnv ALWAYS carries `CCE_IMAGE_DIGEST: target.imageDigest ?? ''`, because the real shell merges over process.env (scripts/rollback.ts:150).
- Codex work order (frozen, filled): C:\Users\EmmanuelAdams\.claude\plans\release-p4-p5-codex-workorder.md.
- Session logs, on feature/release-pipeline-v1: docs/features/release-pipeline-v1/handoffs/2026-09-10-p4-p5-planning.md, 2026-09-11-p4-p5-specification.md, 2026-09-14-p4-p5-implementation.md, 2026-09-14-p4-p5-cleanup.md.

BAR (objective; unchanged)
- AC-1: synth renders `claudeclaw-orchestrator@<digest>` for BOTH the orchestrator and worker containers when CCE_IMAGE_DIGEST is set.
- AC-2: a malformed CCE_IMAGE_DIGEST (not /^sha256:[0-9a-f]{64}$/) fails synth, naming the variable.
- AC-3: with no digest, today's tag chain is unchanged. ci.yml:122 stays `CCE_IMAGE_TAG: ci`.
- AC-4 (amended by Q4): the rollback --rebuild-from-git child env carries CCE_IMAGE_DIGEST = the manifest's imageDigest, OR '' WHEN IT HAS NONE, and still carries CCE_IMAGE_TAG.
- AC-5: every driver forwards the digest (deploy.ts cdkEnvBag + the env assignment; deploy.yml `id: orchimg`, consumed EXACTLY twice; cdk-drift.yml parses `*@sha256:*`; buildspec.yml captures, guards, exports, and its image-only branch uses `$IMAGE_URI@$DIGEST`).
- AC-6: the ECR lifecycle policy has exactly one rule (keep the newest 50).
- AC-7 (P4): schedule commented out, workflow_dispatch kept; a DATED DISARM comment with the date, the evidence, the two-part restore and "escalate rather than extend" by 2026-10-01; the false comments at :10 and :25-30 fixed.
- AC-8: the hermetic cdk synth matrix (digest / tag / bare / bogus), per the plan's Verification step 2.
- AC-9: the drift-parse harness (`:tag`, `@sha256:`, `None`).
- AC-10: the nine development.md commands pass, apart from the five known Windows reds.
- AC-11: docs updated (.env.reference, docs/lifecycle.md, docs/runbooks/rollback-bad-image.md); the feature folder updated on feature/release-pipeline-v1.
- Mutation check: reverting each guard turns its test red, including reverting Q4's line to a conditional spread.

CURRENT WORK ITEM
WI-1: P4 and P5 as one work item, in local commits on feature/release-pipeline-p4-p5:
1. 4b3393e test(deploy): the red-test checkpoint;
2. db116ba ci(drift): disarm the cdk-drift schedule until the diff role exists;
3. b27ac38 feat(deploy): pin the orchestrator task definition by image digest;
4. 4d36c24 refactor(deploy): tidy the digest pin and drift disarm.

CURRENT PHASE
VERIFICATION. PLAN, SPECIFICATION, IMPLEMENTATION and CLEANUP are complete. Do not reopen them. A failure is routed to the right phase in a NEW session (step 5).

AUTHORSHIP (for routing only; never give it to the critic)
- Implementation: Codex (gpt-5.6-terra, codex-cli 0.153.0), one attempt, from the frozen work order.
- Review fixes before the P4/P5 commits: Claude (Opus 5), after a fresh Opus inspection. Per file in the implementation log's §4.2.
- Cleanup, 4d36c24: Claude (Opus 5). Text only, in six files. Per file in the cleanup log's §4.2.
- No Codex review has run. This phase's critic is the first independent look at Claude's review fixes and at the cleanup.

BASELINE
- Clone: C:\dev\_netzer-release (Git Bash: /c/dev/_netzer-release), on feature/release-pipeline-p4-p5 at 4d36c24. No upstream; nothing pushed.
- feature/release-pipeline-v1 = 271339bc + 9892afd + 4a01b6e + 1203fc9 + 913cae4 + 8d96ee0 (the cleanup session log and HANDOFF.md) + 06dc8aa (the ECR gate recorded). Unpushed; the only copy.
- Suite baseline on 271339bc (2026-09-11): typecheck exit 0; `npm test` shows the five known Windows reds (collection failures in docs-links, feature-knowledge, runnable-blocks, sync-deprecations; rollback-classes "deploys the archived assembly with --app and diffs first"). durability.repro may time out under load but is hermetic.
- Re-check first: `timeout 30 git ls-remote origin development` (271339bc on 2026-09-14); `git status --porcelain --untracked-files=all` (must be empty); free disk on C: (5.3 GiB late on 2026-09-14, down from 8.7 GiB that morning). A netzer-root AWS session was live at 19:21 UTC on 2026-09-14 and lasts about two hours, so assume it has expired; ask before running aws login. Docker Desktop is stopped; wrap `docker info` in timeout.

CURRENT EVIDENCE (at 4d36c24: the builders' own runs, not a verdict)
- Proof: exit 1 for the known Windows red alone, 110 passed and 1 failed (111).
- `npm run typecheck` exit 0; `git diff --check` exit 0.
- The 17 related test files: 17 files, 349 tests passed (listed in the cleanup log §7); the same set gives 349 at b27ac38, file for file. The implementation session counted 339 on a set with scripts/lib/lifecycle/manifest.test.ts (14 tests) in place of scripts/up.test.ts (24), and manifest.test.ts passes 14 of 14 at 4d36c24.
- `node scripts/ci/docs-links.mjs` and `node scripts/ci/feature-knowledge.mjs` exit 0 on feature/release-pipeline-p4-p5, and on feature/release-pipeline-v1 with the cleanup log in place.
- YAML parse of cdk-drift.yml, deploy.yml and buildspec.yml: 0 errors, 0 warnings; the drift `on:` holds only `workflow_dispatch`.
- The drift resolve step's real lines, run in bash: `repo@sha256:…` gives outputs `tag=` and `digest=sha256:…`; `repo:abc1234def56` gives `tag=abc1234def56` and `digest=`; `None` and '' give both empty. That is a spot check, not AC-9.
- Encoding: no BOM, U+FFFD or mojibake, and no LF-only lines, in the six cleanup files.

NEXT OBJECTIVE (this session only)
1. Load gauntlet-loop and netzer-os-development-process (read the clone's root development.md first), plus git (local only). Declare the governing development.md sections before acting.
2. Re-check BASELINE. Start this session's repo handoff (framework §6a) outside the clone, carrying §5 forward verbatim from 2026-09-14-p4-p5-cleanup.md. At the end, commit it on feature/release-pipeline-v1 with HANDOFF.md pointing at it.
3. Fresh critic. Spawn a read-only Opus subagent, with the model set explicitly. Give it only the GOAL, the BAR, the spec tests (`git show 4b3393e`), the implementation diff (`git diff 4b3393e..HEAD`), the plan and work-order paths, and these rules:
   - return PASS or FAIL per criterion, with command output or file:line evidence;
   - name any change the plan does not call for;
   - say whether anything in 4d36c24 changes behaviour. It changes the malformed-digest error's text and the drift step's log line, and claims no render, step output, exit code or assertion moves.
   Do not give it authorship, iteration history or the builders' evidence.
4. Run the objective gates yourself, one at a time:
   a. AC-8: the hermetic cdk synth matrix per the plan's Verification step 2 (digest / tag / bare / bogus). Seed the gitignored cdk.context.json if synth needs lookups.
   b. AC-9: the drift-parse harness (`:tag`, `@sha256:`, `None`), run against the resolve step's real lines cut from the parsed YAML.
   c. The mutation check: revert each guard in turn and confirm its test goes red, including Q4's line reverted to a conditional spread. Restore the tree and confirm it is clean after each.
   d. AC-10: the nine commands in development.md's "How to develop a new feature, end to end", step 7. `npm run local:test:integration` needs Floci, so ASK the user before starting Docker Desktop, and never run test:integration:up. Check free disk before the full `npm test`, and run nothing heavy beside it. Record the five known Windows reds, and never record an unrun command as passing.
   e. AC-11's feature-folder half: README, HANDOFF and session logs on feature/release-pipeline-v1.
5. Verdict. PASS only if every AC and the mutation check pass (the five known Windows reds excepted) and the critic reports no blocking finding.
   - PASS: WI-1 is complete. What follows is the user's call: push and PR, the ECR rollout gate, and the merge into development that makes the disarm take effect. Emit a completion note; do not push.
   - FAIL: write a handoff with the failing evidence for a NEW session. A wrong or missing spec goes to SPECIFICATION; a code defect goes to IMPLEMENTATION, with Claude as the provider because WI-1's Codex build attempt is spent; a cleanup regression goes to CLEANUP.
6. Emit the next handoff and stop.

PROOF
- `npx vitest run infra/lib/compute-stack.test.ts scripts/lib/lifecycle/rollback-classes.test.ts scripts/lib/lifecycle/paperclip-image-pipeline.test.ts`: everything passes except the known Windows red "deploys the archived assembly with --app and diffs first", so the exit code stays 1 for that alone.
- `npm run typecheck`, exit 0.

EXPECTED SCOPE
- Read-only against both branches' committed code. The only writes: this session's log and HANDOFF.md on feature/release-pipeline-v1, the gitignored cdk.context.json, and mutations that are reverted before the next step.
- Nothing gets fixed in this phase. A finding becomes a routed handoff.

NOT VERIFIABLE WITHOUT AWS OR MISSING TOOLS (never claim these)
- A real deploy, RepoDigests inside CodeBuild, and Actions linting, including of the drift step's nested `${LIVE_DIGEST:-${TAG:-<unresolved>}}` echo line (actionlint is absent).
- The live ECR lifecycle policies were applied and read back on 2026-09-14 (USER CONSTRAINTS). Re-reading them needs a live AWS session and is read-only.

CLAUDE ROUTING
- VERIFICATION coordinator: opus. Critic: a fresh read-only Opus subagent.

IMPLEMENTATION_PROVIDER: CODEX (complete)
CODEX_POLICY: CONSERVE
CODEX_MODEL_CLASS: TERRA (gpt-5.6-terra; proven runnable 2026-09-14 on codex-cli 0.153.0)
CODEX_ATTEMPTS_USED: 1 build attempt (completed, 1330 s); 0 corrections
CODEX_REVIEW: OFF (CONSERVE default; not requested)
CLEANUP_AUTHOR: CLAUDE (Opus 5)

REQUIRED SKILLS
gauntlet-loop, netzer-os-development-process, git (local only), harness if the synth matrix needs isolating. graft only if its index is built outside the clone (T6).

USER CONSTRAINTS (carry every one of these forward)
- Work only in C:\dev\_netzer-release. Never edit C:\dev\Netzer-Labs (someone else's uncommitted work) or anything under .worktrees/.
- No push, PR, deploy, tag, secret, repository-setting change, or AWS mutation. Run `aws login` (netzer-root) only after asking.
- Local commits only: `git -c user.name="Emmanuel Adams" -c user.email="emmanuelmadams4@gmail.com" commit …`, with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` (or the trailer the harness mandates for the model actually running).
- Verification is hermetic cdk synth. A real deploy can't be verified without AWS: say so, and never claim it.
- Run the FULL npm test and all nine commands, using Floci (never test:integration:up). Never record an unrun command as passing. Starting Docker Desktop is the user's call.
- Don't edit development.md, CONTRIBUTING.md, docs/features/README.md, docs/security-posture.md, docs/security-model.md, or any untracked doc.
- Items the plan filed stay filed (scope discipline). Run /graft before changing a symbol; use grep for the .yml and buildspec sites.
- Rollout gate before qa → staging: re-apply both orchestrator repos' ECR lifecycle policies without rule 1. This needs aws login and the owner's consent.
  - APPLIED on 2026-09-14, with the owner's consent given in chat: claudeclaw-staging-orchestrator at 19:20:54 UTC, then claudeclaw-orchestrator at 19:21:17 UTC (netzer-root, account 239887088812, us-east-1). The policy was generated from ECR_LIFECYCLE_POLICY at 4d36c24, and each repo's read-back equals it. Before the change, each repo carried rule 1 plus a rule 2 identical to the new policy, held 24 and 12 images with none untagged, and its live service pinned a tag (claudeclaw-staging-orchestrator:22 → :8299f0468cb4; claudeclaw-orchestrator:15 → :de244e6387ef). Image counts were unchanged afterwards. To restore, put ECR_LIFECYCLE_POLICY from 271339b.
  - The gate can come undone. Every local `npm run deploy` re-puts the checked-out code's policy (bootstrapState → ensureEcrLifecyclePolicy → `aws ecr put-lifecycle-policy`, scripts/deploy.ts:1036), so a local deploy from pre-P5 code puts rule 1 back. CI deploys never touch the policy. Re-read both policies, read-only, right before qa → staging.
  - Filed, not for VERIFICATION to fix: ensureEcrLifecyclePolicy's docstring in bootstrap-state.ts still calls the deploy.ts CLI adapter 'unsupported', but that adapter implements putLifecyclePolicy.
- The P4 disarm only takes effect once it reaches development, the default branch scheduled runs execute from. Until then the schedule keeps failing daily. Pushing is the user's call.
- Codex never certifies its own work; Claude inspects the diff and reruns the proof.

TRAPS
- Prefix `git show rev:path` with MSYS_NO_PATHCONV=1, and then pass `-C C:/dev/_netzer-release`: that variable also stops Git Bash translating `-C /c/...` (T13).
- Git Bash has no jq: use node (gh --jq works).
- The Bash tool truncates commands of about 8 KB, and can mangle backslashes in heredocs: write longer scripts with the Write tool.
- A YAML parser is available at node_modules/aws-cdk-lib/node_modules/yaml; require it by absolute path.
- cdk.context.json is gitignored, so it is safe to seed for the synth matrix.
- graft writes graft/.cache/telemetry-repo-id.json into the repo even with --dir. `graft callers` misses `export const` objects; use `graft grep`.
- `docker info` and `git ls-remote` can hang: wrap both in timeout.
- Re-run a surprise red in isolation before calling it a regression.
- core.autocrlf=true normalizes line endings on commit; every WI-1 file is CRLF in the working tree.
- `npm run typecheck` writes the gitignored tsconfig.tsbuildinfo.
- The repository has no Prettier, ESLint or EditorConfig file and no lint script.
- The claudex runner's Claude inspector can't launch here (`claude` is not on the Git Bash PATH); use a read-only Opus subagent.

PROGRESS
Keep the live progress page updating as the work evolves: https://claude.ai/code/artifact/1fe42496-108e-4964-b8e0-b34d04b1c3af
`````
