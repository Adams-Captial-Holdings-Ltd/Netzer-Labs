# [US-026] Try it: sample-data test runner (sealed sandbox) + Ready flag

> Backlog task NZR-26 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-005, FR-014, AC-005, NFR-008. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3), designed and tested as "Margaret, 67" (Q98)
* **I want** to tap one "Try it" button and see what my routine would hand me, worked out on a made-up sample, before I look at any step details
* **So that** I can trust the routine before it ever touches real systems. Success means zero external calls or writes during a try (asserted in tests), a plain result for every step, and an honest "Ready" mark that I can only set after a passing try of this exact version (FR-005, FR-014, AC-005).

---

## 2. Business Context & Description
* **Background:**
  - The PRD promises "test without executing unintended real-world actions" (FR-005). ARCHITECTURE R1 shows today's AI-step write-deny does not deliver that:
    - an MCP tool runs if the agent allowlist names it (`src/lib/tools/tool-policy.ts:11-13`);
    - the persistence path after a turn writes memories and Hive notes (`src/lib/state/sessions-repo.ts:46` → `src/agent/memory-ingest.ts` `logToHive`);
    - `tool_invoke` audit rows are fire-and-forget (`agent-loop.ts:1537`, `void writeAudit`).
  - PENDING OWNER Q85 asks for a **sealed sandbox**. Recommended yes, and this story builds it:
    - no remote tools;
    - no memory, Hive or session writes;
    - a synthetic chatId;
    - every other tool call intercepted and recorded as "would have…";
    - a network spy that asserts zero outbound calls besides the (mocked) model;
    - `writeAuditOrThrow` per step;
    - the TestRun row as the record of truth.
  - Q106 (round 5) changes the screens. There is one "Try it" button with the sample already picked. The finished output comes first ("Here's the report it would send you"), and the step details are folded underneath.
  - ARCHITECTURE R8 sets two limits. WAF's CommonRuleSet caps request bodies at 8 KB on `/api/*`, and CloudFront cuts origin reads at 60 s. So a try runs **asynchronously**: the request returns a run id at once, and the page polls. Request bodies carry ids only.
  - design.md O-11 notes that the Ready flag (W-012) had no owner. This story owns it.
  - Safety boundary, so the story is T3.
* **Current behaviour (d1d3a66):**
  - `runAgentTurn(req)` (`src/agent/agent-loop.ts:762`) accepts `toolPolicy?: { aiStep?: boolean }` (`:217`) and `attachments?: AttachmentBlock[]` (`:241`, document or image bytes, `:112-120`).
  - Context assembly always reads the agent's long-term memory, inbox and recent Hive notes (`:403-412`).
  - The tool list is built from local tools plus `mcpToolsFor(agentId)` (`:1082`), which connects to the MCP servers. It is then filtered by `toolDecision` (`:1092-1100`), so denied tools are hidden from the model, and the model can never show what it *would* have sent.
  - Dispatch is at `:1510-1531`. Calls go to `invokeMcpTool` for `mcp__*` names and `tools.invoke` otherwise.
  - Some tools are marked read-only and still reach outside or read real data: `salesforce_query` and `dynamodb_query`. `search_memories` and `search_hive` read real stored data. So "read-only" does not mean "sealed".
  - The loop itself does not append turns. Callers do, and `appendTurns` triggers memory ingest.
  - `writeAuditOrThrow` (`src/lib/audit/audit-writer.ts:432`) throws only if both the DDB and S3 writes fail. `writeAudit` (`:286`) drops writes while the `audit_log_disabled` kill switch is on, unless the action is in `ALWAYS_AUDITED_ACTIONS` (`:234`).
  - The vitest setup has a tripwire on `http`/`https` but does not patch `fetch` (`vitest.setup.ts:18-25, 91-94`).
  - Nothing exists yet for the TestRun store, the test runner, samples or the Ready flag.
