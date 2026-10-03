# ADR 0013 — SYNC_ATTACH execution contract and the deterministic-writes rule

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29; touched by decisions 18, 30, 36 and 38). Built in step 4 on the branch `feature/wp-step4-execution-contract`; not merged or deployed. Plan number 0012; repo number 0013 — [why](../features/paperclip/decision-log.md#adr-numbers).

## Context

Today Paperclip marks a run "succeeded" the moment Netzer answers its dispatch, which causes duplicate AI work (VERIFIED in source). Two blockers cannot be manual ([minimum sellable product](../features/paperclip/minimum-sellable-product.md), section A): correct execution semantics, and retry-safe business actions. An AI retry must never create a second EHR record or a second calendar booking.

Jev first chose NATIVE_ASYNC_MONITOR (1.0), then **revised to SYNC_ATTACH (1.0)** after the owner made true run states a blocker.

What Paperclip does, read at the plan and then MEASURED at v2026.916.1 in a sealed local container (2026-10-03, spike A120): the http adapter never reads the response body; a non-2xx answer marks the run failed and the issue blocked, and Paperclip never sends that dispatch again. A retry gets a new run id plus `context.retryOfRunId`. One issue has one run at a time. A `done` written before the 2xx causes no follow-up run, and a comment-only write makes Paperclip run the job a second time. A late write with the ended run id is accepted. Where the plan-time source read and the measurement differ (for example, a failed run is not re-sent), the measurement wins; it is re-measured at every digest bump.

What Netzer did before step 4 (checked at 29309c8): `tryClaimOnce` had neither a renewable lease nor a fencing token and recorded no holder; the dispatch route answered 202 `agent_not_enabled` and 503 `paperclip_disabled`, which forged outcomes; shutdown force-exited after 28 s.

## Decision

**SYNC_ATTACH.** Dispatch is held open for one execution attempt.

- **Outcome.** 2xx comes back only after the outcome is written to Paperclip with the run id of a dispatch that is attached at that moment. Failure returns non-2xx with an `error` code (Paperclip never reads the body; it is for logs and tests):

  | Code | Status | When |
  |---|---|---|
  | `cost_cap` | 402 | the cost cap is reached |
  | `model_access` | 503 | the kill switch is on, or Bedrock access or availability failed |
  | `connector_auth` | 502 | Paperclip refused our credential or run |
  | `agent_failed` | 500 | any other failure of the turn |
  | `attempt_in_progress` | 409 | a genuine new wake while an attempt runs |
  | `attempt_timeout` | 504 | the hold cap passed |
  | `lease_lost` | 409 | this holder was fenced out |
  | `delivery_failed` | 502 | the completion write failed in a way that proves it was not applied; the outcome is kept |
  | `delivery_unknown` | 500 | the completion write got no answer, or its lease expired mid-write; never retried blind |
  | `agent_blocked` | 409 | a guardrail blocked the turn; the notice was delivered as a comment |
  | `draining` | 503 | SIGTERM was received |
  | `attempt_store_unavailable` | 503 | the attempt row could not be read or written |
  | `agent_not_enabled` | 409 | the agent is not armed |

  The route checks the bearer secret first (401), then the runtime lock (503 `paperclip_locked`), then draining. The 202 `agent_not_enabled` reply, the 503 `paperclip_disabled` reply and the kill-switch pre-check are removed.
- **Attempt identity** is one attempt row per issue: `PK = ATTEMPT#<issueId>` in the existing queue-lease table (no new table). It holds `attemptNo`, `state` (`running`, `recorded`, `delivering`, `delivered` or `failed`), a fencing `leaseToken`, the `holderId`, the lease expiry, the run ids that started or attached to it (at most 20), the recorded outcome and a `version` used for compare-and-set. A dispatch belongs to the attempt when its run id or its `context.retryOfRunId` is on the row. This REPLACES the earlier wording `(issueId, wake cause/revision)`: the measured Paperclip context carries no revision, so the retry link is the key. A dispatch that belongs attaches to the running attempt or gets its recorded result; any other dispatch is a genuine new wake and starts the next attempt (or answers 409 `attempt_in_progress` while one runs).
- **Leases** are renewable and fenced. The lease is 30 s, renewed every 10 s. Every holder write checks the attempt number, the token and the holder, then compare-and-sets on `version`; a stale holder writes nothing and its request ends 409 `lease_lost`. A store error fails closed (503 `attempt_store_unavailable`): running without the row would break "one execution". A task that finds an expired lease takes the attempt over with the token plus one.
- **Hold cap.** `ATTEMPT_HOLD_MS` is 240 s per request. If the attempt still runs then, the request ends 504 `attempt_timeout`; the holder keeps working and delivers the outcome late. The agent's adapter `timeoutMs` is 270 000 (it was 10 000).
- **Completion writer.** The outcome is recorded on the row before any delivery is tried. Delivery is one call with `X-Paperclip-Run-Id` set to the newest attached run id: `PATCH /api/issues/:id { status: "done", comment }` for a normal reply. A guardrail-blocked turn posts the notice as a comment and the attempt ends 409 `agent_blocked`, so Paperclip marks the run failed and the issue blocked; Netzer does not set the status, because a bare `blocked` or `in_review` PATCH is rejected 422 by Paperclip at this pin. The 2xx is written only after the row says `delivered`.
- **`pending_dispatch` sweep.** Every 5 minutes, under one runner lease, the sweep delivers each recorded outcome older than 60 s, ends an in-flight write whose lease expired as `delivery_unknown`, and writes one error log when an outcome stays undelivered for 15 minutes. Paperclip does not re-send a failed dispatch (measured), so the sweep is what delivers an outcome whose request is gone.
- **SIGTERM.** The route answers 503 `draining` first (new starts and attaches); attempts this task holds keep running until the 28 s backstop. While a task holds an attempt it sets ECS task scale-in protection (`ecs:UpdateTaskProtection`), and clears it when the last attempt ends. A failed protection call is a warning, never a failed attempt.
- **Held-request limit and the fixed address (decisions 30, 34 and 38).** Step-2 spike (a) measured it on 2026-09-30: at v2026.916.1 a dispatch to a hostname is cut at 30 s, and one to a raw private IP at about 302 s; raw-IP holds of 240 s and 280 s succeed. So the dispatch goes to a raw private IP and attempts are capped at 240 s; longer work continues through a new wake. The fixed address is an internal Network Load Balancer in front of the orchestrator's private port 3001 (decision 38). Its first private IP is looked up at deploy time and added to Paperclip's adapter allowlist next to the interim DNS origin (decision 34), and the bootstrap script is given it as the dispatch URL. The load balancer's default 350 s TCP idle timeout is relied on (it is above the 240 s hold). The single looked-up IP sits in one zone; if that zone fails, the operator re-points it (accepted). There is no Paperclip patch. If a digest we must take closes the raw-IP path, the named fallback is a two-line `responseTimeoutMs` patch on the http adapter: an ADR 0019 last resort, with an upstream issue.
- **Waits and pauses.** A wait ends the attempt as `blocked` or `in_review` with a durable wait path. Pause is done by disabling routines and agents, never by 202 or 503 replies, which would forge outcomes; those replies are removed.

**Deterministic writes only.** Business writes happen only in deterministic L1 steps. AI (L2) steps read, analyze, recommend and draft. (L1 tool action: deterministic, idempotent, effect ledger. L2 agent task: LLM, no writes. L3 workflow: a Paperclip pipeline whose stages spawn L1 and L2 issues and whose review stages wait on humans.)

- **Effect ledger.** The key is `(caseKey, stage, step, stageEntryNo)`, using the ingest `caseKey`; it survives Request Changes rounds and database restores. A retry returns the recorded result.
- **Paperclip writes** (transition, review, comment) are ledgered too, with read-before-retry.
- **Unknown outcomes** go to `blocked: verify`, never a blind retry. `pack effect resolve` clears them; in a customer's AWS account, `effect resolve` decisions are the customer admin's (decision 18).

**Decided by.** Jev: SYNC_ATTACH 1.0 (revised from NATIVE_ASYNC_MONITOR 1.0 after the owner requirement), writes only in deterministic steps 0.99, deterministic actions 0.98, issue claim 0.91. The blindspot review folded in the effect-ledger key, Paperclip-write coverage, attempt identity, lease fencing, the SIGTERM drain, the fetch-limit spike and removal of the forging replies. Decision 30 (owner, 2026-09-30, after Jev was unsure at 0.63 and the council voted 4 of 4): the dispatch goes to a raw private IP. Decision 36 (owner, 2026-10-02): with the flag off the lock closes (ADR 0014). Decision 38 (Jev 0.92 and the owner, 2026-10-03): the fixed address is an internal Network Load Balancer. In step 4 Jev also chose the attempt row (0.92), a normal reply as `done` (1.0), a blocked turn as notice then error (0.95), and, after the spike, that the sweep delivers (1.0).

## Consequences

Good: run states are true, a duplicate dispatch executes once, and no AI retry can double-write.

Bad:

- Held-open dispatch across restarts is the top risk (High). Mitigation: attach semantics, lease takeover and live restart proofs (step 4).
- The internal load balancer adds about $16 to $20 a month per deployment.
- **Proved locally (step 4):** the attempt row, fencing, the held route, the completion writer, the sweep, drain and the CDK synth, by hermetic tests; and the Paperclip behavior in the Context, measured in a sealed local container.
- **PENDING on staging, not proved:** a restart or deploy mid-attempt and scale-in protection; the 45 s and 250 s holds through the load balancer; a Paperclip restart mid-attempt. These run at the staging trip, never in this repository's tests.
- Agent writes outside a run (A109, A119) are step 5's, not this contract's.
- Unknown-outcome writes stop for an operator instead of retrying (High); the effect ledger records them as `unknown`.
- The held-request limit is measured, not assumed (decision 30), and the raw-IP path is re-proved at every digest bump. Failure behavior is specified in the [failure-handling matrix](../features/paperclip/minimum-sellable-product.md#j-minimum-testing-gate).

- **Reversibility:** two-way before the first live pack run; one-way after, because the effect-ledger key is a persisted schema that customer data depends on.
- **Revisit trigger:** the per-digest-bump hold test (a 45 s and a 250 s held response through the real hop to a raw private IP) fails at a digest that must be taken. Spike (a) failed as written on 2026-09-30, for a hostname; decision 30 is the rework.

## Alternatives considered

- **NATIVE_ASYNC_MONITOR** (Jev's first choice, 1.0). Revised away when the owner made true run states a blocker.
- **Forging 202 or 503 replies to pause work.** Rejected: they forge outcomes. Pause by disabling routines and agents.
- **AI steps that write.** Rejected: writes only in deterministic steps (Jev 0.99), so a retry cannot double-write.
- **Blind retry of an unknown-outcome write.** Rejected: `blocked: verify`.
- **A hostname for the dispatch address.** Rejected by decision 30: the new pin cuts a hostname dispatch at 30 s.
- **A patch that lifts the http adapter's timeout.** Not taken; held in reserve as the named fallback (ADR 0019 last resort, with an upstream issue).
