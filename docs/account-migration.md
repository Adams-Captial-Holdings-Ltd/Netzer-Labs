# Account-to-account migration

> Plain English: this is the runbook for moving a whole install from one
> AWS account to another, the org-change handover, which is a different
> event from handing the same install to a new operator. The hard parts
> are encryption and ownership, because KMS keys never leave an account
> and a naive "sync the buckets" strands data that the new account cannot
> decrypt or does not own. The sequence below stages everything into the
> new account under the new account's keys and ownership, deploys the
> same version fresh, imports the data, and only tears the old account
> down after a validation gate passes.

Distinct from OPERATOR handover (`npm run handover`, the same account
with a new human): this runbook changes the ACCOUNT ID, so every KMS
key, IAM trust, and resource ARN changes with it.

Throughout, `111111111111` is the OLD account, `222222222222` is the NEW
account, and `us-east-1` is the region. Real resource names come from
[../infra/lib/constants.ts](../infra/lib/constants.ts) (prod defaults,
no `CCE_NAME_SUFFIX`).

## What moves, what is re-created, what stays behind

> **Do not assume a bucket is disposable because its name says "staging".**
> Until 2026-08 the durable vector index lived in `claudeclaw-vectors-staging-*`,
> and this table told operators to abandon it because "vectors re-derive from
> curated". No such re-derivation exists anywhere in this codebase, and acting on
> that line destroys the knowledge base. Verify what a bucket actually holds
> before classifying it — see
> [knowledge durability](features/knowledge-durability/README.md).

| Thing | Treatment |
| --- | --- |
| DynamoDB tables (`claudeclaw-sessions`, `claudeclaw-memories`, `claudeclaw-runtime-config`, ... the full `claudeclaw-*` set) | Exported to S3, imported via `ImportTable` (new-table-only, see step 6) |
| S3 `claudeclaw-config-*`, `claudeclaw-raw-*`, `claudeclaw-curated-*` | Staged copy into the new account, re-encrypted under new CMKs |
| S3 `claudeclaw-vectors-*` | **MUST be migrated.** This is the durable vector index and the ONLY copy of ingested knowledge — nothing re-derives it. Staged copy into the new account, re-encrypted under new CMKs, exactly like `curated` |
| S3 `claudeclaw-vectors-staging-*` | NOT migrated: genuinely ephemeral (browser upload scratch under `uploads/`, deleted once indexed, 7-day expiry) |
| ECR images (`claudeclaw-orchestrator`) | Registry-copied by digest, or re-imported from upstream when eligible (step 3) |
| Secrets (`/claudeclaw/slack`, `/claudeclaw/telegram`, `/claudeclaw/dashboard`, `/claudeclaw/db-encryption`, `/claudeclaw/bedrock-guardrails`, `/claudeclaw/vendor-keys`) | RE-ENTERED BY HAND in the new account, never plaintext-exported |
| EventBridge schedules (group `claudeclaw`) | REHYDRATED from the `claudeclaw-scheduled-tasks` table (derived state, step 7) |
| KMS keys (`alias/claudeclaw-data`, `alias/claudeclaw-curated`, `alias/claudeclaw-logs`) | DO NOT MIGRATE. New keys are created by the fresh deploy; data is re-encrypted under them |
| WORM audit history (`claudeclaw-audit-lock-*`, Object Lock, T2+) | DOES NOT MIGRATE: intentional residual in the old account until retention lapses |
| CloudWatch logs/metrics/alarm history, `claudeclaw-logs-*` contents | DO NOT MIGRATE (history stays queryable in the old account until teardown) |
| GitHub OIDC trust, CodeBuild source credential | DO NOT MIGRATE: re-established against the new account ID (the OIDC trust `sub` and the imported PAT are account-scoped) |

## 0. Pre-work in the NEW account: staging bucket + roles

Create the transfer staging bucket IN THE NEW ACCOUNT with Object
Ownership ENFORCED. With `BucketOwnerEnforced`, ACLs are disabled and
every object written by the old account's role is owned by the new
account automatically, so there are no orphaned old-account-owned
objects and no `bucket-owner-full-control` ACL dance:

