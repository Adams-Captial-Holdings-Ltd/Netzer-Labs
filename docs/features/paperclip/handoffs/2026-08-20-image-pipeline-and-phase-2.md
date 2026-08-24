---
feature: paperclip
document_role: session-handoff
status: current
observed_at: 2026-08-20
as_of_commit: 87a8fa8072008ece181d6226c0c989ab89d0e884
session_slug: image-pipeline-and-phase-2
supersedes: 2026-08-20-phase-2-readiness
---

# Session handoff: Phase 1.5 image pipeline and Phase 2 service

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-20 |
| Feature folder | `docs/features/paperclip/` |
| Branch worked on | `feature/paperclip-phase-1-5`, cut from `docs/paperclip-phase-1-5` at `87a8fa8` (= `development` `17fadd1` + the Phase 1.5 spec commit) |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `87a8fa8072008ece181d6226c0c989ab89d0e884` |
| Commit at session end | TBD |
| Pushed | TBD |
| PRs | TBD |
| Deployed | TBD |

## 2. Current state summary

IN PROGRESS — will be completed before the session closes.

The session was asked to (1) diagnose why prior sessions repeatedly carried
stale blockers and made one-path fixes, (2) implement Phase 1.5 (the Paperclip
image pipeline) per the accepted work definition, (3) implement Phase 2 (the
Paperclip service, `paperclip-stack.ts`) plus the phase b.5 migration
lifecycle, and (4) stop at the deployment authorization gate before any AWS
mutation.

Tree state found at session start and left alone per **P6**: uncommitted edits
to `.gitignore` and `CLAUDE.md`, plus untracked
`handoff-connector-availability-2026-08-15.md` and
`handoff-staging-deploy-2026-08-14.md` at the repo root. One anomaly was
corrected rather than preserved: `docs/features/paperclip/phase-1.5-image-pipeline.md`
had been moved (byte-identically, verified with `diff` against
`git show HEAD:…`) into `handoffs/`, which breaks the README's links and puts a
`document_role: decision` file in the session-log directory. The committed
location was restored and the stray identical copy deleted; no content was
lost.

## 3. Codebase understanding

To be filled as the source map is built.

## 4. Work completed

### 4.1 Tasks finished

Phase 1.5 (the image pipeline) only. Phase 2 (the service stack) is **not**
started; see §6.

1. `scripts/lib/lifecycle/cloud-build.ts` parameterized, not copied: the
   buildspec takes a Dockerfile path and a build context, both defaulting to
   the orchestrator's `-f Dockerfile .` so that path is byte-identical. The
   `test "$ARCH" = "arm64"` self-check sits OUTSIDE the substitution, so no
   consumer can lose it.
2. `contentImageTag()` added to the same module: the Paperclip image is tagged
   `paperclip-<first 12 of the git TREE HASH of vendor/paperclip>`.
3. `scripts/deploy.ts` phase a, inside the single `if (paperclipEnabled)`
   block: ensure the repo, look the content tag up in ECR, build through
   CodeBuild only on a miss, record the digest either way.
4. `.github/workflows/deploy.yml`: the mirror of 3, same gate, same tag, same
   skip, and reordered to build-load-inspect-then-push.
5. `scripts/lib/lifecycle/deploy-phases.ts`: a `paperclip-server` /
   `linux/arm64` `ContainerImageRecord` when both digest and repo URI exist.
6. `scripts/teardown.ts`: the cloud-build sweep loops over both ECR repo names,
   so the second project, role, role policy and log group are deleted.
7. `docs/out-of-band-catalog.json`: a `paperclip-cloud-build` row (a REPORT —
   item 6 is the delete).
8. Both mapped diagrams updated with `drift-gate:` notes in the same change.

### 4.2 Files modified

`scripts/lib/lifecycle/cloud-build.ts`, `scripts/deploy.ts`,
`scripts/lib/lifecycle/deploy-phases.ts`, `scripts/teardown.ts`,
`.github/workflows/deploy.yml`, `docs/out-of-band-catalog.json`,
`docs/diagrams/deploy-pipeline.md`, `docs/diagrams/teardown-decision-tree.md`,
and the new `scripts/lib/lifecycle/paperclip-image-pipeline.test.ts`.

Added in the review response: `scripts/lib/lifecycle/manifest.ts` and
`scripts/lib/lifecycle/rollback-classes.ts`.

### 4.3 Decisions made

