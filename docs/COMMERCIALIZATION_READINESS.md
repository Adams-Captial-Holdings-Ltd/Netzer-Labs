---
feature: customer-hosted-commercialization
document_role: evidence
status: historical
observed_at: 2026-08-28
as_of_commit: 51b39a1dc0afe84f32823f3f4fca9c609f1aa346
---

# Commercialization readiness evidence

> This is a historical technical audit of commit
> `51b39a1dc0afe84f32823f3f4fca9c609f1aa346` plus live GitHub settings observed
> on 2026-08-28. The architecture can support customer-hosted proprietary
> licensing, but it is not commercially releasable today. The current feature
> state and next action live in the
> [commercialization feature README](features/customer-hosted-commercialization/README.md).

This document is technical evidence, not legal advice or an approval to sell.

## Verdict

**YES, WITH BLOCKERS.** The CDK already creates a single-tenant application,
data stores, keys, secrets, logs, and backups in the target AWS account; generic
customer domains are supported through `DOMAIN_NAME`. The blockers are the
software factory and trust boundary around that runtime: no actual immutable
release exists, moving branches deploy directly, repository controls are not
enforced, the GitHub deployment role can retrieve Paperclip secrets and assume
powerful CDK roles, and the distributable artifact has unresolved license and
SBOM gaps.

## Evidence baseline

| Area | Observed state |
|---|---|
| Repository | Private GitHub Organization repository `Adams-Captial-Holdings-Ltd/Netzer-Labs`; default branch `development`; repository license API reports `NOASSERTION`. |
| Branches | `development → qa → staging → production` convention; no branch protection or rulesets on any promotion branch. `CODEOWNERS` names one individual account and is advisory only. |
| Deployments | `staging` deploys on push; production uses manual dispatch from the moving `production` branch. Images are tagged with short commit SHA and `latest`; the deploy does not consume a signed `v*` release. |
| Releases | Package version `0.0.1`; no local/remote release tags and no GitHub Releases. Release metadata/signing/updater code exists, but trust roots and external release objects do not. |
| GitHub security | Actions allow all actions; workflow default token is read-only; inspected actions are SHA-pinned. Secret scanning and push protection are disabled; code scanning is unavailable/disabled; Dependabot is enabled. No production environment approvals exist. |
| Runtime data | DynamoDB, S3, Aurora, EFS, KMS, Secrets Manager, CloudWatch, CloudTrail, X-Ray, and backups are synthesized into the deployment account with retention controls. |
| Domain | `DOMAIN_NAME`, `HOSTED_ZONE_ID`, `HOSTED_ZONE_NAME`, `ACM_CERT_ARN`, and `CCE_DASHBOARD_URL` provide generic customer configuration. `app.pgnos.ai` is confined to a separate PGN Cloudflare overlay, but current PGN staging/production workflows use that overlay. |
| Data access | The GitHub OIDC role uses short-lived credentials, but can read/write scoped Paperclip secrets and assume CDK bootstrap deploy roles. That creates a technical path to alter customer infrastructure or expose data. |
| Dependencies | Post-patch npm runtime audits: root 0 critical/0 high/2 moderate (`exceljs → uuid`, accepted pending upstream); dashboard 0 findings. Built images, OS packages, Paperclip, and sidecars remain unscanned. |
| Tests | Untouched baseline: 229 test files passed, 6 failed, 1 skipped; 2,894 tests passed, 7 failed, 6 skipped. Failures were four existing parser errors, six Windows `sh`-missing cases, and one Windows path assertion. |

## Ranked blockers

