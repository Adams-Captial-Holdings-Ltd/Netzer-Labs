# [US-040] Gauntlet model routing on the VPS: Codex builds, fresh Claude critic, NVIDIA roles after bake-off

> Backlog task NZR-40 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-009.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** every gauntlet role (builder, critic, security reviewer, external reviewer) checked against my routing rules before it starts, with every pick and every refusal written to the step's route log
* **So that** code is built cheaply by Codex, always checked by someone other than its builder, and never sent to NVIDIA before I say yes (measured: 100% of steps have a route log with a Jev line; 0 steps where the critic session equals a builder session; 0 NVIDIA calls without a consent record)

---

## 2. Business Context & Description
* **Background:**
  - Owner decisions: Q59 (VPS gauntlet-loop builds Netzar; Codex builds; fresh Claude critic; NVIDIA review roles only after a bake-off; engdept parked), Q51 (reviewers are the fresh Claude critic, the security reviewer and later NVIDIA roles; Codex reviews only code someone else built), Q65 (no repo code to NVIDIA until the owner reads the free-tier terms and says yes; NVIDIA builders only if they pass a bake-off on small tasks).
  - CONSTRAINTS C-16 (model data), C-47 (builder never certifies its own work), C-51 (factory spend cap $250, alert $125). PRD NFR-009 (enforce spending limits).
  - Terms: **Jev** is the cheap decision model the gauntlet asks first (`/root/.claude/bin/jev.sh`, OpenRouter `typesafe/jev-1.13`). A **route** is the (role, provider, model, session) a piece of work runs on. A **bake-off** is a measured trial against the Claude critic before a free model may take a role.
* **Current behaviour (VPS factory, verified 2026-10-23):**
  - The Claude copy of the skill already says Codex builds and Claude verifies: "Codex writes the code every time" (`/root/.claude/skills/gauntlet-loop/SKILL.md:1141-1168`), Build Ladder luna/sol/astra with Claude fallbacks (`:1373-1398`), Codex never certifies its own work (`:1584-1608`), builder/critic separation (`:1817-1832`), Jev Job 1 picks the lowest model (`:1246-1256`), every Jev answer is recorded as `JEV: <question> → <answer> (<confidence>)` (`:1335`).
  - These are prose rules only. Nothing checks them: there is no helper that refuses a route, and no record ties a critic session to the builder session.
  - "Codex reviews only code someone else built" is not written anywhere. `SKILL.md:2359-2372` allows "optional cross-provider Codex inspection" of Claude-built work, default `CODEX_REVIEW: OFF`, and says nothing about Codex-built work.
  - NVIDIA appears as review layer L3 (`/root/.claude/skills/gauntlet-loop/references/review-gauntlet.md:27,53`) with no consent gate of its own; the vps-doctor run recorded L3 as NOT RUN because it was not set up (`~/.claude/plans/vps-doctor-review-report.md:11`).
  - A review-role bake-off already exists in code: `/root/.claude/bin/gauntlet-evals.mjs:274` (`BAKEOFF = { steps: 20, recall: 0.7, precision: 0.6, failure: 0.1 }`) and `:297-319` (`bakeoffMetrics` for `role-a`..`role-e`). There is no builder bake-off: the `build_attempt` rung enum (`gauntlet-evals.mjs:66-69`) has no NVIDIA rung.
  - Jev decisions for lanes are logged by `/root/.claude/bin/decide.sh:42-46` to `~/.claude/plans/<slug>/decisions.jsonl`; single-lane steps call `jev.sh` directly and log by hand.
  - The Hermes copy says the opposite of the owner: `/root/.hermes/skills/software-development/gauntlet-loop/references/hermes-adaptation.md:21` ("Small code: NVIDIA-hosted models ... Code review: Codex") and `:27-30` ("builders run on the cheapest NVIDIA-hosted model ... Codex reviews code"). `/root/.hermes/engineering/policy.json:22` still says Codex is not installed; `codex --version` prints `codex-cli 0.163.0`.
