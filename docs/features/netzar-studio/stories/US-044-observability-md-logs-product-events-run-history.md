# [US-044] OBSERVABILITY.md: logs, product events, run history, alerts

> Backlog task NZR-44 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-014, FR-023. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** one page that lists every log, product event, run record and alert the Studio writes, with the exact fields of each
* **So that** I can see what workflows did, the owner can read the tester and pilot numbers, and no event ever stores personal data in the 7-year audit record

---

## 2. Business Context & Description
* **Background:** Q48 (OBSERVABILITY is a C1 story). Q55: product analytics are named events written to the existing audit log, as a **separate event type** with **no personal data**. CONSTRAINTS C-17 ("no personal data in any product event", measured by this review). FR-014 (users can inspect progress, failures, outcomes); FR-023 (one policy and audit model). The gauntlet PLAN expects `OBSERVABILITY.md` (log format, metrics, SLOs, alerts on symptoms, dashboards).
* **Current behaviour (d1d3a66):**
  - **Audit writer:** `src/lib/audit/audit-writer.ts`. `AuditEvent.action` is a closed string union (`:58-206`, about 140 members); none is a product event or a workflow action. `writeAudit` (`:286`) is fire-and-forget (`:340-341` "Don't await") and drops events when the `audit_log_disabled` kill switch is on, except the `ALWAYS_AUDITED_ACTIONS` set (`:234-278`, "break-glass-proof security events. Keep this list tight"). `writeAuditOrThrow` (`:432-451`) awaits both stores and throws `AuditWriteFailedError` when neither accepted.
  - **Redaction is not an allow-list:** both writers run `redactSync` over top-level string values of `detail` only (`:327-334`, `:437-444`), and only when the PII switch is on (`refreshPiiCache`). Nested objects and non-string values pass unchanged.
  - **Stores:** DynamoDB `TABLE_AUDIT_LOG` with `PK=DAY#<day>`, `SK=<ts>#<id>`, `GSI1PK=AGENT#<agentId|system>` (`:353-366`); S3 Object Lock mirror only when `AUDIT_LOCK_BUCKET` is set (tier ≥ 2, `:23-44`, `:380-390`). WORM retention is 7 years: `infra/lib/storage-stack.ts:302-306` creates the bucket only when `tier >= 2`, Object Lock **governance** mode, 2,555 days (governance mode can be bypassed by a principal with the bypass permission; it is not compliance mode).
  - **Identity in audit rows:** `dashboardIdentity` returns `dashboard:user:<userId>` for a person, else `dashboard:<tokenHash>` (`src/adapters/dashboard/handler.ts:294-303`). That is personal data.
  - **Admin reads:** `GET /api/audit` (`handler.ts:2761-2771`, capability `audit:read`, ≤ 7 days, first 200 rows); `GET /api/audit/export` CSV (`handler.ts:4390-4410`, ≤ 30 days, 10,000 rows, includes a `userId` column).
  - **Other audit-table readers:** `src/lib/aws/cloudtrail-reader.ts:44`, `src/adapters/status/data.ts:35`, `src/lib/security/posture-repo.ts:268`, `handler.ts:5071` (agent health errors).
  - **Logs:** pino JSON to stdout (`src/observability/logger.ts:25-56`); redact paths for authorization/password/token/secret/apiKey and Paperclip keys (`:33-43`); `truncateForLog` cuts user text to 100 chars (`:63-67`).
  - **Metrics:** EMF in namespace `ClaudeClaw` (`src/observability/emf.ts:1-30`, `emitToolMetric`).
  - **Alarms:** `infra/lib/observability-stack.ts` defines ErrorAlarm (`:114`), FatalAlarm (`:124`), BedrockThrottleAlarm (`:135`), BedrockServerErrorAlarm (`:151`), KillSwitchBlockedAlarm (`:177`), AuthFailedAlarm (`:203`), CostSpikeAlarm (`:342`), SchedulerStalledAlarm (`:363`), plus CanaryErrorAlarm, ConnectorCapacityAlarm, PublicEndpointDownAlarm (later in the file).
  - **Planned shapes it must agree with:** DATA-MODEL rows "Product analytics event" (action `product_event`, `userId` and `agentId` omitted, `detail={event, props}`, rejected at write) and "TestRun step result" (`writeAuditOrThrow`, action `workflow_test_step`, IDs and hashes only).
  - **Events already named by stories** (Data & Analytics lines, 23 stories): `journey.golden_completed`, `nav.area_opened`, `nav.admin_opened`, `home.quick_action`, `voice.used`, `agent.page_viewed`, `onboarding.step_completed`, `onboarding.skipped`, `agent.version_published`, `workflow.list_viewed`, `workflow.draft_requested`, `workflow.draft_created`, `workflow.clarify_asked`, `workflow.draft_failed`, `workflow.edit_applied`, `workflow.edit_refused`, `workflow.preview_viewed`, `workflow.test_started`, `workflow.test_completed`, `workflow.test_write_blocked`, `playbook.created`, `playbook.used`, `fact.proposed`, `fact.approved`, `fact.rejected`, `lesson.proposed`, `run.started`, `run.completed`, `run.failed`, `trigger.received`, `trigger.rejected`, `workflow.published`, `workflow.activated`, `workflow.rolled_back`, plus two audit actions written as `security.scope_denied (audit)` and `security.config_denied (audit)`.
