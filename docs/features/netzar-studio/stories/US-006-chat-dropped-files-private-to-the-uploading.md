# [US-006] Chat-dropped files private to the uploading user's chat

> Backlog task NZR-6 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-012, FR-029, NFR-010.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** a file a user adds to knowledge from a chat to be searchable only in that user's chat with that agent, and every file added before the fix to be locked to admins until an admin reassigns it
* **So that** one user's documents are never returned to another user of the same agent, on any surface, and permission tests show 0 cross-user reads

---

## 2. Business Context & Description
* **Background:**
  * Known leak; week-0 T3 security step with NZR-5 (Q62, Q75). SECURITY.md §3b lists the frozen tests F6-1 to F6-9.
  * Q82: a viewer reads the shared/company scopes and **their own chat files**; admins and the agent's own runtime read private scopes.
  * Q83: files added before the fix have no reliable uploader record. They **fail closed**: admin-only (quarantined), audited. Admins get a **list of affected files** to reassign or delete.
  * Q84: not deployed to the legacy app. It is marked known-vulnerable and its secrets are rotated (US-043). The quarantine script is **not** run there.
  * PRD IDs: FR-012, FR-029, NFR-010. Threat B3 and risk #3 in [SECURITY.md](../foundation/SECURITY.md).
* **Current behaviour (d1d3a66):**
  * Only the dashboard chat can add a file to knowledge: the send route `POST /test-turn/stream` (`src/adapters/dashboard/handler.ts:2203`) passes `addToKnowledge: a.addToKnowledge === true` per attachment (`:2363`) into `processMedia` (`src/lib/media/process.ts:345-364`), which calls `ingestChatMedia`. Slack and Telegram never set `addToKnowledge` (grep: the flag appears only in `handler.ts` and `process.ts`).
  * Scope: `resolveChatIngestScope` returns the target agent's `knowledgeScope`; `shared` if `media/chat_kb_ingest_scope=shared`; `default` if the agent has none or fails to load (`src/lib/media/chat-kb-ingest.ts:61-70`, used at `:135`).
  * Tags name the surface and agent, not the chat or uploader (`:144-149`). `docId` is a content hash (`:42-44`); dedup within the scope (`:140-142`) tells user B that user A already added the same file.
  * Retrieval: `s3_vectors_search` searches the agent's own scope + `default` + `shared` for every chat on every surface (`src/lib/tools/vector-tools.ts:102`). So user B, on any surface, gets user A's passages. Before NZR-5, any viewer could also list them through `/vectors*`.
  * The confirmation message promises cross-surface access: "Ask me about it anytime — from Slack, Telegram, or the dashboard." (`chat-kb-ingest.ts:204`).
  * `POST /ingest/stream` accepts any `s3Key` under `uploads/` (`isUploadKey`, `src/lib/vectors/store.ts:124-126`), including another user's chat staging prefix `uploads/chat/<sha256(identity)[:16]>/` (`handler.ts:306-309`). It then reads the object (`:3268`) and deletes it (`:3314`).
  * What we know about legacy files: each chunk row carries `tags` (with `chat`, the surface and `agent:<id>`), `docTitle` (file name), `source` (raw-bucket URL `s3://<raw>/<surface>/<chatId>/YYYY/MM/DD/<ms>-<name>`, built at `process.ts:253`), `uploadedAt` and `scope` (`store.ts:147-160`). The `source` names the chat of the **first** upload only. Later uploads of the same bytes were deduped, so other uploaders are not recorded. This is why Q83 fails closed instead of trusting it.
  * The raw attachment download is already owner-only with an audited admin override (`handler.ts:3949-3972`: `ownsConversation`, then `security:write` + `auditedOverride`). Keep it.
