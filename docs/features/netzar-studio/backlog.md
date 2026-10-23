---
feature: netzar-studio
document_role: backlog
status: accepted
observed_at: 2026-10-23
as_of_commit: d1d3a66970cd548f9529a234ef2b51ecdc29378e
---

# Netzar Studio rebuild backlog (v2)

Approved execution queue ([feature README](README.md), [blueprint v2](blueprint.md)). Generated from one task list; each item has a full user story in [stories/](stories/README.md). Task IDs equal Plane `NZR` sequence ids; ids 43 to 48 are provisional until the Plane mirror creates them (owner yes needed). 1 pt is about 1 hour of factory work, rounded to 1/2/3/5/8/13.

| Cycle | Dates | Points | Exit gate |
|---|---|---|---|
| C0 Week 0: factory, security patch, foundation PLAN | 2026-10-20 to 2026-11-01 | 30 | Foundation docs PR ready for owner; NZR-5/6 red tests frozen; VPS clean clone + routing working; AWS account requested. |
| C1 Foundations | 2026-10-27 to 2026-11-09 | 37 | Nov 9 gate + fixed re-plan: ADRs merged, schema validates golden workflow, eval set + live eval baseline, AWS account usable (NZR-42 drop-dead). Re-plan with real cost per step. |
| C2a Core vertical slice (plain Workflows tab) | 2026-11-10 to 2026-11-23 | 35 | Nov 23 gate: golden workflow drafted, edited and tested end to end in the plain Workflows tab; drafter >= 70% on live eval (kill rule: below 70% stop UI work, fix drafter); friendly dry-run done; 2 partner calls held. |
| C2b Workspace + Admin console + testers | 2026-11-24 to 2026-12-07 | 57 | >= 4 of 5 testers build + test the golden workflow unaided in <= 20 min; axe 0 serious/critical; every old screen reachable. |
| C3 Live (loop 2) + pilot | 2026-12-08 to 2026-12-31 | 33 | Dec 31: one design partner runs the golden workflow on a live webhook in a deployed install (PGN AWS pilot) and agrees to a paid pilot or LOI. |
| LATER January 2027 | 2027-01-04 to 2027-01-29 | 8 | Paperclip retired. |
| **Total active** | | **200** | |

Cut order if late (Q72): NZR-39, then NZR-37 (already moved to January), then NZR-29, then NZR-18. Kill rule: drafter under 70% on the live eval at the Nov 23 gate stops UI work until the drafter is fixed.

## Cycle C0 Week 0: factory, security patch, foundation PLAN (2026-10-20 to 2026-11-01)

Exit: Foundation docs PR ready for owner; NZR-5/6 red tests frozen; VPS clean clone + routing working; AWS account requested.

### NZR-1 EADS-28/29/30: close Opus R2 sandbox blockers

```yaml
work_state: blocked
cycle: C0
labels: factory, parked
```

- **Parked:** Parked by owner (Q59): engdept is parked; the VPS gauntlet-loop builds Netzar.

### NZR-2 Final Opus whole-factory review

```yaml
work_state: blocked
cycle: C0
labels: factory, parked
```

- **Parked:** Parked by owner (Q59): engdept is parked; the VPS gauntlet-loop builds Netzar.

### NZR-3 Clean-clone builder workspace on the VPS (no .env, lockfile installs)

```yaml
work_state: approved
cycle: C0
milestone: M0 Factory ready
priority: Must Have
estimate_points: 3
rigor_tier: T2
deploy_reach: local only
labels: factory, urgent
```

- **Story:** [US-003](stories/US-003-clean-clone-builder-workspace-on-the-vps.md)
- **Objective:** As Factory operator, I want builders to work in a clean clone of Netzer-Labs with no secrets, installed only from the lockfile, so that no build session can leak a secret or pull in an unreviewed dependency.
- **Acceptance criteria:** (1) Clean clone is secret-free: both report nothing and the result is logged. (2) Lockfile-only installs: all three succeed, `git status` shows no lockfile change, peak memory stays under the VPS limit. (3) Push is blocked: the push is refused and the attempt is logged.
- **Requirement IDs:** OBJ-006, NFR-007

**Dependencies.** none

### NZR-4 Register Netzer-Labs as engdept project + link Plane NZR

```yaml
work_state: blocked
cycle: C0
labels: factory, parked
```

- **Parked:** Parked by owner (Q59): engdept is parked; the VPS gauntlet-loop builds Netzar.

### NZR-5 Fix /vectors scope leak: knowledge routes enforce agent scope

```yaml
work_state: approved
cycle: C0
milestone: M0 Security fixed
priority: Must Have
estimate_points: 5
rigor_tier: T3
deploy_reach: local only
labels: security, knowledge, urgent
```

- **Story:** [US-005](stories/US-005-fix-vectors-scope-leak-knowledge-routes-enforce.md)
- **Objective:** As Persona E, enterprise administrator, I want every `/vectors*` route to check the caller's access to the requested scope, so that no user can read another agent's private knowledge.
- **Acceptance criteria:** (1) Own scope works: results return as before. (2) Other scope denied: each returns 403 with a plain error, no data, and an audit entry. (3) No scope given: the request is rejected (400) rather than defaulting to a broad scope.
- **Requirement IDs:** FR-012, FR-029, NFR-007, NFR-010

