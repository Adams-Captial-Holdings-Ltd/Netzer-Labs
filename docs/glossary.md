# Glossary

> ClaudeClaw Enterprise has a small set of project-specific words that the docs, the scripts, and the dashboard all use without re-explaining. This page defines each one in one to three sentences, grounded in the code that implements it. If a doc uses a term that is not here, that is a docs bug.

Terms are alphabetical. File links point at the implementation.

**Agent.** A policy, not a process: a CLAUDE.md system prompt (stored in the S3 config bucket at `agents/<id>/CLAUDE.md`, 5-minute cache), an `agent.yaml`, a model selection, and an optional Slack persona. One Fargate orchestrator hosts every agent; identity is which configuration `loadAgent()` (`src/lib/config/agent-loader.ts`) loads for the current turn.

**Bootstrap-state.** The three primitives created by SDK calls **before** any CDK stack exists, because the lifecycle depends on them: the state bucket (manifests/journals), the deploy-lock DynamoDB table, and the private ECR repo. Created idempotently by `scripts/lib/lifecycle/bootstrap-state.ts`, tagged, cataloged in [`out-of-band-catalog.md`](./out-of-band-catalog.md), and deleted last by teardown.

**Break-glass.** A deliberate, loud bypass of a safety gate for emergencies: the `*_signature_check_disabled` kill switches that accept unverified webhooks, and teardown's degraded mode that runs from CloudFormation + tags alone when the state bucket is lost. Every break-glass path logs a warning naming itself.

**Deploy lock.** A DynamoDB lease (owner + expiry + heartbeat) in the deploy-lock table that every mutating lifecycle operation (deploy, rollback, seed, teardown) must hold; a second concurrent operation refuses to start and names the current holder. Implemented in `scripts/lib/lifecycle/lock.ts`.

**Deploy mode.** `CCE_DEPLOY_MODE`, either `chat` (default: at least one webhook surface, requires HTTPS/domain) or `infra-only` (dashboard only, no chat surfaces; without a domain the ALB is internal and access is the SSM tunnel). Drives readiness (`isReadyForTraffic()` in `src/config/env.ts`), preflight scope, and verify scope.

**Glossary.** You are here.

**Guardrail.** The Bedrock Guardrail (12 PII entity types, 6 content filters) attached to every Converse call in `src/agent/agent-loop.ts` unless `guardrail_disabled` is tripped or a turn explicitly skips it (the War Room). Blocked turns return a notice and are never persisted to session history.

**Hive (Hive Mind).** The cross-agent, cross-chat shared scratchpad: agents write with `log_to_hive`, read with `search_hive`, and recent notes are auto-injected into every system prompt (`recentHive()` in `src/lib/state/hive-mind-repo.ts`). Memory ingest can auto-promote fleet-wide facts into it on a tunable cadence.

**Intentional residual.** A resource teardown deliberately leaves behind and reports rather than deletes: the WORM audit-lock bucket (undeletable inside its governance retention window), KMS keys with living encrypted dependents, and shared account prerequisites (OIDC provider, CodeBuild source credential, CDK bootstrap stack). The teardown summary prints them with ongoing cost.

**Jarvis.** The browser voice co-pilot backed by Amazon Nova Sonic bidirectional streaming (`src/lib/jarvis/`), with a fail-closed launch gate (`JARVIS_LAUNCH_ENABLED`), its own kill switches, and a role manifest so a voice command can only reach surfaces the caller may use.

**Journal.** Per-deploy, immutable event objects written to the state bucket after every mutating step (image pushed, each secret version written, per-stack status), promoted atomically into the final manifest on success (`scripts/lib/lifecycle/journal.ts`). An interrupted deploy leaves a precise resume/rollback record instead of orphaned half-state.

**Kill switch.** One of the boolean flags in the `claudeclaw-kill-switches` DynamoDB table (30-second read cache, fail-open on read error) that gate features at runtime with no redeploy: `bedrock_global`, `tool_use`, `web_search_disabled`, and the rest. Read via `isKillSwitchActive()` (`src/lib/state/kill-switches-repo.ts`); flipped from the dashboard or the [kill-switches runbook](./runbooks/kill-switches.md).

**Knowledge / vectors.** The retrieval feature: documents are chunked, embedded with Titan v2, and stored as JSONL in S3 (`src/lib/vectors/`); agents query with `s3_vectors_search` and ingest with `ingest_document`. Gated by `CCE_KNOWLEDGE_ENABLED`, which also scopes the Titan model-grant preflight check.

**Manifest (deploy manifest).** The schema-versioned JSON record of one deploy, promoted to the state bucket: git SHA, image tag/digest, tier + mode + feature flags, per-stack template hashes, per-secret version ids, and a pointer to the archived `cdk.out` (`scripts/lib/lifecycle/manifest.ts`). Rollback targets what the manifest recorded; `npm run verify` compares live state against it.

**MCP gateway.** An Amazon Bedrock AgentCore Gateway fronting your APIs/Lambdas as MCP tools, called with SigV4 under the task's IAM role, no stored secrets (`docs/mcp/README.md`). Created by CLI runbook, deliberately outside CDK, and listed in the out-of-band catalog so teardown sees it.

**Out-of-band resource.** Anything the app creates or depends on that `cdk destroy` cannot see: the bootstrap primitives, AgentCore gateways, runtime-created EventBridge schedules, live-attached managed policies, the Telegram webhook. The committed catalog ([`out-of-band-catalog.json`](./out-of-band-catalog.json)) is one of teardown's four inventory sources.

**Owner alias.** Cross-surface identity mapping for the operator: chat ids listed in `CCE_OWNER_TELEGRAM_CHATS` / `CCE_OWNER_SLACK_USERS` resolve to one synthetic owner chatId (label from `CCE_OWNER_LABEL`, default `owner`), so the operator's memories follow them across surfaces (`src/lib/identity/owner-alias.ts`).

**Runtime-config.** The `claudeclaw-runtime-config` DynamoDB table of live-editable `category/key` settings (cost caps, memory cadence, the MCP server registry, feature arms like `iam/apply_enabled`), read through a 30-second cache with SNS invalidation fanout (`src/lib/state/runtime-config-repo.ts`). Edits propagate in seconds; no redeploy.

**Surface.** A place users talk to the system: Telegram, Slack, the dashboard Chat tab, and Jarvis voice. Adapters live under `src/adapters/`; the agent loop is surface-agnostic, and the project rule is that chat-UX changes must be mirrored across surfaces (see the repo CLAUDE.md).

**Tier.** `CCE_TIER` 0 to 3 (Hobby / Standard / Pro / Enterprise), the resource-shape dial CDK reads from `TIERS` in `infra/lib/constants.ts`: Fargate size and count, NAT count, log retention, and the WAF / CloudFront / X-Ray / Flow Logs / WORM gates. Upgrades are non-destructive; costs per tier are in [`cost-guide.md`](./cost-guide.md).

**War Room.** A multi-agent meeting: one user turn fans out to several agents whose replies land in a shared transcript (`src/lib/warroom/`), driven from Telegram (`/warroom`) or the dashboard tab. Room turns deliberately skip the Bedrock guardrail because the multi-speaker transcript shape trips the prompt-attack filter; everything else (kill switches, DLP) still applies.
