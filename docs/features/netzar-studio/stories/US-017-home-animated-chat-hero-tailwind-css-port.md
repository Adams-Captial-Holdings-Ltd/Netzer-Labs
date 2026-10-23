# [US-017] Home: animated chat hero (Tailwind/CSS port) + quick actions

> Backlog task NZR-17 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-001, NFR-002, AC-001.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3), tested against "Margaret, 67" (PENDING OWNER Q98)
* **I want** a calm Home with one big "What would you like help with?" box, three big action buttons, and short "Waiting for you" and "Recent work" lists
* **So that** I start a routine from Home without help (target: at least 4 of 5 testers in NZR-32 start the golden routine from Home unaided, and Home is interactive in ≤ 3 s p95)

---

## 2. Business Context & Description
* **Background:**
  * The owner shared an `animated-ai-chat.tsx` (React + framer-motion) as the look for Home. The owner rule: recreate the look with Tailwind 3 and CSS only, no framer-motion, no new dependency (C-15; PENDING OWNER Q97 confirms Preact + Tailwind 3, shadcn look copied, not installed).
  * AC-001: reach the builder without developer settings. NFR-001: Home interactive within 3 s p95 (C-01). NFR-002: visible acknowledgement within 3 s (C-02).
  * **Q87:** Home is at `/` for everyone (US-015 moved Overview to `/overview` and left a placeholder Home).
  * Round 5 (pending): plain words (Q99), 20 px text and AAA contrast in the Workspace (Q105, built by US-020), "Help me" on every screen (Q107, shell from US-015), tester tracking "finished without Help" (Q109).
  * UNVERIFIED: the source file `animated-ai-chat.tsx` is not in the repo or the grill folder (`find / -name "animated-ai-chat*"` → no hits). The builder needs it attached (for example under `docs/assets/netzar-studio/reference/`) or works from the state list in design.md W-015 and the description below.
* **Current behaviour (d1d3a66):**
  * After US-015, `/` renders a placeholder `web/src/pages/Home.tsx` (title + 3 links). Before US-015, `/` is Overview (`web/src/App.tsx:236`).
  * The chat empty state `ChatLanding` already has a mark, a large greeting and 3 starter buttons that drop text into the composer without sending (`web/src/components/chat/ChatLanding.tsx:27-31`, `:55-91`). Its header notes the donor's animated greeting was dropped to avoid `@react-spring` (`:11-12`).
  * `react-textarea-autosize` is already a web dependency and used by the chat composer (`web/src/components/chat/Composer.tsx:95`; `web/package.json`). Re-using it adds no dependency.
  * A global rule already zeroes animation and transition durations under `prefers-reduced-motion: reduce` (`web/src/index.css:338-343`). Existing keyframes: `shimmer`, `pageIn`, `shake`, `pulse-dot` (`index.css:358-388`).
  * Chat has no external "prefill" entry point; drafts are stored per agent/chat in `sessionStorage` (`web/src/lib/chat/drafts.ts:3-31`).
  * Workflows list/describe come from NZR-49 and NZR-23. UNVERIFIED: the list API path and response shape (not built at d1d3a66). design.md proposes `/workflows/new` for the describe screen.
* **Target behaviour:**
  * **Hero (W-015):** a centred greeting ("What would you like help with?"), one large auto-growing text box (`react-textarea-autosize`, max 6 rows), a Send button, and 3 suggestion pills that put example text into the box without sending. Soft blurred colour shapes behind the box drift slowly (CSS keyframes); the box gets a glow ring on focus; a 3-dot "thinking" indicator shows after Send until the next screen paints.
  * Typing `/` as the first character opens a small command list (W-015 "`/` command palette") with the same 3 actions. ↑/↓ moves, Enter picks, Esc closes; it is a `role="listbox"` linked by `aria-activedescendant`.
  * Send stores the text in `sessionStorage` key `nz_home_prefill` (never in the URL) and navigates to `/workflows/new`. The describe screen (NZR-23) reads and clears the key. The hero shows only to principals holding `workflows:write` (added by NZR-49); others see the quick actions only.
  * **Quick actions (W-016):** 3 large buttons, each hidden without its capability: "Make a new routine" → `/workflows/new`; "Ask a helper" → `/chat` (`chat:read`); "Add a document" → `/vectors` (`vectors:read`). PENDING OWNER Q99: labels in plain words; if rejected: "Build a workflow", "Talk to an agent", "Add knowledge".
  * **Waiting for you:** up to 5 of my routines that need me (NZR-49 label "Needs setup" or "Test again"), each with one plain next-step button. **Recent work:** my 5 most recently changed routines. Each panel has its own loading, empty and error state, so one failing panel never blanks Home.
  * **Reduced motion:** with `prefers-reduced-motion: reduce`, no element animates (shapes static, no glow pulse, dots shown as static text "Working…"), and every function still works.
  * Light mode only for the new styles (design section 1); colours use the app's tokens, not the reference file's.
