---
feature: deliverables-parity
document_role: session-handoff
status: current
observed_at: 2026-09-15
as_of_commit: 551227935557463d144ef98a008e92c209741923
session_slug: w1-a12-spend-hardening
supersedes: 2026-09-14-w1-harness-verification.md
---

# Session handoff: W1 A12 spend hardening

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-14 |
| Feature folder | `docs/features/deliverables-parity/` |
| Branch worked on | `chore/deliverables-parity` in the normal clone `C:\dev\_netzer-diag`; `diag/prod-capture` for the overlay |
| Branch it merges into next | `development`, and only with the user's approval |
| AWS environment that branch reaches | none, per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `f6410d9c46cb8f8c96d103fa08b89824a3b827c6` |
| Commit at session end | `551227935557463d144ef98a008e92c209741923`, the A12 implementation. This log, the README and the HANDOFF are committed on top of it |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

The user asked Codex's lowest capable model to finish building W1, and chose the A12 spend hardening as the scope; everything else in W1 needs the user's AWS sign-in. Claude specified R11 to R13 as a red contract (`936957a`). Codex `gpt-5.6-luna` implemented them in `replay.ts` in one build and one correction. Two fresh Opus critics reviewed the result:
- The first caught fabricated token measurements, since fixed, and loose tests.
- The second passed every rule and named nine more loose clauses. The contract now pins them (`86651b6`, `d06a379`), and a mutation check catches all nine.

The implementation is `5512279` on `chore/deliverables-parity`, overlaid as `4cc8503` on `diag/prod-capture`, where the diagnostic suite passes 18 of 18. The replay's $30 cap now covers guardrail units and unmetered calls, and a credential error stops a campaign. Nothing touched AWS, nothing was spent, and nothing was pushed. W1 Step 0 is next and waits on the user's sign-in and go.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **What the replay charges today** (`replay.ts:428-499` at `f6410d9`):
  - Admission runs once per `exchange`, not once per attempt.
  - `sendWithRetry` retries four error names for up to 3 attempts.
  - Only a stream that fails while being read is charged its worst case.
  - A rejected send and a response without `usage` are charged $0.
  - The contract never covered a response without usage, because `fakeBedrock` always supplies one (`replay.diag.ts:121`).
- **Production's guardrail policies are in code.** `origin/production:infra/lib/guardrails-stack.ts:24-73` defines one `CfnGuardrail`:
  - content filters HATE, INSULTS, SEXUAL, VIOLENCE and MISCONDUCT, with PROMPT_ATTACK set to `NONE`;
  - credential-grade PII entities, all BLOCK;
  - no denied topics, word or regex filters, contextual grounding or Automated Reasoning.

  The deployed id and version come from the `bedrock-guardrails` secret (`compute-stack.ts:489-492`), so Step 0 still has to confirm the deployed guardrail matches this code.
- **Guardrail pricing.** From [the Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/), fetched 2026-09-14:
  - content filters (text) cost $0.15 and sensitive-information filters $0.10 per 1,000 text units;
  - regex and word filters are free;
  - a text unit holds up to 1,000 characters, and input and output text are both counted.

  Production's two priced policies therefore cost $0.00025 per text unit.
- **The captured guardrail block is only an id and a version.** Both captured calls carry `{"guardrailIdentifier":"diag-guardrail-placeholder","guardrailVersion":"DRAFT"}` with no `trace`, so a response cannot report guardrail usage back to the replay.
- **Error names the replay can see:**
  - `@aws-sdk/client-bedrock-runtime` models these exceptions: AccessDenied, InternalServer, Throttling, Validation, Conflict, ResourceNotFound, ServiceQuotaExceeded, ServiceUnavailable, ModelError, ModelNotReady, ModelTimeout and ModelStreamError.
  - The SDK's credential chain throws `CredentialsProviderError` or `TokenProviderError` (`@smithy/core`) before sending.
  - The service-side names for expired or invalid credentials (`ExpiredTokenException`, `UnrecognizedClientException`, `InvalidSignatureException`) are not modelled. R13 takes them from AWS's common error codes, unverified against a live response.
- **Codex here.**
  - The desktop app's `codex-cli 0.153.4` reported "Logged in using ChatGPT".
  - `~/.codex/models_cache.json` lists `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` and `gpt-5.5`, and `gpt-5.6-luna` is the smallest.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `scripts/diagnostics/deliverables/replay.ts` | The E1 replay and its CLI | R11 to R13 change its spend boundary |
