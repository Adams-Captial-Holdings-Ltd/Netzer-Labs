# [US-034] Live engine v1 (chosen option)

> Backlog task NZR-34 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-009, FR-010, FR-022, NFR-008, AC-023, AC-024, AC-025, AC-027.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** an active, published workflow to run on its own from start to finish, pausing at each approval until the named approver releases it, and retrying safely when something fails
* **So that** real work gets done reliably, with zero duplicate business writes in fault tests (NFR-008) and every action traceable afterwards (AC-027)

---

## 2. Business Context & Description
* **Background:**
  - Built per the NZR-33 ADR (`docs/adr/<n>-live-workflow-engine.md`, status `accepted`). This story is written for the **recommended default, our own engine on DynamoDB**; where Step Functions would change a slice, it says so under "If the ADR picks Step Functions".
  - Blueprint journey 6: publish → approver activates → partner's system posts to the webhook → run waits for approval → report delivered. This story is the "run" part. Triggers are NZR-35; publish/activate is NZR-36.
  - DATA-MODEL risk 8: one authority per run entity. The studio table (NZR-12) holds definitions and versions only, never execution state.
  - ARCHITECTURE R12: run state lives in DynamoDB, never in process memory; use the lease pattern of `src/lib/state/runner-lease.ts`.
  - PENDING OWNER Q95: recommended answer "the validator requires an approval step before any external write". The engine enforces the same rule at run time (defence in depth). If the owner says no, Scenario 5 changes to "a write without an approval step runs only when its decision class is `automated_allowed`" (the existing rule in `src/lib/work/approvals.ts:187-192` `requiresHumanApproval`).
* **Current behaviour (d1d3a66):**
  - Nothing runs a workflow definition. `src/lib/workflows/` does not exist yet (NZR-12 creates it).
  - Effect executor exists and is the duplicate-write guard: `src/lib/work/executor.ts:65` `createExecutor`, `runEffect` (:107-132), `applyFromRow` (:134-171), `resolve` (:173-184); production wiring `defaultExecutor()` (:208-211) uses `writeAuditOrThrow` and `PENDING_SETTLE_MS = 270_000` (:50). Rows in table `effect-ledger` (`src/lib/work/effect-rows-dynamo.ts:6`).
  - It is coupled to Paperclip in two places: `executor.ts:4` imports `isDispatchDraining` from `src/lib/paperclip/dispatch-drain.ts`; approvals use Paperclip as the port and shadow users as approvers (`src/lib/work/approvals.ts:3,110-184`, `approvals-paperclip.ts`).
  - Leases: `tryAcquireRunnerLease` (`runner-lease.ts:54-88`) fails **open** on a store error; `tryClaimOnce` (:113-140) also fails open. Both are right for monitoring, wrong for a step owner.
  - Agent turns: `runAgentTurn` (`src/agent/agent-loop.ts:762`) with `toolPolicy: { aiStep: true }` (`AgentTurnRequest` :210-217) filters tools to read-only built-ins (:1091-1099). It does not persist turns itself; the caller decides (`appendTurns` lives in `src/lib/state/sessions-repo.ts`). `loadAgent(agentId)` has no version argument yet (`src/lib/config/agent-loader.ts:248`); NZR-22 adds pinned loads.
  - Audit actions that already exist and are always audited: `effect_applied`, `effect_unknown`, `effect_resolved`, `approval_requested`, `approval_decided`, `approval_refused` (`src/lib/audit/audit-writer.ts:198-203`, set at :234-240).
  - In-process workers start in `src/index.ts:91-118` (queue drain, scheduler, canary, Paperclip reconciler, pending-dispatch sweep).