**Dependencies.** none

### NZR-6 Chat-dropped files private to the uploading chat

```yaml
work_state: approved
cycle: C0
milestone: M0 Security fixed
priority: Must Have
estimate_points: 5
rigor_tier: T3
deploy_reach: local only
labels: security, knowledge
```

- **Story:** [US-006](stories/US-006-chat-dropped-files-private-to-the-uploading.md)
- **Objective:** As Persona E, enterprise administrator, I want a file dropped into a chat to be readable only inside that user's chat, so that one user's documents are never shown to other users of the same agent.
- **Acceptance criteria:** (1) Uploader can use it: the agent answers using the file. (2) Other user cannot: nothing from A's file is returned and the denial is audited. (3) Existing files: they become private to their original chat (or are flagged for review if the owner chat is unknown), never public.
- **Requirement IDs:** FR-012, FR-029, NFR-010

**Dependencies.** none

### NZR-9 Foundation PLAN docs + user stories (this docs PR)

```yaml
work_state: approved
cycle: C0
milestone: M0 Foundation PLAN
priority: Must Have
estimate_points: 8
rigor_tier: T1
deploy_reach: local only
labels: docs, plan
```

- **Story:** [US-009](stories/US-009-foundation-plan-docs-user-stories-this-docs.md)
- **Objective:** As Factory operator, I want the PRD, constraints, architecture, data model, security, deploy and design docs plus the story set in the repo, so that every builder and reviewer works from the same written plan.
- **Acceptance criteria:** (1) Docs complete: both pass. (2) Traceability: every in-scope MVP ID is cited by at least one story and every story cites at least one ID. (3) Docs-only: no file under src/, web/ or infra/ changed.
- **Requirement IDs:** OBJ-001, OBJ-007

**Dependencies.** none

### NZR-40 Gauntlet model routing on the VPS: Codex builds, fresh Claude critic, NVIDIA roles after bake-off

```yaml
work_state: approved
cycle: C0
milestone: M0 Factory ready
priority: Must Have
estimate_points: 5
rigor_tier: T2
deploy_reach: local only
labels: factory
```

- **Story:** [US-040](stories/US-040-gauntlet-model-routing-on-the-vps-codex.md)
- **Objective:** As Factory operator, I want each gauntlet role to run on the model the owner chose, with every pick logged, so that code is built cheaply and checked by someone other than its builder.
- **Acceptance criteria:** (1) Routed step: Codex builds, a new Claude session critiques, and the run log names both models and the Jev pick. (2) No NVIDIA before consent: the route is refused and the step falls back to Codex, with the reason logged. (3) Builder never certifies itself: Codex is excluded from reviewing that change and the critic session id differs from the builder's.
- **Requirement IDs:** NFR-009

**Dependencies.** NZR-3

### NZR-41 Review gauntlet v2 wiring: Q68 tier policy + Kodus/CodeRabbit on the VPS

```yaml
work_state: approved
cycle: C0
milestone: M0 Factory ready
priority: Should Have
estimate_points: 3
rigor_tier: T2
deploy_reach: local only
labels: factory
```

- **Story:** [US-041](stories/US-041-review-gauntlet-v2-wiring-q68-tier-policy.md)
- **Objective:** As Factory operator, I want each step reviewed at the depth its risk tier needs, so that T3 steps get every layer and cheap steps don't burn credits.
- **Acceptance criteria:** (1) Tier picks layers: critic + free checks + step maid run and Greptile does not. (2) T3 gets Greptile once: exactly one Greptile pass runs on the exact SHA and the credit ledger is updated. (3) Third-party send needs consent: the layer stops and asks the owner.
- **Requirement IDs:** NFR-007

**Dependencies.** NZR-40

### NZR-42 Open PGN AWS account + request Bedrock model access (owner, drop-dead Nov 9)

```yaml
work_state: approved
cycle: C0
milestone: M0 Factory ready
priority: Must Have
estimate_points: 1
rigor_tier: N/A
deploy_reach: pilot
labels: needs-owner, deploy, urgent
```

- **Story:** [US-042](stories/US-042-open-pgn-aws-account-request-bedrock-model.md)
- **Objective:** As Factory operator, I want a standalone AWS account with Bedrock Claude access, so that the drafter can be re-measured on the real model and the pilot can be deployed.
- **Acceptance criteria:** (1) Account ready: the account id and grant date are recorded in the HANDOFF. (2) Bedrock late: C3 is re-planned and the pilot date is reset with the owner.
- **Requirement IDs:** OBJ-006

**Dependencies.** none

## Cycle C1 Foundations (2026-10-27 to 2026-11-09)

Exit: Nov 9 gate + fixed re-plan: ADRs merged, schema validates golden workflow, eval set + live eval baseline, AWS account usable (NZR-42 drop-dead). Re-plan with real cost per step.

