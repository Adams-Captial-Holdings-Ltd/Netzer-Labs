# [US-046] Business brief: ICP, single pain, price hypothesis, 2 partner calls

> Backlog task NZR-46 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-008. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Design partner (first insurance agency; Q63)
* **I want** a one-page brief that names who Netzar is for, the one pain it removes and a price to test, and two booked conversations where I can react to it
* **So that** the Dec 31 pilot has a real customer and a price to test: 2 partner calls held by Nov 23, with notes that feed the Nov 23 gate

---

## 2. Business Context & Description
* **Background:**
  * Q73: a one-page brief by Nov 15: ICP, the single pain, a price hypothesis, and two design-partner conversations booked.
  * Q79: Zion drafts by Nov 12 from the repo plus assumptions, marks every guess, and lists the owner-only questions. The owner corrects by Nov 15. The 2 partner calls happen by Nov 23 so they inform the Nov 23 gate.
  * Q63: Dec 31 "done" = one design partner runs the golden workflow on a live webhook and agrees to a paid pilot or LOI (NZR-48). This brief is the input to that ask.
  * Q64: the pilot runs in PGN's own AWS account (managed pilot) with a written data-boundary exception, no customer production data, partner consent. Customer-hosted comes at GA.
  * PRD OBJ-008 (commercially defensible user experience).
  * Terms: **ICP** = ideal customer profile, the one kind of company we sell to first. **Design partner** = an early customer who uses the product before it is finished and gives feedback, often at a reduced price. **LOI** = letter of intent, a short written statement that the partner plans to buy on stated terms. **Price hypothesis** = a price we guess and then test on real buyers.
* **Current behaviour (d1d3a66): what exists to draft from.**
  * The golden workflow, in the PRD's words: "When we receive an insurance policy, have our insurance agent review it, identify potential gaps, prepare a report, and send it to me for approval." (`docs/features/netzar-studio/foundation/PRD.md:61-70`).
  * Persona B "A department manager, insurance broker, consultant, or operations leader" (`PRD.md:143-149`). Journey A: "A 67-year-old insurance professional wants new insurance policies reviewed automatically." (`PRD.md:1616-1618`). Design target "Margaret, 67": office manager, uses email and Facebook on an iPad (round 5 Q98, PENDING OWNER Q98: recommendation applied).
  * Cost to run one pilot install: T0 floor $65–95/mo, Bedrock tokens capped at $5/day, typical $150–250/mo for the account (DEPLOY.md §4).
  * Commercial rules: "A signed agreement is the v1 entitlement; no license server or call-home" and "No external commercial use occurs until counsel and every P0 owner approve" ([customer-hosted README](../../customer-hosted-commercialization/README.md) §6). Counsel's open questions: `LEGAL_REVIEW_CHECKLIST.md` on branch `docs/customer-hosted-commercialization`.
  * Pilot data rules: SECURITY.md §5 (16 controls). No BAA exists, so no PHI/PII ([SECURITY.md](../foundation/SECURITY.md) §5 control 3).
  * No brief, ICP or pricing document exists in the repo today (grep for "ICP", "price" in `docs/features/netzar-studio/`: only the blueprint/backlog lines that schedule this task).
* **Target behaviour:**
  * `foundation/BUSINESS-BRIEF.md` exists, one page (about 500 words) plus appendices, in the template below.
  * Every statement not backed by the repo or the owner is marked `[GUESS]`. Every owner answer is marked `[OWNER yyyy-mm-dd]`.
  * The four owner-only questions are listed and, by Nov 15, answered by the owner.
  * Two named-by-code partners ("Partner A", "Partner B") have a call booked by Nov 15 and held by Nov 23.
  * Notes from both calls sit in the brief's Appendix B, with the price reaction and the pilot answer for each.
  * The Nov 23 gate record links the brief and says "2 calls held" or why not.
* **Out of scope:**
  * Signing anything with a partner (NZR-48). Drafting the pilot agreement or LOI wording (NZR-48 checklist; counsel).
  * The data-boundary exception text (NZR-48, SECURITY.md §5).
  * Market sizing, a pitch deck, a website, or a pricing page.
  * Contacting partners: only the owner contacts partners. Zion never emails or calls anyone.
