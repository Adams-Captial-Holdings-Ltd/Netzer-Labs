# Roll back a bad deploy

## Symptom

You just shipped (CI or local) and something is broken:

- `/health` is 503 / connection refused
- ECS service has tasks in `PROVISIONING` → `STOPPED` loop
- New tasks crash with `exec format error` (the ARM64 class of bug)
- New tasks start cleanly but turns fail (the empty-env class of bug)

## Verify the deploy is the cause

```bash
aws ecs describe-services --cluster claudeclaw-cluster --services claudeclaw-service \
  --no-cli-pager --query 'services[0].events[0:5].[createdAt,message]' --output text
```

If you see "begin draining" + "stopped N pending tasks" within the last 10 min, the deploy is in flight. If you see "circuit breaker triggered", CFN already auto-rolled the compute stack — proceed to "Auto-rollback already happened".

## Fix path 1 — `npm run deploy:rollback`

The cleanest path. Clones the live ECS task definition, swaps only the orchestrator container's image to the previous one **by immutable digest**, registers a new task-definition revision, then rolls the service and waits for stability. It does not touch the ECR `:latest` tag. Recovery ~60s. The `--class` flag is required (bare `npm run deploy:rollback` prints a usage error and does nothing):

```bash
npm run deploy:rollback -- --class=image --to=previous
```

## Fix path 2 — manual task-definition rollback

When the rollback script is unavailable or didn't help. Task definitions pin an **immutable per-deploy image tag**, never `:latest`, so retagging `:latest` and forcing a new deployment rolls nothing back — the task def still references the same pinned tag. Instead, roll the service to the previous task-definition revision, which already points at the previous good image:

```bash
# 1. List recent ACTIVE revisions; the second-newest is usually the last good deploy
aws ecs list-task-definitions --family-prefix claudeclaw-orchestrator \
  --status ACTIVE --sort DESC --no-cli-pager --max-items 5

# 2. Roll the service to the previous good revision
aws ecs update-service --cluster claudeclaw-cluster --service claudeclaw-service \
  --task-definition claudeclaw-orchestrator:<previous-revision> \
  --force-new-deployment --no-cli-pager > /dev/null
aws ecs wait services-stable --cluster claudeclaw-cluster --services claudeclaw-service
```

To roll to a specific older image instead, register a new revision pointing at that image's immutable tag — `npm run deploy:rollback -- --class=image --to=<deployId>` does exactly that for you.

## Fix path 3 — auto-rollback already happened

If you see `circuit breaker triggered` events: ECS already rolled the service back to the previous task definition. The bad `:latest` image is still in ECR, but running tasks have the cached previous image. Two follow-ups:

```bash
# (a) Rebuild and redeploy the last known-good commit so new task launches
#     (autoscale event, spot replacement, future deploy) get a good image.
#     This pushes a NEW immutable per-deploy tag and points the task def at
#     it — there is no floating :latest to re-push.
git checkout <last-good-sha>
npm run deploy -- --image-only --yes
git checkout main

# (b) Investigate the original failure offline — see "Why this happened" below.
```

## After recovery — verify fully

Run `deploy-validation.md` to confirm not just liveness but actual function.

## Why these bugs slip past CI

Both ARM64 mismatch and empty-Bedrock-env are class of bugs where the orchestrator BOOTS cleanly (`/health` 200) but DOESN'T FUNCTION (turns fail). The CI smoke test only checks liveness. Mitigations:

1. `deploy-validation.md` step 4 (test turn) catches both classes
2. Pre-flight: `npx cdk synth CCE-Compute | grep BEDROCK_` after every deploy to see if env vars are populated
3. Long-term (F1 stretch): integration tests with a real ECS task spin up against LocalStack before CI accepts the build

## What NOT to do

- Don't `git revert` and re-deploy — that ships a NEW image with revert-bytes, which is slower than retagging an existing known-good image
- Don't `git reset --hard` — destructive; loses any unmerged work
- Don't bypass the kill switch by `force-new-deployment` without first identifying the bad image; you'll just roll the broken image again
