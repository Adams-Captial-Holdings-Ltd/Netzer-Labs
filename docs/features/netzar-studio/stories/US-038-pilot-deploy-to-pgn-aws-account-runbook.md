# [US-038] Pilot deploy to PGN AWS account + runbook

> Backlog task NZR-38 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-006.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** Netzar deployed in PGN's AWS account for the pilot
* **So that** the design partner can use it for real

---

## 2. Business Context & Description
* **Background:** Q63/Q64: managed pilot in PGN's own AWS account under a written exception; no customer production data; partner consent. Each deploy is its own owner yes. Production reach stays blocked until the drafter is re-measured on Bedrock (Q58).
* **Target Value:** Install verified (npm run verify green).
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Deployed
* **Given** owner yes for this deploy
* **When** the repo's own `npm run up` is run from the VPS against the new account (no GitHub Actions, no hand-made steps)
* **Then** verify is green and the dashboard URL works

### Scenario 2: Chat channels off
* **Given** the pilot install
* **When** it is configured
* **Then** Telegram and Slack are not connected (Q93)

### Scenario 3: Staging branch guarded
* **Given** the old `staging` auto-deploy
* **When** the pilot plan is reviewed
* **Then** the owner has disabled that workflow or protected the branch in GitHub settings (Q91)

### Scenario 4: Not re-baselined
* **Given** the Bedrock eval re-baseline is missing
* **When** a deploy is attempted
* **Then** it stops before deploy with the reason

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-42 / US-042](US-042-open-pgn-aws-account-request-bedrock-model.md) Open PGN AWS account + request Bedrock model access (owner, drop-dead Nov 9); [NZR-35 / US-035](US-035-triggers-webhook-api.md) Triggers: webhook + API; [NZR-36 / US-036](US-036-publish-activate-approval-rollback.md) Publish / Activate (approval) / Rollback
* **UI/UX Design:** N/A: deployment.
* **Non-Functional Requirements:** Cost tier T0 ~$65-95/month; rollback rehearsed. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** pilot · **Labels:** needs-owner, deploy

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: deployment.
- [ ] Dependencies have been identified and are unblocked (NZR-42, NZR-35, NZR-36).
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
- [ ] Deployed to the PGN AWS pilot account with the owner's yes for that deploy; `npm run verify` green. Production reach stays blocked until the drafter is re-measured on Bedrock (Q58).
