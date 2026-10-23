---
feature: netzar-studio
document_role: decision
status: draft
observed_at: 2026-10-23
as_of_commit: d1d3a66970cd548f9529a234ef2b51ecdc29378e
---

> Foundation PLAN draft (2026-10-23), written by a read-only review agent and accepted as a draft by the planner. Owner decisions it asks for are in grill round 4 (Q81+). Overrides: [blueprint v2](../blueprint.md) wins on conflict.

# DEPLOY: Netzar Studio rebuild (draft for owner review)

Draft · 2026-10-23 · deploy reviewer, Foundation PLAN · repo `docs/netzar-studio-stories` (base `origin/development` d1d3a66) · read-only review, nothing deployed.

**Summary (5 lines)**
1. Today no merge to `development` deploys anything. Only a push or merge into `staging` auto-deploys (`deploy.yml`), and it deploys to the OLD shared account where Bedrock is banned. Production is manual dispatch only.
2. Almost every NZR task stays local only (VPS clean clone + Floci on :4566 + NVIDIA dev models, test data) until NZR-42 (the new PGN AWS account with Bedrock) exists. Drop-dead for that is Nov 9. If Bedrock is not usable by Nov 23, C3 gets re-planned.
3. The rebuild needs a new staging install in NZR-42 before the pilot. I recommend the first staging deploy goes out as soon as Bedrock works (late Nov, not C3), so the Bedrock eval re-baseline, rollback drill and restore test happen early.
4. Dec 31 done = one design partner runs the golden workflow on a live webhook in a deployed T0 install in NZR-42. That pilot counts as production-class: the partner gets no access until the drafter eval is re-measured on Bedrock and the owner says yes.
5. Biggest hazards: the auto-deploy on `staging`, the documented-but-unwired `development`→QA auto-deploy, repointing `vars.AWS_ACCOUNT_ID`, the isolation scan refusing NZR-42, and webhook ingress that nobody has designed yet.

Consent rule (unchanged by anything here): every push, PR, merge, deploy, infra apply, flag flip, AWS call and `npm run destroy` needs the owner's yes in the conversation that does it. A local PASS is never a staging PASS, and a staging PASS is never a pilot PASS.

---

## 1. Environments

| Env | Where / what runs | Model backend | Data allowed | How it gets code | Status |
|---|---|---|---|---|---|
| **Local** | VPS clean clone (no `.env` secrets, NZR-3). Orchestrator + web dev server. AWS services emulated by Floci (`~/floci`, port 4566). | Floci Bedrock proxy → NVIDIA hosted dev models (NZR-10). Unit tests use recorded replies (NZR-11). | Synthetic / seeded test data only. No repo code goes to NVIDIA until the owner reads the free-tier terms and says yes (Q65). | Builder commits on a local branch | Active (C0/C1) |
| **CI** | GitHub Actions: `ci.yml` (typecheck, build, unit, LocalStack 3.8 integration, hermetic synth, secret scan, rollback dry-run, chat e2e), `docs-ci.yml`, `branch-guard.yml` | None live. Recorded replies only. CI checks that the committed eval result hashes (drafter files, dataset, model) match (Q66). | Fixtures only. `ci.yml` has `permissions: contents: read` and no AWS credentials. | PR / push to development, qa, staging, production | Active |
| **Legacy staging** (`CCE-STAGING-*`, staging.pgnos.ai) | Old PGN account, shared with legacy production. T0 plus the Paperclip substrate (Aurora + EFS, RETAIN) via `CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE=1`. | Bedrock, which is banned for this work (blueprint Q17/Q34) | Existing staging data | **Auto on push to `staging`** | Exists. **Not a rebuild target.** |
| **Legacy production** (app.pgnos.ai) | Old account, `CCE-*` | Bedrock | Live | Manual `workflow_dispatch` + typed `deploy` | Out of scope |
| **Rebuild staging** | NZR-42 account, `CCE_NAME_SUFFIX=staging`, T0, infra-only. Same commit and infra code as pilot; values differ only. | Real Bedrock (us-east-1). Runs the Bedrock re-baseline and the nightly live eval. | Synthetic documents only (testers too, Q67) | `npm run deploy -- --env=staging --tier=0` from the operator machine, owner yes each time | Waits for NZR-42 + Bedrock |
| **Pilot** (managed pilot, Q64) | NZR-42 account, no suffix, T0. Golden workflow, live webhook trigger (NZR-35), engine (NZR-34). | Bedrock | Synthetic + partner-consented, non-production test documents. **No customer production data.** Needs a written exception to the customer-hosted "no PGN data plane" rule before the first deploy. | Same commit as the soaked staging, owner yes | Target Dec (C3) |
| **Customer-hosted GA** | Customer's own AWS account. Signed `v*` release, customer OIDC, `npm run update` (release-pipeline.md). | Customer's Bedrock | Customer's data, which stays in their account | Never auto-deployed (deployment.md) | After Dec 31. Blocked by COMM-001..006. |