* **Target behaviour:**
  - **Try it.** Tapping "Try it" on the preview (enabled only when US-025 reports no needs) sends `POST /api/workflows/:id/test` with the default sample "Made-up home insurance policy". The server answers 202 with a `runId`, and the page goes to `/workflows/:id/test/:runId`.
  - **Running.** The run page polls every 2 s. It shows "Trying it… step 2 of 4: <step sentence>", one line per step, a "Stop" button, and the standing banner "This is a practice run. Nothing will be sent anywhere."
  - **Passed.** The result comes first:
    - heading "It worked.";
    - the card "Here's the report it would send you" with the final text;
    - "Nothing was sent anywhere.";
    - a list "It would have sent:" (for example "The report to you, in Netzar"; "Email to claims@example.test: Policy gaps found");
    - a big "Mark as ready" button;
    - "Show the steps" (folded), which lists every step with a plain outcome.
  - **Failed.** The page shows "It stopped at step 2." with the plain reason and a suggested fix. It offers "Try again" and "Ask Netzar to fix it" (the NZR-24 Ask box, hidden if absent). Later steps show "Not run". The failed step is unfolded.
  - **Sealed sandbox.** Every AI step runs `runAgentTurn` with `sandbox:{mode:'sealed'}`:
    - no MCP specs are loaded;
    - memory, inbox and Hive context are not read;
    - only `get_time` executes;
    - every other tool call returns "Practice run: not carried out" to the model and is recorded as an intercepted action (tool name plus a redacted input preview);
    - the synthetic chatId is `wftest_<runId>`;
    - nothing calls `appendTurns`, `beginTurn` or memory ingest.
  - **Records.**
    - The TestRun header and step rows are create-only in the studio table, and status only moves forward.
    - Each step writes one `writeAuditOrThrow` row (action `workflow_test_step`, ids and hashes only). If that write throws, the run fails closed with "We couldn't record this try, so we stopped it."
    - Start, end and Ready are also always-audited actions.
  - **Ready.** "Mark as ready" (`POST /api/workflows/:id/ready {runId}`) succeeds only if that run passed **and** its `draftRev` and sha256 equal the current draft. The routine then shows "Ready" with "Turning it on comes later." Any later edit makes the label "Test again" (the US-049 `labelFor` rule), and Ready must be earned again.
  - **Limits.**
    - One running try per routine.
    - At most 20 tries per person per day.
    - Each try has a 5-minute deadline and at most 6 AI calls.
    - A run left "running" past its deadline (for example after a server restart) is closed as "Timed out" the next time anyone reads it.
* **Out of scope:**
  - Uploading your own file (W-008 upload states). The built-in samples cover the slice, and upload needs presigned S3 because of the WAF body cap. Proposed as a follow-up in NOTES-E-slice.
  - The technical trace for authorized users (W-010 "expanded trace", PRD 3.5).
  - Real runs, turning a routine on, and publishing (C3, NZR-36).
  - Human approval waits (approval steps are simulated in a try).
  - Remote (MCP) "would have sent" previews: remote tools are not offered at all in a sealed try.
  - Temporal or any new engine (Q110).
* **Target Value:**
  - Zero outbound network calls other than the model client, zero memory/Hive/session writes, and zero executed non-allow-listed tools in every runner test (asserted).
  - 100% of steps get a stored plain result.
  - In the Nov 23 dry-run, at least 4 of 5 testers (at least 2 aged 60+) finish a try and say what the routine produced, without "Help me".
  - Measured with `workflow.test_started`, `workflow.test_completed`, `workflow.test_write_blocked`, `workflow.marked_ready` and `studio.help_opened` (screen `test`).
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3), as "Margaret, 67" (Q98). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Try it passes, result first
* **Given:**
  - the golden routine has no needs, at `draftRev` 3;
  - the model client is replaced by a scripted fake that returns a gap report for step 1 and "YES" for the check in step 2.
* **When** the owner taps "Try it" on the preview.
* **Then:**
  - `POST /api/workflows/<id>/test` with `{"sampleId":"policy-home-v1","baseRev":3}` returns 202 `{"runId":"run_…","pollAfterMs":2000}` in under 1 s.
  - Polling `GET /api/workflows/<id>/test/<runId>` reaches `status:"passed"`.
  - The page shows these, in this DOM order: "It worked.", then "Here's the report it would send you" containing the scripted report text, then "Nothing was sent anywhere.", then "Mark as ready".
  - "Show the steps" is collapsed (`aria-expanded="false"`). When opened, it lists 4 steps with outcomes "Done", "Done", "Approved for you (practice)", "Would send to you".
  - The store holds 1 TestRun header and 4 step rows, all create-only puts.
* **Test:** `src/lib/workflows/test-runner.test.ts` › "golden routine passes and stores header plus one row per step"; `tests/e2e/studio/try-it.spec.ts` › "Try it shows the result first with steps folded"

### Scenario 2: A step fails
* **Given** the scripted model throws a model error on step 1.
* **When** the try runs.
* **Then:**
  - The run ends `status:"failed"`. Step 1 has `outcome:"failed"` and `summary` "The helper couldn't finish reading the document." The `fix` field reads "Try again. If it keeps happening, choose a different helper for step 1."
  - Steps 2 to 4 have `outcome:"not_run"`.
  - The page shows "It stopped at step 1.", the reason, "Try again", and step 1 unfolded.
  - The routine's `lastPassedRev` is unchanged.
* **Test:** `src/lib/workflows/test-runner.test.ts` › "a failing step marks later steps not_run and does not set lastPassedRev"; `tests/e2e/studio/try-it.spec.ts` › "failed try shows the stopping step and Try again"

### Scenario 3: A write is intercepted and shown as "would have sent"
* **Given** step 1's helper calls the local tool `send_email` with `{"to":"claims@example.test","subject":"Policy gaps found"}` during the try.
* **When** the try runs.
* **Then:**
  - `tools.invoke` is never called for `send_email`.
  - The model receives the tool result text "Practice run: not carried out." and the turn continues.
  - Step 1's row has `intercepted:[{"tool":"send_email","preview":"Email to claims@example.test: Policy gaps found"}]`.
  - A `tool_invoke` audit is written with `result:"blocked"` and `reason:"sealed_test"`.
  - The step's `workflow_test_step` audit has `interceptedCount:1`.
  - The result page lists "Email to claims@example.test: Policy gaps found" under "It would have sent:".
  - `workflow.test_write_blocked` is emitted with `count:"1"`.
