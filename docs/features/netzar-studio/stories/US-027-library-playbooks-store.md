# [US-027] Library: Playbooks store

> Backlog task NZR-27 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-019, FR-012.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** to write down how our company does a process
* **So that** the drafter follows our way of working

---

## 2. Business Context & Description
* **Background:**
  - Blueprint "Teach the company" (blueprint.md:96): Library → add a playbook → the drafter uses it. PRD FR-019 (templates created and reused), FR-012 (retrieval respects permissions). Owner Q82: company-level knowledge is visible to everyone; only agent-private knowledge is limited to admins + the agent. Playbooks are company-level.
  - Owner Q90: locally there are no embeddings (Floci 1.6.0 cannot embed, ARCHITECTURE R3), so playbook lookup uses **keyword search**; local drafter scores with playbooks are not representative of Bedrock.
  - Terms. **Playbook**: a short plain-text document "how we do X" (≤ 64 KB markdown), owned by the company, with revisions. **Active**: the playbook the drafter may use. **Keyword search**: match the words of the user's description against playbook titles and text; no model call.
* **Current behaviour (d1d3a66):**
  - No playbook entity, route, table or page exists (`grep -rni playbook src web/src` finds nothing; DATA-MODEL summary item 1: "There are no workflow, playbook, eval or agent-version entities yet").
  - The only company-wide knowledge today is the `shared`/`default` vector scopes (`src/lib/config/agent-loader.ts:25-27`, searched by every agent `src/lib/tools/vector-tools.ts:102`) and the Hive Mind (NZR-28). Vector search needs an embedding call, which fails locally (ARCHITECTURE R3).
  - The drafter (`src/lib/workflows/drafter.ts`) is TARGET in NZR-23 (ARCHITECTURE §2 row "workflows/drafter.ts", §4 flow). Its prompt ships in the repo (Q88) and its files are hashed by the eval gate (Q66, NZR-14/30).
  - Prompt neutralization has one approved scheme: angle brackets → guillemets at interpolation (`src/agent/agent-loop.ts:436-451`); SECURITY §4 item 4 requires it for playbooks.
  - Capabilities are a closed list, additive only (`src/lib/auth/permissions.ts:84-135`); templated profiles at `:195-240`.
* **Target behaviour:**
  - A user with `playbooks:write` creates, edits and archives playbooks in Library; each save is a new revision; nothing is lost on edit.
  - Any user with `playbooks:read` sees the list and reads active playbooks (read-only view without edit controls).
  - When a user asks the drafter for a workflow, the server picks at most 2 active playbooks by keyword match with the description, and passes them to the drafter inside a neutralized `<company_playbooks>` block. The draft follows the playbook's steps (proved by an eval case).
  - The drafter only gets playbooks the requesting user may read; with no `playbooks:read`, it gets none.
  - The drafter response says which playbook it used ("Based on: How we review policies"), and a `playbook.used` event is written.
  - Size and count limits are enforced on the server with plain error messages.
