---
feature: knowledge-scope-fanout
document_role: session-handoff
status: current
observed_at: 2026-08-25
as_of_commit: 06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710
session_slug: three-corpus-retrieval
supersedes: none
---

# Session handoff: three-corpus retrieval and the silent scope drop

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-25 |
| Feature folder | `docs/features/knowledge-scope-fanout/` |
| Branch worked on | `fix/knowledge-scope-fanout` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping), `fix/*` and `development` both deploy nothing |
| Commit at session start | `06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710` |
| Commit at session end | none yet — no commit made at time of writing |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

The objective is that every agent reaches all three knowledge corpora on every
query — its own scope, the platform `default` corpus, and `shared` — merged and
ranked together. Two things stand in the way and only one of them is the
feature. The feature is a small change to the fan-out array and read allowlist
in `s3_vectors_search`. The underlying bug is that an agent's own scope never
resolves at all when it has no `CLAUDE.md` object in S3, because the loader
reads `agent.yaml` only after a successful `CLAUDE.md` fetch. Both were
confirmed from source and from live staging state before any code was written.
At the time of writing the feature folder and this handoff exist, the baseline
has been recorded, and the source change is being built and adversarially
verified. Nothing is committed or pushed. One gap report against
`development.md` is open and is blocking only the live end-to-end retrieval
proof, not the source work.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

`knowledgeScope` reaches vector search through exactly one path:
`agents/<id>/agent.yaml` in the config bucket → `fetchKnowledgeScope` →
`fetchFromS3` → `loadAgent` → `AgentConfig.knowledgeScope` → the `ownScope`
local in `s3_vectors_search`. `fetchKnowledgeScope` has a single call site, and
it sits *after* the early return for a missing `CLAUDE.md`, which is why the
whole path can silently collapse to `default`.

Two independent surfaces make that collapse invisible rather than loud. The
dashboard `PATCH /agents/:id` writes the scope to both the DynamoDB row and
`agent.yaml`, and the detail endpoint reads it back from the DynamoDB row, so
the UI confirms a setting that retrieval never honours. And the zero-hit branch
of `s3_vectors_search` returns a non-error message asserting a cause — suggesting
broader phrasing or more documents — for a corpus that was never searched.

A scope is not an index or a namespace; it is an S3 key prefix under
`index/<scope>/`. Read and write both derive that prefix from one helper in
`src/lib/vectors/store.ts`, which is what stops a scope being written to one
prefix and read from another. That property is owned by the
[knowledge-durability](../../knowledge-durability/README.md) feature, not this
one, and must not be regressed here.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/lib/config/agent-loader.ts:170` | `fetchFromS3` — fetches `CLAUDE.md`, returns `null` when absent | The early return at `:180` is the defect: it precedes the `agent.yaml` read at `:181` |
| `src/lib/config/agent-loader.ts:206` | `fetchKnowledgeScope` — reads `agent.yaml` | Single call site, unreachable when `CLAUDE.md` is missing |
| `src/lib/config/agent-loader.ts:253` | Normalises the scope to `DEFAULT_KNOWLEDGE_SCOPE` | Where the silent collapse to `default` becomes final |
| `src/lib/tools/vector-tools.ts:109` | The fan-out array `[ownScope, 'shared']` | The feature change; also the read allowlist at `:97` |
| `src/lib/tools/vector-tools.ts:148` | Zero-hit message | Asserts a cause it cannot know; the "silence" this work is about |
| `src/lib/tools/vector-tools.scope.test.ts` | Existing scope-containment guard | Security assertions that must survive unchanged |
| `src/lib/vectors/store.scope.test.ts` | Read/write prefix guard | Documents why driving the real path beats testing a helper |

### 3.3 Patterns and conventions to follow

The `scope` argument on both vector tools is model-supplied, therefore
attacker-controlled under prompt injection. Reads may be widened to corpora the
agent is entitled to; writes must stay pinned to the agent's own scope,
server-resolved. `ingest_document` deliberately ignores the argument.

`src/lib/vectors/store.scope.test.ts` carries the local convention for this
defect class: a guard that exercises a helper in isolation does not pin the
behaviour, because the production call site can drift away from the helper. Its
docblock records that reverting the real read path left every helper test green.
New guards in this area drive the real code path and assert on what the
collaborator was actually called with.

`loadAgent` caches for five minutes in module state, so any test touching it
must invalidate that cache between cases.

## 4. Work completed

### 4.1 Tasks finished

- [x] Confirmed the defect mechanism from source and from live staging state
- [x] Recorded the pre-change baseline
- [x] Created the feature folder and this session handoff before writing code
- [ ] Source change and guards — in progress at time of writing; see section 6

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/knowledge-scope-fanout/README.md` | New | Feature index, required before code |
| `docs/features/knowledge-scope-fanout/HANDOFF.md` | New | Volatile state and session index |
| `docs/features/knowledge-scope-fanout/handoffs/2026-08-25-three-corpus-retrieval.md` | New | This log |