### NZR-7 ADRs: supersede 0012 + 0017 d21, amend do-not-build #1

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: Must Have
estimate_points: 3
rigor_tier: T3
deploy_reach: local only
labels: docs, decision
```

- **Story:** [US-007](stories/US-007-adrs-supersede-0012-0017-d21-amend-do.md)
- **Objective:** As Factory operator, I want the three reversals of earlier decisions recorded as ADRs, so that no builder follows an old decision the owner has replaced.
- **Acceptance criteria:** (1) ADRs merged: it passes and each ADR lists options, decision, reversibility and revisit trigger. (2) Old ADRs point forward: each shows superseded-by links.
- **Requirement IDs:** FR-030, OBJ-007

**Dependencies.** NZR-9

### NZR-8 ADRs: workflows-as-data, eval flywheel, knowledge layers, agent runtime, pilot hosting, mock policy

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: Must Have
estimate_points: 5
rigor_tier: T3
deploy_reach: local only
labels: docs, decision
```

- **Story:** [US-008](stories/US-008-adrs-workflows-as-data-eval-flywheel-knowledge.md)
- **Objective:** As Factory operator, I want the grill decisions recorded as ADRs with their trade-offs, so that future changes have a revisit trigger instead of re-arguing.
- **Acceptance criteria:** (1) ADRs merged: it passes and each has trade-offs, reversibility and revisit trigger. (2) Pilot exception is bounded: it states: PGN AWS only, no customer production data, partner consent, ends at GA.
- **Requirement IDs:** OBJ-004, OBJ-006, FR-012, FR-027

**Dependencies.** NZR-9

### NZR-10 Local model env: Floci + NVIDIA dev backend (test data only)

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: Must Have
estimate_points: 5
rigor_tier: T2
deploy_reach: local only
labels: devenv
```

- **Story:** [US-010](stories/US-010-local-model-env-floci-nvidia-dev-backend.md)
- **Objective:** As Factory operator, I want the real drafter to run locally against an NVIDIA-hosted model through the Bedrock client, so that we can build and evaluate before the AWS account exists.
- **Acceptance criteria:** (1) Turn succeeds: the turn completes and the cost ledger records it. (2) Only test data: the runbook forbids it and the sample set is the only input used by scripts.
- **Requirement IDs:** NFR-009

**Dependencies.** NZR-3

### NZR-11 Recorded-reply harness for model calls in tests

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: Should Have
estimate_points: 3
rigor_tier: T2
deploy_reach: local only
labels: devenv, eval
```

- **Story:** [US-011](stories/US-011-recorded-reply-harness-for-model-calls-in.md)
- **Objective:** As Factory operator, I want tests to replay recorded model replies offline, so that CI is free and deterministic.
- **Acceptance criteria:** (1) Replay: they pass with no network. (2) Mismatch fails loudly: the test fails naming the missing recording.
- **Requirement IDs:** FR-027

**Dependencies.** none

### NZR-12 Workflow definition schema + validator

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: Must Have
estimate_points: 5
rigor_tier: T3
deploy_reach: local only
labels: workflow
```

- **Story:** [US-012](stories/US-012-workflow-definition-schema-validator.md)
- **Objective:** As Persona B, business process owner, I want a workflow to be stored as versioned data that a validator can check, so that every draft is valid before anyone tests it.
- **Acceptance criteria:** (1) Golden workflow valid: it passes. (2) Malformed rejected in plain words: each fails with a plain-language error naming the step. (3) Unknown construct kept: it is flagged, not silently dropped (AC-021).
- **Requirement IDs:** FR-001, FR-004, FR-008, AC-002, AC-020, AC-021

**Dependencies.** NZR-9

### NZR-13 Trigger contract design (webhook/api/form/embed/integration/schedule)

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: Should Have
estimate_points: 2
rigor_tier: T3
deploy_reach: local only
labels: workflow, docs
```

- **Story:** [US-013](stories/US-013-trigger-contract-design-webhook-api-form-embed.md)
- **Objective:** As Persona B, business process owner, I want one written entry contract for every way a workflow can start, so that live triggers in C3 plug into one entry point.
- **Acceptance criteria:** (1) Contract reviewed: auth, schema, rate limit and idempotency key are defined per trigger type. (2) No runtime: no handler or route is added.
- **Requirement IDs:** FR-011, AC-026

**Dependencies.** NZR-12

### NZR-14 Drafter eval set (30 cases) + scorer + live baseline

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: Must Have
estimate_points: 5
rigor_tier: T2
deploy_reach: local only
labels: eval
```

- **Story:** [US-014](stories/US-014-drafter-eval-set-30-cases-scorer-live.md)
- **Objective:** As Persona B, business process owner, I want 30 plain-language descriptions with expected workflows and a scorer, so that we can tell whether a drafter change made it better or worse.
- **Acceptance criteria:** (1) Baseline stored: a result file with pass rate and the three hashes is committed. (2) Stale result fails: CI fails with 'eval result does not match drafter hash'.
- **Requirement IDs:** FR-001, FR-027, NFR-003

**Dependencies.** NZR-12, NZR-10

### NZR-43 OBSERVABILITY.md: logs, product events, run history, alerts

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: Should Have
estimate_points: 3
rigor_tier: T1
deploy_reach: local only
labels: docs, ops
```