* **Target behaviour:**
  - `startRun()` creates a run for an **activated, frozen** workflow version and returns a `runId`. It is the one entry point NZR-35 calls.
  - Steps run in order: agent step (one `runAgentTurn`, AI write-deny, pinned agent version), decision, approval (durable wait), output/deliver (the only external write, always through `runEffect`).
  - An approval wait survives restarts and deploys of the single T0 task; the approver sees the exact frozen payload and its hash (AC-023, AC-024); only a listed approver can release it (AC-025).
  - A crash, retry or second worker never produces a second business write (NFR-008, AC-026, PR-AC-002). An uncertain write stops the run in `needs_attention`; a human resolves it.
  - Every state change writes a run event row and an always-audited audit row with ids and hashes only (AC-027, ADR 0020).
  - A kill switch `workflow_runs_disabled` stops new step work within one sweep interval.
* **Out of scope:**
  - Webhook/API entry and caller auth (NZR-35). Publish, activate, rollback and the "which version is active" pointer (NZR-36). Forms (NZR-39).
  - The approver screen and run history UI. UNVERIFIED owner: design.md has no inventory row for "run detail / approve" (W-020 My Work is a placeholder, `foundation/design.md:185`). See NOTES; this story ships the API only.
  - Missions on the new engine (NZR-37, January; PENDING OWNER Q94).
  - Removing the Paperclip approval path (`approvals-paperclip.ts` stays for Paperclip; NZR-37).
* **Target Value:** golden workflow (NZR-31 definition) completes end to end on LocalStack with the approval wait; 0 duplicate external writes across the fault suite (Scenarios 2–4), measured as the count of `apply()` calls on the deliver connector spy.
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Runs to the approval, then completes
* **Given** an activated golden-workflow version `VER#000001` (fixture) and a synthetic policy document
* **When** `startRun({ workflowId, input, trigger: { kind: 'test' }, idempotencyKey: 'k1' })` is called
* **Then** it returns `{ runId, status: 'queued' }`; the run reaches `waiting_approval` with an `APPROVAL#<stepId>` row holding `payloadSha256`; an audit row `approval_requested` exists; after `POST /api/runs/:runId/approvals/:stepId` with `{ decision: 'approve', payloadSha256 }` by a listed approver → `200 { runId, status: 'running' }`, then the run ends `succeeded` with exactly one `effect_applied` audit row for the deliver step
* **Test:** `src/lib/engine/engine.golden.integration.test.ts` › "golden workflow waits at approval and completes once approved"

### Scenario 2: Retry after an uncertain write never writes twice
* **Given** a run at the deliver step whose connector `apply()` throws a non-`notSent` error (outcome unknown)
* **When** the worker retries the step
* **Then** the effect row is `unknown`, the run status is `needs_attention`, the connector spy saw exactly 1 `apply()` call, an audit row `effect_unknown` exists, and no further `apply()` happens until `resolve(key, 'not_applied', by)` is called; after that, one retry applies and the spy shows 2 calls total with exactly one success
* **Test:** `src/lib/engine/run-worker.test.ts` › "uncertain deliver stops in needs_attention and is not repeated"

### Scenario 3: Two workers, one step
* **Given** two worker instances (two `holderId`s) racing for the same queued run
* **When** both try to claim it
* **Then** exactly one claim succeeds (conditional write), the loser makes no step write (its writes fail on the fencing condition), and the connector spy shows 1 `apply()` call
* **Test:** `src/lib/engine/run-lease.test.ts` › "only the lease holder can write step state"

### Scenario 4: Restart during the approval wait
* **Given** a run in `waiting_approval` and the worker process restarted (all in-memory state dropped)
* **When** the approver approves 3 days later (clock injected)
* **Then** the sweeper resumes the run from DynamoDB, the deliver payload hash equals the `payloadSha256` frozen at request time, and the run ends `succeeded` (PR-AC-003)
* **Test:** `src/lib/engine/run-worker.test.ts` › "approval after restart resumes the exact frozen payload"

