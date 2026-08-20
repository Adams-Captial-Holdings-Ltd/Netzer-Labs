---
feature: paperclip
document_role: session-handoff
status: current
observed_at: 2026-08-20
as_of_commit: 6996f64efaace96bb4b19246e4a870be341290c1
session_slug: phase-2-readiness
supersedes: 2026-08-19-phase-1-ponytail-audit
---

# Session handoff: Phase 2 readiness, and a blocker that was never a blocker

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-20 |
| Feature folder | `docs/features/paperclip/` |
| Branch worked on | `fix/paperclip-phase2-readiness` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `5418497` (`development`) |
| Commit at session end | `6996f64efaace96bb4b19246e4a870be341290c1` |
| Pushed | no — seven commits local at time of writing |
| PRs | none opened yet |
| Deployed | **no.** No AWS call was made and no AWS resource was created or changed. |

## 2. Current state summary

The session was asked to read the previous handoff, be grilled on the blockers
without assuming anything, and fix the code needed for Phase 2. Partway through,
the framing changed: Paperclip must install cleanly into a **customer's own AWS
account** as part of a Netzar OS install, not only into ours.

**Verifying the blocker list mattered more than working through it.** Four
entries in the previous handoff were stale or wrong:

- **PR #81 was already merged** (`5418497`, squash, 2026-08-20T04:03:11Z) and
  its branch deleted. §6.1's "smallest next action" was done. The local
  `fix/paperclip-phase1-arming` diffed **empty** against `origin/development`.
- **The ARM64 precondition was already met.** Two handoffs carried "the ARM64
  question is unanswered" as a Phase 2 blocker needing a `docker buildx` run.
  The pinned digest is an OCI image **index** carrying both `linux/amd64` and
  `linux/arm64`. Read straight from GHCR, no Docker, no deploy. **A22.**
- **The unmerged docs branch is not a code risk.** Against its own merge-base
  it adds one file and touches no code; the alarming `M scripts/deploy.ts` in a
  two-dot diff is just `development` moving ahead.
- **`observability-stack.ts`'s `retentionFromDays` was not dead.** §6.4 deferred
  it as dead; it was called at `:80`. **M25.**

Four code blockers were then closed: gated ECR creation with a real teardown,
a non-rotating `better_auth_secret`, the ALB listener export, and P1-C4. Two
architectural decisions were taken for the customer-install goal and are
**not yet built**. Nothing was deployed.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **The out-of-band catalog is a REPORT, not an executor.**
  `docs/out-of-band-catalog.json` is parsed and validated
  (`teardown-plan.ts`), classified app-owned vs shared, and **printed**
  (`teardown.ts:582`). `plan.catalogAppOwned` is never acted on. Every real
  deletion is hand-written — the orchestrator ECR repo at `teardown.ts:801`,
  the DDB tables, the lock table, the state bucket. Adding a catalog row does
  **not** make teardown delete anything. **M24.**
- **The pinned Paperclip artifact is multi-arch.** `sha256:6b9daa3c…` resolves
  to an `application/vnd.oci.image.index.v1+json` with `linux/amd64`
  (`sha256:6936579e…`), `linux/arm64` (`sha256:6ab3c816…`) and two attestation
  manifests. `vendor/paperclip/Dockerfile` pins the **index** digest, which is
  the correct way to pin a multi-arch base: the builder resolves the platform.
- **The whole compute plane is ARM64/Graviton.** `compute-stack.ts:270` and
  `:686` set `CpuArchitecture.ARM64`, and the cloud build's buildspec asserts
  `test "$ARCH" = "arm64"` so a non-arm64 image can never be pushed. Any
  Paperclip image must be arm64; the base image supports it.
- **`cloud-build.ts` already solves the customer-install image problem** for
  the orchestrator: git-archive the source to the operator's own state bucket,
  one-shot CodeBuild project on a **native ARM64** container, push to their
  ECR, teardown deletes the project and role beside the repo. Its header says
  local Docker was "the heaviest prerequisite in the whole install". Paperclip
  reintroduces that prerequisite unless it rides this path.
- **`PutSecretValue` replaces the whole `SecretString`.** A secret whose fields
  are owned by different phases cannot be written with a plain plan.
  `/claudeclaw/paperclip` has one deploy-owned field (`better_auth_secret`) and
  three minted against the running instance later. **P19.**
- **`planSecretWrites` runs on every deploy.** Anything generated inside it is
  regenerated every deploy. `npm run setup` is where a stable secret is minted
  (`state.appEncryptionKey = state.appEncryptionKey ?? generateHexToken(32)` is
  the house pattern). **P18.**
- **`EnvBag` has an index signature** (`[k: string]: string`), so a new `.env`
  key reaches `deploy.ts` untouched. The allowlist that bit **M22** is
  `cdkEnvBag`, the `.env` → **synth** boundary; it only matters for values read
  during `cdk synth`. A phase-b secret value needs no entry there.
- **`ComputeStack`'s HTTPS listener is conditional and crowded.** It is built
  only inside the `DOMAIN_NAME` branch, its default action is a **403** when
  `tier.cloudFrontEnabled`, and rule priorities **1 and 2** are taken by
  `CloudFrontOnly` and `DirectHost`. **A23.**
- **`DatabaseStack` has zero tier awareness** — no `TIERS`, no `props.tier`. A
  Tier 0 install provisions the same Aurora Serverless v2 as production.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `scripts/deploy.ts:452` | Phase a, after `ensureSchedulerGroup` | Where the gated Paperclip ECR create now lives |
