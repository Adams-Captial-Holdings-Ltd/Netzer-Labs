---
feature: deliverables-parity
document_role: session-handoff
status: current
observed_at: 2026-09-10
as_of_commit: de244e6387efdba177d550d1fb82a6d60291309e
session_slug: deliverables-gap-diagnosis
supersedes: none
---

# Session handoff: why Netzar's deliverables lag the Claude app

> **Back-filled.** The 2026-09-11 W1 specification session wrote this log on
> 2026-09-13 from the approved round-1 plan,
> `~/.claude/plans/claude-bedrock-deliverables-wobbly-heron.md`, which lives
> outside the repository. The diagnosis session wrote no repo handoff of its own:
> its checkout sat on the unrelated dirty branch `fix/knowledge-scope-fanout`, and
> its context was full. Back-filling was a one-time decision. What follows is what
> that session recorded, condensed; line numbers are as it read them.

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-10 |
| Feature folder | `docs/features/deliverables-parity/`, created afterwards by the 2026-09-11 session |
| Branch worked on | none. A read-only diagnosis: code was read with `git show origin/production:<path>` and `git show origin/development:<path>` from a checkout on the unrelated `fix/knowledge-scope-fanout` |
| Branch it merges into next | none |
| AWS environment that branch reaches | none; no AWS access was used |
| Commit at session start | none; it read `origin/production` `de244e6` and `origin/development` `271339b` |
| Commit at session end | none |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

The session diagnosed, from code and documentation only, why Netzar OS (Claude on
Amazon Bedrock) produces weaker PPTX, XLSX, DOCX and PDF work than the Claude
app, handles uploads badly, cannot edit existing files, and reports "context
limits". It produced ranked root causes, a capability-gap matrix and a first
experiment: read-only production telemetry (Step 0), then an output-budget
ablation (E1). The user approved the plan on 2026-09-10 and confirmed the bar and
the system under test. Nothing was built and no runtime evidence was gathered.
The next session was to open this folder in a normal clone, record a baseline,
and specify the capture and replay harness (work item W1).

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

**Production is not development.** Four hotfixes existed only on
`origin/production`: `1abba67` (the first-call output ceiling), `d828124`
(builders returning broken files), `1124118` (the Haiku model id) and `8c14b3f`
(empty-turn repair). Production's first model call gets 8192 output tokens;
development and staging get 1024. A back-merge was started in a separate session
(`task_202d44cb`) and is outside this campaign.

**System B, reconstructed from code.** Netzar is a chat relay with one narrow
document writer; the Claude app is an agent with a computer.

1. **Upload.** Telegram takes one file per message, up to 20 MB; Slack up to 3 at
   50 MB each; the dashboard up to 3.
2. **Storage.** Files go to `RAW_BUCKET`, and no tool ever reopens them.
3. **Handling by type.** Images and PDFs up to 20 MB become Converse blocks for
   that turn only; PDFs go without citations, which Anthropic's documentation says
   means text-only reading. DOCX, PPTX, TXT, MD and CSV are chunked at 2,000
   characters into the knowledge base, after which Telegram and both Slack send
   paths acknowledge and stop, dropping the user's instruction. XLSX is stored and
   never parsed.
4. **Model input.** Fleet-wide conduct rules, the agent's prompt or a default that
   pushes for brevity, memory, 31 tool specs, and the last 20 turns as text only.
5. **Model call.** ConverseStream to Sonnet 4.6 at temperature 0.7, no thinking.
6. **Tools.** `generate_document` builds from headings, paragraphs and string
   tables (or rows) with pdfkit, docx or exceljs and returns a presigned URL;
   `s3_vectors_search` returns the top 5 chunks.
7. **Missing entirely.** A sandbox, PPTX output, rendering, validation, and editing
   a file in place.

**Hypothesis.** Most of the gap sits in the application layer. What reads as
"Claude's document skill" is the Claude app's computing environment. Bedrock
offers neither server-side code execution nor the Agent Skills or Files APIs, so
the application must host all of that, and Netzar hosts none of it. Netzar also
loses input documents and caps output. The older model, the missing thinking and
the brevity prompts contribute by an amount not yet measured.

**Root causes**, where P is the probability each materially contributes:

