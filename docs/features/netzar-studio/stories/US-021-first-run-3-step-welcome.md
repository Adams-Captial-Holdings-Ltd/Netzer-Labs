# [US-021] First-run 3-step welcome

> Backlog task NZR-21 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-001.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3), tested against "Margaret, 67" (PENDING OWNER Q98)
* **I want** a short guided start: pick a helper, add a document, try an example
* **So that** I get to a first result in under 5 minutes (target: median ≤ 5 min from first sign-in to a tested example routine across NZR-32 testers, with ≥ 4 of 5 finishing without tapping Help, Q109)

---

## 2. Business Context & Description
* **Background:**
  * OBJ-001 "Make workflow creation accessible to nontechnical users" (PRD line 177). Backlog AC: (1) they reach a tested example workflow; (2) Skip lands on Home and the welcome can be restarted from the account menu.
  * design.md W-018: first-run welcome (3 steps) at `/welcome` "or replaces the `/getting-started` redirect"; S-033: Getting Started is "replaced for business users" by the welcome; the admin checklist moves to an Admin landing card (W-034, US-016). Keep the route.
  * **Q87:** the first-run redirect is updated in the Home-at-`/` change (US-015 keeps it pointing at `/getting-started`; this story retargets it).
  * **PENDING OWNER Q107 (recommended ✅):** "Help me" on every screen, no arrow tours. The welcome is plain step cards, never a spotlight/arrow tour. Getting Started's "Take the tour" (`web/src/pages/GettingStarted.tsx:202-207`) stays for admins (nothing deleted). See NOTES on the arrow tour.
  * **PENDING OWNER Q100:** step 3 uses the example cards from the describe screen (6 cards, "Check new policies for gaps" first). **PENDING Q99:** labels "helper" and "routine".
  * **PENDING Q109:** at least 2 of 5 testers 60+, "finished without tapping Help" tracked.
* **Current behaviour (d1d3a66):**
  * First sign-in check runs once on `AppShell` mount: if neither `cce_company_onboarding_seen` nor `cce_onboarded` is in `localStorage` and the path is not `/getting-started`, it redirects there (`web/src/App.tsx:166-177`). It runs before `/whoami` resolves (`loadRole()` is called in the effect above, `:164`), so it cannot tell admins from business users.
  * `GettingStarted` shows an admin checklist when the principal holds `seats:write` or `members:write`, else a seat checklist (`GettingStarted.tsx:177-182`, `:51`, `:105`). Checked steps live in `localStorage` key `cce_company_onboarding_steps:<profileId>:<email>` (`:28-49`). `markSeen(destination)` sets `cce_company_onboarding_seen` and navigates (`:197-200`); "Skip" path is `markSeen('/')` (`:257`).
  * Agent list: `GET /agents` (`src/adapters/dashboard/handler.ts:1504`); Agents page needs `agents:read` (`App.tsx` gate).
  * Adding a document: `POST /vectors/upload-url` needs `vectors:read` (`handler.ts:3174-3176`); `POST /ingest/stream` needs `agents:write` (`handler.ts:3196-3200`), SSE stages including `transcribe` and `error` (`:3234-3260`). The browser flow is in `web/src/pages/Vectors.tsx:246-254`. A templated viewer cannot ingest (no `agents:write`, `src/lib/auth/permissions.ts:195-225`).
  * Example routine + test run: from NZR-23 (describe), NZR-24/NZR-26 (test run) and NZR-31 (golden workflow). UNVERIFIED: their API paths (not built at d1d3a66).
