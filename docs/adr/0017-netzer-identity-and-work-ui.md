# ADR 0017 — Netzer identity is authoritative; customers never use the Paperclip UI

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29; amended by decision 18 of 2026-09-28). Plan number 0016; repo number 0017 — [why](../features/paperclip/decision-log.md#adr-numbers).

## Context

Paperclip ships a full SPA, but it has no base path (VERIFIED, `pc:ui/src/api/client.ts:3`) and signs in by email and password. If customers needed it, that would violate Netzer's identity and approval model ([ADR 0016](0016-human-decisions-via-shadow-users.md)); the plan therefore gives customers a Netzer-owned UI instead ([minimum sellable product](../features/paperclip/minimum-sellable-product.md), B7).

## Decision

1. **Netzer identity, authentication and RBAC are authoritative.** Paperclip holds shadow users and least-privilege roles only.
2. **Customers use a Netzer-owned Work UI**, built on Paperclip's API through a Netzer BFF, with capabilities `work:read` and `work:approve`. Four screens in v1:
   - **Work Inbox**: items needing this person: approvals waiting on them, blocked cases (connector, config or failure), cases they own.
   - **Cases**: active workflow instances for the installed packs, filtered by pack, stage and status. A thin list.
   - **Case Detail**: current stage and status, owner (agent or human), key fields, timeline (case events and issue comments), agent activity (turns and tool calls from the Netzer audit), blockers, approvals.
   - **Approvals**: a queue with Approve, Reject and Request Changes, each carrying a comment (required for Reject and Request Changes). It shows the exact action payload being approved.
3. **The Missions page is not the foundation.** The UI is redesigned around Paperclip's work model, and `/missions` redirects to Work Inbox ([step 7](../features/paperclip/minimum-sellable-product.md#build-steps)).
4. **Customers never use the Paperclip SPA.** It is operator-only: reached over SSM with named accounts, sign-up disabled, telemetry off. Not in v1, and staying operator or admin only: a designer, dashboards, a pipeline builder, a routine editor.
5. **Decision 18 (owner, 2026-09-28) amends item 4 for customer accounts.** Netzer staff never access customer data. In a customer's AWS account they use a limited login that can install, upgrade and remove packs and the platform and can see system health (status, counts, IDs and error codes). They cannot read cases, records, documents, secrets or content-bearing logs, open the Paperclip screens there, or grant themselves more access. Decision 18 replaces "operators over SSM" for customer accounts; the plan does not change it elsewhere. Details and the parts still open (decided in step 8): [decision log](../features/paperclip/decision-log.md).

**Decided by.** Jev: hybrid UI 1.0, then revised to the Netzer Work UI 1.0; four screens 1.0; surface control 1.0. Owner: YES, extended: a Netzer-owned Work UX, Paperclip SPA operator-only, Missions not the foundation. Decision 18: owner, 2026-09-28.

## Consequences

Good: identity and approvals cannot diverge from Netzer's, and customers get one product surface.

Bad:

- Netzer builds and owns four screens and a BFF.
- Designer, dashboards, a pipeline builder and a routine editor are unavailable to customers.

- **Reversibility:** one-way. The identity model and the core customer UX are the product surface customers will use.
- **Revisit trigger:** Work UI v2 ([step 17](../features/paperclip/minimum-sellable-product.md#build-steps)), or a customer requirement (for example SSO) the four screens cannot meet.

## Alternatives considered

- **Hybrid UI.** Jev's first pick (1.0), revised to the Netzer Work UI (1.0); owner: YES, extended.
- **The Missions page as the foundation.** Rejected by the owner.
- **A customer-facing Paperclip SPA or a board bridge.** Rejected: [DO NOT BUILD](../features/paperclip/do-not-build.md). Paperclip cannot be served under a base path.
