# [US-033] Spike: Step Functions vs own DynamoDB engine

> Backlog task NZR-33 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-009, OBJ-005.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** a written, measured comparison of two ways to run published workflows (AWS Step Functions Standard, or our own engine on DynamoDB), ending in one decision recorded as an ADR
* **So that** NZR-34 builds exactly one engine, chosen on cost at 1,000 runs/day, failure handling and upkeep, with one source of truth for every piece of run state

---

## 2. Business Context & Description
* **Background:**
  - Workflows become data (draft → test → publish → activate → roll back; blueprint §4). Nothing executes a published workflow yet. C3 needs a live engine (FR-009 durable execution, OBJ-005 dependable execution) before the Dec 31 pilot (Q63).
  - A spike is a short, throwaway experiment (1–2 days) that answers one question. Its code is never merged; only the written result and the ADR are.
  - **Two options only.** PENDING OWNER Q110: recommended answer "no Temporal in 2026" (Temporal needs an always-on server, which breaks the serverless T0 pilot at ~$65–95/month, CONSTRAINTS C-53). If the owner says "add Temporal", this story grows by about 2 pts and gets a third prototype column; the measurements below stay the same.
  - DATA-MODEL risk 8: today three stores could each claim run state in C3 (Paperclip Postgres, the Work Platform effect ledger, the new studio table). This spike must name **one authority per run entity** before NZR-34 starts. The studio table must never hold execution state ([DATA-MODEL](../foundation/DATA-MODEL.md) §6 item 8).
  - ARCHITECTURE R12: the orchestrator autoscales (tier ≥ 1 runs 2–4 tasks), so run state cannot live in memory. ARCHITECTURE R2: Paperclip is the only `MissionEngine` today; whichever engine wins should be able to carry Missions later (PENDING OWNER Q94, see Out of scope).
