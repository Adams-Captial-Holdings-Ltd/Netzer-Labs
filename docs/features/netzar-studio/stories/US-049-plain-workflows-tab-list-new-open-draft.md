# [US-049] Plain Workflows tab: list, new, open draft

> Backlog task NZR-49 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: AC-001, FR-001. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3), designed and tested as "Margaret, 67" (office manager, iPad + desktop, has never heard the word "workflow"; Q98)
* **I want** one plain "Routines" tab where I tap **Build a routine** or tap one of my saved routines to open it
* **So that** I reach the builder in one tap from the main menu, without opening any developer or admin screen (AC-001), measured as "reached the builder without Help" in the dry-run

---

## 2. Business Context & Description
* **Background:**
  - Q61: the core slice (drafter, preview, test runner, edit-by-chat) ships first, Nov 10 to 23, inside a plain tab in today's sidebar. The full Workspace shell comes later (NZR-15, C2b).
  - design.md O-11: no backlog story owned the interim nav entry or the list, open-draft and not-found screens (W-001, W-013). This story owns them.
  - Round 5 UX (Q96 to Q110) changes this screen most: plain words, 20px text, "Help me" and "Bigger text" on every screen. Those shared pieces are built here because this is the first slice screen; later slice stories reuse them.
  - PRD IDs: AC-001 (reach the builder without developer settings), FR-001 (describe and generate drafts; this story is the entry point).
  - Words used below: **routine** = what the code calls a workflow; **helper** = what the code calls an agent. Code, routes, capabilities and data keep "workflow"; only on-screen words change (PENDING OWNER Q99).
* **Current behaviour (d1d3a66):**
  - No workflow screen, route, API, store or capability exists. `src/lib/workflows/`, `src/lib/studio/` and `src/lib/analytics/` do not exist (checked with `ls`).
  - Sidebar tabs come from `NAV_ITEMS` (`web/src/components/Sidebar.tsx:92-231`, 28 items in 7 sections, `sections` list at `:233`). Each item's `minCapability` must equal its route gate (`Sidebar.tsx:79-89`).
  - Signed-in routes live in one `<Switch>` (`web/src/App.tsx:221-304`). Gated routes use `<RequireCapability need=… label=…>` (`App.tsx:137-158`). Its denied state shows the raw capability string: `This page needs the "<cap>" permission` (`App.tsx:153`), which is jargon for Margaret.
  - Signed-out visitors: `AuthGate` renders `Login` for every path when there is no token (`App.tsx:106-119`). No redirect happens and no page component mounts. A 401 from any API call clears the token and reloads (`web/src/lib/api.ts:202-205`).
  - Jarvis `ROUTE_TABLE` (`src/lib/jarvis/route-manifest.ts:106-159`) must list exactly the static App routes. The drift test (`src/lib/jarvis/route-manifest.test.ts:118-206`) scrapes `App.tsx` with the regex `<Route\s+path="([^"]+)"` (`:139`), skips paths containing `:`, and maps each `RequireCapability need` to a role through `CAPABILITY_MIN_ROLE` (`:165-192`). A capability missing from that map silently becomes `viewer` (`:203`, design.md O-9).
  - Capabilities live in `CAPABILITIES` (`src/lib/auth/permissions.ts:88-135`); templated profiles are layered from `VIEWER_CAPS` (`:195-214`). A new capability goes only to the profiles named, plus owner (`:84-86`, `:163`).
  - Backend: every `/api/*` route in `buildDashboardRouter` (`src/adapters/dashboard/handler.ts:1383`) passes a bearer middleware (`:1386-1436`) that also applies a legacy role gate `requiredRole(method, subPath)` (`:428-466`). Any non-GET path not listed there needs role `operator` (`:465`). Per-route capability checks use `hasCapability(c, cap)` (`:870-875`). The person behind a principal is `personOf(c)` (`:312-315`); the env root token has no person unless linked (`src/lib/auth/dashboard-auth.ts:98-134`).
  - Breadcrumb labels come from `BREADCRUMB_LABELS` (`web/src/components/Header.tsx:7-21`); unknown paths show the raw slug.
  - Tailwind body text is 15px (`web/tailwind.config.ts:162`). There is no 20px token.
  - The web app has no unit-test runner (`web/package.json` scripts: dev, typecheck, build, preview; design.md O-6). The only local UI harness is Playwright against the Vite dev server with a dev-only mock plugin (`tests/e2e/chat/playwright.config.ts`, `web/dev/mock-stream-plugin.ts`, run by `npm run e2e:chat`, CI job `e2e-chat` in `.github/workflows/ci.yml:270-297`).
