# [US-043] Fix /api/config secret exposure: category allowlist, server-side deny, masking

> Backlog task NZR-43 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-007, FR-015.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** settings endpoints to never return a stored secret to anyone
* **So that** no signed-in user can read our OAuth, Slack signing or MCP credentials

---

## 2. Business Context & Description
* **Background:** Grill round 4 (Q81): the most severe open item. `GET /api/config/*` has no capability check and returns stored OAuth, Slack signing and MCP secrets to any signed-in user (finding #1 of 2026-08-11, still in `handler.ts` at d1d3a66). Fixed first, before NZR-5, because both touch the same file. Rotate secrets only after the patch merges, and check the audit log for who read them. Legacy app.pgnos.ai is NOT redeployed (Q84): it is marked known-vulnerable, holds no real data, and its secrets are rotated (owner yes for each AWS call).
* **Target Value:** 0 secret values returned by any /api/config route in tests; exposure window reviewed from the audit log.
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Allowed category
* **Given** an admin
* **When** they read a non-secret config category on the allowlist
* **Then** the values return as before

### Scenario 2: Secret category denied
* **Given** any signed-in user, admin included
* **When** they request a secret category (OAuth, Slack signing, MCP credentials)
* **Then** the server refuses (403) whatever the client sends, and the attempt is audited

### Scenario 3: Masking
* **Given** a config response that contains a field marked secret
* **When** it is returned
* **Then** the value is masked (for example `****abcd`), never in full

### Scenario 4: Unknown category
* **Given** a category not on the allowlist
* **When** it is requested
* **Then** it is refused by default

### Scenario 5: Rotation after patch
* **Given** the patch is merged
* **When** the owner rotates the exposed secrets
* **Then** an audit-log query lists who read `/api/config/*` before the fix, and the rotation date is recorded

---

## 4. Technical Notes & Constraints
* **Dependencies:** None.
* **UI/UX Design:** N/A: API fix; Settings screens keep working with masked values.
* **Non-Functional Requirements:** Default-deny allowlist; server-side check; existing tests still pass. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `security.config_denied (audit)`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44).

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Security fixed (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** security, urgent

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: API fix; Settings screens keep working with masked values.
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
