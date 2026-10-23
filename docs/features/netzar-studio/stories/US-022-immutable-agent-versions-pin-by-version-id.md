# [US-022] Immutable agent versions (pin by version id)

> Backlog task NZR-22 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: AC-012, AC-022, FR-008.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** a workflow to keep using the agent version it was tested with
* **So that** an agent edit never silently changes a workflow

---

## 2. Business Context & Description
* **Background:**
  - Workflows pin the agent they were tested with (blueprint "workflows as data"; PRD FR-008 "Published workflows are versioned", AC-022 "Published executions use the approved immutable version", AC-012 "The published agent can be used in chat and in a workflow").
  - Today an agent edit overwrites the live S3 prompt file in place, so a tested workflow can change behaviour with no one noticing. This is a data-model one-way door (DATA-MODEL §4, ARCHITECTURE R7), so it is T3.
  - Terms used below. **Live key**: the S3 object `agents/<id>/CLAUDE.md` or `agents/<id>/agent.yaml` that chat reads today. **Revision (rev)**: one row in the `agent-file-history` table per file save. **Version**: a frozen pair `{CLAUDE.md, agent.yaml}` plus a non-secret settings snapshot, with a `versionId`. **Pin**: a workflow step stores `agentVersionId`, and the runner loads exactly that version.
* **Current behaviour (d1d3a66):**
  - Revisions exist: `saveAgentFile` writes `AGENT#<id>` / `REV#<iso>#<revId>` with the full `body` and a sha256 `bodyHash` (`src/lib/state/agent-file-history-repo.ts:54-85`), then overwrites the live key in place (`:89-106`). The DDB row is written **before** S3, so a failed S3 put leaves a rev that never went live.
  - The PUT route writes the live key a **second** time with a different content type (`src/adapters/dashboard/handler.ts:1643-1661`). Editor identity comes from the caller-set `X-Dashboard-User` header (`handler.ts:278-282`, used at `:1647`; SECURITY.md 2a B1 S/R).
  - `createAgentFull` puts both files directly, with **no** history row (`src/lib/agents/agent-manager.ts:120-149`).
  - `persistKnowledgeScopeToS3` rewrites `agent.yaml` from the PATCH route and **skips** history (`handler.ts:1857-1859`, `:4911-4962`).
  - The loader reads only the live keys (`src/lib/config/agent-loader.ts:189-246`) and takes the **model** from the `agents` META row, not from S3 (`agent-loader.ts:260-266`). The tool allowlist is in `agent.yaml` (`readYamlTools`, `:127-138`). Cache: per process, 5-minute TTL (`:149-150`), cleared only on the local task (`:313-317`).
  - The turn loads the agent by id only (`src/agent/agent-loop.ts:1036`); `AgentTurnRequest` has no version field (`agent-loop.ts:210-232`).
  - The config bucket is versioned, but **noncurrent object versions expire after 90 days** (`infra/lib/storage-stack.ts:327-333`), so S3 version ids cannot be pin targets (DATA-MODEL risk 4).
  - The `agents` META row also holds `telegramBotToken`, `slackBotToken` and `slackSigningSecret` (`src/lib/agents/types.ts:16-22`; DATA-MODEL risk 13). `redactAgent` strips three of them (`types.ts:42-49`).
  - `GET /agents/:agentId/history` and `/history/:revId` have no `hasCapability` call; only the legacy "every GET = viewer" gate applies (`handler.ts:1670-1697`, `:464`). `/history/:revId` returns the full body.
  - `deleteAgentFull` deletes only the two live keys and the META row (`agent-manager.ts:165-194`).
  - No `agent_version_*` or `migration_step` audit action exists (`src/lib/audit/audit-writer.ts:57-…`). The migration registry is empty (`scripts/migrations/index.ts`).
