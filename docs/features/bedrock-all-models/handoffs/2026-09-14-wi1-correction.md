---
feature: bedrock-all-models
document_role: session-handoff
status: current
observed_at: 2026-09-14
as_of_commit: 1b6797ab643b08df0d39fd16de95f8a51876e551
session_slug: wi1-correction
supersedes: 2026-09-13-wi0-setup.md
---

# Session handoff: WI-1 corrections 1 and 2 — discovery bounds, failure backoff, immutable registry data

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-14 |
| Feature folder | `docs/features/bedrock-all-models/` |
| Branch worked on | `feature/bedrock-all-models`, in the normal clone `C:\dev\_netzer-allmodels` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `c4f6c843dafd19b7767e9f7695a1118437f83eb9` |
| Commit at session end | the docs commit that adds this file. Read it with `git log -1 --format=%H -- docs/features/bedrock-all-models`: a file cannot carry the SHA of the commit that introduces it. The last code commit is `1b6797ab643b08df0d39fd16de95f8a51876e551`. |
| Pushed | no, local commits only |
| PR | none |
| Deployed | no |

## 2. Current state summary

This session resumed WI-1 of the Bedrock all-models campaign: the capability registry, per-model pricing and
the live catalog.

**Where WI-1 started.** Inspection 1 of Codex's build `10dc36c` had returned REVISE. This session ran two
test-first correction rounds. Codex gpt-5.6-sol built each one, and Claude checked it.

**Correction 1**
- 15 failing tests, committed in `b220259` and `99df8a5`, then the Codex build `1c4379f`.
- **C1.** Claude's own check found one medium defect: when the Bedrock client constructor throws, a settled attempt stays "in flight", so discovery never retries.
- **Inspection 2** found the same defect independently and rated it high. It also raised four low findings. Claude had recorded C1 before that inspection started.

**Correction 2**
- Two failing tests plus three regression guards, committed in `0e2ca86`, then the Codex build `1b6797a`.
- A final fresh inspection 3 returned **APPROVED**, with two low findings carried into CLEANUP:
  - I3-1: failure logging can still throw for a hostile `Proxy` or a throwing getter;
  - I3-2: a reset in the same tick as a new attempt lets the old attempt put its client back into the map.

**State at `1b6797a`**
- `src/lib/bedrock`: 104 tests pass.
- Typecheck is clean.
- The full `npm test` shows only the 5 pre-existing red files, with 3191 tests passing.

WI-1 IMPLEMENTATION is complete; CLEANUP comes next, then VERIFICATION.

**Owner's directive, mid-session.** Codex writes every Gauntlet build, and Claude checks it (P11).

**Interruption.** A usage-limit pause stopped the session once. On resume, diff-hash checks showed the tree had not
drifted.

Nothing was pushed, no AWS call was made, and production is still Claude-only.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **Unhandled rejections kill the task.**
  - `src/index.ts:162-165` registers a process-wide `unhandledRejection` handler that logs at fatal and calls `process.exit(1)`.
  - So any abandoned promise that rejects later kills the Fargate task.
  - The catalog's deadline therefore attaches both handlers to the promise that loses the race.
- **An async IIFE settles during the call when nothing awaits first.**
  - An async function runs synchronously until its first `await`.
  - If its body throws and `catch`/`finally` finish before any `await`, the function settles during the call itself, before `pending = (async () => …)()` has been assigned.
  - A single-flight slot registered afterwards then keeps a settled promise that its own `finally` could not clear (C1).
  - `1b6797a` fixes this by making `await Promise.resolve()` the first statement of the attempt.
- **Stringifying a thrown value can throw.** `String(value)` throws for `Object.create(null)` and for a value whose `toString` throws. Failure logging that promises never to throw must guard it (I2-2).
- **Request timeouts only warn by default.**
  - `@smithy/node-http-handler` 4.7.7, which `@aws-sdk/client-bedrock` 3.1053.0 uses, has a default `requestTimeout` of 0, meaning none.
  - With `requestTimeout` set but not `throwOnRequestTimeout: true`, an elapsed timeout only logs a warning.
  - `BedrockClient` accepts the options object directly as `requestHandler`.
