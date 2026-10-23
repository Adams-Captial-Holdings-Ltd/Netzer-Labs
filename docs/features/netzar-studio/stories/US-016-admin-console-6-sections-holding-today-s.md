# [US-016] Admin console: 6 sections holding today's admin screens

> Backlog task NZR-16 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-015, FR-013, OBJ-007.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** all 22 of today's admin screens grouped in one Admin console with 6 sections, opened from the account menu
* **So that** I keep every control (0 screens lost, 0 permission changes) without cluttering the Workspace that business users see

---

## 2. Business Context & Description
* **Background:**
  * Blueprint section 7 item 6: "Nothing deleted", "permission checks unchanged". FR-015: existing agent/chat/governance capabilities remain functional. OBJ-007: extend, don't rewrite.
  * **Q86 (owner decision, design O-2):** the Admin link shows to anyone holding any Admin-screen capability and lists only the screens they can open. Each screen's API keeps its own server-side check. Hiding nav is not security.
  * **Design O-3:** keep today's URLs. The console is a new grouping, not new URLs. Only `/admin` (the index) is new.
  * design.md section 4 defines the 6 sections and the 22 screens. design.md also notes the backlog's old "18 admin tabs" cannot be backed by the code; the title already says 6 sections.
* **Current behaviour (d1d3a66):**
  * All 28 tabs sit in one `Sidebar` with 7 groups: Core, Operations, Security, Advanced, Collaboration, Team, Account (`web/src/components/Sidebar.tsx:92-233`). After US-015, the 22 non-Workspace tabs still render in this legacy sidebar on admin routes.
  * Each admin route is gated in `App.tsx` by `<RequireCapability need=… label=…>` (`web/src/App.tsx:236-299`); the denied state is a generic EmptyState "\<label\> access required" (`App.tsx:149-155`).
  * Every admin API checks `hasCapability` itself, for example `GET /sessions` → `sessions:read` (`src/adapters/dashboard/handler.ts:2597-2598`), `GET /audit` → `audit:read` (`:2761-2762`), `GET /kill-switches` → `kill-switches:read` (`:2773-2781`), `GET /cost-today` → `overview:read` (`:3068-3071`). The route-level authorization matrix test drives the real routers (`src/adapters/dashboard/authz-matrix.test.ts:1-22`, `:401-560`).
  * Group labels disagree between lists: Integrations is "Security" in the sidebar but "Collaboration" in `ROUTE_TABLE` (`Sidebar.tsx:175` vs `src/lib/jarvis/route-manifest.ts:138`, design O-A); DLP is "DLP & Exfil" vs "DLP" (O-B). Nothing tests labels or groups (`route-manifest.test.ts:118-206`).
  * Every signed-in user prefetches `/agents`, `/sessions`, `/kill-switches`, `/audit?days=7`, `/cost-today`, `/usage/daily…` 1.5 s after load (`App.tsx:187-201`, design O-8). A principal without those capabilities makes 403 calls on every load.
  * Admin cards live inside Settings and are gated on the role string `role === 'admin'` (`web/src/pages/Settings.tsx:128`): Daily cost cap (`:534`), API access (`:613`), Themes (`:678`) and others (design S-034, O-E).
  * Templated profiles: viewer holds 9 Admin-screen reads (overview, sessions, usage, audit, missions, memories, hive, scheduled, warroom) plus `chat:read` for Playground (`src/lib/auth/permissions.ts:195-210`). Seat-user holds only `dashboard:read` and `usage:self:read` (`:252-255`).
