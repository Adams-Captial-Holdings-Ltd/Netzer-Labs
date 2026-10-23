# [US-032] Real tester sessions (5 non-technical people)

> Backlog task NZR-32 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-001, AC-001, AC-002, AC-005.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3)
* **I want** 5 real non-technical people to try the golden workflow (insurance policy review) on their own, one hour each
* **So that** we know it works for the people it is for: at least 4 of 5 build and test it unaided in 20 minutes or less

---

## 2. Business Context & Description
* **Background:**
  * C2b exit gate: "≥ 4 of 5 testers build + test the golden workflow unaided in ≤ 20 min" (`backlog.md:18`; CONSTRAINTS C-30; blueprint §8 item 4). 1 hour each, fixed task, synthetic documents (Q67). Booked under NZR-47.
  * PENDING OWNER Q109, recommendation applied: same bar, at least 2 of the 5 testers aged 60+, and "finished without tapping Help" tracked. If the owner picks "any ages", drop the age rule from the pass rule; tracking Help stays.
  * PENDING OWNER Q107: a "Help me" button on every screen. If it is not built by the sessions, "finished without Help" is `N/A`.
  * PENDING OWNER Q98/Q108: testers should look like "Margaret, 67"; iPad and desktop first.
  * Q51: UAT for golden-workflow stories = real testers. Q55: product events carry no personal data.
  * PRD Journey A acceptance criteria this story checks with people: AC-001 (reach the builder without developer settings), AC-002 (valid draft without code), AC-005 (test without a live external action) (`foundation/PRD.md:1636-1644`). Also reported: C-32 explain-back (4 of 5) and C-33 (≤ 3 clarifying questions).
  * Terms: **unaided** = no help from a person once the task card is handed over (re-reading the card is allowed; the product's own Help is allowed but counted). **Golden workflow** = the insurance policy review in `PRD.md:61-70`.
* **Current behaviour (d1d3a66): what exists.**
  * No tester sessions have run; no observation sheet or results file exists in the repo.
  * The product screens testers will use do not exist yet: the Workflows slice (NZR-49, NZR-23 to NZR-26), the golden workflow end to end (NZR-31) and the Workspace shell (NZR-15) are all backlog items. Mocks: [design.md](../foundation/design.md) W-001 to W-013.
  * The product event `journey.golden_completed` is named in NZR-31/NZR-32 and catalogued by NZR-44 (OBSERVABILITY.md, not written yet). No product-event code exists (`grep -rn "golden_completed" src` → nothing). UNVERIFIED: its fields; NZR-44 defines them.
  * The session script v2 comes from NZR-47 (US-047, Artifacts: "Session script"), tested in the Nov 23 dry-run.
* **Target behaviour:**
  * 5 sessions of 60 minutes held between Nov 24 and Dec 7 with T1–T5 from NZR-47 (backup B1 if needed), each on the same build commit, the same seeded synthetic policy and the same task card.
  * One observation sheet per tester, committed with initials only, filled in during the session.
  * One results file with the metrics table, the pass/fail decision, and the issues list.
  * Pass = ≥ 4 of 5 "completed unaided in ≤ 20:00" AND ≥ 2 of the 5 aged 60+ (PENDING OWNER Q109). "Finished without Help" reported per tester and in total.
  * Every problem seen is an issue `TST-nn` with a severity; blockers and majors become task stories at the next PLANNING.
  * On fail: the C3 start is re-decided with the owner, recorded in the results file.
* **Out of scope:**
  * Booking testers, consent, and the session script itself (NZR-47).
  * Fixing what the sessions find (new task stories).
  * The design partner's live run (NZR-48). Any real customer documents.
  * Measuring Admin console screens (Admin keeps its density; Workspace only).
* **Target Value:** ≥ 4 of 5 complete unaided in ≤ 20 minutes (C-30), with ≥ 2 of 5 aged 60+; also reported: finished without Help (count of 5), explain-back correct (≥ 4 of 5, C-32), live external actions during tests = 0 (C-12). Measured from the 5 observation sheets.
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3): "a business professional with limited technical or AI experience"; target Margaret, 67 (PENDING OWNER Q98). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Pass
* **Given** 5 valid sessions (T1–T5) on the same build commit, ≥ 2 of the 5 aged 60+
* **When** the results file is written
* **Then** ≥ 4 sheets show `completed_unaided: yes` with `time_to_result` ≤ `20:00`; the results file says `decision: PASS`, lists finished-without-Help as `n of 5` (or `N/A` if no Help button), and links all 5 sheets
* **Test:** evidence check › `handoffs/2026-12-DD-tester-sessions.md` metrics table; count of `completed_unaided: yes` ≥ 4

