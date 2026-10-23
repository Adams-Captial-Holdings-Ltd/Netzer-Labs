# [US-044] TEST-STRATEGY.md: pyramid, replay vs live eval, e2e journeys

> Backlog task NZR-44 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-027, NFR-005. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** the test layers written down, including what replay can and cannot prove
* **So that** no gate claims more than its tests show

---

## 2. Business Context & Description
* **Background:** Q48 (C1 story), Q66: replay tests the harness only; live eval on each drafter change + nightly.
* **Target Value:** Every MVP journey has a named e2e test.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Layers named
* **Given** the doc
* **When** it is reviewed
* **Then** unit, integration, replay, live eval, e2e and axe layers each name their command and when they run

### Scenario 2: Replay limit stated
* **Given** a drafter prompt change
* **When** the doc is consulted
* **Then** it says replay cannot score it and the live eval must run

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-9 / US-009](US-009-foundation-plan-docs-user-stories-this-docs.md) Foundation PLAN docs + user stories (this docs PR)
* **UI/UX Design:** N/A: documentation.
* **Non-Functional Requirements:** Playwright runs serially on the VPS (Q69). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T1 · **Deploy reach:** local only · **Labels:** docs, eval

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: documentation.
- [ ] Dependencies have been identified and are unblocked (NZR-9).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Docs follow docs/features/README.md; no file under src/, web/ or infra/.
- [ ] Peer code review is completed and approved. Free checks only (Q68): docs CI, lint, secret scan.
- [ ] Docs CI green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
