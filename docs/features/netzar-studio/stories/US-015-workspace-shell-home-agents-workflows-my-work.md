# [US-015] Workspace shell: Home, Agents, Workflows, My Work, Library

> Backlog task NZR-15 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-001, AC-001, NFR-001, NFR-005.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3), tested against the round-5 design target "Margaret, 67" (iPad and desktop first)
* **I want** five clear areas (Home, Agents, Workflows, My Work, Library) and one account menu instead of today's 28 sidebar tabs
* **So that** I find each area on the first try (target: 5 of 5 areas found first try by at least 4 of 5 testers, NZR-32)

---

## 2. Business Context & Description
* **Background:**
  * Q61 put the core slice (plain Workflows tab, NZR-49) first, Nov 10–23. This story replaces the 28-tab sidebar with the Workspace shell from about Nov 24 (cycle C2b).
  * **Q87 (owner decision, design O-1):** Home is at `/` for everyone. Overview moves to `/overview`. The Jarvis `ROUTE_TABLE`, the drift test, the guided tour, the Jarvis walkthrough and the first-run redirect are updated in this story.
  * **Q86 (owner decision, design O-2):** the Admin link in the account menu shows to anyone holding any Admin-screen capability. Each screen's API keeps its own server-side check.
  * **Design O-3:** every other URL stays the same in the MVP. Nothing is deleted.
  * Repo rule: Sidebar `NAV_ITEMS`, `App.tsx` routes and the Jarvis `ROUTE_TABLE` must agree (`web/src/App.tsx:228-231` comment; `src/lib/jarvis/route-manifest.ts:91-105`).
  * PRD: AC-001 "The user can reach the builder without navigating developer settings"; NFR-001 Home interactive within 3 s p95; NFR-005 WCAG 2.2 AA.
* **Current behaviour (d1d3a66):**
  * The only nav is `Sidebar`, rendered for every signed-in user (`web/src/App.tsx:206`). It lists 28 `NAV_ITEMS` in 7 groups (`web/src/components/Sidebar.tsx:92-233`). Each item can carry `minCapability`; `canSee` hides items until `/whoami` resolves (`Sidebar.tsx:254-266`).
  * Each link carries `data-tour="nav:<href>"` (`Sidebar.tsx:321`). The guided tour spotlights those anchors (`web/src/lib/tour/steps.ts:9-10`, `:36-66`).
  * `/` is Overview behind `overview:read` (`App.tsx:236`). Breadcrumbs call `/` "Overview" and the first crumb "Home" (`web/src/components/Header.tsx:7-8`, `:25`).
  * `ROUTE_TABLE` has 28 rows, first `{ route: '/', label: 'Overview' }` (`route-manifest.ts:106-159`). The drift test pins `resolveRoute('admin','overview') === '/'` (`src/lib/jarvis/route-manifest.test.ts:21`) and compares App paths and gates to `ROUTE_TABLE` with a regex (`route-manifest.test.ts:118-207`).
  * The Jarvis walkthrough's first stop is `route: '/'` described as Overview (`web/src/lib/jarvis/walkthrough.ts:31-37`).
  * First sign-in redirects to `/getting-started` unless `cce_company_onboarding_seen` or `cce_onboarded` is set (`App.tsx:166-177`; key at `web/src/pages/GettingStarted.tsx:17`). "Take the tour" there sets location `/` and starts the tour (`GettingStarted.tsx:202-207`).
  * The tour e2e expects tab 1 = Overview at `/dashboard/` (`tests/e2e/tour/tour.spec.ts:34-37`), then Agents, then Chat (`:46-54`).
  * `JarvisWidget` positions its orb by reading the sidebar DOM: `aside nav[aria-label="Main"]` and `[aria-label="Account controls"]` (`web/src/components/JarvisWidget.tsx:78-89`).
  * Every signed-in user prefetches 6 endpoints 1.5 s after load, including admin ones (`App.tsx:187-201`, design O-8). US-016 fixes this.
  * The web app has no unit tests and no test script (`web/package.json` scripts: dev, typecheck, build, preview). Root vitest only includes `src/**`, `infra/**`, `scripts/**` `*.test.ts` (`vitest.config.ts`), design O-6.
  * Builds on: NZR-49 (plain Workflows tab, adds `/workflows` routes and their `ROUTE_TABLE` rows before this story).
