---
feature: paperclip
document_role: session-handoff
status: current
observed_at: 2026-08-19
as_of_commit: f1d602278035252a6579f40a5c3b84b41ec2814e
session_slug: phase-1-ponytail-audit
supersedes: 2026-08-19-staging-deploy-green
---

# Session handoff: Phase 1 over-engineering audit, and the gate that was not a gate

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-19 |
| Feature folder | `docs/features/paperclip/` |
| Branch worked on | `fix/paperclip-phase1-arming` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `747cf8b` (`development`) |
| Commit at session end | `1b206c6` (docs); `f1d602278035252a6579f40a5c3b84b41ec2814e` is the final **code** state and what `as_of_commit` names |
| Pushed | yes |
| PRs | [#81](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/81) → `development`, open |
| Deployed | **no.** Nothing was deployed and no AWS resource was created or changed. |

## 2. Current state summary

The session was asked to audit Phase 1 for over-engineering, on the premise
that it already works, and to fix anything not production-ready.

**Phase 1 is not badly over-engineered.** The Aurora and EFS settings are lean,
and every load-bearing one traces to a documented reason: 5432 from `PaperclipSg`
only (DL-2 at the network layer), 2049 from the same SG, posix 1000:1000,
port 3100, the `/claudeclaw/paperclip` log-group name, `RETAIN`, deletion
protection, PG 17. `infra/lib/github-oidc.ts` had already been cut back in
`44c9b34`. The genuine over-engineering amounted to one identity function.

The audit found something else instead: **the `CCE_PAPERCLIP_ENABLED` gate added
in `bc4909b` was applied in `infra/bin/app.ts` and mirrored in none of the four
other places that encode the same decision.** The flag did not do what its own
comment said, and it failed *silently*:

- `scripts/deploy.ts` phase a named `CCE-Database` and `CCE-Filesystem`
  unconditionally in a `cdk deploy --exclusively` call. That does **not** crash.
  `validateStacksSelected` throws only when the *total* selected count is zero,
  and six of the eight phase-a names always match, so the two Paperclip names
  were dropped with no error and the deploy reported success.
- `CCE_PAPERCLIP_ENABLED` was absent from `cdkEnvBag`, an allowlist over
  `process.env`. Setting it in `.env` therefore reached synth as `undefined`.
  The only arming path that ever worked was an inline `export`.
- Together those two mean: arm the flag the documented `.env` way, and the
  deploy goes green having created no Aurora and no EFS.

Three more Phase 1 additions were ungated side-effects the gate never covered: a
second ECR repository created on every local deploy for an image nothing pushes,
cost copy promising an Aurora cluster the deploy does not create, and a budget
alarm loosened by $50 for every deployment that has no Paperclip. All three are
now gone or gated.

All fixes are committed on `fix/paperclip-phase1-arming`, three commits, nothing
deployed. **Phase 2 is still blocked** — see §6.5.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- **`cdk deploy <a> <b> <c> --exclusively` does not fail on an unmatched name.**
  `validateStacksSelected` (`node_modules/aws-cdk/lib/cli/cdk-toolkit.js:1250-1254`)
  throws `NoStacksMatched` only when `stacks.stackCount == 0`. Patterns are
  flattened into one set first, so any single matching name suppresses the error
  for all the others. Demonstrated read-only against a flag-off assembly:

  ```bash
  npx cdk ls CCE-Network CCE-Database
  ```

  exits 0 and lists only `CCE-Network` (plus its dependency). This is why a
  feature flag that disagrees with a hardcoded stack list is dangerous rather
  than merely wrong: the deploy is green and the resource is absent.
- **A feature flag in this repo has five homes, not one.** `infra/bin/app.ts`
  (synth), `scripts/deploy.ts` phase-a list, `scripts/deploy.ts` `cdkEnvBag`
  (the `.env` -> synth boundary), `scripts/lib/lifecycle/manifest.ts`
  `SYNTH_INPUT_ALLOWLIST` (rollback re-synth), and
  `scripts/lib/lifecycle/teardown-plan.ts` `currentAppStackNames`
  (cdk-destroy vs direct `DeleteStack`). `CCE_CODEBUILD_ENABLED` is the worked
  example that appears in all of them.
- **`RetentionDays` is a numeric enum whose members are day counts**
  (`ONE_WEEK = 7` … `ONE_YEAR = 365`), and `TierShape.logRetentionDays` is typed
  `7 | 30 | 90 | 365` (`infra/lib/constants.ts:232`). Any helper mapping one to
  the other is an identity function.
- **`estimateLine` has two branches and the endpoints clause only reaches one.**
  The estimator branch returns before the clause is built, so the ~$220 endpoint
  note appears only when the estimator has *failed*. Anything appended the same
  way inherits that. `scripts/cost-estimate.mjs` also carries no Aurora, EFS or
  RDS line item at all.
- **`bootstrap-state.ts` only ever created one ECR repo.** The
  `deploy-pipeline.md` node claiming it creates "orchestrator + paperclip" was
  wrong as drawn; the Paperclip repo came from `deploy.ts`'s push path.
- **`RESOURCE_NAMES` is derived from `CCE_NAME_SUFFIX` at import.** Asserting a
  synthesized name equals `RESOURCE_NAMES.x` compares the constant with itself
  and would accept any rename. `infra/lib/constants.test.ts:82,107-109` sets the
  house precedent: literals, or an explicit `buildResourceNames('')`.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `scripts/deploy.ts:433` | Phase-a foundation stack list | Hardcoded both Paperclip stacks; the silent-drop defect |
| `scripts/deploy.ts:1187` | `cdkEnvBag`, the `.env` -> synth allowlist | The flag was missing, so `.env` arming was a no-op |
| `scripts/lib/lifecycle/manifest.ts:77` | `SYNTH_INPUT_ALLOWLIST` | A rollback re-synths from the manifest; an unlisted flag is dropped |
| `scripts/lib/lifecycle/teardown-plan.ts:167` | `currentAppStackNames` | Picks cdk-destroy vs direct `DeleteStack`; Aurora is deletion-protected |
| `scripts/lib/cost-gate.ts` | The deploy money gate | Priced and listed a substrate the deploy does not create |
| `infra/lib/filesystem-stack.ts:78` | `retentionFromDays` (deleted) | The one genuine over-engineering finding |
| `infra/lib/database-stack.test.ts:108` | SG-description ASCII guard | Sat in the NetworkStack describe but asserted on the database template |
| `node_modules/aws-cdk/lib/cli/cdk-toolkit.js:1250` | `validateStacksSelected` | The authority for the silent-drop behaviour |

### 3.3 Patterns and conventions to follow

- Feature flags are the bare literal comparison `=== '1'`, read from the `env`
  bag in `scripts/`, from `process.env` in `infra/`. There is no `envFlag()`
  helper and adding one for a single flag would be the over-engineering.
- When adding a flag, add it to **all five** homes listed in §3.1, or write down
  why not.
- `implements <X>Outputs` and `export interface <X>StackProps` are house style
  across nine stacks. Do not strip them from two stacks for tidiness.
- Mapped-source changes that leave the depicted flow alone get a prepended
  `drift-gate:` note with the previous note demoted to `Prior verification:`.
  Changes that make a node text false get the node text fixed as well.

## 4. Work completed

### 4.1 Tasks finished

- [x] Audited Phase 1 for over-engineering against the plan's own mandates,
  separating load-bearing settings from taste.
- [x] Found and fixed the silent-arming defect across all four unmirrored
  homes of `CCE_PAPERCLIP_ENABLED`.
- [x] Deleted the ungated second ECR repository and its regex name-derivation.
- [x] Made the cost gate and the budget alarm honest again.
- [x] Deleted the identity-function log-retention mapper.
- [x] Closed the SG-description ASCII guard's coverage gap.
- [x] Recorded, with reasons, the seven things that look over-engineered and
  should **not** be cut (§4.3).
- [x] Answered the Phase 2 readiness question (§6.5).

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `scripts/deploy.ts` | Phase-a list gated; `cdkEnvBag` forwards the flag; Paperclip ECR calls and `paperclipEcrRepoName` deleted; `ensureEcrRepo` default param reverted; cost-gate call sites pass the flag | The silent-drop defect, the `.env` no-op, and an uncatalogued repo created on every deploy |
| `scripts/lib/lifecycle/manifest.ts` | `CCE_PAPERCLIP_ENABLED` added to `SYNTH_INPUT_ALLOWLIST` | A rollback re-synth would otherwise drop a deployed Aurora and EFS |
| `scripts/lib/lifecycle/teardown-plan.ts` | `currentAppStackNames` mirrors the gate; stale docstring fixed | Direct `DeleteStack` cannot delete a deletion-protected cluster |
| `scripts/lib/lifecycle/teardown-plan.test.ts` | +1 case | Proves the armed stacks take the cdk-destroy path |
| `scripts/lib/cost-gate.ts` | `paperclip` parameter on both functions; `FALLBACK_RANGES` reverted to pre-Paperclip; clause appended in **both** branches of `estimateLine` | The gate told every operator they were creating Aurora; the fallback-only pattern would have hidden it on the path that runs |
| `scripts/lib/cost-gate.test.ts` | +2 cases | Pins "only when armed" and "both branches" |
| `infra/lib/cost-guardrails-stack.ts` | Monthly budget default `650` -> `600` | Loosened the alarm by $50 for every deployment with no Paperclip; also restores agreement with the docstring at `:30` |
| `infra/lib/filesystem-stack.ts` | `retentionFromDays` deleted, replaced by a cast | Identity function; -8 lines |
| `infra/lib/database-stack.test.ts` | ASCII guard iterates `[network, database]` | NetworkStack's SG descriptions were not covered by any test |
| `.env.example` | `CCE_PAPERCLIP_ENABLED` documented | Its only documented arming path was `gh variable set` |
| `docs/diagrams/deploy-pipeline.md` | Two node texts + drift note | Both depicted nodes became false |
| `docs/diagrams/rollback-classes.md` | Drift note | New synth input recorded in the manifest |
| `docs/diagrams/teardown-decision-tree.md` | Drift note | `currentAppStackNames` gained a branch |

Commits: `e9de42b` (the gate and cost fixes), `3a078b8` (retention mapper),
`f1d6022` (ASCII guard coverage).

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| **Do not merge `CCE-Database` and `CCE-Filesystem`** | Fold into one `PaperclipStack`, as the plan's §14.6 actually specified and §22.4 permits | Both are `RETAIN` and Aurora is `deletionProtection: true`. Merged, an EFS create failure rolls back the Aurora create and orphans a deletion-protected cluster — a worse version of the EFS orphan that already happened (**M19**). Two stacks also keep independent phase-a deploys. |
| **Leave the `/claudeclaw/paperclip` secret ungated** | Gate it like the two stacks | It is already deployed to staging, `RETAIN`, with a fixed name. Removing it from the template makes CloudFormation `DELETE_SKIPPED` it, and Secrets Manager names are unique keys (unlike EFS name tags), so a later re-arm fails `ResourceExistsException`. User decision, taken deliberately. |
| **Leave `PaperclipSg` and its three SG rules ungated** | Remove the speculative 443 endpoints rule | Already live in staging. Removing them is a security-group diff on a deployed stack for zero benefit, and breaks `database-stack.test.ts:99-107`. `44aad84`'s message already records the rule-stability convention as deliberate. |
| **Keep `DatabaseOutputs` / `FilesystemOutputs` and the exported `*StackProps`** | Delete as one-implementation interfaces with zero importers | House style across nine stacks. Deleting them for two stacks only makes those two the odd ones out, and `interfaces.ts` is where Phase 2 reads the contract. |
| **Keep the CDK "prop echo" assertions** | Cut them as tests of CDK rather than of intent | They pin plan-declared invariants. `database-stack.test.ts:63` / `filesystem-stack.test.ts:67` (`not.toMatch(/FargateSg/)`) are the DL-2 guard and the highest-value lines in either file. |
| **Leave the tests' hardcoded `/claudeclaw/...` names** | Replace with `RESOURCE_NAMES.*` | Reversed mid-session. `RESOURCE_NAMES` derives from `CCE_NAME_SUFFIX` at import, so that assertion compares the constant with itself and would accept any rename. `constants.test.ts` uses literals or an explicit `buildResourceNames('')`. |
| **Leave `RESOURCE_NAMES.paperclipEcrRepo`** | Delete the dead constant with the rest of the ECR machinery | `infra/lib/constants.ts` is mapped to **two** diagrams; deleting one correct, suffix-aware line costs two diagram edits for nothing, and Phase 2 re-adds it verbatim. |
| **Leave `observability-stack.ts`'s copy of `retentionFromDays`** | Delete both identity functions | Equally dead, but outside this audit's scope. Recorded in the commit message so it reads as seen, not missed. |
| Read the flag from the `env` bag, not `process.env`, in `deploy.ts` | Read `process.env` to match `app.ts` exactly | Reading `process.env` while also adding a `?? ''` bag entry produces the one combination that silently disagrees with `app.ts`. Bag-sourced plus a `'1' | ''` normalization agrees in all four `.env` x inline combinations. Blanking an inline export is the house convention every other flag already follows. |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| A flag has five homes in this repo; list them | This log §3.1 + the `cdkEnvBag`, `manifest.ts` and `teardown-plan.ts` comments | yes |
| `cdk deploy` drops unmatched stack names silently when others match | `docs/diagrams/deploy-pipeline.md` drift note + the phase-a code comment | yes |
| The Paperclip ECR repo is created by whoever pushes the image, not by bootstrap | `deploy-pipeline.md` node text + `ecrLoginAndPush` comment | yes |
| Why the secret and `PaperclipSg` stay ungated | `e9de42b` commit message + this log §4.3 | yes |
| `RetentionDays` members are day counts | `filesystem-stack.ts` comment | yes |

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

## 6. Pending work

### 6.1 Smallest next action

Read CI on [PR #81](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/81):

```bash
gh pr checks 81 --repo Adams-Captial-Holdings-Ltd/Netzer-Labs
```

The Mermaid job is the one to look at first — the local renderer is unusable on
this machine (**M21**), so CI is the only signal for it. Nothing here deploys.

### 6.2 Immediate next steps

1. Merge [#81](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/81)
   into `development` once CI is green, then delete the branch (**P7**).
2. Resolve the **ECR gap** carried in §6.3 before Phase 2, since Phase 2 cannot
   start without an image in ECR and CI still has no step that creates the
   Paperclip repository.
3. Phase 1 steps 5-8: `cdk diff` the foundation stacks against the account, the
   one `docker buildx build --platform linux/arm64`, and the image push. All
   need an explicit deploy go-ahead; they create billable resources.

### 6.3 Blockers and open questions

- [ ] **GAP, unchanged and now sharper: nothing creates the Paperclip ECR
  repository.** It was previously created by `scripts/deploy.ts` on every local
  deploy; this session removed that, because it produced an empty, uncatalogued
  repo for an image nothing pushes. CI never had a step for it
  (`.github/workflows/deploy.yml` contains zero occurrences of "paperclip").
  Whoever implements the Phase 2 image push must create the repo in the same
  change, from `buildResourceNames().paperclipEcrRepo` (`constants.ts:52`,
  already suffix-aware) rather than a regex over `ECR_REPO_NAME`, and add it to
  `docs/out-of-band-catalog.json` so teardown removes it.
- [ ] **Question: should `plan-audit.md` P1-C4 be settled now?** The plan names
  the Paperclip secret fields two different ways (`agent_keys` /
  `dispatch_secret` vs `agent_keys_json` / `dispatch_token`). Phase 1 shipped
  the first set; Phase 2 bakes them into `EcsSecret.fromSecretsManager`, where a
  mismatch produces a task that cannot start. Suggested resolution: the shipped
  spelling wins, and the plan is corrected to match, per **P5**.
- [ ] Question: should the `updatedSince` patch be offered upstream? — user
  approved "patch our copy" only; upstreaming is optional follow-up.
- [ ] Open: `npm run setup` (Q11c) writes the GitHub OIDC variables into `.env`
  for local deploys and does not ask for the immutable-subject ids. A local
  `cdk deploy` with `CCE_CICD_ENABLED=1` and no ids would rewrite the prod
  trust policy back to the classic form. CI is the only deploy path in use;
  fix this if that changes.
- [ ] The immediately preceding session log,
  `2026-08-19-staging-deploy-green.md`, is still unmerged on
  `docs/staging-deploy-green-handoff`, so nothing on `development` can link to
  it and the feature's session index has an unlinkable row. Its §5 ledger is
  carried forward here verbatim, so no history is lost whichever merges first —
  but merge that docs branch and restore the link.
- [ ] `.gitignore` and `CLAUDE.md` still carry uncommitted edits from the
  concurrent documentation session, plus the user's untracked
  `handoff-connector-availability-2026-08-15.md` and
  `handoff-staging-deploy-2026-08-14.md`. Left for their owner per **P6**.
- [ ] Before Phase 4, the plan's dual-write and `PAPERCLIP_ENABLED`
  contradictions still need an author decision — see `plan-audit.md` P1-C6 and
  P1-C7.

### 6.4 Deferred, and why

- `observability-stack.ts:742` still has its own dead `retentionFromDays` —
  deferred because it is outside this Phase 1 audit's scope. One line of the
  same fix when someone is already in that file.
- Deleting `RESOURCE_NAMES.paperclipEcrRepo` — deferred because `constants.ts`
  is mapped to two diagrams and Phase 2 re-adds the name verbatim.
- Adding an Aurora/EFS line item to `scripts/cost-estimate.mjs` — deferred to
  Phase 2, when the Paperclip Fargate task lands and the figure is real. Until
  then the estimator branch carries the same appended note as the fallback.
- A whole-app synth check for non-ASCII SG descriptions — the guard now covers
  `NetworkStack`, `DatabaseStack` and `FilesystemStack`, marked with a
  `ponytail:` comment. Add if a fourth stack regresses.
- Paperclip ECS service, client, reconciler, ACL, tools, UI — later plan phases,
  in order.

### 6.5 Are we ready for Phase 2?

**No.** Phase 2's goal is `GET /api/health` returning 200 through the ALB backed
by the Aurora cluster. Five preconditions, none of them met:

| Precondition | State on 2026-08-19 |
|---|---|
| Phase 1 **deployed** (Aurora, EFS, log group) | **no** — code only, gate off, nothing created. Phase 1 step 6 is unstarted. |
| `cdk diff` read against the real account (step 5) | **no** — never run; needs a deploy go-ahead |
| The ARM64 question answered (step 7) | **no** — one `docker buildx build --platform linux/arm64` |
| The patched image in ECR (step 8) | **no**, and nothing creates the repository — see the ECR gap in §6.3. Step 8's "or retagged from the pinned upstream tag" is also **dead**: ADR 0010's amendment means the artifact must be built through `vendor/paperclip/Dockerfile`, or `updatedSince` is a silent no-op and DL-3's durable poll breaks. |
| `/claudeclaw/paperclip` populated | secret **exists** (deployed 2026-08-19) but carries `REPLACE_ME`; nothing under `scripts/lib/` populates it (zero matches for "paperclip") |

Plus one decision that should land before Phase 2 writes the task definition:
`plan-audit.md` P1-C4, the secret field names (§6.3).

What this session changed about Phase 2 readiness: arming the substrate now
actually arms it. Before these commits, `CCE_PAPERCLIP_ENABLED=1` in `.env`
would have produced a green deploy with no Aurora and no EFS, and Phase 2 would
have started by debugging a database that was never created.

The Phase 2 build sheet — new files, changed files, sequence, the four
guardrail CDK assertions (`DesiredCount` 1, no `ScalableTarget`, 0/100 healthy
percentages, `/api/health` on 3100), acceptance and rollback — is unchanged
from §6.5 of `2026-08-19-staging-deploy-green.md`, which remains the index for
it. That file is on `docs/staging-deploy-green-handoff`, not on this branch, so
it is named rather than linked; read it from that branch or after it merges.
Note **A10**: the plan is historical, and ADR 0010's amendment plus
`plan-audit.md` outrank it where they disagree.

## 7. Verification actually performed

Baseline recorded on the untouched branch before any edit (**P1**), and compared
by failing file **name**, never count (**A9**).

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | not run separately | **clean** |
| `npm test` | 192 files: 6 failed / 185 passed / 1 skipped; 2126 tests: 7 failed / 2113 passed / 6 skipped | 192 files: 6 failed / 185 passed / 1 skipped; 2129 tests: 7 failed / **2116** passed / 6 skipped. **Same six file names and same seven test names as baseline**, verified by name per **A9**. The +3 tests / +3 passing are exactly the three cases added this session. **No new failures.** |
| `npm run build` | not run | **clean** |
| `npm --prefix web run typecheck` | not run | **clean** |
| `npm --prefix web run build` | not run | **clean** |
| `npm run local:test:integration` | not run | **not run** — no Paperclip or runtime code changed this session; the disposable stack was not started |
| `node scripts/ci/docs-links.mjs` | not run | **OK** — 95 files, 807 internal links. Caught a real break first: this file linked the previous session log, which is not on this branch (§6.3). |
| `node scripts/ci/feature-knowledge.mjs` | not run | **OK** |
| `git diff --check` | not run | **clean** |
| `node scripts/ci/diagrams-drift.mjs` | OK (path validation) | **OK** — no drift across 13 changed files, with `GITHUB_BASE_REF=development` set to force PR-context checking |

The six baseline failures, by name — all in the documented environmental set
(**A9**), none touched by this work:
`scripts/ci/docs-links.test.ts`, `scripts/ci/feature-knowledge.test.ts`,
`scripts/ci/runnable-blocks.test.ts`, `scripts/release/sync-deprecations.test.ts`
(four collect-time `SyntaxError`), `scripts/release/buildspec-tag-normalization.test.ts`
(`spawnSync sh ENOENT`, and see **A21**), `scripts/lib/lifecycle/rollback-classes.test.ts`
(path separator).

Additional proof beyond the documented list:

| Proof | Result |
|---|---|
| `npx cdk ls`, flag unset | **15 stacks**, no `CCE-Database`, no `CCE-Filesystem` |
| `npx cdk ls`, `CCE_PAPERCLIP_ENABLED=1` | **17 stacks**, both present |
| `npx cdk ls CCE-Network CCE-Database`, flag unset | **exit 0**, `CCE-Database` silently absent — the defect, demonstrated |
| Targeted suites after the change (`cost-gate`, `teardown-plan`, `manifest`, `database-stack`, `filesystem-stack`) | **5 files / 62 tests passed**, up from 59 (3 new cases) |
| Repo-wide grep for `paperclipEcrRepoName` / `ensureEcrRepo(env,` | **0 matches** |

Not run, and why: `cdk diff` and any deploy — they need AWS credentials and
create or read billable state, and this session was explicitly not a deploy.
`scripts/ci/docs-mermaid.mjs` — unusable on this machine (**M21**); CI is the
signal. `npm run local:test:integration` — nothing it covers changed.

## 8. Environment state

- **Tools and services**: Node v24.19.0, npm 11.17.0, `aws-cdk` 2.1124.1
  (installed), Vitest 2.1.9, PowerShell on Windows 11.
- **Active processes**: none left running. No Docker container, no Floci, no
  Paperclip disposable stack was started this session.
- **Environment variables**: `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION` and
  `CCE_PAPERCLIP_ENABLED` were set **per-command only**, for `cdk ls`. Nothing
  was written to `.env`.
- **AWS**: no AWS call was made. No credentials were used.
- **GitHub variables**: unchanged. `CCE_GITHUB_IMMUTABLE_SUBJECT=1` is set;
  `CCE_PAPERCLIP_ENABLED` is deliberately **unset**; `CDK_DIFF_ROLE_ARN` is
  still missing since the org transfer (non-gating).
- **Shell caveat**: Git Bash here has no coreutils and no `npm` — see **A21**.
- **Uncommitted work left in the tree**: `.gitignore` and `CLAUDE.md` from the
  concurrent documentation session, plus the user's untracked
  `handoff-connector-availability-2026-08-15.md` and
  `handoff-staging-deploy-2026-08-14.md` — per **P6**, not staged, not touched.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Newest session handoff on this branch](2026-08-19-org-transfer-oidc-and-staging-deploy.md)
  — the immediately preceding session, `2026-08-19-staging-deploy-green.md`, is
  still unmerged on `docs/staging-deploy-green-handoff`
- [Implementation plan](../implementation-plan.md) and its [audit](../plan-audit.md)
- [ADR 0010 — Paperclip is the missions work engine](../../../adr/0010-paperclip-work-engine.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
