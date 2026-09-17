# Customer-hosted architecture

> Netzer OS is structurally single-tenant: the software factory remains with
> PGN while a customer deployment runs in one customer-controlled AWS account.
> Generic DNS and AWS resources already exist in code, but the commercial
> release/deployment path described here is a target until its P0 controls and
> customer canary are implemented. PGN's `pgnos.ai` Cloudflare overlay is a
> separate demo/staging mode and is not a customer-production dependency.

## Current proven runtime path

```text
Browser
  -> customer DNS or PGN Cloudflare overlay
  -> optional CloudFront/WAF or ALB
  -> ECS Fargate orchestrator
  -> AWS services in the deployment account
       DynamoDB / S3 / Aurora / EFS / Secrets Manager / KMS
       CloudWatch / X-Ray / CloudTrail / Backup
  -> explicitly configured external processors
       Bedrock, Slack, Telegram, Salesforce, search, SES recipients, MCP
```

`infra/bin/app.ts` supplies the current AWS account/region to the stack set.
The data stacks use account-local resources and retention controls. The generic
public path is configured through `DOMAIN_NAME`; `HOSTED_ZONE_ID` and
`HOSTED_ZONE_NAME` support a delegated Route 53 zone, while `ACM_CERT_ARN`
supports operator-managed DNS/certificates. CORS also incorporates
`CCE_DASHBOARD_URL`, and OAuth/magic-link callbacks deliberately use server
configuration rather than request headers.

The PGN overlay in `infra/lib/public-dashboard-access.ts` is intentionally
restricted to `pgnos.ai`, uses an outbound Cloudflare sidecar, requires
`infra-only`, and rejects a nonblank `DOMAIN_NAME`. Those invariants show that
the overlay is separable; they do not make it suitable for a customer.

## Intended commercial path

```text
PGN private GitHub repository
          |
          v
signed, versioned Netzer release
  tag + commit + image digests + SBOM + notices + attestation
          |
          v
approved GitHub Actions job using OIDC
          |
          v
customer bootstrap/deployment role in explicit account and region
          |
          v
customer ECR + customer CloudFormation/CDK-controlled workload
          |
          v
customer DNS/TLS -> customer Netzer application -> customer-owned data
```

No step requires a long-lived customer AWS access key. The customer owns the
OIDC trust, can revoke it, and approves production deployment. CI deploys an
already approved immutable digest; it does not rebuild a moving branch.

## Domain configuration contract

The existing equivalent of the requested `APP_DOMAIN=ai.customer.com` is:

```dotenv
DOMAIN_NAME=ai.customer.com
CCE_DASHBOARD_URL=https://ai.customer.com
```

Choose one certificate/DNS path:

1. Customer Route 53: set `HOSTED_ZONE_ID` and `HOSTED_ZONE_NAME`; deployment
   creates/uses ACM and the DNS record where supported.
2. External/customer DNS: provide an issued regional `ACM_CERT_ARN`, keep DNS
   in the customer's provider, and publish the deployment's target record.

Before customer production, test frontend assets, same-origin API/WebSocket,
OAuth callbacks, magic links, Slack/Telegram callbacks, CORS, cookies,
redirects, ACM renewal, and rollback under the exact customer hostname. The T3
CloudFront path currently performs an apex Route 53 lookup and documents a
manual cutover, so external DNS/delegated-zone support at T3 is a P1 gap.

## External network connections

| Connection | Data sent | Destination owner | Customer control |
|---|---|---|---|
| Amazon Bedrock | Full prompt/context/attachments and model output; cross-region profile may route among AWS regions | AWS under customer's credentials/account configuration | Core model function; customer selects model/regions and can halt via kill switch |
| Slack/Telegram | Messages, identifiers, media, full replies, API credentials | Slack/Telegram | Optional; customer creates credentials and may disconnect/kill outbound posting |
| Salesforce | OAuth tokens, SOQL/query/record payloads | Customer's Salesforce tenant/Salesforce | Optional and customer-configured; kill switch available |
| Search vendors | Search query and API key; query passes the configured PII policy | Selected vendor | Optional; customer provides key, can refuse/redact/disable |
| MCP endpoints | Model-generated arguments and returned tool data | Customer-selected AWS/vendor endpoint | Optional; registry is customer-configured and can be disabled |
| SES/recipients | Email addresses and message content | AWS plus recipient mail systems | Optional; customer sender/configuration and kill switch |
| GitHub release check | Egress IP and timing only | GitHub | Disable with `CCE_UPDATE_CHECK_DISABLED=1`; current defaults point at a stale repo and no real release exists |
| GitHub Actions | Source, CI logs/artifacts, and short-lived deployment actions | PGN GitHub organization/GitHub | Required only for vendor-push deployment; customer may instead operate a verified pull/deploy path |
| npm/public image registries | Requested packages/images and build egress metadata | npm, ECR Public, GHCR | Build-time, plus current X-Ray/optional sidecars; customer can mirror into ECR |
| PGN Cloudflare overlay | Complete encrypted HTTP/WebSocket traffic transits Cloudflare before entering the task | Cloudflare/PGN zone | **Not allowed for customer production**; omit `CCE_PUBLIC_ACCESS` and configure customer DNS |
| Paperclip telemetry | Coarse upstream product usage in the pinned component | Paperclip project | Explicitly disabled by `PAPERCLIP_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` after this audit |

There is no Netzer-owned analytics, license server, Sentry, PostHog, Segment,
Datadog, centralized log sink, shared database, or PGN support API in the
current application source. AWS X-Ray/CloudWatch/CloudTrail are account-local.

## Customer-production invariants

- `CCE_PUBLIC_ACCESS` and PGN Cloudflare values are absent.
- Account ID, region, environment, domain, certificate/DNS path, and release
  digest are explicit deployment inputs and part of the deployment record.
- Customer data resources use customer KMS keys and retention/backups in the
  customer account.
- All optional processors are customer-selected and documented before use.
- Paperclip/vendor telemetry is disabled unless the customer explicitly elects
  otherwise in writing.
- Deployment permission and data-access permission are separate; PGN has no
  standing customer-data role.
