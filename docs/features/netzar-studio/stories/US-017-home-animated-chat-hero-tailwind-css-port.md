# [US-017] Home: animated chat hero (Tailwind/CSS port) + quick actions

> Backlog task NZR-17 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-001, NFR-002, AC-001.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3)
* **I want** a welcoming Home with one chat box and three big actions
* **So that** my next step is obvious

---

## 2. Business Context & Description
* **Background:** Look of the owner's animated-ai-chat.tsx recreated with Tailwind/CSS (no framer-motion, no new dependency). Build a workflow / Talk to an agent / Add knowledge; Waiting for you; Recent work.
* **Target Value:** NFR-001 met; testers start a workflow from Home unaided.
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Quick action
* **Given** a user on Home
* **When** they click Build a workflow
* **Then** the describe screen opens

### Scenario 2: Reduced motion
* **Given** a user with reduced motion set
* **When** Home loads
* **Then** no animation plays and all functions still work

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-15 / US-015](US-015-workspace-shell-home-agents-workflows-my-work.md) Workspace shell: Home, Agents, Workflows, My Work, Library
* **UI/UX Design:** design.md screen inventory (NO-MOCK-YET until Nov 24). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** Keyboard usable; reduced-motion respected; no new dependency. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `home.quick_action`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-43).

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 5 (raw estimate 6 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** ui

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs are attached and finalized: design.md screen inventory (NO-MOCK-YET until Nov 24) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
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
