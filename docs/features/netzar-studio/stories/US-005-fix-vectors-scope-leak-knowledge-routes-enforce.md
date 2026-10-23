# [US-005] Fix /vectors scope leak: knowledge routes enforce scope access

> Backlog task NZR-5 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-012, FR-029, NFR-007, NFR-010.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** every knowledge route to check, on the server and before any store, embedding or model call, that the caller may read the scope they name
* **So that** viewers and operators can no longer list, search, answer from or delete another agent's private knowledge, and permission tests show 0 cross-scope reads

---

## 2. Business Context & Description
* **Background:**
  * Known leak found in discovery; week-0 T3 security step (Q62, Q75). SECURITY.md §3a cites this step's tests as evidence when it merges.
  * Owner rule Q82 (defined in SECURITY.md, one test per role): **admins and the agent's own runtime** read an agent's private scope; everyone else reads the shared/company scopes and their own chat files only. "Company" maps to today's `shared` and `default` corpora; no separate company scope exists yet (NZR-8).
  * Q81: lands **after** NZR-43 (US-043), which edits the same file (`src/adapters/dashboard/handler.ts`).
  * Q84: not deployed to the legacy app; it is marked known-vulnerable.
  * PRD IDs: FR-012, FR-029, NFR-007, NFR-010. Threat B3 and risk #1 in [SECURITY.md](../foundation/SECURITY.md).
* **Current behaviour (d1d3a66):**
  * `GET /vectors` lists any `?scope=` (`handler.ts:3081-3088`). `POST /vectors/search` searches any body `scope` (`:3331-3360`, scope at `:3338`). `POST /vectors/answer` does the same, then spends Bedrock money (`:3368-3520`, scope at `:3386`, search `:3420`, model `:3446`). The only gate on all three is `vectors:read`, which every profile from viewer up holds (`src/lib/auth/permissions.ts:205`).
  * `DELETE /vectors/:scope/:docId` deletes from any scope with `agents:write` (operator+) (`handler.ts:3522-3539`).
  * `POST /ingest` (`:3090-3143`) and `POST /ingest/stream` (`:3196-3327`) write into any body `scope` with `agents:write`. An operator can plant text in any agent's corpus (poisoning) or, after NZR-6, in a user's chat scope.
  * `POST /vectors/upload-url` is gated on `vectors:read` only (`:3174-3177`), so a viewer can mint staging-bucket PUT URLs.
  * A fifth read path: the Jarvis `query` tool, resource `vectors`, lists any `params.scope` (`src/adapters/dashboard/jarvis.ts:1250-1254`, guard `authorizeRead` at `:1095` checks only `minRole: 'viewer'`, `src/lib/jarvis/route-manifest.ts:66`).
  * Scopes are free-form. Every read and write folds the name with `normalizeScope` (`src/lib/vectors/store.ts:372-374`, `/[^A-Za-z0-9_-]/g → '_'`), so `finance.private`, `finance private` and `finance/private` all reach `index/finance_private/`.
  * The agent runtime is already limited: `s3_vectors_search` reads only the agent's own `knowledgeScope` plus `default` and `shared` and refuses any other model-supplied scope (`src/lib/tools/vector-tools.ts:83-110`, tests in `src/lib/tools/vector-tools.scope.test.ts`); `s3_vectors_ingest` writes only the agent's own scope (`vector-tools.ts:235-255`).
  * The SPA Knowledge tab (`web/src/pages/Vectors.tsx:209-213`) offers `default`, `shared` and one option per agent **id** from `GET /agents`, and sends the chosen scope to `GET /vectors`, `/ingest/stream`, `/vectors/search`, `DELETE /vectors/:scope/:docId` (`:197, :254, :306, :318`) and to `/vectors/answer` via `KnowledgeModelTest` (`web/src/components/KnowledgeModelTest.tsx:173, :213`). The route itself needs `vectors:read` (`web/src/App.tsx:280`, `web/src/components/Sidebar.tsx:179`).
