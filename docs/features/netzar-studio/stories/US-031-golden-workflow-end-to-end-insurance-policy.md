# [US-031] Golden routine end to end: insurance policy review (Journey A)

> Backlog task NZR-31 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: AC-001, AC-002, AC-003, AC-004, AC-005, AC-006, AC-007. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3), acting for Persona A ("Margaret, 67", Q98)
* **I want** the "review new insurance policies" routine to go from the Routines tab through drafting, choosing a helper, editing, trying and marking Ready, end to end on a local install, with an automated test and a recording
* **So that** we have one real proof, repeatable on demand, that Journey A works (PRD Journey A, AC-001 to AC-007) before the Nov 23 dry-run, and every slice regression is caught by one test

---

## 2. Business Context & Description
* **Background:**
  - PRD Journey A ([PRD](../foundation/PRD.md), "Journey A — First-time user builds a workflow") has 11 steps. In plain terms:
    1. Open Netzar.
    2. Tap "Build".
    3. Describe the routine.
    4. Get a draft of about five steps.
    5. Choose the insurance helper.
    6. See what is needed.
    7. Review it.
    8. Try it with a sample.
    9. Read the explained result.
    10. Ask for corrections.
    11. Get offered activation.
  - The slice (Q61, Nov 10–23) delivers steps 1 to 10. Step 11 shows only "Turning it on comes later" (loop 2).
  - Q67 rules: synthetic documents only, 5 testers booked by Nov 15, one friendly dry-run on Nov 23. Q109 (round 5, PENDING): at least 2 of the 5 testers aged 60+, and track "finished without tapping Help".
  - Q69: one lane, Playwright run serially. Q78: `npm ci --prefix web` plus Playwright chromium are installed only in the clean clone on the VPS, one at a time (3.9 GB RAM).
  - This story owns the cross-slice test and the journey metric event. It does not own any slice screen.
* **Current behaviour (d1d3a66):**
  - Playwright suites exist in `tests/e2e/{battle,chat,cost,iam,jarvis,knowledge,perf,staging,tour}`. Most target a **deployed URL** with `CCE_TOKEN` (for example `tests/e2e/tour/playwright.config.ts:3-4`, which has no `baseURL` and no `webServer`).
  - The only local suite is `e2e:chat`: Vite on port 5180 plus a dev-only mock stream plugin, with no backend (`tests/e2e/chat/playwright.config.ts:17-45`, `package.json` `e2e:chat`).
  - There is no suite that runs the real orchestrator locally.
  - Local stack (`development.md` "Local vs AWS architecture"):
    - orchestrator via `tsx watch` on port 3000;
    - Vite on 5173 with an `/api` proxy (`web/vite.config.ts`);
    - Floci on `127.0.0.1:4566` emulating DynamoDB and S3;
    - **Bedrock is a Floci stub with fixed placeholder text and no tool use**, so the real drafter cannot produce a draft locally without NZR-10 (NVIDIA dev backend) or NZR-11 (recorded replies);
    - `npm run local:verify` (`scripts/local/guard.ts`) refuses non-loopback endpoints and real accounts.
  - Local sign-in uses the env root token (`local-dev-dashboard-token`). It has **no person** (`src/lib/auth/dashboard-auth.ts:98-134`), so studio routes answer `person_required` (US-049).
  - Magic links do not work locally (`development.md` "Authentication").
  - `createToken(label, createdBy, role, expiresInDays, binding?: {userId, profileId})` (`src/lib/state/tokens-repo.ts:122-133`) can mint a token bound to a person. `createUserInvite` plus `activateUser` (`src/lib/state/users-repo.ts:177, 430`) can create that person.
  - No agents are seeded locally. Only the built-in `main` exists (`development.md` "Development data"). `createAgentFull` (`src/lib/agents/agent-manager.ts:80`) creates one.
  - The e2e chat specs sign in by seeding `localStorage.cce_token` with `page.addInitScript` (`tests/e2e/chat/chat.spec.ts:31-32`).
