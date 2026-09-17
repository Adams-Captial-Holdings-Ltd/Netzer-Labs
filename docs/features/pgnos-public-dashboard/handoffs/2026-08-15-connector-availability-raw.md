---
feature: pgnos-public-dashboard
document_role: session-handoff
status: historical
observed_at: 2026-08-15
session_slug: connector-availability-raw
imported_from: C:/dev/Netzer-Labs/handoff-connector-availability-2026-08-15.md
imported_at: 2026-09-17
---

> Imported verbatim on 2026-09-17 during the machine transfer. Raw pre-template session log; historical only; paths refer to the old machine.

# Handoff: Cloudflare connector availability — outage remediation, monitoring, and HA hardening

> Note: the repo's tracked `handoff.md` is a Missions compatibility stub and was deliberately
> NOT overwritten (same choice as the 2026-08-14 session). This file is a session handoff,
> untracked.

## Session Metadata
- Created: 2026-08-15 (session ran 2026-08-15 ~01:30–18:00 UTC)
- Project: `C:\dev\Netzer-Labs`
- Branch at handoff: `fix/staging-anomaly-monitor-20260813-135423` @ `f5fc05d` (canonical clone, untouched)
- Working branches: `fix/alarm-threshold-and-env-bag` @ `682c7ff` (worktree `C:\dev\_netzer-ha`)
- Session duration: ~16 hours across two AWS auth windows

## Current State Summary

**Both public hostnames are healthy and the highest-severity risk is neutralised.** `app.pgnos.ai`
and `staging.pgnos.ai` both return HTTP 200. Production runs 3/3 Fargate tasks with 3 registered
Cloudflare connectors across two AZs; staging runs 1/1 with 1 connector. Staging was down (HTTP 530,
zero connectors) for ~18 hours and was repaired this session.

The nightly `claudeclaw-power-auto-pause` — which **provably took production to zero connectors for
~5.5 hours on 2026-08-10** — is now DISABLED in AWS via a direct CLI stopgap, and is additionally
suppressed by a stale `mode: "paused"` state record that must be left alone until the IaC lands.

Work stopped mid-ladder: **GitHub Actions runners stopped starting entirely** (jobs complete in
2–4 s with `steps=0`, reproducible across three re-runs). `development` and `qa` carry all changes;
`staging` and `production` do not. Production has **not** been deployed with any new code.

## Codebase Understanding

### Architecture Overview

Production is ECS Fargate in account `239887088812`, `us-east-1`, VPC `vpc-0e70d9556d328c1fc`.
The public request path does **not** traverse the ALB:

```text
app.pgnos.ai (Cloudflare-proxied)
  → Cloudflare Edge (TLS terminates here — the account has ZERO Route 53 zones and ZERO ACM certs)
  → Named Tunnel netzar-production-public (8729640c-53cc-4b88-a1ed-6d0ba3ed37c6, remotely managed)
  → cloudflared sidecar, one per Fargate task, essential:true, digest-pinned 2026.7.3
  → http://localhost:3000 (shared task netns)
  → Hono orchestrator, binds 0.0.0.0:3000
  → DynamoDB (32 tables) / Bedrock / S3 / Secrets Manager

  internal ALB claudeclaw-alb serves health checks and Slack/Telegram webhooks ONLY.
  It is scheme=internal, so it is NOT a fallback — the tunnel is the only public path.
```

Connector-to-AZ mapping is provable from both sides: Cloudflare reports connector origin IPs
`44.208.10.19` and `98.94.244.73`, which are this VPC's NAT gateway EIPs in `us-east-1b` and
`us-east-1a` respectively.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `infra/lib/public-dashboard-access.ts` | Resolver + `assertPublicEntrypointRenderable()` | The synth guard that refuses to emit a connector-less task def |
| `infra/lib/compute-stack.ts:576` | `if (publicAccess.enabled && publicTunnelSecret && CCE_PUBLIC_CONNECTOR_READY === '1')` | The condition that silently dropped the connector on 2026-08-14 |
| `infra/lib/power-switch-stack.ts:309-321` | `CfnSchedule` for auto-pause | Had **no `state` property**, so CFN defaulted it to ENABLED |
| `infra/lib/power-switch-handler/index.js:320-345` | `doPause` → `setBounds(0,0)`, `setDesired(0)` | The code that zeroes production |
| `infra/lib/power-switch-handler/index.js:383` | `doAutoPause` early-return on `mode === 'paused'` | **Why production has survived since 08-10** |
| `infra/lib/observability-stack.ts` | Alarms, SNS topic, new uptime probe | Topic had 32 alarms and **zero subscribers** |
| `scripts/deploy.ts` | 13-phase deploy orchestrator | Readiness gate; `cdkEnvBag` allowlist |
| `scripts/lib/lifecycle/cloud-build.ts:244-249` | `ARM_CONTAINER` CodeBuild | The native-ARM path that fixes the QEMU problem |
| `.github/workflows/deploy.yml:232-250` | `pubready` step | Fail-silent probe that caused the 08-14 outage |
| `docs/diagrams.map` | Diagram ownership | Drift gate fails if you touch a mapped source without updating its note |

