# [US-026] Sample-data test runner (sealed sandbox) + Ready flag

> Backlog task NZR-26 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-005, AC-005, FR-014, NFR-008.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3)
* **I want** to test my workflow on a sample document and see each step's result
* **So that** I can trust it before it ever touches real systems

---

## 2. Business Context & Description
* **Background:** Reuses the agent loop with a stricter test sandbox than today's AI-step write-deny (which still lets an allowlisted MCP tool write and saves memories/Hive notes; ARCHITECTURE R1). Test-step evidence is written with writeAuditOrThrow and the studio TestRun row is the record of truth. Safety boundary, so T3.
* **Target Value:** 0 external writes in tests (asserted); per-step result shown for 100% of steps.
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Test passes
* **Given** a valid draft and a synthetic policy PDF
* **When** the user clicks 'Test with sample data'
* **Then** each step shows a plain result and the banner says 'Nothing was sent anywhere'

### Scenario 2: Step fails
* **Given** a sample that makes the review step fail
* **When** the test runs
* **Then** the failed step is marked, explained in plain words, and later steps show 'not run'

### Scenario 3: Write attempt blocked
* **Given** an agent step that tries a write tool
* **When** the test runs
* **Then** the write is blocked, shown as 'would have sent X', and audited; no external call is made

### Scenario 4: Sandbox is total
* **Given** an agent whose allowlist names a remote (MCP) tool, and memory/Hive writes that normally happen after a turn
* **When** the test runs
* **Then** no remote tool runs, no memory or Hive note is written, and a network spy records zero outbound calls

### Scenario 5: Mark ready
* **Given** a test that passed on the current draft
* **When** the user clicks 'Mark as ready'
* **Then** the workflow shows Ready; if the draft changes afterwards it shows 'Test again'

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-23 / US-023](US-023-workflow-drafter-describe-draft-or-clarifying-question.md) Workflow drafter: describe -> draft or clarifying question
* **UI/UX Design:** design.md Workflows slice gallery (MOCK, phone + desktop, light) (W-008 to W-012). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** Zero external writes (asserted in tests); every step result in the audit log. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `workflow.test_started`, `workflow.test_completed`, `workflow.test_write_blocked`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44).

---

## 5. Estimation & Tracking
* **Epic Name:** M2a Core slice (cycle C2a Core vertical slice (plain Workflows tab), 2026-11-10 to 2026-11-23)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 8 (raw estimate 8 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** workflow, urgent

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs are attached and finalized: design.md Workflows slice gallery (MOCK, phone + desktop, light) (W-008 to W-012) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-23).
- [ ] The team has reviewed and estimated the story points (8 pts; re-checked at the Nov 9 re-plan, Q71).
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
