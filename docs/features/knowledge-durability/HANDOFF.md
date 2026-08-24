---
feature: knowledge-durability
document_role: handoff
status: current
observed_at: 2026-08-20
as_of_commit: 5418497c4b8466f2f932862fcfee512ca527a7a3
---

# Knowledge durability handoff

- Branch: `hotfix/durable-knowledge-bucket`, branched from `production` at
  `992fd9d`. Merge target: `production`. Backport branch:
  `fix/knowledge-durability-backport`, from `development` at `17fadd1`, merge
  target `development` and then on through `qa` and `staging`, per the
  [branch-to-environment mapping](../../../development.md#branch-to-environment-mapping).
- Pushed: see the session handoff. PR: see the session handoff.
- Current objective: **two defects fixed, awaiting the operator's production
  deploy.** (1) The durable index has its own versioned, non-expiring bucket and
  the staging expiry is scoped to `uploads/`. (2) **New this session:** the
  vectors bucket CORS allowlist is rebuilt from both `DOMAIN_NAME` and
  `CCE_DASHBOARD_URL` — it previously contained only `http://localhost:3000`,
  so every browser upload from `https://app.pgnos.ai` died in preflight. That
  second defect, not the lifecycle rule, is why uploads error *now*.
  Active task IDs: none.
- Blockers: **production deploy is the operator's dispatch** (`workflow_dispatch`
  only, requires typing `deploy`; `CCE-Storage` before `CCE-Compute`).
  **`npm run local:test:integration` NOT RUN** — Docker Desktop will not start.
- Verified against the live account this session (account `239887088812`):
  `expire-staging-fast` really carries `Filter.Prefix ""` with a 7-day expiry,
  versioning was never enabled, and `index/` holds **0 objects**. The CORS
  allowlist really contains only `http://localhost:3000`.
- Baseline `npm test` on untouched `992fd9d` (production): **4 files failed /
  1 test failed** — `scripts/ci/docs-links.test.ts`,
  `scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`,
  `scripts/release/sync-deprecations.test.ts` fail at import, plus a Windows
  path-separator assertion at `scripts/lib/lifecycle/rollback-classes.test.ts:574`.
  After the change: **identical failure set**, 1925 passed, 6 skipped (1932).

## Session log index

- [2026-08-20 — knowledge base wipe RCA and durable bucket](handoffs/2026-08-20-knowledge-wipe-rca-and-durable-bucket.md)
- [2026-08-24 — the CORS outage and the production hotfix](handoffs/2026-08-24-cors-outage-and-hotfix.md)
