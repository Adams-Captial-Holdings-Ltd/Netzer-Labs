# [US-008] ADRs: workflows-as-data, eval flywheel, knowledge layers, agent runtime, pilot hosting, mock policy

> Backlog task NZR-8 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-004, OBJ-006, FR-012, FR-027.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** the grill decisions recorded as ADRs with their trade-offs
* **So that** future changes have a revisit trigger instead of re-arguing

---

## 2. Business Context & Description
* **Background:** Q11-Q16, Q29-Q31 from grill 1 plus grill 2: pilot in PGN's own AWS account as a written exception to the customer-hosted data-plane rule (Q64); NO-MOCK-YET screens departing from the PLAN gate wording (Q77); live eval with hash-checked results, run on the VPS only (Q66, Q89); drafter prompt ships in the repo and seeds S3 at deploy, an exception to "prompts live in S3" (Q88).
* **Target Value:** 6 ADRs merged with scale/maintainability/cost/reliability trade-offs.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: ADRs merged
* **Given** six drafts
* **When** docs CI runs
* **Then** it passes and each has trade-offs, reversibility and revisit trigger

### Scenario 2: Pilot exception is bounded
* **Given** the pilot-hosting ADR
* **When** it is reviewed
* **Then** it states: PGN AWS only, no customer production data, partner consent, ends at GA

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-9 / US-009](US-009-foundation-plan-docs-user-stories-this-docs.md) Foundation PLAN docs + user stories (this docs PR)
* **UI/UX Design:** N/A: decision record.
* **Non-Functional Requirements:** T3: owner yes recorded. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** docs, decision

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: decision record.
- [ ] Dependencies have been identified and are unblocked (NZR-9).
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
