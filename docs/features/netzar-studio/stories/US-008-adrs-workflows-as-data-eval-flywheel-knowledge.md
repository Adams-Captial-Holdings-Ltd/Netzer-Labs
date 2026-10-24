# [US-008] ADRs: workflows-as-data, eval flywheel, knowledge layers, agent runtime, pilot hosting, mock policy

> Backlog task NZR-8 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-004, OBJ-006, FR-012, FR-027.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** the grill decisions on workflows, evaluation, knowledge, agent runtime, pilot hosting and mocks written as six ADRs with their options, trade-offs and revisit triggers
* **So that** a builder who wants to change one of them finds the reason and the trigger in one file instead of re-arguing it with the owner

---

## 2. Business Context & Description
* **Background:** Grill 1 (blueprint v1, accepted 2026-10-20, commit `1e0ebde`, section 2 table) decided Q11 (agent runtime), Q13/Q14/Q29 (eval flywheel), Q16 (lifecycle as versioned data), Q19/Q29-Q31 (knowledge layers). Grill 2-4 added: Q64 pilot in PGN's AWS account as a written exception; Q66 replay tests the harness only, live eval on each drafter change + nightly, hash-checked; Q77 NO-MOCK-YET screens depart from the PLAN gate wording; Q88 the drafter prompt ships in the repo and seeds S3 at deploy; Q89 live eval runs on the VPS only, no model keys in GitHub; Q58 production reach blocked until re-measured on Bedrock. ARCHITECTURE section 7 lists D4-D8 as one-way doors needing ADRs.
* **Current behaviour (d1d3a66):**
  - ADR format and index: `docs/adr/README.md`. Layout to copy: `docs/adr/0012-paperclip-owns-work-state.md` (Status, Context, Decision, Decided by, Consequences with Reversibility + Revisit trigger, Alternatives considered).
  - Numbers 0022-0024 are reserved for NZR-7 (US-007). This story uses **0025-0030**.
  - Prompts live in S3 today: `CLAUDE.md:48-52` ("Per-agent system prompts live in the S3 config bucket at `agents/<id>/CLAUDE.md` … NOT in this repo"); `docs/code-config-contract.md:24` (row "Agent system prompts and per-agent config").
  - Customer-hosted rule: `docs/features/customer-hosted-commercialization/README.md:78-79` ("PGN owns software and releases; the customer owns AWS, DNS, credentials, and production data"). Staff-access limit: ADR 0018 decision 18 (`docs/adr/0018-managed-solution-packs-v1.md:22`) and ADR 0017 item 5 (`0017:19`).
  - Packs: ADR 0018 decision 1 says "no workflow schema is invented" (`0018:11`) and rejects "An invented pack or workflow schema" (`0018:46`). Pack schema `src/lib/packs/schema.ts:50,59-79` carries Paperclip pipeline paths and `approvalGates` (ARCHITECTURE R9: two workflow formats).
  - Agent runtime: ADR 0014 (`docs/adr/0014-netzer-only-ai-runtime.md`) makes `runAgentTurn` (`src/agent/agent-loop.ts:762`) the only AI runtime.
  - Knowledge: JSONL-in-S3 with a per-scope scan (`src/lib/vectors/store.ts:1-12,333-343`), not S3 Vectors as PRD FR-029/DEC-010 says. Hive Mind has two unapproved writers (`src/lib/tools/agent-tools.ts:254-302`, `src/agent/memory-ingest.ts:173-186`).
  - Mock policy line already in `blueprint.md:35` (Designs row, Q77) with a revisit trigger.