* **Target behaviour:**
  * One server function decides scope access: `canReadScope(caps, scope)`.
    * `default`, `shared` (after `normalizeScope`): any principal with `vectors:read`.
    * Any other scope (an agent's private scope, an unknown name, or a reserved `chat_*` scope from NZR-6): only a principal holding the new capability `knowledge:private:read` (admin, org-admin, owner; grantable in custom profiles).
  * Access to the caller's **own** chat files goes through `agentId` + `chatId` parameters, never a raw `chat_*` name. This is delivered in NZR-6 (US-006); this story leaves the hook.
  * The check runs on the normalized name, before any store, embedding, model or usage call, on: `GET /vectors`, `POST /vectors/search`, `POST /vectors/answer`, `DELETE /vectors/:scope/:docId`, `POST /ingest`, `POST /ingest/stream`, and the Jarvis `vectors` resource.
  * Every refusal returns the same `403 {"error":"forbidden_scope"}` (private and unknown look identical) and writes an always-audited `knowledge_scope_denied` row with a scope hash, not the name.
  * `POST /vectors/upload-url` needs `agents:write`.
  * The SPA shows agent scopes in the Knowledge tab only to principals holding `knowledge:private:read`; viewers and operators see `default` and `shared`.
  * The agent runtime keeps its current rule. A new guard makes sure a `knowledgeScope` in the reserved `chat_` namespace is refused.
* **Out of scope:**
  * Chat-private scopes, the owner's own chat files, the legacy quarantine (NZR-6, US-006).
  * Per-agent membership lists (Q82: deferred to 2027 / NZR-8 knowledge-layers ADR).
  * The SPA using agent **ids** as scope names while agents search their `knowledgeScope` (pre-existing mismatch; see NOTES).
  * `/api/config*` (NZR-43, US-043).
* **Target Value:** 0 successful cross-scope reads, writes or deletes across 7 routes (6 HTTP + 1 Jarvis) for the 3 roles viewer, operator and admin, measured by the frozen tests F5-1 to F5-12 (all green). Viewer access to `default`/`shared` unchanged (F5-7 green).
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

Fixture for all scenarios (as SECURITY.md §3a): agents `ops` (`knowledgeScope: ops_private`) and `finance` (`knowledgeScope: finance_private`); principals by role via the mocked `dashboard-auth.js`.

### Scenario 1: Viewer is refused another agent's private scope on every read route (viewer test)
* **Given** a viewer
* **When** they call `GET /api/vectors?scope=finance_private`, `POST /api/vectors/search {"query":"q","scope":"finance_private"}` and `POST /api/vectors/answer {"query":"q","scope":"finance_private","modelId":<a catalog id>}`
* **Then** each returns `403 {"error":"forbidden_scope"}`; `listDocuments`, `embedOne`, `search`, `converseTurn` and `recordUsage` are never called; the cost-cap read (`getDailyCostUsd`) is not reached
* **Test:** `src/adapters/dashboard/vectors.scope.test.ts` › "F5-1 GET /vectors refuses a viewer another agent's private scope", "F5-2 POST /vectors/search refuses a viewer another agent's private scope", "F5-3 POST /vectors/answer refuses a viewer another agent's private scope before any spend"

### Scenario 2: Normalization cannot be used to get around the check
* **Given** a viewer
* **When** they name `finance.private`, `finance private`, `finance/private` or `FINANCE_PRIVATE` on the three read routes
* **Then** all return `403 {"error":"forbidden_scope"}`. Separately, `DEFAULT`, `Default` and `shared ` (trailing space) are also refused (they fold to `DEFAULT`, `Default`, `shared_`, which are not the public scopes)
* **Test:** `src/adapters/dashboard/vectors.scope.test.ts` › "F5-4 refuses a scope that reaches a private corpus only after normalization"

### Scenario 3: An unknown scope looks exactly like a private one
* **Given** a viewer
* **When** they call `GET /api/vectors?scope=no_such_scope`
* **Then** the status and body are byte-identical to Scenario 1 (`403 {"error":"forbidden_scope"}`); no store call
* **Test:** `src/adapters/dashboard/vectors.scope.test.ts` › "F5-5 answers an unknown scope exactly like a private one"

### Scenario 4: Operator cannot delete or ingest into a scope they cannot read (operator test)
* **Given** an operator (holds `agents:write`, lacks `knowledge:private:read`)
* **When** they call `DELETE /api/vectors/finance_private/doc1`, `POST /api/ingest {"content":"x","scope":"finance_private"}` and `POST /api/ingest/stream {"content":"x","scope":"finance_private"}`
* **Then** each returns `403 {"error":"forbidden_scope"}` (the stream route refuses with a JSON 403 **before** opening the SSE stream); `removeDocument` and `ingestDocument` are never called. `POST /api/ingest {"content":"x","scope":"shared"}` still returns 200
* **Test:** `src/adapters/dashboard/vectors.scope.test.ts` › "F5-6 DELETE /vectors/:scope/:docId refuses an operator a scope they cannot read", "F5-10 /ingest and /ingest/stream refuse an operator a scope they cannot read"

### Scenario 5: Viewer still reads the public corpora
* **Given** a viewer
* **When** they call the three read routes with no scope, with `default` and with `shared`
* **Then** each returns 200 with today's body (`{scope,count,docs}`, `{scope,query,hits}`, `{ok:true,…}`); the no-scope request reports `scope: "default"`
* **Test:** `src/adapters/dashboard/vectors.scope.test.ts` › "F5-7 still lets a viewer read the default and shared corpora"

### Scenario 6: Admin reads a private scope (admin test)
* **Given** an admin (and separately the env root token, owner)
* **When** they call the three read routes and `DELETE` on `finance_private`
* **Then** each returns 200 and the store is called with `finance_private`; no `knowledge_scope_denied` row is written
* **Test:** `src/adapters/dashboard/vectors.scope.test.ts` › "F5-8 lets a principal with knowledge:private:read read a private scope"

### Scenario 7: The agent's own runtime reads its own scope, never another agent's (agent test)
* **Given** agent `ops` running a turn
* **When** it calls `s3_vectors_search` with no scope, then with `args.scope = "finance_private"`
* **Then** the first searches `ops_private`, `default`, `shared`; the second returns `isError` and `search` is not called. If `ops`'s `knowledgeScope` is `chat_abc` (reserved namespace), the tool returns `isError` "invalid knowledge scope" and searches nothing
* **Test:** existing `src/lib/tools/vector-tools.scope.test.ts` (unchanged, must stay green) + new case "F5-11 refuses an agent knowledgeScope in the reserved chat_ namespace"

### Scenario 8: The Jarvis query path is held to the same rule
* **Given** a viewer talking to Jarvis
* **When** Jarvis calls `executeQueryTool(viewer, 'vectors', {scope:'finance_private'})`
* **Then** the result is `{ok:false, code:'RESOURCE_FORBIDDEN'}`, `listDocuments` is not called, and a `knowledge_scope_denied` row is written with `surface:'dashboard'`, `detail.route:'jarvis:vectors'`. With `{scope:'shared'}` the result is `{ok:true}`
* **Test:** `src/adapters/dashboard/jarvis.test.ts` › "F5-12 the vectors resource refuses a scope the principal cannot read"

### Scenario 9: Each refusal is audited without the scope name; malformed input is a 400
* **Given** the `audit_log_disabled` kill switch is active
* **When** a viewer is refused `finance_private` on `GET /vectors`, and separately sends `POST /api/vectors/search {"query":"q","scope":""}`, `{"scope":123}` or a 200-character scope
* **Then** the refusal writes `{action:'knowledge_scope_denied', surface:'dashboard', result:'blocked', userId:<dashboardIdentity>, detail:{route:'GET /vectors', scopeHash:<first 12 hex of sha256(normalizeScope(scope))>, reason:'private_scope', event:'security.scope_denied'}}` and the row is not suppressed; the malformed bodies return `400 {"error":"invalid_scope"}` with no store call and no audit row
* **Test:** `src/adapters/dashboard/vectors.scope.test.ts` › "F5-9 audits each refusal as knowledge_scope_denied with a scope hash only", "F5-9b rejects an empty, non-string or over-long scope with 400"; `src/lib/audit/audit-writer.test.ts` › "knowledge_scope_denied survives audit_log_disabled"

### Scenario 10: Staging upload URLs need write access; the SPA hides scopes the user cannot open
* **Given** a viewer, and separately an operator and an admin, on the Knowledge tab
* **When** the viewer calls `POST /api/vectors/upload-url`, and each user opens the scope selector
* **Then** the viewer gets `403 {"error":"forbidden","requiredCapability":"agents:write"}`; viewer and operator see only "Default scope" and "Shared (all agents)"; admin also sees one entry per agent as today
* **Test:** `src/adapters/dashboard/vectors.scope.test.ts` › "F5-13 POST /vectors/upload-url needs agents:write"; SPA: manual check by the fresh critic with the viewer, operator and admin fixtures (no SPA unit-test harness under `web/`; see Test plan)

### Scenario 11: Degraded mode
* **Given** the capability lookup throws (`capabilitiesForPrincipal` rejects) or the audit write rejects
* **When** a viewer asks for `finance_private`
* **Then** the response is `403 {"error":"forbidden_scope"}` (fail closed), never 200 and never 500 with data
* **Test:** `src/adapters/dashboard/vectors.scope.test.ts` › "F5-14 a failing capability lookup or audit write fails closed"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-43 / US-043](US-043-fix-api-config-secret-exposure-category-allowlist.md) merged first (same file, Q81). NZR-6 (US-006) builds on `canReadScope` and the reserved `chat_` namespace defined here.
* **UI/UX Design:** No new screen. One change in the Knowledge tab: the scope selector (`web/src/pages/Vectors.tsx:209-213`) lists agent scopes only when `hasCapability('knowledge:private:read')` (`web/src/lib/auth.ts:124`). What changes for users: viewers and operators no longer see agent entries; operators can upload to and delete from `default`/`shared` only. Before this fix, opening an agent scope as a viewer worked. With the server fix but no SPA change it would show the existing load-error state ("forbidden_scope", `Vectors.tsx:200-202`), so the SPA change ships in the same commit.
* **Non-Functional Requirements:** Server-side check on the normalized name, before any I/O. One uniform 403 body. Added latency < 1 ms (in-memory capability set already resolved per request). No extra DynamoDB or S3 call on the allowed path. Full `npm test` stays green. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** New always-audited action `knowledge_scope_denied` (`result:'blocked'`), `detail.event = 'security.scope_denied'` (Q55 product-event name), `detail.scopeHash` (12 hex chars), no scope name, no query text. NZR-44 catalogues it.
* **Files to change:**

  | path | change |
  |---|---|
  | `src/lib/auth/permissions.ts:88-135` | Add `'knowledge:private:read'` to `CAPABILITIES` (comment: agent-private and reserved knowledge scopes). |
  | `src/lib/auth/permissions.ts:234-243` | Add it to `ADMIN_CAPS` (org-admin inherits via `...ADMIN_CAPS` at `:263`; owner via `ALL_CAPABILITIES` at `:163`). Not in VIEWER/ANALYST/OPERATOR/SEAT_USER. |
  | `src/adapters/dashboard/handler.ts` (new helper next to `hasCapability`, `:870-875`) | `async function scopeAccess(c, rawScope, route): Promise<{ok:true, scope:string} \| {ok:false, res:Response}>`: validate (string, 1-128 chars, else 400 `invalid_scope`), default `'default'` when absent, `canReadScope(caps, scope)`, on refusal `void writeAudit(knowledge_scope_denied …)` and 403. Wrap the capability lookup in try/catch → refuse. |
  | `src/adapters/dashboard/handler.ts:3081-3088` | `GET /vectors`: call `scopeAccess` before `listDocuments`. |
  | `src/adapters/dashboard/handler.ts:3090-3143` | `POST /ingest`: after the `agents:write` check, `scopeAccess(body.scope)` before `ingestDocument`. |
  | `src/adapters/dashboard/handler.ts:3174-3177` | `POST /vectors/upload-url`: gate `agents:write` instead of `vectors:read`. |
  | `src/adapters/dashboard/handler.ts:3196-3217` | `POST /ingest/stream`: `scopeAccess(body.scope)` before the `ReadableStream` is built (JSON 403, not an SSE error). |
  | `src/adapters/dashboard/handler.ts:3331-3338` | `POST /vectors/search`: `scopeAccess(body.scope)` before `embedOne`. |
  | `src/adapters/dashboard/handler.ts:3368-3386` | `POST /vectors/answer`: `scopeAccess(body.scope)` **before** the kill-switch and cost-cap block (`:3389-3414`). |
  | `src/adapters/dashboard/handler.ts:3522-3530` | `DELETE /vectors/:scope/:docId`: `scopeAccess(c.req.param('scope'))` after `agents:write`, before `removeDocument`. |
  | `src/adapters/dashboard/jarvis.ts:1250-1254` | `case 'vectors'`: resolve caps with `capabilitiesForPrincipal(principal)` (`src/lib/auth/dashboard-auth.ts:50`); if `!canReadScope` audit + throw a forbidden marker that `executeQueryTool` (`:1088-1100`) maps to `{ok:false, code:'RESOURCE_FORBIDDEN'}`. |
  | `src/lib/tools/vector-tools.ts:83-110` and `:235-255` | If `normalizeScope(ownScope)` starts with `chat_`, return `isError` "invalid knowledge scope" (search and ingest). |
  | `src/lib/audit/audit-writer.ts:57-206`, `:234-278` | Add `'knowledge_scope_denied'` to the action union and to `ALWAYS_AUDITED_ACTIONS`. |
  | `src/lib/jarvis/route-manifest.test.ts:165-192` | Add `'knowledge:private:read': 'admin'` to `CAPABILITY_MIN_ROLE` (explicit, not defaulted, per the comment at `:160-164`). |
  | `src/adapters/dashboard/authz-matrix.test.ts:285-399` | Rows: "Knowledge private scope read (GET /vectors?scope=ops_private)", minTier admin, body `forbidden_scope`; "Staging upload URL (POST /vectors/upload-url)", minTier operator, `agents:write`. |
  | `web/src/pages/Vectors.tsx:209-213` | Spread the agent options only when `hasCapability('knowledge:private:read')`. |
  | `docs/diagrams/architecture-security.md` (top comments) | Drift-gate line: new capability `knowledge:private:read` (admin tier), in-route scope check on 6 routes + Jarvis resource; no new principal, grant or boundary. |
  | `docs/features/netzar-studio/foundation/SECURITY.md` §3a, §7 risk #1 | Mark SEC-D1 decided (Q82), cite `src/adapters/dashboard/vectors.scope.test.ts` at the merge SHA. |