| `scripts/diagnostics/deliverables/replay.diag.ts` | The replay contract | R11 to R13 are added. `fakeBedrock` learns to omit usage and to fail a stream |
| `origin/production:infra/lib/guardrails-stack.ts` | Production's guardrail | Sizes R12's price per text unit |
| `origin/production:src/lib/bedrock/models.ts:152-166` | `turnCost` | Has no guardrail term |
| `origin/production:src/lib/bedrock/client.ts:290-331` | `isRetryable` and `withRetry` | The retry policy R11 keeps: four names, 3 attempts, 500 ms then 1000 ms |

### 3.3 Patterns and conventions to follow

- **Red cases here use only existing exports.** New summary fields are asserted through `toMatchObject`, so `tsc --noEmit` stays clean while the cases fail on their assertions.
- **Commit style follows `CONTRIBUTING.md`:** `type(scope): …`, matching this branch's history.
- **Prove a contract's strength by mutation, not by another opinion.** Plant each wrong implementation a critic names into the source, run the contract, restore the original bytes, and verify them by sha256. A mutation counts as caught only when the contract goes red on an assertion in the rule's own test.
- **Give a critic a measurement-integrity check** whenever the change touches code that writes records: "which recorded field differs, for which input".
- **Drive Codex through a runner, not a shell one-liner.** Strip `AWS_*`, set the P12 tripwire, pass `-c sandbox_workspace_write.network_access=false`, enforce a timeout, then read the rollout's `turn_context` for the observed model and sandbox.

## 4. Work completed

### 4.1 Tasks finished

- [x] R11 to R13 specified as red contract cases (`936957a`). They fail on their assertions against `f6410d9`'s `replay.ts`, while R1 to R10 and P1 to P3 pass and `tsc` is clean
- [x] Codex `gpt-5.6-luna` implements R11 to R13 in `replay.ts`: one attempt, 353 s, exit 0, +72/−9 lines. After critic 1, one correction took 256 s (exit 0), for +89/−10 lines in all. Committed as `5512279`
- [x] Claude inspects each Codex run (diff, scope, CRLF, rollout log, fingerprints) and re-runs the proof itself
- [x] Two fresh Opus critics judge R11 to R13:
  - Critic 1: FAIL on C4 and C8. The contract was tightened, and Codex made one correction.
  - Critic 2: PASS on every rule, FAIL on C4. Nine clauses were pinned, and a mutation check caught 9 of 9
