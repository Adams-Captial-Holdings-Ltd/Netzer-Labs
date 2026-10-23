# [US-041] Review gauntlet v2 wiring: Q68 tier policy + Kodus/CodeRabbit on the VPS

> Backlog task NZR-41 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-007.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** each step reviewed at the depth its risk tier needs
* **So that** T3 steps get every layer and cheap steps don't burn credits

---

## 2. Business Context & Description
* **Background:** Existed in Plane only (NZR-41), now in the repo backlog (Q76). The layered review is already built into the gauntlet skill (`references/review-gauntlet.md`), so this step is wiring only: the Q68 tier policy (T3 = full layers + one Greptile pass; T2 UI = critic + free checks + step maid; T1/docs = free checks) and the Kodus/CodeRabbit CLIs on the VPS. Sending code to Kodus/CodeRabbit/Greptile needs the owner's yes per run.
* **Target Value:** Greptile credits used only on T3 steps; review layer per tier matches policy in 100% of steps.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Tier picks layers
* **Given** a step tagged T2
* **When** verification runs
* **Then** critic + free checks + step maid run and Greptile does not

### Scenario 2: T3 gets Greptile once
* **Given** a step tagged T3 with all lower layers green
* **When** verification runs
* **Then** exactly one Greptile pass runs on the exact SHA and the credit ledger is updated

### Scenario 3: Third-party send needs consent
* **Given** no owner yes recorded for this run
* **When** a layer would send code to Kodus, CodeRabbit or Greptile
* **Then** the layer stops and asks the owner

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-40 / US-040](US-040-gauntlet-model-routing-on-the-vps-codex.md) Gauntlet model routing on the VPS: Codex builds, fresh Claude critic, NVIDIA roles after bake-off
* **UI/UX Design:** N/A: no user interface in this step.
* **Non-Functional Requirements:** Greptile credit ledger: warn 35, stop 45 of 50. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Factory ready (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** factory

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: no user interface in this step.
- [ ] Dependencies have been identified and are unblocked (NZR-40).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
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
