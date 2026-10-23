# [US-047] Book 5 testers + friendly dry-run (synthetic documents)

> Backlog task NZR-47 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-001. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3)
* **I want** 5 non-technical testers (at least 2 aged 60+) booked into 1-hour slots, and one friendly dry-run of the session on Nov 23
* **So that** the C2b tester gate (NZR-32) can actually run: 5 of 5 slots booked by Nov 15 with consent sent, and the session script tested once before real testers see it

---

## 2. Business Context & Description
* **Background:**
  * Q67: synthetic documents only; book 5 testers by Nov 15; one friendly dry-run on Nov 23.
  * PENDING OWNER Q109 (round 5), recommendation applied: same pass bar (≥ 4 of 5 unaided in ≤ 20 min), but at least 2 of the 5 testers are aged 60+, and "finished without tapping Help" is tracked. If the owner says "any ages", drop the 60+ rule from Scenario 1 and 2; nothing else changes.
  * PENDING OWNER Q98: design target "Margaret, 67" (office manager, email + Facebook on an iPad, has never heard the word "workflow"). PENDING OWNER Q108: iPad and desktop first; phone works.
  * C2a exit gate (Nov 23) includes "friendly dry-run done" (`backlog.md:17`). C2b exit gate is the NZR-32 tester result (`backlog.md:18`; CONSTRAINTS C-30).
  * Terms: **friendly dry-run** = one practice session with a forgiving person, to find problems in the product and in our script before real testers come. **Unaided** = no help from a person during the task.
* **Current behaviour (d1d3a66): what exists.**
  * No tester list, consent text or session script exists in the repo (grep for "tester" in `docs/features/netzar-studio/` finds only the plan lines: blueprint, backlog, CONSTRAINTS C-30/C-32, DEPLOY §3).
  * The task testers will do is Journey A ([PRD.md](../foundation/PRD.md) §10, `PRD.md:1612-1646`): describe the policy-review process, get a draft, pick the insurance Helper, test with a sample, understand the result.
  * Sample document: design.md W-008 plans "seeded samples to pick from (synthetic policy PDF)" (`foundation/design.md:168`). UNVERIFIED: no synthetic policy file is in the repo at d1d3a66 (`git ls-files | grep -i polic` finds only story files). NZR-26/NZR-31 must add it.
  * Where testers can reach the product on Nov 23: only a local build (VPS or operator machine) with the NVIDIA dev model (DEPLOY §1). Rebuild staging waits for NZR-42 + Bedrock (late Nov). Open decision D2 in DEPLOY.md: "how testers reach the Nov 23 dry-run (local tunnel vs rebuild staging)". Recommendation used here: no public tunnel; in person on the operator's machine, or a video call where the tester takes remote control of the operator's browser. Public tunnels are deferred to NZR-35's security review (Q92).
* **Target behaviour:**
  * 5 testers + 1 backup booked by Nov 15 into 1-hour slots between Nov 24 and Dec 7 (C2b), each recorded in the repo by code and initials only.
  * At least 2 of the 5 are aged 60+ (PENDING OWNER Q109). At least 2 will use an iPad (PENDING OWNER Q108).
  * Every booked tester has received the consent note; consent is recorded yes/no with a date before their slot.
  * One friendly dry-run held on Nov 23 with a 7th person (not one of the 5), using the session script below.
  * Dry-run findings are written as a numbered list; each one is either fixed in the script, or becomes a backlog/task item for C2b PLANNING.
  * The session script is final (v2) by Nov 24, ready for NZR-32.
* **Out of scope:**
  * Running the 5 real sessions and judging pass/fail (NZR-32).
  * Building the sample policy (NZR-26 / NZR-31) or the Help button (round 5 Q107, no story yet).
  * Paying testers (owner decision; see NOTES).
  * Any real customer or partner documents (NZR-48 covers the partner, with its own rules).
* **Target Value:** 5 of 5 booked + 1 backup by Nov 15 (≥ 2 aged 60+); consent sent to 6 of 6; dry-run held on Nov 23 with ≥ 1 finding list committed. Measured from the bookings and dry-run handoff files.
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3): "a business professional with limited technical or AI experience". Testers should look like Margaret (Q98). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Five booked by Nov 15
* **Given** the owner has recruited testers
* **When** Nov 15 arrives
* **Then** `handoffs/2026-11-15-tester-bookings.md` has rows T1–T5 plus B1 (backup), each with initials (2–3 capital letters), age band (`60+` or `under 60`), device, slot (date + time, between 2026-11-24 and 2026-12-07), mode (`in person` / `remote control`), and `consent sent: yes`; at least 2 of T1–T5 show `60+`
* **Test:** evidence check › the bookings table; count of `60+` in T1–T5 ≥ 2

