# Pre-scale Fargate for a traffic burst

## When you need this

- You're about to demo the bot to a group; expect 50+ concurrent users
- You're shipping a launch and traffic might spike before autoscale catches up
- The WAF rate-limit (2000 req / 5min per IP) is about to bite

Default T3 sizing: 3 min tasks, 20 max tasks. Autoscaling responds within ~3 min to CPU pressure. Pre-scaling makes the first burst feel as smooth as steady-state.

## Verify current state

```bash
aws ecs describe-services --cluster claudeclaw-cluster --services claudeclaw-service \
  --no-cli-pager --query 'services[0].{desired:desiredCount, running:runningCount, pending:pendingCount}'
```

## Fix — temporary scale up

```bash
# Bump desired count. Pick something like 10 for a single-stream demo,
# 20 for a full launch.
NEW_DESIRED=10
aws ecs update-service --cluster claudeclaw-cluster --service claudeclaw-service \
  --desired-count "$NEW_DESIRED" --no-cli-pager > /dev/null

# Watch new tasks come up
aws ecs wait services-stable --cluster claudeclaw-cluster --services claudeclaw-service
aws ecs describe-services --cluster claudeclaw-cluster --services claudeclaw-service \
  --no-cli-pager --query 'services[0].{desired:desiredCount, running:runningCount}'
```

Note: the service runs under Application Auto Scaling (T3 floor is 3 tasks). Bumping only `--desired-count` can be scaled back down when CPU drops; for a sustained pre-scale, also raise the floor:

```bash
aws application-autoscaling register-scalable-target --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/claudeclaw-cluster/claudeclaw-service --min-capacity 10
# lower --min-capacity back to 3 after the burst
```

Cost while the bump is in effect: each task is ~$0.08/hour for 2 vCPU / 4 GB (ARM64/Graviton: 2 × $0.03238 + 4 × $0.003556 ≈ $0.079/hr). Bumping from 3 → 10 (7 more tasks) adds ~$0.55/hour.

## Permanent change

Edit `infra/lib/constants.ts`:

```ts
3: {
  // ...
  fargateMinTasks: 5,   // was 3
  fargateMaxTasks: 30,  // was 20
}
```

Deploy:

```bash
npm run deploy -- --yes
```

## WAF rate limit

The regional WAF caps each IP at 2000 requests per 5 minutes. For a demo where one office IP serves 50 users, that's 40 requests per user per 5-minute window (~8 req/min per user) before the cap bites — usually fine. If your demo is "users all share a corporate proxy", consider relaxing the limit:

Edit `infra/lib/security-stack.ts`, find the rate-limit rule (`limit: 2000`), bump to `limit: 20000`. Deploy `CCE-Security`. Lower again after the demo.

## Restore default after the burst

```bash
aws ecs update-service --cluster claudeclaw-cluster --service claudeclaw-service \
  --desired-count 3 --no-cli-pager
```

This drops to 3 tasks (matches T3 `fargateMinTasks`); autoscaler will scale back up if real demand sustains.

## Monitor during the burst

(The `date` calls below use GNU `date -d`; on macOS use `date -u -v-30M +%FT%TZ`.)

```bash
# CPU + memory utilization per task
aws cloudwatch get-metric-statistics --namespace AWS/ECS \
  --metric-name CPUUtilization \
  --dimensions Name=ClusterName,Value=claudeclaw-cluster Name=ServiceName,Value=claudeclaw-service \
  --start-time $(date -u -d '30 minutes ago' +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 60 --statistics Average,Maximum --no-cli-pager \
  --query 'Datapoints[*].[Timestamp,Average,Maximum]' --output table

# Bedrock throttles (the most likely upstream bottleneck)
aws cloudwatch get-metric-statistics --namespace AWS/Bedrock \
  --metric-name InvocationThrottles \
  --start-time $(date -u -d '30 minutes ago' +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 60 --statistics Sum --no-cli-pager \
  --query 'Datapoints[*].[Timestamp,Sum]' --output table
```

If Bedrock throttles spike, the orchestrator retries transiently throttled calls (default 3 attempts, then the Opus→Sonnet→Haiku fallback chain, in `src/lib/bedrock/client.ts`); brief throttles are absorbed with added latency, but sustained throttling across all fallback models still surfaces errors. If throttles sustain for 5+ minutes, raise the per-model quota: in the **Service Quotas** console open Amazon Bedrock and search for the relevant per-model quota (e.g. "On-demand InvokeModel requests per minute for `<model>`") — request an increase if it's adjustable, or submit a support request if it's marked non-adjustable.
