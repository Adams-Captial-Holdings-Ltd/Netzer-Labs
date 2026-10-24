# [US-025] Plain-language preview (numbered steps, no canvas) + helper picker

> Backlog task NZR-25 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-004, AC-003, AC-004, AC-006. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3), designed and tested as "Margaret, 67" (Q98)
* **I want** to see my routine as short numbered steps in plain words. I also want to tap any step and fix it with big buttons (Change who, Change what, Remove, Move up, Move down), without typing.
* **So that** I can tell someone what the routine will do before I try it. Success is 4 of 5 dry-run testers explaining it correctly (AC-003). I can also finish setup, such as choosing a helper, without help (AC-004, AC-006).

---

## 2. Business Context & Description
* **Background:**
  - The MVP has no canvas (PRD 3.2, Q97 "No drag-and-drop canvas"). The preview is the only picture of the routine Margaret gets, so it must say who, what and when for every step, where approvals happen and what the result is.
  - Q103 (round 5): tapping a step gives big buttons: Change who, Change what, Remove, Move up/down, and chat for anything else. Q104: autosave with no Save button, and Undo always visible (Undo itself is NZR-24).
  - design.md O-11: W-005 (pick a helper) had **no owner**. This story owns it as "Change who". W-004 "Needs setup" and the disabled "Try it" button are also here.
  - PRD IDs: FR-004 (plain-language preview), AC-003 (understandable preview), AC-004 (choose helpers per step), AC-006 (missing setup is shown, not hidden).
  - Words: **routine** = workflow, **helper** = agent, "When this happens" = trigger (PENDING OWNER Q99). Code and data keep the technical names.
* **Current behaviour (d1d3a66):**
  - No preview, picker or step-edit code exists. `/workflows/:id` is a frame with a not-found state after NZR-49 (US-049).
  - Draft storage comes from NZR-12 (DATA-MODEL §3): `WF#<wfId>`/`META` holds `draftRev`. Revisions are `DRAFT#<rev:6>` with the full JSON (trigger, steps of type `agent|decision|approval|output`), `sha256`, `source chat|edit`, `parentRev` and the validator result. A revision is appended by a transaction: META `draftRev=:n` only if it equals `:n-1`, plus a create-only put of the DRAFT.
  - Agents today come from `GET /api/agents` (`src/adapters/dashboard/handler.ts:1504-1550`, gated on `agents:read`). The response includes `systemPromptPreview`, `model`, and bot connection flags (`:1519-1530`). That is too much for a picker, and the words are not plain. Status values are `'active' | 'inactive' | 'creating' | 'error'` (`src/lib/agents/types.ts:1`).
  - There is no per-agent "who may use" list (DATA-MODEL risk 1: capabilities are deployment-wide). Today "helpers I may use" can only mean "active helpers in this install".
  - The legacy role gate requires `operator` on every non-GET path. The `/workflows*` carve-out comes from US-049 (`handler.ts:428-466`).
* **Target behaviour:**
  - `/workflows/:id` shows:
    - A status line: "Draft · not tried yet · not turned on", "Tried · passed", or "Ready". The labels come from US-049 `labelFor`.
    - A "When this happens" card.
    - An ordered list of steps. Each step shows its number, one sentence (what), who does it (helper name, "You", or the approver), and an "Approval" badge where someone must approve.
    - A "Result" card.
    - A big "Try it" button.
  - Each sentence is built server-side by a pure function from the draft JSON. No model call, so the same draft always gives the same words.
  - A step with no helper shows "Needs: choose a helper" and a "Choose a helper" button. While anything is needed, "Try it" is disabled and the reason is shown under it ("Choose a helper for step 2 first.").
  - Tapping a step opens a sheet with the buttons Change who, Change what, Remove, Move up and Move down.
    - Change who opens the helper picker (W-005). The picker shows active helpers only, each with a name and "Good for: …". "None of these fit?" says to ask the administrator.
    - Remove and Move write a new draft revision right away (autosave). The changed step is highlighted for 3 s with a line like "Step 3 moved up."
    - Change what opens the NZR-24 "Ask" box, prefilled with "Change step 2: ". It is hidden if NZR-24 is not merged.
  - A stale edit (draft changed in another tab) is refused, the latest draft is reloaded, and "This routine changed somewhere else. We loaded the newest version." is shown.
  - Screen-reader order equals step order (`<ol>`). Text is 20px and "Help me" works on this screen (frame from US-049).
