# ADR 0016 — Human decisions are recorded in Paperclip through shadow users; high-impact classes are human by default

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29; touched by decision 18). Plan number 0015; repo number 0016 — [why](../features/paperclip/decision-log.md#adr-numbers).

## Context

Approvals are Paperclip's record of who allowed what, but Paperclip approvals are board-only. If Netzer approved on a person's behalf under a shared or operator account, the record would misidentify the approver, and a person could approve one action while another executes ([minimum sellable product](../features/paperclip/minimum-sellable-product.md), B5).

VERIFIED at plan time: board API keys are bound to a user (`board_api_keys.user_id`).

## Decision

1. **Each approver gets a headless Paperclip shadow user** with its own board key. The Netzer BFF writes to Paperclip as that shadow user: `approvals/:id/approve|reject`, or the pipeline `review` with `approve|reject|request_changes`. Netzer stays the identity authority ([ADR 0017](0017-netzer-identity-and-work-ui.md)). Creation, membership and key minting are proven by the step-2 spike (b). Keys live in Secrets Manager. Rotation and RBAC sync are a staff runbook for ten or fewer approvers. In a customer's AWS account, what staff may do is set by decision 18 ([ADR 0017](0017-netzer-identity-and-work-ui.md)). There is no delegation engine in v1.
2. **Every decision carries** the approver (a real person via the shadow user), a timestamp, a comment (required for Reject and Request Changes), the case and stage, and a Netzer audit row with the Netzer user ID, shadow ID, decision class and correlation IDs ([ADR 0020](0020-worm-audit-and-ledger-cost-authority.md)). The decisions are Approve, Reject and Request Changes.
3. **Frozen payload.** AI output is persisted once per `(case, stage, round)` and is never regenerated after approval is requested.
4. **Hash-bound approval.** The approval carries the sha256 of the exact L1 payload. The executor checks that hash and that `decidedByUserId` is a shadow user entitled to the decision class. Operator accounts never count.
5. **High-impact decision classes are human by default.** They need human sign-off unless the customer approved an automated-decision policy for that class (owner rule). Classes are declared as `decisionClasses` in `pack.json`; high-impact classes default to `human_required`. A customer exception is a recorded sign-off plus a config flag set by staff.
6. **Drift.** A reconcile job compares shadow users with Netzer identity and fails closed on mismatch.

**Decided by.** Approver identity: Jev split 0.57 to 0.43, so the owner decided: shadow users. Human gates: Jev 0.74, then the owner said YES with the rule in item 5. The blindspot review added the hash binding. Verified: `board_api_keys.user_id`.

## Consequences

Good: the Paperclip record names the real person, and changing the payload after approval invalidates the approval.

Bad:

- Shadow-user sync can drift (Med). The reconcile job fails closed.
- The shadow-user lifecycle is unproven until spike (b) (sign-up closed, create, membership, board key, approve, revoke).

- **Reversibility:** two-way before approvals are recorded for a customer; one-way after, because approval records and attribution then live in Paperclip.
- **Revisit trigger:** spike (b) fails at LATEST. The plan then sends B5 back to Jev for rework before step 4.

## Alternatives considered

- **Approvals recorded under an operator or board account.** Rejected: it misidentifies the approver, and operator accounts never count.
- **Automated approval of high-impact decisions by default.** Rejected: human sign-off unless the customer's policy says otherwise.
- **A Netzer delegation engine.** Not built in v1.
- The plan records Jev's 0.57 to 0.43 split and the owner's choice of shadow users; it does not name the losing option.