* **Target behaviour:**
  - A "Routines" item sits in the sidebar **Core** section right after "Chat", gated on `workflows:read`. Breadcrumb label "Routines".
  - `/workflows` lists only the signed-in person's routines (newest edit first) with name, a plain status label and "Edited …". Empty, loading, error and no-access states exist.
  - **Build a routine** goes to `/workflows/new` (the start screen content is NZR-23's; this story registers the route and a placeholder page). Tapping a routine opens `/workflows/:id` (preview content is NZR-25's; this story owns the page frame and the not-found state W-013).
  - New capabilities `workflows:read` and `workflows:write` exist, are held by viewer and every profile above it (not seat-user), and are in the drift map. App routes, `ROUTE_TABLE`, `NAV_ITEMS` and the drift test agree.
  - `GET /api/workflows` and `GET /api/workflows/:id` exist, owner-only, with plain error bodies.
  - Every slice screen uses one shared frame `StudioPage`: 20px body text, "Help me" (explains this screen, can read it aloud), "Bigger text" toggle, and works at 200% zoom.
  - All on-screen copy for slice screens lives in `web/src/lib/studio/copy.ts`, and a vitest check fails the build if it contains a banned word (workflow, agent, trigger).
  - `workflow.list_viewed` is written as a product event with no personal data.
* **Out of scope:**
  - Describe/guided builder, 6 example cards and mic on `/workflows/new` (NZR-23; Q100 moves the mic into the slice there).
  - Preview, step sheet and helper picker on `/workflows/:id` (NZR-25). Edits, Undo and history (NZR-24). Test runs and Ready (NZR-26).
  - Rename, delete, duplicate a routine. Admin view of everyone's routines (GSI2 `WFALL`, later).
  - Workspace shell, Home, removing the old 28 tabs (NZR-15). Tour step for the new tab (`web/src/lib/tour/steps.ts`; NZR-15 rewrites the tour).
  - axe in CI (NZR-20; needs a new dependency and owner yes).
* **Target Value:** In the Nov 23 dry-run, at least 4 of 5 testers (at least 2 aged 60+, Q109) reach `/workflows/new` from a cold sign-in without tapping "Help me". Measured from the `workflow.list_viewed` and `workflow.new_opened` product events plus the tester observation sheet (NZR-47).
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3), as "Margaret, 67" (Q98). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Empty state
* **Given** a signed-in viewer-profile person with no routines
* **When** they open `/dashboard/workflows`
* **Then** `GET /api/workflows` returns 200 `{"workflows":[]}`; the page shows the heading "No routines yet", the line "A routine is a job Netzar does for you, the same way every time.", and exactly one primary button "Build a routine"; tapping it navigates to `/dashboard/workflows/new`
* **Test:** `tests/e2e/studio/workflows-list.spec.ts` › "empty list shows one Build a routine button"; `src/adapters/dashboard/workflows.routes.test.ts` › "GET /workflows returns an empty list for a person with no routines"

### Scenario 2: List of my routines
* **Given** the person owns 3 routines (labels Ready, Draft, Needs setup) and another person owns 1
* **When** they open the Routines tab
* **Then** the API returns 200 with exactly their 3 items, each `{id, name, label, updatedAt}`, sorted by `updatedAt` descending; each card shows the name, the label chip text ("Ready", "Draft", "Needs setup") and "Edited today HH:MM" / "Edited yesterday" / "Edited Mon D"; the other person's routine is absent
* **Test:** `src/adapters/dashboard/workflows.routes.test.ts` › "GET /workflows lists only the caller's routines, newest first"; `tests/e2e/studio/workflows-list.spec.ts` › "list shows name, label and last edited"

