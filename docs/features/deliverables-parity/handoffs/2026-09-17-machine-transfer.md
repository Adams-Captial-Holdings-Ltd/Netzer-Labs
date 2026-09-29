---
feature: deliverables-parity
document_role: session-handoff
status: current
observed_at: 2026-09-17
as_of_commit: cf0397f18b770ed522d22fc55039c132186a3b83
session_slug: machine-transfer
supersedes: 2026-09-14-w1-a12-spend-hardening.md
---

# Session handoff: machine transfer

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-17 |
| Feature folder | `docs/features/deliverables-parity/` |
| Branch worked on | `chore/deliverables-parity` in the normal clone `C:\dev\_netzer-diag`. `diag/prod-capture` was not touched |
| Branch it merges into next | `development`, and only with the user's approval |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `cf0397f18b770ed522d22fc55039c132186a3b83`, the A12 session close docs |
| Commit at session end | The commit that adds this log and updates the HANDOFF: a docs-only child of `cf0397f`, titled `docs(deliverables-parity): hand off for the machine transfer`. A file cannot name its own SHA, so read it with `git log -1` |
| Pushed | Not yet at the time of writing. The coordinator pushes this branch to origin under the same name immediately after this commit, as an owner-approved backup (no PR, no merge, no deploy). Confirm with `git ls-remote origin refs/heads/chore/deliverables-parity`. `diag/prod-capture` is never pushed |
| PR | none |
| Deployed | no |

## 2. Current state summary

The owner is moving Netzer development from this Windows 11 PC, whose C: drive is 99% full, to a new Windows PC and a Mac. This session records where the deliverables-parity campaign stands and where every piece of its state lives after the move. It changed no code and touched no AWS.

The campaign is in Gauntlet `DIRECT_COORDINATOR` / `EXECUTION`. W1 Step 0 is next, and it is owner-gated: it needs an AWS sign-in and the owner's explicit go. Step 2, the live replay, needs a separate approval for up to $30. Everything built so far is on `chore/deliverables-parity` (tip `cf0397f` before this commit) and on the local-only `diag/prod-capture` (`4cc8503a19e6d689ac4fae6079465b058a234a1c`, which is `origin/production` `de244e6` plus five overlay commits).

The campaign's own rule was never to push either branch: see the resume handoff's USER CONSTRAINTS (`~/.claude/plans/claude-bedrock-deliverables-handoff.md`, line 236) and [HANDOFF.md](../HANDOFF.md), line 24. On 2026-09-17 the owner overrode that rule for `chore/deliverables-parity` only, so it can be pushed as a backup with no PR. `diag/prod-capture` is still never pushed. It travels as a git bundle in the private devkit (`https://github.com/emmanuelmadams4-lgtm/netzer-devkit`, `bundles/diag-prod-capture.bundle`). Restore it with `git fetch <devkit>/bundles/diag-prod-capture.bundle diag/prod-capture:diag/prod-capture`, which keeps `4cc8503` and every overlay SHA the logs cite. Section 8 says where each non-git file goes, and Appendix A has the path map and the resume prompt.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **Where captures land.** `capture.diag.ts:186` writes to `resolve(process.env.DIAG_OUT_DIR || join(tmpdir(), 'netzer-deliverables-diag'))` and refuses a directory inside the repository (`:190`).
  - On this machine that default is `%TEMP%\netzer-deliverables-diag`, the path the resume handoff and the logs name.
  - On macOS `os.tmpdir()` is the per-user `$TMPDIR` under `/var/folders`, so the default is somewhere else. Set `DIAG_OUT_DIR` (P19).
  - `replay.ts` has no default capture path: it needs `--capture <capture.json>` (`replay.ts:726`), so a restored capture can be anywhere outside the clone.
- **What `diag/prod-capture` holds.** `de244e6` (production) -> `f7194c1` -> `51e85cb` -> `b62849e` -> `3bb9300` -> `4cc8503`. Each overlay copies `scripts/diagnostics/deliverables` from `chore/deliverables-parity`. P14 compares that folder between the two branches before any `--spend`.
- **The remote at the time of writing** (`git ls-remote`, 2026-09-17): `production` is `de244e6387efdba177d550d1fb82a6d60291309e` and `development` is `271339bc8b2feea85e6c31b115fdd34e757a72e2`, as on 2026-09-14. Neither `chore/deliverables-parity` nor `diag/prod-capture` exists on origin yet.
- **The campaign's non-git state** is listed, with its devkit destination, in section 8.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `~/.claude/plans/claude-bedrock-deliverables-handoff.md` | The fresh-session resume prompt for EXECUTION | Embedded verbatim in Appendix A. Line 236 carries the "never push either branch" rule this session records as overridden for one branch |
| `docs/features/deliverables-parity/HANDOFF.md:24` | "Never push it", about `diag/prod-capture` | Still true for that branch. The dated override note for `chore/deliverables-parity` sits next to it |
| `scripts/diagnostics/deliverables/capture.diag.ts:186` | The capture's output directory | Its default moves with the operating system (P19) |
| `scripts/diagnostics/deliverables/replay.ts:726` | `--capture` is required | A restored capture is passed by path |

### 3.3 Patterns and conventions to follow

- **Carry a local-only branch as a bundle, not a push.** `git bundle verify` the file, `git bundle list-heads` it, then `git fetch <bundle> diag/prod-capture:diag/prod-capture`. The fetch keeps the original SHAs, so every SHA in the logs still resolves.
- **Check copies by hash.** Section 8 records the sha256 of every capture and plan file on this machine. Compare after restore with `sha256sum`, not by size or by `git diff --no-index`.
- **Translate paths with Appendix A's map** before running any command from the resume handoff on another machine.

## 4. Work completed

### 4.1 Tasks finished