* **Target behaviour:**
  * The 22 admin screens are grouped into 6 sections (design section 4): **Operations** (Overview `/overview`, Sessions, Missions, Scheduled, War Room), **Usage & cost** (Usage, Cost), **Safety controls** (Kill Switches, Panic, DLP & Exfil, Rate Limits, Alerting), **Governance** (Audit Log, Security Posture, Compliance, Hive Mind), **People & connections** (Members, Seats, Integrations), **Developer tools** (Jarvis `/jarvis`, Playground, Memories).
  * On any admin route, the left rail shows only these 6 sections (Admin keeps today's density; no 18/20 px rule), a "Back to Workspace" link at the top, and only the screens the principal can open. A section with no visible screen is hidden (W-033).
  * New `/admin` index (W-033/W-034): section cards listing the allowed screens (each 1 click away); a "Stop all agents" link to `/panic` for principals with `security:write`; a card "Admin setup checklist" linking `/getting-started` for principals with `members:write` or `seats:write`; a card naming the admin cards still on Settings (Daily cost cap, API access tokens, Themes) with a link. Nothing moves out of Settings in this story.
  * A principal with no Admin-screen capability who opens `/admin` sees W-036: "You don't have access to Admin. Ask your administrator if you need it." and a "Back to Home" button.
  * The account-menu Admin link (from US-015) now opens `/admin`. Its visibility rule is unchanged (Q86; ungated `/jarvis` does not count, see NOTES).
  * `ROUTE_TABLE` `section` values use the 6 section names, and a test keeps manifest sections, labels and `ROUTE_TABLE` in step (fixes O-A, O-B for these routes).
  * The 1.5 s prefetch only requests paths whose capability the principal holds, and only once an admin route is opened (fixes O-8).
  * Light mode is the tested mode for the new `/admin` page. Reduced motion respected (no new animation).
* **Out of scope:**
  * Moving the Settings admin cards into Admin sections, and replacing `role === 'admin'` checks with capabilities (O-E): a later story (see NOTES).
  * Company facts approval queue (W-025, NZR-28) and Proposed lessons (W-026, NZR-29): those stories add their screens to Governance.
  * Moving any URL to `/admin/*` (O-3). Developer tools index route `/admin/developer` (W-035) is not added; Developer tools is a section on `/admin`.
  * Workspace shell and areas: US-015. Moving Jarvis' mic into Home/chat: US-018.
  * Any server permission change. This story may only add tests on the server.
* **Target Value:** (1) For each of 5 principals (seat-user, viewer, operator, admin, owner), the set of screens listed on `/admin` equals the set of the 22 routes whose `RequireCapability need` they hold (plus `/jarvis` when the list is non-empty); checked by a vitest truth table. (2) 0 server permission regressions: the extended authz matrix shows 403 for every lacking principal. (3) Each of the 22 screens is 1 click from `/admin` and ≤ 2 clicks from any admin screen.
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Every admin screen reachable for an owner
* **Given** an owner principal (stub `GET /api/whoami` with all capabilities)
* **When** they open the account menu, click "Admin", then each link on `/admin`
* **Then** `/admin` shows 6 section headings in order "Operations", "Usage & cost", "Safety controls", "Governance", "People & connections", "Developer tools" and 22 screen links
* **And** each link opens its existing URL (for example "DLP & Exfil" → `/dashboard/dlp`) and the page's own content renders (no "access required" text)
* **Test:** `tests/e2e/workspace/admin.spec.ts` › "owner reaches all 22 admin screens from /admin in one click"

### Scenario 2: Viewer sees only what they can open (Q86)
* **Given** a templated viewer principal
* **When** they open `/admin`
* **Then** the page lists exactly: Overview, Sessions, Missions, Scheduled, War Room, Usage, Audit Log, Hive Mind, Playground, Memories, Jarvis (11 links), and the sections "Safety controls" and "People & connections" are absent from the DOM
* **And** the admin rail on `/dashboard/sessions` shows the same 11 links and nothing else
* **Test:** `tests/e2e/workspace/admin.spec.ts` › "viewer sees only the 11 admin screens they hold"; `src/lib/jarvis/nav-manifest.test.ts` › "admin list per templated profile matches App gates"

### Scenario 3: No admin access
* **Given** a seat-user principal
* **When** they type `/dashboard/admin`
* **Then** the page shows `h1` "You don't have access to Admin" and a button "Back to Home" linking `/dashboard/`
* **And** the account menu shows no "Admin" item
* **Test:** `tests/e2e/workspace/admin.spec.ts` › "seat-user gets the plain no-access page"

### Scenario 4: Server decides, not the nav
* **Given** a principal without a screen's capability (seat-user for each viewer-tier read; viewer for `cost:write`, `posture:read`, `compliance:read`, `integrations:read`, `members:read`; operator for `security:write`; admin for `seats:read`)
* **When** they call that screen's primary API directly (for example `GET /api/audit`, `GET /api/cost`, `GET /api/rate-limits`, `GET /api/seats`)
* **Then** the response is HTTP 403 with body `{ "error": "forbidden", "requiredCapability": "<cap>" }` and the mocked repository for that route was not called
* **Test:** `src/adapters/dashboard/authz-matrix.test.ts` › "admin console screens — primary read is denied without the screen capability" (one `it` per screen × lacking principal). UNVERIFIED: exact primary GET path for Cost, Rate Limits, DLP, Alerting, Integrations and Seats pages; read each page's first `api.get` call before freezing the table.

### Scenario 5: Lists stay in sync
* **Given** the regrouping
* **When** `npx vitest run src/lib/jarvis/route-manifest.test.ts src/lib/jarvis/nav-manifest.test.ts` runs
* **Then** for each of the 22 admin routes, the manifest `section` equals the `ROUTE_TABLE` `section`, the manifest label equals the `ROUTE_TABLE` label, and `/admin` is present in both `App.tsx` and `ROUTE_TABLE` (minRole viewer, ungated)
* **And** the drift test still passes with no admin `<Route>` wrapped in a layout component
* **Test:** `src/lib/jarvis/nav-manifest.test.ts` › "admin sections and labels match ROUTE_TABLE"; `src/lib/jarvis/route-manifest.test.ts` › "matches the live web/src/App.tsx route table (paths + minRole)"

### Scenario 6: No admin prefetch for business users
* **Given** a custom profile with only `agents:read` and `chat:read`
* **When** they stay on `/dashboard/` for 3 s
* **Then** no request is made to `/api/sessions`, `/api/kill-switches`, `/api/audit`, `/api/cost-today` or `/api/usage/daily`
* **And** an admin who opens `/dashboard/overview` still triggers the prefetch of paths they hold
* **Test:** `tests/e2e/workspace/admin.spec.ts` › "prefetch is capability-aware and admin-only"

### Scenario 7: Identity changes mid-session
* **Given** an operator whose `/whoami` later returns viewer capabilities (profile downgraded; next `loadRole()`)
* **When** the rail re-renders
* **Then** Cost, Security Posture, Compliance, Integrations and Members links disappear without a reload, and opening `/dashboard/cost` shows "Cost access required"
* **Test:** `tests/e2e/workspace/admin.spec.ts` › "admin rail follows a capability change without reload"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-15 / US-015](US-015-workspace-shell-home-agents-workflows-my-work.md) Workspace shell: Home, Agents, Workflows, My Work, Library
* **UI/UX Design:** design.md W-033 (Admin shell), W-034 (Admin landing), W-036 (No admin access), section 4 (6 sections): **NO-MOCK-YET, due Nov 23** ([design.md](../foundation/design.md)). The 22 existing screens are unchanged; real screenshots after NZR-3 installs Playwright. Admin keeps today's density, light mode tested.
* **Non-Functional Requirements:** Admin keeps today's density (C-20..C-26 readability rules do not apply to Admin, design section 1), but the new `/admin` page must pass keyboard use (Tab order = section order) and have no axe serious/critical issues if US-020's axe check is available. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `nav.admin_opened` `{entry: 'account_menu'|'url', sectionCount: number}`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Uses US-015's `track()` (no-op until the writer exists, NOTES X2).