* **Out of scope:**
  - Free-text edits, Undo and history (NZR-24, W-006/W-007).
  - Drafting (NZR-23).
  - Running a test and the Ready flag (NZR-26).
  - A per-helper access list (DATA-MODEL risk 1, NZR-5 owner decision).
  - Creating a helper from the picker.
  - Canvas or drag-and-drop.
  - Pinning a helper version (NZR-22/36, loop 2).
* **Target Value:** In the Nov 23 dry-run, at least 4 of 5 testers (at least 2 aged 60+) explain in their own words what the golden routine does, correctly on trigger, helper, approval and result (observer checklist, NZR-47). At least 4 of 5 choose a helper without tapping "Help me". Measured with `workflow.preview_viewed`, `workflow.step_changed` and `studio.help_opened` (screen `preview`).
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3), as "Margaret, 67" (Q98). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Readable steps
* **Given** the owner's routine whose latest draft is the golden fixture:
  - trigger "a new policy document is added"
  - agent step "insurance-reviewer" reviews the document
  - decision "any gaps found?"
  - approval by "you"
  - output "report to you"
* **When** they open `/dashboard/workflows/<id>`
* **Then**:
  - `GET /api/workflows/<id>` returns 200 with a `preview` whose `when.text` is "When a new policy document is added".
  - The `steps` array has 4 entries numbered 1 to 4. Each has a non-empty `what` and a `who`.
  - Step 3 has `approval: {by: "You"}`.
  - `result.text` starts with "You get".
  - The page renders `ol > li` items in the same order, each showing "1", "2", … the sentence and the who line.
  - Step 3 shows the badge "Approval".
  - The status line reads "Draft · not tried yet · not turned on".
* **Test:** `src/lib/workflows/describe.test.ts` › "golden draft describes as 4 plain numbered steps"; `tests/e2e/studio/preview.spec.ts` › "preview shows numbered steps, approval badge and status line"

### Scenario 2: Choose a helper (Change who)
* **Given** a draft where step 1 (an agent step) has no `agentId`, and the install has helpers A (active), B (active) and C (inactive)
* **When** the owner taps "Choose a helper" on step 1, then taps helper B
* **Then**:
  - `GET /api/workflows/helpers` returns exactly A and B, each `{id, name, goodFor}`, with no `systemPromptPreview`, `model` or connection fields.
  - The picker shows "Good for: <description, at most 140 characters>".
  - Tapping B sends `POST /api/workflows/<id>/steps/<stepId>` `{"op":"set_helper","helperId":"B","baseRev":1}`. The response is 200 with `draftRev: 2`. Step 1 now shows B's name and the highlight line "Step 1: B will do this."
  - The store has a new `DRAFT#000002` with `source: "edit"` and `parentRev: 1`.
* **Test:** `src/adapters/dashboard/workflows.preview.routes.test.ts` › "helpers lists active helpers with safe fields only" and › "set_helper writes a new revision"; `tests/e2e/studio/preview.spec.ts` › "choose a helper fills the step"

### Scenario 3: Needs setup blocks Try it
* **Given** a draft whose step 2 is an agent step with no helper chosen
* **When** the preview opens
* **Then**:
  - `preview.needs` equals `[{"stepId":"<s2>","kind":"choose_helper","text":"Choose a helper for step 2"}]` and `canTry` is false.
  - Step 2 shows "Needs: choose a helper" with a "Choose a helper" button.
  - The "Try it" button is `disabled` and `aria-describedby` points to the text "Choose a helper for step 2 first."
  - After a helper is chosen, `canTry` is true and the button is enabled with no reload.