* **Target behaviour:**
  * New route `/welcome` (W-018), ungated route, own page with 3 numbered step cards and a "Step N of 3" label (`aria-current="step"`).
    1. **Pick a helper:** big cards from `GET /api/agents` (name + one plain line). Picking stores the id for steps 2–3. If 0 agents: "No helpers are set up yet. Ask your administrator." and step 1 can be skipped.
    2. **Add a document (optional):** one "Choose a file" button (and drag-drop) using the existing upload-url + ingest flow, into the picked helper's scope (falls back to `shared` until NZR-5 is merged; UNVERIFIED: scope rules, see NOTES). Shown only with `agents:write`; others see "Your administrator adds documents for you." and a "Next" button. Upload errors show plain words and "Try again" or "Skip this step".
    3. **Try an example:** the first example card ("Check new policies for gaps", PENDING Q100) opens the describe screen with the example prefilled (`nz_home_prefill` from US-017) and the picked helper; finishing the routine's test run (NZR-24/26) marks the welcome done. If the Workflows capability is missing, the card shows "Ask a helper" (opens `/chat/<agentId>`) instead.
  * **Progress:** `localStorage` key `nz_welcome:<profileId>:<email>` = `{ step: 1|2|3, agentId?, doc?: 'added'|'skipped', done?: true, skipped?: true }` (same per-user scoping as Getting Started). Reopening `/welcome` resumes at the saved step ("Welcome back. You were on step 2.").
  * **First-run redirect:** after `/whoami` resolves (not before), a principal with neither `cce_company_onboarding_seen`, `cce_onboarded`, nor a `nz_welcome` record with `done` or `skipped` goes to `/welcome` if they do not hold `seats:write`/`members:write`, else to `/getting-started` (today's admin checklist). Deep links other than `/` are not redirected (a tester opening a shared link lands where it points).
  * **Skip:** "Skip for now" on every step sets `skipped: true` and lands on Home (`/`). The account menu (W-019) gets "Start the welcome again", which clears `skipped`/`done` (keeps the agent pick) and opens `/welcome`.
  * **Done:** a "You're all set" panel with "Go to Home" and the time taken ("That took 4 minutes."), shown once.
  * Every step works by keyboard and screen reader; focus moves to the new step's heading on step change.
* **Out of scope:**
  * The describe screen, example cards and test run (NZR-23/24/26/31, Q100).
  * Removing `/getting-started` or the arrow tour (`web/src/lib/tour/*`): kept for admins (nothing deleted). Retiring the arrow tour under Q107 is a separate story (NOTES).
  * Server-side onboarding state (browser-only, like today).
  * Help-me text for `/welcome` (one entry in `web/src/lib/help/content.ts`, US-015).
* **Target Value:** (1) NZR-32: median time from first `/welcome` render to `onboarding.completed` ≤ 300 s; ≥ 4 of 5 testers finish without a `help.opened` event (Q109). (2) Hermetic e2e: the full path with stubs completes with 3 step events and 1 completed event in order.
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Finish the 3 steps
* **Given** an empty `localStorage`, an operator-like custom principal without `seats:write`/`members:write` (holds `agents:read`, `agents:write`, `vectors:read`, `chat:read` and the Workflows capability), and stubs: `GET /api/agents` → 2 agents ("Policy Checker", "Ops Helper"); upload-url + PUT + `POST /api/ingest/stream` SSE `stage: done`; the NZR-24/26 test-run API → `passed`
* **When** they sign in at `/dashboard/`, pick "Policy Checker", choose `renewals-2026.pdf`, then press the example card "Check new policies for gaps" and run its test
* **Then** they were redirected to `/dashboard/welcome`; the ingest request body has `scope: "policy-checker"` (or `"shared"` while `AGENT_KNOWLEDGE_SCOPED` is false); `sessionStorage.nz_home_prefill` held the example text when the describe screen opened; after the test passes, `/dashboard/welcome` shows "You're all set"
* **And** `track()` received `onboarding.step_completed` `{step:1}`, `{step:2, doc:'added'}`, `{step:3}` and `onboarding.completed` `{seconds}` in that order, and `nz_welcome:<profile>:<email>` has `done: true`
* **Test:** `tests/e2e/workspace/welcome.spec.ts` › "new user finishes the 3 steps and reaches a tested example"

### Scenario 2: Skip and restart
* **Given** a new business user on step 2
* **When** they press "Skip for now"
* **Then** they land on `/dashboard/` (Home), `onboarding.skipped` `{step:2}` is tracked, and a reload of `/dashboard/` does not redirect to `/welcome`
* **And** when they open the account menu and press "Start the welcome again", `/dashboard/welcome` opens at step 1 with "Policy Checker" still selected
* **Test:** `tests/e2e/workspace/welcome.spec.ts` › "skip lands on Home; account menu restarts the welcome"

### Scenario 3: Resume
* **Given** `nz_welcome:<profile>:<email>` = `{ "step": 2, "agentId": "policy-checker" }`
* **When** the user opens `/dashboard/welcome`
* **Then** step 2 is current (`aria-current="step"`), the text "Welcome back. You were on step 2." is shown, and focus is on the step 2 heading
* **Test:** `tests/e2e/workspace/welcome.spec.ts` › "resumes at the saved step"

### Scenario 4: Admins keep the admin checklist; old installs are not redirected
* **Given** (a) a new owner principal (holds `members:write`), (b) a business user with `cce_onboarded` set, (c) a new business user opening a shared link `/dashboard/agents/policy-checker`
* **When** each signs in
* **Then** (a) lands on `/dashboard/getting-started` with "Admin onboarding"; (b) is not redirected; (c) stays on the agent page (no redirect for deep links)
* **And** the redirect fires only after `/whoami` resolves (stub delays it 2 s; no navigation happens before)
* **Test:** `tests/e2e/workspace/welcome.spec.ts` › "redirect waits for identity and routes admins to Getting Started"; `src/lib/web-welcome/first-run.test.ts` › "firstRunTarget truth table"

### Scenario 5: No agents, no upload right, upload failure
* **Given** (a) `GET /api/agents` → `{ agents: [] }`; (b) a templated viewer (no `agents:write`); (c) `POST /api/ingest/stream` emits `{stage:'error', detail:'file is 31.0MB, over the 30MB limit for pdf ingest'}`
* **When** the welcome runs
* **Then** (a) step 1 shows "No helpers are set up yet. Ask your administrator." and a "Next" button; (b) step 2 shows "Your administrator adds documents for you." and no file button; (c) step 2 shows "That file is too big. Choose one under 30 MB, or skip this step." with "Try again" and "Skip this step", and the server's raw `detail` text is not shown
* **Test:** `tests/e2e/workspace/welcome.spec.ts` › "no agents, no upload right, upload failure"

### Scenario 6: Keyboard only
* **Given** a new business user
* **When** they complete steps 1–2 with Tab, Space/Enter and arrow keys only (agent cards are a `radiogroup`)
* **Then** each step change moves focus to the new heading, the file button opens the picker on Enter, and every control has a visible focus ring
* **Test:** `tests/e2e/workspace/welcome.spec.ts` › "keyboard-only path through steps 1 and 2"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-17 / US-017](US-017-home-animated-chat-hero-tailwind-css-port.md) Home: animated chat hero (Tailwind/CSS port) + quick actions
* **Builds on (proposed dependencies, not yet in the backlog; see NOTES):** NZR-15 (account menu, `track()`), NZR-23/24/26 (describe + test run, for step 3), NZR-5 (per-agent document scope; else `shared`).
* **UI/UX Design:** design.md W-018 (step 1, 2, 3; skipped; resumed; done; no agents available; upload failed): **NO-MOCK-YET, due Nov 23** ([design.md](../foundation/design.md)). Light mode; Workspace sizes from US-020; iPad + desktop first (PENDING Q108).
* **Non-Functional Requirements:** each step works by keyboard (Scenario 6); focus management on step change; `aria-live="polite"` for upload progress; ≥ 44 px targets; reduced motion (no animated step transitions). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `onboarding.step_completed` `{step:1|2|3, doc?:'added'|'skipped'|'not_allowed'}`, `onboarding.skipped` `{step}`, `onboarding.completed` `{seconds}`, `onboarding.restarted` `{}`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). No agent id, no file name. Uses US-015 `track()` (no-op until the writer exists, NOTES X2).