* **Test:** `src/agent/agent-loop.sealed.test.ts` › "sealed mode intercepts a write tool and reports it"; `src/lib/workflows/test-runner.test.ts` › "intercepted calls are stored and shown as would-have-sent"

### Scenario 4: The sandbox is total
* **Given:**
  - an agent whose `agent.yaml` `tools` allowlist names `mcp__gmail__send_message` and `salesforce_query`;
  - memory, inbox and Hive repos that would return data;
  - a network spy on `globalThis.fetch`, `http.request/get`, `https.request/get`, `net.connect` and `tls.connect`;
  - a mocked model client.
* **When** a sealed turn runs and the model asks for `salesforce_query`, `log_to_hive` and `search_memories`.
* **Then:**
  - `mcpToolsFor` and `invokeMcpTool` are called 0 times, and no `mcp__*` spec is sent to the model.
  - `buildMemoryContext`, `listInbox` and `recentHive` are called 0 times.
  - `tools.invoke` is called 0 times for all three tools; all three are recorded as intercepted.
  - `appendTurns`, `beginTurn` and `ingestEvictedTurns` are called 0 times. Hive puts and memory puts are also called 0 times.
  - The network spy records 0 calls.
  - The `chatId` passed to every audit and usage call starts with `wftest_`.
* **Test:** `src/agent/agent-loop.sealed.test.ts` › "sealed turn makes zero outbound calls, loads no MCP tools and writes no memory, Hive or session"

### Scenario 5: Mark as ready, then edit
* **Given** a passed run of `draftRev` 3 whose sha256 matches the current draft.
* **When** the owner taps "Mark as ready", then moves a step (US-025, `draftRev` 4).
* **Then:**
  - `POST /api/workflows/<id>/ready` with `{"runId":"<run>"}` returns 200, and META has `status:"ready"` and `readyRev:3`.
  - The preview status line reads "Ready". The note reads "Turning it on comes later."
  - A `workflow_ready` audit row is written.
  - After the edit, the label is "Test again", the "Mark as ready" button is gone from the old run page, and the run page shows "This try was for an older version. Try it again."
* **Test:** `src/adapters/dashboard/workflows.test-runs.routes.test.ts` › "ready accepts a passed current run"; `src/lib/workflows/list.test.ts` (US-049) › "labelFor maps status, readyRev and validator needs to plain labels"; `tests/e2e/studio/try-it.spec.ts` › "mark ready then edit shows Test again"

### Scenario 6: Ready is refused when not earned
* **Given:** (a) a failed run, (b) a passed run for `draftRev` 2 while the draft is at 3, (c) another person's run id.
* **When** `POST /api/workflows/<id>/ready` is called.
* **Then:**
  - (a) returns 409 `{"error":"run_not_passed"}`;
  - (b) returns 409 `{"error":"run_out_of_date"}`;
  - (c) returns 404 `{"error":"not_found"}`;
  - META is unchanged in all three cases.
* **Test:** `src/adapters/dashboard/workflows.test-runs.routes.test.ts` › "ready refuses failed, out-of-date and foreign runs"

### Scenario 7: Fail closed when the record can't be written
* **Given** `writeAuditOrThrow` throws `AuditWriteFailedError` for step 2's `workflow_test_step` row.
* **When** the try runs.
* **Then:**
  - Step 3 never starts: no step row is written for steps 3 or 4, and `runAgentTurn` is never called again after step 2.
  - The run ends `status:"failed"` with `reason:"audit_unavailable"`.
  - The page shows "We couldn't record this try, so we stopped it. Please try again in a few minutes."
* **Test:** `src/lib/workflows/test-runner.test.ts` › "audit write failure stops the run and fails closed"

### Scenario 8: Async, limits and stuck runs
* **Given:**
  - (a) a try already running for this routine;
  - (b) a person with 20 tries today;
  - (c) a run whose `deadlineAt` has passed while its status is still `running`;
  - (d) a POST body over 1 KB;
  - (e) a draft with open needs;
  - (f) a `baseRev` that is not the current `draftRev`.
* **When** they start a try or read the run.
* **Then:**
  - (a) returns 409 `{"error":"test_already_running","runId":"<existing>"}`, and the UI goes to that run.
  - (b) returns 429 `{"error":"too_many_tests","retryAfterS":<n>}`, and the page shows "You've tried 20 times today. Try again tomorrow."
  - (c) the GET conditionally sets `status:"aborted"` with `reason:"timed_out"` and returns it. The page shows "This try took too long and was stopped."
  - (d) returns 413.
  - (e) returns 409 `{"error":"needs_setup","needs":[…]}`.
  - (f) returns 409 `stale_draft`.
  - In every case, every GET response has `Cache-Control: no-store` and a body under 64 KB.
