# Telegram bot stopped replying

## Symptom

You message the bot in Telegram and get nothing back. No "delivered" tick issue (Telegram doesn't show that for bots), the bot just sits.

## Decision tree

### 1. Is the orchestrator alive?

```bash
curl -fsS https://claudeclaw-enterprise.com/health
```

200 → continue. Else see `rollback-bad-image.md`.

### 2. Is the webhook still set to point at us?

```bash
BOT_TOKEN=$(aws secretsmanager get-secret-value --secret-id /claudeclaw/telegram \
  --query 'SecretString' --output text --no-cli-pager \
  | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); t=json.loads(d['tokens']); print(t['main'])")

curl -fsS "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo" | jq .
```

Look at:
- `url` → should be `https://claudeclaw-enterprise.com/tg/main/webhook`
- `last_error_message` → if non-empty, that's the immediate cause
- `pending_update_count` → if growing, Telegram is queuing because we're not 200-ing

If `url` is wrong or empty, re-set it:

```bash
curl -fsS -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{
    \"url\": \"https://claudeclaw-enterprise.com/tg/main/webhook\",
    \"secret_token\": \"$(aws secretsmanager get-secret-value --secret-id /claudeclaw/telegram --query 'SecretString' --output text --no-cli-pager | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['webhook_secret'])")\",
    \"allowed_updates\": [\"message\",\"callback_query\",\"my_chat_member\"]
  }"
```

### 3. Did the webhook reach us?

```bash
aws logs filter-log-events --log-group-name /claudeclaw/orchestrator \
  --start-time $(($(date +%s) - 600))000 \
  --filter-pattern '{ $.msg = "telegram message received" }' \
  --no-cli-pager --query 'events[-5:].message' --output text
```

If empty, Telegram isn't reaching us. Look at `getWebhookInfo.last_error_message` (step 2). Common values:

- `Wrong response from the webhook: 401 Unauthorized` → `TELEGRAM_WEBHOOK_SECRET` mismatch. Re-set the webhook with the secret currently in Secrets Manager.
- `Connection timed out` → ALB or CloudFront not reachable from Telegram's IPs. Verify `curl https://claudeclaw-enterprise.com/tg/main/webhook` returns *something* (404 is fine for GET; the route only accepts POST).

### 4. Voice / media path stuck?

If text replies work but voice doesn't:

```bash
aws logs filter-log-events --log-group-name /claudeclaw/orchestrator \
  --start-time $(($(date +%s) - 600))000 \
  --filter-pattern '{ $.msg = "tts reply failed*" || $.msg = "transcribe failed*" }' \
  --no-cli-pager --query 'events[-5:].message' --output text
```

The text-only reply should still be there. If TTS keeps failing, trip `tts_disabled` to stop trying (`kill-switches.md`).

### 5. Specific chat ID muted (Telegram "block bot")

If the user blocked the bot in Telegram, every send returns `Forbidden: bot was blocked by the user`. Logs:

```bash
aws logs filter-log-events --log-group-name /claudeclaw/orchestrator \
  --start-time $(($(date +%s) - 86400))000 \
  --filter-pattern 'bot was blocked' --max-items 5 \
  --no-cli-pager --query 'events[*].message' --output text
```

The user has to unblock the bot from their phone; there's nothing the operator can do.

### 6. Multiple bots / wrong token

`TELEGRAM_TOKENS_JSON` maps `agentId → bot token`. If you added a second agent and reused the old token by mistake, both agents reply from the same bot account → user sees one of them silently dropping.

Verify the mapping:

```bash
aws secretsmanager get-secret-value --secret-id /claudeclaw/telegram \
  --query 'SecretString' --output text --no-cli-pager \
  | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); t=json.loads(d['tokens']); print({k: v[:10] + '...' for k,v in t.items()})"
```

Each token prefix should be unique. If two agents map to the same prefix, fix `TELEGRAM_TOKENS_JSON` and redeploy.

## Why Telegram is forgiving

Telegram queues updates for up to 24 hours and replays them when your webhook starts 200-ing again. If you fix the root cause within a day, queued messages flow through naturally. No retry-storm risk; Telegram retries with backoff.