* **Target behaviour:**
  - All three writers (PUT file, create, PATCH knowledgeScope) go through **one** writer that records a history rev for every file change. The duplicate S3 put in the PUT route is removed. The editor comes from the session (`dashboardIdentity`, `handler.ts:294-304`), not the header.
  - `POST /api/agents/:agentId/versions` publishes a version from what chats run **today**: the live S3 files plus the allow-listed META fields. It never builds a version from history rows alone (risk 4).
  - A version is content-addressed and write-once: `versionId = "av_" + first 32 hex of sha256(canonical bundle)`; the two files are copied to `agents/<id>/versions/<versionId>/` with a create-only put (`IfNoneMatch: '*'`). These are current objects, never overwritten, so the 90-day noncurrent rule never removes them.
  - The version row stores a **non-secret** snapshot built from an allow-list: `model`, `knowledgeScope`, `tools`, `displayName`. Bot tokens and signing secrets are never copied.
  - `loadAgent(agentId, { versionId })` loads exactly that version (files from the version prefix, model from the snapshot), checks both sha256 hashes, and fails closed on any mismatch or missing object. It never falls back to the live key.
  - `runAgentTurn` accepts `agentVersionId`. Callers that do not pass it (every chat surface) behave exactly as today.
  - Publishing identical content twice returns the existing version (idempotent). Old versions stay loadable forever, including after the agent is deleted.
  - One idempotent backfill creates version 1 for every existing agent from its live files.
* **Out of scope:**
  - The versions panel on the agent page (W-032) → NZR-19 shows it. This story is API + loader only.
  - Pinning inside workflow JSON (`agentVersionId` field) → NZR-12 schema; the test runner loading by version → NZR-26; publish/activate/rollback of workflows and blocking agent delete while pinned → NZR-36.
  - Contract step (dashboard edits become drafts; only publish rewrites the live key) → C3 or later, needs owner yes and a 14-day soak (DATA-MODEL §4 rule 1).
  - Cross-task cache fan-out for publish (`publishInvalidation`) is not needed: pinned loads are keyed by versionId and immutable.
  - Moving the drafter prompt into the repo (Q88) → NZR-8/NZR-23.
* **Target Value:** 0 workflow test or live runs load an agent without a `versionId` once NZR-26/34 call the loader (measured: audit rows `agent_turn` with `detail.agentVersionId` absent and `detail.runId` present = 0 in the C2b tester sessions). For this story: 100% of pinned loads in tests return the pinned bytes after a later edit.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Publish freezes the current agent
* **Given** agent `ops` with live `CLAUDE.md` = "You are Ops v3", `agent.yaml` with `tools: [get_time]`, and META `model: us.anthropic.claude-sonnet-4-6`, `slackBotToken: xoxb-SYNTHETIC`
* **When** an operator (`agents:write`) calls `POST /api/agents/ops/versions` with `{ "note": "tested with policy review" }`
* **Then** the response is `201 { versionId: /^av_[0-9a-f]{32}$/, seq: 1, created: true, claudeMdHash, agentYamlHash }`
* **And** S3 holds `agents/ops/versions/<versionId>/CLAUDE.md` and `.../agent.yaml` with the same bytes as the live keys, both written with `IfNoneMatch: '*'`
* **And** the `agent-file-history` table holds `AGENT#ops` / `VER#000001` and `AGENT#ops` / `VERID#<versionId>`, and the snapshot has exactly the keys `model, knowledgeScope, tools, displayName` (no key containing `Token` or `Secret`)
* **And** one audit row `agent_version_published` with `detail = { versionId, seq, claudeMdHash, agentYamlHash, model, toolsChanged, knowledgeScopeChanged }` is written with `writeAuditOrThrow`
* **Test:** `src/lib/agents/agent-versions.test.ts` › "publishes a version from the live files with an allow-listed snapshot"
* **Test:** `src/lib/agents/agent-versions.test.ts` › "never copies bot tokens or signing secrets into the version"

### Scenario 2: A pinned run keeps its version after an edit
* **Given** version `av_A` (seq 1) of `ops` and a later `PUT /api/agents/ops/file` that changes the live prompt to "You are Ops v4" and `PATCH /api/agents/ops` that changes the model
* **When** a run calls `runAgentTurn({ agentId: 'ops', agentVersionId: 'av_A', … })`
* **Then** the system prompt contains "You are Ops v3", the model id is the one in the `av_A` snapshot, and the tool allowlist is `[get_time]`
* **And** a call without `agentVersionId` gets "You are Ops v4" and the new model (unchanged behaviour)
* **Test:** `src/lib/config/agent-loader.version.test.ts` › "loads the pinned prompt, yaml and model, not the live ones"
* **Test:** `src/agent/agent-loop.version.test.ts` › "passes agentVersionId to loadAgent and leaves unpinned turns unchanged"

