# Lifecycle runbook — rollback classes & data restore

> Plain English: when a deploy goes bad you don't "roll back", you roll back
> ONE of four things — the container image, the infrastructure, the
> secrets/config, or the data — and each has its own blast radius. The first
> three are one command (`npm run deploy:rollback`). The fourth, data
> restore, is a disruptive, locked, service-at-zero operation documented
> step-by-step below.

Names in this doc are the real prod defaults from `infra/lib/constants.ts`
(`CCE_NAME_SUFFIX` empty). With a suffix, every `claudeclaw-...` name becomes
`claudeclaw-<suffix>-...`, and `CCE` is whatever your `CDK_STACK_NAME` is.

| Thing | Real name |
| --- | --- |
| ECS cluster / service | `claudeclaw-cluster` / `claudeclaw-service` |
| Orchestrator task family | `claudeclaw-orchestrator` |
| EventBridge Scheduler group | `claudeclaw` |
| DDB stack | `CCE-Dynamo` (tables: `claudeclaw-sessions`, `claudeclaw-memories`, `claudeclaw-scheduled-tasks`, ...) |
| State bucket | `claudeclaw-deploy-<account>-<region>` |
| Deploy-lock table | `claudeclaw-deploy-lock` |

Every rollback reads manifests from the state bucket:
`manifests/latest.json` is the live deploy; `deploys/<deployId>/manifest.json`
is a target. `npm run deploy:rollback -- --list` shows recent deploy ids.

All mutating classes take the lifecycle lock (operation `rollback`) with a
heartbeat and journal every step to `deploys/<opId>/journal/`. `--dry-run`
prints the full plan for any class and mutates **nothing** (it doesn't even
acquire the lock). Every class ends the same way: **run `npm run verify`**.

---

## The schema-version safety contract

Each manifest records `appSchemaVersion` — the version of the APPLICATION
schema: DynamoDB item shapes, runtime-config keys, queue/scheduler payload
formats. Migrations are backward-compatible by default, so rolling FORWARD
is always allowed.

Rolling back to a manifest with a **lower** `appSchemaVersion` is refused by
every class, because rolling back code alone can strand the app on item
shapes it can't read (the new code already wrote v2-shaped items; the old
code only parses v1). The override requires BOTH flags together:

```bash
npm run deploy:rollback -- --class=image --to=<deployId> \
  --accept-schema-downgrade \
  --migration-plan="run scripts/migrations/00X-revert.ts before traffic resumes"
```

The `--migration-plan` text is recorded verbatim in the journal, so the
audit trail shows what reversibility story the operator claimed. If you
don't have a reversible migration or a data-restore plan, you don't have a
rollback — you have a second incident.

---

## Class 1: image — "the new code is bad, the infra is fine"

Most common, least blast radius, fastest.

```bash
npm run deploy:rollback -- --class=image --to=previous            # one deploy back
npm run deploy:rollback -- --class=image --to=<deployId>          # explicit target
npm run deploy:rollback -- --class=image --to=previous --dry-run  # plan only
```

What it does (mirrors the proven `buildspec.yml` image-swap flow):

1. **Preflight, before touching anything**: verifies the target manifest's
   `imageDigest` and every `images[]` digest still exist in ECR
   (`DescribeImages` by digest). The ECR lifecycle policy keeps the newest
   50 images — per-deploy tags are the only tags we push, so count-based
   retention IS deploy-tag retention — which means a very old target may be
   pruned. A pruned digest fails HERE, named, not midway through a roll.
2. Clones the LIVE task definition (preserving every other container and all
   env vars — launch flags, voice, cost cap), swaps ONLY the orchestrator
   container image to `<repo>@<digest>` — by **digest**, never a tag.
3. Registers a new task-definition revision, `update-service`, waits for
   `services-stable`.

Then: `npm run verify`.

## Class 2: infra — "a stack change broke us"

```bash
npm run deploy:rollback -- --class=infra --to=<deployId> --dry-run  # ALWAYS look first
npm run deploy:rollback -- --class=infra --to=<deployId>
```

