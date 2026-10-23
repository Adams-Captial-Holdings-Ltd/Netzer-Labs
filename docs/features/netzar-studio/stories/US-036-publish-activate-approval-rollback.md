# [US-036] Publish / Activate (approval) / Rollback

> Backlog task NZR-36 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-008, FR-010, AC-022.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** to publish a tested draft as a frozen version, have an approver switch it on, and switch back to the last good version in one click when something goes wrong
* **So that** live runs only ever use a version someone tested and approved (AC-022), and a bad change is undone before the next run starts

---

## 2. Business Context & Description
* **Background:**
  - Lifecycle (blueprint §4): draft → test → **publish** (freeze) → **activate** (approval) → **roll back**. This story owns the last three.
  - Terms: **publish** = copy one tested draft revision into a numbered, read-only version (`VER#000001`); it does not go live. **Activate** = point the workflow's live pointer (`activeVer`) at a version; only then do triggers start runs with it. **Roll back** = point `activeVer` back at an earlier version that was active before. **Deactivate** = no active version; triggers answer `409 not_active` (NZR-35).
  - DATA-MODEL §3 (WorkflowVersion row): publish = Transact(put `VER`, `META.publishedVer`); activate = `META.activeVer` + approval ref; rollback = point `activeVer` at an earlier `VER`. Versions are create-only, never updated, kept while referenced.
  - SECURITY T5 E-rule: a trigger can start only a published, activated version and cannot pass a version. SECURITY T6: activation is a high-impact action (FR-010).
  - Runs pin the version at start (NZR-34 `RUN#…/META.versionSeq` + `versionSha256`). A rollback never changes a run that already started.
  - DEPLOY §4 pre-deploy checklist: "new triggers default OFF, activation needs approval (NZR-36)". In the pilot, a newly published version is never live until approved.
* **Current behaviour (d1d3a66):**
  - None of this exists. `src/lib/workflows/` is created by NZR-12 (store + schema) and NZR-49 (list/get routes). Draft revisions `DRAFT#<rev>` and `META.draftRev` come from NZR-12/24; test runs `TEST#<runId>` with forward-only status come from NZR-26 (DATA-MODEL §3).
  - Agent versions `av_<32 hex>` and `loadAgent(agentId, { versionId })` come from NZR-22 (US-022).
  - design.md W-012 "Ready" says "publishing comes later, loop 2" and has **no owner** (`foundation/design.md:172`). No screen row exists for publish, versions, activation approval or rollback (checked §3a–3d). W-007 is draft history, not published versions.
  - Pattern for a guarded state change with audit: `src/lib/work/approvals.ts:110-184` (decide, refuse with code, audit on every path).
* **Target behaviour:**
  - **Publish:** from a draft revision that has a passing test run on the same `draftSha256`, create `VER#<n>` holding the frozen JSON, its `sha256`, `fromDraftRev`, the agent pins, `publishedBy/At`. Fails if any agent step has no published agent version.
  - **Request activation:** the publisher (or any holder of `workflows:publish`) asks for a version to go live; approvers get it in their list.
  - **Activate:** a holder of `workflows:activate` who is **not the publisher of that version** approves with the version's `sha256`; `META.activeVer` moves to it in one conditional write. Proposal (four-eyes); see NOTES for a one-person install.
  - **Roll back:** one click on a version that was active before (it has an `ACTIVATION` record). Needs `workflows:activate`; no second approval, because that exact frozen version was already approved. Takes effect on the next `startRun` (no cache).
  - **Deactivate:** one click, `workflows:activate`; triggers stop starting runs.
  - Every change writes an always-audited row and a history row; the UI shows who did what and when.
* **Out of scope:**
  - The Ready flag itself (W-012 has no owner; see NOTES). This story reads "passing test on this draft hash" directly.
  - Triggers and their secrets (NZR-35). Running versions (NZR-34). Run history UI (NZR-44 / unowned approver screen, see US-034 NOTES).
  - Deleting a version. Versions are kept forever while referenced (FR-008).
  - Diff view between versions (later).
