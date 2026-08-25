---
feature: knowledge-durability
document_role: session-handoff
status: current
observed_at: 2026-08-20
as_of_commit: 5418497c4b8466f2f932862fcfee512ca527a7a3
session_slug: knowledge-wipe-rca-and-durable-bucket
supersedes: none
---

# Session handoff: production knowledge base wipe — RCA and durable bucket

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-20 |
| Feature folder | `docs/features/knowledge-durability/` |
| Branch worked on | `fix/durable-knowledge-bucket` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `5418497c4b8466f2f932862fcfee512ca527a7a3` |
| Commit at session end | pending |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

The operator reported that the entire production knowledge base was empty and
guessed the cause was a GitHub account change. It was not. The knowledge index
lives at `index/<scope>/<docId>.jsonl` in the vectors **staging** bucket, and
that bucket carries a lifecycle rule, `expire-staging-fast`, with **no prefix
and no filter** — so S3 expired every object in it, knowledge included, seven
days after each write. `versioned: false` made those deletes permanent. The
production install was created 2026-08-08, so the first week of ingested
knowledge aged out between 2026-08-15 and 2026-08-20, exactly the reported
window. The GitHub org transfer to `Adams-Captial-Holdings-Ltd` happened
2026-08-18, inside that window, which is why it looked causal; it is a
coincidence of dates and cannot delete S3 objects.