* **New files:**
  * `src/lib/vectors/scope-access.ts` — `PUBLIC_SCOPES = ['default','shared']`, `RESERVED_SCOPE_PREFIX = 'chat_'`, `canReadScope(caps: ReadonlySet<Capability>, scope: string): boolean`, `scopeHash(scope): string`. Pure, imports `normalizeScope` from `store.ts`.
  * `src/lib/vectors/scope-access.test.ts` — unit table: `default`/`shared` true with `vectors:read`, false without; `DEFAULT`, `shared_`, `ops_private`, `chat_x`, `no_such_scope` false without `knowledge:private:read`, true with it; empty string false.
  * `src/adapters/dashboard/vectors.scope.test.ts` — frozen F5-1..F5-10, F5-13, F5-14 (pattern: `vectors-answer-metering.test.ts`, `chat-uploads.test.ts`; mocks per SECURITY.md §3a).
* **Scope access table (the contract the tests pin):**

  | normalized scope | viewer | operator | admin / org-admin / owner | agent runtime |
  |---|---|---|---|---|
  | `default`, `shared` | read | read, ingest, delete | all | read (and own-scope ingest) |
  | agent's own `knowledgeScope` | 403 | 403 | all | read + ingest (own only) |
  | another agent's scope | 403 | 403 | all | `isError` |
  | unknown name | 403 | 403 | all (empty result) | `isError` |
  | `chat_*` (NZR-6) | 403 (own files only via `agentId`+`chatId`, US-006) | 403 | read/delete via audited override (US-006) | own chat only (US-006) |

