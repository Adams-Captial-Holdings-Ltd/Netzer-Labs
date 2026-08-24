---
feature: knowledge-durability
document_role: session-handoff
status: current
observed_at: 2026-08-24
as_of_commit: 17fadd1
session_slug: cors-outage-and-hotfix
supersedes: none
---

# Session handoff: the second cause — CORS — and the production hotfix

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-24 |
| Feature folder | `docs/features/knowledge-durability/` |
| Branch worked on | `hotfix/durable-knowledge-bucket` (from `production`), backported on `fix/knowledge-durability-backport` (from `development`) |
| Branch it merges into next | `production` for the hotfix; `development` for the backport |
| AWS environment that branch reaches | `production` deploys production, manual dispatch only — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `17fadd1` (development), `992fd9d` (production) |
| Commit at session end | see git log on both branches |
| Pushed | yes — both branches |
| PR | [#91](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/91) production, [#92](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/92) development, [#93](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/93) qa, [#94](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/94) staging — all merged |
| Deployed | **yes — production, 2026-08-24, tier 2.** Task definition `8` → `9`. Staging NOT deployed (see 6.3) |

## 2. Current state summary

The previous session's RCA was **confirmed against the live AWS account**, which
it never could be (credentials were expired for that whole session). It is
correct: `expire-staging-fast` on
`claudeclaw-vectors-staging-239887088812-us-east-1` really does carry
`Filter.Prefix ""` — an empty prefix matching every key — with a 7-day
expiration, on a bucket where versioning was never enabled. `index/` now holds
**0 objects**. The bucket is entirely empty.

But the RCA does **not** explain the symptom the operator reported this session:
uploads *erroring right now*. An expiry deletes an object seven days after it is
written; a document imported today would still be there. It is not.

The residual cause was found, and it is unrelated to lifecycle rules. The
vectors bucket's CORS allowlist contains exactly one origin,
`http://localhost:3000`, while the dashboard is served from
`https://app.pgnos.ai`. Every browser PUT dies in CORS preflight. The request
never reaches the server, which is why nothing appears in the orchestrator log
and why `presignUploadUrl` records no failure — presign *succeeds*, and the
upload that follows it is refused by the browser. `uploads/` holding 0 objects
is the corroborating evidence: no upload has ever landed.

**Two independent defects, two different symptoms.** The lifecycle rule explains
why the knowledge that *was* there is gone. CORS explains why nothing new can be
added. Fixing only one leaves the system broken.

**Outcome: fixed, deployed to production, and verified against the live
account.** The operator reproduced the CORS failure from the browser
(`No 'Access-Control-Allow-Origin' header is present`) on a presigned PUT to
`uploads/` — the exact failure traced from source before any browser evidence
existed. Both defects were first mitigated directly on the live bucket to
restore uploads within minutes, then the deploy made the fix permanent. All
four long-lived branches carry the change, so no promotion can reinstate it.

The riskiest moment was the deploy itself: had the synth found no dashboard
origin, it would have overwritten the live CORS mitigation and re-broken uploads
at the moment everyone believed it was fixed. It held because `CCE_DASHBOARD_URL`
is a **GitHub Environment** variable, which `gh variable list` does not show —
a distinction worth remembering, since checking only repository variables led to
a wrong conclusion mid-session (see M12).

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- The CORS allowlist is built at **synth time** from `process.env.DOMAIN_NAME`
  (`infra/lib/storage-stack.ts:394` pre-fix). There are **two** environment
  variables denoting the same origin: `DOMAIN_NAME` and `CCE_DASHBOARD_URL`.
  The last deploy set the second and not the first, so magic links kept working
  while uploads silently broke. Nothing compared them.
- `production` has **no `docs/features/` directory**, no
  `scripts/ci/feature-knowledge.mjs`, and no `development.md`. The feature
  knowledge framework post-dates it. Feature docs cannot ride a production
  hotfix without breaking `docs-links`.
- `production` has **no `infra/lib/paperclip-stack.ts`**. A hotfix branched from
  `production` therefore cannot disturb the Paperclip work at all — the code is
  not on the branch.
- The deployed task definition is `claudeclaw-orchestrator:8`, registered
  **2026-08-14**. No deploy has landed since, which is why the CORS defect has
  persisted.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `infra/lib/storage-stack.ts` (CORS block) | Browser-PUT allowlist | The residual cause. Built from one env var when two exist |
| `infra/lib/storage-stack.ts` (`expire-staging-fast`) | The 7-day rule | Root cause, now confirmed live |
| `src/lib/vectors/store.ts` `indexPrefixFor` | Single prefix construction site | Replaced two hand-built templates that could drift |
| `src/lib/vectors/durability.repro.test.ts` | **New.** End-to-end reproduction | Saves a file, imports a document, proves neither can expire |
| `infra/lib/storage-stack.test.ts` | Durability + reachability guards | Extended with four CORS guards |

### 3.3 Patterns and conventions to follow

- A guard that passes proves nothing until it has been seen to **fail**.
  Every guard here was mutation-tested: the defect was reintroduced and the
  suite confirmed red. Two of them did not fail on first attempt.
- Prefer making a defect **unrepresentable** over merely detectable. Prefix
  construction is now one exported function; divergence cannot be expressed.

## 4. Work completed

### 4.1 Tasks finished

- [x] Confirmed the RCA against the live account — lifecycle rule, versioning
      state, and `index/` emptiness all verified by direct API call.
- [x] Found the residual cause: CORS allowlist missing the dashboard origin.
- [x] Tested and **refuted** the operator's account-drift hypothesis: still
      account `239887088812`. The org migration did not move accounts. The
      *mechanism* the operator intuited — a deploy-shell-dependent value
      silently vanishing — is nonetheless exactly what CORS suffered.
- [x] Ruled out embedding: Bedrock Titan v2 invoked directly, returned a 43KB
      embedding. Service healthy at 3/3 tasks.
- [x] Cherry-picked the durable-bucket fix onto `production` — zero conflicts.
- [x] Fixed the CORS origin defect and added four reachability guards.
- [x] Strengthened `store.scope.test.ts`, which did **not** catch a broken read
      path (see M9).
- [x] Wrote `durability.repro.test.ts` — the reproduction.
- [x] Mutation-tested every guard.
- [ ] `RawBucket` — untouched, by operator instruction. Still in the guard's
      `UNRESOLVED` set.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `infra/lib/storage-stack.ts` | CORS allowlist built from `DOMAIN_NAME` **and** `CCE_DASHBOARD_URL`, deduped; malformed URL fails synth loudly | A dropped origin is invisible in logs |
| `infra/lib/storage-stack.test.ts` | +4 CORS reachability guards | Pins the outage shape |
| `src/lib/vectors/store.ts` | `indexPrefixFor` — one construction site for `index/` prefixes | Divergence made unrepresentable |
| `src/lib/vectors/store.scope.test.ts` | +2 behavioural tests driving the real read path via a spied S3 client | The originals tested a pure function and missed the bug |
| `src/lib/vectors/durability.repro.test.ts` | **New.** 7 tests | The reproduction |
| `docs/account-migration.md` | Cross-link inlined on the hotfix branch only | `production` has no `docs/features/` |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Hotfix from `production`, then backport | full `development → qa → staging → production` chain | Operator chose it. Clients are piloting on live infra that is losing data. `development.md` defines `hotfix/*` for exactly this. The backport is part of the task, not a follow-up — without it the next promotion reinstates the defect. |
| Hotfix carries **code only**; docs go on the backport | carry docs on both | `production` predates the feature framework; the docs broke `docs-links` there. A hotfix should also be the smallest possible change to live infra. |
| Fail synth on a malformed `CCE_DASHBOARD_URL` | skip it silently | Silent omission is the entire defect. Loud beats invisible. |
| Unify prefix construction rather than only adding a test | add a test | A test detects; one construction site prevents. |

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
| P10 | **A guard is not a guard until you have watched it fail.** Reintroduce the defect and confirm red. | New this session. Two guards here passed while the defect was live — see M9 and M10. |
| P11 | **Restore mutation probes before committing, and diff before you stage.** | New this session. See M11 — a probe that removed the fix was nearly committed to a production hotfix. |

### 5.2 Mistakes already made, and their corrections

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M1 | Feature-documentation conventions were written on several pages at once. | The copies drifted and no page was trustworthy. | Single specification in [the framework](../../README.md), machine-checked by `scripts/ci/feature-knowledge.mjs`. | One rule, one home, enforced by CI rather than by discipline. |
| M2 | The repository-root `handoff.md` was used as live, writable operational state. | It became a stale global handoff that contradicted the per-feature ones. | Reduced to a one-sentence compatibility pointer; CI now fails if it grows back. | Operational state is per-feature. A global handoff always rots. |
| M3 | `infra/lib/dynamo-stack.ts` carries a header comment claiming "All 14 DynamoDB tables". | It creates **32**. The comment misled table-count work. | Read the synthesized template, never the comment. | Comments are not authorities. `infra/lib/constants.ts` and the synth output are. |
| M4 | The CodeBuild deploy branch default was changed from `main` to `production`, then reverted. | Churn on a live CI path; the doc fixes from that change were kept, the behaviour change was not. | Reverted in `4ce27a7`, doc fixes retained. | Do not re-apply this without first establishing why it was reverted. |
| M5 | A feature handoff recorded required checks as complete when the authoring machine had no Node runtime, so they could not have run. | The next reader would have trusted an unverified contract. | Disclosed explicitly in the handoff; Docs CI on `development` became the first real execution. | This is precisely what P2 exists to prevent. Disclosure is the minimum; running the check is the goal. |
| M6 | Targeted Vitest was run inside a Windows **linked worktree**. | Startup failed and no tests were collected. | Ran from a normal checkout instead. | On Windows, run test suites from a normal clone. Vitest is not worktree-safe here. |
| M7 | `npm run test:integration:up` was assumed safe alongside the local stack. | It starts LocalStack on port 4566 and collides with Floci. | Use `npm run local:test:integration`. | One emulator on 4566, ever. |
| M8 | `.env` was created for local development while several lifecycle scripts default their environment flag to **prod** and read `.env`. | Commands that were previously inert became genuinely dangerous. | Catalogued in [dangerous commands](../../../../development.md#dangerous-commands-never-run-locally). | Read that list before running any unfamiliar `npm run` script. |
| M9 | `store.scope.test.ts` tested `normalizeScope` in isolation while its own docblock claimed it pinned both read and write paths. | Reverting `iterateRows` to a raw-scope template left all five tests **green** while every read silently returned empty. Found by mutation, not by reading. | Prefix construction unified into `indexPrefixFor`; two behavioural tests now drive the real read path through a spied S3 client. | A test of a helper is not a test of the invariant. Assert the property that broke. |
| M10 | The first CORS guard was written before checking what `process.env` does with `undefined`. | Assigning `undefined` into `process.env` coerces to the **string** `"undefined"`, so `new URL("undefined")` threw and the test failed for the wrong reason. | Delete the key instead of assigning undefined. | The test caught a real flaw in the fix — a malformed value would have thrown an unreadable `Invalid URL` at deploy time. |
| M12 | Concluded `CCE_DASHBOARD_URL` was unset because `gh variable list` did not show it, and nearly blocked the deploy on setting it. | Would have added a **repository**-scoped variable pinned to one customer's domain — wrong for an install shipped to multiple companies. | It was already set correctly as a **GitHub Environment** variable, per environment (`production` → `app.pgnos.ai`, `staging` → `staging.pgnos.ai`). Caught only because the operator asked what would happen for another client. | Repository and environment variables are different scopes and different CLI calls. `vars.X` in a job with an `environment:` key resolves from the environment. Check `gh api repos/<org>/<repo>/environments/<env>/variables` before concluding anything is unset. |
| M11 | A review subagent was told it could mutate files to probe, and it died mid-probe without restoring. | It left `prefix: UPLOAD_STAGING_PREFIX` **deleted** in the working tree — the exact defect being fixed — staged for a production hotfix commit. Caught only by reading `git status` and finding `MM`. | Restored from the index; both branches re-verified by grep before commit. | Never let a probing agent share a tree you are about to commit from. Diff before you stage, always. |

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it with `npm run local:verify`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS** on 2026-08-10. | Windows behaviour is **not** covered. See M6 and section 7. |
| A3 | Bedrock is a **stub** locally. | Local development validates plumbing, never model behaviour. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; production is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time. | A `TABLE_*` override must be set before the first import. |
| A6 | AWS console access is root-user sign-in via `aws login`. | **Confirmed working this session** — account `239887088812`, ARN `arn:aws:iam::239887088812:root`. |
| A7 | **New.** Bucket names, and the CORS allowlist, are computed at **synth** time from the deploy shell's environment. | So the deployed configuration depends on *who ran the deploy and from where*. This is the defect class behind the CORS outage; treat any `process.env` read in `infra/` as a potential silent-drift source. |

### 5.4 Known traps that cost time

Short pointers only. The owning document has the detail.

| Trap | Where the detail lives |
|---|---|
| A bare `KEY=` in `.env` becomes `''`, and zod's `.optional()` only fires on `undefined`. | [Environment variables](../../../../development.md#environment-variables) |
| `NODE_ENV=production` locally arms a deployed-task fail-fast. | [Environment variables](../../../../development.md#environment-variables) |
| `GET /ready` returning `503` locally is **correct**. | [Starting development](../../../../development.md#starting-development) |
| **New.** Git Bash rewrites a leading-slash argument into a Windows path, so `aws logs --log-group-name "/claudeclaw/orchestrator"` fails validation. Set `MSYS_NO_PATHCONV=1`. | this handoff |
| **New.** The orchestrator log is dominated by X-Ray `Failed to get the current sub/segment from the context` errors, which carry a full stack trace including whatever AWS call was in flight. A function name appearing in one means it was *called*, not that it failed. | this handoff |

## 6. Pending work

### 6.1 Smallest next action

Run the two read-only AWS commands in section 6.3 to see the defect, then apply
the CORS mitigation — it restores uploads in minutes, without a deploy.

### 6.2 Immediate next steps

1. ~~Apply the live CORS mitigation~~ — **done**, then superseded by the deploy.
2. ~~Hotfix into `production` and deploy~~ — **done**. Run succeeded at tier 2.
3. ~~Backport through `development → qa → staging`~~ — **done**, all merged.
4. **Re-ingest from the `knowledge_ingest` audit rows.** Still outstanding. New
   ingests land in the durable bucket and are safe.
5. **Unblock the staging deploy** (6.3) — staging carries the code but its
   environment is still unfixed.
6. **Reconcile the promotion ladder with the runbook** (6.3).

### 6.3 Blockers and open questions

- [x] Resolved: **`npm run local:test:integration`** could not run locally
      (Docker Desktop will not start on this machine) but **passed in CI** on
      #91. Green, just never on this machine. Per **P2** it is recorded as run
      by CI, not by this session.
- [x] Resolved: **production deploy** dispatched at tier 2 to match the running
      task rather than the workflow's tier-3 default. Diffing task definition 8
      against 9, only `DEPLOY_SHA` and `VECTORS_BUCKET` changed — no collateral
      to tier, cost cap, or any other env-backed tunable, which is the specific
      risk `CLAUDE.md` warns a full `cdk deploy` carries.
- [ ] Blocker: **the staging deploy fails, and staging's environment is still
      unfixed.** It dies at `Ensure ECR repo exists`, *before* CDK runs, so
      staging's bucket still has the localhost-only CORS and the empty-prefix
      expiry. Cause is unrelated to this work: `CCE_PAPERCLIP_ENABLED=1` makes
      the deploy probe `claudeclaw-staging-paperclip`, which the deploy role has
      no `ecr:DescribeRepositories` grant for. The error text notes the grant
      ships from the **prod** IAM stack — which carries no Paperclip code — so
      this is a bootstrap ordering problem inside the Paperclip work. Left
      untouched deliberately: unblocking it means either disarming the Paperclip
      flag or changing its IAM, and neither is this feature's call.
- [ ] Open question: **`scripts/ci/branch-guard.mjs:20` contradicts
      `development.md`.** The ladder hard-codes `{ production: 'staging' }`, so
      the `hotfix/* → production` route the runbook documents is rejected by the
      Promotion ladder check. #91 was merged past that red check. One of the two
      is wrong, and until it is reconciled every hotfix trains someone to
      override a failing gate.
- [x] Resolved: *is any object under `index/` still present?* **No — zero.**
      The bucket is entirely empty:
      `aws s3 ls s3://claudeclaw-vectors-staging-239887088812-us-east-1/ --recursive`
      returns nothing. Combined with `uploads/` also being empty, this is what
      pointed at a second, write-side cause.

### 6.4 Deferred, and why

- **`RawBucket` retention** — untouched by operator instruction. Still named in
  the guard's `UNRESOLVED` set so it cannot be quietly blessed.
- **Backup/replication for the vector index** — still none. Versioning makes
  deletes recoverable; it is not a backup.
- **The two-variable origin problem** — `DOMAIN_NAME` and `CCE_DASHBOARD_URL`
  both denote the dashboard origin. This change makes the CORS allowlist read
  both, but does not collapse them into one. Worth an ADR.

## 7. Verification actually performed

| Command | Baseline (production, untouched) | After changes |
|---|---|---|
| `npm run typecheck` | not captured | **pass** |
| `npm test` | **4 files / 1 test failed** (same files) | **4 files / 1 test failed**, 1925 passed, 6 skipped (1932) — identical failure set |
| `npm run build` | not captured | **pass** |
| `node scripts/ci/docs-links.mjs` | not captured | **pass** (310 internal links) |
| `git diff --check` | not captured | **pass** |
| `npm run local:test:integration` | not run | **NOT RUN — blocker, Docker unavailable** |
| `node scripts/ci/feature-knowledge.mjs` | n/a | **n/a on the hotfix branch** — the script does not exist on `production`. Applies to the backport branch. |
| Mutation testing (7 mutations) | n/a | **all caught red** |

The four failing test files are identical before and after, on the untouched
`production` base: `scripts/ci/docs-links.test.ts`,
`scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`,
`scripts/release/sync-deprecations.test.ts` fail at import, and
`scripts/lib/lifecycle/rollback-classes.test.ts:574` asserts POSIX path
separators. Consistent with **A2**.

### Deploy verification (live, post-deploy)

| Property | Verified value |
|---|---|
| Deploy run | success, `env=prod`, `tier=2` |
| Task definition | `claudeclaw-orchestrator:8` → `:9`, service ACTIVE 3/3 |
| `VECTORS_BUCKET` | `claudeclaw-vectors-<account>-<region>` — the durable bucket |
| Durable bucket versioning | `Enabled` |
| Durable bucket lifecycle | only `expire-old-versions` (`ExpireDays: None`, `NoncurrentDays: 90`) — nothing can expire a current object |
| Staging bucket CORS | `["https://app.pgnos.ai", "http://localhost:3000"]` — survived the deploy |
| Staging bucket lifecycle | `Filter.Prefix: uploads/`, 7 days |
| Env diff, rev 8 → 9 | exactly two values: `DEPLOY_SHA`, `VECTORS_BUCKET` |

Mutation testing: seven defect variants reintroduced, every one caught red.
Two guards did **not** fail on first attempt and were strengthened (M9, M10).

Live AWS verification performed this session (read-only):
`sts get-caller-identity`, `s3 ls`, `s3api get-bucket-lifecycle-configuration`,
`get-bucket-versioning`, `get-bucket-cors`, `get-bucket-encryption`,
`ecs describe-services`, `ecs describe-task-definition`,
`logs start-query`, and a direct `bedrock-runtime invoke-model`.

## 8. Environment state

- **Tools**: Windows 11, Node 24.19.0, Vitest 2.1.9. Work performed in a
  **separate clone** under the session scratchpad, never in the operator's
  checkout, which holds in-flight Paperclip work (**P6**).
- **Docker unavailable** — Docker Desktop will not start; no Floci, no
  integration suite.
- **AWS credentials working** — account `239887088812`, root ARN.
- **Uncommitted work in the operator's tree**: untouched.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- Previous session handoff: [2026-08-20 knowledge wipe RCA and durable bucket](./2026-08-20-knowledge-wipe-rca-and-durable-bucket.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
