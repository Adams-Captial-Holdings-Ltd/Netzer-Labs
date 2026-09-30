# ADR 0014 — Netzer is the only AI runtime; Paperclip runners are disabled and fail closed

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29; amended by decisions 32, 33 and 35). Plan number 0013; repo number 0014 — [why](../features/paperclip/decision-log.md#adr-numbers).

## Context

Paperclip can run agents itself: its native runner, local adapters and remote profiles. Any of them would be a second, ungoverned AI runtime beside Netzer's, which owns the guardrail, cost ledger, audit and tool policy. The plan names the risk as a data leak ([minimum sellable product](../features/paperclip/minimum-sellable-product.md), B3).

`enableNativeRunner` defaults to true and is settable (VERIFIED, `pc:validators/instance.ts:44` @LATEST), so a re-pin or a settings change can switch a runner on silently. The risk register rates "native runner re-enabled by re-pin" High.

## Decision

1. **`runAgentTurn` is the only AI runtime.** Paperclip's native runner, local adapters and remote profiles are off. Pack agents are http-adapter agents that dispatch to Netzer ([ADR 0013](0013-sync-attach-execution-contract.md)); there are no non-http agents.
2. **Fail-closed runtime lock (decision 32).** The Paperclip task's environment locks what can be locked: hidden settings for adapters, plugins and the feedback preference, an http-only adapter list, and telemetry off. The native-runner flag is deliberately not hidden (decision 35): it defaults on in a fresh database and a hidden setting refuses any change, so the operator bootstrap turns it off and the orchestrator reads it. At start and every 60 s the orchestrator reads the five conditions live, through one read-only company-member board key, the **lock auditor** (secret field `lock_auditor_key`; never an agent key, never an instance-admin key): `enableNativeRunner` is off, no agent uses a non-http adapter, no remote profile exists, no tool application or connection exists, and no agent has a timer heartbeat; the health route also lists `instance.adapters` and `instance.plugins` as hidden. There are three outcomes. **Clean** opens the Paperclip surface. **Violated** at start means the orchestrator will refuse to start, so the ECS circuit breaker fails the deploy. **Unknown** (Paperclip unreachable, the key missing or rejected, a response whose shape drifted) lets the process start but closes a latch on the Paperclip surface, which stays closed with a real non-2xx until a later read is clean. The Paperclip client, the reconciler and the private dispatch route all read the latch. A violated check never warns and continues, and an unreadable one fails closed.
3. **Private dispatch.** The dispatch route is served only by a second listener on a private port (3001) that only Paperclip's security group can reach; the public app answers 404 for it in code, because a peer-IP check would fail open behind the tunnel. Paperclip's http adapter may call only that origin (`PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST`), the orchestrator's own Paperclip address from runtime config must be private (loopback, RFC 1918 or `.internal`) and is never followed through a redirect, the bearer is rotated at install and never logged (pino redacts it), and Paperclip telemetry is off (`PAPERCLIP_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false`).
4. The lock is contract-tested at every digest ([ADR 0019](0019-paperclip-compatibility-program.md)), live, with `npm run test:paperclip:contract`.
5. **No cleanup code (decision 33).** The lock fails on any non-http agent, so a Paperclip that already holds built-in agents (the existing staging one) makes the orchestrator refuse to start with a clear code. How such an instance is cleaned is the owner's call; the bootstrap never deletes an agent or a user.

**Decided by.** Jev: Netzer `runAgentTurn` only 1.0, fail-closed checks 1.0, private dispatch 0.93. Verified: `enableNativeRunner` default and settability (above). Jev, 2026-09-30: the live-read architecture with one read-only key 0.98 (decision 32), no cleanup code 1.0 (decision 33), the native-runner flag left unhidden 0.99 (decision 35). Jev scored "this fully satisfies the ADR" only 0.44, so the residuals below are listed rather than hidden.

## Consequences

Good: one runtime means one place for guardrails, cost and audit, and a re-pin cannot quietly add a second one.

Bad:

- No Paperclip feature that executes agents is available to packs.
- Every digest bump must re-prove the lock, and a red check blocks the deploy.
- Residuals: tool gateways are not read at start; a violation that appears while running is caught within 60 s, not instantly; `company.import` is not floored (pack install may use it, and the adapter allowlist alone may not stop it); the native-runner flag has no prevention, only detection; until the bootstrap has made the auditor the verdict is unknown and the surface stays closed.
- The auditor key is rotated by hand: clear `lock_auditor_key` to `REPLACE_ME` in the Paperclip secret and run the bootstrap, which creates a new auditor. The old auditor stays an inert read-only member until an operator removes its membership, and a failed secret write after the auditor was created leaves the same kind of orphan.

- **Reversibility:** two-way. The lock is settings plus checks.
- **Revisit trigger:** a digest bump changes the default or meaning of any locked setting (the contract suite goes red), makes any of the auditor's reads admin-only, or adds an env default for the native-runner flag (then hide it too); or the first staging deploy shows a false `violated`.

## Alternatives considered

- **Paperclip's native runner for some agents.** Rejected: a second AI runtime ([DO NOT BUILD](../features/paperclip/do-not-build.md)).
- **Local adapters or remote profiles.** Rejected for the same reason.