* **Target behaviour:** six ADRs, each one page, each recording the owner's yes:

  | # | File | Title | Options (rejected ones in "Alternatives considered") | Decision recorded | Owner source | Touches |
  |---|---|---|---|---|---|---|
  | 0025 | `docs/adr/0025-workflows-are-versioned-data.md` | Workflows are versioned data with one canonical schema | (a) Paperclip pipeline JSON; (b) extend the pack format; (c) a new Netzar schema in `src/lib/workflows/schema.ts` with `schemaVersion`; (d) store AWS Step Functions ASL or BPMN as the format | (c). Lifecycle Draft → Test → Publish (frozen, create-only) → Activate (approval) → Monitor → one-click rollback. Running work pins a version. Packs keep Paperclip bodies until NZR-37; pack format v2 (2027) embeds this schema, so only one workflow format is written by new code | Q16, R9 | amends 0018 decision 1 and 0012 #3 (key-per-version replaced by version pins) |
  | 0026 | `docs/adr/0026-drafter-eval-flywheel.md` | Drafter eval flywheel: live eval, hash-checked results, approved lessons | (a) replay-only CI score; (b) live eval in GitHub Actions with a model secret; (c) live eval on the VPS + hash check in CI | (c). 30 synthetic cases; live eval on each drafter change and nightly, VPS only; the committed result holds sha256 of drafter files, dataset and model; CI fails on mismatch and on a lower score; replay tests the harness only; kill rule < 70% at Nov 23; re-baseline on Bedrock, production reach blocked until then; lessons are proposed and a human approves; customer cases opt-in, scrubbed, stay in the customer account. **ADR line (Q88):** the drafter prompt ships in the repo as product code and seeds the S3 copy at deploy, an exception to `CLAUDE.md:48-52` and `docs/code-config-contract.md:24` | Q13, Q14, Q29, Q57, Q58, Q66, Q72, Q88, Q89 | `docs/code-config-contract.md` row (link to this ADR) |
  | 0027 | `docs/adr/0027-knowledge-layers-and-company-facts.md` | Knowledge layers Company → Team → Agent, Playbooks, and approved Company facts | (a) keep one flat scope per agent + global Hive; (b) a vector database service; (c) layered scopes on the existing JSONL-in-S3 store with approval queues | (c). Drafter reads playbooks + the agent's own knowledge as the signed-in user. Hive Mind becomes Company facts: writes are `proposed`, an admin approves. Private agent knowledge = admins + the agent's own runtime (Q82). Storage stays JSONL-in-S3 (PRD wording corrected). Playbooks are not a second skills store | Q19, Q29-Q31, Q81-Q83 | do-not-build #8; ADR 0015 |
  | 0028 | `docs/adr/0028-agent-runtime-stays-typescript.md` | The agent runtime stays Netzar's TypeScript loop | (a) LangGraph.js now; (b) a Python framework; (c) keep `runAgentTurn`, LangGraph.js later only for AI teams behind a Netzar interface | (c). The workflow engine calls `runAgentTurn` once per agent step; it never embeds a second runtime | Q11 | reaffirms 0014; do-not-build #4 |
  | 0029 | `docs/adr/0029-pilot-hosting-exception.md` | Managed pilot in PGN's AWS account: a bounded exception | (a) customer-hosted from day one; (b) PGN-hosted as the product model; (c) PGN-hosted pilot under a written, time-boxed exception | (c), bounded by: PGN's dedicated pilot AWS account only (NZR-42); no customer production data (synthetic or test documents only); partner consent recorded before any data arrives; ends at GA or the hard end date (no later than 90 days), whichever is first; not renewable without a new owner sign-off; controls 1-16 of SECURITY section 5 | Q64, Q67, Q92, Q93 | exception to customer-hosted README section 6 and ADR 0018 decision 18; ADR 0002 |
  | 0030 | `docs/adr/0030-mock-policy-no-mock-yet.md` | Mock policy: full mocks for the Workflows slice, NO-MOCK-YET for the rest | (a) every screen and state before step 1 (PLAN gate wording); (b) full set for the slice now, inventory rows with dates for the rest | (b). Phone + desktop, light mode only until CONSTRAINTS requires dark; seeded sample data only. Revisit trigger: a NO-MOCK-YET screen reaches its step's PLANNING without a mock | Q49, Q77 | gauntlet PLAN gate wording |

  - Each ADR names scale, maintainability, cost and reliability trade-offs in Consequences (Good/Bad), plus `- **Reversibility:**` and `- **Revisit trigger:**`.
  - `docs/adr/README.md` index has rows 0025-0030; ADR 0018's index status gains `amended by 0025`; `docs/code-config-contract.md:24` gains "except the drafter prompt, see ADR 0026".
  - `docs/features/netzar-studio/README.md` `decisions:` list gains the six paths.
* **Out of scope:** the three reversal ADRs (NZR-7, 0022-0024); the live-engine choice (NZR-33 → D9 ADR); the schema code (NZR-12); the eval harness (NZR-14/30); the knowledge code (NZR-5/6/27/28); changing `CLAUDE.md`'s prompt rule text (only a pointer line is added if the owner agrees); round-5 UX decisions Q96-Q110 (pending; 0030 must not pre-decide them).
* **Target Value:** 6 ADRs merged with trade-offs on all four axes (scale, maintainability, cost, reliability) = 24 of 24 trade-off lines present.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Six ADRs with the required parts
* **Given** `docs/adr/0025-*.md` to `docs/adr/0030-*.md`
* **When** the critic runs `ADR-PARTS` (Test plan)
* **Then** each file contains `**Status:**`, `## Context`, `## Decision`, `**Decided by.**`, `## Consequences`, `- **Reversibility:**`, `- **Revisit trigger:**`, `## Alternatives considered`, and the four words `Scale`, `Maintainability`, `Cost`, `Reliability` inside Consequences
* **Test:** critic command `ADR-PARTS` › "0025-0030 have all markers and 4 trade-off axes"

