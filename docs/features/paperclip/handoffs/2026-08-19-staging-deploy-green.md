---
feature: paperclip
document_role: session-handoff
status: current
observed_at: 2026-08-19
as_of_commit: 747cf8b
session_slug: staging-deploy-green
supersedes: 2026-08-19-org-transfer-oidc-and-staging-deploy
---

# Session handoff: staging deploy green, Paperclip substrate gated off

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-19 |
| Feature folder | `docs/features/paperclip/` |
| Branch worked on | `docs/staging-deploy-green-handoff` (this file); the work it records shipped on `fix/oidc-immutable-subject-claims` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none directly — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `bfe870724dc38ee8cd470b4a44ce95e121e22f21` |
| Commit at session end | `747cf8b` on `development`, `e8ba485` on `staging` |
| Pushed | yes |
| PRs | [#77](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/77) → `development`, [#78](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/78) → `qa`, [#79](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/79) → `staging` — all merged |
| Deployed | **yes — staging, green**, run [32323984500](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/runs/32323984500) |

## 2. Current state summary

Staging deploys again, and `https://staging.pgnos.ai` is serving.

The session began with the staging deploy red since the repository moved to the
`Adams-Captial-Holdings-Ltd` org. Three distinct faults were found and fixed,
in the order they surfaced — each one hidden behind the previous:

1. **OIDC subject claims.** The org mints immutable subjects carrying numeric
   owner and repository ids. The trust policy is `StringEquals` with wildcards
   deliberately rejected, so the classic-form subjects the CDK generated could
   never match. Every deploy died at `Not authorized to perform
   sts:AssumeRoleWithWebIdentity`, which reads like an AWS permissions fault
   and was a GitHub-side format change.
2. **Non-ASCII security group descriptions.** With OIDC fixed, the deploy
   reached CloudFormation and `CCE-STAGING-Filesystem` rolled back: EC2 rejects
   a `GroupDescription` outside ASCII, and both Paperclip stacks used an em
   dash. The rollback abandoned a `RETAIN`-marked EFS and log group.
3. **The real problem — ungated substrate.** `DatabaseStack` and
   `FilesystemStack` were wired unconditionally in `infra/bin/app.ts` although
   nothing consumes them (`void database; void filesystem;`). That put
   first-time Aurora and EFS creation on the path of every routine app deploy.
   The orchestrator had in fact shipped fine and was running 1/1 the entire
   time; the pipeline reported failure on infrastructure nobody was using.

Fault 3 is why the session felt like a cascade: faults 1 and 2 were real, but
the coupling in fault 3 is what turned an unrelated infrastructure experiment
into a blocker for shipping application code.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- GitHub mints OIDC subjects in two non-interchangeable forms:
  `repo:<owner>/<repo>:...` and `repo:<owner>@<owner_id>/<repo>@<repo_id>:...`.
  Which one you get is a property of the org/enterprise, not the workflow, and
  it changed under this repository when it was transferred. Read it from
  `sub_claim_prefix` in
  `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`, or decode the
  `sub` of a token a run actually minted.
- **Only a production deploy rewrites `ClaudeClawGitHubDeploy`.**
  `iam-stack.ts` gates the role on `!isStagingDeploy` and staging sets
  `CCE_NAME_SUFFIX`, so staging deploys never touch the trust policy. Proven
  from the synthesized artifacts: the 15 staging templates contain zero
  `ClaudeClawGitHubDeploy`; the prod template contains it as
  `GithubDeployRoleB0CF66A5`.
- EC2 rejects non-ASCII only in security group descriptions. It is **not** a
  global CloudFormation constraint: 9 live CloudWatch alarms in this account
  carry em dashes in their descriptions and are deployed and healthy. A
  repo-wide em-dash purge would have been a large diff fixing nothing.
- A rolled-back stack is not a clean slate. `RemovalPolicy.RETAIN` makes
  CloudFormation log `DELETE_SKIPPED` and abandon the resource. EFS names are
  tags rather than unique keys, so a naive retry creates a *second* filesystem
  and bills for both.
- The Paperclip bootstrap fixture fails closed on a **stale** stack, not only a
  missing one (`Active Paperclip integration keys exist without the in-memory
  credential cache`). The disposable stack must be reset per test process.
- The pinned mermaid renderer does not work on this Windows machine: it fails
  all 15 blocks including ones CI renders successfully. Local
  `scripts/ci/docs-mermaid.mjs` output is not a usable signal here; CI is.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `infra/bin/app.ts` | Stack wiring | Where the ungated Paperclip stacks coupled experimental infra to every app deploy; now behind `CCE_PAPERCLIP_ENABLED` |
| `infra/lib/github-oidc.ts` | Fail-closed OIDC trust resolution | Generated the wrong subject form for this org; now emits either |
| `infra/lib/{database,filesystem}-stack.ts` | Paperclip Aurora + EFS | Both carried the em dash that rolled the deploy back |
| `infra/lib/iam-stack.ts` | Creates `ClaudeClawGitHubDeploy` | Unchanged; its `!isStagingDeploy` gate is why staging never rewrites the trust |
| `.github/workflows/deploy.yml` | Staging/prod deploy | Forwards the subject ids and the Paperclip flag, both from Actions variables |
| `docs/diagrams/architecture-compute.md` | Drift-gate-mapped diagram | `infra/bin/app.ts` is mapped to it; any change there needs a verification note |

### 3.3 Patterns and conventions to follow

- OIDC trust stays fail-closed and exact-match: no wildcard reaches a subject,
  and the ids are digits-only for the same reason.
- New deploy knobs are opt-in through Actions `vars`, matching how
  `CCE_PUBLIC_ACCESS`, `CCE_EMAIL_FROM` and the rest are forwarded.
- Infrastructure nothing consumes yet ships behind a flag, so a failure in it
  cannot report as a failure to ship application code.
- `docs/diagrams/architecture-compute.md` carries a running `drift-gate:` HTML
  comment. When a mapped source changes without changing a depicted flow,
  prepend a verification note in the established form rather than redrawing.

## 4. Work completed

### 4.1 Tasks finished

- [x] Diagnosed the red staging deploy to the exact claim, from a decoded token
  and the OIDC customization API rather than by inference.
- [x] `resolveGithubOidcTrust` accepts `CCE_GITHUB_OWNER_ID` /
  `CCE_GITHUB_REPO_ID` and emits the id-bearing subject; ids are digits-only so
  a wildcard or an un-interpolated `${{ }}` cannot reach a trust subject.
- [x] `deploy.yml` forwards the ids when `CCE_GITHUB_IMMUTABLE_SUBJECT == '1'`.
- [x] Verified the live IAM trust policy matches the generator byte-for-byte,
  so no deploy flips it back.
- [x] Fixed the em dash in **both** Paperclip stacks, with a synth assertion in
  each stack's test file, verified to fail on the em dash and pass without it.
- [x] Gated `DatabaseStack`/`FilesystemStack` behind `CCE_PAPERCLIP_ENABLED`,
  forwarded from an Actions variable so arming it is config, not a code change.
- [x] Repaired the vendored plan's mermaid block (actor named `LOOP`, a
  reserved keyword) and added the drift-gate note for `infra/bin/app.ts`.