### Scenario 2: Fail
* **Given** fewer than 4 sessions show `completed_unaided: yes` within 20:00
* **When** results are reviewed
* **Then** the results file says `decision: FAIL`, every blocker/major `TST-nn` has a proposed task story, and an owner decision line records the C3 start (go / delay to <date> / re-test with 3 new testers after fixes)
* **Test:** evidence check › `decision: FAIL` + the owner decision line dated before the C3 start (2026-12-08)

### Scenario 3: Age rule not met (PENDING OWNER Q109)
* **Given** fewer than 2 of the 5 session testers are aged 60+
* **When** results are reviewed
* **Then** the decision is `INCOMPLETE` (not PASS), even if ≥ 4 completed, until more 60+ sessions run or the owner accepts "any ages" in writing
* **Test:** evidence check › `age_60_plus: n of 5` line + decision value

### Scenario 4: Help taken from a person
* **Given** the observer points, hints, or answers "where do I click" (anything beyond re-reading the task card), or the tester gives up and the observer shows the way
* **When** the sheet is filled in
* **Then** `completed_unaided: no` for that tester, `interventions` ≥ 1 with the time and the screen, and the session continues to collect findings
* **Test:** evidence check › sheet `interventions` list is non-empty for any `completed_unaided: no` caused by assistance

### Scenario 5: Over time
* **Given** a tester reaches the test result after 20:00
* **When** the sheet is filled in
* **Then** `completed_unaided: no`, `time_to_result` holds the real time, and the reason for the extra time is a `TST-nn` issue
* **Test:** evidence check › sheet time > 20:00 maps to an issue row

### Scenario 6: Product broke, not the tester
* **Given** the session cannot continue for a technical reason (model down screen W-002, crash, login failure, network)
* **When** the observer stops the session
* **Then** the sheet says `valid: no (technical: <reason>)`, the session is re-booked (B1 or the same tester on a new day if they agree), and a `blocker` issue is opened; invalid sessions do not count toward the 5
* **Test:** evidence check › `valid: no` sheet + its `TST-nn` blocker + a replacement sheet

### Scenario 7: Live external action during a test
* **Given** a tester's test run
* **When** the observer checks the result screen and the run record
* **Then** "nothing was sent" (W-010) holds; if anything was sent outside the sandbox, the session is marked `AC-005: FAIL`, a `blocker` issue opens, and sessions stop until it is fixed (C-12)
* **Test:** evidence check › each sheet `AC-005: pass`; results file `external_actions: 0`

### Scenario 8: No personal data
* **Given** 5 sheets and the results file
* **When** they are committed
* **Then** they contain only codes, initials, age band and device; no names, emails, phone numbers, employers, quotes that identify a person, or document text from a real source; any recording stays off-repo
* **Test:** evidence check › `grep -nE "@|[0-9]{3}[-. ][0-9]{3}[-. ][0-9]{4}"` on the handoff files returns nothing

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-31 / US-031](US-031-golden-workflow-end-to-end-insurance-policy.md) Golden workflow end to end: insurance policy review; [NZR-15 / US-015](US-015-workspace-shell-home-agents-workflows-my-work.md) Workspace shell: Home, Agents, Workflows, My Work, Library; [NZR-47 / US-047](US-047-book-5-testers-friendly-dry-run-synthetic.md) Book 5 testers + friendly dry-run (synthetic documents)
* **UI/UX Design:** N/A: uses the built screens (Workflows slice W-001 to W-013 in [design.md](../foundation/design.md) as the reference; screen IDs are used in issue rows).
* **Non-Functional Requirements:** No tester personal data in the repo. Same build commit, same sample, same task card for all 5. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md) (C-30, C-32, C-33, C-12, C-18).
* **Data & Analytics:** `journey.golden_completed`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Used here as a cross-check only: the observer's sheet is the source of truth for timing and "unaided".

