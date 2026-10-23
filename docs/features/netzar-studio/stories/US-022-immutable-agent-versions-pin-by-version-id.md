# [US-022] Immutable agent versions (pin by version id)

> Backlog task NZR-22 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: AC-012, AC-022, FR-008.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** a workflow to keep using the agent version it was tested with
* **So that** an agent edit never silently changes a workflow

---

## 2. Business Context & Description
* **Background:** Today the live S3 prompt file is overwritten in place. Data-model one-way door.
* **Target Value:** 0 runs on an unpinned agent.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Publish freezes
* **Given** an agent edit
* **When** the user publishes it
* **Then** a new version id is created and old versions stay retrievable

### Scenario 2: Pinned run
* **Given** a workflow pinned to version 3
* **When** the agent is edited to version 4
* **Then** the workflow still runs version 3 until re-pinned

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-12 / US-012](US-012-workflow-definition-schema-validator.md) Workflow definition schema + validator
* **UI/UX Design:** N/A: backend; version shown on the agent page (NZR-19).
* **Non-Functional Requirements:** Expand/contract migration; running chats unaffected. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `agent.version_published`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-43).

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** agents

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: backend; version shown on the agent page (NZR-19).
- [ ] Dependencies have been identified and are unblocked (NZR-12).
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
