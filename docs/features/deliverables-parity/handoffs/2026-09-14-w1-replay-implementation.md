---
feature: deliverables-parity
document_role: session-handoff
status: current
observed_at: 2026-09-14
as_of_commit: d91efaf25d53546bc1cd06763f55405460e67a8f
session_slug: w1-replay-implementation
supersedes: 2026-09-11-w1-harness-specification.md
---

# Session handoff: W1 replay implementation

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-14 |
| Feature folder | `docs/features/deliverables-parity/` |
| Branch worked on | `chore/deliverables-parity` in the normal clone `C:\dev\_netzer-diag`; also the local-only `diag/prod-capture` (`51e85cb` → `b62849e`) |
| Branch it merges into next | `development`, and only with the user's approval |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `2af1e4ff5e639171b6a1bfcfcc0ebb90adb5fb32` |
| Commit at session end | `d91efaf25d53546bc1cd06763f55405460e67a8f`; this log and the HANDOFF are committed on top of it |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

W1's Gauntlet IMPLEMENTATION phase is complete. `replay.ts` and `prompts.ts` no
longer throw `not implemented`: on `diag/prod-capture` (`b62849e`, production's
tree plus the harness) the diagnostic suite passes 15 of 15, which is capture 2,
replay contract 10 and prompts contract 3, and the contract files are unchanged.
`replay.ts` now has a `main()` that is a dry run unless `--spend` is given
together with `--out` outside the repository and an explicit guardrail choice.
A live run also keeps each built document and the final reply for the step 3
judge, an addition the user approved this session. Nothing was sent to Bedrock,
nothing touched AWS, and nothing was pushed. The next phase is CLEANUP, then a
fresh VERIFICATION; Step 0 and the live replay still wait on the user.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- Production's forced synthesis (`src/agent/agent-loop.ts`, after the tool loop)
  sends no `toolConfig`, while its messages still hold the turn's `toolUse` and
  `toolResult` blocks. Whether Bedrock accepts that is unmeasured; see A9.
- `generate_document` refuses an unknown format before it validates, with the
  bare text `format must be one of: pdf, docx, xlsx`. Validation and build errors
  share one `spec invalid or build failed: <message>` text.
- Production's `withRetry` wraps only the `send`. An error while a stream is being
  read is not retried, and it checks the `bedrock_global` kill switch before every
  attempt, which reads DynamoDB.
- Production's success text for a document is three lines, the last a presigned
  URL. The replay sends the same first two lines and a short placeholder link.

**Measured with the production capture** (`capture-f7194c157503.json`, built-in
agent prompt), from the dry run. Characters are the first request's JSON; the
worst case assumes all 10 calls of a run at that size.

| Prompt | First request, S and P | Worst case per run, S / P / U |
|---|---:|---|
| `p1-swot-pdf` | 23,977 | $1.42 / $1.53 / $5.10 |
| `p2-deck-10-slides` | 23,950 | $1.42 / $1.53 / $5.10 |
| `p3-workbook-from-csv` | 33,944 | $1.55 / $1.65 / $5.22 |
| `p4-summary-2000-words` | 64,931 | $1.93 / $2.04 / $5.61 |
| `p5-docx-memo-table` | 23,878 | $1.42 / $1.53 / $5.10 |

U's requests are one character longer (`32000`). The 75-run worst case is
$210.76, so the $30 cap stops a campaign whose runs use most of their calls; the
interleaved order still samples every cell first. Prompt 4's source is 170
paragraphs of `development.md` at `271339b`: 6,076 words, 40,281 characters,
sha256 `ba6ba998be13a401ea45b8a3f7faa30d82388d9ece33b01754305ac4f4fee276`.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `scripts/diagnostics/deliverables/replay.ts` | The E1 replay and its CLI | Implemented; the spend boundary |
| `scripts/diagnostics/deliverables/prompts.ts` | The five prompts, fixtures, export, and the repository refusal both files use | Implemented |
| `scripts/diagnostics/deliverables/replay.diag.ts` | The contract | Unchanged; the proof |
| `src/agent/agent-loop.ts` on `origin/production` | The tool loop and forced synthesis | What `runOne` mirrors |
| `src/lib/tools/document-generation-tools.ts` on `origin/production` | The format check and the result texts | What the replay's tool results copy |
| `src/lib/vectors/extractors.ts` | pdf-parse v2 and jszip usage | The reopen gates copy it |

### 3.3 Patterns and conventions to follow

- The contract greps `replay.ts` for the tool-registry path and for dotenv or
  env-loader calls, **comments included**. Never write those strings in that file.
- Iterate on `chore/deliverables-parity` first. The contract's one tree-dependent
  case keys on `d828124` ancestry, so it passes on both trees. Overlay onto
  `diag/prod-capture` once, for the proof.
- Commit on the chore branch before overlaying:
  `git checkout chore/deliverables-parity -- scripts/diagnostics/deliverables`
  copies committed content, not the working tree.
