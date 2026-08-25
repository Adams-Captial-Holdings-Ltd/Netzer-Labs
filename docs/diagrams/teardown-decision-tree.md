<!-- drift-gate: verified against ADR 0010 Phase 9; no depicted flow changed. The `scripts/lib/lifecycle/teardown-plan.ts` change moves CCE-Database, CCE-Filesystem and CCE-Paperclip out of the CCE_PAPERCLIP_ENABLED conditional and into ALWAYS_ON_STACK_SUFFIXES, because the app now constructs all three at every tier. This list only chooses the DESTROY METHOD (cdk destroy vs direct DeleteStack), never WHAT is destroyed - that still comes from live CloudFormation plus the manifest, which is the branch this tree depicts and which is unchanged. The change makes the depicted "in the current app?" test answer yes for a live Aurora stack in every configuration, including an install that has since dropped to Tier 0 while its RETAIN'd, deletion-protected cluster is still alive - direct DeleteStack cannot delete that cluster. Prior verification: Phase 1.5 turned teardown.ts's final sweep of the cloud-build primitives into a loop over both ECR repo names. -->
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
- The SES `netzar-magic-link` configuration set and its ops-alerts event destination are created **out of band** (CLI, like the AgentCore gateways) and are not in the out-of-band catalog, so teardown neither inventories nor deletes them. They read the logs CMK via its `AllowSES` grant, so scheduling that key for deletion silently breaks bounce/complaint delivery before the config set itself is gone. Delete the event destination by hand, or expect it in the final-sweep residuals.
- Break-glass exists so a lost state store never strands paid resources; deploy and rollback hard-require state, only teardown degrades.
- Status: `scripts/teardown.ts` is fully implemented (with `scripts/lib/lifecycle/teardown-plan.ts` and `teardown-plan.test.ts` coverage); this diagram depicts the flow that code executes.
- `npm run teardown -- --help` answers before any of this starts (`scripts/lib/help.ts`, shared by every lifecycle CLI): asking for help never reaches the inventory, the confirm, or any mutation.
- Sources: `scripts/teardown.ts`, `scripts/lib/lifecycle/teardown-plan.ts`, `scripts/lib/lifecycle/bootstrap-state.ts`, `infra/lib/storage-stack.ts` (Object Lock + RETAIN policies).