- [x] Baseline docs gates on `cf0397f` (section 7)
- [x] Inventory of the campaign's non-git state, with sha256 values for the captures and the six plan files (section 8)
- [x] This log: section 5 carried verbatim from the 2026-09-14 A12 log and appended, Appendix A with the path map and the resume prompt
- [x] `HANDOFF.md`: frontmatter, pushed state, the dated note next to "Never push it", the smallest next action and the session index
- [x] After-state docs gates (section 7)

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/deliverables-parity/handoffs/2026-09-17-machine-transfer.md` | New | The session record for the machine transfer |
| `docs/features/deliverables-parity/HANDOFF.md` | `observed_at` and `as_of_commit`; the commit list; a dated note on the push override; the pushed state; the transfer's docs gates; the smallest next action; this log at the top of the index | Current state after the transfer |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Push `chore/deliverables-parity` to origin under its own name as a backup: no PR, no merge, no deploy. The coordinator pushes it after this commit | Keep the campaign rule and carry the branch as a bundle too | The owner's call on 2026-09-17, overriding the resume handoff's line 236 and HANDOFF line 24 for this branch only. The branch deploys nothing (`chore/*`) and holds only the harness and docs |
| Keep `diag/prod-capture` unpushed and carry it as `bundles/diag-prod-capture.bundle` in the private devkit | Push it; rebuild it on the new machine from the overlay commits | The rule still holds for it. A rebuild would create new SHAs, and the logs cite `f7194c1`, `51e85cb`, `b62849e`, `3bb9300` and `4cc8503` |
| Carry the five captures in the private devkit (`archive/deliverables-captures/`) | Re-capture on the new machine | They hold the built-in agent prompt and tool specs, so they stay private (P11). Two of them are the baseline the logs compare against (`capture-f7194c157503.json`, `capture-3bb9300758bc.json`), and a re-capture changes `capturedAt` and `headSha` |
| Add no new mistake (M) entries | | This session found no new mistake. It added three precautions, two assumptions and three traps |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The campaign's non-git state (plans, captures, scratchpads, Codex rollouts, the `diag/prod-capture` bundle) lives in the private devkit repository | `docs/features/deliverables-parity/README.md`, as a pointer next to its evidence list | no. The transfer task allows only this log and the HANDOFF. Promote it when the devkit's README confirms the layout |
| The capture's default output directory follows `os.tmpdir()`, so it differs by operating system | Nowhere new: `capture.diag.ts:22-23` and `:186` already say so, and the code is the authority (P5) | not needed |

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
| P16 | When a Codex child writes code that records measurements, ask the critic which recorded field changes, and for which input. | On 2026-09-14/15 Codex build 1 passed its red contract while writing `maxTokens` into token fields. Only a critic asked about measurement integrity caught it (M12). |
| P17 | Answer "the tests are loose" with a mutation check. Plant each named wrong implementation, run the contract, and restore the bytes, verified by sha256. | Two critics named 13 loose clauses in all. Pinning them and planting nine mutations, 9 of 9 caught, gives executable evidence where a third critic would only give another opinion. |

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
| M12 | The A12 red contract (`936957a`) pinned the charges but not the recorded measurements. | Codex build 1 passed it while `usage?.outputTokens ?? maxTokens` wrote `maxTokens` into `CallRecord.outputTokens` and `specOutputTokens` for responses without usage. That would have inflated H1's spec sizes and hidden A11's 0-token signal. | Critic 1 caught it (C8). The contract now requires 0 tokens for unmetered calls (`86651b6`, `d06a379`), and the correction uses `maxTokens` only for charging (`5512279`). | A contract for a charging rule must also pin what the record measures. |

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
| A12 | The $30 cap bounds metered model spend, not the AWS bill. | **RESOLVED (`5512279`)**: R11 and R12 now charge guardrail units, failed attempts that are not request rejections, and responses without usage within the cap; A13 records what the allowance assumes. **Unverified in size.** `exchange()` charges returned usage, and only a stream that fails while being read is charged its worst case. Three costs escape the cap: guardrail evaluation, which Bedrock bills apart from tokens and `turnCost` does not price (`models.ts:152-166`); a non-streaming round whose response is lost after Bedrock accepted it, charged $0 (`replay.ts:472`); and A11's response without usage. A10's "a few cents" covers only a metered call's input shortfall. Settle it with the user before Step 2's go: see the 2026-09-14 verification log, section 6.3. |
| A13 | The replay's guardrail allowance, `ceil(requestChars / 1000) + ceil(outputTokens × 4 / 1000)` text units at $0.00025, bounds the real guardrail charge. | **Unverified.** The price assumes the deployed guardrail matches production's CDK (content and sensitive-information filters only), which Step 0 confirms. Counting the whole request JSON over-counts the guardrail's input text. 4 characters per output token is an assumption, so output that averages more could exceed the allowance by cents. The dry-run estimate also ignores charged retries, which can reach three worst cases per call. |

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
| **RESOLVED (`5512279`)**: a credential error now stops the campaign (R13). A `replay.ts --spend` campaign stops only for the budget. A credential or transport error marks that run `error` and the next run starts, so a sign-in that lapses mid-campaign (sessions last about 2 hours) leaves a tail of $0 error records. Check the session's age before `--spend`. | 2026-09-14 verification log, section 6.4 |
| Codex's `--json` event stream lives in a session scratchpad and disappears with it. `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` survives: `turn_context` holds the model, effort and sandbox policy, and each command sits in an `exec` custom tool call's arguments. | 2026-09-14 verification log, section 3.3 |
| A backgrounded `npm test` here died after about six minutes with tinypool's `Error: Worker exited unexpectedly` and printed no summary. The foreground re-run finished in 158 s with the recorded baseline. The cause was not established; re-run before reading a missing summary as a result. | 2026-09-14 A12 log (this file), section 7 |
| In `codex exec --json` output, an `item.completed` of type `error` reading "Exceeded skills context budget" is a warning, not a failure. The sandbox here has no `rg` on PATH. A 72-line change to `replay.ts` cost 1.0M input tokens (957K cached) and 5.7K output tokens. | 2026-09-14 A12 log (this file), section 7 |

### Added 2026-09-17 (machine transfer)

Appended by the 2026-09-17 machine-transfer session. The IDs continue the tables above.

| # | Precaution | Why it exists |
|---|---|---|
| P18 | Never push `diag/prod-capture`. It travels only as a git bundle, devkit `bundles/diag-prod-capture.bundle`. Restore it with `git fetch <devkit>/bundles/diag-prod-capture.bundle diag/prod-capture:diag/prod-capture`, and check that `git rev-parse diag/prod-capture` prints `4cc8503a19e6d689ac4fae6079465b058a234a1c` before P14. | The campaign's rule was never to push either branch (resume handoff line 236, HANDOFF line 24). On 2026-09-17 the owner overrode it for `chore/deliverables-parity` only, as a backup. A bundle keeps `4cc8503` and every overlay SHA the logs cite; a rebuild would not. |
| P19 | On any machine other than the original Windows PC, set `DIAG_OUT_DIR` to a lasting directory outside the clone before a capture, and pass `replay.ts --capture` the restored file's full path. | `capture.diag.ts:186` defaults to `join(os.tmpdir(), 'netzer-deliverables-diag')`. The logs name `%TEMP%\netzer-deliverables-diag`. On macOS `os.tmpdir()` is a per-user folder under `/var/folders` that the system may clear. |
| P20 | Keep captures, prompt exports and replay records in the private devkit (`archive/deliverables-captures/`) or in a local directory outside the clone. Never put them on a Netzer-Labs branch, the backup push included. | They hold the built-in agent prompt and tool specs (P11). Once `chore/deliverables-parity` is on origin, anyone with access to the Netzer-Labs repository can read it, a wider audience than the owner's private devkit. |

| # | Assumption | Confidence and caveat |
|---|---|---|
| A14 | The 2026-09-17 push of `chore/deliverables-parity` is a backup only. It approves no PR, no merge into `development` and no deploy, and it does not relax P18. | The owner's instruction for the machine transfer, relayed by the transfer coordinator. A merge still needs the user's approval. |
| A15 | The five captures in devkit `archive/deliverables-captures/` are byte-identical to the `%TEMP%\netzer-deliverables-diag` originals, whose sha256 values are in section 8 of the 2026-09-17 log. | **Unverified by that session**: the devkit is built after its commit. Compare with `sha256sum` after restoring, before using a capture. |

| Trap | Where the detail lives |
|---|---|
| The resume handoff and these logs name Windows paths (`C:\dev\_netzer-diag`, `C:\Users\EmmanuelAdams\...`, `%TEMP%`) and Windows-only tooling: `MSYS_NO_PATHCONV`, Git Bash's `fork` error, the PowerShell tool's cmdlet refusal, `core.autocrlf=true`, `codex.exe` under AppData, and graft indexing `C:\dev\Netzer-Labs`. Translate them before running anything on macOS. | 2026-09-17 log, Appendix A |
| The two Downloads files the logs cite, `claude-bedrock-deliverables-handoff.md` (pre-A12) and the verification log copy, were no longer in `C:\Users\EmmanuelAdams\Downloads` when the 2026-09-17 session listed it. The transfer's inventory had found them earlier that day. The pre-A12 handoff is carried as devkit `archive/handoffs-raw/claude-bedrock-deliverables-handoff.pre-A12.md`, and the committed verification log is the authority for the other. | 2026-09-17 log, section 8 |
| The resume handoff's pre-flight expects the clone "at cf0397f". After the 2026-09-17 session the branch tip is that session's commit, a docs-only child of `cf0397f`. Check that `git diff --stat cf0397f HEAD` lists only files under `docs/features/deliverables-parity/`. | 2026-09-17 log, section 6.2 |

## 6. Pending work

### 6.1 Smallest next action

When the owner has signed in to AWS and says go, start W1 Step 0 from `~/.claude/plans/claude-bedrock-deliverables-handoff.md` (embedded in Appendix A). Do not start it without both. On a new machine, restore first (step 1 below).

### 6.2 Immediate next steps

1. On the new machine, restore with Appendix A, then check before anything touches AWS:
   - `git rev-parse chore/deliverables-parity` is this log's commit, and `git diff --stat cf0397f chore/deliverables-parity` lists only `docs/features/deliverables-parity/` files. The resume handoff's pre-flight says "at cf0397f"; read it as "at this docs-only child of cf0397f".
   - `git rev-parse diag/prod-capture` prints `4cc8503a19e6d689ac4fae6079465b058a234a1c`, and the P14 diff prints nothing.
   - The captures' sha256 values match section 8, and `DIAG_OUT_DIR` points outside the clone (P19).
   - Dependencies are installed with `npm ci`. It is not an install-runbook task: do not run `npm run up` (5.4, the `AGENTS.md` trap).
2. Step 0, read-only, each item with the owner's approval, as the resume handoff lists it:
   - Logs Insights Q1–Q6 and the `claudeclaw-token-usage` table;
   - the `agents/*/CLAUDE.md` listing and the incident agent's file, fetched outside the clone;
   - the raw-bucket listing;
   - production's guardrail id, version and policies, which confirm A13's price;
   - the orchestrator task definition's tool gates, read by container name;
   - production's MCP server config.
3. Re-capture on `diag/prod-capture` with `DIAG_AGENT_PROMPT_FILE`, the gates and `DIAG_OUT_DIR` outside the clone. Export the prompts for System A.
4. Step 2 only on the owner's explicit go, which is a separate approval for up to $30. Run it from `diag/prod-capture` once the P14 diff prints nothing, re-run the dry run first, and check the sign-in's age.
5. Step 3 only with its own approval, which must state that System A runs Sonnet 5 and the replay Sonnet 4.6.

### 6.3 Blockers and open questions

Carried from the [2026-09-14 A12 log](2026-09-14-w1-a12-spend-hardening.md#63-blockers-and-open-questions), unchanged:

- [ ] Blocker: Step 0 — needs: an AWS sign-in (the root `default` profile; sessions last about 2 hours) and the user's go.
- [ ] Blocker: 3–5 production failures from before and after 2026-08-24 — needs: the user.
- [ ] Blocker: System A's files for the exported prompts — needs: the user, once the prompts are exported.
- [ ] Blocker: Step 2 spend of up to $30, and the Step 3 judge — needs: two separate approvals.
- [ ] Question: the incident's exact prompt wording — suggested resolution: the user supplies it, or Step 0 reads the `'agent turn started'` log line.
- [ ] Question: H3 compares different models — suggested resolution: state it in the judge's approval.
- [ ] Question: does production enable the web search, email, Nova Canvas or MCP tools? — suggested resolution: Step 0.
- [ ] Gap reports 1 and 2 from the [2026-09-11 log](2026-09-11-w1-harness-specification.md#63-blockers-and-open-questions): still drafted, not applied.
- [ ] Question: does the deployed guardrail match production's CDK policies? — suggested resolution: Step 0 reads it. If it has other priced policies, raise the allowance's price before Step 2 (A13).

Added by this session:

- [ ] Blocker for work on a new machine: the backup push and the devkit — needs: the coordinator to push `chore/deliverables-parity` (check with `git ls-remote origin refs/heads/chore/deliverables-parity`) and to publish the devkit with `bundles/diag-prod-capture.bundle`, `archive/deliverables-captures/` and `claude/plans/`.

### 6.4 Deferred, and why

- Everything in the [A12 log's section 6.4](2026-09-14-w1-a12-spend-hardening.md#64-deferred-and-why), unchanged. This session built nothing.
- A devkit pointer in the feature README (section 4.4): deferred because the transfer task allows only this log and the HANDOFF, and the devkit's layout is confirmed only once it is built.
- Updating the resume handoff in `~/.claude/plans` for the new tip and the push override: deferred because it lives outside the repository and the transfer copies it byte for byte. Section 6.2 and P18 carry the corrections instead.

## 7. Verification actually performed

This session changed only documentation. Every command below ran in `C:\dev\_netzer-diag`.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | not run | not run |
| `npm test` | not run | not run |
| `npm run build` | not run | not run |
| `npm --prefix web run typecheck` | not run | not run |
| `npm --prefix web run build` | not run | not run |
| `npm run local:test:integration` | not run | not run |
| `node scripts/ci/docs-links.mjs` | At `cf0397f`: OK, 143 markdown files, 1833 internal links, 72 external links skipped | OK with this log and the HANDOFF in place: 144 markdown files, 1867 internal links, 72 external links skipped |
| `node scripts/ci/feature-knowledge.mjs` | At `cf0397f`: OK | OK with this log and the HANDOFF in place |
| `git diff --check` | Clean tree at `cf0397f` (`git status --short` printed nothing) | Clean: `git diff --check` over the unstaged HANDOFF, then `git diff --cached --check` over both staged files (exit 0 each) |
| `git ls-remote origin refs/heads/chore/deliverables-parity refs/heads/diag/prod-capture refs/heads/production refs/heads/development` | Exit 0. `development` `271339bc8b2feea85e6c31b115fdd34e757a72e2`, `production` `de244e6387efdba177d550d1fb82a6d60291309e`; neither campaign branch on origin | not re-run |
| `git rev-parse diag/prod-capture chore/deliverables-parity origin/production` | `4cc8503a19e6d689ac4fae6079465b058a234a1c`, `cf0397f18b770ed522d22fc55039c132186a3b83`, `de244e6387efdba177d550d1fb82a6d60291309e` | `diag/prod-capture` unchanged: `4cc8503a19e6d689ac4fae6079465b058a234a1c` |
| `sha256sum` over the captures and the six plan files | Section 8 | not re-run |
| `git ls-files --eol docs/features/deliverables-parity/` | Every file `i/lf`. `HANDOFF.md` and the A12 log are also `w/lf`; the other five are `w/crlf` | Both changed files staged as `i/lf w/lf`; Git warns that the working copies would become CRLF the next time it touches them |
| Section 5 check: the body between the `## 5.` and `## 6.` headings compared with the A12 log's, by script | not applicable | Identical: the carried 21,290 bytes match the A12 log's section 5 (read from `HEAD`) byte for byte, followed by the 3,579-byte "Added 2026-09-17 (machine transfer)" block. The output has no CR bytes |
| Appendix A check: the fenced resume prompt compared with `~/.claude/plans/claude-bedrock-deliverables-handoff.md`, by script | not applicable | Identical: 17,679 bytes. The plan has no run of five backticks, so the five-backtick fence cannot close early |
| Staged diff searched for `AKIA`, `ghs_`, `ghp_`, `github_pat_`, `xox`, `sk-ant`, `BEGIN PRIVATE` and base64 runs of 40 or more characters | not applicable | No secret. The only keyword hit is this row, which names the patterns. Every run of 40 or more characters is a git SHA, a sha256 value, a file path or a file name |

