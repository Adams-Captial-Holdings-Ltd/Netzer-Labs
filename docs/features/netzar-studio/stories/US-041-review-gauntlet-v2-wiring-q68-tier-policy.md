# [US-041] Review gauntlet v2 wiring: Q68 tier policy + Kodus/CodeRabbit on the VPS

> Backlog task NZR-41 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-007.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** each Netzar step to run exactly the review layers its tier needs (Q68), with every third-party send stopped until I say yes for that run, and Greptile spent once per T3 step inside the 45-of-50 credit stop
* **So that** T3 steps get every layer, cheaper steps don't burn credits or send code out, and no review layer runs or is skipped by accident (measured: layer set per step matches the tier plan in 100% of steps; Greptile units used only on T3 steps; 0 sends without a per-run yes)

---

## 2. Business Context & Description
* **Background:**
  - Q76: keep Plane NZR-41, add it to the repo backlog, scope = **wiring only**: the Q68 tier policy and Kodus/CodeRabbit on the VPS. The layered review is already built into the gauntlet skill.
  - Q68: T3 steps (schema, versions, security, engine, ADRs) get full layers including one Greptile pass. T2 UI steps get the critic, free checks and the step maid. T1 and docs get free checks.
  - Q50/C-48: every third-party code send needs the owner's yes. Owner rule for this story: a Kodus or CodeRabbit send needs a yes **per run**. CONSTRAINTS C-52: Greptile 50-credit ledger, warn 35, stop 45, one pass per T3 step only.
  - Terms: **L0 free checks** = typecheck, build, unit tests, secret scan, `npm audit` (no third party). **Step maid** = the two-reviewer cleanup pass in `/root/.claude/skills/gauntlet-loop/references/step-maid.md`. **Greptile** = the paid final reviewer, billed in units from a monthly allowance tracked by `/root/.claude/bin/review-ledger.mjs`.
* **Current behaviour (VPS factory, verified 2026-10-23):**
  - The pipeline L0-L7 is written (`/root/.claude/skills/gauntlet-loop/references/review-gauntlet.md:20-45`), but its applicability rule is wider than Q68: "L0-L7 are required for T2/T3 code steps and for every code change that is a merge candidate ... whatever its tier" (`review-gauntlet.md:41-42`). Every Netzar step is a merge candidate (done = merged to `development`, Q50), so as written every step would run Kodus, CodeRabbit and Greptile.
  - `SKILL.md:318` (VERIFICATION row), `:350` (Review Gauntlet routing row), `:3789` and `:3894` (checklists) repeat "T2/T3 code step and every merge candidate".
  - The skill's tier names differ from Q68's: `SKILL.md:375-378` defines T2 as "new user-facing behavior" and T3 as "architecture, data model, public API, pricing, security boundary". Q68's T3 adds "versions, engine, ADRs".
  - Standing consent: `review-gauntlet.md:10-12` lets a standing yes in the STATE FILE cover routine Base/Plus Greptile runs. The owner's rule for Netzar is stricter (a yes per run for Kodus and CodeRabbit; one Greptile pass per T3 step).
  - Ledger policy `~/.claude/gauntlet-review-policy.json` today: `monthly_units 50`, `soft_warn_pct 70` (= warn at 35, matches), `hard_stop_pct 100` (= stop at 50, **does not match 45**), `reserve_units_high_risk 10` (normal-risk reviews already stop at 40, `review-ledger.mjs:80-82`). The ledger has no notion of a step: it refuses a second review of the **same SHA** without `--reason` (`review-ledger.mjs:83`), but a fix after Greptile makes a new SHA and a second pass would be allowed.
  - Kodus 0.4.21 (`/usr/bin/kodus`) and CodeRabbit 0.9.1 (`/root/.local/bin/coderabbit`) are installed and signed in on the VPS (`~/.claude/plans/vps-doctor.md:56`; login markers `:39-40`). Greptile 3.7.0 is installed. In the vps-doctor run Greptile refused because the repo had no git remote (`~/.claude/gauntlet-review-ledger.jsonl` line 2, `"greptile refused: no git remote"`).
  - Step logs record `REVIEW: <layer> <ran|NOT RUN> <SHA>` lines (`SKILL.md:350`). Nothing checks those lines against a tier.
  - The Hermes copy of the skill has no `references/review-gauntlet.md` at all (`ls /root/.hermes/skills/software-development/gauntlet-loop/references/`).