Reproducible from a fresh clone: the tool fetches the target's archived
cloud assembly (`deploys/<id>/cdk.out.zip`, recorded as
`cdkOutArchiveKey`), unzips it, and **always** runs
`npx cdk diff --app <unzipped dir> "CCE-*"` as a preview. `--dry-run` stops
there. Otherwise it runs
`npx cdk deploy --app <dir> --all --require-approval never` — a prebuilt
assembly needs no synth environment, so this works on a machine that has
never built the project.

**Fallback when the archive is missing** (old deploy, pruned object), gated
behind `--rebuild-from-git`: checking out the recorded `gitSha` is YOUR
move — the tool never moves your git tree:

```bash
git checkout <gitSha from the manifest>
npm run deploy:rollback -- --class=infra --to=<deployId> --rebuild-from-git
```

The tool reconstructs the synth env from the manifest's allowlisted
`synthInputs` plus `CCE_IMAGE_DIGEST=<target imageDigest>` and
`CCE_IMAGE_TAG=<target imageTag>`, so the task definition pins the
rolled-back image, and deploys from the current tree. The digest is empty for
a manifest recorded before digests, and that empty value overrides one
exported in the shell. If
`git rev-parse HEAD` doesn't match the recorded sha it WARNS loudly and
proceeds — you asked for a rebuild; the templates may not match the target.

**If a stack lands in `UPDATE_ROLLBACK_FAILED`**, the tool detects it and
prints the documented recovery — it never attempts it automatically:

```bash
aws cloudformation describe-stack-events --stack-name CCE-Compute \
  --query 'StackEvents[?ResourceStatus==`UPDATE_FAILED`]' --no-cli-pager
aws cloudformation continue-update-rollback --stack-name CCE-Compute
# only when a specific resource can never roll back (deleted out-of-band,
# retained-name conflict) — skipping makes reconciling it YOUR job:
aws cloudformation continue-update-rollback --stack-name CCE-Compute \
  --resources-to-skip <LogicalResourceId>
```

Then: `npm run verify`.

## Class 3: config — "a secret rotation / config deploy broke us"

```bash
npm run deploy:rollback -- --class=config --to=<deployId> [--dry-run]
```

Works from any machine with AWS credentials — secret VALUES never pass
through this path, only Secrets Manager version ids recorded in the
manifest (durable because every deploy stamps a per-deploy staging label,
so the versions are never garbage-collected while in the retention window).

1. **Preflight**: `DescribeSecret` confirms every recorded `VersionId` still
   exists. A pruned version fails early, named.
2. For each secret: `UpdateSecretVersionStage` moves `AWSCURRENT` to the
   recorded `VersionId`. The displaced version is journaled so you can
   re-roll-forward.
3. **Only after ALL secrets have moved**: force a new ECS deployment of
   `claudeclaw-service` and wait for stability — secrets are injected at
   task START, so restoring versions alone changes nothing for running
   tasks.

Then: `npm run verify`.

## Class 4: data — restore a DynamoDB table (DISRUPTIVE)

> Plain English: data restore is the only class where the service goes to
> ZERO. Restoring a live table under running tasks and schedulers creates
> split-brain state and replays stale work. Plan for real downtime.

There is no `--class=data` flag on purpose. This is a runbook with typed
confirmations, using `npm run restore:ddb` (see also
`docs/runbooks/restore-from-ddb-export.md` for the inspect-first variant
that restores into a side table).

Worked example below: `claudeclaw-sessions`. The same steps apply to any
table in the `CCE-Dynamo` stack.

### 4.1 Take the lifecycle lock

Data restore is a mutating lifecycle operation like any other. Until a
dedicated maintenance CLI lands, assert the lock manually so no deploy or
rollback interleaves (the item self-expires with the lease; a crashed
operator never wedges the pipeline):