* **Target behaviour:**
  * A new `WorkspaceShell` replaces `Sidebar` on Workspace routes: a desktop/iPad left rail and a phone bottom bar with 5 areas plus an account menu (design W-014, W-019).
  * Area → routes: Home `/`; Agents `/agents`, `/agents/:id`, `/chat`, `/chat/:agentId`; Workflows `/workflows*` (from NZR-49); My Work `/my-work` (new, W-020); Library `/library` (new, W-021) and `/vectors`.
  * Account menu: My seat (`/my-seat`), Settings (`/settings`), Getting started (`/getting-started`), Guided tour, Admin (Q86 rule), Sign out.
  * Every other signed-in route (the 22 admin screens, design section 4) keeps today's `Sidebar` unchanged until US-016 replaces it with the Admin console nav. So nothing becomes unreachable between the two stories.
  * `/` renders a Home placeholder (title + the 3 quick-action links). US-017 fills it. `/overview` renders today's Overview behind `overview:read`.
  * One data-only nav manifest (`web/src/lib/nav/manifest.ts`) is the single list for Workspace areas, account-menu items and the legacy sidebar. A new vitest test checks it against `App.tsx` and `ROUTE_TABLE`.
  * The tour, walkthrough, Jarvis `resolveRoute`, breadcrumbs and `JarvisHud` suggestions point Overview at `/overview`.
  * **PENDING OWNER Q99:** Workspace labels use plain words: "Home", "Helpers" (Agents), "Routines" (Workflows), "My work", "Library". URLs do not change. If the owner says no, the labels are "Agents" and "Workflows" (one constant in the manifest).
  * **PENDING OWNER Q107:** the shell has a "Help me" button on every Workspace screen that opens a plain-words panel for the current screen (text from a per-route map) with a "Read it aloud" button. The arrow tour is NOT removed in this story (nothing deleted); see Out of scope.
* **Out of scope:**
  * Home content (hero chat, quick actions, Waiting for you, Recent work): US-017.
  * Admin console grouping, `/admin` index, 6-section nav, prefetch fix: US-016.
  * Mic button: US-018 (or the C2a slice if Q100 is accepted).
  * Agent page tabs: US-019. Font scale, 44 px targets, AAA, "Bigger text", axe: US-020. Welcome flow and retargeting the first-run redirect to it: US-021.
  * Retiring the arrow tour (Q107): a later story. This story only keeps it working at the new paths.
  * Playbooks (NZR-27) and Company facts (NZR-28) inside Library: those stories add their cards.
  * Moving any URL other than `/` (design O-3).
* **Target Value:** (1) `npx vitest run src/lib/jarvis/route-manifest.test.ts src/lib/jarvis/nav-manifest.test.ts` green. (2) In NZR-32 tester sessions, at least 4 of 5 testers open each of the 5 areas on the first try (tracked as `nav.area_opened` with `firstTry: true|false`). (3) Home placeholder interactive ≤ 3 s p95 over 20 Playwright runs (C-01).
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3); design target "Margaret, 67" (PENDING OWNER Q98/Q108). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Five areas and an account menu
* **Given** a principal with the templated viewer capabilities (stubbed `GET /api/whoami` returns `capabilities` = `VIEWER_CAPS`, `src/lib/auth/permissions.ts:195-210`) (after NZR-49 adds `workflows:read` and `workflows:write` to `VIEWER_CAPS`, per the NZR-49 v2 story `stories-v2/US-049-…` Files table; not at d1d3a66)
* **When** they open `/dashboard/`
* **Then** `nav[aria-label="Workspace"]` contains exactly 5 links in this order with these accessible names: "Home", "Helpers", "Routines", "My work", "Library" (PENDING Q99; else "Agents", "Workflows"), and a button named "Account menu"
* **And** no element with `nav[aria-label="Main"]` (the legacy sidebar) is in the DOM
* **Test:** `tests/e2e/workspace/shell.spec.ts` › "viewer sees five Workspace areas and the account menu"

