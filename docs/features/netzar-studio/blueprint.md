---
feature: netzar-studio
document_role: decision
status: accepted
observed_at: 2026-10-23
as_of_commit: d1d3a66970cd548f9529a234ef2b51ecdc29378e
---

# Netzar Studio rebuild: Blueprint v2

Date: 2026-10-23 · Repo: Netzer-Labs `origin/development` @ `d1d3a66` · Sources: PRD v1.1 ([foundation/PRD.md](foundation/PRD.md)), grill 1 (Q1 to Q45, 2026-10-20), grill 2 (Q46 to Q80, 2026-10-23).
Status: v1 accepted by the owner on 2026-10-20; v2 changes come from the owner's grill-2 answers. Where v2 and v1 disagree, v2 wins.
Execution queue: [backlog](backlog.md). Stories: [stories/](stories/README.md). Foundation docs: [foundation/](foundation/CONSTRAINTS.md).

## 1. Goal and definition of done
A person with no coding knowledge describes a business process in chat and gets a correct, understandable, testable workflow, then runs it live on real incoming data.

**Dec 31, 2026 done (Q63):** one design partner runs the golden workflow (insurance policy review) on a live webhook in a deployed install and agrees to a paid pilot or LOI. The install is a managed pilot in PGN's own AWS account (Q64), under a written exception to the customer-hosted data-plane rule, with no customer production data and the partner's consent. Customer-hosted installs come at general availability.

## 2. What changed in v2 (grill 2)
| Area | v2 decision | Q |
|---|---|---|
| Builder | The VPS gauntlet-loop builds Netzar: Codex builds, a fresh Claude critic checks, NVIDIA review roles join only after a bake-off. engdept is parked, so NZR-1, 2 and 4 are parked; NZR-3 and NZR-40 are rewritten for the gauntlet. | 59, 52 |
| Review | T3 steps (schema, versions, security, engine, ADRs): full layers + one Greptile pass. T2 UI: critic + free checks + step maid. T1/docs: free checks. Codex reviews only code someone else built. | 68, 51 |
| NVIDIA | No repo code goes to NVIDIA until the owner reads the free-tier terms and says yes. NVIDIA is fine as the dev model backend with test data only. | 65 |
| AWS | Owner opens the AWS account and requests Bedrock this week (NZR-42, drop-dead Nov 9). Bedrock unusable by Nov 23 → re-plan C3. | 60 |
| Order | Security patch (NZR-5/6) and foundation docs both start in week 0 (different files). The foundation-docs gate blocks new feature steps, not fixes to existing behavior. Core vertical slice next (Nov 10 to 23: drafter, preview, test runner, edit-by-chat in a plain Workflows tab); Workspace shell, Home and the rest after. | 62, 75, 61 |
| Evaluation | Replay tests the harness only. Live eval on each drafter change and nightly; the committed result records hashes of the drafter files, dataset and model; CI fails on mismatch. Re-baseline on Bedrock; production reach blocked until then. | 66, 57, 58 |
| Testers | Synthetic documents only. Book 5 by Nov 15; friendly dry-run Nov 23. | 67 |
| Business | One-page brief (ICP, single pain, price hypothesis): Zion drafts by Nov 12, owner corrects by Nov 15; 2 design-partner calls by Nov 23. | 73, 79 |
| Re-plan | Fixed date Nov 9 (C1 gate), using real cost per step. | 71, 56 |
| Cuts | NZR-39, then NZR-37 (Paperclip retirement moves to January), then NZR-29, then NZR-18. Kill rule: drafter under 70% on the live eval at the Nov 23 gate stops UI work until the drafter is fixed. | 72 |
| Capacity | One lane. Resize the VPS to 8 GB before running two lanes; Playwright runs serially. | 69 |
| Plan docs | Before step 1 of new feature work: PRD, CONSTRAINTS, ARCHITECTURE, DATA-MODEL, SECURITY, DEPLOY, design.md (in [foundation/](foundation/CONSTRAINTS.md)). OBSERVABILITY and TEST-STRATEGY are C1 stories. | 48 |
| Designs | Full MOCK set (phone + desktop, light mode, seeded sample data) for the Workflows slice. Every other screen is an inventory row marked NO-MOCK-YET with a due date. **Decision line (Q77):** this departs from the gauntlet PLAN gate wording "every screen has a screenshot"; accepted because the other screens are built weeks later and will change; revisit trigger: a NO-MOCK-YET screen reaching its step's PLANNING without a mock. Dark mode not required until CONSTRAINTS says so. | 49, 77 |
| Stories | One plan story + one step story per backlog item in the owner's template; N/A lines carry a reason; task stories written at each step's planning. Stories cite PRD IDs. Points: 1 pt ≈ 1 h, rounded to 1/2/3/5/8/13. | 70, 46, 47, 53 |
| Tracking | Repo is the source of truth; Plane mirrors it only with the owner's yes. Plane NZR-41 (review gauntlet v2) is now in the repo backlog, scoped to wiring. The AWS account is NZR-42. US-n = NZR-n. | 53, 74, 76 |
| Done | Merged to development (owner yes for every merge/push) + verified locally; staging PENDING until the AWS account exists. UAT = owner accepts a short demo; real testers for golden-workflow stories. | 50, 51 |
| Analytics | Named product events in the existing audit log, separate event type, no personal data. | 55 |
| Personas | A first-time AI user, B process owner, E admin, plus Factory operator; C and D wait until 2027. | 54 |
| Installs | `npm ci --prefix web` (lockfile only) and Playwright chromium (official download), one at a time, in the clean clone with no `.env` (NZR-3). | 78 |
| Housekeeping | The plan lands as one docs PR cut from origin/development. Fetch before every build. | 74, 80 |

