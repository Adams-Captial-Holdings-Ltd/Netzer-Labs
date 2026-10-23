# [US-032] Real tester sessions (5 non-technical people)

> Backlog task NZR-32 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-001, AC-001, AC-002, AC-005.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3)
* **I want** 5 real non-technical people to try the golden workflow
* **So that** we know it works for the people it is for

---

## 2. Business Context & Description
* **Background:** 1 hour each, fixed task, synthetic documents (Q67). Booked under NZR-46.
* **Target Value:** >= 4/5 build + test unaided in <= 20 min.
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Pass
* **Given** 5 sessions
* **When** they finish
* **Then** >= 4 complete unaided in <= 20 minutes

### Scenario 2: Fail
* **Given** fewer than 4 pass
* **When** results are reviewed
* **Then** findings become issues and the C3 start is re-decided with the owner

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-31 / US-031](US-031-golden-workflow-end-to-end-insurance-policy.md) Golden workflow end to end: insurance policy review; [NZR-15 / US-015](US-015-workspace-shell-home-agents-workflows-my-work.md) Workspace shell: Home, Agents, Workflows, My Work, Library; [NZR-46 / US-046](US-046-book-5-testers-friendly-dry-run-synthetic.md) Book 5 testers + friendly dry-run (synthetic documents)
* **UI/UX Design:** N/A: uses the built screens.
* **Non-Functional Requirements:** No tester personal data in the repo. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `journey.golden_completed`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-43).

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** N/A · **Deploy reach:** local only · **Labels:** needs-owner, gate

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: uses the built screens.
- [ ] Dependencies have been identified and are unblocked (NZR-31, NZR-15, NZR-46).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] N/A: no code (owner/business task).
- [ ] Peer code review is completed and approved. N/A: owner/business task, no code. Evidence is the artifact named in the acceptance criteria.
- [ ] N/A: no code; evidence is the artifact in the acceptance criteria.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: real non-technical testers (synthetic documents only).
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] N/A: nothing to deploy.
