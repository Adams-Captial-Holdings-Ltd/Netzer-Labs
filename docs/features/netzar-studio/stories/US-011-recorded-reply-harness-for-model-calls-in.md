# [US-011] Recorded-reply harness for model calls in tests

> Backlog task NZR-11 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-027.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** unit tests to answer every Bedrock model call from a committed recording file, matched by a hash of the request, and to fail by name when a recording is missing
* **So that** CI is free and deterministic (measured: 0 network dials and $0 model spend in replay tests; the same test gives the same result on every run)

---

## 2. Business Context & Description
* **Background:**
  - Q66: "Replay tests the harness only." Recorded replies prove the plumbing around model calls (streaming, tool-use loops, retries, cost math). They never stand in for the live eval, which scores the drafter on each drafter change and nightly.
  - [DATA-MODEL.md](../foundation/DATA-MODEL.md) line 124: an EvalResult has `mode live|replay`; line 185: "Recorded replies can pass while live drifts, so the gate must read `mode=live`". Line 164: CI may hold recorded replies and synthetic eval cases, never live customer content or credentials.
  - PRD FR-027 (published workflows run continuous regression tests) needs model-dependent tests that run in CI without a model.
  - Terms: a **recording** is a JSON file holding one model request (normalised) and the reply to return. **Replay mode** means the harness answers calls from recordings and never dials out. **Request hash** is a SHA-256 of the normalised request; it is the recording's file name.
* **Current behaviour (d1d3a66):**
  - One Bedrock client factory: `bedrockClient()` memoises one `BedrockRuntimeClient` wrapped by `captureAwsClient` (`src/lib/bedrock/client.ts:35-39`). `captureAwsClient` returns the client unchanged unless `CCE_XRAY_ENABLED === '1'` (`src/lib/observability/xray.ts:24-26,50-51`).
  - Model calls go through `client.send(...)` in `converseTurn` (`client.ts:345-357`, `ConverseCommand`), `converseStreamTurn` (`client.ts:440-460`, `ConverseStreamCommand`), the agent loop (`src/agent/agent-loop.ts:1411,1604`), and Jarvis (`src/adapters/dashboard/jarvis.ts:691`). Embeddings use a separate client and `InvokeModelCommand` (`src/lib/vectors/embedder.ts:11,36-49`).
  - The stream consumer reads `contentBlockDelta.delta.text`, `contentBlockDelta.delta.toolUse.input`, `messageStop.stopReason` and `metadata.usage` (`client.ts:498-518`).
  - Every test that needs a model reply hand-builds one. Example: `src/lib/bedrock/client.p2.test.ts:16-20` mocks `../observability/xray.js` so `captureAwsClient` returns `{ send }`, and `streamOf()` (`:32-40`) builds a fake stream. There is no shared harness; this pattern appears in one file only (grep for `captureAwsClient: () =>`).
  - `vitest.setup.ts:6-26,60-110` neutralises AWS credentials and refuses any `http`/`https` dial to `*.amazonaws.com`, failing the test in `afterEach`. It does not refuse dials to other hosts (e.g. `127.0.0.1:4566`), and does not patch `fetch` (`vitest.setup.ts:24`).
  - Shared test helpers live in `src/__test-utils__/` (`aws-guard.test.ts`, `fake-dynamo.ts`, `localstack.ts`). `vitest.config.ts:9` collects `src/**/*.test.ts`, `infra/**/*.test.ts`, `scripts/**/*.test.ts`. No mocking library such as `aws-sdk-client-mock`, `nock` or `msw` is in `package.json` (grep).
  - CI's secret scan covers only `cdk.out` and `scripts/lib/lifecycle` (`.github/workflows/ci.yml:192-197`).
