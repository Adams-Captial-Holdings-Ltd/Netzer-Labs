# [US-037] Migrate off Paperclip and retire it (moved to January)

> Backlog task NZR-37 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-030.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** every Paperclip code path, setting, script and stack removed once nothing needs it, with Missions running on the same engine as workflows (PENDING OWNER Q94)
* **So that** we run and maintain one work system, no new install can provision Paperclip's Aurora + EFS (~$104/month), and the code base loses about 5,600 lines of Paperclip source plus its tests

---

## 2. Business Context & Description
* **Background:**
  - Q72: moved to January (cycle LATER, 2027-01-04 to 2027-01-29); 8 pts of regression risk and no customer value before the pilot.
  - Q84: no deploy to the old account. Legacy staging (the only place Paperclip runs, with no customer data) is marked known-vulnerable; its secrets are rotated. So retiring Paperclip is a **code and infra-definition** change; cleaning up the old account's retained Aurora/EFS is a separate owner action.
  - ADR 0022 (from NZR-7) says Netzar owns work state and Paperclip is replaced; ADRs 0010 and 0019 are amended by it. PR-AC-006: Paperclip is retired only after PR-AC-001…005 pass and the superseding decision is approved.
  - ARCHITECTURE R2: Paperclip is the only `MissionEngine` implementation today. DATA-MODEL risk 8: one authority per run entity — after this story Paperclip is authority for nothing.
  - **PENDING OWNER Q94:** recommended answer "rebuild Missions on the new engine as part of NZR-37" (~+5 pts, 8 → 13). If the owner says no, Missions keep the existing DynamoDB path (`mission_tasks` table) and only the Paperclip path is removed (8 pts). Both variants are written below; slice 3 is the only difference.
* **Current behaviour (d1d3a66):**
  - `src/lib/paperclip/`: 23 source files (~5,600 lines) + 40 test files: client, dispatch worker/drain, reconciler, pending-dispatch sweep, shadow users/keys, attempt store, runtime lock, sign-up probe, `paperclip-mission-engine.ts`, `mission-engine.ts` (the `MissionEngine` interface: `listMissions`, `getMission`, `createMission`, `createSubtask`, `setStatus`, `completeMission`, `reassign`, `comment`; `mission-engine.ts:82-101`).
  - 24 non-test files outside that folder mention Paperclip: `src/index.ts` (workers start/stop, `beginDispatchDrain` :34), `src/server.ts` (`/api/paperclip` mount :67, dispatch deny :145), `src/config/env.ts:297-317` (`CCE_PAPERCLIP_ENABLED`, `PAPERCLIP_*`), `src/agent/agent-loop.ts`, `src/agent/commands.ts`, `src/lib/tools/{registry,mission-tools,paperclip-tools,privacy-tools}.ts`, `src/lib/missions/{mission-acl,format}.ts`, `src/lib/work/{executor,approvals,approvals-paperclip}.ts`, `src/lib/packs/schema.ts`, `src/lib/state/{kill-switches-repo,mission-tasks-repo,mission-provenance-repo}.ts` (`paperclip_disabled` switch :107-109), `src/ops/paperclip-phase-probe.ts`, `src/observability/logger.ts`, `src/adapters/dashboard/{handler,jarvis,missions,paperclip-dispatch}.ts`.
  - Web: `web/src/components/chat/Composer.tsx`, `web/src/lib/missions-hierarchy.ts`, `web/src/pages/Missions.tsx`.
  - Missions routing: `paperclipRoutingEnabled()` reads `CCE_PAPERCLIP_ENABLED` per call (`src/lib/missions/mission-acl.ts:104-107`); when off, every function falls back to the DynamoDB repo (`:306,342,384,435`); when on, `missionEngine()` builds the Paperclip engine (`:115-118`). The pilot (T0) runs with it off.
  - Infra: `infra/bin/app.ts` builds `DatabaseStack`, `FilesystemStack`, `PaperclipStack` (`:12,57-120`) and the emptying guard (`:100-117`, `CCE_PAPERCLIP_TEARDOWN`); `TIERS[1..3].paperclipEnabled: true` (`infra/lib/constants.ts:366,388,406`), T0 false (`:348`); resource names `:64,161-178`; also `interfaces.ts`, `filesystem-stack.ts`, `iam-stack.ts`, `database-stack.ts`, `network-stack.ts`, `secrets-stack.ts`, `compute-stack.ts`, `cost-guardrails-stack.ts`.
  - Scripts (20 files): `scripts/paperclip-bootstrap.ts`, `scripts/paperclip-shadow.ts`, `scripts/mission.ts`, `scripts/lib/paperclip/*`, `scripts/ci/paperclip-image.ts`, `scripts/ci/tier-gate.ts`, `scripts/setup.ts:978-1006`, `scripts/deploy.ts:1545`, `scripts/teardown.ts:748`, `scripts/lib/lifecycle/{deploy-phases,rollback-classes,teardown-plan,manifest,sign-up-deploy-probe,cloud-build}.ts`, `scripts/lib/{cost-gate,seed-defaults}.ts`, `scripts/cost-estimate.mjs`.
  - CI/deploy: `.github/workflows/deploy.yml` provisions Paperclip on legacy staging (`CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE=1`; `CCE_PAPERCLIP_TEARDOWN: ''` at :201, :994).
  - Docs: ADRs 0010, 0012, 0019; `docs/features/paperclip/*`.