* **Target behaviour:**
  1. A Netzer-Labs tier table in `review-gauntlet.md` section 10 that overrides the general applicability rule: T3 = L0, fresh critic, step maid, L1 Kodus, L2 CodeRabbit (if substantial), L3 NVIDIA (only with NZR-40 consent, else NOT RUN), L4-L5, L6 Greptile once, L7; T2 = L0, fresh critic, step maid; T1 and docs = L0.
  2. A helper `/root/.claude/bin/review-plan.mjs`: `plan --tier` prints the required and forbidden layers; `verify --tier --log` reads the step log's `REVIEW:` lines and fails on a forbidden layer that ran, a required layer missing, or more than one Greptile pass in a T3 step; `send-check` refuses a Kodus/CodeRabbit/Greptile send without a per-run owner-yes record for that layer, step and SHA.
  3. The ledger policy file stops normal reviews at 45 and warns at 35 (`hard_stop_pct 90`, `soft_warn_pct 70`, `reserve_units_high_risk 0`; see NOTES for why the reserve goes to 0).
  4. `review-ledger.mjs reserve` takes `--step <id>` and refuses a second reserve for the same step in the month unless `--reason` is given (one pass per T3 step).
  5. The preflight (`review-gauntlet.md:59-62`) runs on the VPS against the clean clone and records which layers are ready in the Netzar STATE FILE; the first Kodus and first CodeRabbit run on Netzer-Labs are attended and record exit codes and output shape.
  6. `SKILL.md` rows 318, 350, 3789, 3894 point to the Netzer-Labs tier table instead of "T2/T3 or merge candidate" when the repo is Netzer-Labs.
* **Out of scope:**
  - Choosing models for roles, the NVIDIA consent gate and the bake-off: NZR-40 / [US-040](US-040-gauntlet-model-routing-on-the-vps-codex.md).
  - Installing or signing in tools (already done on the VPS); changing Kodus BYOK keys (owner action).
  - GitHub PR status checks and webhooks (`review-gauntlet.md:181`, out of scope by owner).
  - Deciding a step's tier: it comes from the story's `rigor_tier` in [backlog.md](../backlog.md).
* **Target Value:** 100% of Netzar steps pass `review-plan.mjs verify` for their tier; Greptile units spent only on T3 steps and never more than one reserve per step without a written reason; 0 Kodus/CodeRabbit/Greptile sends without a matching yes record; ledger never above 45 units used in a month (`node ~/.claude/bin/review-ledger.mjs status`).
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: T2 picks critic + free checks + step maid, not Greptile
* **Given** a step tagged T2
* **When** `review-plan.mjs plan --tier T2` runs
* **Then** it prints JSON `{"tier":"T2","required":["L0","critic","step-maid"],"forbidden":["L1","L2","L3","L6"]}`; and `verify --tier T2 --log <log>` exits 1 with `FORBIDDEN LAYER RAN: L6 greptile` when the log holds `REVIEW: L6 ran <sha>`, and exits 0 when the log holds only L0, critic and step-maid lines
* **Test:** `/root/.claude/bin/review-plan.test.mjs` › "T2 plan excludes paid and third-party layers and verify rejects a Greptile run"

### Scenario 2: T1 and docs get free checks only
* **Given** a step tagged T1, or a docs-only step
* **When** `plan` runs and `verify` reads a log with `REVIEW: L0 ran <sha>` only
* **Then** `required` is `["L0"]`, `forbidden` contains `L1, L2, L3, L6`, and `verify` exits 0; a missing L0 line makes `verify` exit 1 with `MISSING LAYER: L0`
* **Test:** `/root/.claude/bin/review-plan.test.mjs` › "T1 and docs require L0 only"