```bash
# in the NEW account
aws s3api create-bucket --bucket cce-migration-staging-222222222222-us-east-1 \
  --region us-east-1
aws s3api put-bucket-ownership-controls \
  --bucket cce-migration-staging-222222222222-us-east-1 \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
aws s3api put-public-access-block \
  --bucket cce-migration-staging-222222222222-us-east-1 \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Two migration roles, one per direction:

- `arn:aws:iam::111111111111:role/cce-migration-copy` (OLD account):
  reads the old buckets, writes into the staging bucket.
- `arn:aws:iam::222222222222:role/cce-migration-restore` (NEW account):
  reads the staging bucket and the old account's DDB export objects,
  writes into the new account's canonical buckets/tables.

Staging bucket policy granting the old account's copy role write access
(plus list, for multipart verification):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OldAccountCopyRoleWrite",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111111111111:role/cce-migration-copy" },
      "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::cce-migration-staging-222222222222-us-east-1/*"
    },
    {
      "Sid": "OldAccountCopyRoleList",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111111111111:role/cce-migration-copy" },
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::cce-migration-staging-222222222222-us-east-1"
    }
  ]
}
```

### The KMS plan, split BY DIRECTION

The two halves of the transfer need OPPOSITE grants, and mixing them up
is the classic way migrations strand data:

- **Source-decrypt**: the NEW account's restore role must decrypt
  objects/exports encrypted under the OLD account's CMKs. Grants are
  created in the OLD account, on the OLD keys, for the NEW account's
  role.
- **Destination-encrypt**: the OLD account's copy role must encrypt what
  it writes into the staging bucket under the NEW account's CMKs (the
  staging bucket should default-encrypt with the new data key). Grants
  are created in the NEW account, on the NEW keys, for the OLD account's
  role.

Per key alias (run `describe-key` because grants take key IDs, not
aliases; aliases are per-account so the same alias names exist on both
sides after the fresh deploy):

```bash
# OLD account: source-decrypt on the old CMKs for the new restore role
for alias in alias/claudeclaw-data alias/claudeclaw-curated; do
  key=$(aws kms describe-key --key-id "$alias" --query KeyMetadata.KeyId --output text)
  aws kms create-grant --key-id "$key" \
    --grantee-principal arn:aws:iam::222222222222:role/cce-migration-restore \
    --operations Decrypt DescribeKey \
    --name "cce-migration-source-decrypt-${alias##*/}"
done
# alias/claudeclaw-logs encrypts CloudWatch/SNS in place; log history does
# not migrate, so it needs no source grant.
```

```bash
# NEW account: destination-encrypt on the new CMKs for the old copy role
for alias in alias/claudeclaw-data alias/claudeclaw-curated; do
  key=$(aws kms describe-key --key-id "$alias" --query KeyMetadata.KeyId --output text)
  aws kms create-grant --key-id "$key" \
    --grantee-principal arn:aws:iam::111111111111:role/cce-migration-copy \
    --operations Encrypt GenerateDataKey DescribeKey \
    --name "cce-migration-dest-encrypt-${alias##*/}"
done
```

(The new-account aliases exist only AFTER step 4's fresh deploy; create
the destination-encrypt grants then, or default-encrypt the staging
bucket with a temporary new-account key and re-encrypt on restore.)

Restore RE-ENCRYPTS everything under the NEW account's keys: S3 copies
out of staging land in buckets whose default encryption is the new
`alias/claudeclaw-data` / `alias/claudeclaw-curated`, and `ImportTable`
creates tables encrypted with the new data key. Nothing in the new
account remains readable only via an old-account CMK, which is what lets
you eventually revoke every grant and close the old account.

### Object-version semantics, per bucket (the AWS reality)

S3 `CopyObject` MINTS NEW VERSION IDS at the destination. Version IDs
can never be "preserved" across accounts, full stop. So the inventory
question is whether anything references a version ID:

| Bucket | Versioned at source? | Treatment |
| --- | --- | --- |
| `claudeclaw-config-*` | yes | latest-only copy; noncurrent versions are a non-migrated residual |
| `claudeclaw-curated-*` | yes | latest-only copy; noncurrent versions are a non-migrated residual |
| `claudeclaw-raw-*` | no | straight copy |
| `claudeclaw-vectors-*` | yes | **must be migrated** — sole copy of the knowledge index |
| `claudeclaw-vectors-staging-*` | no | not migrated (upload scratch only) |
| `claudeclaw-audit-lock-*` | yes + Object Lock | not migrated (WORM residual, retention holds it in place anyway) |
| `claudeclaw-logs-*` | no | not migrated (history residual) |

**Inventory result for this codebase (checked 2026-06-11):** a grep of
`src/` finds NO S3 read that passes a `VersionId` for application data
(the `VersionId` references in the tree are IAM policy-version metadata in
`src/lib/posture/iam-reader.ts` and `src/lib/aws/iam-copilot.ts`, plus an S3
`VersionId` in `src/lambdas/ttl-tripwire.ts` that only lists and deletes
object versions during teardown, never reads app data by version). The app
references S3 KEYS, not versions, so this is the expected case: buckets copy
LATEST-ONLY, version history is declared a non-migrated residual, and no
old-to-new version-ID remap is needed. If a future change ever stores an
S3 version ID in DDB or runtime-config, this runbook's copy step must
grow the remap-and-rewrite pass described in the readiness plan
(item 48) before validation.

Either way, the application-level check stands: after restore, confirm
no live reference points at anything that did not migrate. Concretely:
run `npm run verify`, exercise knowledge retrieval and a branding-asset
fetch in the new account, and spot-check that S3 keys referenced from
DDB rows (knowledge documents, agent prompts under `agents/<id>/`)
resolve without `NoSuchKey`.

## The sequence

### 1. Old account into maintenance mode

Follow [lifecycle.md](lifecycle.md) section 4.2 exactly: acquire the
lifecycle lock, scale `claudeclaw-service` on `claudeclaw-cluster` to
zero, disable the EventBridge schedules in group `claudeclaw`, and let
the queues drain to EMPTY (`claudeclaw-scheduled-fire`,
`claudeclaw-consolidation-work`, `claudeclaw-ingest`), letting in-flight
and delayed work settle. Inspect the DLQs (`claudeclaw-hook-dlq`,
`claudeclaw-consolidation-dlq`) and EXPORT any non-empty DLQ to the
staging bucket before proceeding; a message stranded in a deleted
account is gone.

### 2. DDB exports + S3 staged copy

> `export-table-to-point-in-time` requires point-in-time recovery (continuous
> backups) enabled on each source table and works only within its PITR window.
> The CDK enables PITR on the `claudeclaw-*` tables (`infra/lib/dynamo-stack.ts`),
> but confirm it is on before exporting — the call errors
> `Point in time recovery has not yet been enabled` otherwise.

```bash
# OLD account, per canonical table (PITR export, repeat for every claudeclaw-* table):
aws dynamodb export-table-to-point-in-time \
  --table-arn arn:aws:dynamodb:us-east-1:111111111111:table/claudeclaw-sessions \
  --s3-bucket cce-migration-staging-222222222222-us-east-1 \
  --s3-prefix ddb-exports/claudeclaw-sessions \
  --export-format DYNAMODB_JSON --no-cli-pager
# poll list-exports until every ExportStatus = COMPLETED

# OLD account, S3 staged copy (latest-only by construction; sync reads current versions):
aws s3 sync s3://claudeclaw-config-111111111111-us-east-1 \
  s3://cce-migration-staging-222222222222-us-east-1/s3/config/
aws s3 sync s3://claudeclaw-raw-111111111111-us-east-1 \
  s3://cce-migration-staging-222222222222-us-east-1/s3/raw/
aws s3 sync s3://claudeclaw-curated-111111111111-us-east-1 \
  s3://cce-migration-staging-222222222222-us-east-1/s3/curated/
# The vector index. This is the ONLY copy of ingested knowledge and nothing
# re-derives it, so skipping this line loses the customer's knowledge base.
# `vectors-staging` is deliberately NOT synced: it is upload scratch.
aws s3 sync s3://claudeclaw-vectors-111111111111-us-east-1 \
  s3://cce-migration-staging-222222222222-us-east-1/s3/vectors/
```