* **Target behaviour:**
  - No source file outside an archived note references Paperclip; `grep -rli paperclip src web/src infra scripts .github` returns only the allow-listed lines (the emptying guard's message and the teardown flag, kept for old installs).
  - Missions: (Q94 yes) a `MissionEngine` implementation on the new engine's store (NZR-34), same interface, same tools and dashboard; or (Q94 no) the DynamoDB repo path is the only path.
  - The Work Platform libs no longer import Paperclip: the executor uses the engine's drain flag (started in NZR-34), approvals use the native port only.
  - No tier provisions Paperclip: `TIERS[*].paperclipEnabled` and `CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE` removed; `DatabaseStack`/`FilesystemStack`/`PaperclipStack` no longer built for new installs.
  - A migration ledger records that legacy staging held no customer data and lists what was exported and archived (PR-AC-004).
  - ADR 0022 gets a "Retired on <date>" line; 0010/0019 point to it.
* **Out of scope:**
  - Any AWS call or deploy, including to legacy staging (Q84). Deleting the retained Aurora cluster/EFS in the old account is an owner action listed in the ledger.
  - New Missions features. Moving data from legacy production (none exists in Paperclip there; UNVERIFIED, see NOTES).
* **Target Value:** Paperclip references in `src/`, `web/src`, `infra/`, `scripts/`, `.github/` reduced from 81 non-test files (src 47, web 3, infra 11, scripts 20) plus 2 workflows to the allow-list (≤ 3 lines, all in the emptying guard / teardown path); full `npm test` and `npx vitest run infra` green; `node scripts/cost-estimate.mjs --tier=1` drops the Paperclip line.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Nothing reads Paperclip
* **Given** the code base after the change
* **When** `node scripts/ci/no-paperclip.mjs` runs (new guard)
* **Then** it exits 0; it scans `src/`, `web/src/`, `infra/`, `scripts/`, `.github/` (case-insensitive "paperclip") and allows only the lines listed in its allow-list (emptying guard message in `infra/bin/app.ts`, `CCE_PAPERCLIP_TEARDOWN` handling in setup/deploy/teardown); `src/lib/paperclip/` does not exist; any new match fails with `file:line`
* **Test:** `scripts/ci/no-paperclip.test.ts` › "passes on the allow-list and fails on a new reference"; Docs CI / CI step `node scripts/ci/no-paperclip.mjs`

### Scenario 2: Missions keep working
* **Given** the Missions dashboard, `/mission` chat commands and mission tools
* **When** a user lists, creates, sets status, completes, reassigns and comments on a mission
* **Then** each call returns the same response shape as before (existing `src/adapters/dashboard/missions` tests, `src/lib/missions/mission-acl.test.ts`, `src/agent/commands*` mission tests stay green with Paperclip cases removed); (Q94 yes) the calls go through `createEngineMissionEngine()` and its rows live in the engine store; (Q94 no) they go through the DynamoDB repo only
* **Test:** `src/lib/missions/mission-acl.test.ts` › existing suite; (Q94 yes) `src/lib/engine/mission-engine.test.ts` › "implements every MissionEngine method"

### Scenario 3: Hidden dependency found late
* **Given** removal of a Paperclip module breaks a caller that was not in the inventory
* **When** `npm run typecheck` or a test fails
* **Then** the slice stops, the caller is added to the inventory table in the handoff with its file:line, it is migrated in its own commit first, and only then is the module removed; the slice never deletes a test to make it pass (a removed test must be a Paperclip-only test listed in the inventory)
* **Test:** handoff › table "Inventory" (every removed test file is listed with the reason "Paperclip-only")

### Scenario 4: No tier provisions Paperclip
* **Given** `CCE_TIER` = 0, 1, 2 and 3
* **When** `npx cdk synth` runs hermetically for each tier
* **Then** no template contains `AWS::RDS::DBCluster` for Paperclip, the Paperclip EFS, the Paperclip ECR repo or the `/…/paperclip-db` secret; the synth tests pass; a synth with `CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE=1` set fails with "Paperclip is retired (ADR 0022)"
* **Test:** `infra/lib/no-paperclip.test.ts` › "no tier synthesizes Paperclip resources", "the provision override is refused"

### Scenario 5: Old installs are not silently orphaned
* **Given** an env file for an install that recorded Paperclip at tier ≥ 1 and no `CCE_PAPERCLIP_TEARDOWN=1`
* **When** `npm run deploy` or `cdk synth` runs against it
* **Then** it still refuses with the existing emptying-guard message (kept, `infra/bin/app.ts:100-117`), so a legacy install cannot drop its retained Aurora/EFS out of CloudFormation by accident
* **Test:** `infra/lib/no-paperclip.test.ts` › "the emptying guard still fires without the teardown flag"

### Scenario 6: Ledger and ADR
* **Given** PR-AC-004/006
* **When** the story is done
* **Then** `docs/features/netzar-studio/paperclip-retirement-ledger.md` lists: legacy staging resources (Aurora cluster, EFS, ECR repo, secrets, log group) with names from `infra/lib/constants.ts:64,161-178`, "customer data: none" with the owner's confirmation, what was exported (or "nothing, synthetic only"), and the owner action to delete the retained resources; ADR 0022 has "Retired on <date>, see ledger"; `node scripts/ci/docs-links.mjs` exits 0
* **Test:** ledger file › sections "Resources", "Data", "Owner actions"; Docs CI

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-34 / US-034](US-034-live-engine-v1-chosen-option.md) Live engine v1 (chosen option)
* **Builds on (other merged work; formal dependency changes are proposed in NOTES-H-live-deploy.md, not made here):** Also: NZR-7 ADR 0022 accepted; NZR-38 pilot stable (no work during the pilot freeze); Q94 answered.
* **UI/UX Design:** N/A: migration (Missions screens keep their current look).
* **Non-Functional Requirements:** no behaviour change for Missions users; full test suite green; owner yes for any AWS call (none planned). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

