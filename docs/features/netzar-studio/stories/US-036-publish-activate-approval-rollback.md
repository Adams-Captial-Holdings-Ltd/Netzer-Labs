# [US-036] Publish / Activate (approval) / Rollback

> Backlog task NZR-36 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-008, FR-010, AC-022.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** to publish a frozen version, get it approved, and roll back in one click
* **So that** changes are safe and reversible

---

## 2. Business Context & Description
* **Background:** Workflows-as-data lifecycle.
* **Target Value:** One-click rollback tested.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Activate
* **Given** a Ready workflow
* **When** it is published and an approver activates it
* **Then** live runs use that frozen version

### Scenario 2: Rollback
* **Given** version 2 misbehaves
* **When** the user clicks Roll back
* **Then** version 1 serves the next run

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-34 / US-034](US-034-live-engine-v1-chosen-option.md) Live engine v1 (chosen option)
* **UI/UX Design:** design.md screen inventory (NO-MOCK-YET). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** Activation needs an authorized approver. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `workflow.published`, `workflow.activated`, `workflow.rolled_back`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-43).

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs are attached and finalized: design.md screen inventory (NO-MOCK-YET) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-34).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews the security boundary.
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51).
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
