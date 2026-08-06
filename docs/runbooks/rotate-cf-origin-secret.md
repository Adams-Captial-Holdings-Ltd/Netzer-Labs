# Rotate the X-CloudFront-Origin secret

The CloudFront origin sends `X-CloudFront-Origin: <secret>`. At T3 the HTTPS listener forwards a request that carries that secret (priority-1 rule), and also forwards Cloudflare-proxied traffic matched by Host header — the apex or `origin.<apex>`, no secret required (priority-2 rule); everything else gets a 403. Both sides compute the secret from `infra/lib/cf-origin-secret.ts`. To rotate it you change what both sides compute.

## When to rotate

- The current value leaked (visible in a log, posted somewhere)
- Quarterly hygiene rotation
- After offboarding someone who had access to the AWS account

## Approach

Two-phase deploy to avoid downtime. Same approach used when B1 first shipped.

```
T = 0    : update CloudFront origin to send the NEW secret. ALB still
           forwards everything because the listener rule still matches
           the OLD value (anyone hitting via CF works; gate is wide).
T = 0    : start CF edge propagation timer (~5–15 min)
T = 15m  : update the ALB listener rules for the NEW secret. The listener
           keeps three actions (priority-1 secret-header forward, priority-2
           Host-header forward for Cloudflare, default 403). After the flip,
           only the NEW secret matches priority-1; a direct ALB hit carrying
           the OLD secret (with a non-matching Host) 403s.
```

Reversing the order would 403 every CloudFront request for the duration of CF propagation.

## Fix

### Option A — explicit override (recommended for emergencies)

```bash
# Pick a new value
NEW_SECRET=$(openssl rand -hex 16)
export CCE_CF_ORIGIN_SECRET="$NEW_SECRET"

# Your deploy context (values from .env)
export AWS_ACCOUNT_ID=<your-aws-account-id>
export DOMAIN_NAME=<your-domain>

# Phase 1 — update CloudFront origin
CCE_TIER=3 DOMAIN_NAME="$DOMAIN_NAME" \
  CDK_DEFAULT_ACCOUNT="$AWS_ACCOUNT_ID" CDK_DEFAULT_REGION=us-east-1 \
  npx cdk deploy CCE-Security --require-approval never

# No blind wait needed: the Phase-1 `cdk deploy CCE-Security` above does not
# return until CloudFormation reports the CloudFront distribution as "Deployed"
# (fully propagated). If you deployed out of band, confirm with:
#   aws cloudfront get-distribution --id <id> --query 'Distribution.Status'
#   # expect: Deployed

# Phase 2 — flip the ALB gate
CCE_TIER=3 DOMAIN_NAME="$DOMAIN_NAME" \
  CDK_DEFAULT_ACCOUNT="$AWS_ACCOUNT_ID" CDK_DEFAULT_REGION=us-east-1 \
  npx cdk deploy CCE-Compute --require-approval never

# Pin the override into .env so subsequent deploys don't regress
echo "CCE_CF_ORIGIN_SECRET=$NEW_SECRET" >> .env

echo "Rotated to: $NEW_SECRET"
```

### Option B — bump the deterministic version tag

Edit `infra/lib/cf-origin-secret.ts`:

```ts
const VERSION_TAG = 'v2';  // was 'v1'
```

Then do the same two-phase deploy (without the env var override). The hash function recomputes from the new tag.

This is the cleaner long-term path because it doesn't require keeping the secret in `.env`; the secret is purely a function of `(account, region, tag)` and lives in code.

## Verify

```bash
echo "=== Through CloudFront (should 200) ==="
curl -sS -o /dev/null -w "%{http_code}\n" https://claudeclaw-enterprise.com/health

echo "=== Direct ALB with new header (should 200) ==="
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "X-CloudFront-Origin: $NEW_SECRET" \
  https://origin.claudeclaw-enterprise.com/health

echo "=== Direct to origin host, no header (returns 200, not 403) ==="
# origin.<apex> matches the priority-2 host-header allow rule (for Cloudflare-
# proxied traffic), so it is forwarded WITHOUT the secret — this returns 200.
# A 403 only happens for a request whose Host is neither the apex nor
# origin.<apex> AND that lacks the secret (e.g. hitting the raw ALB DNS name).
curl -sS -o /dev/null -w "%{http_code}\n" https://origin.claudeclaw-enterprise.com/health

aws elbv2 describe-target-health \
  --target-group-arn "$(aws elbv2 describe-target-groups --names claudeclaw-tg --query 'TargetGroups[0].TargetGroupArn' --output text)" \
  --no-cli-pager --query 'TargetHealthDescriptions[*].TargetHealth.State' --output text
# expect: healthy healthy healthy
```

## Rollback

If Phase 2 broke something:

```bash
# Restore the previous ALB listener default + delete the new rule via
# the AWS console, or temporarily switch the default to forward:
LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn "$(aws elbv2 describe-load-balancers --names claudeclaw-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text)" \
  --query 'Listeners[?Port==`443`].ListenerArn' --output text)
TG_ARN=$(aws elbv2 describe-target-groups --names claudeclaw-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 modify-listener --listener-arn "$LISTENER_ARN" \
  --default-actions Type=forward,TargetGroupArn="$TG_ARN"
```

Then investigate Phase 2 with the gate disarmed. Re-arm via `cdk deploy CCE-Compute`.