- [x] Local commits `936957a`, `86651b6`, `d06a379` and `5512279` on `chore/deliverables-parity`, and overlay `4cc8503` on `diag/prod-capture`, where the diagnostic suite passes 18 of 18
- [x] CLI proof behind the P12 and network tripwires: before at `936957a`, then after build 1, after correction 1, and at `5512279`
- [x] README (two promoted facts, the replay row, a risk row), HANDOFF and this log updated; docs gates run

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `scripts/diagnostics/deliverables/replay.diag.ts` | R11 to R13 added. `fakeBedrock` can omit `usage` (`usage: null`) and fail a stream (`streamError`). New helpers: `named`, `depsFor`, `charsOf`, `worstOf`, `guardrailUsd` and `LONG_CAPTURE` | The red contract for A12 (`936957a`), tightened after critic 1 (`86651b6`) and critic 2 (`d06a379`) |
| `scripts/diagnostics/deliverables/replay.ts` | Written by Codex `gpt-5.6-luna`:<br>- admission before every attempt;<br>- worst-case charges for failed non-rejection attempts and for responses without usage;<br>- the guardrail allowance in admission, the charge and the dry-run estimate;<br>- the credential stop, with `stoppedForCredentials` and a one-line CLI message;<br>- the header docblock<br>Claude fixed two stale comments | A12 (`5512279`) |
| `docs/features/deliverables-parity/README.md` | Section 5: the replay row and capture determinism. Section 6: a failed forced synthesis is "(no response)". Section 7: the allowance's assumptions | Promotions (section 4.4), and the replay's new spend boundary |
| `docs/features/deliverables-parity/HANDOFF.md` | Current state | A12 settled; Step 0 next |
| This log | New | The session record |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Build the A12 hardening before Step 0 | Accept A12 as is; also add the deferred record-shape fixes | The user's choice. Production's guardrail policies could be read from its CDK code without AWS, so the allowance is sized now and Step 0 only confirms it |
| Codex `gpt-5.6-luna` at medium effort writes `replay.ts`. Claude writes the tests, and a fresh Opus subagent judges | Claude implements; Codex Terra | The user asked for Codex's lowest capable model. The red cases pin every rule, so the work is bounded. One attempt and one narrow correction are allowed, then Claude takes over |
| Specification, build and review run in one session | A fresh SPECIFICATION session, as the EXECUTION handoff's EXIT says | The user asked for the build now. Builder and critic stay separate: Claude's tests, Codex's code, a fresh Opus critic |
| A failed attempt is charged unless its name marks a request rejection: throttle, unavailable, not ready, validation, access denied, not found, quota, or a credential error | Charge every failure except a throttle, as the verification log's section 6.3 worded it | Charging rejections their worst case would turn a visible $0 failure, such as a lapsed sign-in, into a budget stop |
| Guardrail units come from the full request JSON and 4 characters per output token | Count only message text; meter guardrail usage with `trace` | The full request over-counts, which is safe for a cap. `trace` would change the request production sends. Counting output text alone would miss tool-use input if the guardrail inspects it |
| After a credential error, stop without recording the runs that never started | Record them under a new status | Smallest change. The JSONL's line count against the plan shows what never ran, and a stopped campaign is re-run with a fresh `--out` anyway |
| Close critic 1's C4 gaps in the contract, except the dry-run estimate and `main()`'s credential line | Export the estimate and test it; accept every gap | The gaps are specification gaps, so Claude, the spec author, closes them. Exporting a print-only estimate would widen `replay.ts` for nothing: the CLI golden master already byte-checks it against a hand derivation. `main()`'s line has no hermetic path, so it is judged by reading |
| Route C8 to one Codex `gpt-5.6-luna` correction, bundled with the stale header and a one-line stop message | Claude fixes it; a second full build | A narrow defect with a failing assertion. CONSERVE allows one correction per work item, and then Claude takes over |
| Close critic 2's C4 with nine assertions plus a mutation check, not a third critic | A third fresh critic; accept the gaps | Critic 2 passed the implementation on every rule. Any test suite can be called loose, so the executable answer is to plant each named wrong implementation and watch the contract go red: 9 of 9. Claude also fixed the two stale comments itself, because Codex's correction budget was spent |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| A replay run in `error` on its forced synthesis is production's "(no response)" (carried from the verification log) | `docs/features/deliverables-parity/README.md`, section 6 | yes |
| Captures are request-deterministic across overlays (carried) | README section 5, "Request size, measured" | yes |
| Production's guardrail has two priced policies, $0.00025 per text unit, and the replay now charges an allowance for it | README section 5, "Replay (E1)" | yes |

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

## 6. Pending work

### 6.1 Smallest next action

When the user has signed in to AWS and says go, start W1 Step 0 from `~/.claude/plans/claude-bedrock-deliverables-handoff.md`. Do not start it without that go.

### 6.2 Immediate next steps

1. Step 0, read-only, each item with the user's approval:
   - Logs Insights Q1–Q6;
   - the agent prompts and the raw bucket;
   - production's guardrail id, version and policies, which confirm A13's price;
   - the task definition's tool gates, read by container name;
   - the MCP server config.
2. Re-capture on `diag/prod-capture` (`4cc8503`) with `DIAG_AGENT_PROMPT_FILE` and the gates. Export the prompts for System A.
3. Step 2 only on the user's go, within $30, and from `diag/prod-capture` once the P14 diff prints nothing. Re-run the dry run first, and check the sign-in's age.
4. Step 3 only with its own approval, which must state that System A runs Sonnet 5 and the replay Sonnet 4.6.

### 6.3 Blockers and open questions

