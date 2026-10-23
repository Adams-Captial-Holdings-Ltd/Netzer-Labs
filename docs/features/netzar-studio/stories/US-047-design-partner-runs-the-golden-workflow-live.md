# [US-047] Design partner runs the golden workflow live + paid pilot or LOI

> Backlog task NZR-47 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-008, OBJ-005. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Design partner (first insurance agency; Q63)
* **I want** to run my policy review on Netzar for real
* **So that** I can decide to pay for a pilot

---

## 2. Business Context & Description
* **Background:** Q63 Dec 31 definition of done.
* **Target Value:** 1 partner live run + signed pilot or LOI by Dec 31.
* **User Persona Profile:** Design partner (first insurance agency; Q63). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Live run
* **Given** the pilot install and a partner-consented webhook
* **When** the partner sends a policy
* **Then** the workflow runs and the partner approves the report

### Scenario 2: No agreement
* **Given** the partner declines
* **When** Dec 31 arrives
* **Then** the reason is recorded and the January plan changes

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-38 / US-038](US-038-pilot-deploy-to-pgn-aws-account-runbook.md) Pilot deploy to PGN AWS account + runbook; [NZR-45 / US-045](US-045-business-brief-icp-single-pain-price-hypothesis.md) Business brief: ICP, single pain, price hypothesis, 2 partner calls
* **UI/UX Design:** N/A: business outcome.
* **Non-Functional Requirements:** Partner consent recorded; no customer production data. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 2 (raw estimate 2 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** N/A · **Deploy reach:** pilot · **Labels:** needs-owner, business, gate

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases.
- [ ] UX/UI designs: N/A: business outcome.
- [ ] Dependencies have been identified and are unblocked (NZR-38, NZR-45).
- [ ] The team has reviewed and estimated the story points (2 pts; re-checked at the Nov 9 re-plan, Q71).
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
