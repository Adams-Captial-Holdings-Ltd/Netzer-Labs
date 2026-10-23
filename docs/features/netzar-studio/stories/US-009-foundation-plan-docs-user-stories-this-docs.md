# [US-009] Foundation PLAN docs + user stories (this docs PR)

> Backlog task NZR-9 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-001, OBJ-007.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** the PRD, constraints, architecture, data model, security, deploy and design docs plus the story set in the repo, on one docs-only branch that passes docs CI
* **So that** every builder and reviewer works from the same written plan, and the PLAN gate can be checked by commands instead of by opinion

---

## 2. Business Context & Description
* **Background:** Q48: before step 1 of new feature work, write PRD, CONSTRAINTS, ARCHITECTURE, DATA-MODEL, SECURITY, DEPLOY and design.md (OBSERVABILITY and TEST-STRATEGY are C1 stories NZR-44/NZR-45). Q70: 1 plan story + one step story per backlog item now; task stories at each step's PLANNING. Q74: the plan lands as ONE docs PR cut from `origin/development`. Q80: local branch `docs/netzar-studio-stories`, nothing under `src/`, `web/` or `infra/`, no push or PR until the owner says. Q75: this docs gate blocks NEW feature steps, not the week-0 security fixes (NZR-43/5/6).
* **Current behaviour (d1d3a66 + this branch):**
  - Branch `docs/netzar-studio-stories` holds 3 commits on top of `origin/development` `d1d3a66`: `1e0ebde`, `e8a17f0`, `ee0d0e3` (`git log --oneline origin/development..HEAD`). 133 files changed, all under `docs/` (`git diff --name-only origin/development HEAD | grep -v '^docs/'` prints nothing).
  - Foundation docs exist in `docs/features/netzar-studio/foundation/`: `PRD.md`, `CONSTRAINTS.md`, `ARCHITECTURE.md`, `DATA-MODEL.md`, `SECURITY.md`, `DEPLOY.md`, `design.md`. Six of them carry `status: draft` in frontmatter (`ARCHITECTURE.md:4`, `CONSTRAINTS.md:4`, `DATA-MODEL.md`, `SECURITY.md`, `DEPLOY.md`, `design.md`). `draft` is not in the status vocabulary (`docs/features/README.md` section 4; `scripts/ci/feature-knowledge.mjs:42`). CI does not fail on it, because the validator only checks the canonical `README.md` and `HANDOFF.md` (`scripts/ci/feature-knowledge.mjs:52,172-174`).
  - Stories: `stories/US-000` plus 46 step stories; `stories/README.md` says they are generated from a task list kept outside the repo and must not be hand-edited on one side only.
  - Traceability today (computed 2026-10-23 from the story header lines): 75 PRD IDs; 53 cited by at least one story; 23 listed as deliberately out in `stories/README.md` "Requirements traceability"; 0 uncovered; 0 stories without an ID.
  - Mocks: 72 files in `docs/assets/netzar-studio/mock/` (PNG + `.provenance.json` pairs); folder size 3.1 MB. `design.md` has 25 `NO-MOCK-YET` rows (Q77).
  - The gauntlet PLAN gate (`gauntlet-loop/references/enterprise-planning.md` section 4) also asks that every one-way door has an ADR or is listed as `WAITING`. ARCHITECTURE section 7 lists one-way doors D1–D9; their ADRs are NZR-7 and NZR-8 (C1), so today they are not written.
* **Target behaviour:**
  - All seven foundation docs are on the branch with a valid status: `accepted` once the owner says yes, otherwise `current` with a one-line "DRAFT, owner review pending" note under the frontmatter (no `draft` value).
  - ARCHITECTURE section 7 marks each one-way door D1–D9 with its ADR story (NZR-7 or NZR-8) and the word `WAITING`, so the PLAN gate line "every one-way door has an ADR or WAITING" passes.
  - The story set is the stories-v2 build-ready set (this rewrite), regenerated through the task list so the generator and the files agree.
  - Every in-scope PRD ID is cited by at least one story, every story cites at least one ID (checked by the command in Test plan).
  - `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/runnable-blocks.mjs`, `node scripts/ci/docs-assets.mjs` exit 0 on the branch.
  - The feature `HANDOFF.md` and a dated session handoff in `handoffs/` record the branch, commit, what ran and the owner's yes/no.
