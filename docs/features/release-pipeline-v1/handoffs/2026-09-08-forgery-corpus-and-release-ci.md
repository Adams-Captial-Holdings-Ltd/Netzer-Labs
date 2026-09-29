---
feature: release-pipeline-v1
document_role: session-handoff
status: current
observed_at: 2026-09-08
as_of_commit: 271339bc8b2feea85e6c31b115fdd34e757a72e2
session_slug: forgery-corpus-and-release-ci
supersedes: none
---

# Session handoff: the forgery corpus, the updater's refusals, and release CI

## 1. Session metadata

| | |
|---|---|
| Session started | 2026-09-07 |
| Feature folder | `docs/features/release-pipeline-v1/` |
| Branch worked on | `feature/release-pipeline-v1` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — `development` deploys nothing |
| Commit at session start | `271339bc8b2feea85e6c31b115fdd34e757a72e2` |
| Commit at session end | see the commit that adds this file |
| Pushed | no |
| PR | none opened |
| Deployed | nothing |

## 2. Current state summary

P1, P2 and P6 of the release plan are implemented in a fresh sibling clone at
`C:\dev\_netzer-release`. P3, P4 and P5 were skipped by instruction: they touch
shared deploy infrastructure with other work open on it.

Three of the five forged releases in the corpus were **accepted by the updater**
before this session. All five are now refused, and each refusal was
mutation-tested. `TRUST_ROOTS` is still empty, no tag exists, and `release.yml`
has never run.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- The release signature is **tag-free by construction**.
  `canonicalPayloadBytes` removes `tag`/`channel` before canonicalising, which
  is what makes an rc and its promoted final byte-identical. It is a feature,
  and `shim.test.ts`'s re-tag test asserts it deliberately.
- The consequence nobody had closed: the signature therefore says nothing about
  *which tag* an artifact belongs to. `promotion.ts` exists to supply that
  binding and had **zero non-test callers**; the updater fetched four assets and
  no attestation; `build-release.ts` emitted an unsigned skeleton nothing ever
  signed.
- `CHANNEL_KEYS` is filtered over `Object.entries(payload)` — top level only —
  and the deep key sort that follows recurses without filtering. A nested
  `imageDigests.tag` reaches the signed bytes and survives parsing, because the
  signature parser passes `imageDigests` through **by reference**.
- `compareVersions` is wired only to the Node and npm gates. `installedTag` was
  read and logged and never compared to the target, so a downgrade was accepted.
- `verifyPromotionAttestation` returns `{ok, problems}` and **never throws**. A
  caller that ignores the return value fails open invisibly.

### 3.2 Critical files

| File | Why |
|---|---|
| `scripts/update/shim.ts` | all three new refusals live here |
| `scripts/update.ts` | the real fetcher; the rotation URL |
| `scripts/lib/release/signing.ts` | canonicalisation — read, never modified |
| `scripts/lib/release/promotion.ts` | the attestation contract |
| `scripts/update/forgery.test.ts` | the corpus; the reason to believe any of this |
| `.baseline/mutate.mjs` | the mutation harness that proves the corpus bites |

### 3.3 Patterns and conventions to follow

- `vitest.config.ts` sets `globals: false` — import `describe`/`it`/`expect`.
- Throwaway ed25519 keys via `generateKeyPairSync('ed25519')`; the same helper is
  copy-pasted into four test files. **Never write a PEM literal into a file** —
  `scripts/ci/secret-scan.mjs` matches `-----BEGIN … PRIVATE KEY-----`. The
  golden vector derives a key from a fixed 32-byte seed through the PKCS#8 DER
  prefix instead.
- CLI modules split logic from entry (`build-release.ts` /
  `build-release-entry.ts`) so a test import cannot fire the CLI.
- GitHub Actions are pinned by commit SHA, not by tag.

## 4. Work completed

### 4.1 Tasks finished

- The forgery corpus, `scripts/update/forgery.test.ts` — 17 tests.
- Attack 1 closed: `ShimFetcher.fetchPromotionAttestation` + a promotion gate in
  `runShim` for final `v*` targets, checked against the **rotated** roots.
- Attack 2 closed: a replay gate that refuses a strictly-older target before any
  fetch, with `rc/` stripped so forward release candidates still install.
- Attack 4 closed: `findChannelKey` refuses a signed payload carrying
  `tag`/`channel` below the top level.