Record object counts per prefix now; they feed the validation gate.

### 3. ECR images, registry-copied with digest verification

Every digest referenced by the deploy manifest (the `images[]` records
in `manifests/latest.json` in the old state bucket) must exist in the
new account's `claudeclaw-orchestrator` repo, or the same-version deploy
in step 4 is impossible.

- **In-window upstream release, unmodified tree**: you MAY re-import
  from the upstream public gallery instead (the item 41 verified-import
  path), since the signed digest is the same bytes.
- **Forked / `--build-local` installs and out-of-window versions**: MUST
  registry-copy from the old account; upstream has no image matching
  your code.

Use a registry-native, manifest-preserving copy (crane/skopeo), never
docker pull/tag/push, and verify the digest survived:

```bash
SRC=111111111111.dkr.ecr.us-east-1.amazonaws.com/claudeclaw-orchestrator
DST=222222222222.dkr.ecr.us-east-1.amazonaws.com/claudeclaw-orchestrator
DIGEST=sha256:<from the manifest images[] record>
crane copy "$SRC@$DIGEST" "$DST:migrated-$(date +%Y%m%d)"
# digest verification: the copy is only done when this equals $DIGEST
crane digest "$DST:migrated-$(date +%Y%m%d)"
```

### 4. Fresh quickstart deploy at the SAME version

In the NEW account, clone the repo, check out the EXACT version the old
account was running (`gitSha` / `imageTag` from the old manifest), run
`npm run setup` then `npm run deploy`. Same version is non-negotiable: a
version skew here would entangle a migration with an upgrade, and the
app schema (`appSchemaVersion` in the manifest) must match the data you
are about to import. This creates the new account's KMS keys, buckets,
tables, queues, cluster, and state bucket under the new account ID.

### 5. Secrets re-entered by hand

Populate `/claudeclaw/slack`, `/claudeclaw/telegram`,
`/claudeclaw/dashboard`, `/claudeclaw/db-encryption`,
`/claudeclaw/bedrock-guardrails`, and `/claudeclaw/vendor-keys` in the
new account from your password manager / the issuing vendors. Never
export secret values from the old account in plaintext. Note
`db-encryption` specifically: the APP_ENCRYPTION_KEY must be the SAME
value as the old account's, or imported rows that hold app-encrypted
fields become unreadable.

### 6. DDB data lands: ImportTable is NEW-TABLE-ONLY

`ImportTable` cannot import into an existing table, including the ones
step 4 just created. So, with the NEW account's service at zero
(`aws ecs update-service ... --desired-count 0`), for EACH canonical
table:

1. Delete the quickstart-created (empty) table:
   `aws dynamodb delete-table --table-name claudeclaw-sessions` and wait
   `table-not-exists`.
2. Re-create it via `ImportTable` from the exported `data/` prefix
   (DynamoDB nests exports under `AWSDynamoDB/<exportId>/data/`):

   ```bash
   aws dynamodb import-table \
     --s3-bucket-source S3Bucket=cce-migration-staging-222222222222-us-east-1,S3KeyPrefix=ddb-exports/claudeclaw-sessions/AWSDynamoDB/<exportId>/data/ \
     --input-format DYNAMODB_JSON \
     --input-compression-type GZIP \
     --table-creation-parameters '{"TableName":"claudeclaw-sessions","AttributeDefinitions":[{"AttributeName":"PK","AttributeType":"S"},{"AttributeName":"SK","AttributeType":"S"}],"KeySchema":[{"AttributeName":"PK","KeyType":"HASH"},{"AttributeName":"SK","KeyType":"RANGE"}],"BillingMode":"PAY_PER_REQUEST","SSESpecification":{"Enabled":true,"SSEType":"KMS","KMSMasterKeyId":"alias/claudeclaw-data"}}' \
     --no-cli-pager
   ```

   Tables with non-PK/SK schemas or GSIs need their real schema in
   `--table-creation-parameters`; take it from
   [../infra/lib/dynamo-stack.ts](../infra/lib/dynamo-stack.ts).