* **Out of scope:**
  * The routine builder screens and the 6 example cards (Q100): NZR-23/NZR-49 in the C2a slice.
  * Mic button in the hero: US-018 (or the slice if Q100 is accepted).
  * Attachment chips in the hero (listed in design.md W-015): not built; documents go through "Add a document" (see NOTES).
  * Font scale, 44 px target audit, AAA, "Bigger text", axe: US-020 (this story uses its tokens if merged, otherwise today's tokens).
  * "Help me" text for Home: one entry in `web/src/lib/help/content.ts` (US-015 shell), PENDING Q107.
  * Approvals in "Waiting for you" (later AC-023, C3).
* **Target Value:** (1) Home interactive (hero box focusable, quick actions clickable) ≤ 3,000 ms p95 over 20 Playwright runs with stubbed APIs and 4x CPU throttle (regression guard for C-01; the full C-01 measurement on a local install happens in NZR-32 prep). (2) Send → describe screen visible ≤ 3 s p95 (C-02). (3) NZR-32: ≥ 4 of 5 testers start the golden routine from Home without tapping Help (`home.quick_action` + `help.opened` events, Q109).
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Quick action opens the describe screen
* **Given** a principal with `workflows:write` (NZR-49), `chat:read` and `vectors:read`
* **When** they open `/dashboard/` and click the button named "Make a new routine"
* **Then** the URL becomes `/dashboard/workflows/new` and a `home.quick_action` event `{action:'new_routine'}` is passed to `track()`
* **Test:** `tests/e2e/workspace/home.spec.ts` › "quick action opens the describe screen"

### Scenario 2: Hero hands text to the describe screen, not the URL
* **Given** the same principal on Home
* **When** they type "Check new policies for missing signatures" and press Enter
* **Then** `sessionStorage.getItem('nz_home_prefill')` equals that text, the URL is exactly `/dashboard/workflows/new` (no query string), and the 3-dot indicator with accessible name "Working" was visible before navigation
* **And** an empty or whitespace-only box does not navigate; the Send button is disabled with `aria-disabled="true"` and the hint "Type what you'd like help with first."
* **Test:** `tests/e2e/workspace/home.spec.ts` › "hero stores text in sessionStorage and opens describe"; `src/lib/web-home/home-prefill.test.ts` › "prefill trims, caps at 4,000 chars and never writes to the URL"

### Scenario 3: Keyboard-only use of the command list
* **Given** focus is in the hero box
* **When** the user types `/`, presses ↓ twice and Enter
* **Then** the listbox with 3 options opened, the third option ("Add a document") was `aria-selected="true"`, and the URL becomes `/dashboard/vectors`
* **And** Esc closes the list and leaves focus in the box with the `/` still typed
* **Test:** `tests/e2e/workspace/home.spec.ts` › "slash command list works by keyboard"

### Scenario 4: Reduced motion
* **Given** Playwright `reducedMotion: 'reduce'`
* **When** Home loads and the user sends text
* **Then** for every element under `[data-home-hero]`, `getComputedStyle(el).animationName === 'none'` or its `animationDuration` is `0s`, the indicator shows the static text "Working…", and the navigation in Scenario 2 still happens
* **Test:** `tests/e2e/workspace/home.spec.ts` › "reduced motion: nothing animates, everything works"

### Scenario 5: Empty Home for a new user
* **Given** the routines list API returns an empty list
* **When** Home loads
* **Then** "Waiting for you" shows "Nothing needs you right now." and "Recent work" shows "Things you make will show up here." and the 3 quick actions are visible
* **Test:** `tests/e2e/workspace/home.spec.ts` › "new user sees plain empty states"

### Scenario 6: One panel fails, Home still works
* **Given** the routines list API returns HTTP 500 (or the request times out after 10 s)
* **When** Home loads
* **Then** both panels show "We couldn't load this. Try again." with a "Try again" button that re-requests once per click, and the hero and quick actions stay usable
* **And** a 403 from that API hides both panels instead of showing an error (same rule as Overview `failSoft`, `web/src/pages/Overview.tsx:85-101`)
* **Test:** `tests/e2e/workspace/home.spec.ts` › "panel error is local; 403 hides the panel"

### Scenario 7: No capability, no button
* **Given** a seat-user principal (`dashboard:read`, `usage:self:read`)
* **When** they open Home
* **Then** there is no hero box and no quick action buttons; Home shows "Your account can't make routines yet. Ask your administrator." and the "Help me" button (PENDING Q107)
* **Test:** `tests/e2e/workspace/home.spec.ts` › "seat-user sees no actions they cannot use"

### Scenario 8: Home is fast
* **Given** stubbed APIs, a fresh browser context and 4x CPU throttle (CDP `Emulation.setCPUThrottlingRate`)
* **When** `/dashboard/` is loaded 20 times
* **Then** the p95 time from navigation start to the hero box being enabled is ≤ 3,000 ms, and the Home chunk does not import `pages/Chat`, `marked` or `highlight.js` (checked in the `vite build` manifest)
* **Test:** `tests/e2e/workspace/home.perf.spec.ts` › "home interactive p95 ≤ 3 s over 20 runs"; `src/lib/web-home/home-bundle.test.ts` › "Home chunk does not pull chat or markdown modules"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-15 / US-015](US-015-workspace-shell-home-agents-workflows-my-work.md) Workspace shell: Home, Agents, Workflows, My Work, Library
* **Builds on (proposed dependencies, not yet in the backlog; see NOTES):** NZR-49 (routine list API + Workflows capability) and NZR-23 (describe screen reads `nz_home_prefill`).
* **UI/UX Design:** design.md W-015 (hero: idle, `/` palette, suggestion pills, typing indicator, send error, reduced motion) and W-016 (quick actions, Waiting for you, Recent work: loading, empty, populated, error per panel): **NO-MOCK-YET, due Nov 23** ([design.md](../foundation/design.md)). Reference look: owner's `animated-ai-chat.tsx` (UNVERIFIED location, see Background). Light mode only; iPad 1024 x 768 + desktop first, phone works (PENDING Q108).
* **Non-Functional Requirements:** Keyboard usable (Scenario 3); reduced motion respected (C-24); no new dependency (C-15); ≥ 44 x 44 px targets (C-23); Workspace text token from US-020 (PENDING Q105: 20 px, AAA). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `home.quick_action` `{action:'new_routine'|'ask_helper'|'add_document'|'hero_send'|'slash_command', source:'button'|'hero'|'slash'}`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Never send the typed text. Uses US-015 `track()` (no-op until the writer exists, NOTES X2).