* **Target behaviour:**
  * A chat-added file is ingested into a chat-private scope `chatKnowledgeScope(agentId, chatId, uploaderId)` = `chat_` + first 24 hex of `sha256(agentId + '|' + chatId + '|' + uploaderId)`. `uploaderId` is `dashboardIdentity(c)` of the sender. The config value `media/chat_kb_ingest_scope` and the agent's `knowledgeScope` no longer affect chat uploads.
  * No uploader → no ingest (fail closed). The turn continues with inline analysis, as today on ingest failure.
  * `s3_vectors_search` adds exactly one extra scope, the current chat's own chat-private scope, when the turn has a `userId`. It never adds another chat's scope, and a model-supplied scope naming another chat is refused.
  * Through `/vectors*`, a user reads their own chat files by passing `agentId` + `chatId`. The server derives the scope from the caller's identity, so nobody can derive another user's scope. A raw `chat_*` scope name is refused to everyone except an admin using the audited override.
  * `/ingest/stream` refuses any `s3Key` under `uploads/chat/`.
  * Legacy: a one-off script moves every chunk set tagged `chat` out of the agent, `default` and `shared` scopes into one admin-only scope `chat_quarantine`. Each move is audited and nothing is deleted. Admins list the quarantined files and reassign each to a dashboard chat or delete it.
* **Out of scope:**
  * Promoting a chat file into agent or company knowledge (Library / Company facts, separate approved action, later story).
  * A user deleting their own chat file (follow-up; admins can delete).
  * An admin screen for the quarantine list. This step ships the API + CLI; the UI comes later (see NOTES).
  * Reassigning to Slack/Telegram chats (no dashboard owner identity; delete only).
  * Running the script on the legacy app (Q84).
* **Target Value:** 0 cross-user passages returned in the frozen tests F6-1 to F6-14 (all green). After the script runs on the local/dev data: 0 documents tagged `chat` outside `chat_*` scopes (script `--verify` prints `0`).
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

Fixture: agent `ops` (`knowledgeScope: ops_private`); user A = `dashboard:user:alice`, chat `dashboard:chatA`; user B = `dashboard:user:bob`, chat `dashboard:chatB`. `SA = chatKnowledgeScope('ops','dashboard:chatA','dashboard:user:alice')`, `SB` likewise for B.

### Scenario 1: The uploader's file goes to their chat scope and the agent uses it there
* **Given** A sends a PDF with `addToKnowledge: true` in `dashboard:chatA`
* **When** the turn runs, and A then asks a question in the same chat
* **Then** `ingestDocument` receives `scope === SA`, which is not `ops_private`, `default` or `shared`, with tags `['chat','dashboard','agent:ops','owner:<first 16 hex of sha256(uploaderId)>']`; the confirmation reads "📚 Indexed <name> (<n> chunks). Ask me about it in this chat."; and A's next `s3_vectors_search` calls `search` with `SA` (plus `ops_private`, `default`, `shared`) and returns the passage
* **Test:** `src/lib/media/chat-kb-ingest.scope.test.ts` › "F6-1 ingests a chat-added document into the uploading chat's private scope, not the agent scope"; `src/lib/tools/vector-tools.chat-scope.test.ts` › "F6-6 s3_vectors_search in user A's chat finds A's chat-added passage"; `src/lib/media/chat-kb-ingest.test.ts` › "says the file is available in this chat" (rewritten)

### Scenario 2: Config and agent settings cannot widen a chat upload
* **Given** `media/chat_kb_ingest_scope=shared`, or `loadAgent('ops')` throws, or the agent has no `knowledgeScope`
* **When** A adds a file from chat
* **Then** the scope is still `SA` in all three cases; never `shared` or `default`
* **Test:** `src/lib/media/chat-kb-ingest.scope.test.ts` › "F6-2 ignores media/chat_kb_ingest_scope=shared for chat uploads", "F6-3 uses the chat-private scope, never default, when the agent config cannot load"