* **Test:** `src/lib/workflows/describe.test.ts` › "a helper-less agent step yields a choose_helper need"; `tests/e2e/studio/preview.spec.ts` › "needs setup disables Try it with the reason"

### Scenario 4: Remove and move a step (autosave)
* **Given** the golden draft at `draftRev` 3
* **When** the owner taps step 2 → "Move up", then taps step 4 → "Remove" → confirms "Remove step"
* **Then**:
  - Each tap writes one revision (rev 4, then rev 5) with no Save button anywhere.
  - The list re-numbers 1 to 3. The highlight lines read "Step 2 moved up." and "Step 4 removed."
  - "Move up" is disabled on step 1 and "Move down" is disabled on the last step.
* **Test:** `src/lib/workflows/step-edits.test.ts` › "move and remove produce valid drafts and plain change lines"; `tests/e2e/studio/preview.spec.ts` › "move up and remove autosave and renumber"

### Scenario 5: An edit that would break the routine
* **Given** a draft with one agent step and one output step
* **When** the owner removes the only agent step
* **Then**:
  - The API returns 422 `{"error":"invalid_change","message":"A routine needs at least one step that does the work."}`. The message comes from the NZR-12 validator in plain words.
  - No revision is written and the step is still shown.
  - The message appears under the step sheet with an "OK" button.
* **Test:** `src/adapters/dashboard/workflows.preview.routes.test.ts` › "a change the validator rejects returns 422 and writes nothing"

### Scenario 6: Stale draft (changed in another tab)
* **Given** the page loaded `draftRev` 4 and another tab saved rev 5
* **When** the owner taps "Move down" on step 1 (sending `baseRev: 4`)
* **Then**:
  - The API returns 409 `{"error":"stale_draft","draftRev":5}` and writes nothing.
  - The page reloads the draft and shows "This routine changed somewhere else. We loaded the newest version."
* **Test:** `src/adapters/dashboard/workflows.preview.routes.test.ts` › "baseRev mismatch is 409 stale_draft"; `tests/e2e/studio/preview.spec.ts` › "stale edit reloads with a plain notice"

### Scenario 7: Picker edge cases
* **Given** (a) no active helpers, (b) the helpers request fails, (c) a `set_helper` with an inactive or unknown `helperId`
* **When** the picker opens or the request is sent
* **Then**:
  - (a) The picker shows "There are no helpers yet. Ask your administrator to add one."
  - (b) The picker shows "We couldn't load the helpers." with "Try again".
  - (c) The API returns 400 `{"error":"unknown_helper"}`. The same body comes back for inactive and for missing ids, and nothing is written.
* **Test:** `src/adapters/dashboard/workflows.preview.routes.test.ts` › "inactive or unknown helper is 400 unknown_helper"; `tests/e2e/studio/preview.spec.ts` › "picker empty and error states"

### Scenario 8: Not the owner, no write permission
* **Given** (a) another person's routine id, (b) a principal holding `workflows:read` but not `workflows:write` (custom profile)
* **When** they call `POST /api/workflows/<id>/steps/<stepId>` or `GET /api/workflows/helpers`
* **Then**:
  - (a) Returns 404 `{"error":"not_found"}`.
  - (b) Returns 403 `{"error":"forbidden","requiredCapability":"workflows:write"}`.
  - The store is not written in either case. For (b) the UI hides the step buttons and "Try it" and shows "You can look at this routine but not change it."
* **Test:** `src/adapters/dashboard/workflows.preview.routes.test.ts` › "other owner 404 and read-only 403 write nothing"

