---
feature: netzar-studio
document_role: decision
status: draft
observed_at: 2026-10-23
as_of_commit: d1d3a66970cd548f9529a234ef2b51ecdc29378e
---

> Foundation PLAN draft (2026-10-23), written by a read-only review agent and accepted as a draft by the planner. Owner decisions it asks for are in grill round 4 (Q81+). Overrides: [blueprint v2](../blueprint.md) wins on conflict.

# DATA-MODEL: Netzar Studio rebuild (brownfield)

**Summary.**
1. Today Netzar is one install per deployment (ADR 0002). It has 30 DynamoDB tables (PK/SK strings, KMS, PITR, RETAIN), 7 S3 buckets, a 7-year WORM audit mirror at tier 2+, and the Paperclip Postgres. There are no workflow, playbook, eval or agent-version entities yet.
2. Knowledge is a free-string `scope` over JSONL in S3. The dashboard `/vectors*` read routes take any scope from any viewer-tier caller. Chat-dropped files land in the agent's scope, or in `default`, which every agent searches.
3. TARGET: one new single-table `${app}-studio` holds workflows, drafts, versions, test runs, playbooks, company facts and lessons. AgentVersion extends `agent-file-history` and adds immutable S3 keys. Evals live in the repo (synthetic data) or in-account (customer data). Analytics go to the existing audit log as a new action.
4. Migration is expand/contract and forward-only. Each change has a runtime-config flag as its rollback path. Agent prompts move to immutable versions by dual-writing first, so running chats never see a missing key.
5. The biggest risks are: no per-agent access model exists to enforce "private" knowledge, chat uploads can't be attributed to the person who uploaded them, Hive Mind TTL would expire "Company facts", the agent config has three writers that are not atomic, and the WORM audit makes any PII slip permanent.

Notation: current-state claims cite `path:line`. **TARGET:** marks anything not built. PRD IDs: FR-/NFR-/AC-/KN-AC-.

---

## 1. Current entities and stores

### 1.1 Install model and defaults
- One deployment = one customer. There is no `tenantId` anywhere (`docs/adr/0002-single-tenant.md:7`). Isolation is per AWS account and stack.
- Every table uses `baseProps`: PAY_PER_REQUEST, PITR, a customer-managed KMS `dataKey`, and RETAIN (`infra/lib/dynamo-stack.ts:82-91`). Names are `${app}-<name>` (`infra/lib/constants.ts:85-130`).
- Backups cover DynamoDB only, via a PITR export to the logs bucket (`infra/lib/backup-stack.ts:5,73`). **The vectors bucket is the only copy of the knowledge index** (`infra/lib/storage-stack.ts:455-461`).
- Per-agent scoping exists only as key prefixes (`AGENT#<id>`) and the `knowledgeScope` string. Users and permissions are deployment-wide capabilities, with no per-agent grants (`src/lib/auth/permissions.ts:88-140`).

