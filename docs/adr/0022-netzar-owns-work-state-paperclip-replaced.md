# ADR 0022 — Netzar owns workflow and work state; Paperclip is replaced

**Status:** Proposed — WAITING owner yes on this text. The decision it records is the owner's (grill 1, 2026-10-20; retirement timing grill 2, 2026-10-23). Supersedes [ADR 0012](0012-paperclip-owns-work-state.md); amends [ADR 0010](0010-paperclip-work-engine.md) for Studio workflows.

## Context

[ADR 0012](0012-paperclip-owns-work-state.md) made Paperclip the owner of workflow definitions, cases, triggers and SLA timers, with pipelines as the canonical engine. The Netzar Studio rebuild ([blueprint v2](../features/netzar-studio/blueprint.md#3-decisions-kept-from-v1-grill-1)) changes the product: a person describes a business process in chat and Netzar drafts, tests, publishes and runs it. The [PRD](../features/netzar-studio/foundation/PRD.md#23-existing-architectural-conflict) (section 2.3) calls out the conflict: the accepted record gives canonical workflow state to Paperclip, and the approved direction needs a Netzar-owned workflow system. FR-030: Netzar replaces Paperclip through a verified migration.

Missions still run on Paperclip today, and the step 6 approvals library (`src/lib/work/approvals.ts`) records decisions in Paperclip through shadow users ([ADR 0016](0016-human-decisions-via-shadow-users.md)).

## Decision

1. **Netzar is the single authority for workflow and work state**: workflow definitions and versions, runs, run state, triggers and approvals for Studio workflows. Paperclip is replaced.
2. **Paperclip keeps running for Missions until the January migration** (NZR-37). Until then the Paperclip-backed approvals (`src/lib/work/approvals.ts`, shadow users, ADR 0016) keep working unchanged; nothing in this ADR switches them off.
3. **One authority marker per workflow** during migration: `paperclip` or `netzar` (PRD 2.3). Dual writes are allowed only for comparison, with one side declared non-authoritative and unable to trigger business effects.
4. Paperclip is retired only after the migration is verified (NZR-37). What Missions become after Paperclip is open (owner Q94, decided in NZR-37).

**Decided by.** Owner, 2026-10-20 (grill 1, blueprint v1 accepted, commit `1e0ebde`): Q2 and Q10, "Paperclip: replaced". Owner, 2026-10-23 (grill 2): Q72, retirement moves to January. Source: [blueprint v2 section 3](../features/netzar-studio/blueprint.md#3-decisions-kept-from-v1-grill-1) and [section 2](../features/netzar-studio/blueprint.md#2-what-changed-in-v2-grill-2). The owner has not yet said yes to this ADR text.

## Consequences

Good: one authority per workflow, owned by the product that drafts and runs it; no second engine to keep in sync after January.

Bad:

- Netzar must build what Paperclip gave for free: run state, approvals and timers ([ADR 0024](0024-netzar-owns-its-workflow-engine.md)).
- Two systems run side by side until January, so every workflow needs its authority marker and Missions stay on Paperclip.
- ADR 0012's key-per-version scheme is no longer the plan for Studio workflows; Studio versions are Netzar data (blueprint section 5).

- **Reversibility:** two-way until the first Studio workflow runs live on Netzar (C3); one-way after the NZR-37 migration, because run state and history then live only in Netzar.
- **Revisit trigger:** the NZR-37 migration cannot be verified (a workflow cannot be moved with its history), or the NZR-33 engine spike finds no engine that meets the run-state needs.

## Alternatives considered

- **(a) Keep Paperclip pipelines canonical ([ADR 0012](0012-paperclip-owns-work-state.md)).** Rejected: pipelines are experimental upstream and unversioned, and the Studio's draft → test → publish → activate lifecycle needs versioned workflow data that Netzar controls (Q16).
- **(b) Split for good: Paperclip for Missions, Netzar for Studio workflows.** Rejected: two engines and two sources of case truth forever. Kept only as the temporary state until January (item 2).
- **(c) Netzar is the single authority; Paperclip retired after migration.** Chosen.