- **The Paperclip image is content-addressed, not sha-addressed.** Tagging it
  with the app's short git sha (the orchestrator's scheme) meant every commit
  to unrelated application code triggered a fresh ~10 minute native-ARM
  CodeBuild, a second git-archive upload to the state bucket, and another
  image layer set in a repo with no lifecycle policy — and, on CI, a full
  emulated `apt-get` plus `tsc` over the Paperclip server under QEMU. Under
  Part D (Paperclip provisions on every install at every paid tier) that is a
  mandatory ten-minute rebuild on every deploy in every customer account,
  forever. The tag is git's own tree hash for `vendor/paperclip` because that
  is exactly the bytes `git archive HEAD` ships to CodeBuild, it covers any
  file later added to the directory, and it is ONE command both drivers run
  identically (`git rev-parse HEAD:vendor/paperclip`) rather than two
  hand-matched hash pipelines that would drift.
- **The skip records the existing digest.** On a tag hit the deploy reads the
  digest straight out of ECR and still writes the manifest record, so
  requirement 4 holds on both branches and re-running an armed deploy is a
  genuine no-op.
- **No ECR lifecycle policy was added.** With content addressing the repo
  gains an image only when the vendored content changes, and old digests are
  exactly what a rollback resolves against. Revisit only if a repin cadence
  ever makes the count non-trivial.
- **CI builds with `--load`, inspects, then pushes.** `--push` put the image
  in ECR and moved `:latest` onto it *before* the architecture check could
  fail the job; the requirement's guarantee is that a wrong-architecture image
  can never be pushed at all.
- **`--build-arg DEPLOY_TIER` is left on the Paperclip build.** The vendored
  Dockerfile declares no matching `ARG`, so Docker warns and ignores it. It is
  inert, which is also why it correctly does not participate in the content
  tag; removing it would mean a second buildspec parameter for a warning.
- **No `:latest` in the Paperclip repo, on either driver** (`pushLatest: false`
  on the CodeBuild path, no tag/push pair on the CI path). The orchestrator
  repo keeps its `:latest` because things already depend on it. This one is
  new, is created with no lifecycle policy, and has exactly one legitimate
  consumer — a task definition pinned to the digest in the manifest. A
  convenient floating tag sitting there is what the Phase 4 author reaches for,
  which is the failure requirement 5 exists to prevent. Not publishing it also
  removes the CI skip path's ability to leave `:latest` trailing the content
  tag, since the skip returns before any tagging.
- **The orchestrator image rollback does not verify the Paperclip digest.**
  `collectPrivateEcrDigests` now skips the `paperclip-server` record. The image
  rollback class re-points one service, the orchestrator; verifying a digest in
  a repo teardown deletes with `--force` and Phase 9 will churn would abort a
  rollback of a **running** service over an image no service consumes yet. The
  record stays in the manifest. Phase 4, which gives Paperclip a service, must
  verify it on **that** path rather than deleting the skip.
- **`PAPERCLIP_CONTAINER_NAME` lives in `manifest.ts`.** The task family
  `${app}-paperclip` and the container name are predictions of what
  `infra/lib/paperclip-stack.ts` will choose, made a phase before it exists.
  Two files already compare against the name and Phase 4's rollback will be the
  third, so it is one exported constant carrying the note about which places
  must change together.

### 4.4 Durable facts promoted out of this log

- The Paperclip image's content depends on exactly the tracked contents of
  `vendor/paperclip`; nothing else in the repository can change it.
- There are TWO cloud builds once Paperclip is armed, one per ECR repo, and
  every deterministic name teardown sweeps derives from the repo name.

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

### 5.10 Appended this session (2026-08-20, image pipeline and Phase 2)

- **Shell that has never run is not evidence, and a grep over it is not a
  test.** Both this phase's shell artifacts were verifiable without AWS all
  along, by extracting them from source and running them against argv-recording
  shims (§7.1). That took less time than the review that demanded it. Prefer it
  to a `toContain` over the same string.
- **`npx` swallows piped stdout in this environment.** `npx tsx -e '…console.log'`
  prints to a terminal but yields an empty string through a pipe, a file
  redirect, or `$( )`. `node ./node_modules/tsx/dist/cli.mjs` behaves. Cost 20
  minutes of debugging a harness that was already correct.
- **A digest that "does not match" a digest may be its own child.** An OCI
  image index and its per-platform manifests have different digests by
  construction. Before raising a pin mismatch, check whether the second digest
  is the arm64 child of the first — §6.3 was withdrawn for exactly this.

## 6. Pending work

**Blocking Phase 1.5 sign-off — none of this can be done from a session with
no AWS access, and none of it should be assumed done:**