* **Files to change:**

| path | change |
|---|---|
| `web/src/App.tsx:166-177` | Replace the mount-time redirect with an effect on `currentRole` (resolved) that calls `firstRunTarget({ seen, onboarded, welcome, caps, location })` and navigates only when it returns a path and `location === '/'`. |
| `web/src/App.tsx` (Switch) | Add `<Route path="/welcome" component={Welcome} />` (ungated literal, one line). |
| `src/lib/jarvis/route-manifest.ts:106-159` | Add `{ route: '/welcome', label: 'Welcome', section: 'Account', minRole: 'viewer' }`. |
| `web/src/lib/nav/manifest.ts` (US-015) | Add "Start the welcome again" to `ACCOUNT_MENU_ITEMS` (action, not a plain link: clears skipped/done first). `/welcome` listed in the account list for the drift/nav test. |
| `web/src/components/AccountMenu.tsx` (US-015) | Render the restart item. |
| `web/src/pages/GettingStarted.tsx` | No behaviour change; export `checklistKey`-style helper reuse for the welcome key (or copy the 3-line function). |
| `tests/e2e/a11y/pages.ts` (US-020) | Add `/welcome` to `WORKSPACE_A11Y_PAGES`. |

* **New files:**
  * `web/src/pages/Welcome.tsx` — the 3-step page and done panel.
  * `web/src/lib/welcome/state.ts` — data-only: key builder, `readWelcome`/`writeWelcome` (try/catch, storage injectable), `firstRunTarget(...)`, `ingestErrorWords(detail)` (maps known server details like "over the …MB limit" to plain words; unknown → "We couldn't add that file. Try again, or skip this step.").
  * `src/lib/web-welcome/first-run.test.ts` — vitest (node): `firstRunTarget` truth table (seen / onboarded / done / skipped / admin / deep link), state round trip with in-memory `Storage`, `ingestErrorWords`.
  * `tests/e2e/workspace/welcome.spec.ts` — Scenarios 1–6 (US-015 config and stubs).