* **Target behaviour:**
  1. A test-only module `src/__test-utils__/recorded-replies.ts` exports `useRecordedReplies(dir, opts?)`. It replaces `BedrockRuntimeClient.prototype.send` for the current test file (via `vi.spyOn`) and restores it in `afterEach`/`afterAll`.
  2. For `ConverseCommand`, `ConverseStreamCommand` and `InvokeModelCommand` it builds a normalised request (command name, `modelId`, `system`, `messages`, `toolConfig`, `inferenceConfig`, `guardrailConfig`, and for `InvokeModel` the parsed `body`). Keys are sorted, byte blocks are replaced by their SHA-256. It hashes that and loads `<dir>/<hash16>.json`.
  3. It returns the SDK output shape: `{ output, stopReason, usage }` for Converse; `{ stream: AsyncIterable<event> }` for ConverseStream; `{ body: Uint8Array }` for InvokeModel. A recording may hold an ordered list of replies (for retry tests). A reply may be an error (`{ "error": { "name", "message" } }`), which is thrown with that `name`.
  4. A missing recording throws `RecordedReplyMissing` naming the op, model, hash, expected file path, and which top-level request fields differ from the closest recording of the same op and model.
  5. Any other AWS command sent to a `BedrockRuntimeClient` (e.g. `ApplyGuardrailCommand`) throws `RecordedReplyUnsupported: <CommandName>`.
  6. `isReplayActive()` returns true while the harness is installed, so a later eval runner can stamp `mode: "replay"` (DATA-MODEL line 124).
  7. A fixture lint test fails if any recording holds a secret-shaped string, an email or a phone number, or is not `source: "synthetic"` / `source: "recorded-local"`. CI's secret scan also covers the recordings folder.
  8. `client.p2.test.ts` keeps its own mocks. One new test file proves the harness against the real `converseTurn` and `converseStreamTurn`.
* **Out of scope:**
  - The live eval, its hashes and the CI hash gate (eval stories after NZR-10; Q66). Replay never produces a drafter score.
  - Recording against a real model. Recordings in this story are hand-written synthetic files. A `record` mode that captures replies from local Floci → NVIDIA (NZR-10 / [US-010](US-010-local-model-env-floci-nvidia-dev-backend.md)) is a later task; see NOTES.
  - Changing `src/lib/bedrock/client.ts` or any production module. This story adds test-only code.
  - Migrating existing tests to the harness.
* **Target Value:** replay tests make 0 `http`/`https` dials (any host) and 0 `fetch` calls, asserted in the harness test; a request with no recording fails 100% of the time with the expected path in the message; `npx vitest run src/__test-utils__/recorded-replies.test.ts` gives the same pass result on 3 consecutive runs (critic check).
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Streamed reply replays with no network (happy path)
* **Given** `useRecordedReplies('src/__test-utils__/model-replies/harness')` and a recording for a `ConverseStream` request to `us.anthropic.claude-haiku-4-5-20251001-v1:0` with system `"You are a test."`, user text `"Say hi"`, holding events `contentBlockDelta "Hi"`, `contentBlockDelta " there"`, `messageStop end_turn`, `metadata usage {inputTokens: 7, outputTokens: 2}`
* **When** the test calls `converseStreamTurn({ modelId, systemPrompt: 'You are a test.', userText: 'Say hi' }, { onChunk })` (with `./guard.js` and `../safety/fault-injector.js` mocked as in `client.p2.test.ts:21-22`)
* **Then** it resolves `{ text: 'Hi there', stopReason: 'end_turn', inputTokens: 7, outputTokens: 2 }`; `onChunk` saw `'Hi'` then `'Hi there'`; spies on `http.request`, `https.request` and `globalThis.fetch` were called 0 times
* **Test:** `src/__test-utils__/recorded-replies.test.ts` › "replays a ConverseStream recording through converseStreamTurn with no network"

### Scenario 2: Non-streamed reply with a tool call
* **Given** a `Converse` recording whose output message has a `toolUse` block `{ name: 'get_time', toolUseId: 'tu-1', input: {} }` and `stopReason: 'tool_use'`
* **When** `converseTurn` is called with the matching input and a `tools` list naming `get_time`
* **Then** the raw SDK output seen by the caller contains the `toolUse` block unchanged and `stopReason` is `'tool_use'`
* **Test:** `src/__test-utils__/recorded-replies.test.ts` › "replays a Converse recording with a toolUse block"

