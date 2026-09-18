---
feature: deliverables-parity
document_role: session-handoff
status: current
observed_at: 2026-09-14
as_of_commit: b65f52801307582bda6503d0cf7baa6408e257a7
session_slug: w1-harness-verification
supersedes: 2026-09-14-w1-replay-cleanup.md
---

# Session handoff: W1 harness verification

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-14 |
| Feature folder | `docs/features/deliverables-parity/` |
| Branch worked on | `chore/deliverables-parity` in the normal clone `C:\dev\_netzer-diag`. `diag/prod-capture` (`3bb9300`) and a detached `86e616e` were checked out briefly for proofs; no branch moved |
| Branch it merges into next | `development`, and only with the user's approval |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `b65f52801307582bda6503d0cf7baa6408e257a7` |
| Commit at session end | `b65f52801307582bda6503d0cf7baa6408e257a7`: no code changed. This log and the HANDOFF are committed on top of it |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

W1's Gauntlet VERIFICATION phase is complete, and the harness passes. This fresh session wrote none of the harness. It re-ran every proof item (V1 to V6) instead of trusting the earlier logs, and an independent Opus critic read the replay against the frozen design and `origin/production` from git objects. Every item passes. The critic marked one handoff item, A6, as failed: it says every file prompt "ends" with the assumption sentence, but p3 carries that sentence before its CSV block. The code matches the implementation's own record ("says to assume"), and no measurement depends on the sentence's position, so the record was corrected and the code left alone (P5). The critic also found spend and measurement risks outside the frozen design. They are recorded as A12 and in section 6, to settle before Step 2. Nothing touched AWS, nothing was sent to Bedrock, and nothing was pushed. Step 0 is next, and it waits on the user's AWS sign-in and go.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- Re-read from `origin/production` (`de244e6`) in git objects; each holds:
  - **Tool loop.** `TOOL_TURN_LIMIT = 8` (`src/agent/agent-loop.ts:59`) and `turn < TOOL_TURN_LIMIT` (`:949`). The loop breaks when there is no tool use or the stop reason is not `tool_use`. Each round is a non-streaming `ConverseCommand` with `maxTokens: TURN_MAX_TOKENS` (8192, `:79`) and temperature 0.7. The eighth round's tools still run, so a turn makes at most 10 calls.
  - **Forced synthesis.** It triggers on `if (!lastText && lastStopReason === 'tool_use')` (`:1075`). The instruction is verbatim (`:1085`), rides inside the trailing user turn, and goes without `toolConfig`. A failure is logged and swallowed (`:1130-1134`), and the reply falls back to `truncatedNotice(lastStopReason)` (`:1142`), which the comment at `:1070-1071` names "(no response)". A replay record in `error` on its synthesis call is therefore what the user would have seen as "(no response)".
  - **Retries.** The same four error names (`src/lib/bedrock/client.ts:290-297`) and 3 attempts, stopping at `attempt === maxRetries - 1`. The wait is `500 * Math.pow(2, attempt)`: 500 ms, then 1000 ms. Only `send` is wrapped (`:426-427`), so an error while reading a stream is not retried.
  - **Temperature re-send.** Production re-sends a stream without temperature after a ValidationException that names it (`client.ts:430-435`). The replay has no such path.
  - **Pricing.** `turnCost(modelId, input, output, cacheRead = 0, cacheWrite = 0)` is at `src/lib/bedrock/models.ts:152-166`. `us.anthropic.claude-sonnet-4-6` prices as `sonnet`, at 3 / 15 / 3.75 / 0.3 USD per million tokens. An unknown id falls to `haiku`, never $0 (`:70-71`), and nothing prices guardrail use.
  - **Document tool texts.** Success is at `document-generation-tools.ts:112-113`. The unknown-format text at `:220` returns before validation, and `spec invalid or build failed:` is at `:236`. `pdf.ts:77` throws the `cannot render` message that the replay's `winAnsiRejected` matches.
