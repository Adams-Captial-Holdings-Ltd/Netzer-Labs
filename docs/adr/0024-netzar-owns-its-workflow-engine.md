# ADR 0024 — Netzar owns its workflow engine (amends DO NOT BUILD #1)

**Status:** Proposed — WAITING owner yes on this text. The decision it records is the owner's (grill 1, 2026-10-20; no Temporal, round 5, 2026-10-24). Amends row 1 of [DO NOT BUILD](../features/paperclip/do-not-build.md) and, for Studio workflows, [ADR 0016](0016-human-decisions-via-shadow-users.md) (approvals move to Netzar). Follows [ADR 0022](0022-netzar-owns-work-state-paperclip-replaced.md).

## Context

DO NOT BUILD row 1 forbids a Netzer "workflow engine, state machine, case store, business scheduler, SLA timer engine, approval engine", because Paperclip owned work state ([ADR 0012](0012-paperclip-owns-work-state.md)). ADR 0022 replaces Paperclip as that owner, and Studio workflows must run live on real incoming data ([blueprint v2](../features/netzar-studio/blueprint.md#3-decisions-kept-from-v1-grill-1), section 1). Something Netzar controls has to hold run state and approval waits that outlast a compute session (PRD PR-AC-003). The owner set a C3 spike to choose how (Q12): Step Functions Standard or an own DynamoDB engine.

## Decision

1. **Netzar owns the engine's semantics and run state**: workflow runs, step state, the state machine, the run store and approval gates. These may now be built in Netzar.
2. **The implementation choice is deferred.** Step Functions Standard behind a Netzar interface, or an own DynamoDB engine, is decided in NZR-33 (the spike) and recorded in a later ADR (D9). This ADR does not pick one.
3. **Still forbidden** until a later ADR: a business scheduler and an SLA timer engine. Schedule triggers stay design-only in NZR-13.
4. **Approval rules stay binding** when approvals move into Netzar ([ADR 0016](0016-human-decisions-via-shadow-users.md) items 2-5, [PRD 4.6](../features/netzar-studio/foundation/PRD.md#46-human-approvals)):
   - an approval is bound to the sha256 of the exact payload, and the executor refuses a payload whose hash does not match;
   - the approver is the authenticated session's user, never a value taken from the request body;
   - an AI agent never approves its own action; operator and agent identities never count as approvers;
   - Approve, Reject and Request Changes, with a comment required for Reject and Request Changes; high-impact classes are human by default.
5. Paperclip-backed approvals keep working for Missions until NZR-37 ([ADR 0022](0022-netzar-owns-work-state-paperclip-replaced.md) item 2).

**Decided by.** Owner, 2026-10-20 (grill 1, blueprint v1 accepted, commit `1e0ebde`): Q12, "C3 spike: Step Functions Standard vs own DynamoDB engine, then decide". Owner, 2026-10-24 (grill round 5): Q110, no Temporal. Source: [blueprint v2 section 3](../features/netzar-studio/blueprint.md#3-decisions-kept-from-v1-grill-1) and [section 2b](../features/netzar-studio/blueprint.md#2b-owner-decisions-grill-round-5-2026-10-24-q94-to-q116). The owner has not yet said yes to this ADR text, and reviews item 4's approval rules.

## Consequences

Good: run state and approvals live in the product that drafts the workflow; the engine choice is made on spike evidence, not guessed.

Bad:

- Netzar now carries the engine risk: durable waits, retries and exactly-once effects (the effect ledger, [ADR 0013](0013-sync-attach-execution-contract.md)) are ours to get right.
- Approval security moves from Paperclip's record to Netzar's code, so item 4 must be tested in Netzar, not inherited.
- Until D9, no run code is written against a concrete engine.

- **Reversibility:** two-way until NZR-33's ADR (D9) and the first live run; one-way after, because run state then lives in the chosen engine.
- **Revisit trigger:** NZR-33 finds neither (b) nor (c) can meet the run-state and approval-wait needs, or a schedule or SLA trigger is needed before the later ADR that allows it.

## Alternatives considered

- **(a) Paperclip pipelines, routines and monitors.** Rejected: ADR 0022 replaces Paperclip as the owner of work state.
- **(b) AWS Step Functions Standard behind a Netzar interface.** Open: one of the two options NZR-33 decides between.
- **(c) An own DynamoDB engine.** Open: the other NZR-33 option.
- **(d) Temporal or another external engine.** Rejected: no new dependency, and the owner said no Temporal (Q110: it needs an always-on server and breaks serverless).