* **Test:** `src/adapters/dashboard/workflows.test-runs.routes.test.ts` › "start refuses running, over-limit, oversized, needs-setup and stale requests"; `src/lib/workflows/test-runner.test.ts` › "an expired running run is closed as timed_out on read"

### Scenario 9: Stop a running try
* **Given** a running try at step 1.
* **When** the owner taps "Stop" and confirms "Stop trying".
* **Then:**
  - `POST /api/workflows/<id>/test/<runId>/cancel` returns 202.
  - The in-flight turn's `AbortSignal` fires.
  - The run ends `status:"aborted"` with `reason:"stopped"`.
  - The page shows "You stopped this try." with "Try again".
  - Cancelling a run that has already finished returns 409 `{"error":"run_finished"}`.
* **Test:** `src/lib/workflows/test-runner.test.ts` › "cancel aborts the in-flight step and closes the run"; `tests/e2e/studio/try-it.spec.ts` › "Stop ends the try"

### Scenario 10: Readable for Margaret
* **Given** the run page at 1440x900, 1024x768 and 390x844 in each state (running, passed, failed, timed out).
* **When** it renders, and again at 720x450 (200% zoom).
* **Then:**
  - Body text is at least 20px.
  - Buttons are at least 44x44px.
  - There is no horizontal scroll at 720x450.
  - The progress line is in an `aria-live="polite"` region that announces each step change once.
  - No banned word appears in any run summary, reason or fix text.
* **Test:** `tests/e2e/studio/try-it.spec.ts` › "run page text size, zoom and live region"; `src/lib/workflows/run-copy.test.ts` › "run texts never use banned words"

---

## 4. Technical Notes & Constraints
* **Dependencies:**
  - [NZR-23 / US-023](US-023-workflow-drafter-describe-draft-or-clarifying-question.md) Workflow drafter: describe -> draft or clarifying question.
  - Also needs:
    - [NZR-25 / US-025](US-025-plain-language-preview-numbered-steps-no-canvas.md): the "Try it" button, `needs`, `describeDraft`, and the fixtures;
    - [NZR-49 / US-049](US-049-plain-workflows-tab-list-new-open-draft.md): frame, capabilities, `labelFor` (`readyRev`/`lastPassedRev`), events;
    - [NZR-12 / US-012](US-012-workflow-definition-schema-validator.md): the studio table and store.
  - Soft dependency: [NZR-24 / US-024](US-024-edit-by-chat-on-drafts.md) for "Ask Netzar to fix it".
* **UI/UX Design:**
  - Mocks:
    - W-008 [pick sample desktop](../../../assets/netzar-studio/mock/W-008-pick-sample-desktop.png) / [phone](../../../assets/netzar-studio/mock/W-008-pick-sample-phone.png)
    - W-009 [running desktop](../../../assets/netzar-studio/mock/W-009-running-desktop.png) / [phone](../../../assets/netzar-studio/mock/W-009-running-phone.png)
    - W-010 [results desktop](../../../assets/netzar-studio/mock/W-010-results-desktop.png) / [phone](../../../assets/netzar-studio/mock/W-010-results-phone.png)
    - W-010 [blocked write desktop](../../../assets/netzar-studio/mock/W-010-blocked-write-desktop.png) / [phone](../../../assets/netzar-studio/mock/W-010-blocked-write-phone.png)
    - W-011 [failed desktop](../../../assets/netzar-studio/mock/W-011-failed-desktop.png) / [phone](../../../assets/netzar-studio/mock/W-011-failed-phone.png)
    - W-012 [ready desktop](../../../assets/netzar-studio/mock/W-012-ready-desktop.png) / [phone](../../../assets/netzar-studio/mock/W-012-ready-phone.png)
    - Index: [design.md](../foundation/design.md) sections 2 and 3a.
  - The current mocks follow the old flow: pick a sample first, a per-step list first, "Test with sample data", and "agent" wording. They will be redone for Q106 (result first, steps folded, one "Try it", "Help me", 20px, iPad frame) before Nov 9 (Q101). W-008 becomes the secondary "Use a different sample" screen. Build from this story's copy; the redone mocks win on layout.
  - Not mocked yet (due Nov 9): queued, cancelling, cancelled, timed out (W-009); system error before start (W-011); out of date and can't-mark-ready (W-012); too many tries.
  - **PENDING OWNER Q85:** sealed sandbox. Recommended yes, and this story builds it. If the owner picks "keep today's write-deny":
    - drop the `sandbox` option and Scenarios 3 and 4;
    - run with `toolPolicy:{aiStep:true}` only;
    - change the banner to "Practice run. Tools that only read may still look things up.";
    - reduce points 8 → 6.
  - **PENDING OWNER Q106:** one "Try it" button with results first. Recommended yes. If no, use the current mocks (pick sample first, per-step list first).
  - PENDING OWNER Q99, Q105 and Q107 apply as in US-049.