- **Story:** [US-043](stories/US-043-observability-md-logs-product-events-run-history.md)
- **Objective:** As Persona E, enterprise administrator, I want one page that says what is logged, measured and alerted, so that admins can see what workflows did and the owner can read the tester and pilot numbers.
- **Acceptance criteria:** (1) Event catalogue: each event has name, fields, and a 'no personal data' check. (2) No PII: it is rejected and replaced by ids. (3) Allow-list at write time: it requires a per-event field allow-list enforced when the event is written, not later redaction.
- **Requirement IDs:** FR-014, FR-023

**Dependencies.** NZR-9

### NZR-44 TEST-STRATEGY.md: pyramid, replay vs live eval, e2e journeys

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: Should Have
estimate_points: 3
rigor_tier: T1
deploy_reach: local only
labels: docs, eval
```

- **Story:** [US-044](stories/US-044-test-strategy-md-pyramid-replay-vs-live.md)
- **Objective:** As Factory operator, I want the test layers written down, including what replay can and cannot prove, so that no gate claims more than its tests show.
- **Acceptance criteria:** (1) Layers named: unit, integration, replay, live eval, e2e and axe layers each name their command and when they run. (2) Replay limit stated: it says replay cannot score it and the live eval must run.
- **Requirement IDs:** FR-027, NFR-005

**Dependencies.** NZR-9

### NZR-45 Business brief: ICP, single pain, price hypothesis, 2 partner calls

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: Must Have
estimate_points: 2
rigor_tier: N/A
deploy_reach: local only
labels: needs-owner, business
```

- **Story:** [US-045](stories/US-045-business-brief-icp-single-pain-price-hypothesis.md)
- **Objective:** As Design partner, I want a one-page brief and two booked design-partner conversations, so that the Dec 31 pilot has a real customer and a price to test.
- **Acceptance criteria:** (1) Draft on time: it is ready by Nov 12 with every guess marked and the owner-only questions listed. (2) Calls held: notes from 2 partner calls are linked, or the gate records why not.
- **Requirement IDs:** OBJ-008

**Dependencies.** none

### NZR-46 Book 5 testers + friendly dry-run (synthetic documents)

```yaml
work_state: approved
cycle: C1
milestone: M1 Foundations ready
priority: Must Have
estimate_points: 1
rigor_tier: N/A
deploy_reach: local only
labels: needs-owner
```

- **Story:** [US-046](stories/US-046-book-5-testers-friendly-dry-run-synthetic.md)
- **Objective:** As Persona A, first-time AI user, I want 5 non-technical testers booked and one friendly dry-run, so that the C2b tester gate can actually run.
- **Acceptance criteria:** (1) Booked: 5 names and slots are recorded (no personal data in the repo; initials only). (2) Dry-run: findings are logged as issues.
- **Requirement IDs:** OBJ-001

**Dependencies.** none

## Cycle C2a Core vertical slice (plain Workflows tab) (2026-11-10 to 2026-11-23)

Exit: Nov 23 gate: golden workflow drafted, edited and tested end to end in the plain Workflows tab; drafter >= 70% on live eval (kill rule: below 70% stop UI work, fix drafter); friendly dry-run done; 2 partner calls held.

### NZR-23 Workflow drafter: describe -> draft or clarifying question

```yaml
work_state: approved
cycle: C2a
milestone: M2a Core slice
priority: Must Have
estimate_points: 8
rigor_tier: T2
deploy_reach: local only
labels: workflow, urgent
```

- **Story:** [US-023](stories/US-023-workflow-drafter-describe-draft-or-clarifying-question.md)
- **Objective:** As Persona A, first-time AI user, I want to describe my process in plain words and get a valid draft, so that I can automate work without writing code.
- **Acceptance criteria:** (1) Draft from description: within 45 s (p95) they see a schema-valid draft or a clarifying question. (2) Clarifying question: it asks one plain question, and never more than 3 in total. (3) No automatic tool permission: the step is marked 'needs permission' and no tool permission is granted by the drafter (AC-010). (4) Drafter can't produce a valid draft: the user sees 'I couldn't build that yet' plus what is missing, never raw JSON or a stack trace.
- **Requirement IDs:** FR-001, FR-002, AC-002, AC-003, AC-004, AC-010, NFR-002, NFR-003

**Dependencies.** NZR-12, NZR-14, NZR-48

### NZR-24 Edit-by-chat on drafts

```yaml
work_state: approved
cycle: C2a
milestone: M2a Core slice
priority: Must Have
estimate_points: 5
rigor_tier: T2
deploy_reach: local only
labels: workflow
```

- **Story:** [US-024](stories/US-024-edit-by-chat-on-drafts.md)
- **Objective:** As Persona A, first-time AI user, I want to change the draft by saying what I want, so that I can fix it without learning an editor.
- **Acceptance criteria:** (1) Edit applied: an approval step appears before the output step, the change is highlighted and the draft stays valid. (2) Edit would break it: the change is refused with a plain reason and the previous version is kept. (3) Undo: the previous draft version is restored.
- **Requirement IDs:** FR-020, AC-007, AC-020

