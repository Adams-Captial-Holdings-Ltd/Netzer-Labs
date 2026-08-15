# 2026-08-15 — the public entrypoint outage, and the guards that stop it recurring

## Session metadata

- Branch: `fix/public-entrypoint-guards`, cut from `origin/development` @ `03d7ee8`
- Worktree: `C:\dev\_netzer-entrypoint-guards` (the canonical clone was mid-change on
  another branch; see the maintenance rule about not disturbing an in-flight tree)
- Next merge target: `development`
- Deployment state: **not deployed**
- Pushed: yes

## What happened

`app.pgnos.ai` served Cloudflare **Error 1033** from **2026-08-14 16:03 UTC**.
`staging.pgnos.ai` served the same from **15:32 UTC**. Neither had a `cloudflared`
connector running anywhere in AWS.

Both were removed by GitHub Actions **Deploy** runs that reported **`success`**:

| UTC | Event |
|---|---|
| 15:12:50 | `staging` / push / Deploy starts (run `31813363493`) |
| 15:30:32 | `CCE-STAGING-Compute` UPDATE_COMPLETE — sidecar + tunnel-secret grant gone |
| 15:32:53 | last staging `cloudflared` log line → `staging.pgnos.ai` starts 1033 |
| 15:41:48 | `production` / workflow_dispatch / Deploy starts (run `31815756998`) |
| 15:54:05 | **`Public connector readiness` probe runs** → "No connector token yet" |
| 15:54:06 | `CDK deploy` begins with `CCE_PUBLIC_CONNECTOR_READY:` **empty** |
| 15:59:48–16:00:04 | **`CCE-Iam` grants the deploy role `secretsmanager:DescribeSecret`** |
| 16:00:27 | `CCE-Compute` UPDATE_COMPLETE — sidecar + grant gone; rev 6 registered by CFN |
| 16:03:07 | last prod `cloudflared` log line → `app.pgnos.ai` starts 1033 |
| 16:04:11 | `CCE-Compute.PublicConnectorAttached = false` |
| 16:07:46 | `Smoke test (health)` → `PUBLIC_HOST:` empty → short-circuits, run goes green |
| 16:33:49 | `claudeclaw-orchestrator:7` hand-registered **by `root`, outside CloudFormation** |
| 16:42:22 | those tasks fail: `AccessDeniedException … GetSecretValue on claudeclaw-public-tunnel` |
| 16:44:08 | circuit breaker rolls back to rev 6 (no sidecar) |
| 16:52:08 | user-reported `Ray ID a2b177df6ef979d9` |

## Root cause — three defects, none of which failed anything

1. **Ordering.** The readiness probe ran at 15:54:05, **six minutes before the same
   deploy granted it `secretsmanager:DescribeSecret` at 16:00:04.**
2. **Fail-silent.** The probe piped `describe-secret` through `2>/dev/null`, so
   `AccessDeniedException` was indistinguishable from "secret not filled yet". The step's
   own comment blessed this: *"Any failure here (including AccessDenied) leaves the output
   empty, i.e. 'not ready', which is the safe direction."* It is safe against attaching a
   connector to an empty token, and catastrophic against tearing a working connector out
   of a live environment. Only one direction had been considered.
3. **Self-blinding smoke test.** `PUBLIC_HOST` was derived from
   `steps.pubready.outputs.ready == '1'`, so the exact condition that dropped the sidecar
   also emptied the variable the health check needed, and the check exited 0.

The IAM grant is a side effect of `EcsSecret.fromSecretsManager()`, so removing the
container removed the permission too — which is why the 16:33 hand-rolled recovery died on
AccessDenied. The outage outlived its own fix attempt for that reason alone.

**Not causes** (each checked, each ruled out): DNS is correct and proxied; the named
tunnels and their ingress are intact; this was never a `trycloudflare` Quick Tunnel; the
app is healthy and already binds `0.0.0.0:3000`; all ALB targets are `healthy`; the
`production` branch **does** contain the feature (`bb2898b`, the exact running image tag).

## What changed here