* **Files to change:**

| path | change |
|---|---|
| `web/src/lib/nav/manifest.ts` (from US-015) | `ADMIN_SECTIONS` = the 6 names in order; each `ADMIN_ITEMS` entry gets its new `section`; `/jarvis` gets `ungated: true`; add `adminItemsFor(caps)` and keep `canSeeAdminLink(caps)` ignoring `ungated` items. |
| `web/src/components/Sidebar.tsx:233` | `sections` comes from `ADMIN_SECTIONS`; on admin routes render only `ADMIN_ITEMS` plus the "Back to Workspace" link (the collapse, mobile drawer and account row behaviour stays). |
| `web/src/App.tsx:187-201` | Prefetch runs only when an admin route is first opened, and only for paths whose capability `hasCapability` holds (map: `/agents`→`agents:read`, `/sessions`→`sessions:read`, `/kill-switches`→`kill-switches:read`, `/audit?days=7`→`audit:read`, `/cost-today`→`overview:read`, `/usage/daily…`→`usage:read`). |
| `web/src/App.tsx` (Switch) | Add `<Route path="/admin" component={AdminHome} />` (ungated literal, one line). |
| `web/src/components/AccountMenu.tsx` (from US-015) | Admin item `href="/admin"`. |
| `src/lib/jarvis/route-manifest.ts:106-159` | Add `{ route: '/admin', label: 'Admin', section: 'Admin', minRole: 'viewer' }`; set `section` of the 22 admin rows to the 6 names; DLP label "DLP & Exfil" (O-B). |
| `src/lib/jarvis/route-manifest.test.ts` | Unchanged logic; must stay green. |
| `src/adapters/dashboard/authz-matrix.test.ts:419+` | New `describe` block for Scenario 4. If `principalFor` (`:33-45`) cannot build a seat-user, add that branch (synthetic token string `seat-user`). |
| `web/src/lib/tour/steps.ts` | Tour tabs keep their routes; reorder admin tabs to the new section order (the tour follows sidebar order, header comment `:1-17`). Keep Overview first (tour.spec expects Overview → Agents → Chat, `tests/e2e/tour/tour.spec.ts:34-54`). |