* **API contract (changes only):**
  * `GET /api/vectors?scope=<s>` — auth: `vectors:read` (unchanged) + scope rule. 200 `{scope, count, docs: Doc[]}` unchanged. 403 `{error:'forbidden_scope'}`. 400 `{error:'invalid_scope'}`.
  * `POST /api/vectors/search` `{query, scope?, topK?}` and `POST /api/vectors/answer` `{query, scope?, modelId, topK?, history?}` — as above; answer's existing 400 `missing_query`/`unknown_model` and 503 kill-switch/cost errors are unchanged but come **after** the scope check.
  * `DELETE /api/vectors/:scope/:docId`, `POST /api/ingest`, `POST /api/ingest/stream` — `agents:write` (unchanged) + scope rule; 403 `{error:'forbidden_scope'}` (stream: JSON, before SSE).
  * `POST /api/vectors/upload-url` — now `agents:write`; 403 `{error:'forbidden', requiredCapability:'agents:write'}`.
  * Jarvis `query` resource `vectors` — `{ok:false, code:'RESOURCE_FORBIDDEN'}` when refused.
* **Data changes:** None. No index, key or document moves (the NZR-6 migration moves chat files). Rollback needs no data step.
* **Security notes:**
  * Threats: SECURITY.md B3, risk #1, SEC-D1 (now decided by Q82).
  * Authz rule: capability first (`vectors:read`/`agents:write`), then `canReadScope` on `normalizeScope(scope)`, exact-case match against `default`/`shared`. Unknown is denied by default, which also covers names created later.
  * Ingest is gated by the same read rule, so nobody can write into a corpus they cannot read (blocks poisoning of agent and chat scopes).
  * Admin reads of agent scopes are normal admin work and are not individually audited (only `knowledge_answer`/`knowledge_delete`/`knowledge_ingest` as today). Admin reads of `chat_*` scopes are audited overrides (US-006).
  * Audit: `writeAudit` (fire-and-forget) for refusals; always-audited so `audit_log_disabled` cannot hide probing. Scope **hash** only, so the audit log, which viewers can read (`audit:read`), does not list private scope names.
  * Run `node scripts/ci/secret-scan.mjs <changed files…>` on the diff (SECURITY.md §6).
