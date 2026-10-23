# [US-007] ADRs: supersede 0012 + 0017 d21, amend do-not-build #1

> Backlog task NZR-7 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-030, OBJ-007.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** the three reversals of earlier decisions written as three numbered ADRs, with the old records pointing forward to them
* **So that** no builder or reviewer follows a decision the owner has replaced, and a critic can prove it with one grep per old record

---

## 2. Business Context & Description
* **Background:** Grill 1 (blueprint v1, accepted 2026-10-20, commit `1e0ebde`) decided: Paperclip is replaced (Q2, Q10); customers build workflows, superseding ADR 0017 decision 21 (Q4); Netzar runs its own live engine after a spike (Q12). Grill 2 moved Paperclip retirement to January (Q72). ARCHITECTURE section 7 lists these as one-way doors D1, D2, D3. The gauntlet PLAN gate needs an ADR (or `WAITING`) for every one-way door. FR-030: Netzar replaces Paperclip through a verified migration.
* **Current behaviour (d1d3a66):**
  - ADR folder `docs/adr/`; index and format in `docs/adr/README.md` (four sections: Context, Decision, Consequences, Alternatives considered; "When a decision is reversed, write a new ADR that supersedes the old one. Don't edit history"). Highest number is 0021 (`docs/adr/0021-pack-format-v1-file-shapes.md`); no branch on `origin` holds a 0022+ file (checked with `git ls-tree` on every ref, 2026-10-23).
  - ADR 0012 `docs/adr/0012-paperclip-owns-work-state.md:3` status "Accepted". Decision 1 and 2 (`:17-18`) make Paperclip the owner of workflow definitions, cases, triggers, SLA timers, and pipelines the canonical engine. Alternatives (`:44`) reject "A Netzer workflow engine" by pointing at DO NOT BUILD.
  - ADR 0017 `docs/adr/0017-netzer-identity-and-work-ui.md:20` (item 6) says the Workflow Studio is "for staff and the owner only" and "There are no customer-built workflows" (decision 21). Its own revisit trigger (`:34`) is "a customer asks to build their own workflows (decision 21)".
  - Decision 21 itself: `docs/features/paperclip/decision-log.md:66`.
  - DO NOT BUILD row 1: `docs/features/paperclip/do-not-build.md:17` forbids "Workflow engine, state machine, case store, business scheduler, SLA timer engine, approval engine"; `:11` says building one "means superseding the ADR that forbids it".
  - The supersede pattern already used in the repo: ADR 0009 `docs/adr/0009-mission-container-model.md:3-5` (status line "Superseded (date) by …. Was: Accepted", then a quoted banner, then the old text unedited).
  - ADR 0012-0020 carry `Reversibility` and `Revisit trigger` bullets in Consequences and a `**Decided by.**` paragraph (`0012:30,40-41`).