* **Target behaviour:**
  1. A zero-dependency helper `/root/.claude/bin/route-guard.mjs` (same style as `review-ledger.mjs`) checks a route before it starts and appends one JSON line per check to the step's route log.
  2. Rules it enforces: (a) any `nvidia` route needs an owner consent record; (b) an `nvidia` **builder** also needs a passed builder bake-off; (c) the critic is always `claude` in a session id no builder of that step used; (d) a `codex` critic, security reviewer or reviewer is refused when Codex built any of the step's code; (e) a refused builder route prints the fallback (`codex`, same rung).
  3. The owner's consent lives in `~/.claude/gauntlet-consent.json` (mode 600), written by the coordinator only after the owner's yes in chat, quoting it. No file, or a broken file, means "no consent" (fail closed).
  4. `route-guard.mjs summary --step <id>` prints the line the step log needs: `ROUTE: builder codex/<model> (s:<id>) | critic claude/<model> (s:<id>) | JEV: model -> <choice> (<conf>)`.
  5. `SKILL.md` gains a short "VPS routing rules" section that tells the coordinator to call `route-guard.mjs check` before every Codex launch, critic dispatch, security review and external review, and states "Codex never reviews Codex-built code".
  6. `review-gauntlet.md` L3 says NVIDIA roles run only with the consent record; without it L3 is `NOT RUN (no owner yes on NVIDIA terms)`.
  7. The Hermes `hermes-adaptation.md` routing rows are replaced with the owner's rules, so no copy of the skill says NVIDIA builds or Codex reviews its own work.
* **Out of scope:**
  - Running the bake-off itself (needs the consent first; collects data over 20+ steps). This story only builds the gate and the record.
  - Review depth per tier and Kodus/CodeRabbit/Greptile: NZR-41 / [US-041](US-041-review-gauntlet-v2-wiring-q68-tier-policy.md).
  - The clean clone and push guard: NZR-3 / [US-003](US-003-clean-clone-builder-workspace-on-the-vps.md).
  - NVIDIA as the **app's** dev model backend (test data only): NZR-10 / [US-010](US-010-local-model-env-floci-nvidia-dev-backend.md). That path sends synthetic prompts, not repo code, and is governed by Q65's second half.
  - Reviving engdept or editing `/root/.hermes/engineering/policy.json` (parked, Q59); noted in NOTES only.
* **Target Value:** 100% of steps have `ROUTE:` and `JEV:` lines in the step log; 0 steps where critic session == a builder session; 0 `nvidia` routes allowed without a consent record (count of `allowed` lines with `provider: nvidia` and no consent = 0); factory spend stays under the $250 cap (`node ~/.claude/bin/gauntlet-evals.mjs report`, `step_cost` totals).
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Routed step (happy path)
* **Given** step `nzr-12.s1`, Jev's Job 1 answer `model -> sol (0.86)` recorded, and no consent file
* **When** the coordinator runs `route-guard.mjs check --step nzr-12.s1 --role builder --provider codex --model gpt-6-sol --session A`, then `check --role critic --provider claude --model opus --session B`, then `summary --step nzr-12.s1`
* **Then** both checks exit 0 and print `ROUTE OK`; the route log has two lines with `"result": "allowed"`; `summary` prints exactly `ROUTE: builder codex/gpt-6-sol (s:A) | critic claude/opus (s:B) | JEV: model -> sol (0.86)`
* **Test:** `/root/.claude/bin/route-guard.test.mjs` › "allows codex builder and fresh claude critic and prints the summary line"

### Scenario 2: No NVIDIA builder before consent
* **Given** no `~/.claude/gauntlet-consent.json`
* **When** `check --role builder --provider nvidia --model <any> --session C` runs
* **Then** it exits 4, prints `ROUTE REFUSED: nvidia needs the owner's yes on the NVIDIA free-tier terms (Q65)` and `FALLBACK: codex/<same rung>`; the route log line has `"result": "refused", "reason": "no_nvidia_consent", "fallback": "codex"`
* **Test:** `/root/.claude/bin/route-guard.test.mjs` › "refuses an nvidia builder without consent and names the codex fallback"

### Scenario 3: No NVIDIA reviewer before consent
* **Given** no consent record
* **When** `check --role reviewer --provider nvidia --model <any> --session D` runs
* **Then** it exits 4 with `ROUTE REFUSED: nvidia needs the owner's yes ...` and prints `LAYER: L3 NOT RUN (no owner yes on NVIDIA terms)`; no fallback reviewer is substituted
* **Test:** `/root/.claude/bin/route-guard.test.mjs` › "refuses an nvidia reviewer without consent and marks L3 NOT RUN"

### Scenario 4: Codex never reviews code Codex built
* **Given** a builder route `codex/gpt-6-sol` recorded for the step
* **When** `check --role reviewer --provider codex ...` or `check --role security --provider codex ...` runs
* **Then** it exits 4 with `ROUTE REFUSED: codex built this step; codex may not review it (Q51)`; and, on a different step whose only builder was `claude/opus` (Codex limit hit), the same Codex reviewer check exits 0
* **Test:** `/root/.claude/bin/route-guard.test.mjs` › "refuses codex reviewing codex-built work and allows it on claude-built work"