### Scenario 2: Area hidden without its capability
* **Given** a seat-user principal (`capabilities` = `["dashboard:read","usage:self:read"]`, `permissions.ts:252-255`)
* **When** they open `/dashboard/`
* **Then** Home and Library show; Helpers (needs `agents:read`) and Routines (needs `workflows:read`, which NZR-49 keeps out of `SEAT_USER_CAPS`) are absent from the DOM, not just disabled
* **And** the account menu shows "My seat" and no "Admin" item
* **Test:** `tests/e2e/workspace/shell.spec.ts` › "seat-user does not see areas they cannot open"

### Scenario 3: Home owns `/`, Overview moves to `/overview`
* **Given** an admin principal
* **When** they open `/dashboard/` and then `/dashboard/overview`
* **Then** `/dashboard/` shows `h1` "Home" and makes no request to `/api/cost-today` or `/api/agents/health` from the Home component
* **And** `/dashboard/overview` shows the existing element `[data-tour="overview-title"]` (`web/src/pages/Overview.tsx:223`)
* **And** a principal without `overview:read` at `/dashboard/overview` sees "Overview access required" (`App.tsx:149-155`)
* **Test:** `tests/e2e/workspace/shell.spec.ts` › "home at root, overview at /overview, overview still gated"

### Scenario 4: Old links keep working
* **Given** a bookmark to any of the 28 static routes that existed at d1d3a66 other than `/` (for example `/dashboard/cost`, `/dashboard/vectors`, `/dashboard/jarvis`)
* **When** an admin principal opens it
* **Then** the page renders its own content (no `NotFound` text "Page not found") and the URL is unchanged
* **And** for every path in the d1d3a66 list, `App.tsx` still has a literal `<Route path="…">` (machine check in vitest)
* **Test:** `src/lib/jarvis/nav-manifest.test.ts` › "every d1d3a66 static route still has a Route in App.tsx"; `tests/e2e/workspace/shell.spec.ts` › "old bookmarks render, no NotFound"

### Scenario 5: Lists stay in sync (drift and nav manifest)
* **Given** the route change
* **When** `npx vitest run src/lib/jarvis/route-manifest.test.ts src/lib/jarvis/nav-manifest.test.ts` runs
* **Then** `ROUTE_TABLE` paths equal `App.tsx` static paths (including `/`, `/overview`, `/my-work`, `/library`); `resolveRoute('admin','overview') === '/overview'`; `resolveRoute('viewer','home') === '/'`
* **And** every manifest item's `href` is an App static route and its `capability` equals that route's `RequireCapability need` (or both are absent)
* **And** every App static route appears in exactly one of: Workspace areas, account menu, legacy/admin list
* **Test:** `src/lib/jarvis/route-manifest.test.ts` › "resolves labels, paths, and near-misses to the allowed route" (updated); `src/lib/jarvis/nav-manifest.test.ts` › "manifest hrefs and capabilities match App.tsx gates" and "every static route is reachable from exactly one nav list"

### Scenario 6: Tour, walkthrough and first-run point at the new paths
* **Given** the tour, the walkthrough and Getting Started
* **When** the tour starts from Settings, or "Take the tour" is clicked on `/getting-started`
* **Then** tab 1 "Overview" lands on `/dashboard/overview` (tour step target `nav:/overview`), then Agents, then Chat, as today
* **And** `DEMO_WALKTHROUGH[0].route === '/overview'`
* **And** a first sign-in (no `cce_company_onboarding_seen`, no `cce_onboarded`) at `/dashboard/` still redirects to `/dashboard/getting-started` (US-021 retargets it)
* **Test:** `tests/e2e/tour/tour.spec.ts` › "full tour: launches, walks tabs in order, skip + resume work" (URL expectation changed to `/overview`); `src/lib/jarvis/nav-manifest.test.ts` › "walkthrough and tour reference only App routes"

