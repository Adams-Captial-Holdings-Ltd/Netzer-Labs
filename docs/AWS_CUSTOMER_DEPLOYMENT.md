# AWS customer deployment

> This is the minimum viable enterprise deployment contract: PGN releases a
> verified immutable artifact; the customer owns the AWS account, trust policy,
> production approval, DNS, and data. GitHub OIDC supplies short-lived
> credentials and must never require customer access keys in repository
> secrets. The existing install conductor is reusable, but the present
> branch-driven GitHub role is too broad for this contract.

## Responsibility split

| Responsibility | PGN | Customer |
|---|---:|---:|
| Source, build, release tag, signing, notices, SBOM | Accountable | May audit |
| AWS account/Organization policy/billing | No access by default | Accountable |
| OIDC provider and role trust | Supplies exact claims/template | Creates, reviews, revokes |
| Production deployment approval | Supplies release/evidence | Approves in customer and GitHub environment |
| DNS, certificate, domain validation | Supplies outputs/runbook | Owns and performs/authorizes |
| Runtime secrets, KMS, data, logs, backups | No standing access | Owns/controls |
| Integration accounts/credentials | Documents processors | Selects/configures |
| Support access | Requests case-specific scope | Creates time-bound break-glass access |

## Customer prerequisites

Before PGN receives any deployment authority, the customer creates or confirms:

1. A fresh supported AWS account (the current installer intentionally refuses
   nonempty or Organizations-managed accounts; changing that constraint needs a
   separate enterprise-account design).
2. Explicit account ID, approved AWS region(s), deployment tier, environment
   name, cost approval, tagging/retention requirements, and AWS service quotas.
3. AWS CloudTrail and customer security monitoring, plus named customer
   administrators and an incident contact.
4. Customer DNS zone or delegated subzone for `ai.customer.com`, and either a
   Route 53/ACM path or an issued regional certificate with customer-managed
   DNS.
5. Required Bedrock model access and customer-approved inference regions.
6. A GitHub OIDC provider for `token.actions.githubusercontent.com` and a
   customer-created role whose trust matches the exact PGN organization,
   repository, workflow/ref or reusable workflow, and customer-specific GitHub
   Environment. The customer records the role ARN outside the source tree.
7. A production approval mechanism and named customer approver. The customer
   must be able to revoke trust without PGN cooperation.

Never request the root user, administrator access keys, exported credentials,
customer secret values, database dumps, or permanent users.

## Bootstrap architecture

Because CloudFormation/CDK bootstrapping can create broad execution roles, use
two phases:

### One-time customer bootstrap

Customer administrators execute a reviewed template locally or through their
own pipeline. It creates:

- customer ECR repositories with immutable tags, encryption, lifecycle, and
  scan settings;
- a release-import role scoped to those repositories;
- a customer-owned deployment service/CloudFormation execution role constrained
  by permissions boundary and resource/tag policy;
- the exact GitHub OIDC trust and customer-specific environment claim;
- customer deployment/audit log storage and alerting;
- optional time-bound break-glass role, disabled or untrusted by default.

The bootstrap output contains nonsecret ARNs, account ID, region, and allowed
domain/environment. Secret values are generated inside the account.

### Repeatable release deployment

```text
approved vX.Y.Z release
  -> verify tag/signature/attestation/SBOM/notices
  -> GitHub OIDC assumes customer release role
  -> import exact digest into customer ECR
  -> compare imported digest with signed manifest
  -> create constrained change set using explicit account/region/domain
  -> customer production approval
  -> execute change set
  -> customer-owned migration task retrieves secrets internally
  -> health/security/data-boundary probes
  -> signed deployment record
```

The workflow must fail if the requested account, region, environment, tag,
commit, or digest differs from the approved deployment record. It must not
accept `latest`, a branch head, or an arbitrary image override.

## Minimum deployment-role policy properties

- Trust only GitHub OIDC audience `sts.amazonaws.com` and exact immutable
  subject/workflow/environment claims; no wildcard repository owner or branch.
- Session duration is short, sessions are attributable to run/customer/release,
  and CloudTrail records assumption and changes.
- Resource access is scoped by customer account, region, repository, stack
  prefix, and mandatory customer/environment tags.
- Explicit denies cover Secrets Manager value retrieval, KMS decrypt outside
  the release path, S3/DynamoDB/RDS/EFS/Backup data APIs, logs content reads,
  ECS Exec, IAM trust mutation, Organizations, account administration, and
  disabling audit/security services.
- The role cannot pass arbitrary roles or deploy arbitrary templates. Any
  necessary CloudFormation execution role is customer-owned, bounded, and
  allowed to deploy only approved stack artifacts.

The current `ClaudeClawGitHubDeploy` role does not meet the last two properties.

## Domain and callback checklist

For every customer environment set `DOMAIN_NAME` and `CCE_DASHBOARD_URL` to the
same approved HTTPS origin. Verify:

- ACM certificate status and renewal path;
- Route 53/delegated/external DNS records and ownership;
- ALB/CloudFront/WAF origin and health checks;
- CORS upload origins and cookie security/same-site behavior;
- dashboard routes, API calls, and WebSocket upgrades;
- OAuth redirect URIs, magic links, Slack event URL, Telegram webhook, and any
  Salesforce callback;
- no `pgnos.ai`, PGN Cloudflare tunnel, PGN SES identity, or PGN DNS dependency
  appears in the synthesized customer templates or task definition.

## Deployment record

Archive for each customer/environment: customer identifier, AWS account and
region, GitHub run, approvers, release tag, commit, signed upstream digest,
customer ECR digest, SBOM hash, notices hash, change-set ID, stack outputs,
verification result, time, and rollback target. Do not put customer secrets or
business records in the record.

## Offboarding

The customer revokes the OIDC trust and any support role. The signed agreement
must decide continued-use, update, source escrow, backup, and deletion rights;
this technical runbook does not. Customer data and retained resources remain
under the customer's control unless the customer explicitly destroys them.
PGN deletes any non-data deployment metadata according to the agreed retention
schedule.