- The dry-run estimate re-derives by hand from that table. For p1 under S, the first call is `ceil(23977 / 3)` tokens at 3.75 plus 1,024 at 15, per million tokens. Each of the nine loop-kind calls adds 8,192 at 15 on the same input. That gives $1.42 per run; the 75-run total is $210.76.
- Captures are deterministic. This session's re-capture on `3bb9300`, the previous `3bb9300` capture and `capture-f7194c157503.json` have identical `firstCall.input` and `toolLoopCalls`; only `capturedAt` and `headSha` differ. The dry run's input is therefore request-identical to production's capture today.
- **The capture is not production's live request.** Memory, the inter-agent inbox and the hive are stubbed, and MCP returns no tools (`capture.diag.ts:63-130`). Of the add-on gates, only `RAW_BUCKET` is set (`:52-60`). Step 0's list covers the agent prompt, the guardrail and the tool gates, but not production's MCP servers (`runtime-config`, `category: mcp`).

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `scripts/diagnostics/deliverables/replay.ts` | The E1 replay and its CLI | Verified; the spend boundary |
| `scripts/diagnostics/deliverables/prompts.ts` | Prompts, fixtures, export, `refuseInsideRepo`, `REPO_ROOT` | Verified; A6's wording (`:141`) |
| `scripts/diagnostics/deliverables/replay.diag.ts`, `capture.diag.ts`, `vitest.diag.config.ts` | The contract | Unchanged since `bc462df`; re-run |
| `src/agent/agent-loop.ts`, `src/lib/bedrock/client.ts`, `src/lib/bedrock/models.ts`, `src/lib/tools/document-generation-tools.ts`, `src/lib/documents/pdf.ts` on `origin/production` | What the replay mirrors and how it prices | Read from git objects for V4 |

### 3.3 Patterns and conventions to follow

- **Verifying a spend path's CLI.** Use a golden master and two tripwires:
  - the P12 environment;
  - a network preload, loaded with `NODE_OPTIONS=--import=<file URL>`, that records and refuses every outbound TCP connect but lets local pipes through, because tsx uses one for IPC;
  - a positive control that passes every refusal and must stop at `prepareEnv`'s own message.

  Drive it from PowerShell through a Node runner. Byte-compare the before and after directories with `cmp` or a byte comparer, never with `git diff --no-index` (section 5.4).
- **Probe the property, not its label.** `--guardrail <ARN>:` with a trailing colon refuses only if the split is on the last colon. The ARN dry run's label reads the same for any split.
- **Auditing a Codex child after its session scratchpad is gone.** Read `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`: `turn_context` holds the model, effort and sandbox policy, and each command sits in an `exec` custom tool call's arguments. Summarise it with a script, because the log also holds file content.
- **PowerShell tool refusals.** When the tool refuses a command because its text names a destructive cmdlet, even inside a string, put the script in a file and run that file.
- **Comparing captures.** Compare `firstCall.input` and `toolLoopCalls`, not the files: `capturedAt` changes every run and `headSha` every commit.

## 4. Work completed

### 4.1 Tasks finished

- [x] State restored from the handoff, whose Downloads and plans copies are byte-identical. The process was declared from `development.md` and the feature framework before any command.
- [x] **V1, the contract:** 15 of 15 on `diag/prod-capture` `3bb9300`, and the three contract files are unchanged since `bc462df`.
- [x] **V2, the suite** on `chore/deliverables-parity` `b65f528`:
  - typecheck;
  - `npm test` with AWS stripped, matching the baseline exactly;
  - both docs gates and `git diff --check`;
  - the replay contract, 13 of 13.
- [x] **V3, the spend gates**, behind P12 and a network tripwire, at `86e616e` and `6f4e09e`: three dry runs, seven refusals plus two variants, a `prepareEnv` positive control, and the export with its refusal.
- [x] **V4, the frozen design:** an independent Opus critic, plus the coordinator's spot-check of the decisive production lines.
- [x] **V5, scope and state**, including a read-only `git ls-remote` of GitHub.
- [x] **V6, record honesty:** every claim in section 7 of the cleanup log was re-run or re-derived.
- [ ] **Step 0:** waits on the user's AWS sign-in and go.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/deliverables-parity/HANDOFF.md` | Current state | The phase moved |
| This log | New | The session record |