**Files to change / remove** (inventory; the handoff keeps it current)
| area | action |
|---|---|
| `src/lib/paperclip/**` (23 src + 40 tests) | delete after callers are moved |
| `src/lib/work/executor.ts:4`, `approvals.ts:3`, `approvals-paperclip.ts` | executor uses the engine drain flag only; delete the Paperclip approvals port and shadow-user lookup |
| `src/lib/missions/mission-acl.ts:84-125,300-780` | remove `paperclipRoutingEnabled()` branches; (Q94 yes) `missionEngine()` returns `createEngineMissionEngine()`; (Q94 no) call the repo directly |
| `src/lib/missions/format.ts` (`formatWrongSubstrate` :584) | remove the Paperclip-substrate message |
| `src/index.ts`, `src/server.ts:67,145` | remove Paperclip workers, drain, `/api/paperclip` mount and the dispatch deny line |
| `src/config/env.ts:297-317` | remove `CCE_PAPERCLIP_ENABLED`, `PAPERCLIP_*` |
| `src/lib/state/kill-switches-repo.ts:107-109,111,274` | remove `paperclip_disabled` (reader tolerates an unknown stored row) |
| `src/lib/tools/{registry,paperclip-tools,mission-tools,privacy-tools}.ts`, `src/agent/{agent-loop,commands}.ts`, `src/lib/packs/schema.ts`, `src/ops/paperclip-phase-probe.ts`, `src/observability/logger.ts` | remove Paperclip tools, commands, pack fields, probe, log redaction keys (keep redaction if harmless) |
| `src/adapters/dashboard/{handler,jarvis,missions,paperclip-dispatch}.ts` | remove routes/handlers; `paperclip-dispatch.ts` deleted |
| `web/src/components/chat/Composer.tsx`, `web/src/lib/missions-hierarchy.ts`, `web/src/pages/Missions.tsx` | remove Paperclip-only UI branches |
| `infra/bin/app.ts`, `infra/lib/{constants,interfaces,paperclip-stack,database-stack,filesystem-stack,iam-stack,network-stack,secrets-stack,compute-stack,cost-guardrails-stack}.ts` | stop building the three stacks for new installs; remove `paperclipEnabled`, provision override, Paperclip SG rules, IAM, secrets, alarms; keep the emptying guard |
| `scripts/**` (20 files) | delete `paperclip-bootstrap.ts`, `paperclip-shadow.ts`, `scripts/lib/paperclip/*`, `scripts/ci/paperclip-image.ts`; remove Paperclip lines from setup, deploy, teardown, lifecycle, cost gate, cost estimate, seed defaults, tier gate; `scripts/mission.ts` keeps working on the remaining path |
| `.github/workflows/deploy.yml`, `cdk-drift.yml` | remove Paperclip image/provision/drift steps (deploy.yml is disabled per Q91; edit anyway so it cannot provision if re-enabled) |
| `docs/adr/0010*`, `0019*`, `0022*`, `docs/adr/README.md`, `docs/features/paperclip/README.md` | status/forward links; feature marked `retired` |
| `docs/diagrams/*` (+ `docs/diagrams.map` sources) | remove Paperclip boxes; `diagrams-drift.mjs` green |

