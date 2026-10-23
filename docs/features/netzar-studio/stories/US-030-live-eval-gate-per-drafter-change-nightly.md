# [US-030] Live eval gate: per drafter change + nightly, hash-checked in CI

> Backlog task NZR-30 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-027.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** every drafter change scored by a live eval and checked in CI
* **So that** the drafter can only get better

---

## 2. Business Context & Description
* **Background:** Q66/Q89: live eval on each drafter change and nightly, on the VPS only (no model keys in GitHub); CI only checks the committed result's hashes and score. The committed result records drafter-file, dataset and model hashes; CI fails on mismatch or a lower score. Production reach blocked until re-baselined on Bedrock (Q58).
* **Target Value:** 0 drafter merges without a matching eval result.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Better passes
* **Given** a drafter change with a new result file at or above baseline
* **When** CI runs
* **Then** the gate passes

### Scenario 2: Worse fails
* **Given** a result below baseline
* **When** CI runs
* **Then** the merge is blocked with the two scores shown

### Scenario 3: Nightly drift
* **Given** the nightly run scores below baseline
* **When** it finishes
* **Then** the owner is alerted on Telegram

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-14 / US-014](US-014-drafter-eval-set-30-cases-scorer-live.md) Drafter eval set (30 cases) + scorer + live baseline; [NZR-23 / US-023](US-023-workflow-drafter-describe-draft-or-clarifying-question.md) Workflow drafter: describe -> draft or clarifying question
* **UI/UX Design:** N/A: CI gate.
* **Non-Functional Requirements:** No secrets in CI (NVIDIA key stays on the VPS). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M2a Core slice (cycle C2a Core vertical slice (plain Workflows tab), 2026-11-10 to 2026-11-23)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** eval, gate

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: CI gate.
- [ ] Dependencies have been identified and are unblocked (NZR-14, NZR-23).
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