### Scenario 3: Not signed in
* **Given** a browser with no stored token
* **When** it opens `/dashboard/workflows`
* **Then** the sign-in screen shows (email field with placeholder "you@company.com"), no routine name is in the page, and the browser makes zero requests to `/api/workflows`; a direct `GET /api/workflows` with no bearer returns 401 `{"error":"unauthorized"}`
* **Test:** `tests/e2e/studio/workflows-list.spec.ts` › "signed-out visitor sees sign-in and no workflow request"; `src/adapters/dashboard/workflows.routes.test.ts` › "GET /workflows without a token is 401"

### Scenario 4: No permission
* **Given** a seat-user principal (holds no `workflows:read`)
* **When** they call `GET /api/workflows` or open `/dashboard/workflows`
* **Then** the API returns 403 `{"error":"forbidden","requiredCapability":"workflows:read"}` and the store is never queried; the page shows "You can't open Routines yet" and "Ask your administrator to give you access." (no capability string on screen); the sidebar has no "Routines" item
* **Test:** `src/adapters/dashboard/workflows.routes.test.ts` › "seat-user gets 403 and no store read"; `tests/e2e/studio/workflows-list.spec.ts` › "no-access state uses plain words and hides the tab"

### Scenario 5: Open a routine that is gone or not mine (W-013)
* **Given** a routine id that does not exist, is soft-deleted (`deletedAt` set), or is owned by someone else
* **When** the person opens `/dashboard/workflows/<id>`
* **Then** `GET /api/workflows/<id>` returns the same 404 `{"error":"not_found"}` in all three cases; the page shows "We can't find that routine" and "It may have been deleted, or it belongs to someone else." with a button "Back to my routines" that goes to `/dashboard/workflows`
* **Test:** `src/adapters/dashboard/workflows.routes.test.ts` › "GET /workflows/:id answers missing, deleted and other-owner ids with the same 404"; `tests/e2e/studio/workflows-list.spec.ts` › "unknown routine shows the not-found screen"

### Scenario 6: Principal with no person, and load failure
* **Given** (a) the env root token with no linked user, or (b) a person whose list request fails (store error)
* **When** they open the Routines tab
* **Then** (a) the API returns 403 `{"error":"person_required"}` and the page shows "Sign in with your own account to see your routines."; (b) the API returns 500 `{"error":"workflows_unavailable"}` and the page shows "We couldn't load your routines." with a "Try again" button that repeats the request
* **Test:** `src/adapters/dashboard/workflows.routes.test.ts` › "a principal with no person gets person_required"; `tests/e2e/studio/workflows-list.spec.ts` › "load error shows Try again and retries"

### Scenario 7: Nav, routes and Jarvis stay in sync
* **Given** the changed `App.tsx`, `Sidebar.tsx`, `route-manifest.ts` and `permissions.ts`
* **When** `npx vitest run src/lib/jarvis/route-manifest.test.ts src/lib/auth/permissions.workflows.test.ts` runs
* **Then** `/workflows` and `/workflows/new` are in both App and `ROUTE_TABLE` with `minRole: 'viewer'`; `CAPABILITY_MIN_ROLE` has explicit `workflows:read` and `workflows:write` entries; `resolveRoute('viewer','routines')` and `resolveRoute('viewer','workflows')` both return `/workflows`; viewer, analyst, operator, admin, org-admin and owner hold both capabilities and seat-user holds neither; every `NAV_ITEMS` entry with a `minCapability` matches its App route gate
* **Test:** `src/lib/jarvis/route-manifest.test.ts` › "matches the live web/src/App.tsx route table (paths + minRole)" (existing) and › "resolves Routines and workflows to /workflows" (new) and › "every Sidebar NAV_ITEMS minCapability equals its App route gate" (new); `src/lib/auth/permissions.workflows.test.ts` › "workflows caps are held from viewer up and not by seat-user"

