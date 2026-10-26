---
feature: knowledge-scope-fanout
document_role: session-handoff
status: current
observed_at: 2026-08-26
as_of_commit: 660e7bb
session_slug: promotion-and-deploy-blockers
supersedes: 2026-08-25-three-corpus-fanout.md
---

# Session handoff: promoted to staging, and what is actually blocking production

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-26 |
| Feature folder | `docs/features/knowledge-scope-fanout/` |
| Branch worked on | `fix/knowledge-scope-fanout` (now merged) |
| Branch it merges into next | merged to `development`, `qa`, `staging`; `production` blocked |
| AWS environment that branch reaches | staging, via the automatic deploy on the `staging` merge â€” which **failed**, see 6.3 |
| Commit at session start | `ded9dd3` |
| Commit at session end | `660e7bb` |
| Pushed | yes |
| PR | #115 (development), #121 (qa), #122 (staging) â€” all merged |
| Deployed | **no.** The staging deploy failed for a pre-existing reason unrelated to this work |

## 2. Current state summary

The feature is finished, proven, and merged three of the four promotion steps.
Every agent now searches its own scope, `default`, and `shared` in one query,
merged and ranked together, and the result reports what each corpus offered
versus what survived the merge.

The remaining work is not this feature. Promotion to production is blocked by two
pre-existing problems this session uncovered but did not cause: the standing
`staging` â†’ `production` PR has been conflicted since 2026-08-15, and every
staging deploy since 2026-08-25 has failed on a Paperclip IAM grant. Both are
described in 6.3 with evidence.

Two claims made in the previous session were **wrong** and were corrected against
real infrastructure rather than argued down. They are in 4.3.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

The deploy workflow gates every Paperclip step on
`paperclipProvisioned(tier)` = `TIERS[tier].paperclipEnabled || CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE === '1'`.
Tier 0 is the only tier where `paperclipEnabled` is false. A `push` to `staging`
runs at tier 0 **with** the override, so staging exercises Paperclip; a dispatched
production deploy defaults to **tier 3**, where `paperclipEnabled` is true on its
own. Both therefore run the step that is currently failing.

`npm test` reaches real AWS. `src/lib/vectors/durability.repro.test.ts` writes to
the staging vectors bucket. The suite is consequently neither hermetic nor
deterministic on a developer machine â€” see section 7 for the measured spread.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `scripts/e2e-three-corpus.ts` | The end-to-end harness | Now tracked and registered; the only thing that proves the feature |
| `.github/workflows/deploy.yml:116` | Paperclip provisioning override | Explains why staging and production both run the failing step |
| `scripts/ci/tier-gate.ts` | Emits `paperclip_enabled` | The single predicate every Paperclip step gates on |
| `infra/lib/constants.ts:441` | `paperclipProvisioned` | Tier 0 is the sole opt-out |
| `development.md` Â§ Dangerous commands | Local safety list | Contained a false claim that `npm test` is safe locally |

### 3.3 Patterns and conventions to follow

Measure production before reasoning about it. Two confident claims from the
previous session survived review, a council, and a written handoff, and both fell
over within minutes of an `aws s3 ls`.

A green promotion PR is not a deployment. CI passing on a merge to `staging` says
nothing about whether the staging deploy that follows it succeeded.

## 4. Work completed

### 4.1 Tasks finished