### Scenario 5: Wrong approver, stale payload, missing approval
* **Given** a run in `waiting_approval`
* **When** (a) a principal not in the step's approver list approves; (b) a listed approver sends a `payloadSha256` that differs from the frozen one; (c) a definition has a deliver step with no approval step before it (PENDING OWNER Q95)
* **Then** (a) `403 { error: 'not_an_approver' }` and audit `approval_refused` with `code: 'not_an_approver'`; (b) `409 { error: 'payload_changed' }` and audit `approval_refused` with `code: 'hash_mismatch'`; (c) `startRun` throws `RunRefusedError('approval_required_before_write')`, no run row is written; the run state in (a) and (b) stays `waiting_approval`
* **Test:** `src/adapters/dashboard/runs.test.ts` › "refuses an approver who is not listed", "refuses a stale payload hash"; `src/lib/engine/start-run.test.ts` › "refuses a version with a write before any approval"

### Scenario 6: AI step stays write-deny and private
* **Given** the agent step's pinned agent has an MCP tool and `send_email` in its `agent.yaml`
* **When** the step runs
* **Then** `runAgentTurn` is called with `toolPolicy: { aiStep: true }`, `chatId` = `run:<runId>:<stepId>`, the pinned `agentVersionId`; `appendTurns` is never called; the remote tool and `send_email` are not offered; the step result stores `outputHash` and a ≤ 4 KB summary, not the full transcript
* **Test:** `src/lib/engine/step-runners.test.ts` › "agent step runs write-deny on a synthetic chat and never persists turns"

### Scenario 7: Model error, timeout and kill switch (degraded mode)
* **Given** (a) `runAgentTurn` throws a model error twice then succeeds; (b) it times out 3 times; (c) kill switch `workflow_runs_disabled` is active
* **When** the worker runs the step
* **Then** (a) the step succeeds on attempt 3 with 2 `step_retry` events; (b) the run ends `failed` with `failure: { stepId, code: 'model_timeout' }` and audit `run_failed`, later steps are `skipped`; (c) no step starts, the run stays `queued` with event `paused_by_kill_switch`, and it resumes when the switch clears
* **Test:** `src/lib/engine/run-worker.test.ts` › "retries a model error twice then succeeds", "fails safely after 3 timeouts", "kill switch pauses new step work"

### Scenario 8: Duplicate start with the same idempotency key
* **Given** `startRun` called twice with the same `(workflowId, idempotencyKey)` within 24 h
* **When** both calls complete (sequentially and concurrently)
* **Then** both return the same `runId`, only one run META row exists, and the second result has `deduped: true`
* **Test:** `src/lib/engine/start-run.test.ts` › "same idempotency key returns the same run"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-33 / US-033](US-033-spike-step-functions-vs-own-dynamodb-engine.md) Spike: Step Functions vs own DynamoDB engine
* **Builds on (other merged work; formal dependency changes are proposed in NOTES-H-live-deploy.md, not made here):** (ADR `accepted`). Also needs merged: NZR-12 schema (`src/lib/workflows/schema.ts`), NZR-22 pinned agent loads (`loadAgent(id, { versionId })`), NZR-31 golden definition fixture. NZR-36 supplies the real "active version" pointer; until then tests use a fixture `VER#` row.
* **UI/UX Design:** N/A: engine and API only. Run history and the approver screen have no design row yet (see Out of scope and NOTES).
* **Non-Functional Requirements:** NFR-008 zero duplicate writes; ≤ 1,000 runs/day (C-50); a sweep finds due work within 30 s; T0 single task must survive restarts; tier ≥ 1 (2–4 tasks) must be correct (R12). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `run.started`, `run.completed`, `run.failed`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Props allow-list: `{ workflowId, versionSeq, stepCount, durationMs, failureCode }`; no user id, no document text.