* **Target Value:** Brief draft by Nov 12 (0 unmarked guesses), owner-corrected by Nov 15 (4 of 4 owner-only questions answered), 2 of 2 partner calls held by Nov 23. Measured by the brief's frontmatter `status`, `[GUESS]` count, and Appendix B entries.
* **User Persona Profile:** Design partner (first insurance agency; Q63). Likely a small independent insurance agency; the person we design for is the office manager who reads new policies (Margaret, 67); the person who signs may be the agency owner `[GUESS]`. PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Draft on time, every guess marked
* **Given** the repo at the drafting commit
* **When** Zion commits `foundation/BUSINESS-BRIEF.md` on or before Nov 12
* **Then** the file has frontmatter `status: draft`, the 8 template headings in order, at least one `[GUESS]` marker in each of sections 1–4, and section 8 lists exactly the 4 owner-only questions (first agency, what they pay today, who signs, pilot in PGN AWS)
* **Test:** evidence check › `grep -c "\[GUESS\]" docs/features/netzar-studio/foundation/BUSINESS-BRIEF.md` ≥ 4 and `grep -n "^## " ...` shows the 8 headings

### Scenario 2: Owner corrections by Nov 15
* **Given** the draft
* **When** the owner reviews it by Nov 15
* **Then** each of the 4 owner-only questions has an answer marked `[OWNER 2026-11-DD]`; every remaining `[GUESS]` is either replaced or re-marked `[HYPOTHESIS]` (kept on purpose, to test on calls); frontmatter `status: accepted`
* **Test:** evidence check › `grep -c "\[GUESS\]"` = 0 and `grep -c "\[OWNER "` ≥ 4 on the accepted commit

### Scenario 3: Two calls booked by Nov 15
* **Given** the corrected brief and the owner's candidate list (kept off-repo)
* **When** Nov 15 arrives
* **Then** Appendix B has two rows `Partner A` and `Partner B` with a call date on or before Nov 23 and status `booked`; no person's name, email or phone appears
* **Test:** evidence check › Appendix B table rows; `grep -E "@|\+?[0-9]{3}[- ][0-9]{3}[- ][0-9]{4}"` on the file returns nothing

### Scenario 4: Calls held and written up
* **Given** a booked call
* **When** the call ends
* **Then** within 2 days Appendix B for that partner holds the 9 call-script answers (current process, volume, time per policy, what they pay today, who signs, price reaction, pilot interest, PGN-hosted pilot OK yes/no, next step), status `held`
* **Test:** evidence check › each held partner block has the 9 labelled lines filled

### Scenario 5: Fewer than 2 calls by Nov 23
* **Given** a call is cancelled or not booked
* **When** the Nov 23 gate runs
* **Then** the gate record says "partner calls: N of 2 held", the reason, the new date, and "NZR-48 at risk: yes"
* **Test:** evidence check › line present in `handoffs/2026-11-23-*.md`

### Scenario 6: Partner refuses a PGN-hosted pilot
* **Given** a partner answers "no" to running the pilot in PGN's AWS account
* **When** the notes are written
* **Then** the brief's section 6 lists this as a blocker with the partner's reason, and the Nov 23 gate decides: other partner, or wait for customer-hosted (blocked by COMM-001..006, not in 2026)
* **Test:** evidence check › section 6 "Blockers" line + gate decision line

### Scenario 7: Price hypothesis rejected
* **Given** both partners call the price "too expensive" or "no budget"
* **When** the notes are written
* **Then** section 4 gets a new dated hypothesis (`v2`) with the reason, before NZR-48's LOI is drafted
* **Test:** evidence check › section 4 has a `v2 (2026-11-DD)` line

### Scenario 8: No customer data enters the repo
* **Given** a partner offers or sends a real policy during or after a call
* **When** the owner handles it
* **Then** the policy is not stored in the repo, the VPS or any model tool; Appendix B records only "offered real policy: declined, asked for a test/sample policy"
* **Test:** evidence check › `git log --stat` for the brief commits shows only `BUSINESS-BRIEF.md` and handoff files; no `.pdf`/`.docx` added

---

## 4. Technical Notes & Constraints
* **Dependencies:** None to start. Feeds NZR-48 (LOI and price) and the Nov 23 gate. Uses the NZR-31 demo recording if it exists by the call date (optional; mocks otherwise).
* **UI/UX Design:** N/A: business document. For calls, show the Workflows-slice mocks from [design.md](../foundation/design.md) (marked MOCK), e.g. `../../../assets/netzar-studio/mock/W-008-pick-sample-desktop.png`, or the NZR-31 recording.
* **Non-Functional Requirements:** One page for sections 1–8 (about 500 words). Plain words. No customer data, no personal data. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