* **Test plan:**
  * Frozen failing tests first, own commit, red SHA recorded: F5-1, F5-2, F5-3, F5-4, F5-5, F5-6, F5-9, F5-9b, F5-10, F5-11, F5-12, F5-13, F5-14 (all red today: a viewer gets 200, an agent with a `chat_` scope searches it). Guards (green today, must stay green): F5-7, F5-8.
  * One test per role (Q82): viewer = F5-1, operator = F5-6, admin = F5-8; agent runtime = `vector-tools.scope.test.ts` + F5-11.
  * Unit: `scope-access.test.ts`.
  * Existing tests that must stay green: `vectors-answer-metering.test.ts` (it uses `scope` values; if it uses a non-public scope with a viewer, change its fixture to `default` and say so in the commit), `vector-tools.scope.test.ts`, `src/lib/vectors/store.scope.test.ts`, `jarvis.test.ts`, `authz-matrix.test.ts`, `seat-profiles.test.ts` › "owner holds every seat capability (ALL_CAPABILITIES derivation)", `route-manifest.test.ts`.
  * SPA: no web unit-test runner exists (no `web/**/*.test.*`); verify by `npm run build` in `web/` plus the critic's manual check (Scenario 10).
  * Commands: `npx vitest run src/adapters/dashboard/vectors.scope.test.ts src/lib/vectors/scope-access.test.ts src/lib/tools/vector-tools.scope.test.ts src/adapters/dashboard/jarvis.test.ts src/adapters/dashboard/authz-matrix.test.ts src/lib/jarvis/route-manifest.test.ts`, `npm run typecheck`, full `npm test`, `node scripts/ci/diagrams-drift.mjs`.
