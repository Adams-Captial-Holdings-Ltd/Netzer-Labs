# [US-048] Design partner runs the golden workflow live + paid pilot or LOI

> Backlog task NZR-48 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-008, OBJ-005. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Design partner (first insurance agency; Q63)
* **I want** to send a test policy from my own sandbox system to Netzar's live webhook, see the review report, and approve it myself
* **So that** I can decide to pay for a pilot: one live run approved by me and a signed paid-pilot agreement or LOI by Dec 31

---

## 2. Business Context & Description
* **Background:**
  * Q63: Dec 31 "done" = one design partner runs the golden workflow on a live webhook in a deployed install, and agrees to a paid pilot or LOI. This is the C3 exit gate (`backlog.md:19`).
  * Q64: the install is PGN's own AWS account (NZR-42), as a managed pilot, with an explicit written exception to the "no PGN data plane" rule, no customer production data, and the partner's consent. Customer-hosted comes at GA.
  * Q58: partner access is blocked until the drafter is re-measured on Bedrock. DEPLOY.md §6 lists 6 blockers to partner reach.
  * Q72: if late, the cut order drops NZR-39, NZR-37, NZR-29, NZR-18 first; this story is never cut, it is the goal.
  * PENDING OWNER Q95 (validator requires an approval step before any external write, NZR-12/23): recommended yes. The golden workflow already ends with "send the report for your approval" (`PRD.md:61-70`), so the live run below includes the partner's approval. If the owner says no, the run still must show the approval step, because Scenario 2 is defined by it.
  * Terms: **LOI** = letter of intent: a short signed letter saying the partner intends to buy on stated terms; usually not binding except for named clauses. **Paid pilot** = a short paid trial under a signed agreement. **Webhook** = a web address the partner's system calls to send a document, which starts a run. **Sandbox system** = the partner's own test system (not their live client system).
* **Current behaviour (d1d3a66): what exists to build on.**
  * No pilot install, no webhook trigger, no live engine. Webhook auth, schema check, rate limit and body limit exist on no route today ([SECURITY.md](../foundation/SECURITY.md) summary item 4). These come from NZR-35 (webhook + API), NZR-34 (engine), NZR-36 (publish/activate/rollback), deployed by NZR-38.
  * Webhook public ingress is undecided (DEPLOY D3). US-035 proposes a Cloudflare tunnel on a pgnos.ai subdomain (Q92). The customer-hosted rule "Customer production never uses the PGN Cloudflare/`pgnos.ai` overlay" ([customer-hosted README](../../customer-hosted-commercialization/README.md) §6) is one of the rules the exception must name.
  * Partner users: magic-link principals with seat-user or viewer profiles; no admin, `tokens:write` or `security:write` (SECURITY.md §5 control 9; profiles in `src/lib/auth/permissions.ts`, seat-user at `:252-255` per SECURITY.md §1).
  * The 16 pilot controls: SECURITY.md §5 (written exception, consent, no production data, dedicated account, Bedrock only, data-blind deploy role, tier ≥ 2 controls, security fixes in, least-privilege partner principals, per-partner webhook credentials, cost cap + budget, deletion at end, nothing leaves the pilot, incident response, data-flows.json updated, exception ends at GA/end date).
  * Pilot deploy timing: pilot deploy target about Dec 18; no deploys Dec 24–31 (DEPLOY.md §4).
  * Commercial rules: "A signed agreement is the v1 entitlement" and "No external commercial use occurs until counsel and every P0 owner approve" (customer-hosted README §6). Counsel package: `LEGAL_REVIEW_CHECKLIST.md` on branch `docs/customer-hosted-commercialization`; COMM-006 (attorney closure) is `blocked` ([commercialization backlog](../../customer-hosted-commercialization/backlog.md)). Data boundary today: `CUSTOMER_DATA_BOUNDARY.md` on the same branch.
  * The pilot-hosting ADR is written by NZR-8 (US-008 Scenario 2: "PGN AWS only, no customer production data, partner consent, ends at GA").
  * Price and partner come from the brief (NZR-46, `foundation/BUSINESS-BRIEF.md`, not written yet).
