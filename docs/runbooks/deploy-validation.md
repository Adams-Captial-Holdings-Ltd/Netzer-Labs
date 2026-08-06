# Deploy validation

`/health` returning 200 is not enough. Several real bugs have shipped past a green CI run because the smoke test only checked liveness, not function.

## Symptom

Run finished green; something is still broken downstream.

## Verify (run after every deploy)

```bash
# 1. /health — process is up
curl -fsS https://claudeclaw-enterprise.com/health
# expect: {"status":"ok", ...}

# 2. /ready — all configured surfaces report ready
curl -sS https://claudeclaw-enterprise.com/ready
# expect: {"status":"ready", ...}. /ready returns HTTP 503 (not 200) when not
#         ready, so drop curl's -f (it fails and discards the body on 5xx); the
#         surface booleans (bedrock/slack/telegram) tell you which one is false

# 3. Task def has the expected env vars (catches the Bedrock regression
#    where empty model IDs ship to production)
aws ecs describe-task-definition --task-definition claudeclaw-orchestrator \
  --no-cli-pager --query 'taskDefinition.containerDefinitions[0].environment[?starts_with(name, `BEDROCK`)]'
# expect every BEDROCK_*_MODEL to have a non-empty value

# 4. Drive a real turn — proves Bedrock + Guardrails + tool dispatch work
TOKEN=$(aws secretsmanager get-secret-value --secret-id /claudeclaw/dashboard \
  --query 'SecretString' --output text --no-cli-pager \
  | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['token'])")
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agentId":"main","chatId":"smoke","text":"what time is it? use the get_time tool."}' \
  https://claudeclaw-enterprise.com/api/test-turn | jq '{text, toolCallCount, costUsd}'
# expect: a real reply, toolCallCount >= 1, costUsd > 0
```

If any of the four fail, stop, run the relevant runbook.

## Why this exists

The CI workflow only runs step 1 today. Future work (D4 follow-up): extend `deploy.yml`'s smoke step to also call `/ready` and to validate the task def has non-empty model IDs before declaring success. The full test-turn requires the dashboard secret and is best done from an operator's terminal.

## Specific bugs this would have caught

- **2026-05-20**: B3+D2 CI deploy shipped a task def with empty `BEDROCK_*_MODEL` because the workflow didn't forward `.env` model IDs. `/health` was 200; `/api/test-turn` returned `"No Bedrock model configured"`. Caught manually ~25 min after the deploy. Fixed by adding `BEDROCK_MODELS` fallback in `compute-stack.ts`.
- **2026-05-20**: A2 first end-to-end CI deploy shipped an x86_64 image because `ubuntu-latest` is amd64 and the Fargate task runs ARM64. `/health` was unreachable; ECS circuit breaker auto-rolled-back. Fixed by adding `docker/setup-qemu-action` + `--platform linux/arm64` to the workflow.