* **Files to change:**

| path | change |
|---|---|
| `web/src/pages/Home.tsx` (from US-015) | Replace the placeholder body with `HomeHero`, `QuickActions`, `WaitingPanel`, `RecentPanel`. Keep `h1` "Home" (visually the greeting; `h1` text may be "Home" with `sr-only` if the greeting is an `h2`). |
| `web/src/index.css` (components layer, near `:358-388`) | Add `@keyframes home-drift` (slow translate/scale of the blurred shapes, ≥ 12 s), `home-glow` (focus ring opacity), `home-dot` (3-dot bounce). Add a `@media (prefers-reduced-motion: reduce)` block that sets `animation: none` on `.home-*` classes (the global rule only zeroes duration; infinite loops must be off). |
| `web/src/lib/help/content.ts` (from US-015) | Home entry (PENDING Q107). |
| `web/src/lib/analytics.ts` (from US-015) | Allow-list `home.quick_action` and its props. |

* **New files:**
  * `web/src/components/home/HomeHero.tsx` — greeting, `TextareaAutosize` box, Send, pills, slash listbox, thinking dots.
  * `web/src/components/home/QuickActions.tsx` — 3 capability-aware buttons.
  * `web/src/components/home/HomePanels.tsx` — Waiting for you / Recent work with per-panel states.
  * `web/src/lib/home/prefill.ts` — data-only: `writeHomePrefill(text)`, `readAndClearHomePrefill()`, key constant `nz_home_prefill`, trim + 4,000-char cap (UNVERIFIED: align the cap with NZR-23's describe input limit, design W-002 "input too long").
  * `web/src/lib/home/status.ts` — data-only mapper: a routine "needs me" when NZR-49's `labelFor` gives "Needs setup" or "Test again" (NZR-49 v2 story, Target behaviour label rules); next-step labels "Finish setting up" / "Test it again". UNVERIFIED until NZR-49 merges.
  * `src/lib/web-home/home-prefill.test.ts` — vitest (node) for `prefill.ts` and `status.ts` with an in-memory `Storage`.
  * `src/lib/web-home/home-bundle.test.ts` — reads `web/dist/.vite/manifest.json` after build; skips with a clear message if the build is absent. UNVERIFIED: `build.manifest` is not enabled in `web/vite.config.ts`; alternative is grepping the Home chunk file for `marked`.
  * `tests/e2e/workspace/home.spec.ts`, `tests/e2e/workspace/home.perf.spec.ts` — use US-015's config and stubs; pattern follows `tests/e2e/perf/run.mjs:1-30` (stubbed `page.route` against local Vite).

* **API contract:** N/A: no API change. Reads `GET /api/workflows` from NZR-49 (owner-only; `200 {"workflows":[…]}`, 401 `{"error":"unauthorized"}`, 403 `{error:'forbidden', requiredCapability:'workflows:read'}`, per the NZR-49 v2 story). UNVERIFIED: item fields (name, label, updatedAt) until NZR-49 merges; only `status.ts` and the stubs change if they differ.
* **Data changes:** Browser `sessionStorage` key `nz_home_prefill` (string ≤ 4,000 chars, cleared on read; tab-scoped so it never outlives the tab). No server data.
* **Security notes:**
  * Typed text may hold personal data. It never goes in the URL, logs, product events or `localStorage` (C-17; SECURITY.md section 6 "No secret goes in … logs").
  * Rendered routine names are plain text (Preact escapes); never `dangerouslySetInnerHTML`.
  * Buttons hidden without capability are convenience only; NZR-49/23 APIs enforce their own capability (boundary B1).
  * No model call from Home (keeps spend at zero on page load; asset A8).
* **Test plan:**
  * Frozen failing tests first: `src/lib/web-home/home-prefill.test.ts`, then `tests/e2e/workspace/home.spec.ts` Scenarios 1–7.
  * Perf: `home.perf.spec.ts` (serial; 20 runs; report p50/p95 in the session handoff).
  * Fixtures: synthetic routine names ("Check new policies", "Renewal reminders"); stub sets: empty, populated, 500, 403, slow (10 s).
  * Commands: `npx vitest run src/lib/web-home/`; `npm --prefix web run build`; `npx playwright test --config tests/e2e/workspace/playwright.config.ts home.spec.ts home.perf.spec.ts`; `npm test`; `npm --prefix web run typecheck`.
* **Repo rules that apply:** No new dependency (reuse `react-textarea-autosize`; no framer-motion, no `@react-spring`). No route change (Home route came in US-015) ⇒ no drift/ROUTE_TABLE change. No `handler.ts` change ⇒ no `docs/diagrams.map` update. Feature HANDOFF + dated session handoff.
* **Rollback:** Revert the merge; Home returns to US-015's placeholder. Stale `nz_home_prefill` keys die with the tab.
* **Build slices (proposal):**
  1. **Panels + quick actions** (~2 h): `QuickActions`, `HomePanels`, `status.ts`. Green: Scenarios 1, 5, 6, 7.
  2. **Hero + prefill + slash list** (~2.5 h): `HomeHero`, `prefill.ts`, CSS keyframes. Green: Scenarios 2, 3, 4; `home-prefill.test.ts`.
  3. **Perf guard** (~1 h): `home.perf.spec.ts`, bundle check. Green: Scenario 8.
* **Agent gotchas:**
  * The global reduced-motion rule sets `animation-duration: 0ms` but keeps `animation-iteration-count: infinite`; set `animation: none` explicitly for the hero loops.
  * Large `blur-3xl` layers are expensive on iPad Safari; keep ≤ 3 shapes, `will-change: transform`, `pointer-events: none`, `aria-hidden="true"`.
  * On iOS Safari, `index.css:309-311` sets `input, select, textarea { font-size: 16px !important; }`. That `!important` beats a 20 px Workspace token, so the hero box would render at 16 px on an iPad. US-020 owns the fix (scope the rule to `font-size: max(16px, var(--ws-text))`); if US-020 has not landed, note it in the handoff.
  * Do not import from `pages/Chat` or `components/chat/*` (pulls the chat chunk with markdown and highlight.js into Home, hurting C-01). Import `react-textarea-autosize` directly.
  * The tour's old Overview steps referenced `/`; US-015 moved them. Do not add `data-tour` anchors on Home unless the tour adds a Home tab.
  * Fake timers in Playwright: measure with `performance.now()` in the page, not wall clock from the runner.

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 5 (raw estimate 6 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** ui

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases (empty, 500, 403, seat-user, reduced motion, keyboard, perf).
- [ ] UX/UI designs are attached and finalized: design.md W-015, W-016 are **NO-MOCK-YET, due Nov 23**; the owner's `animated-ai-chat.tsx` reference is attached to the repo (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (proposed extras marked in section 4; NZR-15; NZR-49 list API shape and capability name frozen; NZR-23 agrees to read `nz_home_prefill`).
- [ ] Round-5 answers for Q99 (labels) and Q105 (text scale) known or defaults accepted.
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. T2: fresh Claude critic + free checks (npm audit, secret scan, typecheck, `git diff web/package-lock.json` shows no change) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: `npx vitest run src/lib/web-home/` and `npx playwright test --config tests/e2e/workspace/playwright.config.ts home.spec.ts home.perf.spec.ts`; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51) on iPad-size and desktop, with reduced motion on and off.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff (with the p50/p95 numbers); durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
