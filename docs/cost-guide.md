# Cost guide: what each tier actually costs

> Running ClaudeClaw Enterprise has a fixed monthly floor (the always-on AWS plumbing: Fargate tasks, NAT gateways, the load balancer) and a variable part (Bedrock tokens, which the built-in daily cost cap keeps bounded). The floor ranges from roughly $65 to $95 a month at the Hobby tier up to $300-plus at the Enterprise tier before any real traffic, with stated assumptions below. The numbers on this page age, so the repo ships a small recalculable estimator, `scripts/cost-estimate.mjs`, whose unit prices are an editable block at the top; trust the script over any prose snapshot.

**As of:** 2026-06. **Region assumption:** us-east-1. **Traffic profile assumption:** light (about 50 agent turns/day, ~1 ALB LCU, single-digit GB of logs). All figures USD, on-demand pricing, before taxes.

## What each tier actually provisions

This table is read directly from `TIERS` in [`infra/lib/constants.ts`](../infra/lib/constants.ts), the single source of truth CDK deploys from. The cost-relevant columns only:

| Tier | Label | Fargate (min tasks x size) | NAT | Log retention | Flow Logs | WAF | X-Ray | CloudFront | WORM audit bucket | GuardDuty + Config | Daily cap default |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T0 | Hobby | 1 x 0.5 vCPU / 1 GB | 1 | 7 days | no | no | no | no | no | no | $5 |
| T1 | Standard | 2 x 1 vCPU / 2 GB | 2 | 30 days | yes | no | no | no | no | no | $50 |
| T2 | Pro | 2 x 2 vCPU / 4 GB (scale to 10) | 2 | 90 days | yes | yes | yes | no | yes | no | $200 |
| T3 | Enterprise | 3 x 2 vCPU / 4 GB (scale to 20) | 2 | 365 days | yes | yes | yes | yes | yes | yes (T3) | $1000 |

Every tier also carries: an ALB, 3 customer-managed KMS keys, 6 Secrets Manager secrets, ~31 on-demand DynamoDB tables, 6 S3 buckets, 9 CloudWatch alarms + a dashboard, and (with a domain) a Route 53 hosted zone. Tasks run on ARM64 Fargate, which is roughly 20% cheaper than x86.

## Fixed-floor ranges per tier

Computed by the estimator under the stated assumptions, then widened into honest ranges (usage wiggle, AWS price drift, data transfer):

| Tier | Estimator floor | Honest range | What dominates |
|---|---|---|---|
| T0 Hobby | ~$82/mo | **$65 to $95** | NAT ($33) + ALB ($22): the network plumbing costs more than the compute ($14) |
| T1 Standard | ~$159/mo | **$130 to $180** | 2 NAT ($66) + 2 tasks ($58) + ALB ($22) |
| T2 Pro | ~$230/mo | **$230 to $400** | 2 bigger tasks ($115) + NAT; the top of the range is autoscaling above the 2-task minimum under load |
| T3 Enterprise | ~$306/mo | **$300 to $800** | 3 tasks ($173) + NAT; the top of the range is real traffic: more tasks, GuardDuty/Config volume pricing, CloudFront egress, 365-day log storage |

### Reconciling with the README's numbers

The repository README quotes ~$50 / ~$140 / ~$350 / ~$500-800 per tier. Those are operational observations from the live deployment, not a parts-list calculation, and they reconcile like this:

- **T1 ~$140** matches the estimator's ~$159 floor within noise; the live install's gateway endpoints (free) keep NAT data low. Treat $130-180 as the honest band.
- **T0 ~$50** is optimistic against the parts list: the ALB ($22/mo) and one NAT ($33/mo) alone exceed it. A genuinely sub-$60 T0 requires very low NAT data and riding CloudWatch free tiers. Budget $65-95.
- **T2 ~$350 and T3 ~$500-800** sit above the estimator floors (~$230 / ~$306) because production carries more than the light-traffic profile: autoscaled tasks above the minimum, heavier log ingest, real GuardDuty/Config event volume, and data transfer. The floor is what you pay while idle; the README figures are what a working install tends to cost.