* **Target Value:** rollback drill: with v2 active, one Roll back click → the next `startRun` uses v1, measured by `RUN#…/META.versionSeq = 1` within 1 run and < 2 s from click; 0 runs start on a version without an `ACTIVATION` record (test-enforced).
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Publish a tested draft
* **Given** workflow `wf_1` at `draftRev 7` (`draftSha256 D7`) with a `TEST#…` row `status: passed` for `D7`, and every agent step pinned to a published agent version
* **When** a `workflows:publish` holder calls `POST /api/workflows/wf_1/versions { draftRev: 7, draftSha256: 'D7' }`
* **Then** `201 { versionSeq: 1, versionSha256, status: 'published' }`; item `WF#wf_1/VER#000001` exists with `fromDraftRev: 7`, `agentPins: [{ stepId, agentId, agentVersionId }]`; `META.publishedVer = 1`, `META.activeVer` unchanged; audit `workflow_published`; the UI shows "Version 1 published. It is not live yet." and a button "Ask to switch on"
* **Test:** `src/lib/workflows/versions.test.ts` › "publishes a tested draft as a frozen version"; `src/adapters/dashboard/workflows.versions.routes.test.ts` › "POST versions returns 201 with the new version"

### Scenario 2: Publish refused
* **Given** (a) no passing test for `D7`; (b) the draft moved to `draftRev 8` after the caller loaded it; (c) one agent step has no `agentVersionId`; (d) a seat-user or viewer principal
* **When** they publish
* **Then** (a) `409 { error: 'not_tested', message: 'Test this version first.' }`; (b) `409 { error: 'draft_changed' }`; (c) `422 { error: 'agent_not_published', stepIds: ['…'] }`; (d) `403 { error: 'forbidden', requiredCapability: 'workflows:publish' }`; in all cases no `VER#` item is written
* **Test:** `src/lib/workflows/versions.test.ts` › "refuses to publish an untested draft", "refuses a stale draft rev", "refuses unpinned agent steps"; routes test › "seat-user and viewer cannot publish"

### Scenario 3: Activation needs a different approver
* **Given** version 1 published by Alice and an activation request for it
* **When** (a) Bob (holds `workflows:activate`) approves with `versionSha256` of v1; (b) Alice approves her own version; (c) Bob approves with a wrong `versionSha256`
* **Then** (a) `200 { activeVer: 1 }`, `META.activeVer = 1`, an `ACTIVATION#000001` record (who, when, request id), audit `workflow_activated`; (b) `403 { error: 'self_approval_not_allowed' }`; (c) `409 { error: 'version_changed' }`; (b) and (c) leave `activeVer` unchanged and write audit `workflow_activation_refused` with the code
* **Test:** `src/lib/workflows/versions.test.ts` › "a different approver activates", "the publisher cannot activate their own version", "a wrong version hash is refused"