* **Target behaviour:**
  - A new suite `tests/e2e/studio-golden/` runs Journey A against a **local** orchestrator, Vite and Floci. It is started by `npm run e2e:studio-golden`. Playwright `webServer` owns the orchestrator and Vite. Floci must already be up, and `globalSetup` checks this.
  - `globalSetup` does four things:
    1. Runs the local guard.
    2. Provisions the studio table if it is missing (`scripts/local/table-schemas.ts`).
    3. Seeds a synthetic person "Margaret Test" (`margaret@example.test`, viewer profile) with a 1-day token bound to her, plus a "Policy Reviewer" helper.
    4. Writes the token to a git-ignored `tests/e2e/studio-golden/.auth.json`.
  - Seeding is idempotent and refuses to run unless the guard passes.
  - Model answers have two modes:
    - **Replay (default, the gate).** The orchestrator runs with the NZR-11 recorded-reply harness pointed at `tests/fixtures/studio/golden-replies/`. Results are deterministic, cost nothing and need no network. A request with no recording fails loudly.
    - **Live (the recording).** `STUDIO_GOLDEN_MODEL=live` uses the NZR-10 NVIDIA dev backend for a real run. That run also refreshes the recordings (`--record`) and saves the demo video. Live mode is never the gate.
  - The journey spec drives the real UI with role-and-name selectors. At the end it checks the records through the API: the run passed, it is tied to the current draft, nothing was executed outside, and the routine is Ready.
  - The browser records `journey.golden_completed` when a routine first becomes Ready in a session. Props: `helpOpened` (yes or no) and `minutes` bucket. Each tester's result for the Q109 "finished without Help in 20 min" bar is read from these props.
  - A dry-run kit for Nov 23 provides an observer sheet, the tester script, and the findings-to-issues routine.
* **Out of scope:**
  - The screens themselves (NZR-49, NZR-23, NZR-24, NZR-25, NZR-26).
  - Activation and publishing (loop 2).
  - Running this suite in GitHub CI (it needs Floci in docker; proposed in NOTES).
  - Staging or deployed targets (PENDING NZR-42).
  - axe checks (NZR-20).
  - Booking the testers (NZR-47).
  - Real customer documents (Q67).
* **Target Value:**
  - `npm run e2e:studio-golden` passes 3 times in a row on the VPS clean clone in replay mode, in under 6 min each. It makes zero external model calls.
  - One live-mode recording (video plus trace) is saved and linked from the session handoff by Nov 21.
  - On Nov 23, at least 4 of 5 testers finish Journey A in 20 min or less, and at least 2 of those 5 are aged 60+. "Finished without Help" is reported per tester.
  - Every dry-run finding is logged as an issue within 24 h.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3), proving Journey A for Persona A ("Margaret, 67", Q98). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Journey A passes locally (replay mode)
* **Given:**
  - a fresh local install on the VPS clean clone;
  - Floci up (`npm run local:up`);
  - `npm ci` and `npm ci --prefix web` done;
  - Playwright chromium installed (Q78);
  - golden recordings committed.
* **When** `npm run e2e:studio-golden` runs.
* **Then** the spec `journey-a.spec.ts` completes these steps in order, at a 1024x768 viewport (iPad, Q108):
  1. **(AC-001)** It opens `/dashboard/` signed in as Margaret Test, taps the sidebar link "Routines", sees "No routines yet", and taps "Build a routine".
  2. **(AC-002)** It completes the NZR-23 start: it taps the example card "Check new insurance policies", answers the guided questions by tapping, and sees a preview with at least 4 numbered steps.
  3. **(AC-003)** The When card reads "When a new policy document is added". The Result card starts with "You get".
  4. **(AC-006)** One step shows "Needs: choose a helper" and "Try it" is disabled.
  5. **(AC-004)** It taps "Choose a helper" and taps "Policy Reviewer". The need disappears and "Try it" is enabled.
  6. **(AC-007)** In the NZR-24 "Ask" box it types "Ask me to approve before the report is sent". A step with the badge "Approval" appears, highlighted with a change line, and "Undo" is visible.
  7. **(AC-005)** It taps "Try it". Within 120 s it sees "It worked.", then "Here's the report it would send you" containing "flood", then "Nothing was sent anywhere.".
  8. It taps "Mark as ready" and sees "Ready" and "Turning it on comes later."
  9. It returns to "Routines" and sees the card with the label "Ready".
