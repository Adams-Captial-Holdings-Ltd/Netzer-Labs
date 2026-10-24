# [US-029] Lessons from corrections -> proposed knowledge

> Backlog task NZR-29 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-027.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** my corrections to become proposed lessons
* **So that** the drafter improves with approval

---

## 2. Business Context & Description
* **Background:**
  - Eval flywheel (ARCHITECTURE D5: "lessons need approval"); PRD FR-027 (published workflows run continuous regression tests). Blueprint "Teach the company": corrections become proposed lessons an admin approves (blueprint.md:96).
  - **Cut 3rd if late** (Q72: NZR-39, NZR-37, then NZR-29). Could Have. If cut, nothing else depends on it.
  - SECURITY §4 risk (h): lessons are a way to plant lasting instructions. So: opt-in, proposed only, approved by someone else, shown to the drafter only as neutralized data through the playbook path, never as system-prompt instructions (SECURITY §4 item 9).
  - Data rule: customer-derived lessons and eval cases never leave the install and never enter the repo (DATA-MODEL §5, risk 11). Pilot: eval opt-in stays off (SECURITY §5 item 13).
  - Terms. **Correction**: an edit the user applies to a drafter-made draft (edit-by-chat or tap-to-change, NZR-24). **Lesson**: a short, scrubbed sentence describing that correction, waiting for approval. **Eval case**: a stored test "for this description, the draft must have X", kept inside the install. **Opt-in**: an install-level switch, off by default.
* **Current behaviour (d1d3a66):**
  - No lesson, eval-case or draft entity exists (DATA-MODEL summary item 1). Drafts, edit revisions (`source chat|edit`, `parentRev`) and the edit flow are TARGET in NZR-12/23/24 (DATA-MODEL §3 "WorkflowDraft revision"; ARCHITECTURE §4 `store.saveRevision(draft)`).
  - A pattern-based PII scrubber exists: `redactPiiUnconditional` (`src/lib/pii/redact.ts:85`) with email, SSN, card, phone, AWS key, 40-char secret, JWT and IPv4 patterns (`:13-22`). It does not detect names.
  - Runtime-config flags are read with `getConfig(ns, key)` (e.g. `src/agent/memory-ingest.ts:110`); config writes are admin-gated (`src/adapters/dashboard/handler.ts:2939-2985` comments).
  - Playbooks (NZR-27) are the only path by which approved company guidance reaches the drafter (`findPlaybooksForDraft`, neutralized `<company_playbooks>` block).
* **Target behaviour:**
  - With `studio/lessons_opt_in = "1"` (admin sets it; default off), each **structural** correction (a step added, removed or moved, or an approver changed) on a drafter-made draft creates one `proposed` lesson and one `proposed` in-install eval case.
  - The lesson text is scrubbed before it is stored; the change summary is built by code from the two validated draft JSONs, never by the model.
  - Proposed lessons and eval cases change nothing: the drafter input is byte-identical with or without them.
  - A user with `playbooks:write` who is **not** the correction's author approves a lesson into a chosen playbook (a new playbook revision) and the eval case becomes `active`; or rejects it (text deleted, tombstone kept).
  - Opt-in off ⇒ no lesson, no eval case, no extra storage of correction text.
  - Spam guard: duplicates (same draft + same change) are merged; at most 20 proposed lessons per author per day.
* **Out of scope:**
  - Running in-install eval cases (an in-account eval runner) → later; the CI scorer reads repo cases only (DATA-MODEL §3 EvalCase).
  - Lessons targeting Company facts (DATA-MODEL lists `fact` as a target) → not in MVP; only `playbook` and `eval`.
  - Using a model to generalise a lesson ("always add a second reviewer") → not in MVP; the lesson is the user's own words + the code-built summary.
  - Exporting lessons or eval cases out of the install, ever (DATA-MODEL §5).
* **Target Value:** With opt-in on, 100% of structural corrections in tests yield exactly one proposed lesson + one proposed eval case; 0 lessons change drafter input before approval (Scenario 2 byte-compare). In tester sessions (opt-in on, synthetic data only): count of `lesson.proposed` events vs `workflow.edit_applied` events, reported in the NZR-32 summary.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Proposed
* **Given** `studio/lessons_opt_in = "1"`, a drafter-made draft (rev 1) for "Review new policies and send a summary", and user U (person `u1`)
* **When** U applies the edit "add Maria's approval before sending, her email is maria@example.com" and NZR-24 saves rev 2 (`source: 'edit'`, `parentRev: 1`) with a new approval step before the output step
* **Then** the studio table holds `LESSON#<id>` / `META` with `status: 'proposed'`, `correctionText: "add Maria's approval before sending, her email is [email]"`, `changeSummary: "Added an approval step before \"Send summary\""`, `changes: [{ kind: 'step_added', stepType: 'approval', beforeStepType: 'output' }]`, `draftRef: { workflowId, fromRev: 1, toRev: 2 }`, `authorUserId: 'u1'`, `textHash`, `ttl` = now + 90 days, `GSI1PK: 'LESSONQ#proposed'`
* **And** `EVAL#<id>` / `META` with `status: 'proposed'`, `source: { lessonId }`, `description: "Review new policies and send a summary"` (scrubbed), `assertions: [{ kind: 'step_before', stepType: 'approval', beforeStepType: 'output' }]`
* **And** audit `lesson_proposed` `{ lessonId, evalCaseId, textHash, changeKinds: ['step_added'] }` (no text)
* **Test:** `src/lib/studio/lessons.test.ts` › "a structural correction proposes one scrubbed lesson and one eval case"
* **Test:** `src/lib/workflows/draft-diff.test.ts` › "describes added, removed and moved steps and approver changes in plain words"

