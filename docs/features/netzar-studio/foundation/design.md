---
feature: netzar-studio
document_role: decision
status: draft
observed_at: 2026-10-23
as_of_commit: d1d3a66970cd548f9529a234ef2b51ecdc29378e
---

# Netzar Studio rebuild: design

> Foundation PLAN design doc. Owner rules: Q49 (every state, marked MOCK) as refined by Q77 (full mocks only for the Workflows slice, phone + desktop, light mode, seeded sample data; every other screen is an inventory row marked NO-MOCK-YET with a date). The departure from the PLAN-gate wording "every screen has a screenshot" is recorded in [blueprint v2](../blueprint.md) section 2 (Designs) and becomes a line in the C1 mock-policy ADR (NZR-8).

## 1. Rules every Workspace screen follows

- Plain words, no jargon. Every status says what happened and what to do next. Never show raw JSON, stack traces or model ids to business users.
- Body text at least 18px; touch targets at least 44 x 44 px; WCAG 2.2 AA; axe 0 serious/critical ([CONSTRAINTS](CONSTRAINTS.md) C-20 to C-26).
- Safety is visible: a test always says "Nothing was sent anywhere"; blocked writes show "would have sent …"; approvals are tagged on the step.
- One primary action per screen; secondary actions as outlined buttons; disabled buttons always explain why.
- Light mode only for MVP (dark mode when CONSTRAINTS requires it). Reduced motion respected.
- Mocks use the existing app's Tailwind look (indigo primary, white cards). Colours in the mock are approximations; the build uses the app's tokens.
- Admin console keeps today's density (no 18px rule there).

## 2. Workflows slice gallery (MOCK)

Throwaway static HTML rendered in headless Chromium, desktop 1440 x 900 and phone 390 x 844, full page, seeded synthetic data. Each PNG has a `.provenance.json` sidecar. Replace with real screenshots when the step that builds the screen lands.

| Screen | State | Desktop | Phone |
|---|---|---|---|
| W-001 | Workflow list: empty | [desktop](../../../assets/netzar-studio/mock/W-001-empty-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-001-empty-phone.png) |
| W-001 | Workflow list: populated | [desktop](../../../assets/netzar-studio/mock/W-001-list-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-001-list-phone.png) |
| W-002 | Describe: thinking | [desktop](../../../assets/netzar-studio/mock/W-002-describe-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-002-describe-phone.png) |
| W-002 | Describe: too vague, drafter asks for trigger and result | [desktop](../../../assets/netzar-studio/mock/W-002-unclear-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-002-unclear-phone.png) |
| W-002 | Describe: model unavailable | [desktop](../../../assets/netzar-studio/mock/W-002-model-down-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-002-model-down-phone.png) |
| W-003 | Clarifying question (1 of at most 3) | [desktop](../../../assets/netzar-studio/mock/W-003-clarify-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-003-clarify-phone.png) |
| W-004 | Preview: numbered plain steps | [desktop](../../../assets/netzar-studio/mock/W-004-preview-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-004-preview-phone.png) |
| W-004 | Preview: needs setup, testing disabled | [desktop](../../../assets/netzar-studio/mock/W-004-needs-setup-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-004-needs-setup-phone.png) |
| W-005 | Pick an agent for a step | [desktop](../../../assets/netzar-studio/mock/W-005-pick-agent-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-005-pick-agent-phone.png) |
| W-006 | Edit by chat: change applied and highlighted | [desktop](../../../assets/netzar-studio/mock/W-006-edit-by-chat-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-006-edit-by-chat-phone.png) |
| W-007 | Draft history with restore | [desktop](../../../assets/netzar-studio/mock/W-007-history-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-007-history-phone.png) |
| W-008 | Test: pick a sample (synthetic) | [desktop](../../../assets/netzar-studio/mock/W-008-pick-sample-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-008-pick-sample-phone.png) |
| W-009 | Test running, step n of N | [desktop](../../../assets/netzar-studio/mock/W-009-running-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-009-running-phone.png) |
| W-010 | Results: all passed, nothing sent | [desktop](../../../assets/netzar-studio/mock/W-010-results-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-010-results-phone.png) |
| W-010 | Results: write blocked, shows what would have been sent | [desktop](../../../assets/netzar-studio/mock/W-010-blocked-write-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-010-blocked-write-phone.png) |
| W-011 | Test failed at a step | [desktop](../../../assets/netzar-studio/mock/W-011-failed-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-011-failed-phone.png) |
| W-012 | Ready (turn-on comes later) | [desktop](../../../assets/netzar-studio/mock/W-012-ready-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-012-ready-phone.png) |
| W-013 | Not found / no access | [desktop](../../../assets/netzar-studio/mock/W-013-no-access-desktop.png) | [phone](../../../assets/netzar-studio/mock/W-013-no-access-phone.png) |

**Slice states not yet mocked (due Nov 9, before NZR-48/23/24/25/26 PLANNING):** list loading/error/permission-denied (W-001); describe offline and input too long (W-002); question limit reached (W-003); generating and validator errors (W-004); no agent fits / picker error (W-005); edit request unclear (W-006); restore failed (W-007); upload progress, wrong type, too large, upload failed (W-008); queued, cancelling, cancelled, timed out (W-009); expanded technical trace (W-010); system error before start (W-011); out of date and can't-mark-ready (W-012).

## 3. Screen inventory (today + rebuild)

Source: read-only review of `web/src` at `d1d3a66` (2026-10-23). Owner decisions this section asks for (O-1 home route, O-2 Admin link visibility) are in grill round 4.

### 0. Headline numbers

