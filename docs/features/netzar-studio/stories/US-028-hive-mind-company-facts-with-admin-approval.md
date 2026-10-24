# [US-028] Hive Mind -> Company facts with admin approval queue

> Backlog task NZR-28 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-012, FR-023.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** new company-wide facts to wait for my approval
* **So that** no agent spreads an unapproved claim to everyone

---

## 2. Business Context & Description
* **Background:**
  - Blueprint "Knowledge": Hive Mind becomes "Company facts" with admin-approved writes. PRD FR-012 (retrieval respects permissions), FR-023 (one policy and audit model). ARCHITECTURE R13 and DATA-MODEL risk 5: both writers **and** the read path must be gated. SECURITY.md 2b T3, 3c and ranked risk 5 (one chat gets a lasting injection path into every agent).
  - Owner Q82: private knowledge is visible to admins and the agent itself; everyone else sees only shared/company knowledge. A *proposed* fact may hold one user's private chat data, so it is admin-only until approved. An *approved* fact is company knowledge, readable by every viewer.
  - Terms. **Hive note**: a row in today's `hive-mind` table. **Company fact**: a new row with a `status`. **Proposed**: waiting for an admin. **Approved**: injected into prompts. **Rejected**: never used; its text is deleted. **Retired**: was approved, now withdrawn.
* **Current behaviour (d1d3a66):**
  - Writer 1, model-callable: `log_to_hive` calls `logToHive` with no approval (`src/lib/tools/agent-tools.ts:254-304`, call at `:292`).
  - Writer 2, automatic: memory ingest promotes a fact to the hive when Haiku says it is org-wide with `confidence >= hive_promote_min_confidence` (`src/agent/memory-ingest.ts:169-205`, call at `:177`), audited fire-and-forget (`:186`).
  - `logToHive` stores rows with no status and a TTL of `60 + 3 × importance` days (`src/lib/state/hive-mind-repo.ts:58-103`, TTL at `:85`). An "approved" fact stored here would silently expire.
  - Read paths (all return every row in the window): the system prompt, up to 12 notes into `<hive_context>` on every turn (`src/agent/agent-loop.ts:403-413`, block `:431-458`); `search_hive` tool (`agent-tools.ts:306-348`: `searchHiveByTopic` `:335`, `searchHiveText` full-table scan `:337`, `recentHive` `:339`); dashboard `GET /hive` (`src/adapters/dashboard/handler.ts:4166-4173`, `hive:read`); Jarvis `hive` resource (`src/adapters/dashboard/jarvis.ts:1295-1299`).
  - Prompt text calls hive notes "authoritative" (`src/lib/config/agent-loader.ts:57,82`; `src/lib/agents/templates.ts:62,87`). Only angle brackets are neutralized (`agent-loop.ts:451`).
  - **The documented interim fix does not work.** SECURITY.md 3c says set `memory/hive_promote_min_confidence` above 1 to disable promotion. The code clamps that value to `[0,1]` (`memory-ingest.ts:110-112`) and clamps Haiku's confidence to `[0,1]` (`:77-78`), so a fact with confidence `1.0` still passes `>= 1`. The Hive page also refuses values above 1 (`web/src/pages/HiveMind.tsx:68-71`).
  - Capabilities: `hive:read` is viewer-tier (`src/lib/auth/permissions.ts:102,208`). No approve capability exists. UI: `/hive` page `web/src/pages/HiveMind.tsx`, nav `web/src/components/Sidebar.tsx:191`, route `web/src/App.tsx:283`, Jarvis route table `src/lib/jarvis/route-manifest.ts:70,131`.
* **Target behaviour:**
  - Both writers create a `proposed` Company fact in the studio table and no longer write hive notes. Nothing proposed reaches any prompt, tool result, Jarvis answer or viewer screen.
  - Every read path (system prompt, `search_hive`, `GET /hive`, Jarvis `hive`) returns **approved** facts only.
  - An admin (new capability `facts:approve`) sees the queue with source agent and provenance, and approves or rejects each item. Approval is bound to the hash of the exact text shown. The proposer cannot approve their own fact.
  - Approved facts have **no TTL**. Rejected facts lose their text at once and keep a tombstone (id, text hash, who, why) for 1 year. Proposed facts expire after 90 days if nobody decides.
  - Approving, rejecting and retiring write always-audited rows with ids and hashes only.
  - Existing hive notes are copied in as `proposed` (origin `legacy-hive`) so nothing that was never reviewed stays in prompts; an admin can approve up to 50 at once.
  - Interim fix (lands first, can ship alone in week 0): a `hive_promote_min_confidence` value above 1 disables automatic promotion.