Anything not run, and why:
- `npm run typecheck`, `npm test`, the build commands and `npm run local:test:integration`: this session changed only two Markdown files. The last full run, at `5512279` with the A12 close docs, is in the [A12 log's section 7](2026-09-14-w1-a12-spend-hardening.md#7-verification-actually-performed).
- The replay contract and the diagnostic suite: no harness file changed.
- The devkit copies: the devkit is built after this commit, so this session could not check them (A15).

## 8. Environment state

- **Tools and services**: Node 24.19.0; Git 2.55.0.windows.3 with `core.autocrlf=true` from the system gitconfig. C: had about 2.6 GB free.
- **Branches in the clone**:
  - `chore/deliverables-parity`: `cf0397f`, then this session's commit. Pushed: not yet at the time of writing; the coordinator pushes this branch to origin under the same name immediately after this commit as an owner-approved backup (no PR, no merge, no deploy). Confirm with `git ls-remote origin refs/heads/chore/deliverables-parity`.
  - `diag/prod-capture`: `4cc8503a19e6d689ac4fae6079465b058a234a1c`, local only, not touched. Never pushed; carried as devkit `bundles/diag-prod-capture.bundle`.
  - `fix/knowledge-scope-fanout`: untouched.
- **Where the non-git state goes** (the devkit is `https://github.com/emmanuelmadams4-lgtm/netzer-devkit`, private, built after this commit):

| On this machine | In the devkit | What it is |
|---|---|---|
| `C:\Users\EmmanuelAdams\.claude\plans\claude-bedrock-deliverables-handoff.md` (17,679 bytes, LF) | `claude/plans/claude-bedrock-deliverables-handoff.md` | The EXECUTION resume prompt, embedded in Appendix A |
| `C:\Users\EmmanuelAdams\.claude\plans\claude-bedrock-deliverables-wobbly-heron.md` | `claude/plans/claude-bedrock-deliverables-wobbly-heron.md` | The approved round-1 plan |
| `C:\Users\EmmanuelAdams\.claude\plans\gauntlet-mode-direct-coordinator-gauntle-clever-quokka.md` | `claude/plans/gauntlet-mode-direct-coordinator-gauntle-clever-quokka.md` | SPECIFICATION phase plan |
| `C:\Users\EmmanuelAdams\.claude\plans\c-users-emmanueladams-downloads-claude-indexed-clover.md` | `claude/plans/c-users-emmanueladams-downloads-claude-indexed-clover.md` | IMPLEMENTATION phase plan |
| `C:\Users\EmmanuelAdams\.claude\plans\c-users-emmanueladams-downloads-claude-rosy-steele.md` | `claude/plans/c-users-emmanueladams-downloads-claude-rosy-steele.md` | CLEANUP phase plan |
| `C:\Users\EmmanuelAdams\.claude\plans\c-users-emmanueladams-downloads-2026-09-mossy-breeze.md` | `claude/plans/c-users-emmanueladams-downloads-2026-09-mossy-breeze.md` | A12 plan |
| `%TEMP%\netzer-deliverables-diag\capture-*.json`, five files | `archive/deliverables-captures/` | The captures. They hold the built-in agent prompt and tool specs, so they are private (P11, P20) |
| `C:\Users\EmmanuelAdams\Downloads\claude-bedrock-deliverables-handoff.md` (14,466 bytes, 2026-09-14 15:11, per the transfer inventory) | `archive/handoffs-raw/claude-bedrock-deliverables-handoff.pre-A12.md` | The resume handoff as it stood before the A12 session; superseded |
| `C:\Users\EmmanuelAdams\Downloads\2026-09-14-w1-harness-verification.md` (42,519 bytes, per the transfer inventory) | nothing extra: the committed log is the authority | The transfer inventory found it byte-identical to the committed file, whose blob is also 42,519 bytes |
| Scratchpad `fc88b1bc-6b85-4e8e-a8c4-42f6338a9cc9` (1.2 MB, files dated 2026-09-11 and 2026-09-13) | `archive/scratch/fc88b1bc-6b85-4e8e-a8c4-42f6338a9cc9/` | By its contents, the SPECIFICATION evidence: baseline, capture and red-contract logs |
| Scratchpad `0e7988ec-7d2a-4db6-b369-f7163d92f768` (384 KB, 2026-09-14) | `archive/scratch/0e7988ec-7d2a-4db6-b369-f7163d92f768/` | By its contents, the IMPLEMENTATION evidence, including `export-prompts.mts` and the dry runs |
| Scratchpad `b364b214-a956-4258-acb3-0dfd800977ad` (557 KB, 2026-09-14) | `archive/scratch/b364b214-a956-4258-acb3-0dfd800977ad/` | By its contents, the CLEANUP evidence: the Codex work order and runner, the golden master |
| Scratchpad `9bd78365-321e-49f3-80e0-0990b5a8aca7` (1.3 MB, 2026-09-14) | `archive/scratch/9bd78365-321e-49f3-80e0-0990b5a8aca7/` | By its contents, the VERIFICATION evidence (`v1` to `v6`) |
| Scratchpad `69bb827e-7138-4558-ad0b-d995e99db222` (1.4 MB, 2026-09-14 and 2026-09-15) | `archive/scratch/69bb827e-7138-4558-ad0b-d995e99db222/` | The A12 evidence (`a12/`): CLI golden masters, Codex runs, critic briefs, mutation logs |
| `C:\Users\EmmanuelAdams\.codex\sessions\2026\09\14\` and `\15\`, including `rollout-2026-09-14T23-22-27-01a0a316-5cb9-7231-82ba-525fa3bc0d2f.jsonl` (A12 build 1) and `rollout-2026-09-14T23-55-34-01a0a334-b18c-70b0-8268-bbca7e47d04f.jsonl` (A12 correction 1) | `codex/sessions/2026/09/14/`, `codex/sessions/2026/09/15/` | Codex rollouts |
| Branch `diag/prod-capture` | `bundles/diag-prod-capture.bundle` | Restore with P18 |

- **sha256 on this machine, 2026-09-17**:
  - `capture-1a29a40d8a05.json` `1530e1dbacc72749deed4e666e29c7896553bad2563b87bcbc03cbc3b92ccdd3`
  - `capture-3bb9300758bc.json` `95e7e5a6592e9b06679ce392be46ba38e3f6095bb8585ba37551eccd456f078e`
  - `capture-4cc8503a19e6.json` `e5ce269a80f87a8839477b43440e3d51049a2324ff97daf205f26c297d2e8c9c`
  - `capture-b62849e484ca.json` `97885f0b544481dce89b735504abdb406e0e12cb474fe6115f5da8c55ea0cc76`
  - `capture-f7194c157503.json` `607d767b44b7969f90425aebd8aa3efafc6d34d65bd5c1b9bad798e7061ca43b`
  - `claude-bedrock-deliverables-handoff.md` `f7e6210365163d42b945d7304038d3b5201f2b89eeda6e79e6c63ca03962b66c`
  - `claude-bedrock-deliverables-wobbly-heron.md` `1ad0d368f9c441dfba845a9c534852fbf47319ccff5e964a4e90db2ae3905456`
  - `gauntlet-mode-direct-coordinator-gauntle-clever-quokka.md` `afbb64a8519d5949c915e1cdbb5c2c1af5dcacb55189bea5c7bf09bc776cea3d`
  - `c-users-emmanueladams-downloads-claude-indexed-clover.md` `be491df9070cc62f33963e68116fe7ef6765443efc6ccc81e209a3753c81c2d8`
  - `c-users-emmanueladams-downloads-claude-rosy-steele.md` `719ed7722e712bc2c2acc3145682296b00a713c28e3b06fbdfd492cbed5b63ca`
  - `c-users-emmanueladams-downloads-2026-09-mossy-breeze.md` `13b078c14268a7bc743ca256ed63fd1d6bb6d8df058d0e86af7a403dd9f63594`
- **Not found**: the two Downloads files above were not in `C:\Users\EmmanuelAdams\Downloads` when this session listed it, so their sizes and the equality come from the transfer inventory, not from this session.
- **Active processes**: none.
- **Environment variables**: none set.
- **Uncommitted work left in the tree**: none after this session's commit. The main checkout `C:\dev\Netzer-Labs` was not modified.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-09-14-w1-a12-spend-hardening.md)
- [W1 harness verification log](./2026-09-14-w1-harness-verification.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)

## Appendix A - Resume on a new machine

### A.1 Path map

| On this Windows PC | On a new machine | Source |
|---|---|---|
| `C:\Users\EmmanuelAdams\.claude\plans\<file>`: the six plan files in section 8 | `~/.claude/plans/<file>`, after running the devkit restore | devkit `claude/plans/<file>` |
| `C:\Users\EmmanuelAdams\.claude\gauntlet\<campaign>` | `~/.claude/gauntlet/<campaign>` | devkit `claude/gauntlet/<campaign>/`. This campaign has no gauntlet folder; its state is the plans and this feature folder |
| `C:\dev\_netzer-diag` | `<dev-root>/_netzer-diag`: a fresh clone of origin with `chore/deliverables-parity` checked out | origin (after the backup push), plus devkit `bundles/diag-prod-capture.bundle` for `diag/prod-capture` |
| `C:\dev\Netzer-Labs`, the main checkout that graft indexes | `<dev-root>/Netzer-Labs` | a fresh clone of origin |
| `%TEMP%\netzer-deliverables-diag\capture-*.json` | a directory outside the clone, exported as `DIAG_OUT_DIR` (P19) | devkit `archive/deliverables-captures/` |
| `%TEMP%\claude\C--dev-Netzer-Labs\<session-id>\scratchpad` for `fc88b1bc`, `0e7988ec`, `b364b214`, `9bd78365` and `69bb827e` | read-only reference | devkit `archive/scratch/<session-id>/` |
| `C:\Users\EmmanuelAdams\Downloads\claude-bedrock-deliverables-handoff.md`, which the resume handoff cites | read-only reference | devkit `archive/handoffs-raw/claude-bedrock-deliverables-handoff.pre-A12.md` |
| `C:\Users\EmmanuelAdams\.codex\sessions\2026\09\14\` and `\15\` | read-only reference | devkit `codex/sessions/2026/09/14/` and `codex/sessions/2026/09/15/` |
| `codex.exe` under `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>` | the `codex` CLI on PATH; pass its absolute path to `--cli` | the new machine's install. The resume handoff sets `CODEX_IN_EXECUTION: OFF` |
| `-c windows.sandbox="elevated"` | drop it on macOS | not applicable |
| `cygpath`, `MSYS_NO_PATHCONV`, the PowerShell 5.1 notes, `core.autocrlf=true` | Windows and Git Bash only | not applicable |
| Docker | On Apple Silicon, Docker builds arm64 natively and amd64 under emulation | not applicable |
| The owner's AWS sign-in (A6) | the owner configures the AWS CLI and signs in on the new machine | never in the devkit |

Restore the clone, from a POSIX shell, after the devkit restore and the backup push:

```bash
DEV=<dev-root>
DEVKIT=<path to the netzer-devkit clone>
git clone https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs.git "$DEV/_netzer-diag"
cd "$DEV/_netzer-diag"
git switch chore/deliverables-parity
git diff --stat cf0397f HEAD   # only docs/features/deliverables-parity/
git bundle verify "$DEVKIT/bundles/diag-prod-capture.bundle"
git fetch "$DEVKIT/bundles/diag-prod-capture.bundle" diag/prod-capture:diag/prod-capture
git rev-parse diag/prod-capture   # 4cc8503a19e6d689ac4fae6079465b058a234a1c
git diff --quiet chore/deliverables-parity diag/prod-capture -- scripts/diagnostics/deliverables && echo "P14 diff empty"
export DIAG_OUT_DIR="$HOME/netzer-deliverables-diag"   # outside the clone (P19)
mkdir -p "$DIAG_OUT_DIR"
cp "$DEVKIT"/archive/deliverables-captures/capture-*.json "$DIAG_OUT_DIR"/
(cd "$DIAG_OUT_DIR" && shasum -a 256 capture-*.json)   # compare with section 8; sha256sum on Linux or Git Bash
```

On the new Windows PC, run the same commands in Git Bash, and set `DIAG_OUT_DIR` anyway, so the path is explicit.

### A.2 The resume prompt

The fresh-session resume prompt for this campaign is `~/.claude/plans/claude-bedrock-deliverables-handoff.md`, carried as devkit `claude/plans/claude-bedrock-deliverables-handoff.md` (sha256 `f7e6210365163d42b945d7304038d3b5201f2b89eeda6e79e6c63ca03962b66c`). It is embedded verbatim below. Read it with these corrections, which sit outside it:

- Its "never push either branch" (line 236) now holds for `diag/prod-capture` only (P18, A14).
- Its "at cf0397f" pre-flight means this session's docs-only child of `cf0397f` (section 6.2).
- Its Windows paths translate with A.1.

It cites these plans by their Windows paths. Their devkit paths are:

- the approved round-1 plan: `claude/plans/claude-bedrock-deliverables-wobbly-heron.md`;
- SPECIFICATION: `claude/plans/gauntlet-mode-direct-coordinator-gauntle-clever-quokka.md`;
- IMPLEMENTATION: `claude/plans/c-users-emmanueladams-downloads-claude-indexed-clover.md`;
- CLEANUP: `claude/plans/c-users-emmanueladams-downloads-claude-rosy-steele.md`;
- A12: `claude/plans/c-users-emmanueladams-downloads-2026-09-mossy-breeze.md`.

`````text
GAUNTLET_MODE: DIRECT_COORDINATOR
GAUNTLET_PHASE: EXECUTION

This is a Gauntlet Loop handoff for a fresh session.

Before doing substantive work, load/re-read the gauntlet-loop skill.
The mode and phase markers are authoritative.
Do not generate another generic Gauntlet prompt.
Do not restart completed phases:
- PLAN was approved on 2026-09-10.
- SPECIFICATION finished on 2026-09-13.
- IMPLEMENTATION and CLEANUP finished on 2026-09-14.
- VERIFICATION of the W1 harness PASSED on 2026-09-14. Do not re-run it.
- The A12 spend hardening (R11-R13) was specified, built by Codex gpt-5.6-luna, and verified on 2026-09-14/15
  (chore 5512279, close docs cf0397f). Do not re-run it.
Do not rely on prior conversation context.
Restore state from this handoff and execute only the named phase.

EXECUTION is not a code phase.
- It is the approved round-1 plan's §8 "Execution after approval", steps 5 to 9: Step 0, Step 2, Step 3,
  record the results, and propose round 2.
- The user gates every step that touches AWS or spends money, one step at a time.
- This session does not make code changes. If one is needed, emit a fresh DIRECT_COORDINATOR / SPECIFICATION
  handoff with the evidence and stop.

GOAL
Find, with measurements rather than prompt tuning, which layers make Netzar OS (Claude on AWS Bedrock) do
worse than the Claude app on:
- PPTX/XLSX/DOCX/PDF deliverables;
- handling uploads;
- editing existing files;
- "context limits".

APPROVED PLAN
- Round-1 plan: C:\Users\EmmanuelAdams\.claude\plans\claude-bedrock-deliverables-wobbly-heron.md
  (§2 root causes, §3 matrix, §4 experiment and queries Q1-Q6, §5 asks, §6 tracker, §8 execution order).
- Phase plans:
  - SPECIFICATION: C:\Users\EmmanuelAdams\.claude\plans\gauntlet-mode-direct-coordinator-gauntle-clever-quokka.md
  - IMPLEMENTATION: C:\Users\EmmanuelAdams\.claude\plans\c-users-emmanueladams-downloads-claude-indexed-clover.md
  - CLEANUP: C:\Users\EmmanuelAdams\.claude\plans\c-users-emmanueladams-downloads-claude-rosy-steele.md
  - A12 (specification, Codex build and review in one session, at the user's request):
    C:\Users\EmmanuelAdams\.claude\plans\c-users-emmanueladams-downloads-2026-09-mossy-breeze.md
- Repo record, in the clone: docs/features/deliverables-parity/ (README, HANDOFF, handoffs/).
  Read these first:
  - handoffs/2026-09-14-w1-a12-spend-hardening.md, sections 2, 6 and 5;
  - then the README.
- The frozen design is executable: scripts/diagnostics/deliverables/replay.diag.ts is its contract, and replay.ts's header
  docblock describes it. C:\Users\EmmanuelAdams\Downloads\claude-bedrock-deliverables-handoff.md is this handoff as it
  stood before the A12 session (byte-identical then), not the VERIFICATION handoff.

BAR
- System A: the Claude app (claude.ai or Desktop) with code execution and file creation, on Sonnet 5 (user-confirmed).
- Executable gates for every run: the spec validates, the builder returns bytes, the file reopens, stopReason is recorded.
- Subjective: a blind, order-swapped pairwise judge against System A's files. It needs its own approval.
- System B: Netzar production, both before and after the 2026-08-24 hotfix (user-confirmed).

ACCEPTANCE CRITERIA (E1)
- H1, 8192 binds in production:
  - CONFIRMED if P's success rate is >=15 points below U's, or U's p90 spec is >7k tokens.
  - REJECTED if P is within 10 points of U and U's p90 is <6k.
- H2, S explains the older failures: S's success rate is >=50 points below P's.
- H3, remaining gap: if U loses >=75% of blind pairs, run E2 and E3 next; if <=55%, budget plus builders were the
  main cause.
- H4, silent truncation: prompt 4 under S ends at max_tokens with text in >=80% of runs.
- H5, latency: p90 turn latency at U is >120 s.
- Count a run whose forced synthesis fails (status error on the last call, empty reply) as a user-visible failure:
  production shows "(no response)" there (agent-loop.ts:1130-1142).

CURRENT WORK ITEM
W1 = Step 0 telemetry + E1 output-budget ablation:
- profiles S = 1024/8192, P = 8192/8192 control, U = 32000/32000;
- us.anthropic.claude-sonnet-4-6, no fallback;
- 5 prompts x 5 runs; hard cap $30.

THIS PHASE: EXECUTION, starting with Step 0
- Pre-flight, before anything touches AWS:
  - The user has signed in and said go for Step 0 in this session. Without both, stop and ask.
  - Only after that go: aws sts get-caller-identity. A session lasts about 2 hours; re-check before each AWS step.
  - The clone is clean on chore/deliverables-parity at cf0397f, and diag/prod-capture is at 4cc8503.
- Step 0, read-only. Get the user's approval for each item:
  - Logs Insights Q1-Q6 (plan §4) on /claudeclaw/orchestrator, and the claudeclaw-token-usage table.
  - The agents/*/CLAUDE.md listing. Fetch the incident agent's file to a path outside the repo for
    DIAG_AGENT_PROMPT_FILE.
  - The raw-bucket listing.
  - Production's guardrail id and version, and which policies that guardrail uses. They confirm A13:
    - the replay's allowance assumes production's CDK policies, content and sensitive-information filters, at $0.00025
      per text unit;
    - if the deployed guardrail has other priced policies, route the price change through a fresh SPECIFICATION before
      Step 2.
  - The running orchestrator task definition's container environment, read by container NAME, for the web search,
    email and Nova Canvas gates.
  - NEW: production's MCP server config (runtime-config table, category mcp, key servers).
    - The capture mocks MCP to return no tools (capture.diag.ts:124-129).
    - If production has MCP tools, a faithful re-capture needs a harness change: fresh SPECIFICATION.
- Then, in order:
  1. A12 is settled: the user chose to build it, and it was built and verified on 2026-09-15 (SPEND BOUNDARY below).
     Only A13's guardrail price remains to confirm, against Step 0's reading.
  2. Re-capture on diag/prod-capture with DIAG_AGENT_PROMPT_FILE and the gates, with DIAG_OUT_DIR outside the repo.
  3. Export the prompts for System A (the 2026-09-14 implementation log, §3.3 script) to a directory outside the repo.
  4. Step 2, only on the user's explicit go, capped at $30:
     - Run from diag/prod-capture (P14), after git diff chore/deliverables-parity diag/prod-capture --
       scripts/diagnostics/deliverables prints nothing.
     - Use a fresh --out directory outside the repo, and exactly one of --guardrail <id:version> or --no-guardrail.
     - Re-run the dry run first and check the sign-in's age. With --guardrail, its worst case now includes the
       allowance: $229.34 for `gr-diag:1` on capture-f7194c157503.json. A longer real id adds a few characters.
  5. Step 3 judge, only with its own approval, which must state that System A runs Sonnet 5 while the replay pins
     Sonnet 4.6.
  6. Record the results against H1-H5 in a session log, propose round 2, and stop.

AUTHORSHIP
- IMPLEMENTATION_AUTHOR: CLAUDE.
- CLEANUP_AUTHOR: CODEX (gpt-5.6-luna) wrote the three edits at the user's request; CLAUDE chose and checked them.
- VERIFICATION: a fresh Claude (Opus) coordinator plus an independent Opus critic. It authored neither phase.
- A12, 2026-09-14/15, in one session at the user's request:
  - SPECIFICATION: CLAUDE (936957a, 86651b6, d06a379);
  - IMPLEMENTATION_AUTHOR: CODEX gpt-5.6-luna, one build and one correction, in 5512279 (CLAUDE fixed two comments);
  - review: two fresh Opus critics, plus a CLAUDE mutation check (9 of 9).

BASELINE
- Normal clone C:\dev\_netzer-diag; origin = GitHub.
- On 2026-09-14, git ls-remote showed production de244e6387efdba177d550d1fb82a6d60291309e and development
  271339bc8b2feea85e6c31b115fdd34e757a72e2, unchanged since the 2026-09-13 fetch.
- 1abba67, d828124, 1124118 and 8c14b3f are on production and not on development.
- chore/deliverables-parity, never pushed:
  271339b -> 1a29a40 -> b1e2a19 -> bc462df -> 2af1e4f -> d91efaf -> 86e616e -> 6f4e09e (replay cleanup) ->
  b65f528 (cleanup close) -> f6410d9 (verification close, docs only) ->
  936957a -> 86651b6 -> d06a379 (A12 contract) -> 5512279 (A12 implementation) -> cf0397f (A12 close, docs only).
- diag/prod-capture (LOCAL ONLY, never push): de244e6 -> f7194c1 -> 51e85cb -> b62849e -> 3bb9300 -> 4cc8503.
  Its harness is identical to 5512279's.
- npm test with every AWS credential source stripped, identical at 271339b, 2af1e4f, d91efaf, 6f4e09e, b65f528, f6410d9
  and 5512279:
  - Test Files 5 failed | 238 passed | 1 skipped (244); Tests 1 failed | 3108 passed | 6 skipped (3115).
  - The five: 4 shebang collection failures (scripts/ci/docs-links.test.ts, scripts/ci/feature-knowledge.test.ts,
    scripts/ci/runnable-blocks.test.ts, scripts/release/sync-deprecations.test.ts) and
    scripts/lib/lifecycle/rollback-classes.test.ts (1 assertion).
  - durability.repro passed 7/7. typecheck clean.
- Captures: %TEMP%\netzer-deliverables-diag\capture-f7194c157503.json and capture-3bb9300758bc.json; the A12 overlay run
  also wrote capture-4cc8503a19e6.json.
  - The first two have identical requests. The third was not compared.
  - The first two carry the built-in agent prompt, no add-on gates beyond RAW_BUCKET, and no MCP tools.

VERIFICATION RESULT (2026-09-14; evidence in the verification log §7)
- V1: 15/15 on 3bb9300. Contract files unchanged since bc462df.
- V2: typecheck clean; npm test = baseline; feature-knowledge and docs-links OK; diff --check clean; replay contract on
  chore 13/13.
- V3:
  - The dry run holds: 75 runs, $210.76 worst case, re-derived by hand from production's price table.
  - Seven refusals plus two --spend variants all exit before prepareEnv. A positive control stops at prepareEnv.
  - A trailing-colon ARN proves the last-colon split. The export sha256 values are unchanged.
  - The network tripwire saw 0 connects.
  - The golden master is byte-identical at 86e616e and 6f4e09e.
- V4: J1-J3, F1-F13, A1-A5, A7 and A8 PASS against origin/production. A6's "ends" wording was corrected (M11):
  p3 has the sentence before its CSV block.
- V5: docs and harness only; no product code; nothing pushed (local refs and GitHub); no outputs inside the clone.
- V6: every §7 claim in the cleanup log reproduced.

A12 RESULT (2026-09-15; evidence in the A12 session log §7)
- The contract passes 16/16 on chore at 5512279, and the diagnostic suite 18/18 on diag/prod-capture 4cc8503. The P14
  diff is empty.
- npm test matches the baseline, typecheck is clean, and feature-knowledge and docs-links pass (143 files, 1833 links).
- CLI golden master, behind P12 and a network tripwire:
  - 13 of 16 cases byte-identical to 936957a;
  - the three guardrail plans print the hand-derived allowance ($229.34 and $229.38);
  - 0 connects.
- Critic 1: FAIL on C4 (loose tests) and C8 (fabricated token counts). The contract was tightened, and Codex made one
  correction.
- Critic 2: PASS on every rule (C1-C3, C5-C9), FAIL on C4. Nine clauses were pinned, and a mutation check caught 9 of 9.

SPEND BOUNDARY (verified; keep)
- replay.ts is a dry run unless all three hold: --spend, --out outside the repo, and exactly one guardrail choice.
  - Refusals print their own messages before prepareEnv.
  - prepareEnv deletes AWS_ENDPOINT_URL and refuses AWS_ACCESS_KEY_ID=local.
- Admission runs before every attempt, retries included (A12, 5512279):
  - spent + worstCase <= $30.
    - worstCase = turnCost(sonnet, 0, maxTokens, 0, ceil(chars/3)).
    - With a guardrail, add (ceil(chars/1000) + ceil(maxTokens*4/1000)) * $0.00025.
  - At most 10 calls per run.
  - A refusal marks the current run and every later run budget_exhausted.
- Charges:
  - Metered usage, plus guardrail units for the metered output tokens.
  - The worst case for: a failed attempt that is not a request rejection, a response without usage, or a stream that
    fails while being read.
  - Records keep the tokens Bedrock reported.
- A credential error stops the campaign: later runs are not recorded, and the CLI exits 1. The names are
  CredentialsProviderError, TokenProviderError, ExpiredTokenException, UnrecognizedClientException,
  InvalidSignatureException and AccessDeniedException.
- A12 RESOLVED (5512279): guardrail units, lost responses and responses without usage are now charged within the cap.
  - A13 (unverified) is what the allowance assumes:
    - production's CDK guardrail;
    - the whole request JSON as input text;
    - 4 characters per output token.
  - The dry-run estimate also ignores charged retries (up to three worst cases per call).
- A budget refusal or a credential error stops a campaign.
  - Errors may cluster in profile U: long non-streaming rounds sent from this machine.
- Give each campaign a fresh --out directory: an existing <out name>-artifacts folder is reused.

FUTURE FINDINGS (recorded in the session logs; not acted on)
- A9: production's forced synthesis sends toolUse/toolResult blocks without toolConfig. Step 2's records settle
  whether Bedrock accepts that.
- A10, A11 and A13 as recorded; A12 resolved.
- From the A12 critics, not acted on:
  - a null rejection, or a non-streamed response with no body, would go uncharged (the SDK produces neither);
  - a usage object missing inputTokens is charged 0 input.
- Record shape:
  - synthesis is recorded as kind loop;
  - a failed synthesis leaves no CallRecord;
  - the first call's toolUses is always [].
- The replay lacks production's re-send without temperature (client.ts:430-435).
- The replay's placeholder link is shorter than production's presigned URL; profiles share it.
- Capture fidelity: memory, inbox and hive are stubbed; MCP returns no tools; the prompt is built in unless
  DIAG_AGENT_PROMPT_FILE is set.

EXPECTED SCOPE
- No code edits.
- Writes:
  - outside the repo: Step 0 results, captures, prompt exports, replay records and judge artifacts;
  - inside the repo: the new session log, the HANDOFF update and their local docs commit.

CLAUDE ROUTING
- Opus: analysis, the A12 recommendation, and reading the Step 0 and Step 2 results.
- Sonnet: may run mechanical read-only queries and return the raw output.
- The Step 3 judge: a fresh, blind, order-swapped Opus critic, and only with its approval.
- Every agent starts fresh. Mark a session chapter per step.

IMPLEMENTATION_PROVIDER: not applicable in EXECUTION.
CODEX_POLICY: CONSERVE. CODEX_IN_EXECUTION: OFF.
CODEX_ATTEMPTS_USED: 1 (CLEANUP), 0 corrections. A12 used 1 build and 1 correction, so its budget is spent.
Any further Codex use needs the user's request. Give the child the P12 tripwire and
-c sandbox_workspace_write.network_access=false. Give its critic a measurement-integrity check (P16).

REQUIRED SKILLS
- gauntlet-loop, netzer-os-development-process, git.
- graft indexes C:\dev\Netzer-Labs, not the clone; read the clone with git show and Read.

USER CONSTRAINTS
- No deploy, no push, no writes to production. Local commits only at checkpoints; never push either branch.
- Touch AWS only after the user signs in and approves each step.
  - The live replay (Step 2) needs the user's explicit go and is capped at $30.
  - The judge (Step 3) needs its own approval.
- Captured requests, replay records, judge artifacts and prompt exports contain production or prompt text: keep
  them outside the repo.
- Do not edit development.md.
  - Two gap reports are drafted, not applied (2026-09-11 log, section 6.3).
  - Gap report 1 should name `replay.ts --spend`, because the plain command is a dry run.
- Use the numbered section 1-9 handoff template (docs/features/HANDOFF-TEMPLATE.md in the clone, not .worktrees).
  - Write a new session log under docs/features/deliverables-parity/handoffs/.
  - Carry section 5 forward verbatim from 2026-09-14-w1-a12-spend-hardening.md.
- Build only the current phase. Record future findings; don't act on them.
- Git Bash and commits:
  - Use MSYS_NO_PATHCONV=1 for git show <rev>:<path>, but pass git -C C:/dev/... (not /c/dev/...).
  - No jq. Run heavy commands sequentially.
  - Commits need -c user.name="Emmanuel Adams" -c user.email=emmanuelmadams4@gmail.com.
  - Pass ARN-shaped arguments from PowerShell or a Node runner, never Git Bash.
  - Byte-compare with cmp or a byte comparer, not git diff --no-index (core.autocrlf=true on this machine).
- Step 0 must read the running orchestrator task definition's container environment, by container name, for the
  web search, email and Nova Canvas tool gates, then re-capture with them.
- The Step 3 judge's approval must state that System A runs Sonnet 5 while the replay pins Sonnet 4.6.
- Stop after W1 and propose round 2.

OPEN ASKS (not yet supplied)
- An AWS sign-in and a go for the read-only Step 0 (the list above).
- 3-5 production failures from before and after 2026-08-24: date, surface, agent, prompt or chatId, source files.
- The incident's exact prompt wording (prompt 1 is a stand-in).
- System A's output files for the exported prompts.
- Confirmation, from Step 0, that the deployed guardrail matches production's CDK policies (A13). The A12 decision was
  made on 2026-09-14 (build it), and the build is done.
- Approval to spend up to $30 on Step 2, and a separate approval for the Step 3 judge.
- Approval, or not, for the two drafted development.md gap reports.

EXIT
- After Step 0:
  - Record the results outside the repo and in a session log. Update the HANDOFF and commit the docs locally.
  - Continue to A12 only with the user present. Otherwise emit CONTINUE_COORDINATOR / EXECUTION and stop.
- Code change needed: emit a fresh DIRECT_COORDINATOR / SPECIFICATION handoff with the evidence and every
  constraint above, then stop.
- W1 measured (Step 2, plus Step 3 if approved): record the results against H1-H5, propose round 2, and stop.
`````
