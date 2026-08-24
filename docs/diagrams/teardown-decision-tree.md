<!-- drift-gate: verified against the knowledge-durability hotfix; the new vectors bucket joins the teardown/destroy name lists and, being versioned, routes through the existing empty-and-delete versioned-bucket step; no depicted branch changed -->
# Teardown decision tree

> Teardown inventories everything from CloudFormation, tags, the manifest, and the out-of-band resource catalog, then classifies resources as app-owned (deletable) versus shared account prerequisites (report-only by default), and demands a typed confirmation before destroying anything. Destruction is ordered so encrypted data can still be exported and decrypted on the way out: export offer first, then dependents, then buckets, then secrets on their 7-day window, with KMS key deletion blocked until every encrypted dependent is gone. Some things survive on purpose, most notably the WORM audit-lock bucket, and a break-glass mode still works when the state bucket itself is lost.

```mermaid
flowchart TD
  START["npm run teardown"] --> STATE{"State bucket reachable?"}
  STATE -->|"no"| BREAKGLASS["BREAK-GLASS degraded mode: inventory from CloudFormation + tags + name prefix + catalog only, extra account confirmation, banner: manifest precision unavailable"]
  STATE -->|"yes"| INV["Full inventory: CFN stack resources + tags + manifest + out-of-band catalog (state bucket, lock table, ECR repo, AgentCore gateways, runtime EB schedules, managed policies, Telegram webhook)"]
  BREAKGLASS --> CLASSIFY
  INV --> CLASSIFY["Classify each resource"]

  CLASSIFY --> APPOWNED["APP-OWNED: deletable"]
  CLASSIFY --> SHARED["SHARED PREREQS: OIDC provider, CodeBuild source credential, CDK bootstrap stack"]
  SHARED --> SHAREDGATE{"--delete-shared-prereqs passed?"}
  SHAREDGATE -->|"no (default)"| REPORT["Report-only: unrelated CI may ride on these"]
  SHAREDGATE -->|"yes"| BLAST["Scan dependent IAM roles/projects, print blast radius first"]

  APPOWNED --> CONFIRM{"Typed confirmation: destroy account-id"}
  CONFIRM -->|"mismatch"| XABORT["ABORT, nothing touched"]
  CONFIRM -->|"match"| EXPORT["Offer DDB export to S3 before anything is deleted"]
  EXPORT --> RETAINED["Enumerate RETAIN'd paid resources with costed summary (S3, DDB, secrets, log groups, ECR images, KMS)"]
  RETAINED --> ORDERED["Ordered pre-destroy deletion: empty + delete versioned app buckets (state bucket waits for the final sweep), then schedule-delete secrets (7-day window)"]
  ORDERED --> SCHEDDEL["Delete runtime EB schedules BEFORE their CDK-owned group's stack"]
  SCHEDDEL --> POLICIES["Delete catalog app-owned managed policies + AgentCore gateways"]
  POLICIES --> DESTROY["cdk destroy --all (stack list from LIVE CFN + manifest, direct DeleteStack fallback for stacks absent from current synth)"]
  DESTROY --> KMSGATE{"All encrypted dependents gone AND operator opts into cryptographic erasure?"}
  KMSGATE -->|"no"| KMSKEEP["KMS keys kept, exact dependents printed"]
  KMSGATE -->|"yes"| KMSDEL["Disable keys + schedule deletion (7-30 day window)"]
  KMSKEEP --> WORM
  KMSDEL --> WORM["WORM residuals: audit-lock bucket is an INTENTIONAL residual (governance retention to 2555d), bypass-governance instructions + ongoing cost printed"]
  WORM --> SWEEP["Final sweep: print residuals + manual checklist (Slack app, Bedrock model access, Telegram bot)"]
```

## Legend

- Diamonds are operator decisions; the typed confirmation requires literally typing `destroy <account-id>` so a wrong-account teardown cannot happen on muscle memory.
- The three bootstrap primitives (state bucket, deploy-lock table, private ECR repo) are owned by teardown, not `cdk destroy`, because they were created outside CDK.
- KMS keys are treated as DEPENDENCIES, not leftovers: deleting a key before its encrypted data is exported is cryptographic erasure, so the gate defaults closed.
- Break-glass exists so a lost state store never strands paid resources; deploy and rollback hard-require state, only teardown degrades.
- Status: `scripts/teardown.ts` is fully implemented (with `scripts/lib/lifecycle/teardown-plan.ts` and `teardown-plan.test.ts` coverage); this diagram depicts the flow that code executes.
- `npm run teardown -- --help` answers before any of this starts (`scripts/lib/help.ts`, shared by every lifecycle CLI): asking for help never reaches the inventory, the confirm, or any mutation.
- Sources: `scripts/teardown.ts`, `scripts/lib/lifecycle/teardown-plan.ts`, `scripts/lib/lifecycle/bootstrap-state.ts`, `infra/lib/storage-stack.ts` (Object Lock + RETAIN policies).
