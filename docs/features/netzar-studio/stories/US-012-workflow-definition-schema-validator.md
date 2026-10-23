# [US-012] Workflow definition schema + validator

> Backlog task NZR-12 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-001, FR-004, FR-008, AC-002, AC-020, AC-021.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** a workflow to be stored as versioned data that a validator can check
* **So that** every draft is valid before anyone tests it

---

## 2. Business Context & Description
* **Background:** Workflows as data (blueprint 2). Steps: trigger, agent step, decision, approval, output. Lives in `src/lib/workflows/`. One-way door (data model).
* **Target Value:** Validator accepts the golden workflow and rejects 10 malformed cases.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Golden workflow valid
* **Given** the insurance policy review workflow as JSON
* **When** the validator runs
* **Then** it passes

### Scenario 2: Malformed rejected in plain words
* **Given** 10 malformed definitions (missing trigger, unknown step type, approval without approver, cycle, etc.)
* **When** the validator runs
* **Then** each fails with a plain-language error naming the step

### Scenario 3: Unknown construct kept
* **Given** a definition with an unsupported construct
* **When** it is validated
* **Then** it is flagged, not silently dropped (AC-021)

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-9 / US-009](US-009-foundation-plan-docs-user-stories-this-docs.md) Foundation PLAN docs + user stories (this docs PR)
* **UI/UX Design:** N/A: data contract.
* **Non-Functional Requirements:** Schema version field; forward-only changes. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 6 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: data contract.
- [ ] Dependencies have been identified and are unblocked (NZR-9).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
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
