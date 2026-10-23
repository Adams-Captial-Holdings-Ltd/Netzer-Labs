# [US-009] Foundation PLAN docs + user stories (this docs PR)

> Backlog task NZR-9 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-001, OBJ-007.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** the PRD, constraints, architecture, data model, security, deploy and design docs plus the story set in the repo
* **So that** every builder and reviewer works from the same written plan

---

## 2. Business Context & Description
* **Background:** Q48: before step 1 of new feature work, write PRD, CONSTRAINTS, ARCHITECTURE, DATA-MODEL, SECURITY, DEPLOY and design.md (OBSERVABILITY and TEST-STRATEGY are C1 stories). Q70: 1 plan story + step stories now; task stories at each step's planning. Lands as ONE docs PR cut from origin/development (Q74). Nothing under src/, web/ or infra/ (Q80).
* **Target Value:** PLAN gate (enterprise-planning section 4) passes; docs CI green.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Docs complete
* **Given** the branch `docs/netzar-studio-stories`
* **When** `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/docs-links.mjs` run
* **Then** both pass

### Scenario 2: Traceability
* **Given** the PRD FR/NFR/AC IDs
* **When** the stories are checked
* **Then** every in-scope MVP ID is cited by at least one story and every story cites at least one ID

### Scenario 3: Docs-only
* **Given** the branch diff against origin/development
* **When** it is inspected
* **Then** no file under src/, web/ or infra/ changed

---

## 4. Technical Notes & Constraints
* **Dependencies:** None.
* **UI/UX Design:** N/A: documentation; the mocks it contains are the UI artifacts for later stories.
* **Non-Functional Requirements:** docs/assets budget: no file > 2 MB; every screenshot has a provenance sidecar. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Foundation PLAN (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 8 (raw estimate 8 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T1 · **Deploy reach:** local only · **Labels:** docs, plan

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: documentation; the mocks it contains are the UI artifacts for later stories.
- [ ] Dependencies have been identified and are unblocked (none).
- [ ] The team has reviewed and estimated the story points (8 pts; re-checked at the Nov 9 re-plan, Q71).
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