* **Out of scope:**
  - Humans proposing facts from the dashboard, editing fact text, and conflict detection between facts ("item conflicts with an existing fact" state of W-025) → follow-up after NZR-16; this story detects exact duplicates only.
  - The `shared` vector corpus written by `/ingest` without approval (SECURITY 2a B3 T) → NZR-5 / NZR-8 knowledge layers.
  - Moving the page into Admin > Governance and the Library read-only view (W-024 `/library/facts`) → NZR-16 and NZR-15 move this page; this story builds it on the existing `/hive` route.
  - Lessons (proposed playbook/fact changes from corrections) → NZR-29.
  - Rewriting the prompt wording "authoritative" in every template → NZR-8 ADR; this story only changes the injected block heading.
* **Target Value:** 0 unapproved facts reach agents, tested on all 4 read paths (Scenario 1) and both writers (Scenario 2). After the legacy copy, `<hive_context>` holds 0 notes until an admin approves (measured by the agent-loop test and a local smoke run).
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Queued, and invisible on every read path
* **Given** agent `ops` calls `log_to_hive({ content: "Renewals now need two signatures", topic: "policy" })` in chat `chatA`
* **When** it is saved
* **Then** the tool returns `"Saved as a proposed company fact. An admin must approve it before other helpers see it."`
* **And** the studio table holds `FACT#<id>` / `META` with `status: 'proposed'`, `textHash = sha256(text)`, `source: { agentId: 'ops', chatId: 'chatA', userId, surface, origin: 'tool' }`, `ttl` = now + 90 days, `GSI1PK = 'FACTQ#proposed'`
* **And** `logToHive` is not called; the next `buildSystemPrompt` for any agent has no line containing "two signatures"; `search_hive` with `query: "signatures"`, `topic: "policy"` and no args returns `"No company facts match."`; `GET /api/hive` (viewer) and Jarvis `hive` return `notes: []`
* **And** one audit row `fact_proposed` with `detail = { factId, textHash, origin: 'tool', topic }` (no text)
* **Test:** `src/lib/studio/facts-repo.test.ts` › "proposeFact stores a proposed fact with a 90-day ttl and no approval"
* **Test:** `src/lib/tools/agent-tools.facts.test.ts` › "log_to_hive proposes a fact and never writes a hive note"
* **Test:** `src/agent/agent-loop.facts.test.ts` › "injects only approved facts into hive_context"
* **Test:** `src/lib/tools/agent-tools.facts.test.ts` › "search_hive returns approved facts only for topic, query and recent modes"
* **Test:** `src/adapters/dashboard/facts.routes.test.ts` › "GET /hive and Jarvis hive return approved facts only"

### Scenario 2: Automatic promotion is gated too
* **Given** memory ingest parses `{ fleet: true, fleetFact: "Office closes at 3pm Fridays", confidence: 0.9 }` with the threshold at the default 0.6
* **When** `ingestEvictedTurns` runs
* **Then** a `proposed` fact with `source.origin = 'auto-ingest'` exists, `logToHive` is not called, and the result is `{ promoted: true }`
* **And** with `memory/hive_promote_min_confidence = "1.01"` and `confidence: 1`, no fact is proposed and the result is `{ promoted: false }` (interim fix: a value above 1 disables promotion)
* **Test:** `src/agent/memory-ingest.facts.test.ts` › "auto-promotion creates a proposed fact, not a hive note"
* **Test:** `src/agent/memory-ingest.facts.test.ts` › "a threshold above 1 disables promotion even at confidence 1"