### Scenario 3: T3 gets every layer and exactly one Greptile pass
* **Given** a step tagged T3 whose log holds L0, critic, step-maid, L1, L2 (or `L2 skipped (not substantial)`), `L3 NOT RUN (no owner yes on NVIDIA terms)`, L4, L5, and one `REVIEW: L6 ran <sha> ledger=<id>` line
* **When** `verify --tier T3` runs
* **Then** it exits 0 and prints `TIER OK T3 (L3 NOT RUN: allowed exception)`; with two L6 lines it exits 1 with `GREPTILE PASSES: 2 (T3 allows 1)`; with an L6 line whose SHA differs from the last L0 SHA it exits 1 with `GREPTILE SHA != FINAL SHA`
* **Test:** `/root/.claude/bin/review-plan.test.mjs` › "T3 requires all layers and exactly one Greptile pass on the final sha"

### Scenario 4: Third-party send needs a per-run yes
* **Given** no yes record for step `nzr-5.s1`, layer `kodus`, SHA `<sha>`
* **When** `review-plan.mjs send-check --layer kodus --step nzr-5.s1 --sha <sha>` runs
* **Then** it exits 4 and prints `ASK OWNER: kodus would send Netzer-Labs@<sha12> (diff vs origin/development) to Kodus' service. Reply yes for this run only.`; after the coordinator appends `{"layer":"kodus","step":"nzr-5.s1","sha":"<sha>","owner_text":"yes kodus this run","id":"<fresh consent id>"}` the same command exits 0 once, and a second `send-check` for the same record exits 4 (`yes already used`)
* **Test:** `/root/.claude/bin/review-plan.test.mjs` › "kodus, coderabbit and greptile sends need a single-use per-run yes"

### Scenario 5: Ledger warns at 35 and stops at 45
* **Given** the updated policy file and a month with 34 units used
* **When** a Base reserve runs (1 unit), then reserves run until 45 units are used, then one more Base reserve runs
* **Then** the reserve that brings usage to 35 prints `soft warning: 35/50 units after this review`; the reserve at 45 succeeds; the next one exits 4 with `NOT RUN: hard stop: 45+1 > 45 units this month`
* **Test:** `/root/.claude/bin/review-plan.test.mjs` › "policy file: warn at 35, stop at 45" (temp ledger and a copy of the policy file via `GAUNTLET_LEDGER` / `GAUNTLET_POLICY`)

### Scenario 6: One Greptile reserve per step
* **Given** a committed reserve for `--step nzr-5.s1`
* **When** a new reserve for the same step but a new SHA runs without `--reason`
* **Then** it exits 4 with `NOT RUN: step nzr-5.s1 already had a paid review this month; a second needs --reason`; with `--reason "owner yes: rerun after blocker fix"` it succeeds
* **Test:** `node /root/.claude/bin/review-ledger.mjs selftest` › new assertion "a second reserve for one step needs --reason"

### Scenario 7: A layer that cannot run is NOT RUN, never faked
* **Given** Kodus is signed out, or CodeRabbit is over its free limit, or Greptile refuses (for example "no git remote" or the commit is not on the remote)
* **When** the coordinator records the layer
* **Then** the log line is `REVIEW: L1 NOT RUN (<reason>) <sha>`, `verify --tier T3` exits 2 with `INCOMPLETE: L1 NOT RUN`, and any open ledger reserve is released with the reason
* **Test:** `/root/.claude/bin/review-plan.test.mjs` › "a NOT RUN required layer makes a T3 step INCOMPLETE, not PASS"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-40 / US-040](US-040-gauntlet-model-routing-on-the-vps-codex.md) Gauntlet model routing on the VPS: Codex builds, fresh Claude critic, NVIDIA roles after bake-off
* **UI/UX Design:** N/A: no user interface in this step.
* **Non-Functional Requirements:**
  - Greptile credit ledger: warn 35, stop 45 of 50 (C-52). Weights stay `UNVERIFIED` until read from the Greptile account (`review-ledger.mjs:123`).
  - Helpers use Node built-ins only; `verify` reads a log of any size line by line.
  - Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event. Factory records: `REVIEW:` lines in step logs (existing), per-run yes records in `~/.claude/plans/<slug>-reviews/sends.jsonl` (new), ledger lines with a new optional `step` field, `reviewer_run` events in `~/.claude/gauntlet-eval-events.jsonl` (existing, `gauntlet-evals.mjs:90-94`).