### Scenario 3: No uploader identity means no ingest
* **Given** `processMedia` is called with `addToKnowledge: true` but no `uploaderId` (or an empty string)
* **When** the media pipeline runs
* **Then** `ingestChatMedia` returns `null`, `ingestDocument` is not called, an audit row `knowledge_ingest` with `result:'blocked'`, `detail.reason:'no_uploader'` is written, and the turn continues with the inline analysis
* **Test:** `src/lib/media/chat-kb-ingest.scope.test.ts` › "F6-10 refuses to ingest a chat file with no uploader"

### Scenario 4: Same file from two users is two private copies
* **Given** A already added `report.pdf` in chatA
* **When** B adds the same bytes in chatB
* **Then** `documentExists` is checked only against `SB`; the file is ingested into `SB`; the result has `deduped: false`; B's confirmation does not say "already in the knowledge base"
* **Test:** `src/lib/media/chat-kb-ingest.scope.test.ts` › "F6-4 does not deduplicate across chats"

### Scenario 5: Another user of the same agent gets nothing, on any surface
* **Given** A's file is in `SA`
* **When** B asks `ops` about it in chatB (dashboard), and separately a Slack and a Telegram user ask `ops`
* **Then** `search` is never called with `SA`; no passage from A's file is in any result; from chatB, `args.scope = SA` returns `isError` and `search` is not called
* **Test:** `src/lib/tools/vector-tools.chat-scope.test.ts` › "F6-5 s3_vectors_search in user B's chat never searches user A's chat scope", "F6-7 refuses a model-supplied scope naming another chat's private scope", "F6-11 a Slack or Telegram turn adds no chat-private scope it did not write"

### Scenario 6: Knowledge routes give a user their own chat files and nobody else's
* **Given** A, B (viewers), an operator and an admin
* **When** A calls `GET /api/vectors?agentId=ops&chatId=dashboard:chatA`; B calls the same URL; a viewer and the operator call `GET /api/vectors?scope=<SA>`, `POST /api/vectors/search {"scope":"<SA>",…}`, `POST /api/vectors/answer {"scope":"<SA>",…}` and `DELETE /api/vectors/<SA>/doc1`
* **Then** A gets 200 with A's file listed (`scope` in the body is `SA`); B gets 200 with `count: 0` (B's derived scope is `SB`, which is empty); the viewer and operator get `403 {"error":"forbidden_scope"}` on all four, and no store call happens
* **Test:** `src/adapters/dashboard/vectors.scope.test.ts` › "F6-8 /vectors* refuse a chat-private scope to anyone but its owner", "F6-12 a user lists their own chat files by agentId and chatId"

### Scenario 7: Admin access to a chat scope is an audited override
* **Given** an admin (holds `knowledge:private:read` and `security:write`)
* **When** they call `GET /api/vectors?scope=<SA>`, first with the audit write working and then with `writeAuditOrThrow` rejecting
* **Then** the first returns 200 after one awaited `session_read_override` row (`detail: {scope:'knowledge', requestedBy:<admin identity>}`); the second returns `500 {"error":"override_not_audited"}` and `listDocuments` is not called
* **Test:** `src/adapters/dashboard/vectors.scope.test.ts` › "F6-13 an admin reads a chat scope only through an audited override"

