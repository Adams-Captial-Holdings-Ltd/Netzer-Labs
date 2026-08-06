# Trip or disarm a kill switch

The orchestrator checks 40 kill switches at runtime. Each is a row in the `claudeclaw-kill-switches` DDB table, keyed by a composite primary key — `PK = SWITCH#<name>`, `SK = STATUS`. When `active=true`, the gated code path returns an error message without executing. Use kill switches to disable a misbehaving feature without redeploying.

## Available switches (canonical list)

The authoritative list is `ALL_KILL_SWITCHES` in [`src/lib/state/kill-switches-repo.ts`](../../src/lib/state/kill-switches-repo.ts) (40 entries):

`bedrock_global`, `tool_use`, `tool_dispatch_disabled`, `sessions_frozen`, `cost_cap_per_day`, `guardrail_disabled`, `dashboard_read_disabled`, `audit_log_disabled`, `pii_redaction_enabled`, `exfil_guard_disabled`, `exfil_custom_patterns_disabled`, `telegram_posting`, `slack_posting`, `media_upload_disabled`, `image_gen_disabled`, `tts_disabled`, `email_send_disabled`, `web_search_disabled`, `document_gen_disabled`, `video_processing_disabled`, `chat_kb_ingest_disabled`, `oauth_connect_disabled`, `salesforce_disabled`, `memory_writes`, `memory_ingest_disabled`, `memory_consolidation_disabled`, `memory_context_v2_disabled`, `warroom_disabled`, `warroom_router_disabled`, `warroom_intervention_disabled`, `hooks_disabled`, `skills_disabled`, `extension_deployer_disabled`, `jarvis_disabled`, `jarvis_voice_disabled`, `jarvis_canary_mode`, `chaos_bedrock_throttle_opus`, `chaos_bedrock_throttle_sonnet`, `chaos_bedrock_throttle_haiku`, `chaos_secrets_throttle`.

## Trip a switch

```bash
SWITCH=web_search_disabled
REASON="vendor outage 2026-05-20"

aws dynamodb put-item --table-name claudeclaw-kill-switches \
  --item "{
    \"PK\": {\"S\": \"SWITCH#$SWITCH\"},
    \"SK\": {\"S\": \"STATUS\"},
    \"active\": {\"BOOL\": true},
    \"reason\": {\"S\": \"$REASON\"},
    \"setAt\": {\"S\": \"$(date -u +%FT%TZ)\"},
    \"setBy\": {\"S\": \"runbook:$(whoami)\"}
  }" --no-cli-pager
```

Effect: the gated tool returns `Web search disabled: vendor outage 2026-05-20` to the model on the next call. Reads are cached in-process for ~30s (`CACHE_TTL_MS = 30_000`), so allow up to 30 seconds for the change to take effect.

## Verify it tripped

```bash
TOKEN=$(aws secretsmanager get-secret-value --secret-id /claudeclaw/dashboard \
  --query 'SecretString' --output text --no-cli-pager \
  | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['token'])")
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agentId":"main","chatId":"smoke-ks","text":"web search: weather in Toronto"}' \
  https://claudeclaw-enterprise.com/api/test-turn | jq -r .text
# expect: a message that includes "Web search disabled" or the model's
# acknowledgement that the tool is unavailable
```

## Disarm

```bash
SWITCH=web_search_disabled

aws dynamodb update-item --table-name claudeclaw-kill-switches \
  --key "{\"PK\": {\"S\": \"SWITCH#$SWITCH\"}, \"SK\": {\"S\": \"STATUS\"}}" \
  --update-expression 'SET active = :off, setAt = :ts, setBy = :who' \
  --expression-attribute-values "{
    \":off\": {\"BOOL\": false},
    \":ts\": {\"S\": \"$(date -u +%FT%TZ)\"},
    \":who\": {\"S\": \"runbook:$(whoami)\"}
  }" --no-cli-pager
```

## See the current state of all switches

```bash
aws dynamodb scan --table-name claudeclaw-kill-switches \
  --no-cli-pager --query 'Items[?active.BOOL==`true`].[PK.S,reason.S,setAt.S]' \
  --output table
```

## Emergency: trip everything

Drastic mitigation when the orchestrator is misbehaving and you can't immediately diagnose. `tool_use` gates **all** tool dispatch in a single switch (re-checked before every tool round), so one trip disables every tool at once — no need to enumerate per-tool switches:

```bash
aws dynamodb put-item --table-name claudeclaw-kill-switches \
  --item "{\"PK\":{\"S\":\"SWITCH#tool_use\"},\"SK\":{\"S\":\"STATUS\"},\"active\":{\"BOOL\":true},\"reason\":{\"S\":\"emergency disable\"},\"setAt\":{\"S\":\"$(date -u +%FT%TZ)\"},\"setBy\":{\"S\":\"runbook:$(whoami)\"}}" \
  --no-cli-pager
```

This leaves only the core agent loop running — the model can still reply but every tool is gated off. To also halt all model calls, trip `bedrock_global` the same way.

## Why a DDB-backed switch (and not just a flag in code)

A code flag would require a redeploy to flip. The DDB-backed switch is a hot mitigation lever: ~30s from `put-item` to live (the in-process read cache TTL). Use code flags for permanent configuration; kill switches for circuit breakers.