| # | Root cause | P | Verdict | Key evidence |
|---|---|---:|---|---|
| RC1 | First call capped at 1024 output tokens until 2026-08-24, still on development and staging; the whole spec must fit one tool call | 0.95 | Confirmed as the cause before 2026-08-24. RC1′, 8192 still binding in production, open at 0.5 | `client.ts:273`; production `agent-loop.ts:79,819,900`; the `1abba67` message ("5 times in 450 days… every real attempt truncated") |
| RC2 | No execution environment; a primitive toolchain with no PPTX, formulas, styles, charts, images, templates, render loop or editing; production PDF rejects non-WinAnsi text | 0.9 | Absence confirmed; effect unmeasured | `document-generation-tools.ts:143-170`, `documents/types.ts`, production `pdf.ts:62-80` |
| RC3 | Ingestion loses documents: the instruction is dropped after the acknowledgement, XLSX is never parsed, PDFs are read as text only; Bedrock allows 4.5 MB per document and 3.75 MB per image against the app's 20 MB | 0.9 | Confirmed from code; text-only PDF reading likely, per the docs | `telegram/handler.ts:347-353` (production `:242-246`), `slack/handler.ts:429-435,695-703`, `process.ts:498-528,576-588`, `agent-loop.ts:520-549` |
| RC4 | Documents forgotten between turns: history keeps text only, and later turns reach a document only through top-5 chunks | 0.85 | Confirmed from code | `agent-loop.ts:513-518`, `sessions-repo.ts:27`, `vector-tools.ts` |
| RC5 | Model, configuration and prompt: Sonnet 4.6 rather than Sonnet 5, no thinking, temperature 0.7, a "one or two short paragraphs" default, phone-screen conduct rules, throttled chats pinned to Haiku | 0.7 | Likely; unmeasured | `constants.ts:243-248`, `compute-stack.ts:345-348`, `agent-loader.ts:34-44`, `agent-loop.ts:232-239`, `client.ts:120-155` |
| RC6 | A guardrail or data-loss scan changes output | 0.15 | Open | Step 0 |
| RC7 | Fallback pins chats to a weaker model | 0.2 | Open | Step 0, Q5 |

"Context limits" is probably not the input window, since a normal turn is small.
The likelier sources are the output-cap notice's wording ("ran past the length
limit"), raw Bedrock size errors on large PDFs or images, and chats that died
after truncation before 2026-08-24.

**Capability gap:**