1. The **armed staging deploy** required by §5 of the work definition. Both
   shell paths have now been executed locally against shims, so the command
   sequence and the abort-before-push ordering are demonstrated (§7.1); what
   remains unproven is everything only a real build can show — that
   `vendor/paperclip/Dockerfile` builds at all on an ARM CodeBuild host, that
   `--load` of a foreign-platform image succeeds on the amd64 CI runner, and
   that an emulated `tsc` of the Paperclip server finishes inside the job's
   `timeout-minutes: 60`. Proof
   owed: an arm64 image in `claudeclaw-staging-paperclip`, a digest from
   `aws ecr describe-images` that `docker manifest inspect` confirms as
   `linux/arm64`, and a SECOND armed deploy on an unrelated commit that logs
   `already in ... skipping the build` and starts no CodeBuild run.
2. The **teardown dry-run** listing the Paperclip CodeBuild project, its role
   and its log group as things it will delete.
3. A **full `npm test`** against a pre-edit baseline, compared by failing file
   **name** (P1/A9). A scoped baseline for the five files this phase touches
   was taken on 2026-08-20 (§7) and is unchanged by the edits, but that is not
   the P4 gate.

   ~~Per A22, re-verify the pinned base digest… the two do not match.~~
   **WITHDRAWN — this was a false alarm and must not cost another session an
   investigation.** A22 in §5 of this document records the *index* digest as
   `sha256:6b9daa3c…` and `sha256:6ab3c816…` as the `linux/arm64` **child
   manifest inside it**. `vendor/paperclip/Dockerfile:7` pins the index, which
   is exactly what lets an ARM64 builder select that child. The two differing
   is correct. What was actually wrong was the shorthand in the work
   definition's §3 table and in the feature README, which read as if
   `6ab3c816…` were the pinned digest; both have been corrected. The standing
   A22 obligation is unchanged and unrelated: re-verify the index still
   carries an arm64 child on every **re-pin**.
4. **Split the commit.** The working tree also carries Phase 1 work and
   unrelated files. Phase 1.5's acceptance is "both drivers changed in the
   same commit", which is only reviewable if the phases are separate commits.
   Belonging to **Phase 1, not this commit**: `src/lib/paperclip/types.ts`,
   `tests/contract/`, the `tests/contract/**/*` include added to
   `tsconfig.json`, the `tests/**/*.integration.test.ts` include added to
   `vitest.integration.config.ts`, and `paperclipAdminRequest` in
   `tests/fixtures/paperclip-bootstrap.ts`. Belonging to **neither**: the
   `fix-windows-test-suite/` line in `.gitignore`, the handoff section added to
   `CLAUDE.md`, and the two untracked handoffs at the REPO ROOT
   (`handoff-connector-availability-2026-08-15.md`,
   `handoff-staging-deploy-2026-08-14.md`) — which violate the very rule that
   `CLAUDE.md` edit adds, since handoffs belong under
   `docs/features/<slug>/handoffs/`.

Phase 2 (the service stack) is not started.

## 7. Verification actually performed

Executed, with results:

- `npm run typecheck` (`tsc --noEmit`, after deleting `tsconfig.tsbuildinfo`
  so nothing was served from the incremental cache): **clean, exit 0, no
  output**. An earlier run in the same session reported 6 errors, all six in
  `tests/contract/paperclip-routes.paperclip.integration.test.ts` — untracked
  Phase 1 work, touched by nothing in this phase, and edited by a concurrent
  session between the two runs. It was attributable either way: re-running the
  identical compiler options with only `tests/contract/**/*` dropped from
  `include` was already zero errors while the full run was red.
- `npx vitest run scripts/lib/lifecycle/paperclip-image-pipeline.test.ts`:
  25 passed.
- `npx vitest run scripts/lib/lifecycle/{cloud-build,deploy-phases,teardown-plan}.test.ts`:
  73 passed, all three files **unmodified** — which is the evidence that the
  orchestrator build path did not move.
- `node scripts/ci/diagrams-drift.mjs .`: path validation clean; `driftFailures()`
  driven directly over this working tree's changed-file list returns `[]`.
- `node scripts/ci/feature-knowledge.mjs .` and `docs-links.mjs .`: both OK.
  `docs-mermaid.mjs` reports 16 failures, all `spawnSync npx ENOENT` across
  files this phase never touched — the renderer cannot start in this
  environment, so that gate is unevaluated, not passed.