* **Target behaviour:** `docs/features/netzar-studio/foundation/OBSERVABILITY.md` exists and says:
  - **Two kinds of record, never mixed.** (1) *Audit actions* (security and state changes): snake_case members of the `AuditEvent.action` union, IDs and hashes only, e.g. `knowledge_scope_denied`, `config_secret_denied`, `workflow_test_step`, `trigger_received`, `trigger_rejected`, `agent_version_published`, `fact_proposed`, `fact_decided`. (2) *Product events*: one new audit action `product_event`; the event name lives in `detail.event`. Story names like `security.scope_denied (audit)` map to audit actions, not product events (mapping table in the doc).
  - **Event catalogue:** one row per product event: name (regex `^[a-z]+\.[a-z_]+$`), emitting story, trigger point (route or component), allowed `props` keys with type (`enum[...]`, `int`, `bool`, `id:<kind>`), and a "no personal data" tick with the reason.
  - **Forbidden in product events:** `userId`, `operatorHint`, `operatorLabel`, `chatId`, email, phone, names, free text, prompt or document text, file names, IP, user agent. Top-level `userId` and `agentId` are omitted (so `GSI1PK=AGENT#system`). Allowed id kinds: `workflowId`, `draftRev`, `runId`, `stepType`, `agentId` (config name, inside `props`), `journeyRef` (random UUID made per journey in the browser, never derived from a user or token).
  - **Writer contract (allow-list at write time):** `recordProductEvent(name, props)` in `src/lib/analytics/events.ts` validates against a strict per-event schema *before* calling the audit writer; an unknown event name or key, or a value of the wrong type, writes nothing, logs `product_event_rejected` with the event name only, and emits EMF metric `ProductEventRejected`. No later redaction is relied on. TypeScript types make the event name a union so most mistakes fail `npm run typecheck`.
  - **Durability rule:** product events use `writeAudit` (fire-and-forget, counts are lower bounds when `audit_log_disabled` is on) and are **not** added to `ALWAYS_AUDITED_ACTIONS`; test-run evidence (`workflow_test_step`) and security denials use `writeAuditOrThrow`.
  - **Run history:** where test runs and (C3) live runs are recorded (studio table `TEST#<runId>` + `#STEP#<nn>` rows, DATA-MODEL; audit `workflow_test_step`), how an admin reads them (target route owned by NZR-26/NZR-34; today only `GET /api/audit`), retention (TestRun TTL 180 days proposal; audit DDB forever; WORM 7 years at tier ≥ 2; no WORM at tier < 2).
  - **Logs, metrics, alerts:** the existing log rules and the 11 alarms above, plus new Studio alerts with numbers: drafter failure (`workflow.draft_failed` / `workflow.draft_requested` > 20% over 1 h, min 5 requests), test-run error (> 10% over 1 h), `ProductEventRejected` > 0 in 24 h, `workflow_test_step` audit write failure ≥ 1, C3: `trigger_rejected` > 50 in 5 min per trigger. Each names its metric source and where it is built (story ID).
  - **Owner numbers:** how to compute the tester and pilot numbers from events only: golden completions (`journey.golden_completed`), testers finishing unaided (`journey.golden_completed` with `props.helpUsed=false`, round-5 "finished without Help", PENDING OWNER Q96-Q110 wording), drafts per completion, external writes during tests (`workflow.test_write_blocked` count; must stay 0 actual writes), cost per draft (ledger, not events).