### Scenario 7: Admin link follows rights (Q86)
* **Given** (a) an operator principal and (b) a custom profile holding only `agents:read` and `chat:read`
* **When** each opens the account menu
* **Then** (a) sees "Admin" linking to the first Admin-list route they can open; (b) sees no "Admin" item
* **And** the link-visibility rule counts only capability-gated Admin screens (ungated `/jarvis` does not count; see Agent gotchas and NOTES)
* **Test:** `tests/e2e/workspace/shell.spec.ts` › "admin link shows only with an admin-screen capability"

### Scenario 8: Identity still loading or `/whoami` fails
* **Given** `GET /api/whoami` is delayed 3 s, or returns 500 with no cached role
* **When** the shell renders
* **Then** while loading, only Home and the account menu (without Admin) render; after a 500 the shell fails closed to viewer-less visibility (`auth.ts:98-104` sets role `viewer` but capabilities stay `[]`), so only ungated areas show, and no capability-gated link flashes in
* **Test:** `tests/e2e/workspace/shell.spec.ts` › "shell fails closed while identity loads or fails"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-31 / US-031](US-031-golden-workflow-end-to-end-insurance-policy.md) Golden workflow end to end: insurance policy review
* **Builds on (proposed dependencies, not yet in the backlog; see NOTES):** NZR-49 (`/workflows` routes and the Workflows capability) and NZR-3 (Playwright chromium for the new e2e specs).
* **UI/UX Design:** design.md screen inventory W-014 (shell), W-019 (account menu), W-020 (My Work), W-021 (Library home): **NO-MOCK-YET, due Nov 23** ([design.md](../foundation/design.md) section 3b/3c). Rules: design.md section 1 (light mode only, reduced motion, one primary action). Phone 390 x 844, iPad 1024 x 768 (PENDING Q108), desktop 1440 x 900.
* **Non-Functional Requirements:** NFR-001 Home interactive ≤ 3 s p95 (C-01). Text and target sizes are US-020's job, but new shell elements are built at ≥ 44 x 44 px targets (C-23) and body text uses the Workspace token US-020 defines (PENDING Q105: 20 px). Keyboard: rail links reachable by Tab in visual order, account menu opens with Enter/Space and closes with Esc, focus returns to the button. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `nav.area_opened` `{area: 'home'|'agents'|'workflows'|'my_work'|'library', firstTry: boolean}`; `help.opened` `{route}` (PENDING Q107). Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). The writer (`product_event` action, `src/lib/analytics/events.ts`, DATA-MODEL.md row "Product analytics event") has no owning story yet: this story adds `web/src/lib/analytics.ts` with an allow-list and a no-op transport, so events start flowing when the writer lands. UNVERIFIED: owner of the writer (see NOTES).

* **Files to change:**