- [x] Cut three speculative guards on the user's instruction not to
  over-engineer: 176 added lines → 83, generated policy unchanged.
- [x] Promoted through the full ladder and **deployed staging green**.

### 4.2 What shipped, commit by commit

All merged via [#77](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/77)
→ `development` (`747cf8b`), [#78](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/78)
→ `qa` (`d951a1f`), [#79](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/79)
→ `staging` (`e8ba485`).

| Commit | What |
|---|---|
| `07a2570` | `fix(ci)`: match the org's immutable OIDC subject claims |
| `44c9b34` | `refactor(ci)`: cut the OIDC id guards down to what earns its place |
| `04c9f90` | `docs(paperclip)`: consolidate the feature folder and vendor the plan (a concurrent session's work, split back out — see M17) |
| `e32ee04` | `docs(paperclip)`: record the OIDC session and the cleared deploy blocker |
| `573763e` | `fix(docs)`: scope the trust-policy rewrite to production deploys |
| `dac255a` | `fix(infra)`: keep security group descriptions ASCII |
| `4f76fc4` | `chore(infra)`: mark the SG-description guard's known ceiling |
| `bc4909b` | `feat(infra)`: gate the Paperclip stacks behind `CCE_PAPERCLIP_ENABLED` |
| `9676c13` | `chore(ci)`: forward `CCE_PAPERCLIP_ENABLED` from an Actions variable |
| `19ab491` | `docs(diagrams)`: record the Paperclip gate, unbreak the plan's mermaid |

### 4.3 What was deployed, and its verified state

Deploy run [32323984500](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/runs/32323984500),
push to `staging` at `e8ba485`, all three jobs green, `Build + CDK Deploy +
Smoke` 17m30s.

| Check | Verified result |
|---|---|
| `Configure AWS credentials (OIDC)` | **pass** — the step that failed in run 32279945039 |
| ECR login, ARM64 buildx, image push | pass |
| Public connector readiness | pass (`CCE-PUBLIC-READY` stage present on `claudeclaw-staging-public-tunnel`) |
| CDK deploy | pass — 15 stacks, all `UPDATE_COMPLETE` |
| `CCE-STAGING-Database` / `-Filesystem` | **absent**, as the gate intends |
| ECS service | `ACTIVE`, desired 1 / running 1, task definition `claudeclaw-staging-orchestrator:8` (was `:7`), 1 deployment — no rollback |
| `https://staging.pgnos.ai/health` | `{"status":"ok","uptime":201s}` — uptime confirms this deploy's task, not a survivor |
| `https://staging.pgnos.ai/` | HTTP 302 (redirect to login, expected) |

AWS cleanup completed by the user: the orphaned EFS `fs-08f70326911d2ae49`, the
log group `/claudeclaw-staging/paperclip`, and the `ROLLBACK_COMPLETE`
`CCE-STAGING-Filesystem` stack are all gone. **No Aurora cluster was ever
created** — `CCE-STAGING-Database` was never reached, so the retained,
deletion-protected cluster is still ahead, not behind.

### 4.4 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Match the immutable subject rather than disable it org-side | Ask an org owner to turn the setting off | User chose to match. The id-bearing form is the stronger binding — a repo deleted and recreated under the same name cannot inherit deploy trust — and needs no org policy change. |
| Opt-in per repo via `CCE_GITHUB_IMMUTABLE_SUBJECT` | Always send the ids | Always-on would lock out any fork whose org still mints classic subjects, exactly as this repo was locked out. |
| Ids digits-only | Reuse the existing `rejectWildcards` (1 line) | Digits-only is strictly stronger on an IAM trust subject: wildcards reject only `*` and `?`. Disclosed as a deliberate 4-line cost. |
| Dropped the both-or-neither and `@`-in-name guards | Keep as fail-closed insurance | Unreachable through the only caller; the `@` check policed a spelling that would have worked. Cut on the user's explicit instruction. |
| Fixed the em dash in both stacks, not just the failing one | Fix only `filesystem-stack.ts` | `database-stack.ts` carried the identical character and would have failed the same way on the next stack. |
| Did **not** purge em dashes repo-wide | Global ASCII sweep | 9 live CloudWatch alarms carry non-ASCII descriptions and deploy fine; the constraint is EC2-specific. |
| Gate the Paperclip stacks | `cdk diff` review each time; tier-gate | Offered early and declined in favour of diff-first, then adopted after the stacks failed a real deploy and orphaned an EFS. Default off decouples experimental infra from routine app deploys. |
| Committed the concurrent session's doc work as its own commit | Leave it; revert it | It had been staged into the shared index and swept into one of this session's commits. Splitting it back out keeps each commit describing what it contains. |
| Did not run a local `cdk diff` before the deploy | Set up the full staging env and diff | Without CI's connector-readiness probe a local diff shows the cloudflared sidecar being removed — alarming and wrong. Replaced with synth-level proof (template scans, trust-policy diff against live IAM). |

### 4.5 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The two OIDC subject forms and how to tell which you get | `docs/github-to-aws.md` | yes |
| Trust rewrite is production-only (`!isStagingDeploy`) | `docs/github-to-aws.md`, `deploy.yml` comment | yes |
| Why the Paperclip stacks are gated | `infra/bin/app.ts` comment, `deploy.yml` comment | yes |
| SG descriptions must stay ASCII | synth assertions in both stack test files | yes |

## 5. Carried-forward mistakes, assumptions and precautions

> Copied forward from the template seed (new feature folder), then appended to.
> Nothing is deleted. An entry that is fixed is marked `RESOLVED (<commit>)`
> and stays.

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

### 5.5 Appended this session (2026-08-19)

| # | Entry | Detail |
|---|---|---|
| M13 | The single most load-bearing document in this feature — the 822 KB implementation plan — was left in a Claude temporary scratchpad for a day, and the feature README recorded that as an acceptable state ("an external session artifact (not tracked in this repository)"). | A temp directory is not a location. Anything a future phase must be built from belongs in the repository the moment it is written, even if it is large and even if it is historical. RESOLVED (this session). |
| M14 | The first session log was written before the feature folder existed and then never brought into the framework: untracked, no frontmatter, absent from the session index. | The origin record of a feature is the one log most likely to be needed and least likely to be reproducible. When a feature folder is created after work has started, back-fill the earlier logs into it in the same session. RESOLVED (this session). |
| M15 | The README and HANDOFF drifted three commits behind the code they described — the README still said "first-milestone validation only" after Phase 1 infrastructure landed, and the HANDOFF called a merged PR open. | Phase-completion commits must update the canonical two files in the same commit, not in a later documentation pass. |
| P12 | An adversarial audit of a plan is worth as much as the plan and must be stored beside it. | The audit found two cited paths that do not exist and a five-citation cluster with a systematic +92-line offset anchoring an architecture argument. A plan without its audit reads as more certain than it is. |
| A10 | The implementation plan is **historical**, not current. ADR 0010's amendment and `plan-audit.md` both outrank it. | Its "Paperclip source changes required: **None**" premise is dead — the harness runs a patched artifact. Do not quote the plan as a live constraint. |

### 5.6 Appended this session (2026-08-19, OIDC and staging deploy)

| # | Entry | Detail |
|---|---|---|
| M18 | `infra/lib/{database,filesystem}-stack.ts` described their security groups with an em dash. EC2 rejects `GroupDescription` outside ASCII, so `CCE-STAGING-Filesystem` rolled back on first create. | The repo's prose style uses em dashes everywhere, so this will recur. Both stacks carried it; fixing only the one CloudFormation named would have failed again on the next stack. Guarded by a synth assertion in both stack test files. RESOLVED (this session). |
| M19 | The rolled-back `CCE-STAGING-Filesystem` left **orphans**: EFS `fs-08f70326911d2ae49` and log group `/claudeclaw-staging/paperclip` are `RemovalPolicy.RETAIN`, so CloudFormation logged `DELETE_SKIPPED` and abandoned them. | A rolled-back stack is not necessarily a clean slate. EFS names are tags, not unique keys, so a retry silently creates a *second* filesystem and bills for both. Check for orphans after any rollback of a RETAIN-bearing stack. |
| A14 | A staging deploy does **not** touch `ClaudeClawGitHubDeploy`: `iam-stack.ts` gates the role on `!isStagingDeploy` and staging sets `CCE_NAME_SUFFIX`. | Verified in source. Only a production deploy regenerates that trust policy, so an IAM hand-fix survives staging deploys indefinitely. This corrects the broader claim first written in P13. |
| M16 | After the org transfer, the trust policy was updated to the new **repo path** and the deploy still failed — a second session lost to an `AssumeRoleWithWebIdentity` error that reads like an AWS permissions problem. | An org transfer can change the claim **format**, not merely its contents. Decode the token's real `sub` before touching IAM. RESOLVED (this session). |
| M17 | This session committed with explicit `git add <paths>`, believing that scoped the commit — but a concurrent agent had staged its own work into the **shared index**, and `git commit` committed the index, sweeping ~900 KB of another session's docs into a commit whose message described a small refactor. | `git add <paths>` scopes what *you* add, not what the commit contains. When another process may share the working tree, verify with `git status`/`git diff --cached` immediately before committing, or use `git commit <paths>`. Corrected by splitting the commit in two. RESOLVED (this session). |
| P13 | Set `CCE_GITHUB_IMMUTABLE_SUBJECT` **before the next production deploy**. Only the prod IAM stack creates this role (`iam-stack.ts` gates on `!isStagingDeploy`), so a prod deploy with the variable unset rewrites a hand-patched trust policy back to the classic form. Staging deploys never touch it. | The fix has two halves with a required order; reversing it re-creates the outage and looks like a regression. First stated here without the prod-only qualifier — corrected against the code, per **P5**. |
| P14 | When an OIDC assume-role fails, decode the token's real `sub` before changing IAM. | The error names AWS; the cause was on GitHub's side. |
| A11 | `Adams-Captial-Holdings-Ltd/Netzer-Labs` mints **immutable** OIDC subjects: `repo:Adams-Captial-Holdings-Ltd@318461635/Netzer-Labs@1324639154:...`. | Verified twice on 2026-08-19 — a decoded token from run `32280530601`, and `sub_claim_prefix` from the OIDC customization API. Re-verify if the repo moves again. |
| A12 | The deploy workflow needs no repository or environment **secrets**; it reads only `vars`, all of which survived the transfer. | Verified with `gh variable list` and the per-environment variables/secrets API. `CDK_DIFF_ROLE_ARN` is still absent and still only affects the scheduled drift workflow. |
| A13 | The live `ClaudeClawGitHubDeploy` trust policy now lists the four id-bearing subjects and matches the fixed generator's output exactly. | Verified with `aws iam get-role` against the regenerated policy on 2026-08-19, so the next `cdk deploy` is a no-op on the trust rather than a flip-back. |
| Trap | A **production** `cdk deploy` rewrites `ClaudeClawGitHubDeploy`'s own trust policy; staging deploys skip the role entirely (`iam-stack.ts` gates on `!isStagingDeploy`). | [github-to-aws.md](../../../github-to-aws.md), `infra/lib/iam-stack.ts` |
| Trap | Phase 1's Aurora and EFS stacks have **no tier gate**, so Tier 0 staging provisions the same retained, deletion-protected cluster as production. | `infra/bin/app.ts`, `infra/lib/database-stack.ts` |
| Trap | The Paperclip bootstrap fixture aborts on a **stale** stack (`Active Paperclip integration keys exist without the in-memory credential cache`), not only a missing one. Reset the disposable stack per run rather than reusing one a previous session left up. | `tests/fixtures/paperclip-bootstrap.ts`, [README §8](../README.md) |

### 5.7 Appended this session (2026-08-19, staging deploy green)

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

## 6. Pending work

### 6.1 Smallest next action

Nothing is blocked. When the Paperclip substrate is wanted, arm it
deliberately with someone watching:

```bash
gh variable set CCE_PAPERCLIP_ENABLED --body 1 --repo Adams-Captial-Holdings-Ltd/Netzer-Labs
```

then re-run the staging deploy. That creates the Aurora Serverless v2 PG17
cluster and the EFS filesystem — both `RemovalPolicy.RETAIN` with
`deletionProtection: true`, and neither is tier-gated, so Tier 0 staging gets
the same cluster production would.

### 6.2 Immediate next steps

1. Phase 1 steps 6–8: `cdk diff` the foundation stacks against the account,
   answer the ARM64 question with one
   `docker buildx build --platform linux/arm64` of the Paperclip checkout, and
   push the patched image to the Paperclip ECR repo.
2. Then Phase 2 (Paperclip service online), which wires the substrate to a
   consumer and can flip the gate's default.
3. Production has **not** been deployed. The next prod deploy is the one that
   regenerates the OIDC trust policy; `CCE_GITHUB_IMMUTABLE_SUBJECT=1` is
   already set, and the generated policy was verified identical to live IAM, so
   it is a no-op on the trust.

### 6.3 Blockers and open questions

- [ ] **GAP — TO BE VERIFIED: CI never creates the Paperclip ECR repository.**
  `paperclipEcrRepo` (`claudeclaw[-suffix]-paperclip`) is created only by
  `scripts/deploy.ts` (`:334`, `:967`, via `paperclipEcrRepoName()` at
  `:958`) — the **local** deploy path. `.github/workflows/deploy.yml` contains
  zero occurrences of "paperclip": its "Ensure ECR repo exists" step handles
  only `steps.cfg.outputs.ecr_repo`, the orchestrator. Confirmed against the
  account on 2026-08-19: the only repositories are
  `claudeclaw-orchestrator`, `claudeclaw-staging-orchestrator` and the CDK
  assets repo — **no Paperclip repo exists in either environment**.
  Phase 1 step 8 (push the patched Paperclip image) and Phase 2 (which
  requires "the image is in ECR") therefore have nothing to push to from CI.
  *To verify:* re-read both paths and decide whether CI should gain a second
  ensure-step or whether the image push is deliberately a local-only operation.
  Do this before starting Phase 2.
- [ ] Question: should the `updatedSince` patch be offered upstream? — user
  approved "patch our copy" only; upstreaming is optional follow-up.
- [ ] Open: `npm run setup` (Q11c) writes the GitHub OIDC variables into `.env`
  for local deploys and does not ask for the immutable-subject ids. A local
  `cdk deploy` with `CCE_CICD_ENABLED=1` and no ids would rewrite the prod
  trust policy back to the classic form. CI is the only deploy path in use;
  fix this if that changes.
- [ ] `.gitignore` and `CLAUDE.md` carry uncommitted edits from the concurrent
  documentation session. Left for their owner per **P6**.
- [ ] Before Phase 4, the plan's dual-write and `PAPERCLIP_ENABLED`
  contradictions still need an author decision — see `plan-audit.md` P1-C6 and
  P1-C7.

### 6.4 Deferred, and why

- Paperclip ECS service, client, reconciler, ACL, tools, UI — later plan
  phases, in order.
- A whole-app synth check for non-ASCII SG descriptions — the current guard
  covers the two Paperclip stacks only, marked with a `ponytail:` comment in
  both test files. Add if a third stack regresses.

### 6.5 What Phase 2 needs built

Source: [implementation plan](../implementation-plan.md) §"Phase 2 — Paperclip
service online". Read the plan section itself before starting; this is the
index, not a replacement. Note **A10**: the plan is historical, and ADR 0010's
amendment plus `plan-audit.md` outrank it where they disagree.

**Goal.** `GET /api/health` returns 200 through the ALB, backed by the Aurora
cluster with the full Paperclip schema applied.

**Blocked until all four hold.** None of these are true today:

| Precondition | State on 2026-08-19 |
|---|---|
| Phase 1 deployed (Aurora, EFS, log group) | **no** — code exists, gated off behind `CCE_PAPERCLIP_ENABLED` |
| The patched Paperclip image is in ECR | **no** — and see the ECR gap in §6.3 |
| The ARM64 question answered | **no** — Phase 1 step 7, one `docker buildx build --platform linux/arm64` |
| `/claudeclaw[-suffix]/paperclip` secret populated | secret **exists** (deployed 2026-08-19) but carries `REPLACE_ME` placeholders |

**New files.**

| File | What |
|---|---|
| `infra/lib/paperclip-stack.ts` | Task definition (family `paperclip-server`, cpu 2048 / mem 4096, EFS volume mounted at `/paperclip`), pinned tag+digest image, task + execution roles, the service (copy plan §22.6 **verbatim, comments included** — they explain why the settings are inverted), target group (port 3100, health `/api/health`), listener rule, log group |
| `infra/lib/paperclip-stack.test.ts` | The guardrail assertions below |
| `buildspec.paperclip.yml` | **Only if** building in-account rather than consuming the upstream image (§22.8). Prefer not to need it. |

**Files changed.**

| File | Change |
|---|---|
| `infra/bin/app.ts` | Instantiate `PaperclipStack` — inside the `CCE_PAPERCLIP_ENABLED` block added this session, and that flag is the natural place to flip the default once the service exists |
| `infra/lib/compute-stack.ts` | Export the ALB HTTPS listener, or accept it as a prop, so the listener rule can attach |
| `scripts/deploy.ts` | Add phase b.5 — the one-shot migration `RunTask` (§22.7) between the secrets population (`:487`) and the runtime-config seed (`:488`), with a `journal(...)` checkpoint |
| `development.md:344` | "**Migrations**: none." becomes false — update it |
| `buildspec.yml` | **Leave alone.** Stays orchestrator-only. |

**Sequence.** Write the stack → set the task-def environment from §23.2 Table A,
confirming `PAPERCLIP_MIGRATION_AUTO_APPLY` is **absent** on the service → wire
`DATABASE_URL` from the Aurora secret and `BETTER_AUTH_SECRET` from
`/claudeclaw/paperclip`, omitting all vendor API keys → add phase b.5
(`RunTask` on a `paperclip-migrate` task def: same image, migration command
override, **no EFS mount**, wait for exit 0, abort the deploy on non-zero) →
deploy and watch the migration stream to completion **before** the service rolls
→ verify the target goes healthy → from an orchestrator task, `curl` the
Paperclip health endpoint over the internal path to prove the route end to end.

**Tests that matter.** Write these as *explicit* CDK assertions — the plan calls
them the guardrails against a well-meaning future "consistency" refactor:

- `DesiredCount` is **1**
- **no** `ScalableTarget` or `ScalingPolicy` resource exists for this service
- `MinimumHealthyPercent` **0**, `MaximumPercent` **100**
- target group health-check path `/api/health`, port **3100**

Plus `npm run typecheck`, full `npm test`, `npm run synth`, and manually that
`GET /api/health` returns 200 reporting the expected `commit` (fed by
`PAPERCLIP_BUILD_COMMIT`).

**Acceptance.** Health green for 24 h; a forced service roll completes with
exactly one task at all times, never two; the migration job is idempotent.

**Risks named by the plan.** Migration failure mid-run is transactional per
migration, so a failure commits the applied prefix and leaves the rest pending —
fix and re-run, snapshot first. EFS mount failure is almost always the missing
2049 ingress rule or a posix uid/gid mismatch on the access point. Slow cold
start on a populated EFS tree: raise the grace period, never lower the
health-check threshold.

**Rollback.** `desiredCount: 0`, or remove the listener rule. Database and
filesystem persist, so re-enabling is instant.

## 7. Verification actually performed

The nine-command list is the one in
[development.md — How to develop a new feature](../../../../development.md#how-to-develop-a-new-feature-end-to-end),
step 7, run in full on the final code state before the push that shipped.

| Command | Baseline | After changes |
|---|---|---|
| `npm run typecheck` | not run separately | clean |
| `npm test` | at `bfe8707`: 192 files / 2121 tests — 5 files failed, 1 test failed | 192 files / 2126 tests — 5 files failed, 1 test failed. **Same five file names as baseline**, verified by name not count per A9. No new failures. |
| `npm run build` | not run | clean |
| `npm --prefix web run typecheck` / `run build` | not run | clean |
| `npm run local:test:integration` | not run | 9/10 files, **40/41 tests, 0 skipped**; lone failure is the documented Floci `checkSecrets` gap. Paperclip **I3 + FI-4 green** — 0 skipped confirms the live gate ran rather than being env-skipped. Required resetting the disposable stack first. |
| `node scripts/ci/docs-links.mjs` | not run | OK |
| `node scripts/ci/feature-knowledge.mjs` | not run | OK |
| `git diff --check` | not run | clean |
| `node scripts/ci/diagrams-drift.mjs` | FAIL (`app.ts` mapped, diagram untouched) | OK — no drift across 19 changed files, after the verification note |
| `node scripts/ci/docs-mermaid.mjs` | n/a | **not usable locally** — 15/15 fail on this machine including blocks CI renders (M21). CI's Mermaid check: pass |

Additional proof beyond the documented list:

| Proof | Result |
|---|---|
| Synthesized staging templates scanned for non-ASCII | All 6 EC2 SG `GroupDescription`s ASCII; **0** non-ASCII in any EC2 SG/rule description |
| Synthesized prod `CCE-Iam` trust vs. live IAM `get-role` | **identical** — a production deploy is a no-op on the trust policy |
| `ClaudeClawGitHubDeploy` presence by environment | absent from all 15 staging templates; present in the prod template |
| Gate behaviour by synth | flag off → 15 staging templates, no Database/Filesystem; flag on → 17 |
| SG ASCII guard | verified in both directions — fails with the em dash reintroduced, passes without |
| CI on #77 / #78 / #79 | all checks green |
| Staging deploy run 32323984500 | green, 17m30s |
| Deployed runtime | ECS 1/1 on task def `:8`; `GET /health` → `{"status":"ok"}` |

Not run: `cdk diff` against the account (see §4.4 for why, and the synth-level
proofs that replaced it); `npm run synth` is not on the documented list.

## 8. Environment state

- **Tools and services**: Node v24.19.0, npm 11.17.0, AWS CLI 2.36.21,
  gh 2.96.0, Vitest 2.1.9, PowerShell on Windows 11.
- **Active processes**: the disposable Paperclip stack
  (`netzer-labs-paperclip-1`, `netzer-labs-paperclip-db-1`) and Floci
  (`netzer-os-floci`) were left running. Stop with
  `npm run test:paperclip:down` and `npm run local:down`.
- **Environment variables**: `PAPERCLIP_TEST_AUTH_SECRET` was generated
  per-process for the disposable stack and never printed (P11).
- **AWS**: a root session is live (`arn:aws:iam::239887088812:root`), per A6.
- **GitHub variables**: `CCE_GITHUB_IMMUTABLE_SUBJECT=1` is set.
  `CCE_PAPERCLIP_ENABLED` is deliberately **unset**. `CDK_DIFF_ROLE_ARN` is
  still missing since the org transfer (non-gating; scheduled drift workflow
  only).
- **Uncommitted work left in the tree**: `.gitignore` and `CLAUDE.md` from the
  concurrent documentation session, plus the user's untracked
  `handoff-connector-availability-2026-08-15.md` and
  `handoff-staging-deploy-2026-08-14.md` — per **P6**, not staged, not touched.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](2026-08-19-org-transfer-oidc-and-staging-deploy.md)
- [GitHub to AWS trust](../../../github-to-aws.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
