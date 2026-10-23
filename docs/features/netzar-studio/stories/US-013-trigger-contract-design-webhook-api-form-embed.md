# [US-013] Trigger contract design (webhook/api/form/embed/integration/schedule)

> Backlog task NZR-13 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-011, AC-026.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** one written entry contract for every way a workflow can start
* **So that** live triggers in C3 plug into one entry point

---

## 2. Business Context & Description
* **Background:** Design only in MVP; switched on in C3 (NZR-35). Public-API one-way door.
* **Target Value:** Contract type compiles; reviewed.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Contract reviewed
* **Given** the design doc + schema type
* **When** review runs
* **Then** auth, schema, rate limit and idempotency key are defined per trigger type

### Scenario 2: No runtime
* **Given** the diff
* **When** it is inspected
* **Then** no handler or route is added

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-12 / US-012](US-012-workflow-definition-schema-validator.md) Workflow definition schema + validator
* **UI/UX Design:** N/A: contract.
* **Non-Functional Requirements:** Idempotency key required (AC-026). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 2 (raw estimate 2 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** workflow, docs

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: contract.
- [ ] Dependencies have been identified and are unblocked (NZR-12).
- [ ] The team has reviewed and estimated the story points (2 pts; re-checked at the Nov 9 re-plan, Q71).
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