### 1.2 DynamoDB tables (as defined in `infra/lib/dynamo-stack.ts`)
| Table (`${app}-…`) | Keys / GSIs (infra) | Item shape (writer) | TTL / retention |
|---|---|---|---|
| sessions | PK,SK (:94-101) | `AGENT#id` / `CHAT#id`, `…#MSG#seq` (`src/lib/state/sessions-repo.ts:5-17`) | `ttl` 7 days idle (:10) |
| hive-mind | PK,SK; gsi1-agent-time, gsi2-xagent (:103-121) | `DATE#yyyymmdd` / `TS#ms#AGENT#a#ID#u`; GSI2 = `TOPIC#` (`src/lib/state/hive-mind-repo.ts:10-15`) | `ttl` = 60+3×importance days (:85) |
| audit-log | PK,SK; gsi1-date (:124-137) | `DAY#d` / `ts#id`; GSI1PK `AGENT#id\|system` (`src/lib/audit/audit-writer.ts:358-361`) | ttl attr defined, writer sets none → kept forever |
| chat-config | PK,SK (:139) | chat settings | none |
| token-usage | PK,SK; gsi1-agent-time (:147-160) | `AGENT#a#DAY#d` / `iso#id`; GSI1 `MODEL#` (`src/lib/usage/token-tracker.ts:5-8`) | ttl |
| memories | PK,SK; gsi1-importance, gsi2-unconsolidated (:162-181) | `AGENT#a` / `MEM#chat#iso#id` (`src/lib/state/memories-repo.ts:5-8,79-84`) | ttl |
| consolidations | PK,SK (:183) | consolidator output | ttl |
| agent-file-history | PK,SK (:192-199) | `AGENT#a` / `REV#iso#revId`, full `body`, `bodyHash` (`src/lib/state/agent-file-history-repo.ts:5-11,78-83`) | ttl attr defined, writer sets none |
| mission-tasks | PK,SK; gsi1-status-agent-priority (:201-214) | `AGENT#owner` / `MISSION#iso#id`; plus `PROVENANCE` rows (`src/lib/state/mission-tasks-repo.ts:9-12`, `mission-provenance-repo.ts:58`) | ttl |
| scheduled-tasks | PK,SK; gsi1-active-nextrun (:216-228) | schedules | none |
| kill-switches | PK,SK (:230) | switches (seeded by a custom resource) | none |
| inter-agent-tasks | PK,SK; gsi1-from-agent (:238-251) | delegations | ttl |
| compaction-events | PK,SK (:253) | compaction log | ttl |
| queue-lease | **PK only** (:265-270) | per-chat leases **and** Paperclip attempt rows (`src/lib/paperclip/attempt-rows-dynamo.ts:5`) | ttl |
| effect-ledger | PK,SK; gsi1-unknown (:272-285) | Work Platform effect/draft rows (`src/lib/work/effect-rows-dynamo.ts:6-14`) | none |
| spend-ledger | PK only (:293-298) | `DAY#d` aggregate, `RES#key` reservations (`src/lib/cost/spend-ledger.ts:38-39`) | ttl on day rows |
| identities | PK,SK (:317-323) | `SURFACE#…`, `CANONICAL#…`, `CODE#…` (:302-315) | ttl on codes |
| users | PK,SK; gsi1-email | `USER#u/PROFILE`, `MAGIC#hash/STATE`, custom profiles, `SEATS/SEAT#`, `USER#u/SEAT`, `SEAT_POLICIES`, `USAGE#d` (`src/lib/admin/seat-repo.ts:11-14`), Paperclip `SHADOWSLOT#`/`PCUSER#` (`src/lib/paperclip/shadow-rows-dynamo.ts:5-7`) | ttl on magic tokens |
| agents | PK,SK | `AGENT#a/META`: model, knowledgeScope, **bot tokens and signing secrets** (`src/lib/state/agents-repo.ts:5-6`, `src/lib/agents/types.ts:3-26`) | none |
| dashboard-tokens | PK,SK; gsi2-user | `TOKEN#hash/META` (`src/lib/state/tokens-repo.ts:151-169`) | ttl |
| runtime-config | PK,SK | key-value flags (`getConfig(ns,key)`) | none |
| rate-limits, hook-idempotency, spawn-ledger, extension-subnet-pool, extensions-registry, warroom-meetings/turns/connections, jarvis-tickets/leases/ledger/canary | see `dynamo-stack.ts:326-475` | subsystem-private | mostly ttl |

The file comment says "All 14 DynamoDB tables" (`dynamo-stack.ts:28`), but 30 are declared (`:39-75`). The comment is stale. Documents must count from code.

