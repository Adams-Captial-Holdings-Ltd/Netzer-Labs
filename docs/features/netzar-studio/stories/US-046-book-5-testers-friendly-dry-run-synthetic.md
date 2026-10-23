# [US-046] Book 5 testers + friendly dry-run (synthetic documents)

> Backlog task NZR-46 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-001. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3)
* **I want** 5 non-technical testers booked and one friendly dry-run
* **So that** the C2b tester gate can actually run

---

## 2. Business Context & Description
* **Background:** Q67: synthetic documents only; book 5 by Nov 15; one friendly dry-run on Nov 23.
* **Target Value:** 5 booked by Nov 15; dry-run held Nov 23.
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Booked
* **Given** Nov 15
* **When** the owner checks bookings
* **Then** 5 names and slots are recorded (no personal data in the repo; initials only)

### Scenario 2: Dry-run
* **Given** the slice is green
* **When** the Nov 23 dry-run runs
* **Then** findings are logged as issues

---

## 4. Technical Notes & Constraints
* **Dependencies:** None.
* **UI/UX Design:** N/A: owner task.
* **Non-Functional Requirements:** Synthetic documents only. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 1 (raw estimate 1 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** N/A · **Deploy reach:** local only · **Labels:** needs-owner

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: owner task.
- [ ] Dependencies have been identified and are unblocked (none).
- [ ] The team has reviewed and estimated the story points (1 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] N/A: no code (owner/business task).
- [ ] Peer code review is completed and approved. N/A: owner/business task, no code. Evidence is the artifact named in the acceptance criteria.
- [ ] N/A: no code; evidence is the artifact in the acceptance criteria.
- [ ] UAT: the owner confirms the acceptance criteria are met.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] N/A: nothing to deploy.
