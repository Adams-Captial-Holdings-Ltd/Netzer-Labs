# [US-024] Edit-by-chat on drafts

> Backlog task NZR-24 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-020, AC-007, AC-020.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3)
* **I want** to change the draft by saying what I want
* **So that** I can fix it without learning an editor

Concretely (round 5, Q103/Q104, pending):
- She types or says a change in the "Ask" box under her routine, or taps a step → "Change what".
- Every change saves itself and shows what changed.
- One big Undo button, always visible, takes back the last change, whether it came from chat or a tap.

Benefit: every change either keeps the draft valid or is refused with the old version kept. No step ever disappears silently (AC-020).

---

## 2. Business Context & Description
* **Background:**
  - **Requirements:**
    - PRD FR-020: repair workflows conversationally.
    - AC-007: revise the workflow conversationally.
    - AC-020: no step silently disappears.
    - AC-021: unsupported constructs are kept (US-012 `unsupported` step).
    - PRD example: "Make this run every Friday instead." Netzar updates the draft and keeps the version history.
  - Q61: edit-by-chat is part of the C2a vertical slice.
  - **Round 5, pending:**
    - Q103 adds tap-to-change and estimates it at "~+3 pts on NZR-24". The v2 split puts the deterministic taps in US-025: Change who, Remove, Move up/down (US-025 Scenarios 2, 4, 5). This story owns "Change what" (the Ask box prefilled by US-025) and the chat for everything else. See NOTES on where the +3 lands.
    - Q104: autosave everything, no Save button, a big Undo always visible, nothing ever lost.
    - Q101: chat appears only as an "Ask" box.
    - Q99: plain words. Q105: 20px text, AAA contrast. Q107: "Help me".
  - **Q95 (open):** an edit cannot leave an external write without an approval before it (`EXTERNAL_WRITE_WITHOUT_APPROVAL`, US-012).
  - **Q66, Q88:** chat edits use the drafter prompt, which is repo code. Any prompt or reply-schema change re-runs the live eval (US-030). Replay tests check only the harness.
* **Current behaviour (d1d3a66):**
  - No edit, revision or undo code exists. `src/lib/workflows/` does not exist.
  - After the dependencies merge, these exist:
    - From US-014/US-023:
      - `runDrafterStep()` in `create` mode, with the reply contract (question with 2–4 options, draft, `cannot_build`, `refused`)
      - `checkDraftSafety`
      - drafter sessions (`src/lib/workflows/drafter/session.ts`)
      - the `QuestionScreen` component
      - the kill switch `workflow_drafter_disabled`
      - the audit action `workflow_draft_saved`
    - From US-012: `validateWorkflow`, `canonicalSha256`, and `appendDraftRev` in `store.ts`.
    - From US-025:
      - `GET /api/workflows/:id` with `preview` and `draftRev`
      - `POST /api/workflows/:id/steps/:stepId` (`set_helper`, `remove`, `move`; `source: "edit"`; 409 `stale_draft`; 422 `invalid_change`)
      - the step sheet with the "Change what" button
  - DATA-MODEL.md line 115: draft revisions are `WF#<wfId>/DRAFT#<rev:6>`. Each is written in one transaction that moves `META.draftRev` from `n-1` to `n` (optimistic concurrency). Each has `source chat|edit` and `parentRev`, and all revisions are kept.
  - Chat edits run through `runAgentTurn` (`src/agent/agent-loop.ts:762`) with `toolPolicy: { aiStep: true }` (`:217`, `:1091-1099`) and the spend ledger (`src/lib/cost/ledger-gate.ts:162`).
* **Target behaviour:**
  1. **Chat edit.** A request in the Ask box runs `runDrafterStep` in `edit` mode with the current draft. A valid result is saved at once as a new revision. The changed steps are highlighted, e.g. `Step 3 added: Your approval.`
  2. **Change what.** US-025's step sheet opens the Ask box prefilled with `Change step 2: ` and focused. This runs the same chat-edit path.
  3. **Code computes the diff.** `diffWorkflows` works from step ids and never trusts model text. Every removed step is listed as removed and shown, so none disappears silently.
  4. **Refusal keeps the old version.** If the result is invalid, nothing is saved and the reason shows in plain words. Invalid means: no "When this happens", an approval missing before a send, or an unsupported item dropped.
  5. **Undo.** The always-visible button, or saying "undo that", restores the content before the last change as a new revision. This covers changes from chat and from US-025 taps. Repeated Undo walks back step by step. History lists every revision and can restore any of them.
  6. **Autosave.** There is no Save button. `Saved` shows after every change. Two windows never overwrite each other silently: 409 `stale_draft`, as in US-025.