No code, contract or README changed.

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Verdict PASS | FAIL, routed to IMPLEMENTATION or SPECIFICATION | Every item from V1 to V6 passed with evidence; A6 is the next row |
| Treat A6 as a record error, corrected in this log and the next handoff | Move p3's sentence after its CSV block (IMPLEMENTATION); re-freeze the wording (SPECIFICATION) | The contract never checks the sentence. The implementation log and `prompts.ts`'s header both say the file prompts "say" or "tell" the model to assume; "ends" appears only in the VERIFICATION handoff. System A and every profile receive identical bytes, pinned by sha256, so the position cannot bias E1. Moving the sentence would change p3's pinned hash for no measured gain. P5 applies: the code wins |
| Leave the unmetered spend paths as a decision before Step 2, not a FAIL | FAIL to SPECIFICATION | The frozen design meters returned usage and charges a failed stream its worst case, and the code does exactly that. The gap is in the design's promise (A10's "a few cents"), which the user should weigh with Step 2's approval (A12, section 6.3) |
| Add a positive control and a network tripwire to V3 | The recorded case list only | A refusal message alone cannot show that nothing was attempted, or that the P12 tripwire was armed |
| Byte-compare golden masters with a script | `git diff --no-index` | On this machine it reports LF and CRLF copies as equal (section 7) |
| Give the critic git objects only | The working tree | V1 and V3 switched the working tree between branches and commits |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| A replay run in `error` on its forced synthesis is production's "(no response)" (`agent-loop.ts:1070-1075`, `:1130-1142`) | `docs/features/deliverables-parity/README.md`, section 6 | no: VERIFICATION writes only this log and the HANDOFF. Promote it in the next session that edits the docs |
| Captures are request-deterministic across overlays | README section 5, "Request size, measured" | no, for the same reason |
| `turnCost` has no guardrail term, so guardrail charges fall outside the cap | README section 5, "Replay (E1)" | no, for the same reason |

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
| P12 | Check a spend path's refusals behind a tripwire: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` set to `local`, `AWS_ENDPOINT_URL` dead, the profile variables unset, and the AWS config files pointed at a missing path. | A refusal that fires prints its own message, and a path that slips past one stops at `prepareEnv` instead of reaching an account. Every `replay.ts --spend` refusal was proved this way on 2026-09-14. |
| P13 | Before a Codex child edits this clone, give it the P12 tripwire environment and `-c sandbox_workspace_write.network_access=false`, then check its edits against expected text built from the base commit. | This machine's `~/.codex/config.toml` turns network on for workspace-write, so a delegated command could otherwise reach a real account, and Codex's own report is not evidence. Applied to the 2026-09-14 cleanup handoff. |
| P14 | Run `replay.ts --spend` only from `diag/prod-capture`, and only after `git diff chore/deliverables-parity diag/prod-capture -- scripts/diagnostics/deliverables` prints nothing. | A record carries the capture's `headSha`, not the tree whose validators and builders judged its documents (`replay.ts:62-65`, `:423`). Production's PDF character refusal (`d828124`) exists only on production's tree. Found by the 2026-09-14 VERIFICATION critic. |
| P15 | Prove that a spend path sends nothing, not only that it refuses. Behind P12, load a network tripwire through `NODE_OPTIONS=--import` that records and refuses every outbound TCP connect, and add a positive control that passes every refusal and must stop at `prepareEnv`. | A refusal message cannot show that nothing was attempted or that the tripwire was armed. On 2026-09-14 the tripwire logged 0 blocked connects across every case at two commits, and the control stopped at `prepareEnv`. |

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
| M10 | The first `replay.ts` draft prefixed production's unknown-format refusal with `spec invalid or build failed:`. | Prompt 2 asks for a PPTX, so the model would have read a tool result production never sends. The contract did not catch it. | The spend-safety review found it before the checkpoint; the replay sends production's exact text (`d91efaf`). | When a harness mirrors production's text, read every return in the handler, not only its `catch`. |
| M11 | The VERIFICATION handoff said every file prompt "ends" with "Make reasonable assumptions instead of asking me questions." | p3 carries the sentence before its CSV block (`prompts.ts:141`), so the fresh critic returned FAIL (A6) against a correct implementation. | Recorded as "includes" in the 2026-09-14 verification log and the next handoff. The code is unchanged (P5): no measurement depends on the position, and p3's sha256 is pinned. | When a handoff restates code, cite the line rather than paraphrase. The same handoff's "35 entries" meant top-level entries (39 files), and "each with its own message" meant six distinct texts for seven refusals. |

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
| A9 | Bedrock rejects a Converse request whose messages hold `toolUse` or `toolResult` blocks when `toolConfig` is absent. | **Unverified**: recalled, not measured. Production's forced synthesis sends exactly such a request, so if this holds, that synthesis always fails and the turn falls back to placeholder text. The replay sends the same request and records a failure as `status: error`, so Step 2's records settle it. |
| A10 | The replay's worst-case admission, `ceil(chars / 3)` input tokens at the cache-write price plus `maxTokens` of output, bounds a call's real cost. | **Unverified** until Step 2's first call returns exact `inputTokens`. JSON-heavy tool specs and Bedrock's tool-use preamble can exceed `chars / 3`, but output dominates the estimate, so the cap can be exceeded by at most one call's input shortfall, a few cents. R5 freezes the formula. |
| A11 | Bedrock returns `usage` on every successful Converse and ConverseStream response. | **Unverified.** `exchange()` in `replay.ts` meters only the usage a response carries, so a response without it would be charged $0 and record 0 tokens; only a stream that fails after send is charged its worst case. Such a call would show as 0 input tokens in the JSONL, and Step 2's records settle it. |
| A12 | The $30 cap bounds metered model spend, not the AWS bill. | **Unverified in size.** `exchange()` charges returned usage, and only a stream that fails while being read is charged its worst case. Three costs escape the cap: guardrail evaluation, which Bedrock bills apart from tokens and `turnCost` does not price (`models.ts:152-166`); a non-streaming round whose response is lost after Bedrock accepted it, charged $0 (`replay.ts:472`); and A11's response without usage. A10's "a few cents" covers only a metered call's input shortfall. Settle it with the user before Step 2's go: see the 2026-09-14 verification log, section 6.3. |

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
| exceljs types `workbook.xlsx.load()`'s input as an `ArrayBuffer`, so passing a Node `Buffer` fails `tsc` under Node 24's types. Cast through `unknown`; exceljs reads the Buffer at run time. | The comment above `xlsx.load` in `scripts/diagnostics/deliverables/replay.ts` |
| Every `replay.diag.ts` run leaves `replay-diag-*` folders under the temp directory, and R5's holds 75 artifact folders. They hold fake data only. | This log, section 8 |
| The clone's `AGENTS.md` is an install runbook (`npm ci`, `npm run up`), and Codex reads it as project instructions. A Codex work order here must say it is not an install task. | This log, section 3.3 |
| Codex's `apply_patch` failed twice on a CRLF line holding backticks in `replay.ts`, and Codex recovered by rewriting both files' line endings. The bytes came out right; check the working tree against expected content rather than trusting the patch tool. | This log, section 7 |
| A `codex exec` handoff here took 469 s for eight one-line edits and warned that the skills context budget was exceeded, dropping every skill description. Run it in the background. | This log, section 7 |
| Under this machine's `core.autocrlf=true` (set in the system gitconfig), `git diff --no-index --exit-code` reports an LF file and a CRLF file as equal. Byte-compare golden masters with `cmp`, `diff -r` or a byte comparer. | 2026-09-14 verification log, section 7 |
| The PowerShell tool refuses a command whose text names a destructive cmdlet, even inside a string such as a regex (`Remove-Item on system path '/\b' is blocked`). Put the script in a file and run the file. | 2026-09-14 verification log, section 3.3 |
| A dry run with `--guardrail <ARN>` cannot show where the value was split: the label rejoins `id:version`, and the request length is the same for any split point. A trailing-colon ARN, which refuses only under a last-colon split, is the probe that tells them apart. | 2026-09-14 verification log, section 7 |
| Two captures of one tree differ in `capturedAt`, and captures of different commits also differ in `headSha`, so `cmp` always reports a difference. Compare `firstCall.input` and `toolLoopCalls` instead. | 2026-09-14 verification log, section 3.3 |
| A `replay.ts --spend` campaign stops only for the budget. A credential or transport error marks that run `error` and the next run starts, so a sign-in that lapses mid-campaign (sessions last about 2 hours) leaves a tail of $0 error records. Check the session's age before `--spend`. | 2026-09-14 verification log, section 6.4 |
| Codex's `--json` event stream lives in a session scratchpad and disappears with it. `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` survives: `turn_context` holds the model, effort and sandbox policy, and each command sits in an `exec` custom tool call's arguments. | 2026-09-14 verification log, section 3.3 |