Source files are being changed as this is written; the final list is recorded
before the session closes.

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Resolve the scope by hoisting the `agent.yaml` read into `loadAgent` | (a) hoist the yaml read; (b) read `knowledgeScope` off the DynamoDB row `loadAgent` already fetches; (c) both | The user chose (a). It fixes the identified mechanism directly and keeps working for a hand-edited `agent.yaml`, which is a documented workflow. (b) costs no extra call but leaves an S3-only agent broken. |
| One list serves as both the fan-out and the read allowlist | Two separate expressions, as today | Two expressions can drift, which is how a corpus becomes readable-but-unsearched or named-but-unreachable. One list makes that class of bug unrepresentable. |
| Base the work on a new branch off `development` | Continue on `feature/paperclip-phase-1-5` | That branch is 26 commits behind `development` and 0 ahead — its work is already merged. `development.md` step 1 requires branching from `development`. |
| Leave the `chunkId` merge key unqualified by scope | Qualify it per scope | Chat-ingest `docId` is a content hash, so one document can legitimately occupy two corpora; the unqualified key collapses the duplicate and keeps the higher score. Qualifying it would surface the same passage three times. |
| Keep this feature separate from `knowledge-durability` | Fold into that folder | That feature owns storage durability and the prefix helper; this one owns retrieval reach. Distinct concerns, cross-linked rather than merged. |