### Scenario 9: Plain, readable, accessible
* **Given** the preview at 1440x900, 1024x768 and 390x844
* **When** it renders, and again at 720x450 (200% zoom)
* **Then**:
  - Every string in `preview` (when/what/who/result/needs) contains no banned word (`workflow`, `agent`, `trigger`).
  - Body text is at least 20px, each step row and sheet button is at least 44x44px, and there is no horizontal scroll at 720x450.
  - Keyboard Tab order goes "When" card → step 1 … step N → "Try it".
  - The step sheet is a `role="dialog"` with focus moved into it, Escape closes it, and focus returns to the step.
* **Test:** `src/lib/workflows/describe.test.ts` › "describe output never uses banned words" (runs over all 10 fixture drafts); `tests/e2e/studio/preview.spec.ts` › "preview text size, zoom and keyboard order"

---

## 4. Technical Notes & Constraints
* **Dependencies:**
  - [NZR-23 / US-023](US-023-workflow-drafter-describe-draft-or-clarifying-question.md) Workflow drafter: describe -> draft or clarifying question.
  - Also needs [NZR-49 / US-049](US-049-plain-workflows-tab-list-new-open-draft.md): page frame, `StudioPage`, `copy.ts`, capabilities and the `requiredRole` carve-out.
  - Also needs [NZR-12 / US-012](US-012-workflow-definition-schema-validator.md): draft JSON schema, validator with plain messages, and the revision append in `src/lib/workflows/store.ts`.
  - Soft dependency: [NZR-24 / US-024](US-024-edit-by-chat-on-drafts.md) for "Change what" and Undo. The screen works without it; those two controls stay hidden.
* **UI/UX Design:**
  - Mocks: W-004 [preview desktop](../../../assets/netzar-studio/mock/W-004-preview-desktop.png) / [phone](../../../assets/netzar-studio/mock/W-004-preview-phone.png), [needs setup desktop](../../../assets/netzar-studio/mock/W-004-needs-setup-desktop.png) / [phone](../../../assets/netzar-studio/mock/W-004-needs-setup-phone.png), W-005 [pick desktop](../../../assets/netzar-studio/mock/W-005-pick-agent-desktop.png) / [phone](../../../assets/netzar-studio/mock/W-005-pick-agent-phone.png). Index: [design.md](../foundation/design.md) sections 2 and 3a.
  - The current mocks are chat-style: a side chat next to the steps, "agent" wording, "Test with sample data", 15 to 18px text, and no step sheet. They will be redone for the guided flow (Q101, before Nov 9). The redo adds the step sheet with the 5 big buttons, the "Try it" button, the always-visible Undo slot, "Help me", "Bigger text" and an iPad frame. Build from the copy in this story; the redone mocks win on layout.
  - Not yet mocked (due Nov 9): generating, validator errors (W-004); no helper fits, picker error (W-005); step sheet; stale-draft notice.
  - PENDING OWNER Q99 (words), Q103 (step sheet; if no, only "Change who" ships and other changes go through NZR-24 chat), Q104 (autosave, Undo visible; if no, a "Save" button commits a batch), Q105 (20px, AAA), Q107 ("Help me" read-aloud). Recommended yes on all. This story builds the recommendation.
  - PENDING OWNER Q95: if yes, the NZR-12 validator adds a need "Add an approval before this sends anything" for any external write that has no approval before it. The preview shows it like any other need. No code here changes, because needs are rendered generically.
* **Non-Functional Requirements:**
  - Workspace screen: 20px body, AAA contrast 7:1, targets at least 44px, 200% zoom, iPad + desktop first (Q105, Q108).
  - The screen-reader order matches the step order.
  - `describeDraft` is pure and deterministic: no model call and no I/O.
  - `GET /api/workflows/:id` p95 under 400 ms. That is 2 reads (META, latest DRAFT) plus one helpers read, cached per request.
  - Each step edit is one transaction, with p95 under 500 ms.
  - Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:**
  - `workflow.preview_viewed` with props `stepCount` (bucket `1-3|4-6|7+`) and `needsCount` (`0|1|2+`).
  - `workflow.step_changed` with props `op` (`set_helper|remove|move`).
  - `studio.help_opened` (screen `preview`, from US-049).
  - All of these go through `emitProductEvent` (US-049, `src/lib/analytics/events.ts`), action `product_event`, with no userId (Q55). Catalogue in OBSERVABILITY.md (NZR-44).