* **Test:** `tests/e2e/studio-golden/journey-a.spec.ts` › "Journey A: build, choose helper, edit, try, mark ready"

### Scenario 2: Records prove the try was sealed and current
* **Given** Scenario 1 just finished.
* **When** the spec calls the API with Margaret's token: `GET /api/workflows`, `GET /api/workflows/<id>`, and `GET /api/workflows/<id>/test/<runId>`.
* **Then:**
  - The run has `status:"passed"` and `outOfDate:false`, its `draftRev` equals the workflow's `draftRev`, and every step has a non-empty `summary`.
  - The workflow label is `"Ready"`.
  - The orchestrator log (captured by `webServer` stdout to `test-results/studio-golden/server.log`) contains zero lines matching `tool policy denied call|tool dispatch failed` for non-sealed reasons, and zero `invokeMcpTool` lines.
  - The replay harness reports `0 unmatched, 0 live calls` in its summary line.
* **Test:** `tests/e2e/studio-golden/journey-a.spec.ts` › "records show a sealed, current, passing try"

### Scenario 3: Recording is saved
* **Given** Scenario 1 runs, in either replay or live mode.
* **When** the run ends.
* **Then:**
  - Playwright saves `test-results/studio-golden/journey-a/video.webm` and `trace.zip` (config `video:'on'`, `trace:'on'` for this project only).
  - A step screenshot `NN-<name>.png` is saved after each of the 9 steps.
  - In live mode, the spec prints the absolute paths. The session handoff links them, and the 9 PNGs are copied to `docs/assets/netzar-studio/golden/` (checked by `node scripts/ci/docs-assets.mjs`).
* **Test:** `tests/e2e/studio-golden/journey-a.spec.ts` › "saves video, trace and 9 step screenshots"

### Scenario 4: Missing recording fails loudly
* **Given** replay mode, and a drafter prompt changed so that a model request has no recording.
* **When** the suite runs.
* **Then:**
  - The orchestrator answers that model call with an error naming the missing recording key.
  - The journey fails at the step that needed it with a message containing `no recording for`.
  - It never falls through to Floci's placeholder text or a live model.
* **Test:** `tests/e2e/studio-golden/journey-a.spec.ts` › "unrecorded model call fails the journey with the recording key" (sets `STUDIO_GOLDEN_REPLAY_DIR` to an empty temp dir)

### Scenario 5: Refuses an unsafe target
* **Given** either:
  - (a) `AWS_ENDPOINT_URL` is unset or points to a non-loopback host; or
  - (b) `CCE_BASE_URL` points to a deployed dashboard.
* **When** `npm run e2e:studio-golden` starts.
* **Then:**
  - `globalSetup` exits non-zero before seeding.
  - For (a) the message is "Local guard failed: …" (the output of `scripts/local/guard.ts`).
  - For (b) the message is "studio-golden runs against a local target only".
  - No user, token or agent is written anywhere.
* **Test:** `tests/e2e/studio-golden/global-setup.test.ts` › "refuses non-local endpoints and deployed base URLs" (vitest, unit-level on the setup function)

### Scenario 6: Seed is idempotent and synthetic
* **Given** the seed already ran once.
* **When** `globalSetup` runs again.
* **Then:**
  - It reuses user `usr_golden_margaret` and helper `policy-reviewer`, and mints a fresh 1-day token bound to `{userId:"usr_golden_margaret", profileId:"viewer"}`.
  - It soft-deletes routines left by earlier runs for that user, so the list starts at "No routines yet".
  - All seeded names and emails use `example.test`.
  - The sample is the US-026 synthetic PDF: its sha256 equals that of `tests/fixtures/studio/synthetic-home-policy.pdf`.