| What | Count | How it was counted |
|---|---|---|
| Sidebar tabs (`NAV_ITEMS`) | **28** | `Sidebar.tsx:92-231`, in 7 groups (Core 5, Operations 4, Security 8, Advanced 5, Collaboration 1, Team 2, Account 3) |
| Static signed-in routes in `App.tsx` | **28** | Same 28 paths as the sidebar. The drift test also checks these. |
| Jarvis `ROUTE_TABLE` entries | **28** | `route-manifest.ts:106-159`. Same 28 paths. |
| Detail routes (`:param`) | 2 | `/agents/:id` (`App.tsx:238`), `/chat/:agentId` (`App.tsx:240`) |
| Pre-sign-in and fallback screens | 4 | Login (shown by `AuthGate`, no route), `/accept`, `/verify`, NotFound |
| **Routed screens in total (S-rows below)** | **34** | 28 + 2 + 4 |
| Page component files | 33 | 32 in `web/src/pages/` + `web/src/routes/Jarvis.tsx`. `Chat.tsx` serves 2 routes. |
| Tabs inside a page | 13 | Agent detail 7, Security Posture 4, Compliance 2 (one per framework the scan returns; SOC 2 and HIPAA today) |
| **New screens for the rebuild (W-rows below)** | **36** | 13 in the Workflows slice + 23 others |

### Checking the counts the docs claim

| Claim | Where | Verdict |
|---|---|---|
| "28 tabs" / "Replace 28-tab sidebar" | backlog NZR-15, blueprint section 6 C2 ("All 28 old screens reachable") | **Correct** for sidebar tabs, static routes and `ROUTE_TABLE`. It misses some screens, though: 2 detail routes (`/agents/:id`, `/chat/:agentId`), 4 pre-sign-in or fallback screens, and 13 tabs inside pages. The C2 exit gate "all 28 old screens reachable" should say **30 signed-in routes** (28 + 2 detail routes) plus the 7 agent-detail tabs. Otherwise the agent page rework (NZR-19) could quietly drop a tab and still pass. |
| "18 admin tabs" | backlog NZR-16 title | **Can't be backed by the code.** No grouping in the code gives 18. The numbers the code does support: 20 tabs outside the Core and Account groups; 11 tabs gated above viewer level (cost, kill-switches, dlp, panic, rate-limits, alerting, security-posture, compliance, integrations, members, seats); **22** tabs that land in the Admin console under the proposal in section 4. You only get 18 if Missions, Scheduled, Memories and Hive Mind also move to the Workspace (for example My Work and Library). The blueprint doesn't say that. Fix the title to "22" or record the 4 moves as a decision. |
| "32 existing pages" | owner | **Correct as a file count.** `web/src/pages/` has 32 `.tsx` files, but that leaves out `routes/Jarvis.tsx` (33 components) and counts Login, AcceptInvite, VerifyLogin and NotFound, which are not dashboard tabs. As routed screens the answer is **34**. |

---

### 1. Existing screens (today)

**How the gates work.** Every gated route is wrapped in `<RequireCapability need=… label=…>` (`App.tsx:137-158`). That gives every gated route two shared states:
- **"Checking permissions..."** while the user's role is still null (`App.tsx:146-148`).
- **Permission-denied:** an `EmptyState` reading "\<label\> access required" (`App.tsx:149-155`).

The States column below lists only states the page builds itself, plus "denied (route)" where this shared gate applies. Every lazy-loaded page also shares a Suspense "Loading..." (`App.tsx:220`) and the `ErrorBoundary` (`App.tsx:212`).

"Jarvis rung" is the role level from `ROUTE_TABLE` (viewer, operator or admin).

