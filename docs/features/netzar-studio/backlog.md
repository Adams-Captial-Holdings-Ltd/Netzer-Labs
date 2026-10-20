---
feature: netzar-studio
document_role: backlog
status: accepted
observed_at: 2026-10-20
as_of_commit: d1d3a66970cd548f9529a234ef2b51ecdc29378e
---

# Netzar Studio rebuild backlog

Approved execution queue for the Netzar rebuild ([feature README](README.md)). Task IDs match the Plane project `Netzar Rebuild` (identifier `NZR`). The repo is the source of truth; Plane mirrors it. Estimates: 1 pt ≈ 1 hour of factory work.

## Cycle C0 Factory hardening (2026-10-20 → 2026-10-26)

Fix EADS-28/29/30 so builders can safely touch Netzer-Labs. Exit: final Opus review PASS, harness green, owner OK.

### NZR-1 EADS-28/29/30: close Opus R2 sandbox blockers

```yaml
work_state: approved
cycle: C0
milestone: M0 Factory cleared
priority: urgent
estimate_points: 6
labels: factory, blocker
```

- **Objective:** Fix the 3 open sandbox escape blockers in engbox from Opus review R2.
- **Acceptance criteria:** Each blocker has a failing test that now passes; harness 43/43 + 27/27 green.
- **Depends on:** none

### NZR-2 Final Opus whole-factory review

```yaml
work_state: approved
cycle: C0
milestone: M0 Factory cleared
priority: urgent
estimate_points: 3
labels: factory, gate
```

- **Objective:** Independent Opus review after the fixes.
- **Acceptance criteria:** Verdict PASS or remaining items recorded as accepted risk with owner words.
- **Depends on:** EADS-28/29/30

### NZR-40 Factory model routing: NVIDIA builders, Codex review, Opus orchestration, Jev checks

```yaml
work_state: approved
cycle: C0
milestone: M0 Factory cleared
priority: high
estimate_points: 5
labels: factory
```

- **Objective:** Owner routing 2026-10-20: NVIDIA models (Gemma 4, Nemotron, GLM/Qwen coders) write small code; Codex reviews; Opus orchestrates; Jev (OpenRouter) picks routes first and double-checks pass/fail; usage exhausted -> Jev picks replacement; Jev unsure -> owner.
- **Acceptance criteria:** engdept roles run on the routed model; each pick logged as JEV: q -> answer (confidence); Jev can fail a pass but never pass a red gate; builder never certifies own work.
- **Depends on:** EADS-28/29/30

### NZR-3 Clean-clone builder workspace for Netzer-Labs (no .env)

```yaml
work_state: approved
cycle: C0
milestone: M0 Factory cleared
priority: high
estimate_points: 2
labels: factory
```

- **Objective:** Builders work on a clone with no secrets.
- **Acceptance criteria:** Clone has no .env or secrets (secret-scan clean); push/PR blocked without owner yes.
- **Depends on:** none

### NZR-4 Register Netzer-Labs as engdept project + link Plane NZR

```yaml
work_state: approved
cycle: C0
milestone: M0 Factory cleared
priority: high
estimate_points: 2
labels: factory
```

- **Objective:** engdept becomes source of truth; Plane mirrors it.
- **Acceptance criteria:** engdept project exists; plane link done; sync idempotent.
- **Depends on:** Final Opus review

## Cycle C1 Foundations (2026-10-27 → 2026-11-09)

Knowledge security fix, ADRs, local model env, workflow schema, trigger contract, eval harness. Exit: cross-scope reads denied in tests; ADRs merged; schema validates golden workflow.

### NZR-5 Fix /vectors scope leak (dashboard routes)

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: urgent
estimate_points: 5
labels: security, knowledge, lane:B
```

- **Objective:** /vectors, /vectors/search, /vectors/answer enforce agent scope access.
- **Acceptance criteria:** Tests: viewer cannot read another agent's private scope via any /vectors* route; existing tests pass.
- **Depends on:** M0

### NZR-6 Chat-dropped files private to the uploading chat

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: high
estimate_points: 4
labels: security, knowledge
```

- **Objective:** Files dropped in a chat are no longer readable by every user of that agent.
- **Acceptance criteria:** Test: user B cannot retrieve user A's chat file; agent still can within A's chat.
- **Depends on:** M0