* **Out of scope:** writing `src/lib/analytics/events.ts` or any code (no story owns it yet; proposal in NOTES: the first emitting story, NZR-49); dashboards UI; CloudWatch alarm code (each alert row names its building story); exporting product events out of the customer account (DATA-MODEL section 5: needs its own ADR).
* **Target Value:** 100% of event names in story Data & Analytics lines (36 today) appear in the catalogue with fields; 0 catalogue props on the forbidden list.
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). Reads the Audit tab and exports CSVs; must answer "what did this workflow do, and when" without reading code. PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Every story event is catalogued
* **Given** the backticked event names in every `stories/US-*.md` line starting `* **Data & Analytics:**`
* **When** the `CATALOGUE` command (Test plan) compares them with the catalogue table in `OBSERVABILITY.md`
* **Then** it prints `missing: []`; every row has a non-empty props column and a "no personal data" cell
* **Test:** critic command `CATALOGUE` › "every story event has a catalogue row"

### Scenario 2: No personal data in any event definition
* **Given** the catalogue props columns
* **When** `FORBIDDEN` greps them for `userId|email|phone|name|chatId|text|prompt|fileName|ip|userAgent|operatorHint|operatorLabel`
* **Then** it finds 0 matches outside the "Forbidden" list itself; an event that needs a person reference uses `journeyRef` (random) and the doc says why
* **Test:** critic command `FORBIDDEN` › "0 forbidden keys in props"

### Scenario 3: Allow-list enforced when the event is written
* **Given** the "Writer contract" section
* **When** the critic reads it
* **Then** it names `src/lib/analytics/events.ts` › `recordProductEvent`, states validation happens before `writeAudit` is called, states that unknown names/keys/types write nothing and emit `ProductEventRejected`, states redaction (`audit-writer.ts:327-334`) is not relied on, and lists these frozen tests for the builder: `src/lib/analytics/events.test.ts` › "writes product_event with no userId and no agentId", "rejects an unknown event name and writes nothing", "rejects a props key not on the allow-list and writes nothing", "rejects a string where an enum is required", "never adds product_event to ALWAYS_AUDITED_ACTIONS"
* **Test:** critic command `grep -c 'events.test.ts' docs/features/netzar-studio/foundation/OBSERVABILITY.md` › "≥ 1, and 5 test names present"

### Scenario 4: Separate audit event type
* **Given** the doc's "Audit actions" section
* **When** the critic compares it with `src/lib/audit/audit-writer.ts:58-206`
* **Then** the doc lists every new action it needs (`product_event`, `workflow_test_step`, `knowledge_scope_denied`, `trigger_received`, `trigger_rejected`, …) as additive union members, marks which use `writeAuditOrThrow`, and the mapping table turns each `security.* (audit)` story name into one of them
* **Test:** critic command `grep -n 'product_event' docs/features/netzar-studio/foundation/OBSERVABILITY.md` › "union + writer + mapping rows present"

### Scenario 5: Alerts are numbers, not adjectives
* **Given** the "Alerts" table
* **When** the critic reads each row
* **Then** each has a metric source, a threshold with a number and a window, the action to take, and the story that builds it; the 11 existing alarms are listed with `infra/lib/observability-stack.ts` line numbers
* **Test:** critic command `ALERTS` › "every row has digits in the threshold cell"

### Scenario 6: Degraded audit is stated honestly
* **Given** the "Durability" section
* **When** the critic reads it
* **Then** it states: product event counts are lower bounds when `audit_log_disabled` is on (`audit-writer.ts:289-313`); tier < 2 has no WORM copy (`:23-44`); a failed `workflow_test_step` write fails the test run (`AuditWriteFailedError`, `:410-415`)
* **Test:** critic command `grep -n 'audit_log_disabled\|tier < 2\|AuditWriteFailedError' docs/features/netzar-studio/foundation/OBSERVABILITY.md` › "3 matches"

### Scenario 7: Docs CI green
* **Given** the branch HEAD with the new file
* **When** `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/docs-links.mjs` run
* **Then** both exit 0; the file has the five frontmatter keys with `status: current`
* **Test:** existing Docs CI jobs

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-9 / US-009](US-009-foundation-plan-docs-user-stories-this-docs.md) Foundation PLAN docs + user stories (this docs PR)
* **UI/UX Design:** N/A: documentation.
* **Non-Functional Requirements:** Events: separate audit event type, no personal data (Q55, C-17). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only. (This story defines the catalogue the others use.)
* **Steps:**
  1. Builder (docs lane): collect event names with the `CATALOGUE` extractor; run it against an empty catalogue (red).
  2. Builder: write `OBSERVABILITY.md` sections in this order: 1 Purpose; 2 Two kinds of record; 3 Audit actions (additive union members, writer per action); 4 Product events: naming, forbidden keys, allowed id kinds, writer contract, frozen tests; 5 Event catalogue; 6 Run history and retention; 7 Logs; 8 Metrics; 9 Alerts; 10 Owner numbers (queries); 11 Durability and degraded modes; 12 Open items.
  3. Builder: link it from `docs/features/netzar-studio/README.md` section 4 (Source of truth) and from `foundation/DATA-MODEL.md` row "Product analytics event".
  4. Builder: run the critic commands and Docs CI (green); session handoff.
  5. Fresh critic re-runs the commands (T1: free checks only).