| path | change |
|---|---|
| `web/src/App.tsx:160-212` | `AppShell` picks `WorkspaceShell` when `isWorkspaceRoute(location)` (from the manifest), else today's `Sidebar` + `Header`. Keep every `<Route path="…">` literal and on one line with its `<RequireCapability>` (drift regex, O-5). |
| `web/src/App.tsx:236` | `/` → `<Route path="/" component={Home} />` (ungated). Add `<Route path="/overview"><RequireCapability need="overview:read" label="Overview"><Overview /></RequireCapability></Route>`. Add `/my-work`, `/library` (ungated pages; their panels fail soft on 403). |
| `web/src/components/Sidebar.tsx:75-231` | Move item data (href, label, section, minCapability, icon key) into the manifest; Sidebar maps icon keys to the existing SVGs. Overview item href → `/overview`. Workspace items are not shown in the legacy sidebar on admin routes, except a "Back to Workspace" link at the top. |
| `web/src/components/Header.tsx:7-22` | Breadcrumb labels read from the manifest (fixes O-C for touched routes); `/` = "Home", `/overview` = "Overview". |
| `src/lib/jarvis/route-manifest.ts:106-159` | `/` label "Home", section "Workspace"; add `/overview` (Overview, Operations, viewer), `/my-work` (viewer), `/library` (viewer). Update the comment at `:91-105`. |
| `src/lib/jarvis/route-manifest.test.ts:21` | `resolveRoute('admin','overview')` → `/overview`; add `resolveRoute('viewer','home')` → `/`. |
| `web/src/lib/tour/steps.ts:36-66` | Overview tab: `route: '/overview'`, step 1 `target: 'nav:/overview'`, body no longer says "the first thing you see". Agents/Chat targets stay `nav:/agents`, `nav:/chat` (the Workspace rail renders the same `data-tour` anchors). |
| `web/src/lib/jarvis/walkthrough.ts:33-37` | First stop `route: '/overview'`; comment at `:31-32`. |
| `web/src/pages/GettingStarted.tsx:202-207` | `takeTour()` sets location `/overview` before `startTour()`. `markSeen('/')` at `:257` stays (Home). |
| `web/src/components/JarvisHud.tsx:223-235` | No change required: there is no `/` row today (`/` falls through to `DEFAULT_SUGGESTIONS` at `:236`, which also covers Home and `/overview`). Optional: add an `/overview` row. |
| `web/src/components/JarvisWidget.tsx:70-100` | Anchor lookup must find the Workspace rail too: query `nav[aria-label="Workspace"], aside nav[aria-label="Main"]`; keep the null fallback. |
| `tests/e2e/tour/tour.spec.ts:36-37` | Expect URL `/overview`. |
| `vitest.config.ts` | No change (new test lives under `src/`). |

