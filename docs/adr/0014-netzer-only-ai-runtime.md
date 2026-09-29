# ADR 0014 — Netzer is the only AI runtime; Paperclip runners are disabled and fail closed

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29). Plan number 0013; repo number 0014 — [why](../features/paperclip/decision-log.md#adr-numbers).

## Context

Paperclip can run agents itself: its native runner, local adapters and remote profiles. Any of them would be a second, ungoverned AI runtime beside Netzer's, which owns the guardrail, cost ledger, audit and tool policy. The plan names the risk as a data leak ([minimum sellable product](../features/paperclip/minimum-sellable-product.md), B3).

`enableNativeRunner` defaults to true and is settable (VERIFIED, `pc:validators/instance.ts:44` @LATEST), so a re-pin or a settings change can switch a runner on silently. The risk register rates "native runner re-enabled by re-pin" High.

## Decision

1. **`runAgentTurn` is the only AI runtime.** Paperclip's native runner, local adapters and remote profiles are off. Pack agents are http-adapter agents that dispatch to Netzer ([ADR 0013](0013-sync-attach-execution-contract.md)); there are no non-http agents.
2. **Fail-closed runtime lock.** Deploy-time and startup checks refuse to run unless the native runner is off, no agent uses a non-http adapter, no remote profile exists, Paperclip tool-access is off, and timer heartbeats are off on pack agents. A failed check stops the deploy or the start; it never warns and continues.
3. **Private dispatch.** The dispatch endpoint is reachable on the private address only, behind an SSRF allowlist; the public route is denied; the bearer is rotated at install and never logged; Paperclip telemetry is off.
4. The lock is contract-tested at every digest ([ADR 0019](0019-paperclip-compatibility-program.md)).

**Decided by.** Jev: Netzer `runAgentTurn` only 1.0, fail-closed checks 1.0, private dispatch 0.93. Verified: `enableNativeRunner` default and settability (above).

## Consequences

Good: one runtime means one place for guardrails, cost and audit, and a re-pin cannot quietly add a second one.

Bad:

- No Paperclip feature that executes agents is available to packs.
- Every digest bump must re-prove the lock, and a red check blocks the deploy.

- **Reversibility:** two-way. The lock is settings plus checks.
- **Revisit trigger:** a digest bump changes the default or meaning of any locked setting (the contract suite goes red).

## Alternatives considered

- **Paperclip's native runner for some agents.** Rejected: a second AI runtime ([DO NOT BUILD](../features/paperclip/do-not-build.md)).
- **Local adapters or remote profiles.** Rejected for the same reason.
- **A warning instead of a fail-closed check.** Rejected: fail-closed checks 1.0.