* **Current behaviour (d1d3a66):**
  - No Step Functions resource exists in `infra/` (ARCHITECTURE §2, grep finds no `StateMachine`). `@aws-sdk/client-sfn` is **not** a dependency (`package.json`; only `client-scheduler` :92, `client-sqs` :96, `client-eventbridge` :85 exist). `aws-cdk-lib` ^2.170.0 (`package.json:126`) already contains the Step Functions constructs.
  - Reusable building blocks for an own engine already exist on `development`:
    - Effect executor `src/lib/work/executor.ts:65` `createExecutor` → `runEffect` (:107) writes a `pending` row before the external call, then `applied`; an ambiguous outcome becomes `unknown` and stops (`markUnknown` :88); a retry reads back first (`applyFromRow` :134). This is the "no duplicate write" core (NFR-008, PR-AC-002).
    - Effect key `{caseKey, stage, step, stageEntryNo}` (`src/lib/work/effect-ledger.ts:1`), DynamoDB rows in the `effect-ledger` table (`src/lib/work/effect-rows-dynamo.ts:6`, keys `CASE#…` / `EFFECT#…` at `effect-ledger.ts:28-29`).
    - Leases: `tryAcquireRunnerLease` (one conditional put, `src/lib/state/runner-lease.ts:54-88`) and the one-shot claim `tryClaimOnce` (:113-140) on the `queue-lease` table.
    - Timers: EventBridge Scheduler wrapper `src/lib/scheduler/eb-scheduler.ts:118` `upsertSchedule`; SQS drain `src/lib/scheduler/queue-drain.ts:355`.
    - Sweeper pattern with lease + fencing: `src/lib/paperclip/pending-dispatch-sweep.ts:1-28`.
  - Those libs are Paperclip-shaped: `executor.ts:4` imports `isDispatchDraining` from `paperclip/dispatch-drain`; `approvals.ts:3` imports Paperclip shadow users and the approvals port is Paperclip (`src/lib/work/approvals-paperclip.ts`). The blueprint still says "PR #206 unmerged" (`blueprint.md:55`), but steps 4–6 of these libs are merged (`d1d3a66` is the merge of PR #205; ARCHITECTURE §3.1). PR #206 itself stays paused.
  - Tier 0 runs one Fargate task at most (`infra/lib/constants.ts:337-349`: `fargateMaxTasks: 1`, no WAF, no CloudFront, daily cap $5). Every deploy restarts that single task (no canary at T0, DEPLOY §4), so in-flight runs must survive a restart.
* **Target behaviour:**
  - Two throwaway prototypes run the golden workflow shape (document in → agent review → gaps → report → approval → deliver; NZR-31) end to end **locally**, each with: one approval wait, one forced crash mid-step, one forced retry of an external write, and one process restart during the approval wait.
  - A comparison file records, for each option: cost at 1,000 runs/day (formula + inputs), failure handling (each forced fault and what happened), upkeep (new deps, new stacks, IAM, local emulation, tests, on-call), and the authority table.
  - **Authority table:** for each entity (Run, StepExecution, Wait/Timer, Approval, Effect, RunEvent/history) exactly one store is named as the record of truth; every other copy is called a projection.
  - An ADR (status `proposed`) states the decision, the rejected option and why, and the one-way doors it opens. The owner accepts it (status `accepted`) before NZR-34 PLANNING.
  - If no clear winner: Jev (the planner) writes a first-pass pick with reasons, and the owner decides.
* **Out of scope:**
  - Building the engine (NZR-34), triggers (NZR-35), publish/activate (NZR-36).
  - Any AWS call or deploy. Prototypes run against local emulators only.
  - Temporal (PENDING OWNER Q110).
  - Missions migration (NZR-37, January; PENDING OWNER Q94). The ADR only records whether the chosen engine can carry Missions later.
* **Target Value:** ADR merged with the decision, the authority table complete (6 of 6 entities have exactly one authority), and 4 of 4 forced faults recorded for each option.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Decision recorded
* **Given** both prototypes have run the golden workflow shape locally
* **When** the spike ends
* **Then** `docs/adr/<next-free-number>-live-workflow-engine.md` exists with sections `Context`, `Options`, `Decision`, `Cost at 1,000 runs/day`, `Failure handling`, `Upkeep`, `Authority per entity`, `Consequences`, and `node scripts/ci/docs-links.mjs` exits 0
* **Test:** `docs/features/netzar-studio/engine-spike.md` › section "Checklist" (each line ticked with evidence); Docs CI `node scripts/ci/docs-links.mjs` and `node scripts/ci/feature-knowledge.mjs`

### Scenario 2: Cost at 1,000 runs/day is shown, not asserted
* **Given** the golden workflow has N steps (counted from the NZR-31 definition)
* **When** cost is computed for each option
* **Then** the comparison shows the formula, every input (state transitions or DynamoDB reads/writes per run, approval wait length, price per unit with the AWS pricing page date), the monthly total at 30,000 runs, and the share of the T0 floor ($65–95/month, CONSTRAINTS C-53)
* **Test:** `docs/features/netzar-studio/engine-spike.md` › table "Cost model" (critic re-computes one row by hand)

### Scenario 3: Failure handling under forced faults
* **Given** each prototype and the four forced faults (crash mid-step; retry after an uncertain external write; process restart during an approval wait; two workers picking up the same step)
* **When** each fault is injected
* **Then** for each fault the table records: run end state, number of external writes (must be 1, never 2: NFR-008), whether the approval resumed with the exact frozen payload (PR-AC-003), and the evidence (test output line or log line)
* **Test:** spike branch `spike/nzr-33-engine` › `src/lib/engine-spike/own-engine.spike.test.ts` › "a retry after an uncertain write produces one external write" and `src/lib/engine-spike/sfn.spike.test.ts` › same name (never merged; output pasted into the comparison file)

### Scenario 4: One authority per entity
* **Given** the candidate stores (Step Functions execution history; a new runs table; the existing `effect-ledger` table; `queue-lease` for leases; the studio table; Paperclip)
* **When** the authority table is filled
* **Then** each of Run, StepExecution, Wait/Timer, Approval, Effect, RunEvent has exactly one authority; the studio table and Paperclip are authority for none of them
* **Test:** `docs/features/netzar-studio/engine-spike.md` › table "Authority per entity" (critic checks each row has exactly one ✔)

### Scenario 5: Tie
* **Given** no option wins on all three of cost, failure handling and upkeep
* **When** the spike ends
* **Then** the ADR has a section `First-pass pick (Jev)` with the pick and the deciding reason, status stays `proposed`, and NZR-34 does not start until the owner sets status `accepted`
* **Test:** ADR file › section "First-pass pick (Jev)"; DoR of NZR-34 checks status `accepted`

### Scenario 6: Blocked prototype (degraded mode)
* **Given** an option cannot run locally (for example the pinned Floci 1.6.0 has no Step Functions, or the owner says no to installing `@aws-sdk/client-sfn`)
* **When** the spike reaches that option
* **Then** that column is marked `PAPER ONLY` with the reason, its failure rows say `not measured`, and the ADR may not pick a `PAPER ONLY` option without the owner's explicit yes recorded in the ADR
* **Test:** `docs/features/netzar-studio/engine-spike.md` › column header shows `PAPER ONLY` where it applies

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-31 / US-031](US-031-golden-workflow-end-to-end-insurance-policy.md) Golden workflow end to end: insurance policy review
* **Builds on (other merged work; formal dependency changes are proposed in NOTES-H-live-deploy.md, not made here):** (gives the step count and the shape to prototype). Also reads NZR-12 schema and NZR-13 trigger contract (merged by C3).
* **UI/UX Design:** N/A: spike, no screen.
* **Non-Functional Requirements:** ≤ 50 users, ~1,000 runs/day per install (CONSTRAINTS C-50); zero duplicate external writes (NFR-008); approval waits longer than a compute session survive (PR-AC-003); pilot running cost T0 ~$65–95/month (C-53). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