Carried from the [2026-09-14 verification log](2026-09-14-w1-harness-verification.md#63-blockers-and-open-questions), except the A12 question, which this session addresses:

- [ ] Blocker: Step 0 — needs: an AWS sign-in (the root `default` profile; sessions last about 2 hours) and the user's go.
- [ ] Blocker: 3–5 production failures from before and after 2026-08-24 — needs: the user.
- [ ] Blocker: System A's files for the exported prompts — needs: the user, once the prompts are exported.
- [ ] Blocker: Step 2 spend of up to $30, and the Step 3 judge — needs: two separate approvals.
- [ ] Question: the incident's exact prompt wording — suggested resolution: the user supplies it, or Step 0 reads the `'agent turn started'` log line.
- [ ] Question: H3 compares different models — suggested resolution: state it in the judge's approval.
- [ ] Question: does production enable the web search, email, Nova Canvas or MCP tools? — suggested resolution: Step 0.
- [ ] Gap reports 1 and 2 from the [2026-09-11 log](2026-09-11-w1-harness-specification.md#63-blockers-and-open-questions): still drafted, not applied.
- [ ] Question: does the deployed guardrail match production's CDK policies? — suggested resolution: Step 0 reads it. If it has other priced policies, raise the allowance's price before Step 2 (A13).

### 6.4 Deferred, and why

These are carried unchanged from the [2026-09-14 verification log](2026-09-14-w1-harness-verification.md#64-deferred-and-why), section 6.4:
- the record shape;
- no temperature re-send;
- reused artifacts folders;
- unchecked loop and synthesis models;
- the short placeholder link;
- A9 and A11;
- work outside W1.

This session built only A12.

Recorded this session and not acted on, from critic 2's non-blocking notes:
- A rejection whose value is `null`, or a non-streamed response with no body, would throw before any charge. The SDK produces neither.
- A `usage` object without `inputTokens` is charged 0 input tokens, which R11's wording allows.
- The dry-run estimate ignores charged retries, so a live campaign can reach the cap sooner than the estimate suggests (A13).

## 7. Verification actually performed

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | not run at `f6410d9` this session | Clean with the red contract in the tree, after Codex build 1, with the tightened contract, and after Codex correction 1 |
| `npm test`, AWS credentials stripped | At `f6410d9`: files 5 failed, 238 passed, 1 skipped; tests 1 failed, 3108 passed, 6 skipped (158.44 s). The same five files as the recorded baseline: the four shebang files and `rollback-classes.test.ts`. A first, backgrounded attempt died with tinypool `Worker exited unexpectedly` and printed no summary | At `5512279`: identical counts and the same five files (145.56 s) |
| `npm run build` | not run | not run |
| `npm --prefix web run typecheck` | not run | not run |
| `npm --prefix web run build` | not run | not run |
| `npm run local:test:integration` | not run | not run |
| `node scripts/ci/docs-links.mjs` | not run at `f6410d9` this session | OK with this log, the README and the HANDOFF in place: 143 markdown files, 1833 internal links |
| `node scripts/ci/feature-knowledge.mjs` | not run at `f6410d9` this session | OK with this log, the README and the HANDOFF in place |
| `git diff --check` | | Clean over the red contract, each Codex run and each commit. The close docs: clean, staged and unstaged |
| Replay contract on `chore/deliverables-parity` `f6410d9`, AWS stripped | 13 of 13 (7.42 s) | Red contract (`936957a`): 3 failed, 13 passed. R11 `expected 0.0006000000000000001 to be close to 0.12418499999999999`; R12 `expected 0.03936 to be close to 0.04236`; R13 `expected [ …(75) ] to have a length of 2 but got 75`. After Codex build 1, re-run by Claude: 16 of 16 (6.69 s). With the tightened contract (`86651b6`): build 1 fails only R11's last assertion, `expected [ [ +0, 1024 ], [ +0, 8192 ] ] to deeply equal [ [ +0, +0 ], [ +0, +0 ] ]`, so every assertion added for C4 already held. After Codex correction 1, re-run by Claude: 16 of 16 (8.52 s) |
| CLI golden master: 16 cases against `capture-f7194c157503.json`, behind P12 and the network preload | At `936957a`: <br>- 4 dry runs exit 0: 75 runs; $210.76 with no flag or `--no-guardrail`, $210.83 with `--guardrail gr-diag:1`, $210.87 with an ARN. Every per-run figure matches a hand derivation from production's price table.<br>- 11 refusals exit 1 with their own messages, including a trailing-colon ARN and `:3`.<br>- The `--spend --no-guardrail` control stops at `prepareEnv`.<br>- 32 preload loads, 0 blocked connects, nothing written under the watched `--out` paths | After Codex build 1:<br>- 13 of 16 cases byte-identical in stdout, stderr and exit code: both no-guardrail dry runs ($210.76), every refusal, and the control.<br>- The guardrail dry runs now include R12's allowance: $229.34 for `gr-diag:1` and $229.38 for the ARN. All 15 per-run figures match the hand derivation.<br>- `refuse-spend-both` prints that same guardrail plan before its unchanged refusal. Its stdout equals the `dry-guardrail` plan, before and after.<br>- 33 preload loads, 0 blocked connects, nothing written.<br><br>After Codex correction 1, against the tightened contract:<br>- the same three differences and nothing else;<br>- all 15 per-run figures still equal the hand derivation;<br>- totals of $210.76, $229.34 and $229.38.<br>Tagging each preload line by case shows the 33rd load is a third Node process in the first case, `dry-noflag`. It made no connection: 0 blocked, nothing written.<br><br>At `5512279`, after Claude's two comment edits:<br>- the same three differences from the "before" run;<br>- all 48 output files identical to the run after correction 1;<br>- 0 blocked connects |
| Codex build 1 audit: the runner's `result.json`, the `--json` events and the rollout log `rollout-2026-09-14T23-22-27-01a0a316-….jsonl` | not applicable | <br>- The runner exited 0 after 353 s, within its 60-minute limit.<br>- Observed in `turn_context`: `gpt-5.6-luna`, effort `medium`, approval `never`, `workspace-write` with `network_access: false`, cwd the clone.<br>- 10 commands: reads of both files; the contract and `tsc` twice each; read-only `git status`/`diff`; one PowerShell rewrite of `replay.ts` from CRLF to LF and back to CRLF, UTF-8 without BOM. One read-only probe exited 1 because `rg` is not on the sandbox PATH.<br>- 3 `file_change` items, all updates to `replay.ts`; `git status` shows only `replay.ts` changed.<br>- No install, commit or network use.<br>- The only `error` item is the skills-context-budget warning.<br>- Usage: 1,015,531 input tokens (957,184 cached) and 5,732 output tokens.<br>- Claude re-checked: CR 796 = LF 796, no bare LF, no non-ASCII bytes, `git diff --check` clean, and the four fingerprinted files unchanged |
| Independent critic 1: fresh Opus subagent, read-only, on build 1 against the rules and `origin/production`, 26 tool uses | not applicable | **VERDICT: FAIL.** PASS on C1–C3 (the rules, and the retry policy matching production's `withRetry`), C5 (spend safety: no request bytes changed, nothing charged below the rules), C6 (scope, CRLF) and C7 (16 of 16).<br>**FAIL C4**, loose tests:<br>- R11 proved "charge anything else" with one name, and never pinned the retry count or waits.<br>- R12's fixtures kept every request under 1,000 characters, so the request term was always 1 unit.<br>- R13 did not show that other rejections or a budget stop leave `stoppedForCredentials` false.<br>- The dry-run estimate and `main()`'s line are unreachable without new exports.<br>**FAIL C8**: `usage?.outputTokens ?? maxTokens` wrote `maxTokens` into `CallRecord.outputTokens` and `DocumentGate.specOutputTokens` for any response without usage, where it recorded 0 before.<br>Nits: the header docblock (`replay.ts:31-32`) is stale; the credential-stop line can span lines if the service message has newlines; one 135-character line |
| Codex correction 1 audit: `rollout-2026-09-14T23-55-34-01a0a334-….jsonl` | not applicable | <br>- The runner exited 0 after 256 s. Observed: `gpt-5.6-luna`, effort `medium`, approval `never`, `workspace-write` with `network_access: false`.<br>- 9 commands: read-only inspection (an `rg` probe exited 1 again), byte-level CRLF checks with one byte rewrite of `replay.ts`, the contract and `tsc`.<br>- `apply_patch` failed verification once on the CRLF docblock lines, then recovered.<br>- 2 `file_change` items, both `replay.ts`.<br>- Usage: 530,624 input tokens (493,568 cached) and 4,777 output tokens.<br>- Claude's interdiff against build 1 shows exactly the four corrections: records keep `usage?.outputTokens ?? 0` while charges use `chargedOutputTokens`; the Budget docblock bullet is rewritten; whitespace is collapsed in the stop line; the two `sendWithRetry` calls are wrapped.<br>- CR 812 = LF 812, no non-ASCII bytes, no added line over 120 characters, `git diff --check` clean, fingerprints unchanged |
| Independent critic 2: fresh Opus subagent, read-only, on build 1 plus correction 1, 24 tool uses | not applicable | **VERDICT: FAIL, on C4 only.** PASS on:<br>- C1–C3, the rules clause by clause, retries matching production's `withRetry`;<br>- C5, spend safety: request bytes unchanged, and every new path charges more or stops sooner;<br>- C6, scope, CRLF, no added line over 120;<br>- C7, 16 of 16;<br>- C8, measurement integrity: token fields metered or 0, `chargedOutputTokens` feeds only cost;<br>- C9, the docblock matches the code.<br>**C4**: nine clauses unpinned —<br>- a charged retryable failure on every attempt;<br>- stream failures under rejection names;<br>- the unmetered cache-token fields;<br>- classification by `$fault`;<br>- the exact guardrail reserve at first attempt and retry;<br>- budget and record agreement on guardrail paths;<br>- a metered non-streamed guardrail round;<br>- credential detection by text rather than name;<br>- the stopping run's JSONL line and artifacts.<br>Non-blocking: a `null` rejection or an empty non-stream response, which the SDK cannot produce, would go uncharged; a `usage` missing `inputTokens` is charged 0 input; two comments were stale (`replay.ts` :39, :483); the dry-run estimate ignores charged retries (up to three worst cases per call) |
| Mutation check on the final `replay.ts`, with the contract pinned for critic 2's nine clauses | not applicable | 9 of 9 caught. Each planted wrong implementation turned the contract red on an R11–R13 assertion:<br>- M1: charge a retryable failure only on its last attempt;<br>- M2: exempt rejection names in the stream catch;<br>- M3: record a worst-case cache write;<br>- M4: exempt `$fault: 'client'`;<br>- M5: reserve only the request's guardrail units;<br>- M6: put the model-only worst case into the budget on a failed stream;<br>- M7: add guardrail units to streamed calls only;<br>- M8: detect credential errors by text;<br>- M9: stop before writing the stopping run.<br>`replay.ts` was restored byte for byte, verified by sha256 |
| Diagnostic suite on `diag/prod-capture` `4cc8503`, AWS stripped | 15 of 15 at `3bb9300`, per the verification log | 18 of 18: both capture cases, plus R1–R13 and P1–P3 on production's builders. `git diff --quiet chore/deliverables-parity diag/prod-capture -- scripts/diagnostics/deliverables` exits 0 (P14) |

Anything not run, and why:
- `npm run build`, both web commands and `npm run local:test:integration` are pre-push gates, and no push is planned.

## 8. Environment state

- **Tools and services**: Node 24.19.0; Git with `core.autocrlf=true`; the desktop app's `codex-cli 0.153.4`. The harness files are `i/lf w/crlf`.
- **Branches in the clone**:
  - `chore/deliverables-parity`: `5512279`, plus this session's close docs.
  - `diag/prod-capture`: `4cc8503`, local only.
  - `fix/knowledge-scope-fanout`: untouched.
  - HEAD sat on `diag/prod-capture` only for the overlay commit and its diagnostic suite, then returned to `chore/deliverables-parity`.
- **Outputs outside the repository**:
  - The overlay's diagnostic run wrote `capture-4cc8503a19e6.json` under `netzer-deliverables-diag` in the temp directory.
  - This session's scratchpad holds everything else, all of it temporary:
    - the Codex work orders and runner;
    - both Codex runs' event streams and replies;
    - the critics' briefs;
    - the CLI golden masters: `cli-before`, `cli-after-1`, `cli-after-2` and `cli-final`;
    - the mutation logs and the test logs.
  - Codex's rollout logs stay under `~/.codex/sessions/2026/09/14/`: `rollout-2026-09-14T23-22-27-01a0a316-….jsonl` for build 1, and `rollout-2026-09-14T23-55-34-01a0a334-….jsonl` for correction 1.
  - The contract runs added more `replay-diag-*` folders under the temp directory. They hold fake data only.
- **Active processes**: none.
- **Environment variables**: none set in the shell. The stripped and tripwire values are set per command.
- **Uncommitted work left in the tree**: none after the close docs commit. The main checkout `C:\dev\Netzer-Labs` was not modified.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-09-14-w1-harness-verification.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
