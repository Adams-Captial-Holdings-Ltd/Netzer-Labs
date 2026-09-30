# ADR 0015 — AgentCore is the connector and credential plane; Netzer enforces in v1, Cedar next

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29). Plan number 0014; repo number 0015 — [why](../features/paperclip/decision-log.md#adr-numbers).

## Context

Solution Packs act on customer systems (EHR, Jira, Microsoft 365). Every such call needs a connector, a credential and a policy check. Doing that twice (in Paperclip and in Netzer) would create a second connector plane and a second credential store ([do-not-build](../features/paperclip/do-not-build.md)). Without policy on the tool call, an agent could take dangerous actions ([minimum sellable product](../features/paperclip/minimum-sellable-product.md), B4).

VERIFIED at plan time: Paperclip has no policy-only endpoint. In AgentCore, the request interceptor runs before Cedar and can pass request headers through (`passRequestHeaders`, AWS docs). Approvals expose their payload and can be read by ID.

## Decision

1. **AgentCore Gateway and AgentCore Identity are the connector and credential plane.** Homes (no duplicates): OAuth tokens live in the AgentCore Identity token vault; API keys live in Secrets Manager, referenced by the Gateway target; MCP credentials live in the Gateway target's auth; AWS credentials are IAM roles only; Paperclip's own database and auth secrets and the per-user board keys live in Secrets Manager. Packs and the registry hold names only.
2. **Netzer is the sole MCP client** and holds the only IAM role that can invoke the Gateway. Gateway targets are scoped to the pack's capabilities.
3. **v1: policy is enforced in Netzer**, before Cedar: a per-agent-role tool allowlist from the pack; write-deny for AI steps, including `paperclip_add_comment` and `paperclip_create_subtask`; approval-verified gated steps ([ADR 0016](0016-human-decisions-via-shadow-users.md)); `allowedAgents` enforced. Built-in tools fall under the same policy.
4. **Cedar next** ([step 12](../features/paperclip/minimum-sellable-product.md#build-steps)): an AgentCore request interceptor plus Cedar policies as defense in depth, with approvals verified at the Gateway. Approvals are verified directly, not through a Paperclip policy endpoint.
5. **Connector requirements.** `connectors.json` declares each capability with scopes and tool aliases (for example `ehr.client.search → <target>__searchClient`). `pack preflight` probes each Gateway target with `tools/list` for the aliased tools and prints READY or MISSING. Activation is refused while any mandatory capability is MISSING.
6. **Duplicate connectors are retired.** Existing Netzer vendor tokens (Slack, Salesforce) move to AWS, and `salesforce_record` retires ([step 16](../features/paperclip/minimum-sellable-product.md#build-steps)).
7. Paperclip tool-access stays off ([ADR 0014](0014-netzer-only-ai-runtime.md)).

**Decided by.** Jev: AWS-native connector plane 1.0; approvals verified directly 0.93; Netzer-enforced first, Cedar next 0.89; built-ins under the same policy 0.91; retire duplicate connectors 0.93; tokens to AWS 0.90.

## Consequences

Good: one credential plane, least privilege per pack, and a customer changes vendor by configuration (a tool alias), not by fork.

Bad:

- Until Cedar lands, policy lives only in Netzer (Med). Mitigation: tests, and a single IAM path to the Gateway.
- Approval-gated tools depend on Paperclip being available (Med). Gated steps fail closed; other steps continue.

- **Reversibility:** two-way. Cedar layers on top of the Netzer policy without replacing the credential plane.
- **Revisit trigger:** step 12 (interceptor and Cedar), or a policy gap found by the permission test in the release checklist.

## Alternatives considered

- **Paperclip tool-access, or any second connector plane or credential store.** Rejected: [DO NOT BUILD](../features/paperclip/do-not-build.md).
- **Cedar first, before Netzer enforcement.** Rejected for v1 (Jev 0.89): Netzer enforcement ships with Customer #1, Cedar follows.
- **Approvals verified through a Paperclip policy endpoint.** Not available: none exists (VERIFIED).
