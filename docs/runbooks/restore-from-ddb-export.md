# Restore a DynamoDB table from S3 export

## When you need this

- A scheduled task ran amok and wiped/corrupted a table
- A migration script wrote the wrong values to a table
- You need to inspect a table's state from a specific day in the past

Two restore paths are available: the DynamoDB **PITR** path (continuous backups via `RestoreTableToPointInTime`, ~35-day window, no S3 export needed) and the **S3-export** path (from the daily DDB → S3 exports, for restoring a specific daily snapshot).

## Verify export exists

```bash
# S3-export path: list exports of the target table (from the daily DDB → S3 exports)
aws s3 ls "s3://claudeclaw-logs-${AWS_ACCOUNT_ID}-us-east-1/ddb-exports/claudeclaw-sessions/"

# PITR path: PITR is enabled on all tables; check the window
aws dynamodb describe-continuous-backups --table-name claudeclaw-sessions \
  --no-cli-pager --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription'
# expect: PointInTimeRecoveryStatus = ENABLED. EarliestRestorableDateTime is the
#         later of (35 days ago) or (when PITR was first enabled) — so it is only
#         ~35 days back once PITR has been enabled continuously for 35+ days
```

## Fix (PITR path, available today)

```bash
# Restore the target state into a NEW table — never overwrite live.
SOURCE_TABLE=claudeclaw-sessions
RESTORE_TABLE=claudeclaw-sessions-restore-$(date +%Y%m%d)
RESTORE_TIME=2026-05-20T08:00:00Z  # ISO 8601 UTC

aws dynamodb restore-table-to-point-in-time \
  --source-table-name "$SOURCE_TABLE" \
  --target-table-name "$RESTORE_TABLE" \
  --restore-date-time "$RESTORE_TIME" \
  --no-cli-pager

# Wait until ACTIVE. Note: the table-exists waiter polls 20s x 25 = ~8m20s max,
# then exits non-zero ("Waiter TableExists failed: Max attempts exceeded"); a
# large restore can exceed that — just re-run the waiter (or poll describe-table).
aws dynamodb wait table-exists --table-name "$RESTORE_TABLE"
```

## Fix (S3-export path)

```bash
SOURCE_TABLE=claudeclaw-sessions
EXPORT_DATE=2026-05-19
RESTORE_TABLE=claudeclaw-sessions-restore-$(date +%Y%m%d)

# npm script that wraps the import-table API (flags use --key=value form)
npm run restore:ddb -- --table="$SOURCE_TABLE" \
  --from-date="$EXPORT_DATE" \
  --as-table="$RESTORE_TABLE"
```

## Inspect the restored data

```bash
# Sample 10 rows
aws dynamodb scan --table-name "$RESTORE_TABLE" --max-items 10 --no-cli-pager

# Count rows
aws dynamodb scan --table-name "$RESTORE_TABLE" --select COUNT --no-cli-pager
```

## Promote the restored table back

Only do this if you've confirmed the restored data is what you want, AND you've taken a fresh point-in-time of the current (corrupted) live table for forensics.

```bash
# 1. Take a forensic snapshot of the corrupted live table
LIVE_BACKUP="claudeclaw-sessions-pre-restore-$(date +%Y%m%d-%H%M%S)"
aws dynamodb create-backup --table-name "$SOURCE_TABLE" \
  --backup-name "$LIVE_BACKUP" --no-cli-pager

# 2. Stop writes to live (trip the relevant kill switch, e.g.
#    sessions_frozen — see kill-switches.md). Most orchestrator
#    operations gracefully degrade when their kill switch is active.

# 3. Application-level swap: there's no single AWS command that
#    "renames" a DDB table. The pragmatic option is to update the
#    TABLE_SESSIONS env var in the task def to point at the restored
#    table, then redeploy. To do this without code change, override
#    the env var via `aws ecs update-service` with a new task def
#    that has the restored table name.
#
#    Easier: open `infra/lib/constants.ts`, set
#    RESOURCE_NAMES.ddb.sessions to the restored name, deploy compute
#    stack, untrip the kill switch.
#
#    IMPORTANT: a restored table does NOT inherit TTL, PITR, auto-scaling,
#    tags, stream settings, deletion protection, or CloudWatch alarms from
#    the source. Re-enable at least TTL and PITR on the restored table before
#    it goes live (aws dynamodb update-time-to-live / update-continuous-backups).

# 4. After 24h of clean operation, delete the corrupted table:
aws dynamodb delete-table --table-name "$SOURCE_TABLE"
```

## Why we restore into a NEW table

Restoring over a live table is irreversible if the restore itself is wrong (wrong target time, wrong source). The "promote" step gives you a checkpoint to verify before the destructive change happens.

## Rollback

If the swap goes wrong: change `RESOURCE_NAMES.ddb.sessions` back to the original name, redeploy, untrip kill switch. The forensic snapshot from step 1 above remains intact regardless.
