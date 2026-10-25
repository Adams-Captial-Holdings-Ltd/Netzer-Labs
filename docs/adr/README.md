# Architecture Decision Records

One file per non-obvious architectural choice. Use these to answer "why did we do X this way?" without having to ask in chat or dig through commit history.

## Format

Each ADR has four sections:

- **Context** — what was true at the time, what tension we were trying to resolve
- **Decision** — what we chose
- **Consequences** — what good and bad things follow from the choice
- **Alternatives considered** — what we said no to and why

Keep ADRs short (1 page). When a decision is reversed, write a new ADR that supersedes the old one. Don't edit history.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-tier-framework.md) | T0–T3 tier framework | Accepted |
| [0002](0002-single-tenant.md) | Single-tenant deploy model | Accepted (revisit for E1 strategic track) |
| [0003](0003-bedrock-inference-profiles.md) | Cross-region inference profiles | Accepted |
| [0009](0009-mission-container-model.md) | Missions become a work container, not a task row | Superseded by [0010](0010-paperclip-work-engine.md) and 0012–0020 (2026-09-29) |
| [0010](0010-paperclip-work-engine.md) | Paperclip is the missions work engine | Accepted (amended 2026-09-29; amended by [0022](0022-netzar-owns-work-state-paperclip-replaced.md)) |
| [0011](0011-chat-regenerate-tie-notice-and-lock-lease.md) | Regenerate tied to the reply shown, the file note as a notice, a lease on the chat lock | Accepted |
| [0012](0012-paperclip-owns-work-state.md) | Paperclip owns work state; pipelines are canonical, key-per-version | Superseded by [0022](0022-netzar-owns-work-state-paperclip-replaced.md) (2026-10-20) |
| [0013](0013-sync-attach-execution-contract.md) | SYNC_ATTACH execution contract and the deterministic-writes rule | Accepted |
| [0014](0014-netzer-only-ai-runtime.md) | Netzer is the only AI runtime; Paperclip runners are disabled and fail closed | Accepted |
| [0015](0015-agentcore-connector-credential-plane.md) | AgentCore is the connector and credential plane; Netzer enforces in v1, Cedar next | Accepted |
| [0016](0016-human-decisions-via-shadow-users.md) | Human decisions are recorded in Paperclip through shadow users; high-impact classes are human by default | Accepted (amended by [0024](0024-netzar-owns-its-workflow-engine.md): approvals move to Netzar for Studio workflows) |
| [0017](0017-netzer-identity-and-work-ui.md) | Netzer identity is authoritative; customers never use the Paperclip UI | Accepted (amended by decision 18; item 6 superseded by [0023](0023-customers-build-workflows.md)) |
| [0018](0018-managed-solution-packs-v1.md) | Managed Solution Packs v1: format, registry and entitlement | Accepted |
| [0019](0019-paperclip-compatibility-program.md) | Paperclip compatibility program | Accepted |
| [0020](0020-worm-audit-and-ledger-cost-authority.md) | WORM compliance record and ledger cost authority | Accepted |
| [0021](0021-pack-format-v1-file-shapes.md) | Pack format v1: the exact file shapes and what `pack validate` enforces | Accepted |
| [0022](0022-netzar-owns-work-state-paperclip-replaced.md) | Netzar owns workflow and work state; Paperclip is replaced | Proposed (WAITING owner yes) |
| [0023](0023-customers-build-workflows.md) | Customers build their own workflows in a conversational studio | Proposed (WAITING owner yes) |
| [0024](0024-netzar-owns-its-workflow-engine.md) | Netzar owns its workflow engine (amends DO NOT BUILD #1) | Proposed (WAITING owner yes) |

0012–0020 record the Work Platform architecture. The plan numbered them 0011–0019 before the chat ADR took 0011; the mapping and every decision behind them are in the [decision log](../features/paperclip/decision-log.md#adr-numbers). The Reversibility and Revisit-trigger lines in those nine ADRs were added by the recorder on 2026-09-29 as process metadata; they classify the approved decisions and change none of them.

## Future ADRs to write (when we touch the related areas)

- 0004 — Deterministic resource naming with `CCE_NAME_SUFFIX` (A3 refactor)
- 0005 — ALB origin-gate two-phase rollout (B1)
- 0006 — EMF over PutMetricData for per-tool metrics (D2)
- 0007 — Manual-dispatch deploy gate as A5 (GitHub Free plan workaround)
- 0008 — Pattern-1 (deploy-per-customer) vs Pattern-3 (multi-tenant refactor)