Open decision D1: is rebuild staging a second install in NZR-42 (cheaper, mirrors the old pattern) or a second fresh account? The agent path's isolation scan refuses non-empty and Organizations-managed accounts with no override (AGENTS.md rule 5, `scripts/lib/isolation/account-profile.ts`, run from `scripts/bootstrap.ts`). So NZR-38 must prove which entry point (`up` or `deploy --env=staging`) accepts a second install. If neither does, the fallback is a second account, which costs about one more owner-hour.

## 2. Branch → environment, as the workflows actually behave today

| Event | Workflows that run | Deploys? |
|---|---|---|
| PR into `development` (e.g. this plan's docs PR) | `ci.yml`, `docs-ci.yml` | **No.** No AWS credentials. |
| Merge/push to `development` | `ci.yml`, `docs-ci.yml` | **No** (no `development` trigger in `deploy.yml`) |
| PR/push to `qa` | `ci.yml`, `docs-ci.yml`, `branch-guard.yml` | No |
| **Merge/push to `staging`** | the above + **`deploy.yml` (`on.push.branches: [staging]`)** | **YES, automatically.** Deploys `CCE-STAGING` at Tier 0 + Paperclip substrate into `vars.AWS_ACCOUNT_ID` (the old account). The job comment says "A push to `staging` is its own approval". |
| PR/push to `production` | CI, Docs CI, branch-guard | No (prod deploy is dispatch only) |
| `workflow_dispatch deploy.yml` | `deploy.yml` | Yes. Prod needs `confirm=deploy`. **The tier input defaults to `3`** (~$400-900/mo). |
| Daily 13:00 UTC | `cdk-drift.yml` | No, but it reads the live account over OIDC. It fails today because `CDK_DIFF_ROLE_ARN` is unset. |
| Tag push `deploy/v*` | No GitHub workflow. If an install has `CCE_CODEBUILD_ENABLED=1`, CodeBuild in that account deploys it (`docs/github-to-aws.md`). | **Yes, in that account** |

Flags:
- **The `qa → staging` merge is a deploy.** It needs its own owner yes as a deploy, on top of the merge yes. No rebuild step should go up the ladder past `qa` in 2026. The legacy staging account has no Bedrock for this work, and it runs Paperclip, which the rebuild is retiring.
- `docs/deployment.md` and `docs/development.md` say a merge into `development` deploys to a T0 QA environment. `deployment.md` itself says this is "not active until the implementation is merged", and no workflow does it today. Re-read `.github/workflows/*.yml` at every step's PLANNING. If a `development` trigger appears, every merge (docs included) becomes a deploy.
- `branch-guard.yml` covers `qa`, `staging` and `production` only, and it detects rather than blocks (GitHub Free). Nothing guards `development`.

## 3. Deploy reach per NZR task

Reach = the furthest environment the task's code gets to, under the newer owner decisions. Everything is **local only** until NZR-42 has Bedrock. "Pilot" means the code ships inside the pilot artifact; it never means a separate deploy per task. Merging to `development` is "local only" because it deploys nothing today.

| Task | Reach | Notes |
|---|---|---|
| NZR-1, 2, 4 | none | Parked (Q59) |
| NZR-3 clean clone, NZR-40 routing, NZR-41 review gauntlet v2 | local only (VPS) | Factory wiring, never in AWS |
| NZR-42 AWS account + Bedrock access | account-level (owner) | Owner action. Budget + anomaly alerts on day 1. Drop-dead Nov 9. |
| NZR-5, 6 security fixes (T3) | local → pilot | Ship in the first staging/pilot artifact. The same leak exists in legacy prod: fixing it there is a separate owner decision through the old ladder. |
| NZR-7, 8, 9 ADRs / feature docs | local only | Docs CI only |
| NZR-10 Floci → NVIDIA | local only | Never deployed. Config must not leak into deploy env. |
| NZR-11 recorded replies, NZR-30 eval gate | CI | No AWS |
| NZR-12 schema, 13 trigger contract | local → pilot | Schema carries `schemaVersion` (section 5) |
| NZR-14 eval set | local, then **staging** | Re-baselined on Bedrock in rebuild staging. Blocks pilot (section 6). |
| NZR-15–21 Workspace/Home/Admin/UI | local → pilot | Optional for Dec 31 (cut order Q72) |
| NZR-22 immutable agent versions | local → staging → pilot | Data-shape change, expand/contract (section 5) |
| NZR-23 drafter, 24 edit-by-chat, 25 preview, 26 test runner | local → staging → pilot | Core slice Nov 10–23 |
| NZR-27 playbooks, 28 Company facts | local → staging → pilot | New tables: expand only |
| NZR-29 lessons | local only | Cut 3rd |
| NZR-31 golden workflow e2e | local, re-run on staging | Must pass on Bedrock before pilot |
| NZR-32 testers | local or staging | Synthetic docs. If staging exists by the Nov 23 dry-run, use it (tester access needs a decision, D2). |
| NZR-33 engine spike | local only | If Step Functions wins, NZR-34 adds a new stack (infra change rules apply) |
| NZR-34 live engine, 35 webhook+API, 36 publish/activate/rollback | local → staging → **pilot** | Dec 31 needs a deployed live webhook. Ingress design is D3. |
| NZR-37 Paperclip retirement | local only | Moved to January (Q72). Don't touch legacy `CCE-STAGING-Paperclip`. |
| NZR-38 deploy runbook | local → staging → pilot | Becomes the first real deploy (section 4) |
| NZR-39 forms/embed | local only | Cut first |

## 4. Pilot deploy path (NZR-38 runbook + first real deploy in C3)

**Sequence:**
1. NZR-42 is ready (owner).
2. NZR-38 runbook merged (local).
3. First rebuild-staging deploy, late Nov, as soon as Bedrock works: the walking skeleton.
4. Bedrock eval re-baseline + rollback drill + restore test on staging.
5. Staging redeploys per C3 step, each soaked.
6. Pilot deploy, target by ~Dec 18. Leave the Dec 24–31 holiday window as buffer, not deploy days.
7. Partner access after the ship message is approved.

**NZR-38 runbook must contain (acceptance additions):**
- `aws sts get-caller-identity` shows NZR-42.
- The isolation scan / account profile result is recorded: standalone, not in an Organization (else D1 fallback).
- Bedrock model ids granted in us-east-1, with the exact ids written down.
- `npm run validate:tier1` green ($0, read-only).
- **A T0 synth for a fresh account is green.** CI's `synth-hermetic` runs `CCE_TIER=1`, not 0, and `infra/bin/app.ts` has the Paperclip-emptying guard at tiers that provision no Paperclip. T0 fresh-account synth is unproven.
- Runs from the operator machine. GitHub Actions does NOT deploy NZR-42 in 2026, and `vars.AWS_ACCOUNT_ID` stays pointed at the old account.

**Pre-deploy checklist** (every line recorded in the step log; from safe-deploy section 3):
- [ ] VERIFICATION passed on the exact HEAD (gates, fresh critic PASS, Jev ≥ 0.8). CI green on that same SHA.
- [ ] `shipping-and-launch` pre-launch list run, with N/A lines given reasons.
- [ ] `cdk diff` output reviewed for `[-]`/replace on stateful resources (DynamoDB tables, S3 buckets, KMS keys, secrets). Any replace = ADR + explicit owner yes.
- [ ] Migrations checked against section 5. Rollback path tested, or a written reason it is safe.
- [ ] Flags listed with defaults: new triggers default OFF, activation needs approval (NZR-36).
- [ ] Rollback plan for this release: trigger conditions, exact command, minutes, data notes.
- [ ] Monitoring named, with expected values: `/health`, ECS steady state, 9 CloudWatch alarms, ops SNS subscription **confirmed** (the 2026-08-15 outage had a topic with zero subscribers), daily cost.
- [ ] Data exception signed and partner consent recorded (pilot only).
- [ ] Drafter eval on Bedrock ≥ threshold, with result hashes committed (pilot only, section 6).

**Cost gate and expected monthly cost** (estimates; re-run `node scripts/cost-estimate.mjs --tier=0` in the runbook):
| Item | Estimate |
|---|---|
| Pilot T0 fixed floor (NAT ~$33, ALB ~$22, 1×0.5 vCPU Fargate ~$14, logs/KMS/secrets) | $65–95/mo (estimator $81.74). Infra-only without ALB ~$50–60 (agent-setup.md). |
| Rebuild staging T0 (if D1 = second install) | another $65–95/mo. Pause it when idle with `npm run power:setup`. |
| Bedrock tokens per install | Bounded by the T0 daily cap of $5/day, so ≤ ~$152/mo worst case. Light use is ~$13–39/mo. |
| Live eval nightly (30 cases) | Rough guess $1–3/night, on **staging only**, so it never eats the pilot's $5/day cap |
| Step Functions Standard (only if NZR-33 picks it) | ~$0.025 per 1k transitions: pennies at pilot volume |
| **NZR-42 total** | Typical ~$150–250/mo. Worst case ~$500/mo with both caps maxed. |

Do not pass `--yes` (it accepts the deploy cost gate) unless the owner has approved the standing cost in that conversation. Never dispatch `deploy.yml` with the default `tier=3`. Do not set `CCE_PRIVATE_ENDPOINTS=1` (+~$175/mo).

**Staging soak** (safe-deploy section 4; this file sets longer windows):
- Confirm staging runs the exact commit (`DEPLOY_SHA` env on the task definition / image tag) and record it.
- Run the e2e journeys and a human-style pass of the golden workflow on Bedrock.
- Minimum soak: **24 h for the first deploy** and for any infra/engine/webhook change; 2 h for app-only changes; 30 min floor otherwise.
- Pass = zero task restarts, zero new error types, flat memory, no alarm, daily spend under cap.

**Same-artifact gap:** `npm run up`/`deploy` builds the image inside each account (Docker or CodeBuild), so the pilot image is a rebuild, not the soaked artifact. Two options: copy the soaked staging image digest into the pilot ECR repo (manifest-preserving copy, as in `importReleaseImage()`), or record both digests and treat any mismatch as a FAIL. NZR-38 must pick one.

**First deploy steps and rollback per step:**
| Step | Command | Rollback |
|---|---|---|
| 1 Doctor / early-win | `npm run up` (stops at the cost gate) | Nothing created |
| 2 Bootstrap primitives (state bucket, lock table, ECR) + image push | inside `up`/`deploy` | Pennies; leave in place. Removal only by `npm run destroy` on owner request. |
| 3 Stacks | `deploy` (never bare `cdk deploy`) | CloudFormation rolls back a failed stack update itself. Later releases: `npm run deploy:rollback -- --class=infra --to=<deployId> --dry-run`, then without `--dry-run`. A failed first create: fix and re-run `npm run up` (idempotent). |
| 4 Secrets / runtime config | out of band (CDK leaves `REPLACE_ME`) | lifecycle.md Class 3 (config). Check logs for "Refusing to start". |
| 5 Verify | `npm run verify` | Red = stop, partner stays locked out |
| 6 Webhook ingress (D3) | per design | Remove the route / flag the trigger OFF |
| 7 App releases after go-live | redeploy same path | `npm run deploy:rollback -- --class=image --to=previous` (~minutes). **Rehearse once on staging before the pilot exists.** |

T0 is a single task, so there is no canary or blue/green. ECS circuit-breaker rollback is the only automatic rollback. A straight 100% promote needs one ADR line saying why (safe-deploy section 5). The coordinator watches 30 min after each promote with the rollback command ready.

**Restore test** (once on staging before any partner data, then after any table change): restore one table from the daily 02:00 UTC S3 export or PITR into a **side table** with `npm run restore:ddb` (`docs/runbooks/restore-from-ddb-export.md`), then compare item counts and spot-check records. Record the time it took. An original-name restore is lifecycle.md Class 4: service at zero, locked, owner yes.

**Tear-down:** `npm run destroy` removes the whole install. Run it only when the owner explicitly asks, naming the install (staging or pilot). Afterwards, check the power panel `/costs` inventory or Cost Explorer for RETAIN leftovers.

## 5. Migrations and data

- **Store:** DynamoDB on-demand, PITR on, `RemovalPolicy.RETAIN` (`infra/lib/dynamo-stack.ts`), plus a daily S3 export (`backup-stack.ts`, alarm if missing 36 h) and S3 for documents. The pilot is T0, so there is no Aurora/Paperclip.
- **Expand / migrate / contract:**
  - New tables (workflows, versions, playbooks, Company-facts queue) and new attributes ship optional/defaulted.
  - Readers tolerate a missing attribute. Old and new code both work against the new shape.
  - Contract (remove the old shape) only in a later release after a clean soak.
  - Use the registry in `scripts/migrations/index.ts` with the ordering contract in `scripts/lib/release/migrations.ts`: expand before rollout, backfill/contract only after `npm run verify`, journaled and idempotent.
- **Workflow definitions:** versioned JSON with `schemaVersion`. The validator accepts N and N-1. Published versions are frozen and never rewritten in place.
- **NZR-22 agent versions:** today the live S3 file is overwritten.
  - Expand: write immutable versioned keys beside the live file; readers prefer a pinned version id and fall back to the live file.
  - Contract: retire the overwrite path in a later release.
- **Never rename or replace a table/bucket in CDK.** Changing a logical id = an orphaned RETAIN resource + a new empty one. That is a one-way door: ADR + owner yes.
- **Rollback:** image rollback is safe only while the schema stays backward-compatible (the lifecycle.md schema-version safety contract). Data rollback = Class 4 restore, which is disruptive.
- **Data rules:**
  - Local and CI: synthetic only.
  - Staging: synthetic only.
  - Pilot: synthetic + partner-consented non-production documents.
  - Pilot data is never copied to local, the VPS, NVIDIA or CI fixtures.
  - Analytics events carry no personal data (Q55).

## 6. What blocks production (pilot-partner) reach

1. NZR-42 exists with Bedrock access granted for the exact model ids. Drop-dead Nov 9; re-plan C3 if not usable by Nov 23.
2. **Drafter eval re-measured on Bedrock** in rebuild staging. The committed result hashes (drafter files, dataset, Bedrock model id) must match and CI must be green. The score must meet the target (≥80%, AC 1). Below 70% at the Nov 23 gate triggers the kill rule (stop UI, fix drafter). NVIDIA/replay scores do not count.
3. Golden workflow (NZR-31) passes end to end on staging/Bedrock, and the live webhook passes on staging.
4. Staging soak PASS on the exact commit. Image rollback rehearsed. Restore test done.
5. Written data-plane exception + partner consent on file.
6. Owner approves the ship message (safe-deploy section 6) in-session. That yes also covers the named rollback command.

## 7. Ranked risks (adversarial)

1. **Auto-deploy on `staging`.** Any `qa → staging` merge, direct push, or a rebuild branch accidentally targeted at `staging` deploys to the old shared account next to app.pgnos.ai, at T0 + Paperclip Aurora/EFS (RETAIN). Treat it as a deploy needing its own yes, and keep rebuild work at `development`/`qa`.
2. **The documented `development` → QA auto-deploy could be switched on.** If someone wires it (or adds `development` to `deploy.yml` `on.push`), this plan's docs PR and every later merge silently become deploys. Re-check triggers at every PLANNING, and add a test or alarm for new deploy triggers.
3. **Repointing `vars.AWS_ACCOUNT_ID` (or the env-scoped vars/OIDC role) at NZR-42.** Staging pushes would then deploy into the pilot account, and a careless prod dispatch would bring tier 3 defaults (~$400–900/mo, RETAIN Aurora). Keep NZR-42 out of GitHub Actions in 2026, or give it separate environments + an OIDC role with exact subjects, decided by ADR.
4. **The isolation scan refuses NZR-42** if it sits in an AWS Organization / Control Tower or is not empty, with no override. A second install (staging) may also be refused. Find out in week 1, not at C3.
5. **Bedrock late, or Bedrock models differ from the NVIDIA dev models.** The local eval is then no evidence, the re-baseline fails, production reach stays blocked, and Dec 31 is missed. Re-baseline the day access lands.
6. **Webhook ingress is undesigned (D3).** Installs are infra-only with an internal ALB. Public reach means either the PGN Cloudflare tunnel overlay (pgnos.ai only) or domain mode (Route 53 + ACM, which does not exist yet). A webhook is an internet-exposed write path: auth, rate limits and payload limits (NZR-35 AC) must be tested on staging before the pilot.
7. **The same-artifact rule is broken by in-account builds.** The pilot could run an image that never soaked. Use digest copy or digest match (section 4).
8. **Cost cap starvation.** At T0's $5/day cap, the nightly live eval, testers or a runaway loop on the pilot trips the kill switch mid partner demo. Run the eval on staging only, and raise the pilot's cap via runtime-config only with owner yes.
9. **T0 fresh-account synth is unproven.** CI synthesizes at Tier 1, and the Paperclip-emptying guard in `infra/bin/app.ts` may refuse T0 synth. Could fail at deploy time in C3.
10. **Port 4566 collision.** Floci, `docker-compose.local.yml` LocalStack (127.0.0.1:4566) and `docker-compose.test.yml` (4566) all bind it. Tests can hit the wrong emulator and pass or fail falsely. Run one at a time.
11. **No canary at T0.** Every promote is 100% to a single task. A bad release is a full outage until the image rollback finishes. Needs an ADR, a watched promote, and no deploys Dec 24–31.
12. **Data-boundary breach.** A partner sends real production documents to a PGN-hosted install without the written exception, against the customer-hosted rule in `customer-hosted-commercialization/README.md`. Gate partner access on the signed exception and add a "test data only" notice in the UI.
13. **Secrets creep for the live eval.** Running live eval "on each drafter change" in GitHub Actions means putting NVIDIA/Bedrock credentials in GitHub. Keep the live eval on the VPS/staging, with CI checking hashes only, unless the owner decides otherwise.
14. **Standing cloud reads.** If `cdk-drift.yml` gets a `CDK_DIFF_ROLE_ARN` for NZR-42, a daily cloud read starts with no standing read-only yes. Scheduling it counts as a standing change and needs the owner.
15. **Stale cost docs.** `staging.md` says ~$81/mo, but `deploy.yml` also provisions Paperclip on legacy staging (~+$104/mo per cost-guide). Owner budget figures may be low. Re-price from the estimator.
16. **Legacy prod keeps the /vectors leak.** NZR-5/6 fix the rebuild only. Whether to promote the fix to app.pgnos.ai is an unasked owner question.

**Open owner decisions:**
- D1: staging in NZR-42 as a second install vs a second account.
- D2: how testers reach the Nov 23 dry-run (local tunnel vs rebuild staging).
- D3: webhook public ingress (Cloudflare tunnel on pgnos.ai vs domain mode).
- D4: GitHub Actions for NZR-42, yes or no in 2026 (recommend no).
- D5: promote the NZR-5/6 fix to legacy prod.