* **Target behaviour:**
  - Three new ADRs, numbered 0022, 0023, 0024 (numbers reserved for NZR-7; NZR-8 takes 0025-0030):
    | # | File | Title | Options listed | Decision it records (owner source) |
    |---|---|---|---|---|
    | 0022 | `docs/adr/0022-netzar-owns-work-state-paperclip-replaced.md` | Netzar owns workflow and work state; Paperclip is replaced | (a) keep Paperclip pipelines canonical (0012); (b) split: Paperclip for Missions, Netzar for Studio workflows; (c) Netzar is the single authority, Paperclip retired after migration | (c). Paperclip keeps running for Missions until the January migration (NZR-37). One authority marker per workflow (PRD 2.3). Q2, Q10, Q72 |
    | 0023 | `docs/adr/0023-customers-build-workflows.md` | Customers build their own workflows in a conversational studio | (a) staff-only authoring (decision 21); (b) customers edit only pack `customerEditable` fields; (c) customers build workflows by describing them, a validator and an approval gate guard activation | (c). Supersedes 0017 item 6's "no customer-built workflows" and decision 21. Staff studio, canvas and packs wait until 2027. Q4, Q1, Q16 |
    | 0024 | `docs/adr/0024-netzar-owns-its-workflow-engine.md` | Netzar owns its workflow engine (amends DO NOT BUILD #1) | (a) Paperclip pipelines/routines/monitors; (b) AWS Step Functions Standard behind a Netzar interface; (c) own DynamoDB engine; (d) Temporal or another external engine | Netzar owns the engine's semantics and run state. The choice between (b) and (c) is deferred to the NZR-33 spike and a later ADR (D9). (d) rejected (no new dependency; owner round 5: no Temporal). Q12 |
  - Each new ADR has: `**Status:**` line, Context, Options (as "Alternatives considered"), Decision, `**Decided by.**` (owner, date, Q numbers, link to `blueprint.md` section 3), Consequences with `- **Reversibility:**` and `- **Revisit trigger:**` bullets. One page each.
  - ADR 0012 status line becomes `Superseded (YYYY-MM-DD) by [ADR 0022](0022-netzar-owns-work-state-paperclip-replaced.md). Was: Accepted <old date>` plus a quoted banner, text below unedited (0009 pattern).
  - ADR 0017 status line adds `item 6 (decision 21: no customer-built workflows) superseded by [ADR 0023](0023-customers-build-workflows.md)`; a banner under item 6 says the same. Items 1-5 stay accepted.
  - DO NOT BUILD row 1 gets an "Amended by ADR 0024" note: workflow engine, state machine, run store and approval gates may be built in Netzar; business scheduler and SLA timer engine stay forbidden until a later ADR (schedule triggers are design-only in NZR-13).
  - `docs/adr/README.md` index: 3 new rows; row 0012 status `Superseded by 0022`; row 0017 status `Accepted (item 6 superseded by 0023)`; row 0010 and 0016 status gain `amended by 0022` / `amended by 0024` (approvals move to Netzar for Studio workflows).
  - `decision-log.md:66` row 21 gains `Superseded by ADR 0023 (date)` in its links cell.
  - `docs/features/netzar-studio/README.md` frontmatter gains `decisions:` listing the three new ADR paths.
* **Out of scope:** the six grill ADRs (NZR-8); choosing Step Functions vs own engine (NZR-33, then a D9 ADR); migrating or retiring Paperclip (NZR-37, January); deciding Missions after Paperclip (open owner Q94, NZR-37); any code.
* **Target Value:** 3 ADRs merged; 0 old records (0012, 0017 item 6, decision 21, DO NOT BUILD row 1) without a forward link (grep count 4 of 4).
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Three ADRs with the required parts
* **Given** files `docs/adr/0022-*.md`, `0023-*.md`, `0024-*.md`
* **When** the critic greps each file
* **Then** each contains, in order, `**Status:**`, `## Context`, `## Decision`, `**Decided by.**`, `## Consequences`, `- **Reversibility:**`, `- **Revisit trigger:**`, `## Alternatives considered`; each names at least 2 rejected options; each cites at least one Q number and `blueprint.md`
* **Test:** critic command `ADR-PARTS` (Test plan) › "0022-0024 have all eight markers"

### Scenario 2: Old records point forward
* **Given** ADR 0012, ADR 0017, `decision-log.md` and `do-not-build.md`
* **When** `grep -l '0022' docs/adr/0012-*.md`, `grep -n '0023' docs/adr/0017-*.md docs/features/paperclip/decision-log.md` and `grep -n '0024' docs/features/paperclip/do-not-build.md` run
* **Then** each prints at least one match; 0012's line 3 starts with `**Status:** Superseded`
* **Test:** critic command `FORWARD-LINKS` (Test plan) › "4 of 4 old records link forward"

### Scenario 3: History not rewritten
* **Given** the diff of `docs/adr/0012-*.md` and `docs/adr/0017-*.md`
* **When** `git diff origin/development -- docs/adr/0012-* docs/adr/0017-*` is read
* **Then** only the status line and inserted banner lines change; no existing Decision or Consequences line is deleted (`git diff --numstat` shows 0 deletions except the status line)
* **Test:** critic command `NO-HISTORY-EDIT` (Test plan) › "only status + banner changed"

### Scenario 4: Owner's yes recorded or WAITING
* **Given** each new ADR
* **When** its `**Decided by.**` paragraph is read
* **Then** it names the owner, the date of the yes (2026-10-20 for grill 1 decisions, or the date the owner approves this ADR text) and the Q numbers; if the owner has not yet approved the ADR text, the Status line reads `Proposed — WAITING owner yes` and the story is not done
* **Test:** critic command `grep -n 'Decided by' docs/adr/002[2-4]-*.md` › "owner + date + Q present"

### Scenario 5: Index and links valid
* **Given** `docs/adr/README.md` and `docs/features/netzar-studio/README.md`
* **When** `node scripts/ci/docs-links.mjs` and `node scripts/ci/feature-knowledge.mjs` run
* **Then** both exit 0; the ADR index has rows 0022, 0023, 0024; the netzar-studio README `decisions:` list names the three files (the validator checks they exist and are tracked)
* **Test:** `scripts/ci/docs-links.mjs`, `scripts/ci/feature-knowledge.mjs` › existing Docs CI jobs

### Scenario 6: Number collision
* **Given** another branch merges an ADR numbered 0022-0024 first (the release-identity ADR rule X8, `decision-log.md:111`)
* **When** this branch is rebased on `origin/development`
* **Then** the builder renumbers to the next free numbers, updates every link, and NZR-8's reserved range moves up by the same amount; `docs-links.mjs` exits 0
* **Test:** critic command `ls docs/adr | sort | uniq -d -w4` prints nothing › "no duplicate ADR numbers"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-9 / US-009](US-009-foundation-plan-docs-user-stories-this-docs.md) Foundation PLAN docs + user stories (this docs PR)
* **Coordination (not a dependency):** ADR numbers are shared with [NZR-8 / US-008](US-008-adrs-workflows-as-data-eval-flywheel-knowledge.md); this story takes 0022-0024. Proposed NZR-8 → NZR-7 dependency is in the group NOTES.
* **UI/UX Design:** N/A: decision record.
* **Non-Functional Requirements:** Each ADR records the owner's yes (T3). One page each (`docs/adr/README.md`). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.
* **Steps:**
  1. Builder (Opus, PLAN-level docs): `git fetch`; re-check the highest ADR number on `origin/development` and on open branches.
  2. Builder: write the critic's grep checklist (Test plan) into the session handoff first; run it and record that it fails (red).
  3. Builder: write 0022, 0023, 0024 from the table in section 2, using the 0012 layout (`docs/adr/0012-paperclip-owns-work-state.md`).
  4. Builder: add status lines and banners to 0012 and 0017 (0009 pattern); amend status of 0010 and 0016 in the index only (one phrase each).
  5. Builder: amend DO NOT BUILD row 1 with a note and a new "Amended by later ADRs" section; bump that file's `observed_at` and `as_of_commit`.
  6. Builder: add the note to decision-log row 21; add `decisions:` to the netzar-studio README.
  7. Builder: run Docs CI and the checklist (green); write the session handoff.
  8. Fresh critic + security reviewer + one Greptile pass (T3, Q68).
  9. Owner: reads the three ADRs; says yes (Status → Accepted, date in Decided by) or asks for changes.
