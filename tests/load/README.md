# Load tests (F2)

k6-based load tests. One file per scenario.

## Prerequisites

```bash
# macOS
brew install k6

# Linux
sudo apt-get install -y gnupg ca-certificates
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

## test-turn.js — agent-turn load

Three-stage ramp: 1 → 10 → 100 RPS, 5 min per stage, against `/api/test-turn`.
Validates autoscale + cost-cap kill switch + p95 latency under SLO.

**WARNING: do not point at prod with the default RPS curve.** 100 RPS for
5 min ≈ 30,000 turns × ~$0.01/turn ≈ **$300+** in Bedrock spend before
the cost cap kicks in. Use staging, or shorten the high-RPS stage when
smoke-testing prod.

```bash
# Recommended: staging (lower cost cap, isolated tier-1 deploy)
export DASHBOARD_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id /claudeclaw-staging/dashboard \
  --query SecretString --output text \
  | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['token'])")

k6 run \
  -e PUBLIC_HOST=staging.claudeclaw-enterprise.com \
  -e DASHBOARD_TOKEN="$DASHBOARD_TOKEN" \
  tests/load/test-turn.js
```

Or via npm:

```bash
npm run loadtest
```

(reads PUBLIC_HOST + DASHBOARD_TOKEN from your shell env)

## What "success" looks like

- `low` (1 RPS) stage: 100% 2xx, p95 < 5s
- `medium` (10 RPS) stage: ≥98% 2xx, p95 < 5s
- `high` (100 RPS) stage: cost cap trips somewhere mid-stage; subsequent
  requests return 503 with "Daily cost cap exceeded". This is the
  desired behavior — proves the kill switch works
- Fargate scales from baseline to max-tasks during the medium stage and
  stays at max through the high stage; ECS service events show
  `registered N targets`
- No 5xx other than cost-cap 503s
- No ECS task crash-loops

## Reading the summary

The script writes `tests/load/last-run.json` at the end. Key fields:

```jsonc
{
  "stages": [
    { "stage": "low",    "p95_ms": 2100, "avg_ms": 1450, "fail_rate": 0 },
    { "stage": "medium", "p95_ms": 3800, "avg_ms": 1900, "fail_rate": 0.01 },
    { "stage": "high",   "p95_ms": 9200, "avg_ms": 4800, "fail_rate": 0.62 }
  ],
  "costCapped": 18432
}
```

A high `costCapped` count in the `high` stage is expected (and proves the
kill switch is working). High `fail_rate` in `low` or `medium` is a
real problem — investigate the orchestrator logs.