### Scenario 2: Not auto-applied
* **Given** 3 proposed lessons, none approved
* **When** the drafter runs for "Review new policies and send a summary"
* **Then** the drafter's model input (system prompt + user text) is byte-identical to the input with an empty lessons table, and no lesson text appears in any `<company_playbooks>` block
* **Test:** `src/lib/workflows/drafter.lessons.test.ts` › "proposed lessons never change drafter input"

### Scenario 3: Opt-in off, and non-structural edits
* **Given** `studio/lessons_opt_in` unset or `"0"`; or opt-in on and an edit that only renames a step label
* **When** the edit is saved
* **Then** no `LESSON#` or `EVAL#` item is written, no `lesson_proposed` audit row exists, and the edit save itself succeeds unchanged
* **Test:** `src/lib/studio/lessons.test.ts` › "creates nothing when opt-in is off or the edit is not structural"

### Scenario 4: Approve into a playbook
* **Given** proposed lesson `l1` by `u1` and active playbook `p1` at `rev: 4`
* **When** reviewer R (`playbooks:write`, person `u2`) calls `POST /api/lessons/l1/decision` with `{ decision: 'approve', textHash, playbookId: 'p1', baseRev: 4 }`
* **Then** `200 { id: 'l1', status: 'approved', playbookRev: 5, evalCaseStatus: 'active' }`; playbook `p1` rev 5 body = rev 4 body + `"\n\n## Lesson (approved YYYY-MM-DD)\n"` + `changeSummary` + `"\n"` + `correctionText`, written with the NZR-27 `updatePlaybook` transaction; the lesson has no `ttl`; `EVAL#` status `active`
* **And** the next drafter run that matches `p1` contains the lesson text inside the neutralized `<company_playbooks>` block, and audit `lesson_decided` `{ lessonId, decision: 'approve', playbookId, playbookRev: 5, textHash }` via `writeAuditOrThrow`
* **Test:** `src/adapters/dashboard/lessons.routes.test.ts` › "approve appends the lesson as a new playbook revision and activates the eval case"

### Scenario 5: Permission, self-approval, stale playbook
* **Given** proposed lesson `l1` by `u1`
* **When** a viewer calls `GET /api/lessons` or the decision route; or `u1` (who holds `playbooks:write`) approves their own lesson; or R approves with `baseRev: 3` while `p1` is at rev 4
* **Then** respectively `403 { error: 'forbidden', requiredCapability: 'playbooks:write' }`; `403 { error: 'cannot_approve_own_lesson' }`; `409 { error: 'playbook_changed', currentRev: 4 }` with the lesson still `proposed`
* **Test:** `src/adapters/dashboard/lessons.routes.test.ts` › "refuses viewers, self-approval and stale playbook revisions"
* **Test:** `src/adapters/dashboard/authz-matrix.test.ts` › rows for the 2 lesson routes

### Scenario 6: Reject
* **Given** proposed lesson `l1`
* **When** R rejects it with `{ decision: 'reject', textHash, reason: 'One-off change' }`
* **Then** `200 { id: 'l1', status: 'rejected' }`; `correctionText` and `changeSummary` are removed from the item, `ttl` = now + 365 days; the linked `EVAL#` item is deleted; audit `lesson_decided` `{ decision: 'reject', reasonLength }`
* **Test:** `src/adapters/dashboard/lessons.routes.test.ts` › "reject removes the text and the eval case"