* **Files to change:**

  | path | change |
  |---|---|
  | `/root/.claude/skills/gauntlet-loop/references/review-gauntlet.md` lines 41-45 (Applicability) | Add: "Netzer-Labs uses the Q68 table in section 10 instead of this paragraph." |
  | `/root/.claude/skills/gauntlet-loop/references/review-gauntlet.md` lines 216-236 (section 10) | Add the Q68 tier table (T3/T2/T1/docs → layers), Q68's T3 list (schema, versions, security, engine, ADRs), the per-run yes rule for Kodus/CodeRabbit, "one Greptile pass per T3 step", and the `review-plan.mjs` commands. |
  | `/root/.claude/skills/gauntlet-loop/references/review-gauntlet.md` lines 10-12 | Note that for Netzer-Labs the standing yes does not cover Kodus/CodeRabbit (per-run yes) and Greptile is limited to one pass per T3 step. |
  | `/root/.claude/skills/gauntlet-loop/SKILL.md` lines 318, 350, 3789, 3894 | Append "(Netzer-Labs: the Q68 table in `references/review-gauntlet.md` section 10)" so the general "merge candidate" wording does not override Q68. |
  | `/root/.claude/gauntlet-review-policy.json` | `hard_stop_pct` 100 → 90; `reserve_units_high_risk` 10 → 0; `soft_warn_pct` stays 70. |
  | `/root/.claude/bin/review-ledger.mjs` lines 6 (usage comment), 72-86 (`decide`), the `reserve` branch of `main` (from line 112), 169 (usage), 171-238 (selftest) | Accept `--step <id>` on `reserve` and store it; in `decide`, refuse a second live reserve for the same step without `--reason`; usage line; one new selftest assertion. Do not change `DEFAULT_POLICY` (`:16-19`): the selftest's budget assertions rely on it. |

* **New files:**
  - `/root/.claude/bin/review-plan.mjs`: `plan --tier T3|T2|T1|docs`, `verify --tier T --log <file>`, `send-check --layer kodus|coderabbit|greptile --step ID --sha SHA [--slug S]`.
  - `/root/.claude/bin/review-plan.test.mjs`: `node:test` suite for Scenarios 1-5 and 7.
  - `~/.claude/plans/netzar-reviews/sends.jsonl`: per-run yes records (created on first use, mode 600).
* **API contract:** N/A: no API change. CLI contract:

  | command | exit 0 | 1 | 2 | 4 |
  |---|---|---|---|---|
  | `plan --tier T` | JSON `{tier, required[], forbidden[], optional[]}` | — | usage / unknown tier | — |
  | `verify --tier T --log F` | `TIER OK <T> [...]` | forbidden ran / missing / >1 Greptile / SHA mismatch | `INCOMPLETE: <layer> NOT RUN` | — |
  | `send-check --layer L --step S --sha H` | `SEND OK` (record marked used) | — | usage | `ASK OWNER: ...` or `yes already used` |

  `REVIEW:` line grammar `verify` accepts: `REVIEW: <L0|critic|step-maid|L1|L2|L3|L4|L5|L6|L7> <ran|NOT RUN (<reason>)|skipped (<reason>)> <40-hex sha> [ledger=<id>]`. Anything else on a `REVIEW:` line is exit 1 `UNPARSEABLE`.