### 1.3 S3 buckets (`infra/lib/storage-stack.ts`, names `infra/lib/constants.ts:66-77`)
| Bucket | Prefixes and use | Versioned / lifecycle |
|---|---|---|
| config | `agents/<id>/CLAUDE.md`, `agents/<id>/agent.yaml` (`src/lib/config/agent-loader.ts:5-6`) | versioned; **noncurrent versions expire after 90 days** (:327-333) |
| raw | chat media `<surface>/<chatId>/yyyy/mm/dd/<ts>-<name>` (`src/lib/media/process.ts:254`) | 365-day expiry (:348-356) |
| curated | artifacts, branding | versioned, no expiry |
| vectors-staging | `uploads/<id>/…`, `uploads/chat/<callerTag>/<id>/…` (`src/adapters/dashboard/handler.ts:306-309`) | 7-day expiry scoped to `uploads/` (:405-416) |
| vectors (durable) | `index/<normalizedScope>/<docId>.jsonl` (`src/lib/vectors/store.ts:385-391`) | versioned, no expiry by design (:455-484) |
| logs | access logs, CloudTrail, ddb-exports | 730-day expiry |
| audit-lock (tier ≥2 only) | `audit/<day>/<ts>-<id>.json` (`audit-writer.ts:384-390`) | Object Lock governance, 2555 days (:303-313) |

Postgres: an Aurora Serverless v2 PG17 cluster, database `paperclip`, owned by the Paperclip work engine (`infra/lib/database-stack.ts:22,64-85`). Paperclip is the system of record for missions and work state (ADR 0012).

### 1.4 Ownership notes
- **Agent config has three writers to S3, and none is transactional.** (a) `createAgent` puts both files directly, with no history row (`src/lib/agents/agent-manager.ts:124,145`). (b) `saveAgentFile` writes the DDB revision first, then overwrites the S3 key in place (`agent-file-history-repo.ts:76-106`). (c) `persistKnowledgeScopeToS3` rewrites `agent.yaml` and skips history (`src/adapters/dashboard/handler.ts:4911-4945`). The model id is not in S3: the runtime takes it from the `agents` META row (`agent-loader.ts:254-264`).
- The loader cache is per process with a 5-minute TTL. Invalidation reaches the local task only (`agent-loader.ts:149-150,307-315`).
- Audit: `writeAudit` is fire-and-forget (`audit-writer.ts:286,341`). `writeAuditOrThrow` throws if neither store accepted the event (`:432`, ADR 0020 §1). `action` is a closed TS union (`:56-…`).
- Cost authority is the spend ledger plus token-usage (ADR 0020 §5).

## 2. Knowledge scopes today, and the leak (verified)

**Model.** A scope is an operator string. It is normalised with `[^A-Za-z0-9_-] → _` (`store.ts:372-373`). Search is a full scan of every row under `index/<scope>/` (`store.ts:292-343`); there is no S3 Vectors service. Constants are `default` and `shared` (`src/lib/config/agent-loader.ts:25,27`). The agent tool `s3_vectors_search` always searches `{own, default, shared}` (`src/lib/tools/vector-tools.ts:102`). Agent-side ingest is held to the agent's own scope (`vector-tools.ts:235-252`, tested in `vector-tools.scope.test.ts`). **Only the agent tool is contained. The dashboard routes are not.**

**Leak A: dashboard reads accept any scope.** All three routes are gated only on `vectors:read`. That capability is in VIEWER_CAPS, so every templated profile from viewer upward holds it (`src/lib/auth/permissions.ts:99,205`).
| Route | Gate | Scope source | Read |
|---|---|---|---|
| `GET /vectors` | `handler.ts:3082` | `c.req.query('scope') ?? 'default'` (:3085) | `listDocuments(scope)` (:3086): titles, docIds, sources |
| `POST /vectors/search` | `:3332` | `body?.scope ?? 'default'` (:3338) | `vectorSearch({scope,…})` (:3341): returns chunk **text** |
| `POST /vectors/answer` | `:3369` | `body?.scope ?? 'default'` (:3386) | `vectorSearch` (:3420), then a paid model answer |

