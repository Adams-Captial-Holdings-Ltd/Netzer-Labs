# [US-007] ADRs: supersede 0012 + 0017 d21, amend do-not-build #1

> Backlog task NZR-7 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-030, OBJ-007.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** the three reversals of earlier decisions recorded as ADRs
* **So that** no builder follows an old decision the owner has replaced

---

## 2. Business Context & Description
* **Background:** Paperclip replaced (supersedes 0012); customers build workflows (supersedes 0017 decision 21); Netzar owns its workflow engine (amends do-not-build #1). One-way doors: owner yes recorded in each ADR.
* **Target Value:** 3 ADRs merged; old ADRs marked superseded.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: ADRs merged
* **Given** the three drafts
* **When** docs CI runs
* **Then** it passes and each ADR lists options, decision, reversibility and revisit trigger

### Scenario 2: Old ADRs point forward
* **Given** ADR 0012 and 0017
* **When** a reader opens them
* **Then** each shows superseded-by links

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-9 / US-009](US-009-foundation-plan-docs-user-stories-this-docs.md) Foundation PLAN docs + user stories (this docs PR)
* **UI/UX Design:** N/A: decision record.
* **Non-Functional Requirements:** Each ADR records the owner's yes (T3). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** docs, decision

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: decision record.
- [ ] Dependencies have been identified and are unblocked (NZR-9).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
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