* **Steps (who does what):**
  1. **Zion, Nov 10–12.** Draft `foundation/BUSINESS-BRIEF.md` from the template below, using only repo facts (cite the file) and marked guesses. Commit on the local docs branch (Q80). Tell the owner it is ready.
  2. **Owner, by Nov 15 (about 45 min).** Answer the 4 owner-only questions in the file or in chat (Zion writes them in, marked `[OWNER date]`). Strike or keep each `[GUESS]`.
  3. **Owner, by Nov 15 (about 30 min).** Pick 2–3 candidate agencies (names kept off-repo, in the owner's own notes). Send the invite message below. Book 2 calls of 30 minutes, on or before Nov 23.
  4. **Zion, by Nov 15.** Add Appendix B rows `Partner A`, `Partner B` with dates and status `booked`.
  5. **Owner, call day (30 min each).** Run the call script below. Take notes on paper or in the owner's own notes app.
  6. **Owner + Zion, within 2 days of each call (15 min).** Owner pastes or dictates notes; Zion writes them into Appendix B with names removed.
  7. **Zion, Nov 23 gate.** Link the brief from the gate record; write "N of 2 held", the price reaction summary, and whether NZR-48 is on track.
* **Artifacts:**
  * `docs/features/netzar-studio/foundation/BUSINESS-BRIEF.md`, frontmatter:
    ```yaml
    ---
    feature: netzar-studio
    document_role: decision
    status: draft        # accepted after owner corrections
    observed_at: 2026-11-12
    as_of_commit: <full sha the facts were checked against>
    ---
    ```
  * **Brief template** (sections 1–8 fit on one page; appendices may run longer):
    ```markdown
    # Netzar Studio: business brief (one page)
    Legend: [GUESS] = Zion's assumption, not checked. [HYPOTHESIS] = kept on purpose, to test on calls.
    [OWNER yyyy-mm-dd] = owner's answer. Facts without a marker cite a repo file.

    ## 1. Who it is for (ICP)
    - Company: independent insurance agency, [GUESS] 3–25 staff, [GUESS] US, commercial + personal lines.
    - Person who uses it: office manager / account manager who reads new policies (Margaret, 67; Q98).
    - Person who signs: [OWNER] (owner-only question 3).
    - Tools they use today: [GUESS] email, PDF viewer, an agency management system.
    - First agency: [OWNER] (owner-only question 1). Code name in this repo: Partner A.

    ## 2. The single pain
    - One sentence: "Every new policy has to be read line by line to find coverage gaps before it goes to the client." [GUESS]
    - How often: [GUESS] N new or renewed policies per week. Time per policy: [GUESS] N minutes.
    - What a miss costs: [GUESS] an E&O claim or a lost client.

    ## 3. What Netzar does about it
    - The golden workflow (PRD.md:61-70): a policy arrives → the insurance Helper reviews it → gaps listed → report → sent to you to approve.
    - What it does not do in the pilot: send anything to the client by itself; touch the agency management system.

    ## 4. Price hypothesis
    - v1: [HYPOTHESIS] $____ per month per agency for the pilot, ___ months.
    - Floor: run cost about $150–250/month per pilot account (DEPLOY.md §4); price must be above it.
    - Ceiling: hours saved per month × the person's hourly cost [GUESS: inputs from section 2].
    - What they pay today: [OWNER] (owner-only question 2).
    - How we test it: calls (Appendix B, price question), then the LOI (NZR-48).

    ## 5. Why us, why now
    - [GUESS] Agencies are short of staff; review is manual; existing tools are built for technical users (PRD.md §1.1).

    ## 6. Pilot offer and blockers
    - Managed pilot in PGN's AWS account, test/sample documents only, written data exception and consent (Q64; SECURITY.md §5).
    - Live run target: week of Dec 14 (NZR-48). Paid pilot or LOI by Dec 31 (Q63).
    - Pilot in PGN AWS acceptable to the partner: [OWNER] (owner-only question 4).
    - Blockers: (none yet)

    ## 7. Biggest assumptions (what would make this wrong)
    - [GUESS] ... (3–5 bullets, each one testable on a call)

    ## 8. Questions only the owner can answer
    1. Who is the first insurance agency?
    2. What do they pay today for this work (staff time, software, outsourcing)?
    3. Who signs at the agency?
    4. Does the pilot run in PGN's AWS? (PGN side decided yes, Q64; is it OK for the partner?)

    ## Appendix A: sources
    ## Appendix B: partner call notes
    | Partner | Call date | Status (booked/held/cancelled) | Pilot interest (yes/maybe/no) |
    |---|---|---|---|
    ### Partner A (role of person met: ____; no names)
    1. Current process: 2. Volume: 3. Time per policy: 4. What they pay today: 5. Who signs:
    6. Price reaction: 7. Pilot interest: 8. PGN-hosted pilot OK: 9. Next step + date:
    ```
  * **Invite message** (owner sends; plain text, adjust names):
    > Hi <name>, I'm building a tool that reads new insurance policies and lists possible coverage gaps for you to check, before anything goes to the client. I'd value 30 minutes of your view on whether this would help your agency. No preparation needed, and please don't send any real policies. Would <day/time> or <day/time> work? Thank you, <owner>
  * **Call script** (30 min; owner leads):
    1. (2 min) Thanks; purpose; "we are early, your honest view helps most"; "please don't share real client documents".
    2. (8 min) Today: "Walk me through what happens when a new policy comes in." "How many a week?" "How long does each take?" "Who does it?" "What happens when a gap is missed?"
    3. (3 min) Cost today: "What do you spend on this now: staff time, software, outside help?" (owner-only question 2)
    4. (7 min) Show: the mocks or the NZR-31 recording of the golden workflow. "What would you trust? What would worry you?"
    5. (4 min) Price: "If this saved you that time, what monthly price would feel like a bargain? Too expensive to consider?" Then state the v1 hypothesis and note the reaction word for word.
    6. (3 min) Pilot: "Would you try it on test policies in December, hosted by us, with a written data agreement?" "Who would need to agree or sign?" (owner-only questions 3, 4)
    7. (3 min) Next step: if yes, book a 1-hour live-run slot in the week of Dec 14 and say a short letter of intent would follow. Thank them.
    * Do not promise: HIPAA or any compliance, a GA date, customer-hosted in 2026, or a final price (customer-hosted README §6, LEGAL_REVIEW_CHECKLIST on branch `docs/customer-hosted-commercialization`).
* **Evidence (what proves done):** the accepted `BUSINESS-BRIEF.md` (Scenario 2 greps), Appendix B with 2 `held` blocks (Scenario 4), and the Nov 23 gate line (Scenario 5). Docs CI green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`.
* **Security notes (data rules):**
  * No personal data in the repo: partners are "Partner A/B"; people are named by role only. The code-to-name map stays in the owner's own notes.
  * No customer production data: no real policies in the repo, the VPS, CI, NVIDIA or any model chat (C-18, Q67, SECURITY.md §5 control 13). If one arrives by email, the owner does not forward it.
  * Prices and partner answers are commercial-confidential; the repo is private. Do not paste them into Plane without the owner's yes (Plane mirror rule, Q53).
  * Counsel gate: the brief may state a price hypothesis, but any binding paid-pilot term waits for counsel (customer-hosted README §6; COMM-006 is blocked).
* **Test plan:** No code. Docs checks on each brief commit: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/secret-scan.mjs`; plus the greps in Scenarios 1–3.
* **Repo rules that apply:** Feature-doc framework ([docs/features/README.md](../../README.md)): frontmatter keys on the new file; adding a document to the feature folder needs a stated maintenance need (§2 sprawl rule): the need is "the brief is a durable input to NZR-48 and the Nov 23 gate". Local docs branch only; no push/PR without the owner's yes (Q80).
* **Rollback:** Revert the brief commit. Nothing external to undo (calls are the owner's own).
* **Build slices (proposal):** (1) Zion drafts the brief, 1 h, Nov 10–12. (2) Owner correction pass + booking, ~1 h owner time, by Nov 15. (3) Call write-ups + gate line, 30 min after each call.
* **Agent gotchas:**
  * Zion cannot know the agency, what they pay, or who signs. Never fill those in; leave `[OWNER]`.
  * Do not copy partner real names from chat into the repo, even when the owner types them.
  * The design.md mocks still say "workflow", "agent", "trigger" (PENDING OWNER Q99: use "Routines", "Helpers", "When this happens"). Use plain words on the call even if the mock does not.
  * Dates: this story sits in cycle C1 (ends Nov 9) but its due dates are Nov 12, 15 and 23 (see NOTES).

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 2 (raw estimate 2 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** N/A · **Deploy reach:** local only · **Labels:** needs-owner, business

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (design partner = first insurance agency, Q63; benefit = customer + price for Dec 31).
- [ ] Acceptance criteria cover both happy paths and edge cases (late draft, unanswered owner questions, fewer than 2 calls, refusal of PGN hosting, price rejected, real policy offered).
- [ ] UX/UI designs: N/A: business document. Call material = design.md Workflows-slice mocks (MOCK) or the NZR-31 recording.
- [ ] Dependencies have been identified and are unblocked (none). The owner has 2–3 candidate agencies in mind.
- [ ] The team has reviewed and estimated the story points (2 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70). N/A: no code; the 3 slices above are the plan.

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] N/A: no code (owner/business task).
- [ ] Peer code review is completed and approved. N/A: owner/business task, no code. Evidence is the accepted `foundation/BUSINESS-BRIEF.md` with Appendix B.
- [ ] N/A: no code; evidence is the artifact in the acceptance criteria. Docs checks green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/secret-scan.mjs`.
- [ ] UAT: the owner confirms the brief is correct (status `accepted`) and both call write-ups match what was said.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts (ICP, price v1/v2) stay in `foundation/BUSINESS-BRIEF.md`, linked from the Nov 23 gate record.
- [ ] N/A: nothing to deploy.
