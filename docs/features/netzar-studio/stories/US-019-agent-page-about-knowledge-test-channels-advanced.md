# [US-019] Agent page: About / Knowledge / Test / Channels (+ Advanced)

> Backlog task NZR-19 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: AC-009, AC-011, AC-004.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** an agent page that shows what the agent knows and lets me test it
* **So that** I trust which agent I pick (target: in NZR-32, at least 4 of 5 testers can say what the golden-routine agent is for and run one test question from its page without help)

---

## 2. Business Context & Description
* **Background:**
  * AC-004 "The user can select an existing agent"; AC-009 "The user can inspect the agent's expertise and limitations"; AC-011 "The agent can be tested before publication" (PRD lines 1642, 1662, 1666).
  * design.md section 3d maps today's 7 tabs (S-007a-g) onto 4 tabs plus Advanced (W-027..W-031). Prompt file and model ids move under Advanced. Nothing is deleted.
  * Design O-12: the C2 exit gate must check each of the 7 old tabs by name, not "28 screens".
  * Design O-D: `/agents/:id` is ungated in `App.tsx:238`; the server gates every call.
  * PENDING OWNER Q99: Workspace word "Helper" instead of "agent" on this page (heading "About this helper"). If rejected, use "agent". Code and URLs keep "agents".
  * PENDING OWNER Q105: Workspace 20 px text and AAA contrast (built by US-020). The baseline NFR line said "18px, AA"; see NOTES.
* **Current behaviour (d1d3a66):**
  * `web/src/pages/AgentDetail.tsx` (976 lines) loads `GET /agents/:id/detail` (`:63`) and shows 7 tabs: Overview, System Prompt, Sessions, Usage, Memories, Connections, Settings, plus a "Chat" link tab to `/chat/:id` inserted before Sessions (`:107-147`).
  * The tab is stored in the URL hash (`#overview`, `#connections`, …) with `history.replaceState` and follows `hashchange` (`:34-44`, `:51-56`, `:73-80`). Two pages deep-link to `#connections`: `web/src/pages/Agents.tsx:534` (post-create "Connect a channel") and `web/src/pages/Integrations.tsx:627`.
  * The loading skeleton draws 8 tab placeholders (`:82-90`); the load error banner is at `:93-100`.
  * The page has no client-side capability checks: every principal sees Edit, Save, Connect, Deactivate and Delete buttons; the server answers 403 (`grep hasCapability|hasRole AgentDetail.tsx` → no hits).
  * Server gates (`src/adapters/dashboard/handler.ts`): `GET /agents/:agentId/file` → `agents:read` (`:1612`); `PUT /agents/:agentId/file`, `PATCH /agents/:id`, `DELETE /agents/:id`, `POST /agents/:id/activate|deactivate`, `POST /agents/:id/telegram/connect`, `POST /agents/:id/slack/connect` → `agents:write` (`:1628`, `:1807`, `:1875`, `:1888`, `:1913`, `:1949`). `GET /agents/:id/detail` and `GET /agents/:agentId/history` have no inline check and fall to the method ladder: GET → viewer, other methods → operator (`handler.ts:464-465`). `POST /agents/:id/telegram/validate-token` has no inline check (operator by ladder).
  * Templated viewer holds `agents:read` and `vectors:read` but not `agents:write`; operator adds `agents:write` (`src/lib/auth/permissions.ts:195-225`).
  * Knowledge: `/vectors` lists by scope `default`, `shared` or an agent id (`web/src/pages/Vectors.tsx:197`, `:209-213`); `POST /vectors/answer` and `/vectors/search` need `vectors:read` (`handler.ts:3331`, `:3368`); delete needs `agents:write` (`:3522`); ingest needs `agents:write` (`:3199-3200`). `KnowledgeModelTest({ scope })` already asks a question against a scope and shows passages (`web/src/components/KnowledgeModelTest.tsx:10`, `:111`, `:171`, `:211`).
  * Agent knowledge scope is stored on the agent (`knowledgeScope`, `AgentDetail.tsx:22-25`) and changed in the Settings tab (`:865`).
  * NZR-5 (scope leak fix: knowledge routes enforce agent scope) is not merged at d1d3a66.