### Scenario 3: Integrity and unknown versions fail closed
* **Given** a pinned `versionId` that has no `VERID#` row, or whose S3 object is missing, or whose bytes hash differently from the stored hash
* **When** `loadAgent('ops', { versionId })` runs
* **Then** it throws `AgentVersionNotFoundError` (no row) or `AgentVersionIntegrityError` (missing object or hash mismatch), and **no** `GetObject` for the live keys `agents/ops/CLAUDE.md` / `agent.yaml` is sent
* **And** `GET /api/agents/ops/versions/<that id>` returns `404 { error: 'not_found' }`
* **Test:** `src/lib/config/agent-loader.version.test.ts` › "fails closed on unknown, missing or tampered versions without reading the live key"

### Scenario 4: Same content twice, and concurrent publish
* **Given** version `av_A` exists and nothing changed since
* **When** the operator publishes again, or two publishes of the same content race
* **Then** both return `200 { versionId: 'av_A', seq: 1, created: false }`; there is still exactly one `VER#` row and one S3 object per file
* **And** when two publishes of **different** content race, both succeed with distinct `seq` values (1 and 2); the `VERSEQ` counter update uses a ConditionExpression, and a `TransactionCanceledException` is retried at most 3 times, then `409 { error: 'version_conflict' }`
* **Test:** `src/lib/agents/agent-versions.test.ts` › "is idempotent for identical content"
* **Test:** `src/lib/agents/agent-versions.test.ts` › "allocates distinct sequence numbers under a concurrent publish"

### Scenario 5: Permissions and identity
* **Given** a viewer (no `agents:write`)
* **When** they call `POST /api/agents/ops/versions`
* **Then** the response is `403 { error: 'forbidden', requiredCapability: 'agents:write' }` and no S3 or DDB write is sent
* **And** for an operator, `createdBy` on the version and `editedBy` on new history revs equal `dashboardIdentity(c)` even when the request sends `X-Dashboard-User: someone-else`
* **And** `GET /api/agents/:agentId/versions`, `/versions/:versionId`, `/history` and `/history/:revId` require `agents:read` (403 without it)
* **Test:** `src/adapters/dashboard/agent-versions.routes.test.ts` › "refuses publish without agents:write and writes nothing"
* **Test:** `src/adapters/dashboard/agent-versions.routes.test.ts` › "stamps the session identity, not X-Dashboard-User"
* **Test:** `src/adapters/dashboard/authz-matrix.test.ts` › add rows for the four GET routes and the POST route

### Scenario 6: Every writer records history (legacy writers)
* **Given** an agent created with `POST /api/agents/create`, then its scope changed with `PATCH /api/agents/:id { knowledgeScope }`
* **When** `listRevisions(id)` runs
* **Then** it returns one `CLAUDE.md` rev and two `agent.yaml` revs (create + scope change), each `bodyHash` equal to the sha256 of the live object written, and the PUT route sends exactly **one** `PutObject` per save
* **Test:** `src/lib/agents/agent-config-writer.test.ts` › "createAgentFull, PATCH knowledgeScope and PUT file all write one history rev per file change"
* **Test:** `src/lib/agents/agent-config-writer.test.ts` › "PUT /agents/:id/file writes the live key once"

