# [US-015] Workspace shell: Home, Agents, Workflows, My Work, Library

> Backlog task NZR-15 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-001, AC-001, NFR-001, NFR-005.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3)
* **I want** five clear areas instead of 28 tabs
* **So that** I always know where to go

---

## 2. Business Context & Description
* **Background:** Replaces the sidebar for business users. Sidebar NAV_ITEMS, App.tsx routes and the Jarvis ROUTE_TABLE must stay in sync (repo rule). Mocks due before this step starts (Q77).
* **Target Value:** Nav manifest tests pass; testers find each area first try.
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Five areas
* **Given** a business user
* **When** they sign in
* **Then** they see Home, Agents, Workflows, My Work, Library and an account menu

### Scenario 2: Old link
* **Given** a bookmarked old route
* **When** they open it
* **Then** they land on the new home of that screen, not a 404

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-31 / US-031](US-031-golden-workflow-end-to-end-insurance-policy.md) Golden workflow end to end: insurance policy review
* **UI/UX Design:** design.md screen inventory (NO-MOCK-YET until Nov 24). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** NFR-001 Home interactive <= 3 s p95; 18px; 44px targets. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `nav.area_opened`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-43).

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 8 (raw estimate 8 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** ui

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs are attached and finalized: design.md screen inventory (NO-MOCK-YET until Nov 24) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-31).
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