* **Target behaviour:**
  * Tabs, in order: **About** (W-027), **Knowledge** (W-028), **Test** (W-029), **Channels** (W-030), then **Advanced** (W-031). "Chat" stays as a link next to the tabs. Tab keys in the hash: `#about`, `#knowledge`, `#test`, `#channels`, `#advanced`.
  * **Old hash links keep working** (aliases): `#overview`→About, `#connections`→Channels, `#prompt`→Advanced/System prompt open, `#sessions`→Advanced/History open, `#usage`→Advanced/Usage open, `#memories`→Advanced/Memories open, `#settings`→Advanced/Turn off or delete open. `Agents.tsx:534` and `Integrations.tsx:627` change to `#channels`.
  * **About:** name, plain description ("What it does"), "What it can't do" (from the agent description's limits field; UNVERIFIED source, see Agent gotchas), status, knowledge scope label, and an Edit button for name and description only. Model moves to Advanced.
  * **Knowledge:** documents in this agent's scope and in "Shared", each with a scope label ("Only this helper" / "All helpers" / "Default"). Upload and remove buttons show only with `agents:write`. Shows a plain notice instead of the list until NZR-5 is merged (feature flag constant, see Files).
  * **Test:** `KnowledgeModelTest` with `scope = agent.knowledgeScope ?? 'default'`, plus the answer's sources and scope used. Needs `vectors:read`.
  * **Channels:** today's Connections panel unchanged (Telegram, Slack), moved.
  * **Advanced:** collapsed sections (`<details>`): System prompt, Model, History (sessions), Usage, Memories, Turn off or delete. Each keeps today's content and states.
  * **No edit right:** for principals without `agents:write` (from `hasCapability` in `web/src/lib/auth.ts`), every edit control renders read-only (`readonly` inputs, no Save/Connect/Delete buttons) with the reason "You can look, but only someone with edit rights can change this helper. Ask your administrator." The server checks stay as they are.
  * Tab bar follows the WAI-ARIA tabs pattern: ←/→ move between tabs, Home/End jump, `aria-controls` links each tab to its panel.
* **Out of scope:**
  * The NZR-5 scope enforcement itself (server).
  * Agent versions panel (W-032, NZR-22).
  * New "can't do" data model or AI-drafted limits (AC-008, NZR-22/later).
  * Gating `/agents/:id` in `App.tsx` (O-D: noted, not changed here).
  * Adding inline capability checks to `GET /agents/:id/detail`, `/history`, `telegram/validate-token` (server; see NOTES).
  * Text scale/AAA (US-020), Help me content (US-015).
* **Target Value:** (1) All 7 old tabs findable by name: a test opens each old hash and finds its content (Scenario 2). (2) A viewer sees 0 enabled edit controls (Scenario 4). (3) NZR-32: ≥ 4 of 5 testers run one test question from the agent page without help (`agent.page_viewed` + `agent.test_asked` events).
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Four tabs plus Advanced
* **Given** an operator principal and the stub `GET /api/agents/policy-checker/detail` → `{ agent: { agentId: "policy-checker", displayName: "Policy Checker", description: "Checks new policies.", model: "us.anthropic.claude-sonnet-4-6", status: "active", knowledgeScope: "policy-checker", telegramConnected: false, slackConnected: false, createdAt: "2026-11-01T00:00:00Z" } }`
* **When** they open `/dashboard/agents/policy-checker`
* **Then** `role="tablist"` holds tabs named "About", "Knowledge", "Test", "Channels", "Advanced" in that order, About is `aria-selected="true"`, the URL hash is `#about`, and the About panel shows "Policy Checker" and "Checks new policies." but not the model id
* **And** opening Advanced shows collapsed sections "System prompt", "Model", "History", "Usage", "Memories", "Turn off or delete"; expanding "Model" shows "Claude Sonnet 4.6"
* **Test:** `tests/e2e/workspace/agent-page.spec.ts` › "four tabs plus Advanced; model only under Advanced"

### Scenario 2: Every old tab still reachable by name and old links work
* **Given** the same agent
* **When** each old hash is opened: `#overview`, `#prompt`, `#sessions`, `#usage`, `#memories`, `#connections`, `#settings`
* **Then** respectively: About is selected; Advanced with "System prompt" open; Advanced with "History" open; Advanced "Usage" open; Advanced "Memories" open; Channels selected and the "Telegram" heading visible; Advanced "Turn off or delete" open
* **And** the hash is rewritten to the new key with `replaceState` (no extra history entry)
* **Test:** `tests/e2e/workspace/agent-page.spec.ts` › "old hash deep links land on the right place"; `src/lib/web-agents/agent-tabs.test.ts` › "resolveTab maps 7 old keys and 5 new keys; unknown → about"

### Scenario 3: Test the agent against its knowledge
* **Given** a viewer (holds `vectors:read`) and the stub `POST /api/vectors/answer` → 200 with one passage from "renewals-2026.pdf"
* **When** they open the Test tab, type "When is the renewal due?" and press "Ask"
* **Then** the request body has `scope: "policy-checker"`, the answer and the source "renewals-2026.pdf" with scope label "Only this helper" are shown, and an `agent.test_asked` event `{agentKind:'custom'}` is passed to `track()`
* **And** if the call returns 403, the tab shows "You don't have access to test this helper." and no Ask button; if 500, "Something went wrong. Try again." with a retry button
* **Test:** `tests/e2e/workspace/agent-page.spec.ts` › "test tab asks with the agent scope and shows sources"

### Scenario 4: No edit right
* **Given** a templated viewer principal (no `agents:write`)
* **When** they open each tab and every Advanced section
* **Then** there is no enabled button named "Edit", "Save", "Connect", "Disconnect", "Turn off", "Delete", "Upload" or "Remove", the system prompt textarea has `readonly`, and the text "You can look, but only someone with edit rights can change this helper. Ask your administrator." is shown once per tab that has edit controls
* **And** a direct `PATCH /api/agents/policy-checker` as that viewer still returns 403 `requiredCapability: 'agents:write'` (server unchanged)
* **Test:** `tests/e2e/workspace/agent-page.spec.ts` › "viewer sees read-only controls with the reason"; `src/adapters/dashboard/authz-matrix.test.ts` › "agent page writes are denied without agents:write" (PATCH, PUT file, DELETE, activate, deactivate, telegram/connect, slack/connect)

### Scenario 5: Knowledge tab before and after NZR-5
* **Given** the constant `AGENT_KNOWLEDGE_SCOPED` is `false` (NZR-5 not merged)
* **When** the Knowledge tab opens
* **Then** it shows "Documents for this helper will show here soon. For now, see Library." with a link to `/dashboard/vectors`, and makes no `/api/vectors` request
* **And** with the constant `true`, it requests `GET /api/vectors?scope=policy-checker` and `GET /api/vectors?scope=shared`, shows each document once with its scope label, and an empty result shows "This helper has no documents yet."
* **Test:** `tests/e2e/workspace/agent-page.spec.ts` › "knowledge tab gated on the NZR-5 flag"

### Scenario 6: Agent not found or load error
* **Given** `GET /api/agents/missing/detail` returns 404, or `GET /api/agents/policy-checker/detail` returns 500
* **When** the page opens
* **Then** 404 shows "We can't find this helper." with "Back to helpers" linking `/dashboard/agents`; 500 shows "We couldn't load this helper. Try again." with a retry button; no tabs render in either case
* **Test:** `tests/e2e/workspace/agent-page.spec.ts` › "not found and load error states"

### Scenario 7: Keyboard tabs
* **Given** focus on the About tab
* **When** the user presses → three times, then End, then Home
* **Then** focus and selection move About → Knowledge → Test → Channels, then Advanced, then About, and each tab's `aria-controls` matches its panel id
* **Test:** `tests/e2e/workspace/agent-page.spec.ts` › "tablist keyboard pattern"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-15 / US-015](US-015-workspace-shell-home-agents-workflows-my-work.md) Workspace shell: Home, Agents, Workflows, My Work, Library
* **Builds on (proposed dependencies, not yet in the backlog; see NOTES):** NZR-5 (agent scope enforcement); until it merges the Knowledge list stays behind a flag.
* **UI/UX Design:** design.md W-027 About, W-028 Knowledge, W-029 Test, W-030 Channels, W-031 Advanced: **NO-MOCK-YET, due Nov 23** ([design.md](../foundation/design.md) section 3d). Today's tabs S-007a-g get real screenshots after NZR-3 installs Playwright. design.md shows tab sub-URLs (`/agents/:id/knowledge`); this story keeps hash tabs (O-3, see NOTES).
* **Non-Functional Requirements:** WCAG 2.2 AA minimum (NFR-005); Workspace text token and AAA from US-020 (PENDING Q105, baseline said 18 px AA); tabs ≥ 44 px tall (C-23); keyboard tab pattern (Scenario 7). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `agent.page_viewed` `{tab:'about'|'knowledge'|'test'|'channels'|'advanced', agentKind:'builtin'|'custom'}`, `agent.test_asked` `{agentKind}`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). No agent id, no question text. Uses US-015 `track()` (no-op until the writer exists, NOTES X2).