- `npx vitest run scripts/` (a SCOPED run, which is not the P4 gate): 862
  passed, 1 failed, 5 files failed. The five are the Windows-lane set —
  `ci/docs-links`, `ci/feature-knowledge`, `ci/runnable-blocks` and
  `release/sync-deprecations` each throw `SyntaxError` at the `import()` of a
  Windows absolute path in their own line 2-6, and `lifecycle/rollback-classes.test.ts:574`
  compares `/tmp/fake/cdk.out` against `\tmp\fake\cdk.out`. All five files are
  unmodified by this phase and none of them imports anything it changed, but
  see §6.3: without a recorded pre-edit baseline that is attribution by
  inspection, not by measurement.

**Not** performed, and not to be read as performed: everything in §6. In
particular no AWS call of any kind was made, and no full `npm test` baseline
was taken, so the claim "the 5 failing files are pre-existing Windows-lane
breakage" remains an assumption.

### 7.1 Appended 2026-08-20 (review response: the shell was executed)

The review's blocking finding was that the two riskiest artifacts in the
change — the buildspec string and the CI shell block — had never run, and that
a source-grep test can prove a string is present but not that a sequence of
commands is correct. AWS is still out of reach, so both were **extracted from
the committed sources and executed** against `docker`/`aws` shims that record
their argv. That proves the command sequence and the abort-before-push
ordering; it does not prove the image builds, which still needs §6.1.

Reproduce: emit the buildspec with
`node ./node_modules/tsx/dist/cli.mjs -e "…cloudBuildBuildSpec(…)"` (note
`npx` swallows piped stdout on this box), strip the `      - ` prefixes into a
`set -e` script, extract the workflow step's `run:` block with `awk`, and put
shims that `echo "$*" >> $TRACE` ahead of both on `PATH`.

| Case | Result |
|---|---|
| Paperclip buildspec, builder reports `arm64` | exit 0; `docker build … -f vendor/paperclip/Dockerfile vendor/paperclip` → `docker inspect` → `docker push <content tag>`. No `:latest`. |
| Paperclip buildspec, builder reports `amd64` | **exit 1 after the inspect, with no `docker push` in the trace at all.** Requirement 6 demonstrated rather than asserted, on the CodeBuild driver. |
| Orchestrator buildspec, defaults | exit 0; `-f Dockerfile .`, then push of both the tag and `:latest` — unchanged. |
| CI step, cache miss, `arm64` | exit 0; `describe-images` → `buildx build --load` → `image inspect` → `push <content tag>`. No `:latest`. |
| CI step, cache miss, `amd64` | **exit 1 with `::error::…refusing to push.` and no `docker push` in the trace.** |
| CI step, cache hit | exit 0, `(build skipped)`, **zero `docker` invocations**. |
| Tag agreement | CI shell `paperclip-e8d7fb892222`; `contentImageTag()` `paperclip-e8d7fb892222`. Identical, so neither driver rebuilds the other's image. |

> **SUPERSEDED (same day, later session).** The three `CI step` rows above
> describe the emulated `buildx` mechanism the CI driver used at the time of
> this handoff. It has since been replaced: the workflow step runs
> `scripts/ci/paperclip-image.ts`, a thin CLI over the same
> `scripts/lib/lifecycle/cloud-build.ts` the local driver uses, so both drivers
> now produce the image on native ARM64 CodeBuild and the first three rows of
> this table cover CI too. The tag-agreement row still holds, and holds more
> strongly: there is now one `contentImageTag()` call, not a shell pipeline
> matched to it by hand. See requirement 8 in
> `docs/features/paperclip/phase-1.5-image-pipeline.md`.

Also executed this session:

- `npx cdk ls`: **15** stacks with `CCE_PAPERCLIP_ENABLED` unset, **17** with it
  `=1`. That is §5's `cdk ls` item, performed rather than reasoned about.
- `npx vitest run` over the five lifecycle files this phase touches, **before
  any edit** and again after: both runs `1 failed | N passed`, the single
  failure being `rollback-classes.test.ts:574` comparing `/tmp/fake/cdk.out`
  against `\tmp\fake\cdk.out`. Same file **name**, same test name, before and
  after (A9). That is a real baseline for these files; it is still not the
  full-suite P4 gate.

## 8. Environment state

No AWS resource was created, changed or deleted. Nothing was committed or
pushed. The branch is `feature/paperclip-phase-1-5`; `production` is
unaffected. Staging still has `CCE_PAPERCLIP_ENABLED` unset, so the gated
block does not run there yet.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](2026-08-20-phase-2-readiness.md)
- [Phase 1.5 work definition](../phase-1.5-image-pipeline.md)
- [Implementation plan](../implementation-plan.md) and its [audit](../plan-audit.md)
- [ADR 0010 — Paperclip is the missions work engine](../../../adr/0010-paperclip-work-engine.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
