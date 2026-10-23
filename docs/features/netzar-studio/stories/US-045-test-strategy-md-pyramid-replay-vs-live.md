# [US-045] TEST-STRATEGY.md: pyramid, replay vs live eval, e2e journeys

> Backlog task NZR-45 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-027, NFR-005. Provisional ID: confirmed when the Plane mirror creates it.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** every test layer written down with its real command, when it runs, what it proves and what it cannot prove
* **So that** no gate claims more than its tests show (for example, a green replay run is never reported as a drafter score)

---

## 2. Business Context & Description
* **Background:** Q48 (TEST-STRATEGY is a C1 story). Q66: replay tests the harness only; live eval on each drafter change + nightly; the committed result holds hashes of drafter files, dataset and model; CI fails on mismatch; re-baseline on Bedrock. Q89: live eval on the VPS only, no model keys in GitHub. Q69: one lane, Playwright serial. Q78: `npm ci --prefix web` and Playwright chromium installs only with the owner's yes, one at a time. Q72: drafter < 70% live at Nov 23 stops UI work. FR-027 (continuous regression tests); NFR-005 (WCAG 2.2 AA).
* **Current behaviour (d1d3a66):**
  - **Scripts** (`package.json`): `test` = `vitest run`; `typecheck` = `tsc --noEmit`; `build` = `tsc -p tsconfig.build.json`; `test:integration` = `vitest run --config vitest.integration.config.ts`; `test:integration:up|down|all` (docker compose `docker-compose.test.yml`, LocalStack 3.8 on port 4566); `local:test:integration` (same config with `.env`); `test:paperclip:contract` (needs `PAPERCLIP_TEST_AUTH_SECRET`); `e2e:chat` = `playwright test --config tests/e2e/chat/playwright.config.ts`; `loadtest` = `k6 run tests/load/test-turn.js`; `synth` = `cdk synth`. There is **no** `lint` script and **no** eval script.
  - **Web** (`web/package.json`): only `dev`, `typecheck`, `build`, `preview`. No unit test runner, no axe.
  - **Unit layer:** `vitest.config.ts` includes `src/**/*.test.ts`, `infra/**/*.test.ts`, `scripts/**/*.test.ts`, excludes `*.integration.test.ts`, setup `vitest.setup.ts`. The setup removes AWS credentials and records/refuses any `http`/`https` dial to `*.amazonaws.com`; it does **not** patch `fetch` (`vitest.setup.ts:6-23`). About 2,705 `it(`/`test(` calls in `src/` (grep count; C-40 baseline is 4,634+ tests across the whole suite).
  - **Integration layer:** `vitest.integration.config.ts` includes `src|scripts|tests/**/*.integration.test.ts`; its header mentions `scripts/test-integration.sh`, which does not exist.
  - **E2E layer:** Playwright `@playwright/test` 1.63.0 (root devDependency). `tests/e2e/chat/playwright.config.ts` runs against the **local** Vite dev server on port 5180 with `CCE_CHAT_MOCK=1`, `workers: 1`, `fullyParallel: false` (not a deployed URL; ARCHITECTURE section 6 says otherwise and is wrong). `tests/e2e/jarvis/`, `tests/e2e/tour`, `tests/e2e/staging` target deployed URLs.
  - **CI** (`.github/workflows/ci.yml`): `npm ci`, `npm run typecheck`, `npm run build`, `npm ci --prefix web`, web typecheck + build, `npm test` (`:36-54`); LocalStack integration job (`:83-103`); hermetic `npx cdk synth --quiet --output cdk.out` (`:152`); secret scan over synth output (`:172-194`); rollback dry-run vitest (`:224`); `e2e-chat` job with `npx playwright install --with-deps chromium` + `npm run e2e:chat` (`:288-297`). Docs CI (`.github/workflows/docs-ci.yml:43-113`): `docs-links.mjs`, `feature-knowledge.mjs`, `runnable-blocks.mjs`, `docs-mermaid.mjs`, `diagrams-drift.mjs`, `docs-assets.mjs`.
  - **Port 4566** is used by both LocalStack (`docker-compose.test.yml:15`) and Floci (`docker-compose.local.yml:32`); "Never run both at once" (`docker-compose.local.yml:13`).
  - **Test patterns to reuse:** route tests drive the real router via `app.request()` with `dashboard-auth.js` mocked to role principals (`src/adapters/dashboard/vectors-answer-metering.test.ts`, `chat-uploads.test.ts`; SECURITY.md section 3a); scope tests are named `<module>.scope.test.ts`.