* **Artifacts:** `docs/adr/0022-netzar-owns-work-state-paperclip-replaced.md`, `docs/adr/0023-customers-build-workflows.md`, `docs/adr/0024-netzar-owns-its-workflow-engine.md` (new); edits to `docs/adr/README.md`, `docs/adr/0012-paperclip-owns-work-state.md` (lines 1-5 only), `docs/adr/0017-netzer-identity-and-work-ui.md` (line 3 and after line 20), `docs/features/paperclip/do-not-build.md` (row at line 17 + new section after line 39), `docs/features/paperclip/decision-log.md` (line 66), `docs/features/netzar-studio/README.md` (frontmatter).
* **Evidence:** red then green outputs of the checklist; Docs CI output; owner's yes quoted with date in each ADR.
* **API contract:** N/A: no API change.
* **Security notes:** ADR 0024 moves the approval engine into Netzar. It must restate the rules that stay binding from ADR 0016 and PRD 4.6: approvals bound to a hash of the exact payload, the approver comes from the session, an AI agent never approves its own action. ADR 0022 must state that Paperclip-backed approvals (`src/lib/work/approvals.ts:3`, shadow users) keep working until NZR-37. No secrets in ADR text.
* **Test plan:** docs only; no vitest. Frozen checks (write first, record red):
  - `ADR-PARTS`: `for f in docs/adr/002[2-4]-*.md; do for m in '**Status:**' '## Context' '## Decision' '**Decided by.**' '## Consequences' '**Reversibility:**' '**Revisit trigger:**' '## Alternatives considered'; do grep -qF "$m" "$f" || echo "MISSING $m in $f"; done; done` → prints nothing.
  - `FORWARD-LINKS`: `grep -c 'ADR 0022\|0022-' docs/adr/0012-*.md; grep -c '0023' docs/adr/0017-*.md docs/features/paperclip/decision-log.md; grep -c '0024' docs/features/paperclip/do-not-build.md` → every count ≥ 1.
  - `NO-HISTORY-EDIT`: `git diff --numstat origin/development -- docs/adr/0012-paperclip-owns-work-state.md docs/adr/0017-netzer-identity-and-work-ui.md` → deletions column ≤ 1 per file.
  - Docs CI: `node scripts/ci/docs-links.mjs && node scripts/ci/feature-knowledge.mjs && node scripts/ci/runnable-blocks.mjs`.