* **Target behaviour:**
  * Before any partner access: the written data-boundary exception is signed by the owner and the partner, the partner's consent is recorded, and all DEPLOY.md §6 blockers are ticked.
  * The partner has one seat-user principal and one webhook credential, both rotated at the start and end of the pilot (control 10).
  * The partner's sandbox system posts one test or sample policy (no client data) to the pilot webhook; a run starts and returns a run id.
  * The run finishes: the insurance Helper reviews, gaps listed, report written, report waits in the partner's approval inbox; the partner approves it in Netzar.
  * The run record (run id, workflow version id, timestamps, step results) and the audit row ids are written in a dated handoff, without document content.
  * By Dec 31 a paid-pilot agreement or an LOI is signed (signed copy kept off-repo; the repo records date, type, term and a SHA-256 hash), or the partner's "no" and reason are recorded and the January plan is changed.
* **Out of scope:**
  * Building the webhook, engine, activation, or the deploy (NZR-35, NZR-34, NZR-36, NZR-38).
  * Writing the pilot-hosting ADR itself (NZR-8); this story adds the signed-exception line to it.
  * Final legal terms, HIPAA/BAA, DPA (counsel; COMM-006).
  * Customer-hosted install in the partner's account (GA, after COMM-001..008).
  * Any customer production data, now or during the pilot.
* **Target Value:** 1 live run on the pilot webhook approved by the partner (target week of Dec 14, before Dec 23), and 1 signed LOI or paid-pilot agreement by Dec 31. Measured by the dated live-run handoff and the agreement record.
* **User Persona Profile:** Design partner (first insurance agency; Q63): the agency person who reviews policies (Margaret-like, PENDING OWNER Q98) plus the person who signs (owner-only question in NZR-46). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: No partner access before the gate
* **Given** any of these is missing: signed exception, recorded consent, Bedrock re-baseline ≥ 80% with matching hashes (C-04, C-07), NZR-31 passing on staging/Bedrock, staging soak PASS, owner-approved ship message (DEPLOY.md §6)
* **When** someone proposes creating the partner principal or webhook credential
* **Then** it is not created; the live-run handoff shows the gate checklist with the missing line(s) unticked and "partner access: not granted"
* **Test:** evidence check › `handoffs/2026-12-DD-partner-live-run.md` "Gate" checklist; all 6 ticked before the "access granted" timestamp

### Scenario 2: Live run approved by the partner
* **Given** the gate is ticked, the golden workflow is published and activated on the pilot (NZR-36), and the partner holds a seat-user principal and a webhook credential
* **When** the partner's sandbox system sends one test policy to the pilot webhook
* **Then** the webhook answers with a run id (NZR-35 contract); the run reaches the approval step with a gaps report; the partner approves it in Netzar; the run ends `completed`; the handoff records run id, workflow version id, start/end times, step statuses and the audit row ids (UNVERIFIED: audit action names, set by NZR-34/35/36 and NZR-44)
* **Test:** evidence check › live-run handoff "Run record" block; `npm run verify` green on the pilot that day (output summary pasted)

### Scenario 3: Real client data offered or sent
* **Given** the partner sends, or wants to send, a real client policy
* **When** it is noticed (before or after arrival)
* **Then** before: the owner refuses and asks for a test/sample policy; after: the run and its S3/DynamoDB data are deleted per the exception's deletion section, the partner is told in writing within 24 hours (control 14), and the handoff records "production data received: deleted <time>" without content
* **Test:** evidence check › the handoff line + the partner notice date; no document content in the repo (`git log --stat` shows no `.pdf`/`.docx`)

### Scenario 4: Webhook call rejected
* **Given** the partner's call is unsigned, replayed, too large or too fast
* **When** it reaches the webhook
* **Then** it is rejected with the NZR-35 error body and no run starts; the owner sends the partner the fix (signature, size, timing) and the retry is logged
* **Test:** evidence check › handoff "Attempts" table rows with HTTP status and "run started: no"

### Scenario 5: Run fails or is cut off
* **Given** a model error, Bedrock throttling, or the T0 $5/day cost cap trips (DEPLOY risk 8)
* **When** the run fails
* **Then** the run shows the failed step and "nothing was sent"; no external write happened; the owner re-runs after the fix on the same or a later day before Dec 23; any cap raise is a runtime-config change with the owner's yes
* **Test:** evidence check › failed run id + reason + the successful re-run id in the handoff

### Scenario 6: Signed LOI or paid pilot by Dec 31
* **Given** a successful live run (Scenario 2)
* **When** the partner signs
* **Then** the signed PDF is stored off-repo; the repo records type (`LOI` / `paid pilot`), signing date ≤ 2026-12-31, term start/end, monthly price, the checklist below fully ticked, and `sha256` of the signed PDF; the feature HANDOFF and the C3 gate record say "Dec 31 goal: met"
* **Test:** evidence check › `handoffs/2026-12-DD-pilot-agreement.md` has all checklist lines ticked and a 64-hex `sha256:` line