There is no agentId, no ownership check and no allow-list. Scope names are guessable (`agent:<id>`, or whatever is in `agent.yaml`). Related findings:
- `POST /vectors/upload-url` is also gated on `vectors:read`, so a viewer can presign a PUT into staging `uploads/` (`:3174-3180`).
- `DELETE /vectors/:scope/:docId` (`agents:write`) can delete from any scope (`:3522-3530`).
- `/ingest` and `/ingest/stream` (`agents:write`) can write to any scope, including `shared` (`:3090-3120`, `:3196-3200`, `:3288`).

**Leak B: chat-dropped files are readable by every user of the agent, and sometimes by the whole fleet.** On Telegram, Slack and dashboard chat, documents and transcripts are auto-ingested by `ingestChatMedia` (`src/lib/media/process.ts:347,357`). The scope is `agent.knowledgeScope || 'default'`, or `shared` if `media/chat_kb_ingest_scope=shared` is set (`src/lib/media/chat-kb-ingest.ts:60-69`). The result:
1. Anyone chatting with that agent, on any surface, retrieves the file through `s3_vectors_search`. The file's header comment states this is intended: "drop a PDF in Telegram, ask about it from Slack tomorrow" (`chat-kb-ingest.ts:6-9`). **Fixed by NZR-6:** chat files go to the uploader's chat-private scope `chatKnowledgeScope(agentId, chatId, uploaderId)`, searched only from that chat; legacy ones move to the admin-only `chat_quarantine` (`scripts/nzr6-quarantine-chat-docs.ts`).
2. **An agent with no `knowledgeScope` writes chat files into `default`.** Every agent searches `default` (`vector-tools.ts:102`), so the file is readable fleet-wide.
3. Any viewer can read them through Leak A.
4. The docId is a content hash, `chat-<sha256[:24]>`, and dedup runs per scope (`chat-kb-ingest.ts:41-43,136-138`). Re-sending a file someone else already sent gets a "deduped" reply, which tells the sender the file exists.
5. Stored rows have tags `chat`, `<surface>` and `agent:<id>`, but **no uploader userId and no chatId** (`chat-kb-ingest.ts:142-147`). The audit row does carry agentId and chatId (`:161-172`).
6. The staging prefix is per caller (`handler.ts:306-309`), and its 7-day expiry hides the raw file. The indexed chunks never expire (`storage-stack.ts:455-484`).

## 3. TARGET entities

**Store decision.** TARGET: add one new table `${app}-studio` (PK/SK strings, GSI1 `gsi1`, GSI2 `gsi2`, `ttl`, baseProps), with owner module `src/lib/studio/*-repo.ts`. Reasons:
- The `users` table already mixes 8 item kinds and depends on SK filters on scans (`seat-repo.ts:8-9`).
- `queue-lease` is overloaded with Paperclip rows.
- Hive Mind items carry per-item TTL.

Adding a table is an expand-only CDK change, but it requires IAM grants plus `TABLE_STUDIO` env wiring (CompactionEvents/RuntimeConfig pattern). All repo writes follow the existing patterns: `attribute_not_exists(PK)` create-only puts, and `TransactWriteItems` for counter-plus-item writes. Workflow JSON is small; cap it at 64 KB with validation, well under DynamoDB's 400 KB item limit. Identity comes from `personOf(c)` (`handler.ts:311-315`). A principal with no person (break-glass, bare token) cannot own a workflow.

