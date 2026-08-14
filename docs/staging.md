# Staging environment

Staging is a second, complete copy of Netzar OS Enterprise running beside
production **in the same AWS account**, isolated by resource naming rather than
by account boundary. It exists so development and QA fixes can be exercised
against real Bedrock, real DynamoDB, real IAM and real Fargate before anything
reaches production.

- **URL: <https://staging.pgnos.ai>** (production is `app.pgnos.ai`)
- **Always on.** The ECS service runs 24/7 exactly like production's; visiting
  the URL does not start anything. Deploys are rolling updates to a service
  that is already running.
- **Continuous.** Merging `qa → staging` deploys it. Nobody dispatches a
  workflow.
- **Tier 0**, roughly $81/month.

> Isolation comes from `CCE_NAME_SUFFIX=staging`, which renames every resource
> to `claudeclaw-staging-*` and every stack to `CCE-STAGING-*`. Staging and
> production share an AWS account and share account-level Bedrock inference
> profiles; they share no table, bucket, queue, secret, cluster, or tunnel.

---

## What staging looks like

| | Staging | Production |
|---|---|---|
| Stacks | `CCE-STAGING-*` | `CCE-*` |
| Resources | `claudeclaw-staging-*` | `claudeclaw-*` |
| Tier | 0 (1 task, 512 CPU / 1024 MB) | 2 (3 tasks, autoscaled) |
| Public URL | `staging.pgnos.ai` | `app.pgnos.ai` |
| Cloudflare tunnel | `netzar-staging-public` | `netzar-production-public` |
| Tunnel secret | `claudeclaw-staging-public-tunnel` | `claudeclaw-public-tunnel` |
| Deploy trigger | push to `staging` | manual dispatch + typed `deploy` |
| ALB | internal, not in the public path | internal, not in the public path |

Both environments run `CCE_DEPLOY_MODE=infra-only`, so the ALB is synthesized
**internal** with no public listener. The public path does not go through it:

```
browser -> Cloudflare (TLS terminates here)
        -> Cloudflare Tunnel (remotely managed)
        -> cloudflared sidecar INSIDE the Fargate task
        -> orchestrator on http://localhost:3000
```

The connector dials out, so this adds no AWS ingress: no public task IP, no
public listener, no security-group hole.

### There is no Route 53 hosted zone and no ACM certificate in this account

`pgnos.ai` is a Cloudflare zone. **`DOMAIN_NAME` must stay empty for staging.**
A non-empty value sends `infra/lib/compute-stack.ts` into
`HostedZone.fromLookup` against a zone that does not exist, fails at synth, and
would also flip the ALB internet-facing. Setting `HOSTED_ZONE_ID` does not
rescue it — the certificate and alias record still need a real zone.

Verify a staging template carries neither:

```bash
grep -E 'CertificateManager::Certificate|Route53::RecordSet' cdk.out/CCE-STAGING-Compute.template.json
```

That must print nothing.

---

## Deploying to staging

Merge the promotion PR. That is the whole procedure:

```bash
gh pr create --base staging --head qa --title "promote qa to staging"
```

The push to `staging` triggers `.github/workflows/deploy.yml`, which builds the
ARM64 image, deploys the `CCE-STAGING-*` stacks, forces an ECS rollout, waits
for the service to stabilize, and smoke-tests `https://staging.pgnos.ai/health`.

`scripts/ci/deploy-source-guard.mjs` refuses any staging deploy whose ref is not
`refs/heads/staging`, and staging ignores the workflow's `tier` input — it is
pinned to Tier 0 so a careless dispatch cannot provision Enterprise tier.

To deploy from a laptop instead (all 13 phases, including the deploy lock and
rollback manifest):

```bash
npm run deploy -- --env=staging --tier=0
```

Never hand-assemble a `cdk deploy` invocation; you lose preflight, the deploy
lock, and the rollback manifest.

---

## First-time setup of the public URL

Only needed once per environment, and already done for staging. Recorded here
because the ordering is not obvious and getting it wrong crash-loops the task.