* **Out of scope:**
  - Creating drafts, the question flow and the cards → US-023.
  - The preview, the step sheet, Change who, Remove and Move → US-025. This story adds the Ask box, the Undo header, the History drawer and the change lines for chat edits.
  - Test runs and the Ready flag → US-026. A new revision changes `draftRev`, and US-049's label logic shows "Test again".
  - Redo. To undo an Undo, restore it from History.
  - Lessons from corrections → NZR-29. Live edit cases in the eval dataset → a later re-baseline (NOTES).
* **Target Value:**
  - 100% of edit outcomes are either a new revision that passes the validator, or a refusal with `draftRev` unchanged.
  - This is measured by `src/lib/workflows/edits.test.ts` over the 12 synthetic edit fixtures, plus the property test "every base step is present or reported removed".
  - Q109 tracking (pending): at least 2 of 5 testers aged 60+ finish "add my approval before it's sent" without tapping Help.
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). Design target "Margaret, 67" (Q98, PENDING OWNER). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Edit applied by chat
* **Given** a valid draft at `draftRev` 2 with these steps:
  - `write_report`: agent, "Write the weekly report"
  - `lead_check`: approval, "Team lead checks it"
  - `send_report`: output, `email`, "Send the report to the team"
* **When** she types `add my approval before sending the report` in the Ask box, which sends `POST /api/workflows/:id/edits` `{ "baseRev": 2, "request": "add my approval before sending the report" }`
* **Then** the API returns `202 { editId, status: "thinking" }`
* **And** polling `GET /api/workflows/:id/edits/:editId` returns `{ status: "applied", draftRev: 3, changes: [{ kind: "added", stepId: "<new id>", position: 3, title: "Your approval" }] }`
* **And** rev 3 has the new approval step directly before `send_report`, and it passes `validateWorkflow(…, 'draft', agents)` and `checkDraftSafety`
* **And** rev 3 is saved with `source: "chat"`, `parentRev: 2` and `undoTo: 2`, and `META.draftRev` is 3
* **And** the preview marks the new step `New` and shows the line `Step 3 added: Your approval.` The header shows `Saved`.
* **And** these records are written:
  - `workflow_draft_saved` via `writeAuditOrThrow`, with `{ workflowId, draftRev: 3, sha256, source: "chat" }`
  - product event `workflow.edit_applied`, with `via: "chat"`, `added: 1`, `removed: 0`, `changed: 0`, `moved: 0`
* **Test:** `src/adapters/dashboard/workflows.edits.routes.test.ts` › "chat edit applies, saves rev 3 with undoTo 2, returns code-computed changes"
* **Test:** `tests/e2e/studio/edit.spec.ts` › "Ask box edit highlights 'Step 3 added' and shows Saved, no Save button"

### Scenario 2: Edit would break it
* **Given** a valid draft at rev 3
* **When** the request is `remove the start, I'll run it myself`, and the drafter returns a workflow with no trigger
* **Then** polling returns `{ status: "refused", refused: { code: "TRIGGER_MISSING", message: "I can't make that change. <validator message> Your routine hasn't changed." } }`
* **And** `META.draftRev` is still 3, `DRAFT#000004` does not exist, and product event `workflow.edit_refused` is written (`via: "chat"`, `code: "TRIGGER_MISSING"`)
* **And** the same kind of refusal, with the validator's plain message, happens for:
  - `EXTERNAL_WRITE_WITHOUT_APPROVAL` (Q95)
  - `UNSUPPORTED_DROPPED`: rev 3 has an `unsupported` step that is missing from the result (AC-021). This check lives in `edits.ts`, not in the validator.
* **Test:** `src/adapters/dashboard/workflows.edits.routes.test.ts` › "refuses a trigger-less result and keeps rev 3" and › "refuses when an unsupported step is dropped"

