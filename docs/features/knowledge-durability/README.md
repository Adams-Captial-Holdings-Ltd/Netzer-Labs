---
feature: knowledge-durability
document_role: index
status: current
observed_at: 2026-08-20
as_of_commit: 5418497c4b8466f2f932862fcfee512ca527a7a3
implemented_by:
  - infra/lib/storage-stack.ts
  - infra/lib/compute-stack.ts
  - infra/lib/constants.ts
  - src/lib/vectors/store.ts
tested_by:
  - infra/lib/storage-stack.test.ts
  - src/lib/vectors/store.scope.test.ts
---

# Knowledge durability

## 1. Start Here

This page owns **where ingested knowledge physically lives and what is allowed
to delete it**. It exists because the production knowledge base was destroyed by
an S3 lifecycle rule on 2026-08-15 → 2026-08-20, and because this repository is
installed as enterprise infrastructure at other companies, where the same defect
would fire at every site.

Read [section 2](#2-what-it-does-today) for present behaviour,
[section 6](#6-business-and-state-rules) for the retention rules the code
actually enforces, and the [HANDOFF](HANDOFF.md) for where the work sits now.
Where this page and the implementation disagree, **the code wins** and this page
is wrong.

## 2. What it does today

Ingested knowledge is chunked, embedded, and written as one JSONL object per
document at `index/<scope>/<docId>.jsonl`. Each line is
`{ chunkId, text, embedding, metadata }`. Retrieval lists the objects under the
scope prefix and computes cosine similarity in memory.

There is exactly **one** copy of that data. There is no second store: no
S3 Vectors service, no OpenSearch, no Bedrock knowledge base, and no DynamoDB
mirror. Source documents are **not** retained — the browser upload is deleted
from staging immediately after indexing. So the JSONL object under `index/` is
the sole artifact, and losing it is unrecoverable by any means inside this
system.

What it is **not** yet: there is no backup, no replication, and no export of the
vector index.

## 3. Current status and source commit

**Fixed and deployed to production on 2026-08-24**, and confirmed against the
live account (`239887088812`) rather than from source alone. Task definition
went `8` → `9`; the only environment values that changed were `DEPLOY_SHA` and
`VECTORS_BUCKET`, which now resolves to the durable bucket.

Two independent defects caused the outage, and each produced a different
symptom. Fixing either alone would have left the system broken:

| # | Defect | Symptom it produced |
|---|---|---|
| 1 | `expire-staging-fast` carried `Filter.Prefix ""` — an empty prefix matches **every** key — with a 7-day expiry on an unversioned bucket | Knowledge that had been ingested silently vanished a week later, permanently |
| 2 | The bucket's CORS allowlist was built from `DOMAIN_NAME` alone, which is deliberately blank; the deploy set `CCE_DASHBOARD_URL` instead | Every browser upload died in CORS preflight, so nothing new could be added at all |

Defect 2 is the one the original RCA missed, because an expiry explains data
disappearing later, never a write failing now. If knowledge breaks again, read
[section 10](#10-recovery-runbook--if-knowledge-stops-saving-again) first: it
separates the two shapes in about a minute.

## 4. Source of truth table

| Concern | Authority | Use it for |
|---|---|---|
| Bucket topology, retention, versioning | [`infra/lib/storage-stack.ts`](../../../infra/lib/storage-stack.ts) | Which bucket exists and what may delete from it |
| Which bucket the app reads and writes | [`infra/lib/compute-stack.ts`](../../../infra/lib/compute-stack.ts) | The `VECTORS_BUCKET` / `VECTORS_STAGING_BUCKET` wiring |
| Key layout and scope derivation | [`src/lib/vectors/store.ts`](../../../src/lib/vectors/store.ts) | How a document maps to an S3 key |
| Account-to-account moves | [`docs/account-migration.md`](../../account-migration.md) | What must be carried to a new AWS account |

## 5. Implementation map

| Area | Verified file | Present behaviour |
|---|---|---|
| Vector index read/write | `src/lib/vectors/store.ts` | Reads `VECTORS_BUCKET`; keys are `index/<scope>/<docId>.jsonl` |
| Upload staging | `src/lib/vectors/store.ts` | Presigned browser PUT under `uploads/`, deleted after indexing |
| Bucket definitions | `infra/lib/storage-stack.ts` | Owns every bucket, its lifecycle rules and versioning |
| Env wiring | `infra/lib/compute-stack.ts` | Injects the bucket names into the task definition |

## 6. Business and state rules

1. **The knowledge index is durable.** No lifecycle rule may expire an object
   under `index/`. This is the rule whose absence caused the 2026-08 loss.
2. **Upload staging is disposable.** Objects under `uploads/` are transient and
   are expected to be expired; the app deletes them after indexing anyway.
3. **Durable and disposable data must not share a bucket with a blanket delete
   rule.** An S3 lifecycle rule with no `prefix` and no `filter` matches *every*
   object in the bucket.
4. **A bucket holding durable data has versioning enabled**, so an accidental
   delete or overwrite is recoverable rather than permanent.

## 7. Known risks and approved next work

| Risk | Evidence | Owner |
|---|---|---|
| `RawBucket` expires all objects at 365 days with `versioned: false`, and holds agent-**generated documents** as well as transient media | `infra/lib/storage-stack.ts` raw bucket lifecycle; `src/lib/tools/document-generation-tools.ts` writes deliverables to `RAW_BUCKET` | Unowned — see HANDOFF |
| `docs/account-migration.md` instructs operators to abandon the vectors bucket on the false premise that "vectors re-derive from curated" | No code writes ingested documents to the curated bucket | This work |
| No backup or replication covers the vector index | `infra/lib/backup-stack.ts` is DynamoDB-only | Unowned |

## 8. Validation commands

Focused:

```bash
npx vitest run infra/lib/storage-stack.test.ts
```

Full pre-push suite: the nine commands in
[development.md](../../../development.md#how-to-develop-a-new-feature-end-to-end).

## 9. Related documents

- [Feature knowledge framework](../README.md)
- [development.md](../../../development.md)
- [Account-to-account migration](../../account-migration.md)

## 10. Recovery runbook — if knowledge stops saving again

Written after the 2026-08 outage so the next person does not have to re-derive
any of it. Every command here is read-only unless marked **MUTATES**.

Set these once:

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=${AWS_REGION:-us-east-1}
STAGING="claudeclaw-vectors-staging-${ACCOUNT}-${REGION}"
DURABLE="claudeclaw-vectors-${ACCOUNT}-${REGION}"
```

### 10.1 Tell the two failure shapes apart first

The tense of the complaint is the fastest discriminator. "It won't upload" and
"my knowledge is gone" have completely different causes.

| What the operator reports | Almost certainly | Go to |
|---|---|---|
| Upload errors in the browser, often naming CORS or `Access-Control-Allow-Origin` | The allowlist lost the dashboard origin | [10.2](#102-uploads-are-refused-cors) |
| Import reports success, but the document never appears in the list | Write and read disagree about the key or the bucket | [10.3](#103-import-succeeds-but-nothing-appears) |
| Knowledge that used to be there is missing, and `index/` is empty | A lifecycle rule reached `index/` | [10.4](#104-knowledge-that-was-there-is-gone) |

A useful early signal: if `uploads/` is empty **and** `index/` is empty, nothing
has ever landed, which points at a write-side failure rather than deletion.

```bash
aws s3 ls "s3://${STAGING}/uploads/" --recursive | wc -l
aws s3 ls "s3://${DURABLE}/index/" --recursive | wc -l
```

### 10.2 Uploads are refused (CORS)

The browser PUTs straight to S3 via a presigned URL, so this failure happens
**in the browser** and never reaches the server. Expect nothing in the
orchestrator log, and expect `presignUploadUrl` to report success — presign
genuinely does succeed; it is the upload that follows which is refused.

Diagnose:

```bash
aws s3api get-bucket-cors --bucket "${STAGING}" --query 'CORSRules[].AllowedOrigins'
```

The dashboard's own origin must appear. Compare it with what the running task
believes its dashboard URL is:

```bash
aws ecs describe-task-definition --task-definition claudeclaw-orchestrator \
  --query "taskDefinition.containerDefinitions[?name=='orchestrator'].environment" \
  --output json | grep -A1 CCE_DASHBOARD_URL
```

Prove it from the outside, exactly as a browser would:

```bash
curl -s -o /dev/null -D - -X OPTIONS \
  "https://${STAGING}.s3.${REGION}.amazonaws.com/uploads/probe" \
  -H "Origin: https://app.pgnos.ai" \
  -H "Access-Control-Request-Method: PUT"
```

A healthy response is `HTTP/1.1 200` carrying
`Access-Control-Allow-Origin: <your origin>`. No such header is the bug.

**Fix, permanently:** the allowlist is built in `infra/lib/storage-stack.ts`
from `DOMAIN_NAME` **and** `CCE_DASHBOARD_URL`. `DOMAIN_NAME` is deliberately
blank in every environment, so in practice the origin comes from
`CCE_DASHBOARD_URL`, which is a **GitHub Environment variable**, not a
repository variable — `gh variable list` will not show it. Check the right
place:

```bash
gh api repos/<org>/<repo>/environments/production/variables --jq '.variables[] | "\(.name) = \(.value)"'
```

If it is missing or wrong, set it there and redeploy. Each install has its own
environment, which is why nothing is pinned to one customer's domain.

**Fix, immediately (MUTATES):** restores uploads in about a minute without a
deploy. Creates CDK drift until the next deploy reconciles it.

```bash
aws s3api get-bucket-cors --bucket "${STAGING}" > /tmp/cors-before.json   # rollback
aws s3api put-bucket-cors --bucket "${STAGING}" --cors-configuration '{
  "CORSRules": [{
    "AllowedHeaders": ["*"], "AllowedMethods": ["PUT"],
    "AllowedOrigins": ["https://app.pgnos.ai", "http://localhost:3000"],
    "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3000
  }]
}'
```

### 10.3 Import succeeds but nothing appears

Two causes, both silent — the API returns success either way because
`/api/ingest/stream` performs no read-after-write check.

**Wrong bucket.** Confirm the task writes where the reader looks:

```bash
aws ecs describe-task-definition --task-definition claudeclaw-orchestrator \
  --query "taskDefinition.containerDefinitions[?name=='orchestrator'].environment" \
  --output json | grep -A1 -E "VECTORS_BUCKET|VECTORS_STAGING_BUCKET"
```

`VECTORS_BUCKET` must be the **durable** bucket. If it still names
`*-vectors-staging-*`, `CCE-Compute` has not deployed the fix.

**Scope divergence.** Historically the write path folded a scope such as
`agent:ops` to `agent_ops` while the read path listed the raw string, so every
read came back empty. Both now derive from `indexPrefixFor` in
`src/lib/vectors/store.ts`, and `src/lib/vectors/store.scope.test.ts` pins it.
If you suspect it has returned, list what is actually on disk and compare with
the scope the agent is configured with:

```bash
aws s3 ls "s3://${DURABLE}/index/" --recursive | head -20
```

A scope containing anything outside `[A-Za-z0-9_-]` is the trigger. Note the
Knowledge Scope field on an agent is free text and unvalidated
(`src/adapters/dashboard/handler.ts`), so an operator can still create one.

### 10.4 Knowledge that was there is gone

```bash
aws s3api get-bucket-lifecycle-configuration --bucket "${DURABLE}"
aws s3api get-bucket-versioning --bucket "${DURABLE}"
```

The durable bucket must show **no rule with an `Expiration`** — only
`expire-old-versions`, which touches superseded versions and can never remove a
current object — and versioning `Enabled`. If a rule with `Expiration` appears
on the durable bucket, or if the staging rule's `Filter.Prefix` is empty rather
than `uploads/`, the defect has been reintroduced.

Because versioning is on, deletes since 2026-08-24 are **recoverable**. List
what is behind a delete marker and restore it:

```bash
aws s3api list-object-versions --bucket "${DURABLE}" --prefix "index/" \
  --query '{Versions:Versions[].{K:Key,V:VersionId},Markers:DeleteMarkers[].{K:Key,V:VersionId}}'
# MUTATES — removing the delete marker republishes the previous version
aws s3api delete-object --bucket "${DURABLE}" --key "<key>" --version-id "<delete-marker-id>"
```

Objects deleted **before** 2026-08-24 are unrecoverable: versioning was off, so
those deletes were permanent. The only surviving record is the
`knowledge_ingest` rows in the audit log, which name what was ingested but not
its contents.

### 10.5 Confirm the guards still hold

These fail if either defect returns. They were each verified by reintroducing
the defect and watching the suite go red — a guard nobody has seen fail is not
yet a guard.

```bash
npx vitest run infra/lib/storage-stack.test.ts src/lib/vectors/store.scope.test.ts src/lib/vectors/durability.repro.test.ts
```

`durability.repro.test.ts` is the end-to-end reproduction: it saves a file and
imports a document through the real code paths, then evaluates the real
synthesized lifecycle rules against the keys those paths produced. Its
`describe('the incident itself, reproduced')` block must keep treating the
pre-fix configuration as fatal — if that block ever stops detecting the old
config, the matcher has gone blind and every other assertion in the file is
worthless.

### 10.6 What is still not protected

The index remains a **single copy in a single bucket in a single account**.
Versioning defends against overwrite and delete inside the bucket; it is not a
backup. `infra/lib/backup-stack.ts` covers DynamoDB only and names no bucket.
`scripts/teardown.ts` deletes this bucket by name, versions included, and the
KMS key it rides is scheduled for deletion during teardown's cryptographic
erasure. Teardown, account loss, or key deletion still destroy the knowledge
base permanently.
