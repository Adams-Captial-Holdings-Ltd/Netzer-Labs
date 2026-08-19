---
feature: paperclip
document_role: session-handoff
status: current
observed_at: 2026-08-19
as_of_commit: bfe870724dc38ee8cd470b4a44ce95e121e22f21
session_slug: org-transfer-oidc-and-staging-deploy
supersedes: 2026-08-19-docs-consolidation
---

# Session handoff: unblock the staging deploy after the org transfer

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-19 |
| Feature folder | `docs/features/paperclip/` |
| Branch worked on | `fix/oidc-immutable-subject-claims` (cut from `development` at `bfe8707`) |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `bfe870724dc38ee8cd470b4a44ce95e121e22f21` |
| Commit at session end | the commit carrying this file |
| Pushed | see §7 |
| PR | into `development` |
| Deployed | **no** — staging deploy still owed; the blocker that stopped it is now cleared |

## 2. Current state summary

The Paperclip work reached `staging` earlier today by the normal ladder —
[#72](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/72) into
`development`, [#73](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/73)
into `qa`, [#76](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/76)
into `staging`. CI, Docs CI and Branch Guard are green on every rung, and the
2026-08-18 Actions billing blocker is gone.

The **staging deploy was red**, at exactly one step. Run
[32279945039](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/runs/32279945039)
cleared the source guard, typecheck and the unit suite, then failed
`Configure AWS credentials (OIDC)` with `Not authorized to perform
sts:AssumeRoleWithWebIdentity`.

The cause was the **subject claim format, not the repository path**. This org
mints immutable OIDC subjects carrying numeric ids. A token decoded from a
real run on this repo (run `32280530601`) carries:

```text
repo:Adams-Captial-Holdings-Ltd@318461635/Netzer-Labs@1324639154:ref:refs/heads/debug/oidc-sub
```

and `gh api repos/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/oidc/customization/sub`
reports the same id-bearing `sub_claim_prefix`. `infra/lib/github-oidc.ts`
generated `repo:<owner>/<repo>:...` under `StringEquals` with wildcards
deliberately rejected, so the policy could never match. That is why updating
the trust policy to the new repo path in the previous session did not fix it.

No repository or environment **secret** is involved: `deploy.yml` consumes only
`vars`, and every one survived the transfer.

**Both halves of the fix are now in place.** The generator and workflow are
fixed on this branch, the `CCE_GITHUB_IMMUTABLE_SUBJECT` variable is set, and
the live `ClaudeClawGitHubDeploy` trust policy was updated by the user and
verified by this session to match what the fixed CDK emits — so the next
`cdk deploy` regenerates an identical policy rather than flipping it back.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- GitHub mints OIDC subjects in two non-interchangeable forms:
  `repo:<owner>/<repo>:...` and `repo:<owner>@<owner_id>/<repo>@<repo_id>:...`.
  Which one you get is a property of the org/enterprise, not of the workflow,
  and it changed under this repository when it was transferred. The
  authoritative reading is `sub_claim_prefix` from
  `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`, or the decoded
  `sub` of a token a workflow actually minted.
- The failure mode is maximally misleading: an exact-match trust one format out
  reports `Not authorized to perform sts:AssumeRoleWithWebIdentity`, which
  reads as an AWS permissions fault and is a GitHub-side format change.
- **`cdk deploy` rewrites the deploy role's own trust policy.** `IamStack`
  builds `ClaudeClawGitHubDeploy` from `resolveGithubOidcTrust(process.env)`
  whenever `CCE_CICD_ENABLED=1` and `CCE_NAME_SUFFIX` is empty. An IAM hand-fix
  without the matching generator change therefore survives exactly one deploy.
- `DatabaseStack` and `FilesystemStack` (Phase 1) are wired unconditionally in
  `infra/bin/app.ts` — **no tier gate, no feature flag**. A Tier 0 staging
  `cdk deploy --all` provisions the same Aurora Serverless v2 PG17 cluster as
  production, with `deletionProtection: true` and `RemovalPolicy.RETAIN` on the
  cluster, the EFS filesystem and the log group.
- The deploy job runs with `environment: staging`, so its token's subject is
  the `:environment:staging` form rather than `:ref:refs/heads/staging`. The
  trust lists both, so either works — a policy pinned only to refs would not.
- The Paperclip bootstrap fixture is fail-closed on a *stale* stack, not just a
  missing one: it aborts with `Active Paperclip integration keys exist without
  the in-memory credential cache` when a previous session's stack outlives the
  process that provisioned it. The disposable stack must be reset per run.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `infra/lib/github-oidc.ts` | Fail-closed OIDC trust resolution | Generated the wrong subject form for this org; now emits either |
| `infra/lib/github-oidc.test.ts` | Pins the trust contract | 3 new tests cover the id-bearing form and the numeric guard |
| `.github/workflows/deploy.yml` | The staging/prod deploy | Forwards the ids, opt-in via `CCE_GITHUB_IMMUTABLE_SUBJECT` |
| `infra/lib/iam-stack.ts` | Creates `ClaudeClawGitHubDeploy` | Unchanged, but it is what rewrites the live trust policy |
| `infra/bin/app.ts` | Stack wiring | Where the ungated Paperclip Aurora/EFS stacks enter a staging deploy |
| `docs/github-to-aws.md` | Documents where the trust control lives | Was silent on immutable subjects |

### 3.3 Patterns and conventions to follow

- OIDC trust stays **fail-closed and exact-match**: no wildcard reaches a
  subject, and the ids are digits-only for the same reason.
- New deploy knobs are opt-in through Actions `vars`, matching how
  `CCE_PUBLIC_ACCESS`, `CCE_EMAIL_FROM` and the rest are already forwarded.
- Cross-surface chat parity per [`CLAUDE.md`](../../../../CLAUDE.md) — not
  touched this session.

## 4. Work completed

### 4.1 Tasks finished

- [x] Diagnosed the red staging deploy to the exact claim, from a decoded token
  and the OIDC customization API rather than by inference.
- [x] Confirmed the deploy workflow needs **no** secrets and that every `vars`
  entry survived the org transfer.
- [x] `infra/lib/github-oidc.ts`: optional `CCE_GITHUB_OWNER_ID` /
  `CCE_GITHUB_REPO_ID` producing the id-bearing subject, with a digits-only
  guard so a wildcard or an un-interpolated `${{ }}` cannot reach the policy.
- [x] 3 tests, written first and watched fail for the right reason.
- [x] `.github/workflows/deploy.yml`: forwards the ids when
  `vars.CCE_GITHUB_IMMUTABLE_SUBJECT == '1'`.
- [x] `docs/github-to-aws.md`: documented both subject forms and how to tell
  which one a repository gets.
- [x] Second pass at the user's request to cut over-engineering: removed three
  speculative guards, halving the diff (176 added lines → 83) with an
  unchanged generated policy, verified by regenerating and diffing it.
- [x] Verified the live IAM trust policy matches the generator's output exactly.
- [x] Split a mixed commit back into one-logical-change commits (see M17).

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `infra/lib/github-oidc.ts` | Optional numeric owner/repo ids in the subject | The org mints immutable subjects; exact-match trust must match them |
| `infra/lib/github-oidc.test.ts` | +3 tests | Pin both subject forms and the numeric guard |
| `.github/workflows/deploy.yml` | Forward the ids, opt-in by `vars` | A fork on classic subjects must not be broken by this |
| `docs/github-to-aws.md` | Immutable-subject bullet | The doc described only the classic form |
| `docs/features/paperclip/HANDOFF.md` | Volatile-state update + session index row | Ladder position and the cleared blocker |
| `docs/features/paperclip/handoffs/2026-08-19-org-transfer-oidc-and-staging-deploy.md` | New | This file |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Match the immutable subject rather than disable it org-side | Ask an org/enterprise owner to turn the setting off | User chose to match. The id-bearing form is the stronger binding — a repo deleted and recreated under the same name cannot inherit deploy trust — and it needs no org policy change. |
| Opt-in per repo via `CCE_GITHUB_IMMUTABLE_SUBJECT` | Always send the ids | Always-on would lock out any fork whose org still mints classic subjects, exactly as this repo was locked out. Default off preserves existing behaviour. |
| Ids are digits-only | Accept any string; reuse `rejectWildcards` | Digits-only is strictly stronger than wildcard rejection and is three lines. It catches the realistic failure: a `${{ }}` that failed to interpolate. |
| Dropped the both-or-neither and `@`-in-name guards | Keep them as fail-closed insurance | Unreachable through the only caller (`deploy.yml` sets both from one condition), and the `@` check policed a spelling that would have worked. Cut on the user's explicit "don't over-engineer". `ownerId && repoId` in the subject expression covers the pair case in zero extra lines. |
| `cdk diff` before any staging deploy | Deploy staging straight through | User chose diff-first. Phase 1 puts a retained, deletion-protected Aurora cluster into staging with no tier gate. |
| Continue in the `paperclip` feature folder | A new feature folder for the CI fix | The org transfer and its OIDC follow-up are already recorded as paperclip session state; a second folder would split one thread. |
| Committed the concurrent session's doc work as its own commit | Leave it uncommitted; revert it | It had been staged into the shared index and was swept into one of this session's commits. Splitting it back out keeps each commit describing what it contains, and the user confirmed the doc work is wanted. |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The two OIDC subject forms and how to tell which you get | `docs/github-to-aws.md` | yes |
| The generator's new inputs and their guard | `infra/lib/github-oidc.ts` header comment | yes |
| `cdk deploy` rewrites the trust policy, so set the var first | `.github/workflows/deploy.yml` comment + `docs/github-to-aws.md` | yes |

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
| M16 | After the org transfer, the trust policy was updated to the new **repo path** and the deploy still failed — a second session lost to an `AssumeRoleWithWebIdentity` error that reads like an AWS permissions problem. | An org transfer can change the claim **format**, not merely its contents. Decode the token's real `sub` before touching IAM. RESOLVED (this session). |
| M17 | This session committed with explicit `git add <paths>`, believing that scoped the commit — but a concurrent agent had staged its own work into the **shared index**, and `git commit` committed the index, sweeping ~900 KB of another session's docs into a commit whose message described a small refactor. | `git add <paths>` scopes what *you* add, not what the commit contains. When another process may share the working tree, verify with `git status`/`git diff --cached` immediately before committing, or use `git commit <paths>`. Corrected by splitting the commit in two. RESOLVED (this session). |
| P13 | Set `CCE_GITHUB_IMMUTABLE_SUBJECT` **before** the first green deploy, never after. A hand-patched IAM trust with the variable unset buys exactly one deploy, because that deploy rewrites the policy back to the classic form. | The fix has two halves with a required order; reversing it re-creates the outage and looks like a regression. |
| P14 | When an OIDC assume-role fails, decode the token's real `sub` before changing IAM. | The error names AWS; the cause was on GitHub's side. |
| A11 | `Adams-Captial-Holdings-Ltd/Netzer-Labs` mints **immutable** OIDC subjects: `repo:Adams-Captial-Holdings-Ltd@318461635/Netzer-Labs@1324639154:...`. | Verified twice on 2026-08-19 — a decoded token from run `32280530601`, and `sub_claim_prefix` from the OIDC customization API. Re-verify if the repo moves again. |
| A12 | The deploy workflow needs no repository or environment **secrets**; it reads only `vars`, all of which survived the transfer. | Verified with `gh variable list` and the per-environment variables/secrets API. `CDK_DIFF_ROLE_ARN` is still absent and still only affects the scheduled drift workflow. |
| A13 | The live `ClaudeClawGitHubDeploy` trust policy now lists the four id-bearing subjects and matches the fixed generator's output exactly. | Verified with `aws iam get-role` against the regenerated policy on 2026-08-19, so the next `cdk deploy` is a no-op on the trust rather than a flip-back. |
| Trap | A `cdk deploy` rewrites `ClaudeClawGitHubDeploy`'s own trust policy, so an IAM hand-fix alone survives exactly one deploy. | [github-to-aws.md](../../../github-to-aws.md), `.github/workflows/deploy.yml` |
| Trap | Phase 1's Aurora and EFS stacks have **no tier gate**, so Tier 0 staging provisions the same retained, deletion-protected cluster as production. | `infra/bin/app.ts`, `infra/lib/database-stack.ts` |
| Trap | The Paperclip bootstrap fixture aborts on a **stale** stack (`Active Paperclip integration keys exist without the in-memory credential cache`), not only a missing one. Reset the disposable stack per run rather than reusing one a previous session left up. | `tests/fixtures/paperclip-bootstrap.ts`, [README §8](../README.md) |

## 6. Pending work

### 6.1 Smallest next action

Merge this branch up the ladder — `development` → `qa` → `staging`. The
`qa → staging` merge **is** the release action for staging; it deploys on push.
Before that merge, run `cdk diff` against the account with the staging
environment variables and read every line (§6.3).

### 6.2 Immediate next steps

1. PR this branch into `development`; promote through `qa` to `staging`.
2. `cdk diff` first, per the user's decision — Phase 1 adds Aurora + EFS to
   staging and it has never been diffed against the real account.
3. Re-run the staging deploy and confirm the OIDC step passes.
4. Phase 1 steps 7–8 remain: the ARM64 buildx answer and the patched Paperclip
   image push to the new ECR repo.

### 6.3 Blockers and open questions

- [ ] `cdk diff` against the account is still owed before the staging deploy.
  AWS credentials are now available (root session), so this is runnable.
- [ ] Question: should the `updatedSince` patch be offered upstream? — user
  approved "patch our copy" only; upstreaming is optional follow-up.
- [ ] Open: `npm run setup` (Q11c) writes the GitHub OIDC variables into `.env`
  for local deploys and does not ask for the immutable-subject ids. A local
  `cdk deploy` with `CCE_CICD_ENABLED=1` and no ids would rewrite the trust
  policy back to the classic form and lock CI out. Not fixed here — CI is the
  only deploy path in use, and this is the place to fix it if that changes.
- [ ] `.gitignore` and `CLAUDE.md` carry uncommitted edits from the concurrent
  documentation session. Left for their owner per **P6**.

### 6.4 Deferred, and why

- Paperclip ECS service, client, reconciler, ACL, tools, UI — later plan
  phases, in order.
- Gating the Paperclip Aurora/EFS stacks behind a flag — offered and not
  chosen; the user opted for `cdk diff` review instead.

## 7. Verification actually performed

The nine-command list is the one in
[development.md — How to develop a new feature](../../../../development.md#how-to-develop-a-new-feature-end-to-end),
step 7. Every row below was run in full on this branch after the final code
state, not a scoped subset.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | not run separately | clean (exit 0) |
| `npm test` | at `bfe8707`: 192 files / 2121 tests — 5 files failed, 1 test failed, 1 file + 6 tests skipped | 192 files / 2124 tests — 5 files failed, 1 test failed, 6 skipped. **Same five file names as baseline**, verified by name not count per A9: `scripts/ci/docs-links.test.ts`, `scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`, `scripts/release/sync-deprecations.test.ts` (parser `SyntaxError`), `scripts/lib/lifecycle/rollback-classes.test.ts` (path separator). No new failures. |
| `npm run build` | not run | clean (exit 0) |
| `npm --prefix web run typecheck` | not run | clean (exit 0) |
| `npm --prefix web run build` | not run | clean (exit 0) |
| `npm run local:test:integration` | not run | 9/10 files, **40/41 tests, 0 skipped**. The lone failure is the documented Floci gap `destroy.integration.test.ts > checkSecrets … schedule-deleted`. Paperclip **I3 + FI-4 green** — 0 skipped confirms the live gate ran rather than being env-skipped. |
| `node scripts/ci/docs-links.mjs` | not run | **OK** |
| `node scripts/ci/feature-knowledge.mjs` | not run | **OK** |
| `git diff --check` | not run | clean (exit 0) |
| `node scripts/ci/diagrams-drift.mjs` (extra) | not run | clean; none of this change's files are mapped in `docs/diagrams.map` |
| Focused `infra/lib/github-oidc.test.ts` (extra) | 4 new tests failing for the intended reason | 9/9 pass |
| Generated trust policy vs. the live IAM policy (extra) | n/a | **identical** — `aws iam get-role` output matches the regenerated document, so the next `cdk deploy` does not flip the trust back |

Anything not run, and why: `npm run synth` is not on the documented list and
was not run this session; the previous session ran it clean at `44aad84` and
this change does not add or remove a stack. `cdk diff` against the account is
**not run** and is still owed before the staging deploy — see §6.3.

## 8. Environment state

- **Tools and services**: Node v24.19.0, npm 11.17.0, AWS CLI 2.36.21,
  gh 2.96.0, Vitest 2.1.9, PowerShell on Windows 11.
- **Active processes**: the disposable Paperclip stack
  (`netzer-labs-paperclip-1`, `netzer-labs-paperclip-db-1`) was reset with
  `down -v` and re-created twice this session; Floci (`netzer-os-floci`) was
  started with `npm run local:up`. Stop them with `npm run test:paperclip:down`
  and `npm run local:down`.
- **Environment variables**: `PAPERCLIP_TEST_AUTH_SECRET` was generated
  per-process for the disposable stack and never printed (P11).
- **AWS**: a root session is live (`aws sts get-caller-identity` returns
  `arn:aws:iam::239887088812:root`). Per **A6** this is the working access path.
- **GitHub**: `CCE_GITHUB_IMMUTABLE_SUBJECT=1` is set as a repository variable
  (2026-08-19). The live `ClaudeClawGitHubDeploy` trust policy carries the four
  id-bearing subjects.
- **Uncommitted work left in the tree**: `.gitignore` and `CLAUDE.md` edits from
  the concurrent documentation session, plus the user's untracked
  `handoff-connector-availability-2026-08-15.md` and
  `handoff-staging-deploy-2026-08-14.md` — per **P6**, not staged, not touched.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](2026-08-19-docs-consolidation.md)
- [GitHub to AWS trust](../../../github-to-aws.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
