# [US-010] Local model env: Floci + NVIDIA dev backend (test data only)

> Backlog task NZR-10 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-009.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** the local stack to answer real, streamed agent turns with tool use from an NVIDIA-hosted model, through the app's unchanged Bedrock client, using seeded test data only
* **So that** we can build and evaluate the drafter before the AWS account exists (measured: one streamed local turn that calls a tool, finishes, and leaves a token-usage row; 0 prompts sent to NVIDIA that are not from the committed test-data set)

---

## 2. Business Context & Description
* **Background:**
  - Bedrock is unavailable to dev until NZR-42 (the AWS account).
  - Q65: NVIDIA is fine as the dev model backend with test data only; no repo code goes to NVIDIA without the owner's yes on the free-tier terms.
  - Q90: bump the dev-only Floci container to 2.1 or later and use keyword search for knowledge until Bedrock exists. The Docker pull is a download and needs the owner's (Zion's) yes; verify 2.1 exists and is compatible. Keyword search means local drafter knowledge scores are not representative.
  - [ARCHITECTURE.md](../foundation/ARCHITECTURE.md) risk R3: "NZR-10 'no app code change' holds for chat only". Embeddings fail locally, so keyword search needs a small, local-only code change.
  - PRD NFR-009 (spending limits): the turn must still pass through the cost gate and token tracker. CONSTRAINTS C-16 (model data), C-14 (secrets), C-15 (no new dependency).
  - Terms: **Floci** is the local AWS emulator on port 4566 (a LocalStack replacement). Its **proxy backend** forwards Bedrock `Converse`/`ConverseStream` calls to any OpenAI-compatible `/chat/completions` endpoint, such as NVIDIA's. **Pinned by digest** means the image reference includes `@sha256:<hash>`, so the same bytes run every time.
* **Current behaviour (d1d3a66):**
  - `docker-compose.local.yml:26` pins `image: floci/floci:1.6.0` with no digest. No Bedrock backend variable is set, so Floci uses its `stub` backend (`docker-compose.local.yml:33-41`). The VPS already has `floci/floci:1.6.0` pulled (`docker image inspect`: `floci/floci@sha256:eab36252ea43a4a73928423f0372219052c5c6f87207f6c4754db14b91d6ed30`).
  - Floci changelog (`/root/floci/CHANGELOG.md`, checkout `0517a7a` 2026-10-19): ConverseStream for stub and proxy backends lands in 2.1.0 (`CHANGELOG.md:1451-1452`, inside the 2.1.0 section at `:1086`). 2.0.0 is a major release whose only BREAKING CHANGE is Step Functions JSONata (`CHANGELOG.md:1867-1873`); `src/`, `scripts/local/` and `infra/lib/` use no Step Functions (grep). Latest listed is 2.3.0 (`CHANGELOG.md:5`, 2026-10-15), which adds proxy fixes: abandoned calls stopped and error bodies kept out of logs (`CHANGELOG.md:36-38`).
  - Floci proxy facts (`/root/floci/docs/services/bedrock-runtime.md`): config variables at `:34-41`; ConverseStream proxied incrementally, with a mid-stream failure reported as an in-band `modelStreamErrorException` (`:21`); tool config translated (`:26`); `InvokeModel` is never proxied and always returns the stub (`:11,20`). Token usage is translated from OpenAI `usage` (`src/main/java/.../bedrockruntime/backend/BedrockOpenAiTranslator.java:40,362-366,427-431` in the Floci checkout; UNVERIFIED that this exact code ships in the chosen image tag).
  - The app has a local-only escape hatch for ConverseStream returning 501 (`src/lib/bedrock/client.ts:410-428`, gated on `AWS_ENDPOINT_URL`). With 2.1+ it should no longer trigger.
  - Embeddings call `InvokeModel` with `amazon.titan-embed-text-v2:0` (`src/lib/vectors/embedder.ts:18,34-55`) and throw `Titan returned no embedding` when the body has no `embedding` field (`embedder.ts:51-53`), which is what the Floci stub returns (`development.md:800-801`, limitation 4).
  - So locally: ingest stores nothing (`src/lib/vectors/ingest.ts:157-196`, "embedding failed for all ... chunks; nothing indexed"), and the agent tool `s3_vectors_search` returns `Embedding failed: ...` (`src/lib/tools/vector-tools.ts:113-121`). Search ranks only by cosine similarity (`src/lib/vectors/store.ts:333-370`). There is no keyword search anywhere in `src/lib/vectors/`.
  - Model ids are Bedrock ids, e.g. `BEDROCK_DEFAULT_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0` (`.env.local.example:52`), so the proxy needs a model mapping.
  - A read-only built-in tool exists for a safe tool call: `get_time` (`src/lib/tools/builtin-tools.ts:17-30`, `readOnly: true`).
  - Turns record token usage through `recordUsage` (`src/agent/agent-loop.ts:45`; `src/lib/usage/token-tracker.ts:20,133`, table `TABLE_TOKEN_USAGE`, default `claudeclaw-token-usage`) and are admitted by the spend gate (`agent-loop.ts:46`, `src/lib/cost/ledger-gate.ts`).
  - Deployed tasks are detected by `isDeployedTask` (`src/config/env.ts:384-391`). Nothing stops a deployed task from starting with `AWS_ENDPOINT_URL` set. SECURITY.md T7 asks for exactly that check ("with a test proving it").
  - `npm run local` creates `.env` from `.env.local.example` if missing (`scripts/local/dev.mjs:6,40-48`); every local script reads `--env-file=.env` (`package.json:29-33`).
  - `docs/data-flows.json` has no NVIDIA entry (flow ids: slack-payloads ... github-releases-update-check); T7 requires a dev-only `nvidia-dev-models` entry.