**Steps** (spike, no production code)
1. Builder cuts `spike/nzr-33-engine` from `origin/development` (fetch first, Q74). It is never pushed or merged without the owner's yes.
2. Builder counts steps and transitions of the NZR-31 golden workflow and writes the cost inputs.
3. Builder prototypes option B (own engine): run row + step rows in a throwaway table, a step worker that takes a lease (`runner-lease.ts` pattern) with a fencing token, external writes only through `createExecutor().runEffect` (`work/executor.ts:65,107`) with an in-memory `EffectRows` fake plus one LocalStack run, approval as a durable wait row, wake-up by a sweeper (no in-memory timers).
4. Builder prototypes option A (Step Functions Standard): one generic interpreter state machine (ASL) that loops over steps; approval via `.waitForTaskToken`; the AI step and the deliver step call back into the app. Needs `@aws-sdk/client-sfn` → **owner yes before `npm install`** (C-15, Q78). Local emulation: Floci 2.x documents Step Functions (`~/floci/docs/services/step-functions.md`); the pinned `floci/floci:1.6.0` (`docker-compose.local.yml:26`) is UNVERIFIED for Step Functions; LocalStack 3.8 in `docker-compose.test.yml:17` does not list `stepfunctions` in `SERVICES`. If neither runs, mark `PAPER ONLY` (Scenario 6).
5. Builder injects the four faults in each prototype and records results.
6. Builder writes `engine-spike.md` and the ADR draft. Fresh critic re-checks numbers and the authority table. Jev gives a pick. Owner accepts.

**Artifacts**
| path | purpose |
|---|---|
| `docs/features/netzar-studio/engine-spike.md` | Comparison: cost model, fault table, upkeep table, authority table, checklist |
| `docs/adr/<next-free>-live-workflow-engine.md` | The decision (expected number after NZR-7/NZR-8 ADRs land, about 0031; UNVERIFIED: check `ls docs/adr` at PLANNING) |
| `docs/adr/README.md` | Index line for the new ADR |
| `docs/features/netzar-studio/handoffs/<date>-nzr-33-engine-spike.md` | Session handoff |
| branch `spike/nzr-33-engine` (local only) | Prototype code + spike tests; deleted after the ADR is accepted |

**Evidence** (what proves done)
- Cost table with formula and dated prices for both options.
- Fault table: 4 faults × 2 options, each with run end state, external write count and an output line.
- Authority table: 6 entities, exactly one authority each.
- ADR status `accepted` with the owner's yes quoted and dated.

**What the comparison must cover (minimum rows)**
| Topic | Own DynamoDB engine | Step Functions Standard |
|---|---|---|
| Durable approval wait (days) | wait row + sweeper | task token (execution max 1 year) |
| Restart of the only T0 task mid-run | lease expiry + resume | execution keeps running; callback retried |
| Scale-out to 2–4 tasks (R12) | fencing token on every step write | no app-side state; callback idempotency |
| Duplicate external write | `runEffect` + `effect-ledger` | still needs `runEffect` (SFN retries a Task) |
| Run history UI (My Work) | own RunEvent rows | `GetExecutionHistory` or own projection |
| Versions (NZR-36 rollback) | run pins `workflowVersion` | same pin passed as input; ASL is generic |
| New dependency | none | `@aws-sdk/client-sfn` (owner yes) |
| New infra | one table (expand-only) or reuse `effect-ledger` | state machine + IAM role + log group (new stack or `compute-stack.ts` change) |
| Local tests | vitest + LocalStack (DDB already in `SERVICES`) | Floci/LocalStack SFN support UNVERIFIED |
| Effect of `executor.ts:4` Paperclip import | must be cut (drain signal for the new worker) | same |
| Can host Missions later (Q94) | yes/no + why | yes/no + why |
| Customer-hosted GA fit (one account, ADR 0002) | | |

