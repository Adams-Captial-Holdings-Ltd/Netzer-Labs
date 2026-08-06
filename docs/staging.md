# Staging Environment

Parallel deployment of every CDK stack with prefix `CCE-STAGING` and `CCE_TIER=1`, reachable at `staging.claudeclaw-enterprise.com`. Same AWS account, separate resources, separate surface tokens, lower cost cap.

## Why a staging environment

- Test infra changes (new stacks, new IAM grants, new tier features) without touching prod.
- Verify the deploy pipeline before promoting to prod.
- Reproduce bugs without contaminating prod data.

## One-time setup (before the first deploy)

You only do this once per account. Everything below is **prerequisites you have to provide manually** — the deploy script can't create Slack/Telegram apps on your behalf.

### 1. Create a staging Slack app

1. Go to https://api.slack.com/apps → "Create New App" → "From an app manifest"
2. Pick the same workspace as prod
3. Paste the manifest from the prod app, but rename the bot user to "ClaudeClaw Staging" (or similar)
4. Set the event subscription request URL to `https://staging.claudeclaw-enterprise.com/slack/events` (Slack will reject it for now — that's expected; we'll come back after the first deploy)
5. Capture: `SLACK_BOT_TOKEN` (xoxb-...), `SLACK_SIGNING_SECRET`, optional `SLACK_APP_TOKEN` (xapp-...)

### 2. Create a staging Telegram bot

1. DM `@BotFather` on Telegram → `/newbot`
2. Pick a name + username (e.g. `claudeclaw_staging_bot`)
3. BotFather returns a token; capture it
4. The webhook URL we'll set later is `https://staging.claudeclaw-enterprise.com/tg/main/webhook`

### 3. Generate fresh secrets

Never reuse prod's dashboard token, security PIN, or encryption key in staging:

```bash
# Dashboard token (64 hex chars)
openssl rand -hex 32

# App encryption key (64 hex chars = 32 bytes — required for AES-256)
openssl rand -hex 32

# Security PIN hash — the app expects a SALTED value, salt:sha256(salt+pin);
# a bare `shasum -a 256` will NOT verify. The setup wizard generates it
# (scripts/lib/crypto.ts hashPin()); to reproduce it by hand:
SALT=$(openssl rand -hex 8)
printf '%s:%s\n' "$SALT" "$(printf '%s' "${SALT}123456" | shasum -a 256 | awk '{print $1}')"
```

### 4. Write `.env.staging`

Copy `.env.staging.example` → `.env.staging` and fill in:

- Bedrock model IDs (safe to reuse prod's account-level inference profile IDs)
- The Slack and Telegram tokens from steps 1 & 2
- The freshly generated dashboard / encryption / PIN values
- Leave `CCE_DAILY_COST_CAP_USD=10` — staging shouldn't burn money

The file is gitignored, so it stays on your machine.

## First bootstrap deploy

```bash
npm run deploy -- --env=staging
```

Confirm at the "money gate" prompt. This will:

1. Run pre-checks against the staging env
2. Bootstrap CDK toolkit for the account+region (idempotent if prod already bootstrapped)
3. Build the orchestrator image, tag it `claudeclaw-staging-orchestrator:<sha>`, push to the staging ECR repo
4. Deploy the `CCE-STAGING-*` stacks: the 14 always-on stacks (Network, Storage, Guardrails, Secrets, Dynamo, Messaging, Iam, Compute, Observability, Security, Backup, Chaos, Extensions, CostGuardrails), plus the isolated PowerSwitch stack and the conditional CodeBuild / DemoReset stacks when their env flags are set
5. Populate the staging Secrets Manager entries from `.env.staging`
6. Auto-issue an ACM cert via Route 53 DNS validation for `staging.claudeclaw-enterprise.com`
7. Add the A-record for the staging subdomain pointing at the staging ALB
8. Poll `/health` until 200

Expected time: ~15 min for the first deploy (cert issuance is the slow step).

## Post-bootstrap manual steps

### 1. Set the staging Slack event URL

Now that the staging ALB has HTTPS, go back to `api.slack.com/apps`, paste `https://staging.claudeclaw-enterprise.com/slack/events` as the event subscription request URL. Slack should verify it (we respond to the URL verification challenge automatically).

### 2. Set the staging Telegram webhook

The deploy script offers to do this for you if `TELEGRAM_TOKENS_JSON` is set in `.env.staging`. Otherwise:

```bash
curl -X POST "https://api.telegram.org/bot<STAGING_BOT_TOKEN>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\": \"https://staging.claudeclaw-enterprise.com/tg/main/webhook\", \"secret_token\": \"<STAGING_TELEGRAM_WEBHOOK_SECRET>\", \"allowed_updates\": [\"message\", \"callback_query\", \"my_chat_member\"]}"
```

### 3. Verify staging

```bash
curl https://staging.claudeclaw-enterprise.com/health
# expect: {"status":"ok", ...}

curl -H "Authorization: Bearer <STAGING_DASHBOARD_TOKEN>" https://staging.claudeclaw-enterprise.com/api/tier
# expect: {"tier":1,"label":"Standard", ...}
```

Then DM the staging Slack bot and the staging Telegram bot to confirm both surfaces work end-to-end.

## CI deploys to staging

The `Deploy` GitHub workflow takes optional inputs:

```bash
# manual dispatch via CLI
gh workflow run deploy.yml -f confirm=deploy -f tier=1 -f env=staging
```

(or pick `env=staging` in the Actions UI's "Run workflow" form). A GitHub Actions OIDC token carries exactly one `sub` claim, so the deploy role's trust policy lists the allowed subjects as separate `StringEquals` entries — the deploy refs (`repo:<org>/<repo>:ref:refs/heads/main` and `...:ref:refs/heads/staging`, from `CCE_GITHUB_DEPLOY_REFS`) and any configured deploy environments (`CCE_GITHUB_DEPLOY_ENVIRONMENTS`) — matched with OR semantics, not a ref-and-environment conjunction. A job is trusted when its single subject equals any one listed entry, so a `main`/`production` job can deploy prod and a `staging` job can deploy staging.

## Cost

A staging T1 deployment adds approximately (rates as of 2026-07):

| Resource | Monthly |
|---|---|
| 2x Fargate tasks (1 vCPU, 2GB, ARM64) | ~$60 |
| ALB (low traffic) | ~$20 |
| NAT Gateway (2 AZ) | ~$65 |
| VPC interface endpoints (PrivateLink) | $0 by default, opt-in via `CCE_PRIVATE_ENDPOINTS=1`, then ~$175 (12 endpoints × 2 AZ × $0.01/AZ-hr) |
| DDB on-demand, S3, KMS, Logs (idle) | ~$5–10 |
| **Total fixed** | **~$150** (interface endpoints off; add ~$175 if enabled) |

Plus Bedrock token spend if you actively use staging. The `CCE_DAILY_COST_CAP_USD=10` kill switch trips before runaway spend.

## Teardown

If you ever need to delete the staging environment:

```bash
# Reverse-order delete (compute before storage, etc.). CDK handles
# dependency order if you use `cdk destroy CCE-STAGING-* --force`.
cd /path/to/claudeclaw-enterprise   # your local repo root
CCE_TIER=1 CDK_STACK_NAME=CCE-STAGING DOMAIN_NAME=staging.claudeclaw-enterprise.com \
  npx cdk destroy "CCE-STAGING-*" --force
```

Retain-policy DDB tables and S3 buckets will survive the destroy and require manual deletion if you want a clean slate.