* **Non-Functional Requirements:**
  - Zero external effects in a try (FR-005, NFR-008: a try can create no duplicate external writes because it creates none).
  - Every step result is stored (FR-014).
  - Requests:
    - `POST …/test` p95 under 1 s; it only creates the header and schedules the run.
    - Each poll GET p95 under 300 ms, using one `begins_with` Query on `TEST#<runId>`.
    - Every request finishes far under CloudFront's 60 s.
    - Request bodies are at most 1 KB, far under the WAF's 8 KB.
  - Run limits: deadline 5 min, at most 6 model calls, at most 8 tool calls per AI step (the existing loop cap), and the model output cap from `resolveTurnMaxTokens()`.
  - Workspace screen readability as in US-049 (Q105, Q108).
  - Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:**
  - `workflow.test_started` (props `sample` = `builtin`).
  - `workflow.test_completed` (props `outcome` = `passed|failed|aborted`, `reason` = `none|step_failed|audit_unavailable|timed_out|stopped|ai_off`, `durationBucket` = `<30s|30-120s|>120s`).
  - `workflow.test_write_blocked` (props `count` = `1|2-5|6+`).
  - `workflow.marked_ready` (no props).
  - All events go through `emitProductEvent` (US-049), with no userId (Q55). Catalogue in OBSERVABILITY.md (NZR-44).
  - Evidence (not analytics) goes to the audit actions `workflow_test_run`, `workflow_test_step` and `workflow_ready` (ids and hashes only, ADR 0020 §2).

* **Files to change:**

| path | change |
|---|---|
| `src/agent/agent-loop.ts:210-307` (`AgentTurnRequest`) | Add `sandbox?: { mode: 'sealed'; onIntercept: (c: { tool: string; args: unknown }) => void }`. |
| `src/agent/agent-loop.ts:403-412` | When `req.sandbox`, skip `buildMemoryContext`, `listInbox` and `recentHive`. Use the empty fallbacks; do not issue the reads. |
| `src/agent/agent-loop.ts:1076-1100` | When `req.sandbox`, do not call `mcpToolsFor`. The tool list is `tools.listFor(agentId)` (local specs stay visible so the model can attempt them). |
| `src/agent/agent-loop.ts:1510-1545` | When `req.sandbox` and `name` ∉ `SEALED_EXEC_ALLOW` (`['get_time']`), do not dispatch. Set result `{text:'Practice run: not carried out.', isError:false}`, call `req.sandbox.onIntercept({tool:name,args})`, and write `tool_invoke` with `result:'blocked'` and `reason:'sealed_test'`. |
| `src/lib/tools/tool-policy.ts` | Export `SEALED_EXEC_ALLOW` and `sealedDecision(name)` (pure), so the rule is unit-tested in one place. |
| `src/lib/audit/audit-writer.ts:58+, 234` | Add the actions `workflow_test_run`, `workflow_test_step` and `workflow_ready` to the `AuditEvent['action']` union and to `ALWAYS_AUDITED_ACTIONS`. |
| `src/adapters/dashboard/handler.ts` (US-049 `/workflows` block) | Register these routes, all before `GET /workflows/:id`: `GET /workflows/samples`, `POST /workflows/:id/test`, `GET /workflows/:id/test/:runId`, `POST /workflows/:id/test/:runId/cancel`, `POST /workflows/:id/ready`. Each has a 1 KB `bodyLimit` where there is a body, and `Cache-Control: no-store` on the run GET. |
| `src/lib/analytics/events.ts` (US-049) | Allow-list the four new events and their enums. |
| `web/src/App.tsx` (US-049 block) | Add `/workflows/:id/test/:runId` and `/workflows/:id/test` routes **before** `/workflows/:id`, gated `workflows:write`/`workflows:read` with the `plain` prop. They contain `:`, so the drift test skips them (no `ROUTE_TABLE` row). |
| `web/src/pages/studio/WorkflowDetail.tsx` (US-025) | Wire "Try it" to start a try and navigate. Show "Ready" plus "Turning it on comes later." |
| `web/src/lib/studio/api.ts`, `copy.ts` | Add `startTry`, `getRun(…, {fresh:true})`, `cancelRun`, `markReady`, `listSamples`, and all run texts. |
| `web/src/lib/api.ts:160-250` | Add a `fresh` option to `api.get` that bypasses and does not fill the 60 s GET cache (polling must never be served stale). |
| `docs/security-model.md` ("AI steps cannot write" + known limits) | Document the sealed practice-run mode and what it guarantees. |
| `docs/diagrams/architecture-security.md`, `docs/diagrams/request-lifecycle.md` | Required: `handler.ts`, `agent-loop.ts` and `audit-writer.ts` are mapped sources in `docs/diagrams.map`. Add the sealed branch and the new routes. |