### Key Patterns Discovered

- **`cdkEnvBag` in `scripts/deploy.ts` is an ALLOWLIST.** A variable set in `.env` but absent from
  the bag never reaches the `cdk` child process. This silently disabled the SNS subscription.
- **`cdk deploy --exclusively` still synthesizes the WHOLE app.** Phase a constructs `ComputeStack`,
  so anything the deploy sets up after phase a is unavailable during that synth.
- **Exact-literal `'1'` is the convention** for every feature flag (`CCE_PUBLIC_ACCESS`,
  `CCE_CODEBUILD_ENABLED`, `CCE_DEMO_RESET_ENABLED`). Follow it; `'true'` must not work.
- **`APP_NAME_SUFFIX === ''` means production.** `props.tier` is NOT a usable discriminator —
  CI passes tier 3 to both environments.
- **Diagram drift gate**: touching a source in `docs/diagrams.map` requires updating that diagram's
  `<!-- drift-gate: ... -->` header in the same PR, or CI fails.

## Work Completed

### Tasks Finished

- [x] Diagnosed the 2026-08-14 outage to exact root cause with timestamps
- [x] Restored production (`app.pgnos.ai` 200, connector re-attached)
- [x] Independent HA audit — verified Named Tunnel, 3 connectors, multi-AZ, no laptop dependency
- [x] Discovered a **second, previously unknown production outage** (2026-08-10, ~5.5 h)
- [x] Disabled production auto-pause in AWS (CLI stopgap, reversible)
- [x] Repaired staging via native-ARM CodeBuild (`staging.pgnos.ai` 200, connector registered)
- [x] Built the synth guard, IAM decoupling, uptime probe, capacity alarm, SNS subscription
- [x] Merged PRs #57, #58, #62, #63, #66 → `development`; #67 → `qa`

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| `infra/lib/public-dashboard-access.ts` | `assertPublicEntrypointRenderable()` | Fail synth rather than silently drop the public entrypoint |
| `infra/lib/compute-stack.ts` | Call the assert; unconditional `publicTunnelSecret.grantRead()` | Re-attaching must never fail on AccessDenied |
| `infra/lib/power-switch-stack.ts` | `autoPauseEnabled` prop → `state`; `AUTO_PAUSE_FORBIDDEN`; prod synth assertions | Three independent guards against scale-to-zero |
| `infra/lib/power-switch-handler/index.js` | `doAutoPause` refuses when forbidden | Survives console drift / stale CFN state |
| `infra/lib/observability-stack.ts` | Uptime probe Lambda + rule + 2 alarms + `EmailSubscription` | Detection, which did not exist |
| `infra/bin/app.ts` | Pass `autoPauseEnabled`, `publicHostname`, `opsAlertEmail` | Per-environment wiring |
| `scripts/deploy.ts` | Readiness gate moved before phase a; `CCE_OPS_ALERT_EMAIL` added to `cdkEnvBag` | Two ordering/allowlist bugs |
| `.github/workflows/deploy.yml` | Probe fails on AWS error; smoke test keys off `CCE_PUBLIC_ACCESS`; forward `CCE_OPS_ALERT_EMAIL` | Fail-silent + self-blinding test |
| `.env.reference`, `docs/diagrams/*.md` | New vars documented; drift-gate notes | Required by the docs gates |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Harden the tunnel, not migrate to public ALB+ACM | Tunnel / ALB+ACM / defer | No hosted zone or cert exists; ALB is internal by design. User chose. |
| `state: 'DISABLED'` over deleting the schedule | Set state / omit resource / gate whole stack | Mutates in place, stays auditable, keeps `resourceCountIs(...,1)` test green, doesn't orphan the IAM role |
| Capacity threshold `min(2, tier.fargateMinTasks)` | Fixed 2 / `tier.fargateMinTasks` / tier-aware | Fixed 2 alarms forever on T0; raw tier value pages on every T3 task replacement |
| Probe outside the VPC | In-VPC / outside / Synthetics canary | A check sharing the path it tests cannot report that path failing; also avoids NAT cost |
| Restore prod first, harden second | Restore-first / fix-first | Prod was down ~10 h |
| Leave `claudeclaw-orchestrator:7` alone | Deregister / leave | Inert; touching it by hand repeats the mistake that made it |
| Native-ARM CodeBuild for staging | Re-run QEMU / `--build-cloud` / native ARM runner | QEMU hung twice at 40+ min; GitHub ARM runners are paid on private repos |