### Scenario 3: Approved
* **Given** proposed fact `f1` with `textHash = h1`
* **When** an admin calls `POST /api/facts/f1/decision` with `{ decision: 'approve', textHash: 'h1' }`
* **Then** the response is `200 { id: 'f1', status: 'approved' }`; the item has no `ttl` attribute, `GSI1PK = 'FACTQ#approved'`, `decidedBy = dashboardIdentity(c)`, `decidedAt` set
* **And** the next `buildSystemPrompt` contains `"Renewals now need two signatures"` inside `<hive_context>` with angle brackets neutralized as in `agent-loop.ts:451`
* **And** one audit row `fact_decided` `{ factId, decision: 'approve', textHash }` via `writeAuditOrThrow`
* **Test:** `src/adapters/dashboard/facts.routes.test.ts` › "admin approves a fact bound to its text hash"
* **Test:** `src/lib/studio/facts-repo.test.ts` › "approve removes the ttl attribute"

### Scenario 4: Rejected
* **Given** proposed fact `f2`
* **When** an admin calls `POST /api/facts/f2/decision` with `{ decision: 'reject', textHash, reason: 'Not company policy' }`
* **Then** `200 { id: 'f2', status: 'rejected' }`; the item keeps `textHash`, `decidedBy`, `reason` but its `text` and `topic` attributes are removed; `ttl` = now + 365 days
* **And** `f2` never appears on any read path, and the audit row `fact_decided` `{ factId, decision: 'reject', textHash, reasonLength }` is written
* **Test:** `src/adapters/dashboard/facts.routes.test.ts` › "reject deletes the text, keeps a tombstone and audits"

### Scenario 5: Approved facts don't expire; retire removes them
* **Given** an approved fact whose `createdAt` is 400 days ago (older than any hive TTL, max 360 days at importance 100, `hive-mind-repo.ts:85`)
* **When** the facts are listed for a prompt
* **Then** it is still returned (the item has no `ttl`)
* **And** after `POST /api/facts/:id/retire` (admin) it returns `200 { status: 'retired' }`, is gone from all read paths, and audit `fact_retired` is written
* **Test:** `src/lib/studio/facts-repo.test.ts` › "approved facts have no ttl and stay listed regardless of age"
* **Test:** `src/adapters/dashboard/facts.routes.test.ts` › "retire removes an approved fact from every read path"

### Scenario 6: Permissions, self-approval and stale decisions
* **Given** a viewer and an operator (neither holds `facts:approve`)
* **When** they call `GET /api/facts?status=proposed` or `POST /api/facts/:id/decision`
* **Then** both get `403 { error: 'forbidden', requiredCapability: 'facts:approve' }` and no DDB read of `FACTQ#proposed` happens
* **And** an admin deciding a fact whose `source.proposedBy` equals their own `dashboardIdentity(c)` gets `403 { error: 'cannot_approve_own_fact' }`
* **And** a decision whose `textHash` differs from the stored one gets `409 { error: 'fact_changed' }`; a second decision on an already-decided fact gets `409 { error: 'already_decided', status }` (conditional update `status = 'proposed'`)
* **Test:** `src/adapters/dashboard/facts.routes.test.ts` › "only facts:approve may list or decide proposed facts"
* **Test:** `src/adapters/dashboard/facts.routes.test.ts` › "refuses self-approval, stale hashes and double decisions"
* **Test:** `src/adapters/dashboard/authz-matrix.test.ts` › rows for the 4 new routes

### Scenario 7: Legacy hive notes, duplicates and bulk approve
* **Given** 3 existing hive notes (one duplicated text) and the backfill `hive-to-facts` run twice
* **Then** 2 `proposed` facts exist with `source.origin = 'legacy-hive'` and the original `authorAgentId`/`authorChatId`; re-running creates nothing new (fact id = `sha256('legacy:' + note.id)`; a duplicate text with an existing non-rejected fact increments `seenCount` instead of adding a row); one `migration_step` audit row per run
* **And** an admin `POST /api/facts/decision` with `{ decision: 'approve', items: [{id, textHash}, …] }` (≤ 50 items) returns `200 { results: [{ id, status }|{ id, error }] }`; 51 items → `400 { error: 'too_many_items', max: 50 }`
* **Test:** `scripts/migrations/hive-to-facts.test.ts` › "copies hive notes as proposed facts once"
* **Test:** `src/adapters/dashboard/facts.routes.test.ts` › "bulk approve is capped at 50 and reports per item"