* **Test:** `tests/e2e/studio-golden/global-setup.test.ts` › "second run reuses ids, mints a new token and clears old routines"

### Scenario 7: Journey metric event
* **Given** a browser session that opened `/workflows/new` at time T and opened "Help me" 0 times.
* **When** that routine is marked Ready at T+14 min.
* **Then:**
  - Exactly one `POST /api/workflows/events` is sent with `{"event":"journey.golden_completed","props":{"helpOpened":"no","minutes":"10-20"}}`.
  - A second Ready in the same session sends nothing.
  - The audit row has action `product_event` and no `userId`.
* **Test:** `tests/e2e/studio/journey-event.spec.ts` › "first Ready in a session sends one journey event with help and minutes buckets" (mock mode, uses the clock API); `src/lib/analytics/events.test.ts` › "journey.golden_completed accepts only helpOpened and minutes enums"

### Scenario 8: Dry-run findings become issues (Nov 23)
* **Given:**
  - 5 booked testers (NZR-47), at least 2 aged 60+ (PENDING OWNER Q109);
  - the dry-run kit;
  - a local or VPS demo install running replay-free (live NVIDIA mode).
* **When** each tester tries Journey A with only the tester script.
* **Then:**
  - The observer fills one row per tester in `docs/features/netzar-studio/dry-run/2026-11-23-results.md`: finished (y/n), minutes, Help taps, explained the routine correctly (y/n on trigger, helper, approval, result), and quotes.
  - Each finding is logged within 24 h as an issue labelled `dry-run` and `netzar-studio` with severity `blocker|major|minor` and a link to the row.
  - The results file reports the Q109 bar: at least 4 of 5 finished in 20 min or less, plus "finished without Help" per tester.
* **Test:** Evidence check, not automated: the results file exists with 5 rows, and `gh issue list --label dry-run` (or the Plane query) shows one issue per finding. The fresh critic verifies both.

---

## 4. Technical Notes & Constraints
* **Dependencies:**
  - Story dependencies:
    - [NZR-49 / US-049](US-049-plain-workflows-tab-list-new-open-draft.md) Plain Workflows tab: list, new, open draft;
    - [NZR-23 / US-023](US-023-workflow-drafter-describe-draft-or-clarifying-question.md) Workflow drafter: describe -> draft or clarifying question;
    - [NZR-24 / US-024](US-024-edit-by-chat-on-drafts.md) Edit-by-chat on drafts;
    - [NZR-25 / US-025](US-025-plain-language-preview-numbered-steps-no-canvas.md) Plain-language preview (numbered steps, no canvas) + helper picker;
    - [NZR-26 / US-026](US-026-sample-data-test-runner-sealed-sandbox-ready.md) Try it: sample-data test runner (sealed sandbox) + Ready flag.
  - Also needs:
    - [NZR-11 / US-011](US-011-recorded-reply-harness-for-model-calls-in.md) recorded-reply harness, usable by the **server process** and not only inside vitest;
    - [NZR-10 / US-010](US-010-local-model-env-floci-nvidia-dev-backend.md) NVIDIA dev backend, for live mode;
    - [NZR-3 / US-003](US-003-clean-clone-builder-workspace-on-the-vps.md) VPS clean clone with Playwright chromium;
    - [NZR-47 / US-047](US-047-book-5-testers-friendly-dry-run-synthetic.md) testers booked, for Scenario 8.
