---
feature: chat-history-integrity
document_role: session-handoff
status: current
observed_at: 2026-09-11
as_of_commit: 271339bc8b2feea85e6c31b115fdd34e757a72e2
session_slug: backmerge-production-hotfixes
supersedes: 2026-08-24-empty-turn-poisoning.md
---

# Session handoff: back-merge the production chat-history hotfixes into development

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-10 |
| Feature folder | `docs/features/chat-history-integrity/` |
| Branch worked on | `fix/backmerge-production-hotfixes` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — neither `fix/*` nor `development` deploys anything, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `271339bc8b2feea85e6c31b115fdd34e757a72e2` (`origin/development`) |
| Commit at session end | not yet — recorded when the session closes |
| Pushed | no |
| PR | none yet |
| Deployed | no, and nothing in this session deploys |

## 2. Current state summary

`origin/production` (`de244e6`, deployed 2026-09-09) carries hotfix PRs #103–#106 from
`hotfix/empty-turn-poisoning`. That is four fixes plus five companion commits
(`844a831`, `333ef6b`, `5193ced`, `8c7b07e`, `3bffea6`). The four fixes:

- `8c14b3f`: the empty-turn guard, production's backport of #96.
- `1abba67`: `TURN_MAX_TOKENS` on every call, including the initial ConverseStream.
- `1124118`: the Haiku inference-profile id.
- `d828124`: a document build must not hand back a broken file.

None of the nine is reachable from `origin/development` (`271339b`) or `origin/staging`
(`8299f04`). On development the initial `converseStreamTurnWithFallback` call passes no
`maxTokens`, so the Bedrock client falls back to 1024 output tokens and a real document
reply truncates. That is the M12 miss, still live outside production.

This session back-merges the nine commits by cherry-pick, reconciled against
development's own variant of the first fix (`9d72979`, #96). So far the handoff is open
and the baseline is recorded (section 7). Nothing has been applied yet.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- Production and development diverged at `bb2898b` (2026-08-14). Since then production
  has received six hotfix PRs that development lacks: #90, #91, #103–#106, #168 and
  #170. So `git merge origin/production` is not "the four fixes"; it carries all six.
- The standing `staging → production` PR #61 conflicted from 2026-08-15 on eleven files
  from these hotfixes, and was closed unmerged on 2026-09-09. See the
  [knowledge-scope-fanout HANDOFF](../../knowledge-scope-fanout/HANDOFF.md).

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/agent/agent-loop.ts` | The turn loop | On development, the initial `converseStreamTurnWithFallback` call (line 1008 at `271339b`) passes no `maxTokens` |
| `src/lib/bedrock/client.ts` | Bedrock Converse / ConverseStream | Line 273 at `271339b` applies `maxTokens ?? 1024` |
| `src/agent/agent-loop.max-tokens.test.ts` | Pins the initial call's output ceiling | Exists only on production (`1abba67`), and is the red/green proof for this back-merge |

### 3.3 Patterns and conventions to follow

- The chat-surface parity rule in [`CLAUDE.md`](../../../../CLAUDE.md) is not triggered:
  `agent-loop.ts` is surface-agnostic and no adapter changes.

## 4. Work completed

### 4.1 Tasks finished

- [x] Fresh normal clone, branch `fix/backmerge-production-hotfixes` from `271339b`.
- [x] Baseline recorded before any change (section 7).
- [ ] Back-merge of the nine commits — not started.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/chat-history-integrity/handoffs/2026-09-10-backmerge-production-hotfixes.md` | Created | This session's handoff |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Cherry-pick the nine commits of #103–#106 | `git merge origin/production` | The merge would also carry #90, #91, #168 and #170. Scope is the four fixes (owner decision, 2026-09-11). |
| Work in this feature folder | A new folder for the back-merge | These are this feature's fixes, and production's `5193ced` and `d828124` already write here. A new folder is the sprawl the framework forbids. |
| Fresh normal clone at `C:\dev\_netzer-backmerge` | The main checkout; a linked worktree | M6 (Vitest in a Windows linked worktree) and P6 (the main checkout holds other sessions' uncommitted work). |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| — | — | Nothing yet; recorded when the session closes |

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

## 6. Pending work

### 6.1 Smallest next action

Apply the nine commits in production order with `git cherry-pick -x`: `8c14b3f`,
`844a831`, `1abba67`, `333ef6b`, `5193ced`, `1124118`, `8c7b07e`, `d828124`, `3bffea6`.

### 6.2 Immediate next steps

1. Apply the nine commits mechanically. The forecast conflicts are docs only.
2. Reconcile the conflicts, and check that every model call in the turn carries
   `TURN_MAX_TOKENS`.
3. Show `agent-loop.max-tokens.test.ts` failing without the fix and passing with it.
   Then run the full validation and open the PR into `development`.

### 6.3 Blockers and open questions

- [ ] None yet.

### 6.4 Deferred, and why

- Back-merging #90, #91, #168 and #170 is out of scope by owner decision (2026-09-11).
  Until they are reconciled, a `staging → production` promotion can still drop them.

## 7. Verification actually performed

Fill in the real result. `not run` is an acceptable and expected answer;
a false `pass` is not.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | | |
| `npm test` | | |
| `npm run build` | | |
| `npm --prefix web run typecheck` | | |
| `npm --prefix web run build` | | |
| `npm run local:test:integration` | | |
| `node scripts/ci/docs-links.mjs` | | |
| `node scripts/ci/feature-knowledge.mjs` | | |
| `git diff --check` | | |

Anything not run, and why:

## 8. Environment state

- **Tools and services**: Windows 11, Node 24.19.0, npm 11.17.0, Docker 29.7.2, and Floci
  from `docker-compose.local.yml`. Git `core.autocrlf=true`, so checkouts are CRLF.
- **Active processes**: recorded when the session closes.
- **Environment variables**: `.env` was created from `.env.local.example` by
  `npm run local`. Names only here, never values.
- **Uncommitted work left in the tree**: none. The main checkout `C:\dev\Netzer-Labs` was
  not touched (P6).

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-08-24-empty-turn-poisoning.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