* **Files to change:**

| path | change |
|---|---|
| `web/src/pages/AgentDetail.tsx:34-44` | `TabKey` → `'about'|'knowledge'|'test'|'channels'|'advanced'`; `tabFromHash` uses `resolveTab()` from the new data module (old keys alias). |
| `web/src/pages/AgentDetail.tsx:82-90` | Skeleton: 5 tab placeholders. |
| `web/src/pages/AgentDetail.tsx:93-100` | Split 404 ("can't find") from other errors; add retry. `api.get` throws `Error(body.detail || body.error || "HTTP <status>")` without a status field (`web/src/lib/api.ts:106-115`), so match the 404 body's `error` value (UNVERIFIED: what `/agents/:id/detail` returns for an unknown id, `handler.ts:1770-1806`) or add a `status` property to the thrown error (small, shared change). |
| `web/src/pages/AgentDetail.tsx:107-158` | New tab list + panels; ARIA tabs pattern (ids, `aria-controls`, roving `tabIndex`, arrow keys). Keep the Chat link. |
| `web/src/pages/AgentDetail.tsx:160-246` (`OverviewTab`) | Becomes `AboutTab`: name, description, "What it can't do", scope label; model field removed from the edit form (moved to Advanced › Model; same `PATCH /agents/:id` body field `model`). |
| `web/src/pages/AgentDetail.tsx:248-...` (`SystemPromptTab`, `SessionsTab`, `UsageTab`, `MemoriesTab`, `SettingsTab`) | Rendered inside `AdvancedTab` `<details>` sections; logic unchanged; read-only when `!canEdit`. |
| `web/src/pages/AgentDetail.tsx:474-...` (`ConnectionsTab`) | Rendered as Channels; read-only notice when `!canEdit`. |
| `web/src/pages/Agents.tsx:534`, `web/src/pages/Integrations.tsx:627` | `#connections` → `#channels` (alias keeps old links working anyway). |
| `src/adapters/dashboard/authz-matrix.test.ts` | Add the agent-page write rows for Scenario 4 (regression net; server unchanged). |