### Scenario 5: The critic is a fresh Claude session
* **Given** builder session `A` recorded for the step
* **When** a critic check uses `--session A`, or uses `--provider codex`, or runs before any builder is recorded
* **Then** each exits 4 with, in order, `ROUTE REFUSED: critic session A also built this step`, `ROUTE REFUSED: the critic must be a fresh Claude session`, `ROUTE REFUSED: no builder recorded for this step`
* **Test:** `/root/.claude/bin/route-guard.test.mjs` › "refuses a reused, non-claude or premature critic"

### Scenario 6: Consent alone does not let NVIDIA build
* **Given** a consent record `{"nvidia": {"terms_yes": true, "ts": "...", "owner_text": "yes, I read the terms"}}` without `build_bakeoff_passed`
* **When** an `nvidia` builder check runs, and then an `nvidia` reviewer check runs
* **Then** the builder check exits 4 with `ROUTE REFUSED: nvidia builders need a passed bake-off (Q65)` and `FALLBACK: codex/...`; the reviewer check exits 0 and prints `ROUTE OK (advisory until bake-off qualifies)`
* **Test:** `/root/.claude/bin/route-guard.test.mjs` › "consent allows advisory nvidia review but not nvidia builds"

### Scenario 7: Broken inputs fail closed
* **Given** a consent file that is not valid JSON, or a route log line that is not valid JSON
* **When** any `check` runs
* **Then** it exits 5 with `ROUTE NOT CHECKED: <file> is unreadable; fix it by hand` and records nothing; an unknown `--role` or `--provider` exits 2 with a usage line
* **Test:** `/root/.claude/bin/route-guard.test.mjs` › "corrupt consent or log refuses; bad flags are usage errors"

### Scenario 8: Jev is down
* **Given** `jev.sh` exits 1 (stubbed via `JEV_SH`)
* **When** the coordinator records the model pick with `route-guard.mjs jev --step <id> --unavailable --advisor sonnet --answer sol`
* **Then** `summary` prints `JEV: unavailable -> advisor (sonnet): sol` instead of a confidence; a step with neither a Jev line nor an advisor line makes `summary` exit 4 with `MISSING: no Jev or advisor pick recorded`
* **Test:** `/root/.claude/bin/route-guard.test.mjs` › "records an advisor pick when Jev is down and flags a step with no pick"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-3 / US-003](US-003-clean-clone-builder-workspace-on-the-vps.md) Clean-clone builder workspace on the VPS (no .env, lockfile installs)
* **UI/UX Design:** N/A: no user interface in this step.
* **Non-Functional Requirements:**
  - `route-guard.mjs` uses Node built-ins only, runs in under 200 ms, and holds an exclusive lock around read-check-append (copy the `withLock` pattern from `/root/.claude/bin/review-ledger.mjs:88-109`).
  - Spend stays inside the factory cap ($250, alert $125; C-51). This story adds no paid call; Jev costs about $0.00002 per call (`hermes-adaptation.md:20`).
  - Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event. Factory records: one route-log line per check; the existing `jev_decision` and `build_attempt` events in `~/.claude/gauntlet-eval-events.jsonl` (`references/agent-evals.md:80-82`) are still recorded by the coordinator as today.
* **Files to change:**

  | path | change |
  |---|---|
  | `/root/.claude/skills/gauntlet-loop/SKILL.md` end of Build Ladder (just before `# Effort and Usage Routing`, line 1399) | New section "VPS routing rules (owner, Q51/Q59/Q65)": call `route-guard.mjs check` before every Codex launch, critic, security review and external reviewer; a refused builder uses the printed fallback; `summary` line goes in the step log; NVIDIA needs `~/.claude/gauntlet-consent.json`. |
  | `/root/.claude/skills/gauntlet-loop/SKILL.md` lines 2359-2372 (Verification of Claude-Built Work) and 1584-1608 (Codex Authorship Invariant) | Add: "Codex never reviews code Codex built (Q51). It may review Claude-built code." |
  | `/root/.claude/skills/gauntlet-loop/SKILL.md` lines 1817-1832 (Builder / Critic Separation) | Add: "Enforced by `route-guard.mjs`: the critic's session id must differ from every builder session of the step." |
  | `/root/.claude/skills/gauntlet-loop/references/review-gauntlet.md` line 53 (L3 row) and line 207 (readiness row) | L3 runs only when the consent record exists; otherwise `REVIEW: L3 NOT RUN (no owner yes on NVIDIA terms)`. Bake-off results come from `gauntlet-evals.mjs report`. |
  | `/root/.hermes/skills/software-development/gauntlet-loop/references/hermes-adaptation.md` lines 21 and 25-35 | Replace the "Model routing (owner rule)" row and "Build provider" text with: Codex builds; fresh Claude critic; Codex reviews only others' code; NVIDIA only after the owner's yes and a bake-off; Netzar uses the Claude copy (Q59). |