* **Out of scope:** OBSERVABILITY.md (NZR-44) and TEST-STRATEGY.md (NZR-45); the ADR files themselves (NZR-7, NZR-8); any code, including the security fixes (NZR-43, NZR-5, NZR-6); mirroring to Plane (owner yes, Q53); pushing or opening the PR (owner yes, Q50/Q80).
* **Target Value:** PLAN gate (enterprise-planning section 4) passes with 0 failing lines; docs CI 4 of 4 scripts exit 0; traceability check prints `uncovered: 0, stories without id: 0`.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). Runs one build lane on a 3.9 GB VPS; reads the evidence summary, not every page. PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Docs CI green
* **Given** a clean checkout of branch `docs/netzar-studio-stories` at its HEAD
* **When** `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/runnable-blocks.mjs` and `node scripts/ci/docs-assets.mjs` run
* **Then** each exits with status 0 and prints no `FAIL` line
* **Test:** `scripts/ci/feature-knowledge.mjs`, `scripts/ci/docs-links.mjs`, `scripts/ci/runnable-blocks.mjs`, `scripts/ci/docs-assets.mjs` › existing Docs CI jobs (`.github/workflows/docs-ci.yml:43-49,113`)

### Scenario 2: Traceability both ways
* **Given** the PRD IDs (`FR-`, `NFR-`, `AC-`, `OBJ-`) in `foundation/PRD.md` and the "deliberately not covered" table in `stories/README.md`
* **When** the traceability command in the Test plan runs
* **Then** it prints `uncovered: []` and `stories without id: []`
* **Test:** critic command `TRACE` (Test plan) › "every in-scope ID cited; every story cites one"

### Scenario 3: Docs-only diff
* **Given** the branch diff against `origin/development`
* **When** `git diff --name-only origin/development...HEAD | grep -E '^(src|web|infra)/'` runs
* **Then** it prints nothing (exit status 1 from grep)
* **Test:** critic command `DOCS-ONLY` (Test plan) › "no file under src/, web/ or infra/"

### Scenario 4: No invalid status values
* **Given** every Markdown file under `docs/features/netzar-studio/`
* **When** `grep -rl '^status: draft' docs/features/netzar-studio` runs
* **Then** it prints nothing; every file with frontmatter uses one of `current|accepted|historical|superseded|compatibility`
* **Test:** critic command `STATUS` (Test plan) › "status vocabulary"

### Scenario 5: One-way doors listed
* **Given** ARCHITECTURE section 7 (D1–D9)
* **When** the critic greps each row
* **Then** every row names its ADR story (NZR-7 or NZR-8) or an existing ADR number, plus `WAITING` or the owner's yes with a date
* **Test:** critic command `grep -nE '^\| D[1-9] ' docs/features/netzar-studio/foundation/ARCHITECTURE.md` › "9 rows, each with NZR-7|NZR-8|ADR and WAITING|yes"

### Scenario 6: Asset budget and provenance
* **Given** `docs/assets/netzar-studio/`
* **When** `node scripts/ci/docs-assets.mjs` runs
* **Then** it exits 0: no file over 2 MB, total under the budget, every `.png` has a `.provenance.json` sidecar
* **Test:** `scripts/ci/docs-assets.mjs` › existing Docs CI job

---

## 4. Technical Notes & Constraints
* **Dependencies:** None.
* **Parallel work:** runs alongside NZR-43/5/6 (different files, Q75).
* **UI/UX Design:** N/A: documentation; the mocks it contains ([W-001 empty](../../../assets/netzar-studio/mock/W-001-empty-desktop.png) to W-013) are the UI artifacts for later stories.
* **Non-Functional Requirements:** docs/assets budget: no file > 2 MB; `docs/assets/` total <= 15 MB; every screenshot has a provenance sidecar (C-43). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.
* **Steps:**
  1. Builder (Opus, docs lane): `git fetch` then confirm the branch base is `origin/development` (Q74).
  2. Builder: replace `status: draft` with `status: current` plus a one-line `> DRAFT: owner review pending (date)` note in the six foundation files; switch to `accepted` per file only after the owner's yes.
  3. Builder: add a `WAITING (NZR-7)` / `WAITING (NZR-8)` cell to each D1–D9 row in ARCHITECTURE section 7.
  4. Builder: regenerate stories from the task list with the stories-v2 content (keep `gen.py` and the files in step); update `stories/README.md` index only if titles change (they must not).
  5. Builder: run the four Docs CI scripts and the three critic commands; paste outputs into the session handoff.
  6. Fresh critic: re-runs every command on a clean checkout of the exact HEAD.
  7. Owner: reads the evidence summary; says yes/no to push and to open ONE docs PR into `development`.
