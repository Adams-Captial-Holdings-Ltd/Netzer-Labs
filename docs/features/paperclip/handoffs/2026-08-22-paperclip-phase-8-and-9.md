---
feature: paperclip
document_role: session-handoff
status: current
observed_at: 2026-08-22
as_of_commit: a050fa8
session_slug: paperclip-phase-8-and-9
supersedes: 2026-08-21-paperclip-phases-2-to-9
---

# Session handoff: Paperclip phase 8 verification and phase 9

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-22 |
| Feature folder | `docs/features/paperclip/` |
| Branch worked on | `feature/paperclip-phase-1-5` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `a050fa8` |
| Commit at session end | IN PROGRESS |
| Pushed | no |
| PR | [#89](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/89) open into `development` |
| Deployed | no |

## 2. Current state summary

**PAUSED MID-FLIGHT AND HANDED OVER. Nothing is committed. Nothing is pushed.
No AWS resource was created, modified or deleted at any point.**

The tree carries **66 modified tracked files and 19 untracked files**, spanning
three bodies of work in three different states of verification. Read
[§2.1](#21-what-state-each-body-of-work-is-in) before touching anything — the
difference between "gauntlet-verified" and "built but never reviewed" is the
single most important fact in this handoff.

### 2.1 What state each body of work is in

| Body of work | Built | Critic-reviewed | Blind-judged | Full validation |
|---|---|---|---|---|
| **Phase 8** — cross-surface Missions parity | yes | **yes, 3 rounds + 3 fix** | **yes, 3/3 vs the repo's own `onToolEvent`** | flag-ON and flag-OFF both clean |
| **Phase 9 install half** — stacks install by default | yes | **yes, 1 round + 3 fix** | **yes, 3/3 vs the repo's own always-on stacks** | 7 × `cdk ls` configurations, all 18 stacks |
| **Tonight's five** — six lanes, P30, tenancy assert, cost notice, reachability | **yes** | **NO — the workflow was stopped before its critique phase ran** | no | **NOT RUN** |

The third row is the risk. Its two builders finished and their edits are on disk;
what was cut was the three critics and the arbiter. **Treat every file in
[§4.2 group C](#42-files-modified) as unreviewed.** In this project specifically,
every blocking defect across phases 5–9 was found by a critic driving real code
*after* a reading-based review had already passed it — so "the builder said it
works" has a poor track record here. See **P29**, **M14**, **M15**.

### 2.2 How the session got here

It opened on a tree carrying Phase 8 uncommitted whose last recorded verdict was
a **rejection**, so nobody had judged the fixed code. Execution settled it: the
defect the previous handoff was still chasing was closed, and the only red test
was a bug in the *probe*, not the product (**M14**). Phase 8 then went through a
fresh gauntlet, won 3/3 blind, and took three fix rounds — the last of which
found the same identity defect in a third location, on the Slack main bot.

Phase 9's install half followed the same shape and shipped. Then a grill of the
open questions found what three gauntlets had missed: **a standard install
provisions Paperclip and the orchestrator cannot reach it.** Fixing that, plus
four smaller decisions, is the unreviewed third row above.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

Nothing structural beyond what the feature README and
[`bar-and-phases.md`](../bar-and-phases.md) already record. One correction to
the previous handoff's expectations is recorded as **M14** in section 5.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `src/zzprobe.test.ts` | Previous session's throwaway execution probe, untracked | The only red file outside the known baseline — and it was the probe that was wrong, not the product |
| `src/lib/scheduler/delivery.ts` | Delivery-target resolution and the out-of-band push | Holds the `bot-<agentId>` / `app-<agentId>` identity scheme Phase 8 introduced |
| `src/lib/tools/schedule-tools.ts:178` | Stamps `deliveryTarget` from `ctx.replyChatId` | Proven by probe to carry the identity segment into a task delivered a day later |

### 3.3 Patterns and conventions to follow

Cross-surface chat work must be mirrored across Telegram, Slack (**both** send
paths) and the dashboard, per [`CLAUDE.md`](../../../../CLAUDE.md). And a red
test is not evidence until it has been instrumented — see **M14**.

## 4. Work completed

### 4.1 Tasks finished

- [x] Recorded the `npm test` baseline on the untouched tree (**P1**)
- [x] Established by execution that Phase 8's known open defect is closed
- [x] Diagnosed and corrected the one red probe case
- [x] Ran the flag-ON configuration (**M44**) — matches the baseline exactly
- [ ] Phase 8 gauntlet — running
- [ ] Phase 9 — in discovery

### 4.2 Files modified

Grouped by body of work, because the groups have **different verification
states** (see §2.1). `M` = modified tracked file, `NEW` = untracked.

#### Group A — Phase 8, cross-surface Missions parity · GAUNTLET-VERIFIED, 3/3 blind

| File | What |
|---|---|
| `NEW src/lib/missions/format.ts` | The shared pure formatter — the centrepiece. Every user-visible mission string, the ref/window numbering rule, the size bounds, the error and degraded-delivery copy |
| `NEW src/lib/missions/format.test.ts` | Includes the source scan over **both** `web/` copies of the status vocabulary, and hostile-input rows |
| `M src/agent/commands.ts` | `/missions`, `/mission new`, `/mission done` on the shared router — every surface picks them up free |
| `M src/agent/agent-loop.ts` | `AgentTurnRequest.boardAgentId`, threaded into `ToolContext` beside `replyChatId` |
| `M src/agent/picker.ts` | Bot identity feeds the picker |
| `M src/adapters/telegram/handler.ts` `M .../send.ts` `M .../parse.ts` | Per-agent bot identity in the reply target; oversize splitting measured on **escaped** length; send result no longer discarded |
| `M src/adapters/slack/handler.ts` | Both send paths — main bot and per-agent apps |
| `M src/lib/scheduler/delivery.ts` `M .../delivery.test.ts` | `bot-<agentId>` / `app-<agentId>` identity rides *in* the id; `send()` returns whether the message actually left |
| `M src/lib/tools/mission-tools.ts` `M .../registry.ts` `M .../schedule-tools.ts` | Tools read the board the commands wrote to |
| `NEW src/lib/tools/paperclip-tools.ts` + `.test.ts` | The new agent verbs, gated on `paperclip_disabled` at invoke |
| `M src/lib/missions/mission-acl.ts` | Provenance join; `listMissionsForExport` unions both substrates |
| `M src/server.ts` `M web/src/pages/Missions.tsx` | Wiring and the pointer comment |
| `NEW` ×7 test files | `handler.command-scope` (telegram + slack), `send.oversize`, `commands.missions`, `delivery.telegram-identity`, `mission-assignment-push`, `mission-toolspec` |

#### Group B — Phase 9 install half · GAUNTLET-VERIFIED, 3/3 blind

| File | What |
|---|---|
| `M infra/bin/app.ts` | Database, Filesystem and Paperclip **always constructed**; tier-gated internally; Tier 0 refuses to empty a live substrate unless `CCE_PAPERCLIP_TEARDOWN=1` |
| `M infra/lib/constants.ts` | `TierShape.paperclipEnabled` (T0 false, T1+ true); `clampTier` moved here; `paperclipProvisioned()` |
| `M infra/lib/database-stack.ts` `M .../filesystem-stack.ts` `M .../paperclip-stack.ts` | Internal tier gate — early return before any resource |
| `M infra/lib/interfaces.ts` | Outputs become `\| undefined` |
| `M infra/lib/cost-guardrails-stack.ts` | Tier-aware budget default (710 provisioned / 600 at T0) |
| `M scripts/deploy.ts` | Tier-derived gate; phase-a names the stacks unconditionally; **self-bootstrapping first install** |
| `M scripts/lib/cost-gate.ts` + `.test.ts` | Reads `TIERS[...]` instead of a boolean parameter, so it cannot disagree with what CDK deploys |
| `M scripts/lib/lifecycle/teardown-plan.ts` + `.test.ts` | The three stacks move into `ALWAYS_ON_STACK_SUFFIXES` |
| `M scripts/lib/lifecycle/manifest.ts` | `DEPLOY_TIER` added to `SYNTH_INPUT_ALLOWLIST` |
| `M scripts/lib/lifecycle/rollback-classes.ts` + `.test.ts` | A manifest carrying no tier key is no longer treated as tier 1 |
| `M .github/workflows/deploy.yml` | Four gates moved to the tier; defer path exits 0; `PAPERCLIP_TIER_ENABLED` (deliberately **not** the plan's unbuilt `PAPERCLIP_ENABLED`) |
| `M .github/workflows/cdk-drift.yml` | Dated exclusion so the daily job does not go permanently red |
| `NEW infra/bin/app.stack-set.test.ts` | **The acceptance test that never existed** — synthesizes the app and asserts the stack set is identical across flag values |
| `NEW scripts/ci/tier-gate.ts` | Emits the one tier boolean CI gates on |
| `M scripts/cost-estimate.mjs` `M scripts/setup.ts` `M scripts/teardown.ts` `M scripts/ci/paperclip-image.ts` | Estimator line item, wizard, teardown sweep, operator message |

#### Group C — tonight's five · ⚠️ BUILT, NEVER REVIEWED

| File | What | Confirmed present by |
|---|---|---|
| `M src/lib/state/mission-tasks-repo.ts` | `MISSION_STATUSES` widened to six in the decided order | read: `open, in_progress, blocked, in_review, done, cancelled` |
| `M src/lib/paperclip/mission-projection.ts` + `.test.ts` | `toMissionStatus` stops collapsing; `toIssueStatus` gains both cases | not verified |
| `M web/src/lib/glossary.ts` | Third copy of the vocabulary | not verified |
| `M web/src/pages/Missions.tsx` | Six lanes, decided order | read: all six `COLUMNS` present |
| `M src/lib/scheduler/queue-drain.ts` + `.test.ts` | **P30** — typed `refusal` marker, retryable vs non-retryable | read: `result.refusal?.retryable` branch present |
| `M src/lib/paperclip/client.ts` + `.test.ts` | One-company invariant at construction | read: documented as an accepted architectural invariant |
| `M infra/lib/network-stack.ts` | **SG ingress `fargateSecurityGroup → PAPERCLIP_PORT`** | read: `'Orchestrator to Paperclip'` |
| `M infra/lib/paperclip-stack.ts` + `.test.ts` | **Cloud Map service discovery** | read: 4 references |
| `M infra/lib/compute-stack.ts` | **`PAPERCLIP_BASE_URL` on the orchestrator task** | read: `:544`, from `RESOURCE_NAMES.paperclipInternalUrl` |
| `NEW src/agent/agent-loop.board-scope.test.ts` | Closes the untested `boardAgentId` forwarding | not verified |
| `M src/lib/paperclip/readme.test.ts` `M .../paperclip-mission-engine.test.ts` `M src/adapters/dashboard/missions.test.ts` `M src/lib/tools/mission-tools.authz.test.ts` | Follow-on test updates | not verified |

#### Group D — docs

`M docs/diagrams/architecture-security.md` (corrected: `paperclip_disabled` is armed, not inert),
seven other `docs/diagrams/*`, `M docs/how-it-works.md`, `M docs/features/paperclip/HANDOFF.md`,
`NEW docs/features/paperclip/handoffs/2026-08-22-paperclip-phase-8-and-9.md` (this file).

#### ⚠️ DO NOT COMMIT

| Path | Why |
|---|---|
| `src/zzprobe.test.ts` | Throwaway probe, header says "delete after use". Its `prompt`→`prompt_text` fix was mine; still not for commit |
| `.env.example`, `CLAUDE.md` | **Another session's uncommitted work** (**P6**) |
| `handoff-connector-availability-2026-08-15.md`, `handoff-staging-deploy-2026-08-14.md` | Another session's, root-level |
| `.agents/`, `skills-lock.json` | Tooling artefacts, not this work |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Verify Phase 8 directly rather than resume the previous session's workflow by run id | Cross-session workflow resume; re-run the script fresh; verify by direct execution | Direct execution answered the question in three commands and did not depend on another session's cache surviving |
| Plan Phase 9 from [`bar-and-phases.md` Part D](../bar-and-phases.md) rather than from a GSD `.planning/ROADMAP.md` | Invoke `/gsd-phase` and let it initialise `.planning/`; use the repo's existing decomposition | The repo has **no** `.planning/` directory, and its phase decomposition already lives in `bar-and-phases.md` at file:line precision — Part D names all seven homes of the flag. A second phase list beside it is precisely the drift **M1**/**P9** forbid. One-time decision, recorded here per the development-process skill. |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Phase 8's assignment-push defect is closed and proven on the wire | `docs/features/paperclip/HANDOFF.md` | pending end of session |

## 5. Carried-forward mistakes, assumptions and precautions

> Copied forward verbatim from the previous session handoff,
> [`2026-08-21-paperclip-end-to-end.md`](2026-08-21-paperclip-end-to-end.md),
> then appended to. Nothing is deleted. An entry that is fixed is marked
> `RESOLVED (<commit>)` and stays.

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

(entries appended as they are earned)

### 5.11 Appended this session (2026-08-20, Paperclip end to end)

| # | Entry | Detail |
|---|---|---|
| M28 | **Paperclip silently ignores unknown query parameters.** Sending `updatedSince` to a build without the vendored patch returns **HTTP 200 with the full, unfiltered issue list** — not a 400, not an error. | This is a silent data-correctness trap, and it is the failure mode a reconciler is least able to detect: it looks like a successful poll that just happened to return a lot of rows. Mitigated by the **A1-8 boot probe**, which asserts that `updatedSince=<now + 1h>` returns `[]` and refuses to start the reconciler if it does not. |
| M29 | The historical implementation plan's Paperclip line-number citations are from a **different revision** than the pinned tag, systematically — not the 16 one-off errors `plan-audit.md` catalogued. Checkout, release, comments and force-release all disagree by hundreds to thousands of lines. | Recorded as hard rule **A1-16**: never cite a Paperclip source line number as authority. Cite method + path + observed behaviour + the probe name that proves it. |
| M30 | ADR 0010's ratified watermark predicate `updated_at >= watermark + 1ms` is a **correctness hazard**, not merely a conservative choice. `updated_at` is microsecond-stored `timestamptz` while every API caller observes millisecond-truncated values, so querying `>= T + 1ms` permanently loses any row whose true timestamp falls in `[T, T+1ms)` and was not already in the processed page. | Superseded by C-2: query `>= (maxUpdatedAt − poll_overlap_ms)` and dedupe client-side on `(id, updatedAt)`. The ADR must be amended in the same PR as the reconciler. Prove it with a probe that writes two issues inside one millisecond. |
| M31 | `src/lib/paperclip/mission-projection.ts` hardcodes `createdByChat: 'paperclip'`, while `privacy-tools.ts` filters a subject's missions by `m.createdByChat === chatId`. Every Paperclip-origin mission would therefore **silently disappear from a user's GDPR export**. | A compliance regression with no test coverage, invisible until audited. Fixed by a Netzar-side provenance row written at create time; the test ships in the same PR. Blocking gate on Phase 7. |
| A27 | **The `updatedSince` patch is present and working in the running artifact.** Verified 2026-08-20 by grepping the built image: 14 occurrences across `/app/server/dist/routes/issues.js`, `/app/server/dist/services/issues.js` and `services/issues.d.ts`. | This is the first execution-time confirmation of ADR 0010's amendment; every prior statement was source-only. Re-verify on every re-pin. |
| A28 | Upstream now implements `updatedSince` natively: absent at `v2026.722.0` and `v2026.817.0`, present on master via PR #9050, released in `v2026.818.0-beta.1`. | The ADR amendment's re-pin rule is now live rather than hypothetical — **drop the patch** in the same change that bumps to a release carrying it. Until then the patch stays and A1-8 guards it. |
| A29 | **`A21` does not hold for every Bash in this repository.** The Bash tool in this session has coreutils, `sh`, `git`, `node` and `npm` on PATH. | `scripts/release/buildspec-tag-normalization.test.ts` passes here, which is why this session's baseline is 5 failing files where the previous session's was 6. Compare failing file **names**, never counts — exactly what **A9** already says. |
| A30 | `paperclip_disabled` is registered in all three places but has **zero callers** — it is inert. `neutralizeForPrompt` is likewise implemented, tested, and called by nothing. | Both are latent no-ops that read as shipped safety. The kill switch goes inside the client at every invoke so no caller can bypass it; `neutralizeForPrompt` is wired at the Jarvis and dispatch-ingest boundaries. |
| P22 | Set `PAPERCLIP_TEST_AUTH_SECRET` in **every** shell that touches the harness — including plain `docker compose ps`, which fails to interpolate the Compose file without it. | Broadens **P10**, which named only the vitest process. The failure message names the variable, but it looks like a Docker fault at a glance. |
| P23 | `/gsd-phase` and the GSD skill family operate on `.planning/ROADMAP.md`. This repository has no such directory and its process documentation forbids second copies of planning conventions. | Phase plans belong in `docs/features/paperclip/`. Do not stand up a parallel planning tree here; it is the exact drift **M1** records. |

### 5.12 Appended after the first live probe run (2026-08-20)

Eleven of thirteen contract probes ran green against the pinned artifact. These
are the facts that run produced, and several of them correct a document.

| # | Entry | Detail |
|---|---|---|
| A31 | **`GET /api/openapi.json` is reachable unauthenticated** and returns the full document: 475 paths, 704 KB, at the pinned digest. | This is the authoritative machine-readable contract (**A1-15**) and it needs no credentials, so the snapshot can be taken by anything that can reach the port. It settled two probe failures in minutes that a source read had left open. Take the snapshot from the running artifact, never from a source read. |
| A32 | The agent-key scope payload is `{name, scope: {kind: 'standard' \| 'task_bridge', …}}` — **nested under `scope`, with `name` required**. The `task_bridge` variant requires only `kind`; `projectId`/`projectIds`/`parentIssueId`/`parentIssueIds`/`allowedAssigneeAgentIds` are all optional. | The first A1-9 probe sent `{kind:'task_bridge'}` flat and omitted `name`, and got a bare `400 Validation error` that named nothing. Paperclip's validation errors do not tell you the shape; the OpenAPI does. |
| M32 | **The bar's own criterion A1-12 was wrong.** It asserted `/wakeup` answers **202** for both the run and the skipped envelope. The live OpenAPI declares **200** (plus 400/401/403) and types the response as an undocumented `additionalProperties: {}`. The probe observed `status: 'queued'`, not `'skipped'`. | The claim came from a source read of a 400 KB route file, which is exactly the class of claim **A1-16** already distrusts — it turns out status codes are as unreliable as line numbers when read at that scale. The bar's stated precedence already covers this: *a green contract probe against the pinned artifact beats all four documents*, and that includes the bar itself. Correct A1-12 against the artifact, and do not treat any unprobed status code in A1 as settled. |
| A33 | **C-3 is settled, and Packet 4 was right where Packet 1 was wrong.** A run-less agent actor can POST a comment and PATCH an issue: `commentRequiresRunId: false`, `patchRequiresRunId: false`, observed. | This is load-bearing for the ACL, which comments as a run-less actor. The ACL does **not** need to degrade to `wakeup` for comments. Recorded by characterization, not assertion. |
| A34 | **A1-8 is green against the patched artifact**: `updatedSince` one hour in the future returns `[]`. **C-2 is green**: an overlap-and-dedupe read sees same-millisecond writes exactly once. | These are the two blocking probes. A34 is the first end-to-end proof that the vendored patch does what ADR 0010's amendment claims, and that the C-2 predicate (`>= maxUpdatedAt − poll_overlap_ms` with `(id, updatedAt)` dedupe) is lossless where the ADR's `+1ms` is not. The reconciler may now be built on it. |
| P24 | **Reset the disposable stack before every probe run**, not just when one looks stale. | The fixture fails closed with `Active Paperclip integration keys exist without the in-memory credential cache` whenever a previous bootstrap left keys behind — and its credential cache is in `/dev/shm`, which **does not exist on Windows**, so on this platform the cache never survives a process boundary and the second run in a session always trips it. `npm run test:paperclip:down && :up` between runs. This broadens the existing Trap from "a stale stack" to "any second run on Windows". |

### 5.13 Appended at session close (2026-08-21)

| # | Entry | Detail |
|---|---|---|
| M33 | **A readiness gate can be catastrophic in the direction nobody checked.** Phase 4 made the Paperclip service's *existence* depend on a probe reading `cdk-outputs.json` — a **gitignored, machine-local** file — with a failure default of **omit the service**. On CI, a fresh clone, or a second engineer's machine the probe can never succeed, so `cdk deploy --all` would **delete a running Paperclip service and its listener rule**, print "re-run the deploy", and **exit 0**. | This is the cloudflared post-mortem repeating, whose own conclusion is quoted in `.github/workflows/deploy.yml`: *"Both directions have to be safe."* A gate that protects against starting a container against an unpopulated secret must not create a silent-delete path going the other way. When adding a readiness gate, write down what happens when the probe fails **on the resource that already exists**. |
| M34 | The five Paperclip CodeBuild IAM grants were written onto `cicdRole`, which `iam-stack.ts` creates **only** in the `!isStagingDeploy` branch — making a staging arm depend on a **production** IAM deploy. Verified against the live `ClaudeClawGitHubDeploy` role: every ECR grant was orchestrator-scoped and there were zero Paperclip statements, so an armed staging run would have failed `AccessDenied` at the ECR repo create **after Aurora already existed**. | Third instance of the shape **M22** and **M27** record. Fixed by mirroring into the staging branch with `Role.fromRoleName(...).addToPrincipalPolicy(...)` — the pattern `PublicTunnelReadinessStaging` already proves live in this account — narrowed to `claudeclaw-staging-paperclip*`. **Before granting anything to CI, read the LIVE role; the code is a plan, the role is the fact.** |
| M35 | Every one of the eight critic rejections across Phases 1 and 1.5 was the same defect class: **a claim no probe supported.** A wrong discriminator, a wrong status code, a wrong endpoint purpose, a fabricated `retryAfterSeconds` comment, a placeholder snapshot presented as a contract. | The remedy that finally worked was making "an honest `UNVERIFIED` marker beats a claim no probe supports" an explicit instruction. `ISSUE_LIST_DEFAULT_LIMIT` and friends now carry that marker, because the harness board is smaller than the thresholds and no probe can distinguish 500 from 5000. |
| A35 | **The pinned image ships its built UI and it serves.** `/app/ui/dist` (13 MB, with `index.html`) exists; the server resolves `../ui-dist`, which does not. With a symlink and `SERVE_UI=true`, `GET /` answers 200 `text/html` and `/assets/index-*.js` answers 200 with **6,484,747 bytes**. Runtime branding hooks exist (`PAPERCLIP_LOGO_SVG`, favicon markers). | Amends plan §16.6, which ruled "rebuild in Netzar". Its four reasons still hold but argue for controlling **access**, not rewriting. Re-verify on every re-pin: this is a path convention, not a supported contract — and §33 records upstream saying branding must not be counted on. |
| A36 | **Delegation needs no Paperclip change**, and the turn budget survives: `POST /api/issues/{id}/children` takes an **array** with per-child `assigneeAgentId`, so a fan-out to five agents costs **one** tool turn, not five. `wakeup` takes an `idempotencyKey`, so retries are safe. | But `suggest_tasks` is a trap: it looks ideal and its `/accept` is **board-only**, so an agent calling it stalls until a human clicks. And **co-owned projects have no model at all** — `leadAgentId` is a single uuid, zero hits for participant/watcher/collaborator across 475 paths, and `checkout` is an exclusive lock. Co-ownership must be one parent + N assigned sibling children, a Netzar convention. |
| A37 | `GET /api/companies/{cid}/timeline` is the **only fully-typed response schema** in the delegation area and returns `edges[]` with `kind: delegation\|assignment\|mention` — an **observed** collaboration graph, filterable by project. | Better than the org chart for the client-facing "see how agents work together" goal: `reportsTo` is hand-set and rots, the timeline is self-maintaining. Lead with the timeline, scoped by project. |
| A38 | **Open self-registration.** Probed live: `POST /api/auth/sign-up/email` returns **200 with no credential** even under `PAPERCLIP_DEPLOYMENT_MODE=authenticated`. | Matters the moment the board is reachable. Must be closed or fronted before any Netzar user can reach the UI. |
| P25 | Run one gauntlet per working tree. Two concurrent builder/critic loops sharing a checkout produced a red typecheck attributed to the wrong phase. | No damage — the builder proved attribution before proceeding — but it costs a confusing round. Serialize phases that share a tree, or give each a worktree. |
| P26 | `node scripts/ci/docs-mermaid.mjs --extract-only` runs the **node-budget** check WITHOUT rendering, so it is trustworthy on this machine despite **M21**. | M21 says local mermaid output is not signal. That applies to the *renderer* only. The budget check caught a 41-vs-40 failure locally in one second that would otherwise have cost a CI round trip. |


### 5.14 Appended this session (2026-08-21, phases 2 through 9)

| # | Entry | Detail |
|---|---|---|
| M36 | The Phase 2 client shipped a create body carrying `status`, and an `idempotencyKey` **without** `allowDuplicate: true`, while a comment cited A1-13's `200 + deduplicated: true` as proven. A1-13 proved that only for a body carrying `allowDuplicate: true` — and `client.ts` auto-retries any write that has an idempotency key. | Two independently harmless-looking choices combined into a duplicate-issue-on-retry bug. Caught only because the critic checked the *cited* probe rather than trusting the citation. **When a comment cites a probe as authority, open the probe and check that it proves the shape actually being sent.** RESOLVED this session — `status` deleted from `missionToIssueCreate`, `allowDuplicate: true` added, key made deterministic (`netzar-mission:<mission.id>`), pinned by a test asserting `not.toHaveProperty('status')`. |
| M37 | `types.ts` and `error.ts` shipped in the same changeset giving **opposite normative instructions** about the same two strings: `types.ts` said "Do not map them from prose; produce them first", while `error.ts` mapped them behind an UNVERIFIED marker. | Neither was wrong on its own; together they guarantee the next maintainer deletes one of them. A doc-vs-code disagreement inside one changeset is a defect even when the code is right — **P5** says fix the document, so `types.ts` now records what `error.ts` does and why. RESOLVED this session. |
| A39 | **A blind head-to-head is worth running and this project can win it.** Five rounds, three judges each (craft / three-year maintainer / consumer), both files anonymized and the A/B order deliberately flipped every round: ours was B, A, B, A, B and won **15 of 15**. | The alternating order is the control — without it a sweep proves position bias, not quality. Note what it did *not* do: the blind judges passed our client in round 1, while the bar critic kept rejecting it through round 4. **Winning blind is necessary, not sufficient** — beating a rival file says nothing about matching *this* artifact's observed contract. |
| A40 | `Agent(isolation: "remote")` does **not** reach a cloud machine from this session — the probe reported it running in a local git worktree under `.claude/worktrees/` with the same local Docker daemon. | So "run it in the cloud" is not available by that route. Do not assume the flag means what it says; probe it with `pwd` + `docker --version` before planning around it. |
| A41 | Creating a claude.ai cloud **routine** against this repo fails `HTTP 403 — You don't have access to a repository this routine uses`. `Netzer-Labs` is PRIVATE under the `Adams-Captial-Holdings-Ltd` org, and the Claude GitHub integration has not been granted access to it. A local `gh` login (scopes `repo`, `workflow`, `read:org`) does **not** carry over — the cloud has its own grant. | Probably a consequence of the org transfer (**M16**, **A11**). Unblocked only by an org owner authorizing the integration for that repo; it cannot be fixed from a non-interactive session and must never be worked around with a pasted token. |
| M41 | Phase 6's first critic passed every acceptance item, then named a loss channel: the route takes a durable 24 h claim BEFORE the work runs and the worker never rejects, so any post-ack failure was permanently swallowed — Paperclip got its 202 and would not retry. The compensating control its own contract names ("the reconciler is the mandatory mitigation for dispatch loss and must be live first") **does not exist**: Phase 5 ships observing-only and writes nothing even at `mode:'live'`. | A phase can satisfy every enumerated acceptance item and still ship a defect the acceptance list never thought to enumerate. Ask separately: *what does this lose, and what recovers it?* RESOLVED — transient failures release the claim, deterministic ones stay terminal. |
| M42 | The first fix released the claim on the THROW paths and missed that `runAgentTurn` has three refusal paths that **return normally**: the `sessions_frozen` kill switch, the turn-level rate limit, and the kill-phrase halt. They never reach the `catch`, so the claim was never released — a maintenance freeze silently ate the dispatch, and the board was told *"Please try again shortly"* when nothing ever would. **538 green tests said nothing**, because every test drove `Promise.reject` and none resolved a refusal-shaped result. | Found only because the verifier was told to prove it by EXECUTION. When classifying failures, enumerate what a function RETURNS as well as what it THROWS — and check whether your tests only ever exercise one of the two. RESOLVED by a typed `refusal` marker on `AgentTurnResponse`; the heuristic alternative (zero-cost/zero-token/empty-modelId) was deliberately rejected as fragile. |
| M43 | **A fix of mine was worse than the bug it closed.** Gating the kill phrase on `origin === 'human_chat'` correctly closed a low-severity Paperclip hole — and silently disabled the emergency stop for a human typing that phrase into an active **War Room** on Telegram and the dashboard, because that path diverts through `orchestrateWarroomTurn` with no origin. | This is **M33** in a new place: both directions have to be safe. Weigh what a fix BREAKS against what it closes; a silent loss of an emergency stop during an incident beats a hole that needs a high-entropy secret. Also note the trap in the obvious repair: the check does NOT go at the orchestrator, whose `userText` is a multi-speaker transcript — an agent's words would halt the fleet and a stale line would re-halt every round. It belongs at the entry points, on the human's raw message. RESOLVED via a shared check in `src/lib/warroom/kill-phrase.ts` (A3-1: the surface-agnostic layer, not duplicated into two adapters). |
| A45 | **11 production call sites reach `runAgentTurn`.** Every human-typed path halts on the kill phrase; five machine callers correctly do not. Two in-between states that nobody had enumerated also halt correctly: a stale `activeWarroomId` pointing at an ENDED room, and an active room plus an attachment (the divert is gated on `!attachment`) — both fall through to the ordinary chat call site. Slack has no War Room divert. | Verified by execution, not by reading. Re-verify this enumeration whenever a new divert, queue or orchestrator is added between an adapter and the turn loop; that is exactly the shape that was missed twice. |
| A46 | **Dispatch rollback is a BOARD-UI operation, not a scripted one.** There is no agent-UPDATE call anywhere in this repo — `bootstrap-core.ts` has `listAgents` and `createAgent` and nothing else — and none of the 21 probes exercises one, so the method and path that would rewrite an existing `adapter_config` are established by nothing green. | The acceptance item ("rollback is blanking that URL — a data edit, no deploy") still holds, but the edit is made in the Paperclip board by hand. Marked UNVERIFIED rather than guessed from the plan document, which A1-16 forbids and which is already wrong about this route's auth. |
| P29 | **Prove it by execution, not by reading.** Three consecutive verification rounds on Phase 6 each found a real defect with a throwaway probe, after a reading-based review had passed the same code. One of those verifiers caught its OWN false positive — a malformed mock threw before the code under test, so the right thing happened for the wrong reason — and re-ran. | Make "write a throwaway probe, then delete it and confirm `git status` is clean" an explicit instruction for any verifier of a failure-classification path. Reading finds the throws; only execution finds the returns. |
| P30 | **Follow-up owed, not done:** `src/lib/scheduler/queue-drain.ts:126` has the identical loss-channel shape and is PRE-EXISTING and outside Phase 6 — a scheduled task firing during a maintenance freeze is permanently consumed, because the refusal returns normally and the SQS message is then deleted. | Now trivially fixable using the `refusal` marker Phase 6 added to `AgentTurnResponse`. Recorded here rather than fixed so it is not lost; `src/agent/canary.ts:75` scoring a freeze as a canary failure is a cosmetic sibling. |
| M44 | **Six phases were validated with the feature flag OFF.** The whole integration is gated behind `CCE_PAPERCLIP_ENABLED`, so every "full validation, clean" exercised the LEGACY path. Phase 7's critic proved it: with the flag armed, `mission-tools.authz.test.ts` went 5/5 → 3/5, and CI runs flag-off so it would have stayed green forever while the new code's behaviour was asserted nowhere. | Bounded by luck, not diligence — a flag-on sweep found exactly the one file the critic named and nothing from Phases 2-6. **Validate a flag-gated feature in BOTH configurations, every time.** `npm test` AND `CCE_PAPERCLIP_ENABLED=1 npm test` are now both part of the pre-push list for this feature. RESOLVED — both now report 213 files passing with the identical 5-file environmental baseline. |
| A47 | `resolveOwned` swept the whole owner board TWICE per mutation via `paginateAll` (up to 100 pages) where legacy did one bounded `Limit=100`. This is not merely slow: **A1-10's refusal counts DISTINCT list reads in flight per actor**, so a mutation-heavy dashboard fan-out is exactly the shape that trips it. | Bounded in the same change. When porting a bounded query onto a paginating client, the bound is part of the contract, not an implementation detail. |
| A48 | **C-16's 8-char-prefix ambiguity was real, not theoretical.** `startsWith` silently picked the first match, so two missions sharing a prefix meant a mutation hit the WRONG mission. | Closed with a deterministic ambiguity error. That is a fix rather than a contract break: the ambiguous case could not previously succeed correctly, and the unambiguous cases stay byte-identical. |
| A49 | `infra/lib/compute-stack.ts` had to plumb `CCE_PAPERCLIP_ENABLED` into the Fargate task environment. Without it the flag is synth-time only and the ACL never arms in a deployed task. | The fifth home of the flag (**M22**). It defaults to unset, so the legacy stack serves — the safe direction. |
| P27 | A builder/critic loop must be capped, and the cap must be **reported as a cap**. Phase 2's first workflow exited `passed: false` at `rounds < 3` — not because it converged, but because it ran out of rounds with two criteria still failing. | Read the exit condition before concluding a phase failed on quality. A capped loop that is *close* deserves a focused follow-up round on the named failures, not a rebuild — the follow-up cleared both in two rounds while touching nothing that already passed. |
| M15 | A decision was put to the repository owner on a premise taken from **comments in the shipping code** rather than from the code's behaviour. Six comments — `infra/lib/iam-stack.ts:760, :838, :996` and `.github/workflows/deploy.yml:249, :354, :477` — all still assert that arming Paperclip in staging "depends on a production IAM deploy having run first". That was true before **M34** and has not been true since: `CCE-STAGING-Iam` exists, and already attaches all five `PaperclipCloudBuild*Staging` statements plus `PaperclipSecretPopulateStaging`, `EcrPushPaperclipStaging`, `EcrCreatePaperclipRepoStaging` and both migration grants to the shared `ClaudeClawGitHubDeploy` role via `Role.fromRoleName(...).addToPrincipalPolicy(...)`. | **P5 says the code wins when a document disagrees — a comment is a document.** The rule was applied to every external doc this session and not to the comments sitting beside the code being read. Verify a comment by synthesizing the stack and enumerating what it actually produces, exactly as an OpenAPI claim is verified by a probe. The six comments are corrected in this change. |
| P33 | The genuine defect the stale comments were hiding is **step ordering, not environment scoping**: an existing CI-enabled installation upgrading to this version runs the ECR, CodeBuild, secret-populate and migrate steps **before** the `CDK deploy` that creates their grants, so at the default tier (`clampTier('')` → Tier 1, which provisions Paperclip) all four fail `AccessDenied`. `deploy.yml:353` acknowledges it and offers a manual workaround. | Resolved by deploying `${CDK_STACK_NAME}-Iam --exclusively` early in the job so an upgrading installation grants itself what it needs in one unattended run. A **first** install is unaffected: `CCE_CICD_ENABLED` defaults empty so the role is never created, and opting into CI does one local deploy that lands the role and all fifteen statements at once. |
| P32 | `node scripts/ci/diagrams-drift.mjs` is **inert locally**. Without `GITHUB_BASE_REF` it prints "not a PR context, path validation only" and exits 0 — it validates that the mapped paths exist, and checks no drift at all. | A local green from this gate is not evidence a diagram is in step with the code it maps. `infra/bin/app.ts` is mapped (`docs/diagrams.map:4`), so any Phase 9 edit to it must update `docs/diagrams/architecture-compute.md` or carry a `drift-gate:` note — and only CI will actually enforce that. Verify the diagram by reading it, never by running the gate locally. |

### 5.15 Appended this session (2026-08-21, Phase 4 rework round 2)

| # | Entry | Detail |
|---|---|---|
| M38 | **M27 for the fourth time, and the most expensive shape of it yet.** Phase b.5 — compose `DATABASE_URL`, run the one-shot migration, abort on a non-zero exit — existed only in `scripts/deploy.ts`. CI does **not** run that script; it hand-mirrors each phase and then runs `npx cdk deploy --all`. `grep -n "migrat\|run-task" .github/workflows/deploy.yml` returned exactly one hit and it was a comment. So on the only driver that reaches staging and production, the schema was never migrated by anything: the service deliberately carries no `PAPERCLIP_MIGRATION_AUTO_APPLY`, so deploy 2 would have started an essential container against an empty schema, failed the rollout, and left `CCE-Paperclip` in `UPDATE_ROLLBACK` beside RETAIN + `deletionProtection` substrate (**P21**). | It failed *safely* — nothing would have been deleted — which is exactly why it survived a full review round: an M33-clean design can still be an unreachable one. **When a phase adds a step to `scripts/deploy.ts`, open `.github/workflows/deploy.yml` in the same edit and either mirror it or write down why it does not need mirroring.** RESOLVED this session — a `Migrate Paperclip database` step now sits between `Populate Paperclip secret` and `CDK deploy`, running `aws ecs run-task` + `ecs wait tasks-stopped` + an exit-code check, and hard-failing before the deploy rather than after it. |
| M39 | The round-1 workflow wrote the Paperclip secret and nothing granted it. `grep secretsmanager infra/lib/iam-stack.ts` returned only power-switch and public-tunnel statements — **zero** Paperclip statements in either branch — so the step would have died `AccessDenied` on its first armed run. | A capability added to a workflow is not added until the role can do it, and the role has two homes (**M34**). RESOLVED this session — three statements in the `!isStagingDeploy` branch and three mirrored `*Staging` ones, asserted by name in `paperclip-stack.test.ts`. **Still a prerequisite, not a fix:** the grants are created by the CDK deploy later in the same job, so they must land in a prior UNARMED deploy, and the live `ClaudeClawGitHubDeploy` role is the fact worth reading before arming. |
| M40 | `SYNTH_INPUT_ALLOWLIST` still carried `CCE_PAPERCLIP_SERVICE_READY` — a variable from the **rejected** design, referenced nowhere else in the tree — under a comment claiming synth "creates the FargateService only when the readiness gate is '1'", which is precisely the behaviour **M33** forbade and the code no longer has. Meanwhile the flag that *does* change synth output, `CCE_PAPERCLIP_BOOTSTRAP`, was missing from the list. | A replay list is executable documentation: a stale name there is a promise that a rollback will re-apply a gate that no longer exists. Worse, that particular name could only ever *remove* a resource. RESOLVED this session — removed, `CCE_PAPERCLIP_BOOTSTRAP` added, the comment rewritten to say why the old name must never come back, and a colocated test asserts both directions. Two diagram files carried the same stale claim and were corrected. |
| A42 | A comment can be *right about the decision and wrong about the evidence*. `paperclip-stack.ts` justified using `curl` in the health check by asserting the orchestrator's `wget` "is not" in the image. `curl` is genuinely there and `wget` is genuinely there too, at `/usr/bin/wget`. | The choice was fine; the reason given was false, and a false reason is what the next reader deletes the choice on. **A1-16 in miniature: state what the probe proved, not what it implied.** The comment now says `curl` was probed present and names the cost of naming a binary the image lacks (UNHEALTHY forever, which at `minHealthyPercent: 0` is an outage). |
| A43 | `resolvePaperclipMigrationTargets()` read the **gitignored** `cdk-outputs.json`. That was already M33-safe (its only consumer aborts, it removes nothing), but `null` still meant "a fresh clone" far more often than "not deployed" — and an operator on a fresh clone of a *working* environment would have been told to set `CCE_PAPERCLIP_BOOTSTRAP=1`, which scales the running service to zero. | Live CloudFormation answers the same question identically from anywhere, and `cloudformation:DescribeStacks` was already granted. Re-sourced this session; a non-`ValidationError` failure now aborts instead of masquerading as "not deployed". It is also what let the CI step reuse the same four outputs instead of inventing a second protocol. |
| A44 | **The image bump is the same two-deploy protocol as the first arm, and that is stated rather than hidden.** Both drivers run the migration task definition the *previous* deploy created, so an image that introduces a migration must ship with `CCE_PAPERCLIP_BOOTSTRAP=1` and then be cleared. | `vendor/paperclip` is content-tagged and changes only when its Dockerfile or patch changes, so this is rare. Named in `.github/workflows/deploy.yml` at the migration step, because an unnamed constraint is one somebody hits at 3am. |
| P28 | Both critics that mattered here disagreed about *what kind* of defect blocks a phase: the bar critic rejected on a reachability gap (the migration never running on CI), the blind judges passed the same file three times. | Blind head-to-heads test whether the artifact reads well; they do not test whether it *works on the path that reaches a customer*. Run both, and let the bar critic's verdict govern (**A39** already says winning blind is necessary, not sufficient — this is the second instance). |

### 5.6 Appended 2026-08-22 (phase 8 verification and phase 9)

| # | Entry | Detail |
|---|---|---|
| M14 | A red test was carried across a session boundary as evidence of a product defect. It was a defect in the **probe**: `PROBE 7` invoked `schedule_task` with `prompt` where the tool's parameter is `prompt_text`, so the tool refused the call, `createScheduledTask` was never reached, and the assertion read `undefined` — indistinguishable from an unimplemented feature. | Instrument a failing probe before believing it. One line printing the tool's own return value (`{"text":"prompt_text is required","isError":true}`) and the spy's call count (`0`) settled in one run what the handoff had carried forward as an open defect. **A red test that means the opposite of what it says is worse than no test.** |
| P31 | A verifier's throwaway probe must assert that the call it is probing actually **happened**, not only that the result looks right. `expect(created[0]?.deliveryTarget)` reads `undefined` both when the field is missing and when nothing was ever created. | Assert the arrange step (`expect(spy).toHaveBeenCalledTimes(1)`) before asserting the outcome, so a refused call fails loudly as a refused call. |
| A47 | Phase 8's identity scheme is verified on the wire, not inferred: the Telegram push from the research bot's conversation leaves over `botTOKEN-RESEARCH`; the per-agent Slack push carries that app's own bearer token; `schedule_task` stamps `42:bot-research` and the reply fires over the research token when the task runs. | Established by 12 probe cases driving the real routers with only `fetch` and the DDB-backed lookups stubbed. This supersedes the previous handoff's "Phase 8 was closing the wrong Telegram bot token" as an **open** item — it is closed. |

## 6. Pending work

### 6.1 Smallest next action

**Review [§4.2 group C](#42-files-modified) — the eleven files that were built
and never reviewed.** Concretely: run the three critics that were cut, or review
those files yourself against the same questions. The three that matter most, in
order:

1. **Does `PAPERCLIP_BASE_URL` actually do anything?** `compute-stack.ts:544` sets
   it from `RESOURCE_NAMES.paperclipInternalUrl`, but `src/lib/paperclip/config.ts`
   resolves as `baseUrl: configured ?? env.PAPERCLIP_BASE_URL` — runtime config
   **wins**. Trace it and confirm the env var is reachable rather than
   permanently shadowed. If runtime config always has a value, this change
   accomplishes nothing and the reachability fix is incomplete.
2. **Trace the whole path**: orchestrator task → DNS → security group → Paperclip
   on 3100. Name every hop and what permits it. Any hop you cannot confirm from
   the synthesized template is a defect.
3. **Does the source scan in `format.test.ts` actually fail** when one of the four
   copies of the status vocabulary is stale? Make one stale, run it, revert. If it
   passes, the scan is theatre and the six-lane change has no parity guard.

### 6.2 Immediate next steps, in order

1. **Review group C** (above). Assume nothing in it is correct.
2. **Delete the probe debris**: `src/zzprobe.test.ts`. Confirm no `zz*` files remain.
3. **Run the full documented validation list** from
   [`development.md` step 7](../../../../development.md#how-to-develop-a-new-feature-end-to-end),
   in **both** flag configurations (**M44**). Compare failing file **names**, never
   counts (**A9**). The known-good baseline is exactly five files:
   `scripts/ci/docs-links`, `scripts/ci/feature-knowledge`,
   `scripts/ci/runnable-blocks`, `scripts/release/sync-deprecations`,
   `scripts/lib/lifecycle/rollback-classes`.
   `npm run local:test:integration` needs Docker + Floci — the CLI is at
   `AppData/Local/Programs/DockerDesktop/resources/bin/docker`, the daemon was
   **stopped**, nothing was listening on Floci's port. A command you could not run
   is a blocker to report, not a line to drop.
4. **Commit as two separate, self-contained commits** (owner decision): Phase 8,
   then Phase 9. Verify `git diff --cached --name-only` against the DO-NOT-COMMIT
   table in §4.2 before **each** one (**M17**, **P15**).
5. **The queued IAM ordering fix** (owner decision, see **P33**): add
   `cdk deploy ${CDK_STACK_NAME}-Iam --exclusively` early in `deploy.yml`, before
   the ECR / CodeBuild / secret / migrate steps, and correct the six stale comments
   at `iam-stack.ts:760, :838, :996` and `deploy.yml:249, :354, :477`.
6. **Write the docs**, and do not skip this — five documented positions changed
   tonight and if they are not written back the next session re-derives the same
   wrong premises, which is exactly what **M15** records happening:
   - `implementation-plan.md` — a new `## §37 Addendum`, **append-only**, matching
     `§36`'s four subsections (Shipped / Where execution contradicted this plan /
     Defects execution found that this plan does not contain / Not implemented).
     **Record only what actually shipped.** Never rewrite anything above it.
   - `bar-and-phases.md` and **ADR 0010** — the three reversals in §6.5.
   - `docs/features/paperclip/HANDOFF.md` — current state and the session index.

### 6.5 Decisions taken this session — do not relitigate

Twenty-two decisions, taken by the repository owner. Five contradict what
`bar-and-phases.md`, `HANDOFF.md` or ADR 0010 currently say, and are marked ⚠ —
those documents are now **wrong** until updated.

| # | Decision |
|---|---|
| 1 | Tier floor: **T1+ only, Tier 0 Hobby exempt** ⚠ (`HANDOFF.md` says "every tier, no Tier 0 carve-out") |
| 2 | Both halves of Phase 9 in scope |
| 3 | Staging keeps Tier 0 and gets an **environment-scoped provisioning override** ⚠ (Part D anticipated no such thing; Tier 0 turned out to mean two incompatible things) |
| 4 | Commit locally; **do not push** |
| 5 | Phase 8.5: **pull, not push** for org/goal context; deferred |
| 6 | Retirement: **the legacy path stays permanently as the rollback** ⚠ (the plan says delete it after two clean weeks in production — a clock that cannot start and has been carried across five handoffs) |
| 7 | Shadow soak: **a permanent divergence comparator with an alarm**, not a 48-hour window ⚠ (Phase 5 acceptance item 11) |
| 8 | Multi-tenancy: **one deployment = one company is a permanent commitment**, asserted in the client at construction ⚠ (§15.7 treats it as a current convenience) |
| 9 | Upstream re-pin: a **scheduled check that opens an issue** when upstream ships `updatedSince` natively |
| 10 | P30: **fix it, and add the test that catches the class** — the test must *resolve* a refusal, not reject a promise |
| 11 | A8 clock skew: probe gates **production**, not staging |
| 12 | A46: **probe the endpoint, then write the runbook** |
| 13 | PR shape: **separate self-contained commits now**, split into PRs later |
| 14 | Cost: **CI job summary** names the added monthly cost on first provision |
| 15 | Six lanes order: **Open · In Progress · Blocked · In Review · Done · Cancelled** |
| 16 | Legacy path **accepts all six statuses** — one vocabulary, one validator |
| 17 | **No Tier 1+ opt-out.** The tier is the choice |
| 18 | Reachability: **Cloud Map service discovery** |
| 19 | Upgrade trap: **deploy the IAM stack early in the job** |
| 20 | Tonight's build scope: six lanes, P30, tenancy assert, cost notice, reachability — nothing else |
| 21 | Comparator, alarms, scheduled check and both probes: **deferred with their designs settled** |
| 22 | `.env.example` entries are **owed, not applied** — the file is another session's |

### 6.3 Blockers and open questions

- [ ] Blocker: `npm run local:test:integration` needs Docker and Floci, reported
      down after a restart — needs: `npm run local:up` + `npm run local:provision`.

### 6.4 Deferred, and why

- Phases 4.5, 8.6 and 10–12 — outside the scope this session was asked for,
  which named the client, the reconciler, the authorization layer, the agent
  tools, the Missions UI, and the CDK install-by-default work.

#### Phase 8.5 — deferred mid-session, with its blocking decision already taken

Raised by the author during the session and deliberately not built. The decision
the phase demands *before* any code is settled, so the next session does not
relitigate it.

| Item | State |
|---|---|
| **The caution [`bar-and-phases.md`](../bar-and-phases.md) requires be settled before building** | **SETTLED: pull, not push.** Expose org and goals as tools an agent calls when it needs to escalate or check alignment, and inject at most a one-line "you report to X" into standing context. Injecting the chart and goal tree into every system context bills tokens on *every turn of every agent forever* and grows with the org. Wanting the full chart in every prompt later is a separate, separately-priced decision — the same shape as the install-cost one, and it must be recorded the same way. |
| **Why it was not built** | Acceptance item 1 forbids writing a line against the org JSON before probing it: `GET /api/companies/{cid}/org` declares `additionalProperties: {}`, i.e. guarantees no field at all. **A1-12** is the recorded case of exactly this assumption going wrong. No live Paperclip was available — the Docker CLI is on PATH at `AppData/Local/Programs/DockerDesktop/resources/bin/docker`, but the daemon was stopped and nothing was listening on Floci's port. |
| **File collisions to expect** | `web/src/pages/Missions.tsx` (8.5 wants a goals surface; the six-lane change also edits it) and `src/lib/missions/format.ts` (8.5's cross-surface formatter — prefer a **new** `src/lib/goals/format.ts`, since goals are not missions). `src/lib/tools/paperclip-tools.ts` and the two new files are clear. |
| **Budget** | `TOOL_TURN_LIMIT` is **8**. Ship `paperclip_whoami` and `paperclip_list_goals` first; justify any third. |
| **Do not forget** | Acceptance 4 — every string from the org chart or a goal is a **widened prompt-injection surface**. `neutralizeForPrompt` exists, is tested, and per **C-13** is still called by nothing. This phase is one of the places that must call it. |

## 7. Verification actually performed

**The documented list has NOT been run against the final tree.** It was
deliberately held until the tree settled, and the session was paused before it
did. Everything below is honest about which tree each result describes.

| Command | Baseline (session start) | Mid-session | Against the FINAL tree |
|---|---|---|---|
| `npm run typecheck` | not run | clean after Phase 8/9 | **RAN AT PAUSE. One error, and it is in `src/zzprobe.test.ts` — the throwaway probe that must be deleted anyway (`zzprobe.test.ts(396,36) TS2345`). Every other file, including all of group C, compiles.** |
| `npm test` | **ran** — 222 passed, 6 failed | **ran** — 2844 passed, 1 failed, all pre-existing | **NOT RUN** |
| `CCE_PAPERCLIP_ENABLED=1 npm test` | **ran** — 224 passed, **5 failed = the documented baseline exactly** | ran, clean | **NOT RUN** |
| `npm run build` | not run | not run | **NOT RUN** |
| `npm --prefix web run typecheck` / `build` | not run | ran clean after Phase 8 | **NOT RUN** |
| `npm run local:test:integration` | **NOT RUN — Docker daemon stopped, nothing on Floci's port** | — | **NOT RUN — same blocker** |
| `node scripts/ci/docs-links.mjs` | **ran, OK** — 103 files, 1,028 links | — | **NOT RUN** |
| `node scripts/ci/feature-knowledge.mjs` | **ran, OK** | — | **NOT RUN** |
| `node scripts/ci/diagrams-drift.mjs` | **ran, exit 0 — and it proves nothing locally**, see **P32** | — | **NOT RUN** |
| `git diff --check` | **ran, clean** | — | **NOT RUN** |
| `npx cdk ls` × 7 configurations | 15 vs 18 | **ran — all seven print the same 18 stacks** | not re-run since group C |
| `cdk diff` / `cdk deploy` / any AWS mutation | **NEVER RUN. No resource created, modified or deleted.** | | |

The flag-OFF baseline's six failing files are the five documented environmental
files (`scripts/ci/docs-links`, `scripts/ci/feature-knowledge`,
`scripts/ci/runnable-blocks`, `scripts/release/sync-deprecations`,
`scripts/lib/lifecycle/rollback-classes`) plus `src/zzprobe.test.ts`. Once the
probe's own bug was corrected the flag-ON run failed **exactly** the five. Per
**A9** the comparison is on failing file *names*, never counts.

Probes actually driven this session, all against the real routers with only
`fetch` and the DDB-backed lookups stubbed:

| Probe | Result |
|---|---|
| Telegram per-agent push | `botTOKEN-RESEARCH/sendMessage`, `chat_id 42` — the bot that owns the chat, not the turn agent |
| Telegram main-bot push | `botTOKEN-MAIN`, unchanged |
| Slack per-agent push | `Bearer xoxb-RESEARCH-APP` into `C0AGENT`, thread preserved |
| Slack main-bot push | workspace token, unchanged |
| Failed push honesty | Telegram 403 and Slack `not_in_channel` both render "This chat was not notified" |
| Stickiness regression | sticky `main` still answers in the research bot chat; an explicit prefix still out-ranks the bot token |
| `schedule_task` identity | stamps `42:bot-research`; `deliverScheduledReply` then fires over `botTOKEN-RESEARCH` |

Anything not run, and why: the remainder of the documented list is deliberately
held until the Phase 8 fix round closes, so that it is run once against the code
that will actually be committed rather than against a tree that is still moving.

## 8. Environment state

- **Tools and services**: Windows 11, normal clone (not a linked worktree —
  **M6**). Docker and Floci reported down after a restart.
- **Active processes**: none left running.
- **Environment variables**: `CCE_PAPERCLIP_ENABLED` exercised in both states.
  Names only.
- **Uncommitted work left in the tree**: `.env.example`, `CLAUDE.md` and the two
  root-level `handoff-*.md` files belong to **other sessions** and are not this
  session's to commit (**P6**). `src/zzprobe.test.ts` is a throwaway probe and
  is not for commit either.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [The bar and phase decomposition](../bar-and-phases.md)
- [Previous session handoff](./2026-08-21-paperclip-phases-2-to-9.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