* **New files:**
  - `src/lib/workflows/test-runner.ts`:
    - `startTestRun({wfId, userId, sampleId, baseRev})`: preconditions, header put, `writeAuditOrThrow(workflow_test_run started)`, then `setImmediate(executeRun)`.
    - `executeRun(runId)`: steps in order. Per-step put and `writeAuditOrThrow`, then a final conditional status update, then `lastPassedRev` on pass.
    - `readRun(wfId, runId, userId)`: lazily closes a run as timed out.
    - `cancelRun()`.
    - An in-process `Map<runId, AbortController>`.
  - `src/lib/workflows/step-exec.ts`: one function per step kind.
    - agent: a sealed `runAgentTurn` with `chatId:'wftest_'+runId`, `surface:'system'`, `history:[]`, the sample as an `AttachmentBlock` on the first AI step, and the previous outputs in `userText`.
    - decision: a sealed `runAgentTurn` with the previous step's helper, "Answer only YES or NO: <question>", parsed strictly; unparseable means failed "The check couldn't decide."
    - approval: `simulated` with "In a real run, <approver> would be asked to approve here. In this practice run we approved it for you."
    - output: `would_send` with the last AI output as the result text (capped at 8 KB).
  - `src/lib/workflows/test-runs-repo.ts`: create-only puts, forward-only status `ConditionExpression`, the `begins_with` read, and the GSI1 `TESTBY#<userId>` count for the daily limit.
  - `src/lib/workflows/ready.ts`: `markReady(wfId, runId, userId)` with a conditional META update on `draftRev = run.draftRev AND draftSha = run.draftSha`.
  - `src/lib/workflows/samples.ts`: `SAMPLES = [{id:'policy-home-v1', title:'Made-up home insurance policy', format:'pdf', name:'sample-home-policy', bytesBase64}]`.
  - `scripts/studio/make-sample-policy.mjs`: Node built-ins only, no dependency. Writes a minimal text PDF with the header "SYNTHETIC — NOT A REAL POLICY" and 3 planted gaps (a missing flood exclusion wording, an expired endorsement date, and no named insured address). It writes both `src/lib/workflows/samples.generated.ts` and `tests/fixtures/studio/synthetic-home-policy.pdf`.
  - `src/lib/workflows/run-copy.ts`: maps outcomes and reasons to plain text and fixes.
  - `web/src/pages/studio/TryRun.tsx` (W-009 to W-012 states, result first, folded steps) and `web/src/pages/studio/TrySample.tsx` (the "Use a different sample" list).
  - Tests:
    - `src/agent/agent-loop.sealed.test.ts`
    - `src/lib/tools/tool-policy.sealed.test.ts`
    - `src/lib/workflows/test-runner.test.ts`
    - `src/lib/workflows/ready.test.ts`
    - `src/lib/workflows/samples.test.ts`: the PDF bytes' sha256 equals the fixture file's; the text has the synthetic header; no 9-digit SSN-like pattern.
    - `src/lib/workflows/run-copy.test.ts`
    - `src/adapters/dashboard/workflows.test-runs.routes.test.ts`
    - `tests/e2e/studio/try-it.spec.ts`
    - `src/test-utils/network-spy.ts`: a spy on `fetch`, http/https, `net.connect` and `tls.connect`, with `takeCalls()`. Reused by US-031.