* **UI/UX Design:** No new screens. The test follows W-001 to W-013 ([design.md](../foundation/design.md) sections 2 and 3a; mocks in `../../../assets/netzar-studio/mock/`). The current mocks are chat-style and are being redone for the guided flow (Q101). Selectors use accessible role and name from each slice story's copy, never CSS classes, so a mock redo does not break the test. Copy changes from PENDING OWNER Q99/Q103/Q106 change selector names in one place, `tests/e2e/studio-golden/copy.ts`, which imports `web/src/lib/studio/copy.ts`.
* **Non-Functional Requirements:**
  - The suite runs serially (`workers:1`, `fullyParallel:false`). It must never run alongside another Playwright suite on the VPS (Q69, Q78: 3.9 GB RAM).
  - The whole suite, including server start, takes 6 min or less in replay mode.
  - Per-step `expect` timeout is 25 s, and 120 s for the try. The try is async (US-026), so no single HTTP request comes near the 60 s CloudFront limit that applies when deployed (R8).
  - Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:**
  - `journey.golden_completed` has props `helpOpened` (`yes|no`) and `minutes` (`<10|10-20|>20`). The browser sends it once per session on the first Ready after `/workflows/new` was opened, tracked in `sessionStorage` by `web/src/lib/studio/journey.ts`. It is written as `product_event` with no userId (Q55) and goes in the OBSERVABILITY.md catalogue (NZR-44).
  - Dry-run metrics come from these events plus the observer sheet.

* **Files to change:**

| path | change |
|---|---|
| `package.json` scripts | Add `"e2e:studio-golden": "playwright test --config tests/e2e/studio-golden/playwright.config.ts"` and `"e2e:studio-golden:record": "STUDIO_GOLDEN_MODEL=live playwright test --config tests/e2e/studio-golden/playwright.config.ts"`. |
| `scripts/local/table-schemas.ts` | Add the `${app}-studio` table schema (PK/SK, gsi1, gsi2, ttl) so `npm run local:provision` creates it. Skip if NZR-12 already did this. |
| `src/lib/analytics/events.ts` (US-049) | Allow-list `journey.golden_completed` with its two enums. |
| `web/src/pages/studio/WorkflowNew.tsx` (NZR-23), `TryRun.tsx` (US-026), `HelpMe.tsx` (US-049) | Call `journey.start()` on mount of `/workflows/new`, `journey.helpOpened()` in HelpMe, and `journey.readyReached(wfId)` after a successful Mark as ready. |
| `.gitignore` | Add `tests/e2e/studio-golden/.auth.json`. `test-results/` is already ignored (`.gitignore:76`). |
| `development.md` ("Automated tests") | Add a short section: how to run the golden suite locally, both modes, and the serial rule. |

* **New files:**
  - `tests/e2e/studio-golden/playwright.config.ts`:
    - `testDir: '.'`, `workers:1`, `fullyParallel:false`, `timeout:360_000`, `expect.timeout:25_000`;
    - `use:{baseURL:'http://localhost:5173/dashboard/', viewport:{width:1024,height:768}, video:'on', trace:'on', screenshot:'on'}`;
    - `outputDir:'../../../test-results/studio-golden'`, `globalSetup:'./global-setup.ts'`;
    - two `webServer` entries:
      - (1) `tsx --env-file=.env src/index.ts` on port 3000 with env `MODEL_REPLAY_DIR=tests/fixtures/studio/golden-replies` (or the live NZR-10 vars when `STUDIO_GOLDEN_MODEL=live`), `reuseExistingServer:false`, `url:'http://localhost:3000/health'`;
      - (2) `npm --prefix web run dev -- --port 5173 --strictPort`.
  - `tests/e2e/studio-golden/global-setup.ts`: refuses a non-local `CCE_BASE_URL`, runs `runGuard()` from `scripts/local/guard.ts`, provisions if needed, calls `seed()`, and writes `.auth.json`.
  - `scripts/studio/seed-golden.ts`, exporting `seed()`:
    - `createUserInvite({userId:'usr_golden_margaret', email:'margaret@example.test', profileId:'viewer', invitedBy:'seed-golden'})` then `activateUser`, both skipped if the user exists;
    - `createToken('studio-golden', 'seed-golden', 'viewer', 1, {userId, profileId:'viewer'})`;
    - `createAgentFull` for `policy-reviewer` (display name "Policy Reviewer", description "Reads insurance policies and lists missing or risky terms."), skipped if present;
    - soft-deletes the user's old routines through the NZR-12 store;
    - imports the guard and throws if it fails.
  - `tests/e2e/studio-golden/journey-a.spec.ts` (Scenarios 1–4), `tests/e2e/studio-golden/copy.ts`, `tests/e2e/studio-golden/global-setup.test.ts` (Scenarios 5–6, vitest with mocked repos).
  - `tests/fixtures/studio/golden-replies/*.json`: recorded model replies for the drafter, edit, step 1 review, and the decision check. Produced by `e2e:studio-golden:record`. Synthetic content only, no secrets (NZR-11 rules).
  - `web/src/lib/studio/journey.ts`: `start()`, `helpOpened()` and `readyReached(wfId)`, backed by `sessionStorage`; sends at most once.
  - `tests/e2e/studio/journey-event.spec.ts` (Scenario 7, mock mode in the US-049 harness), `src/lib/analytics/events.test.ts` (extend if it exists).
  - `docs/features/netzar-studio/dry-run/tester-script.md`: plain steps for the tester, with no product words beyond those on screen.
  - `docs/features/netzar-studio/dry-run/observer-sheet.md`: columns as in Scenario 8.
  - `docs/features/netzar-studio/dry-run/2026-11-23-results.md`: created on the day.