* **Steps (who does what):**
  1. **Zion, at C2b PLANNING (by Nov 24).** Confirm NZR-31 passes on the chosen build; record the build commit; pick where sessions run (open decision D2: rebuild staging with synthetic data if it exists by then, else the local build; no public tunnel, see US-047). Print 5 task cards and 5 observation sheets.
  2. **Owner, 2 days before each slot.** Remind the tester; confirm consent is recorded (NZR-47 table).
  3. **Zion, 30 min before each slot.** Reset to a fresh workspace with the insurance Helper and the seeded synthetic policy; confirm nothing from the previous tester remains; open the observation sheet.
  4. **Owner (observer) + Zion (note-taker, optional), the session (60 min).** Run session script v2 from US-047. Observer keeps silent during the task; times with a stopwatch; fills the sheet.
  5. **Zion, same day (20 min).** Type the sheet into `handoffs/2026-12-DD-tester-Tn.md` (or one file per day); write `TST-nn` issues; delete the tester's drafts/tests from the install; delete any screen recording within 30 days.
  6. **Zion, after session 5 (1 h).** Write the results file, compute the metrics, apply the pass rule, propose task stories for blockers/majors.
  7. **Owner, before Dec 8.** Read the results; on FAIL or INCOMPLETE record the C3 decision line.
* **Artifacts:**
  * `docs/features/netzar-studio/handoffs/2026-12-DD-tester-Tn.md` (one per session, or one per session day) holding the observation sheet:
    ```markdown
    ## Observation sheet: T<n>
    - initials: __   age band: 60+ / under 60   device: iPad / desktop / phone   mode: in person / remote control
    - build commit: <sha>   sample: <synthetic policy file name>   date: 2026-__-__   observer: owner   valid: yes / no (technical: __)
    - task card handed over at: mm:ss (timer 00:00)
    | Time | Screen (W-0xx) | What the tester did / said (no names) | Help taps | Observer action |
    |---|---|---|---|---|
    - reached builder without developer settings (AC-001): yes / no
    - got a valid draft without code (AC-002): yes / no   clarifying questions answered: n (C-33 ≤ 3)
    - picked the insurance Helper: yes / no
    - tested with the sample, nothing sent (AC-005): pass / FAIL
    - time_to_result: mm:ss   completed_unaided: yes / no   interventions: [time, screen, what]
    - help_taps: n   finished_without_help: yes / no / N/A
    - explain-back (C-32): mentions a) starts when a new policy arrives b) Helper checks for gaps c) writes a report d) sent to me to approve first → correct (≥ 3 incl. d) / partly / no
    - words the tester asked about: [...]
    - confidence 1–5: n   would use at work: yes / maybe / no
    - issues: TST-__, TST-__
    ```
  * `docs/features/netzar-studio/handoffs/2026-12-DD-tester-sessions.md` (results file):
    ```markdown
    build commit: <sha>   where: staging / local   sessions: 5 valid (+ n invalid)
    | Code | Age band | Device | time_to_result | completed_unaided | help_taps | finished_without_help | explain-back | AC-001 | AC-002 | AC-005 |
    |---|---|---|---|---|---|---|---|---|---|---|
    completed_unaided: n of 5 (need ≥ 4)   age_60_plus: n of 5 (need ≥ 2, PENDING OWNER Q109)
    finished_without_help: n of 5 (or N/A)   explain-back correct: n of 5 (C-32 target 4)   external_actions: 0
    median time_to_result: mm:ss
    decision: PASS / FAIL / INCOMPLETE
    owner decision (if not PASS): <date> <go / delay to date / re-test>
    ## Issues
    | ID | Severity | Testers | Screen | What happened (observer words) | Proposed action |
    ```
  * **Metrics (definitions):**
    * `time_to_result`: stopwatch from the task card handover to the moment the test result/report is on screen (W-010) for a draft that uses the insurance Helper.
    * `completed_unaided`: yes only if `time_to_result` ≤ 20:00 AND 0 interventions AND the session is valid.
    * `finished_without_help`: yes only if `completed_unaided` = yes AND `help_taps` = 0. `N/A` if no Help button exists.
    * `help_taps`: taps on "Help me" (or any built-in help), counted by the observer; cross-check with a product event if NZR-44 defines one (UNVERIFIED: none named yet).
    * `explain-back`: scored by the observer with the 4 points on the sheet.
    * `journey.golden_completed` count in the session's time window: cross-check only (UNVERIFIED: event fields).
  * **What becomes an issue (`TST-nn`):**
    * **blocker:** stopped a tester from finishing, caused any external action (C-12), showed another tester's data, or broke the session (Scenario 6). → task story before the C3 start; sessions pause if it is a C-12 or data case.
    * **major:** cost a tester more than 2 minutes, OR was seen with 2 or more testers, OR led to 2 or more Help taps on one screen. → task story at the next PLANNING (C3 or January, owner picks).
    * **minor:** one tester, under 2 minutes. → listed in the results file; batched into one cleanup story.
    * **word:** any on-screen word a tester asked the meaning of. → proposed for the plain-words list (PENDING OWNER Q99) and the CI word-list check.
    * Not an issue: a tester's opinion with no observed problem (kept in the debrief notes).