* **Data changes:** None in the product. Ledger lines gain an optional `step` field (old lines without it stay valid: `readEvents` only requires `id, month, event` and for reserve `tier, units, sha`, `review-ledger.mjs:43-52`). Policy file values change (above). Rollback = restore the old values.
* **Security notes:**
  - SECURITY.md boundary B8 (factory → repo → reviewers) and risk #11. Third-party egress: Kodus cloud and CodeRabbit receive the diff; Greptile and likely CodeRabbit index more than the diff (`review-gauntlet.md:82-84`, ASSUMED). The first use of each tool on Netzer-Labs needs the owner's egress yes, and then each run needs its own yes (owner rule).
  - Redact before any send and fail closed on a secret-shaped string (`review-gauntlet.md:78-81`); reuse the extra patterns from NZR-3's `check`.
  - Never pass `--include` to Greptile (uploads ignored files), `--use-credits` to CodeRabbit, or `--fix` to Kodus (`review-gauntlet.md:51-54`).
  - The yes record holds the owner's words, layer, step and SHA; no code, no keys.
* **Test plan:**
  - Frozen failing tests first: `/root/.claude/bin/review-plan.test.mjs` (Scenarios 1-5, 7) and the new selftest assertion in `review-ledger.mjs` (Scenario 6), written before the code.
  - Fixtures: synthetic step logs in temp files; temp `GAUNTLET_LEDGER`/`GAUNTLET_POLICY`; a temp `sends.jsonl`. No tool is called; no network.
  - Commands: `node --test /root/.claude/bin/review-plan.test.mjs`; `node /root/.claude/bin/review-ledger.mjs selftest`; regression `node --test /root/.claude/bin/gauntlet-evals.test.mjs`; `node --test /root/.claude/bin/route-guard.test.mjs` (from NZR-40).
  - Attended preflight on the VPS (no paid call): `coderabbit doctor`, `kodus --version`, `kodus auth status`, `greptile whoami`, `node ~/.claude/bin/review-ledger.mjs status`, saved to `~/.claude/plans/netzar-logs/review-preflight.log`. First real Kodus and CodeRabbit runs happen on the first T3 step (NZR-43 or NZR-5), each after its own yes.
* **Repo rules that apply:** No Netzer-Labs change. Applies: no new dependency; Codex builds, a fresh Claude critic reviews (Codex may not review it, NZR-40); the selftest in `review-ledger.mjs` must still pass unchanged apart from the one new assertion.
* **Rollback:** Restore `gauntlet-review-policy.json` (values above); revert `review-ledger.mjs` from the factory snapshot (old ledger lines stay valid; new lines with `step` are still readable by the old code because unknown fields are ignored, `review-ledger.mjs:43-52`); delete `review-plan.mjs` and its test; revert the doc edits.
* **Build slices (proposal):**
  1. **Tests (red):** `review-plan.test.mjs` and the new ledger selftest assertion.
  2. **review-plan.mjs:** `plan`, `verify`, `send-check`; turns Scenarios 1-4 and 7 green.
  3. **Ledger + policy:** `--step` rule and policy values; turns Scenarios 5-6 green.
  4. **Docs + preflight:** `review-gauntlet.md` sections 1, 2, 10; `SKILL.md` four rows; attended preflight log.