### Scenario 7: Legacy agents, deleted agents, and S3 down
* **Given** the built-in `main` with no live `CLAUDE.md` in S3
* **When** an operator publishes it
* **Then** `409 { error: 'agent_has_no_saved_prompt', message: "Save this helper's instructions once before publishing a version." }` (built-in prompts embed the task boot date, `agent-loader.ts:35,168,181`, so they are not stable content)
* **And** given agent `ops` with version `av_A` that is then deleted with `DELETE /api/agents/ops`, `loadAgent('ops', { versionId: 'av_A' })` still returns the v3 prompt (`deleteAgentFull` never touches `versions/` or `VER#` rows)
* **And** when S3 `PutObject` fails during publish, the response is `503 { error: 'storage_unavailable' }`, no `VER#`/`VERID#` row exists, and a retry succeeds with `created: true`
* **Test:** `src/lib/agents/agent-versions.test.ts` › "refuses to publish an agent with no saved prompt"
* **Test:** `src/lib/agents/agent-versions.test.ts` › "keeps versions loadable after the agent is deleted"
* **Test:** `src/lib/agents/agent-versions.test.ts` › "writes no version row when the S3 copy fails"

### Scenario 8: Backfill version 1 for existing agents
* **Given** 3 agents in the `agents` table, one of which already has `VER#000001`
* **When** the backfill migration `agents-v1-backfill` runs twice
* **Then** each agent has exactly one `VER#000001` built from its **live** S3 files (not its history rows), the agent without a live `CLAUDE.md` is skipped and listed in the result, and one audit row `migration_step` per agent processed is written
* **Test:** `scripts/migrations/agent-versions-backfill.test.ts` › "creates v1 from live files once and is safe to re-run"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-12 / US-012](US-012-workflow-definition-schema-validator.md) Workflow definition schema + validator (defines the `agentVersionId` field this story's loader serves). Consumers, not blockers: NZR-26 (test runner), NZR-34/36 (live engine, publish), NZR-19 (versions panel).
* **UI/UX Design:** N/A: backend; version shown on the agent page (NZR-19). Inventory row W-032 "Agent versions" is NO-MOCK-YET ([design.md](../foundation/design.md)). Copy returned by the API for the 409 case is the only user-facing text here and must use the plain word "helper" (round-5 plain-words rule, PENDING OWNER Q96–Q110 word list).
* **Non-Functional Requirements:** Expand/contract migration; running chats unaffected (the live key stays valid throughout, DATA-MODEL §4 step 5). Publish p95 ≤ 2 s locally (4 S3 calls + 1 transaction). Pinned load adds ≤ 1 DDB read + 2 S3 reads on a cache miss and is cached by `agentId@versionId`. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `agent.version_published`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Props: `{ seq, toolsChanged: boolean, knowledgeScopeChanged: boolean }` only. If NZR-44's product-event writer is not merged when this builds, the `agent_version_published` audit row is the record and the product event is added by NZR-44 (see NOTES).
* **Files to change:**

  | path | change |
  |---|---|
  | `src/lib/state/agent-file-history-repo.ts:54-136` | Split `saveAgentFile` into `appendRevision` (DDB only) + the S3 write; add `putVersion` (TransactWriteItems: `VER#<seq:6>` create-only, `VERID#<versionId>` create-only, `VERSEQ` counter `seq = :n` iff `seq = :n-1` or absent), `getVersion(agentId, versionId)`, `listVersions(agentId, limit)`. `listRevisions` must filter `begins_with(SK,'REV#')` so new row kinds don't leak into history |
  | `src/lib/config/agent-loader.ts:189-282` | `loadAgent(agentId, opts?: { versionId?: string })`; new `fetchVersion()` reads `agents/<id>/versions/<vid>/…`, verifies sha256, parses yaml with the existing `readYamlScalar`/`readYamlTools`, takes `model` from the snapshot; new errors `AgentVersionNotFoundError`, `AgentVersionIntegrityError`; cache key `agentId@versionId` |
  | `src/agent/agent-loop.ts:210-232`, `:1036` | add `agentVersionId?: string` to `AgentTurnRequest`; pass it to `loadAgent`; add `agentVersionId` to the `agent_turn` audit detail when present |
  | `src/lib/agents/agent-manager.ts:120-149` | `createAgentFull` writes both files through the new writer (history rev, `editedBy = opts.createdBy`) |
  | `src/adapters/dashboard/handler.ts:1628-1668` | PUT file: drop the duplicate S3 put (`:1650-1661`); `editedBy: dashboardIdentity(c)` |
  | `src/adapters/dashboard/handler.ts:1670-1697` | add `hasCapability(c,'agents:read')` to both history GETs; `/history/:revId` exact match only (today `startsWith` prefix match, `:1694`) |
  | `src/adapters/dashboard/handler.ts:1857-1859`, `:4911-4962` | `persistKnowledgeScopeToS3` writes through the new writer (history rev) |
  | `src/adapters/dashboard/handler.ts` (agents block, after `:1697`) | new routes: `POST /agents/:agentId/versions`, `GET /agents/:agentId/versions`, `GET /agents/:agentId/versions/:versionId` |
  | `src/lib/audit/audit-writer.ts:57-…`, `:234-…` | add actions `agent_version_published`, `migration_step`; add `agent_version_published` to `ALWAYS_AUDITED_ACTIONS` |
  | `scripts/migrations/index.ts` | register the backfill (`phase: 'backfill'`, `idempotencyKey: '<release>-001-agent-versions-v1'`) |
  | `src/adapters/dashboard/authz-matrix.test.ts` | add the 5 routes |
  | `docs/diagrams/architecture-security.md` | `handler.ts` + `agent-loop.ts` are mapped sources (`docs/diagrams.map:35-45`): add the version publish/load path |

* **New files:**
  - `src/lib/agents/agent-config-writer.ts`: the single writer for agent files: `writeAgentFile({agentId, filename, body, editedBy, note})` → put live key, then `appendRevision`; returns `{revId, bodyHash}`.
  - `src/lib/agents/agent-versions.ts`: `publishAgentVersion({agentId, createdBy, note})`, `canonicalBundle()`, `SNAPSHOT_FIELDS = ['model','knowledgeScope','tools','displayName'] as const`.
  - `src/lib/agents/agent-versions.test.ts`, `src/lib/agents/agent-config-writer.test.ts`, `src/lib/config/agent-loader.version.test.ts`, `src/agent/agent-loop.version.test.ts`, `src/adapters/dashboard/agent-versions.routes.test.ts`.
  - `scripts/migrations/agent-versions-backfill.ts` + `.test.ts`.
  - `src/lib/state/agent-file-history-repo.integration.test.ts`: LocalStack run proving `IfNoneMatch: '*'` returns 412 on a second put and the transaction conditions hold.
* **API contract:** (all under `/api`, behind the auth middleware, `handler.ts:1410-1436`)
  - `POST /agents/:agentId/versions` · capability `agents:write` · body `{ note?: string ≤ 200 chars }`, unknown keys → 400 `{error:'invalid_body'}` · `201 { versionId, seq, created: true, claudeMdHash, agentYamlHash, createdAt }` · `200 { …, created: false }` for identical content · `403 {error:'forbidden', requiredCapability:'agents:write'}` · `404 {error:'not_found'}` (no META row and not built-in) · `409 {error:'agent_has_no_saved_prompt', message}` · `409 {error:'version_conflict'}` after 3 retries · `503 {error:'storage_unavailable'}` (S3/DDB failure) · `503 {error:'audit_unavailable'}` if `writeAuditOrThrow` throws (the version exists; a retry returns `created:false` and audits again).
  - `GET /agents/:agentId/versions?limit=1..100` · `agents:read` · `200 { agentId, versions: [{ versionId, seq, createdBy, createdAt, note?, model, toolsCount, knowledgeScope }] }` newest first. No bodies.
  - `GET /agents/:agentId/versions/:versionId` · `agents:read` · `200 { versionId, seq, createdBy, createdAt, note?, snapshot, claudeMd, agentYaml }` · `404 {error:'not_found'}`.
  - `GET /agents/:agentId/history`, `/history/:revId` · now `agents:read` (was none) · response unchanged.
* **Data changes:**
  - Table `${app}-agent-file-history` (existing, `infra/lib/dynamo-stack.ts:192-199`), new row kinds under the same `PK = AGENT#<id>`:
    - `SK = VER#<seq:6>`: `{ versionId, seq, claudeMdRevId, agentYamlRevId, claudeMdHash, agentYamlHash, snapshot: { model, knowledgeScope, tools, displayName }, createdBy, createdAt, note? }`. Create-only (`attribute_not_exists(SK)`). No `ttl`.
    - `SK = VERID#<versionId>`: `{ seq }` pointer for O(1) lookup. Create-only.
    - `SK = VERSEQ`: `{ seq }` counter.
  - S3 config bucket: new prefix `agents/<id>/versions/<versionId>/{CLAUDE.md,agent.yaml}`, create-only, metadata `version-id`, `sha256`. Live keys unchanged.
  - `canonicalBundle` = JSON with sorted object keys `{ agentYamlHash, claudeMdHash, snapshot }`. Arrays (`tools`) keep their written order; do not sort them.
  - Publish reads the **live** S3 files; if no history rev has a matching `bodyHash` among the newest 200, it appends one (`note: 'publish snapshot'`) first, so `claudeMdRevId`/`agentYamlRevId` always resolve.
  - Migration: expand only (new row kinds, new prefix, new optional request field). Backfill `agents-v1-backfill` (idempotent, journaled by the registry, audit `migration_step` per agent). No contract in this story.
  - Rollback data: rows and objects are additive; leaving them is harmless. Never delete `versions/` objects (pins may reference them).
* **Security notes:**
  - SECURITY.md 2b **T4**: content-addressed write-once versions (done via `IfNoneMatch` + create-only rows), author from the session (fixes 2a B1 S/R for this path), a `tools`/`knowledgeScope` change is a privilege change → `toolsChanged`/`knowledgeScopeChanged` flags in the always-audited row.
  - DATA-MODEL risk 13: snapshot built from `SNAPSHOT_FIELDS` allow-list, never `{...meta}`. Test asserts no `Token`/`Secret` keys and that `xoxb-SYNTHETIC` appears nowhere in S3 bodies, DDB items or audit detail.
  - Authz: publish `agents:write`; reads `agents:read`. Closes the ungated history GETs (B1 I).
  - Audit: `writeAuditOrThrow` for publish (ADR 0020 §1); `agent_version_published` added to `ALWAYS_AUDITED_ACTIONS` so `audit_log_disabled` can't hide a privilege change. Detail carries ids and hashes only, never prompt text.
  - A pinned load never silently falls back to the live key (tamper or loss = hard error, visible to the runner).
  - No secrets handled; fixtures use `xoxb-SYNTHETIC`-style placeholders only.
* **Test plan:**
  - Frozen failing tests first (own commit, red SHA recorded): Scenario 1 "never copies bot tokens…", Scenario 2 "loads the pinned prompt, yaml and model…", Scenario 3 "fails closed…", Scenario 6 "…all write one history rev per file change".
  - Unit (vitest, mocked `ddb().send` and S3 client as in `src/lib/state/agents-repo.test.ts:1-15`): the files listed above.
  - Routes: `app.request()` with `dashboard-auth.js` mocked to role principals, as in `src/adapters/dashboard/authz-matrix.test.ts:24-60`.
  - Integration (LocalStack via `docker-compose.test.yml`, port 4566): `agent-file-history-repo.integration.test.ts`.
  - Fixtures: synthetic agents `ops`, `finance`; synthetic token strings only.
  - Commands: `npx vitest run src/lib/agents/agent-versions.test.ts src/lib/agents/agent-config-writer.test.ts src/lib/config/agent-loader.version.test.ts src/agent/agent-loop.version.test.ts src/adapters/dashboard/agent-versions.routes.test.ts src/adapters/dashboard/authz-matrix.test.ts scripts/migrations/agent-versions-backfill.test.ts`; then `npm run typecheck`; `npm test` (full); `npm run test:integration:all` for the LocalStack test; `node scripts/ci/diagrams-drift.mjs`; `node scripts/ci/secret-scan.mjs <changed files>`.
* **Repo rules that apply:**
  - `handler.ts` and `agent-loop.ts` route/flow change ⇒ update `docs/diagrams/architecture-security.md` (`docs/diagrams.map:35-45`), drift gate `scripts/ci/diagrams-drift.mjs`.
  - `writeAuditOrThrow` (not `writeAudit`) for the publish; audit `action` is a closed TS union, add members additively (`audit-writer.ts:57`).
  - Never repurpose a key prefix (`permissions.ts:84-86` rule applied to data, DATA-MODEL §4 rule 3): `VER#`/`VERID#`/`VERSEQ` are new.
  - Migration registry contract (`scripts/migrations/index.ts:1-27`): unique `idempotencyKey`, internally idempotent `run()`.
  - No new dependency (sha256 via `node:crypto`). Full `npm test` before push (CLAUDE.md:46).
* **Rollback:** Runtime-config flag `agents/versioned_load` (default `1`): `0` makes `loadAgent` ignore `versionId` and log `version_load_bypassed` (DATA-MODEL §4 table). The publish route and writer consolidation are reverted by `git revert`; rows and objects stay (additive, harmless). No data restore needed.
* **Build slices (proposal):**
  1. *One writer* (1–2 h): `agent-config-writer.ts`, `createAgentFull`, PUT file, `persistKnowledgeScopeToS3`, session identity, history GET gates. Turns green: Scenario 6, Scenario 5 identity + history gates.
  2. *Publish* (2–3 h): repo version rows, `agent-versions.ts`, POST/GET routes, audit actions, authz matrix. Turns green: Scenarios 1, 4, 5, 7 (publish parts).
  3. *Pinned load* (1–2 h): loader `versionId`, errors, cache key, `AgentTurnRequest.agentVersionId`, flag. Turns green: Scenarios 2, 3, 7 (deleted agent).
  4. *Backfill + integration* (1–2 h): migration, LocalStack test, diagram. Turns green: Scenario 8 + integration test.
* **Agent gotchas:**
  - **Three writers.** Missing one means a version that doesn't match what chats run. Grep `agents/\${` and `PutObjectCommand` across `src/` before declaring done.
  - **History is not truth** (risk 4): build versions from the live S3 bytes; history rows may be missing or ahead of S3.
  - **Model lives in DDB META**, not S3 (`agent-loader.ts:260-266`). A pinned load must not read META for the model. `getAffinityModel` (`agent-loop.ts:1045`) can still move to a fallback model on throttling; record the actual `modelId` in the turn audit; do not "fix" fallback here.
  - **Don't spread META** into the snapshot; tokens live there.
  - `listRevisions` today queries the whole partition (`agent-file-history-repo.ts:142-151`); new `VER#` rows will appear as fake revisions unless it adds `begins_with(SK, 'REV#')`.
  - Built-in prompts contain `new Date()` at module load (`agent-loader.ts:35`), so their "content" changes per boot. Never publish them.
  - `loadAgent` is called from ~16 places (`grep -rn "loadAgent(" src`); keep the signature backward compatible (optional 2nd arg).
  - LocalStack/Floci on port 4566: UNVERIFIED: whether `localstack/localstack:3.8` (`docker-compose.test.yml:12`) honours `IfNoneMatch` on `PutObject`; Floci lists "s3: enforce conditional writes" before 1.5.24 (`~/floci/CHANGELOG.md:2998`). Check in the integration test; if unsupported, the unit test with a mocked 412 is the gate and NOTES records it.
  - Unit tests mock AWS; `vitest.setup.ts` arms an AWS guard, so a forgotten mock fails loudly rather than calling AWS.

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** agents

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona B; pin = the workflow keeps the tested helper).
- [ ] Acceptance criteria cover both happy paths and edge cases (8 scenarios: publish, pinned run, fail-closed, idempotent/concurrent, permissions/identity, three writers, legacy/deleted/S3-down, backfill).
- [ ] UX/UI designs: N/A: backend; version shown on the agent page (NZR-19, W-032 NO-MOCK-YET).
- [ ] Dependencies have been identified and are unblocked (NZR-12 merged, so the `agentVersionId` field name is fixed).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71; NOTES proposes 8).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail); one writer for agent files; no new dependency.
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews the security boundary (snapshot allow-list, session identity, history GET gates, fail-closed loader).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: the `npx vitest run …` list in Test plan, `npm run typecheck`, full `npm test`, `npm run test:integration:all`, `node scripts/ci/diagrams-drift.mjs`.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; `docs/diagrams/architecture-security.md`; durable facts promoted to README/ADR (version model in the NZR-8 ADR set).
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