* **New files:**
  - `/root/.claude/bin/route-guard.mjs`: `check | jev | summary | selftest`. Env overrides: `GAUNTLET_ROUTES` (log path, default `~/.claude/plans/<slug>-logs/routes.jsonl` via `--slug`), `GAUNTLET_CONSENT` (default `~/.claude/gauntlet-consent.json`).
  - `/root/.claude/bin/route-guard.test.mjs`: `node:test` suite for the 8 scenarios (same layout as `/root/.claude/bin/gauntlet-evals.test.mjs`).
* **API contract:** N/A: no API change. CLI contract:

  | command | exit 0 | 2 | 4 | 5 |
  |---|---|---|---|---|
  | `check --slug S --step ID --role builder\|critic\|security\|reviewer --provider codex\|claude\|nvidia\|openrouter --model M --session SID` | `ROUTE OK` (+ note) | usage | `ROUTE REFUSED: <why>` (+ `FALLBACK:` / `LAYER:`) | file unreadable |
  | `jev --slug S --step ID (--question Q --choice C --confidence N \| --unavailable --advisor R --answer C)` | recorded | usage | — | file unreadable |
  | `summary --slug S --step ID` | prints `ROUTE: ... \| JEV: ...` | usage | `MISSING: ...` | file unreadable |

  Route-log line: `{"ts","step","role","provider","model","session","result":"allowed"|"refused","reason":null|"no_nvidia_consent"|"no_build_bakeoff"|"codex_self_review"|"critic_reused_session"|"critic_not_claude"|"no_builder","fallback":null|"codex"}`.
  Consent file: `{"nvidia": {"terms_yes": true, "ts": ISO, "owner_text": "<=200 chars", "build_bakeoff_passed": false}}`.