| Entity | Store | Key design | Access pattern | Owner module | Retention |
|---|---|---|---|---|---|
| **WorkflowDefinition** (identity + status) | studio | `WF#<wfId>` / `META`: name, ownerUserId, status `draft\|ready\|published`, `draftRev`, `publishedVer`, `activeVer` (C3), schemaVersion; GSI1 `OWNER#<userId>` / `WF#<updatedAt>`; GSI2 `WFALL` / `<updatedAt>` | list mine / list all (≤50 users) / get | `src/lib/workflows/` (NZR-12) | until deleted; soft-delete flag (`deletedAt`), no TTL |
| **WorkflowDraft revision** (history) | studio | `WF#<wfId>` / `DRAFT#<rev:6>`: full JSON (trigger, steps of `agent\|decision\|approval\|output`), `sha256`, author, `source chat\|edit`, `parentRev`, validator result | Transact: META `draftRev=:n` iff `=:n-1`, plus put DRAFT (create-only). Read latest = META.draftRev | workflows | all kept (small). TARGET: cap at 200 revs, prune oldest non-tested |
| **WorkflowVersion** (C3, frozen on publish) | studio | `WF#<wfId>` / `VER#<seq:6>`: frozen JSON, `sha256`, `fromDraftRev`, `agentPins[{stepId, agentId, agentVersionId}]`, publishedBy/At; create-only, never updated | publish = Transact(put VER, META.publishedVer); activate = META.activeVer plus approval ref; rollback = point activeVer at an earlier VER | workflows (NZR-36) | kept forever while referenced (AC-022, FR-008) |
| **TestRun** | studio | `WF#<wfId>` / `TEST#<runId>`: `draftRev` + draft sha256, sample-set id, status, totals, cost; GSI1 `TESTBY#<userId>` / `<ts>` | create-only header. Status moves only forward via ConditionExpression (`running→passed\|failed\|aborted`); no update after a terminal state | `src/lib/workflows/test-runner` (NZR-26) | `ttl` 180 days (proposal; owner to confirm) |
| **TestRun step result** | studio, plus audit | `WF#<wfId>` / `TEST#<runId>#STEP#<nn>`: stepId, type, outcome, plain-text summary, `inputHash`/`outputHash`, `deniedWrites[]` (tool names blocked by write-deny), model id, tokens. Create-only | read all steps for a run with one `begins_with` Query | test-runner | same TTL. **Audit:** one `writeAuditOrThrow` per step, action `workflow_test_step`, IDs and hashes only (ADR 0020 §2) |
| **AgentVersion** (immutable) | `agent-file-history` table + config bucket | `AGENT#<id>` / `VER#<seq:6>`: `versionId`, revIds + sha256 of CLAUDE.md and agent.yaml, a **non-secret** META snapshot (model, knowledgeScope, tools), createdBy. Files are copied to `agents/<id>/versions/<versionId>/{CLAUDE.md,agent.yaml}`, which are current objects that never expire. Create-only | `loadAgent(id, {versionId})` reads the version prefix. Without a versionId the current behaviour is unchanged | `src/lib/state/agent-file-history-repo.ts` plus `agent-loader.ts` (NZR-22) | forever while pinned. Block `deleteAgentFull` while any VER is pinned |
| **Playbook** | studio (+ optional vector scope) | `PLAYBOOK#<id>` / `META` (title, owner, status, rev) and `REV#<n:6>` (markdown ≤64 KB, sha256); GSI2 `PLAYBOOKS` / `<title>`. TARGET: ingest the approved rev into scope `pb_company` for retrieval | Library CRUD (permission `playbooks:write`, new and additive); the drafter reads approved revs | `src/lib/studio/playbooks-repo.ts` (NZR-27) | until deleted; revisions kept |
| **CompanyFact** + approval queue | studio (**not** hive-mind) | `FACT#<id>` / `META`: text, source (agentId, chatId, userId), status `proposed\|approved\|rejected\|retired`, decidedBy/At, reason; GSI1 `FACTQ#<status>` / `<createdAt>` | an agent's `log_to_hive` or a user creates `proposed`. An admin approves with a conditional status change plus `writeAuditOrThrow`. Only `approved` facts are injected into context | `src/lib/studio/facts-repo.ts` (NZR-28) | no TTL on approved; `proposed` TTL 90 days; rejected kept 1 year |
| **ProposedLesson** | studio | `LESSON#<id>` / `META`: correction text, from TestRun/draft ref, target (playbook\|fact\|eval), status; GSI1 `LESSONQ#<status>` / `<ts>` | created on user correction; approve → create the Playbook rev / Fact / EvalCase. Nothing applies without approval | `src/lib/studio/lessons-repo.ts` (NZR-29) | same as CompanyFact |
| **EvalCase** | **repo files** (synthetic) / studio (customer, opt-in) | repo: `evals/drafter/cases/<id>.json` (description, expected-step assertions, max questions). Customer cases: `EVAL#<id>` in-account, scrubbed, `optIn` ref | the CI scorer reads repo cases only | `evals/drafter/` (NZR-14) | repo: git. Customer: until opt-out |
| **EvalResult** | repo file | `evals/drafter/results/<runId>.json`: score per case, total, `hashes{drafterFiles: sha256 per file, dataset: sha256 of the sorted case set, model: provider+modelId+params}`, mode `live\|replay`, baseline ref | CI recomputes the hashes and **fails on mismatch**. A drafter PR must beat the stored baseline. Replay results test the harness only (synthesis: Evaluation) | NZR-30 | git history. Re-baseline when moving to Bedrock |
| **Product analytics event** | existing audit-log table + WORM mirror | new action `product_event`. `agentId` omitted (so GSI1PK=`AGENT#system`). **`userId` omitted.** `detail={event:<allow-listed name>, props:<allow-listed enum/number keys>}`. Rejected at write if a key is not allow-listed | Admin usage view: Query `DAY#d`, filter on action | `src/lib/analytics/events.ts` | 7 years in WORM (tier ≥2); forever in DDB. Hence no PII, ever |
| **TriggerContract** (design only) | TARGET: studio | `WF#<wfId>` / `TRIG#<verSeq>`: `{type: webhook\|api\|form\|embed\|integration\|schedule, auth: {kind, secretRef→Secrets Manager}, inputSchema (JSON Schema), rateLimit, idempotencyKeyPath}`. Secrets never stored in the table. Reuse `hook-idempotency` and `rate-limits` | loop 2 | NZR-13 doc; NZR-35 code | with its version |