* **New files:**
  * `web/src/lib/nav/manifest.ts` — data only (no JSX, no Preact import): `WORKSPACE_AREAS`, `ACCOUNT_MENU_ITEMS`, `ADMIN_ITEMS` (today's 22 admin `NAV_ITEMS` with `section` kept for US-016), `isWorkspaceRoute()`, `adminEntryRoute(caps)`, `canSeeAdminLink(caps)`.
  * `web/src/components/WorkspaceShell.tsx` — rail (≥ 1024 px), bottom bar (< 1024 px), account menu, "Help me" button (PENDING Q107), skip link reuse.
  * `web/src/components/AccountMenu.tsx` — W-019 menu (button `aria-haspopup="menu"`, `role="menu"` list).
  * `web/src/components/HelpMe.tsx` + `web/src/lib/help/content.ts` — PENDING Q107: per-route plain text; "Read it aloud" uses `window.speechSynthesis` with a voice whose `localService === true` only (no audio leaves the device); hidden if none.
  * `web/src/pages/Home.tsx` — placeholder: `h1` "Home" + 3 links (US-017 replaces the body).
  * `web/src/pages/MyWork.tsx` — W-020: empty state "Nothing here yet. Routines you build and try will show up here." Reads `GET /api/workflows` (NZR-49 v2: owner-only, `200 {workflows:[…]}`); UNVERIFIED until NZR-49 merges.
  * `web/src/pages/Library.tsx` — W-021: Documents card linking `/vectors` (shown with `vectors:read`). Other sections appear only when NZR-27/28 add them.
  * `web/src/lib/analytics.ts` — `track(name, props)` with allow-listed names. Transport: NZR-49 v2 plans `POST /api/workflows/events` + `src/lib/analytics/events.ts`; post there if it accepts these names, else no-op (UNVERIFIED, NOTES X2).
  * `src/lib/jarvis/nav-manifest.test.ts` — vitest (node env) importing `../../../web/src/lib/nav/manifest.ts` and reading `web/src/App.tsx`, `walkthrough.ts`, `steps.ts` as text.
  * `tests/e2e/workspace/playwright.config.ts` — serial, 1 worker, `webServer: npm --prefix web run preview -- --port 4173 --strictPort`, base `http://localhost:4173/dashboard/`. Viewports: 390 x 844, 1024 x 768, 1440 x 900.
  * `tests/e2e/workspace/fixtures/api-stubs.ts` — `page.route('**/api/**')` stubs with synthetic data per profile (seat-user, viewer, operator, admin, custom). No backend, no `.env`, no AWS.
  * `tests/e2e/workspace/shell.spec.ts` — Scenarios 1–4, 7, 8.

* **API contract:** N/A: no API change. The shell reads `GET /api/whoami` (existing; `web/src/lib/api.ts:667-673` shape `{role,label,email,profileId,capabilities}`).
* **Data changes:** None server-side. Browser `localStorage`: no new keys (Bigger-text key belongs to US-020). Existing keys `cce_sidebar_collapsed`, `cce_company_onboarding_seen`, `cce_onboarded`, `cce_tour_progress` keep their meaning. Rollback needs no data step.
* **Security notes:**
  * Hiding nav is not a control (SECURITY.md section 6 "Authorization on the server"; Q86). Every gated route keeps its `RequireCapability` and every API keeps `hasCapability`. This story changes no server check.
  * Fail closed: capability-gated links render only when `currentRole !== null && hasCapability(cap)` (same rule as `Sidebar.tsx:254-266`).
  * Design O-D: `/agents/:id` and `/chat/:agentId` stay ungated in App (unchanged); note it, do not widen it.
  * Product events carry no personal data (C-17): `track()` rejects keys not in the allow-list; `route` values are App route patterns, never ids.
  * "Read it aloud" (PENDING Q107) must not use a network voice; filter `speechSynthesis.getVoices()` by `localService`.
* **Test plan:**
  * Frozen failing tests first (red SHA recorded): `src/lib/jarvis/nav-manifest.test.ts` (all 4 tests) and the updated `resolveRoute` test in `route-manifest.test.ts`; then `tests/e2e/workspace/shell.spec.ts`.
  * Unit (vitest, node): manifest vs App gates; d1d3a66 route list (hard-coded array of the 28 paths) still present; walkthrough and tour routes ⊆ App routes; `canSeeAdminLink` truth table for seat-user, viewer, operator, admin, custom.
  * E2E (Playwright, hermetic with stubs): `shell.spec.ts`; existing `tests/e2e/tour/tour.spec.ts` updated (live-deploy spec; run only when a deploy exists).
  * Fixtures: synthetic names only ("Policy Checker", "Ops Helper"); no real emails.
  * Commands: `npx vitest run src/lib/jarvis/route-manifest.test.ts src/lib/jarvis/nav-manifest.test.ts`; `npm test`; `npm run typecheck`; `npm --prefix web run typecheck`; `npm --prefix web run build`; `npx playwright test --config tests/e2e/workspace/playwright.config.ts` (needs NZR-3's Playwright chromium install); `node scripts/ci/secret-scan.mjs <changed files>`; `npm --prefix web audit --omit=dev`.
* **Repo rules that apply:**
  * Nav sync: manifest + `App.tsx` + `ROUTE_TABLE` + drift test in the same change (`route-manifest.ts:91-105`). New capability ⇒ add to `CAPABILITY_MIN_ROLE` (`route-manifest.test.ts:165-192`, O-9).
  * No `handler.ts` change ⇒ no `docs/diagrams.map` update (map has no `web/` sources).
  * No new dependency (C-15). Tailwind 3 + Preact only (PENDING Q97).
  * Feature docs: update `docs/features/netzar-studio/HANDOFF.md` and add a dated file under `handoffs/` (docs/features/README.md section 6a).
  * Full `npm test` before push (CONTRIBUTING.md).
* **Rollback:** Revert the merge commit. No data or server state. If only the shell misbehaves, a one-line switch in `AppShell` (`isWorkspaceRoute` returns false) restores the legacy sidebar everywhere while keeping the `/overview` route.
* **Build slices (proposal):**
  1. **Manifest + routes** (~2 h): `manifest.ts`, Sidebar reads it, `/` placeholder Home, `/overview`, `/my-work`, `/library`, `ROUTE_TABLE`, drift updates. Turns green: `nav-manifest.test.ts`, `route-manifest.test.ts`.
  2. **Shell + account menu** (~3 h): `WorkspaceShell`, `AccountMenu`, Admin-link rule, JarvisWidget anchor, Playwright config + stubs. Turns green: `shell.spec.ts` Scenarios 1, 2, 7, 8.
  3. **Tour/walkthrough/first-run + old links** (~1.5 h): steps, walkthrough, GettingStarted, Header labels. Turns green: `shell.spec.ts` Scenarios 3, 4; tour/walkthrough unit checks.
  4. **Help me (PENDING Q107)** (~2 h): `HelpMe`, `help/content.ts`, `help.opened`. Turns green: `shell.spec.ts` › "Help me explains this screen and reads aloud with a local voice only". Drop this slice if the owner says no.
* **Agent gotchas:**
  * The drift regex needs `path="X">` immediately followed by `<RequireCapability need=…` (`route-manifest.test.ts:194-205`). Do not wrap routes in a layout component inside `<Route>`; choose the shell in `AppShell` by location instead (O-5).
  * A capability missing from `CAPABILITY_MIN_ROLE` silently counts as viewer (O-9).
  * `isRouteAllowed` treats `/` specially (`route-manifest.ts:218`: no prefix match for `/`). Keep that; `/overview` is a normal route.
  * Router base is `/dashboard` (`App.tsx:318`); Playwright URLs include it. Do not use port 4566 (LocalStack/Floci) or 3000/5173 (`npm run local`) for the preview server.
  * `Sidebar.tsx` NAV_ITEMS hold JSX icons; a node-env vitest cannot import `.tsx`. Keep the manifest free of JSX and Preact.
  * If tests are ever placed under `web/src`, add `"exclude": ["src/**/*.test.ts"]` to `web/tsconfig.json`, or the web typecheck pulls in vitest types.
  * `/jarvis` is ungated and `NAV_ITEMS` shows it to everyone (`Sidebar.tsx:116`, O-G). If it counted toward the Admin-link rule, every principal would see Admin.
  * Templated viewers hold 9 Admin-screen reads (`permissions.ts:195-210`), so under Q86 every templated profile from viewer up sees the Admin link. That is the decision, not a bug.
  * `pageOwnsTopBar` (`Sidebar.tsx:63-65`) and `tests/e2e/chat/conversation-ux.spec.ts:385` pin today's "Open main navigation" button. The chat route must keep a working nav opener on phones; update that spec's selector if the label changes (O-10).

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 8 (raw estimate 8 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** ui

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona A; Margaret target PENDING Q98).
- [ ] Acceptance criteria cover both happy paths and edge cases (8 scenarios above, including seat-user, custom profile, `/whoami` failure).
- [ ] UX/UI designs are attached and finalized: design.md W-014, W-019, W-020, W-021 are **NO-MOCK-YET, due Nov 23** (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77). Mocks must show iPad 1024 x 768 if Q108 is accepted.
- [ ] Dependencies have been identified and are unblocked (proposed extras marked in section 4; NZR-31; NZR-49 merged; NZR-3 Playwright chromium installed in the clean clone).
- [ ] Round-5 owner answers recorded for Q99 (labels) and Q107 (Help me), or the recommended defaults accepted.
- [ ] The team has reviewed and estimated the story points (8 pts; re-checked at the Nov 9 re-plan, Q71; see NOTES for the 13-pt proposal).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. T2: fresh Claude critic + free checks (`npm audit --omit=dev --audit-level=high`, `npm --prefix web audit --omit=dev`, `node scripts/ci/secret-scan.mjs <changed files>`, typecheck) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded: `nav-manifest.test.ts` + updated `route-manifest.test.ts`); the gate is green on a clean checkout of the exact HEAD: `npx vitest run src/lib/jarvis/route-manifest.test.ts src/lib/jarvis/nav-manifest.test.ts`, `npx playwright test --config tests/e2e/workspace/playwright.config.ts`; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51): viewer, seat-user and admin walk the 5 areas, `/overview`, an old bookmark, and the tour start.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts (Home at `/`, Overview at `/overview`, manifest is the nav source) promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