## 3. Decisions kept from v1 (grill 1)
| Area | Decision | Q |
|---|---|---|
| MVP | Conversational Workflow Studio (describe → draft → plain preview → sample-data test) inside a 5-area Workspace. No AI teams, canvas, developer studio or packs until 2027. | 1, 16 |
| Paperclip | Replaced. ADR in C1; retirement now January (v2). | 2, 10 |
| Work Platform | Paused; PR #206 stays unmerged; reuse its screens and step 4 to 6 libraries (effect ledger, executor, approvals) later. | 3 |
| Who builds | Customers build workflows (supersedes ADR 0017 decision 21). | 4 |
| Agent runtime | Keep Netzar's TypeScript runtime. LangGraph.js later only for AI teams, behind our own interface. No Python frameworks. | 11 |
| Live engine | C3 spike: Step Functions Standard vs own DynamoDB engine, then decide. | 12 |
| Triggers | One trigger contract designed in C1; C3 turns on webhook/API; forms/embed later. | 5, 18 |
| Lifecycle | Workflows are versioned data: Draft → Test → Publish (frozen) → Activate (approval) → Monitor → one-click rollback. | 16 |
| Knowledge | Company → Team → Agent layers + Playbooks; Hive Mind becomes "Company facts" with admin-approved writes. | 19, 29 to 31 |
| Slack/Telegram | Keep working, no new investment; not used to build workflows. | 7, 20 |
| Scale | ≤ 50 users, about 1,000 runs/day per install; serverless pieces, no dead ends. | 15 |
| UI | Workspace (Home, Agents, Workflows, My Work, Library) + Admin console (today's dashboard, 6 sections). Nothing deleted. 18px, WCAG 2.2 AA, axe in CI. Home chat look recreated with Tailwind/CSS (no framer-motion). | 6, 25, 35 to 41 |
| Connections | Admins only for now. | 39 |
| Golden workflow | Insurance policy review: document in → agent reviews → gaps → report → approval. | 23, 24 |
| Factory spend | Cap $250, alert $125. | 33 |

## 4. Keep / Modify / Remove / Build
**Keep (as is):** agent runtime core (`agent-loop.ts`: cost gate, kill switches, audit per tool call, tool policy, MCP); upload/embedding pipeline; audit + cost ledger; Members/Seats/permission profiles; Telegram/Slack chat; all admin/ops screens; CI, branch model, feature-docs rules.
**Modify:**
- Navigation: Sidebar `NAV_ITEMS`, `App.tsx` routes, Jarvis `ROUTE_TABLE` (kept in sync, as the repo requires) → plain Workflows tab first (C2a), then Workspace + Admin console (C2b).
- Knowledge permissions: `/vectors*` routes enforce scope access; chat-dropped files private to the uploader's chat (week 0); Hive Mind writes go to an approval queue.
- Agent page: simplified tabs, Advanced section.
- Design tokens: Workspace type scale base 18px; Admin keeps current density.
- Agent versioning: immutable published versions (today the live S3 file is overwritten) so a workflow pins an agent version.
- Docs: PRD wording "S3 Vectors" → actual JSONL-in-S3.

**Remove:** nothing in this phase (Paperclip retired in January after migration).
**Build:** workflow schema + validator; drafter; plain-language preview; sample-data test runner (write-deny); trigger contract (design); playbooks store + Company facts queue; drafter eval set + live eval gate (hash-checked); Workspace shell + Home; C3: live engine (post-spike), webhook/API triggers, publish/activate/rollback, pilot deploy.

## 5. Architecture changes
- Workflow = data in DynamoDB (draft, versions) + validator in `src/lib/workflows/`; no execution engine until C3.
- Test runner reuses the agent loop with write-deny and records each step to the audit log.
- Agents pinned by immutable version id.
- Model access unchanged in code (Bedrock client); locally pointed at Floci → NVIDIA (test data only). Recorded replies test the harness only; the live eval scores the drafter.
- Trigger contract: `{type: webhook|api|form|embed|integration|schedule, auth, schema, rate limit, idempotency key}` → one entry point (C3).
- New ADRs: supersede 0012 (Paperclip replaced), supersede 0017 d21 (customers build), amend do-not-build #1 (Netzar owns its workflow engine), workflows-as-data, eval flywheel, knowledge layers, agent runtime, pilot hosting exception, mock policy.
- `handler.ts` route changes update the `docs/diagrams.map` diagram (CI gate).
- Detail: [ARCHITECTURE](foundation/ARCHITECTURE.md), [DATA-MODEL](foundation/DATA-MODEL.md), [SECURITY](foundation/SECURITY.md), [DEPLOY](foundation/DEPLOY.md), [design](foundation/design.md).

## 6. User journeys (MVP)
1. **First run:** sign in → welcome (pick an agent, add a document, try an example) in < 5 min.
2. **Build a workflow:** Workflows → describe in plain words (typed or mic) → ≤ 3 clarifying questions → plain numbered draft → edit by chat → saved as Draft.
3. **Test it:** Test with sample data → pick a synthetic sample → per-step results, nothing sent anywhere → mark Ready.
4. **Teach the company:** Library → add a playbook → the drafter uses it; corrections become proposed lessons an admin approves.
5. **Admin:** account menu → Admin console → today's screens; owners see "Stop all agents".
6. **Pilot (C3):** publish → approver activates → partner's system posts to the webhook → run waits for approval → report delivered; one-click rollback.

## 7. Cycles and exit gates
| Cycle | Dates | Scope | Exit gate |
|---|---|---|---|
| C0 Week 0 | Oct 20 to Nov 1 | VPS clean clone + routing + review wiring; NZR-5/6 security patch; foundation docs + stories (this PR); AWS account | Docs PR ready; NZR-5/6 red tests frozen; routing logged; AWS requested |
| C1 Foundations | Oct 27 to Nov 9 | ADRs; OBSERVABILITY + TEST-STRATEGY; local model env; replay harness; schema + validator; trigger contract; eval set + live baseline; brief; tester booking | **Nov 9 gate + fixed re-plan** with real cost per step; AWS account usable (drop-dead) |
| C2a Core slice | Nov 10 to 23 | Plain Workflows tab; drafter; preview; edit-by-chat; sample-data test runner; live eval gate; golden workflow e2e | **Nov 23 gate:** golden workflow end to end; drafter ≥ 70% (kill rule); friendly dry-run; 2 partner calls held; Bedrock usable or C3 re-planned |
| C2b Workspace + testers | Nov 24 to Dec 7 | Shell, Admin console, Home, Jarvis mic, agent page, readability/axe, welcome, agent versions, playbooks, Company facts, lessons, 5 tester sessions | ≥ 4 of 5 testers unaided in ≤ 20 min; axe 0 serious/critical; every old screen reachable |
| C3 Live + pilot | Dec 8 to 31 | Engine spike → engine v1; webhook/API triggers; publish/activate/rollback; pilot deploy; partner live run + pilot/LOI | Dec 31 definition of done (section 1) |
| January | Jan 4 to 29, 2027 | Paperclip migration and retirement | Nothing reads Paperclip |

Main risk: C2b holds 57 points in 2 weeks. If the Nov 9 re-plan shows it does not fit, cut NZR-29 then NZR-18 first (NZR-39 is C3 stretch, NZR-37 already moved).

## 8. MVP acceptance criteria (measurable)
1. Drafter: schema-valid draft in ≤ 3 clarifying questions in ≥ 80% of the 30 live-eval cases (≥ 70% at Nov 23 or UI work stops).
2. Preview: testers can explain what the workflow does (4 of 5).
3. Sample test makes zero external writes (asserted) and shows a per-step result.
4. ≥ 4 of 5 non-technical testers build and test the golden workflow unaided in ≤ 20 minutes.
5. Workspace text ≥ 18px, touch targets ≥ 44px, axe 0 serious/critical.
6. Every existing admin screen reachable from the Admin console with unchanged permission checks; all existing tests pass (4,634+).
7. No viewer can read another agent's private knowledge, or another user's chat files, via any route (tested).
8. Every drafter change has a live eval result whose hashes match; a lower score blocks the merge.
9. Feature docs pass docs CI; Plane mirrors the plan after the owner's yes.

## 9. Open owner items
- Open the AWS account and request Bedrock (NZR-42, this week; drop-dead Nov 9).
- Read the NVIDIA free-tier terms and say yes or no (gates NVIDIA builders and reviewers).
- Book 5 testers by Nov 15 (NZR-46); hold 2 design-partner calls by Nov 23 (NZR-45).
- Answer the brief's owner-only questions: first insurance agency, what they pay today, who signs, pilot in PGN AWS (Q79).
- Yes/no: push this branch and open the docs PR; mirror stories and the v2 backlog to Plane.