**Knowledge scope target (NZR-5/6).**
- Add one resolver, `allowedScopes(principal, agentId)`. The agent tool, `/vectors*` and the drafter all use it. Unknown or other scopes return 404, so existence is not revealed (KN-AC-003, KN-AC-005).
- Chat files get scope `chat_<agentId>_<chatId>`, and rows are tagged with the uploader's userId. Only the chat owner (`ownsConversation`) and the turn's agent read it.
- Reserve the prefixes `chat_` and `pb_` by rejecting them in `knowledgeScope` writes (`persistKnowledgeScopeToS3`). Without that, normalisation collisions are possible.
- **Open owner decision:** which humans may read which agent's scope. There is no per-agent ACL today (see Risk 1).

## 4. Migration policy

Rules:
1. Expand → migrate → contract. A contract step needs owner yes plus a soak of ≥14 days with zero reads on the old path (a log counter).
2. Forward-only. There are no down-migrations. Rollback means flipping a `runtime-config` flag (`getConfig(ns,key)`) back to the old read path while the old data is still being written.
3. Never repurpose an attribute, key prefix or capability string (the rule at `permissions.ts:84-86` applies to data as well).
4. Every new table uses baseProps (PITR, RETAIN). A table is never removed in this phase (blueprint: "Remove: nothing").
5. Backfills are idempotent (create-only puts), resumable, and logged as an audit `migration_step` row.

| Change | Expand | Migrate | Contract | Rollback |
|---|---|---|---|---|
| `${app}-studio` table | CDK add + IAM + env | none (new data) | n/a | flag `studio/enabled=0` hides the UI; the table stays (RETAIN) |
| `/vectors*` scope enforcement (NZR-5) | add resolver; log would-deny for one deploy | n/a | enforce (deny) | flag `vectors/enforce_scope=0` (time-boxed; security owner must sign) |
| Chat files private (NZR-6) | new writes go to `chat_<agent>_<chat>` with uploader tag | backfill: find rows tagged `chat` in agent and `default` scopes; move them to a quarantine scope `chat_legacy_<agentId>` readable only by admins, keeping the audit row's chatId for owner mapping | stop reading chat docs from agent scopes | flag routes new ingest back to the agent scope; the quarantine stays |
| Company facts | new FACT items; `log_to_hive` dual-writes a `proposed` FACT | none | stop injecting unapproved hive notes | flag |
| AgentVersion (below) | dual-write version prefix | backfill v1 | live key becomes a projection | flag `agents/versioned_load=0` |

