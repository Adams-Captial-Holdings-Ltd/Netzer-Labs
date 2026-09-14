---
feature: deliverables-parity
document_role: session-handoff
status: current
observed_at: 2026-09-13
as_of_commit: 271339bc8b2feea85e6c31b115fdd34e757a72e2
session_slug: w1-harness-specification
supersedes: 2026-09-10-deliverables-gap-diagnosis.md
---

# Session handoff: W1 harness specification

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-11 (planning); the work ran on 2026-09-13 |
| Feature folder | `docs/features/deliverables-parity/` |
| Branch worked on | `chore/deliverables-parity`, in the normal clone `C:\dev\_netzer-diag` |
| Branch it merges into next | `development`, and only with the user's approval |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `271339bc8b2feea85e6c31b115fdd34e757a72e2` |
| Commit at session end | in progress |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

Gauntlet phase SPECIFICATION for W1, in progress. The normal clone exists, the
baseline is recorded, and this feature folder is written. The capture gate and
the replay specification come next. Nothing has touched AWS.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- The first call is `ConverseStreamCommand(buildParams(input))` in
  `src/lib/bedrock/client.ts`. When it stops on `tool_use`, the agent loop sends
  the same messages again as a non-streaming `ConverseCommand`, so the first
  call's output is paid for and discarded.
- Tools register through side-effect imports in `src/server.ts`: 14 modules on
  production, 15 on development (adds `paperclip-tools`). Four add-ons register
  only when their environment is set: document generation (`RAW_BUCKET`), email,
  Nova Canvas and web search.
- Production source reads `AWS_ENDPOINT_URL` in one place only: the emulator-501
  replay in `client.ts`.
- `src/lib/bedrock/guard.test.ts` scans `src/` only, and `vitest.config.ts`
  collects only `*.test.ts`, while `tsconfig.json` includes `scripts/**`.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/agent/agent-loop.board-scope.test.ts` | Store-only mocks around the real `runAgentTurn` | The pattern the capture follows |
| `src/agent/agent-loop.max-tokens.test.ts` (production only) | Pins the first-call ceiling | The assertion the capture generalises to both trees |
| `src/server.ts` | Tool registration | The capture registers tools the same way |

### 3.3 Patterns and conventions to follow

- Mock stores only; keep the Bedrock client, tool registry and agent loader real.
- In Git Bash, `MSYS_NO_PATHCONV=1` is needed for `git show <rev>:<nested path>`,
  but it also stops `git -C /c/dev/...` from being converted, and git then says
  it cannot change directory. Use `git -C C:/dev/...`.
- Git Bash can fail with `fork: Permission denied` when many shells start at
  once. Run heavy commands one after another.

## 4. Work completed

### 4.1 Tasks finished

- [x] Normal clone, `origin` pointed at GitHub, refs re-verified, `npm ci`.
- [x] Baseline recorded before any change (section 7).
- [x] Feature folder: README, HANDOFF, the back-filled 2026-09-10 log, this log.
- [ ] Capture gate.
- [ ] Replay and prompts specification.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/deliverables-parity/*` | New | The feature folder, written before any harness code |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Record the baseline with every AWS credential source stripped | Run with the ambient credentials | No AWS access is approved for this phase, and some suite tests have reached AWS when credentials were present |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Output ceilings per tree, request shape, tool registration, builder differences | `docs/features/deliverables-parity/README.md` | yes |

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

## 6. Pending work

### 6.1 Smallest next action

Add `scripts/diagnostics/deliverables/capture.diag.ts` and its config, and run it
on `chore/deliverables-parity`.

### 6.2 Immediate next steps

1. Capture gate green on this branch; show a red for the intended reason.
2. Run it on production's tree.
3. Specify the replay and the prompts as a red contract.

### 6.3 Blockers and open questions

- [ ] Blocker: Step 0 — needs: an AWS sign-in and the user's go.
- [ ] Blocker: production failure examples, System A's files, $30 replay approval, judge approval — needs: the user.

### 6.4 Deferred, and why

- Everything past W1 SPECIFICATION: this session builds only this phase.

## 7. Verification actually performed

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | clean | pending |
| `npm test` | 5 files failed, 238 passed, 1 skipped; 1 test failed, 3108 passed, 6 skipped (238.59 s) | pending |
| `npm run build` | not run | pending |
| `npm --prefix web run typecheck` | not run | pending |
| `npm --prefix web run build` | not run | pending |
| `npm run local:test:integration` | not run | pending |
| `node scripts/ci/docs-links.mjs` | OK: 135 files, 1647 internal links | pending |
| `node scripts/ci/feature-knowledge.mjs` | OK | pending |
| `git diff --check` | clean | pending |

The baseline ran on `271339b` with `AWS_PROFILE`, the key variables,
`AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE` and the metadata endpoint
stripped. The five failing files are the known set: four fail to collect on a
`.mjs` shebang (`scripts/ci/docs-links.test.ts`,
`scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`,
`scripts/release/sync-deprecations.test.ts`), and
`scripts/lib/lifecycle/rollback-classes.test.ts` has one assertion failure.
`src/lib/vectors/durability.repro.test.ts` passed 7/7.

Anything not run, and why: pending the end of the session.

## 8. Environment state

- **Tools and services**: Node 24.19.0, npm 11.17.0.
- **Active processes**: none.
- **Environment variables**: none of `AWS_*` were inherited by the shell.
- **Uncommitted work left in the tree**: none in the clone.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-09-10-deliverables-gap-diagnosis.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