* **Files to change:**

| path | change |
|---|---|
| `src/adapters/dashboard/handler.ts` (next to the US-049 `/workflows` routes) | Register `GET /workflows/helpers` **before** `GET /workflows/:id`. Register `POST /workflows/:id/steps/:stepId` with a 2 KB `bodyLimit`. Extend `GET /workflows/:id` to include `preview`, `needs`, `canTry` and `tryBlockedReason`. |
| `src/lib/analytics/events.ts` (US-049) | Add `workflow.preview_viewed` and `workflow.step_changed` to the allow-list with their prop enums. |
| `web/src/pages/studio/WorkflowDetail.tsx` (US-049 frame) | Render the preview body: status line, When card, `<ol>` steps, Result card, "Try it" button linking to `/workflows/:id/test`, and the needs messages. |
| `web/src/lib/studio/copy.ts` (US-049) | Add all strings from this story (status lines, sheet buttons, picker texts, change lines, errors, preview Help text). |
| `web/src/lib/studio/api.ts` (US-049) | `listHelpers()`, `changeStep(id, stepId, body)`. |
| `docs/diagrams/architecture-security.md` | Add the new `/api/workflows/helpers` and `/api/workflows/:id/steps/:stepId` routes and their gates (`handler.ts` is a mapped source in `docs/diagrams.map`). |

* **New files:**
  - `src/lib/workflows/describe.ts`: `describeDraft(def, helpersById) → {when, steps[], result, needs[]}`. Plain sentence templates per step type:
    - agent: "<Helper> <verb phrase from step.instruction>"
    - decision: "Check: <question>?"
    - approval: "<Approver> approves before anything is sent"
    - output: "You get <deliverable>"
  - `src/lib/workflows/step-edits.ts`: `applyStepEdit(def, op) → {def, changeLine} | {error}`. Pure. Ops are `set_helper`, `remove` and `move up|down`. Validates with the NZR-12 validator.
  - `src/lib/workflows/helpers.ts`: `listUsableHelpers()` wraps `listAgents()` plus `listKnownAgentsAsync()`, keeps `status==='active'`, and maps to `{id, name: displayName, goodFor: description.slice(0,140)}`.
  - `web/src/components/studio/StepList.tsx`, `StepSheet.tsx` (dialog with 5 buttons), `HelperPicker.tsx` (W-005 states), `ChangeHighlight.tsx`.
  - Tests: `src/lib/workflows/describe.test.ts`, `src/lib/workflows/step-edits.test.ts`, `src/adapters/dashboard/workflows.preview.routes.test.ts`, `tests/e2e/studio/preview.spec.ts`, and fixtures `tests/fixtures/studio/drafts/*.json` (10 synthetic drafts including the golden one, shared with US-026/US-031).
  - `web/dev/studio-fixtures.ts` (US-049): add preview and helper fixtures for the mock plugin.

