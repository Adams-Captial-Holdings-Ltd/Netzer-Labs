---
feature: netzar-studio
document_role: decision
status: accepted
observed_at: 2026-10-20
as_of_commit: d1d3a66970cd548f9529a234ef2b51ecdc29378e
---

# Netzar Studio rebuild: Blueprint v1

Date: 2026-10-20 · Repo: Netzer-Labs `development` @ `d1d3a66` · Source: PRD v1.1 + discovery + grill answers Q1–Q41 (the owner grill answers summarised in section 2).
Status: **accepted by the owner on 2026-10-20** ("can you add it to plane", then "ok push"). Open owner items are tracked in [HANDOFF](HANDOFF.md).

## 1. Goal and deadline
A person with no coding knowledge describes a business process in chat and gets a correct, understandable, testable workflow, then (loop 2) runs it live on real incoming data.
**Done by Dec 31, 2026 (~10 weeks):** factory fixes → knowledge security fix → MVP → loop 2 (Q28, Q32).

## 2. Decisions locked by the grill
| Area | Decision | Q |
|---|---|---|
| MVP | New 5-area Workspace + Conversational Workflow Studio (describe → draft → plain preview → sample-data test). No live activation, teams, canvas, dev studio, packs. | 1, 16 |
| Paperclip | Replace. ADR now; migrate in loop 2. | 2, 10 |
| Work Platform | Paused. PR #206 stays unmerged; reuse screens + step 4–6 libs (effect ledger, executor, approvals) later. | 3 |
| Who builds | Customers build workflows. New ADR supersedes ADR 0017 decision 21. | 4 |
| Agent framework | Keep Netzar's TS runtime. LangGraph.js later, only for AI teams, behind our own interface. No Python frameworks. | 11 |
| Live engine | Loop 2 spike: Step Functions Standard vs own DynamoDB engine, then decide. | 12 |
| Triggers | One trigger contract designed in MVP; loop 2 turns on webhook/API, then forms/embed, then integrations. | 5, 18 |
| Lifecycle | Workflows are versioned data: Draft → Test → Publish (frozen) → Activate (approval) → Monitor → one-click rollback. MVP stops at Test. | 16 |
| Evaluation | Eval flywheel starts in MVP with a drafter eval set. Changes must beat the previous version. Lessons proposed, human approves. Customer data opt-in, scrubbed, stays in their AWS. | 13, 14, 29 |
| Knowledge | Layers Company → Team → Agent + Playbooks. Drafter reads playbooks + agent's own knowledge. Hive Mind = "Company facts", admin-approved writes. Security fix before MVP. | 19, 29–31 |
| Slack/Telegram | Keep current chat working, no new investment. Later: a "send message" workflow step. Not for building workflows (declared parity skip). | 7, 20 |
| Models / env | Bedrock banned → dev uses NVIDIA hosted models via Floci's Bedrock proxy; automated tests use recorded replies. Built and proven locally; staging deploy waits for new AWS account. | 17, 21, 22, 34 |
| Scale | ≤50 users, ~1,000 runs/day per install; serverless pieces, no dead ends. | 15 |
| UI | Workspace (Home, Agents, Workflows, My Work, Library) + Admin console (today's dashboard, 6 sections). Nothing deleted. 18px, WCAG 2.2 AA + automated axe checks. Dense only in Admin. | 6, 25, 35–41 |
| Home | Hero chat input styled after the user's `animated-ai-chat.tsx` (glass box, `/` command palette, attachment chips, suggestion pills, typing indicator) + Build a workflow / Talk to an agent / Add knowledge + Waiting for you + Recent work. | 37 |
| Jarvis | Mic button on Home + chat; orb page → Developer tools. | 38 |
| Connections | Admins only for now. | 39 |
| Agent page | About / Knowledge / Test / Channels; prompt + model under Advanced. | 40 |
| Golden workflow | Insurance policy review: document in → agent reviews → gaps → report → approval. 3–5 real non-technical testers at end of MVP. | 23, 24 |
| Tracking | Repo plan is source of truth (`docs/features/netzar-studio/`); Plane mirror. | 26 |
| Factory | Fix EADS-28/29/30 first; clean clone, no `.env`; push/PR only with owner yes. 2 lanes where files don't overlap. Cap $250, alert $125. | 9, 27, 33 |

## 3. Keep / Modify / Remove / Build
**Keep (as is):** agent runtime core (`agent-loop.ts`: cost gate, kill switches, audit per tool call, tool policy, MCP); upload/embedding pipeline; audit + cost ledger; Members/Seats/permission profiles; Telegram/Slack chat; all admin/ops screens; CI, branch model, feature-docs rules.
**Modify:**
- Navigation: Sidebar `NAV_ITEMS`, `App.tsx` routes, Jarvis `ROUTE_TABLE` (kept in sync, as the repo requires) → Workspace + Admin console.
- Knowledge permissions: `/vectors*` routes enforce scope access; chat-dropped files private to the uploader's chat; Hive Mind writes go to an approval queue.
- Agent page: simplified tabs, Advanced section.
- Design tokens: Workspace type scale base 18px; Admin keeps current density.
- Agent versioning: immutable published versions (today the live S3 file is overwritten) — needed so a workflow pins an agent version.
- Docs: PRD wording "S3 Vectors" → actual JSONL-in-S3.
**Remove:** nothing in this phase (Paperclip retired in loop 2 after migration).
**Build:**
- Workflow definition schema (versioned JSON, steps: trigger, agent step, decision, approval, output) + validator.
- Workflow drafter (agent prompt + tools reading playbooks/agent knowledge) → valid draft or a clarifying question.
- Plain-language preview (numbered steps, who/what/when, approval points; no canvas).
- Sample-data test runner: dry run with AI-step write-deny, no real side effects, per-step results.
- Trigger contract (design only in MVP).
- Playbooks store (Library) + Company facts approval queue.
- Drafter eval set (~30 cases) + scorer + "must beat baseline" CI check (recorded replies).
- Workspace shell + Home.
- Loop 2: live engine (post-spike), webhook/API triggers, publish/activate/rollback, Paperclip migration + retirement, ADRs.

## 4. User journeys (MVP)
1. **First run:** sign in → Home → 3-step welcome (pick an agent, add a document, try an example) → done in < 5 min.
2. **Build a workflow:** Home "Build a workflow" → describe in plain words (typed or 🎤) → Netzar asks ≤3 clarifying questions → shows the draft as plain numbered steps → user edits by chatting ("add my approval before sending") → saved as Draft.
3. **Test it:** "Test with sample data" → pick/upload a sample (e.g. a policy PDF) → step-by-step results in plain words, nothing sent anywhere → mark Ready (Publish arrives in loop 2).
4. **Teach the company:** Library → add a playbook ("How we review policies") → drafter uses it next time; corrections become proposed lessons an admin approves.
5. **Admin:** account menu → Admin → 6 sections; owners see "Stop all agents".

## 5. Architecture changes
- Workflow = data in DynamoDB (draft, versions) + validator in `src/lib/workflows/`; no execution engine in MVP.
- Test runner reuses the agent loop with write-deny and records each step to the audit log.
- Agents pinned by immutable version id.
- Model access unchanged in code (Bedrock client); locally pointed at Floci → NVIDIA. Recorded replies for CI.
- Trigger contract: `{type: webhook|api|form|embed|integration|schedule, auth, schema, rate limit}` → one entry point (loop 2).
- New ADRs: supersede 0012 (Paperclip replaced), supersede 0017 d21 (customers build), amend do-not-build #1 (Netzar owns workflow engine), workflows-as-data, eval flywheel, knowledge layers, agent runtime choice.
- `handler.ts` route changes update `docs/diagrams.map` diagram (CI gate).

## 6. Phases (cycles) and exit gates
| Cycle | Weeks | Scope | Exit gate |
|---|---|---|---|
| C0 Factory hardening | 1 (Oct 20–26) | EADS-28/29/30, clean-clone setup, final Opus review | Opus PASS; harness green; owner OK to touch Netzer-Labs |
| C1 Foundations | 1–2 (Oct 27–Nov 9) | Knowledge security fix; ADRs; Floci→NVIDIA dev env; workflow schema + validator; trigger contract doc; eval harness skeleton | Fix tests prove cross-scope reads denied; ADRs merged; schema validates the golden workflow |
| C2 MVP lane A: Workspace | 3–6 (Nov 10–Dec 7) | Shell, Home (animated chat look), Admin console regroup, agent page, 18px/axe | All 28 old screens reachable; axe 0 serious issues; nav manifest tests pass |
| C2 MVP lane B: Studio | 3–6 (parallel) | Drafter, preview, test runner, playbooks, Company-facts queue, agent versions, eval set | Golden workflow drafted + tested end to end; eval ≥ target |
| C2 exit: testers | 6 (~Dec 1–7) | 3–5 real testers, 1 hr each | ≥4 of 5 (80%) build + test the golden workflow unaided |
| C3 Loop 2: Live | 7–10 (Dec 8–31) | Engine spike → decision; webhook/API triggers; publish/activate/rollback; Paperclip migration + retirement | Golden workflow runs on a live webhook locally; rollback works; Paperclip off; deploy runbook ready for new AWS account |

Risk: C3 is tight (4 weeks incl. holidays). If C2 slips, cut forms/embed (already loop-2-later) and keep webhook/API only.

## 7. MVP acceptance criteria (measurable)
1. From a plain description of the golden workflow, the drafter produces a schema-valid draft in ≤3 clarifying questions in ≥80% of the 30 eval cases (recorded replies).
2. The preview describes every step in plain words; testers can explain what the workflow does (4/5).
3. Sample test makes zero external writes (asserted in tests) and shows a per-step result.
4. 4 of 5 non-technical testers build and test the golden workflow without help in ≤20 minutes.
5. Workspace text ≥18px, touch targets ≥44px, automated axe: 0 serious/critical.
6. All existing admin screens reachable from the Admin console with unchanged permission checks; all existing tests still pass (4,634+).
7. No viewer can read another agent's private knowledge via any `/vectors*` route (tested).
8. Every drafter change runs the eval set; a lower score blocks the merge.
9. Feature docs (`docs/features/netzar-studio/`) pass docs CI; Plane mirrors the plan.

## 8. Open items (need owner input — small)
- **O1 Animated chat component:** it uses React + framer-motion; Netzar's web app is Preact. Recommendation: recreate the look with Tailwind/CSS animations (no new dependency). Alternative: add framer-motion via preact/compat (new dependency → needs your OK, some compat risk).
- **O2 Installs:** `npm ci --prefix web` and Playwright browsers need network installs (owner OK) — required to build/test the UI.
- **O3 NVIDIA usage:** test data only; free-tier credits. OK?
- **O4 Plane:** create project "Netzar Rebuild" (identifier NZR) with cycles C0–C3 after this blueprint is approved.