### Scenario 3: Undo, by button or by saying it
* **Given** these revisions:
  - rev 1: created by US-023, `undoTo: null`
  - rev 2: US-025 tap Remove, `source: "edit"`, `parentRev: 1`, no `undoTo`
  - rev 3: chat edit, `undoTo: 2`
* **When** the user taps `Undo`, which sends `POST /api/workflows/:id/undo` `{ "baseRev": 3 }`
* **Then** the API returns `200 { draftRev: 4, restoredFromRev: 2, changes: [...] }`. Rev 4 has the content of rev 2, with `source: "undo"` and `undoTo: 1`, because rev 2 has no `undoTo` and `parentRev` is used instead.
* **And** a second Undo gives rev 5 with the content of rev 1 and `undoTo: null`
* **And** a third Undo returns `409 { error: "nothing_to_undo", message: "Nothing to undo." }`. The button shows as disabled with `Nothing to undo yet`.
* **And** sending `undo that` to the edits route performs the same undo with **no** `runDrafterStep` call. The phrases `undo`, `undo it` and `go back` also count, in any case, with an optional final `.` or `!`.
* **And** `GET /api/workflows/:id/revisions` lists all revisions newest first, each with `{ rev, source, createdAt, summary, isCurrent }`
* **And** `POST /api/workflows/:id/restore` `{ baseRev, rev: 3 }` creates a new revision with rev 3's content (`source: "restore"`)
* **Test:** `src/lib/workflows/edits.test.ts` › "undo walks undoTo back (parentRev for legacy rows) and stops at null"
* **Test:** `src/adapters/dashboard/workflows.edits.routes.test.ts` › "'undo that' undoes without a model call" and › "restore creates a new revision"
* **Test:** `tests/e2e/studio/edit.spec.ts` › "Undo after a tap Remove brings the step back"

### Scenario 4: Change what, from the step sheet
* **Given** the US-025 step sheet is open on step 2 `lead_check`
* **When** she taps `Change what`
* **Then** the Ask box gets focus, holds `Change step 2: ` and has the cursor at the end
* **And** she adds `the office manager checks it instead` and taps `Change it`. The request runs the Scenario 1 path, and the result changes only `lead_check`, with `changes: [{ kind: "changed", stepId: "lead_check", position: 2, … }]`.
* **And** if the drafter replies with a question, the routine page shows the US-023 `QuestionScreen` inline, with 2–4 big buttons and `Something else`. At most 1 question is asked per edit.
* **Test:** `tests/e2e/studio/edit.spec.ts` › "Change what prefills the Ask box and highlights the changed step"
* **Test:** `src/adapters/dashboard/workflows.edits.routes.test.ts` › "an edit may ask one question; a second question ends refused"

### Scenario 5: No step silently disappears (AC-020)
* **Given** a draft with steps `a`, `b` and `c`, and the request `make it run every Friday instead`
* **When** the drafter's result changes the schedule but also drops step `b`
* **Then** the edit is saved, and `changes` holds both `{ kind: "trigger_changed" }` **and** `{ kind: "removed", stepId: "b", title: "<b label>", position: 2 }`
* **And** the preview shows the removed step as a struck-through card labelled `Removed`. The line `Step 2 removed: <label>.` shows next to the Undo button until the next change.
* **And** for every fixture pair (base, result), every base step id is either in the result or listed as `removed`. This property test runs over the 12 edit fixtures plus 200 generated pairs.
* **Test:** `src/lib/workflows/diff.test.ts` › "every base step is present or reported removed"
* **Test:** `src/adapters/dashboard/workflows.edits.routes.test.ts` › "a model-dropped step is reported and shown, never silent"

### Scenario 6: Permission and ownership
* **Given** three cases:
  - (a) a principal without `workflows:write`
  - (b) user B on user A's routine
  - (c) a principal with no person id
* **When** they call any of the edits, undo, revisions or restore routes
* **Then** (a) gets `403 { error: "forbidden", requiredCapability: "workflows:write" }` (`workflows:read` for the GET routes), (b) gets `404 { error: "not_found" }`, and (c) gets `403 { error: "person_required" }`
* **And** no store write, no `runDrafterStep` call and no `workflow_draft_saved` audit happened
* **Test:** `src/adapters/dashboard/workflows.edits.authz.test.ts` › "403/404/403 on every edit route; no model, store or audit call"