## Errors, Mistakes & Learnings

### Errors Encountered

| Error / Symptom | Cause | Resolution | Status |
|---|---|---|---|
| `app.pgnos.ai` HTTP 530 / Cloudflare 1033 | Deploy removed the `cloudflared` sidecar; task def rolled back to a connector-less revision | Re-ran the prod deploy after the IAM grant landed | Resolved |
| `AccessDeniedException ... GetSecretValue on claudeclaw-public-tunnel` | The same deploy that removed the container removed its auto-generated IAM grant | `grantRead()` made unconditional | Resolved |
| Staging deploy stopped at Phase a: `CCE_PUBLIC_CONNECTOR_READY is not "1"` | Readiness gate ran after phase a, but phase a synthesizes the whole app | Moved the gate before phase a | Resolved |
| `claudeclaw-staging-connector-capacity` stuck in ALARM | Threshold hardcoded to 2; Tier 0 runs 1 task | `min(2, tier.fargateMinTasks)` | Resolved (not deployed) |
| SNS topic still had 0 subscribers after a deploy that set `CCE_OPS_ALERT_EMAIL` | `cdkEnvBag` is an allowlist; var not in it | Added to the bag | Resolved (not deployed) |
| `npm error code ETIMEDOUT` in CI ARM64 build | QEMU emulation, no layer cache, no retry | Used `--build-cloud` (native ARM) | Worked around |
| `spawn zip ENOENT` at end of staging deploy | No `zip` binary on Windows | None — deploy succeeds, but **no rollback manifest was produced** | Open |
| All Actions jobs `completed/failure` with `steps=0` | Runners never start; likely exhausted minutes or spending limit | **Unresolved — blocks everything** | Open |

### Mistakes Made & Corrections

| Mistake | Impact | Correction | Lesson |
|---|---|---|---|
| Claimed "the `production` branch lacks the tunnel code" | Wrong root cause in the first report; §6.3 of the plan was unnecessary | Fetched and verified `origin/production` @ `bb2898b` **is** the running image | Fetch before asserting anything about a remote branch |
| Explained the auto-pause as "fires and is overwritten by `cdk deploy`" | Understated the risk; nearly led me to "repair" the state record and re-arm a nightly outage | Queried `RunningTaskCount` for 2026-08-10 and found 3 → **0** for 5.5 h | Check the metric before theorising about why something didn't break |
| Merged PR #62 with the drift gate red | Left `development` with a known-red gate | Fixed forward in #63; added an explicit check-gate to later merges | GitHub Free cannot enforce branch protection — `gh pr merge` will happily merge red |
| Recorded the Windows test baseline as 5 files | Would have mis-attributed a 6th failure to my change | Stashed changes, re-ran on pristine `origin/development`, found `jarvis.flow.test.ts` also fails | Verify a baseline by re-running it, don't trust a note |
| Hardcoded the capacity threshold to 2 | False-positive ALARM on staging | Tier-aware `min(2, ...)` | A constant that is right for one environment is usually wrong for another |
| Assumed setting `CCE_OPS_ALERT_EMAIL` in `.env` was enough | Alarms deployed with nobody subscribed | Added to `cdkEnvBag` | Trace a config value all the way to the resource; don't assume it propagates |

### Key Learnings

- **The stale `mode: "paused"` record is load-bearing.** It is the ONLY reason the nightly pause has
  not fired since 08-10. Deploying the DISABLED schedule must come FIRST; resetting that record
  before then re-arms the outage.
- **"It hasn't broken" is not "it can't break."** The pause looked dormant for five days; the metric
  showed it had already caused a 5.5-hour outage nobody noticed.
- **Fail-closed needs a direction.** `deploy.yml`'s probe treated any failure as "not ready" and
  called that "the safe direction" — safe against attaching a bad connector, catastrophic against
  removing a working one.
- **A test that keys off the thing it is testing is not a test.** The smoke test derived `PUBLIC_HOST`
  from the same probe output that dropped the sidecar, so it short-circuited and went green.
- **`--build-cloud` is the reliable image path on this machine.** Native ARM, no Docker, no QEMU.

### Prevention / Future Guidance

- Before any `cdk deploy` of `CCE-PowerSwitch`, confirm the template carries `State: DISABLED`.
- After any production deploy, assert the live task definition still contains `cloudflared`:
  `aws ecs describe-task-definition --task-definition claudeclaw-orchestrator --query 'taskDefinition.containerDefinitions[].name'`
