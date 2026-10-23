# [US-025] Plain-language preview (numbered steps, no canvas) + agent picker

> Backlog task NZR-25 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-004, AC-003, AC-006.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3)
* **I want** to see my workflow as numbered steps in plain words
* **So that** I understand exactly what it will do before testing

---

## 2. Business Context & Description
* **Background:** No canvas in MVP. Shows trigger, who/what/when per step, approval points and the result.
* **Target Value:** 4/5 testers explain the workflow correctly.
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Readable steps
* **Given** a valid draft
* **When** the preview opens
* **Then** each step shows a number, a one-line action, who does it and any approval

### Scenario 2: Pick an agent
* **Given** a step with no agent
* **When** the user taps 'Pick an agent'
* **Then** a list of agents they may use opens, each with what it is for, and choosing one fills the step

### Scenario 3: Missing configuration
* **Given** a draft whose agent step has no agent chosen
* **When** the preview opens
* **Then** that step shows 'Needs: pick an agent' with a button, and testing is disabled with the reason

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-23 / US-023](US-023-workflow-drafter-describe-draft-or-clarifying-question.md) Workflow drafter: describe -> draft or clarifying question
* **UI/UX Design:** design.md Workflows slice gallery (MOCK, phone + desktop, light) (W-004, W-005). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** 18px, WCAG 2.2 AA, screen-reader order matches step order. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `workflow.preview_viewed`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44).

---

## 5. Estimation & Tracking
* **Epic Name:** M2a Core slice (cycle C2a Core vertical slice (plain Workflows tab), 2026-11-10 to 2026-11-23)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** ui, workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs are attached and finalized: design.md Workflows slice gallery (MOCK, phone + desktop, light) (W-004, W-005) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
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
