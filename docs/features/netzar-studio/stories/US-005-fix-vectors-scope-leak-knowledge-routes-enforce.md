# [US-005] Fix /vectors scope leak: knowledge routes enforce agent scope

> Backlog task NZR-5 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-012, FR-029, NFR-007, NFR-010.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** every `/vectors*` route to check the caller's access to the requested scope
* **So that** no user can read another agent's private knowledge

---

## 2. Business Context & Description
* **Background:** Known leak found in discovery: `/vectors`, `/vectors/search` and `/vectors/answer` accept any scope. Owner rule (Q82), defined in SECURITY.md: admins and the agent's own runtime read an agent's private scope; everyone else reads shared/company scopes and their own chat files only. Q62/Q75: patched in week 0 as a T3 security-boundary step (failing test first, highest effort, owner review), in parallel with the docs because the files don't overlap. SECURITY.md cites this step's tests as evidence.
* **Target Value:** 0 successful cross-scope reads in permission tests (NFR-010).
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Admin reads private
* **Given** an admin
* **When** they call `/vectors/search` on agent X's private scope
* **Then** results return (one test for the admin role)

### Scenario 2: Agent runtime reads its own private
* **Given** agent X running a turn
* **When** it searches its own private scope
* **Then** results return; it cannot search agent Y's private scope (one test for the agent role)

### Scenario 3: Viewer limited to shared + own chat files
* **Given** a viewer
* **When** they call `/vectors`, `/vectors/search` or `/vectors/answer` on any agent's private scope
* **Then** each returns 403 with a plain error, no data, and an audit entry; shared/company scopes and their own chat files still work (one test for the viewer role)

### Scenario 4: No scope given
* **Given** any viewer
* **When** they call a `/vectors*` route with no or a malformed scope
* **Then** the request is rejected (400) rather than defaulting to a broad scope

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-43 / US-043](US-043-fix-api-config-secret-exposure-category-allowlist.md) Fix /api/config secret exposure: category allowlist, server-side deny, masking
* **UI/UX Design:** N/A: no user interface in this step.
* **Non-Functional Requirements:** Authz checked server-side; existing 4,634+ tests still pass. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `security.scope_denied (audit)`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44).

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Security fixed (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** security, knowledge, urgent

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: no user interface in this step.
- [ ] Dependencies have been identified and are unblocked (NZR-43).
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