**Agent prompts: from overwrite-in-place to immutable versions, without breaking running chats.**
1. *Expand.* `saveAgentFile`, `createAgent` and `persistKnowledgeScopeToS3` all go through one writer. It (a) writes the history row, (b) writes `agents/<id>/versions/<revId>/<file>` (create-only, `IfNoneMatch:*`), then (c) overwrites the live key exactly as today. Chats keep reading the live key, so nothing changes for them.
2. *Backfill.* For each agent row, read the **live S3 files**, not the history table, because the two can differ (Risk 4). Snapshot the non-secret META fields and create `VER#000001`.
3. *Publish.* "Publish agent" creates `VER#n` from the current revs. Workflow agent steps pin `agentVersionId`. The test runner and the live engine load by version. Chat with no pin loads "latest published", which equals the live key.
4. *Contract (C3 or later).* Dashboard edits write drafts. Only publish rewrites the live key, so the live key is a projection of the latest version. The live key is never deleted while an older-image task could read it.
5. Running chats are safe throughout. Every step keeps the live key valid. The 5-minute per-task cache means a publish can take up to 5 minutes to reach other tasks (`agent-loader.ts:149`). A pinned load is keyed by versionId, so it is cache-coherent by construction.

## 5. Data boundary rules

| Context | Allowed data | Never |
|---|---|---|
| Pilot (managed, PGN AWS account, written exception: synthesis Q64) | seeded sample data and synthetic documents; partner consent on file | customer production data of any kind |
| Mocks, tests, tester sessions | seeded sample data only (Q67, Q77); fixtures in repo | real names, emails, policy documents |
| CI | recorded replies (NZR-11); synthetic eval cases | live customer content; credentials |
| NVIDIA dev backend | test data only, and **no repo code until the owner reads the free-tier terms and says yes** (Q65) | anything from an install; eval cases derived from customer data |
| Repo (git) | synthetic eval cases, result files (hashes and scores) | customer eval cases, transcripts, scrubbed or not |
| GA, customer-hosted | everything stays in the customer's account | see below |

**At GA, these must never leave the customer AWS account:** source documents and raw media; vector JSONL and embeddings; chat sessions, memories, Hive Mind and Company facts; playbooks and agent prompts and versions; workflow definitions, test-run inputs, outputs and step results; customer-derived eval cases and lessons; audit rows (DDB and WORM); token and cost ledgers; users, seats and identities. Model calls go to in-account Bedrock (ADR 0014).

TARGET, needs an ADR: if PGN ever wants aggregate product analytics, it would be an explicit customer-approved export of `product_event` counts only. Nothing is exported by default.

## 6. Ranked risks and conflicts