One repeated real-world lesson encoded in the defaults: **VPC interface endpoints are the single biggest optional line.** They are opt-in (`CCE_PRIVATE_ENDPOINTS=1`, default OFF) because the full set measured roughly $175/month on the original deployment; with NAT present, tasks already reach every AWS API. Turn them on only when PrivateLink isolation is a requirement, and re-run the estimator with `privateEndpoints: true` to see the impact.

## Variable cost: Bedrock tokens

Token spend scales with usage, not tier. Reference prices (per 1M tokens; Bedrock token/image rates re-verified against live AWS pricing on 2026-07-16): Sonnet $3 in / $15 out, Haiku $1 in / $5 out, Opus $5 in / $25 out, Titan embeddings $0.02 in, image generation ~$0.04 per image on `stability.stable-image-core-v1:1` (the deployed default, us-west-2; Nova Canvas, for installs that pin it back, runs $0.04 standard 1024px / $0.06 premium). (Opus 4.5 cut the earlier Opus 4/4.1 rate of $15/$75 by two-thirds; 4.6-4.8 hold the $5/$25 price. Haiku $1/$5 is the 4.5-generation rate — the models this repo deploys — versus the older Haiku 3.5 rate of $0.80/$4.)

Worked illustration at the assumed profile (50 turns/day, ~6,000 input tokens per turn once the system prompt, memories, and history stack up, ~500 output): **about $39/month on Sonnet, about $13/month on Haiku.** Three built-in bounds keep this honest:

1. **The daily cost cap** (`cost_cap_per_day` kill switch + runtime-config `cost/daily_cap_usd`, tier defaults in the table above) hard-stops Bedrock spend in-app, failing closed when the day's spend cannot be computed.
2. **The CostGuardrails stack** pairs an AWS Budget — which emails you at 80% and 100% of actual spend and at 100% of forecast — with Cost Anomaly Detection, an ML monitor that separately alerts on unusual per-service spend spikes (not on percentage-of-budget thresholds).
3. **Prompt caching** (`CCE_PROMPT_CACHE`, on by default) cuts repeat input-token cost on the system prompt and tool catalog.

## The recalculable estimator

```bash
node scripts/cost-estimate.mjs            # all four tiers, line by line
node scripts/cost-estimate.mjs --tier=1   # one tier
node scripts/cost-estimate.mjs --json     # machine-readable
```

No dependencies, plain Node. Two blocks at the top of [`scripts/cost-estimate.mjs`](../scripts/cost-estimate.mjs) are meant to be edited:

- `UNIT_PRICES`: per-resource AWS unit prices. **These age.** When AWS reprices (or you deploy to a pricier region), edit the block and re-run instead of trusting this page's snapshot.
- `ASSUMPTIONS`: the usage profile (NAT data, log volume, turns/day, whether you have a domain, whether private endpoints are on).

The `TIER_SHAPES` block mirrors `TIERS` in `infra/lib/constants.ts`; if a tier's shape changes there, update the script in the same PR.

### What the estimator deliberately excludes

Data transfer beyond the stated assumptions, Polly/Transcribe/SES usage (pennies at light volume), generated images, autoscaling above the minimum task count, the WORM audit bucket's long-tail storage growth (T2+), and taxes. It estimates the floor you commit to by deploying, not your bill under load; the dashboard's **Cost** tab reads live Cost Explorer data for that.

## Watching the real bill

- **Dashboard Cost tab**: month-to-date, run-rate projection, by-service breakdown, and a waste scan (idle NAT, redundant endpoints, unattached EIPs, orphaned EBS) with a dollar figure per finding.
- **Spending cap card**: sets the in-app daily cap and syncs the AWS monthly Budget to roughly cap x 30.4.
- **`cost/watch_enabled`** (runtime-config, default off): a daily worker that alerts the ops SNS topic when recoverable waste jumps or the projection exceeds budget.
- **Power panel maintenance card** (works even while everything else is paused): the pause/wake panel's `/costs` action inventories your actual always-on resources, prices them with the rate constants in `infra/lib/power-switch-handler/index.js`, and shows paused floor vs awake total (Fargate from the live task definition plus real last-30-day Bedrock spend from Cost Explorer). If AWS rates change, update that price book together with this guide. See [agent-setup.md](./agent-setup.md#pause-and-wake-the-power-switch).