* **Data changes:** None in the product. New factory files above; forward-only JSONL logs; nothing migrates.
* **Security notes:**
  - SECURITY.md T7 (eval and NVIDIA data leaving AWS), risk #8 (NVIDIA prompts on unread terms) and #11 (factory agents with write access); boundary B8.
  - The consent file is written only by the coordinator after the owner's yes in chat (Q65); a work order's `DO NOT` list (`SKILL.md:1527-1528`) adds "never write `gauntlet-consent.json`". Jev never decides consent (`SKILL.md:1267`: Jev's recommendations "do not cover the owner's own gates").
  - Fail closed: a missing or broken consent file means no NVIDIA. The route log stores model ids and session ids, never prompts, diffs or keys.
  - `route-guard` reads no API key and makes no network call. Keys stay in `~/.config/gauntlet/jev.env` (Jev) and the provider's own login (Codex `~/.codex/auth.json`).
* **Test plan:**
  - Frozen failing tests first: `/root/.claude/bin/route-guard.test.mjs` with the 8 scenarios, written before `route-guard.mjs` (red = module not found).
  - Fixtures: temp dirs for the route log and consent file per test; a stub `JEV_SH` for Scenario 8. No network, no real model.
  - Commands: `node --test /root/.claude/bin/route-guard.test.mjs`; `node /root/.claude/bin/route-guard.mjs selftest`; regressions `node --test /root/.claude/bin/gauntlet-evals.test.mjs`, `node /root/.claude/bin/review-ledger.mjs selftest`, `bash /root/.claude/bin/test/test-decide.sh`.
  - Attended check: on the next real Netzar step, the step log carries the `ROUTE:` and `JEV:` lines and `routes.jsonl` has a refused-NVIDIA line if one was tried.
* **Repo rules that apply:** No Netzer-Labs change, so repo rules (nav sync, diagrams map, capability map, audit helpers) do not apply. Applies: no new dependency (Node built-ins only); Codex builds the helper (Q59) and a fresh Claude critic reviews it; Codex may not review it.
* **Rollback:** Remove the `route-guard.mjs` calls from `SKILL.md` (one section) and delete the two new files; revert the doc edits from the factory snapshot (NZR-3 slice 1). Existing logs can stay; nothing else reads them.
* **Build slices (proposal):**
  1. **Tests (red):** `route-guard.test.mjs`, all 8 scenarios failing.
  2. **Core checks:** `check` with consent, bake-off, self-review and critic-session rules, lock, fail-closed reads; turns Scenarios 1-7 green.
  3. **Jev + summary:** `jev` and `summary` subcommands; turns Scenario 8 green; `selftest`.
  4. **Docs:** `SKILL.md` section and three amendments, `review-gauntlet.md` L3 rows, `hermes-adaptation.md` rows.
* **Agent gotchas:**
  - The rules are already in `SKILL.md` as prose; do not add a second, different wording. Add the helper and point to it.
  - Session ids: Codex and Claude subagents do not hand the coordinator a stable id that is verified here (UNVERIFIED). Use a coordinator-generated UUID per launch, written into the work order header and the route log, and say so in the section.
  - `decide.sh` already logs lane decisions to `~/.claude/plans/<slug>/decisions.jsonl`; `summary` may read the latest `model:<step>` entry from there instead of asking for a second `jev` record. Do not log the same decision twice with different answers.
  - `gauntlet-evals.mjs` `build_attempt.rung` (`:66-69`) has no NVIDIA value. Do not add one in this story; a bake-off that qualifies NVIDIA builders is a later owner decision.
  - `JEV:` lines must use the real answer and confidence; never write a placeholder when Jev was down (Scenario 8 has its own form).
  - The Hermes copy and the Claude copy differ in other places too (NOTES-B-factory). Edit only the routing rows named above.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Factory ready (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** factory

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Factory operator; logged routes, no self-review, no NVIDIA without consent).
- [ ] Acceptance criteria cover both happy paths and edge cases (8 scenarios incl. consent, bake-off, self-review, reused session, corrupt files, Jev down).
- [ ] UX/UI designs: N/A: no user interface in this step.
- [ ] Dependencies have been identified and are unblocked (NZR-3: clean clone and factory snapshot exist).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail): one helper, one test file, doc edits in three files.
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (`node --check`, the regression commands above) + step maid (Q68, T2). Codex built it, so Codex does not review it.
- [ ] A frozen failing test came first (red SHA recorded in the factory snapshot); `node --test /root/.claude/bin/route-guard.test.mjs` is green, and `gauntlet-evals.test.mjs`, `review-ledger.mjs selftest` and `test-decide.sh` still pass.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary (route log from one real step).
- [ ] Documentation is updated: `SKILL.md`, `review-gauntlet.md`, `hermes-adaptation.md`; a dated session handoff in `~/.claude/plans/`.
- [ ] Done = installed on the VPS and verified locally (factory change; nothing merges to `development`). Staging: N/A for factory files.

<!-- runner:evidence:start -->
### Story exit gate evidence (runner)

```
Story: NZR-40   HEAD: c31844ac2a9c18685c708be8737f38ec81cd8809
G1 code review : PASS  reviewer=claude-opus fresh critic session=f6694a9f-a591-4b12-b269-51e7bc6a0bb5 findings=1/12 open_low=11 greptile=GR:PASS
GR greptile    : PASS confidence=5 comments=0 plus=False
G2 unit tests  : PASS        red=c70fef8 green=c31844a counts=4779/4779 story_files=11/11 typecheck=ok
G2b integration: PENDING run=- (not in runner scope yet, Goal v1)
G3 UAT         : PENDING scenarios=8/8 pending_owner=0 accepted_by=- date=-
G4 E2E         : PASS run=docs/features/netzar-studio/evidence/NZR-40/e2e-run.txt counts=7/7
G5 Opik eval   : N/A     experiment=- (not in runner scope yet, Goal v1)
Lessons checked: L-001,L-002,L-003,L-004,L-005,L-006,L-007,L-008,L-009,L-010,L-011,L-012,L-013,L-014,L-015,L-016,L-017   New lessons: L-018, L-019
```

- [e2e-run.txt](../evidence/NZR-40/e2e-run.txt)
- [g1-review.md](../evidence/NZR-40/g1-review.md)
- [gates.md](../evidence/NZR-40/gates.md)
- [uat-transcript.md](../evidence/NZR-40/uat-transcript.md)
- [uat-unit-tests.md](../evidence/NZR-40/uat-unit-tests.md)
- [uat-walk.mjs](../evidence/NZR-40/uat-walk.mjs)
- [uat.json](../evidence/NZR-40/uat.json)
<!-- runner:evidence:end -->
