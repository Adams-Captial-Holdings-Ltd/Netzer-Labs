# [US-037] Migrate off Paperclip and retire it (moved to January)

> Backlog task NZR-37 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-030.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** Paperclip removed once nothing reads it
* **So that** we run one workflow system

---

## 2. Business Context & Description
* **Background:** Q72: moved to January (8 pts of regression risk, no customer value now). Paperclip is staging-only with no customer data.
* **Target Value:** Nothing reads Paperclip; tests green.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Nothing reads it
* **Given** the code base
* **When** a search for Paperclip clients runs
* **Then** only the removal shim remains and all tests pass

### Scenario 2: Hidden dependency
* **Given** a caller found late
* **When** removal is attempted
* **Then** it stops and the caller is migrated first

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-34 / US-034](US-034-live-engine-v1-chosen-option.md) Live engine v1 (chosen option)
* **UI/UX Design:** N/A: migration.
* **Non-Functional Requirements:** Staging stack removal plan; owner yes for any AWS call. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M4 Paperclip retired (cycle LATER January 2027, 2027-01-04 to 2027-01-29)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 8 (raw estimate 8 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** migration, cut-2

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: migration.
- [ ] Dependencies have been identified and are unblocked (NZR-34).
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