No entry here is an architecture decision requiring an ADR: the fan-out
behaviour is a bug fix plus a small scope widening within an existing design,
and the storage model is unchanged.

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| An agent with no `CLAUDE.md` silently owns `default` regardless of `agent.yaml` | `docs/features/knowledge-scope-fanout/README.md` §2, §6, §7 | yes |
| A zero-hit search cannot be distinguished from a corpus that was never searched | `docs/features/knowledge-scope-fanout/README.md` §7 | yes |
| `development.md` AWS-safety layer 4 is stale | Gap report to the maintainer; ledger entry A8 below | reported, not yet amended |

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

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it any time with `npm run local:verify`, which requires account id `000000000000`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS**, Floci 1.6.0, Docker 28.3.2, Node 24.3.0, on 2026-08-10. | Windows and Linux behaviour is **not** covered by that verification. See M6. |
| A3 | Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. | Local development validates plumbing, never model behaviour. Tool use is unreachable locally by design. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; deployment is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const). | A `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception. |
| A6 | AWS console access for this account is root-user sign-in via `aws login` with the `netzer-root` profile. | The `netzer-dev` SSO profile is known broken. Do not burn time on it. |
| A7 | Four CI-script suites (`docs-links`, `feature-knowledge`, `runnable-blocks`, `sync-deprecations`) fail under Vitest on this Windows machine with `SyntaxError: Invalid or unexpected token` on a `.mjs` import. | Pre-existing and unrelated to feature work; observed again 2026-08-25 on an untouched `development` base. The `.mjs` validators themselves run clean under plain `node`, so the documentation gates remain genuinely enforceable. |
| A8 | `development.md` section AWS safety, layer 4 ("no ~/.aws directory") is **stale**: `~/.aws/config` now exists on this machine. | Local isolation still holds via `AWS_ENDPOINT_URL` and the fail-closed guard (A1), but on three layers rather than four. Gap report filed 2026-08-25; amendment drafted and NOT applied. |

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

Open `src/lib/config/agent-loader.ts` and confirm the hoisted
`fetchKnowledgeScope` call in `loadAgent` is present and that
`src/lib/config/agent-loader.scope.test.ts` fails when it is reverted.

### 6.2 Immediate next steps

1. Finish the source change and its guards, with the mutation check observed
   rather than assumed for each guard.
2. Run the full nine-command validation list and record every result in
   section 7, including anything that could not run.
3. Once the open gap report is answered, run the live three-corpus retrieval
   against staging resources, capture the verbatim tool output as evidence, and
   remove the fixture afterwards.
4. Update the feature README to describe only what actually shipped, then open
   the pull request into `development`.

### 6.3 Blockers and open questions

- [ ] Blocker: the live end-to-end retrieval proof — needs: a decision on the
      open gap report against `development.md` § AWS safety. The document
      asserts local development cannot reach real AWS and states a machine
      invariant that is no longer true, and it is silent on how to run a
      deliberate real-AWS verification when an acceptance bar requires one. An
      amendment is drafted and deliberately **not** applied. All source and
      unit-test work continues meanwhile.
- [ ] Question: whether `resolveChatIngestScope` in
      `src/lib/media/chat-kb-ingest.ts` should also be hardened. Its bare
      `catch` silently redirects a chat-dropped document into `default`.
      Suggested resolution: leave it. It is a consumer of `loadAgent`, so it
      inherits this fix, and after this change a document mis-filed into
      `default` is retrievable by every agent rather than lost. Widening the
      diff now would not change observable behaviour.

### 6.4 Deferred, and why

- Negative-result caching in `loadAgent` — deferred because it is a distinct
  defect. `cache.set` is unconditional, so a transient S3 error pins an agent to
  `default` for the full five-minute TTL with only a warn line as evidence. It
  is a second path to the same symptom, is self-healing, and fixing it means
  adding new state. Recorded in the feature README §7 as a known risk.
- Per-scope result accounting in `s3_vectors_search` — deferred because it is
  out of scope. The merge destroys per-scope provenance before any check could
  see it, so the tool cannot today report "this corpus returned nothing" as
  distinct from "nothing matched". The guard tests pin the fan-out instead,
  which is the smaller change that catches the same regression.
- The `<scope>` citation tag is absent from the dashboard's grounded-answer
  formatter — deferred, unrelated surface, no behaviour change here.

## 7. Verification actually performed

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | not run at baseline | see below |
| `npm test` | **fail** — 5 files / 1 test failed of 235 files / 2897 tests; exit 1 | see below |
| `npm run build` | not run at baseline | see below |
| `npm --prefix web run typecheck` | not run at baseline | see below |
| `npm --prefix web run build` | not run at baseline | see below |
| `npm run local:test:integration` | not run at baseline | see below |
| `node scripts/ci/docs-links.mjs` | not run at baseline | see below |
| `node scripts/ci/feature-knowledge.mjs` | **pass** — `feature-knowledge: OK` | see below |
| `git diff --check` | not run at baseline | see below |

The baseline `npm test` failures, enumerated so a later run can be compared
against them rather than against an assumption:

| File | Nature |
|---|---|
| `scripts/ci/docs-links.test.ts` | import-time `SyntaxError` on a `.mjs` import (A7) |
| `scripts/ci/feature-knowledge.test.ts` | import-time `SyntaxError` on a `.mjs` import (A7) |
| `scripts/ci/runnable-blocks.test.ts` | import-time `SyntaxError` on a `.mjs` import (A7) |
| `scripts/release/sync-deprecations.test.ts` | import-time `SyntaxError` on a `.mjs` import (A7) |
| `scripts/lib/lifecycle/rollback-classes.test.ts` | one test fails on a Windows path separator (`\tmp\` vs `/tmp/`) |

All five are pre-existing on an untouched `development` base and none are in
`src/`. `npm test` therefore **cannot** be green on this machine, which is a
blocker to report rather than a line to drop: the four `.mjs` suites are a
known Windows-only Vitest limitation, and the `.mjs` validators they wrap run
clean under plain `node`, which is how the documentation gates were still
verified here.

Anything not run, and why: the live three-corpus retrieval against real AWS is
blocked on the open gap report in section 6.3 and has **not** been run. No
claim about deployed behaviour is made anywhere in this feature's documents.

## 8. Environment state

- **Tools and services**: Node and npm from the repo's normal toolchain; Vitest
  via `npx vitest`. Work done in the main clone at `C:\dev\Netzer-Labs`, never a
  linked worktree, per **M6**.
- **Active processes**: none left running. Floci was not started this session;
  `npm run local` had not been needed for the source work.
- **Environment variables**: names only — `CONFIG_BUCKET`, `VECTORS_BUCKET`,
  `AWS_REGION`, `AWS_ENDPOINT_URL`, `AWS_PROFILE`. No values recorded.
- **Uncommitted work left in the tree**: `CLAUDE.md` carries a 15-line local
  modification that predates this session, and `.agents/`, `skills-lock.json`,
  `handoff-connector-availability-2026-08-15.md` and
  `handoff-staging-deploy-2026-08-14.md` are untracked and also predate it. Per
  **P6** none of these were committed, staged, or reverted. They are not this
  session's work.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Knowledge durability feature](../../knowledge-durability/README.md) — owns the storage prefix behaviour this work must not regress
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
