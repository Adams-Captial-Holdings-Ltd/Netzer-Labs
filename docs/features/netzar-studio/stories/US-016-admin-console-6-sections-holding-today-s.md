# [US-016] Admin console: 6 sections holding today's admin screens

> Backlog task NZR-16 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-015, FR-013, OBJ-007.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** all of today's admin screens in one Admin console
* **So that** I keep every control without cluttering the Workspace

---

## 2. Business Context & Description
* **Background:** Nothing deleted. Permission checks unchanged.
* **Target Value:** Every old screen reachable; 0 permission regressions.
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: All reachable
* **Given** an admin
* **When** they open Admin
* **Then** every existing admin screen is reachable in <= 2 clicks

### Scenario 2: Non-admin
* **Given** a non-admin user
* **When** they look for Admin or open its URL
* **Then** no Admin link shows and the URL returns the existing permission error

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-15 / US-015](US-015-workspace-shell-home-agents-workflows-my-work.md) Workspace shell: Home, Agents, Workflows, My Work, Library
* **UI/UX Design:** design.md screen inventory (real screenshots after NZR-3 installs). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** Admin keeps today's density. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `nav.admin_opened`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-43).

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** ui

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs are attached and finalized: design.md screen inventory (real screenshots after NZR-3 installs) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-15).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
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