### Scenario 2: Not enough testers aged 60+ (PENDING OWNER Q109)
* **Given** fewer than 2 of T1–T5 are `60+` on Nov 15
* **When** the owner checks bookings
* **Then** the HANDOFF "Open owner items" says "NZR-47: need N more testers aged 60+ by Nov 20"; if still short on Nov 20, the Nov 23 gate records "NZR-32 cannot meet the Q109 age rule" and the owner decides: recruit later slots, or accept any ages
* **Test:** evidence check › HANDOFF line and, if needed, the gate line

### Scenario 3: No personal data in the repo
* **Given** the bookings and dry-run files
* **When** they are committed
* **Then** they contain no full names, emails, phone numbers, addresses, employers or birth dates; the initials column matches `^[A-Z]{2,3}$`; the code-to-contact map stays in the owner's own notes
* **Test:** evidence check › `grep -nE "@|[0-9]{3}[-. ][0-9]{3}[-. ][0-9]{4}" handoffs/2026-11-15-tester-bookings.md handoffs/2026-11-23-friendly-dry-run.md` returns nothing

### Scenario 4: Ineligible tester screened out
* **Given** a candidate who is a developer, works for PGN, has used Netzar before, or has built automations (Zapier, Power Automate, macros)
* **When** the owner screens them with the 4 screening questions
* **Then** they are not booked as T1–T5 (they may be the friendly dry-run person)
* **Test:** evidence check › each T row has `screened: yes`

### Scenario 5: Friendly dry-run on the core slice
* **Given** the core slice (NZR-49, NZR-23 to NZR-26) runs locally on Nov 23 and the synthetic policy exists
* **When** the friendly tester does the session script with the observer
* **Then** `handoffs/2026-11-23-friendly-dry-run.md` lists findings `DRY-01`… each with severity (`blocker`/`major`/`minor`), screen, what happened, and the action (`script fix` or `backlog: NZR-nn` or `new item`); the time to finish (or the stop time) is recorded; script v2 is committed by Nov 24
* **Test:** evidence check › dry-run file has ≥ 1 `DRY-` row and a `time:` line; the script in this story (or the handoff) has a `v2` label

### Scenario 6: Slice not ready on Nov 23
* **Given** the core slice is not runnable on Nov 23
* **When** the dry-run time comes
* **Then** the dry-run runs on the design.md mock pictures (the observer shows each mock, the tester says what they would tap), the file says `mode: mocks`, and the Nov 23 gate records "dry-run on mocks; product dry-run moved to <date ≤ Nov 30>"
* **Test:** evidence check › `mode: mocks` line + gate line

### Scenario 7: A tester cancels
* **Given** a booked tester cancels
* **When** the owner hears
* **Then** within 1 day B1 is moved into the empty T slot (or a new tester booked), the table is updated, and the age-60+ count is re-checked
* **Test:** evidence check › git history of the bookings file shows the change with a dated note

### Scenario 8: Real data appears in a session
* **Given** a tester types a real person's name, a real client, or uploads a real document
* **When** the observer sees it
* **Then** the observer pauses, asks the tester to use the sample, and afterwards deletes that draft/test from the local install; the dry-run file records only "real data entered: removed" (no content)
* **Test:** evidence check › the line, if it happened; no content copied

---

## 4. Technical Notes & Constraints
* **Dependencies:** None to book. The product dry-run needs the core slice: NZR-49, NZR-23, NZR-24, NZR-25, NZR-26 and the synthetic policy (NZR-26/NZR-31). Scenario 6 covers the case where they are late. Feeds NZR-32.
* **UI/UX Design:** N/A: owner task. Dry-run fallback material: design.md Workflows-slice mocks W-001 to W-013 ([design.md](../foundation/design.md)), e.g. `../../../assets/netzar-studio/mock/W-004-preview-desktop.png`.
* **Non-Functional Requirements:** Synthetic documents only (Q67, C-18). Initials only in the repo. Sessions 60 minutes. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only. (NZR-32 uses `journey.golden_completed`.)

