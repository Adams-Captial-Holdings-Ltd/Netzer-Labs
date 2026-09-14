---
feature: deliverables-parity
document_role: session-handoff
status: current
observed_at: 2026-09-13
as_of_commit: bc462df16f9e06f0d9f7233515c974d13f27610b
session_slug: w1-harness-specification
supersedes: 2026-09-10-deliverables-gap-diagnosis.md
---

# Session handoff: W1 harness specification

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-11 (planning); the work ran on 2026-09-13 |
| Feature folder | `docs/features/deliverables-parity/` |
| Branch worked on | `chore/deliverables-parity` in the normal clone `C:\dev\_netzer-diag`; also the local-only `diag/prod-capture` (`de244e6` → `f7194c1` → `51e85cb`) |
| Branch it merges into next | `development`, and only with the user's approval |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `271339bc8b2feea85e6c31b115fdd34e757a72e2` |
| Commit at session end | `bc462df16f9e06f0d9f7233515c974d13f27610b`; this log and the HANDOFF are committed on top of it |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

W1's Gauntlet SPECIFICATION phase is complete. In the normal clone
`C:\dev\_netzer-diag`, `chore/deliverables-parity` carries this feature folder,
the capture gate and the replay contract. The capture runs the real agent loop
without reaching AWS and is green on both trees: production's first call asks
for 8192 output tokens, development's for 1024, and every tool-loop round asks
for 8192. It was also shown red for the intended reason. The replay and the
prompts are frozen as a 13-case contract, all red on production's tree because
`replay.ts` and `prompts.ts` are stubs. Nothing was pushed and nothing touched
AWS. Step 0 did not run: no sign-in or go was given. The next phase is
IMPLEMENTATION, which makes the contract green without running the replay.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- The first call is `ConverseStreamCommand(buildParams(input))` in
  `src/lib/bedrock/client.ts`. When it stops on `tool_use`, the agent loop sends
  the same messages again as a non-streaming `ConverseCommand`, so the first
  call's output is paid for and then generated a second time.
- Tools register through side-effect imports in `src/server.ts`: 14 modules on
  production, 15 on development (adds `paperclip-tools`). Four add-ons register
  only when their environment is set: document generation (`RAW_BUCKET`), email,
  Nova Canvas and web search.
- Production source reads `AWS_ENDPOINT_URL` in one place only: the emulator-501
  replay in `client.ts`. A dead endpoint therefore does not change the captured
  path.
- `src/lib/bedrock/guard.test.ts` scans `src/` only, and `vitest.config.ts`
  collects only `*.test.ts`, while `tsconfig.json` includes `scripts/**`.

**Measured requests.** Captured with the built-in agent prompt, empty memory, a
placeholder guardrail, `RAW_BUCKET` set, and the email, Nova Canvas and web
search gates unset. Sizes are JSON characters; tokens are not estimated here,
because the replay's first call returns exact `inputTokens`.

| Tree | Call | `maxTokens` | Request | System | Tool specs | Last message |
|---|---|---:|---:|---:|---:|---:|
| production (`f7194c1` = `de244e6` + harness) | first, ConverseStream | 8192 | 23,715 | 5,310 | 17,929 (26 tools) | 52 |
| production | tool round 1, Converse | 8192 | 23,715 | 5,310 | 17,929 | 52 |
| production | tool round 2, Converse | 8192 | 24,061 | 5,310 | 17,929 | 118 (tool result) |
| development (`1a29a40`) | first, ConverseStream | 1024 | 25,173 | 5,310 | 19,387 (28 tools) | 52 |
| development | tool rounds 1 and 2 | 8192 | 25,173 and 25,519 | 5,310 | 19,387 | 52 and 118 |

