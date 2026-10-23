# [US-039] Later (stretch): forms/embed triggers

> Backlog task NZR-39 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-011.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** a form to start a workflow
* **So that** people without systems can feed it

---

## 2. Business Context & Description
* **Background:** Cut 1st if late (Q72).
* **Target Value:** Form submission starts a run.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Form
* **Given** an active workflow with a form trigger
* **When** someone submits it
* **Then** a run starts

### Scenario 2: Spam
* **Given** 100 submissions a minute
* **When** they arrive
* **Then** the rate limit rejects the excess

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-35 / US-035](US-035-triggers-webhook-api.md) Triggers: webhook + API
* **UI/UX Design:** design.md screen inventory (NO-MOCK-YET). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** Rate limit per contract. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Could Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** stretch, cut-1

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs are attached and finalized: design.md screen inventory (NO-MOCK-YET) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-35).
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