### Scenario 7: Two windows, late results, double taps
* **Given** the routine is at rev 6, and a request carries `baseRev: 5`
* **When** a chat edit, undo or restore arrives
* **Then** the API returns `409 { error: "stale_draft", draftRev: 6 }`, the same body as US-025. The UI reloads and shows `This routine changed somewhere else. We loaded the newest version.`
* **And** two Undo taps with `baseRev: 6` produce exactly one rev 7. The second tap gets the 409, enforced by the store transaction condition `draftRev = :base`.
* **And** a chat edit whose result arrives after another change has moved the head is not saved. Its status is `refused` with `code: "stale_draft"` and the same message.
* **Test:** `src/adapters/dashboard/workflows.edits.routes.test.ts` › "stale baseRev → 409 stale_draft; double undo saves once; late chat edit not saved"

### Scenario 8: Degraded: model down or drafter paused
* **Given** (a) `runDrafterStep` returns `unavailable` with cause `model_error` or `timeout`, or (b) the kill switch `workflow_drafter_disabled` is on
* **When** the user (a) sends a chat edit, or (b) sends a chat edit and then taps `Undo`
* **Then** in (a), polling returns `{ status: "failed", failed: { message: "I can't reach the routine builder right now. Your routine hasn't changed. Please try again in a minute.", retryable: true } }`, and `draftRev` is unchanged
* **And** in (b), the chat edit returns `503 { error: "drafter_disabled", message: "Changing routines by chat is paused right now. You can still tap a step to change it." }`. Undo, restore and US-025's taps still succeed, because they need no model.
* **Test:** `src/adapters/dashboard/workflows.edits.routes.test.ts` › "model down → failed, unchanged" and › "kill switch blocks chat edits only; undo and restore still work"

---

## 4. Technical Notes & Constraints
* **Dependencies:**
  - [NZR-23 / US-023](US-023-workflow-drafter-describe-draft-or-clarifying-question.md) Workflow drafter: describe -> draft or clarifying question.
  - Also uses NZR-12's validator and store, through NZR-23.
  - Also uses NZR-25's preview, step sheet and step route. NZR-25 lists NZR-24 as a soft dependency; see NOTES for the order.
* **UI/UX Design:** design.md Workflows slice gallery (MOCK, desktop only (Q108), light) (W-006, W-007). See [design.md](../foundation/design.md).
  - Current mocks: [W-006 edit by chat](../../../assets/netzar-studio/mock/W-006-edit-by-chat-desktop.png), [W-007 history](../../../assets/netzar-studio/mock/W-007-history-desktop.png).
  - **PENDING OWNER Q101:** chat is an "Ask" box under the steps, not a scrolling transcript. The box has:
    - one line of text, plus a mic if NZR-18 is merged
    - a `Change it` button
    - an outcome line for the last edit only

    The W-006 mock shows a transcript (NO-MOCK-YET for the Ask box). Mock it before PLANNING (Q77) at iPad 1024×768 and desktop 1440×900 (Q108).
  - **PENDING OWNER Q104:**
    - No Save button.
    - `Saved` with a check after each change.
    - `Undo` fixed in the routine header and always visible. At the first revision it is disabled and shows `Nothing to undo yet`.
    - History opens as a drawer (W-007) from a `History` link next to Undo.
  - **PENDING OWNER Q103:** "Change what" is a button in US-025's step sheet that opens this Ask box. If the owner picks "Edit by chat only", US-025 drops the sheet. This story is unchanged, except that Scenario 4 starts from the Ask box.
  - **PENDING OWNER Q105/Q107/Q99:**
    - 20px text, AAA contrast, 200% zoom.
    - Words "routine", "helper", "When this happens".
    - Help text for the Ask box, in `copy.ts`: `Tell me what to change, in your own words, like "add my approval before it's sent". I'll change it and show you what's different. Made a mistake? Tap Undo.`
  - Highlights follow US-025: a change line plus a 3 s highlight on the changed card. Removed steps stay visible as a struck-through card until the next change, so AC-020 holds even after the highlight fades.