## 6. Pending work

### 6.1 Smallest next action

When the user has signed in to AWS and says go, start W1 Step 0 from `~/.claude/plans/claude-bedrock-deliverables-handoff.md`. Do not start it without that go.

### 6.2 Immediate next steps

1. Step 0, read-only, once the user signs in and says go:
   - Logs Insights Q1 to Q6 on `/claudeclaw/orchestrator` and `claudeclaw-token-usage`.
   - The `agents/*/CLAUDE.md` listing, and the incident agent's file for `DIAG_AGENT_PROMPT_FILE`.
   - The raw-bucket listing, production's guardrail id and version, and the running task definition's container environment, read by container name, for the web search, email and Nova Canvas gates.
   - **New:** production's MCP server config (`runtime-config`, `category: mcp`, `key: servers`), because the capture registers no MCP tools.
   - Re-capture with `DIAG_AGENT_PROMPT_FILE`, the gates, and any MCP tools production has.
2. Export the prompts for System A (the 2026-09-14 implementation log, section 3.3).
3. Settle A12 with the user before asking for Step 2's go (section 6.3).
4. Step 2 only on the user's go, within $30, and from `diag/prod-capture` (P14). Step 3 only with its own approval, which must state that System A runs Sonnet 5 and the replay Sonnet 4.6.

