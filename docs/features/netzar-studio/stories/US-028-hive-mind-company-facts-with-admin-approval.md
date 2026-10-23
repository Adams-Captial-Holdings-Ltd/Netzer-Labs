# [US-028] Hive Mind -> Company facts with admin approval queue

> Backlog task NZR-28 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-012, FR-023.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** new company-wide facts to wait for my approval
* **So that** no agent spreads an unapproved claim to everyone

---

## 2. Business Context & Description
* **Background:** Today Hive Mind writes go global without approval, from two writers (log_to_hive and memory-ingest), and items self-expire. Both writers and the read path are gated (ARCHITECTURE R13, DATA-MODEL risk 5).
* **Target Value:** 0 unapproved facts reach agents (tested).
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Queued
* **Given** an agent proposes a fact
* **When** it is saved
* **Then** it lands in the queue and no agent sees it yet

### Scenario 2: Approved
* **Given** an admin approves it
* **When** an agent next answers
* **Then** the fact is available

### Scenario 3: Rejected
* **Given** an admin rejects it
* **When** an agent next answers
* **Then** the fact is never used and the rejection is audited

### Scenario 4: Approved facts don't expire
* **Given** an approved fact older than today's Hive TTL
* **When** the TTL would have removed it
* **Then** it is still present (approved facts are stored without TTL)

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-5 / US-005](US-005-fix-vectors-scope-leak-knowledge-routes-enforce.md) Fix /vectors scope leak: knowledge routes enforce agent scope
* **UI/UX Design:** design.md screen inventory (NO-MOCK-YET). See [design.md](../foundation/design.md).
* **Non-Functional Requirements:** Audit every decision. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `fact.proposed`, `fact.approved`, `fact.rejected`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44).

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** knowledge, security

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs are attached and finalized: design.md screen inventory (NO-MOCK-YET) (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-5).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews the security boundary.
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51).
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