### Scenario 3: Mismatch fails loudly
* **Given** recordings exist only for user text `"Say hi"`
* **When** a test sends the same request with user text `"Say hello"`
* **Then** the call rejects with an error whose `name` is `RecordedReplyMissing` and whose message contains `ConverseStream`, the model id, the 16-hex hash, the expected path `src/__test-utils__/model-replies/harness/<hash16>.json`, and `differs from closest recording in: messages`; no network call is made
* **Test:** `src/__test-utils__/recorded-replies.test.ts` › "a request with no recording fails naming the expected file and the differing field"

### Scenario 4: Retry path uses an ordered reply list
* **Given** a recording whose `replies` are `[{ "error": { "name": "ThrottlingException", "message": "slow down" } }, { <normal stream> }]`
* **When** `converseStreamTurn` runs with `maxRetries: 2` under `vi.useFakeTimers()` (`withRetry` waits with a real `setTimeout` between attempts, `client.ts:304-340`)
* **Then** the first send throws `ThrottlingException`, `withRetry` (`client.ts:304`) retries (`ThrottlingException` is retryable, `isRetryable`, `client.ts:295-302`), the second send returns the stream and the turn resolves; a third send of the same request in the same test throws `RecordedReplyExhausted: <hash16> has 2 replies`
* **Test:** `src/__test-utils__/recorded-replies.test.ts` › "ordered replies drive the retry path and run out loudly"

### Scenario 5: Same request, same key, every time (determinism)
* **Given** two requests equal except for key order in `toolConfig` and an `abortSignal` passed to `send`
* **When** the harness hashes them
* **Then** both give the same hash; a request whose `inferenceConfig.temperature` differs gives a different hash; a request with an image block hashes the image bytes' SHA-256, never the raw bytes
* **Test:** `src/__test-utils__/recorded-replies.test.ts` › "request hash ignores key order and abort signals but not inference settings"

### Scenario 6: Broken or unsupported input fails closed
* **Given** a recording file that is not valid JSON, or has `schema` other than `1`, or a test that sends `ApplyGuardrailCommand` through a `BedrockRuntimeClient`
* **When** the call is made
* **Then** it rejects with `RecordedReplyCorrupt: <path>: <reason>` or `RecordedReplyUnsupported: ApplyGuardrailCommand`; the harness never falls back to the real `send`
* **Test:** `src/__test-utils__/recorded-replies.test.ts` › "corrupt recordings and unsupported commands never reach the real client"

### Scenario 7: Recordings hold no secrets or personal data
* **Given** every `*.json` under `src/__test-utils__/model-replies/`
* **When** the fixture lint runs
* **Then** it fails, naming file and JSON path, on: an AWS key id (`AKIA`/`ASIA` + 16), `ghp_`, `sk-ant-`, `sk-or-`, `nvapi-`, a JWT (`eyJ...\..*\.`), an email address, a phone number (7+ digits with separators), or a `source` other than `synthetic` or `recorded-local`; CI's `secret-scan.mjs` step lists `src/__test-utils__/model-replies` as a path
* **Test:** `src/__test-utils__/model-replies.lint.test.ts` › "recorded replies hold synthetic data only"

### Scenario 8: The harness cleans up and reports its mode
* **Given** a test file that installs the harness in one `describe` block only
* **When** a later test in the same file runs outside that block
* **Then** `BedrockRuntimeClient.prototype.send` is the original function again and `isReplayActive()` is `false`; inside the block it is `true`
* **Test:** `src/__test-utils__/recorded-replies.test.ts` › "restores the real send after the block and reports replay mode"

---

## 4. Technical Notes & Constraints
* **Dependencies:** None.
* **UI/UX Design:** N/A: test tooling.
* **Non-Functional Requirements:**
  - Replay files contain no secrets or personal data (Scenario 7). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
  - No new dependency (C-15): use `vi.spyOn`, `node:crypto` and `node:fs` only; do not add `aws-sdk-client-mock`.
  - Each recording file under 64 KB; the folder under 1 MB (keeps the repo small; checked by the lint test).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.
* **Files to change:**

  | path | change |
  |---|---|
  | `.github/workflows/ci.yml` lines 192-197 (Scan for secret patterns) | Add `src/__test-utils__/model-replies` to the `secret-scan.mjs` path list. |
  | `development.md` section "Testing Netzar OS features" (line 470) | Add a short "Recorded model replies" note: what replay proves (harness only, Q66), how to add a recording, the file format, and that replay results are never a drafter score. |

