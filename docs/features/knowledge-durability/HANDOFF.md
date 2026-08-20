---
feature: knowledge-durability
document_role: handoff
status: current
observed_at: 2026-08-20
as_of_commit: 5418497c4b8466f2f932862fcfee512ca527a7a3
---

# Knowledge durability handoff

- Branch: `fix/durable-knowledge-bucket`, branched from `development` at
  `5418497c4b8466f2f932862fcfee512ca527a7a3`. Merge target: `development`.
  Deployment: none — `development` reaches no AWS environment, per the
  [branch-to-environment mapping](../../../development.md#branch-to-environment-mapping).
- Pushed: **no**. Committed locally only. PR: none.
- Current objective: **implementation complete, unpushed.** The index now has
  its own versioned, non-expiring bucket; the staging expiry is scoped to
  `uploads/`; the write/read scope-folding asymmetry is fixed; guard tests are
  in place and proven to fail when either defect is reintroduced; the
  account-migration runbook is corrected. Active task IDs: none.
- Blockers: **AWS credentials expired for this entire session** — nothing has
  been verified against a live account, and the production loss itself is
  confirmed from source and synthesized templates only.
- Baseline `npm test` on untouched `5418497c4b8466f2f932862fcfee512ca527a7a3`:
  **5 files failed / 1 test failed**, 2122 passed, 6 skipped (2129). Four are
  suite-load failures on Windows (`scripts/ci/docs-links.test.ts`,
  `scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`,
  `scripts/release/sync-deprecations.test.ts`); one is a Windows path-separator
  assertion at `scripts/lib/lifecycle/rollback-classes.test.ts:574`. All five
  pre-date this work and none touch the files being changed.
- Last required checks: eight of the nine pre-push commands ran and pass —
  `typecheck`, `build`, web `typecheck`, web `build`, `docs-links`,
  `feature-knowledge`, `git diff --check`, and `npm test`. After the change
  `npm test` is **5 files / 1 test failed, 2134 passed** against a baseline of
  **5 files / 1 test failed, 2122 passed**: the failure set is identical and
  pre-existing (Windows), and passing is up 12 from the new guards.
  **`npm run local:test:integration` did NOT run** — Docker is unavailable on
  this machine so Floci cannot start. That gate is outstanding.
- Smallest next action: push the branch and open the PR into `development`;
  have someone with valid AWS credentials confirm the production bucket state.
- Unresolved evidence: `RawBucket` carries the same defect class (365-day
  blanket expiry, versioning off) while holding agent-generated documents. Not
  fixed here; it needs a product decision on media retention, recorded in
  [README section 7](README.md#7-known-risks-and-approved-next-work) and named
  in the guard test's `UNRESOLVED` set.
- Deploy ordering constraint: `CCE-Storage` must deploy BEFORE `CCE-Compute`,
  since Compute repoints `VECTORS_BUCKET` at a bucket Storage creates. Do not
  re-ingest until both have landed, or the new documents go into the still
  expiring bucket.

## Session log index

- [2026-08-20 — knowledge base wipe RCA and durable bucket](handoffs/2026-08-20-knowledge-wipe-rca-and-durable-bucket.md)