### NZR-7 ADRs: supersede 0012 + 0017 d21, amend do-not-build #1

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: high
estimate_points: 3
labels: docs, decision
```

- **Objective:** Record: Paperclip replaced; customers build workflows; Netzar owns its workflow engine.
- **Acceptance criteria:** 3 ADRs merged; docs CI green; old ADRs marked superseded.
- **Depends on:** none

### NZR-8 ADRs: workflows-as-data, eval flywheel, knowledge layers, agent runtime

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: high
estimate_points: 3
labels: docs, decision
```

- **Objective:** Record the grill decisions Q11-Q16, Q29-Q31.
- **Acceptance criteria:** 4 ADRs merged; each lists scale/maintainability/cost/reliability trade-offs.
- **Depends on:** none

### NZR-9 Feature docs: docs/features/netzar-studio/ (README, HANDOFF, plan)

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: high
estimate_points: 3
labels: docs
```

- **Objective:** Version-controlled plan agents without Plane can follow.
- **Acceptance criteria:** feature-knowledge.mjs passes; plan lists cycles/tasks matching Plane.
- **Depends on:** none

### NZR-10 Local model env: Floci Bedrock proxy -> NVIDIA

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: high
estimate_points: 4
labels: devenv
```

- **Objective:** Run the real drafter locally while Bedrock is banned.
- **Acceptance criteria:** Documented runbook; one agent turn with tool use succeeds via Floci; no app code change.
- **Depends on:** owner OK (Q44)

### NZR-11 Recorded-reply harness for model calls in tests

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: medium
estimate_points: 3
labels: devenv, eval
```

- **Objective:** Deterministic, free CI runs of drafter tests.
- **Acceptance criteria:** Record/replay toggle; CI runs offline; replay mismatch fails loudly.
- **Depends on:** none

### NZR-12 Workflow definition schema + validator

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: high
estimate_points: 6
labels: lane:B, workflow
```

- **Objective:** Versioned JSON: trigger, agent step, decision, approval, output.
- **Acceptance criteria:** Validator accepts the golden insurance workflow, rejects 10 malformed cases with plain-language errors.
- **Depends on:** none

### NZR-13 Trigger contract design (webhook/api/form/embed/integration/schedule)

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: medium
estimate_points: 2
labels: workflow, docs
```

- **Objective:** One entry contract for all live data sources (switched on in C3).
- **Acceptance criteria:** Design doc + schema type; reviewed; no runtime yet.
- **Depends on:** schema

### NZR-14 Drafter eval set (30 cases) + scorer skeleton

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: high
estimate_points: 5
labels: eval, lane:B
```

- **Objective:** Measure drafter quality from day one.
- **Acceptance criteria:** 30 plain-language descriptions with expected workflows; scorer outputs pass rate; baseline stored.
- **Depends on:** schema

## Cycle C2 MVP (2026-11-10 → 2026-12-07)

Lane A Workspace + Admin console; Lane B Workflow Studio; real testers. Exit: >=4 of 5 testers build+test golden workflow unaided; eval >= 80%.

### NZR-15 Workspace shell: Home, Agents, Workflows, My Work, Library

```yaml
work_state: approved
cycle: C2
milestone: M2A Workspace + Admin console
priority: high
estimate_points: 8
labels: lane:A, ui
```

- **Objective:** Replace 28-tab sidebar for business users.
- **Acceptance criteria:** 5 areas + account menu; Sidebar, App routes and Jarvis ROUTE_TABLE in sync; manifest tests pass.
- **Depends on:** M1

### NZR-16 Admin console: 6 sections, all 18 admin tabs regrouped

```yaml
work_state: approved
cycle: C2
milestone: M2A Workspace + Admin console
priority: high
estimate_points: 5
labels: lane:A, ui
```

- **Objective:** Today's dashboard becomes admin-only console.
- **Acceptance criteria:** Every old screen reachable; permission checks unchanged; non-admin cannot see Admin link.
- **Depends on:** shell

### NZR-17 Home: animated chat hero (Tailwind/CSS port) + quick actions

```yaml
work_state: approved
cycle: C2
milestone: M2A Workspace + Admin console
priority: high
estimate_points: 6
labels: lane:A, ui
```

- **Objective:** Glass chat box, / command palette, chips, suggestion pills, typing dots; Build a workflow / Talk to an agent / Add knowledge; Waiting for you; Recent work.
- **Acceptance criteria:** No new dependencies; keyboard usable; reduced-motion respected.
- **Depends on:** shell

### NZR-18 Jarvis -> mic button on Home and chat; orb page to Developer tools