* **API contract:** No new routes. The test uses only routes defined in US-049, US-025 and US-026, plus the existing `POST /api/workflows/events` for the journey event (body ≤ 1 KB, 204).

* **Data changes:**
  - Local only: seeded user, token and agent in Floci, plus the studio table schema in `scripts/local/table-schemas.ts`.
  - No change to deployed data. No migration.

* **Security notes:**
  - Local target only. Seeding must not run if the guard fails (`scripts/local/guard.ts`: loopback endpoints, the emulator account `000000000000`, no real credentials). It also refuses any `CCE_BASE_URL` that is not `localhost` or `127.0.0.1`.
  - The seeded token lasts 1 day, is bound to a synthetic viewer, and its raw value is written only to a git-ignored file. It is never printed in logs.
  - Synthetic data only (Q67): `example.test` addresses, and the US-026 synthetic PDF with its "SYNTHETIC — NOT A REAL POLICY" header. Recorded replies are reviewed for secrets with `node scripts/ci/secret-scan.mjs tests/fixtures/studio/golden-replies/*` before commit.
  - The journey event carries no userId, wfId or free text (Q55).
  - Dry-run: testers use the synthetic sample only. The observer sheet stores first names or tester codes, never emails.

* **Test plan:**
  - Frozen failing test first (own commit, red SHA recorded): `tests/e2e/studio-golden/global-setup.test.ts`, covering "refuses non-local endpoints and deployed base URLs" and "second run reuses ids, mints a new token and clears old routines". Plus `journey-a.spec.ts`, committed with its steps written against the slice copy. It is red until the slices land, which is expected because this is the integration gate.
  - Commands (VPS clean clone, one at a time):
    1. `npm run local:up`
    2. `npm run local:verify`
    3. `npm run local:provision`
    4. `npx vitest run tests/e2e/studio-golden/global-setup.test.ts src/lib/analytics/events.test.ts`
    5. `npm run e2e:studio-golden` (3 consecutive green runs)
    6. `npm run e2e:studio` (mock suite incl. `journey-event.spec.ts`)
    7. `npm test`
    8. `npm run typecheck`
    9. `npm --prefix web run typecheck`
    10. `node scripts/ci/docs-links.mjs`
    11. `node scripts/ci/docs-assets.mjs`
  - Live recording: `npm run e2e:studio-golden:record` (needs NZR-10 credentials in `.env` on the VPS; never in git).

* **Repo rules that apply:**
  - Playwright installs follow Q78: lockfile `npm ci` only, chromium from the official download, clean clone, no secrets.
  - Run serially (Q69).
  - Add no new dependency: `@playwright/test` is already a dev dependency.
  - Run the full `npm test` before any push.
  - Update `development.md`, because the local test workflow changes.
  - Update the feature HANDOFF and write a dated session handoff that links the recording.

* **Rollback:** Test-only and local-only, except `journey.ts` and the one-line hooks. To roll back, revert the commit. The local seed can be cleared with `npm run local:reset`.