### Scenario 8: A staged chat upload cannot be pulled into knowledge by someone else
* **Given** an operator, and A's staged object `uploads/chat/<A's tag>/<id>/a.pdf`
* **When** the operator calls `POST /api/ingest/stream {"s3Key":"uploads/chat/<A's tag>/<id>/a.pdf"}`
* **Then** the stream emits `{stage:'error', detail:'invalid upload key'}`; `getObjectBuffer` and `deleteObject` are not called
* **Test:** `src/adapters/dashboard/vectors.scope.test.ts` › "F6-9 /ingest/stream refuses an s3Key under another caller's chat upload prefix"

### Scenario 9: Legacy chat files are quarantined, audited, nothing lost
* **Given** local data with docs tagged `chat` in `ops_private`, `default` and `shared`, plus untagged docs in the same scopes
* **When** an admin runs `npx tsx scripts/nzr6-quarantine-chat-docs.ts` (dry run), then `--apply`, then `--apply` again, then `--verify`
* **Then** the dry run prints each candidate (`fromScope`, `docId`, title, chunks) and changes nothing; the first apply copies each into `chat_quarantine` as docId `<normalizedFromScope>__<docId>` with tag `from:<normalizedFromScope>` and its chunks and embeddings unchanged, writes one awaited `knowledge_quarantined` audit row per doc **before** deleting the original, and leaves untagged docs alone; the second apply moves nothing (idempotent); `--verify` prints `chat docs outside chat_ scopes: 0`. If the audit write fails, that doc stays in its original scope and the script exits non-zero
* **Test:** `scripts/nzr6-quarantine-chat-docs.test.ts` › "F6-14 moves chat-tagged docs to chat_quarantine, audits each before delete, and is idempotent", "keeps a doc in place when its audit write fails"

### Scenario 10: Admins get the reassign list and can reassign or delete
* **Given** quarantined docs, a viewer and an admin
* **When** the viewer calls `GET /api/knowledge/quarantine`; the admin calls it; the admin calls `POST /api/knowledge/quarantine/<qDocId>/reassign {"agentId":"ops","chatId":"dashboard:chatA"}`; the admin calls the same with a chat that has no dashboard owner; the admin calls `DELETE /api/vectors/chat_quarantine/<qDocId>`
* **Then** the viewer gets `403 {"error":"forbidden","requiredCapability":"knowledge:private:read"}`; the admin gets `200 {count, docs:[{docId, title, agentId, surface, fromScope, uploadedAt, chunks, chars, suggestedChatId}]}`, where `suggestedChatId` is read from `source` and is a hint, not an owner; the reassign moves the doc into `chatKnowledgeScope('ops','dashboard:chatA', <session owner>)` under its original `docId`, after an awaited `knowledge_reassigned` row, and returns `200 {ok:true, docId, agentId, chatId}`; the no-owner case returns `409 {"error":"no_dashboard_owner"}` and moves nothing; the delete returns 200 and writes `knowledge_delete`
* **Test:** `src/adapters/dashboard/knowledge-quarantine.test.ts` › "lists quarantined docs to admins only", "reassigns a doc into the chat owner's scope after an awaited audit", "refuses to reassign to a chat with no dashboard owner", "a failed audit leaves the doc in quarantine"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-5 / US-005](US-005-fix-vectors-scope-leak-knowledge-routes-enforce.md) merged first (it adds `scope-access.ts`, `canReadScope`, `knowledge:private:read`, the reserved `chat_` namespace and `scopeAccess` in `handler.ts`). NZR-43 before both (same file).
* **UI/UX Design:** No new screen. One user-visible text change: the knowledge confirmation (`chat-kb-ingest.ts:203-204`) says "Ask me about it in this chat." instead of promising Slack/Telegram/dashboard access, and the dedup text (`:202`) stays only for the same chat. The Knowledge tab does not list chat scopes (they are hashes; agents are listed only to admins after US-005). Admins use the API/CLI for the quarantine list in this step.
* **Non-Functional Requirements:** No data loss: the script copies first, audits, then deletes, and is idempotent (expand/contract). Embeddings are moved, not recomputed (no Bedrock spend). One extra S3 prefix listed per dashboard search turn. A brand-new chat scope is empty, so the cost is one `ListObjectsV2`, target < 50 ms added p95 (UNVERIFIED, measure in the critic run). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** New audit actions `knowledge_quarantined`, `knowledge_reassigned` (both awaited via `writeAuditOrThrow`, both in `ALWAYS_AUDITED_ACTIONS`). Refusals reuse `knowledge_scope_denied` from US-005 (`detail.event:'security.scope_denied'`, Q55). Audit `detail` carries `docId`, scope **hashes**, `agentId`, `chatId` and chunk counts. No file names: they can be personal data, and the audit log is viewer-readable (`audit:read`). NZR-44 catalogues the actions.
* **Files to change:**

  | path | change |
  |---|---|
  | `src/lib/vectors/scope-access.ts` (from US-005) | Add `chatKnowledgeScope(agentId, chatId, uploaderId)`, `QUARANTINE_SCOPE = 'chat_quarantine'`, `isChatScope(s)` (`normalizeScope(s).startsWith('chat_')`). |
  | `src/lib/media/chat-kb-ingest.ts:61-70` | Delete `resolveChatIngestScope` (only caller `:135` and its test). |
  | `src/lib/media/chat-kb-ingest.ts:72-84` | `ChatKbIngestArgs` gains `uploaderId: string`. |
  | `src/lib/media/chat-kb-ingest.ts:98-160` | Empty `uploaderId` → audit `blocked`/`no_uploader`, return `null`. Scope = `chatKnowledgeScope(targetAgentId, chatId, uploaderId)`. Tags add `owner:<sha256(uploaderId)[:16]>`. |
  | `src/lib/media/chat-kb-ingest.ts:196-205` | Confirmation text: "Ask me about it in this chat." |
  | `src/lib/media/process.ts:130-147` | `RawMediaInput` gains `uploaderId?: string`. |
  | `src/lib/media/process.ts:345-364` | Pass `uploaderId: input.uploaderId ?? ''` to both `ingestChatMedia` calls. |
  | `src/adapters/dashboard/handler.ts:2352-2364` | Pass `uploaderId: dashboardIdentity(c)` to `processMedia`. |
  | `src/lib/tools/vector-tools.ts:100-110` | If `ctx.userId`, append `chatKnowledgeScope(ctx.agentId, ctx.chatId, ctx.userId)` to `scopes` (so it is also an allowed `args.scope`). Never add any other `chat_*` scope. The dashboard sets `userId: dashboardIdentity(c)` on the turn (`handler.ts:2488`) and `agent-loop.ts:1495-1500` copies it into the tool context. |
  | `src/adapters/dashboard/handler.ts` `scopeAccess` (from US-005) | (a) If `agentId` + `chatId` are given (query for GET, body for search/answer), scope = `chatKnowledgeScope(agentId, chatId, dashboardIdentity(c))`, allowed with `chat:read` + `vectors:read`. (b) A raw scope with `isChatScope` → allowed only with `knowledge:private:read` **and** `security:write` **and** `await auditedOverride(c, 'knowledge')` (`handler.ts:349-369`); audit failure → 500 `override_not_audited`; otherwise 403 `forbidden_scope`. (c) `/ingest`, `/ingest/stream` refuse any `chat_*` target scope for everyone (chat scopes are written only by the chat pipeline and the reassign route). |
  | `src/adapters/dashboard/handler.ts:3246-3250` | `/ingest/stream`: also refuse `body.s3Key.startsWith('uploads/chat/')` with the same `invalid upload key` error. |
  | `src/adapters/dashboard/handler.ts` (new routes next to `/vectors*`) | `GET /knowledge/quarantine`, `POST /knowledge/quarantine/:docId/reassign` (see API contract). |
  | `src/lib/vectors/store.ts` | Add `listScopePrefixes(): Promise<string[]>` (`ListObjectsV2` on `index/` with `Delimiter: '/'`, paginated) and `readDocumentRows(scope, docId)` (`GetObject` of `keyFor(scope, docId)`, parse JSONL). Moves use `putDocument` (`:180-216`, which re-stamps `metadata.scope`) then `deleteDocument`. |
  | `src/lib/audit/audit-writer.ts:57-206`, `:234-278` | Add `knowledge_quarantined`, `knowledge_reassigned` to the union and to `ALWAYS_AUDITED_ACTIONS`. |
  | `src/lib/media/chat-kb-ingest.test.ts:97, :139, :191, :201` | Rewrite the four tests that pin the leaking behaviour ("ingests … into the agent scope", "uses the shared scope when configured", "falls back to default scope when loadAgent fails", "mentions cross-surface availability"). The owner's review must call this out (SECURITY.md §3b). |
  | `docs/diagrams/architecture-security.md` | Drift line: chat-private knowledge scopes, quarantine scope, two admin routes; no new principal, grant or boundary. |
  | `docs/features/netzar-studio/foundation/SECURITY.md` §3b, §7 risk #3 | Cite the test files at the merge SHA, and the `--verify` output from the local run. |
  | `src/lib/media/process.ts:608` | The ack text "Ask me anything about it — from Slack, …" becomes "Ask me anything about it in this chat." (second place the cross-surface promise is shown to users). |
  | `src/lib/media/chat-kb-ingest.ts:1-22` | Header comment: replace "drop a PDF in Telegram, ask about it from Slack tomorrow" and the scope bullets with the chat-private rule. |
  | `docs/features/netzar-studio/foundation/DATA-MODEL.md:96` | Mark the "anyone chatting with that agent … retrieves the file" finding fixed by NZR-6. |

* **New files:**
  * `src/lib/media/chat-kb-ingest.scope.test.ts` — F6-1..F6-4, F6-10.
  * `src/lib/tools/vector-tools.chat-scope.test.ts` — F6-5..F6-7, F6-11.
  * `src/adapters/dashboard/knowledge-quarantine.test.ts` — Scenario 10.
  * `scripts/nzr6-quarantine-chat-docs.ts` — flags `--apply` (default dry run), `--verify`; pattern `scripts/p1-migrate-legacy-chats.ts` (dry-run/apply one-off). It does not register in `scripts/migrations/index.ts`: a fresh install has nothing to move. Exits non-zero on any audit failure.
  * `scripts/nzr6-quarantine-chat-docs.test.ts` — F6-14 with a mocked store.
  * F6-8, F6-9, F6-12, F6-13 go into `src/adapters/dashboard/vectors.scope.test.ts` (from US-005).
* **API contract:**
  * `GET /api/vectors?agentId=<id>&chatId=<id>` — `vectors:read` + `chat:read`. 200 `{scope:<derived>, count, docs}`. `POST /api/vectors/search` and `/vectors/answer` accept `{agentId, chatId}` in place of `scope` (both given → 400 `{error:'invalid_scope'}`).
  * Raw `chat_*` scope on `/vectors*`: 403 `{error:'forbidden_scope'}`, or for an admin 200 after an awaited override, or 500 `{error:'override_not_audited'}`.
  * `GET /api/knowledge/quarantine` — `knowledge:private:read`; 403 `{error:'forbidden', requiredCapability:'knowledge:private:read'}`. 200 `{count, docs:[{docId, title|null, agentId|null, surface|null, fromScope, uploadedAt, chunks, chars, suggestedChatId|null}]}`, newest first.
  * `POST /api/knowledge/quarantine/:docId/reassign` `{agentId, chatId}` — `knowledge:private:read` + `security:write`. 200 `{ok:true, docId, agentId, chatId}`. 404 `{error:'not_found'}` (doc not in quarantine). 409 `{error:'no_dashboard_owner'}` (no session, or `session.userId` is not a `dashboard:user:<person>` owner; legacy `dashboard:<tokenHash>` chats are refused until migrated, since chat search uses the person identity). 409 `{error:'reassign_conflict'}` (the target copy kept changing under a chat upload across 3 ETag-checked merge attempts; the doc stays in quarantine, retry). 409 `{error:'reassign_in_progress'}` (another reassign of the same doc holds its claim; nothing moved). 500 `{error:'override_not_audited'}` (audit failed, nothing moved). 400 `{error:'invalid_body'}`.
  * Delete a quarantined doc: existing `DELETE /api/vectors/chat_quarantine/:docId` (US-005 rule + the audited override).
* **Data changes:**
  * New S3 prefixes `index/chat_<24hex>/` (per chat) and `index/chat_quarantine/`. No DynamoDB change.
  * One-off move of legacy chat docs (Scenario 9). Copy → audit → delete per doc. Rollback of the data: the reverse move is possible from the `from:<scope>` tag and the original docId in the quarantine docId, but it **must not** be run, because it re-opens the leak. A failed move leaves the doc where it was.
  * Run order: merge code (new uploads go private), then run the script on local/dev data. On the legacy app: not run (Q84).
* **Security notes:**
  * Threats: SECURITY.md B3, risk #3; Q83 fail-closed.
  * Authz rule: a chat scope is derivable only from the caller's own identity; the raw name is admin-override-only; writes into `chat_*` only from the chat pipeline (uploader-bound) and the admin reassign route.
  * The hash binds the uploader, so an expired ephemeral session's `chatId` reused by another principal does not reach the old files.
  * Audit: overrides and moves are awaited and refuse on audit failure (same posture as `session_read_override`). Refusals are fire-and-forget `knowledge_scope_denied`.
  * No file names in audit detail (viewer-readable log). The quarantine list API returns titles to admins only.
  * Run `node scripts/ci/secret-scan.mjs <changed files…>`.
* **Test plan:**
  * Frozen failing tests first, own commit, red SHA recorded: F6-1 to F6-14 (all red today; F6-6 is red because no chat scope exists yet).
  * Rewritten in the same commit as the fix (not the red commit): `chat-kb-ingest.test.ts:97, :139, :191, :201`.
  * Must stay green: `process.p3.test.ts` › "keeps a chat document out of the knowledge base unless the sender opts in", `process.test.ts`, `chat-uploads.test.ts`, `vector-tools.scope.test.ts`, `vectors.scope.test.ts` F5-*, `store.scope.test.ts`, the attachment-override tests for `/sessions/attachment`.
  * Commands: `npx vitest run src/lib/media src/lib/tools/vector-tools.chat-scope.test.ts src/lib/tools/vector-tools.scope.test.ts src/adapters/dashboard/vectors.scope.test.ts src/adapters/dashboard/knowledge-quarantine.test.ts scripts/nzr6-quarantine-chat-docs.test.ts` (`vitest.config.ts:9` includes `scripts/**/*.test.ts`), `npm run typecheck`, full `npm test`, `node scripts/ci/diagrams-drift.mjs`.
* **Repo rules that apply:** `handler.ts` changed ⇒ architecture-security drift line; new audit actions ⇒ closed union; no new capability (uses `knowledge:private:read` from US-005); no new dependency; full `npm test` before push; owner yes for every merge/push and for running `--apply` (Q50); T3 failing-test-first commit.
* **Rollback:** `git revert` of the merge commit restores old ingest behaviour (the leak) and is only for a broken build. Quarantined docs stay quarantined after a revert of this story alone: the old ingest code never searches `chat_quarantine`, and US-005's route check (a separate merge) still refuses `chat_*` to non-admins, so legacy files stay closed. Reverting US-005 as well would re-open every scope, `chat_quarantine` included. New chat files already in `chat_*` scopes become unreachable to their owners after a revert, but are not exposed.
* **Build slices (proposal):**
  1. **Red tests** (~1.5 h): the five new test files.
  2. **Private ingest + retrieval** (~1.5 h): `chatKnowledgeScope`, `chat-kb-ingest.ts`, `process.ts`, `handler.ts:2363`, `vector-tools.ts`, rewritten tests. F6-1..F6-7, F6-10, F6-11 green.
  3. **Route rules** (~1 h): `scopeAccess` chat cases, `/ingest/stream` key guard. F6-8, F6-9, F6-12, F6-13 green.
  4. **Quarantine** (~2 h): store helpers, script, two admin routes, audit actions. F6-14 + Scenario 10 green; owner yes, then the dry run, `--apply` and `--verify` on local data; output pasted into the HANDOFF.
* **Agent gotchas:**
  * Only the dashboard sets `addToKnowledge` today, but `RawMediaInput` is shared by all three surfaces. Make `uploaderId` explicit in the args; never infer it from `chatId`.
  * `ctx.userId` on Slack is the Slack user id and on Telegram the chat id (`agent-loop.ts:263-265`). Adding a chat scope for them is harmless (it is empty, since nothing writes there) and keeps the rule surface-agnostic. Do not special-case `surface === 'dashboard'` in the search tool.
  * The dedup message "already in the knowledge base" was itself a cross-user signal. After the fix it can only come from the same chat scope.
  * `normalizeScope` keeps `chat_` + hex unchanged, so the derived scope and its S3 prefix are identical. Assert it in a unit test.
  * Quarantine docIds must be prefixed with the source scope: the same content-hash docId can exist in `ops_private` and `default`, and a plain copy would overwrite one with the other.
  * `suggestedChatId` comes from `source` (first uploader only). Never auto-reassign from it (Q83).
  * Four existing tests pin the leak (not two, as SECURITY.md says): `chat-kb-ingest.test.ts:97, :139, :191, :201`.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Security fixed (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47). See NOTES: 8 proposed (quarantine script + reassign routes add about 2-3 h).
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** security, knowledge

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona E; 0 cross-user reads).
- [ ] Acceptance criteria cover both happy paths and edge cases (10 scenarios: ingest, config bypass, no uploader, dedup, other users and surfaces, routes, admin override, staged keys, quarantine, reassign).
- [ ] UX/UI designs: N/A, no new screen. The confirmation text change is specified in section 4.
- [ ] Dependencies have been identified and are unblocked (NZR-43 and NZR-5 merged).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Full T3 review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews the security boundary and explicitly signs off the four rewritten `chat-kb-ingest.test.ts` tests.
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: the vitest command in section 4, `npm run typecheck`, full `npm test`, `node scripts/ci/diagrams-drift.mjs`, `node scripts/ci/secret-scan.mjs <changed files>`.
- [ ] Quarantine run on local/dev data with owner yes: dry-run list, `--apply` output, and `--verify` = `0` pasted into the HANDOFF. Until then NZR-6 is not done (SECURITY.md §3b).
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts the evidence summary and the confirmation-text change.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; SECURITY.md §3b cites the test files at the merge SHA; architecture-security drift line; the "ask from Slack" promise removed from the header comment and docs.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists. Legacy app: not deployed, script not run (Q84).

<!-- runner:evidence:start -->
### Story exit gate evidence (runner)

```
Story: NZR-6   HEAD: a0e224e5a35f9ad69cf4437d7ce026d4d57049fb
G1 code review : PASS  reviewer=claude-opus fresh critic session=a14cd010-ea62-41ce-8455-9d3aff048a20 findings=1/9 open_low=8 greptile=GR:PASS
GR greptile    : PASS confidence=5 comments=0 plus=True
G2 unit tests  : PASS        red=2f20dfb green=a0e224e counts=4768/4768 story_files=68/68 typecheck=ok
G2b integration: PENDING run=- (not in runner scope yet, Goal v1)
G3 UAT         : PASS scenarios=10/10 pending_owner=0 accepted_by=owner (Telegram) date=2026-10-25
G4 E2E         : PASS run=docs/features/netzar-studio/evidence/NZR-6/e2e-run.txt counts=18/18
G5 Opik eval   : N/A     experiment=- (not in runner scope yet, Goal v1)
Lessons checked: L-001,L-002,L-003,L-004,L-005,L-006,L-007,L-008,L-009,L-010,L-011,L-012,L-013,L-014,L-015,L-016,L-017   New lessons: L-014, L-015, L-016, L-017
```

- [e2e-run.txt](../evidence/NZR-6/e2e-run.txt)
- [g1-review.md](../evidence/NZR-6/g1-review.md)
- [gates.md](../evidence/NZR-6/gates.md)
- [uat-transcript.md](../evidence/NZR-6/uat-transcript.md)
- [uat.json](../evidence/NZR-6/uat.json)
<!-- runner:evidence:end -->
