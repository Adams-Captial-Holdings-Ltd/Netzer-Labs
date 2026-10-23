# [US-029] Lessons from corrections -> proposed knowledge

> Backlog task NZR-29 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-027.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** my corrections to become proposed lessons
* **So that** the drafter improves with approval

---

## 2. Business Context & Description
* **Background:** Cut 3rd if late (Q72).
* **Target Value:** Each correction yields a proposed lesson + eval case.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Proposed
* **Given** a user corrects a draft
* **When** they save
* **Then** a proposed lesson and a new eval case appear for approval

### Scenario 2: Not auto-applied
* **Given** a proposed lesson
* **When** nobody approves it
* **Then** the drafter behavior does not change

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-24 / US-024](US-024-edit-by-chat-on-drafts.md) Edit-by-chat on drafts
* **UI/UX Design:** design.md screen inventory (NO-MOCK-YET). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** Opt-in, scrubbed, stays in the install. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `lesson.proposed`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-43).

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Could Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** eval, cut-3

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs are attached and finalized: design.md screen inventory (NO-MOCK-YET) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-24).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
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