### Scenario 8: Readable for Margaret (round 5)
* **Given** the list page at desktop 1440x900, iPad 1024x768 and phone 390x844
* **When** the page renders, then "Bigger text" is tapped, then the viewport is set to 720x450 (200% zoom of desktop)
* **Then** body text computes to at least 20px (at least 24px after "Bigger text"); every button and card has a box at least 44x44px; `document.documentElement.scrollWidth <= clientWidth` at 720x450; "Help me" opens a panel whose first line is "This page lists your routines." and has a "Read it to me" button; `scripts/ci/studio-copy.test.ts` finds no banned word in `web/src/lib/studio/copy.ts`
* **Test:** `tests/e2e/studio/workflows-list.spec.ts` › "list meets text size, target size and 200% zoom"; `scripts/ci/studio-copy.test.ts` › "studio copy has no banned words"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-12 / US-012](US-012-workflow-definition-schema-validator.md) Workflow definition schema + validator. Precondition from NZR-12: the `${app}-studio` table, `TABLE_STUDIO` env wiring and `src/lib/workflows/store.ts` (DATA-MODEL §3). If NZR-12 merged without the table or store, slice 1 below adds them exactly as DATA-MODEL §3 describes (and then this story also touches `infra/lib/dynamo-stack.ts`, which needs the `docs/diagrams/architecture-data.md` update).
* **UI/UX Design:**
  - Mocks: W-001 [empty desktop](../../../assets/netzar-studio/mock/W-001-empty-desktop.png) / [phone](../../../assets/netzar-studio/mock/W-001-empty-phone.png), [list desktop](../../../assets/netzar-studio/mock/W-001-list-desktop.png) / [phone](../../../assets/netzar-studio/mock/W-001-list-phone.png), W-013 [desktop](../../../assets/netzar-studio/mock/W-013-no-access-desktop.png) / [phone](../../../assets/netzar-studio/mock/W-013-no-access-phone.png). Index: [design.md](../foundation/design.md) section 2 and 3a.
  - The current mocks use the old words ("Workflows", "Build a workflow"), 15 to 18px text and no "Help me" / "Bigger text". They are being redone for the guided flow (Q101, about 2 h, before Nov 9) and will add an iPad 1024x768 frame (Q108). Build from the copy in this story; the redone mocks win on layout.
  - Not yet mocked (due Nov 9): list loading, list error, permission-denied (W-001).
  - Look: shadcn-style clean cards recreated in Preact + Tailwind 3 (Q97). No React, no Tailwind 4, no new dependency.
  - PENDING OWNER Q99: words "Routines"/"Routine"/"Helper". Recommended yes. If the owner says no, `copy.ts` uses "Workflows"/"Build a workflow"/"agent", the nav label becomes "Workflows", and the banned-word test is removed.
  - PENDING OWNER Q105/Q107/Q108: 20px + AAA + "Bigger text"; "Help me" with read-aloud and no arrow tour; iPad + desktop first. Recommended yes. If no: 18px, AA, no "Bigger text", Help panel without read-aloud.
* **Non-Functional Requirements:**
  - Workspace screens only: body 20px, AAA text contrast 7:1, targets at least 44x44px, usable at 200% zoom, iPad + desktop first, phone works (Q105, Q108). Admin screens keep today's density.
  - `GET /api/workflows` p95 under 300 ms for 50 items (one GSI1 Query, no per-item reads).
  - Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:**
  - `workflow.list_viewed` (props: `count` bucket `0|1-5|6-20|21+`) on each successful `GET /api/workflows`; `workflow.new_opened` (no props) when `/workflows/new` mounts (sent by `POST /api/workflows/events` with `{event:"workflow.new_opened"}`).
  - Written to the existing audit log as action `product_event`, no `userId`, no `agentId`, props allow-listed at write time (Q55; DATA-MODEL §3 "Product analytics event"). Catalogue in OBSERVABILITY.md (NZR-44).
  - Help usage: `studio.help_opened` (props: `screen` enum `list|new|preview|test`) so "finished without Help" can be counted (Q109).

