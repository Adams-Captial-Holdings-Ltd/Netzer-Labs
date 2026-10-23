# [US-003] Clean-clone builder workspace on the VPS (no .env, lockfile installs)

> Backlog task NZR-3 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-006, NFR-007.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** builders to work in a clean clone of Netzer-Labs with no secrets, installed only from the lockfile
* **So that** no build session can leak a secret or pull in an unreviewed dependency

---

## 2. Business Context & Description
* **Background:** Rewritten for the VPS gauntlet (Q59). The clone is the only place builders, Playwright and axe run. Installs per Q78: `npm ci --prefix web` from the lockfile only (never `npm install`), Playwright chromium from its official download, one at a time because the VPS has 3.9 GB RAM. Fetch before every build (Q74).
* **Target Value:** 0 secrets found in the clone; 0 lockfile drift; build sessions start from a fetched origin/development.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Clean clone is secret-free
* **Given** the clone was created from origin/development
* **When** the secret scan (`node scripts/ci/secret-scan.mjs`) and a search for `.env*` run on it
* **Then** both report nothing and the result is logged

### Scenario 2: Lockfile-only installs
* **Given** the clone has no node_modules
* **When** `npm ci --ignore-scripts`, then `npm ci --prefix web`, then the Playwright chromium download run one at a time
* **Then** all three succeed, `git status` shows no lockfile change, peak memory stays under the VPS limit

### Scenario 3: Push is blocked
* **Given** a builder session runs in the clone
* **When** it tries `git push` without an owner yes recorded for that push
* **Then** the push is refused and the attempt is logged

---

## 4. Technical Notes & Constraints
* **Dependencies:** None.
* **UI/UX Design:** N/A: no user interface in this step.
* **Non-Functional Requirements:** Peak RAM < 3.5 GB during installs (serial). No credentials in the clone. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Factory ready (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** factory, urgent

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: no user interface in this step.
- [ ] Dependencies have been identified and are unblocked (none).
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
