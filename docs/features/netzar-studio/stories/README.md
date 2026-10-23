# Netzar Studio user stories

Every Gauntlet step in the [backlog](../backlog.md) has one user story here, written to the owner's template
(statement, business context, Given/When/Then acceptance criteria, technical notes, estimation, DoR, DoD).
[US-000](US-000-netzar-studio-rebuild.md) is the plan-level story for the whole rebuild.

## Rules (owner grill Q46 to Q80)

- **Levels.** Plan story US-000; one step story per backlog item (`US-n` = `NZR-n` = Plane sequence id). A step is one gauntlet build session. Task stories (build slices, about 120 in total) are written at each step's PLANNING checkpoint, before code, because they change once the tests are frozen (Q70).
- **Generated.** Backlog and step stories come from one task list (kept outside the repo by the planning session). Edit the list and regenerate; never hand-edit one side only. Plane mirrors this folder only after the owner says yes (Q53).
- **Points.** 1 point is about 1 hour of factory work, rounded to 1/2/3/5/8/13 (Q47).
- **N/A lines.** A template line that doesn't apply says `N/A:` with the reason (designs on an ADR, deploy before the AWS account exists) (Q70).
- **Personas.** A first-time AI user, B business process owner, E enterprise administrator (PRD 1.3), O factory operator, P design partner (Q54). C and D wait until 2027.
- **Review per tier (Q68).** T3 (schema, versions, security, engine, ADRs): full layers + one Greptile pass. T2 (UI and features): fresh critic + free checks + step maid. T1 and docs: free checks. Codex reviews only code someone else built (Q51).
- **Done (Q50).** Merged to `development` with the owner's yes and verified locally; staging is PENDING until the AWS account (NZR-42) exists. Every merge or push needs the owner's yes.
- **Analytics (Q55).** Named product events in the existing audit log, separate event type, no personal data.
- **Designs (Q49, Q77).** Full MOCK set (phone + desktop, light) for the Workflows slice; every other screen is an inventory row marked NO-MOCK-YET with a due date in [design.md](../foundation/design.md).

## Index