| File | Change |
|---|---|
| `infra/lib/public-dashboard-access.ts` | new `assertPublicEntrypointRenderable()` — refuses to synth a stack that would take a declared hostname offline unless `CCE_PUBLIC_BOOTSTRAP=1` says so explicitly |
| `infra/lib/compute-stack.ts` | calls the assert before the sidecar block; grants the execution role read on the tunnel secret **unconditionally**, so re-attaching can never fail on AccessDenied |
| `.github/workflows/deploy.yml` | probe captures the AWS error and **fails** instead of guessing; remediation text uses `${TARGET_ENV}` not a hardcoded `staging`; smoke test keys off `vars.CCE_PUBLIC_ACCESS`, not off the probe |
| `infra/lib/public-dashboard-access.test.ts` | 7 regression tests |

Design note: `CCE_PUBLIC_BOOTSTRAP` is deliberately a **typed, one-deploy opt-in** rather
than an inference. The two-phase bootstrap is real and must keep working; what must stop is
it being the *default* answer to an unanswered question.

## Verification

Synth proof, hermetic (`CDK_DEFAULT_ACCOUNT=111111111111`):

| Case | Env | Result |
|---|---|---|
| A — the outage | `CCE_PUBLIC_ACCESS=1`, no `CONNECTOR_READY` | **synth fails**, names `app.pgnos.ai` |
| B — normal | `CCE_PUBLIC_CONNECTOR_READY=1` | exit 0; **1** `cloudflared` container |
| C — first deploy | `CCE_PUBLIC_BOOTSTRAP=1` | exit 0; **0** containers, **grant still present** |

Case C is the §6.2 proof: `TaskExecutionRoleDefaultPolicyA84DD1B0` still carries
`GetSecretValue` on `PublicTunnelSecret` with no container in the task.

### Validation run

Passed: `npm run typecheck` (clean), `npx vitest run infra/lib/public-dashboard-access.test.ts`
(26/26), `node scripts/ci/docs-links.mjs` (OK), `node scripts/ci/feature-knowledge.mjs` (OK),
`git diff --check` (clean), `js-yaml` parse of `deploy.yml` (valid), and the three synth cases.

`npm test`: **2004 passed, 14 failed across 6 files — all pre-existing.**
Baseline verified by stashing this branch's changes and re-running on pristine
`origin/development`. The failing files are `scripts/ci/{docs-links,feature-knowledge,runnable-blocks}.test.ts`,
`scripts/release/sync-deprecations.test.ts`, `scripts/lib/lifecycle/rollback-classes.test.ts`
(POSIX path separators on Windows) and `src/adapters/dashboard/jarvis.flow.test.ts`
(13 failures, 5s timeouts). **Note the last one is new to the recorded baseline, which had
five files — it is still not caused by this change.**

**Skipped, and not claimed as passing** — `development.md` step 7 lists nine commands;
these five were not run because this change touches CDK/infra and a workflow, not app or
web runtime code: `npm run build`, `npm --prefix web run typecheck`,
`npm --prefix web run build`, `npm run local:test:integration`, and the Docker/Floci stack
they need.

## Ledger carried forward

- `scripts/deploy.ts:457-492` implements the same readiness gate as the workflow and has
  **the same fail-silent shape**. This branch fixes the CI path only. The local path should
  get the same treatment before anyone relies on it.
- Still open from the previous session and still true: **no CloudWatch alarm on connector
  health.** `observability-stack.ts` has zero `cloudflared`/`tunnel` references; the alarm
  promised at `compute-stack.ts:625-628` does not exist. A nine-hour production outage was
  found by a human loading a page. Recommended: an external synthetic probe of
  `CCE_PUBLIC_HOSTNAME` on a 5-minute schedule into `claudeclaw-ops-alerts` — it catches
  1033, a Cloudflare-side ingress edit and a revoked token alike.
- `claudeclaw-orchestrator:7` is an out-of-band task definition registered by `root`.
  Decision this session: **leave it**; let CloudFormation supersede it. Nothing references it.
- The QEMU-emulated `linux/arm64` image build in CI is slow and flaky — one run failed on
  `npm error code ETIMEDOUT` mid-build. In-account CodeBuild builds ARM64 natively and is
  what `npm run deploy --build-cloud` uses.
- **Two documentation conflicts to resolve, not to paper over.** `development.md:1095-1108`
  says staging and production deploy via `deploy.yml`; the previous handoff says production
  is deployed by `npm run deploy` and has never been CI-deployed. As of 2026-08-14 the
  second is out of date — production *was* CI-deployed, and that is what broke it. And
  `development.md` has no rule that an environment's public entrypoint must survive a
  deploy, which is the gap this branch closes in code. Both need an owner's decision before
  the document is edited.