| Capability | Bedrock API | Needs custom infrastructure | Claude app | Netzar |
|---|---|---|---|---|
| PDF understanding | Converse is text-only without citations; 4.5 MB per document | Configuration | Native and visual | Converse block without citations, first turn only |
| DOCX and XLSX understanding | Converse accepts docx and xlsx blocks | A parser or sandbox for styles and formulas | Read in its environment | DOCX as knowledge chunks; XLSX not at all |
| PPTX understanding | Not a Converse format | python-pptx or slide renders | Yes | Knowledge text only |
| Creating PPTX, XLSX, DOCX, PDF | Nothing | A sandbox with python-pptx, openpyxl and python-docx | Yes | No PPTX; flat specs; PDF limited to WinAnsi |
| Editing an existing file | Nothing | Sandbox, the original file, write-back | Yes | Not possible |
| Rendering and visual QA | Nothing | Render to images, then a review loop | Yes | Not possible |
| Thinking | Supported | None | Yes | Not configured |
| Long context | 1M input and 128K output on Sonnet 5 | A context manager | Managed by the app | A 20-turn text window with no token budget |

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/agent/agent-loop.ts` | The turn: system prompt, first streamed call, tool loop | Where the output ceiling is passed, and where history keeps only text |
| `src/lib/bedrock/client.ts:273` | `buildParams` | `maxTokens ?? 1024` is the default the first call fell through to |
| `src/lib/tools/document-generation-tools.ts` | `generate_document` | The only way a deliverable leaves the model |
| `src/lib/documents/types.ts` | Spec validation | The flat spec caps how rich a document can be |
| `src/adapters/telegram/handler.ts`, `src/adapters/slack/handler.ts` | Upload handling | The early return that drops the instruction |
| `src/lib/config/agent-loader.ts:34` | The built-in prompt | The brevity default |

### 3.3 Patterns and conventions to follow

- Read production with `git show origin/production:<path>`, and confirm what it
  carries with `git merge-base --is-ancestor`. The working tree is not production.
- Any fix to upload handling is cross-surface work and follows the parity rule in
  [`CLAUDE.md`](../../../../CLAUDE.md).

## 4. Work completed

### 4.1 Tasks finished

- [x] Diagnosis from code and documentation; the round-1 plan was approved on 2026-09-10.
- [ ] W1 (Step 0 telemetry and E1): not started; see section 6.

### 4.2 Files modified

None. The session changed nothing in the repository.

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| The bar, System A, is the Claude app with code execution and file creation, on Sonnet 5 | Other apps; an older model | Confirmed by the user |
| System B is Netzar production, both before and after the 2026-08-24 hotfix | Staging; development | Confirmed by the user; production is where users hit the problem |
| E1, an output-budget ablation, is the first experiment | E2, model and thinking; E3, a sandbox | The only cause confirmed from production history, still open there, the cheapest to test, and truncated output would make every later quality test unjudgeable |
| Profiles: S = 1024 first call / 8192 tool rounds; P = 8192 / 8192, the control; U = 32000 / 32000 | More profiles | S is production before 2026-08-24, P is production today, U is unconstrained |
| Held fixed: `us.anthropic.claude-sonnet-4-6` with no fallback, temperature 0.7, and production's system prompt, tool specs, guardrail and cache points. Memory is empty, a documented deviation | Letting more vary | Only the budget may vary |
| 5 prompts × 5 runs × 3 profiles = 75 runs, with a hard cap of $30 | – | Enough to decide H1 and H2 at the thresholds below |
| Gates on every run: the spec validates, the builder returns bytes, the file reopens, and `stopReason` is recorded. The model's own report never counts | Self-report | Executable evidence |
| Acceptance. **H1**, 8192 binds: confirmed if P's success rate is at least 15 points below U's or U's p90 spec exceeds 7k tokens; rejected if P is within 10 points of U and U's p90 is under 6k. **H2**: S's success rate at least 50 points below P's. **H3**: U loses at least 75% of blind pairs, then run E2 and E3; 55% or fewer means budget and builders were the main cause. **H4**: prompt 4 under S ends at `max_tokens` with text in at least 80% of runs. **H5**: p90 turn latency at U exceeds 120 s | – | Decides the next experiment either way |
| A blind, order-swapped pairwise judge in fresh context compares U's files with System A's | A self-graded comparison | No builder certifies its own output; the judge needs its own approval |
| Run the harness from a normal clone, not a linked worktree | A linked worktree | Ledger M6 |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Output ceilings per tree, the document tool's limits, the root-cause table | `docs/features/deliverables-parity/README.md` | yes, by the 2026-09-11 session |

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

## 6. Pending work

### 6.1 Smallest next action

Clone the repository normally to `C:\dev\_netzer-diag` and create
`chore/deliverables-parity` from `origin/development`.

### 6.2 Immediate next steps

1. Create this feature folder and record the `npm test` baseline in the clone.
2. Write the capture harness (Step 1) and specify the replay and the prompts.
3. Run Step 0 once the user signs in to AWS.
4. Run Step 2 when the user says go, within $30.
5. Run Step 3 if the judge is approved.
6. Record results and propose round 2.

### 6.3 Blockers and open questions

- [ ] Blocker: 3–5 production failures from before and after 2026-08-24 — needs: date, surface, agent, prompt or chatId, and the source files, from the user.
- [ ] Blocker: System A's output files for the same prompts — needs: the user to run them in the Claude app.
- [ ] Blocker: Step 0 access — needs: an AWS sign-in (only the root `default` profile works, and sessions last about 2 hours), or the user pasting query results.
- [ ] Blocker: Step 2 spend — needs: approval for up to $30.
- [ ] Blocker: the Step 3 judge — needs: a separate approval.

### 6.4 Deferred, and why

- E2 (Sonnet 4.6 against Sonnet 5 with thinking) and E3 (a sandbox): deferred until E1 answers H1–H3.
- Every fix: deferred, because this campaign measures first.
- The production-to-development back-merge: running in a separate session.

## 7. Verification actually performed

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | not run | not run |
| `npm test` | not run | not run |
| `npm run build` | not run | not run |
| `npm --prefix web run typecheck` | not run | not run |
| `npm --prefix web run build` | not run | not run |
| `npm run local:test:integration` | not run | not run |
| `node scripts/ci/docs-links.mjs` | not run | not run |
| `node scripts/ci/feature-knowledge.mjs` | not run | not run |
| `git diff --check` | not run | not run |

Anything not run, and why: nothing was run. This was a read-only diagnosis that changed no file.

## 8. Environment state

- **Tools and services**: none started.
- **Active processes**: none.
- **Environment variables**: none used.
- **Uncommitted work left in the tree**: the main checkout `C:\dev\Netzer-Labs` sat on `fix/knowledge-scope-fanout` with uncommitted work belonging to other efforts. Per **P6**, it was left alone.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- Previous session handoff: none; this is the first session
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