* **API contract:** N/A: no API change. Uses existing `GET /agents`, `POST /vectors/upload-url`, `POST /ingest/stream` (SSE `data: {stage, detail?}`), and the NZR-24/26 test-run API (UNVERIFIED shape; stubbed in e2e).
* **Data changes:** Browser `localStorage` key `nz_welcome:<profileId>:<email>` (JSON above). Existing keys `cce_company_onboarding_seen`, `cce_onboarded`, `cce_company_onboarding_steps:*` unchanged. Uploaded documents are normal knowledge documents (existing tables/buckets).
* **Security notes:**
  * SECURITY.md section 6 "Authorization on the server": hiding the upload button for non-`agents:write` principals is convenience; `/ingest/stream` keeps its check (boundary B1).
  * Do not echo raw server error `detail` strings into the page (they can contain internal paths); map to plain words.
  * Uploaded files are customer data: no file name in product events or logs (C-17).
  * The welcome key contains the email in the key name (same as today's Getting Started key, `GettingStarted.tsx:28-30`); acceptable for browser-local storage, noted for the privacy review.
* **Test plan:**
  * Frozen failing tests first: `src/lib/web-welcome/first-run.test.ts`, then `tests/e2e/workspace/welcome.spec.ts`; `src/lib/jarvis/route-manifest.test.ts` and `nav-manifest.test.ts` must stay green with `/welcome`.
  * Fixtures: synthetic agents and file `renewals-2026.pdf` (small generated PDF bytes); stub SSE stream for ingest; stubbed test-run API.
  * Commands: `npx vitest run src/lib/web-welcome/ src/lib/jarvis/`; `npm test`; `npm --prefix web run typecheck`; `npm --prefix web run build`; `npx playwright test --config tests/e2e/workspace/playwright.config.ts welcome.spec.ts`.
* **Repo rules that apply:** Nav sync: `/welcome` in `App.tsx` + `ROUTE_TABLE` + nav manifest in the same change. No `handler.ts` change ⇒ no `docs/diagrams.map` update. No new dependency. Feature HANDOFF + dated session handoff.
* **Rollback:** Revert the merge: the redirect goes back to `/getting-started` for everyone; `nz_welcome:*` keys are ignored. Uploaded documents stay (normal documents, deletable from Library).
* **Build slices (proposal):**
  1. **State + redirect** (~1 h): `state.ts`, `firstRunTarget`, App effect, `/welcome` route + ROUTE_TABLE. Green: `first-run.test.ts`; Scenario 4.
  2. **Steps 1–2** (~1.5 h): `Welcome.tsx` agent picker + upload. Green: Scenarios 3, 5, 6.
  3. **Step 3 + done + skip/restart** (~1 h, after NZR-23/24/26): example handoff, done panel, account-menu restart. Green: Scenarios 1, 2.
* **Agent gotchas:**
  * Today's redirect runs before `/whoami` resolves (`App.tsx:164-177`); waiting for the role is the core change. `currentRole.value !== null` is not enough: after a `/whoami` failure `loadRole()` sets the role to `'viewer'` anyway (`web/src/lib/auth.ts:98-104`). Add an explicit "identity loaded OK" signal in `auth.ts` and do not redirect after a failure.
  * `markSeen('/')` in GettingStarted (`:257`) already sends to `/`, which is Home after US-015; keep it.
  * The upload flow is raw `fetch` with SSE parsing in `Vectors.tsx:246-260`; extract a small shared helper only if it stays a minimum diff, otherwise copy the 15 lines.
  * Tour (`web/src/lib/tour/*`) and the welcome must never run at the same time: do not call `startTour()` from `/welcome`.
  * Example-card text must match NZR-23's card list (one shared constant; UNVERIFIED location until NZR-23 lands).

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** ui

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases (skip, resume, admin, old install, deep link, no agents, no right, upload failure, keyboard).
- [ ] UX/UI designs are attached and finalized: design.md W-018 is **NO-MOCK-YET, due Nov 23** (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (proposed extras marked in section 4; NZR-17; NZR-15; NZR-23/24/26 APIs frozen for step 3; NZR-5 status known for the document scope).
- [ ] Round-5 answers for Q99, Q100, Q107, Q109 recorded or defaults accepted.
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71; NOTES proposes 5).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. T2: fresh Claude critic + free checks (npm audit, secret scan, typecheck) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: `npx vitest run src/lib/web-welcome/ src/lib/jarvis/` and `npx playwright test --config tests/e2e/workspace/playwright.config.ts welcome.spec.ts`; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51): a fresh browser profile goes through the welcome in under 5 minutes; skip and restart; an owner still gets the admin checklist.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; the first-run rule (business users → `/welcome`, admins → `/getting-started`, after identity loads) promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
