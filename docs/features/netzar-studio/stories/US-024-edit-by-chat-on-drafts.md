# [US-024] Edit-by-chat on drafts

> Backlog task NZR-24 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-020, AC-007, AC-020.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3)
* **I want** to change the draft by saying what I want
* **So that** I can fix it without learning an editor

---

## 2. Business Context & Description
* **Background:** 'Add my approval before sending' updates the draft; history kept.
* **Target Value:** Edits keep the draft valid in 100% of replay cases.
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Edit applied
* **Given** a valid draft
* **When** the user says 'add my approval before sending the report'
* **Then** an approval step appears before the output step, the change is highlighted and the draft stays valid

### Scenario 2: Edit would break it
* **Given** a request that would remove the trigger
* **When** the drafter applies it
* **Then** the change is refused with a plain reason and the previous version is kept

### Scenario 3: Undo
* **Given** an applied edit
* **When** the user says 'undo that'
* **Then** the previous draft version is restored

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-23 / US-023](US-023-workflow-drafter-describe-draft-or-clarifying-question.md) Workflow drafter: describe -> draft or clarifying question
* **UI/UX Design:** design.md Workflows slice gallery (MOCK, phone + desktop, light) (W-006, W-007). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** No step silently disappears (AC-020). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `workflow.edit_applied`, `workflow.edit_refused`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-43).

---

## 5. Estimation & Tracking
* **Epic Name:** M2a Core slice (cycle C2a Core vertical slice (plain Workflows tab), 2026-11-10 to 2026-11-23)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs are attached and finalized: design.md Workflows slice gallery (MOCK, phone + desktop, light) (W-006, W-007) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-23).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (npm audit, secret scan, lint) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51).
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