* **Target behaviour:** `docs/features/netzar-studio/foundation/TEST-STRATEGY.md` exists and holds:
  - **Layer table** (one row each): unit, route/permission, integration (LocalStack), replay (NZR-11), live eval (NZR-14/30), sealed-sandbox test-runner checks (NZR-26), e2e journeys, accessibility (axe, NZR-20), infra synth, docs CI, load. Columns: command (real today, or `TARGET:` + the story that adds it), where it runs (VPS / CI / both), when (each commit / PR / drafter change / nightly / release), what it proves, what it cannot prove, RAM note for the 3.9 GB VPS.
  - **Replay vs live:** replay proves the harness (parsing, validation wiring, step recording, error paths) with recorded replies; it **cannot** score a drafter prompt, tool list or model change, because the recordings were made with the old prompt. Any change to a hashed drafter file requires a new live eval result (`mode: live`) committed with matching hashes; CI (NZR-30) recomputes the hashes and fails on mismatch or a lower score. Local live runs on NVIDIA through Floci are labelled "knowledge: keyword, not representative" (NZR-10); production reach waits for a Bedrock re-baseline (Q58).
  - **Journey → e2e map:** each MVP journey in `blueprint.md` section 6 gets one named Playwright spec (TARGET paths under `tests/e2e/studio/`, local Vite + dev mock like `e2e:chat`, serial): J1 first run (NZR-21), J2 build a workflow (NZR-23/24/25/49), J3 test it (NZR-26), J4 teach the company (NZR-27/28/29), J5 admin console (NZR-16), J6 pilot live run (NZR-35/36, C3). The golden workflow spec (NZR-31) is J2+J3 end to end.
  - **Frozen-test rule:** T3 and T2 code steps commit the failing test first and record the red SHA (C-41); the gate runs on a clean checkout of the exact HEAD.
  - **Fixtures:** synthetic only (Q67, C-18), stored in the repo; a CI lint for emails/phones/policy numbers outside an allowlist is TARGET (SECURITY 2b T7).
  - **VPS rules:** one lane; Playwright `workers: 1`; installs one at a time; never run Floci and LocalStack together; `npx vitest run <file>` for focused runs, full `npm test` before push (CLAUDE.md).
  - **Coverage of security claims:** every new route has a lower-principal test that asserts 403/404 **and** that no data-layer or model call happened (SECURITY section 6).
* **Out of scope:** writing any test, script or config (each layer's TARGET names its story); adding `@axe-core/playwright` or any dependency (needs the owner's yes, C-15); the eval harness itself (NZR-14/30); the replay harness (NZR-11).
* **Target Value:** 6 of 6 MVP journeys have a named e2e spec path and owning story; 11 of 11 layers have a command (real or TARGET+story) and a "cannot prove" cell.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). Reads gate evidence; must be able to tell "replay green" from "drafter scored 82% live". PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Every layer names a real command
* **Given** the layer table in `TEST-STRATEGY.md`
* **When** the `COMMANDS` check (Test plan) compares each `npm run <x>` in the table with the keys of `package.json` and `web/package.json` `scripts`
* **Then** every `npm run` name exists, or the cell starts with `TARGET:` and names a story ID; every row has non-empty "when" and "cannot prove" cells
* **Test:** critic command `COMMANDS` › "no unknown npm script outside TARGET cells"

### Scenario 2: Replay limit stated
* **Given** a drafter prompt change
* **When** the reader opens the "Replay vs live" section
* **Then** it says, in these words or stricter: "Replay cannot score a drafter change. Commit a new live eval result with matching hashes"; and it names the hashed inputs (drafter files, dataset, model) and the CI check that fails on mismatch (NZR-30)
* **Test:** critic command `grep -n 'Replay cannot score' docs/features/netzar-studio/foundation/TEST-STRATEGY.md` › "1 match in the Replay vs live section"

### Scenario 3: Every MVP journey has a named e2e test
* **Given** the six journeys in `blueprint.md` section 6
* **When** the critic reads the journey map
* **Then** each journey row has a spec path (`tests/e2e/studio/j<n>-<slug>.spec.ts`), an owning story ID, and the run command (`TARGET: npm run e2e:studio`, added by the first owning story)
* **Test:** critic command `grep -cE 'tests/e2e/studio/j[1-6]-' docs/features/netzar-studio/foundation/TEST-STRATEGY.md` › "6"

### Scenario 4: Accessibility layer is honest about the missing tool
* **Given** the axe row
* **When** the critic reads it
* **Then** it says axe is not installed today (`web/package.json`, root devDependencies), that adding `@axe-core/playwright` is a new dependency needing the owner's yes (C-15), the target (0 serious, 0 critical, C-21) and the owning story NZR-20
* **Test:** critic command `grep -n 'axe' docs/features/netzar-studio/foundation/TEST-STRATEGY.md` › "row with NZR-20, C-15 and 'not installed'"

### Scenario 5: Zero-external-write proof is defined
* **Given** the sealed-sandbox row
* **When** the critic reads it
* **Then** it names both checks: the existing AWS tripwire (`vitest.setup.ts`) and a `fetch` spy plus connector-client spies (because the tripwire does not patch `fetch`), and marks it `PENDING OWNER Q85` with the recommended answer (sealed sandbox: no remote tools, no memory writes, network spy) and what changes if the owner keeps today's write-deny (the claim "nothing was sent anywhere" must then be dropped from the UI copy)
* **Test:** critic command `grep -n 'Q85' docs/features/netzar-studio/foundation/TEST-STRATEGY.md` › "≥ 1 match in the sandbox row"