- Check a spend path's refusals behind the tripwire in P12.
- Export the prompts for System A with a throwaway script outside the repository:

  ```ts
  // export-prompts.mts, run from the repository root: npx tsx <path>/export-prompts.mts <dir outside the repo>
  import { exportPrompts } from 'file:///C:/dev/_netzer-diag/scripts/diagnostics/deliverables/prompts.ts';
  console.log(exportPrompts(process.argv[2] as string, 'C:/dev/_netzer-diag').join('\n'));
  ```

## 4. Work completed

### 4.1 Tasks finished

- [x] Baseline re-confirmed: the clone was clean and the contract was 13 of 13 red on `51e85cb`, each on `not implemented`.
- [x] `prompts.ts`: the five prompts, the seeded CSV, the source text and the export.
- [x] `replay.ts`: requests, budget, retries, the mirrored loop, document gates, the campaign and `main()`.
- [x] Judge artifacts beside the JSONL, approved by the user on 2026-09-14.
- [x] Proof on the production overlay, the spend-safety self-check and the full checks (section 7).
- [ ] CLEANUP, then a fresh VERIFICATION: next.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `scripts/diagnostics/deliverables/prompts.ts` | Stubs replaced; adds the exported `refuseInsideRepo` | The contract; one repository check for both files |
| `scripts/diagnostics/deliverables/replay.ts` | Stubs replaced; adds `main()`; `DocumentGate` gains optional `buildError` and `file` | The contract, the CLI and the judge artifacts |
| `docs/features/deliverables-parity/README.md` | The replay's status, rule and command | Durable facts promoted |
| `docs/features/deliverables-parity/HANDOFF.md` | Current state | The phase moved |
| This log | New | The session record |

`capture.diag.ts`, `replay.diag.ts` and `vitest.diag.config.ts` did not change.

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| A live run writes `<out name>-artifacts/<runId>/doc-<n>.<format>` and `reply.txt`; records point at them | Measurements only, as frozen | The user approved it: without the files, the step 3 judge would need a second paid campaign |
| `--spend` also needs `--out` outside the repository and exactly one of `--guardrail <id:version>` or `--no-guardrail`; a dry run needs only `--capture` | `--out` always required | The handoff's proof runs the dry run without `--out` |
| `--guardrail` splits on its last colon | The first colon | A guardrail identifier may be an ARN |
| `--out` must not exist yet | Appending | Two campaigns must never mix in one record set |
| A stream that fails after `send` is charged its worst case | Charging nothing | The call may be billed; the cap must stay conservative |
| The replay has its own retry loop | Importing production's `withRetry` | That checks the kill switch in DynamoDB before every attempt |
| A failed synthesis call records `status: error` | Swallowing it like production | Production's placeholder text would hide the failure the measurement needs; see A9 |
| `DocumentGate.buildError` separate from `validationError` | One field | An invalid spec and a valid spec the builder refused are different failures |
| Every file prompt says to assume rather than ask | Bare prompts | The replay is a single turn, on both systems; a clarifying question ends it with no deliverable |
| The dry-run estimate multiplies the first request's worst case by 10 calls | Simulating request growth | It is informational; admission checks every real request |
| No `--export-prompts` flag | A CLI flag | A four-line throwaway script does it, section 3.3 |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The replay is implemented, dry run by default, with three spend gates and judge artifacts | `docs/features/deliverables-parity/README.md`, sections 2, 5 and 8 | yes |
| Production's forced synthesis sends no `toolConfig` while its messages hold tool blocks | `docs/features/deliverables-parity/README.md`, section 6 | yes |

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

## 6. Pending work

### 6.1 Smallest next action

In a fresh session, start Gauntlet CLEANUP from
`~/.claude/plans/claude-bedrock-deliverables-handoff.md`.

### 6.2 Immediate next steps

1. CLEANUP, scope-locked to `replay.ts` and `prompts.ts`, then a fresh VERIFICATION of the harness.
2. Step 0 once the user signs in and says go. Fetch the incident agent's `CLAUDE.md`
   and production's guardrail id and version. Also read the running orchestrator
   task definition's container environment for the add-on tool gates (web search,
   email, Nova Canvas). Re-capture with `DIAG_AGENT_PROMPT_FILE` and those gates.
3. Export the prompts for System A (section 3.3).
4. Step 2 only on the user's go, within $30. Step 3 only with its own approval,
   which must state the model confound below.

### 6.3 Blockers and open questions

