# [US-045] Business brief: ICP, single pain, price hypothesis, 2 partner calls

> Backlog task NZR-45 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-008. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Design partner (first insurance agency; Q63)
* **I want** a one-page brief and two booked design-partner conversations
* **So that** the Dec 31 pilot has a real customer and a price to test

---

## 2. Business Context & Description
* **Background:** Q73/Q79: Zion drafts by Nov 12 from the repo plus marked assumptions; owner corrects by Nov 15; the 2 partner calls happen by Nov 23 so they inform the Nov 23 gate. Owner-only questions: who the first insurance agency is, what they pay today, who signs, whether the pilot runs in PGN AWS.
* **Target Value:** Brief final by Nov 15; 2 calls held by Nov 23.
* **User Persona Profile:** Design partner (first insurance agency; Q63). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Draft on time
* **Given** the repo plan
* **When** Zion drafts the brief
* **Then** it is ready by Nov 12 with every guess marked and the owner-only questions listed

### Scenario 2: Calls held
* **Given** the corrected brief
* **When** Nov 23 arrives
* **Then** notes from 2 partner calls are linked, or the gate records why not

---

## 4. Technical Notes & Constraints
* **Dependencies:** None.
* **UI/UX Design:** N/A: business document.
* **Non-Functional Requirements:** No customer data in the brief. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 2 (raw estimate 2 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** N/A · **Deploy reach:** local only · **Labels:** needs-owner, business

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: business document.
- [ ] Dependencies have been identified and are unblocked (none).
- [ ] The team has reviewed and estimated the story points (2 pts; re-checked at the Nov 9 re-plan, Q71).
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
