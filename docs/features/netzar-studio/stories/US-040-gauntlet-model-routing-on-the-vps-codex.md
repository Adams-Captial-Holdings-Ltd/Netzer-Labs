# [US-040] Gauntlet model routing on the VPS: Codex builds, fresh Claude critic, NVIDIA roles after bake-off

> Backlog task NZR-40 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-009.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** each gauntlet role to run on the model the owner chose, with every pick logged
* **So that** code is built cheaply and checked by someone other than its builder

---

## 2. Business Context & Description
* **Background:** Rewritten for the VPS gauntlet (Q59, Q51, Q65). Codex builds by default. A fresh Claude critic checks. NVIDIA review or build roles join only after (a) the owner reads the NVIDIA free-tier terms and says yes, and (b) they pass a bake-off on small tasks. Codex reviews only code someone else built. Jev picks routes first and can fail a pass, never pass a red gate.
* **Target Value:** 100% of steps have a logged route (`JEV: q -> answer (confidence)`); 0 steps where builder == critic.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Routed step
* **Given** a work order for a small code step
* **When** the gauntlet starts it
* **Then** Codex builds, a new Claude session critiques, and the run log names both models and the Jev pick

### Scenario 2: No NVIDIA before consent
* **Given** the owner has not said yes to the NVIDIA terms
* **When** a route would send repo code to an NVIDIA model
* **Then** the route is refused and the step falls back to Codex, with the reason logged

### Scenario 3: Builder never certifies itself
* **Given** Codex built a change
* **When** the review stage is assigned
* **Then** Codex is excluded from reviewing that change and the critic session id differs from the builder's

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-3 / US-003](US-003-clean-clone-builder-workspace-on-the-vps.md) Clean-clone builder workspace on the VPS (no .env, lockfile installs)
* **UI/UX Design:** N/A: no user interface in this step.
* **Non-Functional Requirements:** Spend stays inside the factory cap ($250, alert $125). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Factory ready (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** factory

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: no user interface in this step.
- [ ] Dependencies have been identified and are unblocked (NZR-3).
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
