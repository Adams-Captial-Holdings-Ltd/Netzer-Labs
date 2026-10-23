# [US-023] Workflow drafter: describe -> draft or clarifying question

> Backlog task NZR-23 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-001, FR-002, AC-002, AC-003, AC-004, AC-010, NFR-002, NFR-003.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3)
* **I want** to describe my process in plain words and get a valid draft
* **So that** I can automate work without writing code

---

## 2. Business Context & Description
* **Background:** The core of the product. The drafter prompt ships in the repo as product code (Q88), so the eval can hash it; the S3 copy is seeded from the repo version at deploy (ADR line in NZR-8). It is an agent prompt + tools reading the agent's knowledge (and playbooks once NZR-27 lands). Asks at most 3 clarifying questions. Kill rule (Q72): under 70% on the live eval at the Nov 23 gate stops UI work.
* **Target Value:** >= 80% of 30 eval cases give a schema-valid draft in <= 3 questions (target); >= 70% at Nov 23 (kill line).
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Draft from description
* **Given** a user on the new-workflow screen
* **When** they describe the policy review process
* **Then** within 45 s (p95) they see a schema-valid draft or a clarifying question

### Scenario 2: Clarifying question
* **Given** a description missing who approves
* **When** the drafter runs
* **Then** it asks one plain question, and never more than 3 in total

### Scenario 3: No automatic tool permission
* **Given** a draft that needs a tool the agent is not allowed to use
* **When** the drafter proposes it
* **Then** the step is marked 'needs permission' and no tool permission is granted by the drafter (AC-010)

### Scenario 4: Drafter can't produce a valid draft
* **Given** the model returns an invalid workflow
* **When** validation fails
* **Then** the user sees 'I couldn't build that yet' plus what is missing, never raw JSON or a stack trace

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-12 / US-012](US-012-workflow-definition-schema-validator.md) Workflow definition schema + validator; [NZR-14 / US-014](US-014-drafter-eval-set-30-cases-scorer-live.md) Drafter eval set (30 cases) + scorer + live baseline; [NZR-49 / US-049](US-049-plain-workflows-tab-list-new-open-draft.md) Plain Workflows tab: list, new, open draft
* **UI/UX Design:** design.md Workflows slice gallery (MOCK, phone + desktop, light) (W-002, W-003). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** NFR-002 ack <= 3 s; NFR-003 <= 45 s p95; cost per draft logged. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `workflow.draft_requested`, `workflow.draft_created`, `workflow.clarify_asked`, `workflow.draft_failed`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44).

---

## 5. Estimation & Tracking
* **Epic Name:** M2a Core slice (cycle C2a Core vertical slice (plain Workflows tab), 2026-11-10 to 2026-11-23)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 8 (raw estimate 8 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** workflow, urgent

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs are attached and finalized: design.md Workflows slice gallery (MOCK, phone + desktop, light) (W-002, W-003) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-12, NZR-14, NZR-49).
- [ ] The team has reviewed and estimated the story points (8 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (npm audit, secret scan, lint) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51).
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
