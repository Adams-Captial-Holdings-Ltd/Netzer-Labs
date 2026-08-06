# CloudFront cutover (T3)

CloudFront ships at deploy tier 3. The distribution provisions in
parallel with the ALB; live traffic stays on the ALB until you flip the
apex Route 53 record. This document is the runbook for that flip.

## What deploys at T3

Running `npm run deploy` with `CCE_TIER=3` (or `DEPLOY_TIER=3`)
provisions:

- ACM cert in us-east-1 covering the apex (e.g. `claudeclaw-enterprise.com`)
  AND `origin.claudeclaw-enterprise.com`
- Route 53 A alias `origin.<apex>` → ALB (provisioned by compute-stack)
- CloudFront distribution with the ALB as custom origin via
  `origin.<apex>`, HTTP/2 + HTTP/3, TLS 1.2_2021 minimum, PriceClass 100
- Three cache behaviors:
  - `/dashboard` → cached via the CachingOptimized managed policy (its
    AWS-managed default TTL is 1 day, not 1 hour; min 1s, max 1 year)
  - `/dashboard/*` → same CachingOptimized policy
  - everything else → never cache, forward all viewer headers (so
    Authorization passes through cleanly, webhooks work, SSE works)
- Origin custom header `X-CloudFront-Origin: <secret>` on every origin
  request, paired with an ALB listener rule that 403s anything missing
  the right header value (B1; see "ALB origin gate" below). The secret
  is the SHA256 of `<account>-<region>-cf-origin-v1` truncated to 32
  hex chars, or `$CCE_CF_ORIGIN_SECRET` if set. Both stacks compute the
  same value from `infra/lib/cf-origin-secret.ts`.
- CloudFront access logs to the logs bucket

The apex Route 53 record **stays pointing at the ALB** after deploy. No
DNS surprise.

## CFN outputs you need

After `cdk deploy` finishes, `cdk-outputs.json` has:

```json
{
  "CCE-Security": {
    "CloudFrontDomain": "dXXXXXX.cloudfront.net",
    "CloudFrontDistId": "EXXXXXXXX",
    "CloudFrontOriginHost": "origin.claudeclaw-enterprise.com"
  }
}
```

## Cutover

1. **Smoke test CloudFront in parallel.** Add a temporary
   `cloudfront-test.<apex>` CNAME pointing at the CloudFront domain
   from CFN outputs, then hit it:

   ```bash
   curl -I https://cloudfront-test.claudeclaw-enterprise.com/health
   curl -I https://cloudfront-test.claudeclaw-enterprise.com/dashboard
   curl -sS -H "Authorization: Bearer $TOKEN" \
     https://cloudfront-test.claudeclaw-enterprise.com/api/agents | jq .
   ```

   All three should respond as they do against the apex today. The
   /dashboard response should arrive with `X-Cache: Hit from cloudfront`
   on the second hit.

2. **Flip the apex.** In Route 53, change the apex A alias from
   `dualstack.claudeclaw-alb-XXX.us-east-1.elb.amazonaws.com.` to
   `dXXXXXX.cloudfront.net.` (use the CloudFront domain from outputs).
   Save. DNS propagation is usually < 60 seconds inside AWS resolvers,
   up to ~5 min externally.

3. **Watch for fallout.** Tail the orchestrator log and the CloudFront
   distribution metrics:

   ```bash
   aws cloudwatch get-metric-statistics --namespace AWS/CloudFront \
     --metric-name Requests --dimensions Name=DistributionId,Value=EXXXXXXXX Name=Region,Value=Global \
     --statistics Sum --period 60 --start-time "$(date -u -v-15M +%FT%TZ 2>/dev/null || date -u -d '15 minutes ago' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)"
   ```

   The Telegram webhook, Slack events endpoint, and dashboard SPA should
   all keep working.

## Rollback

In Route 53, change the apex A alias back to the ALB. Same one-record
edit. DNS propagation completes in < 5 min.

## ALB origin gate (B1)

At T3, the HTTPS listener's default action is `fixed-response 403
"origin only"`. A higher-priority listener rule forwards requests
carrying the matching `X-CloudFront-Origin` secret header to the
target group. CloudFront sends this header on every origin request.

Result:
- `https://<apex>/...` (via CloudFront) → 200 (CF injects the header)
- `https://origin.<apex>/...` (direct ALB) without the header → 403
- `https://origin.<apex>/...` with the right header (operator debug) → 200
- ALB target-group health checks bypass listener rules and stay green

The secret value is computed identically by both stacks via
`infra/lib/cf-origin-secret.ts` — `SHA256(account-region-cf-origin-v1)`
truncated to 32 hex chars, or `$CCE_CF_ORIGIN_SECRET` if set.

### Rotating the secret

Two-phase deploy:

1. Set `CCE_CF_ORIGIN_SECRET=<new value>` (or bump `VERSION_TAG` in
   `cf-origin-secret.ts`) and `npx cdk deploy CCE-Security`.
2. Wait 10–15 min for global CloudFront edge propagation.
3. `npx cdk deploy CCE-Compute`.

Skipping the wait risks a window where the ALB requires the new value
but CloudFront still sends the old one — all CloudFront traffic 403s
until propagation catches up.

### Disabling the gate (emergency)

If something goes wrong and you need direct ALB access ASAP:

```bash
# Strip the listener rule + restore default forward action by hand.
# This is the listener ARN; find it in CCE-Compute outputs.
LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn "$(aws elbv2 describe-load-balancers --names claudeclaw-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text)" \
  --query 'Listeners[?Port==`443`].ListenerArn' --output text)
TG_ARN=$(aws elbv2 describe-target-groups --names claudeclaw-tg --query 'TargetGroups[0].TargetGroupArn' --output text)

aws elbv2 modify-listener --listener-arn "$LISTENER_ARN" \
  --default-actions Type=forward,TargetGroupArn="$TG_ARN"
```

CDK drift detection will flag this on the next deploy; revert via cdk
deploy when the root cause is fixed.

## Costs

At PriceClass 100 (NA + Europe), CloudFront pricing for our traffic
profile (low GBs, mostly HTML + JSON), rates as of 2026-07:

- First 1 TB/month data transfer out and the first 10M HTTP/HTTPS
  requests/month are FREE (CloudFront's perpetual always-free tier)
- Beyond the free tier, data transfer out is $0.085/GB for the next ~10 TB
  (US / Canada / Europe)
- HTTP requests $0.0075 / 10k, HTTPS requests $0.01 / 10k (after the free 10M)

Realistic bill at current ~few-MB-per-day, few-requests-per-day traffic: the
CloudFront data-transfer and request charges are essentially $0, because the
workload stays entirely within the free 1 TB / 10M-request monthly tier. The
only real cost is the CloudFront access-log storage in the logs bucket
(pennies, and covered by that bucket's existing Glacier transition).

## Things this DOES NOT do

- Does not leave the edge without a WAF. The T3 deploy already provisions a
  `CLOUDFRONT`-scope WebACL (`${APP}-cf-web-acl`, in `security-stack.ts`) in
  us-east-1 and attaches it to the distribution via `webAclId` — a rate-limit
  rule (2000/IP) plus AWS managed rule groups — in addition to the `REGIONAL`
  WebACL on the ALB. There is no separate edge-WAF step to run here.
- Does not automatically retarget the apex. Intentional — see "Cutover"
  above.
- Does not change the agent loop's behavior. SSE, multipart uploads,
  webhook signature verification, and bearer auth all work identically
  whether the viewer hit the ALB or CloudFront.
