---
feature: knowledge-durability
document_role: handoff
status: current
observed_at: 2026-08-20
as_of_commit: 5418497c4b8466f2f932862fcfee512ca527a7a3
---

# Knowledge durability handoff

- Branch: all four long-lived branches now carry the fix. Shipped via
  `hotfix/durable-knowledge-bucket` into `production` and
  `fix/knowledge-durability-backport` into `development`, then promoted
  `development -> qa -> staging`, per the
  [branch-to-environment mapping](../../../development.md#branch-to-environment-mapping).
- Pushed: yes. PRs #91, #92, #93, #94 — all merged.
- Current objective: **done and deployed.** Production deployed 2026-08-24 at
  tier 2; task definition `8` -> `9`; service ACTIVE 3/3. Verified against the
  live account, not the deploy log. Active task IDs: none.
- **If knowledge breaks again, start at
  [README section 10](README.md#10-recovery-runbook--if-knowledge-stops-saving-again).**
  It separates the two failure shapes — uploads refused versus knowledge
  vanishing — in about a minute, and carries the diagnostic and repair commands.
- Remaining work: re-ingest the knowledge base (the old data is unrecoverable);
  unblock the staging deploy, which fails for an unrelated Paperclip ECR-grant
  reason so staging's environment is still unfixed; and reconcile
  `scripts/ci/branch-guard.mjs` with the `hotfix/*` route `development.md`
  documents.
- Not protected: the index is still a single copy in a single bucket in a single
  account. Versioning is not a backup, `infra/lib/backup-stack.ts` is
  DynamoDB-only, and `scripts/teardown.ts` deletes this bucket by name.

## Session log index

- [2026-08-20 — knowledge base wipe RCA and durable bucket](handoffs/2026-08-20-knowledge-wipe-rca-and-durable-bucket.md)
- [2026-08-24 — the CORS outage and the production hotfix](handoffs/2026-08-24-cors-outage-and-hotfix.md)