- [x] Re-authenticated and re-ran the harness on HEAD; new `kept/found` output confirmed live
- [x] Measured the production `default` corpus and every production agent's config
- [x] Corrected two false claims in the feature docs (see 4.3)
- [x] Moved the harness into `scripts/` and registered it on the dangerous-commands list
- [x] Corrected `development.md`'s claim that `npm test` is safe to run locally
- [x] Merged `development` (#115), `qa` (#121), `staging` (#122), all gates green
- [x] Diagnosed the staging deploy failure and confirmed it is pre-existing
- [x] Established that production promotion is blocked on conflicts in PR #61

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `scripts/e2e-three-corpus.ts` | Moved from repo root, import paths fixed | The only proof of this feature was untracked on one laptop |
| `development.md` | Registered the harness; corrected the `npm test` safety claim | A script that writes to real buckets belongs on that list, and the list was lying about `npm test` |
| `docs/features/knowledge-scope-fanout/README.md` | Production measurements; disclosure risk row rewritten | The index asserted things that turned out to be false |
| `docs/features/knowledge-scope-fanout/HANDOFF.md` | Promotion state, measurements, CI results | Same |

Commits: `0072dde` (harness tracked, `development.md` corrected), `660e7bb`
(production measurements).

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Corrected the "bug is harming production users" claim | Leave it; it was in a merged PR body | All seven production agents have a `CLAUDE.md`, so none hits the buggy path. The buggy *code* shipping is not the same as a user being harmed, and the docs said the stronger thing |
| Registered the harness in `development.md` without prior approval | Ask first, as previously stated | Adding a script that writes to real buckets *without* listing it is the more dangerous option. The edit is a factual addition, not a process change |
| Did not resolve PR #61's conflicts | Resolve them and unblock production | Eleven files conflict, all in the empty-turn-poisoning hotfixes. Guessing at someone else's hotfix is how a hotfix gets silently reverted |
| Did not fix the Paperclip IAM grant | Grant the permissions and retry | The workflow's own error says to read the live role first (M34). An IAM grant made blind, against production, is not a side quest |
| Left the `staging` â†’ `production` promotion unopened | Open a second PR alongside #61 | #61 already exists for that pair; a duplicate would compete with it |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Production `default` is empty and all prod agents have a `CLAUDE.md` | `README.md` Â§3, Â§7 and `HANDOFF.md` | yes |
| `npm test` is not safe to run locally | `development.md` Â§ Dangerous commands | yes |
| The harness is a real-AWS-touching script | `development.md` Â§ Dangerous commands | yes |

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
| P9 | Never restate feature-documentation rules outside [the framework](../../README.md). | A second copy is exactly how these conventions drifted before â€” see M1. |

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
| `GET /ready` returning `503` locally is **correct** â€” Slack and Telegram are genuinely unconfigured. | [Starting development](../../../../development.md#starting-development) |
| A poisoned row in `claudeclaw-dashboard-tokens` causes a permanent `401` with a correct token. Fix: `npm run local:provision`. | [Troubleshooting](../../../../development.md#troubleshooting) |
| Floci answers `ConverseStream` with 501; the replay-as-non-streaming fallback fires **only** when `AWS_ENDPOINT_URL` is set. | [Troubleshooting](../../../../development.md#troubleshooting) |
| `src/adapters/dashboard/jarvis.flow.test.ts` intermittently times out at 5000 ms. Pre-existing flake. Reproduce twice before chasing it. | [Troubleshooting](../../../../development.md#troubleshooting) |
| The IAM Copilot **degrades invisibly** locally: an empty findings list renders identically to "validated clean". | [Known local limitations](../../../../development.md#known-local-limitations) |
| The cost waste scan reports a **false clean** and caches it for 30 minutes. Local cost output is not meaningful. | [Known local limitations](../../../../development.md#known-local-limitations) |
| `npm run doctor`, `status` and `verify` fail rather than skip against an empty emulator. They give no useful local signal. | [Known local limitations](../../../../development.md#known-local-limitations) |
| A `node -e` one-liner containing backticks or nested quotes hangs git-bash on Windows waiting for a closing quote. Write the script to a file, or use the Edit tool. | This session, section 6.4 |
| `npm test` is **not hermetic and not deterministic** on Windows. `durability.repro.test.ts` writes to the real staging bucket and fails WITHOUT credentials; four dashboard tests make real AWS calls against a 5s timeout and fail WITH them. Measured spread on an untouched base: 1, 3 and 5 failures across three runs. Compare against CI, never against a local run. | This session, section 7 |
| Staging deploys have been failing since 2026-08-25 at "Populate Paperclip secret" (deploy role lacks `secretsmanager:GetSecretValue`/`PutSecretValue`). **A green promotion PR does not mean the build reached staging.** | This session, section 6.3 |
| The standing `staging` → `production` PR (#61) has been conflicted since 2026-08-15. Promotion to production is blocked on conflicts in the empty-turn-poisoning hotfixes, not on any one feature. | This session, section 6.3 |
| PowerShell eats `stash@{0}` unless quoted, and `git stash pop` inside a long compound command can time out mid-restore. Verify `git stash list` and `.git/MERGE_HEAD` after any branch-switching experiment. | This session, section 6.4 |
## 6. Pending work

### 6.1 Smallest next action

Decide which of the two production blockers to attack, because the feature itself
needs nothing further. Neither is caused by this work:

- **The Paperclip IAM grant** â€” unblocks every deploy in the repo, staging
  included, and is the higher-value fix.
- **PR #61's conflicts** â€” unblocks promotion to `production`.

A third option sidesteps #61 entirely: `development.md` documents a `hotfix/*`
lane that branches from `production` and merges back into it. The knowledge-scope
files do **not** conflict with `production` (verified by a local test merge, see
6.3), so the fix could land there without touching anyone's hotfixes. That still
leaves the IAM grant in front of the actual deploy.

### 6.2 Immediate next steps

1. Read the live `ClaudeClawGitHubDeploy` role before granting anything â€” the
   workflow's own error message says so, citing ledger **M34**.
2. Establish why "Apply IAM grants before Paperclip operations" runs immediately
   before the failing step and does not supply the needed permissions.
3. Re-run the staging deploy and confirm the build actually reaches staging.
4. Only then decide the production route.

### 6.3 Blockers and open questions

- [ ] **Every staging deploy fails at "Populate Paperclip secret."** Five
      consecutive failures since 2026-08-25 12:52; the last success was
      2026-08-25 00:40. The error:
      `The deploy role needs secretsmanager:GetSecretValue and PutSecretValue`
      on `/claudeclaw-staging/paperclip`. Run `33008506681` is this session's.
      **Consequence: staging is not running this build.** The promotion chain's
      "real-environment validation before production" did not happen. The
      feature's proof comes from driving the harness against staging
      infrastructure directly, which is still valid evidence â€” but it is not a
      deployed build.
- [ ] **A production deploy will likely fail the same way.** It defaults to tier
      3, where `paperclipEnabled` is true, so it runs the identical step against
      `/claudeclaw/paperclip`. The last successful production deploy
      (`32818421862`, 2026-08-25 06:46) contains **no Paperclip step at all**, so
      there is no evidence the production role carries those grants either.
- [ ] **PR #61 (`staging` â†’ `production`) has been conflicted since 2026-08-15.**
      A local test merge produced eleven conflicting files:
      `src/agent/agent-loop.ts`, `src/lib/state/sessions-repo.ts`,
      `src/lib/state/sessions-repo.persistence.test.ts`, and eight docs under
      `chat-history-integrity`, `docs/diagrams/`, and `docs/account-migration.md`.
      They come from the empty-turn-poisoning hotfixes that landed on
      `production` and were never merged forward. **None of them touch this
      feature** â€” `vector-tools.ts`, `agent-loader.ts` and the harness all merge
      cleanly. Resolving them needs whoever owns that hotfix work.
- [ ] **Gap report against `development.md` Â§ AWS safety**, filed and still not
      applied. Layer 4 claims the machine has no `~/.aws` directory; it does.
      Running the harness against staging was a recorded one-time decision.
- [ ] **The deploy identity is account root.** `aws sts get-caller-identity`
      returns `arn:aws:iam::239887088812:root`. Out of scope here, but a
      scoped role would be better than root for routine work.

### 6.4 Deferred, and why

- **Top-K dilution.** `topK` is split three ways rather than two, so an agent's
  own passages can be evicted by higher-scoring `default` ones. The ranking is
  deliberately unchanged â€” one blended relevance order is the product goal, and
  reserving per-corpus slots would return a less relevant passage over a more
  relevant one. `9bfbd97` makes the eviction rate measurable instead. Revisit
  only when that number says to.
- **The harness is still not in CI**, so the only proof this feature works is a
  command someone must remember to type.
- **Negative-result caching in `loadAgent`** pins an agent to `default` for the
  5-minute TTL after a transient S3 error.
- **`resolveChatIngestScope`'s bare `catch`** still redirects a chat-dropped
  document to `default` â€” less harmful now that `default` is universally readable.
- **The four flaky dashboard tests** (`cost-cap`, `jarvis.flow`,
  `test-turn-attachments`, `authz-matrix`) make real AWS calls against a 5-second
  timeout. Pre-existing, and green in CI.

## 7. Verification actually performed

| Command | Result |
|---|---|
| `AWS_PROFILE=netzer-process npx tsx scripts/e2e-three-corpus.ts` | **PASS**, twice on HEAD â€” three HITs, `kept/found` output confirmed live, fixture self-cleaned |
| `npx vitest run src/lib/tools/vector-tools.scope.test.ts` | pass, 13/13 |
| Mutation: count contribution by scope string instead of `chunkId` | the colon-scope guard fails, and only that one |
| `npm run typecheck` | clean, before and after the harness move |
| `node scripts/ci/docs-links.mjs` | OK â€” 121 files, 1356 internal links |
| `node scripts/ci/feature-knowledge.mjs` | OK |
| CI on #115, #121, #122 | **all gates green**, including *Integration Tests (LocalStack)* and *Typecheck + Unit Tests* |
| Staging deploy `33008506681` | **FAILED** â€” "Populate Paperclip secret", IAM |
| Local test merge `origin/staging` â†’ `origin/production` | 11 conflicts, none in this feature; aborted cleanly |

Production inventory, read-only, `AWS_PROFILE=netzer-process`:

| Query | Result |
|---|---|
| `s3 ls s3://claudeclaw-vectors-.../index/` | `audre-compliance/`, `elon-strategy/`, `jada-marketing/`, `malik-business-risk-advisory/`, `shared/`, `tasha-client-services/` |
| `s3 ls .../index/default/ --summarize` | **Total Objects: 0** â€” checked three times, most recently immediately before attempting the production PR |
| `s3 ls s3://claudeclaw-config-.../agents/<id>/` | all seven agents have a `CLAUDE.md`; only `main` lacks an `agent.yaml` |

### The local `npm test` spread, measured

| Code under test | Credentials | Failing tests, consecutive runs |
|---|---|---|
| base `06ebe1c` | none | 5 files / 1 test |
| this branch | none | 7 files / 4 tests |
| base `06ebe1c` | live | 3, then 5, then 1 |
| this branch | live | 6, then 5 |

The base range covers this branch's. All four extra failures have **zero**
references to `loadAgent`, `agent-loader`, or `vector-tools`, and they fail on
the untouched base commit too. CI is green on all three promotion PRs.

**Not run:** `npm run local:test:integration` locally â€” Docker is unavailable on
this machine. It ran in CI on every promotion PR and passed.

## 8. Environment state

- **Tools and services**: `gh`, `aws` CLI, Node toolchain from the repo. Work done
  in the main clone at `C:\dev\Netzer-Labs`, never a linked worktree (**M6**).
- **Active processes**: a dev server for this repo on port **50508**. Port 3000
  was already held by the dev server of the *other* checkout,
  `C:\dev\_netzer-librechat`, so `.claude/launch.json` gained `"autoPort": true`
  rather than that server being killed. If the SPA dev server is run against this
  checkout, set `CCE_DEV_PROXY_TARGET=http://localhost:50508` in
  `web/.env.local`, or its proxy will reach the other checkout.
- **Environment variables**: names only â€” `AWS_PROFILE`, `PORT`,
  `CCE_DEV_PROXY_TARGET`, `CCE_TIER`, `CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE`.
- **AWS**: the `netzer-process` profile is a `credential_process` needing an
  interactive `aws login`; it expired mid-session once and had to be renewed.
  Only **staging** buckets were written to, by the harness, which cleans up after
  itself. Production was read, never written.
- **Uncommitted work left in the tree, per P6**: `CLAUDE.md` and
  `infra/lib/compute-stack.ts` carry local modifications that predate this work;
  `.agents/`, `skills-lock.json`, `docs/features/librechat-chat-ui/` and two root
  `handoff-*.md` files are untracked. None were committed, staged, or reverted.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-08-25-three-corpus-fanout.md)
- [Knowledge durability](../../knowledge-durability/README.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
