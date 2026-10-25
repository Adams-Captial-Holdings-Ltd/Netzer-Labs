# ADR 0012 — Paperclip owns work state; pipelines are canonical, key-per-version

**Status:** Superseded (2026-10-20) by [ADR 0022](0022-netzar-owns-work-state-paperclip-replaced.md). Was: Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29). Plan number 0011; repo number 0012 — [why](../features/paperclip/decision-log.md#adr-numbers).

> **Superseded (2026-10-20).** The owner replaced Paperclip as the owner of workflow and work state (grill 1, Q2 and Q10; retirement in January, Q72). Netzar is the single authority for Studio workflows; Paperclip keeps running for Missions, and its approvals keep working, until the NZR-37 migration. See [ADR 0022](0022-netzar-owns-work-state-paperclip-replaced.md). This ADR is kept so old links resolve. Its history follows, unedited.

## Context

[ADR 0010](0010-paperclip-work-engine.md) made Paperclip the system of record for Missions. The Work Platform plan widens that to managed Solution Packs: a pack plus customer configuration plus connector mapping is deployed to many customers without a fork ([minimum sellable product](../features/paperclip/minimum-sellable-product.md)). That needs exactly one owner of workflow and case state.

Paperclip already ships the parts: pipelines (stages, transitions, review stages), routines (triggers, variables, concurrency) and monitors (`timeoutAt`, `escalate_to_board`). Netzer building its own would create a second workflow engine ([do-not-build](../features/paperclip/do-not-build.md)).

Mechanics that shape versioning (VERIFIED at plan time):

- Pipelines have no definition versioning, and an archived pipeline blocks transitions. So an old key must stay un-archived until it drains; only new ingest moves.
- The teams catalog already imports through Paperclip's portability path (`pc:services/teams-catalog.ts:12-19`). Pipelines and routines are not portable: routines only as recurring tasks.
- Pipelines are marked experimental upstream.

## Decision

1. **Paperclip owns work state**: workflow definitions, cases, stages, transitions, business schedules and triggers, and SLA timers (pipelines, routines, monitors). Netzer's scheduler stays only for personal chat reminders (EventBridge).
2. **Pipelines are the canonical workflow engine.** Packs carry native Paperclip create-pipeline bodies and transitions. That is INTERIM: Netzer contributes pipeline portability upstream ([step 17](../features/paperclip/minimum-sellable-product.md#build-steps)), and the interim files are deleted when it ships.
3. **Key per pack version.** Each pack version installs under its own pipeline key `<pipeline>.v<major-minor>`, with its own routines. Running cases stay pinned to the key they started on, and the Netzer runtime picks the agent-config version from the case's pipeline key in the dispatch context. Rollback moves ingest back; no case is ever deleted.
4. **Exactly one Paperclip company per deployment**: a single-tenant AWS account per customer ([ADR 0002](0002-single-tenant.md); ADR 0010 DL-5).
5. **Ingest routines are forced to `always_enqueue`**, per-agent concurrency is set at install, and timer heartbeats are off on pack agents. Routine concurrency can merge or skip triggers while a run is active (LIKELY), so a two-webhook test proves it.
6. **SLAs** are pack thresholds enforced by Paperclip routines and monitors as timers; staff configure one SLA escalation routine per pack.
7. Every pipeline route Netzer uses is contract-tested at each digest ([ADR 0019](0019-paperclip-compatibility-program.md)).

**Decided by.** Jev: envelope over Paperclip bundles 1.0, key-per-version 1.0, pipelines canonical 0.87, upstream portability 0.89 (lean), SLAs via pack thresholds and Paperclip timers 0.99 and 1.0, scheduling boundary 1.0, one company per deployment 1.0. Owner: YES on upstream portability and on pipelines canonical.

## Consequences

Good: one workflow engine, one source of case truth, and pack upgrades that leave running cases on the key they started on (explicit migration is a manual, documented operation).

Bad:

- Pipelines are "experimental" upstream (risk High), so a digest bump can break a route.
- Old pipeline keys must be kept alive until they drain, so upgrades leave several keys live.
- The interim serialized pipeline and routine bodies must be replaced when upstream portability ships.

- **Reversibility:** two-way until Customer #1 goes live (step 14); one-way after, because case data and pipeline keys then live in Paperclip.
- **Revisit trigger:** upstream ships pipeline versioning or portability (step 17), or a contract-suite failure on a pipeline route at a candidate digest (step 2).

## Alternatives considered

- **A Netzer workflow engine, state machine, case store or business scheduler.** Rejected: [DO NOT BUILD](../features/paperclip/do-not-build.md).
- **Waiting for upstream pipeline versioning.** Not available; it is the later path, and key per pack version is the v1 workaround.
- **Several companies in one Paperclip instance.** Rejected in ADR 0010 DL-5.
- **Netzer's scheduler for business timers.** Rejected: the scheduling boundary puts business schedules and SLA timers in Paperclip.