* **Out of scope:**
  - Semantic (embedding) search and ingest into the `pb_company` vector scope (DATA-MODEL §3 "TARGET") → after Bedrock exists (NZR-42) as a follow-up; keyword search stays the fallback.
  - Per-team or per-agent playbooks (knowledge layers Company → Team → Agent) → NZR-8 ADR, 2027.
  - Approval workflow for playbooks: writers are trusted operators; lessons proposing playbook changes → NZR-29.
  - Library home page and nav section → NZR-15 (W-021); this story adds the Playbooks sub-pages.
  - A playbook is not a skill, tool or agent format (do-not-build #8, `docs/features/paperclip/do-not-build.md`; ADR 0018 rejects a second skills store): it is plain text the drafter reads, never executed.
* **Target Value:** In the drafter eval, the new case `playbook-policy-review` passes (draft contains the playbook's "second reviewer approves before the report is sent" step) in live mode; and 0 of the existing 30 cases regress by more than the NZR-30 gate allows. Measured by the committed eval result file (NZR-14/30).
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Create and read a playbook
* **Given** an operator (holds `playbooks:write`)
* **When** they `POST /api/playbooks` with `{ title: "How we review policies", body: "1. Agent reads the policy.\n2. A second reviewer approves.\n3. Send the summary report." }`
* **Then** the response is `201 { id, title, rev: 1, status: 'active', bodyHash, updatedAt }`
* **And** the studio table holds `PLAYBOOK#<id>` / `META` (`rev: 1`, `status: 'active'`, `ownerUserId = personOf(c)`, `keywords` array) and `PLAYBOOK#<id>` / `REV#000001` (`body`, `sha256`, `author`)
* **And** a viewer `GET /api/playbooks` returns it in `{ items: [{ id, title, status, rev, updatedAt, canEdit: false }] }` and `GET /api/playbooks/<id>` returns `{ …, body }`
* **And** one audit row `playbook_saved` `{ playbookId, rev, bodyHash }` (no body text)
* **Test:** `src/lib/studio/playbooks-repo.test.ts` › "creates a playbook with revision 1 and keywords"
* **Test:** `src/adapters/dashboard/playbooks.routes.test.ts` › "operator creates, viewer reads read-only"

### Scenario 2: No permission
* **Given** a viewer (has `playbooks:read`, lacks `playbooks:write`)
* **When** they `PUT /api/playbooks/<id>` or `POST /api/playbooks` or `POST /api/playbooks/<id>/archive`
* **Then** each returns `403 { error: 'forbidden', requiredCapability: 'playbooks:write', message: "You can read playbooks but not change them. Ask an admin for edit rights." }` and no DDB write is sent
* **And** a seat-user (no `playbooks:read`) gets `403 { error: 'forbidden', requiredCapability: 'playbooks:read' }` on `GET /api/playbooks`
* **Test:** `src/adapters/dashboard/playbooks.routes.test.ts` › "refuses writes without playbooks:write with the reason"
* **Test:** `src/adapters/dashboard/authz-matrix.test.ts` › rows for the 5 playbook routes

### Scenario 3: The drafter uses the playbook
* **Given** the active playbook from Scenario 1 and a user with `playbooks:read`
* **When** the user asks the drafter "Set up our policy review: the agent reads each new policy and we send a summary"
* **Then** `findPlaybooksForDraft(description, principal)` returns that playbook first, and the drafter's model input contains `<company_playbooks>` with `<playbook id="<id>" title="How we review policies">…</playbook>` where every `<`/`>` inside the title and body is replaced as in `agent-loop.ts:451`
* **And** the draft response includes `usedPlaybooks: [{ id, title, rev }]`, the screen shows "Based on: How we review policies", and audit `playbook_used` `{ playbookId, rev, draftId }` is written
* **And** in the eval, case `evals/drafter/cases/playbook-policy-review.json` passes: the draft has an approval step whose approver is the "second reviewer" before the output step
* **Test:** `src/lib/studio/playbook-search.test.ts` › "ranks the matching playbook first by keyword overlap"
* **Test:** `src/lib/workflows/drafter.playbooks.test.ts` › "passes at most 2 neutralized playbooks to the drafter and reports usedPlaybooks"
* **Test:** `evals/drafter/cases/playbook-policy-review.json` (live eval, NZR-14 scorer)

### Scenario 4: Permissions on the drafter path, no match, archived
* **Given** a user without `playbooks:read`, or a description with no keyword overlap (score below 2), or a matching playbook with `status: 'archived'`
* **When** the drafter runs
* **Then** no `<company_playbooks>` block is sent, `usedPlaybooks` is `[]`, and no `playbook_used` audit row is written
* **Test:** `src/lib/workflows/drafter.playbooks.test.ts` › "sends no playbooks when the user cannot read them, none match, or they are archived"

### Scenario 5: Concurrent edit and revisions
* **Given** playbook at `rev: 3`, opened by two operators
* **When** both `PUT /api/playbooks/<id>` with `{ baseRev: 3, title, body }`
* **Then** the first gets `200 { rev: 4 }`, the second `409 { error: 'playbook_changed', currentRev: 4, message: "Someone else changed this playbook. Reload to see their version." }` (TransactWriteItems: META `rev = :4` iff `rev = :3`, plus create-only `REV#000004`)
* **And** `GET /api/playbooks/<id>/revisions` lists revs 1–4 newest first (no bodies); `GET /api/playbooks/<id>?rev=2` returns that body
* **Test:** `src/lib/studio/playbooks-repo.test.ts` › "rejects a stale baseRev and keeps every revision"

### Scenario 6: Limits and bad input
* **Given** a write request
* **When** `title` is empty or over 120 chars, `body` is empty or over 64 KB (65,536 bytes UTF-8), unknown keys are sent, or 100 active playbooks already exist
* **Then** the response is `400 { error: 'invalid_body', field, message }` with plain messages ("The title can be up to 120 characters.", "A playbook can be up to 64 KB of text."), or `409 { error: 'too_many_playbooks', max: 100 }`, and nothing is written
* **Test:** `src/adapters/dashboard/playbooks.routes.test.ts` › "enforces title, body, unknown-key and count limits"

### Scenario 7: Store down, and the draft still works
* **Given** the studio table read fails during `findPlaybooksForDraft`
* **When** the drafter runs
* **Then** the draft is produced without playbooks, `usedPlaybooks: []`, a warn log `playbooks lookup failed; drafting without playbooks` is written, and the user is not shown an error
* **And** `GET /api/playbooks` returns `503 { error: 'storage_unavailable', message: "Playbooks can't load right now. Try again in a minute." }`
* **Test:** `src/lib/workflows/drafter.playbooks.test.ts` › "drafts without playbooks when the store is down"
* **Test:** `src/adapters/dashboard/playbooks.routes.test.ts` › "returns 503 with plain copy when the store is down"

### Scenario 8: UI states
* **Given** the Playbooks list and editor (W-022, W-023)
* **When** a writer opens an empty Library, creates "How we review policies", edits it (autosave), and archives it; and a viewer opens the same page
* **Then** the empty state shows the example card "How we review policies"; the editor autosaves 1 s after typing stops and shows "Saved" with an always-visible Undo (PENDING OWNER Q104); the archive confirm reads "Stop using this playbook? The drafter will no longer read it."; the viewer sees no Edit/New/Archive controls
* **Test:** `tests/e2e/library/playbooks.spec.ts` › "writer creates, edits and archives; viewer is read-only"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-23 / US-023](US-023-workflow-drafter-describe-draft-or-clarifying-question.md) Workflow drafter: describe -> draft or clarifying question. Also needed but not listed (see NOTES): NZR-15 Library section (W-021, route `/library`), the `${app}-studio` table (DATA-MODEL §3), and NZR-14's case format accepting seeded playbooks.
* **UI/UX Design:** design.md screen inventory (NO-MOCK-YET): W-022 Playbooks list (`/library/playbooks`: loading; empty with example "How we review policies"; populated; error; read-only for users without edit rights) and W-023 Playbook editor (`/library/playbooks/:id`: new; editing; saving; save failed; archive confirm; "used by the drafter" note). See [design.md](../foundation/design.md). Workspace rules (round 5, apply and mark): plain words, "Helpers" not "agents" (PENDING OWNER Q99; whether "Playbook" itself is on the banned list is open, fallback label "How we do things"); 20px text, AAA 7:1 contrast, works at 200% zoom, "Bigger text" button (PENDING OWNER Q105); iPad + desktop first, phone works (PENDING OWNER Q108); autosave + always-visible Undo, no Save button (PENDING OWNER Q104); "Help me" explains the screen and can read it aloud (PENDING OWNER Q107). Preact + Tailwind 3, no new dependency (Q97).
* **Non-Functional Requirements:** Respects knowledge permissions (FR-012). `findPlaybooksForDraft` p95 ≤ 300 ms locally (one GSI2 Query of ≤ 100 META items + ≤ 2 `GetItem` for bodies). Total playbook text sent to the drafter ≤ 8 KB (each body cut at 4 KB, cut marked "…(shortened)"). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `playbook.created`, `playbook.used`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Props: `{ rev }` for created, `{ rank: 1|2 }` for used. Until NZR-44's writer exists, the `playbook_saved`/`playbook_used` audit rows are the record (NOTES item 6).
* **Files to change:**

  | path | change |
  |---|---|
  | `src/lib/auth/permissions.ts:88-135`, `:195-232` | add `'playbooks:read'` (in `VIEWER_CAPS`) and `'playbooks:write'` (in `OPERATOR_CAPS`); both flow up to admin/org-admin/owner |
  | `src/lib/audit/audit-writer.ts:57-…` | add actions `playbook_saved`, `playbook_archived`, `playbook_used` |
  | `src/adapters/dashboard/handler.ts` | mount the playbooks routes (new sub-router file, registered next to the agents block) |
  | `src/lib/workflows/drafter.ts` (NZR-23, TARGET) | before the model turn, call `findPlaybooksForDraft(description, principal)`; add the `<company_playbooks>` block to the drafter input; return `usedPlaybooks`. UNVERIFIED: exact function names until NZR-23 merges |
  | `src/agent/agent-loop.ts:451` | replace the inline `.replace(/</g,'‹').replace(/>/g,'›')` with the shared `neutralizeForHiveContext()` helper (byte-identical output) |
  | `web/src/App.tsx` | routes `/library/playbooks` and `/library/playbooks/:id` wrapped in `<RequireCapability need="playbooks:read" label="Playbooks">` |
  | `web/src/components/Sidebar.tsx` (NAV_ITEMS, Library section from NZR-15) | "Playbooks" item, `minCapability: 'playbooks:read'` |
  | `src/lib/jarvis/route-manifest.ts:39-131` | `ROUTE_TABLE` entry `/library/playbooks` (label "Playbooks", minRole viewer) |
  | `src/lib/jarvis/route-manifest.test.ts:165-193` | `CAPABILITY_MIN_ROLE`: `'playbooks:read': 'viewer'`, `'playbooks:write': 'operator'` |
  | `src/adapters/dashboard/authz-matrix.test.ts` | rows for the 5 routes |
  | `evals/drafter/cases/` (NZR-14) | new case `playbook-policy-review.json` with a seeded synthetic playbook |
  | `docs/diagrams/architecture-security.md` | new route group + drafter reads playbooks (`handler.ts` is mapped, `docs/diagrams.map:35-45`) |

* **New files:**
  - `src/lib/studio/playbooks-repo.ts`: `createPlaybook`, `updatePlaybook({id, baseRev, title, body})`, `archivePlaybook`, `getPlaybook(id, rev?)`, `listPlaybooks()`, `listRevisions(id)`.
  - `src/lib/studio/playbook-search.ts`: `keywordsOf(text)` (lower-case words ≥ 3 letters, minus a fixed stop-word list, top 200 by count), `findPlaybooksForDraft(description, principal, max = 2)` (score = 3 × title hits + body-keyword hits; keep score ≥ 2).
  - `src/lib/safety/prompt-neutralize.ts`: `neutralizeForHiveContext(text)` = the existing guillemet scheme, shared by hive, playbooks and (NZR-29) lessons. Not a third scheme (comment at `agent-loop.ts:440-450`).
  - `src/adapters/dashboard/playbooks.ts`: Hono sub-router for the routes below.
  - `web/src/pages/Playbooks.tsx`, `web/src/pages/PlaybookEditor.tsx`.
  - Tests: `src/lib/studio/playbooks-repo.test.ts`, `src/lib/studio/playbook-search.test.ts`, `src/lib/workflows/drafter.playbooks.test.ts`, `src/adapters/dashboard/playbooks.routes.test.ts`, `src/lib/safety/prompt-neutralize.test.ts`, `tests/e2e/library/playbooks.spec.ts` + `tests/e2e/library/playwright.config.ts`.
* **API contract:** (under `/api`, auth middleware `handler.ts:1410-1436`; owner/author from `personOf(c)`/`dashboardIdentity(c)`, `handler.ts:294-315`; a principal with no person may read but not write → `403 { error: 'person_required' }`)
  - `GET /playbooks` · `playbooks:read` · `200 { items: [{ id, title, status, rev, updatedAt, ownerUserId, canEdit }] }` sorted by title (GSI2 `PLAYBOOKS`) · `403` · `503 storage_unavailable`.
  - `GET /playbooks/:id?rev=n` · `playbooks:read` · `200 { id, title, status, rev, body, bodyHash, updatedAt, canEdit }` · `404 { error: 'not_found' }`.
  - `GET /playbooks/:id/revisions` · `playbooks:read` · `200 { revisions: [{ rev, author, createdAt, bodyHash, bytes }] }`.
  - `POST /playbooks` · `playbooks:write` · `{ title: string 1..120, body: string 1..65536 bytes }` strict · `201 {…}` · `400 invalid_body` · `403` · `409 too_many_playbooks`.
  - `PUT /playbooks/:id` · `playbooks:write` · `{ baseRev: int, title, body }` · `200 { id, rev }` · `409 playbook_changed {currentRev}` · `404`.
  - `POST /playbooks/:id/archive` and `/unarchive` · `playbooks:write` · `200 { id, status }`.
  - Request body limit 80 KB on these routes (SECURITY §6 floor: no body limit exists in `src/` today).
* **Data changes:**
  - Studio table: `PLAYBOOK#<id>` / `META` = `{ id, title, status: 'active'|'archived', rev, bodyHash, keywords: string[], ownerUserId, updatedAt, GSI2PK: 'PLAYBOOKS', GSI2SK: '<lower(title)>#<id>' }`; `PLAYBOOK#<id>` / `REV#<rev:6>` = `{ body, sha256, author, createdAt }`, create-only. No TTL. Revisions kept (DATA-MODEL §3).
  - Expand only. No backfill (new data). Rollback: data stays (RETAIN).
* **Security notes:**
  - SECURITY 2b T1 (drafter): T — poisoned playbook steers a draft: mitigated by neutralized delimiters, the validator rules (approval before external writes, PENDING OWNER Q95: if the owner says "only warn", a poisoned playbook could yield an unreviewed send; the playbook eval case then must assert the approval step explicitly), and preview built by code. S/I — retrieval as the signed-in user: `findPlaybooksForDraft` takes the principal and checks `playbooks:read`. E — playbook text is never executed and never becomes a tool or agent config.
  - SECURITY §4 risk (b) indirect injection; item 4 single neutralization scheme; item 1 lists a `read_playbook` tool — this story uses server-side injection instead (deterministic, no tool-use dependency on the local model); see NOTES.
  - Authz: read viewer-tier (company knowledge, Q82), write operator-tier (same tier as editing an agent prompt, `agents:write`, because a playbook steers every draft).
  - Audit: ids and hashes only; never body text (WORM, DATA-MODEL risk 6). `writeAudit` is acceptable for saves (non-privileged content), `playbook_used` too.
  - Data rule: fixtures and eval playbooks are synthetic (Q67); customer playbooks never enter the repo (DATA-MODEL §5).
* **Test plan:**
  - Frozen failing tests first: Scenario 2 "refuses writes without playbooks:write with the reason", Scenario 3 "passes at most 2 neutralized playbooks…", Scenario 4 (all three no-playbook cases).
  - Unit: vitest, mocked `ddb().send` (`src/lib/state/agents-repo.test.ts:1-15` pattern); routes via `app.request()` with role principals (`authz-matrix.test.ts:24-60`).
  - Eval: one new case; run live per NZR-30 (the drafter files change, so the hash gate requires a fresh live result; Q66).
  - E2E: Playwright, serial (Q69), seeded synthetic playbooks.
  - Commands: `npx vitest run src/lib/studio/playbooks-repo.test.ts src/lib/studio/playbook-search.test.ts src/lib/workflows/drafter.playbooks.test.ts src/adapters/dashboard/playbooks.routes.test.ts src/lib/safety/prompt-neutralize.test.ts src/adapters/dashboard/authz-matrix.test.ts src/lib/jarvis/route-manifest.test.ts`; `npm run typecheck`; `npm --prefix web run typecheck`; `npm test`; `npx playwright test --config tests/e2e/library/playwright.config.ts`; the NZR-14/30 live eval command (UNVERIFIED name until NZR-14 merges); `node scripts/ci/diagrams-drift.mjs`.
* **Repo rules that apply:**
  - Nav sync (Q87): Sidebar `NAV_ITEMS` + `App.tsx` route + Jarvis `ROUTE_TABLE` + `route-manifest.test.ts` drift checks.
  - Capabilities additive, named profiles only (`permissions.ts:84-87`); `CAPABILITY_MIN_ROLE` map in `route-manifest.test.ts:165`.
  - `handler.ts` route change ⇒ diagram update (`docs/diagrams.map`).
  - Drafter file change ⇒ eval hash gate (Q66); the PR must carry a new live result that beats or equals the baseline (NZR-30).
  - Workspace word list CI check (round 5, PENDING OWNER Q99) on the two new pages.
  - No new dependency.
* **Rollback:** runtime-config flag `studio/playbooks_in_drafter` (default `1`); `0` makes `findPlaybooksForDraft` return `[]` (drafter behaves as before NZR-27). Routes and pages: `git revert`. Data stays (RETAIN).
* **Build slices (proposal):**
  1. *Store + API* (2–3 h): capabilities, repo, sub-router, audit actions, authz matrix, limits. Green: Scenarios 1, 2, 5, 6, 7 (routes).
  2. *Drafter reads playbooks* (2 h): search, shared neutralizer, drafter hook, flag, eval case. Green: Scenarios 3, 4, 7 (drafter).
  3. *UI* (2–3 h): list + editor, autosave/Undo, nav sync, e2e. Green: Scenario 8, route-manifest test.
* **Agent gotchas:**
  - **Eval hash gate:** any change to drafter files fails CI until a fresh live eval result is committed (Q66). Plan a live run in the slice, not after.
  - **Local scores lie:** keyword search locally vs semantic later (Q90). Do not tune the threshold to local results only; keep it simple and documented.
  - **One neutralization scheme.** The comment at `agent-loop.ts:440-450` forbids a third scheme; extract the existing one, keep bytes identical, and prove it with `prompt-neutralize.test.ts` plus the existing hive tests.
  - **Not a skills store** (do-not-build #8): no "steps" schema, no execution, no attachment to agents.
  - `personOf(c)` is undefined for break-glass and bare tokens (`handler.ts:311-315`); those may read but not write (DATA-MODEL §3 "A principal with no person cannot own…").
  - Do not reuse `vectors:read` for playbook reads: NZR-5 is changing what it means.
  - The GSI2 sort key is the lower-cased title; renaming a playbook must update `GSI2SK` in the same transaction.

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** knowledge

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona B writes; the drafter reads as the user).
- [ ] Acceptance criteria cover both happy paths and edge cases (8 scenarios: create/read, no permission, drafter uses it, no-playbook cases, concurrent edit, limits, store down, UI states).
- [ ] UX/UI designs are attached and finalized: design.md W-022 and W-023 (NO-MOCK-YET) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77), drawn to the round-5 Workspace rules (Q99, Q104, Q105, Q107, Q108).
- [ ] Dependencies have been identified and are unblocked (NZR-23 merged; NZR-15 Library nav and the studio table present, or the gap resolved at PLANNING).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71; NOTES proposes 8).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail); no new dependency.
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (npm audit, secret scan, lint) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: the `npx vitest run …` list in Test plan, both typechecks, full `npm test`, the Playwright spec, a fresh live eval result committed (Q66).
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51): write "How we review policies", draft the policy review, see "Based on: How we review policies" and the second-reviewer approval step.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; diagram; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
