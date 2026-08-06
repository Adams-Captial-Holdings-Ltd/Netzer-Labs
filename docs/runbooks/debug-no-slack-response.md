# Slack bot stopped replying

## Symptom

You DM the bot in Slack and get nothing back. The Slack message shows it was delivered (no red exclamation), but the bot is silent.

## Decision tree

### 1. Is the orchestrator alive?

```bash
curl -fsS https://claudeclaw-enterprise.com/health
# expect: 200
```

- 200 → orchestrator is up, problem is downstream of liveness. Continue to step 2.
- non-200 → see `rollback-bad-image.md` and check ECS service health.

### 2. Did the Slack webhook reach us?

Slack-side: open `api.slack.com/apps`, click the app, "Event Subscriptions". The "Request URL" should show "Verified ✓". If "Failed", re-enter it as `https://claudeclaw-enterprise.com/slack/events`.

Logs-side:

```bash
aws logs filter-log-events --log-group-name /claudeclaw/orchestrator \
  --start-time $(($(date +%s) - 600))000 \
  --filter-pattern 'slack' \
  --no-cli-pager --query 'events[-5:].message' --output text
```

- See `slack event received` entries → webhook is arriving. Skip to step 4.
- No entries → Slack isn't reaching us. Continue to step 3.

### 3. WAF or rate limit blocking?

```bash
aws wafv2 get-sampled-requests --web-acl-arn \
  "$(aws cloudformation describe-stacks --stack-name CCE-Security \
       --query "Stacks[0].Outputs[?OutputKey=='WebAclArn'].OutputValue" --output text)" \
  --rule-metric-name rate-limit --scope REGIONAL \
  --time-window "StartTime=$(date -u -v-15M +%s 2>/dev/null || date -u -d '15 minutes ago' +%s),EndTime=$(date -u +%s)" \
  --max-items 5 --no-cli-pager
```

If you see Slack IPs in there, your WAF is blocking them. Edit `infra/lib/security-stack.ts` to allowlist Slack's IP ranges (publish.slack.com/api-ip-ranges), redeploy.

### 4. Signing-secret mismatch?

Look for a 401 in the orchestrator logs:

```bash
aws logs filter-log-events --log-group-name /claudeclaw/orchestrator \
  --start-time $(($(date +%s) - 600))000 \
  --filter-pattern '{ $.msg = "slack signature rejected" }' \
  --no-cli-pager --query 'events[-5:].message' --output text
```

If matches, the signing secret in Secrets Manager is out of sync with Slack's. Rotate via the Slack "Basic Information" page → "Show" signing secret, then:

```bash
EXISTING=$(aws secretsmanager get-secret-value --secret-id /claudeclaw/slack \
  --query 'SecretString' --output text --no-cli-pager)
UPDATED=$(echo "$EXISTING" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); d['signing_secret']='<new value>'; print(json.dumps(d))")
aws secretsmanager put-secret-value --secret-id /claudeclaw/slack \
  --secret-string "$UPDATED" --no-cli-pager
aws ecs update-service --cluster claudeclaw-cluster --service claudeclaw-service \
  --force-new-deployment
```

### 5. Bot token revoked?

```bash
aws secretsmanager get-secret-value --secret-id /claudeclaw/slack \
  --query 'SecretString' --output text --no-cli-pager \
  | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d['bot_token'][:12])"
# expect: starts with `xoxb-`
```

If the token starts with `xoxb-` but Slack API rejects it, re-install the app in your workspace (`api.slack.com/apps` → Install App). The bot token rotates on reinstall — paste the new value into the secret with the same JSON pattern as step 4.

### 6. Kill switch active?

```bash
aws dynamodb scan --table-name claudeclaw-kill-switches \
  --no-cli-pager --query 'Items[?active.BOOL==`true`].PK.S' --output table
```

If `audit_log_disabled` or `memory_ingest_disabled` is active, the agent loop may have crashed before sending a reply. Disarm via `kill-switches.md`.

### 7. Agent crashed silently

```bash
aws logs filter-log-events --log-group-name /claudeclaw/orchestrator \
  --start-time $(($(date +%s) - 600))000 \
  --filter-pattern '{ $.level >= 50 }' \
  --no-cli-pager --query 'events[-5:].[timestamp,message]' --output text
```

Error-and-above entries (`$.level >= 50`; in pino, level 50 = `error`, 60 = `fatal`) point at the failing component. Common culprits:

- `Throttling` from Bedrock → temporary; will recover when token bucket refills
- `Bedrock model not found` → see `deploy-validation.md`, the task def is shipping an empty `BEDROCK_*_MODEL`
- `Guardrail blocked` → the user input tripped the guardrail; the model never replies. Check audit log

## Why Slack is special

Slack retries 3 times on 5xx within 3 minutes. After that it gives up silently. Telegram is more forgiving (~24h retention). If you fixed the issue but Slack still seems dead, send a fresh message — the retries are gone but new events flow.
