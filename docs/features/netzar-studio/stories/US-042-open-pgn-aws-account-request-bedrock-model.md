# [US-042] Open PGN AWS account + request Bedrock model access (owner, drop-dead Nov 9)

> Backlog task NZR-42 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-006.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** a standalone AWS account with Bedrock Claude access
* **So that** the drafter can be re-measured on the real model and the pilot can be deployed

---

## 2. Business Context & Description
* **Background:** Q60. About an hour of the owner's time this week. Drop-dead Nov 9 (C1 gate). If Bedrock is not usable by Nov 23, C3 is re-planned. The account hosts the managed pilot (Q64).
* **Target Value:** Account open and Bedrock access granted by Nov 9.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Account ready
* **Given** the owner opened a standalone account
* **When** `aws sts get-caller-identity` runs with the new profile and the Bedrock console shows the requested Claude model ids as granted
* **Then** the account id and grant date are recorded in the HANDOFF

### Scenario 2: Bedrock late
* **Given** Bedrock access is not granted by Nov 23
* **When** the Nov 23 gate runs
* **Then** C3 is re-planned and the pilot date is reset with the owner

---

## 4. Technical Notes & Constraints
* **Dependencies:** None.
* **UI/UX Design:** N/A: owner task in the AWS console.
* **Non-Functional Requirements:** Account is standalone (not Organizations-managed), as the install requires. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Factory ready (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 1 (raw estimate 1 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** N/A · **Deploy reach:** pilot · **Labels:** needs-owner, deploy, urgent

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: owner task in the AWS console.
- [ ] Dependencies have been identified and are unblocked (none).
- [ ] The team has reviewed and estimated the story points (1 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] N/A: no code (owner/business task).
- [ ] Peer code review is completed and approved. N/A: owner/business task, no code. Evidence is the artifact named in the acceptance criteria.
- [ ] N/A: no code; evidence is the artifact in the acceptance criteria.
- [ ] UAT: the owner confirms the acceptance criteria are met.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Deployed to the PGN AWS pilot account with the owner's yes for that deploy; `npm run verify` green. Production reach stays blocked until the drafter is re-measured on Bedrock (Q58).