The RCA is complete and evidenced. The remediation — a dedicated, versioned,
non-expiring bucket for the knowledge index, a regression guard test, and a
correction to the account-migration runbook — is **not yet implemented**. The
data itself is unrecoverable; only the ingest manifest in the audit log
survives, which lists what to re-upload but not the contents.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- The vector store is plain S3 + in-memory cosine similarity, not a managed
  vector service. One JSONL object per document; retrieval lists the scope
  prefix. See [feature README section 2](../README.md#2-what-it-does-today).
- `VECTORS_BUCKET` and `VECTORS_STAGING_BUCKET` are wired to the **same**
  bucket today (`infra/lib/compute-stack.ts:328` and `:331`), with a code
  comment stating a dedicated vectors bucket was always the intent. That single
  bucket therefore mixes durable knowledge (`index/`) with disposable uploads
  (`uploads/`), which is what made one blanket lifecycle rule fatal.
- Splitting the buckets requires an app-layer split too: `src/lib/vectors/store.ts`
  currently resolves **one** module-level `BUCKET` for both the upload-staging
  helpers and the index helpers.
- The defect class is not unique to vectors. `RawBucket` has a 365-day blanket
  expiry with `versioned: false` and holds agent-generated documents.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `infra/lib/storage-stack.ts:376` | The `expire-staging-fast` rule | The root cause: no prefix, no filter, 7-day expiry over the whole bucket |
| `infra/lib/storage-stack.ts:372` | `versioned: false` on the vectors bucket | Why the deletes are permanent and unrecoverable |
| `infra/lib/compute-stack.ts:331` | `VECTORS_BUCKET` wiring | Points the durable index at the disposable staging bucket |
| `src/lib/vectors/store.ts:29` | `const BUCKET = process.env.VECTORS_BUCKET ?? ''` | One bucket serves both index and uploads; must be split |
| `src/lib/vectors/store.ts:314` | `keyFor()` | Proves the index layout is `index/<scope>/<docId>.jsonl` |
| `docs/account-migration.md:28` | Migration runbook row | Tells operators to abandon the vectors bucket on a false premise |
| `src/adapters/dashboard/handler.ts:2351` | `knowledge_ingest` audit write | The only surviving record of what was ingested |

### 3.3 Patterns and conventions to follow

- Bucket names are built by `bucketName(prefix, account, region)` from
  `infra/lib/constants.ts`; a new bucket needs a `RESOURCE_NAMES` entry, not a
  string literal, or `scripts/destroy.ts` and `scripts/teardown.ts` will not
  know it exists.
- Read the **synthesized template** in `cdk.out/`, never the CDK source comment,
  to confirm what actually deploys — this is ledger entry **M3**, and it is what
  proved the missing `Prefix` here.
- A new bucket must be added in five places or teardown silently strands it:
  `constants.ts`, `storage-stack.ts`, `interfaces.ts`, `iam-stack.ts`, and the
  bucket lists in `scripts/destroy.ts` / `scripts/teardown.ts`.

## 4. Work completed

### 4.1 Tasks finished

- [x] Root-caused the production knowledge-base wipe to the unprefixed
      `expire-staging-fast` lifecycle rule; ruled out the operator's
      GitHub-account hypothesis with positive evidence, not absence.
- [x] Split the durable vector index into its own bucket (`claudeclaw-vectors-*`),
      versioned, with no rule that can expire a current object.
- [x] Scoped the staging expiry to `uploads/` so it cannot re-widen.
- [x] Fixed the write/read scope-folding asymmetry that made any scope
      containing e.g. `:` silently unreadable.
- [x] Added synth-level guard tests that fail if either defect returns.
- [x] Corrected `docs/account-migration.md`, which instructed operators to
      abandon the knowledge bucket.
- [ ] `RawBucket` carries the same defect class (365-day blanket expiry,
      versioning off, holds generated documents). Deliberately NOT changed —
      needs a media-retention decision. See section 6.4.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `infra/lib/storage-stack.ts` | New durable `VectorsBucket`; staging expiry scoped to `UPLOAD_STAGING_PREFIX` | The fix. Durable and disposable data no longer share a bucket or a delete rule |
| `infra/lib/constants.ts` | Added `vectorsBucket` to `RESOURCE_NAMES` | Teardown/provision derive names from here; a literal would strand the bucket |
| `infra/lib/interfaces.ts` | Added `vectorsBucket` to `StorageOutputs` | Consumers need the handle |
| `infra/lib/compute-stack.ts` | `VECTORS_BUCKET` now points at the durable bucket | Was pointed at the staging bucket — the direct cause |
| `infra/lib/iam-stack.ts` | Task role granted bucket + object access on the new bucket | Otherwise ingest fails closed after the split |
| `src/lib/vectors/store.ts` | Split `BUCKET` into `INDEX_BUCKET` / `STAGING_BUCKET`; added and applied `normalizeScope`; exported `UPLOAD_PREFIX` | One variable served both roles, which is what let one rule reach both |
| `src/lib/vectors/ingest.ts` | Uses the shared `normalizeScope` | Removes the second copy of the folding regex |
| `src/lib/vectors/ingest.test.ts` | Store mock made partial via `importOriginal` | Full mock hid the real helper; caught as a regression against baseline |
| `src/config/env.ts` | Corrected the `VECTORS_BUCKET` comment | It documented a fallback that did not exist |
| `scripts/destroy.ts`, `scripts/teardown.ts`, `scripts/local/provision.ts` | New bucket added to the name lists | A bucket absent from these is stranded on teardown |
| `infra/lib/storage-stack.test.ts` | **New.** Durability guards | Proven to fail when the defect is reintroduced |
| `src/lib/vectors/store.scope.test.ts` | **New.** Scope-folding guards | Pins the write/read symmetry |
| `docs/account-migration.md` | Vectors bucket reclassified as MUST-migrate; sync step and warning added | The runbook actively instructed operators to destroy the KB |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Give the index its own bucket rather than only scoping the rule | (a) scope `expire-staging-fast` to `uploads/` and leave the index in place; (b) separate bucket | (b). Operator chose it. Scoping alone leaves durable data in a bucket that has a delete rule, so one careless edit re-creates the incident. Migration cost was zero because the index was already empty. |
| Keep a 90-day `noncurrentVersionExpiration` on the new bucket | none; unbounded versions | Version housekeeping cannot remove a current object, so it does not weaken the guarantee, and it bounds cost. |
| Fix the scope asymmetry in this change | defer it | Same user-visible symptom (knowledge silently absent) and same file. Deferring would have shipped a second silent-loss path to customer installs. |
| Leave `RawBucket` alone | fix it here | Changing customer-visible media retention is a product decision, not a bug fix. Recorded as a known gap and made visible by the guard test's `UNRESOLVED` list. |

Anything durable here must also become an ADR. A decision recorded only in a
session log is not an accepted decision.

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The vector index is the only copy of ingested knowledge; nothing re-derives it | `docs/features/knowledge-durability/README.md` §2 | yes |
| Durable and disposable data must not share a bucket with a blanket delete rule | README §6, enforced by `infra/lib/storage-stack.test.ts` | yes |
| The vectors bucket must be migrated account-to-account | `docs/account-migration.md` | yes |
| `RawBucket` has the same defect class | README §7 + the guard test's `UNRESOLVED` list | yes |
| No ADR was written | — | no — this is a defect fix restoring stated intent (`compute-stack.ts` already said a dedicated bucket was planned), not a new architectural decision |

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

Open `infra/lib/storage-stack.ts` at the `RawBucket` block and decide its
retention (section 6.4), or push this branch and open the PR into `development`.

### 6.2 Immediate next steps

1. Push `fix/durable-knowledge-bucket` and open a PR into `development`.
2. Have someone with working AWS credentials run the confirmation in section
   6.3 — this whole RCA is source evidence only.
3. Deploy order matters: `CCE-Storage` (creates the bucket) must land BEFORE
   `CCE-Compute` (repoints `VECTORS_BUCKET`), or ingest writes to a bucket that
   does not exist yet.
4. Re-ingest from the audit-log manifest (`knowledge_ingest` rows carry docId,
   docTitle, source, scope, format) — only AFTER the deploy, or the new
   documents land in the still-expiring bucket.

### 6.3 Blockers and open questions

- [ ] Blocker: **AWS credentials expired all session** (`aws sts get-caller-identity`
      → "Your session has expired"). Nothing is confirmed against the live
      account — not the loss, not the fix. Needs: `aws login`, then
      `aws s3api get-bucket-lifecycle-configuration --bucket claudeclaw-vectors-staging-239887088812-us-east-1`
      and `aws s3 ls s3://claudeclaw-vectors-staging-239887088812-us-east-1/index/ --recursive | head`.
- [ ] Blocker: **`npm run local:test:integration` could not run.** Docker is
      unavailable on this machine, so Floci cannot start; the suite times out
      with every test skipped. This is a documented gate that has NOT passed.
- [ ] Question: is any object under `index/` still present? If a document
      ingested within the last 7 days survives, the lifecycle rule is the whole
      story; if a document ingested yesterday is ALSO gone, a second cause is
      still live. Suggested resolution: run the `s3 ls` above before
      re-ingesting anything.

### 6.4 Deferred, and why

- **`RawBucket` retention** — deferred because it needs a product decision, not
  a bug fix. It expires every object at 365 days with `versioned: false` and
  holds agent-GENERATED documents as well as transient voice/media. Same defect
  class as this incident with a longer fuse: it has not bitten because the
  install is 12 days old, and it would fire at every customer site at the
  one-year mark. Tracked in README §7 and named in the guard test's
  `UNRESOLVED` set so it cannot be quietly blessed.
- **Backup/replication for the vector index** — still none. `BackupStack` is
  DynamoDB-only. Versioning now makes deletes recoverable; it is not a backup.

## 7. Verification actually performed

Fill in the real result. `not run` is an acceptable and expected answer;
a false `pass` is not.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | not captured | **pass** (clean) |
| `npm test` | **5 files / 1 test failed**, 2122 passed, 6 skipped (2129) | **5 files / 1 test failed**, 2134 passed, 6 skipped (2141) — identical failure set, +12 passing |
| `npm run build` | not captured | **pass** |
| `npm --prefix web run typecheck` | not captured | **pass** |
| `npm --prefix web run build` | not captured | **pass** (built in 26.56s) |
| `npm run local:test:integration` | not run | **NOT RUN — blocker** |
| `node scripts/ci/docs-links.mjs` | not captured | **pass** (846 internal links) |
| `node scripts/ci/feature-knowledge.mjs` | not captured | **pass** |
| `git diff --check` | not captured | **pass** (clean) |

The five `npm test` failures are identical before and after and are pre-existing
Windows issues in files this change does not touch: four suites fail at import
(`scripts/ci/docs-links.test.ts`, `scripts/ci/feature-knowledge.test.ts`,
`scripts/ci/runnable-blocks.test.ts`, `scripts/release/sync-deprecations.test.ts`)
and `scripts/lib/lifecycle/rollback-classes.test.ts:574` asserts POSIX path
separators. Consistent with **A2** — `development.md` was verified on macOS.

One regression WAS introduced and fixed before this table was written:
`src/lib/vectors/ingest.test.ts` went 3-red because its `vi.mock('./store.js')`
replaced the whole module and so hid the new `normalizeScope` export. Fixed by
making the mock partial via `importOriginal`. This is exactly what **P1**'s
baseline is for — without it the failure would have looked pre-existing.

Anything not run, and why:

- **`npm run local:test:integration` — NOT RUN.** `docker info` fails (Docker
  unavailable on this machine), so Floci cannot start on 4566. Attempting it
  anyway produced 30-second timeouts with every test skipped, not a pass. Per
  **P2** this is recorded as an un-run gate, not a skipped line. CI or a machine
  with Docker must run it before merge.
- **No AWS verification of any kind.** Credentials were expired for the entire
  session. Every claim here is source-level or synth-level evidence.

## 8. Environment state

- **Tools and services**: Windows 11, Node/npm from a normal (non-worktree)
  checkout per **M6**. Vitest 2.1.9. **Docker unavailable**, so no Floci and no
  integration suite. **AWS credentials expired all session.**
- **Active processes**: none left running.
- **Environment variables**: `VECTORS_BUCKET` and `VECTORS_STAGING_BUCKET` now
  denote DIFFERENT buckets — that is the change. Also read: `CCE_NAME_SUFFIX`,
  `CDK_STACK_NAME`, `RAW_BUCKET`, `CURATED_BUCKET`. Names only.
- **Uncommitted work left in the tree**: **not mine, left untouched per P6** —
  modifications to `.gitignore` and `CLAUDE.md`, plus untracked
  `handoff-connector-availability-2026-08-15.md` and
  `handoff-staging-deploy-2026-08-14.md` at the repo root. They were already
  present on `fix/paperclip-phase2-readiness` when this session started and
  carried across the branch switch. They are NOT staged in any commit here.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- Previous session handoff: none — this is the first session in this folder.
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