* **Artifacts:** the seven `foundation/*.md` files; `stories/*.md` (47 files); `stories/README.md`; `backlog.md`; `blueprint.md`; `HANDOFF.md`; `handoffs/YYYY-MM-DD-<slug>.md` (new, from `docs/features/HANDOFF-TEMPLATE.md`).
* **Evidence:** command outputs for Scenarios 1–6 in the session handoff, with the HEAD SHA; `git diff --stat origin/development...HEAD`.
* **API contract:** N/A: no API change.
* **Security notes:** Docs must hold no secret, real name, email or customer document (C-14, C-18). Mocks use seeded sample data only (Q77). Run `node scripts/ci/secret-scan.mjs $(git diff --name-only origin/development...HEAD)` on the diff, because CI's scan covers only `cdk.out` and fixtures (SECURITY.md section 2a B8).
* **Test plan:** no code tests (docs only). Commands:
  - Docs CI: `node scripts/ci/feature-knowledge.mjs && node scripts/ci/docs-links.mjs && node scripts/ci/runnable-blocks.mjs && node scripts/ci/docs-assets.mjs`
  - `DOCS-ONLY`: `git diff --name-only origin/development...HEAD | grep -E '^(src|web|infra)/' ; test $? -eq 1`
  - `STATUS`: `! grep -rl '^status: draft' docs/features/netzar-studio`
  - `TRACE`: a read-only Python or Node one-off that collects IDs from `foundation/PRD.md`, the header line (line 3) of each `stories/US-*.md`, and the IDs and `X to Y` ranges in `stories/README.md` section "Requirements traceability", and prints `uncovered` and `stories without id`. Paste the script into the session handoff; do not commit it as a new CI script without the owner's yes.
  - Mermaid render (`node scripts/ci/docs-mermaid.mjs`) needs a pinned `npx` download; run it only with the owner's yes (Q78), otherwise record "not run, reason".
* **Repo rules that apply:** `docs/features/README.md` frontmatter contract and status vocabulary; one session handoff per session (section 6a); no file under `src/`, `web/`, `infra/` (Q80); `stories/README.md` "Generated" rule (edit the task list and regenerate).
* **Rollback:** the branch is local and unpushed; rollback is `git reset --hard <previous SHA>` on the branch, or dropping the branch. Nothing is deployed.
* **Build slices (proposal):**
  1. Status + WAITING fixes (6 frontmatter edits, ARCHITECTURE section 7) → Scenarios 4, 5.
  2. Swap in stories-v2 through the generator → Scenarios 1, 2.
  3. Evidence run + handoff → Scenarios 1–6 recorded.
* **Agent gotchas:**
  - `feature-knowledge.mjs` passes even with `status: draft` in foundation files; the critic must run `STATUS` by hand.
  - Hand-editing a story without updating the task list breaks the "Generated" rule; the next regeneration will silently revert it.
  - `docs-links.mjs` checks anchors too: renaming a heading in a foundation doc breaks story links such as `../foundation/PRD.md`.
  - Do not run `npm ci` or Playwright for this story; it needs neither.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Foundation PLAN (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 8 (raw estimate 8 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T1 · **Deploy reach:** local only · **Labels:** docs, plan

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Factory operator; PLAN gate by command).
- [ ] Acceptance criteria cover both happy paths and edge cases (CI, traceability, docs-only, status vocabulary, one-way doors, asset budget).
- [ ] UX/UI designs: N/A: documentation; the Workflows-slice mocks W-001 to W-013 are already in `docs/assets/netzar-studio/mock/`.
- [ ] Dependencies have been identified and are unblocked (none).
- [ ] The team has reviewed and estimated the story points (8 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Docs follow `docs/features/README.md`; `DOCS-ONLY` prints nothing; `STATUS` prints nothing.
- [ ] Peer code review is completed and approved. Free checks only (Q68): docs CI, secret scan on the diff.
- [ ] Docs CI green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/runnable-blocks.mjs`, `node scripts/ci/docs-assets.mjs`; `TRACE` prints `uncovered: []`.
- [ ] QA: the fresh critic re-runs every command on a clean checkout of the exact HEAD. UAT: N/A, no user-facing change; the owner accepts the evidence summary.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: N/A: docs only, nothing deploys.