* **Repo rules that apply:**
  * New capability ⇒ `CAPABILITIES` + named templates only (fail-closed comment, `permissions.ts:80-87`); explicit `CAPABILITY_MIN_ROLE` entry in `route-manifest.test.ts`; nav sync not affected (no new route; `/vectors` still `vectors:read`).
  * `handler.ts` changed ⇒ architecture-security drift line (`docs/diagrams.map`).
  * New audit action ⇒ closed union in `audit-writer.ts`.
  * No new dependency; full `npm test` before push; owner yes for every merge/push (Q50); T3 failing-test-first commit.
* **Rollback:** `git revert` of the merge commit; no data step. If a legitimate operator workflow breaks (uploading to an agent scope), the owner can grant `knowledge:private:read` to a custom profile instead of reverting.
* **Build slices (proposal):**
  1. **Red tests** (~1.5 h): `vectors.scope.test.ts`, `scope-access.test.ts`, F5-11, F5-12, matrix rows.
  2. **Capability + helper + read routes** (~1.5 h): permissions, `scope-access.ts`, `scopeAccess`, audit action, GET/search/answer. F5-1..F5-5, F5-7..F5-9, F5-14 green.
  3. **Write routes + Jarvis + agent guard** (~1.5 h): DELETE, ingest ×2, upload-url, Jarvis case, vector-tools reserved prefix. F5-6, F5-10..F5-13 green.
  4. **SPA + docs** (~0.5 h): `Vectors.tsx` filter, drift line, SECURITY.md evidence.
