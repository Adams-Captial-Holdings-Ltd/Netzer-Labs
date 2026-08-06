# Chaos testing (F3)

One pre-defined AWS FIS experiment that validates ClaudeClaw degrades gracefully under task loss. **Operator-initiated** — the CDK stack ships the template, the operator decides when to fire it.

> Cost: ~$0.10 per action-minute. The kill-task experiment is sub-minute; one run costs pennies.

> Blast radius: scoped by ECS cluster + service tags to the orchestrator. Other workloads on the account are unaffected.

## Why only one experiment

The original F3 plan included three experiments: kill Fargate task, throttle Bedrock, throttle SecretsManager. The latter two were dropped because the FIS `aws:fis:inject-api-throttle-error` action only supports a short list of AWS API namespaces in its `service` parameter (per the AWS FIS actions reference, `ec2` and `kinesis`). Neither `bedrock-runtime` nor `secretsmanager` is supported; CloudFormation returns `"The service parameter value is not supported for the action"` on stack create.

To simulate Bedrock throttling or SecretsManager throttling, the right shape is an application-level fault injector inside the Bedrock client wrapper and the secret-fetch helper (e.g., a kill switch like `chaos_bedrock_throttle` that returns synthetic ThrottlingException for a configurable window). Tracked as a follow-up; not in scope for the initial F3 ship.

## Prerequisites

- Tier 2 or 3 deploy (the template is not provisioned at T0/T1)
- AWS CLI with `fis:StartExperiment`, `fis:StopExperiment`, `fis:GetExperiment`, `cloudformation:DescribeStacks`, `ecs:Describe*`, `ecs:UpdateService`, and `elasticloadbalancing:Describe*` on the account (this runbook's discover, abort, and rollback steps use all of these)
- A second terminal `tail`ing orchestrator logs: `aws logs tail /claudeclaw/orchestrator --follow --region us-east-1`

## Discover the template ID

```bash
KILL_TASK_ID=$(aws cloudformation describe-stacks --stack-name CCE-Chaos --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='KillTaskTemplateId'].OutputValue" --output text)
echo "$KILL_TASK_ID"
```

## Run: kill one Fargate task

**Hypothesis**: surviving tasks absorb traffic, ECS replaces the stopped task within ~60s, ALB health stays green throughout.

```bash
aws fis start-experiment \
  --experiment-template-id "$KILL_TASK_ID" \
  --region us-east-1
```

**Watch**:

- `aws ecs describe-services --cluster claudeclaw-cluster --services claudeclaw-service --query 'services[0].deployments'` — should show one new task launching while the others stay `RUNNING`
- ALB target group health: `aws elbv2 describe-target-health --target-group-arn $(aws elbv2 describe-target-groups --names claudeclaw-tg --query 'TargetGroups[0].TargetGroupArn' --output text)` — at most one target goes `draining` then a new one comes online `healthy`
- Hit `/health` from outside: should stay 200 throughout

**Pass criteria**: zero 5xx at the ALB during the experiment.

## Aborting

```bash
EXPERIMENT_ID=<id returned by start-experiment>
aws fis stop-experiment --id "$EXPERIMENT_ID" --region us-east-1
```

The kill-task experiment self-terminates as soon as ECS confirms task replacement; aborting only matters if you want to halt before the task is back.

## If the hypothesis fails

5xx during the replacement window usually means:

- `minHealthyPercent` is below 100 on the ECS service (it should be 100; check `compute-stack.ts`)
- ALB `deregistration_delay` is too long for ECS's grace period
- The new task is failing its container health check immediately on boot

First check ECS service events: `aws ecs describe-services --cluster claudeclaw-cluster --services claudeclaw-service --query 'services[0].events[:10]'`.

## Rollback

This experiment doesn't mutate anything permanently — it just stops a task. If something goes sideways:

1. `aws fis stop-experiment --id <id>` halts immediately
2. If ECS gets stuck replacing: `aws ecs update-service --cluster claudeclaw-cluster --service claudeclaw-service --force-new-deployment`

## When to run

- After any change to `infra/lib/compute-stack.ts` (ECS service shape, deregistration timing, capacity provider)
- Quarterly as part of SOC 2 prep
- Never run concurrently with a deploy — both rotate tasks