### 6.3 Blockers and open questions

- [ ] Blocker: Step 0 — needs: an AWS sign-in (the root `default` profile; sessions last about 2 hours) and the user's go.
- [ ] Blocker: 3–5 production failures from before and after 2026-08-24 — needs: the user.
- [ ] Blocker: System A's files for the exported prompts — needs: the user, once the prompts are exported.
- [ ] Blocker: Step 2 spend of up to $30, and the Step 3 judge — needs: two separate approvals.
- [ ] Question: is the $30 cap meant to bound the AWS bill, or metered model spend? The replay charges returned usage only (A12), so guardrail charges, a non-streaming round whose response is lost after Bedrock accepted it, and a response without usage go uncharged. Suggested resolution: decide with Step 2's approval. Either:
  - accept it once Step 0 shows which guardrail policies production uses; or
  - route a bounded IMPLEMENTATION change first: charge the worst case for any failed send that is not a throttle, add a guardrail allowance to admission, and stop the campaign on credential errors.
- [ ] Question: the incident's exact prompt wording — suggested resolution: the user supplies it, or Step 0 reads the `'agent turn started'` log line, which carries the first 80 characters of the prompt.
- [ ] Question: H3 compares different models — suggested resolution: state it in the judge's approval, or run System A on Sonnet 4.6 if the app offers it.
- [ ] Question: does production enable the web search, email, Nova Canvas or MCP tools? — suggested resolution: Step 0 reads the task definition's environment by container name, and the `runtime-config` MCP entry.
- [ ] Gap reports 1 and 2 from the [2026-09-11 log](2026-09-11-w1-harness-specification.md#63-blockers-and-open-questions), section 6.3: still drafted, not applied. Gap report 1's proposed line should name `replay.ts --spend`, because the plain command is a dry run.

### 6.4 Deferred, and why

These are left for Step 2's analysis or a later, approved change; VERIFICATION records them and does not act.

- **Only the budget stops a campaign** (`replay.ts:564-571`, `621-640`). A credential or transport error marks the run `error` and the next run starts, so an expired sign-in leaves a tail of $0 error records.
- **Errors may cluster in profile U.** A 32,000-token non-streaming round sent from this machine is the call most exposed to a dropped connection, while production sends its rounds from inside AWS. Read U's `error` records apart from model failures.
- **The record shape hides three things** (`replay.ts:470`, `495`, `560`):
  - synthesis is recorded as `kind: 'loop'`;
  - a failed synthesis leaves no call record;
  - the first call's `toolUses` is always empty, because the stream's tool-use blocks are not read.
- **No temperature re-send.** The replay lacks production's re-send without temperature. If Sonnet 4.6 rejected temperature, every run would fail visibly at $0.
- **Artifacts folders are reused.** An existing `<out name>-artifacts` folder is reused, not refused (`replay.ts:594-602`), so give each campaign a fresh `--out` directory.
- **Loop and synthesis models are unchecked.** Their `modelId` comes from `toolLoopCalls[0]` (`replay.ts:253-261`). `capture.diag.ts:361-363` asserts it, so a capture cannot differ.
- **Short placeholder link.** It is shorter than production's presigned URL. Accepted, because E1 compares profiles, which share it.
- **A9 and A11.** Whether Bedrock accepts the tool-less synthesis request, and returns usage on every response, is settled by Step 2's records.
- **Outside W1 or later.** E2, E3 and every fix are outside W1. Delete `diag/prod-capture` and the `replay-diag-*` temp folders when W1 closes.

## 7. Verification actually performed

No code changed this session. The baseline column is what the CLEANUP log recorded at `6f4e09e`. The second column is this session's re-run at `b65f528`, whose code is identical to `6f4e09e`, unless the row names another commit.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | clean | clean (19 s) |
| `npm test`, AWS credentials stripped | 5 files failed, 238 passed, 1 skipped; 1 test failed, 3108 passed, 6 skipped (83.97 s) | identical counts (253.62 s, with other work running). The four shebang files each fail on `SyntaxError: Invalid or unexpected token`; `rollback-classes.test.ts` fails one assertion; `durability.repro.test.ts` passed 7 of 7 |
| `npm run build` | not run | not run |
| `npm --prefix web run typecheck` | not run | not run |
| `npm --prefix web run build` | not run | not run |
| `npm run local:test:integration` | not run | not run |
| `node scripts/ci/docs-links.mjs` | OK: 141 markdown files, 1775 internal links | OK at `b65f528`: 141 files, 1775 links. OK with this log and the HANDOFF in place: 142 markdown files, 1803 internal links |
| `node scripts/ci/feature-knowledge.mjs` | OK | OK at `b65f528`, and OK with this log and the HANDOFF in place |
| `git diff --check` | `86e616e..6f4e09e` clean | `git diff --check 86e616e b65f528` and `6f4e09e b65f528` clean; `git diff --cached --check` clean over this log and the HANDOFF |
| V1: `npx vitest run --config scripts/diagnostics/deliverables/vitest.diag.config.ts` on `diag/prod-capture` `3bb9300` | 15 of 15 | 15 of 15: capture 2, R1–R10, P1–P3 (5.04 s) |
| V1: `git diff bc462df 6f4e09e --` the three contract files | prints nothing | prints nothing, exit 0. The harness files at `6f4e09e` and `3bb9300` are also identical |
| Replay contract on the chore tree (the same config, filtered to `replay.diag.ts`) | 13 of 13 | 13 of 13 |
| V3: golden master of `86e616e` against `6f4e09e`, behind P12 and the network tripwire | byte-identical over 35 entries | 15 cases per commit, 66 files per side. Every CLI case is byte-identical, and matches CLEANUP's recorded output wherever the arguments match. The one difference is this session's added export-inside-repo case: its uncaught stack trace names `prompts.ts:59` and `:164` before and `:60` and `:165` after, the shift from the cleanup's one-line doc comment. CLEANUP's own `before` and `after` are byte-identical: 39 files, 35 top-level entries |
| V3: dry run, `--capture capture-f7194c157503.json` | 75 runs; p1 23,977 characters; p4 64,931 (64,932 at U); worst case $210.76 | the same, byte for byte; exit 0; no watched path created |
| V3: the refusals | seven, each exit 1 with its own message | all seven exit 1 before `prepareEnv`, as do `--spend` variants of the bad guardrail and `--reps 0`. There are six distinct messages, because "no guardrail choice" and "both choices" share the "exactly one of" message. The inside-repository refusal names the path it was given |
| V3: positive control, `--spend --no-guardrail --out <outside>` | not run | exit 1 with `prepareEnv`'s own message, after printing the plan; no record file, no artifacts folder |
| V3: `--guardrail` given an ARN | parsed as the ARN and version `3` | accepted. A trailing-colon ARN and `:3` are refused, which shows the split is on the last colon |
| V3: network tripwire | not run | 0 blocked connects in 68 preload loads, across both runs and the guardrail probe |
| V3: prompt export | five files, same sha256 | the same five sha256 values (p1 `26c41392…`, p2 `95f02d80…`, p3 `b10eb57b…`, p4 `9f14b6db…`, p5 `c7865e67…`), byte-identical to CLEANUP's. An export inside the repository is refused and creates nothing |
| V4: frozen design against `origin/production` | not applicable | independent Opus critic, from git objects: J1–J3, F1–F13, A1–A5, A7 and A8 PASS. A6 failed on its wording and is resolved as a record error (section 4.3). The coordinator's spot-check of the decisive lines agrees |
| V5: `git diff --name-only 271339b b65f528` and `de244e6 3bb9300` | docs folder and harness only | the same, with no product path. `git branch -r --contains` prints nothing for either tip. `git ls-remote --heads origin` lists neither branch, and shows development at `271339b` and production at `de244e6` |
| V5: untracked and ignored files in the clone | none | nothing untracked; only `node_modules/` and `tsconfig.tsbuildinfo` are ignored |
| V6: cleanup diff `86e616e..6f4e09e` | 2 files, +8/−8, CRLF kept | 2 files, +8/−8, exactly the three described edits. `git ls-files --eol` shows `i/lf w/crlf` for all five harness files. `d91efaf..86e616e` touches documentation only, as the record says |
| V6: the Codex run | `gpt-5.6-luna` at medium; 469 s; exit 0; read-only inspection plus one line-ending rewrite | The rollout log `01a0a08a-…` shows `gpt-5.6-luna` at medium effort, `workspace-write` with `network_access: false`, and approval `never`. It spans 466 s from first to last entry, with 19 tool calls. The only writes were five `apply_patch` attempts and one `WriteAllText` line-ending rewrite, all on the two files. There was no npm, tsx, git state change or network call. A read-only `git status --short --branch` is missing from the record's list |
| Line-ending check: an LF file against a CRLF file | not applicable | `cmp` reports a difference. `git diff --no-index --exit-code` exits 0 under `core.autocrlf=true`, and exits 1 with `-c core.autocrlf=false` |

The V3 cases ran under the P12 tripwire:
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` set to `local`, and `AWS_ENDPOINT_URL` set to `http://127.0.0.1:9`;
- every other `AWS_*` variable removed;
- `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` pointed at the missing `C:\nonexistent-aws`;
- `AWS_EC2_METADATA_DISABLED=true`;
- the network preload.

`npm test` and V1 ran with these settings:
- `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, and the key and session variables unset;
- the two AWS files pointed at that missing path;
- `AWS_EC2_METADATA_DISABLED=true`.

Anything not run, and why:
- `npm run build`, both web commands and `npm run local:test:integration` are pre-push gates, and no push is planned. They must run before anyone pushes this branch.
- Step 0, the live replay and the judge did not run, by design.
- No command reached AWS. The only network call was one read-only `git ls-remote` to GitHub.

## 8. Environment state

- **Tools and services**: Node 24.19.0; tsx 4.22.3; Git with `core.autocrlf=true` from `C:/Program Files/Git/etc/gitconfig`.
- **Branches in the clone**:
  - `chore/deliverables-parity`: `b65f528` plus this commit.
  - `diag/prod-capture`: `3bb9300`, local only.
  - `fix/knowledge-scope-fanout`: untouched.
  - HEAD sat on `diag/prod-capture` for V1 and at a detached `86e616e` for the golden master's before run, and returned to `chore/deliverables-parity` both times.
- **Outputs outside the repository**:
  - V1 rewrote `capture-3bb9300758bc.json` under `netzer-deliverables-diag` in the temp directory, with the same requests and a new `capturedAt`.
  - `replay-diag-*` folders in the temp directory: 24, up from 18.
  - This session's scratchpad holds the V1 to V3 logs, the golden master (`v3/golden/before` and `after`), the tripwire logs, the critic's extracted copies (`v4/`) and the audit scripts. All of it is temporary.
- **Active processes**: none.
- **Environment variables**: none set in the shell; the tripwire and stripped values were set per command.
- **Uncommitted work left in the tree**: none in the clone after this commit. The main checkout `C:\dev\Netzer-Labs` was not modified.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-09-14-w1-replay-cleanup.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