```yaml
work_state: approved
cycle: C2
milestone: M2A Workspace + Admin console
priority: medium
estimate_points: 3
labels: lane:A, ui
```

- **Objective:** Voice without a separate page.
- **Acceptance criteria:** Mic works on Home + chat; orb page under Admin > Developer tools.
- **Depends on:** shell

### NZR-19 Agent page: About / Knowledge / Test / Channels (+ Advanced)

```yaml
work_state: approved
cycle: C2
milestone: M2A Workspace + Admin console
priority: medium
estimate_points: 5
labels: lane:A, ui
```

- **Objective:** Hide prompt file and model IDs behind Advanced.
- **Acceptance criteria:** All current agent settings still reachable; first-time view shows 4 tabs.
- **Depends on:** shell

### NZR-20 Readability: 18px Workspace scale, 44px targets, axe checks in CI

```yaml
work_state: approved
cycle: C2
milestone: M2A Workspace + Admin console
priority: high
estimate_points: 4
labels: lane:A, a11y
```

- **Objective:** Senior-friendly Workspace; Admin keeps density.
- **Acceptance criteria:** Automated axe: 0 serious/critical on Workspace pages; Playwright check in CI.
- **Depends on:** owner OK (Q43)

### NZR-21 First-run 3-step welcome

```yaml
work_state: approved
cycle: C2
milestone: M2A Workspace + Admin console
priority: medium
estimate_points: 3
labels: lane:A, ui
```

- **Objective:** Pick an agent, add a document, try an example.
- **Acceptance criteria:** New user completes it in < 5 min in tester sessions.
- **Depends on:** Home

### NZR-22 Immutable agent versions (pin by version id)

```yaml
work_state: approved
cycle: C2
milestone: M2B Workflow Studio
priority: high
estimate_points: 5
labels: lane:B, agents
```

- **Objective:** Stop overwriting the live agent file so workflows can pin a version.
- **Acceptance criteria:** Publish creates a frozen version; old versions retrievable; runtime loads pinned version.
- **Depends on:** M1

### NZR-23 Workflow drafter agent (describe -> draft or clarifying question)

```yaml
work_state: approved
cycle: C2
milestone: M2B Workflow Studio
priority: urgent
estimate_points: 8
labels: lane:B, workflow
```

- **Objective:** Turn plain language into a valid draft using playbooks + agent knowledge.
- **Acceptance criteria:** >=80% of eval cases produce schema-valid draft in <=3 clarifying questions (replay).
- **Depends on:** schema, eval set

### NZR-24 Edit-by-chat on drafts

```yaml
work_state: approved
cycle: C2
milestone: M2B Workflow Studio
priority: high
estimate_points: 4
labels: lane:B, workflow
```

- **Objective:** 'Add my approval before sending' updates the draft.
- **Acceptance criteria:** Edits keep the draft valid; version history of draft kept.
- **Depends on:** drafter

### NZR-25 Plain-language preview (numbered steps, no canvas)

```yaml
work_state: approved
cycle: C2
milestone: M2B Workflow Studio
priority: high
estimate_points: 4
labels: lane:B, ui
```

- **Objective:** Show who/what/when and approval points in plain words.
- **Acceptance criteria:** Testers can explain what the workflow does (4/5).
- **Depends on:** drafter

### NZR-26 Sample-data test runner (write-deny dry run)

```yaml
work_state: approved
cycle: C2
milestone: M2B Workflow Studio
priority: urgent
estimate_points: 6
labels: lane:B, workflow
```

- **Objective:** Safe test with sample documents, per-step results.
- **Acceptance criteria:** Zero external writes asserted in tests; every step result audited and shown.
- **Depends on:** drafter

### NZR-27 Library: Playbooks store

```yaml
work_state: approved
cycle: C2
milestone: M2B Workflow Studio
priority: high
estimate_points: 4
labels: lane:B, knowledge
```

- **Objective:** 'How our company does X' procedures the drafter reads.
- **Acceptance criteria:** CRUD + permissions; drafter uses playbook in an eval case.
- **Depends on:** M1

### NZR-28 Hive Mind -> Company facts with admin approval queue

```yaml
work_state: approved
cycle: C2
milestone: M2B Workflow Studio
priority: medium
estimate_points: 4
labels: lane:B, knowledge
```

- **Objective:** Stop unapproved global writes.
- **Acceptance criteria:** New facts land in a queue; only approved facts reach agents; test proves it.
- **Depends on:** M1

### NZR-29 Lessons from corrections -> proposed knowledge

