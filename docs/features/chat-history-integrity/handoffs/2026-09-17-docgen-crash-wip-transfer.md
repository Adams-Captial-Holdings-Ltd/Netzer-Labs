---
feature: chat-history-integrity
document_role: session-handoff
status: current
observed_at: 2026-09-17
as_of_commit: ef0768f5dad6a02c97ac57e94fc4eb552b8ab891
session_slug: docgen-crash-wip-transfer
supersedes: 2026-08-24-empty-turn-poisoning.md
---

# Session handoff: back up the unfinished turn-ceiling work before the machine transfer

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-17 |
| Feature folder | `docs/features/chat-history-integrity/` |
| Branch worked on | `wip/docgen-crash-turn-ceiling`. This session created it from `hotfix/empty-turn-poisoning` at `3bffea64ad699fb3e68311450dde235d70269f74`, and that branch is unchanged. |
| Branch it merges into next | **None yet.** This is a backup branch, not a merge candidate. If the work is finished, the owner picks the route (`fix/*` into `development`, or `hotfix/*` into `production`), and only after reconciling with `fix/backmerge-production-hotfixes` (section 6.3). |
| AWS environment that branch reaches | **None.** No workflow on this branch has a push trigger that matches `wip/*` (section 7). See the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping). |
| Commit at session start | `3bffea64ad699fb3e68311450dde235d70269f74`, plus five uncommitted modified files in the worktree |
| Commit at session end | Code: `ef0768f5dad6a02c97ac57e94fc4eb552b8ab891`. Docs: the commit that adds this file, whose parent is `ef0768f`. Read it with `git rev-parse wip/docgen-crash-turn-ceiling`. |
| Pushed | Not yet at the time of writing; the coordinator pushes this branch to origin under the same name immediately after this commit as an owner-approved backup (no PR, no merge, no deploy) - confirm with `git ls-remote origin refs/heads/wip/docgen-crash-turn-ceiling` |
| PR | none, and none is to be opened for this backup |
| Deployed | no |

## 2. Current state summary

This session wrote no feature code. It backed up unfinished work before the owner
moves development to a new Windows PC and a Mac.

**Where the work came from.** On 2026-08-25 the owner asked whether he could raise
the output-token limit himself. That was in the same Claude Code session that shipped
the empty-turn hotfixes: `2485d76c-309a-47fd-a199-1154b9f7d82c`, which started on
2026-08-24. In reply, the agent started a runtime-tunable output ceiling with two
parts:

- `resolveTurnMaxTokens()` reads the runtime-config value `agent` / `max_output_tokens`.
  It clamps the value to 1024–32768 and falls back to 8192.
- `trimTurnsToBudget()` puts a byte budget on the stored turn window.

The owner then said he was only asking. The work stayed uncommitted in the linked
worktree `C:\dev\Netzer-Labs\.worktrees\docgen-crash` for 23 days.

**No dated session log covers that 2026-08-25 work.**
[`2026-08-24-empty-turn-poisoning.md`](./2026-08-24-empty-turn-poisoning.md) was written
at 22:30 on 2026-08-24, before rounds three and four and before the WIP. The rewritten
canonical `HANDOFF.md` was the WIP's only record.

**Where the work is now.** It is on `wip/docgen-crash-turn-ceiling`:

- `ef0768f` holds the four source and test files, byte-for-byte as they were left.
- The next commit, which adds this file, holds `HANDOFF.md` (its 2026-08-25 rewrite plus
  this session's edits) and this session log.
- `hotfix/empty-turn-poisoning` is unchanged at `3bffea6` and is already on origin.

**What is still unfinished.**

- **The new tests are still red.** Vitest was not run (M6).
- **Hoisting the `getConfig` mock will not be enough.** Reading the code and running a
  Node replica of the two helpers found a second defect: a whitespace-only config value
  resolves to 1024, but its test expects 8192 (section 3.1).
- **XLSX generation in production is still unproven.** This was last observed on
  2026-08-25 and not re-checked.
- **The WIP overlaps another branch.** It edits the same code as the back-merge of the
  production hotfixes into `development`. That branch is `fix/backmerge-production-hotfixes`,
  whose session log is `2026-09-10-backmerge-production-hotfixes.md`. Reconcile the two
  before this merges anywhere.

Verified facts at the time of writing:

- Branch: `wip/docgen-crash-turn-ceiling`, in the linked worktree
  `C:\dev\Netzer-Labs\.worktrees\docgen-crash`.
- Tip before this docs commit: `ef0768f5dad6a02c97ac57e94fc4eb552b8ab891` (parent
  `3bffea64ad699fb3e68311450dde235d70269f74`).
- Pushed: not yet at the time of writing; the coordinator pushes this branch to origin under the same name immediately after this commit as an owner-approved backup (no PR, no merge, no deploy) - confirm with `git ls-remote origin refs/heads/wip/docgen-crash-turn-ceiling`
- Non-git files for this campaign are listed with their devkit locations in section 8.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **The knob reuses the existing runtime-config path.**
  - `getConfig(category, key)` is at `src/lib/state/runtime-config-repo.ts:69`. It
    caches values for 30 seconds (`CACHE_TTL_MS`, line 31).
  - The dashboard already writes these values through `POST /config/:category/:key`
    (`src/adapters/dashboard/handler.ts:2202`). Writes are admin-only (line 237).
  - Once merged, `agent` / `max_output_tokens` can be changed without a deploy. The
    value is global, so every agent gets it, including agents created later.
- **The value is resolved once per turn.** `resolveTurnMaxTokens()`
  (`src/agent/agent-loop.ts:100`) runs once in `runAdmittedTurn` (line 840). Every
  `maxTokens` in the file uses that value: the initial streamed call (line 849) and
  both tool-loop `inferenceConfig` sites (lines 996–997 and 1132–1133). The Bedrock
  client still falls back to `input.maxTokens ?? 1024` (`src/lib/bedrock/client.ts:273`)
  for any caller that leaves `maxTokens` out.
- **First test defect (known since 2026-08-25).** The new `resolveTurnMaxTokens` tests
  (test file line 129) call `getConfig.mockResolvedValue(...)`. But `getConfig` exists
  only inside the `vi.mock('../lib/state/runtime-config-repo.js', ...)` factory (lines
  69–71), so the module scope has no binding for it.
  - When run, those tests should throw a `ReferenceError`.
  - `tsc --noEmit` should also report the missing name, because `tsconfig.json`
    includes `src/**/*`.
  - Neither was run this session.
- **Second test defect (found 2026-09-17, not fixed).**
  - The resolver's junk check is `if (!raw || !Number.isFinite(parsed))`.
  - `Number('  ')` is `0`, which is finite. A whitespace-only value therefore gets
    clamped to the floor and returns **1024**, while the `ignores junk` test expects
    **8192**.
  - `''`, `'lots'` and `'null'` do fall back correctly.
  - The fix that matches the test's stated intent is to trim `raw` before both checks.
- **The byte trim looks correct.** The replica gave `trimTurnsToBudget()` the same
  inputs its six new tests use, and it passed all six:
  - the window already fits;
  - the oldest turns drop first;
  - kept turns stay whole;
  - the newest turn is always kept;
  - kept plus dropped rebuilds the input;
  - 20 turns of 16 KB come down to 18 turns within 300,000 bytes.

  The "not passing" note in `HANDOFF.md` may therefore apply only to the agent-loop
  tests. Vitest has not confirmed this either way.
- **The byte accounting is an estimate.** `turnBytes()` counts the UTF-8 text plus a
  flat 64 bytes. The session item's other attributes are not counted. That leaves
  roughly 100 KB between `MAX_TURN_WINDOW_BYTES = 300_000` and DynamoDB's 400 KB item
  limit, and nobody has measured it. `appendTurns` still retries only
  `ConditionalCheckFailedException` (`src/lib/state/sessions-repo.ts:364`), so any
  other write error still throws.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/agent/agent-loop.ts:79-104` | `TURN_MAX_TOKENS`, the floor and ceiling constants, `resolveTurnMaxTokens()` | The knob, and the whitespace defect |
| `src/agent/agent-loop.ts:840` | Resolves the ceiling once per turn | Every `maxTokens` in the turn uses this value |
| `src/agent/agent-loop.max-tokens.test.ts:17-21` | The `vi.hoisted` block | Where the `getConfig` mock needs to move (section 6.1) |
| `src/agent/agent-loop.max-tokens.test.ts:69-71` | The inline `runtime-config-repo.js` mock | Why the new tests cannot reach `getConfig` |
| `src/agent/agent-loop.max-tokens.test.ts:129` | The new `resolveTurnMaxTokens` block | Red, for two reasons (section 3.1) |
| `src/lib/state/sessions-repo.ts:49-78` | `MAX_TURN_WINDOW_BYTES`, `turnBytes()`, `trimTurnsToBudget()` | The byte budget |
| `src/lib/state/sessions-repo.ts:285-290` | How `appendTurns` uses the trim | Dropped turns join the count-evicted turns, so memory ingest still sees them |
| `src/lib/state/sessions-repo.persistence.test.ts:149` | The new `trimTurnsToBudget` block | All six of its inputs passed in the replica |
| `src/lib/state/runtime-config-repo.ts:31,69` | The 30-second cache and `getConfig` | The mechanism the knob relies on |
| `src/adapters/dashboard/handler.ts:237,2202` | The admin-only config write route | How an operator would set the value |
| `src/lib/bedrock/client.ts:273` | The `?? 1024` fallback | Any caller that leaves out `maxTokens` still gets 1024 (M12) |

### 3.3 Patterns and conventions to follow

- **Test bodies may only use mocks from `vi.hoisted(...)`.** Vitest hoists `vi.mock`
  factories above the imports, so a factory can reach only hoisted values, and a mock
  created inside one is invisible to the tests. This file already hoists
  `tryAcquirePanic`, `converseStreamTurnWithFallback` and `writeAudit` (lines 17–21).
- **Runtime tunables read `getConfig(...).catch(() => undefined)` with a default in
  code.** `sessions` / `cross_surface_note_enabled` does this at `agent-loop.ts:785`.
- **Keep helpers pure and exported, and test them directly.** This is carried from the
  2026-08-24 log, section 3.3.
- **The chat-surface parity rule in [`CLAUDE.md`](../../../../CLAUDE.md) does not
  apply.** Both changes are in shared code, not in a surface adapter.

## 4. Work completed

### 4.1 Tasks finished

- [x] Checked that the worktree was on `hotfix/empty-turn-poisoning` at `3bffea6` and
      had exactly the five expected modified files.
- [x] Created `wip/docgen-crash-turn-ceiling` from there, carrying the dirty files.
      `hotfix/empty-turn-poisoning` was not touched.
- [x] Committed the four source and test files byte-for-byte as `ef0768f`.
- [x] Checked the two WIP helpers by reading them and by running a Node replica
      (section 7), which found the whitespace defect.
- [x] Wrote this log and updated the canonical `HANDOFF.md`.
- [ ] Get the new tests passing. Not attempted; see section 6.1.
- [ ] Prove that XLSX generates in production. Still open, carried from `HANDOFF.md`.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `src/agent/agent-loop.ts` | Committed as-is in `ef0768f`; written 2026-08-25, not changed this session | Backup |
| `src/agent/agent-loop.max-tokens.test.ts` | Committed as-is in `ef0768f` | Backup |
| `src/lib/state/sessions-repo.ts` | Committed as-is in `ef0768f` | Backup |
| `src/lib/state/sessions-repo.persistence.test.ts` | Committed as-is in `ef0768f` | Backup |
| `docs/features/chat-history-integrity/HANDOFF.md` | The uncommitted 2026-08-25 rewrite, plus these 2026-09-17 edits: frontmatter; branch and push state; "uncommitted" now points at `ef0768f`; the replica finding; the back-merge overlap; a new session index row | It was the WIP's only record |
| `docs/features/chat-history-integrity/handoffs/2026-09-17-docgen-crash-wip-transfer.md` | New: this file | Machine transfer |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Two commits: the code first (`ef0768f`), then the docs | One commit of all five dirty files, as the transfer plan's B6 row first described | The code commit then holds exactly the bytes left on 2026-08-25, and the docs commit can cite it by SHA. The coordinator's work order asked for this split. |
| A new branch, `wip/docgen-crash-turn-ceiling` | Committing onto `hotfix/empty-turn-poisoning` | That branch already shipped to `production` (PR #106 merged as `ae62709`) and is on origin. Unfinished work on it would misstate what shipped. |
| Leave the tests red | Hoist the mock and trim the value now | This session only makes a backup, and the owner never asked for the feature to be finished (section 6.3). |

Anything durable here must also become an ADR. A decision recorded only in a
session log is not an accepted decision.

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| `Number()` turns a whitespace-only runtime-config value into `0`, so a resolver must trim before its junk check | `docs/features/chat-history-integrity/README.md`, once the knob merges | **no**: the code has not merged, and this work order limited README edits |
| Twenty maxed turns at 8192 tokens reach 284–324 KB of the 400 KB DynamoDB item limit (measured 2026-08-25), and `appendTurns` retries only `ConditionalCheckFailedException` | Same README, known risks | **no**, for the same reason. `HANDOFF.md` carries it until then. |
| A push to a `wip/*` branch triggers no workflow | `development.md`, branch-to-environment mapping | **no**: amending `development.md` needs owner approval (see M9) |

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

These entries continue the ledger's numbering: P, M and A carry on from P9, M13 and A9.
The back-merge branch (`fix/backmerge-production-hotfixes`) is writing its own transfer
handoff in parallel and may use the same next numbers. When the two
chat-history-integrity ledgers are combined, renumber the later entries rather than
drop either.

#### Process precautions

| # | Precaution | Why it exists |
|---|---|---|
| P10 | Before resuming a `wip/*` backup branch, check what `origin/development` and `origin/production` now contain for the files it edits. | `wip/docgen-crash-turn-ceiling` edits the same `maxTokens` sites and `appendTurns` that `fix/backmerge-production-hotfixes` is bringing to `development`. |
| P11 | When a session leaves work uncommitted, write or update its dated session log too, and prefer committing to a `wip/*` branch before closing. | The 2026-08-25 WIP had no session log and sat uncommitted for 23 days on a disk that later filled to 99%. |

#### Mistakes already made, and their corrections

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M14 | On 2026-08-25 the owner asked whether he could raise the token limit himself, and the agent started building the feature. The owner then said he was only asking. | An unrequested, unfinished feature was left in the tree. | The agent stopped and answered the question. The code is kept as a backup on `wip/docgen-crash-turn-ceiling` (`ef0768f`), not merged. | Answer the question first. Build only when asked. |
| M15 | The 2026-08-25 work ended with uncommitted changes, and the only record was the rewritten canonical `HANDOFF.md`. No dated session log was written or updated. | A reader of `handoffs/` would not know the WIP existed. The only copy was one linked worktree. | Committed to a backup branch on 2026-09-17, and this log records it. | See P11. |
| M16 | `HANDOFF.md` recorded the new tests as "not passing" with a single named cause (the unhoisted `getConfig` mock). There was no run log. | Hoisting the mock alone will not make the suite green. A whitespace-only value resolves to 1024, but the test expects 8192. The byte-trim tests may not be failing at all. | Recorded in section 3.1 and in `HANDOFF.md`. Not fixed, because this session only makes a backup. | "Not passing" without a run log is a claim. Name each failing test and its cause, and keep the output. |

#### Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A10 | A push of `wip/docgen-crash-turn-ceiling` starts no workflow. | Verified 2026-09-17 against this branch's `.github/workflows/` push triggers: `branch-guard` fires for qa, staging and production; `ci` and `docs-ci` for development, qa, staging and production; `deploy` for staging only. `cdk-drift` runs on a schedule. Re-check if a workflow is added. |
| A11 | The WIP was written in Claude Code session `2485d76c-309a-47fd-a199-1154b9f7d82c` (2026-08-24 17:12Z to 2026-08-25 12:47Z). Its scratchpad scripts (`add-knob.py`, `knob-tests.py`) no longer exist. | Verified from the transcript's timestamps and the missing `%TEMP%` folder. Commit `ef0768f` is now the only copy of the work, apart from the tool inputs recorded in that transcript. |

#### Known traps that cost time

| Trap | Where the detail lives |
|---|---|
| `Number('  ')` is `0`, not `NaN`. An `!raw \|\| !Number.isFinite(...)` junk check lets a whitespace-only value through as zero. | This log, section 3.1 |
| A mock created inside a `vi.mock` factory cannot be reached from test bodies. Hoist it with `vi.hoisted`. | This log, section 3.3 |

## 6. Pending work

### 6.1 Smallest next action

In `src/agent/agent-loop.max-tokens.test.ts`, move the `getConfig` mock into the
`vi.hoisted` block, as `converseStreamTurnWithFallback` already is (lines 17–21). Then
have the `runtime-config-repo.js` factory (lines 69–71) return that hoisted `getConfig`.
Get both new test blocks passing, then run the full `npm test` in a normal clone, not a
linked worktree (M6).

### 6.2 Immediate next steps

1. Ask the owner whether this feature is wanted now (section 6.3). If not, leave the
   branch as a record and say so in `HANDOFF.md`.
2. Work in a normal clone: `git fetch origin`, then
   `git switch wip/docgen-crash-turn-ceiling`, then `npm ci`. Measure the `npm test`
   baseline first (P1, M9, M11).
3. Make the change in section 6.1.
4. Fix the whitespace case. Trim `raw` in `resolveTurnMaxTokens()` before both checks,
   which is what the `ignores junk` test intends.
5. Run
   `npx vitest run src/agent/agent-loop.max-tokens.test.ts src/lib/state/sessions-repo.persistence.test.ts`,
   then `npm run typecheck`, then the full `npm test` (P4).
6. Reconcile with the back-merge before any merge (section 6.3).
7. Still open, separately: ask an agent for a spreadsheet in production and watch for
   `msg: "document generated"` with `format: xlsx`.

### 6.3 Blockers and open questions

- [ ] Question: does the owner want this built at all? On 2026-08-25 he said "im just
      asking im not saying we have to solve it today" (transcript `2485d76c`).
      Suggested resolution: ask before step 3 of section 6.2.
- [ ] Blocker: overlap with the back-merge.
      - `fix/backmerge-production-hotfixes` cherry-picks the production hotfixes onto
        `origin/development` (`271339b`). They include `1abba67` (`TURN_MAX_TOKENS` on
        every call) and `8c14b3f` (the empty-turn guard in `sessions-repo.ts`).
      - This WIP edits those same lines.
      - That branch's local tip was `a4bad74` in `C:\dev\_netzer-backmerge` when this
        was written, and it may move with its own transfer commit.
      - Needs: an owner decision on order. Suggested: land the back-merge on
        `development` first, then re-apply `ef0768f` on top as a `fix/*` branch.
- [ ] Question: can every model in the fallback chain accept 32,768 output tokens? Not
      checked. Suggested resolution: check each model's output limit before allowing a
      value above 8192, or clamp per model.
- [ ] Question: is a 300,000-byte window safe? The 64-byte overhead per turn is a guess.
      Suggested resolution: measure a real maxed session item.
- [ ] Open: XLSX has never been generated in production. Last observed 2026-08-25; not
      re-checked this session (no AWS access).

### 6.4 Deferred, and why

- **Everything in the "Open, not addressed here" table of `HANDOFF.md`.** This session
  did not change any of it.
- **`npm test`, `npm run typecheck`, the builds and the integration suite.** This
  session only makes a backup, and Vitest fails in a Windows linked worktree (M6).
- **Promoting the facts in section 4.4.** Deferred until the code merges, or until the
  owner approves the change to `development.md`.

## 7. Verification actually performed

The baseline was taken in the linked worktree before any change, with the five files
still uncommitted. Nothing under `src/` was executed through Vitest or `tsc`.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | not run | not run |
| `npm test` | not run | not run |
| `npm run build` | not run | not run |
| `npm --prefix web run typecheck` | not run | not run |
| `npm --prefix web run build` | not run | not run |
| `npm run local:test:integration` | not run | not run |
| `node scripts/ci/docs-links.mjs` | `docs-links: OK` (exit 0): 87 markdown files, 585 internal links, 16 external skipped | `docs-links: OK` (exit 0): 88 markdown files, 616 internal links, 16 external skipped. The new file and the `HANDOFF.md` edits account for the difference. Run on the staged docs commit. |
| `node scripts/ci/feature-knowledge.mjs` | `feature-knowledge: OK` (exit 0) | `feature-knowledge: OK` (exit 0), run on the staged docs commit |
| `git diff --check` (as `git diff --cached --check` on each commit) | clean (exit 0) for `ef0768f` | clean (exit 0) for the docs commit |
| `git status --porcelain=v1` | exactly the five expected modified files, on `hotfix/empty-turn-poisoning` at `3bffea6` | just before the docs commit, only the two staged docs files were listed (`M` `HANDOFF.md`, `A` this file). Nothing else was modified or untracked. |
| `git hash-object --no-filters <file>` compared with `git ls-files -s` | n/a | equal for all four files in `ef0768f` (for example, `src/agent/agent-loop.ts` is blob `413301aa900a7a2de57e0bcce3490ddfccc8df7d`) |
| grep of each staged diff for `AKIA`, `ghs_`, `ghp_`, `github_pat_`, `xox`, `sk-ant`, `BEGIN PRIVATE`, and long base64 runs | n/a | no hits, for both commits |
| `git ls-remote origin` for development, production, `hotfix/empty-turn-poisoning`, `wip/docgen-crash-turn-ceiling` and `fix/backmerge-production-hotfixes` | `development` = `271339bc8b2feea85e6c31b115fdd34e757a72e2`; `production` = `de244e6387efdba177d550d1fb82a6d60291309e`; `hotfix/empty-turn-poisoning` = `3bffea64ad699fb3e68311450dde235d70269f74`; the other two branches do not exist on origin | n/a |
| `git merge-base --is-ancestor 3bffea6 origin/production`, and the same against `origin/development` | ancestor of production; **not** an ancestor of development | n/a |
| Push triggers in `.github/workflows/*.yml` (five files) | none match `wip/*` (A10) | n/a |
| Node replica: the two helpers copied verbatim from the `ef0768f` sources and run with Node 24 type stripping on the new tests' inputs | n/a | 15 checks: 14 pass, 1 fails (`resolveTurnMaxTokens` given `'  '` returns 1024; the test expects 8192) |
| `node -e 'console.log(Number("  "))'` | n/a | `0` |

**What was not run, and why:**

- **The Vitest suite.** The work order excluded it, and Vitest collection fails in a
  Windows linked worktree (M6).
- **`npm run typecheck` and the builds.** This session only makes a backup. The
  transfer plan also records that a baseline typecheck ran out of memory on this host
  during the back-merge session.
- **Web gates and the integration suite.** Nothing under `web/` changed, and no local
  emulator was started.
- **The replica is not a substitute for Vitest.** It proves the helpers' logic on those
  inputs, not the test files. Its builder script is listed in section 8.

## 8. Environment state

- **Tools and services**:
  - Node v24.19.0, Windows 11, Git Bash.
  - `core.autocrlf=true` globally. The four source files and both handoff documents are
    LF in the index and in the tree.
  - C: had 3.4 GB free when the session started.
  - No AWS call was made.
- **Active processes**: none started.
- **Environment variables**: none set.
- **Uncommitted work left in the tree**:
  - `.worktrees/docgen-crash`: nothing uncommitted. After `ef0768f` only the two docs files remained, and this commit adds them..
  - The main checkout `C:\dev\Netzer-Labs`, on `fix/knowledge-scope-fanout` and holding
    other sessions' modified and untracked files, was not touched (P6).
- **Branch and push state**:
  - Branch: `wip/docgen-crash-turn-ceiling`.
  - Tip before this docs commit: `ef0768f5dad6a02c97ac57e94fc4eb552b8ab891`.
  - Pushed: not yet at the time of writing; the coordinator pushes this branch to origin under the same name immediately after this commit as an owner-approved backup (no PR, no merge, no deploy) - confirm with `git ls-remote origin refs/heads/wip/docgen-crash-turn-ceiling`
  - `hotfix/empty-turn-poisoning`: `3bffea6`, on origin, unchanged.

**Where each non-git file lives.** The devkit is
`https://github.com/emmanuelmadams4-lgtm/netzer-devkit`.

| What | Path on this PC | Devkit path |
|---|---|---|
| The machine-transfer plan (row "B6 Docgen WIP") | `C:\Users\EmmanuelAdams\.claude\plans\we-have-alot-of-eager-spindle.md` | `claude/plans/we-have-alot-of-eager-spindle.md` |
| Transcript of the session that wrote the WIP | `C:\Users\EmmanuelAdams\.claude\projects\C--dev-Netzer-Labs\2485d76c-309a-47fd-a199-1154b9f7d82c.jsonl` (4,754,343 bytes), plus the folder of the same name | Requested at `claude/transcripts/2485d76c-309a-47fd-a199-1154b9f7d82c.jsonl.gz`. It was **not** in the transfer plan's transcript list when this was written, so check the devkit README before relying on it. |
| Scratchpad of the session that wrote the WIP (`add-knob.py`, `knob-tests.py`) | Was under `%TEMP%\claude\C--dev-Netzer-Labs\2485d76c-...\scratchpad\`; **no longer exists** | none |
| This session's replica builder and its output | `%TEMP%\claude\C--dev-Netzer-Labs\26ee85c7-e640-427d-875c-da81e9a7707d\scratchpad\transfer\B6-docgen-wip\replica\` | `archive/scratch/26ee85c7-e640-427d-875c-da81e9a7707d/transfer/B6-docgen-wip/`, if the coordinator archives this scratchpad. It is optional: section 3.1 records the finding, and `node -e 'console.log(Number("  "))'` reproduces the cause. |
| Back-merge campaign state | `C:\dev\_netzer-backmerge` (branch `fix/backmerge-production-hotfixes`) | Git: pushed by the coordinator as that branch. Its non-git state is covered by that branch's own transfer handoff. |

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-08-24-empty-turn-poisoning.md)
- The back-merge session log,
  `docs/features/chat-history-integrity/handoffs/2026-09-10-backmerge-production-hotfixes.md`.
  It is on branch `fix/backmerge-production-hotfixes`, not on this branch, so it is not
  linked here.
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
- The machine-transfer plan, at devkit `claude/plans/we-have-alot-of-eager-spindle.md`

## Appendix A - Resume on a new machine

### A.1 Path map

| On this PC | On the new machine |
|---|---|
| `C:\Users\EmmanuelAdams\.claude\plans\we-have-alot-of-eager-spindle.md` | `~/.claude/plans/we-have-alot-of-eager-spindle.md` after running the devkit restore (source: devkit `claude/plans/we-have-alot-of-eager-spindle.md`) |
| `C:\Users\EmmanuelAdams\.claude\gauntlet\<campaign>` | `~/.claude/gauntlet/<campaign>`. This campaign has no gauntlet folder. |
| `C:\dev\Netzer-Labs\.worktrees\docgen-crash` (a linked worktree) | `<dev-root>/Netzer-Labs`, or any name. Make a **fresh normal clone** of origin and check out `wip/docgen-crash-turn-ceiling`. Do not use a linked worktree for Vitest (M6). |
| `C:\dev\_netzer-backmerge` | `<dev-root>/_netzer-backmerge`: a fresh clone of origin, with `fix/backmerge-production-hotfixes` checked out |
| `C:\dev\_netzer-baseline` (named in the 2026-08-24 log) | Not carried over. Make a new clean clone if you need a baseline. |
| `%TEMP%` scratchpad paths (`...\scratchpad\...`) | devkit `archive/scratch/<session-id>/`. For this session that is `26ee85c7-e640-427d-875c-da81e9a7707d`, if archived. The scratchpad of `2485d76c` no longer exists. |
| `C:\Users\EmmanuelAdams\.claude\projects\C--dev-Netzer-Labs\2485d76c-309a-47fd-a199-1154b9f7d82c.jsonl` | devkit `claude/transcripts/2485d76c-309a-47fd-a199-1154b9f7d82c.jsonl.gz`, if included (section 8) |
| `codex.exe` under `AppData` | The `codex` CLI on `PATH`. Pass its absolute path to `--cli`. This campaign did not use Codex. |
| `-c windows.sandbox="elevated"` | Windows-only. Drop it on macOS. |
| `cygpath`, `MSYS_NO_PATHCONV=1` (needed in Git Bash for `/claudeclaw/orchestrator` log-group paths; see the 2026-08-24 log, section 8), and PowerShell 5.1 notes | Windows / Git Bash only. Not needed on macOS. |
| Docker image builds | On Apple Silicon, arm64 builds natively and amd64 runs under emulation. This campaign builds no images. |

### A.2 Resume prompt

**No resume prompt for this campaign exists in `~/.claude/plans`.** A search on
2026-09-17 for `docgen`, `empty-turn`, `turn-ceiling`, `chat-history-integrity`,
`resolveTurnMaxTokens`, `trimTurnsToBudget` and `max_output_tokens` found this campaign
only in the transfer plan's work-order row. Every other hit was about the back-merge or
unrelated work.

That row is copied below verbatim from devkit
`claude/plans/we-have-alot-of-eager-spindle.md`. The file's SHA-256 when read was
`71b8b552ea5112b9041b5d18e28d3952807692962fca11cc5bbae2b94e5caca3`, and the plan was
still being edited that day.

`````text
| **B6 Docgen WIP** | `.worktrees/docgen-crash` | `git switch -c wip/docgen-crash-turn-ceiling`, then commit the 5 dirty files (`HANDOFF.md` plus the `resolveTurnMaxTokens` / `trimTurnsToBudget` code and tests) with a message stating the tests are red. Add a short transfer handoff with §5 from `2026-08-24-empty-turn-poisoning.md`. |
`````

The prompt below was **written for this handoff**. It is not a copy of a plan file.
Paste it into a fresh session on the new machine:

`````text
You are resuming the chat-history-integrity "turn ceiling" work-in-progress in the
Netzer-Labs repo (Netzar OS Enterprise). Read, in order:
  1. docs/features/chat-history-integrity/HANDOFF.md
  2. docs/features/chat-history-integrity/handoffs/2026-09-17-docgen-crash-wip-transfer.md
     (sections 2, 3.1, 5 "Added 2026-09-17", 6)
  3. docs/features/chat-history-integrity/handoffs/2026-08-24-empty-turn-poisoning.md (section 5)
All three are on branch wip/docgen-crash-turn-ceiling.

Setup:
- Work in a fresh NORMAL clone of origin, not a linked worktree (ledger M6).
- git fetch origin; git switch wip/docgen-crash-turn-ceiling; npm ci.
- Confirm the tip: the docs commit whose parent is ef0768f5dad6a02c97ac57e94fc4eb552b8ab891.

Before changing anything:
- Ask the owner whether he wants this feature finished now. On 2026-08-25 he said he
  was only asking. If he says no, stop and record that in HANDOFF.md.
- Check whether fix/backmerge-production-hotfixes has landed on origin/development,
  and what origin/development and origin/production now hold for
  src/agent/agent-loop.ts and src/lib/state/sessions-repo.ts (ledger P10).
  Agree the base branch with the owner before building.
- Record an `npm test` baseline on that clone (P1).

Then:
1. src/agent/agent-loop.max-tokens.test.ts: move getConfig into the vi.hoisted block
   (the same way as converseStreamTurnWithFallback) and have the runtime-config-repo.js
   vi.mock factory return it.
2. src/agent/agent-loop.ts resolveTurnMaxTokens(): trim the raw value before the junk
   check, so that '  ' falls back to 8192 as the "ignores junk" test expects.
3. npx vitest run src/agent/agent-loop.max-tokens.test.ts src/lib/state/sessions-repo.persistence.test.ts
4. npm run typecheck, then the FULL npm test (P4).
5. Write a new dated session handoff in docs/features/chat-history-integrity/handoffs/ and
   update HANDOFF.md, following docs/features/README.md section 6a.

Do not push, open a PR, merge, or deploy without the owner's explicit go-ahead.
Do not touch AWS.
`````
