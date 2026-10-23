# [US-034] Live engine v1 (chosen option)

> Backlog task NZR-34 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-009, FR-010, FR-022, NFR-008, AC-023, AC-024, AC-025, AC-027.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** published workflows to run durably with waits, retries and approvals
* **So that** real work gets done reliably

---

## 2. Business Context & Description
* **Background:** Per NZR-33 decision.
* **Target Value:** Golden workflow runs end to end; 0 duplicate writes in fault tests.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Runs
* **Given** a published golden workflow
* **When** it is triggered
* **Then** it completes, waiting at the approval until the approver releases it

### Scenario 2: Retry safe
* **Given** a step fails mid-way and retries
* **When** the run resumes
* **Then** no business write happens twice (AC-026)

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-33 / US-033](US-033-spike-step-functions-vs-own-dynamodb-engine.md) Spike: Step Functions vs own DynamoDB engine
* **UI/UX Design:** N/A: engine; run history UI is in My Work.
* **Non-Functional Requirements:** NFR-008 zero duplicate writes. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `run.started`, `run.completed`, `run.failed`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44).

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 8 (raw estimate 10 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: engine; run history UI is in My Work.
- [ ] Dependencies have been identified and are unblocked (NZR-33).
- [ ] The team has reviewed and estimated the story points (8 pts; re-checked at the Nov 9 re-plan, Q71).
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