| Story | Cycle | Pts | Tier | Priority | Persona | Requirement IDs |
|---|---|---|---|---|---|---|
| [US-000](US-000-netzar-studio-rebuild.md) Netzar Studio rebuild (plan) | all | 205 | T3 | Must Have | A, B, E, P | OBJ-001, OBJ-005, OBJ-006, OBJ-008 |
| [US-003](US-003-clean-clone-builder-workspace-on-the-vps.md) Clean-clone builder workspace on the VPS (no .env, lockfile installs) | C0 | 3 | T2 | Must Have | O | OBJ-006, NFR-007 |
| [US-005](US-005-fix-vectors-scope-leak-knowledge-routes-enforce.md) Fix /vectors scope leak: knowledge routes enforce agent scope | C0 | 5 | T3 | Must Have | E | FR-012, FR-029, NFR-007, NFR-010 |
| [US-006](US-006-chat-dropped-files-private-to-the-uploading.md) Chat-dropped files private to the uploading chat | C0 | 5 | T3 | Must Have | E | FR-012, FR-029, NFR-010 |
| [US-009](US-009-foundation-plan-docs-user-stories-this-docs.md) Foundation PLAN docs + user stories (this docs PR) | C0 | 8 | T1 | Must Have | O | OBJ-001, OBJ-007 |
| [US-040](US-040-gauntlet-model-routing-on-the-vps-codex.md) Gauntlet model routing on the VPS: Codex builds, fresh Claude critic, NVIDIA roles after bake-off | C0 | 5 | T2 | Must Have | O | NFR-009 |
| [US-041](US-041-review-gauntlet-v2-wiring-q68-tier-policy.md) Review gauntlet v2 wiring: Q68 tier policy + Kodus/CodeRabbit on the VPS | C0 | 3 | T2 | Should Have | O | NFR-007 |
| [US-042](US-042-open-pgn-aws-account-request-bedrock-model.md) Open PGN AWS account + request Bedrock model access (owner, drop-dead Nov 9) | C0 | 1 | N/A | Must Have | O | OBJ-006 |
| [US-043](US-043-fix-api-config-secret-exposure-category-allowlist.md) Fix /api/config secret exposure: category allowlist, server-side deny, masking | C0 | 5 | T3 | Must Have | E | NFR-007, FR-015 |
| [US-007](US-007-adrs-supersede-0012-0017-d21-amend-do.md) ADRs: supersede 0012 + 0017 d21, amend do-not-build #1 | C1 | 3 | T3 | Must Have | O | FR-030, OBJ-007 |
| [US-008](US-008-adrs-workflows-as-data-eval-flywheel-knowledge.md) ADRs: workflows-as-data, eval flywheel, knowledge layers, agent runtime, pilot hosting, mock policy | C1 | 5 | T3 | Must Have | O | OBJ-004, OBJ-006, FR-012, FR-027 |
| [US-010](US-010-local-model-env-floci-nvidia-dev-backend.md) Local model env: Floci + NVIDIA dev backend (test data only) | C1 | 5 | T2 | Must Have | O | NFR-009 |
| [US-011](US-011-recorded-reply-harness-for-model-calls-in.md) Recorded-reply harness for model calls in tests | C1 | 3 | T2 | Should Have | O | FR-027 |
| [US-012](US-012-workflow-definition-schema-validator.md) Workflow definition schema + validator | C1 | 5 | T3 | Must Have | B | FR-001, FR-004, FR-008, AC-002, AC-020, AC-021 |
| [US-013](US-013-trigger-contract-design-webhook-api-form-embed.md) Trigger contract design (webhook/api/form/embed/integration/schedule) | C1 | 2 | T3 | Should Have | B | FR-011, AC-026 |
| [US-014](US-014-drafter-eval-set-30-cases-scorer-live.md) Drafter eval set (30 cases) + scorer + live baseline | C1 | 5 | T2 | Must Have | B | FR-001, FR-027, NFR-003 |
| [US-044](US-044-observability-md-logs-product-events-run-history.md) OBSERVABILITY.md: logs, product events, run history, alerts | C1 | 3 | T1 | Should Have | E | FR-014, FR-023 |
| [US-045](US-045-test-strategy-md-pyramid-replay-vs-live.md) TEST-STRATEGY.md: pyramid, replay vs live eval, e2e journeys | C1 | 3 | T1 | Should Have | O | FR-027, NFR-005 |
| [US-046](US-046-business-brief-icp-single-pain-price-hypothesis.md) Business brief: ICP, single pain, price hypothesis, 2 partner calls | C1 | 2 | N/A | Must Have | P | OBJ-008 |
| [US-047](US-047-book-5-testers-friendly-dry-run-synthetic.md) Book 5 testers + friendly dry-run (synthetic documents) | C1 | 1 | N/A | Must Have | A | OBJ-001 |
| [US-023](US-023-workflow-drafter-describe-draft-or-clarifying-question.md) Workflow drafter: describe -> draft or clarifying question | C2a | 8 | T2 | Must Have | A | FR-001, FR-002, AC-002, AC-003, AC-004, AC-010, NFR-002, NFR-003 |
| [US-024](US-024-edit-by-chat-on-drafts.md) Edit-by-chat on drafts | C2a | 5 | T2 | Must Have | A | FR-020, AC-007, AC-020 |
| [US-025](US-025-plain-language-preview-numbered-steps-no-canvas.md) Plain-language preview (numbered steps, no canvas) + agent picker | C2a | 5 | T2 | Must Have | A | FR-004, AC-003, AC-006 |
| [US-026](US-026-sample-data-test-runner-sealed-sandbox-ready.md) Sample-data test runner (sealed sandbox) + Ready flag | C2a | 8 | T3 | Must Have | A | FR-005, AC-005, FR-014, NFR-008 |
| [US-030](US-030-live-eval-gate-per-drafter-change-nightly.md) Live eval gate: per drafter change + nightly, hash-checked in CI | C2a | 3 | T2 | Must Have | O | FR-027 |
| [US-031](US-031-golden-workflow-end-to-end-insurance-policy.md) Golden workflow end to end: insurance policy review | C2a | 3 | T2 | Must Have | B | AC-001, AC-002, AC-003, AC-004, AC-005, AC-006, AC-007 |
| [US-049](US-049-plain-workflows-tab-list-new-open-draft.md) Plain Workflows tab: list, new, open draft | C2a | 3 | T2 | Must Have | A | AC-001, FR-001 |
| [US-015](US-015-workspace-shell-home-agents-workflows-my-work.md) Workspace shell: Home, Agents, Workflows, My Work, Library | C2b | 8 | T2 | Must Have | A | OBJ-001, AC-001, NFR-001, NFR-005 |
| [US-016](US-016-admin-console-6-sections-holding-today-s.md) Admin console: 6 sections holding today's admin screens | C2b | 5 | T2 | Must Have | E | FR-015, FR-013, OBJ-007 |
| [US-017](US-017-home-animated-chat-hero-tailwind-css-port.md) Home: animated chat hero (Tailwind/CSS port) + quick actions | C2b | 5 | T2 | Should Have | A | NFR-001, NFR-002, AC-001 |
| [US-018](US-018-jarvis-mic-button-on-home-and-chat.md) Jarvis: mic button on Home and chat; orb page to Developer tools | C2b | 3 | T2 | Could Have | A | NFR-005 |
| [US-019](US-019-agent-page-about-knowledge-test-channels-advanced.md) Agent page: About / Knowledge / Test / Channels (+ Advanced) | C2b | 5 | T2 | Should Have | B | AC-009, AC-011, AC-004 |
| [US-020](US-020-readability-18px-workspace-scale-44px-targets-axe.md) Readability: 18px Workspace scale, 44px targets, axe in CI | C2b | 5 | T2 | Must Have | A | NFR-005 |
| [US-021](US-021-first-run-3-step-welcome.md) First-run 3-step welcome | C2b | 3 | T2 | Should Have | A | OBJ-001 |
| [US-022](US-022-immutable-agent-versions-pin-by-version-id.md) Immutable agent versions (pin by version id) | C2b | 5 | T3 | Must Have | B | AC-012, AC-022, FR-008 |
| [US-027](US-027-library-playbooks-store.md) Library: Playbooks store | C2b | 5 | T2 | Should Have | B | FR-019, FR-012 |
| [US-028](US-028-hive-mind-company-facts-with-admin-approval.md) Hive Mind -> Company facts with admin approval queue | C2b | 5 | T3 | Should Have | E | FR-012, FR-023 |
| [US-029](US-029-lessons-from-corrections-proposed-knowledge.md) Lessons from corrections -> proposed knowledge | C2b | 3 | T2 | Could Have | B | FR-027 |
| [US-032](US-032-real-tester-sessions-5-non-technical-people.md) Real tester sessions (5 non-technical people) | C2b | 5 | N/A | Must Have | A | OBJ-001, AC-001, AC-002, AC-005 |
| [US-033](US-033-spike-step-functions-vs-own-dynamodb-engine.md) Spike: Step Functions vs own DynamoDB engine | C3 | 3 | T3 | Must Have | O | FR-009, OBJ-005 |
| [US-034](US-034-live-engine-v1-chosen-option.md) Live engine v1 (chosen option) | C3 | 8 | T3 | Must Have | B | FR-009, FR-010, FR-022, NFR-008, AC-023, AC-024, AC-025, AC-027 |
| [US-035](US-035-triggers-webhook-api.md) Triggers: webhook + API | C3 | 5 | T3 | Must Have | B | FR-011, AC-026 |
| [US-036](US-036-publish-activate-approval-rollback.md) Publish / Activate (approval) / Rollback | C3 | 5 | T3 | Must Have | B | FR-008, FR-010, AC-022 |
| [US-038](US-038-pilot-deploy-to-pgn-aws-account-runbook.md) Pilot deploy to PGN AWS account + runbook | C3 | 5 | T3 | Must Have | E | OBJ-006 |
| [US-039](US-039-later-stretch-forms-embed-triggers.md) Later (stretch): forms/embed triggers | C3 | 5 | T3 | Could Have | B | FR-011 |
| [US-048](US-048-design-partner-runs-the-golden-workflow-live.md) Design partner runs the golden workflow live + paid pilot or LOI | C3 | 2 | N/A | Must Have | P | OBJ-008, OBJ-005 |
| [US-037](US-037-migrate-off-paperclip-and-retire-it-moved.md) Migrate off Paperclip and retire it (moved to January) | LATER | 8 | T3 | Should Have | O | FR-030 |

Parked (Q59, engdept parked): NZR-1, NZR-2, NZR-4. No story.

## Requirements traceability

Every story cites PRD IDs ([PRD](../foundation/PRD.md)). These PRD IDs are deliberately not covered by this rebuild:

| PRD IDs | Why not now |
|---|---|
| FR-003, FR-018, AC-013 to AC-017, OBJ-002 (teams part) | AI teams: out until 2027 (blueprint v1, Q1/Q16). |
| FR-006, FR-007, NFR-004, NFR-006, AC-018, AC-019, OBJ-003 | Visual canvas and Developer Studio (other creation modes): out until 2027. The schema (NZR-12) keeps one definition so they can be added later. |
| FR-017, AC-008 | Conversational agent creation (Journey B): out of MVP; existing agent setup stays. |
| FR-016 | Customer-registered custom actions: out until 2027. |
| FR-021 | Outcome verification after execution: after the live engine (January or later). |
| FR-024 | Labels for governance Netzar can observe but not enforce: belongs with integrations, 2027. |
| FR-025, FR-026 | Automation discovery: out until 2027. |
| FR-028 | Industry outcome packs: out until 2027. |
