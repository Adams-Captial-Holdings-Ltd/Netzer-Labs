# ADR 0002 — Single-tenant deploy model

**Status:** Accepted (2026-04, v3 ship). Revisit for E1 (multi-tenant) strategic track.

## Context

Every persistent resource (DDB tables, S3 buckets, secrets, KMS keys) is scoped to "the deployment" — there's no `tenantId` partition. One deploy serves one team / one user-set.

Reasons to revisit eventually:
- Selling ClaudeClaw to many customers
- Internal "ClaudeClaw as a shared service" where multiple teams want isolation

## Decision

Stay single-tenant. When (if) multi-tenant becomes needed, prefer **pattern-1** (deploy-per-customer + AWS Marketplace installer) over **pattern-3** (refactor every PK to start with `TENANT#`).

## Consequences

Good:
- No `tenantId` to thread through every DDB query, S3 path, audit row, scheduled-task row. Code stays simple.
- Resource isolation is at the AWS-account level. KMS keys + IAM are per-deploy. Hard to leak one customer's data to another by software bug.
- Compliance story for B2B is easier: "your deploy, your account, our IAM never touches your data".
- Marketplace SKU is a one-click install of the same CDK app, configured by the customer.

Bad:
- Per-customer fixed cost floor is the full deploy (~$140/month T1). Doesn't work for $10/seat consumer pricing.
- Multi-region or HA-across-accounts requires lifting more state than we currently have a story for.
- Customer offboarding = stack-destroy + retain-policy cleanup; not as elegant as "delete tenant row".

## Alternatives considered

- **Pattern-3 (full multi-tenant refactor)**: ~2 weeks of work to thread `tenantId`, plus indefinite ongoing cost of "did I remember to scope this query?" mistakes. Worth it only if the customer base is large and per-customer revenue is small. Today neither is true.
- **Pattern-2 (shared compute, per-tenant DDB tables)**: half the pain of pattern-3 with most of the cost benefit. Worth considering when pattern-1 doesn't fit, but adds a meaningful blast radius (one bug can corrupt many tenants).
- **Status quo with manual per-customer deploys**: this. The marketplace installer is the "scale" version, where a customer one-clicks their own deploy without any operator involvement.

## Trigger to revisit

Three to five customers say "we don't want to manage our own AWS account, just host it for us." At that point, pattern-2 + a thin tenancy layer becomes worth the investment.