* **Steps (who does what):**
  1. **Owner, by Nov 8 (30 min).** List 8–10 candidates from the owner's network: non-technical, ideally office or insurance work, at least 3–4 aged 60+, some who use an iPad. Keep the list in the owner's own notes.
  2. **Owner, by Nov 12.** Send the booking message (below). Ask the 4 screening questions by reply or phone.
  3. **Owner, by Nov 15.** Confirm 5 + 1 backup, agree slots Nov 24 – Dec 7 (recommended Dec 1–5, after the Workspace shell NZR-15), send the consent note. Pick the friendly dry-run person (a 7th person, e.g. a family member) for Nov 23.
  4. **Zion, by Nov 15.** Write `handoffs/2026-11-15-tester-bookings.md` from what the owner tells it, codes + initials only. Update the HANDOFF.
  5. **Zion, Nov 20–22.** Prepare the local install for the dry-run: fresh workspace, the insurance Helper, the synthetic policy, the session script printed. Check that nothing real is loaded.
  6. **Owner (observer) + friendly tester, Nov 23 (60 min).** Run the session script. Zion may join as note-taker if remote.
  7. **Zion, Nov 23–24.** Write `handoffs/2026-11-23-friendly-dry-run.md`; fix the script (v2); propose backlog items for blockers at C2b PLANNING (Q70).
* **Artifacts:**
  * `docs/features/netzar-studio/handoffs/2026-11-15-tester-bookings.md` (session handoff frontmatter):
    ```markdown
    | Code | Initials | Age band | Device | Office/insurance work | Screened | Slot (UTC) | Mode | Consent sent | Consent given |
    |---|---|---|---|---|---|---|---|---|---|
    | T1 | MK | 60+ | iPad | yes | yes | 2026-12-01 15:00 | in person | yes | (date) |
    | B1 | ... backup ... |
    ```
  * `docs/features/netzar-studio/handoffs/2026-11-23-friendly-dry-run.md`: mode (`product` / `mocks`), build commit, model backend (NVIDIA dev), time to finish, `DRY-nn` findings table `| ID | Severity | Screen | What happened | Action |`, script changes.
  * **Booking message** (owner sends):
    > Hi <name>, could you help me test something new? It's a simple computer tool for office work, and I want to see if it is easy for people who don't work with computers all day. It takes one hour, on <iPad or computer>, in person or by video call, between Nov 24 and Dec 7. There is nothing to prepare and no right or wrong answers: we are testing the tool, not you. Would you be free? Four quick questions first: (1) Do you write software or work in IT? (2) Have you ever set up an automation (like Zapier, Power Automate, or Excel macros)? (3) Have you seen or used "Netzar" before? (4) Which age group are you in: under 60, or 60 and over? Thank you! <owner>
  * **Consent note** (owner sends before the slot; tester replies "I agree"):
    > **Testing a new tool: what to expect.** You will try a new computer tool for about 20 minutes, and we will chat for the rest of the hour. We will use made-up practice documents only. Please do not type in real names, clients or anything private. We will take written notes about what you do and say. We will not record your face or voice. [Optional, only if you say yes: we record the screen only, and delete it within 30 days.] Your notes are stored with your initials only, never your name or contact details, and only the PGN team sees them. You can stop at any time without giving a reason. If you agree, reply "I agree". Questions: <owner contact>.
  * **Session script v1** (observer reads the parts in quotes; total 60 min; NZR-32 reuses it and adds the observation sheet):
    1. **Before (10 min before the slot).** Fresh workspace open on the Workspace home page; sample policy present; "Help me" button visible if built; timer ready; observation sheet (NZR-32) ready; nothing real on screen.
    2. **Welcome (5 min).** "Thank you for coming. We are testing the tool, not you. If something is confusing, that is our fault, and it is exactly what we need to know. Please think out loud: say what you are looking for and what you expect. I can't help you during the task, but I can repeat it. You can stop at any time."
    3. **Warm-up (3 min).** "Do you get documents by email at work? What do you do with them?"
    4. **Task card (read aloud, then hand over on paper):** "You work at an insurance office. New insurance policies come in, and someone has to check each one for missing cover. Please set up this tool so that when a new policy comes in, a helper checks it for gaps, writes a short report, and sends it to you to approve. Then try it once with the practice policy that is already there, and look at the report." Start the timer when the card is handed over.
    5. **Task (up to 20 min).** Observer is silent. Allowed: re-reading the task card. Not allowed: pointing, hints, answering "where do I click". If the tester asks: "What would you try?" At 20 minutes: stop the timer and say "Thank you, let's stop there."
    6. **Explain-back (5 min).** "In your own words, what will this do when a new policy comes in?" "What happens before anything is sent?" (C-32)
    7. **Debrief (10 min).** "What was easy? What was hard? Where did you feel unsure? Would you use this at work? How confident are you it would do what you asked, 1 to 5?"
    8. **Close (2 min).** Thank them. After they leave: delete their drafts/tests from the local install.