**Dependencies.** NZR-23

### NZR-25 Plain-language preview (numbered steps, no canvas) + agent picker

```yaml
work_state: approved
cycle: C2a
milestone: M2a Core slice
priority: Must Have
estimate_points: 5
rigor_tier: T2
deploy_reach: local only
labels: ui, workflow
```

- **Story:** [US-025](stories/US-025-plain-language-preview-numbered-steps-no-canvas.md)
- **Objective:** As Persona A, first-time AI user, I want to see my workflow as numbered steps in plain words, so that I understand exactly what it will do before testing.
- **Acceptance criteria:** (1) Readable steps: each step shows a number, a one-line action, who does it and any approval. (2) Pick an agent: a list of agents they may use opens, each with what it is for, and choosing one fills the step. (3) Missing configuration: that step shows 'Needs: pick an agent' with a button, and testing is disabled with the reason.
- **Requirement IDs:** FR-004, AC-003, AC-006

**Dependencies.** NZR-23

### NZR-26 Sample-data test runner (sealed sandbox) + Ready flag

```yaml
work_state: approved
cycle: C2a
milestone: M2a Core slice
priority: Must Have
estimate_points: 8
rigor_tier: T3
deploy_reach: local only
labels: workflow, urgent
```

- **Story:** [US-026](stories/US-026-sample-data-test-runner-sealed-sandbox-ready.md)
- **Objective:** As Persona A, first-time AI user, I want to test my workflow on a sample document and see each step's result, so that I can trust it before it ever touches real systems.
- **Acceptance criteria:** (1) Test passes: each step shows a plain result and the banner says 'Nothing was sent anywhere'. (2) Step fails: the failed step is marked, explained in plain words, and later steps show 'not run'. (3) Write attempt blocked: the write is blocked, shown as 'would have sent X', and audited; no external call is made. (4) Sandbox is total: no remote tool runs, no memory or Hive note is written, and a network spy records zero outbound calls. (5) Mark ready: the workflow shows Ready; if the draft changes afterwards it shows 'Test again'.
- **Requirement IDs:** FR-005, AC-005, FR-014, NFR-008

**Dependencies.** NZR-23

### NZR-30 Live eval gate: per drafter change + nightly, hash-checked in CI

```yaml
work_state: approved
cycle: C2a
milestone: M2a Core slice
priority: Must Have
estimate_points: 3
rigor_tier: T2
deploy_reach: local only
labels: eval, gate
```

- **Story:** [US-030](stories/US-030-live-eval-gate-per-drafter-change-nightly.md)
- **Objective:** As Factory operator, I want every drafter change scored by a live eval and checked in CI, so that the drafter can only get better.
- **Acceptance criteria:** (1) Better passes: the gate passes. (2) Worse fails: the merge is blocked with the two scores shown. (3) Nightly drift: the owner is alerted on Telegram.
- **Requirement IDs:** FR-027

**Dependencies.** NZR-14, NZR-23

### NZR-31 Golden workflow end to end: insurance policy review

```yaml
work_state: approved
cycle: C2a
milestone: M2a Core slice
priority: Must Have
estimate_points: 3
rigor_tier: T2
deploy_reach: local only
labels: gate
```

- **Story:** [US-031](stories/US-031-golden-workflow-end-to-end-insurance-policy.md)
- **Objective:** As Persona B, business process owner, I want the insurance policy review workflow drafted, edited and tested end to end, so that we have one real proof that the product works.
- **Acceptance criteria:** (1) Journey A works: it passes and a recording is saved. (2) Dry-run: findings are logged as issues.
- **Requirement IDs:** AC-001, AC-002, AC-003, AC-004, AC-005, AC-006, AC-007

**Dependencies.** NZR-48, NZR-23, NZR-24, NZR-25, NZR-26

### NZR-48 Plain Workflows tab: list, new, open draft

```yaml
work_state: approved
cycle: C2a
milestone: M2a Core slice
priority: Must Have
estimate_points: 3
rigor_tier: T2
deploy_reach: local only
labels: ui, workflow
```

- **Story:** [US-048](stories/US-048-plain-workflows-tab-list-new-open-draft.md)
- **Objective:** As Persona A, first-time AI user, I want a simple Workflows tab where I can start a new workflow and open my drafts, so that I can reach the builder without developer settings.
- **Acceptance criteria:** (1) Empty state: they see one 'Build a workflow' button and a one-line explanation. (2) List: drafts list with name, status (Draft/Ready) and last edited. (3) Not signed in: they are sent to sign in, no data shown.
- **Requirement IDs:** AC-001, FR-001

**Dependencies.** NZR-12

## Cycle C2b Workspace + Admin console + testers (2026-11-24 to 2026-12-07)

Exit: >= 4 of 5 testers build + test the golden workflow unaided in <= 20 min; axe 0 serious/critical; every old screen reachable.

### NZR-15 Workspace shell: Home, Agents, Workflows, My Work, Library