- **`getConfig` fails open.**
  - In `src/lib/state/runtime-config-repo.ts:69-93`, a DynamoDB error returns the last cached value or `undefined`; the function never throws.
  - The catalog's rule that a throwing reader fails closed therefore only guards injected readers.
- **Bedrock Anthropic ids come in three shapes** in the model-card inventory of 2026-09-14:
  - dated: `anthropic.claude-sonnet-4-5-20250929-v1:0`;
  - `-vN`: `anthropic.claude-opus-4-6-v1`;
  - bare: `anthropic.claude-opus-4-7`.
- **Development's env constants.**
  - The Haiku constant is undated: `us.anthropic.claude-haiku-4-5` (`infra/lib/constants.ts:249`).
  - Opus and Sonnet are bare ids.
  - Only the undated Haiku needed folding (F6).
- **Vitest 2.1.9 test mechanics:**
  - fake timers fake the global `setTimeout` and `Date`, but not `AbortSignal.timeout` or `timers/promises`;
  - `mockReset()` makes a mock return `undefined` rather than restore its original implementation;
  - `vi.getTimerCount()` pins timer hygiene.
- **Claudex runner limits.**
  - `runner.py` refuses `build --resume` once HEAD has moved (`:299-300`), and accepts only a `completed` record (`:257-269`).
  - A checkpoint commit before inspection therefore makes every later fix round a fresh build.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/lib/bedrock/catalog.ts` | Live catalog: `discover`, `discoverWithDeadline`, `errorLogFields`, `rawDiscovery`, `getModelCatalog`, `resetModelCatalogCache` | Both corrections landed here |
| `src/lib/bedrock/capabilities.ts` | Registry defaults, `resolveCapabilities` | F3: frozen defaults, fresh seed copies |
| `src/lib/bedrock/playground-catalog.ts` | Playground list and cap-metering fallback | F8 comments |
| `src/lib/bedrock/catalog.test.ts` | Catalog specification | 18 new tests at the end; fakes `@aws-sdk/client-bedrock` for the default control plane |
| `src/lib/bedrock/capabilities.test.ts` | Registry specification | 2 new tests, deliberately placed last |
| `src/index.ts:162-165` | Process-level `unhandledRejection` handler | Why a late rejection must be handled |
| `~/.claude/skills/claudex-loop/scripts/runner.py:272-383` | Codex build and inspect runner | Clean-tree gate, resume rules, prompt wrapper, console-encoding crash |

### 3.3 Patterns and conventions to follow

- **Faking the default AWS client.** Mock the SDK module with `vi.mock('<module>', async (importOriginal) => ({ ...actual, Client: Fake }))` and `vi.hoisted` state.
  - This is the repository's idiom; see `src/adapters/slack/handler.command-scope.test.ts:57`.
  - Keep the real command classes.
- **Hanging promises.** A test observes one through a holder object (`track()` in `catalog.test.ts`), never by awaiting it.
- **Red-state mutation.** A test that mutates shared module state while red goes last in its file.
- **Codex work orders:**
  - live outside the checkout;
  - carry the real red output;
  - name exact files;
  - give proof commands as separate lines;
  - quote exact text for any wording requirement.
- **After every Codex build, Claude:**
  - diffs each requirement;
  - checks scope and that the tests are unchanged;
  - compares non-ASCII byte counts;
  - reads Codex's command log;
  - reruns the proof and the full suite.
- **Codex's report is advisory, never evidence (M11).**
- **Mutation-testing new tests without touching the repo.** Inspection 3 ran `npx vitest run <test> --config <scratch config>`, where the scratch config substitutes a modified copy of the module. The run on unchanged HEAD validates the harness. Each test is then shown to fail only under the regression it names.

## 4. Work completed

### 4.1 Tasks finished

- [x] **Correction 1 specification:** 15 tests red for the intended reason, in `b220259` (14) and `99df8a5` (1).
- [x] **Correction 1 work order and Codex build:** `1c4379f`, 11 minutes.
- [x] **Coordinator check of correction 1:** found C1 before inspection 2; inspection 2 returned REVISE; findings arbitrated.
- [x] **Correction 2:**
  - specification `0e2ca86`: 2 red tests and 3 regression guards;
  - work order frozen;
  - Codex build `1b6797a`, 11 minutes.
- [x] **Claude's checks on both builds:** scope, frozen tests, encoding, command logs, proof and full suite (section 7).
- [x] **Fresh Opus inspection 3: APPROVED.**
  - Low findings I3-1 and I3-2 are carried into CLEANUP.
  - It mutation-tested the new tests: each driving test and each guard fails only under the regression it names.
- [ ] **WI-1 CLEANUP, then WI-1 VERIFICATION:** next sessions (section 6).

Reports and work orders, outside the repo under `C:\Users\EmmanuelAdams\.claude\gauntlet\bedrock-all-models\`:
- `work-orders/WI-1-correction-1.md` and `work-orders/WI-1-correction-2.md`;
- `inspections/wi1-correction-1-coordinator-review.md` and `inspections/wi1-correction-2-coordinator-review.md`;
- `inspections/wi1-opus-inspection-2.md` (with arbitration) and `inspections/wi1-opus-inspection-3.md`;
- `runs/wi1-correction-1/` and `runs/wi1-correction-2/`.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `src/lib/bedrock/catalog.test.ts` | 34 → 52 tests: +13 in correction 1, +5 in correction 2. Adds a fake `BedrockClient` and three constant imports. | Specification for F1, F2, F4 and F6, then C1, I2-2 and the I2-4 guards |
| `src/lib/bedrock/capabilities.test.ts` | 16 → 18 tests | Specification for F3 |
| `src/lib/bedrock/catalog.ts` | `1c4379f`: a 15 s deadline, a 50-page cap with a repeated-token stop, a 60 s retry window, one client per region, fail-closed config reads, failure log fields, dated-id folding. `1b6797a`: a yield before building the client, and safe stringification. | Codex, per the correction work orders |
| `src/lib/bedrock/capabilities.ts` | `1c4379f`: deep-frozen defaults and fresh seed copies | Codex, per correction 1 |
| `src/lib/bedrock/playground-catalog.ts` | Header and fallback-price comments: paraphrased in `1c4379f`, exact wording in `1b6797a` | Codex, per both corrections |
| `docs/features/bedrock-all-models/HANDOFF.md` | Overwritten | Current state and session index |
| `docs/features/bedrock-all-models/handoffs/2026-09-14-wi1-correction.md` | New (this file) | One log per session |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Codex writes every Gauntlet build and correction. Claude writes the failing tests, checks Codex's diff, reruns every proof, verifies and writes the docs. | The plan's Codex lane: one build plus one correction, then Claude takes over | The owner's instruction in this session on 2026-09-14. A failed build goes back to Codex; if Codex is unavailable, stop and ask. It never becomes a Claude takeover. |
| **F7 is an accepted consequence; no code change.** A non-Claude `BEDROCK_DEFAULT_MODEL` now gets its registry context window: Nova Pro 300000, an unknown id 128000, instead of Haiku's 200000. This reaches `/models` and `/model`. | Pin the old 200000 | More accurate. Production's default, `us.anthropic.claude-sonnet-4-6`, is unaffected, and AM-16's "unchanged" holds for Claude defaults. |
| A throwing runtime-config reader fails closed to Anthropic-only | Env-fallback | Anthropic-only is AM-02's kill-switch state, and it keeps the discovered Claude models |
| A fixed 60 s retry window after any failed discovery | Exponential backoff | Bounds an outage to one control-plane call and one warn log per task per minute |
| A 15 s whole-discovery deadline, a 5 s per-request timeout that throws, and a 50-page profile cap that also stops on a repeated token | A request timeout alone; no cap | The deadline bounds every caller; the cap ends a runaway pagination loop |
| An attempt that settles after the deadline is ignored, and its rejection is handled (test in `99df8a5`) | Rely on the deadline alone | `src/index.ts` exits the process on an unhandled rejection |
| A dated Anthropic discovered id folds into an undated env id only on exact equality after removing `-YYYYMMDD-vN:M` | Match on the seed prefix or an id prefix | Prefix matching would fold Sonnet 4.5 into an undated Sonnet 4 |
| C1 fix: the attempt yields once before building its client | Clear the in-flight slot from `pending.then(clear, clear)` | One line; construction stays inside the failure handling; no new rejection path |
| Inspection 2's I2-3 (a clock stepping backwards, or a NaN clock) is rejected | Treat a negative elapsed time as outside the window | The Fargate clock is slewed, not stepped. A NaN clock needs an injected test clock. WI-1's own TTL check has the same property. |
| Inspection 2's I2-4 test gaps are added as regression guards that already pass | Leave them untested | They protect the coming CLEANUP refactor: per-region clients and reset, the exact deadline with no leftover timer, and a window that does not grow |
| Commit each Codex build locally before its inspection | Inspect the uncommitted tree | The inspector gets a stable SHA; fix rounds then run as fresh builds (3.1) |
| No stale-while-revalidate in these corrections | Serve the stale catalog while a refresh runs | Outside WI-1's scope. Filed for WI-2b, where the catalog reaches the turn path. |
| Re-inspections are fresh Opus subagents, not `runner.py inspect` | The bundled Claude Code CLI through the runner | This session runs with `CLAUDECODE` set, so the runner would start a nested Claude Code session. It was not attempted (ledger A12). |

Anything durable here must also become an ADR. A decision recorded only in a
session log is not an accepted decision.

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The catalog's discovery bounds, failure backoff and fail-closed reads | `docs/features/bedrock-all-models/README.md` | No. The README describes the `development` snapshot, where none of WI-1 exists yet. WI-7's docs pass documents the catalog, runtime-config settings and runbook once WI-1 is verified; this log and the work orders carry the facts until then. |
| Codex builds every item; Claude never takes over coding | This ledger, P11 | Yes. It is the owner's standing instruction for this campaign, not a repository rule. |
| F7, the default model's context window | Section 4.3 | Yes. WI-7 records it in ADR 0011's consequences. |
| `src/index.ts` exits the process on an unhandled rejection | This ledger, A11 | Yes. `development.md` would be its durable home, but editing it needs the owner's consent (plan, consent gates). |
| The async single-flight trap, and the stringify trap | This ledger, section 5.4 | Yes. They are code patterns, not feature facts. |
| The bundled Claude Code CLI, and the nested-session limit | This ledger, M10 and A12; the user's Codex memory note | Yes; machine-specific |
| C: drive nearly full | This ledger, A13 | Yes; machine-specific |

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
| P10 | Work in the normal clone `C:\dev\_netzer-allmodels` on `feature/bedrock-all-models`; never in the main checkout `C:\dev\Netzer-Labs`, which carries other people's uncommitted work, and never in a linked worktree. | Added 2026-09-13. The plan's Workspace decision, chosen to avoid the Vitest linked-worktree trap (M6) and to match the two other live campaigns; the main checkout was dirty when this campaign started. |
| P11 | Route every Gauntlet build and correction in this campaign to Codex (gpt-5.6-sol, effort high, through the claudex runner). Claude writes the failing tests, checks Codex's diff and scope, reruns every proof, verifies and writes the docs. If a build fails, it goes back to Codex. If Codex is unavailable, stop and ask. Never take over the coding. | Added 2026-09-14. The owner's instruction in the WI-1 correction session. It supersedes the plan's "then Claude takes over" clause (plan, Codex lane). |

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
| M9 | Three WI-1 sessions wrote no session log of their own: the specification (2026-09-13/14), the Codex build and the first inspection (2026-09-14). | Their dead ends were not in the repository; they survived only in run artifacts outside it. Two examples: Codex losing a proof attempt to PowerShell 5.1, and the mistaken "Claude Code CLI not installed". | This log reconstructs them from commits `82d8473`, `10dc36c` and `c4f6c84` and from `~/.claude/gauntlet/bedrock-all-models/`. | A session that only coordinates or delegates is still a session and owes its log ([framework](../../README.md), section 6a). |
| M10 | The WI-1 inspection session recorded that the Claude Code command-line tool "isn't installed here", because `claude` was not on PATH. | The runner's formal Claude inspector was written off, and the progress page and a memory note repeated the claim. | Claude Code CLI 2.1.266 (and 2.1.270) is bundled with the desktop app at `%APPDATA%\Claude\claude-code\<version>\claude.exe`, found with `--version` on 2026-09-14. It still was not used; see A12. | Search the app bundles before declaring a CLI missing. A9 is the same story for Codex. |
| M11 | Codex's report for correction 1 said "Implementation deviations: none". | Its F8 comment dropped the requested "not because of permissions" wording and still read as a permissions reason. A check of the report alone would have passed it. | Correction 2's work order quoted the exact seven lines; `1b6797a` matches them byte for byte. | Codex's report is advisory. Check every requirement against the diff. The release P4/P5 campaign saw the same thing. |

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it any time with `npm run local:verify`, which requires account id `000000000000`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS**, Floci 1.6.0, Docker 28.3.2, Node 24.3.0, on 2026-08-10. | Windows and Linux behaviour is **not** covered by that verification. See M6. |
| A3 | Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. | Local development validates plumbing, never model behaviour. Tool use is unreachable locally by design. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; deployment is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const). | A `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception. |
| A6 | AWS console access for this account is root-user sign-in via `aws login` with the `netzer-root` profile. | The `netzer-dev` SSO profile is known broken. Do not burn time on it. |
| A7 | `origin/production` diverges from `origin/development`: the hotfixes `1abba67`, `d828124`, `1124118`, `8c14b3f` and `hotfix/empty-turn-poisoning` (`3bffea6`) are not ancestors of development. `agent-loop.ts`, `handler.ts`, `commands.ts` and `iam-stack.ts` differ (1,390 lines); `src/lib/bedrock/` and `humanize.ts` are identical. Production's agent loop sends `TURN_MAX_TOKENS` (8192) on the first call, the tool loop and the synthesis; development's first call passes no `maxTokens` and gets `client.ts:273`'s 1024. | **Measured 2026-09-13** in the clone with `git merge-base --is-ancestor`, `git diff --stat` and `git grep` against remote refs fetched at 22:21 (UTC-4). Blocks WI-2 through WI-9 until all five are ancestors of `origin/development`; WI-0 and WI-1 may proceed. The README's line numbers are development's; re-read every span after the back-merge and rebase, and capture WI-3's Claude goldens only on that base. |
| A8 | Staging and production deploy into **one AWS account**: `deploy.yml:49` reads a single `AWS_ACCOUNT_ID` repository variable and `TARGET_ENV` (`:52`) only selects the stack suffix. The first invoke of a Marketplace-listed third-party model subscribes that account and accepts the provider's terms for both environments at once. | Verified in `deploy.yml` on 2026-09-13. Consequence: a staging probe is a production-scope legal action. Providers are approved, with their terms, before any live call, and every first call to a provider is consent-gated (plan, consent gates). |
| A9 | Codex CLI **0.153.4** is at `C:\Users\EmmanuelAdams\AppData\Local\OpenAI\Codex\bin\7ac07f4ce733f89a\codex.exe`; the VS Code extension `openai.chatgpt-26.901.22334-win32-x64` bundles the older **0.153.0** at `bin\windows-x86_64\codex.exe`. | Both measured with `--version` on 2026-09-13 (no model call). The plan's "Availability" paragraph names the extension path; pass the newer binary to `--cli`. If Sol refuses either, stop and ask (plan, Codex lane). The hash directory name may change on a Codex update; re-resolve it rather than trusting this path. |
| A10 | The C: drive was **94.5% full** on 2026-09-13: 224.2 GB used, 13.1 GB free (`Get-PSDrive C`). | Two `npm ci` runs (root and `web/`), Docker images, `cdk.out` and Vitest caches all land on C:. Check free space before a build or synth; a failure that looks like a tool bug may be `ENOSPC`. |
| A11 | `src/index.ts:162-165` handles `unhandledRejection` by logging at fatal and calling `process.exit(1)`; `uncaughtException` at `:158-161` does the same. | Read 2026-09-14 on this branch. Any timeout or race that abandons a promise must handle that promise's later rejection, or a slow AWS call kills the task. |
| A12 | Claude Code CLI **2.1.266** and **2.1.270** are bundled with the Claude desktop app at `%APPDATA%\Claude\claude-code\<version>\claude.exe`, and are not on PATH. | Measured with `--version` on 2026-09-14. A coordinator running inside Claude Code has `CLAUDECODE` set, so `runner.py inspect --host claude` from there would launch a nested Claude Code session; that was not attempted. The version directory changes on app updates, so re-resolve it. |
| A13 | On 2026-09-14 the C: drive swung between 1.3 GB free (11:20, 99.5% used), 5.6 GB (14:03) and 2.4 GB (14:56), from Python `shutil.disk_usage`. | Other sessions on the machine consume and free space. The owner was notified at 11:20; nothing was deleted. The full `npm test`, Codex runs and Vitest caches all write to C:, so check before them (A10). |

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
| `node scripts/ci/feature-knowledge.mjs` sees only Git-tracked files and reads an `approved_work` target as a task backlog. Stage new feature docs before running it, and never declare a prose plan as `approved_work`. | `scripts/ci/feature-knowledge.mjs` (`snapshotRepository`, `validateWorkQueue`) and the [framework](../../README.md), section 3 |
| `docs/**` is `i/lf w/crlf` under `core.autocrlf=true`. A new doc written LF looks different from every neighbour in the working tree; write CRLF and let `git add` normalize. | `git ls-files --eol docs/features/README.md` |
| Codex runs its commands in Windows PowerShell 5.1 on this machine, where `&&` is a parse error. The WI-1 build lost a proof attempt to it. Give proof commands as separate lines. | `~/.claude/gauntlet/bedrock-all-models/work-orders/WI-1-correction-2.md`, PROOF |
| Codex runs stall on intermittent DNS failures (`os error 11001`). The WI-1 build hit its 45-minute limit after writing every file. Use `--timeout 3600`, and inspect the diff even when the runner reports `failed`. | `~/.claude/gauntlet/bedrock-all-models/runs/wi1-build/claudex-6jhhxs_c/stderr.txt` |
| The claudex runner crashes after saving `result.json` when it prints a non-cp1252 character (a ✓ in Codex's reply) to the Windows console. It exits 1 with `status: completed`. Launch it with `PYTHONIOENCODING=utf-8`, and read `result.json` whatever the exit code. | `~/.claude/gauntlet/bedrock-all-models/runs/wi1-correction-1/claudex-esbek8hg/result.json` |
| `runner.py build --resume` refuses once HEAD has moved, and a `failed` build can never be resumed. A fix round after a local commit is a fresh build. | `~/.claude/skills/claudex-loop/scripts/runner.py:257-300` |
| `~/.codex/config.toml` enables network for `workspace-write`, and the runner cannot override it. Keep proofs hermetic, and read every command Codex ran in its `stdout.txt`. | `inspections/wi1-correction-1-coordinator-review.md` and `inspections/wi1-correction-2-coordinator-review.md` |
| An async single-flight IIFE with no `await` before its first statement that can throw settles during the call, so its `finally` cannot clear the slot registered afterwards. | `src/lib/bedrock/catalog.ts` `rawDiscovery`; `1b6797a` |
| `String(value)` throws for `Object.create(null)` or a throwing `toString`. Guard it in any "never throws" failure path. | `src/lib/bedrock/catalog.ts` `errorLogFields`; `1b6797a` |
| Vitest fake timers do not fake `AbortSignal.timeout` or `timers/promises`. Deadline code tested with fake timers must use the global `setTimeout`. | `src/lib/bedrock/catalog.test.ts`, the "discovery bounds (F1)" block |

## 6. Pending work

### 6.1 Smallest next action

Start WI-1 CLEANUP in a fresh session from `C:\Users\EmmanuelAdams\.claude\plans\bedrock-all-models-handoff.md`
(DIRECT_COORDINATOR / CLEANUP).

### 6.2 Immediate next steps

1. **WI-1 CLEANUP.**
   - A scope-locked refactor of `capabilities.ts`, `catalog.ts`, `models.ts` and `playground-catalog.ts` under a Codex work order (P11).
   - Known cleanup-shaped items:
     - the `Promise.resolve().then(...)` wrappers around `readConfig` in `getModelCatalog`;
     - the unreachable `throw` after the page loop in `discover`;
     - I3-1: make `errorLogFields` total. It still throws for a revoked `Proxy`, a `Proxy` whose `get` trap throws, or an `Error` whose `message` getter throws. Claude writes the red test first.
     - I3-2: after the C1 yield, a `resetModelCatalogCache()` in the same tick lets the old attempt store its client in the cleared map. Store the client only while the generation matches. Claude writes the red test first.
   - Claude checks the diff and scope, then runs `npx vitest run src/lib/bedrock`, `npm run typecheck` and the full `npm test`. Commit locally.
2. **WI-1 VERIFICATION.** A fresh Opus session against AM-01, AM-02, AM-05, AM-13, AM-16 and the catalog halves of AM-30 and AM-37.
3. **Before WI-2's SPECIFICATION.** Fetch, then re-run `git merge-base --is-ancestor` for `1abba67`, `d828124`, `1124118`, `8c14b3f` and `origin/hotfix/empty-turn-poisoning`. If any is still missing, ask whether this campaign raises the back-merge PR, which is consent-gated.

### 6.3 Blockers and open questions

- [ ] **Blocker: back-merge.** The production-only hotfixes are not on `origin/development` (A7).
  - Needs the back-merge to land, then a rebase.
  - Blocks WI-2 through WI-9; does not block WI-1.
- [ ] **Blocker: consent.** Provider approval, `aws login`, pushes, deploys, runtime-config writes and live model calls each need the owner's consent, separately, every time (plan, consent gates).
- [ ] **Risk: disk space.** The C: drive stays near full (A13). Check free space before the full-validation and synth work in WI-5 and WI-7.
- [ ] **Question:** should `docs/README.md` list this feature folder?
  - Suggested resolution: leave it for WI-7's docs pass (carried).

### 6.4 Deferred, and why

- **Stale-while-revalidate for the catalog.** Deferred to WI-2b's specification, where `getModelCatalog` reaches the turn path. Callers currently wait for a refresh, bounded by the 15 s deadline.
- **Inspection 2's I2-3, a clock stepping backwards or a NaN clock.** Rejected for WI-1 (section 4.3). Revisit only if the catalog ever runs on a host whose clock steps.
- **`maxResults` on `listInferenceProfiles`.** Deferred because its valid range could not be confirmed offline; the 50-page cap bounds the loop.
- **Exponential backoff.** Deferred because the fixed 60 s window is sufficient at one call per task per minute.
- **`au.` APAC inference profiles in the geo rule.** Filed by the WI-1 work order for later.
- **`docs/adr/0010-paperclip-work-engine.md` missing from the ADR index.** Deferred because it belongs to the Paperclip feature (carried).
- **Listing `rollcall:models` and the capability probe under `development.md` "Spends money".** Deferred to WI-7's gap report (carried).
- **`PROVENANCE.md` and Codex-authored commits.** Left to the owner or counsel (carried).

## 7. Verification actually performed

Fill in the real result. `not run` is an acceptable and expected answer;
a false `pass` is not.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | Not rerun at session start. The WI-1 build session measured it clean at `10dc36c`, which has the same code as `c4f6c84`. | Exit 0 at `1c4379f` and at `1b6797a`. At the red-test commits: the 3 expected TS2305 errors for the missing constants at `b220259` and `99df8a5`; clean at `0e2ca86`. |
| `npm test` | Not rerun at session start. At `10dc36c`, per the WI-1 build session: files 5 failed \| 241 passed \| 1 skipped; tests 1 failed \| 3171 passed \| 6 skipped. | **At `1c4379f`:** files 5 failed \| 241 passed \| 1 skipped (247); tests 1 failed \| 3186 passed \| 6 skipped (3193). **At `1b6797a`** (run on the working tree whose diff hash equalled the committed change): files 5 failed \| 241 passed \| 1 skipped (247); tests 1 failed \| 3191 passed \| 6 skipped (3198). The red files are the same 5 pre-existing ones each time. |
| `npm run build` | not run | not run |
| `npm --prefix web run typecheck` | not run | not run |
| `npm --prefix web run build` | not run | not run |
| `npm run local:test:integration` | not run | not run |
| `node scripts/ci/docs-links.mjs` | At `99df8a5`: `docs-links: 140 markdown files · 1758 internal links checked · 74 external links skipped`, then `docs-links: OK` | With this file and `HANDOFF.md` staged: `docs-links: 141 markdown files · 1788 internal links checked · 74 external links skipped`, then `docs-links: OK` |
| `node scripts/ci/feature-knowledge.mjs` | At `99df8a5`: `feature-knowledge: OK` | With this file and `HANDOFF.md` staged: `feature-knowledge: OK` |
| `git diff --check` | Clean tree at session start | Exit 0 for each Codex build before its commit (`git diff --check 99df8a5` and `git diff --check 0e2ca86`), and `git diff --cached --check` exit 0 for the staged docs |

Anything not run, and why:
- **Focused proof.** `npx vitest run src/lib/bedrock` passed at `1c4379f` (7 files, 99 tests) and at `1b6797a` (7 files, 104 tests).
- **Red states.**
  - Correction 1: 15 failed | 50 passed in the two test files.
  - Correction 2: 2 failed | 68 passed.
- **Not run:** `npm run build`, the two `web/` checks and `npm run local:test:integration`. They belong to WI-7's full validation, before any push.
- **Logs** are kept outside the repo, under `~/.claude/gauntlet/bedrock-all-models/runs/`.
- **No AWS command ran.**

## 8. Environment state

- **Tools and services:**
  - Node v24.19.0 and Python 3.14.5.
  - Vitest 2.1.9, `@aws-sdk/client-bedrock` 3.1053.0 and `@smithy/node-http-handler` 4.7.7.
  - Codex CLI 0.153.4 (A9) and the bundled Claude Code CLI 2.1.266/2.1.270 (A12).
  - The C: drive stays near full (A13).
- **Active processes:** none left by this session. Both Codex runs exited, and the inspection subagents were read-only. Other sessions' `git.exe` and `node.exe` processes were running on the machine.
- **Environment variables:** `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` were set in the coordinating session, and `PYTHONIOENCODING=utf-8` was set for runner launches; names only. **Never values, never secrets.**
- **Uncommitted work left in the tree:**
  - `C:\dev\_netzer-allmodels`: none after the docs commit.
  - The main checkout `C:\dev\Netzer-Labs` (branch `fix/knowledge-scope-fanout`) still carries a large uncommitted tree that is not this campaign's. It was untouched, per **P6**.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff: WI-0 setup, 2026-09-13](2026-09-13-wi0-setup.md)
- [Approved plan, verbatim copy](../plan.md)
- ADR 0011 — Every Converse-capable Bedrock model for agents (`adr/0011-every-bedrock-model-for-agents.md` on branch `feature/bedrock-all-models`) (proposed)
- [ADR 0003 — Cross-region Bedrock inference profiles](../../../adr/0003-bedrock-inference-profiles.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