| ID | Screen | Route | Component | Sidebar group today | Gate (cite) | Proposed home in the rebuild | States found in code |
|---|---|---|---|---|---|---|---|
| S-001 | Sign in | none (any path, no token) | `pages/Login.tsx` | not in nav | none; `AuthGate` `App.tsx:106-119` | Unchanged, outside the shell (restyle later) | form; submitting `Login.tsx:257`; error: invalid token, server unreachable, network `:76-85` |
| S-002 | Accept invite | `/accept` | `pages/AcceptInvite.tsx` | not in nav | none, before sign-in `App.tsx:327-331` | Unchanged | activating; error: missing token `:45`, invalid or expired `:60`, activation failed `:81`; success redirects |
| S-003 | Verify sign-in link | `/verify` | `pages/VerifyLogin.tsx` | not in nav | none, before sign-in `App.tsx:332-336` | Unchanged | verifying; error: missing token `:41`, invalid/expired/used `:60` |
| S-004 | Not found | catch-all | `pages/NotFound.tsx` | not in nav | none `App.tsx:303` | Unchanged; restyle for Workspace | static only |
| S-005 | Overview | `/` | `pages/Overview.tsx` | Core | `overview:read` `App.tsx:236`; Jarvis rung viewer | **Admin > Operations** (Admin landing). Business users land on the new Home (W-014). See the `/` conflict in section 5. | loading skeletons `:240,318,349`; populated; empty lines "No agents reporting" `:278`, "No sessions yet" `:369`; a 403 on one card hides that card (`failSoft` `:85-100`); in-page gates `security:write` `:285,413`, `integrations:read` `:379`; **no page-level error UI** (errors only go to the console `:101`); denied (route) |
| S-006 | Agents | `/agents` | `pages/Agents.tsx` | Core | `agents:read` `App.tsx:237`; viewer | **Workspace > Agents** (restyle at 18px) | loading cards `:128-130`; empty `:136`; no-match filter `:134`; errors as toasts; "New Agent" form `:386`; confirm dialog `:272`; denied (route) |
| S-007 | Agent detail | `/agents/:id` | `pages/AgentDetail.tsx` | not in nav (child of Agents) | **No gate** `App.tsx:238` (comment `:232-235`: inherits from the parent) | **Workspace > Agents > agent page** (tabs reworked, see S-007a-g and W-027..W-032) | loading skeleton `:82-90` (draws 8 tab placeholders for 7 tabs); load error banner `:99`; populated with 7 tabs `:107-113` |
| S-007a | Agent tab: Overview | (same, tab state) | `AgentDetail.tsx:163` | — | as S-007 | Agent **About** tab | populated; inline edit of name, description, model `:206-208` |
| S-007b | Agent tab: System Prompt | (tab) | `AgentDetail.tsx:248` | — | as S-007 | Agent **Advanced** | loading `:285`; populated |
| S-007c | Agent tab: Sessions | (tab) | `AgentDetail.tsx` ~`:350` | — | as S-007 | Agent **Advanced** (history) | loading `:358`; empty `:359` |
| S-007d | Agent tab: Usage | (tab) | `AgentDetail.tsx` ~`:385` | — | as S-007 | Agent **Advanced** | loading `:390`; empty "No usage data" `:391` |
| S-007e | Agent tab: Memories | (tab) | `AgentDetail.tsx:421` | — | as S-007 | Agent **Advanced** | loading `:434`; empty `:439` |
| S-007f | Agent tab: Connections | (tab) | `AgentDetail.tsx:474` | — | as S-007 | Agent **Channels** tab | Telegram/Slack connect; token check errors `:606,686,746,836`; disconnect confirm `:660,793` |
| S-007g | Agent tab: Settings | (tab) | `AgentDetail.tsx` ~`:850` | — | as S-007 | Agent **Advanced** (deactivate, delete) | confirm dialogs for deactivate and delete `:967-971` |
| S-008 | Chat | `/chat` | `pages/Chat.tsx` | Core | `chat:read` `App.tsx:239`; viewer | **Workspace > Agents > Talk to an agent** (also opened from Home) | landing / new chat = `ChatLanding` starters; streaming `:74`; populated; agents load error `:217,881`; history load error `:704`; delete confirm `:898`; draws its own top bar (`Sidebar.tsx:63-65`); denied (route) |
| S-009 | Chat with one agent | `/chat/:agentId` | `pages/Chat.tsx` | not in nav | **No gate** `App.tsx:240` | Same as S-008 | same as S-008, but **no** "denied" state, because the route has no gate |
| S-010 | Model Playground | `/playground` | `pages/Playground.tsx` | Core | `chat:read` `App.tsx:241`; viewer | **Admin > Developer tools** | model catalog loading (null) and error `:200`; idle; each model shows loading, done or error `:133,262`; denied (route) |
| S-011 | Jarvis (orb console) | `/jarvis` | `routes/Jarvis.tsx` | Core | **No gate** `App.tsx:302` ("gates itself via the fail-closed manifest"); Sidebar shows it to everyone `Sidebar.tsx:116`; Jarvis rung viewer | **Admin > Developer tools** (NZR-18); mic button moves to Home and chat (W-017) | session state: idle, connecting, listening, thinking, speaking, error, disabled (`lib/jarvis/tools.ts:17-24`); disabled text `:146`; voice-off hint `:194`; name card editable only when `hasRole('admin')` `:287,321`; Routines `:421`; errors as toasts |
| S-012 | Sessions | `/sessions` | `pages/Sessions.tsx` | Operations | `sessions:read` `App.tsx:242`; viewer | **Admin > Operations** | loading rows `:180`; ErrorState `:242`; empty `:249`; transcript loading `:216`; denied (route) |
| S-013 | Usage | `/usage` | `pages/Usage.tsx` | Operations | `usage:read` `App.tsx:243`; viewer | **Admin > Usage & cost** | loading `:187`; ErrorState "Could not load usage" `:176-178`; populated; no explicit empty state; denied (route) |
| S-014 | Cost | `/cost` | `pages/Cost.tsx` | Operations | `cost:write` `App.tsx:253` (note `:244-252`); Jarvis rung operator | **Admin > Usage & cost** | loading `:710,921`; AI report error `:782`; errors as toasts; in-page gates `cost:write` `:430`, `config:write` `:431`; remediation on/off states `:996-998`; denied (route) |
| S-015 | Audit Log | `/audit` | `pages/AuditLog.tsx` | Operations | `audit:read` `App.tsx:254`; viewer | **Admin > Governance** | loading rows `:263`; ErrorState `:311`; empty `:318`; denied (route) |
| S-016 | Kill Switches | `/kill-switches` | `pages/KillSwitches.tsx` | Security | `security:write` `App.tsx:258`; admin | **Admin > Safety controls** | loading `:189-191`; "No kill switches are configured" (summary text only) `:76`; error toast `:127`; confirm modal `:265`; denied (route) |
| S-017 | DLP & Exfil | `/dlp` | `pages/DLP.tsx` | Security | `security:write` `App.tsx:259`; admin | **Admin > Safety controls** | loading `:222`; kill-switch read failed, so the guard state shows as "unverified" `:73,380`; load error toast `:99`; "No patterns matched" `:394`; confirm `:435`; denied (route) |
| S-018 | Panic | `/panic` | `pages/Panic.tsx` | Security | `security:write` `App.tsx:260`; admin | **Admin > Safety controls**, plus a "Stop all agents" button for owners on the Admin landing (W-034) | loading `:174`; active `:180` and inactive `:217`; load error toast `:58`; in-page `security:write` `:44`; confirm `:265`; denied (route) |
| S-019 | Rate Limits | `/rate-limits` | `pages/RateLimits.tsx` | Security | `security:write` `App.tsx:261`; admin | **Admin > Safety controls** | loading `:174`; load error toast `:60`; denied (route) |
| S-020 | Security Posture | `/security-posture` | `pages/SecurityPosture.tsx` | Security | `posture:read` `App.tsx:272`; operator | **Admin > Governance** | loading `:124`; error `:111`; empty `:148`; **4 tabs**: network, security, iam, observability `:14,187`; IAM copilot only with `security:write` `:215`; denied (route) |
| S-021 | Compliance | `/compliance` | `pages/Compliance.tsx` | Security | `compliance:read` `App.tsx:277`; operator | **Admin > Governance** | scanning, complete, failed `:183-199,254`; empty "No compliance data" `:603`; framework tabs `:584` (SOC 2, HIPAA); analysis loading and error `:422-426`; denied (route) |
| S-022 | Alerting | `/alerting` | `pages/Alerting.tsx` | Security | `security:write` `App.tsx:278`; admin | **Admin > Safety controls** | loading `:160,242`; "Could not load recipients" `:170-172`; recipients still pending `:125`; denied (route) |
| S-023 | Integrations | `/integrations` | `pages/Integrations.tsx` | **Security** (but `ROUTE_TABLE` says **Collaboration**) | `integrations:read` `App.tsx:279`; operator | **Admin > People & connections** (the PRD says Connections are admin-only for now, Q39) | 5 sections (Connections, Agent tool servers, Tool catalog, Agent integrations, Secrets posture); loading `:396,579,660`; errors "Failed to load MCP servers" `:302`, "Could not load integrations" `:589`; save error, and a 403 shows as a save error `:287,317`; denied (route) |
| S-024 | Knowledge | `/vectors` | `pages/Vectors.tsx` | Advanced | `vectors:read` `App.tsx:280`; viewer | **Workspace > Library > Documents**; the per-agent scope also shows on the agent Knowledge tab (W-028). Depends on the NZR-5 scope fix. | loading rows `:467`; load error "Couldn't load documents" `:439`; empty "No documents" `:443`; scope picker default, shared, per-agent `:209-213`; search; delete confirm; embeds `KnowledgeModelTest`; denied (route) |
| S-025 | Missions | `/missions` | `pages/Missions.tsx` | Advanced | `missions:read` `App.tsx:281`; viewer | **Admin > Operations** (could move to My Work later) | loading `:297`; ErrorState `:308-310`; empty column text `:359`; create and detail modals `:369,410`; denied (route) |
| S-026 | Memories | `/memories` | `pages/Memories.tsx` | Advanced | `memories:read` `App.tsx:282`; viewer | **Admin > Developer tools** | loading `:168`; ErrorState `:178`; empty sessions `:143`; empty memories `:199`; denied (route) |
| S-027 | Hive Mind | `/hive` | `pages/HiveMind.tsx` | Advanced | `hive:read` `App.tsx:283`; viewer; edits gated on **role** `hasRole('admin')` `:35` | **Admin > Governance**, becoming the Company facts queue (NZR-28, W-025). Approved facts are readable in Library (W-024). | loading `:94,186`; ErrorState `:196`; empty `:203`; edit controls only for admins `:105-129`; denied (route) |
| S-028 | Scheduled | `/scheduled` | `pages/ScheduledTasks.tsx` | Advanced | `scheduled:read` `App.tsx:284`; viewer | **Admin > Operations** (could move to My Work later) | loading rows `:267`; error shown as an EmptyState "Couldn't load scheduled tasks" `:309`; empty `:312`; denied (route) |
| S-029 | War Room | `/warroom` | `pages/WarRoom.tsx` | Collaboration | `warroom:read` `App.tsx:285`; viewer | **Admin > Operations** | empty "Select or create a room" `:867`; errors as toasts; write controls `agents:write` `:231,701,769`; denied (route) |
| S-030 | Seats | `/seats` | `pages/Seats.tsx` | Team | `seats:read` `App.tsx:293`; Jarvis rung admin (comment `route-manifest.ts:111-114`: a plain admin may still be denied) | **Admin > People & connections** | loading `:153`; load errors as toasts `:70,82`; "No policies yet" `:176`; in-page `seats:write`, `seat-policies:write` `:40-41`; denied (route) |
| S-031 | Members | `/members` | `pages/Members.tsx` | Team | `members:read` `App.tsx:295-299` (gate label reads "Team"); operator | **Admin > People & connections** | loading rows `:408`; ErrorState `:365`; empty `:459` (invite button only with write access); in-page `members:write` `:87`; modals: invite, change role, custom profile, confirm `:532-659`; denied (route) |
| S-032 | My Seat | `/my-seat` | `pages/MySeat.tsx` | Account | `usage:self:read` `App.tsx:294`; viewer | **Workspace account menu > My seat** | loading `:61`; empty "No seat assigned yet" `:72`; error toast; denied (route) |
| S-033 | Getting Started | `/getting-started` | `pages/GettingStarted.tsx` | Account | none `App.tsx:292`; first sign-in redirects here `App.tsx:170-177` | **Replaced for business users** by the first-run welcome (W-018). Admin checklist moves to an Admin landing card (W-034). Keep the route. | populated checklist; admin and seat versions keyed on `seats:write`/`members:write` `:181-221`; no loading or error state |
| S-034 | Settings | `/settings` | `pages/Settings.tsx` | Account | none `App.tsx:300`; admin cards gated on **role** `/whoami` `role === 'admin'` `:128` | **Split.** Personal parts (Account, Your name, Theme, Data export, Guided tour) go to Workspace account menu > Settings. Admin cards (Jarvis voice canary `:494`, Daily cost cap `:536`, Async cost report `:577`, API access tokens `:615`, Themes/branding `:680`) go to the matching Admin sections. | loading `:436`; themes load error toast `:161`; "No tokens configured" `:625`; non-admin text instead of controls `:622,749` |