* **New files:**
  * `web/src/pages/AdminHome.tsx` — `/admin` index (W-033/W-034) and the no-access state (W-036).
  * `tests/e2e/workspace/admin.spec.ts` — Scenarios 1–3, 6, 7 (uses US-015's `playwright.config.ts` and `fixtures/api-stubs.ts`).
* **API contract:** N/A: no API change. Server routes are only exercised by new tests. Error body for a denied read is today's `{ error: 'forbidden', requiredCapability: '<cap>' }` with HTTP 403 (for example `handler.ts:2599`).
* **Data changes:** None.
* **Security notes:**
  * SECURITY.md section 6 "Authorization on the server": every route keeps `hasCapability`; Scenario 4 adds a test per screen that a lower principal gets 403 and no data-layer call (boundary B1).
  * The client list is a convenience only (`App.tsx:121-136` comment: "The backend is the real authority").
  * O-E (role-string gates in Settings, Hive Mind, Jarvis) is not changed here; record it, do not widen it.
  * O-F: `ROUTE_TABLE` puts `/seats` at admin rung but a plain admin lacks `seats:read`; Jarvis may still navigate an admin there. Unchanged; the page shows "Seats access required" and the API returns 403.
  * The prefetch change removes avoidable 403 rows from the audit trail for business users (O-8). UNVERIFIED: whether 403s are written to the audit log at all; check `writeAudit` call sites around `hasCapability` denials.
* **Test plan:**
  * Frozen failing tests first: `nav-manifest.test.ts` › "admin list per templated profile matches App gates" and "admin sections and labels match ROUTE_TABLE"; the new `authz-matrix.test.ts` block (should pass immediately on the server side; it is a regression net, so record that it was green before and after).
  * E2E: `tests/e2e/workspace/admin.spec.ts`.
  * Fixtures: synthetic whoami payloads per profile built from `TEMPLATED_PROFILES` (`permissions.ts:273`).
  * Commands: `npx vitest run src/lib/jarvis/nav-manifest.test.ts src/lib/jarvis/route-manifest.test.ts src/adapters/dashboard/authz-matrix.test.ts`; `npm test`; `npm run typecheck`; `npm --prefix web run typecheck`; `npm --prefix web run build`; `npx playwright test --config tests/e2e/workspace/playwright.config.ts admin.spec.ts`.
* **Repo rules that apply:**
  * Nav sync: manifest + `App.tsx` + `ROUTE_TABLE` + drift test change together (`route-manifest.ts:91-105`).
  * No `handler.ts` route change ⇒ no `docs/diagrams.map` update. (A test file under `src/adapters/dashboard/` is not a mapped source.)
  * No new dependency. Feature HANDOFF + dated session handoff.
* **Rollback:** Revert the merge. The legacy 7-group sidebar returns; URLs never changed, so bookmarks are unaffected. No data.
* **Build slices (proposal):**
  1. **Regroup + sync tests** (~1.5 h): manifest sections, Sidebar sections, `ROUTE_TABLE` sections/labels, `/admin` route stub. Green: `nav-manifest.test.ts` admin tests, drift test.
  2. **`/admin` index + no-access + link target** (~2 h): `AdminHome.tsx`, AccountMenu href. Green: `admin.spec.ts` Scenarios 1–3, 7.
  3. **Prefetch + server matrix** (~1.5 h): `App.tsx:187-201`, authz-matrix block. Green: Scenario 4, Scenario 6.
* **Agent gotchas:**
  * Do not wrap admin `<Route>`s in an `<AdminLayout>`; the drift regex needs `path="X">` directly followed by `<RequireCapability` (O-5, `route-manifest.test.ts:197-199`).
  * `/members` spans several lines in `App.tsx:295-299`; the regex allows `\s*` after `>` so it works today. Keep that shape.
  * `/cost` gates on `cost:write`, not `cost:read` (`App.tsx:244-253`); an analyst must NOT see Cost.
  * Hive Mind edits gate on `hasRole('admin')` (`HiveMind.tsx:35`), not a capability; do not "fix" it here (O-E).
  * `/jarvis` is ungated; if counted, the Admin link shows to everyone (NOTES).
  * The tour engine spotlights `nav:<href>` anchors (`Sidebar.tsx:321`); keep `data-tour` on admin rail links.
  * `authz-matrix.test.ts` treats any non-403 as ALLOW; assert the repository mock call count for the "no data call" part.

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** ui

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona E).
- [ ] Acceptance criteria cover both happy paths and edge cases (owner, viewer, seat-user, direct API, capability change).
- [ ] UX/UI designs are attached and finalized: design.md W-033, W-034, W-036 are **NO-MOCK-YET, due Nov 23**; existing screens get real screenshots after NZR-3 installs (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-15 merged, which provides the manifest, account menu and Playwright harness).
- [ ] Owner has confirmed the `/jarvis` reading of Q86 (NOTES) or accepted the recommendation.
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. T2: fresh Claude critic + free checks (npm audit, `node scripts/ci/secret-scan.mjs <changed files>`, typecheck) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: `npx vitest run src/lib/jarvis/nav-manifest.test.ts src/lib/jarvis/route-manifest.test.ts src/adapters/dashboard/authz-matrix.test.ts` and `npx playwright test --config tests/e2e/workspace/playwright.config.ts admin.spec.ts`; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51): owner, viewer and seat-user open Admin; a direct API call as viewer returns 403.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; the 6-section grouping and the Q86 rule promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