* **API contract:** All routes need a bearer token and a person, and are owner only. Every route returns 503 `studio_disabled` when the studio is off.
  - `GET /api/workflows/samples`
    - capability: `workflows:read`
    - 200 `{"samples":[{"id":"policy-home-v1","title":"Made-up home insurance policy","about":"A short pretend policy with a few problems to find."}]}`
  - `POST /api/workflows/:id/test`
    - capability: `workflows:write`
    - body: `{"sampleId":"policy-home-v1","baseRev":3}`, at most 1 KB
    - 202: `{"runId":"run_<ulid>","pollAfterMs":2000}`
    - 400: `unknown_sample` | `bad_request`
    - 404: `not_found`
    - 409: `stale_draft` (`draftRev`) | `needs_setup` (`needs`) | `test_already_running` (`runId`)
    - 413: `body_too_large`
    - 429: `too_many_tests` (`retryAfterS`)
    - 503: `ai_off` (the `bedrock_global` kill switch is on; the page says "Netzar's AI is turned off right now. Try later.")
  - `GET /api/workflows/:id/test/:runId`
    - capability: `workflows:read`
    - header: `Cache-Control: no-store`
    - 200 `{"run":{…}}` with these fields:
      - `"id"`
      - `"status":"running|passed|failed|aborted"`
      - `"reason":"step_failed|audit_unavailable|timed_out|stopped|ai_off"|null`
      - `"draftRev"`, `"outOfDate":bool`, `"stepCount"`, `"currentStep"`, `"startedAt"`, `"endedAt"|null`
      - `"result":{"text":"…","wouldHaveSent":[{"text":"Email to claims@example.test: Policy gaps found"}]}|null`
      - `"steps":[{"n","stepId","what","outcome":"waiting|running|done|simulated|would_send|failed|not_run","summary","fix"|null,"intercepted":[{"text"}]}]`
      - `"canMarkReady":bool`
    - 404: `not_found` (a missing run, a run of another routine, or a routine that is not the caller's)
  - `POST /api/workflows/:id/test/:runId/cancel`
    - capability: `workflows:write`
    - 202
    - 409: `run_finished`
    - 404
  - `POST /api/workflows/:id/ready`
    - capability: `workflows:write`
    - body: `{"runId":"…"}`
    - 200: `{"workflow":{…US-025 shape…}}`
    - 409: `run_not_passed` | `run_out_of_date`
    - 404

* **Data changes:**
  - Studio table (DATA-MODEL §3):
    - TestRun header `WF#<wfId>`/`TEST#<runId>`:
      - fields: `runId`, `draftRev`, `draftSha256`, `sampleId`, `status`, `reason`, `startedBy`, `startedAt`, `deadlineAt`, `endedAt`, `stepCount`, `model`, `tokensIn/Out`, `resultText` (at most 8 KB), `wouldHaveSent[]`;
      - GSI1: `TESTBY#<userId>` / `<startedAt>`;
      - retention: `ttl` +180 days (DATA-MODEL proposal; owner to confirm).
    - Step row `TEST#<runId>#STEP#<nn>`:
      - fields: `stepId`, `kind`, `outcome`, `summary`, `fix`, `inputHash`, `outputHash`, `intercepted[]` (tool plus a redacted preview of at most 300 chars), `model`, `tokens`;
      - create-only, same TTL.
    - Cancel marker `TEST#<runId>#CANCEL`: create-only.
    - META gains `lastPassedRev`, `readyRev`, `readySha256`, and `status:"ready"`.
  - Audit actions are additive. No migration, no backfill.
  - Infra: none beyond NZR-12's studio table. A TTL attribute is already part of DATA-MODEL's table definition.

* **Security notes:**
  - The sealed sandbox is the safety boundary (T3).
    - Enforce it server-side in `agent-loop.ts`, not in the runner. The runner only passes `sandbox`.
    - Fail closed: any tool name not in `SEALED_EXEC_ALLOW` is intercepted. That includes all future tools and both "read-only" tools that reach outside (`salesforce_query`) and tools that read real data (`dynamodb_query`, `search_memories`, `search_hive`).
  - No real data enters a try: memory, inbox and Hive context are skipped, and the only document is the synthetic sample (Q67).
  - Evidence is written with `writeAuditOrThrow`, and the new actions are in `ALWAYS_AUDITED_ACTIONS`, so the `audit_log_disabled` kill switch cannot silently drop them (R1). Detail fields are ids and hashes only. Previews live in the studio row, not the WORM audit.
  - Kill switches are respected:
    - `bedrock_global` refuses the start with `ai_off`;
    - `tool_use` and `tool_dispatch_disabled` mean nothing executes anyway, so interception still records the attempt.
  - Identity comes from `personOf(c)` only. A run belongs to its routine's owner, and every read checks `wfId` + owner + `runId` together, so a foreign run id gives 404.
  - Cost abuse: one running try per routine, 20 per person per day, 6 model calls per try. Viewer can run tries (US-049 decision; see NOTES).
  - The `intercepted` preview is redacted with the existing `redactSync` before storing, and capped at 300 chars.

* **Test plan:**
  - Frozen failing tests first (own commit, red SHA recorded):
    1. `src/lib/tools/tool-policy.sealed.test.ts` › "sealedDecision allows only get_time"
    2. `src/agent/agent-loop.sealed.test.ts` › Scenario 3 and Scenario 4 tests. The pattern follows the existing agent-loop tests: mock `../lib/bedrock/client.js` with a scripted turn sequence, mock `mcp-tools.js`, `sessions-repo.js`, `memory-ingest.js`, `hive-mind-repo.js` and the memory context builder as spies, and use `src/test-utils/network-spy.ts`.
    3. `src/lib/workflows/test-runner.test.ts` › Scenarios 1, 2, 7, 8(c) and 9 (mock `runAgentTurn`, the repo and the audit writer)
    4. `src/lib/workflows/ready.test.ts` › "ready requires a passed run of the current rev and sha"
    5. `src/adapters/dashboard/workflows.test-runs.routes.test.ts` › Scenarios 5, 6 and 8 (US-049 route-test pattern)
    6. `src/lib/workflows/samples.test.ts`, `src/lib/workflows/run-copy.test.ts`
  - Playwright (local, `CCE_STUDIO_MOCK=1`; the mock plugin simulates `running` → `passed`/`failed` across polls): `tests/e2e/studio/try-it.spec.ts`.
  - Commands:
    1. `npx vitest run src/lib/tools/tool-policy.sealed.test.ts src/agent/agent-loop.sealed.test.ts src/lib/workflows/ src/adapters/dashboard/workflows.test-runs.routes.test.ts`
    2. `npm test` (full suite; agent-loop is shared by every surface)
    3. `npm run typecheck`
    4. `npm --prefix web run typecheck && npm --prefix web run build`
    5. `npm run e2e:studio` (serial)
    6. `node scripts/ci/diagrams-drift.mjs`
    7. `node scripts/ci/docs-links.mjs`

* **Repo rules that apply:**
  - A change to `handler.ts`, `agent-loop.ts` or `audit-writer.ts` requires updating `docs/diagrams/architecture-security.md` and `docs/diagrams/request-lifecycle.md` (`docs/diagrams.map`, gate `scripts/ci/diagrams-drift.mjs`).
  - A security-model change requires updating `docs/security-model.md`.
  - No new dependency. The PDF generator and `speechSynthesis` use built-ins only.
  - Full `npm test` before any push. Owner yes for each merge (Q50).

* **Rollback:**
  - Runtime-config `studio/enabled=0` stops new tries (503).
  - Running tries finish or time out on their own deadline.
  - Reverting the code removes the `sandbox` option. That is safe because no caller other than the runner passes it.
  - TestRun rows expire by TTL. Audit rows are permanent by design.
  - If a revert is needed after `status:"ready"` was written, nothing reads it outside the studio, so no live effect remains.

* **Build slices (proposal):**
  1. **Sealed mode in the loop** (`tool-policy.ts`, `agent-loop.ts`, network spy, security-model doc, diagrams). Turns green: tests 1 and 2. **Stop for review here.** This is the safety boundary.
  2. **Runner, repo, samples** (`test-runner.ts`, `step-exec.ts`, `test-runs-repo.ts`, `samples.ts` plus generator, audit actions). Turns green: tests 3 and 6.
  3. **API and Ready** (routes, `ready.ts`, events). Turns green: tests 4 and 5.
  4. **UI** (TryRun, TrySample, preview wiring, `api.get` fresh option, copy, mock plugin states, Playwright). Turns green: `try-it.spec.ts`.

* **Agent gotchas:**
  - `toolDecision` filters denied tools out of the spec list (`agent-loop.ts:1097-1100`). If sealed mode reuses that path, the model never attempts a write and "would have sent" never appears. Intercept at dispatch instead, and keep local specs visible.
  - `mcpToolsFor` opens connections to MCP servers just to list tools (`agent-loop.ts:1082`). Skipping the *invoke* is not enough, because the listing itself is outbound traffic.
  - `softly(...)` swallows read failures (`agent-loop.ts:395-402`). "Skip the read" must mean the promise is never created, or the spy test passes for the wrong reason.
  - `void writeAudit(...)` for `tool_invoke` is fire-and-forget (`:1537`). The step evidence must be the runner's own `writeAuditOrThrow`, awaited before the next step.
  - The in-process `setImmediate` run dies with the task (ECS deploy or restart). That is why `deadlineAt` exists and reads close stuck runs. Do not add a queue.
  - The SPA GET cache serves stale data for 60 s. Polling without the `fresh` option shows "running" forever.
  - `vitest.setup.ts` only trips `http`/`https` dials. The network spy must also cover `fetch`, `net` and `tls`.
  - wouter `<Switch>` takes the first match. Put `/workflows/:id/test/:runId` and `/workflows/:id/test` before `/workflows/:id`.
  - Bedrock document blocks need a `name` (`agent-loop.ts:118`). Use `sample-home-policy` with no dots or spaces.

---

## 5. Estimation & Tracking
* **Epic Name:** M2a Core slice (cycle C2a Core vertical slice (plain Workflows tab), 2026-11-10 to 2026-11-23)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 8 (raw estimate 8 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47). NOTES-E-slice proposes 13, or a split into 26a (sealed mode + runner) and 26b (API, Ready, UI).
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** workflow, urgent, security

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Margaret, 67; trust before real systems; honest Ready).
- [ ] Acceptance criteria cover both happy paths and edge cases (10 scenarios).
- [ ] UX/UI designs are attached and finalized:
  - W-008 to W-012 redone for Q106: one "Try it", result first, steps folded, 20px, Help me, iPad.
  - Queued, cancelling, cancelled, timed out, system error, out of date, and too many tries mocked (NO-MOCK-YET today, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-23, NZR-25, NZR-49 and NZR-12 merged).