- Attacks 3 and 5 pinned as regression tests (already closed; green by design).
- A golden-vector pin on `canonicalPayloadBytes` and `immutableMetadataHash`.
- `RELEASE_REPO` corrected from a personal account to the organisation.
- The rotation-doc URL moved off a non-existent `main` branch to `HEAD`.
- `scripts/lib/release/retention-fetcher.ts` — the first concrete
  `RetentionFetcher`, with a CLI.
- `scripts/release/sign-promotion.ts` + `-entry.ts` — the first thing that ever
  signs a promotion attestation, and the only place `rcTag` is enforced.
- `.github/workflows/release.yml`.
- ADR 0011, doc corrections in `docs/release-pipeline.md`, this feature folder.

### 4.2 Files modified

Modified: `scripts/update/shim.ts`, `scripts/update/shim.test.ts`,
`scripts/update.ts`, `docs/release-pipeline.md`, `docs/adr/README.md`.
New: `scripts/update/forgery.test.ts`,
`scripts/lib/release/retention-fetcher.ts` + test,
`scripts/release/sign-promotion.ts` + `-entry.ts` + test,
`.github/workflows/release.yml`, `docs/adr/0011-release-artifact-identity.md`,
this feature folder.

### 4.3 Decisions made

- **Identity comes from the attestation, not the signature.** Recorded as
  ADR 0011 (`adr/0011-release-artifact-identity.md` on branch `feature/release-pipeline-v1`). The tempting
  one-liner — `if (metadata.tag !== targetTag) throw` — closes the headline case
  and destroys promotion.
- **`rcTag` is enforced by the signer, not the updater.** It is inside the signed
  bytes, so only the legitimate publisher chooses it; a shim-side check defends
  against nothing an attacker can do.
- **The canonicaliser was not touched.** Nested channel keys are refused at the
  consumer, so nothing already signed is invalidated. The one-level filter is
  filed as the real fix.
- **`release.yml` fails closed rather than inventing an image digest.** A
  placeholder would be baked into signed immutable metadata forever.

### 4.4 Durable facts promoted out of this log

- `development.md` line ~617 states that
  `src/lib/vectors/durability.repro.test.ts` "writes to the real staging vectors
  bucket". **That is false on this commit** — see 5.5. This is a gap report, not
  an edit: amending `development.md` needs approval.

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

### 5.5 Appended this session (2026-09-08, forgery corpus and release CI)

| # | Entry | Detail |
|---|---|---|
| M9 | **Reconnaissance was done in a dirty tree and three "facts" were wrong on the branch.** `scripts/update/shim.ts`'s `RELEASE_REPO` reads the *organisation* in `C:\dev\Netzer-Labs` because of an uncommitted local edit; on `origin/development` it is a **personal account**. | Verify every inherited claim with `git show origin/development:<path>`, never by reading the working tree. |
| M10 | **A mutation harness caught two vacuous mutations in its own first run.** `JSON.stringify(x, null, 0)` is a no-op, and neutering one of the two digest loops leaves the other catching the swap. | A mutation that does not mutate reads exactly like a vacuous test. Check that the mutation changed behaviour before concluding the test is weak. |
| M11 | **`release.yml` initially invoked a module with no entry point.** `sign-promotion.ts` is import-safe by design, so `npx tsx sign-promotion.ts` would have defined its exports and exited 0 having signed nothing. | When CI invokes a TS module directly, prove the CLI executes — run it and check the exit code. `build-release-entry.ts` is the pattern. |
| A7 | **`src/lib/vectors/durability.repro.test.ts` is hermetic**, contrary to `development.md` (~:617). `S3Client.prototype.send` is replaced by `vi.spyOn` backed by an in-memory `Map`; `embedMany` is mocked; the CDK half is `Template.fromStack`. Proven: 7/7 pass with `AWS_PROFILE`/keys/`AWS_CONFIG_FILE` stripped and the metadata endpoint disabled. | Do not exclude it from a gate "because of AWS". Gap report filed; `development.md` not edited (needs approval). |
| A8 | **The AWS session was live this session**, not expired as the plan assumed (`aws sts get-caller-identity` → root, acct `239887088812`). | Re-measure session state; do not inherit it. |
| T1 | **Four baseline test files fail at collection because vite-node does not strip `#!/usr/bin/env node`** from a `.mjs` imported by a test. The `SyntaxError` is reported against the *importer's* comment block, which sends you to the wrong file. | Proven: deleting that one line from `scripts/ci/docs-links.mjs` turns the suite from "failed to collect" into 19 passing tests. Exactly the four test files importing a shebanged module are red. |
| T2 | **The Bash tool truncates large heredocs** and silently eats backslashes inside them. A `.replace(/\\/g, '/')` became `.replace(/\/g, '/')` and produced a syntax error hundreds of lines away. | Use the Write tool for any file with regexes or nested quoting. |
| T3 | **`$?` after a pipeline is the last command's status**, so `cmd | tail` always reports 0. Three CLI exit codes initially read as "all pass". | Capture the status without a pipe, or use `PIPESTATUS`. |