* **New files:**
  - `src/__test-utils__/recorded-replies.ts`: `useRecordedReplies(dir, { onMissing?: 'throw' })`, `requestHash(command)`, `isReplayActive()`, error classes `RecordedReplyMissing`, `RecordedReplyExhausted`, `RecordedReplyCorrupt`, `RecordedReplyUnsupported`.
  - `src/__test-utils__/recorded-replies.test.ts`: Scenarios 1-6 and 8.
  - `src/__test-utils__/model-replies.lint.test.ts`: Scenario 7.
  - `src/__test-utils__/model-replies/harness/*.json`: the synthetic recordings the tests use (about 5 files).
  - `src/__test-utils__/model-replies/README.md`: file format and the "synthetic only" rule.
* **API contract:** N/A: no API change. Recording file contract (schema 1):

  ```json
  {
    "schema": 1,
    "op": "Converse | ConverseStream | InvokeModel",
    "modelId": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "requestHash": "<64-hex sha256 of the normalised request>",
    "request": { "system": [], "messages": [], "toolConfig": null, "inferenceConfig": {}, "guardrailConfig": null },
    "replies": [
      { "events": [ { "contentBlockDelta": { "delta": { "text": "Hi" } } }, { "messageStop": { "stopReason": "end_turn" } }, { "metadata": { "usage": { "inputTokens": 7, "outputTokens": 2 } } } ] }
    ],
    "source": "synthetic",
    "note": "why this recording exists"
  }
  ```

  Converse replies use `{ "output": {...}, "stopReason": "...", "usage": {...} }`; InvokeModel replies use `{ "body": <JSON value> }` (encoded to bytes by the harness); an error reply is `{ "error": { "name": "...", "message": "..." } }`. File name = first 16 hex of `requestHash`; the harness checks the full hash inside the file and treats a mismatch as `RecordedReplyCorrupt`.
* **Data changes:** None: test fixtures only. No table, key or S3 prefix changes. Rollback = delete the files.
* **Security notes:**
  - SECURITY.md T7 (tampering line, `SECURITY.md:121`): "a poisoned eval case or recorded reply could raise the score". This harness never produces a score, and `isReplayActive()` lets the eval runner mark `mode: "replay"` so a later gate can refuse it (DATA-MODEL line 185).
  - SECURITY.md risk #11 and boundary B8: the CI secret scan is blind to `src/`; Scenario 7 and the extra CI path cover the new fixture folder.
  - DATA-MODEL line 164: recordings are CI data; only synthetic content. Never paste a live customer conversation or a real system prompt from an install.
  - No authz, audit or secrets handling in production code changes (none changes).