* **Agent gotchas:**
  - Do not edit `DEFAULT_POLICY` in `review-ledger.mjs`; the selftest's "used 6/50" and "hard stop at the monthly budget" assertions depend on the defaults. Change the policy **file**.
  - With `reserve_units_high_risk 10` left in place, normal reviews stop at 40, not 45 (`review-ledger.mjs:80-82`). That is why the reserve goes to 0.
  - Greptile reviews committed changes "from the merge base through HEAD" and may need the commit on the remote (`review-gauntlet.md:54`, UNVERIFIED). If it does, the T3 Greptile pass needs a push first, and every push needs the owner's yes (Q50). Also check whether the Greptile GitHub app auto-reviews on push; if so, count each push as a Base review (`review-gauntlet.md:148-150`).
  - Kodus on a clean pinned tree needs `--branch <target>`; with no branch it reviews working-tree changes, which is nothing (`review-gauntlet.md:51`).
  - The step maid runs only on T2/T3 (`SKILL.md:348`); `plan --tier T1` must not require it.
  - Q68 lists T3 as "schema, versions, security, engine, ADRs"; the skill's T3 list differs (`SKILL.md:378`). The step's tier is the story's `rigor_tier`, not a guess from the diff.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Factory ready (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Should Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** factory

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Factory operator; layers per tier, per-run consent, 45-unit stop).
- [ ] Acceptance criteria cover both happy paths and edge cases (7 scenarios: T2, T1/docs, T3, consent, ledger thresholds, one pass per step, NOT RUN).
- [ ] UX/UI designs: N/A: no user interface in this step.
- [ ] Dependencies have been identified and are unblocked (NZR-40: `route-guard.mjs` and the NVIDIA consent record exist). Owner has confirmed the reserve-to-0 choice and whether T1/docs keep the fresh critic (NOTES-B-factory).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail): one new helper, one ledger rule, one policy edit, doc edits.
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (`node --check`, the regression commands above) + step maid (Q68, T2). No Kodus, CodeRabbit or Greptile on this step.
- [ ] A frozen failing test came first (red SHA recorded in the factory snapshot); `node --test /root/.claude/bin/review-plan.test.mjs` and `node /root/.claude/bin/review-ledger.mjs selftest` are green, plus the NZR-40 and evals regressions.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary (preflight log, `review-ledger.mjs status` showing the new limits).
- [ ] Documentation is updated: `review-gauntlet.md` sections 1, 2 and 10; `SKILL.md` rows 318, 350, 3789, 3894; a dated session handoff in `~/.claude/plans/`.
- [ ] Done = installed on the VPS and verified locally (factory change; nothing merges to `development`). Staging: N/A for factory files.

---

<!-- runner:evidence:start -->
### Story exit gate evidence (runner)

```
Story: NZR-41   HEAD: f89ea37f5564774d0f66e736ba11039332f6b090
G1 code review : PASS  reviewer=claude-opus fresh critic session=dfc2e8b3-0c9a-4e35-abaf-5e3781718b82 findings=1/5 open_low=4 greptile=GR:PASS
GR greptile    : PASS confidence=5 comments=1 plus=False
G2 unit tests  : PASS        red=f036081 green=f89ea37 counts=4793/4793 story_files=14/14 typecheck=ok
G2b integration: PENDING run=- (not in runner scope yet, Goal v1)
G3 UAT         : PASS scenarios=7/7 pending_owner=0 accepted_by=owner (Telegram) date=2026-10-25
G4 E2E         : PASS run=docs/features/netzar-studio/evidence/NZR-41/e2e-run.txt counts=10/10
G5 Opik eval   : N/A     experiment=- (not in runner scope yet, Goal v1)
Lessons checked: L-001,L-002,L-003,L-004,L-005,L-006,L-007,L-008,L-009,L-010,L-011,L-012,L-013,L-014,L-015,L-016,L-017,L-018,L-019,L-020,L-021,L-022   New lessons: L-020, L-021, L-022
```

- [e2e-run.txt](../evidence/NZR-41/e2e-run.txt)
- [g1-review.md](../evidence/NZR-41/g1-review.md)
- [gates.md](../evidence/NZR-41/gates.md)
- [uat-transcript.md](../evidence/NZR-41/uat-transcript.md)
- [uat.json](../evidence/NZR-41/uat.json)
<!-- runner:evidence:end -->

## 8. NOTES
* The helper installs to `/root/.claude/bin` (copy from `scripts/factory/review-plan/` and `scripts/factory/review-ledger/`, see the README there). The `SKILL.md` and `review-gauntlet.md` doc edits are a coordinator follow-up after merge.
* Repo copies plus vitest and E2E were added instead of `node:test` at `/root/.claude/bin`.