1. **No per-agent access model to enforce.** The capabilities are deployment-wide (`permissions.ts:88-140`), so "a viewer cannot read another agent's private knowledge" (blueprint AC 7, KN-AC-003) has no definition of who owns an agent. A shallow fix that requires an `agentId` parameter but still trusts it closes nothing. NZR-5 needs an owner decision on grants (an agent members list in `agents` META? profile-level?) **before** the failing test is written.
2. **Leak A is live and broad.** Every viewer-tier principal can read every scope's chunk text, and `/answer` spends money doing it (`handler.ts:3085,3338-3341,3386-3420`). Custom profiles can grant `vectors:read` alone. Treat it as an incident (T3, week 0, Q62/Q75).
3. **Leak B reaches the whole fleet, not just one agent.** Agents with no `knowledgeScope` write chat files into `default`, which every agent searches (`chat-kb-ingest.ts:66`, `vector-tools.ts:102`). Legacy rows have no uploader or chat id (`chat-kb-ingest.ts:142-147`), so a precise retroactive privatisation is impossible. Quarantine, plus audit-row mapping, is the best available.
4. **Agent config is not atomic and has three writers.** The history row is written before S3, `createAgent` writes no history, and `persistKnowledgeScopeToS3` bypasses history. The model lives in DDB META (`agent-manager.ts:124,145`; `agent-file-history-repo.ts:76-106`; `handler.ts:4911`; `agent-loader.ts:254-264`). An AgentVersion built from history rows alone would pin the wrong prompt or model. Config-bucket S3 version ids expire after 90 days (`storage-stack.ts:327-333`), so they are not pin targets either.
5. **Hive Mind cannot become Company facts as-is.** Items self-expire after 60+3×importance days (`hive-mind-repo.ts:85`). `log_to_hive` writes with no approval (`agent-tools.ts:254`), and every agent gets the notes injected as "authoritative" (`agent-loader.ts:57,82`). That is a prompt-injection poisoning channel until the queue lands, and "approved" facts would silently disappear if stored there.
6. **The WORM audit makes mistakes permanent.** Product events and test-step rows go to 7-year Object Lock (`storage-stack.ts:306`). Today's redaction is top-level only and switch-gated (ADR 0020). Audit `userId` is `dashboard:<sha256(token)>` (`handler.ts:300-303`), which is pseudonymous but still personal data. Analytics need an allow-list schema at write time, not redaction. Tier <2 has no WORM at all, so the meaning of "audited" varies by tier.
7. **`writeAudit` is fire-and-forget** (`audit-writer.ts:341`). If test-run evidence uses it, the "audited" claim is unenforced. Use `writeAuditOrThrow` and make the studio TestRun rows the record of truth. The audit `action` union needs additive members.
8. **Redundant sources of truth (PRD 4.7).** Paperclip Postgres (missions/work), the Work Platform effect ledger (`effect-ledger` table, PR #206 paused) and the new studio table would all hold run state in C3. The NZR-33 spike must pick one authority per entity before NZR-34. The MVP studio table must never hold execution state.
9. **Scope normalisation collisions.** `normalizeScope` folds `:` to `_` (`store.ts:372`), so `chat:a:b`, `chat_a_b` and an operator-chosen `chat_a_b` all map to the same prefix. Reserve prefixes and validate on every `knowledgeScope` write.
10. **Retention mismatches.** Sessions expire after 7 days idle (`sessions-repo.ts:10`), but private chat docs never expire (`storage-stack.ts:455`). This orphans private data and contradicts PRD 3.6 ("temporary uploads must not automatically become shared…"). A retention rule is needed: delete private chat scopes N days after the session TTL, and audit the deletion (KN-AC-006).
11. **Eval hash gate versus the model switch.** The model id is part of the hash, so NVIDIA→Bedrock forces a re-baseline (accepted, Q66). Recorded replies can pass while live drifts, so the gate must read `mode=live`. Customer-derived cases can never enter the repo, which means the CI gate never sees them.
12. **Search is a full scan of each scope** (`store.ts:333-343`). Adding a playbook scope and per-chat scopes is fine at ≤50 users, but `default` and `shared` grow without bound. The PRD still says "S3 Vectors", and the blueprint already flags that as wrong.
13. **Agent META holds bot tokens and signing secrets in plaintext attributes** (`types.ts:16-22`). An AgentVersion snapshot or export must allow-list the fields it copies, or it will copy the secrets.
14. **Viewer-tier write paths.** `/vectors/upload-url` lets a `vectors:read` holder presign PUTs (`handler.ts:3174`). `DELETE /vectors/:scope/:docId` with `agents:write` can delete any scope, including private chat scopes once they exist.
15. **Doc drift.** "All 14 DynamoDB tables" (`dynamo-stack.ts:28`) and the store header that says the index lives in the staging bucket (`store.ts:5`) are both stale. Stories that cite them will mis-size work.