**Shell parts that are not screens (not counted):** `Sidebar`, `Header` (breadcrumbs), `JarvisWidget` (floating Jarvis panel on every page), `TourOverlay`, `NotificationBell` dropdown, `ToastContainer`, `ErrorBoundary`. The 6-path prefetch in `App.tsx:187-201` also runs for every signed-in user.

---

### 2. Count summary

- **Existing routed screens: 34** (S-001..S-034). That is 28 sidebar tabs, 2 detail routes and 4 screens before sign-in or fallback.
- **Plus 13 tabs inside pages** (S-007a-g, plus the Security Posture 4 and Compliance 2, which are not given their own S-rows).
- **Moves under the proposal:** 22 of the 28 sidebar tabs go to the Admin console. 6 go to the Workspace or account menu (Agents, Chat, Knowledge, My Seat, Getting Started, Settings-personal). The pre-sign-in screens don't change.

---

### 3. New screens for the rebuild

**Mock status (Q77).** The Workflows slice needs full mocks before build: every state, phone and desktop, light mode, seeded sample data, marked MOCK. Every other screen is **NO-MOCK-YET**. Mock-due dates below are the planner's proposal (owner may change them):
- Workflows slice mocks: **done** 2026-10-23 (section 2); remaining slice states due Nov 9.
- Workspace, Home and Admin mocks: due **Nov 23** (that work starts around Nov 24).

