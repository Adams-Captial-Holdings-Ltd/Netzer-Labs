# Rotate the dashboard bearer token

## Symptom

- Token leaked (committed to a public repo, screenshotted, etc.)
- Quarterly rotation reminder
- A team member left and you want to invalidate prior access

## Verify current token works

```bash
TOKEN=$(aws secretsmanager get-secret-value --secret-id /claudeclaw/dashboard \
  --query 'SecretString' --output text --no-cli-pager \
  | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['token'])")
curl -fsS -H "Authorization: Bearer $TOKEN" https://claudeclaw-enterprise.com/api/tier
# expect: 200 with tier JSON
```

## Fix

```bash
# 1. Generate a new token
NEW=$(openssl rand -hex 32)

# 2. Read the existing JSON (preserves pin_hash + kill_phrase)
EXISTING=$(aws secretsmanager get-secret-value --secret-id /claudeclaw/dashboard \
  --query 'SecretString' --output text --no-cli-pager)

# 3. Rewrite the token field only
UPDATED=$(echo "$EXISTING" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); d['token']='$NEW'; print(json.dumps(d))")

# 4. Put the new value
aws secretsmanager put-secret-value --secret-id /claudeclaw/dashboard \
  --secret-string "$UPDATED" --no-cli-pager > /dev/null

# 5. Restart Fargate so the orchestrator picks up the new value
aws ecs update-service --cluster claudeclaw-cluster --service claudeclaw-service \
  --force-new-deployment --no-cli-pager > /dev/null
aws ecs wait services-stable --cluster claudeclaw-cluster --services claudeclaw-service

# 6. Save the new token to .env (so future deploys keep it)
sed -i.bak "s/^DASHBOARD_TOKEN=.*/DASHBOARD_TOKEN=$NEW/" .env && rm .env.bak

echo "New token (paste into Mission Control + any client): $NEW"
```

## Verify after

```bash
# Old token rejected
curl -sS -o /dev/null -w "old: HTTP %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" https://claudeclaw-enterprise.com/api/tier
# expect: 401

# New token accepted
curl -sS -o /dev/null -w "new: HTTP %{http_code}\n" \
  -H "Authorization: Bearer $NEW" https://claudeclaw-enterprise.com/api/tier
# expect: 200
```

## Rollback

If the new token doesn't work (e.g. the JSON rewrite mangled the secret value), restore the previous version:

```bash
aws secretsmanager get-secret-value --secret-id /claudeclaw/dashboard \
  --version-stage AWSPREVIOUS --query 'SecretString' --output text --no-cli-pager \
  | tee /tmp/dashboard-previous.json
# inspect /tmp/dashboard-previous.json; if it looks right:
aws secretsmanager put-secret-value --secret-id /claudeclaw/dashboard \
  --secret-string "$(cat /tmp/dashboard-previous.json)" --no-cli-pager
aws ecs update-service --cluster claudeclaw-cluster --service claudeclaw-service \
  --force-new-deployment
```

## Why this is not automated yet

A rotation Lambda (B5) is in the v4 backlog as a stretch goal. Until then, manual rotation through this runbook is the workflow. Frequency expectation: quarterly under normal ops, immediately on suspected leak.