## 6. Pending work

### 6.1 Smallest next action

Open the PR into `development`. Nothing is blocked on code.

### 6.2 Immediate next steps

1. Review and merge into `development`.
2. Decide the key ceremony (parent plan D9: the private key needs a **named
   offline custodian** before it is generated — if nobody will own it, do not
   run P1).
3. Write the orchestrator image-digest step in `deploy.yml` (P5/P2 remainder),
   which is what makes `release.yml` runnable at all.

### 6.3 Blockers and open questions

- **`release.yml` cannot run** until `RELEASE_SIGNING_KEY` exists *and* an image
  digest is producible. Both are deliberate consent gates, not oversights.
- **`npm run local:test:integration` could not be run — Docker is not running on
  this machine.** It is recorded as not run in section 7, never as passing.
- **`actionlint` and a YAML parser are absent** from this environment.
  `release.yml` was parsed with `npx js-yaml` (12 steps, both triggers,
  `contents: write`) but was **not** linted for Actions-specific correctness.

### 6.4 Deferred, and why

P3, P4 and P5 — shared deploy infrastructure, other work open on `deploy.yml`.
Every item found in passing is listed in section 7 of the
[README](../README.md) rather than acted on.

## 7. Verification actually performed

Baseline captured on unmodified `development` @ `271339bc` **before the first
edit**, and every later run diffed against it rather than against green.

| Command | Baseline | After |
|---|---|---|
| `npm run typecheck` | exit 0 | exit 0 |
| `npm test` | 5 files red, 1 failing assertion of 3,115 | see below |
| `npm run build` | exit 0 | exit 0 |
| `npm --prefix web run typecheck` | exit 0 | exit 0 |
| `npm --prefix web run build` | exit 0 | exit 0 |
| `npm run local:test:integration` | **not run** | **not run** |
| `node scripts/ci/docs-links.mjs` | exit 0 | exit 0 |
| `node scripts/ci/feature-knowledge.mjs` | exit 0 | exit 0 |
| `git diff --check` | exit 0 | exit 0 |

The baseline red set is exactly `scripts/ci/docs-links.test.ts`,
`scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`,
`scripts/release/sync-deprecations.test.ts` and
`scripts/lib/lifecycle/rollback-classes.test.ts`. Four are the shebang collection
failure (T1); the fifth is a single real assertion in a file this work is
forbidden to touch.

Beyond the documented list:

- `npx vitest run scripts/update/ scripts/lib/release/ scripts/release/` —
  150 tests passing, including the 17-test corpus and all 16 existing
  `shim.test.ts` tests.
- `node .baseline/mutate.mjs` — **all six guards bite**. Each is reverted in
  turn and the matching forgery goes red. Without this the corpus proves nothing.
- The `sign-promotion` and `retention-fetcher` CLIs were executed directly and
  their exit codes checked (0 / 1 / 1 / 1 / 2, and non-zero for a missing tag).

**Anything not run, and why:** `npm run local:test:integration` — Docker is not
running on this machine, and the parent plan excluded it for that reason. It is
not recorded as passing. `actionlint` — not installed; `release.yml` is
structurally parsed but not lint-verified.

## 8. Environment state

- Windows 11, Node v24.19.0, npm from that toolchain. Work done in a **fresh
  sibling clone** at `C:\dev\_netzer-release` (M6: Vitest cannot start in a
  Windows linked worktree).
- `C:\dev\Netzer-Labs` was **not touched**: it holds 24 uncommitted tracked files
  belonging to other in-flight work (P6).
- AWS session live (root, acct `239887088812`) — see A8.
- Docker not running.
- `.baseline/` in the clone holds the baseline snapshot, the gate runner and the
  mutation harness. It is excluded via `.git/info/exclude`, so it is **not**
  committed and will not survive the clone.

## 9. Related documents

- [Feature README](../README.md)
- [Feature operational handoff](../HANDOFF.md)
- ADR 0011 — release artifact identity (`adr/0011-release-artifact-identity.md` on branch `feature/release-pipeline-v1`)
- [The release pipeline](../../../release-pipeline.md)
- [Feature knowledge framework](../../README.md)
- [development.md](../../../../development.md)