### Scenario 4: One-click rollback
* **Given** v1 was active, then v2 was activated, and v2 misbehaves
* **When** a `workflows:activate` holder clicks "Roll back to version 1" and confirms (`POST /api/workflows/wf_1/rollback { toVersionSeq: 1, expectedActiveVer: 2 }`)
* **Then** `200 { activeVer: 1 }`; the next `startRun` for `wf_1` creates a run with `versionSeq: 1` and `versionSha256` of v1; a run that started on v2 before the click still shows `versionSeq: 2`; audit `workflow_rolled_back` with `{ fromVer: 2, toVer: 1 }`; the UI shows "Version 1 is live again."
* **Test:** `src/lib/workflows/versions.test.ts` › "rollback points activeVer at the earlier version"; `src/lib/engine/start-run.test.ts` › "the run after a rollback uses the rolled-back version" (extends NZR-34's file)

### Scenario 5: Rollback and activation edge cases
* **Given** (a) rollback to v3, which was published but never active; (b) two people roll back at the same time with `expectedActiveVer: 2`; (c) rollback when there is only one version
* **When** they submit
* **Then** (a) `409 { error: 'never_activated', message: 'This version was never approved to run. Ask to switch it on instead.' }`; (b) one gets `200`, the other `409 { error: 'active_changed', activeVer: <current> }`; (c) the Roll back control is hidden and the API returns `409 { error: 'no_earlier_version' }`
* **Test:** `src/lib/workflows/versions.test.ts` › "cannot roll back to a never-activated version", "concurrent rollbacks: one wins", "no earlier version"

### Scenario 6: Deactivate stops new runs, not old ones
* **Given** v1 active and one run waiting for approval on v1
* **When** a `workflows:activate` holder clicks "Switch off" (`POST /api/workflows/wf_1/deactivate { expectedActiveVer: 1 }`)
* **Then** `200 { activeVer: null }`; a new webhook request gets `409 { error: 'not_active' }` (NZR-35); the waiting run still completes on v1 when approved; audit `workflow_deactivated`
* **Test:** `src/lib/workflows/versions.test.ts` › "deactivate clears activeVer"; `src/lib/engine/engine.golden.integration.test.ts` › "a run in flight finishes after deactivate"

### Scenario 7: Versions screen states
* **Given** the workflow page `/workflows/wf_1` Versions panel
* **When** it loads with (a) no versions; (b) v1 active, v2 published with a pending request; (c) the API fails
* **Then** (a) "No published versions yet." with the Publish button disabled until a test passes ("Test this version first."); (b) a list: "Version 2 · Waiting for approval · published by Alice", "Version 1 · Live since <date> · approved by Bob", with "Roll back to version 1" shown on v1 only when v2 is live; (c) "Couldn't load versions. Try again." with a retry button; no capability strings on screen
* **Test:** `web/src/pages/studio/VersionsPanel.test.tsx` › "empty", "live and pending", "load error"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-34 / US-034](US-034-live-engine-v1-chosen-option.md) Live engine v1 (chosen option)
* **Builds on (other merged work; formal dependency changes are proposed in NOTES-H-live-deploy.md, not made here):** `startRun` reads `activeVer`. Also needs merged: NZR-12 store (`WF#/META`, `DRAFT#`), NZR-22 agent versions, NZR-26 test runs (`TEST#` passed on a draft hash), NZR-49 workflows router.
* **UI/UX Design:** No design.md row exists for publish/versions/activation/rollback (W-012 "Ready" notes publishing for loop 2, `foundation/design.md:172`). A mock (new inventory row, proposed `W-033 Versions & go-live`) is required before this step starts (Q77). Copy strings in this story are the starting point. PENDING OWNER Q99 (plain words on Workspace screens: "routine", not "workflow"; "When this happens", not "trigger"): the strings avoid both words; if the owner keeps "workflow", no string changes. Workspace text rules apply (20px, 7:1 contrast, works at 200% zoom, "Help me" explains the panel).
* **Non-Functional Requirements:** activation by an authorized approver who is not the publisher; rollback effective on the next run; ≤ 1 `GetItem` added to `startRun`. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `workflow.published`, `workflow.activated`, `workflow.rolled_back`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Props allow-list: `{ workflowId, versionSeq, fromVer?, stepCount }`.

**Files to change**
| path | change |
|---|---|
| `src/lib/workflows/store.ts` (NZR-12) | Add `activeVer`, `activeSince`, `publishedVer` handling on `META`; readers tolerate missing (expand-only) |
| `src/lib/engine/start-run.ts` (NZR-34) | Replace the fixture lookup with `getActiveVersion(workflowId)` → `{ seq, sha256, json }` or `no_active_version`; verify `sha256(json) === VER.sha256` before running (fail closed) |
| `src/adapters/dashboard/workflows.ts` (NZR-49 router; UNVERIFIED file name) | Mount the version routes below |
| `src/lib/auth/permissions.ts:88-136,195-240` | Add `workflows:publish` (operator tier and up) and `workflows:activate` (admin tier and up). Not seat-user, not viewer (SECURITY §5.9). |
| `src/lib/jarvis/route-manifest.test.ts:165` | `CAPABILITY_MIN_ROLE`: `'workflows:publish': 'operator'`, `'workflows:activate': 'admin'` |
| `src/lib/audit/audit-writer.ts:57-206,234-260` | Always-audited: `workflow_published`, `workflow_activation_requested`, `workflow_activated`, `workflow_activation_refused`, `workflow_rolled_back`, `workflow_deactivated` |
| `web/src/pages/studio/WorkflowDetail.tsx` (NZR-49/25) | Add the Versions panel |
| `web/src/lib/studio/api.ts`, `web/src/lib/studio/copy.ts` | Client calls; all strings from this story |

