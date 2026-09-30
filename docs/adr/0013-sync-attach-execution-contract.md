# ADR 0013 — SYNC_ATTACH execution contract and the deterministic-writes rule

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29; touched by decision 18). Plan number 0012; repo number 0013 — [why](../features/paperclip/decision-log.md#adr-numbers).

## Context

Today Paperclip marks a run "succeeded" the moment Netzer answers its dispatch, which causes duplicate AI work (VERIFIED in source). Two blockers cannot be manual ([minimum sellable product](../features/paperclip/minimum-sellable-product.md), section A): correct execution semantics, and retry-safe business actions. An AI retry must never create a second EHR record or a second calendar booking.

Jev first chose NATIVE_ASYNC_MONITOR (1.0), then **revised to SYNC_ATTACH (1.0)** after the owner made true run states a blocker.

What Paperclip does (VERIFIED at plan time in the Paperclip source, `pc:`): the http adapter's `timeoutMs` 0 means no timeout and a non-2xx answer marks the run failed (`pc:adapters/http/execute.ts:11-41` @LATEST); the silence watchdog fires at 60 min / 4 h (`pc:recovery/service.ts:80-81`); an active run skips stranded-run recovery; blocked waits have a durable wait path (`pc:recovery/service.ts:857,3544`, and the handoff skip in `pc:successful-run-handoff.ts:97`); the run-id header is not status-checked (`pc:middleware/auth.ts:155-218`).

What Netzer does today (checked at 29309c8): `tryClaimOnce` has neither a renewable lease nor a fencing token and records no holder (`src/lib/state/runner-lease.ts:113`); the dispatch route answers 202 `agent_not_enabled` and 503 `paperclip_disabled` (`src/adapters/dashboard/paperclip-dispatch.ts:154,192`), which forge outcomes; shutdown force-exits after 28 s (`src/index.ts:127`).

## Decision

**SYNC_ATTACH.** Dispatch is held open for one execution attempt.

- **Outcome.** 2xx comes back only after the outcome is written. Failure returns non-2xx with an error code: `agent_failed`, `connector_auth`, `cost_cap` or `model_access`.
- **Attempt identity** is `(issueId, wake cause/revision)`, not the run ID. A genuine re-wake (a comment, an unblock) starts a new attempt. A retry of the same attempt attaches to it or gets its recorded result.
- **Leases** are renewable and carry a fencing token checked on every ledger write; attach and wait work across ECS tasks. On SIGTERM no new L1 write starts, and scale-in protection covers tasks with attempts in progress.
- **Held-request limit.** Node fetch likely gives up after about 300 s (LIKELY; step-2 spike). If confirmed, attempts are capped at about 240 s and continue through a new wake.
- **Waits and pauses.** A wait ends the attempt as `blocked` or `in_review` with a durable wait path. Pause is done by disabling routines and agents, never by 202 `agent_not_enabled` or 503 kill-switch replies, which would forge outcomes; those replies are removed.
- **Completion.** A completion writer (with `X-Paperclip-Run-Id`) and a `pending_dispatch` sweep are part of the contract ([step 4](../features/paperclip/minimum-sellable-product.md#build-steps)).

**Deterministic writes only.** Business writes happen only in deterministic L1 steps. AI (L2) steps read, analyze, recommend and draft. (L1 tool action: deterministic, idempotent, effect ledger. L2 agent task: LLM, no writes. L3 workflow: a Paperclip pipeline whose stages spawn L1 and L2 issues and whose review stages wait on humans.)

- **Effect ledger.** The key is `(caseKey, stage, step, stageEntryNo)`, using the ingest `caseKey`; it survives Request Changes rounds and database restores. A retry returns the recorded result.
- **Paperclip writes** (transition, review, comment) are ledgered too, with read-before-retry.
- **Unknown outcomes** go to `blocked: verify`, never a blind retry. `pack effect resolve` clears them; in a customer's AWS account, `effect resolve` decisions are the customer admin's (decision 18).

**Decided by.** Jev: SYNC_ATTACH 1.0 (revised from NATIVE_ASYNC_MONITOR 1.0 after the owner requirement), writes only in deterministic steps 0.99, deterministic actions 0.98, issue claim 0.91. The blindspot review folded in the effect-ledger key, Paperclip-write coverage, attempt identity, lease fencing, the SIGTERM drain, the fetch-limit spike and removal of the forging replies.

## Consequences

Good: run states are true, a duplicate dispatch executes once, and no AI retry can double-write.

Bad:

- Held-open dispatch across restarts is the top risk (High). Mitigation: attach semantics, lease takeover and live restart proofs (step 4).
- Unknown-outcome writes stop for an operator instead of retrying (High); the effect ledger records them as `unknown`.
- The held-request limit is unproven until the step-2 spike. Failure behavior is specified in the [failure-handling matrix](../features/paperclip/minimum-sellable-product.md#j-minimum-testing-gate).

- **Reversibility:** two-way before the first live pack run; one-way after, because the effect-ledger key is a persisted schema that customer data depends on.
- **Revisit trigger:** step-2 spike (a), a held response of 6 minutes or more through the http adapter, fails. The plan then sends B1 back to Jev for rework before step 4.

## Alternatives considered

- **NATIVE_ASYNC_MONITOR** (Jev's first choice, 1.0). Revised away when the owner made true run states a blocker.
- **Forging 202 or 503 replies to pause work.** Rejected: they forge outcomes. Pause by disabling routines and agents.
- **AI steps that write.** Rejected: writes only in deterministic steps (Jev 0.99), so a retry cannot double-write.
- **Blind retry of an unknown-outcome write.** Rejected: `blocked: verify`.
