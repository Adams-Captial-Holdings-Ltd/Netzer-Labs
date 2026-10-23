# [US-031] Golden workflow end to end: insurance policy review

> Backlog task NZR-31 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: AC-001, AC-002, AC-003, AC-004, AC-005, AC-006, AC-007.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** the insurance policy review workflow drafted, edited and tested end to end
* **So that** we have one real proof that the product works

---

## 2. Business Context & Description
* **Background:** Document in -> agent reviews -> gaps -> report -> approval. Synthetic documents only (Q67). Feeds the Nov 23 dry-run.
* **Target Value:** Recorded demo + passing e2e test.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Journey A works
* **Given** a fresh local install with the insurance agent
* **When** the e2e test follows Journey A
* **Then** it passes and a recording is saved

### Scenario 2: Dry-run
* **Given** a friendly non-technical tester
* **When** they try it on Nov 23
* **Then** findings are logged as issues

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-48 / US-048](US-048-plain-workflows-tab-list-new-open-draft.md) Plain Workflows tab: list, new, open draft; [NZR-23 / US-023](US-023-workflow-drafter-describe-draft-or-clarifying-question.md) Workflow drafter: describe -> draft or clarifying question; [NZR-24 / US-024](US-024-edit-by-chat-on-drafts.md) Edit-by-chat on drafts; [NZR-25 / US-025](US-025-plain-language-preview-numbered-steps-no-canvas.md) Plain-language preview (numbered steps, no canvas) + agent picker; [NZR-26 / US-026](US-026-sample-data-test-runner-sealed-sandbox-ready.md) Sample-data test runner (sealed sandbox) + Ready flag
* **UI/UX Design:** design.md Workflows slice gallery (MOCK, phone + desktop, light) (W-001 to W-013). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** Playwright serial on the VPS. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `journey.golden_completed`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-43).

---

## 5. Estimation & Tracking
* **Epic Name:** M2a Core slice (cycle C2a Core vertical slice (plain Workflows tab), 2026-11-10 to 2026-11-23)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** gate

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs are attached and finalized: design.md Workflows slice gallery (MOCK, phone + desktop, light) (W-001 to W-013) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-48, NZR-23, NZR-24, NZR-25, NZR-26).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (npm audit, secret scan, lint) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: real non-technical testers (synthetic documents only).
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
