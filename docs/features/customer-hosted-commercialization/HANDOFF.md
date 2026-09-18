---
feature: customer-hosted-commercialization
document_role: handoff
status: current
observed_at: 2026-09-17
as_of_commit: 271339bc8b2feea85e6c31b115fdd34e757a72e2
---

# Customer-hosted commercialization handoff

- Branch: `docs/customer-hosted-commercialization`, cut from `origin/development`
  at `271339bc8b2feea85e6c31b115fdd34e757a72e2` on 2026-09-17. The 2026-08-28
  work was previously uncommitted on the unrelated branch
  `fix/knowledge-scope-fanout` (PR #132 open). Merge target: undecided (owner).
- Pushed: not yet at the time of writing; the coordinator pushes this branch to
  origin under the same name immediately after this commit as an owner-approved
  backup (no PR, no merge, no deploy) - confirm with
  `git ls-remote origin refs/heads/docs/customer-hosted-commercialization`.
  PR: none for this work. Deployment: none.
- Completed: repository/GitHub/license/dependency/architecture/domain/IAM/
  release/supply-chain audit; required draft documents; source npm SBOMs;
  narrow dependency patches; Paperclip telemetry opt-out; move onto its own
  branch (2026-09-17).
- Active queue: [backlog](backlog.md). P0 commercial blockers remain open.
- Blockers: counsel/ownership decisions, repository-plan protections, customer
  IAM design, built Linux image/SBOM/license scan, release key ceremony and
  workflow, and customer-domain canary.
- Baseline full `npm test` (2026-08-28, on `51b39a1`): 229 files passed, 6
  failed, 1 skipped; 2,894 tests passed, 7 failed, 6 skipped. Four existing
  parser collection errors, six Windows `spawnSync sh ENOENT` cases, and one
  Windows path assertion failed.
- Last required checks: on 2026-09-17 only the two docs gates ran on this
  branch. Typecheck, build and the full `npm test` have **not** run on this
  branch, and the lockfiles were not re-validated with `npm install`; see the
  newest session log.
- Smallest next action: review and approve the `COMM-001` data-blind deployment
  role design (`infra/lib/iam-stack.ts`, GitHub OIDC role) before changing
  customer-facing IAM or deployment workflows.

## Session index

Newest first.

- 2026-09-17 - [machine transfer: moved to its own branch](handoffs/2026-09-17-machine-transfer.md)
- 2026-08-28 - [commercialization readiness audit](handoffs/2026-08-28-commercialization-readiness.md)

Authorities: [README](README.md), [backlog](backlog.md),
readiness evidence (`COMMERCIALIZATION_READINESS.md` on branch `docs/customer-hosted-commercialization`), and
[newest session handoff](handoffs/2026-09-17-machine-transfer.md).