- [ ] **Owner answer on Q85 recorded** (sealed sandbox; the recommended yes is built) and on Q106. TestRun TTL of 180 days confirmed.
- [ ] The team has reviewed and estimated the story points (8 pts; 13 or a split proposed; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. T3, full layers (Q68):
  - fresh Claude critic;
  - security reviewer;
  - one Greptile pass;
  - NVIDIA roles after the bake-off;
  - free checks (`npm audit --omit=dev --audit-level=high`, `node scripts/ci/secret-scan.mjs <changed files>`, typecheck);
  - the **owner reviews the sealed-sandbox diff in `agent-loop.ts` and `tool-policy.ts`**.
- [ ] Gates:
  - A frozen failing test came first (red SHA recorded).
  - The gate is green on a clean checkout of the exact HEAD.
  - Full `npm test` is green.
  - `npm run e2e:studio` is green.
  - `node scripts/ci/diagrams-drift.mjs` is green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a demo of a passing try, a failing try, an intercepted write and Mark as ready on a desktop and an iPad viewport (Q51).
- [ ] Documentation is updated:
  - `docs/security-model.md` (sealed practice runs);
  - both mapped diagrams;
  - the feature HANDOFF plus a dated session handoff;
  - the OBSERVABILITY.md event and audit-action catalogue (NZR-44);
  - real screenshots replace the W-008 to W-012 mocks.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
