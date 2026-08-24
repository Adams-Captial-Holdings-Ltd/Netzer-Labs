---
feature: chat-history-integrity
document_role: session-handoff
status: current
observed_at: 2026-08-24
as_of_commit: f64d1e04b2d85853752e393b310ef243460958dd
session_slug: empty-turn-poisoning
supersedes: none
---

# Session handoff: a truncated reply kills the chat forever

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-24 |
| Feature folder | `docs/features/chat-history-integrity/` |
| Branch worked on | `fix/docgen-crash-isolation` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | **none** — `fix/*` deploys nowhere, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `f64d1e04b2d85853752e393b310ef243460958dd` |
| Commit at session end | `ea1eb93` |
| Pushed | yes |
| PR | [#96](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/96) into `development` |
| Deployed | **no** — nothing reached staging or production |

## 2. Current state summary

The reported bug was "generating a chat document — Excel, PDF or Word — kills
the entire agent chat in production, not just the one tool call". That framing
was wrong in mechanism and right in instinct. There is no crash: 90 days of
production logs (the full retention window, 13.6M records) hold zero unhandled
rejections, zero uncaught exceptions, zero OOM kills and zero unplanned task
restarts. What actually happens is that the model is cut off at the tool loop's
1024-token output ceiling while emitting the `generate_document` spec, returns
no text at all, and the resulting **empty assistant turn** is persisted. Every
later turn in that chat replays it, Bedrock rejects the whole request with
`messages: text content blocks must be non-empty`, and the turn never returns —
so the chat is dead permanently, not just for the one tool call. Reproduced
live in production with the user driving, and the empty turn was then read back
out of DynamoDB to confirm it. Three guards were added (section 4) and verified
against that real poisoned session. Nothing is deployed; the work sits on
`fix/docgen-crash-isolation` awaiting a PR into `development`.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **One bad stored turn fails every later turn, not just its own.** Bedrock's
  Converse API validates the whole `messages` array, and the loop replays full
  history each turn, so a single malformed turn is a permanent chat outage.
  This is the second time this class has bitten — `stripBlockedTurns` was added
  for the guardrail-notice version of exactly the same failure.
- **`getSession` is the one read choke point.** Every consumer that converts
  stored turns into Bedrock messages — `src/agent/agent-loop.ts`,
  `src/adapters/dashboard/handler.ts`, `src/adapters/dashboard/jarvis.ts` —
  reads through it. Repairing there covers all three and heals already-poisoned
  chats with no migration.
- **Bedrock requires alternating roles as well as non-empty blocks.** Dropping
  an offending assistant turn can leave two adjacent user turns, trading one
  rejection for another. `stripBlockedTurns` handles that by removing the
  triggering user turn too; `repairEmptyTurns` sidesteps it by substituting
  text rather than removing anything.
- **The document tool was never implicated.** `generate_document`'s kill
  switch, cost-cap re-check and S3 error handling are sound. It never executed
  at all in the failing turns.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/lib/state/sessions-repo.ts` | `getSession` / `appendTurns` | The single read path every history consumer goes through; `repairEmptyTurns` lives here |
| `src/agent/agent-loop.ts` | Turn loop, tool dispatch, history-to-messages | Holds `turnsToMessages`, `stripBlockedTurns`, the non-tool early return that emitted empty text, and both `maxTokens` call sites |
| `src/adapters/dashboard/handler.ts` | Dashboard chat SSE + persistence | Calls `appendTurns` with `result.text`; its comment already documents the guardrail version of this bug |
| `src/lib/tools/document-generation-tools.ts` | `generate_document` | Investigated and cleared — not the defect |

### 3.3 Patterns and conventions to follow

- **Fix history problems in the shared path, not per surface.** The parity rule
  in [`CLAUDE.md`](../../../../CLAUDE.md) is about UX; this is its data-layer
  equivalent. One guard in `getSession` covers Telegram, Slack, dashboard, the
  scheduler and Paperclip dispatch at once.
- **Pure exported helpers, tested directly.** `isPersistentChat`,
  `stripBlockedTurns`, and now `repairEmptyTurns` / `truncatedNotice` are pure
  and exported so tests need no DynamoDB or Bedrock mocking. Follow that rather
  than mocking the SDK.
- **Named constants carry their rationale in a doc comment.** `TOOL_TURN_LIMIT`
  explains why it is 8; `TOOL_LOOP_MAX_TOKENS` follows the same shape.

## 4. Work completed

### 4.1 Tasks finished

- [x] Diagnosed the real mechanism from production logs plus a live reproduction
- [x] `repairEmptyTurns` — empty stored turns can no longer reach Bedrock
- [x] `truncatedNotice` — the non-tool return path can no longer emit empty text
- [x] `TOOL_LOOP_MAX_TOKENS = 8192` — replaced the hard-coded `1024`
- [x] Regression tests for all three, plus verification against the real
      poisoned production session
- [ ] Confirm a real PDF / DOCX / XLSX generates end to end in a deployed
      environment — see section 6

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `src/lib/state/sessions-repo.ts` | Added `NO_RESPONSE_NOTICE` + `repairEmptyTurns`; applied in `getSession` | One guard on the shared read path; heals chats already poisoned, no migration |
| `src/agent/agent-loop.ts` | Added `truncatedNotice`; the non-tool return can no longer be empty | Stops the empty turn at source and tells the person their reply was cut off |
| `src/agent/agent-loop.ts` | `maxTokens: 1024` to `TOOL_LOOP_MAX_TOKENS = 8192`, both tool-loop sites | 1024 cannot hold a document spec — the shared ceiling is why all three formats failed together |
| `src/agent/agent-loop.history.test.ts` | Added a `truncatedNotice` block | Sits beside `stripBlockedTurns`, its sibling bug |
| `src/lib/state/sessions-repo.persistence.test.ts` | Added a `repairEmptyTurns` block | Matches that file's existing pure-function test style |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Repair on read in `getSession` | Guard on write in `appendTurns`; guard each of the 3 message builders | The read side is the single choke point **and** it heals existing poison. A write-side guard would fix neither of the two chats already dead in production. |
| Substitute text, do not drop the turn | Drop the empty turn; drop it plus its user turn, as `stripBlockedTurns` does | Dropping risks two adjacent user turns, which Bedrock rejects just as hard. Substitution preserves alternation trivially and loses no context. |
| Raise the ceiling to 8192 | Leave 1024; make it env-configurable | 1024 demonstrably cannot hold a document spec. Env-configurability is unrequested config for a value with no per-environment reason to differ. Spend is already bounded by the daily cost cap. |

Anything durable here must also become an ADR. A decision recorded only in a
session log is not an accepted decision.

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| One empty stored turn kills a chat permanently; `getSession` is the choke point | `docs/features/chat-history-integrity/README.md` | yes |
| All three document formats fail together because they share the output ceiling, not a library | same README, section 3 | yes |
| PDF and DOCX have never run in production, ever | same README, section 4, and the feature HANDOFF | yes |
| The `npm test` row of the `development.md` Automated tests table is stale | **no** — amending `development.md` needs owner approval, and it was explicitly withheld this session. Recorded as **M9** below instead. |

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

Deploy this branch's changes and then ask a production agent, in a **fresh
chat**, for a PDF. `generate_document` should actually appear in the logs this
time — it never has for a PDF.

### 6.2 Immediate next steps

1. Merge the PR into `development`.
2. Promote `development` to `qa`, then `qa` to `staging` — each its own PR.
   Merging to `staging` deploys it; nothing before that does.
3. Watch `/claudeclaw/orchestrator` for `msg: "document generated"` with
   `format: pdf`. That log line has never once existed.
4. Re-open chat `dashboard:1787596504860` and confirm it answers again — it is
   the poisoned chat, and it should heal itself with no migration.

### 6.3 Blockers and open questions

- [ ] Blocker: `npm run local:test:integration` was **not run** — Floci is not
      up on this machine (nothing answers on `127.0.0.1:4566`). Needs: a local
      Floci stack, per [development.md](../../../../development.md#floci-integration).
- [ ] Question: does the model reliably *pick* `generate_document` once it is no
      longer being truncated? In the reproduced incident it never called the
      tool at all — but it was being cut off before it could, so this may
      resolve itself. Suggested resolution: re-check after deploy, and only
      investigate tool selection if PDFs still fail to appear.
- [ ] Question: is 8192 the right ceiling? It is enough for the specs seen so
      far and is bounded by the daily cost cap, but no measurement was taken of
      how large a real document spec gets.

### 6.4 Deferred, and why

- **Proving PDF and DOCX generate real, openable files** — deferred because it
  needs a deployed environment, and nothing on a `fix/*` branch reaches one.
  This is the one part of the original request that remains genuinely unproven.
- **`memory ingest failed — "The provided model identifier is invalid."`** —
  a separate live production defect seen 2026-08-24. Out of scope; not
  investigated.
- **`webhook monitor: getWebhookInfo failed`**, repeating every two minutes for
  hours in production — separate, out of scope, not investigated.
- **The flaky `scripts/ci/*.test.ts` collection errors** — pre-existing, present
  on untouched `development`, unrelated to this change.

## 7. Verification actually performed

Baseline was measured on a **clean clone** of untouched `development`, per
**M6**; "after" is the same clone with this branch's patch applied.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | clean | **clean** (exit 0) |
| `npm test` | 192 files, 2135 tests — **7 files / 3 tests failed** | 192 files, 2143 tests — **5 files / 1 test failed**; +8 new tests, **no regressions** |
| `npm run build` | not measured separately | **pass** (exit 0) |
| `npm --prefix web run typecheck` | not measured separately | **pass** (exit 0, after `npm --prefix web ci`) |
| `npm --prefix web run build` | not measured separately | **pass** (exit 0) |
| `npm run local:test:integration` | **not run** | **not run** — see below |
| `node scripts/ci/docs-links.mjs` | pass | **pass** |
| `node scripts/ci/feature-knowledge.mjs` | pass | **pass** (`feature-knowledge: OK`) |
| `git diff --check` | clean | **clean** |

The 5 remaining `npm test` failures are all pre-existing and all in `scripts/`:
`scripts/ci/docs-links.test.ts`, `scripts/ci/feature-knowledge.test.ts`,
`scripts/ci/runnable-blocks.test.ts`, `scripts/release/sync-deprecations.test.ts`
(all four fail at import with `SyntaxError`), and
`scripts/lib/lifecycle/rollback-classes.test.ts` (a Windows path-separator
assertion). This change touches only `src/agent/` and `src/lib/state/`.

The suite is also **flaky**: three runs of the untouched branch produced 10, 5
and 7 failing files. Two baseline failures — `authz-matrix` and
`jarvis.ws-handshake` — did not reappear in the after run, which is flake, not
a fix.

**Anything not run, and why:** `npm run local:test:integration` — Floci is not
running on this machine and nothing answers on `127.0.0.1:4566`. Per **P2** this
is recorded as not run rather than assumed to pass. `npm run test:integration:up`
was deliberately NOT used to work around it (**M7**: it starts LocalStack on the
same port).

Beyond the documented list, the fix was additionally verified against the **real
poisoned production session**: chat `dashboard:1787596504860` was read out of
DynamoDB, confirmed to contain an empty assistant turn at index 5, and passed
through `repairEmptyTurns` — which repaired it, preserved turn count, and kept
roles alternating.

## 8. Environment state

- **Tools and services**: Node v24.19.0, Windows 11. AWS CLI authenticated as
  the `default` (root) profile only — `netzer-dev` SSO is broken (**A6**).
  Docker Desktop is installed but its daemon was **not** running, so no
  container-level test was possible.
- **Active processes**: none left running. A clean clone was made at
  `C:\dev\_netzer-baseline` purely to measure the baseline; it holds this
  branch's patch applied on top of `development` and can be deleted.
- **Environment variables**: `AWS_PROFILE`, `AWS_REGION`, `MSYS_NO_PATHCONV`
  were set per-command. `MSYS_NO_PATHCONV=1` is **required** in Git Bash or log
  group paths like `/claudeclaw/orchestrator` get rewritten into a Windows path
  and the call fails with a misleading `AccessDeniedException`.
- **Uncommitted work left in the tree**: the primary checkout
  `C:\dev\Netzer-Labs` is on `feature/paperclip-phase-1-5` with **93 modified
  files and 13 unpushed commits** of in-flight Paperclip work. Per **P6** none
  of it was touched, staged or committed. This session worked entirely in the
  linked worktree `.worktrees/docgen-crash`.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