### Scenario 7: Paid pilot needs counsel and counsel is not ready
* **Given** the partner wants a paid pilot and counsel has not approved a pilot agreement (customer-hosted README §6)
* **When** Dec 31 approaches
* **Then** the owner offers the LOI instead (non-binding except confidentiality), and the record says "paid pilot pending counsel; LOI signed"
* **Test:** evidence check › agreement record `type: LOI` + the "pending counsel" line

### Scenario 8: No agreement
* **Given** the partner declines, or nothing is signed by Dec 31
* **When** Dec 31 arrives
* **Then** the reason (partner's words, no names), what they would need to say yes, and the January plan change are recorded in the C3 gate record; the pilot exception's end steps (deletion, credential rotation) are scheduled
* **Test:** evidence check › gate record lines + a dated deletion task

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-38 / US-038](US-038-pilot-deploy-to-pgn-aws-account-runbook.md) Pilot deploy to PGN AWS account + runbook; [NZR-46 / US-046](US-046-business-brief-icp-single-pain-price-hypothesis.md) Business brief: ICP, single pain, price hypothesis, 2 partner calls
* **UI/UX Design:** N/A: business outcome. The partner uses the built screens (Workflows slice + approval inbox, NZR-36 "NO-MOCK-YET" in [design.md](../foundation/design.md)). A "test data only" banner on upload screens is required (SECURITY.md §5 control 3; DEPLOY risk 12).
* **Non-Functional Requirements:** Partner consent recorded; no customer production data. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md) (C-07, C-12, C-13).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

* **Steps (who does what):**
  1. **Zion, by Dec 1.** Fill the exception and consent templates below with the partner code, data classes, dates and contacts (placeholders for names). Draft the LOI from the checklist and the NZR-46 price.
  2. **Owner, by Dec 4.** Send the exception, consent and draft LOI to the partner. If a paid pilot is wanted, send the agreement draft to counsel the same day (Scenario 7).
  3. **Owner + partner, by Dec 11.** Sign the exception; partner gives consent. Owner sends the signed PDFs to PGN's document store (off-repo).
  4. **Zion, by Dec 11.** Add the signed-exception line to the pilot-hosting ADR (NZR-8) and the sha256 of the signed copy; update `docs/data-flows.json` for the pilot flows (control 15) as a docs change.
  5. **Zion + owner, Dec 14–18.** Tick the DEPLOY.md §6 gate in the live-run handoff. Owner approves the ship message. NZR-38 deploys (separate story, separate owner yes).
  6. **Owner, after the gate.** Create the partner's seat-user magic link and the webhook credential (per NZR-35/NZR-38 runbook); send them by a channel the partner chose (never email the webhook secret in plain text together with the URL).
  7. **Owner + partner, live-run call (60 min, between Dec 14 and Dec 23).** Partner sends a test policy from their sandbox; both watch the run; partner approves the report. Zion takes notes and records the run record.
  8. **Owner, same call or within 3 days.** Ask for the LOI/pilot signature. Partner signs by Dec 31.
  9. **Zion, on signature.** Write the agreement record; update the HANDOFF and the C3 gate record.
  10. **Owner, pilot end (end date or GA).** Rotate the webhook credential, remove the partner principal, run the deletion steps, send the deletion certificate (control 12).