* **Files to change:**

| path | change |
|---|---|
| `src/lib/auth/permissions.ts:88-135, 195-214` | Add `'workflows:read'`, `'workflows:write'` to `CAPABILITIES` (with a doc line in the taxonomy comment `:21-87`) and to `VIEWER_CAPS`. Not to `SEAT_USER_CAPS` (`:252-255`). |
| `src/lib/jarvis/route-manifest.ts:106-159` | Add `{ route: '/workflows', label: 'Routines', section: 'Core', minRole: 'viewer' }` and `{ route: '/workflows/new', label: 'Build a routine', section: 'Core', minRole: 'viewer' }` after `/chat`. |
| `src/lib/jarvis/route-manifest.test.ts:165-192` | Add `'workflows:read': 'viewer'`, `'workflows:write': 'viewer'` to `CAPABILITY_MIN_ROLE`. Add the two new tests named in Scenario 7. |
| `web/src/App.tsx:77-104, 236-241` | Lazy imports `Workflows`, `WorkflowNew`, `WorkflowDetail`. Routes, in this order, right after the `/chat/:agentId` route: `<Route path="/workflows"><RequireCapability need="workflows:read" label="Routines" plain>…`, `<Route path="/workflows/new"><RequireCapability need="workflows:write" label="Routines" plain>…`, `<Route path="/workflows/:id"><RequireCapability need="workflows:read" label="Routines" plain>…`. Keep `path="…">` immediately followed by `<RequireCapability need=` (drift regex). |
| `web/src/App.tsx:137-158` | `RequireCapability` gets an optional boolean `plain`; when set, the denied state renders the plain copy from `copy.ts` ("You can't open Routines yet" / "Ask your administrator to give you access.") instead of the capability string. |
| `web/src/components/Sidebar.tsx:92-231` | New `NAV_ITEMS` entry after Chat: `{ href: '/workflows', label: 'Routines', section: 'Core', minCapability: 'workflows:read', icon: … }` (inline SVG like the others; no icon library change). |
| `web/src/components/Header.tsx:7-21` | `'/workflows': 'Routines'`, `'/workflows/new': 'New routine'`. |
| `web/tailwind.config.ts:157-166` | Add tokens `ws-title` 32px, `ws-heading` 24px, `ws-body` 20px/1.6, `ws-small` 18px. Body scale for "Bigger text" via a CSS variable on the `StudioPage` root (`--ws-scale: 1` or `1.2`). |
| `src/adapters/dashboard/handler.ts:428-466` | In `requiredRole`, return `'viewer'` for `subPath === '/workflows' \|\| subPath.startsWith('/workflows/')` so the capability check inside each route is the single gate (same pattern as `/members`, `:437`). |
| `src/adapters/dashboard/handler.ts` (inside `buildDashboardRouter`, next to the `/agents` routes ~`:1504`) | Register `GET /workflows`, `GET /workflows/:id`, `POST /workflows/events` as thin handlers that call `src/lib/workflows/*` and `src/lib/analytics/events.ts`. |
| `docs/diagrams/architecture-security.md` | Add the `/api/workflows*` routes and their `workflows:*` gates (required: `handler.ts` is a mapped source in `docs/diagrams.map`). |
| `package.json` scripts | Add `"e2e:studio": "playwright test --config tests/e2e/studio/playwright.config.ts"`. |
| `web/vite.config.ts:33-41` | Register `mockStudioPlugin()` only when `CCE_STUDIO_MOCK=1`, same pattern as `CCE_CHAT_MOCK`. |