**New files**
| path | purpose |
|---|---|
| `scripts/ci/no-paperclip.mjs` (+ `no-paperclip.test.ts`) | Guard from Scenario 1 (pattern of the other `scripts/ci/*.mjs` checks) |
| `infra/lib/no-paperclip.test.ts` | Scenarios 4–5 |
| `src/lib/engine/mission-engine.ts` (+ test) | Q94 yes only: `MissionEngine` on the engine store |
| `docs/features/netzar-studio/paperclip-retirement-ledger.md` | Scenario 6 |

**Data changes**
- Q94 yes: Missions rows move from `mission_tasks` to the engine store only if the engine ADR says so; otherwise the new `MissionEngine` adapter wraps `mission_tasks` (keeps data in place; no migration). Recommended: wrap `mission_tasks` first (no data move), move later. Expand-only either way.
- Remove the `paperclip_disabled` kill-switch row from the code list only; stored rows are ignored.
- Paperclip-owned DynamoDB rows (attempt store, shadow rows; `attempt-rows-dynamo.ts`, `shadow-rows-dynamo.ts`): UNVERIFIED which tables hold them; list at PLANNING. Tables stay (RETAIN, never renamed); code stops reading them.
- No AWS-side data change in this story.

* **Security notes:**
  - Removing a public route (`/api/paperclip`) and its HMAC secret shrinks the attack surface (SECURITY B2/B3 boundary rows go away); update the security diagram.
  - Keep the emptying guard: it prevents orphaning retained, deletion-protected resources (cost + data risk).
  - Legacy staging secrets were rotated per Q84; the ledger records the date; no secret value in the repo (`node scripts/ci/secret-scan.mjs`).