* **Security notes:**
  - SECURITY T6 (live engine): only the engine role may write run state; approval payload frozen per step (ADR 0016 item 3). The ADR must name which IAM principal writes run state in each option.
  - Prototypes use synthetic data only (Q67); no Bedrock, no NVIDIA call is needed (use recorded or stub agent replies, NZR-11).
  - No AWS call (task rule; CONSTRAINTS C-48). LocalStack/Floci only.
* **Test plan:**
  - Spike tests only (not merged): `src/lib/engine-spike/own-engine.spike.test.ts`, `src/lib/engine-spike/sfn.spike.test.ts`. They live only on the spike branch, so `npm test` on `development` never sees them. (The vitest include `src/**/*.test.ts`, `vitest.config.ts:9`, would pick them up on that branch; that is fine there.)
  - Commands on the spike branch: `npx vitest run src/lib/engine-spike` (unit, fakes); for the LocalStack run: `npm run test:integration:up`, then `npx vitest run --config vitest.integration.config.ts src/lib/engine-spike`, then `npm run test:integration:down`.
  - Docs PR commands: `node scripts/ci/docs-links.mjs`, `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/runnable-blocks.mjs`.
* **Repo rules that apply:** no new dependency without owner yes (C-15, `package.json` + lockfile diff); ADR one-way door needs owner yes recorded in the ADR (US-007 pattern); feature-doc frontmatter on `engine-spike.md` (`docs/features/README.md`); one handoff per session.
* **Rollback:** delete the spike branch. The ADR can be superseded by a later ADR; nothing in the product changes.
* **Build slices (proposal):**
  1. *Cost model + authority draft* (1 h): `engine-spike.md` cost table and authority table from code reading. Turns Scenario 2 and 4 green on paper.
  2. *Own-engine prototype + 4 faults* (1 h): `own-engine.spike.test.ts`. Scenario 3 column B.
  3. *Step Functions prototype + 4 faults, or PAPER ONLY* (1 h): `sfn.spike.test.ts`. Scenario 3 column A or Scenario 6.
  4. *ADR + pick* (≤ 1 h): ADR file, Jev pick, owner decision. Scenario 1 and 5.
* **Agent gotchas:**
  - **Port 4566 collision.** Floci (`docker-compose.local.yml:32`, `127.0.0.1:4566`) and LocalStack (`docker-compose.test.yml:15`, `4566`) bind the same port. Run one at a time (`npm run local:down` before `npm run test:integration:up`), or a test hits the wrong emulator and passes or fails falsely.
  - `npm run local:*` scripts use `--env-file=.env`; the VPS clean clone has no `.env` (NZR-3). Use `test:integration:*`, which needs none.
  - Step Functions retries a Task on its own. That does not make the external write safe: the write still has to go through `runEffect`, or a retry writes twice.
  - `tryAcquireRunnerLease` fails **open** on a store error (`runner-lease.ts:76-87`) — right for monitoring loops, wrong for a step worker. The engine needs a fail-closed variant; record that in the ADR.
  - VPS has 3.9 GB RAM: never run LocalStack and Floci together, never run the full `npm test` and LocalStack at the same time.
  - Do not cite the blueprint's "PR #206 unmerged" as meaning `src/lib/work/*` is missing; it is merged (steps 4–6).

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** spike, decision

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (operator needs one engine decision before NZR-34).
- [ ] Acceptance criteria cover both happy paths and edge cases (6 scenarios incl. tie and PAPER ONLY).
- [ ] UX/UI designs: N/A: spike.
- [ ] Dependencies have been identified and are unblocked (NZR-31 golden workflow merged; NZR-12 schema merged; Q110 answered or the recommendation applied; owner yes/no on installing `@aws-sdk/client-sfn` asked up front).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail). For this spike: prototype code stays on `spike/nzr-33-engine` and is not merged; only `engine-spike.md`, the ADR and the handoff are merged.
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic (re-computes one cost row, re-checks the authority table) + security reviewer (T6 rows) (+ NVIDIA roles after bake-off); owner reviews and accepts the ADR.
- [ ] A frozen failing test came first (red SHA recorded) for each fault in the spike tests on the spike branch; Docs CI green on the docs PR HEAD (`docs-links`, `feature-knowledge`, `runnable-blocks`).
- [ ] QA: the fresh critic re-runs the evidence against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary and sets the ADR to `accepted`.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR (the authority table goes into the ADR).
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: N/A (no deployable change).