### Scenario 8: Store down
* **Given** the studio table read fails while building a prompt
* **When** an agent turn runs
* **Then** the turn continues with no `<hive_context>` block and logs `context: facts read failed` (same `softly` fallback as `agent-loop.ts:395-402`), and it does **not** fall back to `recentHive`
* **And** if `writeAuditOrThrow` throws during a decision, the response is `503 { error: 'audit_unavailable' }` and the fact stays `proposed` (the status change is attempted only after the audit write succeeds, see Agent gotchas)
* **Test:** `src/agent/agent-loop.facts.test.ts` › "a facts read failure drops the block and never reads hive notes"
* **Test:** `src/adapters/dashboard/facts.routes.test.ts` › "a failed audit write leaves the fact proposed"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-5 / US-005](US-005-fix-vectors-scope-leak-knowledge-routes-enforce.md) Fix /vectors scope leak: knowledge routes enforce agent scope (the Q82 scope rule and the `knowledge:private:read` pattern this story mirrors). Also needs the `${app}-studio` table (DATA-MODEL §3); no story names it as a deliverable (see NOTES): if it is not on `development` at PLANNING, slice 0 adds it.
* **UI/UX Design:** design.md screen inventory (NO-MOCK-YET): W-025 Company facts approval queue (empty queue; pending items with source agent and provenance; approve; reject with reason; denied) and W-024 approved facts (read-only). Built on the existing `/hive` page (S-027, `web/src/pages/HiveMind.tsx`); the nav label becomes "Company facts". Admin screen, so it keeps Admin density (round-5 Bigger-text rule applies to Workspace only). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** Audit every decision. Prompt build adds ≤ 1 DDB Query (GSI1 `FACTQ#approved`, newest 12) per turn, same budget as today's `recentHive`. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `fact.proposed`, `fact.approved`, `fact.rejected`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Props: `{ origin: 'tool'|'auto-ingest'|'legacy-hive' }` only. Until NZR-44's writer exists, the always-audited `fact_*` rows are the record (NOTES item 6).
* **Files to change:**

  | path | change |
  |---|---|
  | `src/agent/memory-ingest.ts:109-113` | `promoteMinConfidence`: a configured value `> 1` returns `Infinity` (promotion off); keep the `[0,1]` clamp otherwise. **Slice 0, can ship alone** |
  | `scripts/lib/seed-defaults.ts:45-52` | description: "Minimum confidence (0-1) … A value above 1 turns automatic promotion off."; comment no longer says "clamped to [0, 1]" |
  | `src/agent/memory-ingest.ts:169-205` | call `proposeFact({ origin: 'auto-ingest', … })` instead of `logToHive`; audit becomes `fact_proposed` |
  | `src/lib/tools/agent-tools.ts:254-348` | `log_to_hive` → `proposeFact({ origin: 'tool' })`, new reply copy; `search_hive` → approved facts only (`listApprovedFacts`, topic exact match, query = case-insensitive substring over approved text), empty copy `"No company facts match."` |
  | `src/agent/agent-loop.ts:43`, `:403-458` | replace `recentHive({agentId, limit:12})` with `listApprovedFacts({ limit: 12 })`; keep the `<hive_context>` tag and the neutralization at `:451`; heading text becomes "Company facts an admin has approved…" |
  | `src/adapters/dashboard/handler.ts:136`, `:4166-4173` | `GET /hive` returns approved facts in the old `{count, notes}` shape; add the facts routes below |
  | `src/adapters/dashboard/jarvis.ts:85`, `:1295-1299` | `hive` resource returns approved facts only |
  | `src/lib/auth/permissions.ts:88-135`, `:234-…` | add `'facts:approve'` to `CAPABILITIES` and `ADMIN_CAPS` (flows to org-admin and owner) |
  | `src/lib/audit/audit-writer.ts:57-…`, `:234-…` | add `fact_proposed`, `fact_decided`, `fact_retired`, `migration_step` (if NZR-22 has not); add `fact_decided`, `fact_retired` to `ALWAYS_AUDITED_ACTIONS` |
  | `web/src/pages/HiveMind.tsx` | two tabs: "Approved" (everyone with `hive:read`) and "Waiting for approval" (only if `hasCapability('facts:approve')`, `web/src/lib/auth.ts:124`): source agent, chat id, origin, date, Approve / Reject (reason box) / Retire; bulk "Approve selected" for legacy items. The cadence editor (`:30-135`) is unchanged; until slice 2 lands, the interim "off" value (`1.01`) is set by an admin with `POST /api/config/memory/hive_promote_min_confidence` (`handler.ts:2974`) because the page refuses values above 1 (`:68-71`) |
  | `web/src/components/Sidebar.tsx:191`, `web/src/App.tsx:283`, `src/lib/jarvis/route-manifest.ts:70,131` | label "Company facts" (route `/hive` and `hive:read` gate unchanged) |
  | `src/lib/jarvis/route-manifest.test.ts:165-193` | add `'facts:approve': 'admin'` to `CAPABILITY_MIN_ROLE` |
  | `scripts/migrations/index.ts` | register `hive-to-facts` backfill |
  | `docs/diagrams/architecture-security.md`, `docs/diagrams/request-lifecycle.md` | prompt context now reads approved facts (`agent-loop.ts` and `handler.ts` are mapped sources, `docs/diagrams.map:35-55`) |
  | `docs/features/netzar-studio/foundation/SECURITY.md` 3c | replace the broken interim note with the fixed behaviour (doc-only line, same PR) |