* **Evidence (what proves done):** 5 valid observation sheets, the results file with `decision:` and, if not PASS, the owner decision line. Docs CI green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/secret-scan.mjs`.
* **Security notes (data rules):**
  * Initials, age band, device only (C-17 spirit, Q55). No quotes that identify a person. Recordings off-repo, deleted in 30 days.
  * Synthetic documents only (Q67, C-18). If a tester types real names or clients, follow US-047 Scenario 8.
  * If sessions run on rebuild staging: the install holds synthetic data only (DEPLOY §5); tester access is a magic-link principal with seat-user or viewer profile, removed after the session (SECURITY.md §5 control 9 pattern). Local build: the NVIDIA dev model sees tester-typed text (test data only, Q65).
  * C-12/AC-005: zero external writes during tests. Any write is a blocker and stops the sessions.
  * Reset the workspace between testers so one tester never sees another's work.
* **Test plan:** No code is written in this story. Before sessions: NZR-31's e2e test passes on the session build commit (its own test file, named in US-031). After: the docs checks above and the Scenario 8 grep.
* **Repo rules that apply:** Feature-doc framework ([docs/features/README.md](../../README.md)) §6a (session handoffs with frontmatter; HANDOFF lists them newest first). Task stories for fixes are written at PLANNING before code (Q70). Plane mirror of issues needs the owner's yes (Q53). No push without the owner's yes (Q80).
* **Rollback:** N/A: nothing is deployed or changed in product. A bad session is marked invalid and re-run (Scenario 6).
* **Build slices (proposal):** (1) Session prep + build check, 1 h (Zion). (2) 5 sessions × 1 h + 20 min write-up each (owner + Zion). (3) Results, pass rule, issue triage, 1 h (Zion) + owner decision 15 min.
* **Agent gotchas:**
  * Do not count an invalid (technical) session as a fail or a pass; re-run it.
  * "Unaided" is about people, not the product's Help button: a Help tap does not fail the session, it only fails "finished without Help".
  * Do not change the task card, sample or build between sessions; if a blocker forces a fix mid-week, the sessions after the fix are a new round and must be reported separately.
  * The NZR-31 e2e passing is not evidence that people can do it; only the sheets are.
  * The plain-words decision (Q99) may change labels after the mocks; issue rows use screen IDs (W-0xx), not labels, so they survive the rename.

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** N/A · **Deploy reach:** local only · **Labels:** needs-owner, gate

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona A / Margaret, 67; benefit = proof with real people).
- [ ] Acceptance criteria cover both happy paths and edge cases (pass, fail, age rule, assistance, over time, technical failure, external action, personal data).
- [ ] UX/UI designs: N/A: uses the built screens; reference = design.md W-001 to W-013.
- [ ] Dependencies have been identified and are unblocked (NZR-31 e2e green on the session build; NZR-15 shell merged; NZR-47 bookings with ≥ 2 aged 60+ and script v2).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70). N/A: no code here; fix stories come from the `TST-nn` issues.

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] N/A: no code (owner/business task).
- [ ] Peer code review is completed and approved. N/A: owner/business task, no code. Evidence is the 5 observation sheets and the results file.
- [ ] N/A: no code; evidence is the artifact in the acceptance criteria. Docs checks green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/secret-scan.mjs`.
- [ ] QA: the fresh critic re-runs the gate against these criteria (recomputes the metrics table from the 5 sheets). UAT: real non-technical testers (synthetic documents only).
- [ ] Documentation is updated: feature HANDOFF + dated session handoffs (sheets + results); the C2b gate record links the results file; durable numbers (pass rate, median time) promoted to the feature README at the gate.
- [ ] N/A: nothing to deploy.