* **Target behaviour:**
  1. `docker-compose.local.yml` pins Floci 2.3.0 by digest (`floci/floci:2.3.0@sha256:<digest>`), after the owner's yes for the pull. The default backend stays `stub`, so `npm run local:up` without the NVIDIA overlay behaves as today, plus real streaming events.
  2. A new overlay `docker-compose.local.nvidia.yml` switches Floci to the `proxy` backend pointed at NVIDIA's OpenAI-compatible endpoint, maps every configured Bedrock model id to one NVIDIA model, and reads the key only from the shell (`NVIDIA_DEV_API_KEY`). The key never enters the app process, `.env`, or the clone.
  3. A local smoke script `scripts/local/nvidia-smoke.ts` sends one fixed prompt from `scripts/local/fixtures/nvidia-dev-prompts.json` through `POST /api/test-turn/stream` and checks: a `get_time` tool call happened, the stream finished, and a token-usage row exists with input tokens > 0.
  4. Knowledge search uses keyword scoring when, and only when, `AWS_ENDPOINT_URL` is set **and** `KNOWLEDGE_SEARCH_MODE=keyword`. Ingest then stores chunks with an empty embedding, and `s3_vectors_search` ranks by keyword overlap and starts its result with `[knowledge: keyword, not representative]`.
  5. A deployed task refuses to start if `AWS_ENDPOINT_URL` or `KNOWLEDGE_SEARCH_MODE` is set (T7).
  6. A fixture lint test fails if the NVIDIA prompt set holds an email, phone number or policy-number-shaped string (T7, risk #8).
  7. `development.md` "Known local limitations" 1-4 and a new "NVIDIA dev backend" runbook section describe the above; `docs/data-flows.json` gets the `nvidia-dev-models` entry.
* **Out of scope:**
  - Live and recorded evals and their hashes: NZR-11 / [US-011](US-011-recorded-reply-harness-for-model-calls-in.md) (replay harness) and the eval stories.
  - Keyword search for the dashboard routes `POST /api/vectors/search` and `/api/vectors/answer` (`handler.ts:3332-3420`). They keep failing locally; changing `handler.ts` also triggers the `docs/diagrams.map` drift gate. Only the agent tool path the drafter uses changes.
  - Sending repo code to NVIDIA (needs the owner's yes on the terms, Q65), and the NVIDIA builder/reviewer routes (NZR-40 / [US-040](US-040-gauntlet-model-routing-on-the-vps-codex.md)).
  - Real embeddings in dev (a different embedding backend). Semantic search returns when Bedrock exists (NZR-42).
  - Guardrails (not emulated, R3).
* **Target Value:** `npx tsx --env-file=.env scripts/local/nvidia-smoke.ts` exits 0 on the VPS (one streamed turn, one `get_time` call, one token-usage row with `inputTokens > 0`); 100% of NVIDIA-bound prompts come from the fixture file (lint test green); 0 deployed-task starts with `AWS_ENDPOINT_URL` (env test green).
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Floci upgraded safely
* **Given** Floci pinned at 1.6.0 (no streaming, no embeddings) and the owner's yes for `docker pull floci/floci:2.3.0`
* **When** `docker-compose.local.yml:26` is changed to `floci/floci:2.3.0@sha256:<digest printed by the pull>` and the existing local checks run: `npm run local:up`, `npm run local:verify`, `npm run local:provision`, `npx tsx --env-file=.env scripts/seed.ts`
* **Then** each exits 0; `local:verify` reports account `000000000000` (`scripts/local/guard.ts`); the container health check `/_localstack/health` passes (still served in 2.x, `/root/floci/docs/getting-started/migrate-from-localstack.md:126`); and `docker compose -f docker-compose.local.yml config` shows the image with `@sha256:`
* **Test:** `scripts/local/compose-pin.test.ts` › "floci image is 2.1 or later and pinned by sha256 digest" (reads the YAML as text; no Docker needed)
* **Test (evidence, attended):** the four command outputs saved under `~/.claude/plans/netzar-logs/nzr-10-floci-upgrade.log`

### Scenario 2: Streamed turn with a tool call (happy path)
* **Given** Floci running with the NVIDIA overlay, `NVIDIA_DEV_API_KEY` set in the shell only, the seeded `main` agent, and the local orchestrator running
* **When** `scripts/local/nvidia-smoke.ts` posts the fixture prompt `"What time is it in UTC? Use the get_time tool."` to `POST /api/test-turn/stream` with `{"agentId":"main","text":<prompt>,"persistTurns":false}` and the local dashboard token
* **Then** the HTTP status is 200; the SSE stream holds at least two text chunks, one `event: tool` whose JSON `label` is `get time` (`humanizeToolName('get_time')`, `src/lib/tools/humanize.ts:18-40`; the raw name is not sent) followed by an `event: tool_result`, and a final `event: done` with data `ok` (`handler.ts:2502,2507,2574`); an `event: error` (`handler.ts:2589`) fails the run; afterwards `claudeclaw-token-usage` (local DynamoDB) has a row for this turn with `inputTokens > 0`; the script prints `NVIDIA SMOKE OK model=<nvidia model> tokens_in=<n> tokens_out=<n>` and exits 0
* **Test:** `scripts/local/nvidia-smoke.ts` (attended, real call; not part of `npm test`) and `scripts/local/nvidia-smoke.test.ts` › "parses a recorded SSE stream and requires a get_time tool event and a done event" (synthetic SSE text; no network)
* UNVERIFIED: the SSE event name used for text chunks (written by `chunkWriter`, called from `guardedChunkWriter`, `handler.ts:546-551`, and depends on `body.protocol`); read `chunkWriter` before writing the parser.

### Scenario 3: Model error mid-stream (degraded)
* **Given** the overlay points at an endpoint that drops the connection mid-stream, or returns HTTP 401 (bad key)
* **When** the smoke script runs
* **Then** it exits 1 and prints `NVIDIA SMOKE FAILED: <ModelErrorException|modelStreamErrorException|401>` without printing the key or any response body; no token-usage row claims more tokens than were streamed
* **Test:** `scripts/local/nvidia-smoke.test.ts` › "reports a stream error and never echoes the key" (synthetic SSE with an error event; a fake key string checked to be absent from output)

### Scenario 4: Keyword search caveat
* **Given** `AWS_ENDPOINT_URL=http://127.0.0.1:4566` and `KNOWLEDGE_SEARCH_MODE=keyword`, and a seeded document with chunks "renewal date is 1 March" and "claims phone line hours"
* **When** `ingest_document` stores it and `s3_vectors_search` runs with query `"renewal date"`
* **Then** ingest calls no `InvokeModel` and stores two rows with `embedding: []`; search calls no `embedOne`; the top hit is the "renewal date" chunk; the tool text starts with `[knowledge: keyword, not representative]`
* **Test:** `src/lib/tools/vector-tools.keyword.test.ts` › "keyword mode ranks by term overlap, skips embeddings and labels the result" and `src/lib/vectors/keyword.test.ts` › "scores term overlap, ignores case and punctuation, returns 0 for no overlap"

### Scenario 5: Keyword mode cannot switch on outside local
* **Given** `KNOWLEDGE_SEARCH_MODE=keyword` but no `AWS_ENDPOINT_URL`
* **When** `s3_vectors_search` runs
* **Then** it uses `embedOne` and cosine search exactly as today (no label); and, separately, `loadEnv()` with `NODE_ENV=production` plus `AWS_ENDPOINT_URL` or `KNOWLEDGE_SEARCH_MODE` set throws `Refusing to start: local emulator settings on a deployed task: AWS_ENDPOINT_URL` (or `KNOWLEDGE_SEARCH_MODE`)
* **Test:** `src/lib/tools/vector-tools.keyword.test.ts` › "without AWS_ENDPOINT_URL keyword mode is ignored" and `src/config/env.test.ts` › "a deployed task refuses AWS_ENDPOINT_URL and KNOWLEDGE_SEARCH_MODE"

### Scenario 6: Only test data goes to NVIDIA
* **Given** `scripts/local/fixtures/nvidia-dev-prompts.json`
* **When** the fixture lint runs, and the smoke script is started with `--prompt "<any text>"` or a prompt id not in the file
* **Then** the lint fails on any string matching an email, a phone number (7+ digits with separators) or a policy-number pattern unless it is on the file's `allowlist`; the smoke script exits 2 with `REFUSED: prompts must come from scripts/local/fixtures/nvidia-dev-prompts.json` and sends nothing
* **Test:** `scripts/local/nvidia-fixtures.test.ts` › "NVIDIA prompt fixtures hold synthetic data only" and `scripts/local/nvidia-smoke.test.ts` › "refuses a prompt that is not in the fixture file"

### Scenario 7: Key stays out of the app and the clone
* **Given** the overlay and a clean clone
* **When** `docker compose -f docker-compose.local.yml -f docker-compose.local.nvidia.yml config` runs without `NVIDIA_DEV_API_KEY` in the shell
* **Then** it fails with `NVIDIA_DEV_API_KEY is required for the NVIDIA overlay`; with the key set, the key appears only under the `floci` service environment, never in `.env`, `.env.local.example` or the app's environment; `netzar-clone.sh check` (NZR-3) still prints `CLONE CLEAN`
* **Test:** `scripts/local/compose-pin.test.ts` › "nvidia overlay requires NVIDIA_DEV_API_KEY via ${VAR:?} and sets it only on floci" (text check of the YAML)

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-3 / US-003](US-003-clean-clone-builder-workspace-on-the-vps.md) Clean-clone builder workspace on the VPS (no .env, lockfile installs)
* **UI/UX Design:** N/A: developer environment.
* **Non-Functional Requirements:**
  - Local only. No deployed code path changes: keyword mode needs `AWS_ENDPOINT_URL`, and a deployed task refuses that variable.
  - No new dependency (C-15): keyword scoring is plain TypeScript; YAML checks in tests are text/regex based.
  - Floci 2.3.0 must fit the VPS RAM next to the app (3.9 GB total, C-55). Record `docker stats --no-stream netzer-os-floci` in the upgrade log. UNVERIFIED: 2.x memory use.
  - NVIDIA free tier has rate limits (UNVERIFIED numbers); the smoke script makes one turn per run.
  - Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step. Standard token-usage rows from the local turn; standard audit entries only.
* **Files to change:**

  | path | change |
  |---|---|
  | `docker-compose.local.yml` lines 21-26 | Image → `floci/floci:2.3.0@sha256:<digest>`; update the comment to say why 2.x (ConverseStream proxy) and that the digest came from the owner-approved pull. |
  | `src/config/env.ts` lines 361-370 (`loadEnv`, inside `if (isDeployedTask(...))`) | Before `missingDeployConfig`, throw `Refusing to start: local emulator settings on a deployed task: <names>` when `AWS_ENDPOINT_URL` or `KNOWLEDGE_SEARCH_MODE` is set. |
  | `src/lib/vectors/ingest.ts` lines 157-198 | When `isKeywordMode()`, skip `embedMany` and build rows with `embedding: []`; keep the "nothing indexed" error for the normal path. |
  | `src/lib/vectors/store.ts` lines 333-370 (`search`) | Accept `query?: string`; when `isKeywordMode()` and `query` is given, score each row with `keywordScore(query, row.text)` instead of `cosineSimilarity`. Same top-K, tag filter and score floor logic. |
  | `src/lib/tools/vector-tools.ts` lines 113-131 and the result text | In keyword mode do not call `embedOne`; pass `query` to `search`; prefix the result text with `[knowledge: keyword, not representative]`. |
  | `.env.local.example` after line 52 | Add `KNOWLEDGE_SEARCH_MODE=keyword` with a comment (local only; deployed tasks refuse it). Never a bare `KEY=` (`development.md:221`). |
  | `development.md` lines 783-801 (Known local limitations 1-4) and a new section after them | Rewrite 1-4 for Floci 2.3.0 and the NVIDIA overlay; add "NVIDIA dev backend" runbook: owner yes on terms first, key in the shell only, fixture prompts only, the smoke command, how to switch back to stub. |
  | `docs/data-flows.json` (`flows` array) | Add `{"id":"nvidia-dev-models", "processor":"NVIDIA (build.nvidia.com hosted models)", "dataCategories":["synthetic test prompts from scripts/local/fixtures/nvidia-dev-prompts.json","seeded agent system prompt","model output"], "direction":"outbound", "when":"Local development only, when the NVIDIA overlay is used", "optOut":"Do not use docker-compose.local.nvidia.yml", "status":"dev-only", "notes":"Never in a deployed install; Q65, SECURITY.md T7"}`. UNVERIFIED: allowed `status` values; copy the field set from an existing entry. |
  | `/root/.claude/bin/netzar-clone.sh` (NZR-3, VPS factory) | `check`: accept an untracked `.env` only if it is byte-identical to `.env.local.example` (all fake values, created by `npm run local`); anything else still fails. |

* **New files:**
  - `docker-compose.local.nvidia.yml`: overlay for the `floci` service only: `FLOCI_SERVICES_BEDROCK_RUNTIME_BACKEND: proxy`, `..._PROXY_URL: https://integrate.api.nvidia.com/v1` (the host the factory already uses for NVIDIA, `/root/.hermes/skills/software-development/gauntlet-loop/references/hermes-adaptation.md:21`; UNVERIFIED that `/v1/chat/completions` there accepts OpenAI tool calls for the chosen model), `..._PROXY_API_KEY: ${NVIDIA_DEV_API_KEY:?NVIDIA_DEV_API_KEY is required for the NVIDIA overlay}`, `..._PROXY_MODEL_MAPPING: us.anthropic.claude-sonnet-4-5-20250929-v1:0=${NVIDIA_DEV_MODEL:?...}`, `..._PROXY_DEFAULT_MODEL: ${NVIDIA_DEV_MODEL:?...}`.
  - `src/lib/vectors/keyword.ts`: `isKeywordMode(env = process.env)` and `keywordScore(query, text)` (lower-case word tokens, share of query terms found, 0..1).
  - `src/lib/vectors/keyword.test.ts`, `src/lib/tools/vector-tools.keyword.test.ts`: unit tests (Scenarios 4-5).
  - `scripts/local/nvidia-smoke.ts`: the attended smoke turn (Scenario 2); `--prompt-id <id>` only.
  - `scripts/local/nvidia-smoke.test.ts`: SSE parsing, error and refusal tests with synthetic text.
  - `scripts/local/fixtures/nvidia-dev-prompts.json`: `{"allowlist": [], "prompts": [{"id": "get-time-utc", "text": "What time is it in UTC? Use the get_time tool."}]}`.
  - `scripts/local/nvidia-fixtures.test.ts`: synthetic-data lint (Scenario 6).
  - `scripts/local/compose-pin.test.ts`: digest pin and overlay checks (Scenarios 1, 7).
* **API contract:** N/A: no API change. The smoke script uses the existing `POST /api/test-turn/stream` (capability `chat:read` plus operator for the send, `src/adapters/dashboard/handler.ts:2203-2215`; body `{agentId?, text, chatId?, persistTurns?}`).
* **Data changes:** None in deployed data. Local only: vector rows written in keyword mode have `embedding: []`. They must not be read by cosine search: `cosineSimilarity` on an empty vector — UNVERIFIED behaviour; guard so keyword-mode rows score 0 in cosine mode, and tell developers to run `npm run local:reset` when switching modes. Forward-only; rollback = `local:reset`.
* **Security notes:**
  - SECURITY.md T7 (prompts leave AWS; synthetic-only lint; key never in a deployed install; data-flow entry; endpoint override test) and risk #8 (NVIDIA dev path on unread terms). C-16.
  - PENDING OWNER (terms): SECURITY.md T7 says the owner says yes to the NVIDIA free-tier terms "before the first call", while Q65 only gates repo code on that yes. Recommended: treat T7 as binding: no NVIDIA call, even with test data, until the owner's yes is recorded (NZR-40's `~/.claude/gauntlet-consent.json`). If the owner says test data may go first, only the DoR line changes.
  - The key: owner creates a dev-only NVIDIA key; it lives in `~/.config/netzar/nvidia-dev.env` (mode 600, outside any clone) and is exported into the shell only for `docker compose ... up`. It is never written to `.env`, logs, the step log or the smoke output.
  - What goes to NVIDIA: the fixture prompt, the seeded `main` agent's system prompt, tool specs and model output. UNVERIFIED: whether the seeded system prompt or injected Hive/memory text holds anything beyond seed data; read `scripts/seed.ts` and `src/agent/agent-loop.ts:412` (Hive injection) and keep `persistTurns:false`.
  - No authz change. Keyword mode is not a security boundary; scope rules in `vector-tools.ts:96-111` stay as they are.