```yaml
work_state: approved
cycle: C2b
milestone: M2b Workspace + testers
priority: Must Have
estimate_points: 8
rigor_tier: T2
deploy_reach: local only
labels: ui
```

- **Story:** [US-015](stories/US-015-workspace-shell-home-agents-workflows-my-work.md)
- **Objective:** As Persona A, first-time AI user, I want five clear areas instead of 28 tabs, so that I always know where to go.
- **Acceptance criteria:** (1) Five areas: they see Home, Agents, Workflows, My Work, Library and an account menu. (2) Old link: they land on the new home of that screen, not a 404.
- **Requirement IDs:** OBJ-001, AC-001, NFR-001, NFR-005

**Dependencies.** NZR-31

### NZR-16 Admin console: 6 sections holding today's admin screens

```yaml
work_state: approved
cycle: C2b
milestone: M2b Workspace + testers
priority: Must Have
estimate_points: 5
rigor_tier: T2
deploy_reach: local only
labels: ui
```

- **Story:** [US-016](stories/US-016-admin-console-6-sections-holding-today-s.md)
- **Objective:** As Persona E, enterprise administrator, I want all of today's admin screens in one Admin console, so that I keep every control without cluttering the Workspace.
- **Acceptance criteria:** (1) All reachable: every existing admin screen is reachable in <= 2 clicks. (2) Non-admin: no Admin link shows and the URL returns the existing permission error.
- **Requirement IDs:** FR-015, FR-013, OBJ-007

**Dependencies.** NZR-15

### NZR-17 Home: animated chat hero (Tailwind/CSS port) + quick actions

```yaml
work_state: approved
cycle: C2b
milestone: M2b Workspace + testers
priority: Should Have
estimate_points: 5
rigor_tier: T2
deploy_reach: local only
labels: ui
```

- **Story:** [US-017](stories/US-017-home-animated-chat-hero-tailwind-css-port.md)
- **Objective:** As Persona A, first-time AI user, I want a welcoming Home with one chat box and three big actions, so that my next step is obvious.
- **Acceptance criteria:** (1) Quick action: the describe screen opens. (2) Reduced motion: no animation plays and all functions still work.
- **Requirement IDs:** NFR-001, NFR-002, AC-001

**Dependencies.** NZR-15

### NZR-18 Jarvis: mic button on Home and chat; orb page to Developer tools

```yaml
work_state: approved
cycle: C2b
milestone: M2b Workspace + testers
priority: Could Have
estimate_points: 3
rigor_tier: T2
deploy_reach: local only
labels: ui, cut-4
```

- **Story:** [US-018](stories/US-018-jarvis-mic-button-on-home-and-chat.md)
- **Objective:** As Persona A, first-time AI user, I want to speak instead of type, so that describing a process is easier.
- **Acceptance criteria:** (1) Mic: the text appears in the chat box for review before sending. (2) No mic permission: a plain message explains how to allow it; typing still works.
- **Requirement IDs:** NFR-005

**Dependencies.** NZR-17

### NZR-19 Agent page: About / Knowledge / Test / Channels (+ Advanced)

```yaml
work_state: approved
cycle: C2b
milestone: M2b Workspace + testers
priority: Should Have
estimate_points: 5
rigor_tier: T2
deploy_reach: local only
labels: ui, agents
```

- **Story:** [US-019](stories/US-019-agent-page-about-knowledge-test-channels-advanced.md)
- **Objective:** As Persona B, business process owner, I want an agent page that shows what the agent knows and lets me test it, so that I trust which agent I pick.
- **Acceptance criteria:** (1) Four tabs: About, Knowledge, Test, Channels show; prompt and model are under Advanced. (2) No edit right: fields are read-only with the reason shown.
- **Requirement IDs:** AC-009, AC-011, AC-004

**Dependencies.** NZR-15

### NZR-20 Readability: 18px Workspace scale, 44px targets, axe in CI

```yaml
work_state: approved
cycle: C2b
milestone: M2b Workspace + testers
priority: Must Have
estimate_points: 5
rigor_tier: T2
deploy_reach: local only
labels: a11y
```

- **Story:** [US-020](stories/US-020-readability-18px-workspace-scale-44px-targets-axe.md)
- **Objective:** As Persona A, first-time AI user, I want large readable text and big targets, so that older and non-technical users can use it comfortably.
- **Acceptance criteria:** (1) axe clean: 0 serious or critical issues. (2) Regression: the check fails naming the element.
- **Requirement IDs:** NFR-005

**Dependencies.** NZR-15, NZR-3

### NZR-21 First-run 3-step welcome

```yaml
work_state: approved
cycle: C2b
milestone: M2b Workspace + testers
priority: Should Have
estimate_points: 3
rigor_tier: T2
deploy_reach: local only
labels: ui
```

- **Story:** [US-021](stories/US-021-first-run-3-step-welcome.md)
- **Objective:** As Persona A, first-time AI user, I want a short guided start, so that I get to a first result in under 5 minutes.
- **Acceptance criteria:** (1) Finish: they reach a tested example workflow. (2) Skip: they land on Home and can restart the welcome from the account menu.
- **Requirement IDs:** OBJ-001

