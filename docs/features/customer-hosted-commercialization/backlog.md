---
feature: customer-hosted-commercialization
document_role: backlog
status: accepted
observed_at: 2026-08-28
as_of_commit: 51b39a1dc0afe84f32823f3f4fca9c609f1aa346
---

# Customer-hosted commercialization backlog

> This is the approved technical execution queue derived from the 2026-08-28
> audit. P0 tasks precede any external commercial release; P1 tasks precede
> customer production. Legal decisions remain with counsel and business owners,
> not this queue.

## COMM-001 Data-blind deployment design

```yaml
work_state: approved
```

Remove CI secret reads, constrain CloudFormation deployment authority, run
secret composition/migrations under customer-owned roles, and design the
separate customer-controlled break-glass path. Produce IAM tests proving denies
for Secrets Manager values, data stores, logs content, backups, and ECS Exec.

## COMM-002 Immutable release workflow

```yaml
work_state: approved
```

Wire existing metadata/signing/updater code to a protected release workflow.
Build once, generate final-image SBOM/notices/scans/provenance, promote without
rebuild, publish `v*`, and deploy by verified digest only.

**Dependencies.** `COMM-003` and repository protection must pass before the
first final release.

## COMM-003 Resolve distribution-license blockers

```yaml
work_state: approved
```

Resolve or replace `buffers@0.1.1`, PDFKit AFM/ICC assets, and FFmpeg; add the
Paperclip patch/upstream notice; generate built-image/browser/sidecar SBOMs and
complete license texts; obtain counsel approval.

## COMM-004 Customer bootstrap role and template

```yaml
work_state: approved
```

Implement the customer-run bootstrap that creates exact OIDC trust, immutable
ECR, bounded deployment roles, audit records, and optional disabled break-glass
access. No permanent AWS keys or administrator trust.

**Dependencies.** `COMM-001`.

## COMM-005 Customer-domain canary

```yaml
work_state: approved
```

Exercise a customer-shaped account and `ai.customer.example`-style delegated or
external DNS path without PGN Cloudflare. Verify frontend/API/WebSocket/CORS,
OAuth/magic links/integration callbacks, ACM renewal, T3 behavior, rollback, and
data-flow inventory.

**Dependencies.** `COMM-002`, `COMM-004`.

## COMM-006 Attorney and chain-of-title closure

```yaml
work_state: blocked
```

Counsel confirms licensor, assignments/AI-assisted provenance, customer grant,
third-party disposition, support/modification/termination terms, and
healthcare/privacy posture. Engineering supplies the package but cannot close
the task.

## COMM-007 Repository governance enforcement

```yaml
work_state: blocked
```

Business selects the required GitHub organization plan and independent
reviewers; then enable protected branches/tags, required checks/CODEOWNERS,
production Environment reviewers, restricted Actions, secret/code scanning,
and private vulnerability reporting.

## COMM-008 Customer onboarding and release evidence rehearsal

```yaml
work_state: approved
```

Rehearse bootstrap, release import, approval, deployment, verification,
rollback, revocation, and offboarding with synthetic data. Deliver the final
deployment record and procurement evidence set.

**Dependencies.** `COMM-003`, `COMM-004`, `COMM-005`, `COMM-006`, `COMM-007`.
