---
feature: customer-hosted-commercialization
document_role: index
status: current
observed_at: 2026-08-28
as_of_commit: 51b39a1dc0afe84f32823f3f4fca9c609f1aa346
implemented_by:
  - infra/lib/paperclip-stack.ts
  - docker-compose.paperclip.yml
tested_by:
  - infra/lib/paperclip-stack.test.ts
approved_work:
  - docs/features/customer-hosted-commercialization/backlog.md
evidence:
  - docs/COMMERCIALIZATION_READINESS.md
---

# Customer-hosted commercialization

## 1. Start Here

This feature turns the current single-tenant AWS implementation into a
commercially governable customer-hosted product without creating a PGN data
plane. Start with the historical
[readiness evidence](../../COMMERCIALIZATION_READINESS.md), then the
[data boundary](../../CUSTOMER_DATA_BOUNDARY.md) and
[AWS deployment contract](../../AWS_CUSTOMER_DEPLOYMENT.md); use
[HANDOFF.md](HANDOFF.md) for the current branch and next action. Source and live
repository settings are the ultimate truth for present behavior.

## 2. What commercialization does today

The repository now has an explicitly provisional proprietary rights notice, a
truthful pre-release security policy, draft third-party notices, source-level
CycloneDX npm SBOMs, a ranked P0-P3 audit, and implementation-ready customer
architecture/release/supply-chain/counsel documents. Narrow dependency patches
removed all known critical/high runtime npm findings, and Paperclip telemetry
is explicitly disabled in deployed and local task definitions.

It is **not a commercial release**. No final customer agreement, immutable tag,
GitHub Release, release signing trust root, built-image SBOM, customer OIDC
role, customer canary, protected branch/tag, or production approval exists.

## 3. Current status and current source commit

Verified as source evidence against
`51b39a1dc0afe84f32823f3f4fca9c609f1aa346` on 2026-08-28, plus live GitHub
settings observed the same day. No AWS deployment, release, repository setting,
or legal approval was performed. The working tree already contained unrelated
user changes, which remain untouched.

## 4. Source of truth

| Concern | Authority | Use it for |
|---|---|---|
| Present runtime behavior | [infrastructure source](../../../infra/bin/app.ts) | Resources and account/domain behavior |
| Current access evidence | [data boundary](../../CUSTOMER_DATA_BOUNDARY.md) | PGN/customer ownership and access paths |
| Historical audit | [readiness evidence](../../COMMERCIALIZATION_READINESS.md) | 2026-08-28 findings and priorities |
| Approved work | [commercialization backlog](backlog.md) | Ordered executable follow-up |
| Customer release path | [release process](../../RELEASE_PROCESS.md) | Required immutable lifecycle |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, blockers, validation, next action |

## 5. Implementation map

| Area | Verified location | Present behavior |
|---|---|---|
| Customer account stack set | `infra/bin/app.ts`, `infra/lib/*-stack.ts` | Creates single-tenant compute/data/security/backup resources in configured account/region |
| Customer domain | `infra/lib/compute-stack.ts`, `storage-stack.ts`, `security-stack.ts` | Supports `DOMAIN_NAME`, `CCE_DASHBOARD_URL`, hosted-zone and BYO certificate inputs; T3 external DNS is incomplete |
| PGN-only public overlay | `infra/lib/public-dashboard-access.ts` | Restricts Cloudflare mode to `pgnos.ai`; mutually exclusive with generic domain mode |
| GitHub deployment authority | `infra/lib/github-oidc.ts`, `infra/lib/iam-stack.ts` | Exact OIDC subjects, but excessive secret/CDK deploy authority |
| Release tooling | `scripts/release/`, `scripts/update/` | Signed-artifact implementation exists; no operational release/trust root |
| Data-flow inventory | `docs/data-flows.json` | External processors and opt-outs; updated as part of this feature |
| Third-party evidence | `THIRD_PARTY_NOTICES.md`, `sbom/` | Draft inventory and npm SBOM; built image still blocked |
| Paperclip call-home | `infra/lib/paperclip-stack.ts`, `docker-compose.paperclip.yml` | Explicitly disabled with both upstream-supported flags |

## 6. Current business/state rules

- PGN owns software and releases; the customer owns AWS, DNS, credentials, and
  production data.
- Customer production never uses the PGN Cloudflare/`pgnos.ai` overlay.
- A signed agreement is the v1 entitlement; no license server or call-home.
- Customer deployment uses short-lived OIDC, an explicit account/region/domain,
  immutable release digest, and customer production approval.
- The ordinary deployment role is data-blind. Any support access is a separate
  customer-controlled, time-bound break-glass event.
- No external commercial use occurs until counsel and every P0 owner approve.

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| Deployment role can create a data-access path | [data boundary](../../CUSTOMER_DATA_BOUNDARY.md) | `COMM-001`, then `COMM-004` |
| No immutable/customer release | [readiness evidence](../../COMMERCIALIZATION_READINESS.md) | `COMM-002` |
| Image licensing/SBOM blockers | [third-party notices](../../../THIRD_PARTY_NOTICES.md) | `COMM-003` |
| Customer domain path not canary-proven | [architecture](../../CUSTOMER_HOSTED_ARCHITECTURE.md) | `COMM-005` |
| Legal licensor/grant unresolved | [attorney checklist](../../LEGAL_REVIEW_CHECKLIST.md) | `COMM-006` |

## 8. Exact focused and full validation commands

```powershell
npx vitest run infra/lib/paperclip-stack.test.ts
npm audit --omit=dev
npm --prefix web audit --omit=dev
node scripts/ci/feature-knowledge.mjs
node scripts/ci/docs-links.mjs
npm run typecheck
npm run build
npm --prefix web run typecheck
npm --prefix web run build
npm test
git diff --check
```

The Paperclip live integration and built-image scan additionally need Docker,
which was not installed on this workstation.

## 9. Related documents

- [Operational HANDOFF](HANDOFF.md)
- [Commercialization backlog](backlog.md)
- [Session handoff](handoffs/2026-08-28-commercialization-readiness.md)
- [Feature knowledge framework](../README.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)