**Dependencies.** NZR-17

### NZR-22 Immutable agent versions (pin by version id)

```yaml
work_state: approved
cycle: C2b
milestone: M2b Workspace + testers
priority: Must Have
estimate_points: 5
rigor_tier: T3
deploy_reach: local only
labels: agents
```

- **Story:** [US-022](stories/US-022-immutable-agent-versions-pin-by-version-id.md)
- **Objective:** As Persona B, business process owner, I want a workflow to keep using the agent version it was tested with, so that an agent edit never silently changes a workflow.
- **Acceptance criteria:** (1) Publish freezes: a new version id is created and old versions stay retrievable. (2) Pinned run: the workflow still runs version 3 until re-pinned.
- **Requirement IDs:** AC-012, AC-022, FR-008

**Dependencies.** NZR-12

### NZR-27 Library: Playbooks store

```yaml
work_state: approved
cycle: C2b
milestone: M2b Workspace + testers
priority: Should Have
estimate_points: 5
rigor_tier: T2
deploy_reach: local only
labels: knowledge
```

- **Story:** [US-027](stories/US-027-library-playbooks-store.md)
- **Objective:** As Persona B, business process owner, I want to write down how our company does a process, so that the drafter follows our way of working.
- **Acceptance criteria:** (1) Used: the draft follows the playbook steps. (2) No permission: it is refused with the reason.
- **Requirement IDs:** FR-019, FR-012

**Dependencies.** NZR-23

### NZR-28 Hive Mind -> Company facts with admin approval queue

```yaml
work_state: approved
cycle: C2b
milestone: M2b Workspace + testers
priority: Should Have
estimate_points: 5
rigor_tier: T3
deploy_reach: local only
labels: knowledge, security
```

- **Story:** [US-028](stories/US-028-hive-mind-company-facts-with-admin-approval.md)
- **Objective:** As Persona E, enterprise administrator, I want new company-wide facts to wait for my approval, so that no agent spreads an unapproved claim to everyone.
- **Acceptance criteria:** (1) Queued: it lands in the queue and no agent sees it yet. (2) Approved: the fact is available. (3) Rejected: the fact is never used and the rejection is audited. (4) Approved facts don't expire: it is still present (approved facts are stored without TTL).
- **Requirement IDs:** FR-012, FR-023

**Dependencies.** NZR-5

### NZR-29 Lessons from corrections -> proposed knowledge

```yaml
work_state: approved
cycle: C2b
milestone: M2b Workspace + testers
priority: Could Have
estimate_points: 3
rigor_tier: T2
deploy_reach: local only
labels: eval, cut-3
```

- **Story:** [US-029](stories/US-029-lessons-from-corrections-proposed-knowledge.md)
- **Objective:** As Persona B, business process owner, I want my corrections to become proposed lessons, so that the drafter improves with approval.
- **Acceptance criteria:** (1) Proposed: a proposed lesson and a new eval case appear for approval. (2) Not auto-applied: the drafter behavior does not change.
- **Requirement IDs:** FR-027

**Dependencies.** NZR-24

### NZR-32 Real tester sessions (5 non-technical people)

```yaml
work_state: approved
cycle: C2b
milestone: M2b Workspace + testers
priority: Must Have
estimate_points: 5
rigor_tier: N/A
deploy_reach: local only
labels: needs-owner, gate
```

- **Story:** [US-032](stories/US-032-real-tester-sessions-5-non-technical-people.md)
- **Objective:** As Persona A, first-time AI user, I want 5 real non-technical people to try the golden workflow, so that we know it works for the people it is for.
- **Acceptance criteria:** (1) Pass: >= 4 complete unaided in <= 20 minutes. (2) Fail: findings become issues and the C3 start is re-decided with the owner.
- **Requirement IDs:** OBJ-001, AC-001, AC-002, AC-005

**Dependencies.** NZR-31, NZR-15, NZR-46

## Cycle C3 Live (loop 2) + pilot (2026-12-08 to 2026-12-31)

Exit: Dec 31: one design partner runs the golden workflow on a live webhook in a deployed install (PGN AWS pilot) and agrees to a paid pilot or LOI.

### NZR-33 Spike: Step Functions vs own DynamoDB engine

```yaml
work_state: approved
cycle: C3
milestone: M3 Live + pilot
priority: Must Have
estimate_points: 3
rigor_tier: T3
deploy_reach: local only
labels: spike, decision
```

- **Story:** [US-033](stories/US-033-spike-step-functions-vs-own-dynamodb-engine.md)
- **Objective:** As Factory operator, I want a written comparison and a decision, so that the live engine is chosen on cost, scale and upkeep.
- **Acceptance criteria:** (1) Decision: an ADR records cost at 1,000 runs/day, failure handling and upkeep. (2) Tie: Jev gives a first-pass pick and the owner decides.
- **Requirement IDs:** FR-009, OBJ-005

**Dependencies.** NZR-31

### NZR-34 Live engine v1 (chosen option)

```yaml
work_state: approved
cycle: C3
milestone: M3 Live + pilot
priority: Must Have
estimate_points: 8
rigor_tier: T3
deploy_reach: local only
labels: workflow
```

