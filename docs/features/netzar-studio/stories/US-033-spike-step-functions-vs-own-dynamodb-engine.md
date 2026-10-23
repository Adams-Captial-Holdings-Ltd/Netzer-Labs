# [US-033] Spike: Step Functions vs own DynamoDB engine

> Backlog task NZR-33 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-009, OBJ-005.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** a written comparison and a decision
* **So that** the live engine is chosen on cost, scale and upkeep

---

## 2. Business Context & Description
* **Background:** 1-2 days. Decision becomes an ADR.
* **Target Value:** ADR merged with the decision.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Decision
* **Given** both prototypes on the golden workflow
* **When** the spike ends
* **Then** an ADR records cost at 1,000 runs/day, failure handling and upkeep

### Scenario 2: Tie
* **Given** no clear winner
* **When** the spike ends
* **Then** Jev gives a first-pass pick and the owner decides

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-31 / US-031](US-031-golden-workflow-end-to-end-insurance-policy.md) Golden workflow end to end: insurance policy review
* **UI/UX Design:** N/A: spike.
* **Non-Functional Requirements:** <= 50 users, ~1,000 runs/day per install. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** spike, decision

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: spike.
- [ ] Dependencies have been identified and are unblocked (NZR-31).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews the security boundary.
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