* **Test plan:**
  - Frozen failing tests first: `scripts/ci/no-paperclip.test.ts` and `infra/lib/no-paperclip.test.ts` (fail today), red SHA recorded.
  - Keep and run the Missions suites unchanged except Paperclip-only cases: `npx vitest run src/lib/missions src/adapters/dashboard src/agent src/lib/tools`.
  - Commands per slice: `npm run typecheck`; `npx vitest run <touched dirs>`; `npx vitest run infra`; `node scripts/ci/no-paperclip.mjs`; `node scripts/ci/diagrams-drift.mjs`; at the end full `npm test` and `cd web && npm test`.
* **Repo rules that apply:** never delete a test to go green unless it is listed Paperclip-only; `src/lib/**` must not import `src/adapters/*` (R14); never rename/replace a table or bucket; infra change ⇒ synth tests for all tiers; no AWS call; ADR status updates follow the 0009 supersede pattern (US-007); full `npm test` before push.
* **Rollback:** revert the merge commit (code-only change; no data moved). If Q94-yes adapter misbehaves, the DynamoDB repo path is the fallback (keep it callable until the adapter has soaked).
* **Build slices (proposal):**
  1. *Guards first* (1 h): `no-paperclip.mjs` (with a temporary wide allow-list), `infra/lib/no-paperclip.test.ts` (expected red), inventory table in the handoff.
  2. *Cut library couplings* (2 h): executor/approvals, kill switch, env, logger, packs. Green: typecheck + touched suites.
  3. *Missions* (Q94 no: 1 h — remove Paperclip branches; Q94 yes: 5–6 h — `createEngineMissionEngine()` wrapping the engine store, all eight methods, tests). Green: Scenario 2.
  4. *Routes, workers, tools, web* (2 h): server/index/handler/jarvis/missions/commands/tools/web. Delete `src/lib/paperclip/`.
  5. *Infra + scripts + CI* (2 h): stacks, constants, scripts, workflows. Green: Scenarios 4–5; allow-list shrunk to final. Green: Scenario 1.
  6. *Docs + ledger* (≤ 1 h): ADRs, feature README, diagrams, ledger. Green: Scenario 6.
* **Agent gotchas:**
  - `paperclipRoutingEnabled()` is read per call (`mission-acl.ts:101-107`); tests that set `CCE_PAPERCLIP_ENABLED` across files will start failing in odd places when the env var is removed — grep tests for it first.
  - `src/lib/missions/repo-imports.test.ts` pins what Missions may import; update it, do not delete it.
  - Removing `PaperclipStack` from `infra/bin/app.ts` changes the stack list: a legacy install deployed with this code would try to delete those stacks. The emptying guard is the safety; keep it and keep its test (Scenario 5).
  - Kill-switch removal: the admin UI lists switches from `ALL_KILL_SWITCHES`; check the authz matrix test (`src/adapters/dashboard/authz-matrix.test.ts`) and `panic-state-repo.ts`, which iterate it.
  - Big deletions blow the review budget: one PR per slice, each green.
  - Do not start before the pilot is stable and not during a deploy freeze; the pilot image must not change for this.

---

## 5. Estimation & Tracking
* **Epic Name:** M4 Paperclip retired (cycle LATER January 2027, 2027-01-04 to 2027-01-29)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 8 (raw estimate 8 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** migration, cut-2

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (operator; one work system).
- [ ] Acceptance criteria cover both happy paths and edge cases (6 scenarios incl. hidden caller, old-install guard).
- [ ] UX/UI designs: N/A: migration.
- [ ] Dependencies have been identified and are unblocked (NZR-34 merged and live in the pilot; ADR 0022 accepted; Q94 answered; owner confirms legacy staging holds no customer data).
- [ ] The team has reviewed and estimated the story points (8 pts; +5 if Q94 = yes, proposed in NOTES; re-checked at the January plan).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews the infra change (stack list, guard).
- [ ] A frozen failing test came first (red SHA recorded); full `npm test`, `cd web && npm test`, `npx vitest run infra`, `node scripts/ci/no-paperclip.mjs` green on a clean checkout of the exact HEAD.
- [ ] QA: the fresh critic re-runs the gate against these criteria and checks the inventory table. UAT: the owner uses Missions once (list, create, complete) locally.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR (ADR 0022 retired line, ledger); diagrams updated.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging/pilot: ships with the next pilot release after its own owner yes; old account untouched (Q84).