* **New files:**
  * `web/src/lib/agents/tabs.ts` — data-only: `NEW_TABS`, `OLD_TAB_ALIASES`, `resolveTab(hash) → { tab, open?: AdvancedSection }`, `AGENT_KNOWLEDGE_SCOPED = false` (flip when NZR-5 merges).
  * `web/src/components/agents/AboutTab.tsx`, `KnowledgeTab.tsx`, `TestTab.tsx`, `AdvancedTab.tsx` — split out to keep `AgentDetail.tsx` from growing past 976 lines.
  * `src/lib/web-agents/agent-tabs.test.ts` — vitest (node) for `tabs.ts`.
  * `tests/e2e/workspace/agent-page.spec.ts` — Scenarios 1–7 (US-015 config and stubs).

* **API contract:** N/A: no API change. Reads `GET /agents/:id/detail`, `GET /vectors?scope=`, `POST /vectors/answer` (existing).
* **Data changes:** None.
* **Security notes:**
  * SECURITY.md section 6 "Authorization on the server": read-only UI is convenience; every write keeps `agents:write` on the server (boundary B1). Scenario 4 adds a regression row per write.
  * KN-AC-003/004 (agent scope): the Knowledge list must not show other agents' private documents. Until NZR-5 enforces scope server-side, the tab does not list documents (Scenario 5), so the UI does not imply a guarantee the server does not give yet.
  * The Test tab sends `scope` from the agent record; the server must still check it after NZR-5. Do not let the user type a scope.
  * Channel tokens: unchanged handling (validate-token posts the token; never stored client-side). Do not log tokens.