**New files**
| path | purpose |
|---|---|
| `src/lib/workflows/versions.ts` | `publish`, `requestActivation`, `decideActivation`, `rollback`, `deactivate`, `getActiveVersion`, `listVersions` |
| `src/lib/workflows/versions.test.ts` | Scenarios 1–6 (fake DDB) |
| `src/adapters/dashboard/workflows.versions.routes.test.ts` | HTTP contract + capability matrix |
| `web/src/pages/studio/VersionsPanel.tsx` (+ `.test.tsx`) | Panel, confirm dialogs, Scenario 7 states |

**API contract** (all under the dashboard bearer; 401 `{ error: 'unauthorized' }`; 403 `{ error: 'forbidden', requiredCapability }`; 404 `{ error: 'not_found' }` for unknown or not-visible workflow)
- `GET /api/workflows/:id/versions` — `workflows:read`. 200 `{ activeVer: number | null, versions: [{ versionSeq, versionSha256, status: 'published' | 'pending_activation' | 'live' | 'was_live', publishedBy, publishedAt, activatedBy?, activatedAt?, fromDraftRev }] }`.
- `POST /api/workflows/:id/versions` — `workflows:publish`. Body strict `{ draftRev: int ≥ 1, draftSha256: 64 hex }`. 201 `{ versionSeq, versionSha256, status: 'published' }`. 409 `not_tested` / `draft_changed`. 422 `{ error: 'agent_not_published', stepIds }` / `{ error: 'invalid_definition', issues }`.
- `POST /api/workflows/:id/versions/:seq/activation-requests` — `workflows:publish`. Body `{ note?: string ≤ 500 }`. 201 `{ requestId, status: 'pending' }`. 409 `{ error: 'already_live' }` / `{ error: 'request_pending', requestId }`.
- `POST /api/workflows/:id/activation-requests/:requestId/decision` — `workflows:activate`. Body strict `{ decision: 'approve' | 'reject', versionSha256: 64 hex, comment?: string ≤ 1000 }` (reject needs a comment). 200 `{ activeVer }`. 403 `{ error: 'self_approval_not_allowed' }`. 409 `{ error: 'version_changed' }` / `{ error: 'not_pending' }` / `{ error: 'active_changed', activeVer }`.
- `POST /api/workflows/:id/rollback` — `workflows:activate`. Body strict `{ toVersionSeq: int ≥ 1, expectedActiveVer: int }`. 200 `{ activeVer }`. 409 `never_activated` / `active_changed` / `no_earlier_version` / `{ error: 'already_live' }`.
- `POST /api/workflows/:id/deactivate` — `workflows:activate`. Body strict `{ expectedActiveVer: int }`. 200 `{ activeVer: null }`. 409 `active_changed`.

**Data changes** (studio table, NZR-12; expand-only)
- `WF#<wfId>` / `META`: add `publishedVer` (number), `activeVer` (number | absent), `activeSince` (ISO), `activeBy` (person id).
- `WF#<wfId>` / `VER#<seq:6>`: `json` (frozen definition), `sha256`, `fromDraftRev`, `draftSha256`, `testRunId` (the passing test), `agentPins[]`, `publishedBy`, `publishedAt`, `schemaVersion`. Create-only (`attribute_not_exists(SK)`), never updated. Publish = `TransactWriteItems`: put `VER` + update `META` set `publishedVer = :n` if `publishedVer = :n-1` (or absent for n = 1) and `draftRev = :rev`. Items ≤ 400 KB: refuse publish with `422 { error: 'definition_too_large' }` above 350 KB.
- `WF#<wfId>` / `ACTREQ#<requestId>`: `versionSeq, requestedBy, requestedAt, status (pending|approved|rejected), decidedBy?, decidedAt?, commentSha256?`. Status moves only from `pending`.
- `WF#<wfId>` / `ACTIVATION#<seq:6>`: written once, the first time a version goes live (proof it was approved; rollback requires it).
- `WF#<wfId>` / `GOLIVE#<ts>#<n>`: history (`kind: activated|rolled_back|deactivated, fromVer, toVer, by`).
- Activate/rollback/deactivate = `TransactWriteItems`: update `META.activeVer` with condition `activeVer = :expected` (or `attribute_not_exists`) + put the history row (+ `ACTIVATION#` on first activation, + `ACTREQ` status change).
- Rollback of this story's code: the new attributes are ignored by older readers; no backfill; no contract step.

