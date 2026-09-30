---
feature: paperclip
document_role: decision
status: accepted
observed_at: 2026-09-29
as_of_commit: 29309c8fab1d9b37121aee7d92f0efa0bb30fbc8
---

# Work Platform: DO NOT BUILD

> **Binding.** This list comes from the owner-approved Work Platform plan (2026-09-26) and was recorded on 2026-09-29. Building any item below means superseding the ADR that forbids it (for item 12, changing the owner's constraint), not winning a code review. Check it before starting any build in this feature. Feature home: [README](README.md).

## The list

| # | Do not build | Instead | Recorded in |
|---|---|---|---|
| 1 | Workflow engine, state machine, case store, business scheduler, SLA timer engine, approval engine | Paperclip owns work state: pipelines, routines, monitors and approvals | [ADR 0012](../../adr/0012-paperclip-owns-work-state.md), [ADR 0016](../../adr/0016-human-decisions-via-shadow-users.md) |
| 2 | A second connector plane or credential store | AgentCore Gateway and Identity, and Secrets Manager | [ADR 0015](../../adr/0015-agentcore-connector-credential-plane.md) |
| 3 | Paperclip tool-access | Off. Netzer is the only MCP client | [ADR 0014](../../adr/0014-netzer-only-ai-runtime.md), [ADR 0015](../../adr/0015-agentcore-connector-credential-plane.md) |
| 4 | A second AI runtime (Paperclip runner, local adapters, remote profiles) | Netzer `runAgentTurn` only | [ADR 0014](../../adr/0014-netzer-only-ai-runtime.md) |
| 5 | A Paperclip fork or plugins | A pinned digest with contract tests; a patch only as a last resort | [ADR 0019](../../adr/0019-paperclip-compatibility-program.md), [ADR 0010](../../adr/0010-paperclip-work-engine.md) DL-9 |
| 6 | Executable code in packs | Declarative packs: there is no executable code in packs | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md) |
| 7 | Customer-facing Paperclip SPA or board bridge | The Netzer Work UI | [ADR 0017](../../adr/0017-netzer-identity-and-work-ui.md) |
| 8 | A separate skills store | Skills live in Netzer agent config | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md) |
| 9 | A second agent format | One canonical agent format everywhere | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md) |
| 10 | An online license server as a runtime dependency | A registry check plus a signed license file checked offline (step 8) | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md) |
| 11 | Paperclip budgets for AI spend | The Netzer ledger is the cost authority | [ADR 0020](../../adr/0020-worm-audit-and-ledger-cost-authority.md) |
| 12 | Renaming agent tools | Keep the tool names | Owner constraint (below) |

**Item 12.** The `create_mission` tool is blocked by a raw string in `src/lib/warroom/tool-policy.ts`. The [HANDOFF](HANDOFF.md) records that this block has no test coverage, so renaming a tool fails open silently.

**Related.** The pieces of [missions-engine-plan.md](missions-engine-plan.md) that this record supersedes (B-1 to B-6, 8.5-4, 10-4, 11-2, 12-2 and P0-3b) are marked SUPERSEDED in place.

## Added by later owner decisions (2026-09-28)

These come from the [decision log](decision-log.md), not from the original plan:

- **A remote kill switch or call-home for lapsed customers** (decision 17). A customer who stops paying keeps running the copy they already have. Reselling, redistributing or sublicensing Netzer or a pack is forbidden and the license says so; it is backed by what the plans already do: no source code in customer accounts, signed updates and packs only from Netzer staff, and the per-customer `deploymentId` in logs and audit rows.
- **Staff tooling or logins that can read customer data** (decision 18). In a customer's AWS account, Netzer staff use a limited login that installs, upgrades and removes packs and the platform and shows system health only: status, counts, IDs and error codes. Staff cannot read cases, records, documents, secrets or content-bearing logs, open the Paperclip screens there, or grant themselves more access. `pack status` and alerts show IDs and counts only.

## What this list is not

Section E of the [minimum sellable product](minimum-sellable-product.md#e-defer) is a separate list of things to **defer** until there is revenue (the public marketplace, in-app checkout, customer-built workflows, and so on). A deferral is a sequencing call. Everything on this page is a prohibition.