* **API contract:**
  - `GET /api/workflows/:id` (US-049 contract) adds:
    `"preview":{"when":{"text":"When a new policy document is added"},"steps":[{"id":"s1","n":1,"kind":"helper|check|approval|result","what":"…","who":{"type":"helper|you|person","name":"…","helperId":"…"}|null,"approval":{"by":"You"}|null,"needs":[…]}],"result":{"text":"You get …"}},"needs":[{"stepId","kind":"choose_helper|validator","text"}],"canTry":true|false,"tryBlockedReason":"…"|null,"draftRev":<int>,"canEdit":true|false`.
  - Draft JSON is never sent raw to the browser in this story. Only described text and ids are sent, so prompt text in step instructions is shown as written, inside the sentence.
  - `GET /api/workflows/helpers`: capability `workflows:write`, person required. Returns 200 `{"helpers":[{"id","name","goodFor"}]}`, sorted by name, at most 100. Errors: 403 forbidden, 500 `{"error":"helpers_unavailable"}`.
  - `POST /api/workflows/:id/steps/:stepId`: capability `workflows:write`, owner only, body at most 2 KB.
    - Body: `{"op":"set_helper","helperId":"…","baseRev":n}` | `{"op":"remove","baseRev":n}` | `{"op":"move","dir":"up|down","baseRev":n}`.
    - 200: `{"workflow":{…same as GET…},"change":{"stepId","line":"Step 2 moved up."}}`.
    - 400: `{"error":"bad_request"}` (schema) or `{"error":"unknown_helper"}`.
    - 404: `not_found` (workflow or stepId).
    - 409: `{"error":"stale_draft","draftRev":n}`.
    - 413: `body_too_large`.
    - 422: `{"error":"invalid_change","message":"<plain validator text>"}`.
    - 503: `studio_disabled`.

* **Data changes:**
  - New `DRAFT#<rev>` items only, through the NZR-12 append transaction (META `draftRev` condition plus create-only DRAFT put), with `source:"edit"`, `author:<userId>`, `parentRev` and `editOp`.
  - META `updatedAt` is bumped in the same transaction so the US-049 list order follows edits.
  - No schema change, no migration, no backfill.

* **Security notes:**
  - Ownership plus `workflows:write` is checked server-side before any read of the draft body. A non-owner gets the same 404 as a missing id (SECURITY.md §6 floor).
  - The helper picker returns only the id, display name and a description of at most 140 characters. No system prompt, model, tokens or connection flags reach a viewer. Today's `/api/agents` exposes `systemPromptPreview` to `agents:read`, so do not reuse it.
  - `set_helper` re-checks `status==='active'` server-side. The client list is not trusted.
  - Step instructions are user or model text. They are rendered as text (Preact escapes) and never as HTML.
  - Identity comes only from `personOf(c)`.
  - "Helpers I may use" means all active helpers in the install, because no per-helper access model exists (DATA-MODEL risk 1). See NOTES-E-slice for the owner question.

* **Test plan:**
  - Frozen failing tests first (own commit, red SHA recorded):
    1. `src/lib/workflows/describe.test.ts` › "golden draft describes as 4 plain numbered steps", › "a helper-less agent step yields a choose_helper need", › "describe output never uses banned words"
    2. `src/lib/workflows/step-edits.test.ts` › "move and remove produce valid drafts and plain change lines", › "move up on step 1 and move down on the last step are rejected"
    3. `src/adapters/dashboard/workflows.preview.routes.test.ts` › Scenarios 2, 5, 6, 7(c), 8. Uses the US-049 route-test pattern: `app.request()` against `buildDashboardRouter()`, with `principalFor` mocked and `src/lib/workflows/store.js` and `src/lib/agents/registry.js` mocked. It asserts the store `appendDraftRev` call count for the "writes nothing" cases.
  - Playwright (local Vite, `CCE_STUDIO_MOCK=1`, synthetic fixtures): `tests/e2e/studio/preview.spec.ts`.
  - Commands, in order:
    1. `npx vitest run src/lib/workflows/describe.test.ts src/lib/workflows/step-edits.test.ts src/adapters/dashboard/workflows.preview.routes.test.ts scripts/ci/studio-copy.test.ts`
    2. `npm test`
    3. `npm run typecheck`
    4. `npm --prefix web run typecheck`
    5. `npm --prefix web run build`
    6. `npm run e2e:studio` (serial)
    7. `node scripts/ci/diagrams-drift.mjs`

* **Repo rules that apply:**
  - A `handler.ts` route change means updating `docs/diagrams/architecture-security.md` (`docs/diagrams.map`).
  - Add no new dependency. The dialog and focus handling are hand-written, like the existing modals.
  - Run the full `npm test` before any push.
  - Update the HANDOFF and add a dated session handoff.

