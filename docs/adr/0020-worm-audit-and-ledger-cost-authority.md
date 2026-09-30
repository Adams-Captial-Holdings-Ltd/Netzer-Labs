# ADR 0020 — WORM compliance record and ledger cost authority

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29). Plan number 0019; repo number 0020 — [why](../features/paperclip/decision-log.md#adr-numbers).

## Context

A regulated customer needs a compliance trail of every AI turn, tool call and human decision, and a support team needs the same identifiers to diagnose failures, billing disputes and incidents ([minimum sellable product](../features/paperclip/minimum-sellable-product.md), B6). The risk is on both sides: no trail, or PHI locked into a 7-year WORM record.

Netzer's audit path is `writeAuditOrThrow` (`src/lib/audit/audit-writer.ts:414`). Its existing redaction is switch-gated and covers only top-level strings (`src/lib/audit/audit-writer.ts:306-323`), and audit rows land in a 7-year Object Lock bucket (governance mode, tier 2 and above: `infra/lib/storage-stack.ts:306`), so it is not relied on for PHI.

## Decision

1. **Netzer WORM audit rows** are written for every AI turn, tool call and human decision. Human decisions and L1 writes use `writeAuditOrThrow`: it is awaited, the `audit_log_disabled` kill switch cannot suppress it, and it throws when neither audit store accepted the event, so a missing trail is loud instead of silently absorbed. As documented for its existing callers (token and IAM changes), it runs after the mutation persists and does not roll it back (`src/lib/audit/audit-writer.ts:399-414`). Paperclip case events are retained as operational history.
2. **IDs and hashes only.** Audit rows carry no tool arguments and no PHI.
3. **Correlation IDs** (carried in dispatch, audit rows, structured logs and the effect ledger): `deploymentId`, `packId@version`, `pipelineKey`, `caseId`, `stageKey`, `issueId`, `paperclipRunId`, `attemptNo`, `netzerTurnId`, `agentId`, `userId` and `shadowUserId`, `toolCallId` and `effectKey`, `bedrockRequestId`, timestamp and outcome.
4. **Audit rows first, mirror next.** Customer #1 ships with Netzer audit rows; a full mirror of Paperclip case and approval events follows ([step 16](../features/paperclip/minimum-sellable-product.md#build-steps)).
5. **The Netzer ledger is the cost authority.** Paperclip budgets are unused ([DO NOT BUILD](../features/paperclip/do-not-build.md)). Ledger budget partitions per pack and pipeline follow in step 16.
6. **PHI hygiene.** `dataClasses` in `pack.json` may include `PHI` and `42CFR2` (42 CFR Part 2). Every PHI-carrying service is confirmed HIPAA-eligible before the first paid customer. The BAA and staff-access model are in section B10 of the minimum sellable product and decision 18 of the [decision log](../features/paperclip/decision-log.md).

**Decided by.** Jev: WORM compliance 1.0; audit rows first, mirror next 0.93; ledger cost authority 0.91 (and 1.0 in the cross-problem review).

## Consequences

Good: support, compliance, failure diagnosis, billing disputes and incident response all work from the same identifiers, and PHI is not locked into WORM.

Bad:

- The Customer #1 trail does not yet include Paperclip's own events; that is the step-16 mirror.
- As documented for its existing callers, when both audit stores fail `writeAuditOrThrow` throws to the caller after the mutation has already persisted, so the failure is loud but the action is not rolled back.

- **Reversibility:** one-way. Rows are kept for 7 years under Object Lock (governance mode at the base), so nothing sensitive can go in them; that is why they carry IDs and hashes only.
- **Revisit trigger:** step 16 (the event mirror and ledger budget partitions), or counsel's answer on whether the BAA is still required (decision 18).

## Alternatives considered

- **Relying on the existing redaction to keep PHI out of WORM.** Rejected: it is switch-gated, top-level only and lands in 7-year Object Lock.
- **Paperclip budgets or Paperclip's activity log as the cost or compliance record.** Rejected: Netzer's ledger and WORM rows are the authority; Paperclip's history is operational.
- **A full Paperclip-event mirror before Customer #1.** Deferred to step 16.