* **Repo rules that apply:** `docs/adr/README.md` (supersede, don't edit history; one page); `docs/features/README.md` relationship keys must be YAML lists of tracked files; DO NOT BUILD header (`do-not-build.md:11`): changing a row means an ADR; owner yes for every merge/push (Q50).
* **Rollback:** revert the docs commit. Because 0012/0017 are only annotated, a revert restores them exactly.
* **Build slices (proposal):**
  1. Checklist red + ADR 0022 + 0012 banner → Scenario 1 (0022), Scenario 2 (0012), Scenario 3.
  2. ADR 0023 + 0017 banner + decision-log note → Scenarios 1-3 for 0023.
  3. ADR 0024 + DO NOT BUILD amendment + index + README `decisions:` → Scenarios 1, 2, 5, 6.
* **Agent gotchas:**
  - ADR numbers are a race: the release-identity ADR "takes the next free number when it merges" (`decision-log.md:111`). Fetch and re-check right before commit.
  - 0017 is only partly superseded. Do not mark the whole ADR superseded; the identity and Work UI decisions (items 1-5) still hold.
  - DO NOT BUILD is binding for all Work Platform builds; only row 1 changes, and only the named parts of it.
  - The Paperclip feature docs are another feature's folder; keep edits to the marked lines and do not touch `docs/features/paperclip/HANDOFF.md`.
  - Do not invent the engine choice; 0024 must say "decided in NZR-33".

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** docs, decision

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases (parts, forward links, no history edit, owner yes/WAITING, CI, number collision).
- [ ] UX/UI designs: N/A: decision record.
- [ ] Dependencies have been identified and are unblocked (NZR-9; ADR numbers 0022-0024 re-checked free on `origin/development`).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Docs are written and follow CLAUDE.md / CONTRIBUTING.md and `docs/adr/README.md`, minimum correct diff (/ponytail); no file under `src/`, `web/`, `infra/`.
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews ADR 0024's approval rules.
- [ ] The frozen checklist (`ADR-PARTS`, `FORWARD-LINKS`, `NO-HISTORY-EDIT`) came first and was red (SHA recorded); it is green on a clean checkout of the exact HEAD; Docs CI green. `npm test` N/A: no code changed.
- [ ] QA: the fresh critic re-runs the checklist against these criteria. UAT: N/A, no user-facing change; the owner accepts the three ADR texts.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; ADR index updated.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: N/A: docs only.
