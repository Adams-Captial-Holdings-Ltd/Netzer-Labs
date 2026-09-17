# Customer data boundary

> The intended rule is simple: PGN owns the software; the customer owns the
> AWS environment and customer data. The current runtime resources largely
> satisfy that rule, but the current GitHub deployment role does not enforce a
> data-blind vendor boundary. Therefore customer data has a technical path to
> PGN-controlled automation today, even though no centralized PGN data service
> exists.

## Ownership and control matrix

| Asset | PGN | Customer | External provider | Present evidence/condition |
|---|:---:|:---:|:---:|---|
| Private source repository | Owns/controls | No ownership | GitHub hosts | Private organization repository |
| Release/IP/signing keys | Owns intended release | Receives licensed artifact | GitHub/ECR may distribute | No actual signed release/key exists yet |
| AWS account and billing |  | Owns/controls | AWS operates service | CDK targets the configured account/region |
| DNS and TLS |  | Owns/controls | Customer-selected DNS/ACM | `DOMAIN_NAME`/BYO cert exist; PGN Cloudflare is excluded from customer profile |
| Application workload/ECR | Supplies licensed artifact | Owns deployment and runtime | AWS | Target design imports verified digest into customer ECR |
| DynamoDB/Aurora/EFS/S3 |  | Owns/controls | AWS | Synthesized in deployment account; retention/PITR/backups where applicable |
| Secrets and KMS keys |  | Owns/controls | AWS | Customer-account Secrets Manager/KMS; current deploy role access must be removed |
| Logs/traces/audit |  | Owns/controls | AWS | Account-local CloudWatch, X-Ray, CloudTrail; no cross-account sink found |
| Backups |  | Owns/controls | AWS | Customer-account backup resources/retention |
| AI credentials/config |  | Owns/controls | AWS/selected model vendor | Bedrock uses customer AWS authority; optional vendor keys live in customer secrets |
| Salesforce/Slack/Telegram credentials |  | Owns/controls | Integration vendor processes them | Customer-configured optional integrations |
| Customer business data | No intended ownership/access | Owns/controls | Only selected processors | May leave AWS through configured integrations/model/tool calls |
| PGN telemetry | Software-factory metadata only | Owns any customer runtime telemetry | GitHub | No Netzer call-home; Paperclip telemetry is now explicitly disabled |
| Support diagnostics | Receives only with approval | Controls generation/transmission | Approved channel | Raw bundle transfer has no approved channel/retention process yet |

## Resource boundary proven from source

- `infra/lib/storage-stack.ts` creates encrypted customer-account S3 buckets,
  including retained/object-lock audit storage, and data KMS keys.
- `infra/lib/dynamo-stack.ts` creates encrypted/PITR DynamoDB tables in the
  deployment account.
- `infra/lib/database-stack.ts` and `infra/lib/filesystem-stack.ts` create
  retained Aurora/EFS resources for Paperclip.
- `infra/lib/secrets-stack.ts` creates customer-account secrets protected by
  KMS.
- observability, guardrail, and backup stacks write into account-local AWS
  services; no cross-account CloudWatch destination was found.
- application data can intentionally cross the account boundary only through
  documented external processors in `docs/data-flows.json`.

## Current PGN access paths

The answer to “can PGN technically access customer production data?” is
**yes under the current vendor-push design**:

1. `infra/lib/iam-stack.ts` creates the GitHub OIDC role
   `ClaudeClawGitHubDeploy` for exact repository/environment subjects. OIDC is
   short-lived and preferable to access keys, but credential lifetime is not
   the same as least privilege.
2. That role can retrieve and update scoped Paperclip secrets, including
   database/application secret material used by deployment phases.
3. It can assume CDK bootstrap deploy/file/image/lookup roles. A principal that
   can deploy arbitrary CloudFormation changes can change task roles, networking,
   log destinations, or resources to expose data even if direct S3/RDS reads are
   omitted.
4. ECS Exec is enabled on orchestrator and Paperclip tasks. A customer/PGN
   principal with AWS `ecs:ExecuteCommand` plus session permissions can enter a
   live task; the current OIDC role is not directly granted that action, but its
   broad infrastructure-deploy path could create or grant it.
5. No customer-controlled, separately approved break-glass role or evidence
   ledger currently distinguishes support access from deployment access.

No hardcoded PGN admin endpoint, PGN database, centralized log sink, customer
backup copy, or application support account was found. That limits current
exposure but does not cancel the deployment-authority path above.

## Required role separation

| Capability | Release deployment role | Customer data/support role |
|---|---:|---:|
| Read signed release metadata/SBOM | Allow | Not needed |
| Push verified digest to customer ECR | Allow, scoped repository/digest | Not needed |
| Create approved CloudFormation change set | Allow through constrained customer-owned deployment service/template policy | Not needed |
| Execute customer-approved change set | Approval-gated | Not needed |
| Describe deployment/health outputs | Allow, narrow | Optional read-only customer role |
| Retrieve application/database secrets | **Deny** | Customer break-glass only |
| Query Aurora/DynamoDB, read S3/EFS/backups | **Deny** | Customer break-glass only |
| Read production logs/content or ECS Exec | **Deny** | Customer-controlled, time-bound, case-specific approval |
| Change trust/policies/KMS grants | Deny from ordinary release role | Customer administrator only |

Secret generation and database migrations should execute inside customer AWS
under a customer-owned service/task role. CI should pass nonsecret release
identifiers, never retrieve credential values. If initial bootstrap genuinely
requires broad CloudFormation authority, make it a customer-run one-time step;
the steady-state vendor role must be narrower.

## Support and break-glass policy target

Default: PGN has no standing login, user, role, database credential, ECS Exec,
log access, backup access, or cross-account data path. For a specific incident,
the customer may create/activate a separate time-bound role with MFA/approval,
session logging, a ticket identifier, least privilege, and automatic expiry.
Customer and PGN record who used it, what was accessed, and when it was revoked.
This policy requires contractual and operational approval before use.