* **New files:**
  - `src/lib/studio/facts-repo.ts`: `proposeFact`, `listApprovedFacts({limit, topic?})`, `listFactsByStatus(status, cursor)`, `decideFact`, `decideFactsBulk`, `retireFact`.
  - `src/lib/studio/facts-repo.test.ts`, `src/lib/tools/agent-tools.facts.test.ts`, `src/agent/agent-loop.facts.test.ts`, `src/agent/memory-ingest.facts.test.ts`, `src/adapters/dashboard/facts.routes.test.ts`.
  - `scripts/migrations/hive-to-facts.ts` + `.test.ts`.
  - `tests/e2e/facts/facts.spec.ts` + `tests/e2e/facts/playwright.config.ts` (copy of `tests/e2e/chat/playwright.config.ts`): admin approves a seeded proposed fact; viewer sees no queue tab.
* **API contract:** (all under `/api`, behind auth `handler.ts:1410-1436`; identity from `dashboardIdentity(c)`, never a header)
  - `GET /facts?status=proposed|rejected|retired&cursor=` · `facts:approve` · `200 { items: [{ id, text?, topic?, textHash, status, source: { agentId, chatId, surface, origin }, seenCount, createdAt, decidedBy?, decidedAt?, reason? }], cursor? }` (25 per page) · `403`.
  - `GET /facts?status=approved` · `hive:read` · same shape without `source.chatId`/`userId` · `403`.
  - `POST /facts/:id/decision` · `facts:approve` · body `{ decision: 'approve'|'reject', textHash: string(64 hex), reason?: string ≤ 500 }` (reason required for reject → else `400 { error: 'reason_required' }`), unknown keys → `400 { error: 'invalid_body' }` · `200 { id, status }` · `403 forbidden | cannot_approve_own_fact` · `404 { error: 'not_found' }` (also for a tombstone's text) · `409 fact_changed | already_decided` · `503 audit_unavailable`.
  - `POST /facts/decision` (bulk) · `facts:approve` · `{ decision, items: [{ id, textHash }] ≤ 50, reason? }` · `200 { results }` · `400 too_many_items`.
  - `POST /facts/:id/retire` · `facts:approve` · `{ reason: string ≤ 500 }` · `200 { id, status: 'retired' }` · `409 { error: 'not_approved' }`.
  - `GET /hive` · `hive:read` · unchanged shape `{ count, notes }`, approved facts mapped to `{ id, authorAgentId, authorChatId: '', topic, content, ts, importance: 50, tags: [] }`.
* **Data changes:**
  - Studio table (`${app}-studio`, PK/SK, GSI1, `ttl`): `FACT#<id>` / `META` = `{ id, text, topic?, textHash, status, source: { agentId, chatId, userId?, surface?, origin, proposedBy }, seenCount, createdAt, decidedBy?, decidedAt?, reason?, GSI1PK: 'FACTQ#<status>', GSI1SK: '<createdAt>#<id>', ttl? }`. `ttl`: proposed = +90 d, approved = none, rejected = +365 d, retired = none.
  - Duplicate guard: `FACTHASH#<textHash>` / `META` pointer `{ id }` created in the same transaction as the fact; a second proposal of the same text with a live (non-rejected) fact increments `seenCount` on it.
  - `id` = `ulid` style random for new facts (`randomUUID`), `sha256('legacy:'+noteId)` for backfilled ones.
  - Hive table: no schema change; it stops receiving writes. `recentHive`/`searchHive*` stay only for the migration. Contract (drop the hive read code, keep the table, RETAIN) after a 14-day soak and owner yes (DATA-MODEL §4 rule 1).
  - Backfill `hive-to-facts`: scans the hive table (paginated), creates proposed facts create-only, journaled by the migration registry.
* **Security notes:**
  - SECURITY.md 2b T3, 3c, 2a B5 T/E, ranked risk 5. Fixes the poisoning channel at the store and at every reader. The `/warroom` blocklist gap for `log_to_hive` (2a B2 E) becomes harmless: it can only propose.
  - Authz: queue reads and decisions need `facts:approve` (admin+). Approved list needs `hive:read`. Proposed text is never shown to viewers (Q82: private chat data stays admin-only).
  - Approval bound to `textHash` (ADR 0016 idea); approver from the session (A153 lesson); no self-approval.
  - Audit: `writeAuditOrThrow` for `fact_decided`/`fact_retired`, both always-audited; `fact_proposed` via `writeAudit` (high volume, non-privileged) but with ids/hashes only. Never put fact text in audit detail (WORM, DATA-MODEL risk 6).
  - Rejected text is deleted immediately (SECURITY T3 "a rejected fact is deleted"), tombstone kept for audit (DATA-MODEL "rejected kept 1 year"); see NOTES for the doc conflict.
  - Approved facts still enter prompts as data inside `<hive_context>` with the single neutralization scheme (`agent-loop.ts:436-451`, SECURITY §6 floor).
* **Test plan:**
  - Frozen failing tests first (own commit): Scenario 1 "injects only approved facts into hive_context", Scenario 1 "log_to_hive proposes a fact…", Scenario 2 both, Scenario 6 "only facts:approve may…". Slice 0's "threshold above 1" test is frozen separately so it can ship in week 0.
  - Unit: vitest with mocked `ddb().send` (pattern `src/lib/state/agents-repo.test.ts:1-15`); routes via `app.request()` with role principals (pattern `src/adapters/dashboard/authz-matrix.test.ts:24-60`).
  - E2E: `tests/e2e/facts/facts.spec.ts`, seeded synthetic facts, run serially (Q69).
  - Fixtures: synthetic text only ("Office closes at 3pm Fridays"); no names or emails.
  - Commands: `npx vitest run src/lib/studio/facts-repo.test.ts src/lib/tools/agent-tools.facts.test.ts src/agent/agent-loop.facts.test.ts src/agent/memory-ingest.facts.test.ts src/adapters/dashboard/facts.routes.test.ts src/adapters/dashboard/authz-matrix.test.ts src/lib/jarvis/route-manifest.test.ts src/lib/tools/read-only-marks.test.ts scripts/migrations/hive-to-facts.test.ts`; `npm run typecheck`; `npm --prefix web run typecheck`; `npm test`; `npx playwright test --config tests/e2e/facts/playwright.config.ts`; `node scripts/ci/diagrams-drift.mjs`; `node scripts/ci/docs-links.mjs`.
* **Repo rules that apply:**
  - New capability is additive, lands only in the named profiles (`permissions.ts:84-87`); update `CAPABILITY_MIN_ROLE` in `route-manifest.test.ts:165` and the authz matrix.
  - Nav sync for the label change: `Sidebar.tsx` NAV_ITEMS + `App.tsx:283` (`label="Hive Mind"` on `RequireCapability`) + Jarvis `ROUTE_TABLE` (`route-manifest.ts:131`) + drift test (Q87).
  - `handler.ts` / `agent-loop.ts` change ⇒ diagrams (`docs/diagrams.map`).
  - `writeAuditOrThrow` for decisions; closed `action` union.
  - `read-only-marks.test.ts` pins the read-only tool set; `search_hive` stays `readOnly: true`, `log_to_hive` stays not read-only (`src/lib/tools/read-only-marks.test.ts:21-33`).
  - No new dependency.
* **Rollback:** `git revert` of the story restores hive reads and writes; facts rows stay (RETAIN, harmless). There is deliberately **no** runtime flag that re-enables injecting unapproved notes (it would reopen ranked risk 5); a time-boxed flag needs the security owner's signature (DATA-MODEL §4 table pattern). Slice 0 rollback: set the threshold back to `0.6`.
* **Build slices (proposal):**
  0. *Interim fix* (≤ 1 h, week 0 candidate): `promoteMinConfidence` > 1 = off; SECURITY.md 3c line. Green: Scenario 2 second test.
  1. *Store* (2 h): studio table if absent, `facts-repo.ts`, capability, audit actions. Green: facts-repo tests.
  2. *Gate writers and readers* (2–3 h): `log_to_hive`, memory ingest, `search_hive`, agent-loop, `GET /hive`, Jarvis. Green: Scenarios 1, 2, 8 (first part).
  3. *Decisions API + backfill* (2–3 h): routes, bulk, retire, migration, authz matrix, diagrams. Green: Scenarios 3–7, 8 (second part).
  4. *UI* (2 h): HiveMind tabs, nav label, e2e. Green: e2e spec, route-manifest test.
* **Agent gotchas:**
  - **Two writers, four readers.** Gating only `log_to_hive` misses `memory-ingest.ts:177` (R13). Grep `recentHive\|searchHive\|logToHive` across `src/` and make the only remaining callers the repo and the migration.
  - `searchHiveText` is a full-table `Scan` with `Limit: 500` (`hive-mind-repo.ts:190-210`); never point it at the studio table.
  - **Keep the tool names** `log_to_hive` and `search_hive` (do-not-build #12, `docs/features/paperclip/do-not-build.md`; built-in prompts and templates name them, `agent-loader.ts:58-59`, `templates.ts:62`). Change their behaviour and descriptions only.
  - **Clamp trap:** `Math.min(1, n)` in `promoteMinConfidence` is why the interim fix fails. Don't "fix" by changing Haiku's clamp at `:77-78`.
  - Order is fixed: `writeAuditOrThrow` first, then the conditional update. If the update then fails with `ConditionalCheckFailedException`, write a second `fact_decided` row with `result: 'error'` and return the 409. This keeps "every decision is audited" true even when DynamoDB and the audit store disagree.
  - Approve must `REMOVE ttl` (UpdateExpression), not set it to 0; DynamoDB treats `0` as an epoch in the past and deletes the item.
  - The prompt still calls hive notes "authoritative" in built-in prompts and templates; leave the wording (NZR-8) but don't add new trust language.
  - Changing the `<hive_context>` heading changes prompt bytes; tests that mention `hive_context` today: `src/agent/memory-ingest.test.ts`, `src/lib/paperclip/mission-projection.test.ts`, `src/lib/paperclip/dispatch-worker.test.ts`, `src/adapters/dashboard/jarvis-missions.test.ts`; re-run them and update only deliberate byte changes.
  - `GET /hive` is used by the existing page and Jarvis; keep the `{count, notes}` shape so old screens don't crash.

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** knowledge, security

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona E; Q82 rule for who sees proposed text).
- [ ] Acceptance criteria cover both happy paths and edge cases (8 scenarios: queued on 4 read paths, auto-promotion + interim fix, approve, reject, no-TTL + retire, permissions/self-approval/stale, legacy + bulk, store/audit down).
- [ ] UX/UI designs are attached and finalized: design.md W-024 and W-025 (NO-MOCK-YET) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-5 merged; `${app}-studio` table on `development` or slice 0 planned).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71; NOTES proposes 8).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail); no remaining `logToHive`/`recentHive` callers outside the repo and the migration.
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews the security boundary (both writers, all 4 readers, `facts:approve`, self-approval, text-hash binding).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: the `npx vitest run …` list in Test plan, both typechecks, full `npm test`, the facts Playwright spec, `diagrams-drift`, `docs-links`.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51): a chat proposes a fact, it is absent from the next answer, an admin approves, the next answer uses it, a reject removes the text.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; SECURITY.md 3c interim line corrected; diagrams; durable facts promoted to README/ADR (knowledge layers ADR, NZR-8).
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