* **New files:**
  - `web/src/pages/studio/Workflows.tsx`: list page (W-001 states).
  - `web/src/pages/studio/WorkflowNew.tsx`: placeholder that NZR-23 replaces ("Let's build a routine" heading + "Back to my routines").
  - `web/src/pages/studio/WorkflowDetail.tsx`: page frame for `/workflows/:id` (reads id with `useRoute('/workflows/:id')`, like `AgentDetail.tsx:48`), loading, W-013 not-found; NZR-25 fills the body.
  - `web/src/components/studio/StudioPage.tsx`: shared frame: title, "Help me", "Bigger text", 20px root class, max width 960px.
  - `web/src/components/studio/HelpMe.tsx`: panel with this screen's help text from `copy.ts`; "Read it to me" uses the browser `speechSynthesis` API (built in, no dependency); hidden when `speechSynthesis` is missing.
  - `web/src/lib/studio/copy.ts`: every on-screen string for slice screens, plus per-screen help text.
  - `web/src/lib/studio/api.ts`: typed calls `listWorkflows()`, `getWorkflow(id)`, `sendEvent(name)`.
  - `src/lib/workflows/list.ts`: `listForOwner(userId, {limit, cursor})` and `labelFor(meta)` (pure; label rules below).
  - `src/lib/analytics/events.ts`: `emitProductEvent(name, props)` with a per-event allow-list map; rejects unknown names or keys; calls `writeAudit({action:'product_event', …})` (if NZR-44 or another story created it first, reuse it).
  - `src/adapters/dashboard/workflows.routes.test.ts`, `src/lib/workflows/list.test.ts`, `src/lib/auth/permissions.workflows.test.ts`, `scripts/ci/studio-copy.test.ts`.
  - `tests/e2e/studio/playwright.config.ts` (copy of the chat config: port 5181, `CCE_STUDIO_MOCK=1`, workers 1), `tests/e2e/studio/workflows-list.spec.ts`, `web/dev/mock-studio-plugin.ts`, `web/dev/studio-fixtures.ts`.

* **API contract:**
  - All routes: under `/api`, bearer required (401 `{"error":"unauthorized"}` from the middleware, `handler.ts:1410`). When runtime-config `studio/enabled` is `"0"`: 503 `{"error":"studio_disabled"}` and the UI shows "Routines are turned off for now. Ask your administrator."
  - `GET /api/workflows?cursor=<opaque>` · capability `workflows:read` · person required.
    - 200 `{"workflows":[{"id":"wf_…","name":"New policy review","label":"Draft|Needs setup|Tested|Ready|Test again","updatedAt":"<ISO>"}],"nextCursor":"<opaque>"?}` (max 50 per page; `nextCursor` omitted on the last page).
    - 403 `{"error":"forbidden","requiredCapability":"workflows:read"}` · 403 `{"error":"person_required"}` · 400 `{"error":"bad_cursor"}` · 500 `{"error":"workflows_unavailable"}`.
  - `GET /api/workflows/:id` · `workflows:read` · owner only.
    - 200 `{"workflow":{"id","name","label","draftRev":<int>,"updatedAt"}}` (NZR-25 adds `preview`).
    - 404 `{"error":"not_found"}` for missing, soft-deleted, other owner, or an id that fails `^wf_[A-Za-z0-9_-]{8,40}$`. 403 as above.
  - `POST /api/workflows/events` · `workflows:read` · body `{"event":"workflow.new_opened"|"studio.help_opened","props":{…}}`, at most 1 KB (Hono `bodyLimit`, from `hono/body-limit`, already in the `hono` package).
    - 204 · 400 `{"error":"unknown_event"}` · 413 `{"error":"body_too_large"}`.
  - Label rules (`labelFor`, pure): `Needs setup` if the latest draft's validator result has open "needs" items; else `Ready` if `status==='ready' && readyRev===draftRev`; else `Test again` if `status==='ready' && readyRev!==draftRev`; else `Tested` if `lastPassedRev===draftRev`; else `Draft`. Fields `readyRev`/`lastPassedRev` are written by NZR-26; absent means not tested.

* **Data changes:**
  - No new table if NZR-12 delivered `${app}-studio`. Reads only: GSI1 `OWNER#<userId>` / `WF#<updatedAt>` (DATA-MODEL §3 WorkflowDefinition), filter `attribute_not_exists(deletedAt)`. Owner key uses `personOf(c)` (users-table userId).
  - New capability strings are additive (never repurposed, `permissions.ts:84`). Custom profiles do not get them until an admin grants them.
  - Migration: none. Backfill: none. Rollback: see below.