* **Security notes:**
  - SECURITY T5 E (only activated versions run; trigger cannot pick a version), T6 (activation is high impact, approval-gated), FR-010. `startRun` re-hashes the frozen JSON against `VER.sha256` (tamper check, T).
  - Authz: `workflows:publish` operator+, `workflows:activate` admin+; partner principals hold neither unless the owner grants it (§5.9). Approver identity from the session principal only (never body / `X-Dashboard-User`).
  - Self-approval blocked by comparing `principal.userId` with `VER.publishedBy` (proposal; NOTES).
  - Audit: `writeAuditOrThrow` on every change and every refusal; ids and hashes only. The comment is hashed, not stored in audit.
* **Test plan:**
  - Frozen failing tests first: Scenarios 3, 4, 5 in `src/lib/workflows/versions.test.ts` (red SHA).
  - Unit: `versions.test.ts` (fake DDB incl. transaction-condition failures), `workflows.versions.routes.test.ts` (real router, mocked principals per role), `start-run.test.ts` additions, `VersionsPanel.test.tsx` (web vitest).
  - Integration: extend `src/lib/engine/engine.golden.integration.test.ts` with publish → activate → run → rollback → run (LocalStack).
  - Fixtures: synthetic definitions only (`src/lib/workflows/__fixtures__/golden-v1.json`, `golden-v2.json`).
  - Commands: `npx vitest run src/lib/workflows src/adapters/dashboard/workflows.versions.routes.test.ts src/lib/engine/start-run.test.ts src/lib/jarvis/route-manifest.test.ts`; `npm run test:integration:up && npx vitest run --config vitest.integration.config.ts src/lib/engine && npm run test:integration:down`; `cd web && npx vitest run src/pages/studio/VersionsPanel.test.tsx`; full `npm test`.
* **Repo rules that apply:** additive capability strings + `CAPABILITY_MIN_ROLE` entry; `writeAuditOrThrow` for evidence; expand-only data change; no new dependency; mock before UI work (Q77); full `npm test` before push.
* **Rollback:** of a workflow: this story *is* the rollback (Roll back / Switch off). Of the code: image rollback `npm run deploy:rollback -- --class=image --to=previous`; versions stay frozen and valid.
* **Build slices (proposal):**
  1. *Publish* (1–2 h): `versions.ts` publish + `getActiveVersion`, route, capability, audit. Green: Scenarios 1, 2.
  2. *Activation approval* (1–2 h): request + decide, four-eyes, `startRun` wiring. Green: Scenario 3.
  3. *Rollback + deactivate* (1 h): Green: Scenarios 4, 5, 6.
  4. *Versions panel* (1–2 h, after the mock): Green: Scenario 7.
* **Agent gotchas:**
  - `activeVer` must be read fresh in `startRun` (one `GetItem`, `ConsistentRead: true`). Do not reuse the 5-minute agent-loader cache pattern (`agent-loader.ts:149`) here; rollback must hit the next run.
  - Never update a `VER#` item, even to add a field. Put new facts on `META`, `ACTIVATION#` or `GOLIVE#`.
  - Use `expectedActiveVer` on every pointer move; a plain `SET activeVer` lets two clicks race silently.
  - Version status in the list (`live`, `was_live`, `pending_activation`) is computed from `META` + `ACTIVATION#` + `ACTREQ#`; do not store it on `VER#`.
  - `seq` padding is 6 digits (`VER#000001`); sort and parse consistently or rollback picks the wrong version after v9.

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona B; rollback drill is the measure).
- [ ] Acceptance criteria cover both happy paths and edge cases (7 scenarios incl. self-approval, stale hash, never-activated rollback, races, deactivate with a run in flight).
- [ ] UX/UI designs are attached and finalized: new design.md row "Versions & go-live" mocked (Q77); NO-MOCK-YET today.
- [ ] Dependencies have been identified and are unblocked (NZR-34 `startRun`; NZR-12, NZR-22, NZR-26, NZR-49 merged; four-eyes rule accepted by the owner or replaced).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews the security boundary (who can activate).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD (commands above); full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner (as Persona B) publishes, gets it approved, rolls back, and confirms the next run used the old version.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR; design.md inventory row added.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists; the rollback drill is repeated on rebuild staging before the pilot (DEPLOY §4 step 7).