* **Non-Functional Requirements:**
  - AC-020: no step silently disappears.
  - Undo and restore are synchronous and need no model: p95 ≤ 1 s (one conditional transaction).
  - Chat edits share the drafter budget: ack ≤ 3 s (202), result ≤ 45 s p95 (NFR-003), and at most 1 clarifying question per edit.
  - Limits, from US-012 and [CONSTRAINTS.md](../foundation/CONSTRAINTS.md):
    - Workflow JSON ≤ 64 KB and ≤ 30 steps (`TOO_BIG`).
    - ≤ 200 revisions per routine (DATA-MODEL line 115, TARGET). The 201st save returns `409 { error: "history_full", message: "This routine has too many saved versions. Ask your administrator to tidy it up." }` until pruning exists. UNVERIFIED: whether the NZR-12 store enforces this cap.
* **Data & Analytics:** `workflow.edit_applied`, `workflow.edit_refused`. They are written to the existing audit log as a separate product event type with no personal data (Q55), with the catalogue in OBSERVABILITY.md (NZR-44).
  - Writer: `emitProductEvent` (US-049). Allow-list props:
    - `edit_applied`: `workflowId`, `draftRev: int`, `via: enum[chat,undo,restore]`, `added`, `removed`, `changed`, `moved` (all `int`), `questions: int`
    - `edit_refused`: `workflowId`, `via: enum[chat,undo,restore]`, `code: enum[validator codes, UNSUPPORTED_DROPPED, stale_draft, question_limit]`
  - Undo and restore go in `via`, so NZR-44's list keeps the two backlog names. US-025's taps emit `workflow.step_changed`.
  - Never logged: request text, step labels, answers.

#### Edit mode for the drafter (extends US-014's contract)
- `DrafterStepInput.mode: 'edit'` adds these fields: `baseWorkflow: WorkflowDefinition`, `baseRev: number`, `editRequest: string` (≤ 1000), and `answers` (≤ 1).
- `DrafterReply` adds `{ kind: 'edit'; workflow: unknown; summary: string; needsPermission: { stepId: string; tool: string }[] }`. The kinds `question`, `refused` and `cannot_build` work as in create mode. A `draft` reply in edit mode is treated as `edit`. The server never shows `summary`.
- The prompt tells the model to keep the ids of unchanged steps and make the smallest change. The server still never trusts ids:
  - `diffWorkflows` matches steps by `id`.
  - A new step whose id clashes with a base id that was removed is renamed `<id>_2`.
  - Any base id missing from the result is reported as `removed`.
- `baseWorkflow` goes into the prompt as JSON inside a delimiter. Every string gets the same `‹ ›` neutralization (`agent-loop.ts:450`), because step labels may carry earlier user text (SECURITY.md §4 item 4).
- Changing `prompt.ts`, `reply-schema.ts` or `draft-turn.ts` changes the drafter hash, so it needs a live eval run and a committed result (US-014/US-030).

#### Pure functions (new, in `src/lib/workflows/`)
```ts
// diff.ts
export type Change =
  | { kind: 'added' | 'removed' | 'changed'; stepId: string; title: string; position: number }   // 1-based
  | { kind: 'moved'; stepId: string; title: string; from: number; to: number }
  | { kind: 'trigger_changed' };
export function diffWorkflows(base: WorkflowDefinition, next: WorkflowDefinition): Change[];
export function droppedUnsupported(base: WorkflowDefinition, next: WorkflowDefinition): string[]; // step ids
export function changeLine(c: Change): string;   // "Step 3 added: Your approval." — same style as US-025's lines
// edits.ts
export function undoTarget(head: DraftRevMeta, load: (rev: number) => Promise<DraftRevMeta>):
  Promise<{ contentRev: number; undoTo: number | null } | null>;
export function isUndoRequest(text: string): boolean;   // /^\s*(undo( that| it)?|go back)\s*[.!]?\s*$/i
```
**Undo rule:**
- Every revision has an effective `undoTo`, which is `undoTo ?? parentRev ?? null`. Rows without `undoTo` are US-023 rev 1 and US-025 taps.
- An edit, tap or restore that makes rev R from base B gets `undoTo = B`.
- Undo from head H creates a new revision with the content of `H.undoTo` and `undoTo = effectiveUndoTo(rev(H.undoTo))`.
- If `H.undoTo` is `null`, the result is `nothing_to_undo`.

* **Files to change:**

