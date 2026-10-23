# [US-020] Readability: 18px Workspace scale, 44px targets, axe in CI

> Backlog task NZR-20 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-005.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3)
* **I want** large readable text and big targets
* **So that** older and non-technical users can use it comfortably

---

## 2. Business Context & Description
* **Background:** Workspace only; Admin keeps density. Needs the NZR-3 installs (Playwright, axe).
* **Target Value:** axe 0 serious/critical on Workspace pages.
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: axe clean
* **Given** the Workspace pages
* **When** the CI axe check runs
* **Then** 0 serious or critical issues

### Scenario 2: Regression
* **Given** a change that adds a 12px label
* **When** CI runs
* **Then** the check fails naming the element

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-15 / US-015](US-015-workspace-shell-home-agents-workflows-my-work.md) Workspace shell: Home, Agents, Workflows, My Work, Library; [NZR-3 / US-003](US-003-clean-clone-builder-workspace-on-the-vps.md) Clean-clone builder workspace on the VPS (no .env, lockfile installs)
* **UI/UX Design:** N/A: applies the readability rules in design.md section 1; no new screen.
* **Non-Functional Requirements:** WCAG 2.2 AA. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** a11y

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: applies the readability rules in design.md section 1; no new screen.
- [ ] Dependencies have been identified and are unblocked (NZR-15, NZR-3).
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