3. CFN RE-ADOPT the table into the new account's `CCE-Dynamo` stack per
   [lifecycle.md](lifecycle.md) section 4.5 (`npx cdk import CCE-Dynamo`,
   then re-enable TTL and PITR, verify GSIs/tags/KMS, and finish with a
   clean `cdk diff`).
4. Streams rebound: per lifecycle.md section 4.4 this codebase currently
   has NO DynamoDB stream consumers, so this is a verification no-op;
   if one has been added since, rebind its event-source mapping to the
   new stream ARN here.

### 7. EventBridge schedules REHYDRATED from the table

Runtime schedules are DERIVED state: the canonical record is the
`claudeclaw-scheduled-tasks` table, and the per-task one-shot schedules
in scheduler group `claudeclaw` are created from it at runtime
(`src/lib/scheduler/eb-scheduler.ts`). After import, start one task and
let the scheduler reconcile (or trigger the rehydration path), then
VERIFY the recreated set matches before cutover:

```bash
aws scheduler list-schedules --group-name claudeclaw \
  --query 'Schedules[].Name' --output text --no-cli-pager
# compare against the pending rows of claudeclaw-scheduled-tasks:
# every due/pending task must have its schedule, and nothing extra.
```

### 8. Surfaces re-pointed (DNS last)

1. Telegram: `setWebhook` for each bot token to the new account's
   webhook URL.
2. Slack: update each app's Event Subscriptions request URL to the new
   endpoint (Slack re-verifies with `url_verification`).
3. DNS cutover LAST, after both webhook surfaces answer in the new
   account: re-point the domain / hosted zone at the new ALB or
   CloudFront distribution. ACM in the new account needs its own
   validated cert before this step.

### 9. The validation gate (blocks teardown)

ALL of these must pass BEFORE the old account is torn down and BEFORE
any KMS grant is revoked:

- S3 object counts per migrated prefix match the counts recorded in
  step 2.
- DDB item counts per table match the export manifests' item counts.
- Spot-check DECRYPTION in the new account: read a curated knowledge
  object, an agent prompt from the config bucket, and an app-encrypted
  DDB field end to end.
- `npm run verify` fully green in the new account.
- The application-level no-live-reference check from the
  object-version section above.
- Schedules verified in step 7; a test turn on each connected surface.

### 10. Teardown old

Only now: `npm run teardown` in the old account (see its `--export-first`
and Object Lock semantics), revoke the migration KMS grants
(`aws kms retire-grant`/`revoke-grant`), delete the migration roles, and
leave the intentional residuals (WORM audit bucket until retention
lapses). Re-establish CI trust against the new account: the GitHub OIDC
provider + role trust (`scripts/oidc-provider.sh`, `CCE_GITHUB_*`) and
the CodeBuild source credential
(`aws codebuild import-source-credentials`) are new-account work, per
[github-to-aws.md](github-to-aws.md).

## What does NOT migrate, stated plainly

- **KMS keys.** Keys never leave an account. Everything live is
  re-encrypted under the new account's keys; the old keys exist only to
  read residuals until teardown.
- **WORM audit history** (`claudeclaw-audit-lock-*`). Object Lock
  governance retention holds it in the old account on purpose; it is an
  intentional residual until retention lapses.
- **CloudWatch history** (logs, metrics, alarm state) and the
  `claudeclaw-logs-*` bucket contents.
- **OIDC / CodeBuild trust.** Account-scoped; re-established against the
  new account ID, never copied.
- **Noncurrent S3 object versions** of the versioned buckets
  (latest-only copy, per the inventory above).
