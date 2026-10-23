# [US-014] Drafter eval set (30 cases) + scorer + live baseline

> Backlog task NZR-14 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-001, FR-027, NFR-003.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** 30 plain-language descriptions with expected workflows and a scorer
* **So that** we can tell whether a drafter change made it better or worse

---

## 2. Business Context & Description
* **Background:** Q66: the committed result records hashes of the drafter files, the dataset and the model; CI fails if they don't match. Baseline on NVIDIA now, re-baseline on Bedrock later (Q58).
* **Target Value:** Baseline pass rate stored with hashes.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Baseline stored
* **Given** 30 cases
* **When** the live eval runs
* **Then** a result file with pass rate and the three hashes is committed

### Scenario 2: Stale result fails
* **Given** the drafter prompt changed but the result file is old
* **When** CI runs
* **Then** CI fails with 'eval result does not match drafter hash'

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-12 / US-012](US-012-workflow-definition-schema-validator.md) Workflow definition schema + validator; [NZR-10 / US-010](US-010-local-model-env-floci-nvidia-dev-backend.md) Local model env: Floci + NVIDIA dev backend (test data only)
* **UI/UX Design:** N/A: evaluation tooling.
* **Non-Functional Requirements:** Cases use synthetic documents only (Q67). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** eval

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: evaluation tooling.
- [ ] Dependencies have been identified and are unblocked (NZR-12, NZR-10).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (npm audit, secret scan, lint) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