* **Agent gotchas:**
  * There are **seven** places that take a scope (6 routes + Jarvis). Fixing only the three the thin story named leaves DELETE, both ingests and Jarvis open.
  * Check `/vectors/answer` before the kill switch and cost cap, so a refused request costs nothing and leaks nothing about spend.
  * `/ingest/stream` must refuse before `new ReadableStream`; once the stream starts the status is already 200.
  * Compare after `normalizeScope`, and compare case-sensitively: `normalizeScope('DEFAULT')` is `DEFAULT`, a different S3 prefix from `default`, so it is not public.
  * Missing scope keeps defaulting to `'default'` (F5-7; the SPA and Jarvis rely on it). Only malformed values are 400.
  * The audit log is viewer-readable: log `scopeHash`, never the scope name.
  * `s3_vectors_search` logs `contrib` with raw scope names to the app log (`vector-tools.ts:159-166`); that is the server log, not the audit log. Leave it.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Security fixed (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47). See NOTES: 8 proposed (7 scope sites, not 3).
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** security, knowledge, urgent

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona E; 0 cross-scope reads).
- [ ] Acceptance criteria cover both happy paths and edge cases (11 scenarios: 3 roles + agent runtime, normalization, unknown, writes, Jarvis, audit, malformed, SPA, degraded).
- [ ] UX/UI designs: one selector filter in the Knowledge tab, described in section 4; no new screen.
- [ ] Dependencies have been identified and are unblocked (NZR-43 merged).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail): `scope-access.ts` + edits listed in section 4.
- [ ] Peer code review is completed and approved. Full T3 review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews the security boundary (the scope access table and the new capability's placement).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: the vitest command in section 4, `npm run typecheck`, full `npm test`, `node scripts/ci/diagrams-drift.mjs`, `node scripts/ci/secret-scan.mjs <changed files>`, `web/` build.
- [ ] QA: the fresh critic re-runs the gate against these criteria and does the Scenario 10 manual check as viewer, operator and admin. UAT: the owner accepts the evidence summary.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; SECURITY.md §3a cites `vectors.scope.test.ts` at the merge SHA and records SEC-D1 = Q82; architecture-security drift line.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists. Legacy app: not deployed (Q84), known-vulnerable.