* **Test plan:**
  - Frozen failing tests first: `src/__test-utils__/recorded-replies.test.ts` (8 cases incl. Scenario 7's lint in `model-replies.lint.test.ts`), committed before `recorded-replies.ts` exists (red = import fails).
  - Fixtures: hand-written synthetic recordings under `src/__test-utils__/model-replies/harness/`. To get a request hash for a new file, the missing-recording error prints it (Scenario 3); copy it into the new file.
  - Mocks: keep `./guard.js` and `../safety/fault-injector.js` mocked as in `client.p2.test.ts:21-22` (the guard reads DynamoDB). Spy on `http.request`, `https.request`, `globalThis.fetch` to prove zero dials.
  - Commands: `npx vitest run src/__test-utils__/recorded-replies.test.ts src/__test-utils__/model-replies.lint.test.ts`; then full `npm test` and `npm run typecheck`; `node scripts/ci/secret-scan.mjs --denylist scripts/ci/denylist.txt src/__test-utils__/model-replies`; `node scripts/ci/docs-links.mjs` for the doc edit.
* **Repo rules that apply:**
  - No new dependency without the owner's yes (C-15).
  - Test helpers go in `src/__test-utils__/` (existing layout); tests use vitest `*.test.ts` (`vitest.config.ts:9`).
  - `tsconfig.build.json` includes `src/**/*` and excludes only `**/*.test.ts` and `**/test-helpers.ts` (not `src/__test-utils__/**`), so `fake-dynamo.ts` and `localstack.ts` already compile into `dist/`. None of them import `vitest`. The harness does (`vi.spyOn`), so it must not land in `dist/`: either take `vi` as a parameter (`useRecordedReplies(vi, dir)`) and use `import type` only, or add `src/__test-utils__/recorded-replies.ts` to the build `exclude`. Recommended: the parameter, so no build config changes. No non-test module imports `src/__test-utils__/` (grep).
  - Full `npm test` before any push (CLAUDE.md:46); every push/merge needs the owner's yes (Q50).
  - No `handler.ts` change, so no `docs/diagrams.map` update.
* **Rollback:** Delete the new files and revert the `ci.yml` and `development.md` lines. No production code or data is touched.
* **Build slices (proposal):**
  1. **Tests (red) + hashing:** `recorded-replies.test.ts` and lint test; implement `requestHash` and normalisation; turns Scenario 5 green.
  2. **Replay core:** prototype spy, file loading, Converse/ConverseStream/InvokeModel shapes, ordered replies, errors, cleanup, `isReplayActive`; turns Scenarios 1-4, 6, 8 green.
  3. **Fixture hygiene + docs:** lint test, `ci.yml` scan path, `model-replies/README.md`, `development.md` note; turns Scenario 7 green.
* **Agent gotchas:**
  - `bedrockClient()` memoises its instance (`client.ts:35-39`), so patching an instance after first use misses later tests; patch `BedrockRuntimeClient.prototype.send`, which also covers the embedder's own client. If `CCE_XRAY_ENABLED=1` in a test, the X-Ray wrapper may bypass the prototype; the harness should refuse to install when it is set.
  - `vi.mock('../observability/xray.js', ...)` in `client.p2.test.ts` replaces `send` entirely; do not combine it with this harness in one file.
  - The SDK `send` is called as `send(command, { abortSignal })` (`client.ts:356,459`); hash `command.input` only, and keep honouring the abort signal (reject with `AbortError` when already aborted).
  - The ConverseStream reply must be a fresh async iterable on each call; reusing one generator breaks the retry test.
  - Agent-loop prompt helpers read the clock (e.g. `buildCrossSurfaceNote`'s `nowSec = Date.now()` default, `agent-loop.ts:357-360`); tests that replay agent-loop turns should fix time with `vi.useFakeTimers()`/`vi.setSystemTime`, or the request hash may change between runs. Not needed for this story's client-level tests.
  - `vitest.setup.ts` only blocks `*.amazonaws.com`; a test pointed at `127.0.0.1:4566` would pass silently through it. The harness test must spy on `http.request`/`https.request`/`fetch` itself.
  - Do not put recordings under `tests/fixtures/`: `vitest.config.ts:9` does not collect `tests/**`, and the lint test must find them.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** devenv, eval

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Factory operator; free, deterministic, offline model tests).
- [ ] Acceptance criteria cover both happy paths and edge cases (8 scenarios: stream replay, tool-use replay, mismatch, retry list, hash determinism, corrupt/unsupported, fixture hygiene, cleanup/mode).
- [ ] UX/UI designs: N/A: test tooling.
- [ ] Dependencies have been identified and are unblocked (none; record mode against Floci/NVIDIA is deferred, so NZR-10 is not needed).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail): one test-only module, two test files, synthetic recordings, one CI path, one doc note.
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (`npm audit --omit=dev`, secret scan incl. `src/__test-utils__/model-replies`, typecheck; lint is N/A, the repo has none) + step maid (Q68, T2). Codex built it, so Codex does not review it.
- [ ] A frozen failing test came first (red SHA recorded); the gate (`npx vitest run src/__test-utils__/recorded-replies.test.ts src/__test-utils__/model-replies.lint.test.ts`) is green on a clean checkout of the exact HEAD; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria (3 runs, same result). UAT: N/A, no user-facing change; the owner accepts the evidence summary.
- [ ] Documentation is updated: `src/__test-utils__/model-replies/README.md`, `development.md` note, feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