* **Test plan:**
  - Frozen failing tests first: `src/lib/vectors/keyword.test.ts`, `src/lib/tools/vector-tools.keyword.test.ts`, the new case in `src/config/env.test.ts`, `scripts/local/compose-pin.test.ts`, `scripts/local/nvidia-fixtures.test.ts`, `scripts/local/nvidia-smoke.test.ts`.
  - Mocks follow `src/lib/tools/vector-tools.scope.test.ts:10-13` (`vi.mock` of `embedder.js`, `store.js`, `ingest.js`); assert `embedOne` was **not** called in keyword mode.
  - Fixtures: synthetic chunks and SSE text only. `vitest.config.ts:9` already includes `scripts/**/*.test.ts`.
  - Commands: `npx vitest run src/lib/vectors/keyword.test.ts src/lib/tools/vector-tools.keyword.test.ts src/config/env.test.ts scripts/local/`, then full `npm test`, `npm run typecheck`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/diagrams-drift.mjs`, `node scripts/ci/secret-scan.mjs --denylist scripts/ci/denylist.txt scripts/local`.
  - Attended (owner present, after the pull yes and terms yes): Scenario 1 commands, then `docker compose -f docker-compose.local.yml -f docker-compose.local.nvidia.yml up -d --wait`, `npm run local` in another shell, `npx tsx --env-file=.env scripts/local/nvidia-smoke.ts --prompt-id get-time-utc`.
* **Repo rules that apply:**
  - No new dependency without the owner's yes (C-15).
  - `handler.ts` is not changed, so no `docs/diagrams.map` update is needed (`architecture-security.md` maps `src/adapters/dashboard/handler.ts` and `src/agent/agent-loop.ts`; do not touch either).
  - A new outbound flow adds a `docs/data-flows.json` entry (SECURITY.md:251).
  - `.env` rules in `development.md:221-232`: no bare `KEY=`, never `NODE_ENV=production` locally.
  - Full `npm test` before any push (CLAUDE.md:46); every push/merge needs the owner's yes (Q50).
* **Rollback:** Revert the image line to `floci/floci:1.6.0` (the old image is still on the VPS); stop using the overlay (stub backend returns); unset `KNOWLEDGE_SEARCH_MODE` and run `npm run local:reset`; revert the code commit. No deployed data is touched.
* **Build slices (proposal):**
  1. **Floci pin (config):** `compose-pin.test.ts` red → owner yes → pull → digest pin → Scenario 1 commands green; upgrade log saved.
  2. **NVIDIA overlay + smoke:** overlay file, fixtures, lint test, smoke script and its tests; attended smoke run after the terms yes (Scenarios 2, 3, 6, 7).
  3. **Keyword mode:** `keyword.ts`, store/ingest/tool changes, env refusal; Scenarios 4-5 green; `.env.local.example`.
  4. **Docs:** `development.md` limitations and runbook, `data-flows.json`, NZR-3 `check` exception.
* **Agent gotchas:**
  - Port 4566 is shared: `docker-compose.test.yml:12` runs `localstack/localstack:3.8` on the same port for integration tests. Never run both at once.
  - `docker compose --env-file` replaces the default `.env` lookup for interpolation; export the key in the shell instead and keep the app's `.env` untouched.
  - The proxy maps by exact Bedrock model id. Any model id the app picks (`BEDROCK_SONNET_MODEL`, `BEDROCK_HAIKU_MODEL`, fallbacks in `client.ts:138-139`) that is not mapped falls to `PROXY_DEFAULT_MODEL`; set it, or the call fails.
  - `InvokeModel` (embeddings) is never proxied, even in proxy mode. Do not try to "fix" embeddings through Floci.
  - With `persistTurns:false` the `done` data may be `not_saved` rather than `ok` (`handler.ts:2574`: `saved ? 'ok' : 'not_saved'`); accept both.
  - Pick an NVIDIA model that supports OpenAI tool calling, or Scenario 2 cannot pass. UNVERIFIED which hosted models do; the owner picks it (`NVIDIA_DEV_MODEL`).
  - `isLocalUnsupportedStream` (`client.ts:423-428`) should stop firing with 2.x; do not delete it in this story (1.6.0 rollback still needs it).
  - Tests must not depend on `AWS_ENDPOINT_URL` leaking from the shell: `vitest.setup.ts` neutralises the environment (`development.md:548-551`); set it inside each test with `vi.stubEnv`.
  - `npm run local` writes `.env` into the clone; NZR-3's `check` fails on it until the `.env.local.example` exception lands (slice 4) — do slice 4's clone change before the first attended run, or run `check` before `npm run local`.
  - The owner's name for the pull yes is "Zion" in Q90; the yes is recorded in the step log with the owner's words.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** devenv

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Factory operator; one streamed local turn with a tool call, test data only).
- [ ] Acceptance criteria cover both happy paths and edge cases (7 scenarios: upgrade, streamed tool turn, stream error, keyword mode, keyword-mode containment, test-data-only, key containment).
- [ ] UX/UI designs: N/A: developer environment.
- [ ] Dependencies have been identified and are unblocked (NZR-3 clean clone). Owner yes recorded for the `floci/floci:2.3.0` pull (Q90) and on the NVIDIA free-tier terms (T7); owner has created a dev-only NVIDIA key and picked `NVIDIA_DEV_MODEL`.
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail): compose pin, one overlay, one keyword helper, three small `src/lib` edits, one env check, smoke script, docs.
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (`npm audit --omit=dev`, secret scan, typecheck; lint is N/A, the repo has none) + step maid (Q68, T2). Codex built it, so Codex does not review it.
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary (upgrade log, `NVIDIA SMOKE OK` line, keyword-mode test output).
- [ ] Documentation is updated: `development.md` limitations + NVIDIA runbook, `docs/data-flows.json`, feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