### Scenario 6: VPS limits written down
* **Given** the "Running on the VPS" section
* **When** the critic reads it
* **Then** it states: one lane; Playwright `workers: 1`; never run LocalStack and Floci at once (both port 4566); installs only with the owner's yes, one at a time (Q78); focused runs with `npx vitest run <file>`; full `npm test` before any push
* **Test:** critic command `grep -n '4566' docs/features/netzar-studio/foundation/TEST-STRATEGY.md` › "≥ 1"

### Scenario 7: Docs CI green
* **Given** the branch HEAD
* **When** `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs` and `node scripts/ci/runnable-blocks.mjs` run
* **Then** all exit 0 (shell blocks in the doc are not marked runnable, or carry valid runnable-block annotations)
* **Test:** existing Docs CI jobs

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-9 / US-009](US-009-foundation-plan-docs-user-stories-this-docs.md) Foundation PLAN docs + user stories (this docs PR)
* **UI/UX Design:** N/A: documentation.
* **Non-Functional Requirements:** Playwright runs serially on the VPS (Q69). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.
* **Steps:**
  1. Builder (docs lane): write the `COMMANDS` check; run it on an empty table (red).
  2. Builder: write sections: 1 Purpose and what "green" means; 2 Layer table; 3 Replay vs live; 4 Sealed sandbox proof (PENDING OWNER Q85); 5 Journey → e2e map; 6 Accessibility; 7 Security tests pattern; 8 Fixtures and data rules; 9 Running on the VPS; 10 CI map (which job runs which layer, with `ci.yml` line numbers); 11 Known gaps (no lint script, no web unit runner, no axe, stale `scripts/test-integration.sh` reference, ARCHITECTURE section 6 Playwright claim).
  3. Builder: link from `docs/features/netzar-studio/README.md` section 4 and from CONSTRAINTS C-21/C-41 rows.
  4. Builder: run checks + Docs CI (green); session handoff.
  5. Fresh critic re-runs (T1: free checks).
* **Artifacts:** `docs/features/netzar-studio/foundation/TEST-STRATEGY.md` (new; frontmatter `feature: netzar-studio`, `document_role: decision`, `status: current`, `observed_at`, `as_of_commit`); link lines in the feature `README.md` and `foundation/CONSTRAINTS.md`.
* **Evidence:** red then green `COMMANDS` output; Docs CI output; HEAD SHA.
* **Security notes:** test data is synthetic only; no recorded reply may contain customer text (DATA-MODEL section 5: CI gets recorded replies and synthetic eval cases only). No model keys in GitHub (Q89): the doc must not propose a CI job that calls a model. Recorded replies and eval cases are hashed so a poisoned recording cannot raise the score unnoticed (SECURITY 2b T7).
* **Test plan:** docs only; no vitest. Commands:
  - `COMMANDS`: read-only one-off that reads `package.json` and `web/package.json` `scripts` keys, extracts every `npm run <name>` and `npm --prefix web run <name>` from `TEST-STRATEGY.md`, and prints names that are missing and not on a `TARGET:` line.
  - Greps in Scenarios 2-6.
  - Docs CI: `node scripts/ci/feature-knowledge.mjs && node scripts/ci/docs-links.mjs && node scripts/ci/runnable-blocks.mjs`.
* **Repo rules that apply:** `docs/features/README.md` (frontmatter, no sprawl); `docs/runnable-blocks.md` (annotated shell blocks are schema-checked by `runnable-blocks.mjs`); CLAUDE.md (full `npm test` before pushing); no new dependency without the owner's yes.
* **Rollback:** revert the docs commit.
* **Build slices (proposal):**
  1. `COMMANDS` red + sections 1-4 (layers, replay vs live, sandbox) → Scenarios 1, 2, 5.
  2. Sections 5-11 (journeys, a11y, security, fixtures, VPS, CI map, gaps) + links → Scenarios 3, 4, 6, 7.
* **Agent gotchas:**
  - Do not copy ARCHITECTURE section 6's "Playwright only … against a deployed URL"; `e2e:chat` is local (`tests/e2e/chat/playwright.config.ts:3-8`).
  - `npm test` excludes `*.integration.test.ts`; integration needs Docker + port 4566 free.
  - `vitest.setup.ts` blocks `*.amazonaws.com` over `http`/`https` only; a `fetch` to NVIDIA or any other host is not blocked. Zero-write claims need an explicit spy.
  - A shell block in the doc may be parsed by `runnable-blocks.mjs`; use plain fenced `text` blocks or valid annotations.
  - Do not write `npm run lint`; it does not exist.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T1 · **Deploy reach:** local only · **Labels:** docs, eval

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases (real commands, replay limit, journeys, axe gap, zero-write proof, VPS limits, CI).
- [ ] UX/UI designs: N/A: documentation.
- [ ] Dependencies have been identified and are unblocked (NZR-9; Q85 open: the doc records the recommendation and both outcomes).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Docs follow docs/features/README.md; no file under src/, web/ or infra/.
- [ ] Peer code review is completed and approved. Free checks only (Q68): docs CI, secret scan on the diff.
- [ ] Docs CI green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/runnable-blocks.mjs`; `COMMANDS` prints nothing.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; README source-of-truth row links TEST-STRATEGY.md.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: N/A: docs only.