* **Rollback:**
  - Runtime-config `studio/enabled=0` turns the whole slice off (US-049).
  - Revisions written by step edits are normal history and are not removed on revert. They stay readable by NZR-24 history.
  - A code revert is safe because the schema is unchanged.

* **Build slices (proposal):**
  1. **Describe** (`describe.ts`, fixtures, extend `GET /workflows/:id`). Turns green: test 1 and Scenario 1/3 API parts.
  2. **Step edits + helpers API** (`step-edits.ts`, `helpers.ts`, two routes, diagram). Turns green: tests 2 and 3.
  3. **Preview UI + sheet + picker** (StepList, StepSheet, HelperPicker, copy, mock fixtures, Playwright). Turns green: `preview.spec.ts`.

* **Agent gotchas:**
  - Hono route order: register `/workflows/helpers` before `/workflows/:id`, or "helpers" is captured as an id. The US-049 id regex `^wf_…` then turns it into a 404 that looks like a real not-found.
  - `listKnownAgentsAsync()` returns built-in ids with no status. Built-ins default to `'active'` unless a DDB row says otherwise (`handler.ts:1520`). Keep that rule in `listUsableHelpers`, or built-in helpers vanish from the picker.
  - The agent `description` can be empty for built-ins. `/api/agents` falls back to `extractDescription(id, systemPrompt)` (`handler.ts:1520`). Reuse the fallback, but trim it to 140 characters and never return the prompt itself.
  - Banned-word check: `describeDraft` must never interpolate the step `type` names ("agent", "decision"). Use the kind map `helper|check|approval|result`.
  - The SPA GET cache (60 s, `web/src/lib/api.ts:160`) is cleared on every mutation, so after a step edit the next GET is fresh. Do not add a second client cache.
  - `baseRev` is the client's view. Always compare it with META `draftRev` inside the same transaction condition, never with a prior read alone.

---

## 5. Estimation & Tracking
* **Epic Name:** M2a Core slice (cycle C2a Core vertical slice (plain Workflows tab), 2026-11-10 to 2026-11-23)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47). NOTES-E-slice proposes 8 because of the round-5 step sheet and the picker ownership.
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** ui, workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Margaret, 67; explain it back, choose a helper unaided).
- [ ] Acceptance criteria cover both happy paths and edge cases (9 scenarios: readable, choose helper, needs, move/remove, invalid change, stale, picker edges, permission, accessibility).
- [ ] UX/UI designs are attached and finalized:
  - W-004 and W-005 redone for the guided flow with step sheet, "Try it", Undo slot, 20px, Help me and iPad frame (Q101).
  - Generating, validator-error, no-helper-fits and picker-error states mocked (NO-MOCK-YET today, due Nov 9, Q77).
- [ ] Dependencies have been identified and are unblocked: NZR-23, NZR-49 and NZR-12 merged. NZR-24 is optional (controls hidden without it).
- [ ] Owner answers on Q99, Q103, Q104, Q105 and Q95 recorded (the recommended defaults are built).
- [ ] The team has reviewed and estimated the story points (5 pts, 8 proposed; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. T2:
  - Fresh Claude critic.
  - Free checks: `npm audit --omit=dev --audit-level=high`, `npm --prefix web audit --omit=dev`, `node scripts/ci/secret-scan.mjs <changed files>`, typecheck.
  - Step maid (Q68).
- [ ] Tests and gates:
  - A frozen failing test came first (red SHA recorded).
  - The gate is green on a clean checkout of the exact HEAD.
  - Full `npm test` green.
  - `npm run e2e:studio` green.
  - `node scripts/ci/diagrams-drift.mjs` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo on desktop and iPad viewport of choosing a helper and moving a step (Q51).
- [ ] Documentation is updated:
  - Feature HANDOFF plus a dated session handoff.
  - `docs/diagrams/architecture-security.md` lists the new routes.
  - Product events added to OBSERVABILITY.md (NZR-44).
  - W-004/W-005 mock PNGs replaced by real screenshots.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