**Proposed routes** for the slice: `/workflows`, `/workflows/new`, `/workflows/:id` (preview and chat), `/workflows/:id/test`, `/workflows/:id/test/:runId`. In the same change, each new static route must also go into `ROUTE_TABLE`, and each new capability into `CAPABILITY_MIN_ROLE` in the drift test (see section 5, O-9).

### 3a. Workflows slice (core vertical slice, Nov 10–23, in a plain Workflows tab)

| ID | Screen | Route (proposed) | States to design | Built by | PRD AC served | Mock |
|---|---|---|---|---|---|---|
| W-001 | Workflow list | `/workflows` | loading; empty ("No workflows yet" plus a **Build a workflow** button); populated with plain labels (Draft, Tested, Ready; PRD 3.5 wording); error with retry; permission-denied | **No owner.** NZR-15 is the later shell. Add a slice story or fold into NZR-25. | AC-001 | MOCK done 2026-10-23 (gallery, section 2) |
| W-002 | Describe a new workflow (chat) | `/workflows/new` | blank: "What would you like to automate?" with 2–3 example prompts; typing; sending/thinking (typing dots); drafter error (plain words, retry); model unavailable; offline; input too long | NZR-23 | AC-001, AC-002 | MOCK done 2026-10-23 (gallery, section 2) |
| W-003 | Clarifying question | `/workflows/new` (state) | question with a "why this matters" line (PRD 3.2 clarification rules); question count (at most 3); answering; limit reached, so the draft is produced with gaps marked "Needs setup" | NZR-23 | AC-002, AC-006 | MOCK done 2026-10-23 (gallery, section 2) |
| W-004 | Draft preview in plain words | `/workflows/:id` | generating; populated as numbered steps, each saying who, what and when, with the start trigger and end result called out and approval points marked; "Needs setup" items; invalid draft (validator errors in plain words, NZR-12); status label "Draft, not tested, not live" (PRD 3.2 safety and honesty) | NZR-25 (validator: NZR-12) | AC-003, AC-006 | MOCK done 2026-10-23 (gallery, section 2) |
| W-005 | Choose an agent for a step | `/workflows/:id` (panel) | loading; agent list (name, what it's for); none fit ("Ask an admin / create agent" link); error | **No owner.** Picking an agent isn't named in NZR-23 or NZR-25. | AC-004 | MOCK done 2026-10-23 (gallery, section 2) |
| W-006 | Edit by chat | `/workflows/:id` (side chat) | idle; applying change; change applied with the changed steps highlighted ("Step 4 added: your approval"); request unclear, so a clarifying question; edit would break the draft, so it's refused and the reason explained; undo last change | NZR-24 | AC-007 | MOCK done 2026-10-23 (gallery, section 2) |
| W-007 | Draft history | `/workflows/:id` (drawer) | one version; list of versions with what changed; restoring; restore failed | NZR-24 ("version history of draft kept") | AC-007 (later AC-018) | MOCK done 2026-10-23 (gallery, section 2) |
| W-008 | Test: pick or upload sample data | `/workflows/:id/test` | seeded samples to pick from (synthetic policy PDF); no samples (upload only); uploading with progress; wrong file type; file too large; upload failed (actionable); sample chosen; standing banner "Nothing will be sent anywhere" | NZR-26 | AC-005, KN-AC-002 (upload failure must be actionable) | MOCK done 2026-10-23 (gallery, section 2) |
| W-009 | Test running | `/workflows/:id/test/:runId` | queued; running "step n of N" with live per-step status; cancelling; cancelled; timed out | NZR-26 | AC-005 | MOCK done 2026-10-23 (gallery, section 2) |
| W-010 | Per-step test results | `/workflows/:id/test/:runId` | all steps passed; each step shows its input, what the agent did and its output in plain words; "Would have sent: …" for blocked writes; a technical trace that authorized users can expand (PRD 3.5) | NZR-26 | AC-005, AC-003; partly AC-024 (shows the exact action it would take) | MOCK done 2026-10-23 (gallery, section 2) |
| W-011 | Test failed | `/workflows/:id/test/:runId` | a step failed (which step, plain reason, suggested fix, "Ask Netzar to fix it", which hands off to W-006); system error (run never started); model unavailable; retry | NZR-26 | AC-005, AC-006, AC-007 | MOCK done 2026-10-23 (gallery, section 2) |
| W-012 | Ready | `/workflows/:id` | marked "Tested, ready" (with a note that publishing comes later, loop 2); out of date (draft changed after the last test, so test again); can't mark Ready yet because no test has passed | **No owner.** The Ready flag isn't in NZR-25 or NZR-26. | AC-005 (later AC-022) | MOCK done 2026-10-23 (gallery, section 2) |
| W-013 | Workflow not found / no access | `/workflows/:id` | deleted or never existed; belongs to someone else (permission-denied); link back to the list | slice story (same as W-001) | — | MOCK done 2026-10-23 (gallery, section 2) |

### 3b. Workspace, Home, first run, account (from about Nov 24)

| ID | Screen | Route (proposed) | States to design | Built by | PRD AC served | Mock |
|---|---|---|---|---|---|---|
| W-014 | Workspace shell (5 areas: Home, Agents, Workflows, My Work, Library) | all Workspace routes | desktop rail; phone bottom bar or drawer; area active; area hidden when the user lacks the capability; 18px base text, 44px tap targets | NZR-15, NZR-20 | AC-001 | NO-MOCK-YET, due Nov 23 |
| W-015 | Home: hero chat | `/` (see O-1) | idle; `/` command palette open; attachment chips; suggestion pills; typing indicator; send error; reduced-motion version | NZR-17 | AC-001 | NO-MOCK-YET, due Nov 23 |
| W-016 | Home: quick actions, "Waiting for you", "Recent work" | `/` | loading; empty (new user); populated; error per panel | NZR-17 | AC-001 (later AC-023) | NO-MOCK-YET, due Nov 23 |
| W-017 | Mic button (Home and chat) | component | idle; asking for mic access; mic blocked; listening; thinking; error; voice disabled by admin | NZR-18 | — | NO-MOCK-YET, due Nov 23 |
| W-018 | First-run welcome (3 steps: pick an agent, add a document, try an example) | `/welcome` (or replaces the `/getting-started` redirect) | step 1, 2, 3; skipped; resumed; done; no agents available; upload failed | NZR-21 | AC-001, AC-004 | NO-MOCK-YET, due Nov 23 |
| W-019 | Account menu (My seat, Settings, tour, Admin link, sign out) | component | closed; open; Admin link shown or hidden (rule needs a decision, see O-2) | NZR-15 | — | NO-MOCK-YET, due Nov 23 |
| W-020 | My Work (MVP placeholder: my drafts and test runs) | `/my-work` | empty; populated; loading; error | NZR-15 (content not defined in the MVP) | later AC-023, AC-024, AC-025 | NO-MOCK-YET, due Nov 23 |

### 3c. Library

| ID | Screen | Route (proposed) | States to design | Built by | PRD AC served | Mock |
|---|---|---|---|---|---|---|
| W-021 | Library home (Playbooks, Documents, Company facts) | `/library` | loading; per-section counts; empty Library; permission-limited view | NZR-15 | KN-AC-001 | NO-MOCK-YET, due Nov 23 |
| W-022 | Playbooks list | `/library/playbooks` | loading; empty (with an example such as "How we review policies"); populated; error; read-only for users without edit rights | NZR-27 | — (PRD 3.2 "Intelligent reuse") | NO-MOCK-YET, due Nov 23 |
| W-023 | Playbook editor | `/library/playbooks/:id` | new; editing; saving; save failed; delete confirm; "used by the drafter" note | NZR-27 | — | NO-MOCK-YET, due Nov 23 |
| W-024 | Company facts (approved, read-only) | `/library/facts` | loading; empty; populated; error | NZR-28 | KN-AC-003 | NO-MOCK-YET, due Nov 23 |
| W-025 | Company facts approval queue (admin) | Admin > Governance | empty queue; pending items showing source agent and provenance; approve; reject with reason; item conflicts with an existing fact; denied | NZR-28 | KN-AC-003, KN-AC-006 | NO-MOCK-YET, due Nov 23 |
| W-026 | Proposed lessons queue | Admin > Governance (or Library) | empty; pending lesson with the correction it came from; approve; reject; eval case created | NZR-29 (cut order: 3rd) | — | NO-MOCK-YET, due Nov 23 |

### 3d. Agent page (replaces today's 7 tabs, S-007a-g)

| ID | Screen | Route (proposed) | States to design | Built by | PRD AC served | Mock |
|---|---|---|---|---|---|---|
| W-027 | Agent: About | `/agents/:id` (default tab) | loading; populated (what it does, what it can't do); edit name and description; error; not found | NZR-19 | AC-009 | NO-MOCK-YET, due Nov 23 |
| W-028 | Agent: Knowledge | `/agents/:id/knowledge` | loading; empty; documents with their scope labels (this agent / shared / default; PRD 3.6); upload; remove; reprocess; denied for another person's private docs | NZR-19 (depends on NZR-5) | KN-AC-001, KN-AC-003, KN-AC-006 | NO-MOCK-YET, due Nov 23 |
| W-029 | Agent: Test | `/agents/:id/test` | idle; asking; answer with the source and scope used; error. Can reuse `KnowledgeModelTest`. | NZR-19 | AC-011 | NO-MOCK-YET, due Nov 23 |
| W-030 | Agent: Channels | `/agents/:id/channels` | none connected; Telegram connected; Slack connected; token check error; disconnect confirm (re-homes S-007f) | NZR-19 | AC-012 | NO-MOCK-YET, due Nov 23 |
| W-031 | Agent: Advanced (prompt, model, history, usage, memories, deactivate, delete) | `/agents/:id/advanced` | collapsed by default; each sub-panel keeps today's states (S-007b,c,d,e,g) | NZR-19 | AC-009, AC-010 | NO-MOCK-YET, due Nov 23 |
| W-032 | Agent versions | `/agents/:id/advanced` (panel) | one version; list; frozen published version; which workflows pin which version | NZR-22 (it has no UI line yet) | AC-012, AC-022 | NO-MOCK-YET, due Nov 23 |

### 3e. Admin console

| ID | Screen | Route (proposed) | States to design | Built by | PRD AC served | Mock |
|---|---|---|---|---|---|---|
| W-033 | Admin console shell (6-section nav, today's density) | wraps the 22 existing routes | section list with only the screens the user's capabilities allow; empty section hidden; phone layout | NZR-16 | — (PRD 3.1 Administration) | NO-MOCK-YET, due Nov 23 |
| W-034 | Admin landing (Overview, plus "Stop all agents" for owners, plus the admin setup checklist from S-033) | `/admin` or `/` for admins (O-1) | loading; populated; owner-only panic button; checklist done or not done | NZR-16 (+ NZR-18 for the Panic shortcut) | — | NO-MOCK-YET, due Nov 23 |
| W-035 | Developer tools index (Jarvis orb, Playground, Memories) | `/admin/developer` | list; voice disabled; screens hidden per capability | NZR-18 | — | NO-MOCK-YET, due Nov 23 |
| W-036 | No admin access | any Admin route | plain-words refusal and a way back to Home (replaces the generic `RequireCapability` empty state for Workspace users) | NZR-16 | — | NO-MOCK-YET, due Nov 23 |

**New screen count: 36.** That is 13 in the Workflows slice, 7 Workspace/Home/account, 6 Library, 6 agent page, 4 Admin.

---

### 4. Proposed Admin console: 6 sections

The rule is "Nothing deleted" and "permission checks unchanged" (blueprint section 7, item 6). So every screen keeps its current `need=` capability and its URL. The Admin console is a new way to group the screens, not new URLs (see O-3).

| # | Section | Existing screens | In-page cards moved from Settings (S-034) | Count |
|---|---|---|---|---|
| 1 | **Operations** | Overview (S-005, the Admin landing), Sessions (S-012), Missions (S-025), Scheduled (S-028), War Room (S-029) | — | 5 |
| 2 | **Usage & cost** | Usage (S-013), Cost (S-014) | Daily cost cap, Async cost report | 2 |
| 3 | **Safety controls** | Kill Switches (S-016), Panic (S-018; "Stop all agents"), DLP & Exfil (S-017), Rate Limits (S-019), Alerting (S-022) | — | 5 |
| 4 | **Governance** | Audit Log (S-015), Security Posture (S-020), Compliance (S-021), Hive Mind, which becomes the Company facts queue (S-027 → W-025) | Proposed lessons (W-026) | 4 |
| 5 | **People & connections** | Members (S-031), Seats (S-030), Integrations (S-023) | API access tokens, Themes/branding | 3 |
| 6 | **Developer tools** | Jarvis orb (S-011), Model Playground (S-010), Memories (S-026) | Jarvis voice canary | 3 |
| | **Total** | | | **22** |

Two alternatives, if the owner wants 18 (matching the NZR-16 title):
- move Missions and Scheduled to My Work, and
- move Memories and Hive Mind (read view) to Library.

That costs viewer-level users nothing, but My Work would need real content in the MVP, and it doesn't have any yet.

---

### 5. Observations

### 5a. Places where Sidebar, App routes and Jarvis `ROUTE_TABLE` disagree today

| # | Finding | Evidence |
|---|---|---|
| O-A | **Integrations is in a different group.** The sidebar puts it under "Security"; `ROUTE_TABLE` puts it under "Collaboration". The drift test checks only paths and role level, never labels or groups, so this went unnoticed. | `Sidebar.tsx:175` vs `route-manifest.ts:138`; test `route-manifest.test.ts:118-206` |
| O-B | **Labels differ for the same screen.** DLP: "DLP & Exfil" in the sidebar, "DLP" in `ROUTE_TABLE`. Members: "Members" in the nav, "Team" in the access-denied message. Knowledge: "Knowledge" in the nav, "Knowledge Base" in the breadcrumb. Scheduled: "Scheduled" in the nav, "Scheduled Tasks" in the breadcrumb. | `Sidebar.tsx:140,214`; `route-manifest.ts:154`; `App.tsx:296`; `Header.tsx:16,20` |
| O-C | **Breadcrumb labels cover only 14 of the 28 routes.** The other 14 (`/cost`, `/dlp`, `/panic`, `/rate-limits`, `/security-posture`, `/compliance`, `/alerting`, `/integrations`, `/members`, `/seats`, `/my-seat`, `/getting-started`, `/playground`, `/jarvis`) show the raw URL slug, e.g. "security-posture". This is a fourth route list that nothing checks. | `Header.tsx:7-21,31` |
| O-D | **Two detail routes have no gate.** `/agents/:id` and `/chat/:agentId` skip `RequireCapability`, so a principal without `chat:read` can open `/chat/<id>` directly. The backend still checks; the screen just never shows its access-denied state. | `App.tsx:232-240` |
| O-E | **Three gating models are mixed.** Most screens use capabilities. Settings uses the `/whoami` role string (`role === 'admin'`), and Hive Mind and Jarvis use `hasRole('admin')`. A custom profile that holds the right capabilities but not the admin role is wrongly locked out of those controls. | `Settings.tsx:128`; `HiveMind.tsx:35`; `Jarvis.tsx:287` |
| O-F | **Jarvis's 3-level role model is coarser than the capabilities.** `/seats` is listed at the admin level, but a plain admin doesn't hold `seats:read`. So Jarvis can navigate an admin to a page that then denies them. The code says so itself. | `route-manifest.ts:111-115` |
| O-G | **Getting Started, Settings and Jarvis are ungated everywhere.** No `minCapability` in the sidebar, no `RequireCapability` in App, viewer level in `ROUTE_TABLE`. That is consistent, but it means these three appear for every principal in whatever new nav replaces the sidebar. | `Sidebar.tsx:116,224,228`; `App.tsx:292,300,302` |

### 5b. Things that will break when the navigation changes

| # | What breaks | Why | Evidence |
|---|---|---|---|
| O-1 | **Two screens want `/`.** Overview owns `/` behind `overview:read`. Home will want `/` for everyone. Moving Overview breaks the tour test (expects Overview at `/dashboard/`), `resolveRoute('admin','overview') === '/'`, the Jarvis walkthrough's first stop, and the first-run redirect logic. | `App.tsx:236`; `tests/e2e/tour/tour.spec.ts:36-37`; `route-manifest.test.ts:21`; `walkthrough.ts:35` |
| O-2 | **NZR-16 conflicts with today's permissions.** It says "non-admin cannot see Admin link". But 11 of the 22 Admin screens are open to viewers today: 9 viewer-level reads (Overview, Sessions, Usage, Audit, Missions, Memories, Hive, Scheduled, War Room), plus Playground (`chat:read`) and Jarvis (no gate). Wave 5 promised that "no principal loses a tab". Hiding the Admin link from non-admins takes 11 screens away from viewers. That breaks blueprint AC 6 ("unchanged permission checks"). **Owner decision needed:** either show the Admin link to anyone holding any Admin-screen capability, or accept the loss and record it in an ADR. | `App.tsx:222-235`; backlog NZR-16; blueprint section 7, item 6 |
| O-3 | **Moving URLs (for example to `/admin/*`) breaks a lot at once:** the drift test (path set); `walkthrough.ts` (6 routes); `JarvisHud.tsx` route suggestions (11 prefixes); `Header.tsx` breadcrumbs; tour `steps.ts` (29 route entries); Playwright gotos to `/dashboard/cost`, `/dashboard/security-posture` and `/dashboard/chat`; and users' bookmarks. Recommendation: **keep today's URLs in the MVP**. If `/admin/*` arrives later, add redirects then. | `tests/e2e/cost/run.mjs:39`, `iam/run.mjs:37`, `staging/run.mjs:218`, `chat/*.spec.ts` |
| O-4 | **The guided tour depends on the sidebar.** Each tour step spotlights `data-tour="nav:<href>"`, which only exists on sidebar links, for all 28 tabs. The e2e test expects the order Overview (4 steps), then Agents, then Chat. Any screen moved out of the sidebar loses its spotlight target. | `Sidebar.tsx:321`; `lib/tour/steps.ts:43-738`; `tour.spec.ts:40-52` |
| O-5 | **The drift-test regex is fragile.** It finds the gate by matching `path="X">` followed directly by `<RequireCapability need=…`. If a route is wrapped in a layout component (for example `<AdminLayout>`) or switches to nested wouter routes, the match fails, falls back to `viewer`, and every operator/admin route fails the test. Routes also have to stay as literal `<Route path="…">` text. | `route-manifest.test.ts:139,194-205` |
| O-6 | **The web app has no unit tests and no test script.** No test checks `NAV_ITEMS` at all. The only nav checks are the root vitest drift test (App vs `ROUTE_TABLE`) and live-deploy Playwright specs. NZR-15's "Sidebar, App routes and Jarvis ROUTE_TABLE in sync" can't be enforced for the sidebar without a new test. | `web/package.json` scripts (dev, typecheck, build, preview only); no `*.test.*` under `web/src` |
| O-7 | **Two first-run flows will collide.** `AppShell` already redirects first sign-ins to `/getting-started` (keys `GETTING_STARTED_SEEN_KEY` and the old `cce_onboarded`). NZR-21's welcome must take over or retire this redirect, or new users get two onboarding flows. | `App.tsx:170-177` |
| O-8 | **Business users will trigger admin endpoint calls.** Every signed-in user prefetches `/kill-switches`, `/audit?days=7`, `/cost-today` and others 1.5 seconds after load. After the rebuild, business users who never open Admin will cause 403 calls to admin endpoints and noise in the audit log. | `App.tsx:187-201` |
| O-9 | **New capabilities can be silently treated as viewer-level.** In the drift test, a capability missing from `CAPABILITY_MIN_ROLE` falls back to `viewer`. When the Workflows routes add, say, `workflows:read`/`workflows:write`, they must be added to that map. Otherwise the test pins the wrong role level without complaining. | `route-manifest.test.ts:165-204` |
| O-10 | **Chat-specific e2e tests pin the current shell:** the "Open main navigation" button, the house h1, and the orb hint position in the sidebar's lower band. The new Workspace shell will break `conversation-ux.spec.ts`. Similarly, `pageOwnsTopBar` only knows about `/chat`, and the Workflows chat screens may need the same treatment. | `tests/e2e/chat/conversation-ux.spec.ts:385,412,1000`; `Sidebar.tsx:63-65` |
| O-11 | **The slice ships before the shell, so it needs a temporary nav entry.** The plain Workflows tab (Nov 10–23) has to go into today's `NAV_ITEMS`, `App.tsx` and `ROUTE_TABLE` (and optionally the tour) before NZR-15 replaces the nav. No backlog story covers this interim entry or the list, Ready and not-found screens (W-001, W-005, W-012, W-013). | synthesis Q61; backlog NZR-23..26 |
| O-12 | **The C2 exit gate counts screens wrong.** "All 28 old screens reachable" should be 30 signed-in routes plus the 7 agent-detail tabs. Today's 7 agent tabs map onto 4 new tabs plus Advanced (S-007a-g → W-027..W-031), so the gate should check each old tab by name. | blueprint section 6 C2 |