```bash
aws dynamodb put-item --table-name claudeclaw-deploy-lock \
  --item '{"pk":{"S":"deploy-lock"},"owner":{"S":"'"$USER"'@manual-restore"},"operation":{"S":"maintenance"},"expiresAt":{"N":"'"$(($(date +%s%3N) + 3600000))"'"},"acquiredAt":{"S":"'"$(date -u +%FT%TZ)"'"},"fencingToken":{"N":"999999"}}' \
  --condition-expression 'attribute_not_exists(pk) OR expiresAt < :now' \
  --expression-attribute-values '{":now":{"N":"'"$(date +%s%3N)"'"}}' --no-cli-pager
```

If that conditional write fails, someone else holds the lock — stop.

### 4.2 Enter maintenance mode

1. **Service to zero** (webhooks stop answering; that's the point):

   ```bash
   aws ecs update-service --cluster claudeclaw-cluster \
     --service claudeclaw-service --desired-count 0 --no-cli-pager
   aws ecs wait services-stable --cluster claudeclaw-cluster --services claudeclaw-service
   # also confirm no one-shot consolidation-worker tasks are still running:
   aws ecs list-tasks --cluster claudeclaw-cluster --no-cli-pager   # expect []
   ```

2. **Disable runtime EventBridge schedules.** Per-task one-shot schedules
   live in the scheduler group `claudeclaw` (they are app DATA, created at
   runtime by `src/lib/scheduler/eb-scheduler.ts`, not CDK resources):

   ```bash
   aws scheduler list-schedules --group-name claudeclaw \
     --query 'Schedules[].Name' --output text --no-cli-pager
   # disable each (update-schedule requires re-passing the schedule's
   # required fields, so read-modify-write):
   for s in $(aws scheduler list-schedules --group-name claudeclaw --query 'Schedules[].Name' --output text); do
     aws scheduler get-schedule --name "$s" --group-name claudeclaw --no-cli-pager \
       > "/tmp/sched-$s.json"
     aws scheduler update-schedule --name "$s" --group-name claudeclaw --state DISABLED \
       --schedule-expression "$(jq -r .ScheduleExpression /tmp/sched-$s.json)" \
       --flexible-time-window "$(jq -c .FlexibleTimeWindow /tmp/sched-$s.json)" \
       --target "$(jq -c .Target /tmp/sched-$s.json)" --no-cli-pager
   done
   ```

   Keep the `/tmp/sched-*.json` dumps — they are how you re-enable, and how
   you reconcile against the `claudeclaw-scheduled-tasks` table afterwards.

3. **Let the queues drain.** With the service at zero and schedules off, the
   work queues should empty; the consolidation spawner Lambda may still
   drain `claudeclaw-consolidation-work`, so wait for zero before deleting
   any table:

   ```bash
   for q in claudeclaw-scheduled-fire claudeclaw-consolidation-work claudeclaw-ingest; do
     url=$(aws sqs get-queue-url --queue-name $q --query QueueUrl --output text)
     aws sqs get-queue-attributes --queue-url "$url" \
       --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --no-cli-pager
   done
   # inspect the DLQs too; export anything non-empty before proceeding:
   #   claudeclaw-hook-dlq, claudeclaw-consolidation-dlq
   ```

### 4.3 Restore to the ORIGINAL name (the default path)

With zero writers, the restore lands on the canonical name, so **no IAM
grants or task env vars change** — that is exactly why this is the default.

An AWS reality check first: once a table is deleted, PITR can only give you
back the state **at the moment of deletion** (DynamoDB writes a
`$DeletedTableBackup` system backup) — and that snapshot contains the very
corruption you're escaping. So the good state must exist **in S3 before you
delete**, then the import recreates the canonical table from it.

```bash
# 1. Get the good state into S3 BEFORE deleting anything.
#
# Path A — a daily export already covers your restore point (BackupStack
# writes them to ddb-exports/<table>/<date>/ in the logs bucket): nothing
# to do here, note the date.
#
# Path B — you need an arbitrary point in the PITR window (~35 days):
# export that exact point from the still-alive broken table:
aws dynamodb export-table-to-point-in-time \
  --table-arn arn:aws:dynamodb:$AWS_REGION:$AWS_ACCOUNT_ID:table/claudeclaw-sessions \
  --export-time 2026-06-10T08:00:00Z \
  --s3-bucket claudeclaw-logs-$AWS_ACCOUNT_ID-$AWS_REGION \
  --s3-prefix ddb-exports/claudeclaw-sessions/manual-$(date +%Y%m%d) \
  --export-format DYNAMODB_JSON --no-cli-pager
# poll until ExportStatus = COMPLETED:
aws dynamodb list-exports --no-cli-pager

# 2. Delete the broken table (service is at zero; this is the disruptive
#    bit). Deletion itself leaves the $DeletedTableBackup system backup as
#    the forensic net; take an explicit create-backup first if you want a
#    named one.
aws dynamodb delete-table --table-name claudeclaw-sessions --no-cli-pager
aws dynamodb wait table-not-exists --table-name claudeclaw-sessions

# 3. Import the export onto the CANONICAL name.
# Path A (daily export):
npm run restore:ddb -- --table=claudeclaw-sessions \
  --from-date=2026-06-09 --as-table=claudeclaw-sessions
# Path B (manual export): a manual export nests its data under
# .../AWSDynamoDB/<exportId>/data/, so point import-table at that prefix:
aws dynamodb import-table \
  --s3-bucket-source S3Bucket=claudeclaw-logs-$AWS_ACCOUNT_ID-$AWS_REGION,S3KeyPrefix=ddb-exports/claudeclaw-sessions/manual-$(date +%Y%m%d)/AWSDynamoDB/<exportId>/data/ \
  --input-format DYNAMODB_JSON \
  --table-creation-parameters '{"TableName":"claudeclaw-sessions","AttributeDefinitions":[{"AttributeName":"PK","AttributeType":"S"},{"AttributeName":"SK","AttributeType":"S"}],"KeySchema":[{"AttributeName":"PK","KeyType":"HASH"},{"AttributeName":"SK","KeyType":"RANGE"}],"BillingMode":"PAY_PER_REQUEST"}' \
  --no-cli-pager

aws dynamodb wait table-exists --table-name claudeclaw-sessions
```

Note `restore:ddb` was built to restore into a SIDE table for inspection
(see `docs/runbooks/restore-from-ddb-export.md`); when you already know the
restore point — or have inspected a side-table restore first — pointing
`--as-table` at the canonical name with the source deleted is the
original-name path. It asks you to type the table name; that is your last
checkpoint. Tables with non-PK/SK schemas need their real key schema in
`--table-creation-parameters`.

### 4.4 Stream rebinding

A restored table gets a **new DynamoDB Stream ARN**; anything bound to the
old table's stream is pointing at a dead stream after a restore.

**Inventory, as of today (2026-06): this codebase has NO DynamoDB stream
consumers.** A grep of `infra/` and `src/` finds no `StreamSpecification` /
`StreamViewType` on any table, no Lambda event-source mappings on DynamoDB
streams, and no EventBridge Pipes — the SQS-triggered consolidation-spawner
Lambda consumes the `claudeclaw-consolidation-work` SQS queue, not a table
stream. So for the current system this step is a verification no-op, kept
here as future-proofing: **if** a stream consumer is ever added, after a
restore you must (a) list mappings (`aws lambda list-event-source-mappings`
filtered to the old stream ARN), (b) delete/disable them, (c) recreate them
against the new ARN (`aws dynamodb describe-table --table-name ... --query
'Table.LatestStreamArn'`), and (d) verify reads from the new stream before
exiting maintenance.

### 4.5 CloudFormation re-adoption

The restored table now exists OUTSIDE stack ownership: `CCE-Dynamo` still
has a resource with that name in its template, but CloudFormation no longer
manages the live table (the one it created was deleted). Leaving it that
way means the next `cdk deploy` can fail or, worse, replace the table.

Re-adopt it with resource import:

```bash
# Preferred: cdk import maps existing resources into the stack interactively.
npx cdk import CCE-Dynamo
# (Alternative: CloudFormation console → CCE-Dynamo → Stack actions →
#  Import resources into stack, with a template containing the table.)
```

Then validate the live table matches what the template declares — restores
do NOT carry all of this automatically:

- **GSIs** — `aws dynamodb describe-table` vs the template's
  `GlobalSecondaryIndexes` (PITR/import recreate them only if asked).
- **TTL** — `aws dynamodb describe-time-to-live --table-name ...`; restores
  come back with TTL **disabled**. Re-enable to match the template.
- **PITR** — `aws dynamodb describe-continuous-backups`; restored tables
  come back with PITR **disabled**. Re-enable:
  `aws dynamodb update-continuous-backups --table-name claudeclaw-sessions
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true`.
- **KMS key** — the restore must use the same CMK the template declares
  (`alias/claudeclaw-data`); check `SSEDescription.KMSMasterKeyArn`.
- **Tags** — `aws dynamodb list-tags-of-resource`; re-apply
  `Application=claudeclaw-enterprise`, `ManagedBy=cdk`.
- **Alarms** — CloudWatch alarms reference the table by NAME, so
  original-name restores keep them valid; confirm they left `INSUFFICIENT_DATA`
  after traffic resumes.

Finish with `npx cdk diff CCE-Dynamo` and expect **no changes** for the
table. A clean diff is the proof re-adoption worked.

### 4.6 Exit maintenance and verify

```bash
# re-enable the schedules you disabled (same read-modify-write, state ENABLED)
# then scale back up:
aws ecs update-service --cluster claudeclaw-cluster \
  --service claudeclaw-service --desired-count 2 --no-cli-pager   # tier 1 default
aws ecs wait services-stable --cluster claudeclaw-cluster --services claudeclaw-service

# release the lifecycle lock you took in 4.1:
aws dynamodb delete-item --table-name claudeclaw-deploy-lock \
  --key '{"pk":{"S":"deploy-lock"}}' --no-cli-pager
```

Then, as always: **`npm run verify`**.

### ADVANCED: new-name cutover (avoid unless forced)

Restoring to a NEW name (e.g. `claudeclaw-sessions-restore-20260611`) and
cutting the app over is genuinely a multi-system rewiring, which is why
original-name restore is the default. If you must (e.g. the canonical name
is wedged in a stuck deletion), ALL of the following move together:

1. **Task env vars** — the task definition's `TABLE_SESSIONS` (and any
   other reference) must point at the new name; register a new revision and
   roll the service. The honest way is changing the name CDK renders
   (constants/env) and deploying `CCE-Compute`, otherwise the next deploy
   reverts your hand-edit.
2. **IAM grants** — task-role DynamoDB policies are scoped to table ARNs;
   the new name needs grants (table AND its indexes) or every read/write
   throws `AccessDeniedException` at runtime.
3. **Stream/consumer rewiring** — none exist today (see 4.4), but any
   future event-source mapping must be recreated against the new table's
   stream ARN.
4. **CFN ownership** — the old logical resource still exists in
   `CCE-Dynamo`; the new table is unmanaged. Reconcile (import the new,
   remove/retain the old) or the stack and reality drift permanently.
5. **No-writer verification on the OLD table** — before deleting it, prove
   nothing still writes there: CloudWatch `ConsumedWriteCapacityUnits` flat
   at zero for a full traffic cycle, and (belt-and-suspenders) CloudTrail
   data events if enabled. A missed writer means silent split-brain — the
   exact failure original-name restore exists to prevent.

---

## After ANY rollback

```bash
npm run verify
```

Verify is the gate, not the rollback's own exit code: a rollback that
"completed" onto a broken target is still an incident. If verify fails,
roll FORWARD (fix and `npm run deploy`) rather than stacking rollbacks.