The connector is an **essential** container that reads the `token` field of the
tunnel secret. Attaching it before a real token exists means ECS cannot resolve
the secret, the container never starts, and the rollout fails. So the secret and
the sidecar arrive on **two separate deploys**.

1. **Create the tunnel in Cloudflare** — remotely managed (`config_src`
   `cloudflare`), named `netzar-staging-public`, with ingress
   `staging.pgnos.ai -> http://localhost:3000` and an `http_status:404`
   catch-all. Add a **proxied** CNAME `staging` pointing at
   `<tunnel-id>.cfargotunnel.com`. A locally managed tunnel is not an option:
   its credentials live in a file on one laptop and cannot survive a Fargate
   task restart.
2. **Set the GitHub `staging` environment variables**: `CCE_PUBLIC_ACCESS=1`,
   `CCE_PUBLIC_HOSTNAME=staging.pgnos.ai`,
   `CCE_DASHBOARD_URL=https://staging.pgnos.ai`.
3. **Deploy once.** The readiness gate finds no token, so this deploy creates
   the retained `claudeclaw-staging-public-tunnel` secret holding `REPLACE_ME`
   and attaches no sidecar. This is the expected outcome, not a failure.
4. **Write the token:**

   ```bash
   npm run public:setup -- --env=staging
   ```

   This reads the connector token through the `cloudflared` CLI and writes it
   straight to Secrets Manager under the `CCE-PUBLIC-READY` version stage. The
   token is never printed, never an argv element, never written to `.env`, and
   never returned. It requires a one-time `cloudflared tunnel login` in a
   browser and the tunnel from step 1 to already exist.
5. **Deploy again.** The readiness gate now finds the stage, the sidecar joins
   the task, and `staging.pgnos.ai` serves.

`.env.staging` (gitignored) needs `CCE_NAME_SUFFIX=staging`,
`CCE_DEPLOY_MODE=infra-only`, `CCE_PUBLIC_ACCESS=1`,
`CCE_PUBLIC_HOSTNAME=staging.pgnos.ai`, plus `AWS_ACCOUNT_ID` and `AWS_REGION`.
It holds **no Cloudflare credential** — the CLI's browser authorization covers
that.

---

## Access and verification

```bash
curl https://staging.pgnos.ai/health          # {"status":"ok",...}
curl -o /dev/null -w '%{http_code}\n' https://staging.pgnos.ai/api/agents   # 401
```

Sign in at `https://staging.pgnos.ai/dashboard/` with the staging
`DASHBOARD_TOKEN`. Staging has its own dashboard token, encryption key, and
security PIN; **no production credential works against staging and none of
staging's work against production.**

Break-glass access if the tunnel is down, using an SSM port-forward to the
running task:

```bash
$env:AWS_PROFILE="netzer-process"
npm run dashboard:tunnel     # then http://localhost:3000
```

After any deploy, confirm the app actually booted rather than trusting a green
CloudFormation status:

```bash
aws logs tail /claudeclaw-staging/orchestrator --since 10m | Select-String "Refusing to start"
```

Secrets are created by CDK as `REPLACE_ME` placeholders **by design** and
populated out of band; `cdk deploy` does not overwrite a populated secret. A
container that logs `Refusing to start: required production config is missing or
placeholder` means a secret was never populated, not that the deploy failed.

---

## Cost

Tier 0 is about **$81/month**, dominated by the NAT gateway and one Fargate
task. The daily cost cap comes only from `tier.dailyCostCapDefaultUsd` ($5/day
at Tier 0) — `CCE_DAILY_COST_CAP_USD` in `.env.staging` is inert by design, so a
stray shell variable cannot raise or lower it. Change it live through
runtime-config `cost/daily_cap_usd`.

Never set `CCE_PRIVATE_ENDPOINTS=1` in staging: it adds roughly $175/month of
VPC endpoints for no staging confidence.

Recalculate with `node scripts/cost-estimate.mjs`.

---

## Deferred

- **Staging Slack and Telegram bots.** They need their own apps and webhook
  secrets pointed at `staging.pgnos.ai`; until then those surfaces are
  production-only and staging exercises the dashboard surface.
- **NAT-free staging** (~$29.65/month saving) — touches shared networking that
  production synthesizes from.