### Scenario 7: Duplicates, rate limit, store down
* **Given** opt-in on
* **When** the same structural change on the same draft is saved twice (undo + redo), or author `u1` already has 20 proposed lessons today, or the studio table write fails
* **Then** respectively: one lesson with `seenCount: 2` (key `LESSONKEY#sha256(workflowId + changes)`); no new lesson and a `lesson_rate_limited` log line; the edit save still returns success and a warn log `lesson proposal failed` is written (lessons never block an edit)
* **Test:** `src/lib/studio/lessons.test.ts` › "merges duplicates, caps 20 per author per day, and never blocks the edit"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-24 / US-024](US-024-edit-by-chat-on-drafts.md) Edit-by-chat on drafts. Also needed but not listed (see NOTES): NZR-27 (approval target: playbook revisions and the drafter's playbook path), the `${app}-studio` table.
* **UI/UX Design:** design.md screen inventory (NO-MOCK-YET): W-026 Proposed lessons queue (empty; pending lesson with the correction it came from; approve; reject; eval case created). Placed as a "Suggested changes" tab on the Library Playbooks page (W-022, NZR-27) for users with `playbooks:write`. Opt-in notice under the edit box when on: "Changes you make may be suggested to a reviewer as a lesson for the drafter." Workspace rules apply (plain words, 20px/AAA, autosave/Undo, Help me: PENDING OWNER Q99, Q104, Q105, Q107). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** Opt-in, scrubbed, stays in the install. Lesson creation adds ≤ 50 ms to an edit save (it runs after the save response is decided; failures are logged, never surfaced). Limits: `correctionText` ≤ 1,000 chars after scrubbing (cut with "…"), 20 proposed per author per day. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `lesson.proposed`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Props: `{ changeKinds: string[] }`. Until NZR-44's writer exists, the `lesson_proposed` audit row is the record (NOTES item 6).
* **Files to change:**

  | path | change |
  |---|---|
  | NZR-24 edit save path (TARGET, `src/lib/workflows/` store `saveRevision` with `source: 'edit'`) | after a successful save, `void proposeLessonFromEdit({ before, after, author })`. UNVERIFIED: exact module/function until NZR-24 merges |
  | `src/lib/audit/audit-writer.ts:57-…`, `:234-…` | add `lesson_proposed`, `lesson_decided`; `lesson_decided` always-audited |
  | `src/adapters/dashboard/playbooks.ts` (NZR-27) | mount the 2 lesson routes in the same sub-router |
  | `web/src/pages/Playbooks.tsx` (NZR-27) | "Suggested changes" tab: lesson card (change summary, the user's words, date, draft link), playbook picker, Approve / Reject (reason) |
  | Edit box component from NZR-24 (TARGET) | opt-in notice line when `studio/lessons_opt_in = "1"` |
  | `scripts/lib/seed-defaults.ts` | seed `studio/lessons_opt_in = "0"` (pattern of `memory/hive_promote_min_confidence`, `:49`) |
  | `docs/diagrams/architecture-security.md` | lesson routes (`handler.ts`-mounted router) |

* **New files:**
  - `src/lib/workflows/draft-diff.ts`: pure `diffDraftSteps(before, after)` → `changes[]` + `changeSummary` (plain words, no model).
  - `src/lib/studio/lessons.ts`: `proposeLessonFromEdit`, `listLessons(status)`, `decideLesson`.
  - `src/lib/studio/lessons.test.ts`, `src/lib/workflows/draft-diff.test.ts`, `src/lib/workflows/drafter.lessons.test.ts`, `src/adapters/dashboard/lessons.routes.test.ts`.
* **API contract:** (under `/api`, auth middleware; identity from `personOf(c)`)
  - `GET /lessons?status=proposed|approved|rejected&cursor=` · `playbooks:write` · `200 { items: [{ id, status, correctionText?, changeSummary?, changes, draftRef, authorUserId, seenCount, createdAt, decidedBy?, playbookId?, playbookRev? }], cursor? }` · `403`.
  - `POST /lessons/:id/decision` · `playbooks:write` · `{ decision: 'approve', textHash, playbookId, baseRev }` or `{ decision: 'reject', textHash, reason: string 1..500 }`, strict · `200 { id, status, playbookRev?, evalCaseStatus? }` · `400 invalid_body` · `403 forbidden | cannot_approve_own_lesson | person_required` · `404 not_found` · `409 lesson_changed | already_decided | playbook_changed {currentRev}` · `503 audit_unavailable`.
* **Data changes:**
  - Studio table: `LESSON#<id>` / `META` (shape in Scenario 1; `GSI1PK: 'LESSONQ#<status>'`, `GSI1SK: '<createdAt>#<id>'`); `LESSONKEY#<sha256>` / `META` → `{ id }` duplicate pointer; `LESSONRATE#<userId>#<yyyymmdd>` counter with `ttl` 2 days; `EVAL#<id>` / `META` = `{ id, status: 'proposed'|'active', source: { lessonId }, description, assertions[], optIn: { key: 'studio/lessons_opt_in', value: '1', at } , createdAt }`.
  - TTL: proposed lesson 90 d; approved none; rejected tombstone 365 d (same policy as Company facts, DATA-MODEL §3). Eval cases: no TTL while active ("until opt-out"); turning opt-in off does not delete existing items (owner to confirm, NOTES).
  - Expand only; no backfill.
* **Security notes:**
  - SECURITY §4 risk (h) and item 9: lessons are data. Proposed ⇒ invisible to the drafter; approved ⇒ only through a playbook revision, inside the neutralized block (one scheme, `src/lib/safety/prompt-neutralize.ts` from NZR-27).
  - Two-person rule: author cannot approve (`cannot_approve_own_lesson`); approver from the session.
  - Scrub with `redactPiiUnconditional` (`src/lib/pii/redact.ts:85`) before storage and before hashing. Names are **not** detected; the text stays in the install and is admin-visible only (Q82 private-by-default for user-originated text).
  - Opt-in default off; never on in the pilot (SECURITY §5 item 13).
  - Audit: ids, hashes and change kinds only; `writeAuditOrThrow` for decisions.
  - Customer eval cases never in git (DATA-MODEL §5): a CI check is out of scope, but `evals/drafter/cases/` must not be written by this code (assert in test: no `fs` write).
* **Test plan:**
  - Frozen failing tests first: Scenario 2 "proposed lessons never change drafter input", Scenario 3 "creates nothing when opt-in is off…", Scenario 5 self-approval.
  - Unit: vitest, mocked `ddb().send`; routes via `app.request()` with role principals (`src/adapters/dashboard/authz-matrix.test.ts:24-60`).
  - Fixtures: synthetic drafts and corrections; the email in Scenario 1 is `maria@example.com` (reserved domain).
  - Commands: `npx vitest run src/lib/studio/lessons.test.ts src/lib/workflows/draft-diff.test.ts src/lib/workflows/drafter.lessons.test.ts src/adapters/dashboard/lessons.routes.test.ts src/adapters/dashboard/authz-matrix.test.ts src/lib/pii/redact.test.ts`; `npm run typecheck`; `npm --prefix web run typecheck`; `npm test`; `node scripts/ci/diagrams-drift.mjs`.
* **Repo rules that apply:** closed audit `action` union + `writeAuditOrThrow` for decisions; `handler.ts`-mounted route change ⇒ diagram; no new capability (reuses `playbooks:write` from NZR-27), so no nav/Jarvis change; seeded runtime-config default via `scripts/lib/seed-defaults.ts` (+ its test `scripts/lib/seed-defaults.test.ts`); no new dependency.
* **Rollback:** set `studio/lessons_opt_in = "0"` (stops new lessons at once); `git revert` removes routes/UI. Existing items stay (RETAIN) and change nothing unless approved.
* **Build slices (proposal):**
  1. *Propose* (1–2 h): `draft-diff.ts`, `lessons.ts` propose path, opt-in, scrub, dedupe, rate cap, hook in the edit save. Green: Scenarios 1, 2, 3, 7.
  2. *Decide + UI* (2 h): routes, playbook append via NZR-27 transaction, eval case status, "Suggested changes" tab, notice line. Green: Scenarios 4, 5, 6.
* **Agent gotchas:**
  - **Never let a lesson reach the drafter except through an approved playbook revision.** Don't add a "lessons" block to the drafter prompt; it would also change the eval hash (Q66).
  - The change summary is built by code from validated JSON. Do not ask the model to summarise the correction (a second injection path).
  - Scrub **before** hashing and storing; the `textHash` the approver signs is of the scrubbed text.
  - `redactPiiUnconditional` resets `lastIndex` per pattern (`redact.ts:85-…`); `redactSync` is kill-switch gated (`:44-52`), so don't use it here.
  - Proposal runs after the edit is saved and must swallow its own errors; an edit must never fail because of a lesson.
  - Approve writes to another entity (playbook): use the NZR-27 `updatePlaybook` transaction with `baseRev`, then mark the lesson approved conditionally (`status = 'proposed'`); if the second step fails, the playbook rev stands and the lesson stays proposed (retry is safe: dedupe by `lessonId` marker in the playbook rev `note`).

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Could Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** eval, cut-3

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona B corrects; a different `playbooks:write` holder approves).
- [ ] Acceptance criteria cover both happy paths and edge cases (7 scenarios: proposed, not applied, opt-in off/non-structural, approve, permission/self/stale, reject, duplicates/rate/store down).
- [ ] UX/UI designs are attached and finalized: design.md W-026 (NO-MOCK-YET) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-24 merged with a `source: 'edit'` revision save; NZR-27 merged for the approval target).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71; NOTES proposes 5). Cut decision (Q72) made at the Nov 9 re-plan.
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail); no new dependency, no new capability.
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (npm audit, secret scan, lint) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: the `npx vitest run …` list in Test plan, both typechecks, full `npm test`.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51): opt-in on, correct a draft, see the lesson in "Suggested changes", approve into "How we review policies", the next draft follows it.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; diagram; durable facts promoted to README/ADR (eval flywheel ADR, NZR-8).
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