| `scripts/teardown.ts:801` | Final sweep ECR delete | Proved the catalog does not drive deletion |
| `scripts/lib/lifecycle/deploy-phases.ts` | `planSecretWrites` / `populateSecretsV2` | The secret population path, and the whole-value overwrite hazard |
| `scripts/setup.ts:722` | `generateHexToken` generate-if-absent | The house pattern for a stable generated secret |
| `infra/lib/secrets-stack.ts:117` | Paperclip secret field list | Settles P1-C4; CDK seeds all four as `REPLACE_ME` |
| `infra/lib/compute-stack.ts:1035` | `httpsListener` | Was a local const; Phase 2 needs it |
| `infra/lib/database-stack.ts` | Aurora | Zero tier gating — the customer-install cost floor |
| `scripts/lib/lifecycle/cloud-build.ts` | Docker-free CodeBuild path | The decided home for the Paperclip image build |
| `scripts/ci/diagrams-drift.mjs:83` | `git diff origin/<base>...HEAD` | Reads **committed** changes only; uncommitted diagram edits do not clear it |

### 3.3 Patterns and conventions to follow

- A generated-once secret belongs in `npm run setup` writing `.env`, never in a
  per-deploy code path.
- When a resource is created out of band, the catalog row is documentation;
  the teardown delete is the behaviour. Write both.
- Mapped-source changes get a prepended `drift-gate:` note with the previous
  note demoted to `Prior verification:`; node text is fixed only when the
  change makes it false. `compute-stack.ts` is mapped to **three** diagrams.
- Commit with `git commit -m <msg> -- <paths>`, not `git commit -- <paths> -m`
  (everything after `--` is a pathspec). **P15** still applies: check
  `git diff --cached --name-only` first.

## 4. Work completed

### 4.1 Tasks finished

- [x] Verified every blocker in the previous handoff against the repo instead
  of trusting it; found four stale or wrong entries.
- [x] Answered Phase 1 step 7 (ARM64) by reading the GHCR manifest.
- [x] Restored Paperclip ECR creation in deploy phase a, gated, with a real
  teardown delete and a catalog row.
- [x] Gave `/claudeclaw/paperclip` a `better_auth_secret` that does not rotate
  and does not clobber later-minted keys.
- [x] Exported the ALB HTTPS listener from `ComputeStack`.
- [x] Settled `plan-audit.md` P1-C4.
- [x] Deleted the second identity-function log-retention mapper.
- [x] Updated README, HANDOFF, five diagrams and `.env.example`.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `scripts/deploy.ts` | Gated Paperclip ECR create in phase a; `ensureEcrRepo` regains an explicit repo-name param | Nothing created the repo, which blocked Phase 2 |
| `scripts/teardown.ts` | Explicit Paperclip repo delete in the final sweep, tolerating not-found | The catalog only reports; without this an armed install orphans a billable repo |
| `docs/out-of-band-catalog.json` | `paperclip-ecr-repo` entry | Inventory parity with the orchestrator repo |
| `scripts/lib/lifecycle/deploy-phases.ts` | `mergeSecretValue`, `mergeExisting`, the Paperclip plan | Populate `better_auth_secret` without rotating it or destroying minted keys |
| `scripts/lib/lifecycle/deploy-phases.test.ts` | +5 cases, fake client serves `GetSecretValue` | Pins the merge and the field spelling |
| `scripts/setup.ts` | Generates `PAPERCLIP_BETTER_AUTH_SECRET` once into `.env` | Stable value; matches `appEncryptionKey` |
| `.env.example` | Documents the new variable | Its only other home was the code |
| `infra/lib/compute-stack.ts` | `httpsListener` exported, optional | Phase 2's listener rule had nothing to attach to |
| `infra/lib/observability-stack.ts` | `retentionFromDays` deleted, replaced by the cast | Identity function on a live path |
| `docs/features/paperclip/plan-audit.md` | P1-C4 settled | The shipped spelling wins (**P5**) |
| `docs/features/paperclip/{README,HANDOFF}.md` | Rewritten against current truth | Three claims had become false |
| `docs/diagrams/*` (5 files) | Drift notes; one node text | Six mapped source files changed |