- Never trust a green Deploy run as evidence the public URL is up — `curl https://app.pgnos.ai/health`.
- Record the Windows baseline by stashing and re-running, every time.
- Use `npm run deploy -- --env=staging --yes --build-cloud`, not the CI QEMU build.
- When touching anything in `docs/diagrams.map`, update that diagram's drift-gate header in the same PR.

## Pending Work

### Immediate Next Steps

1. **Resolve the GitHub Actions outage.** Check Settings → Billing → Actions. Everything below is
   blocked on it. (`gh api users/<user>/settings/billing/actions` needs the `user` scope.)
2. **Merge PR #68** (`qa` → `staging`), then deploy staging with
   `AWS_PROFILE=netzer-process npm run deploy -- --env=staging --yes --build-cloud` from a clean
   `staging` checkout. Verify `claudeclaw-staging-connector-capacity` leaves ALARM and
   `claudeclaw-staging-ops-alerts` gains a subscription.
3. **Merge PR #61** (`staging` → `production`) and dispatch the production deploy with
   **`tier: 2`** (the input default is `3` ≈ $306/mo).
4. **Only after step 3 lands**, reset `claudeclaw-power-state` from `mode: "paused"` to `awake`.
5. **Confirm the SNS email subscription** — AWS sends a link to `emmanuelmadams4@gmail.com`; until
   clicked, the subscription is `PendingConfirmation` and delivers nothing.
6. Run the controlled failover test (stop ONE `us-east-1b` task; `us-east-1a` keeps its only connector).
7. Prove the alarm fires (point a throwaway probe at a bad path; watch ALARM → SNS).

### Blockers/Open Questions

- [ ] **Blocker: GitHub Actions runners will not start.** Needs: billing/minutes resolution. Verified
      unavailable across 3 re-runs of run `31898022686` (attempts 1–3, all `steps=0`).
- [ ] **Blocker: production deploy has no local path.** Needs: either Actions restored, or the real
      prod `.env` placed at `C:\dev\Netzer-Labs\.env`. Do **not** reconstruct it — phase b
      (`populateSecretsV2`) overwrites live production secrets with whatever is in that file, and a
      wrong `DASHBOARD_TOKEN` breaks dashboard auth.
- [ ] **Open: `SchedulerStalledAlarm` is muted and starved.** `actionsEnabled: false` since
      2026-08-08 and reporting "no datapoints received" — the `SchedulerTick` metric filter
      (`observability-stack.ts:329`) has produced nothing for a week. Diagnose before un-muting.
- [ ] **Open: no rollback manifest for the 2026-08-15 staging deploy** (`spawn zip ENOENT`).
      `npm run deploy:rollback --class=infra` has no artifact for it.

### Deferred Items

- CI regression guards (bidirectional synth assertion, `scripts/ci/public-entrypoint-guard.mjs`,
  Layer-A verify check asserting `cloudflared` in the live task def) — designed, not written.
- `deploy.yml` buildx layer cache + retry (the QEMU slowness is unfixed; only bypassed).
- `cloudflared` 2026.7.3 → 2026.8.2 (one release behind; upgrade is a manual digest edit).
- `vars.CCE_PUBLIC_BOOTSTRAP` is referenced in `deploy.yml`'s smoke expression but the GitHub
  variable does not exist. Evaluates falsy, so behaviour is correct, but the bootstrap path cannot
  be exercised from CI until it is created.
- Public ALB + ACM migration (considered and deferred by the user; would remove cloudflared entirely).

## Context for Resuming Agent

### Important Context

**Do not reset `claudeclaw-power-state` to `awake` until the DISABLED schedule is deployed to
production via CloudFormation.** The record currently reads `mode: "paused"` (since 2026-08-10), and
`doAutoPause` (`power-switch-handler/index.js:383`) returns early on exactly that value. It is the
active suppressor. My CLI stopgap disabled the schedule too, so there are two layers — but the
production CloudFormation template **still has no `state` property**, so any `cdk deploy` of
`CCE-PowerSwitch` before the IaC lands will re-ENABLE the schedule and remove one layer.

**Production has had three 1033 outages, two of them undetected:**

| When | Duration | Cause |
|---|---|---|
| 2026-08-10 10:00–~16:00 UTC | ~5.5 h | auto-pause executed; `RunningTaskCount` 3 → 0 |
| 2026-08-14 15:32 UTC (staging) | ~18 h | CI deploy removed the sidecar |
| 2026-08-14 16:03 → 08-15 02:19 UTC (prod) | ~10 h | same |

