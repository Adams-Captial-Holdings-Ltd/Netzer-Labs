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

Source evidence only, verified by reading the implementation and the
synthesized CloudFormation at the commit in the frontmatter. **No deployment
evidence** — AWS credentials were expired for the whole of this session, so
nothing here has been confirmed against a live account.

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
