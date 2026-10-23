# [US-010] Local model env: Floci + NVIDIA dev backend (test data only)

> Backlog task NZR-10 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-009.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** the real drafter to run locally against an NVIDIA-hosted model through the Bedrock client
* **So that** we can build and evaluate before the AWS account exists

---

## 2. Business Context & Description
* **Background:** Bedrock is unavailable to dev until NZR-42. Q65: NVIDIA is fine as the dev model backend with test data only; no repo code goes to NVIDIA without the owner's yes on the free-tier terms.
* **Target Value:** One agent turn with tool use succeeds locally.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Floci upgraded safely
* **Given** Floci pinned at 1.6.0 (no streaming, no embeddings)
* **When** the dev container is moved to 2.1.0 or later (ConverseStream proxy; 2.0.0 was a major release), pinned by digest, with Zion's yes for the pull
* **Then** the existing local smoke tests pass before anything else uses it

### Scenario 2: Turn succeeds
* **Given** Floci running and the dev proxy configured
* **When** a test agent runs one turn with a tool call, streamed
* **Then** the turn completes and the cost ledger records it

### Scenario 3: Keyword search caveat
* **Given** no embeddings locally
* **When** knowledge search runs in dev
* **Then** it uses keyword search, and every local drafter eval result is labelled 'knowledge: keyword, not representative' until re-measured on Bedrock

### Scenario 4: Only test data
* **Given** a prompt containing anything other than seeded test data
* **When** it would be sent to the dev backend
* **Then** the runbook forbids it and the sample set is the only input used by scripts

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-3 / US-003](US-003-clean-clone-builder-workspace-on-the-vps.md) Clean-clone builder workspace on the VPS (no .env, lockfile installs)
* **UI/UX Design:** N/A: developer environment.
* **Non-Functional Requirements:** No app code change; config only. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** devenv

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: developer environment.
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