**PRs merged this session:** #57, #58, #62, #63, #66 → `development`; #67 → `qa`.
**PRs open:** #68 (`qa` → `staging`), #61 (`staging` → `production`).

`development` and `qa` are current. `staging` is at `ae9458d` (missing #66). `production` is at
`bb2898b` (missing everything).

### Assumptions Made

- The Actions failure is exhausted minutes / a spending limit. **Not verified** — the billing API
  needs the `user` scope, which was deliberately not requested.
- The 2026-08-10 restoration to 3 tasks was a human or a deploy; no journal entry was found.
- `emmanuelmadams4@gmail.com` is the correct ops destination (user-selected this session).

### Potential Gotchas

- **`gh pr merge` merges red PRs.** GitHub Free cannot enforce branch protection on a private repo
  (`branch-guard.yml:3-7`). Gate on `gh pr checks` yourself.
- **Merging into `staging` triggers a push deploy** using the QEMU build. Cancel it and use
  `--build-cloud`, or it will hang for 40+ minutes.
- **Git Bash mangles paths starting with `/`** in `git show rev:path` and AWS log-group names.
  Prefix with `MSYS_NO_PATHCONV=1` or use PowerShell.
- **Node under Git Bash sees `/tmp` as `C:\tmp`.** Use the scratchpad with Windows-style paths.
- **`deploy.yml`'s `tier` input defaults to `'3'`** (~$306/mo). Production runs tier 2.
- **The ALB security group allows `0.0.0.0/0` on 80/443** — not exploitable (the ALB is internal,
  no public IP), but it would become a real exposure if anyone flipped the scheme.
- Windows unit-test baseline on `origin/development` is **6 files / 14 tests failing**:
  `scripts/ci/{docs-links,feature-knowledge,runnable-blocks}.test.ts`,
  `scripts/release/sync-deprecations.test.ts`, `scripts/lib/lifecycle/rollback-classes.test.ts`,
  `src/adapters/dashboard/jarvis.flow.test.ts`.

## Environment State

### Tools/Services Used

- **AWS** account `239887088812`, `us-east-1`. Auth: `aws login --profile netzer-root` (root-user
  browser sign-in + MFA), then `AWS_PROFILE=netzer-process` for anything SDK-based. **Sessions
  expire in hours** — this session was interrupted by one expiry.
- **Cloudflare**: `cloudflared` CLI at `C:\Program Files (x86)\cloudflared`, authenticated via
  `~/.cloudflared/cert.pem`. `cloudflared tunnel list` / `tunnel info <name>` are read-only and work.
- **GitHub CLI** authenticated. **Actions is down.**
- Docker not running (irrelevant — `--build-cloud` is the path).

### Active Processes

- None. All background deploys completed.

### Worktrees (clean these up when done)

| Path | Branch | Purpose |
|---|---|---|
| `C:\dev\Netzer-Labs` | `fix/staging-anomaly-monitor-...` | Canonical clone; has uncommitted `development.md` + untracked files — **leave alone** |
| `C:\dev\_netzer-ha` | `fix/alarm-threshold-and-env-bag` | Where the HA work was written |
| `C:\dev\_netzer-staging` | detached @ `7cfd406` | Used for the native-ARM staging deploy; holds a local `.env.staging` |

### Environment Variables

Names only. New this session: `CCE_OPS_ALERT_EMAIL`, `CCE_POWER_AUTO_PAUSE_ENABLED`,
`AUTO_PAUSE_FORBIDDEN` (Lambda env), `CCE_PUBLIC_BOOTSTRAP` (synth opt-in).
Set as GitHub environment variables on both `production` and `staging`: `CCE_OPS_ALERT_EMAIL`.
`.env.staging` (gitignored) additionally carries `CCE_OPS_ALERT_EMAIL` locally.

## Related Resources

- `docs/features/pgnos-public-dashboard/handoffs/2026-08-15-public-entrypoint-outage-guards.md`
- `docs/features/pgnos-public-dashboard/handoffs/2026-08-14-staging-public-url.md`
- `handoff-staging-deploy-2026-08-14.md` (previous session, repo root, untracked)
- `docs/superpowers/specs/2026-08-11-netzar-os-pgnos-public-dashboard-email-design.md`
- Outage evidence: Deploy runs `31813363493` (staging), `31815756998` (prod), `31857953688` (recovery)
- `docs/tunnel-setup.md` is **stale and contradicts the implementation** — it teaches
  `cloudflared tunnel create` + a credentials-file `config.yml` pointed at the ALB, all three of
  which the pgnos code forbids. Do not follow it during an incident.
