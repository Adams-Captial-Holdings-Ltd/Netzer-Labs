# ADR 0023 — Customers build their own workflows in a conversational studio

**Status:** Proposed — WAITING owner yes on this text. The decision it records is the owner's (grill 1, 2026-10-20). Supersedes [ADR 0017](0017-netzer-identity-and-work-ui.md) item 6's "There are no customer-built workflows" and decision 21 of the [Paperclip decision log](../features/paperclip/decision-log.md). ADR 0017 items 1-5 stay accepted.

## Context

ADR 0017 item 6 and decision 21 made the Workflow Studio a staff and owner tool (a drag-and-drop pipeline designer in a Netzer authoring environment); customers got a read-only flow map and the pack fields flagged `customerEditable`. ADR 0017 named its own revisit trigger: "a customer asks to build their own workflows (decision 21)".

The Netzar Studio rebuild makes that the product ([blueprint v2](../features/netzar-studio/blueprint.md#3-decisions-kept-from-v1-grill-1)): a person with no coding knowledge describes a business process in chat and gets a correct, understandable, testable workflow (blueprint section 1). The reference user has never heard the word "workflow" (Q98).

## Decision

1. **Customers build workflows by describing them** in a conversational studio: describe → draft → plain-language preview → sample-data test, inside the Workspace (Q1).
2. **A validator and an approval gate guard activation.** A workflow is versioned data: Draft → Test → Publish (frozen) → Activate (needs approval) → Monitor → one-click rollback (Q16). Nothing a customer drafts runs live until it validates and an authorised person approves its activation.
3. **The staff studio, the visual canvas and packs wait until 2027** (Q1, Q16). Customers do not drag boxes (Q96).
4. ADR 0017's identity, Work UI and staff-access decisions (items 1-5) are unchanged.

**Decided by.** Owner, 2026-10-20 (grill 1, blueprint v1 accepted, commit `1e0ebde`): Q4 "Customers build workflows (supersedes ADR 0017 decision 21)", Q1 (MVP is the conversational Workflow Studio), Q16 (lifecycle; no canvas or packs until 2027). Source: [blueprint v2 section 3](../features/netzar-studio/blueprint.md#3-decisions-kept-from-v1-grill-1). The owner has not yet said yes to this ADR text.

## Consequences

Good: the product is the thing customers asked for, and the revisit trigger ADR 0017 set has fired on purpose rather than by drift.

Bad:

- Customer-written workflows are untrusted input: the validator, sample-data test (write-deny) and activation approval carry the safety that staff authoring used to carry.
- The drafter's quality is now a product risk; it is gated by the live eval (blueprint section 2, Q66; kill rule Q72).
- Pack authoring and the staff Workflow Studio of ADR 0017 step 9 are deferred, not deleted.

- **Reversibility:** two-way until the first customer activates a workflow they built; one-way after, because their workflows and run history then exist as customer data.
- **Revisit trigger:** the drafter stays under 70% on the live eval at a gate (Q72 kill rule), or a customer-built workflow causes an external write that its approval did not cover.

## Alternatives considered

- **(a) Staff-only authoring (decision 21).** Rejected: the MVP is a person describing their own process (Q1, Q4).
- **(b) Customers edit only a pack's `customerEditable` fields.** Rejected: it lets customers tune a workflow but not build one, and packs wait until 2027.
- **(c) Customers build workflows by describing them; a validator and an approval gate guard activation.** Chosen.