* **Evidence (what proves done):** the bookings file (Scenarios 1, 3, 4), consent recorded for 6 of 6 before their slots, the dry-run file (Scenario 5 or 6), and script v2. Docs CI green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`.
* **Security notes (data rules):**
  * Initials, age band and device only in the repo; contacts and the code-to-name map stay with the owner (Scenario 3).
  * Synthetic documents only (Q67, C-18). Tester-typed text in a local build goes to the NVIDIA dev model (DEPLOY §1; Q65 allows test data only), so testers are told not to type real names or clients (consent note).
  * No public tunnel to the VPS or operator machine for testers (Q92 defers public ingress to NZR-35 with a security review). Remote sessions use the video tool's remote control of the operator's browser.
  * Screen recordings, if any: stored off-repo, deleted within 30 days; never committed (C-43 also caps assets).
  * After each session: delete that tester's drafts and test runs from the local install.
* **Test plan:** No code. Docs checks on each commit: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/secret-scan.mjs`; the Scenario 3 grep.
* **Repo rules that apply:** Feature-doc framework ([docs/features/README.md](../../README.md)) §6a: one session handoff per working session, with frontmatter (`document_role: session-handoff`); HANDOFF lists them newest first. Plane mirror of findings needs the owner's yes (Q53). Local docs branch; no push without the owner's yes (Q80).
* **Rollback:** Cancel or move slots; revert the doc commits. Nothing deployed.
* **Build slices (proposal):** (1) Owner recruiting + booking (~1.5 h owner time, by Nov 15). (2) Zion: bookings file + dry-run prep (~1 h). (3) Dry-run + write-up + script v2 (~1.5 h, Nov 23–24).
* **Agent gotchas:**
  * Don't make the friendly dry-run person one of the 5: a tester who has seen the product is no longer a first-time user.
  * The task card must not use the product's words ("workflow", "agent", "trigger"). The mocks still use them (PENDING OWNER Q99 → "Routines", "Helpers", "When this happens"); say what the tester sees on screen only if they ask what a word means, and log it as a finding.
  * "Help me" (PENDING OWNER Q107) may not be built by Nov 23. Then "finished without Help" is `N/A` for the dry-run; don't invent a substitute.
  * The local build uses the NVIDIA dev model, not Bedrock: drafter quality on the dry-run is not evidence for the eval (Q58).
  * Dates: the story is in cycle C1 (ends Nov 9) but the dry-run is Nov 23 (C2a). See NOTES.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 1 (raw estimate 1 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** N/A · **Deploy reach:** local only · **Labels:** needs-owner

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona A / Margaret, 67; benefit = NZR-32 can run).
- [ ] Acceptance criteria cover both happy paths and edge cases (age rule short, personal data, ineligible tester, slice not ready, cancellation, real data entered).
- [ ] UX/UI designs: N/A: owner task. Fallback = design.md mocks W-001 to W-013.
- [ ] Dependencies have been identified and are unblocked (none for booking; the dry-run needs NZR-49, NZR-23–26 and the synthetic policy, else Scenario 6).
- [ ] The team has reviewed and estimated the story points (1 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70). N/A: no code; the 3 slices above are the plan.

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] N/A: no code (owner/business task).
- [ ] Peer code review is completed and approved. N/A: owner/business task, no code. Evidence is the bookings file and the dry-run file.
- [ ] N/A: no code; evidence is the artifact in the acceptance criteria. Docs checks green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/secret-scan.mjs`.
- [ ] UAT: the owner confirms 5 + 1 are booked (≥ 2 aged 60+), consent was sent, and the dry-run findings are right.
- [ ] Documentation is updated: feature HANDOFF + dated session handoffs (`2026-11-15-tester-bookings.md`, `2026-11-23-friendly-dry-run.md`); script v2 is the one NZR-32 uses.
- [ ] N/A: nothing to deploy.