* **Build slices (proposal):**
  1. **Local harness:** config, global setup plus guard, seed script, table schema, and the setup unit tests. These turn green on their own.
  2. **Journey spec plus recordings:** `journey-a.spec.ts`, `copy.ts`, a live record run, and the committed replies. Turns green once NZR-49, NZR-23, NZR-24, NZR-25 and NZR-26 are merged.
  3. **Journey event plus dry-run kit:** `journey.ts`, the hooks, the event allow-list, `journey-event.spec.ts`, the tester script and the observer sheet.

* **Agent gotchas:**
  - The env root token has no person, so every studio call returns `person_required`. Always sign in with the seeded bound token (`localStorage.cce_token` via `addInitScript`, as `tests/e2e/chat/chat.spec.ts:31-32` does).
  - Floci's Bedrock returns placeholder text with no tool use. If replay is misconfigured, the drafter "succeeds" with junk or fails late. Assert the replay harness summary line, and fail fast on the first unmatched request (Scenario 4).
  - Vite serves the SPA under `/dashboard/`, so `baseURL` must end with `/dashboard/` and specs must use relative paths.
  - The US-026 try runs in-process. Playwright's `webServer` restart between runs kills any running try, which is fine because every run seeds fresh.
  - `tsx watch` restarts on file changes. Use plain `tsx` in `webServer`, or a mid-run edit restarts the server.
  - Never run this alongside `e2e:chat`, `e2e:studio` or any other Playwright job (RAM). The config sets `workers:1`, but separate invocations are not guarded.
  - The replay keys must not include timestamps or run ids. NZR-11 has to key on a normalized request (model, system prompt hash, messages), or every run misses.

---

## 5. Estimation & Tracking
* **Epic Name:** M2a Core slice (cycle C2a Core vertical slice (plain Workflows tab), 2026-11-10 to 2026-11-23)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47). NOTES-E-slice proposes 5, because of the local-target harness, seed, replay wiring and dry-run kit.
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** gate, e2e

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (one repeatable proof of Journey A; the Nov 23 dry-run bar).
- [ ] Acceptance criteria cover both happy paths and edge cases (8 scenarios: journey, records, recording, missing reply, unsafe target, idempotent seed, journey event, dry-run).
- [ ] UX/UI designs are attached and finalized: no new screens. The slice mocks are redone for the guided flow (Q101) and the slice copy is frozen in `web/src/lib/studio/copy.ts`.
- [ ] Dependencies have been identified and are unblocked:
  - NZR-49, NZR-23, NZR-24, NZR-25 and NZR-26 are merged.
  - NZR-11 replay works for the server process.
  - NZR-10 is reachable for the live recording.
  - NZR-3 clean clone has Playwright chromium.
  - NZR-47 testers are booked by Nov 15.
- [ ] Owner answers on Q109 (tester ages, Help tracking) and Q99 (words used by the selectors) are recorded. The recommended defaults are built.
- [ ] The team has reviewed and estimated the story points: 3 pts, with 5 proposed. Re-checked at the Nov 9 re-plan (Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. T2 review: a fresh Claude critic, free checks (`npm audit --omit=dev --audit-level=high`, `node scripts/ci/secret-scan.mjs` on the changed files and recordings, typecheck), and the step maid (Q68).
- [ ] Tests and gates:
  - A frozen failing test came first (red SHA recorded).
  - `npm run e2e:studio-golden` is green 3 times in a row on a clean checkout of the exact HEAD on the VPS.
  - The full `npm test` is green.
- [ ] QA and UAT:
  - QA: the fresh critic re-runs the gate against these criteria.
  - UAT: the owner watches the live recording and accepts it (Q51).
  - The Nov 23 dry-run results file exists, with one issue per finding.
- [ ] Documentation is updated:
  - `development.md` (golden suite section);
  - the dry-run kit;
  - the feature HANDOFF and a dated session handoff linking the video, the trace and `docs/assets/netzar-studio/golden/*.png`;
  - `journey.golden_completed` added to OBSERVABILITY.md (NZR-44).
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