**Files to change**
| path | change |
|---|---|
| `src/lib/work/executor.ts:4,65-66,208-211` | Make the drain signal injectable: `defaultExecutor()` keeps `isDispatchDraining`; add `engineExecutor()` that passes the engine's own draining flag. No behaviour change for Paperclip callers. |
| `src/lib/audit/audit-writer.ts:57-206` (union) and `:234-260` (`ALWAYS_AUDITED_ACTIONS`) | Add `run_started`, `run_step_started`, `run_step_completed`, `run_failed`, `run_completed`, `run_needs_attention`, `run_resolved` as always-audited. Reuse existing `approval_*` and `effect_*`. |
| `src/lib/state/kill-switches-repo.ts:50-109` (union), `:111` (`ALL_KILL_SWITCHES`), `:274` (`KILL_SWITCH_META`) | Add `workflow_runs_disabled` (category `Workflows`). |
| `src/lib/auth/permissions.ts:88-136` (`CAPABILITIES`), `:195-240` (profiles) | Add `runs:read` (viewer tier) and `runs:approve` (operator tier and up). Additive only (`permissions.ts:84-86` rule). |
| `src/lib/jarvis/route-manifest.test.ts:165` (`CAPABILITY_MIN_ROLE`) | Add `runs:read: 'viewer'`, `runs:approve: 'operator'` so the drift test does not silently treat them as viewer (design.md O-9). |
| `src/server.ts:92-133` (beside the other `/api/<name>` routers, before the `/api` catch-all at `:146`) | Mount `app.route('/api/runs', buildRunsRouter())`. |
| `src/index.ts:91-118` (start) and `:137-160` (shutdown drain) | `startEngineWorker()` beside the other workers; `stopEngineWorker()` in the drain path. |
| `infra/lib/dynamo-stack.ts:94-376` | Add table `${app}-runs` with `baseProps` (`:82-91`), GSI1 + GSI2, TTL attribute. Expand-only. |
| `infra/lib/constants.ts:85-130` | Table name `runs: \`${app}-runs\``. |
| `infra/lib/compute-stack.ts` (env + grants block for tables) | `TABLE_RUNS` env and least-privilege grants on the new table ARN only. UNVERIFIED: exact line of the table env block; follow the `TABLE_COMPACTION_EVENTS` / runtime-config pattern named in DATA-MODEL §3. |
| `docs/diagrams/architecture-data.md` (+ `docs/diagrams.map` sources already list `dynamo-stack.ts`) | Add the runs table. Docs CI `diagrams-drift.mjs` fails otherwise. |
| `docs/runbooks/kill-switches.md` | Add `workflow_runs_disabled`; fix the switch count in `docs/runbooks/README.md`. |

**New files**
| path | purpose |
|---|---|
| `src/lib/engine/types.ts` | `Run`, `StepExecution`, `RunEvent`, `ApprovalWait` types and status enums |
| `src/lib/engine/runs-repo.ts` | DynamoDB access for the runs table; all writes conditional (forward-only status, lease token) |
| `src/lib/engine/run-lease.ts` | Fail-**closed** run lease with fencing token (version counter) |
| `src/lib/engine/start-run.ts` | `startRun()`: loads the active frozen version, enforces Q95 rule, idempotent create |
| `src/lib/engine/run-worker.ts` | Claims a run, executes the next step, records events, schedules wake-up |
| `src/lib/engine/step-runners.ts` | One runner per step type: `agent`, `decision`, `approval`, `output` |
| `src/lib/engine/approvals-native.ts` | Netzar approval port on the runs table (no Paperclip, no shadow users) |
| `src/lib/engine/connectors.ts` | Deliver connectors behind `runEffect`; v1 ships `report_store` (writes the report to the run output) and a test spy connector. UNVERIFIED: which external delivery the pilot partner needs (email, callback); owner decision at PLANNING |
| `src/lib/engine/sweeper.ts` | Every 30 s under `tryAcquireRunnerLease({ name: 'engine-sweeper' })`: due waits, stale leases, queued runs |
| `src/lib/engine/index.ts` | `startEngineWorker`, `stopEngineWorker`, `isEngineDraining` |
| `src/adapters/dashboard/runs.ts` | `/api/runs` router (auth pattern of `seat-admin.ts:104-124`) |

