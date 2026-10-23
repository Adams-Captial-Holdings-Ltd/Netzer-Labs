# [US-006] Chat-dropped files private to the uploading chat

> Backlog task NZR-6 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-012, FR-029, NFR-010.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** a file dropped into a chat to be readable only inside that user's chat
* **So that** one user's documents are never shown to other users of the same agent

---

## 2. Business Context & Description
* **Background:** Known leak: files dropped in a chat are readable by every user of that agent. Week-0 T3 security step with NZR-5 (Q62, Q75).
* **Target Value:** 0 cross-user file reads in permission tests.
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Uploader can use it
* **Given** user A drops a file into their chat with agent X
* **When** A asks X about it
* **Then** the agent answers using the file

### Scenario 2: Other user cannot
* **Given** user B also uses agent X
* **When** B's chat or any knowledge route tries to retrieve A's file
* **Then** nothing from A's file is returned and the denial is audited

### Scenario 3: Existing files
* **Given** files dropped before the fix
* **When** the fix is deployed locally
* **Then** they become private to their original chat (or are flagged for review if the owner chat is unknown), never public

---

## 4. Technical Notes & Constraints
* **Dependencies:** None.
* **UI/UX Design:** N/A: no user interface in this step.
* **Non-Functional Requirements:** No data migration that loses files; expand/contract only. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `security.scope_denied (audit)`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-43).

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Security fixed (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** security, knowledge

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: no user interface in this step.
- [ ] Dependencies have been identified and are unblocked (none).
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
