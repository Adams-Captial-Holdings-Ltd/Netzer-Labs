# [US-035] Triggers: webhook + API

> Backlog task NZR-35 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-011, AC-026.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** a workflow to start when data arrives at a webhook
* **So that** it works on real incoming documents

---

## 2. Business Context & Description
* **Background:** Per NZR-13 contract.
* **Target Value:** Authenticated, rate-limited webhook starts a run.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Start
* **Given** an active workflow with a webhook
* **When** a valid signed request arrives
* **Then** a run starts and the caller gets a run id

### Scenario 2: Bad request
* **Given** an unsigned or malformed payload
* **When** it arrives
* **Then** it is rejected with a clear error and no run starts

### Scenario 3: Repeat
* **Given** the same idempotency key twice
* **When** both arrive
* **Then** only one run starts

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-34 / US-034](US-034-live-engine-v1-chosen-option.md) Live engine v1 (chosen option)
* **UI/UX Design:** N/A: API; trigger setup screen is listed in design.md inventory.
* **Non-Functional Requirements:** Auth + schema + rate limit per contract. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `trigger.received`, `trigger.rejected`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-43).

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 6 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: API; trigger setup screen is listed in design.md inventory.
- [ ] Dependencies have been identified and are unblocked (NZR-34).
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