**API contract**
- `GET /api/runs?workflowId=<id>&limit=<1..50>` — cap `runs:read`. 200 `{ runs: [{ runId, workflowId, versionSeq, status, startedAt, endedAt? }] , nextCursor? }`. 400 `{ error: 'invalid_query' }`. 401 `{ error: 'unauthorized' }`. 403 `{ error: 'forbidden', requiredCapability: 'runs:read' }`.
- `GET /api/runs/:runId` — cap `runs:read`. 200 `{ runId, workflowId, versionSeq, status, steps: [{ stepId, type, status, attempt, summary?, outputHash? }], approval?: { stepId, approvers: string[], proposedAction: { kind, target, preview }, payloadSha256, requestedAt } }`. 404 `{ error: 'not_found' }` (same for "no such run" and "not allowed to see", SECURITY T5 I-rule).
- `POST /api/runs/:runId/approvals/:stepId` — cap `runs:approve` **and** `personOf(c)` (`handler.ts:311-315` pattern) in the step's approver list. Body (strict, ≤ 8 KB): `{ decision: 'approve' | 'reject', payloadSha256: string(64 hex), comment?: string ≤ 4000 }`; reject needs a comment (same rule as `approvals.ts:132`). 200 `{ runId, status }`. 400 `{ error: 'invalid_body' }` / `{ error: 'comment_required' }`. 403 `{ error: 'not_an_approver' }`. 404 `{ error: 'not_found' }`. 409 `{ error: 'payload_changed' }` / `{ error: 'not_waiting' }`.
- `POST /api/runs/:runId/resolve` — cap `runs:approve`. Body `{ stepId, outcome: 'applied' | 'not_applied', note: string 1..1000 }`. Calls `executor.resolve()` (`executor.ts:173`). 200 `{ runId, status }`. 409 `{ error: 'not_unknown' }`.
- Internal (no HTTP): `startRun(input: { workflowId; input: unknown; trigger: { kind: 'webhook' | 'api' | 'form' | 'test'; triggerId?: string }; idempotencyKey: string }) → Promise<{ runId; status: 'queued'; deduped: boolean }>`; throws `RunRefusedError(code)` with codes `no_active_version`, `approval_required_before_write`, `input_invalid`, `kill_switch`.

**Data changes**
- New table `${app}-runs` (PK/SK strings, `baseProps`: on-demand, PITR, KMS, RETAIN):
  - `RUN#<runId>` / `META`: `workflowId, versionSeq, versionSha256, status (queued|running|waiting_approval|needs_attention|succeeded|failed|cancelled), trigger{kind,triggerId?}, inputHash, inputRef (S3 key, never inline), leaseHolder?, leaseToken (number), leaseExpiresAt, nextWakeAt?, createdAt, updatedAt`. GSI1 `WF#<workflowId>` / `<createdAt>#<runId>` (list). GSI2 `WAKE` / `<nextWakeAt>#<runId>` (sweeper; attribute removed when nothing is due, so the index stays small).
  - `RUN#<runId>` / `STEP#<nn>#<attempt>`: `stepId, type, status, startedAt, endedAt, outputHash, summary (≤ 4 KB), errorCode?`. Create-only per attempt.
  - `RUN#<runId>` / `APPROVAL#<stepId>`: `approvers[], proposedAction, payloadSha256, status (pending|approved|rejected), decidedBy?, decidedAt?, commentSha256?`. Status changes only from `pending` (conditional).
  - `RUN#<runId>` / `EVT#<ts>#<seq>`: run event history (ids, codes, hashes only).
  - `IDEM#<workflowId>#<sha256(idempotencyKey)>` / `RUN`: `runId`, `ttl` = now + 24 h. Create-only (`attribute_not_exists(PK)`).
- Effects stay in the existing `effect-ledger` table: `EffectKey = { caseKey: 'run:' + runId, stage: stepId, step: connectorName, stageEntryNo: 1 }` (passes `validateEffectKey`, `effect-ledger.ts:20-27`; stepId must match `^[a-z0-9][a-z0-9_-]{0,127}$`).
- Run input documents go to S3 (existing raw bucket, prefix `runs/<runId>/input`), not into DynamoDB (400 KB item limit; WAF/edge limits R8).
- Migration: expand-only (new table, new attributes). No backfill. Rollback: kill switch `workflow_runs_disabled` + image rollback; the table stays (RETAIN). Never rename the table's logical id (DEPLOY §5).