### Scenario 2: Pilot exception is bounded
* **Given** `docs/adr/0029-pilot-hosting-exception.md`
* **When** the critic greps it
* **Then** it contains each of: `PGN` + `NZR-42` (dedicated account), `no customer production data`, `consent`, `ends at GA`, `90 days`, `not renewable`, and a link to `../features/netzar-studio/foundation/SECURITY.md` section 5
* **Test:** critic command `PILOT-BOUNDS` › "7 of 7 bounds present"

### Scenario 3: Eval ADR states the replay limit and the prompt exception
* **Given** `docs/adr/0026-drafter-eval-flywheel.md`
* **When** the critic greps it
* **Then** it contains `replay tests the harness only`, `VPS only`, `no model keys in GitHub`, `sha256`, `drafter files`, `dataset`, `model`, `fails on mismatch`, `70%`, and one line naming the exception to `agents/<id>/CLAUDE.md` in S3 with "seeds the S3 copy at deploy"
* **Test:** critic command `EVAL-LINES` › "all 10 phrases present"

### Scenario 4: One workflow format
* **Given** `docs/adr/0025-workflows-are-versioned-data.md` and ADR 0018
* **When** a reader opens ADR 0018's index row and 0025's Decision
* **Then** 0025 names `src/lib/workflows/schema.ts` as the only format new code writes, states packs keep Paperclip bodies only until NZR-37, and the ADR index row for 0018 says `amended by 0025`
* **Test:** critic command `grep -n '0025' docs/adr/README.md` and `grep -n 'src/lib/workflows/schema.ts' docs/adr/0025-*.md` › "both match"

### Scenario 5: Owner's yes recorded or WAITING
* **Given** each of the six ADRs
* **When** its `**Decided by.**` paragraph is read
* **Then** it names the owner, a date and the Q numbers from the table in section 2; an ADR whose text the owner has not yet approved has Status `Proposed — WAITING owner yes`, and the story is not done until none is WAITING
* **Test:** critic command `grep -c 'WAITING' docs/adr/00{25..30}-*.md` › "0 at done"

### Scenario 6: Docs CI and links
* **Given** the branch HEAD
* **When** `node scripts/ci/docs-links.mjs`, `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/runnable-blocks.mjs` run
* **Then** all exit 0, including the new `decisions:` list in `docs/features/netzar-studio/README.md`
* **Test:** existing Docs CI jobs (`.github/workflows/docs-ci.yml:43-49`)

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-9 / US-009](US-009-foundation-plan-docs-user-stories-this-docs.md) Foundation PLAN docs + user stories (this docs PR)
* **Coordination (not a dependency):** [NZR-7 / US-007](US-007-adrs-supersede-0012-0017-d21-amend-do.md) takes ADR numbers 0022-0024; this story takes 0025-0030. Proposed NZR-8 → NZR-7 dependency is in the group NOTES.
* **UI/UX Design:** N/A: decision record.
* **Non-Functional Requirements:** T3: owner yes recorded. One page per ADR. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.
* **Steps:**
  1. Builder (Opus): `git fetch`; confirm 0025-0030 are free (and that NZR-7 used 0022-0024); renumber both stories' ranges if not.
  2. Builder: commit the critic checklist (`ADR-PARTS`, `PILOT-BOUNDS`, `EVAL-LINES`) into the session handoff; run it; record red.
  3. Builder: write 0025 and 0028 (code-adjacent, cite `schema.ts`, `agent-loop.ts:762`).
  4. Builder: write 0026 and 0027 (cite `CLAUDE.md:48-52`, `code-config-contract.md:24`, `vectors/store.ts:1-12`, the two Hive writers).
  5. Builder: write 0029 (copy the bounds from SECURITY section 5; do not restate all 16 controls, link them) and 0030 (move the `blueprint.md:35` decision line into the ADR; leave a link in the blueprint).
  6. Builder: index rows, 0018 index status, `code-config-contract.md:24` pointer, README `decisions:`.
  7. Docs CI + checklist green; session handoff.
  8. Fresh critic + security reviewer + one Greptile pass (T3, Q68). Owner reads 0026 and 0029 closely (security and commercial boundary).