The largest production tool specs are `schedule_task` (1,840), `dynamodb_query`
(1,630), `ingest_document` (1,184), `s3_vectors_search` (1,131) and
`generate_document` (915). Development adds `paperclip_add_comment` and
`paperclip_create_subtask`. Production's real agent prompts are not in these
numbers; see A8.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/agent/agent-loop.board-scope.test.ts` | Store-only mocks around the real `runAgentTurn` | The pattern the capture follows |
| `src/agent/agent-loop.max-tokens.test.ts` (production only) | Pins the first-call ceiling | The assertion the capture generalises to both trees |
| `src/server.ts` | Tool registration | The capture registers tools exactly the same way |
| `scripts/diagnostics/deliverables/capture.diag.ts` | The first executable gate and the request capture | Green on both trees; writes `capture-<sha>.json` outside the repository |
| `scripts/diagnostics/deliverables/replay.diag.ts` | The replay and prompts contract | 13 cases; IMPLEMENTATION's failing evidence |
| `scripts/diagnostics/deliverables/replay.ts`, `prompts.ts` | Frozen API, stubs | Their header comments carry the frozen design |

### 3.3 Patterns and conventions to follow

- Mock stores only; keep the Bedrock client, tool registry and agent loader real.
- Where the expected value differs by tree, key the gate on commit ancestry
  (`git merge-base --is-ancestor 1abba67 HEAD`, or `d828124`) instead of
  hard-coding one tree's answer.
- To run the harness on production's code, overlay it onto the local branch
  `diag/prod-capture`: `git switch diag/prod-capture`, then
  `git checkout chore/deliverables-parity -- scripts/diagnostics/deliverables`,
  then commit. Never push that branch.
- In Git Bash, `MSYS_NO_PATHCONV=1` is needed for `git show <rev>:<nested path>`,
  but it also stops `git -C /c/dev/...` from being converted, and git then says
  it cannot change directory. Use `git -C C:/dev/...`.
- Git Bash can fail with `fork: Permission denied` when many shells start at
  once. Run heavy commands one after another.
- In a Vitest file, a template-literal dynamic import of a `.js` path fails with
  `Unknown variable dynamic import`: Vite's dynamic-import-vars helper globs
  `*.js`, which matches no TypeScript source. A `@vite-ignore` comment inside the
  `import()` call makes it resolve at run time like a static import.
- Registering every tool module the way `src/server.ts` does took 15 to 35 s on
  this machine, longer than Vitest's default 10 s `hookTimeout`. The diag config
  sets 120 s.

## 4. Work completed

### 4.1 Tasks finished

- [x] Normal clone with `origin` pointed at GitHub; refs re-verified; `npm ci`.
- [x] Baseline recorded before any change (section 7).
- [x] Feature folder: README, HANDOFF, the back-filled 2026-09-10 log, this log (`1a29a40`).
- [x] Capture gate: green on development and production, red for the intended reason (`b1e2a19`).
- [x] Replay and prompts contract: 13 cases, red on production's tree (`bc462df`).
- [ ] Step 0: not run, because no AWS sign-in or go was given.
- [ ] IMPLEMENTATION: the next phase.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/deliverables-parity/README.md`, `HANDOFF.md` | New | The feature folder, written before any harness code |
| `docs/features/deliverables-parity/handoffs/2026-09-10-deliverables-gap-diagnosis.md` | New, back-filled | The diagnosis session wrote no repo handoff |
| `docs/features/deliverables-parity/handoffs/2026-09-11-w1-harness-specification.md` | New | This log |
| `scripts/diagnostics/deliverables/vitest.diag.config.ts` | New | Collects `*.diag.ts` only; dead endpoint, placeholder credentials, 120 s hook timeout |
| `scripts/diagnostics/deliverables/capture.diag.ts` | New | The first executable gate and the request capture |
| `scripts/diagnostics/deliverables/replay.ts`, `prompts.ts` | New, stubs | The frozen API; every export throws `not implemented` |
| `scripts/diagnostics/deliverables/replay.diag.ts` | New | The replay and prompts contract |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Record the baseline with every AWS credential source stripped | Run with ambient credentials | No AWS access is approved for this phase, and some suite tests have reached AWS when credentials were present |
| The capture keeps the loader's real S3 path and answers it with a spy; `DIAG_AGENT_PROMPT_FILE` supplies a real `CLAUDE.md` | `CONFIG_BUCKET=''`, the phase plan's first design | Production agents carry their own prompts (A8), so that design could only ever capture the built-in prompt |
| Key the first-call expectation on `1abba67` ancestry | Separate files per tree; an environment variable | One harness characterises both trees and stays right after the back-merge |
| Register tools by reading the tree's own `src/server.ts` | A fixed import list | Production imports 14 modules and development 15; a fixed list breaks one tree |
| Run against production on the local overlay branch `diag/prod-capture` | A second clone; a linked worktree | One `node_modules` serves both trees, since the package files differ only by Paperclip scripts; worktrees hit M6 |
| Captures go to `DIAG_OUT_DIR`, default `%TEMP%\netzer-deliverables-diag`, refused inside the repository | A git-ignored folder | P11 |
| Specify the replay as stubs plus 13 hermetic cases | A prose specification | Executable failing evidence for IMPLEMENTATION |
| Prompt 4's source text is `development.md` at `271339b` (8,385 words), cut at 6,000 words or more | A downloaded public text; synthetic prose | Real prose, reproducible from git, no download |
| The live replay needs an explicit guardrail choice and a spend flag | Defaults | The capture only holds a placeholder guardrail, and spending needs the user's go |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Output ceilings per tree, request shape, tool registration, builder differences | `docs/features/deliverables-parity/README.md` | yes |
| Production's measured first-request size | `docs/features/deliverables-parity/README.md`, section 5 | yes |

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
| P10 | Before diagnosing production, prove which fixes it carries: `git merge-base --is-ancestor <sha> origin/development`, then read the code with `git show origin/production:<path>`. | Production carried four hotfixes development lacked (`1abba67`, `d828124`, `1124118`, `8c14b3f`), and a development-based tree gave the wrong output ceiling. See M9. |
| P11 | Keep captured requests, replay records and prompt exports outside the repository. | They contain an agent system prompt. `capture.diag.ts` refuses a `DIAG_OUT_DIR` inside the repository. |

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
| M9 | The 2026-09-10 diagnosis started from a development-based working tree as if it were production. | It put production's first-call output ceiling at 1024 tokens; production has sent 8192 since `1abba67` (2026-08-24). | Re-read from `origin/production` (`de244e6`) and confirmed the divergence with `git merge-base`. | In diagnostic work, name the tree every claim was read from. |

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it any time with `npm run local:verify`, which requires account id `000000000000`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS**, Floci 1.6.0, Docker 28.3.2, Node 24.3.0, on 2026-08-10. | Windows and Linux behaviour is **not** covered by that verification. See M6. |
| A3 | Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. | Local development validates plumbing, never model behaviour. Tool use is unreachable locally by design. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; deployment is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const). | A `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception. |
| A6 | AWS console access for this account is root-user sign-in via `aws login` with the `netzer-root` profile. | The `netzer-dev` SSO profile is known broken. Do not burn time on it. |
| A7 | `src/lib/vectors/durability.repro.test.ts` is hermetic. | Verified 2026-09-13 on `271339b`: 7/7 passed with every AWS credential source stripped. [`development.md`](../../../../development.md#dangerous-commands-never-run-locally) still says it writes to the real staging bucket; a gap report was drafted, not applied. |
| A8 | Production agents use their own `agents/<id>/CLAUDE.md`, not the built-in prompt. | All seven production agents, `main` included, had one on 2026-08-26 ([knowledge-scope-fanout HANDOFF](../../knowledge-scope-fanout/HANDOFF.md)). Unverified since; Step 0 re-checks. A capture without `DIAG_AGENT_PROMPT_FILE` under-states the system prompt. |

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
| In Git Bash, `MSYS_NO_PATHCONV=1` is needed for `git show <rev>:<nested path>`, but it also stops `git -C /c/dev/...` from being converted. Use `git -C C:/dev/...`. | This log, section 3.3 |
| Git Bash can fail with `fork: Permission denied` when many shells start at once. Run heavy commands one after another. | This log, section 3.3 |
| In a Vitest file, a template-literal dynamic import of a `.js` path fails with `Unknown variable dynamic import`, because Vite globs `*.js` and matches no TypeScript source. Put a `@vite-ignore` comment inside the `import()` call. | This log, section 3.3 |
| Registering every tool module the way `src/server.ts` does took 15 to 35 s here, longer than Vitest's default 10 s `hookTimeout`. | This log, section 3.3 |

## 6. Pending work

### 6.1 Smallest next action

In a fresh session, start Gauntlet IMPLEMENTATION from
`~/.claude/plans/claude-bedrock-deliverables-handoff.md`.

### 6.2 Immediate next steps

1. IMPLEMENTATION: make `replay.diag.ts` green on `diag/prod-capture` without
   changing the contract, then add `main()` with a dry run as the default.
2. CLEANUP, then a fresh VERIFICATION of the harness.
3. Step 0 once the user signs in and says go. Fetch the incident agent's
   `CLAUDE.md` and production's guardrail id, then re-capture with
   `DIAG_AGENT_PROMPT_FILE`.
4. Export the prompts for System A.
5. Step 2 only on the user's go, within $30; Step 3 only with its own approval.

### 6.3 Blockers and open questions

- [ ] Blocker: Step 0 — needs: an AWS sign-in (the root `default` profile; sessions last about 2 hours) and the user's go.
- [ ] Blocker: 3–5 production failures from before and after 2026-08-24 — needs: the user.
- [ ] Blocker: System A's files for the exported prompts — needs: the user, after IMPLEMENTATION exports them.
- [ ] Blocker: Step 2 spend of up to $30, and the Step 3 judge — needs: two separate approvals.
- [ ] Question: the incident's exact prompt wording — suggested resolution: the user supplies it, or Step 0 reads the `'agent turn started'` log line, which carries the first 80 characters of the prompt.
- [ ] Gap report 1, not applied. **Situation:** this session specified a script that calls Bedrock with real credentials. **Location:** `development.md`, "Dangerous commands, never run locally", **Spends money**. **Why it matters:** the list is how the next person knows a command costs money. **Recommendation:** list the replay. **Proposed edit:**

  ```diff
   - **Spends money**: `npm run early-win`, `npm run validate:tier1`,
     `npm run status -- --strict`, `npm run verify`, `npm run battle`,
  -  `npm run loadtest`, the `scripts/jarvis-*-probe.ts` files.
  +  `npm run loadtest`, the `scripts/jarvis-*-probe.ts` files,
  +  `npx tsx scripts/diagnostics/deliverables/replay.ts` (replays a captured
  +  agent request against real Bedrock; one campaign is capped at $30).
  ```

  **The ask:** approval to apply it.
- [ ] Gap report 2, not applied. **Situation:** the baseline ran with every AWS credential source stripped. **Location:** `development.md`, "AWS safety", the paragraph on `npm test`. **Why it matters:** it tells readers a red suite may be an expired login because `durability.repro.test.ts` writes to staging, and on `271339b` that file passed 7/7 without credentials. **Recommendation:** stop naming that file as the AWS dependency. **Proposed edit:**

  ```diff
  -`npm test` is **not** fully hermetic, despite previously being listed here as
  -safe. `src/lib/vectors/durability.repro.test.ts` writes to the real staging
  -vectors bucket, so the suite reaches AWS and fails when the session lapses —
  -which means a red run cannot be distinguished from an expired login. Verified
  -2026-08-26: the same two files that fail without credentials pass in isolation
  -with them. Treat a red `npm test` as inconclusive until you have checked
  -`aws sts get-caller-identity`.
  +`npm test` is **not** guaranteed hermetic: on 2026-08-26 some tests reached AWS
  +when credentials were present. `src/lib/vectors/durability.repro.test.ts` is
  +not one of them; on 2026-09-13, at `271339b`, it passed 7/7 with every AWS
  +credential source stripped. For a result AWS cannot influence, run the suite
  +with `AWS_PROFILE`, the key variables, `AWS_CONFIG_FILE`,
  +`AWS_SHARED_CREDENTIALS_FILE` and the metadata endpoint stripped.
  ```

  **The ask:** approval to apply it.

### 6.4 Deferred, and why

- Re-capturing with production's own `CLAUDE.md` and guardrail: needs Step 0.
- E2, E3 and every fix: outside W1.
- Deleting `diag/prod-capture`: when W1 closes.

## 7. Verification actually performed

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | clean | clean at `bc462df` |
| `npm test` | 5 files failed, 238 passed, 1 skipped; 1 test failed, 3108 passed, 6 skipped (238.59 s) | 5 files failed, 238 passed, 1 skipped; 1 test failed, 3108 passed, 6 skipped (100.99 s), the same five files as the baseline |
| `npm run build` | not run | not run |
| `npm --prefix web run typecheck` | not run | not run |
| `npm --prefix web run build` | not run | not run |
| `npm run local:test:integration` | not run | not run |
| `node scripts/ci/docs-links.mjs` | OK: 135 files, 1647 internal links | OK: 139 files, 1719 internal links |
| `node scripts/ci/feature-knowledge.mjs` | OK | OK |
| `git diff --check` | clean | clean |
| `capture.diag.ts` on development (`1a29a40`) | not applicable | 2/2 pass; first call 1024, tool rounds 8192 |
| `capture.diag.ts` on development, expectation forced to 8192 | not applicable | fails as intended: `AssertionError: expected 1024 to be 8192`; restored |
| `capture.diag.ts` on production (`f7194c1`) | not applicable | 2/2 pass; first call 8192, tool rounds 8192 |
| `replay.diag.ts` on production (`51e85cb`) | not applicable | 13/13 fail as intended: 12 on `not implemented: <fn>`, and R10 on `not implemented: runCampaign` surfacing through `rejects.toThrow` |

Both `npm test` runs stripped `AWS_PROFILE`, the key variables,
`AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE` and the metadata endpoint. The
five baseline failures are the known set: four fail to collect on a `.mjs`
shebang (`scripts/ci/docs-links.test.ts`, `scripts/ci/feature-knowledge.test.ts`,
`scripts/ci/runnable-blocks.test.ts`, `scripts/release/sync-deprecations.test.ts`),
and `scripts/lib/lifecycle/rollback-classes.test.ts` has one assertion failure.
`src/lib/vectors/durability.repro.test.ts` passed 7/7.

Anything not run, and why: `npm run build`, both web commands and
`npm run local:test:integration` did not run. They are pre-push gates
(development.md step 7), and no push is planned; they must run before anyone
pushes this branch. Step 0 did not run: no AWS sign-in or go was given. The live
replay and the judge did not run, by design.

## 8. Environment state

- **Tools and services**: Node 24.19.0, npm 11.17.0, Vitest 2.1.9.
- **Branches in the clone**: `chore/deliverables-parity` (`bc462df` plus this
  commit); `diag/prod-capture` (`51e85cb`, local only); `fix/knowledge-scope-fanout`,
  created by cloning from the main checkout and untouched.
- **Outputs outside the repository**: `%TEMP%\netzer-deliverables-diag\capture-1a29a40d8a05.json`
  (development) and `capture-f7194c157503.json` (production). Both hold the
  built-in agent prompt.
- **Active processes**: none.
- **Environment variables**: the shell inherited no `AWS_*` variables. The diag
  config sets a dead `AWS_ENDPOINT_URL` and placeholder `AWS_*` values inside its
  own test process only.
- **Uncommitted work left in the tree**: none in the clone after this commit. The
  main checkout `C:\dev\Netzer-Labs` was read, never modified.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-09-10-deliverables-gap-diagnosis.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