* **Security notes:**
  - SECURITY.md §6 floor: server-side `hasCapability` plus an ownership check on every route; a lower principal gets 403/404 and the test asserts the store was not called.
  - Same 404 for "missing", "deleted" and "not yours" so ids can't be probed (same idea as SECURITY.md §3a "unknown scope gets the same answer as private").
  - Identity only from the session (`personOf`), never from the body or `X-Dashboard-User` (SECURITY.md B1 S/R, A153 lesson).
  - Body limit on the new POST (SECURITY.md B1 D: no body limit exists in `src/` today).
  - Product events: allow-listed names and keys, no userId (DATA-MODEL risk 6: WORM makes a PII slip permanent).
  - Pilot rule (SECURITY.md §5 item 9): partner users are seat-user or viewer. Viewer now holds `workflows:write`, so a viewer can create drafts and (with NZR-26) spend model money on tests. Accepted by this story's recommendation; see NOTES-E-slice.

* **Test plan:**
  - Frozen failing tests first (own commit, red SHA recorded):
    1. `src/lib/auth/permissions.workflows.test.ts` › "workflows caps are held from viewer up and not by seat-user"
    2. `src/lib/jarvis/route-manifest.test.ts` › "resolves Routines and workflows to /workflows" and › "every Sidebar NAV_ITEMS minCapability equals its App route gate" (reads `Sidebar.tsx` as text, regex `href: '([^']+)'[^}]*?minCapability: '([^']+)'`, compares with the App gate map)
    3. `src/adapters/dashboard/workflows.routes.test.ts` › all Scenario 1 to 6 API tests (pattern: drive `buildDashboardRouter()` through `app.request()`, mock `dashboard-auth.js` with `principalFor`, as in `src/adapters/dashboard/chat-uploads.test.ts:39-50` and `authz-matrix.test.ts`; mock `src/lib/workflows/store.js`)
    4. `src/lib/workflows/list.test.ts` › "labelFor maps status, readyRev and validator needs to plain labels" (5 cases)
    5. `scripts/ci/studio-copy.test.ts` › "studio copy has no banned words" (case-insensitive `\b(workflows?|agents?|triggers?)\b` over string values in `web/src/lib/studio/copy.ts`) and › "studio pages hold no inline English text" (no `>[A-Za-z][^<{]{2,}<` in `web/src/pages/studio/*.tsx`)
  - Playwright (local Vite + `CCE_STUDIO_MOCK=1`, synthetic fixtures only): `tests/e2e/studio/workflows-list.spec.ts`.
  - Commands: `npx vitest run src/lib/auth/permissions.workflows.test.ts src/lib/jarvis/route-manifest.test.ts src/adapters/dashboard/workflows.routes.test.ts src/lib/workflows/list.test.ts scripts/ci/studio-copy.test.ts`; then `npm test` (full); `npm run typecheck`; `npm --prefix web run typecheck`; `npm --prefix web run build`; `npm run e2e:studio` (needs `npm ci --prefix web` and the Playwright chromium download, Q78, run one at a time); `node scripts/ci/diagrams-drift.mjs`; `node scripts/ci/docs-links.mjs`.

* **Repo rules that apply:**
  - Nav sync: `Sidebar.tsx` `NAV_ITEMS` + `App.tsx` routes + `route-manifest.ts` `ROUTE_TABLE` + `route-manifest.test.ts` `CAPABILITY_MIN_ROLE`, one commit (design.md section 3 "Proposed routes", O-9).
  - `handler.ts` route change ⇒ update `docs/diagrams/architecture-security.md` (`docs/diagrams.map`; gate `scripts/ci/diagrams-drift.mjs`, CONTRIBUTING.md:51-53).
  - No new dependency without owner yes (`hono/body-limit` and `speechSynthesis` are not new dependencies).
  - Full `npm test` before any push (CLAUDE.md "Deploy").
  - Feature docs: update `docs/features/netzar-studio/HANDOFF.md` and add a dated session handoff (docs/features/README.md §6a).