* **Artifacts:** six new ADR files (names in the table); edits to `docs/adr/README.md`, `docs/code-config-contract.md` (line 24), `docs/features/netzar-studio/README.md` (frontmatter), `docs/features/netzar-studio/blueprint.md` (line 35, link only).
* **Evidence:** red then green checklist output; Docs CI output; owner's yes quoted with date in each ADR.
* **API contract:** N/A: no API change.
* **Security notes:**
  - 0026 must keep the NVIDIA rule: test data only, no repo code to NVIDIA until the owner's yes on the free-tier terms (Q65; SECURITY 2b T7). The drafter prompt in the repo is product code, so sending it to NVIDIA is "repo code" under Q65; the ADR must say the live eval on NVIDIA waits for that yes.
  - 0027 must state the read rule from SECURITY section 3a / Q82 (private agent knowledge: admins + the agent's own runtime; unknown scope answered like a private one) and that only `approved` Company facts reach prompts (SECURITY 2b T3).
  - 0029 binds SECURITY section 5 controls; it must not loosen any of them (for example tier ≥ 2 controls unless the exception document says tier 1).
  - No secrets, partner names or real data in ADR text.
* **Test plan:** docs only; no vitest. Frozen checks (record red first):
  - `ADR-PARTS`: loop over `docs/adr/00{25,26,27,28,29,30}-*.md` and the 8 markers plus `Scale|Maintainability|Cost|Reliability` (same loop as US-007, extra 4 words).
  - `PILOT-BOUNDS`: `for p in 'NZR-42' 'no customer production data' 'consent' 'ends at GA' '90 days' 'not renewable' 'SECURITY.md'; do grep -qi "$p" docs/adr/0029-*.md || echo "MISSING $p"; done`
  - `EVAL-LINES`: same loop over the 10 phrases in Scenario 3 against `docs/adr/0026-*.md`.
  - Docs CI: `node scripts/ci/docs-links.mjs && node scripts/ci/feature-knowledge.mjs && node scripts/ci/runnable-blocks.mjs`.
* **Repo rules that apply:** `docs/adr/README.md` (one page; supersede, don't edit history: 0018 is amended through the index status + a banner, not by rewriting decision 1); `docs/features/README.md` relationship keys; `docs/code-config-contract.md` is the single place that says where config lives, so the drafter exception must be linked there; owner yes for every merge/push (Q50).
* **Rollback:** revert the docs commit; nothing else depends on it until NZR-12/14 start.
* **Build slices (proposal):**
  1. Checklist red + 0025 + 0028 + index → Scenarios 1 (two files), 4.
  2. 0026 + 0027 + `code-config-contract.md` pointer → Scenarios 1, 3.
  3. 0029 + 0030 + README `decisions:` + blueprint link → Scenarios 1, 2, 5, 6.
* **Agent gotchas:**
  - "Team" layer: AI teams are out until 2027 (stories README traceability table), and there is no team entity in code today. 0027 must say the Team layer is reserved, not built.
  - Do not quote the PRD's "S3 Vectors"; the store is JSONL-in-S3 (`vectors/store.ts:1-12`, DATA-MODEL risk 12).
  - 0026 is not the eval harness spec. Hash fields and file paths belong to NZR-14/30; the ADR records the rule only.
  - 0030 must not decide the round-5 UX questions (Q96-Q110: 20 px text, "Routines" wording, guided builder). Write "design target may change after Q96-Q110".
  - The decision line for Q77 already exists in `blueprint.md:35`; move it, keep one copy, link the other.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** docs, decision

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases (parts, pilot bounds, eval lines, one format, owner yes/WAITING, CI).
- [ ] UX/UI designs: N/A: decision record.
- [ ] Dependencies have been identified and are unblocked (NZR-9; numbers 0025-0030 free after NZR-7).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Docs are written and follow CLAUDE.md / CONTRIBUTING.md and `docs/adr/README.md`, minimum correct diff (/ponytail); no file under `src/`, `web/`, `infra/`.
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off); owner reviews 0026 (eval/NVIDIA) and 0029 (pilot exception).
- [ ] The frozen checklist (`ADR-PARTS`, `PILOT-BOUNDS`, `EVAL-LINES`) came first and was red (SHA recorded); green on a clean checkout of the exact HEAD; Docs CI green. `npm test` N/A: no code changed.
- [ ] QA: the fresh critic re-runs the checklist against these criteria. UAT: N/A, no user-facing change; the owner accepts the six ADR texts.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; ADR index and `code-config-contract.md` pointer updated.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: N/A: docs only.
