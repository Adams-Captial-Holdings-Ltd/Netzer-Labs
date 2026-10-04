# ADR 0017 — Netzer identity is authoritative; customers never use the Paperclip UI

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29; amended by decision 18 of 2026-09-28 and, in roadmap v2, by decisions 20-23 and 28 (amended 2026-09-30)). Plan number 0016; repo number 0017 — [why](../features/paperclip/decision-log.md#adr-numbers).

## Context

Paperclip ships a full SPA, but it has no base path (VERIFIED, `pc:ui/src/api/client.ts:3`) and signs in by email and password. If customers needed it, that would violate Netzer's identity and approval model ([ADR 0016](0016-human-decisions-via-shadow-users.md)); the plan therefore gives customers a Netzer-owned UI instead ([minimum sellable product](../features/paperclip/minimum-sellable-product.md), B7).

## Decision

1. **Netzer identity, authentication and RBAC are authoritative.** Paperclip holds shadow users and least-privilege roles only.
2. **Customers use a Netzer-owned Work UI**, built on Paperclip's API through a Netzer BFF, with capabilities `work:read` and `work:approve`. Four screens in v1 (step 7, the Work UI core):
   - **Work Inbox**: items needing this person: approvals waiting on them, blocked cases (connector, config or failure), cases they own.
   - **Cases**: active workflow instances for the installed packs, filtered by pack, stage and status. A thin list.
   - **Case Detail**: current stage and status, owner (agent or human), key fields, timeline (case events and issue comments), agent activity (turns and tool calls from the Netzer audit), blockers, approvals.
   - **Approvals**: a queue with Approve, Reject and Request Changes, each carrying a comment (required for Reject and Request Changes). It shows the exact action payload being approved.
3. **The Missions page is not the foundation.** The UI is redesigned around Paperclip's work model, and `/missions` redirects to Work Inbox ([step 7](../features/paperclip/minimum-sellable-product.md#build-steps)).
4. **Customers never use the Paperclip SPA.** It is operator-only: sign-up disabled, telemetry off. In Netzer's own environments operators reach it over SSM; in customer accounts staff never open it (item 5).
5. **Decision 18 (owner, 2026-09-28) amends item 4 for customer accounts.** Netzer staff never access customer data. In a customer's AWS account they use a limited login that can install, upgrade and remove packs and the platform and can see system health (status, counts, IDs and error codes). They cannot read cases, records, documents, secrets or content-bearing logs, open the Paperclip screens there, or grant themselves more access. Decision 18 replaces "operators over SSM" for customer accounts; the plan does not change it elsewhere. Details and the parts still open (decided in step 8): [decision log](../features/paperclip/decision-log.md).
6. **Roadmap v2 puts the rest of the customer UI before Customer #1** (decisions 20, 21, 23 and 28, 2026-09-29). Besides the four screens of step 7: Active Workflows, Automations, SLA status, customer dashboards and chat notifications (step 10); a read-only flow map of each installed pack, and settings edits limited to the fields a pack flags `customerEditable` (step 10, decision 21); day-to-day admin screens for `effect resolve` and stuck cases (step 10, decision 28); OpenID Connect SSO and staff operator screens over `pack status` (step 11, decision 23); and the pack store with self-install (step 12, decisions 22 and 28). The Workflow Studio, a drag-and-drop pipeline designer plus pipeline and routine editors that export the pack format, is for staff and the owner only, in a Netzer authoring environment (step 9, decision 21). There are no customer-built workflows. This supersedes item 4's earlier list of things kept out of v1 (a designer, dashboards, a pipeline builder, a routine editor).

**Decided by.** Jev: hybrid UI 1.0, then revised to the Netzer Work UI 1.0; four screens 1.0; surface control 1.0. Owner: YES, extended: a Netzer-owned Work UX, Paperclip SPA operator-only, Missions not the foundation. Decision 18: owner, 2026-09-28. Decisions 20-23 and 28: [decision log](../features/paperclip/decision-log.md).

### As built (step 7, 2026-10-04)

- **Capabilities.** `work:read` and `work:approve` exist. Operator, admin, org-admin and owner profiles hold both by default; seat-user, viewer and analyst hold neither (owner, 2026-10-04: cases can hold health information). An approver who is not an operator gets a custom profile holding the two.
- **The BFF** is one router mounted at `/api/work` (`src/adapters/dashboard/work.ts`), seven routes: `GET /status`, `/inbox`, `/cases`, `/cases/:caseId`, `/approvals`, `/approvals/:approvalId`, and `POST /approvals/:approvalId/decision`. Gate order: 401, then 403 `forbidden` with the capability named, then 503 `work_disabled` (flag `CCE_PAPERCLIP_ENABLED` off), then 503 `paperclip_disabled` (kill switch). `/status` needs a valid token only. The wire contract is one-way (owner, 2026-10-04) and is pinned by `src/adapters/dashboard/work.test.ts`.
- **The acting person comes from the session only.** The decide route passes `principal.userId` to the approvals library and reads no user id from the request. A token with no user session (a root or service token) is refused with `no_user_session`.
- **The payload shown is the payload that was hashed.** When an approval is requested, its canonical JSON is stored once in the effect ledger table (`PK = CASE#<caseKey>`, `SK = PAYLOAD#<stage>#<step>#<stageEntryNo>`). The approval screen shows that stored content only when its SHA-256 equals both the stored hash and the hash on the Paperclip approval; otherwise it shows no content and no decide form. The decide request carries the hash that was on screen and is refused as `stale_payload` if the approval has changed.
- **Paperclip reads** (`src/lib/work/work-reads.ts`) are shape-checked. A malformed record, or an approval that is not a Netzer approval, is dropped and counted in one log line, `work_read_failed`, which carries codes and counts only. Internal ids (lease owner, Paperclip user ids) never leave the server.
- **The web app** has five routes under `/work` (Inbox, Cases, Case, Approvals, Approval). The Work section and the `/missions` redirect appear only when `/api/work/status` says Work is on; otherwise the Missions page renders as before. Approve opens a plain confirm at every screen size; Reject and Request changes need a comment. Toasts, the tab title and URLs carry no case content. The design rules are in [`design.md`](../../design.md) (locked for step 7; see its status line) and the product context in [`PRODUCT.md`](../../PRODUCT.md).
- **Not built here:** agent activity on Case Detail (item 2 lists it; it needs the executor on the dispatch path, A140, so it comes with step 8 or later); key fields chosen by a pack (step 8); notifications and where an approver lands after sign-in (step 10). No pack or case exists in any environment until step 8, so the screens are proven against fixtures and the live reads are pending (S7-L1 to S7-L3).
- **Known limit.** The case list reads one case detail per listed case to learn its blockers (the pinned list route does not carry them): at most 200 upstream reads per request. A bulk blockers read or a short cache replaces it when volume needs it.

## Consequences

Good: identity and approvals cannot diverge from Netzer's, and customers get one product surface.

Bad:

- Netzer builds and owns the Work UI screens and a BFF: four in step 7, more in steps 10-12.
- The pipeline designer and the pipeline and routine editors are staff-only (the Workflow Studio, step 9). Customers get a read-only flow map and a pack's `customerEditable` settings, not customer-built workflows (decision 21).

- **Reversibility:** one-way. The identity model and the core customer UX are the product surface customers will use.
- **Revisit trigger:** a customer asks to build their own workflows (decision 21) or needs SAML-only SSO (decision 23), or another customer requirement the Work UI screens cannot meet.

## Alternatives considered

- **Hybrid UI.** Jev's first pick (1.0), revised to the Netzer Work UI (1.0); owner: YES, extended.
- **The Missions page as the foundation.** Rejected by the owner.
- **A customer-facing Paperclip SPA or a board bridge.** Rejected: [DO NOT BUILD](../features/paperclip/do-not-build.md). Paperclip cannot be served under a base path.