Commits: `be6a89e`, `be807dd`, `8b65800`, `4a0fa98`, `baf39c9`, `c696a29`,
`6996f64`.

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| **Paperclip ECR repo created in `deploy.ts` phase a, gated** | `bootstrap-state.ts` as a fourth primitive; a CI step; defer to the image-push change | Gated creation fixes the gap without recreating **M23**'s ungated repo. `bootstrap-state` would create it on every install including unarmed ones; a CI-only step would stop local deploys pushing at all. |
| **Teardown deletes it explicitly** | Rely on the catalog row | The catalog is a report. Discovered by reading `teardown.ts`, not by assuming. |
| **`better_auth_secret` generated in `npm run setup`, merged at deploy** | Generate in `planSecretWrites`; source from env with a plain write | Generating per-deploy rotates it every deploy. A plain write destroys the three minted fields. Merge is the only shape that is correct on both. |
| **Only `better_auth_secret` is deploy-owned** | Write all four as `REPLACE_ME` | CDK already seeds all four. Re-stamping placeholders would overwrite real credentials the moment a later phase mints them. |
| **`httpsListener` exported as optional** | Non-optional; pass the listener as a prop into `PaperclipStack` | It genuinely does not exist without `DOMAIN_NAME`; a non-optional field would lie. `ComputeOutputs` left alone — it declares `albDnsName` only and three public fields already sit outside it. |
| **P1-C4 recorded in `plan-audit.md` only** | Also edit `implementation-plan.md` §15.5 | The plan is a vendored historical artifact (**A10**) and the audit is already its correction layer, by the audit's own rule 3. |
| **Image build will ride `cloud-build.ts`** | Publish a prebuilt image with cross-account pull; require local Docker | Keeps everything in the customer's account and preserves the Docker-free install. Not yet built. |
| **Aurora ceiling tier-gated, floor left alone** | Also tier-gate `deletionProtection`/`RemovalPolicy`; also drop the Tier 0 floor to 0 (scale-to-zero) | Built. `TierShape.paperclipAuroraMaxAcu` drives `serverlessV2MaxCapacity` (T0 1, T1 2, T2 4 = the old hardcoded value, T3 8). Protection kept, so **P17**/**M19** hold. The floor stays 0.5 everywhere because 0.5 is the lowest non-zero ACU: this caps burst but does **not** remove the continuous cost, and removing it means scale-to-zero, a runtime behaviour change rather than a size knob. Stated plainly rather than claimed as a cost fix. |
| **Mirror the ECR create into `.github/workflows/deploy.yml`** | Leave CI alone; treat the local path as sufficient | CI never runs `scripts/deploy.ts`, so leaving it would have shipped a fix that cannot execute in staging (**M27**). |
| **No `compute-stack.test.ts` created** | Add a synth test for the exported listener | No such file exists; one test asserting a field assignment is over-engineering. Typecheck covers it and Phase 2's stack test will exercise it. |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The pinned artifact carries `linux/arm64` | README §7 risk table, HANDOFF precondition table, **A22** | yes |
| The catalog reports, teardown deletes | `teardown.ts` comment, `deploy.ts` comment, teardown diagram note, **M24** | yes |
| `PutSecretValue` is whole-value; use `mergeExisting` | `mergeSecretValue` doc comment, **P19** | yes |
| Never mint a secret in `planSecretWrites` | `deploy-phases.ts` + `setup.ts` comments, **P18** | yes |
| The HTTPS listener is conditional, priorities 1-2 taken | `compute-stack.ts` doc comment, **A23** | yes |
| P1-C4: `agent_keys` / `dispatch_secret` win | `plan-audit.md` SETTLED note | yes |

## 5. Carried-forward mistakes, assumptions and precautions

> Copied forward from the previous session handoff,
> `2026-08-19-staging-deploy-green.md`, then appended to. Nothing is deleted.
> An entry that is fixed is marked `RESOLVED (<commit>)` and stays.
>
> That file is deliberately **not linked**: it is not on this branch. It is
> still unmerged on `docs/staging-deploy-green-handoff`, so `development` — and
> therefore this branch — does not carry it. Its ledger (5.1 through 5.7) is
> reproduced here verbatim so this file stands alone regardless of merge order.
> The newest session log that does exist here is
> [org-transfer-oidc-and-staging-deploy](2026-08-19-org-transfer-oidc-and-staging-deploy.md).

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
| P10 | Set `PAPERCLIP_TEST_AUTH_SECRET` in **every** process that touches the Paperclip harness — including the vitest process, because the bootstrap fixture shells out to `docker compose`, whose YAML interpolation refuses to parse without it. | The integration file otherwise fails in under a second with `Docker command failed`, which looks like a Docker problem and is not. |
| P11 | Never print, commit, or hand off Paperclip test tokens; probe scripts read the `/dev/shm` cache into memory and print only statuses and bodies. | The fixture's secret-safety contract; tokens exist only inside the disposable container. |

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
| M9 | The first `updatedSince` patch draft carried the watermark into Paperclip's request-coordination key as a `Date`, which `normalizeIssueListCacheValue` normalizes to `{}`. | Two different watermarks would share one in-flight compute and could return each other's results. | Key on `updatedSince?.toISOString()` explicitly (`527512d`). RESOLVED (`527512d`). | Trace a new parameter through every layer that fingerprints the request, not just the query. |
| M10 | A naive strict `>` watermark predicate was almost used against microsecond-stored `timestamptz`. | A row would be re-returned at its own millisecond-truncated watermark, failing I3 and duplicating reconciler work. | `updated_at >= watermark + 1ms` (`527512d`). RESOLVED (`527512d`). | API callers observe truncated timestamps; compare at the resolution the caller can actually observe. |
| M11 | The vendored `.patch` was first committed with no line-ending pin. | A Windows `autocrlf` checkout would deliver CRLF and `patch`(1) inside the Debian build container would reject it — the image build breaks only on other machines. | `.gitattributes` pins `eol=lf` (`a7ab7a3`). RESOLVED (`a7ab7a3`). | Any file consumed byte-exactly inside a Linux container needs an explicit `eol=lf`. |
| M12 | A first clone of the Paperclip release on Windows silently checked out incomplete (4,000+ files missing) with `Filename too long`. | Greps against the partial tree would have "proven" code absent that exists. | `git config core.longpaths true` + `git reset --hard HEAD`, then verify `git status` is clean before trusting the tree. | On Windows, verify a clone is complete before drawing any conclusion from it. |

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it any time with `npm run local:verify`, which requires account id `000000000000`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS**, Floci 1.6.0, Docker 28.3.2, Node 24.3.0, on 2026-08-10. | Windows and Linux behaviour is **not** covered by that verification. See M6. |
| A3 | Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. | Local development validates plumbing, never model behaviour. Tool use is unreachable locally by design. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; deployment is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const). | A `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception. |
| A6 | AWS console access for this account is root-user sign-in via `aws login` with the `netzer-root` profile. | The `netzer-dev` SSO profile is known broken. Do not burn time on it. |
| A7 | The pinned Paperclip image contains full source and toolchain and runs as root, so a derived image can patch + `tsc` in place. | Verified against `2026.722.0`. Re-verify on every re-pin; upstream could slim the image. |
| A8 | Paperclip stamps `updated_at` from two clocks (DB `now()` on insert, Node `new Date()` on update). | Verified in pinned source. The reconciler must tolerate skew; do not treat watermarks as exact. |
| A9 | The Windows baseline failures (4 `scripts/ci` parser suites, buildspec `sh` missing, rollback path separator, intermittent Jarvis timeouts) are environmental and predate this work. | Verified at `4bdbf08` and unchanged since. Compare failing file *names*, not counts. |

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
| `npm run test:paperclip:all` chains with `&&`, so when a test fails the `down` step never runs; clean up the disposable stack explicitly. | [Paperclip README §8](../README.md#8-exact-focused-and-full-validation-commands) |
| Docker Desktop's CLI is outside `PATH` on this machine; npm lifecycle scripts need it prepended, fixtures auto-detect via `LOCALAPPDATA` or `DOCKER_BIN`. | [Paperclip README §8](../README.md#8-exact-focused-and-full-validation-commands) |

### 5.5 Appended 2026-08-19 (docs consolidation)

| # | Entry | Detail |
|---|---|---|
| M13 | The single most load-bearing document in this feature — the 822 KB implementation plan — was left in a Claude temporary scratchpad for a day, and the feature README recorded that as an acceptable state ("an external session artifact (not tracked in this repository)"). | A temp directory is not a location. Anything a future phase must be built from belongs in the repository the moment it is written, even if it is large and even if it is historical. RESOLVED (that session). |
| M14 | The first session log was written before the feature folder existed and then never brought into the framework: untracked, no frontmatter, absent from the session index. | The origin record of a feature is the one log most likely to be needed and least likely to be reproducible. When a feature folder is created after work has started, back-fill the earlier logs into it in the same session. RESOLVED (that session). |
| M15 | The README and HANDOFF drifted three commits behind the code they described — the README still said "first-milestone validation only" after Phase 1 infrastructure landed, and the HANDOFF called a merged PR open. | Phase-completion commits must update the canonical two files in the same commit, not in a later documentation pass. |
| P12 | An adversarial audit of a plan is worth as much as the plan and must be stored beside it. | The audit found two cited paths that do not exist and a five-citation cluster with a systematic +92-line offset anchoring an architecture argument. A plan without its audit reads as more certain than it is. |
| A10 | The implementation plan is **historical**, not current. ADR 0010's amendment and `plan-audit.md` both outrank it. | Its "Paperclip source changes required: **None**" premise is dead — the harness runs a patched artifact. Do not quote the plan as a live constraint. |

### 5.6 Appended 2026-08-19 (OIDC and staging deploy)

| # | Entry | Detail |
|---|---|---|
| M18 | `infra/lib/{database,filesystem}-stack.ts` described their security groups with an em dash. EC2 rejects `GroupDescription` outside ASCII, so `CCE-STAGING-Filesystem` rolled back on first create. | The repo's prose style uses em dashes everywhere, so this will recur. Both stacks carried it; fixing only the one CloudFormation named would have failed again on the next stack. Guarded by a synth assertion in both stack test files. RESOLVED (`dac255a`). |
| M19 | The rolled-back `CCE-STAGING-Filesystem` left **orphans**: EFS `fs-08f70326911d2ae49` and log group `/claudeclaw-staging/paperclip` are `RemovalPolicy.RETAIN`, so CloudFormation logged `DELETE_SKIPPED` and abandoned them. | A rolled-back stack is not necessarily a clean slate. EFS names are tags, not unique keys, so a retry silently creates a *second* filesystem and bills for both. Check for orphans after any rollback of a RETAIN-bearing stack. |
| A14 | A staging deploy does **not** touch `ClaudeClawGitHubDeploy`: `iam-stack.ts` gates the role on `!isStagingDeploy` and staging sets `CCE_NAME_SUFFIX`. | Verified in source. Only a production deploy regenerates that trust policy, so an IAM hand-fix survives staging deploys indefinitely. This corrects the broader claim first written in P13. |
| M16 | After the org transfer, the trust policy was updated to the new **repo path** and the deploy still failed — a second session lost to an `AssumeRoleWithWebIdentity` error that reads like an AWS permissions problem. | An org transfer can change the claim **format**, not merely its contents. Decode the token's real `sub` before touching IAM. RESOLVED (`07a2570`). |
| M17 | A session committed with explicit `git add <paths>`, believing that scoped the commit — but a concurrent agent had staged its own work into the **shared index**, and `git commit` committed the index, sweeping ~900 KB of another session's docs into a commit whose message described a small refactor. | `git add <paths>` scopes what *you* add, not what the commit contains. When another process may share the working tree, verify with `git status`/`git diff --cached` immediately before committing, or use `git commit <paths>`. Corrected by splitting the commit in two. RESOLVED (`04c9f90`). |
| P13 | Set `CCE_GITHUB_IMMUTABLE_SUBJECT` **before the next production deploy**. Only the prod IAM stack creates this role (`iam-stack.ts` gates on `!isStagingDeploy`), so a prod deploy with the variable unset rewrites a hand-patched trust policy back to the classic form. Staging deploys never touch it. | The fix has two halves with a required order; reversing it re-creates the outage and looks like a regression. First stated without the prod-only qualifier — corrected against the code, per **P5**. |
| P14 | When an OIDC assume-role fails, decode the token's real `sub` before changing IAM. | The error names AWS; the cause was on GitHub's side. |
| A11 | `Adams-Captial-Holdings-Ltd/Netzer-Labs` mints **immutable** OIDC subjects: `repo:Adams-Captial-Holdings-Ltd@318461635/Netzer-Labs@1324639154:...`. | Verified twice on 2026-08-19 — a decoded token from run `32280530601`, and `sub_claim_prefix` from the OIDC customization API. Re-verify if the repo moves again. |
| A12 | The deploy workflow needs no repository or environment **secrets**; it reads only `vars`, all of which survived the transfer. | Verified with `gh variable list` and the per-environment variables/secrets API. `CDK_DIFF_ROLE_ARN` is still absent and still only affects the scheduled drift workflow. |
| A13 | The live `ClaudeClawGitHubDeploy` trust policy now lists the four id-bearing subjects and matches the fixed generator's output exactly. | Verified with `aws iam get-role` against the regenerated policy on 2026-08-19, so the next `cdk deploy` is a no-op on the trust rather than a flip-back. |
| Trap | A **production** `cdk deploy` rewrites `ClaudeClawGitHubDeploy`'s own trust policy; staging deploys skip the role entirely (`iam-stack.ts` gates on `!isStagingDeploy`). | [github-to-aws.md](../../../github-to-aws.md), `infra/lib/iam-stack.ts` |
| Trap | Phase 1's Aurora and EFS stacks have **no tier gate**, so Tier 0 staging provisions the same retained, deletion-protected cluster as production. | `infra/bin/app.ts`, `infra/lib/database-stack.ts` |
| Trap | The Paperclip bootstrap fixture aborts on a **stale** stack (`Active Paperclip integration keys exist without the in-memory credential cache`), not only a missing one. Reset the disposable stack per run rather than reusing one a previous session left up. | `tests/fixtures/paperclip-bootstrap.ts`, [README §8](../README.md) |

### 5.7 Appended 2026-08-19 (staging deploy green)

| # | Entry | Detail |
|---|---|---|
| M20 | Infrastructure that nothing consumes was wired unconditionally into the deploy path, so a failure in an unused experiment reported as a failure to ship application code. The orchestrator was healthy at 1/1 throughout. | Ship unconsumed infrastructure behind a flag from the first commit, not after it breaks a pipeline. `void database; void filesystem;` in `app.ts` was the tell — bindings that exist only to silence "unused" are infrastructure with no consumer. RESOLVED (`bc4909b`). |
| M21 | A local `scripts/ci/docs-mermaid.mjs` run reported 15 failures where CI reported 1, including blocks CI renders successfully. | The pinned renderer does not work on this Windows machine. Do not treat local mermaid output as signal; push and read CI. Add to the Windows environmental set with the four parser suites and the rollback path separator. |
| P15 | Before committing in a tree another agent may share, check `git diff --cached --name-only`. `git add <paths>` scopes what *you* add, not what the commit contains. | See M17. The index is shared; a concurrent `git add` rides along on your `git commit`. |
| A15 | Only a **production** deploy rewrites `ClaudeClawGitHubDeploy` (`iam-stack.ts` gates on `!isStagingDeploy`). | Proven from synthesized artifacts: 15 staging templates contain zero `ClaudeClawGitHubDeploy`; the prod template contains `GithubDeployRoleB0CF66A5`. Supersedes the broader claim first written in P13. |
| A16 | The EC2 non-ASCII constraint applies to security group descriptions, not to CloudFormation generally. | 9 live CloudWatch alarms in this account carry non-ASCII descriptions and are deployed and healthy. Do not "fix" em dashes outside EC2 SG descriptions. |
| A17 | Staging is green at `e8ba485` on task definition `claudeclaw-staging-orchestrator:8`, with `CCE_PAPERCLIP_ENABLED` unset so the Paperclip substrate is not deployed. | Verified 2026-08-19 by deploy run, `describe-services`, `describe-stacks`, and `GET https://staging.pgnos.ai/health`. |
| Trap | A rolled-back stack is not a clean slate: `RemovalPolicy.RETAIN` makes CloudFormation log `DELETE_SKIPPED` and abandon the resource. EFS names are tags, not unique keys, so a retry silently creates a second filesystem and bills for both. | `infra/lib/filesystem-stack.ts`; check for orphans after any rollback of a RETAIN-bearing stack. |
| Trap | `infra/bin/app.ts` is mapped to `docs/diagrams/architecture-compute.md` in `docs/diagrams.map`. Any change to it fails the drift gate without a diagram update or a verification note. | `docs/diagrams.map`, `scripts/ci/diagrams-drift.mjs` |

### 5.8 Appended this session (2026-08-19, Phase 1 ponytail audit)

| # | Entry | Detail |
|---|---|---|
| M22 | `bc4909b` gated the Paperclip stacks in `infra/bin/app.ts` and nowhere else, while `scripts/deploy.ts` phase a still named them and `cdkEnvBag` never forwarded the flag. Arming `CCE_PAPERCLIP_ENABLED=1` in `.env` therefore deployed **nothing**, and said so with a green deploy. | A feature flag in this repo has five homes (§3.1). Gating one is not gating the feature; it is creating a disagreement between synth and the deploy driver. When adding a flag, grep for how `CCE_CODEBUILD_ENABLED` is handled and match it in all five. RESOLVED (`e9de42b`). |
| M23 | Phase 1 shipped three ungated Paperclip side-effects that the later gate never covered: an ECR repo created on every deploy for an image nothing pushes, cost copy naming an Aurora cluster the deploy does not create, and a budget alarm raised $50 for a substrate that is off. | "Gate the stacks" is not the same as "gate the feature". After adding a gate, grep the whole repo for the feature's name and check every hit for whether it is now lying. RESOLVED (`e9de42b`). |
| A18 | **`cdk deploy`/`ls`/`diff` do not fail on an unmatched stack name when another pattern in the same invocation matches.** `validateStacksSelected` (`node_modules/aws-cdk/lib/cli/cdk-toolkit.js:1250-1254`) throws only when the total selected count is zero. | Verified by reading the installed `aws-cdk@2.1124.1` and demonstrated with `npx cdk ls CCE-Network CCE-Database` against a flag-off assembly: exit 0, `CCE-Database` silently absent. Never trust a green deploy to mean a named stack was deployed. |
| A19 | `estimateLine`'s estimator branch returns before the `privateEndpoints` clause is built, so the ~$220 endpoint note only ever appears when the estimator has **failed**. `scripts/cost-estimate.mjs` also prices no Aurora, EFS or RDS line item. | Do not copy the endpoints clause as a pattern — it is the buggy branch. Anything appended to the fallback alone is invisible on the path that normally runs. |
| A20 | `RESOURCE_NAMES` is derived from `CCE_NAME_SUFFIX` at import time, so asserting a synthesized name equals `RESOURCE_NAMES.x` compares the constant with itself. | `infra/lib/constants.test.ts:82,107-109` is the house precedent: assert literals, or call `buildResourceNames('')` explicitly. A test written the other way passes under any rename. |
| P16 | Do **not** gate the `/claudeclaw/paperclip` secret, or any other already-deployed `RETAIN` resource with a fixed name, behind a flag after the fact. | Removing it from the template makes CloudFormation `DELETE_SKIPPED` it. Secrets Manager names are unique keys, so a later re-arm fails `ResourceExistsException` — and the 7-day recovery window means even a deliberate cleanup is not instant. Gate before first deploy or not at all. |
| P17 | Do not merge `CCE-Database` into `CCE-Filesystem` or vice versa. | Both are `RETAIN`; Aurora is `deletionProtection: true`. A merged stack turns an EFS create failure into an orphaned, deletion-protected Aurora cluster. The plan's §14.6 describes a single combined stack that was never built — do not "restore" it. |
| A21 | Git Bash on this machine has **no coreutils**: `ls`, `cat`, `head`, `tail`, `grep`, `sed`, `sh` and `npm` are all absent from its PATH. | Use PowerShell for commands and the editor's own file tools. This is also why `scripts/release/buildspec-tag-normalization.test.ts` fails with `spawnSync sh ENOENT` — it is the same environmental cause as the rest of the **A9** set, not a code fault. |

### 5.9 Appended this session (2026-08-20, Phase 2 readiness)

| # | Entry | Detail |
|---|---|---|
| M24 | The out-of-band catalog was treated as if it drove teardown. It does not. `plan.catalogAppOwned` is parsed, classified and **printed** (`teardown.ts:582`); every actual deletion is hand-written, including the orchestrator ECR repo at `teardown.ts:801`. | The previous handoff's ECR instruction was "add it to `docs/out-of-band-catalog.json` so teardown removes it" — which would have produced a documented orphan. When a resource is created out of band, write the catalog row **and** the delete. Verified by grepping every use of `catalogAppOwned` before writing the comment that claims teardown removes it. |
| M25 | The Phase 1 audit deferred `observability-stack.ts:742`'s `retentionFromDays` as "still has its own dead `retentionFromDays`". It was **not dead** — `:80` called it. | "Dead" is a claim about callers, and it costs one grep to check. A deferred item inherited from a handoff is still unverified until you verify it. RESOLVED (`be807dd`). |
| M26 | Two consecutive handoffs carried "the ARM64 question is unanswered" as an unmet Phase 2 precondition requiring a `docker buildx` run. The base image had carried `linux/arm64` all along. | A precondition phrased as work-to-do can often be settled by **reading** instead. One anonymous GHCR token and one manifest GET closed a blocker that had been open across three sessions. Check whether a blocker is a question before scheduling it as a task. RESOLVED (**A22**). |
| A22 | The pinned artifact `ghcr.io/paperclipai/paperclip:2026.722.0@sha256:6b9daa3c…` is an **OCI image index** carrying `linux/amd64` (`sha256:6936579e…`), `linux/arm64` (`sha256:6ab3c816de36f9a69e9f462e950a153e3d30b6cbc03f9a78c5b140277fbafa25`) and two attestation manifests. | Verified 2026-08-20 by anonymous token + manifest GET against ghcr.io, HTTP 200. `vendor/paperclip/Dockerfile` pins the **index** digest, which is correct for multi-arch: the builder selects the platform. Re-verify on every re-pin — a slimmed upstream could drop arm64, and the whole compute plane is `CpuArchitecture.ARM64`. |
| A23 | `ComputeStack`'s HTTPS:443 listener exists **only** when `DOMAIN_NAME` is set, defaults to a **403** when `tier.cloudFrontEnabled`, and has priorities **1 and 2** already taken by `CloudFrontOnly` and `DirectHost`. | Now exported as an optional `httpsListener`. A Phase 2 listener rule must start at priority 3, carry its own condition, and handle the field being `undefined`. Target-group health checks bypass listener rules and stay green regardless. |
| A24 | `EnvBag` in `deploy.ts` has an index signature, so a new `.env` key reaches the deploy driver with no plumbing. `cdkEnvBag` is the `.env` → **synth** allowlist and matters only for values read during `cdk synth`. | `PAPERCLIP_BETTER_AUTH_SECRET` is consumed in phase b, so it correctly needs **no** `cdkEnvBag` entry. Do not cargo-cult the **M22** fix onto every new variable; ask whether synth reads it. |
| P18 | Never mint a secret value inside `planSecretWrites`. It runs on **every** deploy, so the value would be regenerated every deploy. | Generate once in `npm run setup` into `.env`, the shape `state.appEncryptionKey = state.appEncryptionKey ?? generateHexToken(32)` already uses. Rotating Paperclip's `better_auth_secret` invalidates every session. |
| P19 | `PutSecretValue` replaces the **whole** `SecretString`. A secret whose fields are owned by different phases needs `mergeExisting`, not a plain plan. | `/claudeclaw/paperclip` has one deploy-owned field and three minted against the running instance later. Before adding any secret plan, ask which phase owns each field. |
| P20 | `scripts/ci/diagrams-drift.mjs` diffs `origin/<base>...HEAD` — **committed** changes only. Editing a diagram without committing it does not clear the gate. | Costs a confusing re-run otherwise. Also: `compute-stack.ts` is mapped to **three** diagrams, so one source edit can require three notes. |
| Trap | `git commit -- <paths> -m "<msg>"` fails: everything after `--` is a pathspec. | Use `git commit -m "<msg>" -- <paths>`. |
| M27 | The Paperclip ECR create was added to `scripts/deploy.ts` phase a only. **CI does not run `scripts/deploy.ts`** — it runs `npx cdk deploy --all` and mirrors the phased driver with its own steps, so the fix would not have executed on the path that reaches staging. | The deploy driver has **two homes**, exactly as a feature flag has five (**M22**). The CI step's own comment already recorded the previous round of this: "scripts/deploy.ts does this for local deploys; the CI workflow never did, so the first staging deploy hit a 403". Grep `.github/workflows/deploy.yml` for anything you add to `deploy.ts`. RESOLVED (`c6d491f`). |
| A25 | **Staging deploys automatically on a push to the `staging` branch** (`on: push: branches: [staging]`). It is not `workflow_dispatch`-only. | **A4** says deployment "is `workflow_dispatch` only and requires typing `deploy`". That is correct for **production** and wrong for staging. Merging to `staging` IS a deploy. |
| A26 | **CI populates no secrets at all.** `put-secret-value` appears **zero** times in `.github/workflows/deploy.yml`, so `populateSecretsV2` never runs on the CI path — for any secret, not just Paperclip. | A staging deploy therefore leaves `/claudeclaw-staging/paperclip` at `REPLACE_ME` regardless of the phase-b plan. Pre-existing and architectural. Phase 2 needs a decision on how staging gets `better_auth_secret`. |
| P21 | Before re-deploying a `RETAIN`-bearing stack that previously rolled back, **check for orphans with FIXED names first**. | `filesystem-stack.ts:71` creates `/claudeclaw-staging/paperclip` with an explicit `logGroupName`, and **M19** says the 2026-08-19 rollback abandoned exactly that log group. CloudFormation cannot create a fixed-name log group that already exists, so the stack rolls back at the same point again. A tag-named resource like EFS fails differently and worse: it succeeds, and you pay twice. |

## 6. Pending work

### 6.1 Smallest next action

Push the branch and open the PR:

```bash
git push -u origin fix/paperclip-phase2-readiness
```

Nothing here deploys.

### 6.2 Immediate next steps

1. Open `fix/paperclip-phase2-readiness` → `development` and let CI run the
   two checks this machine cannot: the pinned Mermaid renderer (**M21**) and
   the Linux unit-test job that clears the **A9** set.
2. Merge `docs/staging-deploy-green-handoff`. It adds one file, touches no
   code, and restores the session index's unlinkable row.
3. Build the Paperclip image path in `cloud-build.ts` (decision 1, §4.3). This
   is the last thing standing between here and a Phase 2 deploy.
4. Tier-gate Aurora's capacity (decision 2, §4.3).
5. Phase 1 steps 5-6: `cdk diff` against the account, then the deploy. Both
   need an explicit go-ahead; they create billable resources.

### 6.3 Blockers and open questions

- [ ] **Nothing builds or pushes the Paperclip image.** The repo now exists and
  the base image is confirmed arm64-capable, but `vendor/paperclip/Dockerfile`
  is invoked by nothing. Decided home: `cloud-build.ts`. Not built.
- [x] ~~Aurora is untiered~~ **BUILT.** The ceiling is tier-driven (T0 1 ACU).
  The floor is still 0.5 on every tier and deliberately so — see §4.3.
- [ ] **A staging deploy will very likely fail on an existing orphan.** **M19**
  abandoned log group `/claudeclaw-staging/paperclip`, and
  `filesystem-stack.ts:71` creates it with a **fixed name**. Delete the orphan
  before arming `CCE_PAPERCLIP_ENABLED` in staging, or the stack rolls back at
  the same point as last time. The orphan EFS `fs-08f70326911d2ae49` will not
  block but will be billed alongside a second filesystem. **P21.**
- [ ] **Nothing gives staging a `better_auth_secret`.** CI populates no
  secrets (**A26**), so the phase-b plan never runs there. Needs a decision
  before Phase 2: a CI step reading a GitHub secret, or a one-off manual
  `put-secret-value`.
- [ ] **Uninstall is not clean for a customer.** Aurora is
  `deletionProtection: true` + `RETAIN`, so teardown cannot remove it. This was
  a deliberate choice (**P17**, **M19**) and the user chose to keep it, so it
  needs a documented manual runbook step rather than a code change.
- [ ] **Unverified: the arm64 variant's contents.** **A7** ("full source and
  toolchain, runs as root, so a derived image can patch + `tsc` in place") was
  established against the image generally. The patch is applied with `patch`(1)
  and `tsc`, both arch-independent, so risk is low — but the first real arm64
  build is the proof, and it has not run.
- [ ] Before Phase 4, `plan-audit.md` P1-C6 (dual-write) and P1-C7
  (`PAPERCLIP_ENABLED` fall-through) still need an author decision.
- [ ] `npm run setup` (Q11c) still does not ask for the GitHub OIDC immutable
  subject ids. A local `cdk deploy` with `CCE_CICD_ENABLED=1` and no ids would
  rewrite the prod trust policy back to the classic form. CI is the only deploy
  path in use; fix this if that changes.
- [ ] `.gitignore` and `CLAUDE.md` still carry uncommitted edits from the
  concurrent documentation session, plus the untracked
  `handoff-connector-availability-2026-08-15.md` and
  `handoff-staging-deploy-2026-08-14.md`. Left for their owner per **P6**.

### 6.4 Deferred, and why

- Adding an Aurora/EFS line item to `scripts/cost-estimate.mjs` — still
  deferred to when the Fargate task lands and the figure is real.
- A `compute-stack.test.ts` — none exists, and one test asserting a field
  assignment is over-engineering. Phase 2's stack test will exercise the
  listener for real.
- Upstreaming the `updatedSince` patch — user approved "patch our copy" only.
- Deleting `RESOURCE_NAMES.paperclipEcrRepo` — now actively used, so the Phase
  1 deferral is moot.

### 6.5 What Phase 2 still needs built

Unchanged from §6.5 of `2026-08-19-staging-deploy-green.md` (on
`docs/staging-deploy-green-handoff`) except where this session moved it:

- `infra/lib/paperclip-stack.ts` — task definition (family `paperclip-server`,
  cpu 2048 / mem 4096, EFS at `/paperclip`), pinned tag+digest image, roles,
  service, target group (port 3100, health `/api/health`), listener rule, log
  group. Copy plan §22.6 verbatim, comments included.
- `infra/lib/paperclip-stack.test.ts` — the four guardrail assertions:
  `DesiredCount` **1**; **no** `ScalableTarget`/`ScalingPolicy`;
  `MinimumHealthyPercent` **0** / `MaximumPercent` **100**; health-check path
  `/api/health` on port **3100**.
- `infra/bin/app.ts` — instantiate `PaperclipStack` inside the existing
  `CCE_PAPERCLIP_ENABLED` block.
- `infra/lib/compute-stack.ts` — **done this session**; the listener is
  exported. Handle `undefined`, start rules at priority 3 (**A23**).
- `scripts/deploy.ts` — phase b.5, the one-shot migration `RunTask` (§22.7)
  between secrets population and the runtime-config seed, with a `journal(...)`
  checkpoint. Same image, migration command override, **no EFS mount**, wait
  for exit 0, abort on non-zero.
- `development.md:344` — "**Migrations**: none." becomes false; update it in
  the same change.
- `buildspec.yml` — leave alone, stays orchestrator-only.

Confirm `PAPERCLIP_MIGRATION_AUTO_APPLY` is **absent** on the service, wire
`DATABASE_URL` from the Aurora secret and `BETTER_AUTH_SECRET` from
`/claudeclaw/paperclip` (field `better_auth_secret`, **P1-C4 settled**),
omitting all vendor API keys. Note **A10**: the plan is historical, and ADR
0010's amendment plus `plan-audit.md` outrank it where they disagree.

## 7. Verification actually performed

Baseline recorded on the untouched branch before any edit (**P1**), compared by
failing file **name**, never count (**A9**).

| Command | Baseline | After changes |
|---|---|---|
| `npm test` | 192 files: 6 failed / 185 passed / 1 skipped; 2129 tests: 7 failed / 2116 passed / 6 skipped | 192 files: 6 failed / 185 passed / 1 skipped; 2134 tests: 7 failed / **2121** passed / 6 skipped. **Same six file names and same seven test names as baseline.** +5 tests / +5 passing are exactly the five cases added. **No new failures.** |
| `npm run typecheck` | not run separately | **clean** |
| `npm run build` | not run | **clean** |
| `npx vitest run scripts/lib/lifecycle/deploy-phases.test.ts` | 33 tests | **38 passed** |
| `node scripts/ci/docs-links.mjs` | not run | **OK** — 95 files, 807 internal links |
| `node scripts/ci/feature-knowledge.mjs` | not run | **OK** |
| `node scripts/ci/diagrams-drift.mjs` (`GITHUB_BASE_REF=development`) | OK | **OK** — no drift across 15 changed files, after five diagram notes |
| `git diff --check` | not run | **clean** |

The six baseline failures, by name — the documented **A9** environmental set,
none touched by this work: `scripts/ci/docs-links.test.ts`,
`scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`,
`scripts/release/sync-deprecations.test.ts`,
`scripts/release/buildspec-tag-normalization.test.ts`,
`scripts/lib/lifecycle/rollback-classes.test.ts`.

Additional proof:

| Proof | Result |
|---|---|
| `npx cdk ls`, flag unset | **15 stacks**, no `CCE-Database` |
| `npx cdk ls`, `CCE_PAPERCLIP_ENABLED=1` | **17 stacks**, `CCE-Database` present |
| GHCR manifest GET for the pinned digest | **HTTP 200**, OCI image index, `linux/arm64` present (**A22**) |
| `git diff --name-status origin/development HEAD` on the old branch | **empty** — proved `fix/paperclip-phase1-arming` was a merged duplicate |
| `git diff <merge-base> origin/docs/staging-deploy-green-handoff` | **one file added**, no code — proved merging it reverts nothing |
| `grep -c paperclip docs/out-of-band-catalog.json` before the fix | **0** — the ECR gap, confirmed |
| Every use of `catalogAppOwned` | one, a `console.log` — proved the catalog does not delete (**M24**) |

Not run, and why: `cdk diff` and any deploy — they need AWS credentials and
create or read billable state; the session was scoped to code only.
`scripts/ci/docs-mermaid.mjs` — unusable on this machine (**M21**); CI is the
signal. `npm run local:test:integration` — no Paperclip or runtime code changed.
`npm --prefix web` checks — no web code changed.

## 8. Environment state

- **Tools and services**: Node v24.19.0, npm 11.17.0, `aws-cdk` 2.1124.1,
  Vitest 2.1.9, PowerShell on Windows 11. `curl` 8.21.0 is present in Git Bash
  and was used for the read-only GHCR query.
- **Active processes**: none. No Docker container, no Floci, no Paperclip
  disposable stack was started.
- **Environment variables**: `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION` and
  `CCE_PAPERCLIP_ENABLED` were set **per-command only**, for `cdk ls`. Nothing
  was written to `.env`.
- **AWS**: no AWS call was made. No credentials were used.
- **GitHub**: one read-only `gh pr view 81`. No variable changed.
  `CCE_PAPERCLIP_ENABLED` remains deliberately unset.
- **Shell caveat**: Git Bash here has no coreutils in the usual sense
  (**A21**), but `node`, `perl`, `python3` and `curl` all resolve. File edits
  were made with short Node scripts that preserve the tree's **CRLF** endings —
  a naive LF write shows the whole file as changed.
- **Uncommitted work left in the tree**: `.gitignore` and `CLAUDE.md` from the
  concurrent documentation session, plus the two untracked root handoff files —
  per **P6**, not staged, not touched.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](2026-08-19-phase-1-ponytail-audit.md)
- [Implementation plan](../implementation-plan.md) and its [audit](../plan-audit.md)
- [ADR 0010 — Paperclip is the missions work engine](../../../adr/0010-paperclip-work-engine.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
