---
feature: netzar-chat
document_role: session-handoff
status: current
observed_at: 2026-08-25
as_of_commit: 06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710
session_slug: phase-0-extraction
supersedes: 2026-08-25-phase-0-scaffolding.md
---

# Session handoff: LibreChat chat UI port — Phase 0 extraction

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-25 |
| Feature folder | `docs/features/netzar-chat/` |
| Branch worked on | `feature/netzar-chat` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710` |
| Commit at session end | (see section 7 / git log) |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

Phase 0 proper: the zero-visual-change extraction of the Chat tab's data and
transport layer out of `web/src/pages/Chat.tsx` into `web/src/lib/chat/*`, with
golden unit tests written first (encoding the pre-refactor semantics), plus a
dev-only mock-SSE Vite plugin (`CCE_CHAT_MOCK=1`) so streaming/tool UX can be
exercised locally despite the Floci Bedrock stub (ledger A3). The Chat page
JSX is character-identical after the refactor.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- Root `tsconfig.json` (`module: NodeNext`) pulls test-imported `web/` modules
  into the root `tsc` program even though `web` is in `exclude` (exclude only
  filters `include` globs, not import-reachable files). Consequence: any
  `web/src/lib/chat/*` file imported by a test under `src/` must use
  `.js`-extension relative imports internally, and must type-check under the
  root compiler options. Verified empirically with a probe file before writing
  code; `sessionStorage` in such a file produced no root-tsc error on this
  dependency set.
- Existing `src/` tests touch `web/` by reading files as text
  (`src/lib/missions/format.test.ts`, `src/lib/jarvis/route-manifest.test.ts`);
  this phase adds the first direct module imports (`chat-stream.test.ts`,
  `chat-helpers.test.ts`), deliberately importing only DOM-free modules
  (`stream.ts`, `helpers.ts`, `types.ts`) — never `markdown.ts` (needs
  DOMPurify/DOM) or `uploads.ts` (File type).
- Vite `configureServer` middleware registered in the hook body (not the
  returned callback) runs BEFORE Vite's internal proxy — that is what lets the
  mock-SSE plugin intercept `POST /api/test-turn/stream` ahead of the `/api`
  proxy.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `web/src/pages/Chat.tsx` | The monolith being decomposed | Source of truth for every golden test; JSX must stay character-identical |
| `web/src/lib/chat/stream.ts` | `streamTurn()` — moved SSE parser | The heart of the extraction |
| `web/src/lib/chat/helpers.ts` | Pure helpers moved verbatim | friendlyStreamError matrix is user-facing copy |
| `src/adapters/dashboard/chat-stream.test.ts` | Golden tests for the parser | Written BEFORE the extraction |
| `web/dev/mock-stream-plugin.ts` | Dev-only SSE mock | Only way to see real streaming locally (A3) |

### 3.3 Patterns and conventions to follow

- Where a golden test contradicts `Chat.tsx`, the source wins; fix the test,
  never "improve" the behavior (P5 applied to a refactor).
- Moved code moves VERBATIM including comments — they document paid-for bug
  fixes (deletingRef, snapshot-in-updater, freshChatId rationale).
- No new npm dependencies; no reformatting of moved code.

## 4. Work completed

### 4.1 Tasks finished

- [x] Golden tests written first: `src/adapters/dashboard/chat-stream.test.ts`,
      `src/adapters/dashboard/chat-helpers.test.ts`
- [x] `web/src/lib/chat/{types,helpers,markdown,stream,uploads}.ts` extracted
- [x] `web/src/pages/Chat.tsx` refactored to import them; JSX untouched
- [x] `web/dev/{mock-stream-plugin,fixtures}.ts` + `vite.config.ts` wiring
      behind `CCE_CHAT_MOCK === '1'`, `apply: 'serve'`
- [x] Validation (section 7)

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `src/adapters/dashboard/chat-stream.test.ts` | new | Golden tests for streamTurn (pre-refactor semantics) |
| `src/adapters/dashboard/chat-helpers.test.ts` | new | Golden tests for helpers |
| `web/src/lib/chat/types.ts` | new (moved) | Agent/TurnMeta/Message/Model/Conversation (+ additive `tools?`) |
| `web/src/lib/chat/helpers.ts` | new (moved) | MODEL_NAMES … friendlyStreamError, verbatim |
| `web/src/lib/chat/markdown.ts` | new (moved) | renderMarkdown verbatim (no highlight.js — later phase) |
| `web/src/lib/chat/stream.ts` | new (moved) | streamTurn(): the send() SSE parser, callback-ified |
| `web/src/lib/chat/uploads.ts` | new (moved) | stageAttachments(): the presign PUT loop |
| `web/src/pages/Chat.tsx` | refactor | Imports the above; send() slimmed; JSX character-identical |
| `web/dev/mock-stream-plugin.ts` | new | Dev-only mock SSE middleware |
| `web/dev/fixtures.ts` | new | Scripted fixtures (default/tools/error-mid/error-partial/media/reply/longstream) |
| `web/vite.config.ts` | edit | Conditionally register the plugin behind `CCE_CHAT_MOCK` |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| `.js`-extension internal imports in `web/src/lib/chat/` | extensionless (web style) vs `.js` (NodeNext-safe) | Root tsc sees these files via the tests; `.js` resolves under NodeNext, bundler mode, and Vite alike (probe-verified) |
| streamTurn accumulates `outcome.tools` | leave tools ephemeral vs accumulate | Spec: additive, UI ignores it for now; feeds a later phase |
| Mock fixtures as TS data, no JSON files | JSON files vs `fixtures.ts` | Fewer moving parts; type-checked by the config loader |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Root tsc pulls test-imported web modules into its program (`.js` imports + DOM-free rule) | comment atop `src/adapters/dashboard/chat-stream.test.ts` and `web/src/lib/chat/stream.ts` | yes |
| lib/chat extraction + mock harness | feature `README.md` implementation map | yes |

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
| M9 | A linked worktree was created under `.worktrees/` for this feature before re-reading M6. | Wasted setup; a locked `node_modules` left an orphaned directory `.worktrees/netzar-chat` in the main checkout pending manual deletion. | Abandoned; full clone at `C:\dev\_netzer-librechat` used instead. | Read the ledger before environment setup, not after. |

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it any time with `npm run local:verify`, which requires account id `000000000000`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS**, Floci 1.6.0, Docker 28.3.2, Node 24.3.0, on 2026-08-10. | Windows and Linux behaviour is **not** covered by that verification. See M6. |
| A3 | Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. | Local development validates plumbing, never model behaviour. Tool use is unreachable locally by design. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; deployment is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const). | A `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception. |
| A6 | AWS console access for this account is root-user sign-in via `aws login` with the `netzer-root` profile. | The `netzer-dev` SSO profile is known broken. Do not burn time on it. |
| A7 | *(this session)* The pre-existing full-suite failures on this branch are exactly: `scripts/lib/lifecycle/rollback-classes.test.ts` (1 failed test, a cdk-diff args assertion) and 4 other failed files with 0 failed tests besides it (see section 7 baseline); `src/adapters/dashboard/jarvis.flow.test.ts` can flake at 5000 ms on a cold cache. | Compare any post-change run against this, not against green. |

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
| Tailwind opacity modifiers on this app's semantic colors (`bg-primary/10`) emit **no CSS** — raw `var()` strings lack `<alpha-value>`. Use the `-a` triplet keys or `*-dim` vars. | [Feature README appendix](../README.md) |
| *(this session)* A `web/` module imported by a test under `src/` enters the ROOT tsc program (`exclude: ["web"]` does not stop import-reachable files): its internal relative imports need `.js` extensions and it must be DOM-free enough to type-check under `lib: ["ES2022"]`. | Section 3.1 of this file; comment atop `src/adapters/dashboard/chat-stream.test.ts` |

## 6. Pending work

### 6.1 Smallest next action

Phase 1 of the port plan (first visual phase). Phase 0 leaves no loose ends.

### 6.2 Immediate next steps

1. Stand up LibreChat (docker compose, pinned SHA) and freeze the bar
   screenshot set (carried from previous session's step 5).
2. Phase 1 per the port plan, building on `web/src/lib/chat/*`.

### 6.3 Blockers and open questions

- [ ] None currently.

### 6.4 Deferred, and why

- `AgentDetail.tsx` ChatTab restyle — out of scope per plan; noted for the PR body.
- Orphaned dir `C:\dev\Netzer-Labs\.worktrees\netzar-chat` (file lock) — delete when the lock clears; git already pruned it.
- highlight.js in `renderMarkdown` — explicitly a later phase; not added.
- `npm run local:test:integration` — pre-push gate; this session commits locally
  and does not push. Whoever pushes runs it first (P2: recorded as NOT run).

## 7. Verification actually performed

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm test` | 235 files: 5 failed / 229 passed / 1 skipped; 2897 tests: 1 failed (`scripts/lib/lifecycle/rollback-classes.test.ts`, cdk-diff args assertion) / 2890 passed / 6 skipped — recorded twice on the untouched branch by the orchestrating session | (recorded at session close below) |
| `npx vitest run src/adapters/dashboard/chat-stream.test.ts src/adapters/dashboard/chat-helpers.test.ts` | n/a (files new) | (recorded at session close below) |
| `npm run typecheck` | not separately baselined (branch == origin/development, CI green there) | (recorded at session close below) |
| `npm run build` | same | (recorded at session close below) |
| `npm --prefix web run typecheck` | same | (recorded at session close below) |
| `npm --prefix web run build` | same | (recorded at session close below) |
| `npm run local:test:integration` | not run | NOT RUN — no push this session; pre-push gate for whoever pushes (see 6.4) |
| `node scripts/ci/docs-links.mjs` | not run | (recorded at session close below) |
| `node scripts/ci/feature-knowledge.mjs` | not run | (recorded at session close below) |
| `git diff --check` | clean | (recorded at session close below) |

Anything not run, and why: `npm run local:test:integration` (needs Docker +
Floci; it is a pre-push gate and nothing is pushed this session — P2 says name
it, not skip it silently).

## 8. Environment state

- **Tools and services**: Windows 11, Node v24.19.0, npm deps installed in both
  root and `web/` of `C:\dev\_netzer-librechat`.
- **Active processes**: none left running.
- **Environment variables**: none set beyond defaults; no `.env` in the clone.
  The mock harness activates only via `CCE_CHAT_MOCK=1` at dev-server start.
- **Uncommitted work left in the tree**: none in this clone after the session's
  commits. The main checkout `C:\dev\Netzer-Labs` still carries someone's
  in-flight `feature/paperclip-phase-1-5` work — untouched per P6.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