* **Rollback:** Set runtime-config `studio/enabled=0` (API answers 503, page shows the "turned off" copy). Full revert = revert the merge commit; capabilities are additive and unused elsewhere, so removing them is safe while no custom profile references them (check `users` table custom profiles for `workflows:` before reverting).

* **Build slices (proposal):**
  1. **Caps + nav sync + routes skeleton** (`permissions.ts`, `route-manifest.ts`, test map, `App.tsx`, `Sidebar.tsx`, `Header.tsx`, placeholder pages). Turns green: tests 1, 2 and the existing drift test.
  2. **List API** (`list.ts`, handler routes, `requiredRole` change, events.ts, diagram). Turns green: tests 3, 4.
  3. **StudioPage frame + copy + list UI + W-013** (StudioPage, HelpMe, copy.ts, tailwind tokens, Workflows.tsx, WorkflowDetail frame, mock plugin, Playwright). Turns green: test 5 and `workflows-list.spec.ts`.

* **Agent gotchas:**
  - Route order in `<Switch>`: `/workflows/new` must come before `/workflows/:id`, or "new" is read as an id.
  - Drift regex: `path="/workflows">` must be followed directly (whitespace allowed) by `<RequireCapability need="…"`. Do not wrap the route in a layout component; that silently drops the match and defaults to viewer (design.md O-5).
  - A capability missing from `CAPABILITY_MIN_ROLE` passes as viewer without complaint (O-9). Add both entries even though both are viewer.
  - Legacy role gate: without the `requiredRole` change, `POST /api/workflows/events` (and every later POST from NZR-23/24/25/26) returns 403 `requiredRole: operator` for a viewer before your capability check runs (`handler.ts:465`).
  - The SPA GET cache serves stale data for 60 s and revalidates in the background (`web/src/lib/api.ts:160, 236-250`). Fine for the list; for anything polled, add a cache-busting query.
  - `web/` has no unit-test runner and `web/node_modules` is not installed on the VPS. Browser behaviour is proven by Playwright only.
  - The env root token has no person: local manual testing needs a magic-link user (see US-031 seed script) or the routes answer `person_required`.
  - Name clash: Jarvis already has "Routines" (saved prompts, `web/src/lib/jarvis/routines.ts`, `web/src/routes/Jarvis.tsx:272`). Keep the Jarvis card title unchanged in this story; NOTES-E-slice asks the owner.

---

## 5. Estimation & Tracking
* **Epic Name:** M2a Core slice (cycle C2a Core vertical slice (plain Workflows tab), 2026-11-10 to 2026-11-23)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** ui, workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Margaret, 67; reach the builder without Help).
- [ ] Acceptance criteria cover both happy paths and edge cases (8 scenarios: empty, list, signed out, no permission, not found, no person / error, nav sync, readability).
- [ ] UX/UI designs are attached and finalized: W-001 and W-013 redone for round 5 words, 20px, Help me, Bigger text and an iPad frame (Q101, due Nov 9); list loading/error/denied states mocked (NO-MOCK-YET today, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-12 merged with the studio table and `src/lib/workflows/store.ts`, or slice 1 adds them).
- [ ] Owner answers on Q99, Q105, Q107, Q108 recorded (recommended yes is the default this story builds).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71; NOTES-E-slice proposes 5).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. T2: fresh Claude critic + free checks (`npm audit --omit=dev --audit-level=high`, `npm --prefix web audit --omit=dev`, `node scripts/ci/secret-scan.mjs <changed files>`, typecheck) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD; full `npm test` green; `npm run e2e:studio` green; `node scripts/ci/diagrams-drift.mjs` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo on desktop and iPad viewport (Q51).
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; `docs/diagrams/architecture-security.md` lists the new routes; product events added to the OBSERVABILITY.md catalogue (NZR-44); mock PNGs replaced by real screenshots for W-001/W-013.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