- **Story:** [US-034](stories/US-034-live-engine-v1-chosen-option.md)
- **Objective:** As Persona B, business process owner, I want published workflows to run durably with waits, retries and approvals, so that real work gets done reliably.
- **Acceptance criteria:** (1) Runs: it completes, waiting at the approval until the approver releases it. (2) Retry safe: no business write happens twice (AC-026).
- **Requirement IDs:** FR-009, FR-010, FR-022, NFR-008, AC-023, AC-024, AC-025, AC-027

**Dependencies.** NZR-33

### NZR-35 Triggers: webhook + API

```yaml
work_state: approved
cycle: C3
milestone: M3 Live + pilot
priority: Must Have
estimate_points: 5
rigor_tier: T3
deploy_reach: local only
labels: workflow
```

- **Story:** [US-035](stories/US-035-triggers-webhook-api.md)
- **Objective:** As Persona B, business process owner, I want a workflow to start when data arrives at a webhook, so that it works on real incoming documents.
- **Acceptance criteria:** (1) Start: a run starts and the caller gets a run id. (2) Bad request: it is rejected with a clear error and no run starts. (3) Repeat: only one run starts.
- **Requirement IDs:** FR-011, AC-026

**Dependencies.** NZR-34

### NZR-36 Publish / Activate (approval) / Rollback

```yaml
work_state: approved
cycle: C3
milestone: M3 Live + pilot
priority: Must Have
estimate_points: 5
rigor_tier: T3
deploy_reach: local only
labels: workflow
```

- **Story:** [US-036](stories/US-036-publish-activate-approval-rollback.md)
- **Objective:** As Persona B, business process owner, I want to publish a frozen version, get it approved, and roll back in one click, so that changes are safe and reversible.
- **Acceptance criteria:** (1) Activate: live runs use that frozen version. (2) Rollback: version 1 serves the next run.
- **Requirement IDs:** FR-008, FR-010, AC-022

**Dependencies.** NZR-34

### NZR-38 Pilot deploy to PGN AWS account + runbook

```yaml
work_state: approved
cycle: C3
milestone: M3 Live + pilot
priority: Must Have
estimate_points: 5
rigor_tier: T3
deploy_reach: pilot
labels: needs-owner, deploy
```

- **Story:** [US-038](stories/US-038-pilot-deploy-to-pgn-aws-account-runbook.md)
- **Objective:** As Persona E, enterprise administrator, I want Netzar deployed in PGN's AWS account for the pilot, so that the design partner can use it for real.
- **Acceptance criteria:** (1) Deployed: verify is green and the dashboard URL works. (2) Not re-baselined: it stops before deploy with the reason.
- **Requirement IDs:** OBJ-006

**Dependencies.** NZR-42, NZR-35, NZR-36

### NZR-39 Later (stretch): forms/embed triggers

```yaml
work_state: approved
cycle: C3
milestone: M3 Live + pilot
priority: Could Have
estimate_points: 5
rigor_tier: T3
deploy_reach: local only
labels: stretch, cut-1
```

- **Story:** [US-039](stories/US-039-later-stretch-forms-embed-triggers.md)
- **Objective:** As Persona B, business process owner, I want a form to start a workflow, so that people without systems can feed it.
- **Acceptance criteria:** (1) Form: a run starts. (2) Spam: the rate limit rejects the excess.
- **Requirement IDs:** FR-011

**Dependencies.** NZR-35

### NZR-47 Design partner runs the golden workflow live + paid pilot or LOI

```yaml
work_state: approved
cycle: C3
milestone: M3 Live + pilot
priority: Must Have
estimate_points: 2
rigor_tier: N/A
deploy_reach: pilot
labels: needs-owner, business, gate
```

- **Story:** [US-047](stories/US-047-design-partner-runs-the-golden-workflow-live.md)
- **Objective:** As Design partner, I want to run my policy review on Netzar for real, so that I can decide to pay for a pilot.
- **Acceptance criteria:** (1) Live run: the workflow runs and the partner approves the report. (2) No agreement: the reason is recorded and the January plan changes.
- **Requirement IDs:** OBJ-008, OBJ-005

**Dependencies.** NZR-38, NZR-45

## Cycle LATER January 2027 (2027-01-04 to 2027-01-29)

Exit: Paperclip retired.

### NZR-37 Migrate off Paperclip and retire it (moved to January)

```yaml
work_state: approved
cycle: LATER
milestone: M4 Paperclip retired
priority: Should Have
estimate_points: 8
rigor_tier: T3
deploy_reach: local only
labels: migration, cut-2
```

- **Story:** [US-037](stories/US-037-migrate-off-paperclip-and-retire-it-moved.md)
- **Objective:** As Factory operator, I want Paperclip removed once nothing reads it, so that we run one workflow system.
- **Acceptance criteria:** (1) Nothing reads it: only the removal shim remains and all tests pass. (2) Hidden dependency: it stops and the caller is migrated first.
- **Requirement IDs:** FR-030

**Dependencies.** NZR-34