| path | change |
|---|---|
| `src/lib/workflows/drafter/draft-turn.ts` (US-014) | `mode: 'edit'` input, and result `{ kind: 'edit', workflow, sha256, changes, needsPermission, warnings, turn }` |
| `src/lib/workflows/drafter/reply-schema.ts` (US-014) | add `kind: 'edit'` |
| `src/lib/workflows/drafter/prompt.ts` (US-014) | edit instructions: keep ids, smallest change, ask ≤ 1 question, keep `unsupported` steps |
| `src/lib/workflows/drafter/session.ts` (US-023) | generalize the state machine to `kind: 'create' \| 'edit'` (reuse, don't copy) |
| `src/lib/workflows/store.ts` (US-012) | `appendDraftRev` stores `undoTo`, `restoredFromRev` and `changes` (optional, additive); `listDraftRevs(workflowId, { limit: 200 })` |
| `src/adapters/dashboard/handler.ts` near `:4159` | call `registerWorkflowEditRoutes(router, { hasCapability, personOf })` |
| `src/lib/analytics/events.ts` (US-049) | allow-list `workflow.edit_applied` and `workflow.edit_refused` |
| `web/src/pages/studio/WorkflowDetail.tsx` (US-049 frame, US-025 body) | mount the Ask box, the Undo and Saved header, and the History drawer |
| `web/src/components/studio/StepSheet.tsx` (US-025) | wire "Change what" to `askBox.prefill('Change step N: ')` |
| `web/src/lib/studio/copy.ts`, `web/src/lib/studio/api.ts`, `web/dev/mock-studio-plugin.ts` (US-049) | strings; `startEdit`, `getEdit`, `answerEdit`, `undo`, `listRevisions`, `restore`; mocks |
| `docs/diagrams/architecture-security.md` | new routes (`handler.ts` is mapped at `docs/diagrams.map:35-45`) |
| `evals/drafter/results/current.json`, `evals/drafter/baseline.json` | a new live result after the prompt change (US-030 procedure) |

* **New files:**
  - `src/lib/workflows/diff.ts`, `src/lib/workflows/edits.ts`, plus their tests
  - `tests/fixtures/studio/edits/*.json`: 12 synthetic base/request/result triples, next to US-025's `tests/fixtures/studio/drafts/`
  - `src/adapters/dashboard/workflows.edits.ts`, plus `.routes.test.ts` and `.authz.test.ts`
  - `web/src/components/studio/{AskBox,UndoBar,HistoryDrawer,RemovedStepCard}.tsx`
  - `tests/e2e/studio/edit.spec.ts`
* **API contract:**
  - All routes are under `/api`, behind the auth middleware and US-049's carve-out.
  - Identity comes from `personOf(c)`.
  - Every route checks the capability and ownership (`META.ownerUserId === personOf(c)`, else 404).
  - Bodies are zod `.strict()` with a 16 KB `bodyLimit`.
  - `studio/enabled=0` returns 503 `studio_disabled`.

| method + path | capability | request | 2xx | errors |
|---|---|---|---|---|
| `POST /workflows/:id/edits` | `workflows:write` | `{ baseRev: int ≥ 1, request: string(1..1000), source?: 'text' \| 'voice' }` | `202 { editId, status: 'thinking' }`; an undo phrase returns `200` with the undo body | 400, 403, 404, 409 `stale_draft` / `already_thinking`, 413, 503 `drafter_disabled` |
| `GET /workflows/:id/edits/:editId` | `workflows:read` | — | `200 { editId, status: 'thinking'\|'question'\|'applied'\|'refused'\|'failed', draftRev?, changes?: Change[], question?: { text, why, options }, refused?: { message, code }, failed?: { message, retryable } }` | 403, 404 |
| `POST /workflows/:id/edits/:editId/answers` | `workflows:write` | `{ optionIndex: 0..3 } \| { text: string(1..500) }` | `202 { status: 'thinking' }` | 400, 403, 404, 409 `not_waiting_for_answer` |
| `POST /workflows/:id/undo` | `workflows:write` | `{ baseRev }` | `200 { draftRev, restoredFromRev, changes }` | 403, 404, 409 `stale_draft` / `nothing_to_undo` / `history_full` |
| `GET /workflows/:id/revisions` | `workflows:read` | — | `200 { revisions: [{ rev, source, createdAt, summary, isCurrent }] }` (≤ 200, newest first) | 403, 404 |
| `POST /workflows/:id/restore` | `workflows:write` | `{ baseRev, rev }` | `200 { draftRev, restoredFromRev, changes }` | 403, 404 (`rev_not_found`), 409 `stale_draft` / `history_full` |

  - Code builds `summary` from `Change[]` with `changeLine`, e.g. `Step 3 added: Your approval.`. It never comes from model text.
  - Revisions from before this story have no `changes`. For those, `summary` is computed on read by diffing against `parentRev`.
  - Route order: register `/workflows/:id/edits*`, `/undo`, `/revisions` and `/restore` before any catch-all `/workflows/:id/*`.

* **Data changes:** expand-only, in the same studio table.
  - `DRAFT#<rev:6>` rows:
    - new `source` values `undo` and `restore`. DATA-MODEL lists only `chat|edit`, but the field is a string, so this is additive.
    - new optional fields `undoTo: number | null`, `restoredFromRev?: number` and `changes: Change[]` (≤ 50 entries).
  - New item `WF#<wfId>/EDIT#<editId>`. Status moves are conditional, as in US-023's session item. Fields:
    - `ownerUserId`, `status`, `baseRev`
    - `request` (≤ 1000 chars), `question?`, `answer?`
    - `resultRev?`, `code?`, `turnIds[]`, `costUsd`
    - `startedAt`, `updatedAt`, `ttl` (now + 30 days)
  - Legacy rule, unit-tested: a missing `undoTo` reads as `parentRev ?? null`.
  - Rollback: EDIT items expire by TTL. Revisions are kept, because history is the safety net.
* **Security notes:**
  - SECURITY.md §4 risks d and e:
    - d is smuggling a step, an outside target or a missing approval. Every edit result goes through `validateWorkflow` (Q95 rule) and `checkDraftSafety` (connection-only targets, no emails or URLs).
    - e is a preview that differs from the JSON. Highlights come from `diffWorkflows`, not from the model's `summary`.
  - §2b T1 E/D: chat edits run as the drafter, with the AI step, the read-only allowlist, the guardrail on and `isolatedContext`. Undo and restore run no model.
  - **PENDING OWNER Q95:** recommended yes, so edits that leave an external write without an approval before it are refused (Scenario 2). If the owner picks "only warn":
    - Those edits are saved, with the validator warning shown on the step.
    - The Scenario 2 `EXTERNAL_WRITE_WITHOUT_APPROVAL` case becomes a warning test.
  - Ownership is checked on every route, and identity comes from the session only.
  - Every new revision writes `workflow_draft_saved` (`writeAuditOrThrow`), with ids and hashes only (ADR 0020).
  - User text in requests is stored only in the EDIT item, never in audit rows, events or logs.
* **Test plan:**
  - Frozen failing tests first, in their own commit:
    - `src/lib/workflows/diff.test.ts` (Scenario 5 property test)
    - `src/lib/workflows/edits.test.ts` (Scenario 3 undo chain, `isUndoRequest`, legacy `undoTo`)
    - `src/adapters/dashboard/workflows.edits.routes.test.ts` (Scenarios 1–5, 7, 8). It uses the US-049 route-test pattern, with a fake drafter and the store mocked.
    - `src/adapters/dashboard/workflows.edits.authz.test.ts` (Scenario 6)
  - Fixtures: 12 synthetic edit triples in `tests/fixtures/studio/edits/`, with no personal data. They cover:
    1. add approval
    2. change schedule
    3. change what a step does
    4. remove a step
    5. model drops a step
    6. remove the trigger
    7. approval moved after the send
    8. unsupported step dropped
    9. outside email address
    10. rename only
    11. two edits in one request
    12. undo phrase
  - E2E (`CCE_STUDIO_MOCK=1`, serial): `tests/e2e/studio/edit.spec.ts` covers:
    - the Ask box edit
    - Change what prefill
    - Undo after a tap
    - History restore
    - the stale reload message
    - axe with 0 serious or critical issues
    - 200% zoom at 1024×768
  - Replay (US-011) tests the harness only. The live eval runs on the VPS after the prompt change.
  - Commands:
    - `npx vitest run src/lib/workflows src/adapters/dashboard/workflows.edits.routes.test.ts src/adapters/dashboard/workflows.edits.authz.test.ts`
    - `npx playwright test --config tests/e2e/studio/playwright.config.ts`
    - `npx tsx scripts/ci/drafter-eval-gate.ts`
    - `node scripts/ci/diagrams-drift.mjs`
    - full `npm test`
    - `npm --prefix web run typecheck`
* **Repo rules that apply:**
  - A `handler.ts` route change needs a diagram update (CONTRIBUTING.md:51-52).
  - Use `writeAuditOrThrow` for revisions. Product events go only through `emitProductEvent`.
  - No new dependency. Preact and Tailwind 3 (Q97).
  - No new nav route: the drawer and the Ask box are in-page.
  - A drafter prompt change needs a live eval run and a committed result (US-030).
  - All copy goes in `copy.ts`, and the banned-word test stays green (Q99, pending).
* **Rollback:**
  - `workflow_drafter_disabled` stops chat edits at once. Undo, restore and US-025 taps keep working.
  - A code revert removes the routes. Revisions stay as data, and older readers ignore the new fields.
* **Build slices (proposal):**
  1. **Pure core** (1 h): `diff.ts`, `edits.ts` (undo chain, phrase, legacy rule) and fixtures. Green: `diff.test.ts`, `edits.test.ts`.
  2. **Undo, restore and history routes** (1–2 h): synchronous routes, store fields and audit. Green: Scenarios 3, 6, 7 (undo part) and 8b.
  3. **Chat edit** (2 h): drafter edit mode, generalized sessions, refusal mapping, the prompt update, a live eval run. Green: Scenarios 1, 2, 4 (API), 5, 7 (late result) and 8a, plus the US-030 gate on the new result.
  4. **UI** (2 h): Ask box, Change what wiring, Undo and Saved header, History drawer, removed-step card. Green: `edit.spec.ts` and axe.
* **Agent gotchas:**
  - Never trust step ids or the change summary from the model. If the model renumbered every step, trusting it would show "everything changed" or hide a removal.
  - Undo is a **new** revision. Never delete or overwrite one. Revisions are create-only (`attribute_not_exists`).
  - `draftRev` moves only through the conditional transaction (`draftRev = :base`). Check it at save time, not only at request time: a chat edit takes up to 45 s, and the head can move in the meantime (Scenario 7).
  - The kill switch must not block undo and restore. They are the user's safety net when the model is off.
  - Keep `isUndoRequest` narrow. "undo the email step" is a real edit, not an undo.
  - US-025's taps write `source: "edit"` without `undoTo`. Use the legacy rule; do not ask US-025 to change.
  - The diff must count `unsupported` steps (AC-021). Dropping one is a refusal, not a "removed" change.

---

## 5. Estimation & Tracking
* **Epic Name:** M2a Core slice (cycle C2a Core vertical slice (plain Workflows tab), 2026-11-10 to 2026-11-23)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Margaret, Q98 pending).
- [ ] Acceptance criteria cover both happy paths and edge cases: chat edit, refusal, undo/history, Change what, AC-020 removal, authz, concurrency, degraded.
- [ ] UX/UI designs are attached and finalized: design.md Workflows slice gallery (MOCK, desktop only (Q108), light) (W-006, W-007) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77). If Q101/Q104 are accepted, also: the Ask box, the always-visible Undo, the removed-step card, at iPad and desktop.
- [ ] Dependencies have been identified and are unblocked:
  - NZR-23 merged, with the session pattern, `QuestionScreen` and `workflow_draft_saved`
  - NZR-12 store with the optional `undoTo`/`changes` fields
  - NZR-25 step sheet and step route
  - Q95 answered
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71; see NOTES for 8).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (npm audit, secret scan on the diff, lint) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded). The gate is green on a clean checkout of the exact HEAD: the vitest files above, `tests/e2e/studio/edit.spec.ts`, and `npx tsx scripts/ci/drafter-eval-gate.ts` with the new live result. Full `npm test` is green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51) on iPad width:
  - "add my approval before sending" by chat
  - Change what on a step
  - Undo after a tap Remove
  - a refused "remove the start"
- [ ] Documentation is updated: feature HANDOFF plus a dated session handoff. Durable facts are promoted to README/ADR: the undo rule and the `source` values.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