* **Test plan:**
  * Frozen failing tests first: `src/lib/web-agents/agent-tabs.test.ts`, then `tests/e2e/workspace/agent-page.spec.ts`.
  * Fixtures: synthetic agents "Policy Checker" (custom) and "main" (built-in); documents "renewals-2026.pdf", "claims-guide.docx"; stubs for 403/404/500.
  * Commands: `npx vitest run src/lib/web-agents/ src/adapters/dashboard/authz-matrix.test.ts`; `npm test`; `npm --prefix web run typecheck`; `npm --prefix web run build`; `npx playwright test --config tests/e2e/workspace/playwright.config.ts agent-page.spec.ts`.
* **Repo rules that apply:** No route change (hash tabs) ⇒ no drift/`ROUTE_TABLE`/diagrams change. No new dependency. Feature HANDOFF + dated session handoff.
* **Rollback:** Revert the merge. Old hash links worked before and after.
* **Build slices (proposal):**
  1. **Tab model + aliases** (~1 h): `tabs.ts`, `resolveTab`, hash wiring, Agents/Integrations links. Green: `agent-tabs.test.ts`, Scenario 2.
  2. **About + Advanced + Channels move** (~2 h): split components, `<details>` sections, ARIA tabs, 404/500. Green: Scenarios 1, 6, 7.
  3. **Read-only mode** (~1 h): `canEdit` from `hasCapability('agents:write')`. Green: Scenario 4.
  4. **Knowledge + Test** (~1.5 h): `KnowledgeTab` behind flag, `TestTab` with `KnowledgeModelTest`. Green: Scenarios 3, 5.
* **Agent gotchas:**
  * `hasCapability` on the client returns false until `/whoami` resolves; render read-only first, then enable (never flash edit buttons to a viewer).
  * "What it can't do" has no field today (`AgentInfo` has `description` only, `AgentDetail.tsx:17-32`). Show the line only when the description contains a "Can't do:" paragraph, or leave it out; do not invent a field (UNVERIFIED with the owner; NOTES).
  * Built-in agents (main, ops, research) may have no `knowledgeScope` (`AgentDetail.tsx:22-25`); fall back to `default`.
  * `KnowledgeModelTest` uses raw `fetch` with its own auth headers (`KnowledgeModelTest.tsx:130`, `:171`); stub `**/api/vectors/answer` and `**/api/playground/models` in e2e.
  * Keep `data-tour="agent-detail-title|tabs|panel"` anchors (`AgentDetail.tsx:120`, `:125`, `:150`) in case a tour step uses them later.
  * `history.replaceState` with a hash does not fire `hashchange`; the alias rewrite must not re-trigger the listener loop.

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** ui, agents

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases (old links, viewer, 403/404/500, pre-NZR-5).
- [ ] UX/UI designs are attached and finalized: design.md W-027..W-031 are **NO-MOCK-YET, due Nov 23** (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (proposed extras marked in section 4; NZR-15; NZR-5 status known so the flag value is set).
- [ ] Owner nod on hash tabs instead of design's sub-URLs, and on the "What it can't do" source.
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71; NOTES suggests 8).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. T2: fresh Claude critic + free checks (npm audit, secret scan, typecheck) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: `npx vitest run src/lib/web-agents/ src/adapters/dashboard/authz-matrix.test.ts` and `npx playwright test --config tests/e2e/workspace/playwright.config.ts agent-page.spec.ts`; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51): operator and viewer on the same agent; each old tab name found.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; the old-tab → new-tab map promoted to README/ADR (it is the C2 exit-gate check, O-12).
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