| Priority | Blocker | Evidence | Required fix |
|---|---|---|---|
| P0 | Rights holder, chain of title, and customer grant are not legally confirmed | Existing provenance is an owner statement, imported history is incomplete, authors include people/automation, and the old notice named an individual operating under a business name | Counsel confirms licensor/assignments/AI-assisted provenance and approves the commercial agreement plus final repository notice |
| P0 | No immutable customer release exists | No tags/releases; empty updater trust roots; deploy workflow builds a moving branch with SHA/`latest` tags | Wire the existing signed-artifact tooling into a protected `v*` release workflow; deploy only verified digests from approved releases |
| P0 | Customer deployment authority is not data-blind | `infra/lib/iam-stack.ts` grants the GitHub OIDC role Paperclip `GetSecretValue`/`PutSecretValue` and CDK role assumption | Remove secret reads from CI, move secret composition/migrations inside a customer-controlled principal, constrain release deployment and separate customer-controlled break-glass access |
| P0 | Repository and production approvals are conventions | No branch protection/rulesets; no environment protection; one individual CODEOWNER; admin bypass available | Move to an appropriate organization plan and enforce PRs, independent review, status checks, immutable tags, environment reviewers, no force-push/deletion, and no admin bypass |
| P0 | Distributed dependency/license provenance is incomplete | `buffers@0.1.1` has no detected license; PDFKit bundled data lacks a local grant; Alpine FFmpeg is GPL/LGPL; Paperclip/image notices and built-image SBOM are missing | Resolve/replace unknown assets, decide and satisfy FFmpeg obligations, generate full image notices/SBOM, and obtain counsel review |
| P0 | No working external vulnerability channel or full-history secret evidence | Security contact is unknown; private vulnerability reporting and GitHub secret scanning are disabled; current source scan finds only known fake fixtures but history was not scanned | Create/test the security mailbox, enable private reporting/scanning or equivalent, scan full history, rotate any discovered credentials, and document evidence |
| P1 | Customer production profile is not a tested release path | Generic domain path exists, but PGN workflow is environment-specific and Cloudflare-based; T3 CloudFront assumes Route 53 lookup and manual cutover | Add a customer deployment profile/canary using customer DNS or BYO cert, with explicit account/region/domain and no PGN Cloudflare flags |
| P1 | Supply-chain gates do not cover the delivered artifact | No release-time SAST, container vulnerability gate, license policy, built-image SBOM, provenance attestation, or base-image digest pin | Add bounded release gates, pin base images, archive results beside the digest, and fail on unreviewed critical/high findings |
| P1 | External data-flow inventory was incomplete | Salesforce, Cloudflare request transit, public runtime image pulls, and Paperclip telemetry were omitted or misstated | Maintain `docs/data-flows.json` as a release gate; Paperclip call-home is now disabled explicitly in task definitions |
| P1 | Customer onboarding/support separation is undocumented in one contract | Existing install docs assume a fresh standalone account but not a vendor/customer responsibility split | Adopt `AWS_CUSTOMER_DEPLOYMENT.md`, customer bootstrap template, access matrix, deployment record, and offboarding evidence |
| P2 | Support and modification policy is undecided | Tooling assumes N-1, while no commercial support promise or customer modification policy exists | Counsel/business approve version support, patch cadence, forks/modifications, and subscription-end rights |
| P2 | Optional vendor integrations need customer-specific approval | Slack, Telegram, Salesforce, search vendors, SES recipients, and MCP endpoints can transmit selected customer content | Make each opt-in, list processors/data, obtain customer configuration/approval, and provide kill switches |
| P3 | No offline entitlement artifact | Entitlement is expected to live only in the contract | Keep v1 contractual; later consider locally verified signed entitlements with no call-home |
| P3 | No multi-customer fleet maturity | No customer inventory, rollout ring, or centralized non-data deployment ledger | Add only after the first deployment pattern is proven; never centralize customer content |

## Low-risk changes completed in this audit

- Added a provisional proprietary notice and truthful security policy, both
  explicitly blocked on attorney/business completion.
- Added draft third-party notices and CycloneDX npm SBOMs.
- Patched known runtime vulnerabilities in Hono, DOMPurify, Docx/Nanoid,
  Brace Expansion, and `tmp`; no force or major audit fix was used.
- Disabled Paperclip telemetry using both supported exact-value controls in ECS
  and the local integration harness.
- Prepared customer architecture, data-boundary, AWS deployment, release,
  supply-chain, and counsel-review documents.

## Consequential changes deliberately not made

No repository transfer, production IAM rewrite, branch/ruleset mutation,
release/tag creation, key ceremony, production workflow switch, base-image
change, or customer deployment was performed. Those actions require approved
designs, external settings, a clean branch, and in several cases customer or
counsel participation.