```yaml
work_state: approved
cycle: C2
milestone: M2B Workflow Studio
priority: medium
estimate_points: 3
labels: lane:B, eval
```

- **Objective:** Feedback loop with human approval.
- **Acceptance criteria:** User correction creates a proposed lesson + new eval case; nothing applied without approval.
- **Depends on:** drafter

### NZR-30 Eval gate in CI: drafter changes must not lower score

```yaml
work_state: approved
cycle: C2
milestone: M2B Workflow Studio
priority: high
estimate_points: 3
labels: eval, gate
```

- **Objective:** Agents only get better over time.
- **Acceptance criteria:** CI fails when pass rate drops below stored baseline.
- **Depends on:** eval set

### NZR-31 Golden workflow end-to-end: insurance policy review

```yaml
work_state: approved
cycle: C2
milestone: M2 MVP validated
priority: urgent
estimate_points: 3
labels: gate
```

- **Objective:** Document in -> review -> gaps -> report -> approval, drafted and tested.
- **Acceptance criteria:** Recorded demo + passing e2e test.
- **Depends on:** M2A, M2B

### NZR-32 Real tester sessions (3-5 non-technical people)

```yaml
work_state: approved
cycle: C2
milestone: M2 MVP validated
priority: urgent
estimate_points: 4
labels: needs-owner, gate
```

- **Objective:** Owner lines up testers; 1 hr each, fixed task.
- **Acceptance criteria:** >=4/5 build and test the golden workflow unaided in <=20 min; findings logged as issues.
- **Depends on:** golden workflow

## Cycle C3 Live (loop 2) (2026-12-08 → 2026-12-31)

Engine spike + decision, webhook/API triggers, publish/activate/rollback, Paperclip retired. Exit: golden workflow runs on live webhook locally; rollback works.

### NZR-33 Spike: Step Functions vs own DynamoDB engine (1-2 days)

```yaml
work_state: approved
cycle: C3
milestone: M3 Live workflows
priority: urgent
estimate_points: 3
labels: spike, decision
```

- **Objective:** Pick the live engine on cost, scale, maintainability.
- **Acceptance criteria:** Written comparison + ADR with decision.
- **Depends on:** M2

### NZR-34 Live engine v1 (chosen option)

```yaml
work_state: approved
cycle: C3
milestone: M3 Live workflows
priority: urgent
estimate_points: 10
labels: workflow
```

- **Objective:** Run published workflows durably (waits, retries, approvals).
- **Acceptance criteria:** Golden workflow runs end to end locally; retries and approval waits tested.
- **Depends on:** spike

### NZR-35 Triggers: webhook + API

```yaml
work_state: approved
cycle: C3
milestone: M3 Live workflows
priority: high
estimate_points: 6
labels: workflow
```

- **Objective:** First live data sources per the trigger contract.
- **Acceptance criteria:** Authenticated, rate-limited webhook starts a run; bad payload rejected with clear error.
- **Depends on:** engine

### NZR-36 Publish / Activate (approval) / Rollback

```yaml
work_state: approved
cycle: C3
milestone: M3 Live workflows
priority: high
estimate_points: 5
labels: workflow
```

- **Objective:** Full lifecycle for workflows-as-data.
- **Acceptance criteria:** Publish freezes a version; activation needs approval; one-click rollback tested.
- **Depends on:** engine

### NZR-37 Migrate off Paperclip and retire it

```yaml
work_state: approved
cycle: C3
milestone: M3 Live workflows
priority: high
estimate_points: 8
labels: migration
```

- **Objective:** Paperclip replaced (no customer data).
- **Acceptance criteria:** Nothing reads Paperclip; staging stack removal plan ready; tests green.
- **Depends on:** engine

### NZR-38 Deploy runbook for new AWS account

```yaml
work_state: approved
cycle: C3
milestone: M3 Live workflows
priority: medium
estimate_points: 3
labels: needs-owner, deploy
```

- **Objective:** Ready to deploy the day the account exists.
- **Acceptance criteria:** Runbook + CDK synth green; deploy itself waits for owner yes.
- **Depends on:** M3

### NZR-39 Later (stretch): forms/embed triggers

```yaml
work_state: approved
cycle: C3
milestone: M3 Live workflows
priority: low
estimate_points: 5
labels: stretch
```

- **Objective:** Second wave of live inputs; cut first if late.
- **Acceptance criteria:** Form submission starts a run.
- **Depends on:** webhook