* **Artifacts:** `docs/features/netzar-studio/foundation/OBSERVABILITY.md` (new; frontmatter `feature: netzar-studio`, `document_role: decision`, `status: current`, `observed_at`, `as_of_commit`); one-line link edits in the feature `README.md` and `foundation/DATA-MODEL.md`.
* **Evidence:** red then green `CATALOGUE` output; `FORBIDDEN` output; Docs CI output; HEAD SHA.
* **Security notes:** WORM rows cannot be deleted for 7 years (DATA-MODEL risk 6), so a mistake in an event definition is permanent; that is why the allow-list is checked at write time. `operatorHint` is untrusted (`audit-writer.ts:221-222`). Do not put any example containing a real name or email in the doc; use `journeyRef: 3f6c…` style placeholders. SECURITY.md 2b T5 already names `trigger_received`/`trigger_rejected` with "a hash of the body, never the body"; copy that rule.
* **Test plan:** docs only; no vitest in this story. Commands:
  - `CATALOGUE`: read-only one-off (Node or Python) that pulls backticked tokens from lines starting `* **Data & Analytics:**` in `docs/features/netzar-studio/stories/US-*.md`, drops the `(audit)` suffix, and lists names missing from the first column of the catalogue table. Paste it into the session handoff.
  - `FORBIDDEN`: `awk '/^## 5/,/^## 6/' docs/features/netzar-studio/foundation/OBSERVABILITY.md | grep -niE 'userId|email|phone|chatId|prompt|fileName|userAgent|operatorHint|operatorLabel'` → no output.
  - `ALERTS`: `awk '/^## 9/,/^## 10/' …/OBSERVABILITY.md | grep '^|' | grep -vE '[0-9]'` → only the header and separator rows.
  - Docs CI: `node scripts/ci/feature-knowledge.mjs && node scripts/ci/docs-links.mjs && node scripts/ci/runnable-blocks.mjs`.
* **Repo rules that apply:** `docs/features/README.md` (frontmatter, status vocabulary, no sprawl: link from the README's source-of-truth table); ADR 0020 (WORM audit, IDs and hashes only); `writeAuditOrThrow` vs `writeAudit` (`audit-writer.ts:417-431` says when each is used); never repurpose an action string (additive only).
* **Rollback:** revert the docs commit.
* **Build slices (proposal):**
  1. Extractor red + sections 1-5 (record kinds, audit actions, product events, catalogue) → Scenarios 1-4.
  2. Sections 6-12 (run history, logs, metrics, alerts, owner numbers, durability) + links → Scenarios 5-7.
* **Agent gotchas:**
  - Story event names come from 23 files and other groups are rewriting stories now; re-run `CATALOGUE` on the final story set before merge.
  - `writeAudit` redaction looks like a privacy control but only touches top-level strings and only when a switch is on; do not cite it as protection.
  - ARCHITECTURE section 4 ("Slice rules") says analytics events use a new **always-audited** action. This story recommends the opposite for product events (the always-audited set is for break-glass security events, `audit-writer.ts:227-233`). Record the choice in section 12 "Open items" and in NOTES; the owner decides.
  - `GET /api/audit/export` adds a `userId` column for every row; product events leave it empty by design.
  - Do not invent CloudWatch metric names that exist already; check `observability-stack.ts` first (namespace `ClaudeClaw`).

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T1 · **Deploy reach:** local only · **Labels:** docs, ops

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases (catalogue complete, no PII, write-time allow-list, separate type, numeric alerts, degraded audit, CI).
- [ ] UX/UI designs: N/A: documentation.
- [ ] Dependencies have been identified and are unblocked (NZR-9; final story set merged so `CATALOGUE` runs on it).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Docs follow docs/features/README.md; no file under src/, web/ or infra/.
- [ ] Peer code review is completed and approved. Free checks only (Q68): docs CI, secret scan on the diff.
- [ ] Docs CI green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`; `CATALOGUE` prints `missing: []`; `FORBIDDEN` prints nothing.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary and decides the always-audited question.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; README source-of-truth row links OBSERVABILITY.md.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: N/A: docs only.