**If the ADR picks Step Functions** (changes, not additions): Run/StepExecution authority becomes the execution; `runs` table keeps only `META` + `APPROVAL#` projections for the API; approval resumes by `SendTaskSuccess` with the stored task token; slice 2 becomes "state machine + IAM in a new `engine-stack.ts`"; `@aws-sdk/client-sfn` is added only with the owner's yes; `runEffect` stays mandatory for the deliver step.

* **Security notes:**
  - SECURITY T6: AI steps write-deny (`toolPolicy.aiStep`); only the deliver step writes, through `runEffect` (ADR 0013/0015); approval bound to `payloadSha256` (ADR 0016 item 3). R1 caveat: an MCP tool named in `agent.yaml` can still run in an AI step (`tool-policy.ts`, SECURITY 2a B4). The engine passes `toolPolicy: { aiStep: true }` **and** drops MCP tools for workflow agent steps (same rule NZR-26 adds for test runs); test in Scenario 6.
  - Approver identity from the session principal only (`personOf`), never from body or `X-Dashboard-User` (A153 lesson, SECURITY 2a B1 S/R).
  - Audit: every state change uses `writeAuditOrThrow` (`audit-writer.ts:432`), never fire-and-forget `writeAudit` (:286). Ids and hashes only; no document text, no model output text in audit.
  - Synthetic chat id per step so `buildMemoryContext` reads no real user memory; never call `appendTurns` (memory ingest and Hive writes).
  - Kill switch for spend and writes: `workflow_runs_disabled`; spend still admitted per turn by `admitTurnSpend` (`agent-loop.ts:766`).
* **Test plan:**
  - Frozen failing tests first (own commit, red SHA recorded): Scenarios 2, 3, 4, 5, 8 unit tests with fakes; Scenario 1 integration test.
  - Unit (vitest, fakes for DDB and connectors): `src/lib/engine/run-worker.test.ts`, `run-lease.test.ts`, `start-run.test.ts`, `step-runners.test.ts`, `src/adapters/dashboard/runs.test.ts` (drive the real router with `app.request()`; mock `dashboard-auth.js` principals like `src/adapters/dashboard/seat-admin.test.ts`).
  - Integration (LocalStack DDB): `src/lib/engine/engine.golden.integration.test.ts`. Table schema comes from `scripts/local/table-schemas.ts` synth of `DynamoStack` (ARCHITECTURE §3.1), so the new table appears automatically.
  - Fixtures: synthetic only — `src/lib/engine/__fixtures__/golden-version.json` (copied from the NZR-31 definition), `synthetic-policy.txt`. Recorded agent replies via the NZR-11 harness.
  - Commands: `npx vitest run src/lib/engine src/adapters/dashboard/runs.test.ts`; `npm run test:integration:up && npx vitest run --config vitest.integration.config.ts src/lib/engine && npm run test:integration:down`; `npx vitest run src/lib/jarvis/route-manifest.test.ts`; `npx vitest run infra` (synth tests for the new table); then full `npm test`; `node scripts/ci/diagrams-drift.mjs`; `node scripts/ci/secret-scan.mjs <changed files>`.