- [ ] Blocker: Step 0 — needs: an AWS sign-in (the root `default` profile; sessions last about 2 hours) and the user's go.
- [ ] Blocker: 3–5 production failures from before and after 2026-08-24 — needs: the user.
- [ ] Blocker: System A's files for the exported prompts — needs: the user, once the prompts are exported.
- [ ] Blocker: Step 2 spend of up to $30, and the Step 3 judge — needs: two separate approvals.
- [ ] Question: the incident's exact prompt wording — suggested resolution: the user supplies it, or Step 0 reads the `'agent turn started'` log line, which carries the first 80 characters of the prompt.
- [ ] Question: H3 compares different models. System A is Sonnet 5; the replay pins `us.anthropic.claude-sonnet-4-6`, so a lost pair cannot be blamed on Netzar's layers alone — suggested resolution: state it in the judge's approval, or run System A on Sonnet 4.6 if the app offers it.
- [ ] Question: does production enable the web search, email or Nova Canvas tools? The capture registers only document generation, and the replay copies its tool list byte for byte, so input tokens and callable tools depend on it — suggested resolution: Step 0 reads the task definition's environment, by container name.
- [ ] Gap reports 1 and 2 from the [2026-09-11 log](2026-09-11-w1-harness-specification.md#63-blockers-and-open-questions), section 6.3: still drafted, not applied. Gap report 1's proposed line should now name `replay.ts --spend`, because the plain command is a dry run.

### 6.4 Deferred, and why

- Re-capturing with production's own `CLAUDE.md`, guardrail and tool gates: needs Step 0.
- Whether Bedrock accepts production's tool-less synthesis request (A9): Step 2's records settle it; a product fix is outside W1.
- The replay's placeholder link is shorter than production's presigned URL, so later rounds carry slightly fewer input tokens: accepted; E1 compares profiles, which share it.
- E2, E3 and every fix: outside W1.
- Deleting `diag/prod-capture` and the `replay-diag-*` temp folders: when W1 closes.

## 7. Verification actually performed

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | clean at `2af1e4f` (2026-09-13) | clean at `d91efaf` |
| `npm test`, AWS credentials stripped | 5 files failed, 238 passed, 1 skipped; 1 test failed, 3108 passed, 6 skipped, at `2af1e4f` (2026-09-13) | 5 files failed, 238 passed, 1 skipped; 1 test failed, 3108 passed, 6 skipped (95.90 s), at `d91efaf`; the same five files as the baseline, and `durability.repro.test.ts` passed 7 of 7 |
| `npm run build` | not run | not run |
| `npm --prefix web run typecheck` | not run | not run |
| `npm --prefix web run build` | not run | not run |
| `npm run local:test:integration` | not run | not run |
| `node scripts/ci/docs-links.mjs` | OK: 139 files, 1719 internal links (2026-09-13) | OK: 140 markdown files, 1747 internal links |
| `node scripts/ci/feature-knowledge.mjs` | OK (2026-09-13) | OK |
| `git diff --check` | clean | `git diff --check 2af1e4f d91efaf` clean; working tree clean |
| Replay contract on `diag/prod-capture` (`51e85cb`) | 13 of 13 fail, each on `not implemented`; re-run this session | not applicable |
| Replay contract on the chore tree (development) | not applicable | 13 of 13 pass |
| Full diagnostic suite on `diag/prod-capture` (`b62849e`) | not applicable | 15 of 15 pass: capture 2, replay 10, prompts 3 |
| Dry run, twice: `npx tsx scripts/diagnostics/deliverables/replay.ts --capture <production capture>` | not applicable | exit 0, identical output both times, plan and estimate printed |
| `--spend` with no guardrail choice; with both choices; with no `--out`; a malformed `--guardrail`; `--out` inside the repository | not applicable | each exits 1 with its own refusal; none reached `prepareEnv`, and no record file appeared |
| `--guardrail` given an ARN, dry run | not applicable | parsed as the ARN and version `3` |
| Prompt export, twice | not applicable | byte-identical; five files |
| R10's temp output | not applicable | `doc-1.xlsx` and `reply.txt` for each of its three runs; each record's `file` points at its document |

The dry run and every refusal ran with the tripwire in P12: `AWS_ACCESS_KEY_ID`
and `AWS_SECRET_ACCESS_KEY` set to `local`, `AWS_ENDPOINT_URL` dead, the profile
and session variables unset, and the config and credentials files pointed at a
missing path. `npm test` ran with `AWS_PROFILE`, the key and session variables
unset, `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` pointed at a missing
path, and `AWS_EC2_METADATA_DISABLED=true`.

Anything not run, and why: `npm run build`, both web commands and
`npm run local:test:integration`. They are pre-push gates, and no push is
planned; they must run before anyone pushes this branch. The `npm test` baseline
was not re-run: the 2026-09-13 result at `2af1e4f` stands, and nothing but this
session's two files changed since. Step 0, the live replay and the judge did not
run, by design.

## 8. Environment state

- **Tools and services**: Node 24.19.0.
- **Branches in the clone**: `chore/deliverables-parity` (`d91efaf` plus this
  commit); `diag/prod-capture` (`b62849e`, local only);
  `fix/knowledge-scope-fanout`, untouched.
- **Outputs outside the repository**, all under the temp directory:
  `netzer-deliverables-diag\capture-f7194c157503.json` (production),
  `capture-1a29a40d8a05.json` (development) and `capture-b62849e484ca.json`,
  written by this session's overlay run; all three hold the built-in agent
  prompt. `replay-diag-*` folders from each contract run hold fake data only.
- **Active processes**: none.
- **Environment variables**: none set in the shell; the tripwire and stripped
  values were set per command.
- **Uncommitted work left in the tree**: none in the clone after this commit. The
  main checkout `C:\dev\Netzer-Labs` was not modified.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-09-11-w1-harness-specification.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
