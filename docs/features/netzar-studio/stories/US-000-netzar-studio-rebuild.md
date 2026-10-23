# [US-000] Netzar Studio rebuild: describe a business process, get a tested workflow

> Plan-level story for the whole Gauntlet. Every step story (US-003 to US-049) rolls up to this one. Blueprint: [blueprint v2](../blueprint.md). Backlog: [backlog](../backlog.md). Requirement IDs: OBJ-001, OBJ-002, OBJ-005, OBJ-006, OBJ-007, OBJ-008, FR-001, FR-004, FR-005, FR-008, FR-009, FR-012.

## 1. User Story Statement
* **As a** Persona B, business process owner at an insurance agency (PRD 1.3), with Persona A (first-time AI user) as the bar for ease of use
* **I want** to describe a business process in plain words and get a correct, understandable workflow I can test safely and then run on real incoming documents
* **So that** I automate real work without writing code or hiring a developer, and PGN gets its first paying design partner

---

## 2. Business Context & Description
* **Background:** Today Netzar is a 28-tab dashboard built for operators. The PRD (v1.1) and two owner grills (Q1 to Q80) turned it into a smaller product: a conversational Workflow Studio inside a 5-area Workspace, with today's dashboard kept as an Admin console. Workflows are versioned data. Paperclip is replaced (retired in January). The build runs through the VPS gauntlet-loop: Codex builds, a fresh Claude critic checks, nothing merges or deploys without the owner's yes.
* **Target Value:** By 2026-12-31 one design partner runs the golden workflow (insurance policy review) on a live webhook in a deployed install and agrees to a paid pilot or LOI (Q63). Leading indicators: drafter >= 70% on the live eval at Nov 23 (kill line) and >= 80% target; >= 4 of 5 non-technical testers build and test the golden workflow unaided in <= 20 minutes.
* **User Persona Profile:** PRD section 1.3 personas A, B and E, plus the Factory operator for C0 work and the Design partner for the pilot ([PRD](../foundation/PRD.md)). Personas C (power user) and D (developer) are out of scope until 2027.

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: A non-technical user builds and tests the golden workflow
* **Given** a local install with the insurance agent and a synthetic policy PDF
* **When** a first-time user opens Workflows, describes "review new policies, list the gaps, send me a report to approve", answers at most 3 questions, edits one step by chat and tests it with the sample
* **Then** they see a plain numbered workflow, per-step test results, a banner saying nothing was sent anywhere, and they finish in <= 20 minutes without help (4 of 5 testers)

### Scenario 2: The design partner runs it live
* **Given** the pilot install in PGN's AWS account, a published and approved golden workflow, and the partner's consent
* **When** the partner's system posts a policy document to the workflow's webhook
* **Then** the workflow runs, waits for the partner's approval, delivers the report, and the run is traceable in the audit log

### Scenario 3: The drafter is not good enough
* **Given** the live eval at the Nov 23 gate
* **When** the drafter scores under 70%
* **Then** UI work stops and the factory fixes the drafter before any Workspace step starts (Q72 kill rule)

### Scenario 4: The plan slips
* **Given** the Nov 9 fixed re-plan with real cost per step
* **When** the remaining points do not fit before Dec 31
* **Then** items are cut in the agreed order (NZR-39, NZR-37 already in January, NZR-29, NZR-18) and the owner confirms the new plan; nothing is cut silently

### Scenario 5: A security boundary is crossed
* **Given** any user without access to an agent's private knowledge or another user's chat files
* **When** they call any knowledge route or chat
* **Then** nothing is returned and the denial is audited (NFR-010; NZR-5, NZR-6); no settings route returns a stored secret (NZR-43)

---

## 4. Technical Notes & Constraints
* **Dependencies:** PGN AWS account with Bedrock access (NZR-42, drop-dead Nov 9); owner yes on NVIDIA free-tier terms before any repo code goes to NVIDIA (Q65); 5 testers booked by Nov 15 (NZR-47); 2 design-partner calls by Nov 23 (NZR-46). Full order in the [backlog](../backlog.md).
* **UI/UX Design:** [design.md](../foundation/design.md): full MOCK set for the Workflows slice (W-01 to W-10, desktop only (Q108), light); every other screen has an inventory row marked NO-MOCK-YET with a due date (Q77).
* **Non-Functional Requirements:** [CONSTRAINTS.md](../foundation/CONSTRAINTS.md): NFR-001 to NFR-010 as numbers (Home interactive <= 3 s p95, draft <= 45 s p95, WCAG 2.2 AA with 18px Workspace text and 44px targets, zero unauthorized actions, zero duplicate external writes, spend caps). Security: [SECURITY.md](../foundation/SECURITY.md). Scale: <= 50 users and about 1,000 runs/day per install.
* **Data & Analytics:** Named product events in the existing audit log as a separate event type with no personal data (Q55), catalogued in OBSERVABILITY.md (NZR-44). North-star: golden workflow completions (`journey.golden_completed`). Guardrails: drafter eval score, external writes during tests (must be 0), cost per draft.

---

## 5. Estimation & Tracking
* **Epic Name:** Netzar Studio rebuild (Plane project `NZR`, feature folder `docs/features/netzar-studio/`)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 205 points across 46 active step stories (C0 35, C1 37, C2a 35, C2b 57, C3 33, January 8). Tightest cycle: C2b (57 points in 2 weeks); first cuts NZR-29 and NZR-18.
* **Rigor tier:** T3 (architecture, data model, security boundary) · **Deploy reach:** local only until NZR-42; pilot (PGN AWS) in C3; production blocked until the drafter is re-measured on Bedrock (Q58)

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (owner grills Q1 to Q80).
- [ ] Acceptance criteria cover both happy paths and edge cases (scenarios 1 to 5).
- [ ] UX/UI designs are attached and finalized for the first slice (W-01 to W-10); other screens NO-MOCK-YET with dates.
- [ ] Dependencies have been identified and are unblocked (NZR-42 AWS account, NVIDIA terms yes, testers).
- [ ] The team has reviewed and estimated the story points (205; re-planned on Nov 9).
- [ ] Foundation PLAN docs pass the PLAN gate (NZR-9).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and adheres to team styling standards (every step story's DoD done).
- [ ] Peer code review is completed and approved (per-tier review layers, Q68; the builder never certifies its own work).
- [ ] Unit and automated tests are written and passing (full `npm test`, live eval at or above baseline, golden-workflow e2e).
- [ ] QA verification and UAT pass against the Acceptance Criteria (>= 4 of 5 testers; design partner live run).
- [ ] Documentation (feature docs, ADRs, runbooks) is updated and docs CI is green.
- [ ] Feature is safely deployed to the target environment: the PGN AWS pilot install, each deploy with the owner's yes; customer-hosted at GA.