* **Artifacts:**
  * `docs/features/netzar-studio/handoffs/2026-12-DD-partner-live-run.md`: "Gate" checklist (DEPLOY.md §6 items 1–6), "access granted" timestamp, "Attempts" table `| time | HTTP status | run id | run started |`, "Run record" (run id, workflow version id, start/end UTC, step statuses, approval time, audit row ids), `npm run verify` summary. No document text.
  * `docs/features/netzar-studio/handoffs/2026-12-DD-pilot-agreement.md`: type, signing date, term, monthly price, checklist ticks, `sha256:` of the signed PDF.
  * A one-line addition to the pilot-hosting ADR from NZR-8 (UNVERIFIED file name: `docs/adr/00NN-*.md`, written by NZR-8): "Exception signed <date> by PGN and Partner A; ends <date>; signed copy sha256 <hash>, kept offline."
  * Off-repo (PGN document store): signed exception, signed consent, signed LOI/agreement, partner contacts.
  * **Data-boundary exception template** (one page; mirrors SECURITY.md §5):
    1. Parties: PGN (owner) and Partner A (signer's role). Named contacts: PGN incident owner; partner contact.
    2. Purpose: a managed pilot of Netzar's policy-review routine in PGN's own AWS account, as an exception to "the customer owns AWS and production data" and to "no PGN Cloudflare overlay for customer use" (customer-hosted README §6).
    3. Data allowed: synthetic or test policies only. Not allowed: real client policies, PII, PHI, 42 CFR Part 2 data, payment data. No BAA exists.
    4. Where data lives: PGN AWS account `<NZR-42 id>`, region `us-east-1`; model: Amazon Bedrock only (subprocessors per `docs/data-flows.json`).
    5. Who at PGN can see data: named staff only, through a time-limited break-glass role with MFA; partner told within 24 h of any use (control 6).
    6. Security controls on: list SECURITY.md §5 controls 7–11 as built; if tier 1/0 is used instead of tier ≥ 2, say so here (control 7).
    7. Nothing leaves the pilot: no copy to dev, eval sets, training or other models (control 13).
    8. Start date, hard end date (≤ 90 days and ≤ GA), exit and deletion plan: S3 + DynamoDB data deleted, KMS keys scheduled for deletion, deletion certificate sent within 10 business days; WORM audit rows (ids and hashes only) remain (control 12).
    9. Incident: partner notice within 24 h of a suspected breach; runbook `docs/runbooks/<pilot page>` (control 14).
    10. Not renewable without a new signed exception (control 16). Signatures + dates.
  * **Partner consent form** (signed by the partner before any data arrives; control 2):
    > Partner A agrees that: (1) during the pilot it will send only test or sample policies, never real client documents or personal data; (2) PGN hosts the pilot in PGN's AWS account and uses Amazon Bedrock to process the documents; the full list of services that may see pilot data is attached (from `docs/data-flows.json`); (3) named PGN staff may access pilot data only for support, as described in the exception, and Partner A will be told within 24 hours; (4) pilot data is deleted at the end as described in the exception. Partner A may withdraw consent at any time; PGN then stops the pilot and deletes the data. Signed: ____ (role) Date: ____
  * **LOI checklist** (every line ticked before signing; counsel reviews any binding clause):
    - [ ] Parties and signer's authority (the person who signs, from NZR-46).
    - [ ] What PGN provides: the policy-review routine on Netzar, managed pilot in PGN AWS, support hours, named contact.
    - [ ] What the partner provides: test/sample policies, a sandbox system to call the webhook, one 30-minute feedback call per week, a named contact.
    - [ ] Term: start and end dates (end ≤ the exception's end date).
    - [ ] Price: monthly fee from the NZR-46 price hypothesis (v1 or v2), billing start, what happens at the end (convert to a paid subscription, or stop).
    - [ ] Success criteria the partner will judge: e.g. "≥ N policies reviewed; reports usable without rework in ≥ X% of cases" (numbers agreed with the partner).
    - [ ] Data: refers to the signed exception and consent; no production data during the pilot.
    - [ ] Binding vs non-binding: non-binding except confidentiality (LOI); a paid pilot needs a counsel-approved agreement (customer-hosted README §6).
    - [ ] Confidentiality both ways.
    - [ ] No promises PGN cannot keep: no HIPAA/compliance claim, no GA date, no customer-hosted date (LEGAL_REVIEW_CHECKLIST, branch `docs/customer-hosted-commercialization`).
    - [ ] Signatures and dates (≤ 2026-12-31).
* **Evidence (what proves done):** the live-run handoff with the full gate ticked before access and a `completed` run approved by the partner (Scenario 2), and the agreement record with sha256 (Scenario 6 or 7), or the Scenario 8 record. Docs CI green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/secret-scan.mjs`.
* **Security notes (data rules):**
  * Threats: SECURITY.md §5 (pilot exception, 16 controls) and §7 risk 10 ("the pilot exception quietly becomes a PGN-held data plane"), DEPLOY risk 6 (webhook is an internet-exposed write path) and risk 12 (data-boundary breach).
  * Authz: the partner gets seat-user (or viewer) only; never admin, `tokens:write`, `security:write` (control 9). Webhook credential per partner, rotated at start and end (control 10).
  * Secrets: the webhook secret and magic link never enter the repo, chat logs or Plane; sent by a channel the partner chose. `node scripts/ci/secret-scan.mjs` stays at 0 findings.
  * No customer production data anywhere: not in the pilot, the repo, the VPS, CI, NVIDIA or eval sets (control 13, C-18, Q67).
  * Partner names, signer names and prices stay off-repo except the price and type in the agreement record (private repo; owner may choose to keep price off-repo too).
  * Every deploy, flag flip and AWS call on the pilot is its own owner yes (DEPLOY consent rule). No deploys Dec 24–31.
* **Test plan:** No code in this story. Before the live run: NZR-35's webhook tests (auth, replay, size, rate, idempotency) pass on staging (DEPLOY risk 6), NZR-31's e2e passes on staging/Bedrock, `npm run verify` green on the pilot. After: docs checks above.
* **Repo rules that apply:** Feature-doc framework ([docs/features/README.md](../../README.md)) §6a for the two session handoffs. ADR edits follow `docs/adr/README.md`. `docs/data-flows.json` updated before go-live (control 15). Owner yes for each push, deploy and AWS call (Q50, DEPLOY consent rule).
* **Rollback:** Before signature: withdraw the partner principal and webhook credential, flag the trigger OFF (NZR-36), delete pilot data per the exception. After a bad release during the pilot: `npm run deploy:rollback -- --class=image --to=previous` (DEPLOY.md §4). Agreements are not "rolled back"; the LOI's end and the exception's exit plan apply.
* **Build slices (proposal):** (1) Paperwork: exception, consent, LOI draft, ADR line, data-flows update (Zion 1.5 h + owner 1 h, Dec 1–11). (2) Gate + access (Zion 30 min + owner 30 min, Dec 14–18). (3) Live-run call + run record (1 h, by Dec 23). (4) Signature + agreement record (30 min, by Dec 31).
* **Agent gotchas:**
  * "Deployed" is not "partner may use it": access waits for the whole DEPLOY.md §6 gate, including the Bedrock re-baseline.
  * The webhook must be called by the partner's sandbox system, not by PGN on their behalf; otherwise it is not the Q63 "live webhook" outcome.
  * Do not copy any partner document text into the run record, the handoff, an eval case or a test fixture (control 13).
  * SECURITY.md §5 control 7 asks for tier ≥ 2 controls, but DEPLOY.md and US-038 plan a T0 pilot (~$65–95/mo). The exception must say which is used (see NOTES).
  * The Dec 24–31 window has no deploys: plan the live run before Dec 23.
  * Audit/event names for the run are not defined yet (NZR-34/35/36/44). Record the run id and whatever audit row ids exist; do not invent names.
  * Seat-user today holds only `dashboard:read` and `usage:self:read` (`src/lib/auth/permissions.ts:252-255`), and no capability in `src/lib/auth/permissions.ts` mentions approval (grep "approv" → none). A seat-user partner may not be able to approve the report. NZR-36 must define which capability approves a workflow report, and it must not be admin, `tokens:write` or `security:write` (control 9). UNVERIFIED until NZR-36 is planned.

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 2 (raw estimate 2 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** N/A · **Deploy reach:** pilot · **Labels:** needs-owner, business, gate

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Partner A identified in NZR-46; signer known).
- [ ] Acceptance criteria cover both happy paths and edge cases (gate not met, real data, webhook rejected, run failure/cost cap, LOI, counsel not ready, no agreement).
- [ ] UX/UI designs: N/A: business outcome; partner uses built screens; "test data only" banner present.
- [ ] Dependencies have been identified and are unblocked (NZR-38 deployed with verify green; NZR-46 brief accepted with price; plus, through NZR-38: NZR-35, NZR-36, NZR-42; and the Bedrock re-baseline, NZR-31 on staging, NZR-8 pilot-hosting ADR).
- [ ] The team has reviewed and estimated the story points (2 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70). N/A: no code; the 4 slices above are the plan.

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] N/A: no code (owner/business task).
- [ ] Peer code review is completed and approved. N/A: owner/business task, no code. Evidence is the live-run handoff and the agreement record.
- [ ] N/A: no code; evidence is the artifact in the acceptance criteria. Docs checks green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/secret-scan.mjs`.
- [ ] UAT: the owner confirms the partner approved a live run and the signed LOI/agreement record is correct (or the Scenario 8 record).
- [ ] Documentation is updated: feature HANDOFF + dated session handoffs (live run, agreement); pilot-hosting ADR line with the exception hash; `docs/data-flows.json` pilot flows.
- [ ] Deployed to the PGN AWS pilot account with the owner's yes for that deploy; `npm run verify` green. Production reach stays blocked until the drafter is re-measured on Bedrock (Q58).