* **Repo rules that apply:** new route ⇒ mount in `src/server.ts`, not in `handler.ts` (ARCHITECTURE §3.2); `src/lib/engine/**` must not import `src/adapters/*` (R14 — add an import test like `src/lib/missions/repo-imports.test.ts`); new capability ⇒ `CAPABILITY_MIN_ROLE` in `route-manifest.test.ts:165`; `writeAuditOrThrow` for evidence; no new dependency (own-engine option needs none); `dynamo-stack.ts` change ⇒ `docs/diagrams/architecture-data.md` + `diagrams-drift.mjs`; full `npm test` before any push (CLAUDE.md:46).
* **Rollback:** trip `workflow_runs_disabled` (stops step work, runs stay durable); image rollback `npm run deploy:rollback -- --class=image --to=previous` once deployed; the table is RETAIN and harmless when unused. No data restore needed.
* **Build slices (proposal):**
  1. *Run store + lease* (2 h): `types.ts`, `runs-repo.ts`, `run-lease.ts`, infra table + constants + grants. Green: Scenario 3, Scenario 8, infra synth test.
  2. *Worker + step runners (no approval)* (2–3 h): `run-worker.ts`, `step-runners.ts`, `connectors.ts`, executor drain injection, audit actions, kill switch. Green: Scenarios 2, 6, 7.
  3. *Native approvals + API* (2 h): `approvals-native.ts`, `runs.ts` router, capabilities, server mount, manifest test. Green: Scenario 5.
  4. *Sweeper + golden integration* (2 h): `sweeper.ts`, `index.ts`, `src/index.ts` wiring, diagrams, runbook. Green: Scenarios 1 and 4.
* **Agent gotchas:**
  - **Fail-open leases.** Do not reuse `tryAcquireRunnerLease`/`tryClaimOnce` for step ownership: both return `true` on a store error (`runner-lease.ts:76-87,128-139`). A step owner must fail closed or two tasks write.
  - **Settle window.** `defaultExecutor()` uses `settleMs = 270_000` (`executor.ts:50,209`): a second caller seeing a `pending` row younger than 4.5 min gets `EffectRetryableError`. Tests must inject `now` and `settleMs`, or they wait 4.5 min or flake.
  - **Paperclip drain coupling.** `executor.ts:4` ties the executor to Paperclip's drain flag; if you call `defaultExecutor()` from the engine, a Paperclip drain stops workflow runs. Use the injected `engineExecutor()`.
  - **Effect key regex.** `stage`/`step` must match `^[a-z0-9][a-z0-9_-]{0,127}$` (`effect-ledger.ts:21`); a step id with a capital letter or a dot throws `InvalidEffectKeyError` mid-run. Validate step ids in `startRun`.
  - `runAgentTurn`'s `runId` field is documented as "Genuine caller-held Paperclip run id" (`agent-loop.ts:215`); it only flows into audit ids and tool ctx (:898, :1501). Passing the engine runId is fine, but say so in a comment.
  - **Port 4566.** Floci and LocalStack both bind 4566 (`docker-compose.local.yml:32`, `docker-compose.test.yml:15`). Stop one before starting the other.
  - Do not store run state in a module-level `Map`; the T0 task restarts on every deploy and tier ≥ 1 runs several tasks (R12).
  - The studio table is for definitions/versions only (DATA-MODEL risk 8). Do not add `RUN#` items there.

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 8 (raw estimate 10 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona B; NFR-008 measured by the connector spy).
- [ ] Acceptance criteria cover both happy paths and edge cases (8 scenarios: happy, uncertain write, race, restart, authz, write-deny, degraded, duplicate start).
- [ ] UX/UI designs: N/A: engine and API. Approver screen owner decided (see NOTES) before NZR-38.
- [ ] Dependencies have been identified and are unblocked (NZR-33 ADR `accepted`; NZR-12 schema, NZR-22 pinned loads, NZR-31 fixture merged; Q95 answered or recommendation applied; pilot deliver target decided).
- [ ] The team has reviewed and estimated the story points (8 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail); no import from `src/adapters/*` under `src/lib/engine/`.
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews the security boundary (approval authz, write path, leases).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: `npx vitest run src/lib/engine src/adapters/dashboard/runs.test.ts`, the LocalStack integration run, `npx vitest run infra`; full `npm test` green (≥ 4,634 tests, C-40).
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary (fault-suite write counts).
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR (engine authority table); `architecture-data.md` diagram and kill-switch runbook updated.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists; ships to the pilot inside the NZR-38 artifact.
