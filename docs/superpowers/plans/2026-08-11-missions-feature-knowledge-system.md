# Missions Feature Knowledge System Implementation Plan

> **For agentic workers:** Use `subagent-driven-development` or `executing-plans` to implement this plan task by task. Use `test-driven-development` for the CI contracts and `verification-before-completion` before reporting success.

**Goal:** Make Missions the first trustworthy, feature-centric repository workspace so a new engineer or AI agent can find the implementation, distinguish current truth from history and planned work, run the right checks, and continue safely without creating a second source of truth.

**Architecture:** Keep source code authoritative. Add only two canonical Missions documents: an index and a volatile handoff. Reuse ADR 0009 for durable decisions, the existing audit for dated evidence, and the existing backlog for approved executable work. Turn the root `handoff.md` into a compatibility pointer, update repository entry points, and enforce the document roles with dependency-free CI. Pilot Graphify only after the knowledge layer is consistent.

**Tech stack:** Markdown, YAML frontmatter, existing Node.js documentation checks, Vitest, Graphify `graphifyy==0.9.40`, and local Ollama for the optional semantic pilot.

**Reviewed branch:** `development` at `d767a368bca3cbb32e0abfc50a42cd3a001c64fa` on 2026-08-11.

## Review Outcome

The original request proposed roughly eleven files per feature plus repository-wide migration. That structure would duplicate information already present in four substantial Missions documents and would create a maintenance system before proving anyone can keep it current.

The accepted scope is the Missions reference slice:

1. Establish explicit truth ownership.
2. Create one stable discovery page and one volatile handoff.
3. Reconcile contradictions in the existing ADR, audit, backlog, and handoff.
4. Add small CI contracts that prevent the same drift from returning.
5. Run Graphify as a separate, reversible pilot after the documentation gate passes.

This is a scope reduction, not a partial implementation. It completes the knowledge lifecycle for one feature before expanding it.

## Repository Analysis

- The repository uses a layer/domain hybrid. Missions spans state, tools, HTTP routes, dashboard UI, CLI, permissions, infrastructure, and tests. Moving source into a `features/` tree would create churn without improving runtime boundaries.
- Existing feature knowledge is substantial but fragmented across `handoff.md`, `docs/missions-v2-audit.md`, `docs/missions-v2-backlog.md`, and `docs/adr/0009-mission-container-model.md`.
- `AGENTS.md` is currently an installation runbook, not a development knowledge entry point.
- `development.md` mandates one root `handoff.md` for every feature. That convention cannot represent multiple concurrent features safely.
- The existing docs link checker is useful and already runs in CI, but it scans `docs/**/*.md` plus root `README.md` only.
- `development` and `production` currently resolve to the same source tree. That proves the source was merged; it does not prove an AWS deployment occurred.
- Current CI evidence for `d767a36` is green: 1,922 tests passed, 6 skipped, across 177 passing test files and 1 skipped test file. This is the baseline, not evidence that Missions has sufficient integration coverage.

## What Already Exists

| Need | Existing asset | Decision |
|---|---|---|
| Source of truth | Missions implementation under `src/`, `web/src/`, `scripts/`, and `infra/` | Reuse; code wins when prose disagrees. |
| Durable architecture | `docs/adr/0009-mission-container-model.md` | Reuse as the only durable decision authority. |
| Historical evidence | `docs/missions-v2-audit.md` | Preserve as dated evidence; label superseded conclusions. |
| Executable work | `docs/missions-v2-backlog.md` | Reconcile and keep approved work only in the active queue. |
| Operational handoff | root `handoff.md` | Move current operations to feature scope; retain root as a pointer. |
| Documentation discovery | `docs/README.md` | Add the feature index instead of creating a second central docs system. |
| Agent instructions | `AGENTS.md` and `development.md` | Extend existing entry points and conventions. |
| Link validation | `scripts/ci/docs-links.mjs` and test | Extend the existing gate; do not build a replacement. |
| Machine-readable precedent | `docs/diagrams.map`, `docs/data-flows.json`, `docs/deprecations.json` | Follow their explicit ownership and schema-version style. |
| Knowledge graph | Graphify upstream | Use as a derived projection only; no custom graph service. |

## Source-of-Truth Contract

| Question | Authoritative source | Update rule |
|---|---|---|
| What does the system do now? | Source code and tests | Inspect before changing documentation. |
| Where do I start and what is the current feature status? | `docs/features/missions/README.md` | Update when boundaries, entry points, or verified status change. |
| What is the current branch, blocker, last verification, and next action? | `docs/features/missions/HANDOFF.md` | Update whenever operational state changes. |
| Why is the architecture this way? | Accepted ADRs, currently ADR 0009 | Add or supersede an ADR; never restate durable decisions in HANDOFF. |
| What work is approved? | `docs/missions-v2-backlog.md` | Keep active queue executable; tombstone rejected IDs without reusing them. |
| What was observed, attempted, or rejected? | `docs/missions-v2-audit.md` | Preserve dated evidence and label its current disposition. |
| Where is the legacy entry point? | root `handoff.md` | Pointer only; no operational content. |
| What does Graphify say? | `graphify-out/` | Derived navigation aid. It never overrides code or canonical docs. |

## Canonical Missions Workspace

```text
docs/features/missions/
|-- README.md        # Stable discovery, boundaries, implementation map, status
`-- HANDOFF.md       # Volatile branch/test/blocker/next-action state

Linked authorities, not copied:
docs/adr/0009-mission-container-model.md  # durable decisions
docs/missions-v2-backlog.md               # approved execution queue
docs/missions-v2-audit.md                 # dated evidence and failed approaches
```

Do not add `CONTEXT.md`, `ARCHITECTURE.md`, `PLAN.md`, `IMPLEMENTATION.md`, `TESTING.md`, `LEARNINGS.md`, `DECISIONS.md`, `TODO.md`, or `REFERENCES.md` until a real maintenance need cannot be met by the two canonical files and linked existing authorities.

## Minimal Metadata Contract

Canonical feature documents use small YAML frontmatter. Markdown links remain the human-readable authority because Graphify does not automatically turn arbitrary frontmatter keys into typed feature relationships.

Required fields:

```yaml
feature: missions
document_role: index        # index | handoff | decision | backlog | evidence | compatibility
status: current             # current | accepted | historical | superseded | compatibility
observed_at: 2026-08-11
as_of_commit: d767a368bca3cbb32e0abfc50a42cd3a001c64fa
```

Optional relationship fields may list repository-relative paths:

```yaml
implemented_by:
  - src/lib/state/mission-tasks-repo.ts
tested_by:
  - src/lib/tools/mission-tools.test.ts
decisions:
  - docs/adr/0009-mission-container-model.md
evidence:
  - docs/missions-v2-audit.md
```

No field may claim deployment from branch state. `landed`, `deployed`, and `verified` are separate facts.

## Knowledge Flow

```text
source code + tests + git evidence
                |
                v
   reconcile facts and document roles
                |
      +---------+----------+----------------+
      |                    |                |
      v                    v                v
 feature README       feature HANDOFF    existing authorities
 discovery/current    volatile state     ADR/backlog/audit
      |                    |                |
      +--------------------+----------------+
                           |
                           v
            root entry points and docs index
                           |
                           v
            link gate + feature-role contract
                           |
                           v
                  reviewed merge commit
                           |
                           v
           optional local Graphify projection
                           |
                           v
       committed portable graph artifacts, if accepted
```

## Delivery-Evidence Model

Do not compress implementation, branch reachability, deployment, and verification into one linear status. They are independent facts.

Active backlog work uses only:

```text
work_state: approved | in_progress | blocked
```

Closed, retired, or historically claimed work records evidence with orthogonal fields:

```yaml
outcome: landed | rejected | superseded | claimed_unverified
reachable_commit: <sha-or-none>
present_in_current_source: true | false
deployment: not_deployed | unknown | <named-environment-and-evidence>
verification: not_run | code_verified | environment_verified
```

- `landed` requires a commit reachable from the named target branch.
- Code can be verified locally before it lands or deploys.
- `deployed` requires a named environment plus deployment evidence and does not imply verification.
- Verification requires commands, results, date, and the commit or environment tested.
- Rejected or superseded task IDs move to a retired-ID table and are never reused.
- The former MISSION-001, MISSION-002, and MISSION-003 entries become `outcome: claimed_unverified`, `reachable_commit: none`, and `present_in_current_source: false`. The documents may say the work was reported as implemented, but must not claim that it actually existed or presume recovery is possible. Create fresh approved work only after choosing whether to reimplement or investigate missing evidence.

## Engineering Review Findings

### Architecture

1. `[P1] (confidence: 10/10) handoff.md:314-318 and handoff.md:402-413 - the proposed canonical handoff contains mutually exclusive durable decisions.`

   Motivating lines: `Consequence: a data migration with a dual-read shim`, `scopeId on new rows only`, later `DEC-015 - No data migration`, and `DEC-016 - Workflow coverage is integration tests, not Playwright`.

   Resolution: HANDOFF contains operational state only and links to ADR 0009 for durable decisions.

2. `[P1] (confidence: 10/10) docs/missions-v2-backlog.md:6 and :255-305 - the executable queue still requires work ADR 0009 rejected.`

   Motivating lines: `Work in dependency order`, MISSION-013's migration/backfill, and MISSION-014's `scopeId`. ADR 0009:123-134 says `No scopeId, no migration`.

   Resolution: remove rejected work from dependency sequencing, preserve IDs as retired tombstones, and rewrite dependent tasks against the accepted ADR.

3. `[P1] (confidence: 10/10) docs/missions-v2-backlog.md:26-28 and :57-64 - Complete/shipped is not tied to reachable repository state.`

   Motivating lines: `MISSION-001 ... Complete`, `Hotfix - shipped`, and commit `74c74be`. The three cited commits do not resolve and no `hotfix/missions-authz` ref exists.

   Resolution: use the delivery-state ladder above and mark the hotfix work unverified/unavailable.

4. `[P1] (confidence: 10/10) development.md:906-918 - repository guidance still tells every feature to write the same root handoff.`

   Motivating lines: `Every feature worked on in this repository keeps a handoff.md` and `Reference implementation: handoff.md (Missions v2)`.

   Resolution: require `docs/features/<slug>/HANDOFF.md`; root handoff is compatibility only.

5. `[P2] (confidence: 10/10) scripts/ci/docs-links.mjs:139-144 - the link gate excludes the root entry points this plan depends on.`

   Motivating lines: `files.push(...listMarkdown(docsDir))` and only root `README.md` is added.

   Resolution: explicitly include `AGENTS.md`, `development.md`, and `handoff.md`, with fixture coverage.

6. `[P2] (confidence: 9/10) docs/missions-v2-audit.md:560-568 and :682-702 - a derived graph would faithfully amplify superseded scope and migration claims.`

   Motivating lines still prescribe `scopeId`, dual-read, and backfill after ADR 0009 rejected them.

   Resolution: add role/provenance metadata, label historical conclusions, and run Graphify only after reconciliation.

### Code Quality

1. `[P1] (confidence: 10/10) scripts/mission.ts:33-50 - the CLI does not match the implemented HTTP contract.`

   Motivating lines use `?agent=` while the route reads `owner`, and call `GET /api/missions/:id`, which is not registered in the Missions route block.

   Resolution in this slice: record the defect as approved backlog work with exact paths and tests. Do not mix the behavioral fix into the documentation-system change.

2. `[P1] (confidence: 10/10) src/lib/state/mission-tasks-repo.ts:143-144 and :180-209 - mutations search only 200 rows, accept ambiguous ID prefixes, and reassignment is two non-transactional writes.`

   Motivating lines: `listMissionsForAgent(ownerAgent, 200)`, `m.id.startsWith(missionId)`, followed by separate `PutCommand` and `DeleteCommand` calls.

   Resolution in this slice: document as known production risk and approved follow-up work. The later implementation should use exact identity and a DynamoDB transaction or another atomic ownership design.

3. `[P2] (confidence: 9/10) src/lib/tools/registry.ts:88-125 - ToolRegistry invocation records metrics but not the audit behavior the backlog calls shipped.`

   Motivating line: `const result = await handler.invoke(args, ctx)` followed by `emitToolMetric`; no central `writeAudit` call exists.

   Resolution: correct the evidence state now; implement and verify audit behavior in a separate security-focused change.

4. `[P2] (confidence: 10/10) web/src/pages/Missions.tsx:90-110 - the all-agent board issues one request per known agent.`

   Motivating behavior: `Promise.all(agents.map(... /missions?owner=${a.id}))` with 100 rows per agent.

   Resolution: document the bound and performance debt. Do not add a cross-agent API solely for the knowledge-system slice.

### Tests

1. `[P1] (confidence: 10/10) scripts/ci/docs-links.test.ts:76-109 - current end-to-end fixtures do not cover AGENTS.md, development.md, or handoff.md.`

   Add negative fixtures proving a broken link in each root entry point fails.

2. `[P1] (confidence: 10/10) repository search - no feature-role contract exists.`

   Add a dependency-free validator for canonical files, pointer-only compatibility, discoverability, role metadata, approved active backlog states, and historical markers.

3. `[P2] (confidence: 9/10) scripts/ci/docs-links.mjs:54-76 and :169-187 - reference-style links are ignored and malformed percent encoding can abort the checker.`

   Add parser edge tests for reference-style links, malformed encoding, path casing, and stat/symlink failures. Implement only the fixes demonstrated by failing tests.

4. `[P1] (confidence: 10/10) src/lib/tools/mission-tools.test.ts and mission-tools.authz.test.ts - Missions has mocked tool tests but no repository, route, or LocalStack integration coverage.`

   Preserve this as approved feature backlog work. It does not block merging documentation-only changes once the documentation gates pass.

### Performance

1. `[P2] (confidence: 9/10) scripts/ci/docs-links.mjs:127-196 - the synchronous checker is linear in Markdown bytes and links, with anchor caching, which is appropriate for CI.`

   Keep the feature-role validator dependency-free and limited to the small canonical set. Record timing only if the observed local OneDrive timeout repeats on the Ubuntu runner.

2. `[P1] (confidence: 10/10) Graphify README privacy and extraction contract - semantic document extraction invokes an LLM and is model-variable and cost-bearing.`

   Do not run semantic extraction on every pull request. Use explicit local Ollama, a pinned model, content-hash caching, and a designated generator during the pilot.

3. `[P1] (confidence: 9/10) Graphify generated-state lifecycle - a shared mutable latest graph can become stale or mix branches.`

   Pilot one authoritative `development` snapshot. Commit only reviewed portable artifacts and validate freshness through Graphify manifest content hashes, not `built_at_commit == HEAD`.

## Test Coverage Diagram

```text
CODE PATHS / CONTRACTS                              AGENT USER FLOWS
[+] docs/**/*.md                                    [+] Start at AGENTS.md
  |-- [*** TESTED] file + anchor links                |-- [GAP] points to Missions README
  |-- [GAP] reference-style links                     `-- [GAP] no competing start page
  `-- [GAP] malformed percent encoding

[+] root entry points                               [+] Continue Missions work
  |-- [GAP] AGENTS.md links                           |-- [GAP] current state is unambiguous
  |-- [GAP] development.md links                      |-- [GAP] rejected work cannot look active
  `-- [GAP] handoff.md pointer                        `-- [GAP] landed != deployed

[+] feature knowledge contract                     [+] Inspect prior attempts
  |-- [GAP] canonical files exist                    |-- [GAP] audit is visibly historical
  |-- [GAP] role metadata is valid                   `-- [GAP] accepted ADR wins
  |-- [GAP] root handoff is pointer-only
  `-- [GAP] active backlog states are executable

[+] Graphify pilot                                 [+] Query the second brain
  |-- [GAP] pinned local generation                  |-- [GAP] Missions source in top results
  |-- [GAP] no-op/idempotence                        |-- [GAP] docs -> code/test path exists
  |-- [GAP] update/delete/failure safety              `-- [GAP] stale graph is obvious
  `-- [GAP] secret/path scan

CURRENT: link checker covers docs/** and root README only.
TARGET: every changed knowledge path has a deterministic CI contract;
        Graphify has a separate acceptance suite before adoption.

Legend: [*** TESTED] behavior + edge + error | [GAP] missing coverage
```

## Failure Modes

| Failure | Current protection | Required protection | User impact if missed |
|---|---|---|---|
| Agent implements `scopeId` and migration from stale backlog/audit | Conflicting ADR only | Reconciliation plus role contract | Wrong data model and authorization boundary. |
| Security hotfix remains absent because backlog says Complete | None | Reachability-based status and explicit recovery task | Authorization/audit exposure remains open. |
| Root handoff or AGENTS link rots | Not scanned | Expanded docs link gate | New agents cannot find current work. |
| Root handoff regains operational prose | Human review only | Pointer-only semantic contract | Multiple current truths drift again. |
| Graphify receives files outside the approved Missions corpus | Whole-repository scan or ignore mistake | Exact allowlist, sparse worktree, manifest review, explicit loopback Ollama, and output scans | Sensitive or irrelevant repository context reaches the model. |
| Failed Graphify run replaces the last good graph | Upstream partial guard | Never use `--allow-partial`; verify failure preservation | Agents query an incomplete graph. |
| Committed graph claims freshness after a rebase | `built_at_commit` is insufficient | Manifest/content-hash validator | Agents trust stale navigation. |

The reviewed plan closes all documentation-system critical gaps. Existing Missions runtime risks remain explicit follow-up work and are not disguised as fixed.

## Implementation Scope and Files

### Phase 1 - Canonical knowledge and reconciliation

Create:

- `docs/features/missions/README.md`
- `docs/features/missions/HANDOFF.md`

Modify:

- `handoff.md`
- `AGENTS.md`
- `development.md`
- `docs/README.md`
- `docs/adr/0009-mission-container-model.md`
- `docs/missions-v2-audit.md`
- `docs/missions-v2-backlog.md`

### Phase 2 - Drift prevention

Create:

- `scripts/ci/feature-knowledge.mjs`
- `scripts/ci/feature-knowledge.test.ts`

Modify:

- `scripts/ci/docs-links.mjs`
- `scripts/ci/docs-links.test.ts`
- `.github/workflows/docs-ci.yml` only if the new validator is not already reached by an existing test command

### Separate follow-up - Optional Graphify pilot

This is not part of the documentation-system Definition of Done or its pull request. Create a separate reviewed plan only after Phases 1 and 2 land. That follow-up may create or modify:

- `.graphifyignore`
- selected portable files under `graphify-out/`
- a dependency-free `scripts/ci/graphify-artifacts.mjs` and its tests if the pilot is accepted
- `.gitignore` entries for Graphify local state

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~3h / CC: ~25min)** - Missions evidence - reconcile ADR, audit, backlog, and git/source facts
  - Surfaced by: Architecture findings 1-3 and 6.
  - Files: `docs/adr/0009-mission-container-model.md`, `docs/missions-v2-audit.md`, `docs/missions-v2-backlog.md`, current source and git refs as evidence.
  - Verify: rejected scope/migration work is not executable; unreachable hotfix commits are not called complete; historical claims link to current truth.

- [ ] **T2 (P1, human: ~3h / CC: ~30min)** - Feature workspace - create the canonical Missions index and volatile handoff
  - Surfaced by: Architecture findings 1 and 4.
  - Files: `docs/features/missions/README.md`, `docs/features/missions/HANDOFF.md`, `handoff.md`.
  - Verify: root handoff is a one-link compatibility pointer; canonical files contain valid metadata and repository-relative links; HANDOFF contains no durable decision or task definitions.

- [ ] **T3 (P1, human: ~2h / CC: ~20min)** - Repository entry points - make feature discovery and handoff rules explicit
  - Surfaced by: Architecture findings 4-5.
  - Files: `AGENTS.md`, `development.md`, `docs/README.md`.
  - Verify: an unfamiliar agent starting at AGENTS reaches Missions README, implementation, tests, ADR, audit, backlog, and handoff without search guesswork.

- [ ] **T4 (P1, human: ~2h / CC: ~20min)** - Link CI - cover root knowledge entry points and parser failures
  - Surfaced by: Test findings 1 and 3.
  - Files: `scripts/ci/docs-links.mjs`, `scripts/ci/docs-links.test.ts`.
  - Verify: `npx vitest run scripts/ci/docs-links.test.ts`; `node scripts/ci/docs-links.mjs`.

- [ ] **T5 (P1, human: ~4h / CC: ~35min)** - Knowledge contract CI - prevent semantic role drift
  - Surfaced by: Test finding 2.
  - Files: `scripts/ci/feature-knowledge.mjs`, `scripts/ci/feature-knowledge.test.ts`, optionally `.github/workflows/docs-ci.yml`.
  - Verify: negative fixtures fail for missing canonical files, broken discovery, non-pointer root handoff, invalid roles, active rejected work, and unlabeled historical evidence; positive repository run passes.

- [ ] **T6 (P1, human: ~3h / CC: ~30min)** - Repository verification - prove the documentation change is accurate and non-regressing
  - Surfaced by: all review sections.
  - Files: no new production files; only corrections exposed by verification.
  - Verify: docs checks, focused tests, typecheck, builds, full unit suite, integration suite where available, `git diff --check`, and a clean intentional status.

- [ ] **T7 (P3 follow-up, human: ~1 day / CC: ~1h plus model runtime)** - Graphify pilot - write a separate executable plan for one private Missions snapshot
  - Surfaced by: Performance findings 2-3.
  - Files: `.graphifyignore`, `.gitignore`, disposable worktree output, then only accepted portable `graphify-out/` artifacts.
  - Verify: the follow-up freezes its corpus manifest, Ollama model digest, exact queries, expected targets, scoring rule, privacy checks, and output lifecycle before extraction runs.

- [ ] **T8 (P3 follow-up, human: ~2h / CC: ~20min)** - Graphify adoption decision - keep, narrow, or remove the projection using pilot evidence
  - Surfaced by: Graphify's optional derived role.
  - Files: plan/report or backlog only unless adoption is approved.
  - Verify: decision records measured query value, runtime, size, privacy result, and maintenance owner. Removal must leave canonical Markdown fully usable.

## Task Details

### Task 1: Reconcile Current Truth and Historical Evidence

- [ ] Record the verified source commit and distinguish merge state from deployment state.
- [ ] Treat ADR 0009's accepted `No scopeId, no migration` decision as authoritative.
- [ ] Move MISSION-013 and migration-dependent work out of active sequencing into a retired-ID table.
- [ ] Rewrite MISSION-014, MISSION-027, MISSION-031, and MISSION-032 against the accepted architecture; retire MISSION-033 if it has no remaining purpose.
- [ ] Mark MISSION-001/002/003 as claimed implemented, unverified, backed by no reachable commit, and absent from verified current source.
- [ ] Add current-disposition callouts to historical audit sections without erasing the historical record.
- [ ] Search the reconciled documents for `scopeId`, `migration`, `backfill`, `Complete`, `shipped`, and stale branch names. Every remaining occurrence must be contextualized correctly.

### Task 2: Create the Missions Feature Workspace

`README.md` must answer, in this order:

1. Start Here.
2. What Missions does today.
3. Current status and current source commit.
4. Source-of-truth table.
5. Implementation map covering repository, tools, routes, UI, CLI, permissions, DynamoDB, scheduler dependencies, and tests.
6. Current business/state rules.
7. Known runtime risks and approved next work.
8. Exact focused and full validation commands.
9. Links to HANDOFF, ADR, backlog, audit, and central docs.

`HANDOFF.md` is deliberately short. It contains only:

- current branch and commit;
- next merge target;
- push/PR/deployment state;
- current objective and active task IDs;
- blockers and unresolved evidence;
- last commands actually run and results;
- smallest next action;
- links to authoritative README, ADR, backlog, and audit.

Root `handoff.md` contains metadata marking it compatibility-only, one sentence, and one relative link to the canonical handoff.

### Task 3: Update Repository Entry Points

- [ ] Add a development-focused first step to `AGENTS.md`: choose a feature, open its README, verify the code and branch state, then open HANDOFF.
- [ ] Preserve the existing installation safety runbook; do not replace it.
- [ ] Change `development.md` from root `handoff.md` to `docs/features/<slug>/HANDOFF.md` while preserving branch, deployment, baseline, and command-evidence rules.
- [ ] Add a feature index to `docs/README.md` with Missions as the reference implementation and a status vocabulary.
- [ ] State that new feature folders begin with README and HANDOFF only; more documents require demonstrated maintenance value.

### Task 4: Extend Link Validation Test-First

- [ ] Add failing fixtures for broken links in `AGENTS.md`, `development.md`, and `handoff.md`.
- [ ] Add failing fixtures for malformed percent encoding and reference-style Markdown links.
- [ ] Update `checkRepo()` with an explicit root allowlist rather than scanning every root Markdown file.
- [ ] Handle malformed encodings as reported failures rather than uncaught exceptions.
- [ ] Preserve external-link skipping and target anchor caching.
- [ ] Run the focused test, the checker, and the full unit suite.

### Task 5: Add the Feature-Knowledge Contract Test-First

Expose a pure validator plus a small CLI. It must check:

- canonical Missions README and HANDOFF exist;
- required metadata fields and allowed enum values are present;
- root handoff contains only compatibility metadata, a short pointer, and the canonical link;
- AGENTS and docs index link to the Missions README;
- development guidance names `docs/features/<slug>/HANDOFF.md` and does not instruct feature authors to use a global operational handoff;
- the active backlog contains only `approved`, `in_progress`, or `blocked` work states, while closed/retired evidence uses the orthogonal fields above;
- retired/rejected IDs cannot appear in dependency sequencing;
- audit is labeled historical and links to the current README/ADR;
- repository-relative relationships resolve to tracked files.

Keep the parser narrow and explicit. This is not a general Markdown or YAML framework.

### Task 6: Verification

Run in order:

```powershell
npx vitest run scripts/ci/docs-links.test.ts scripts/ci/feature-knowledge.test.ts
node scripts/ci/docs-links.mjs
node scripts/ci/feature-knowledge.mjs
node scripts/ci/diagrams-drift.mjs
node scripts/ci/runnable-blocks.mjs
node scripts/ci/docs-mermaid.mjs
npm run typecheck
npm run build
npm --prefix web run typecheck
npm --prefix web run build
npm test
npm run local:test:integration
git diff --check
git status --short
```

Use the existing Floci environment. Do not run `npm run test:integration:up` or `npm run test:integration:all`; `development.md:508-513` says LocalStack collides with Floci, and the `test:integration:all` command skips teardown when its middle command fails. Record the known emulator gap separately. A skipped environment is not a pass.

Manual acceptance:

1. Give a fresh agent only `AGENTS.md` and ask it to locate Missions state storage, routes, UI, tests, ADR, active backlog, and next action.
2. Confirm every answer resolves through documented links.
3. Ask whether Missions v2 is deployed. The correct answer must distinguish source merge state from deployment evidence.
4. Ask whether `scopeId` or a migration is required. The accepted ADR must win without ambiguity.

### Task 7: Separate Graphify Pilot Plan

Do not run Graphify as part of this plan. After Phases 1 and 2 land, write a separate plan around an explicit Missions-only corpus. The existing secret scanner detects a limited set of credential shapes; it does not prove that a corpus contains no client data, PHI, private notes, binaries, or disallowed files.

The follow-up must create an exact allowlist manifest containing only the canonical Missions documents and the reviewed Missions implementation/test paths. Materialize those files in a disposable sparse worktree, compare the actual filesystem corpus to the allowlist, and require human review of that list before invoking a model. Do not point Graphify at the whole repository.

Before the first run, record an installed Ollama model's immutable digest and replace every placeholder in the follow-up plan. If no approved local model is installed, the pilot remains blocked; do not fall back to backend autodetection or a cloud provider.

Use a pinned local backend:

```powershell
uvx --from "graphifyy==0.9.40" graphify --version
$env:GRAPHIFY_QUERY_LOG_DISABLE = "1"
$env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"
uvx --from "graphifyy==0.9.40" graphify extract . --backend ollama --model "<approved-model-name-at-recorded-digest>" --timing
```

Rules:

- Explicitly pass `--backend ollama`; never use backend autodetection.
- Require loopback `OLLAMA_BASE_URL` and verify the selected model digest still matches the reviewed value.
- Compare the sparse-worktree file list byte-for-byte with the reviewed corpus manifest before extraction.
- Do not install Git hooks or strict agent hooks during the pilot.
- Do not use `graphify update .` for documentation changes; it rebuilds the code AST only and leaves semantic documents stale.
- Do not use `--allow-partial`.
- Use one designated generator/reviewer.
- Ignore machine paths, caches, cost files, dated backups, pending markers, media, generated output, dependencies, build artifacts, environment files, and secret-bearing local files.
- Scan `graphify-out/` for known secrets and absolute workstation paths before staging, while recognizing that a clean pattern scan is only one control and not corpus authorization.

Pilot acceptance:

- initial run completes without partial-extraction warnings;
- every allowlisted Missions document and implementation/test file appears as a source, and no non-allowlisted path appears;
- at least three of these four fixed queries return at least one expected target in the first five results:
  1. `Where is a mission stored and how is its status updated?` Expected: `src/lib/state/mission-tasks-repo.ts`.
  2. `Which HTTP routes power Missions and what capabilities gate them?` Expected: `src/adapters/dashboard/handler.ts` and `src/lib/auth/permissions.ts`.
  3. `What is the accepted Missions v2 decision about scope and migration?` Expected: `docs/adr/0009-mission-container-model.md`, with no historical document ranked above it as current truth.
  4. `How should a new agent continue Missions work and what checks should it run?` Expected: `docs/features/missions/README.md`, `docs/features/missions/HANDOFF.md`, or a listed Missions test.
- at least one useful path connects Missions documentation to implementation or tests;
- unchanged rerun performs zero semantic misses and leaves committed artifacts byte-stable;
- one-document change is detected by `extract`;
- code change and delete fixtures update without dropping unrelated nodes;
- backend failure exits nonzero and preserves the last good graph;
- manifest content hashes prove tracked inputs are current;
- first run is under 45 minutes, unchanged run under 2 minutes, one-document refresh under 5 minutes, and `graph.json` under 25 MB.

If accepted, commit only portable reviewed artifacts such as `graph.json`, `GRAPH_REPORT.md`, analysis/labels, and `manifest.json`. Do not use `built_at_commit == HEAD` as the freshness gate because committing generated output advances HEAD. Validate manifest content hashes instead.

If the pilot misses the query/connectivity target, keep Markdown as the full solution and remove the graph output. Do not add Neo4j or a custom adapter to rescue a weak pilot.

## NOT in Scope

- Repository-wide feature migration. Missions must prove the convention first.
- Moving runtime source code into feature directories.
- Creating the original eleven-file documentation template.
- Fixing Missions runtime bugs in the same change; they become evidence-backed backlog tasks.
- New tenant, workspace, team, or `scopeId` concepts.
- Legacy mission data migration or backfill.
- Automatic deployment from `development`; merge and deployment remain separate.
- Graphify semantic extraction in CI.
- Cloud Graphify backend, Git hooks, strict Codex hooks, Neo4j, FalkorDB, MCP, Obsidian, or a custom relation adapter.
- Public graph artifacts or graph ingestion of secrets, client data, local notes, or machine-specific paths.
- Feature-specific inline ASCII comments in runtime code; this change does not alter runtime flows.

## Maintenance Workflow

### Start feature work

1. Start from the correct long-lived branch and create a feature branch.
2. Open `docs/features/<slug>/README.md`; verify its `as_of_commit` against code.
3. Open HANDOFF for current operational state.
4. Read linked accepted ADRs, then approved backlog items, then historical evidence as needed.
5. Record a baseline before editing.

### Make an architectural decision

1. Update or add an ADR.
2. Link it from the feature README.
3. Reconcile affected active backlog tasks.
4. Do not copy the decision into HANDOFF.

### Discover a failed approach

1. Add dated evidence to the audit with what was tried, result, and current disposition.
2. Retire any invalid backlog task ID without reusing it.
3. Link the accepted replacement decision.

### Finish implementation or fix a bug

1. Add tests at the correct level.
2. Run focused and full checks.
3. Advance status only to the state proven by reachable commits, deployment records, and verification evidence.
4. Update README if boundaries/status changed; update HANDOFF whenever operational state changed.

### Hand work to another agent

1. Record branch, commit, target branch, push/PR/deployment state.
2. Record exact commands and results, including what was not run.
3. Name blockers and the smallest next action.
4. Keep durable decisions and task definitions in their owning documents.

## Outside Voice Resolution

The required independent pass ran through a fresh read-only subagent because Windows denied execution of the installed packaged Codex binary. It found six high-confidence issues:

1. Unreachable hotfix evidence was still phrased as implementation fact. Corrected to `claimed_unverified` and absent from current source.
2. A linear delivery ladder mixed work, reachability, deployment, and verification. Replaced with orthogonal evidence fields.
3. The verification list used a LocalStack command forbidden by the repository's Floci guidance. Replaced with `npm run local:test:integration` and an explicit collision warning.
4. Whole-repository Graphify extraction was not justified by the existing secret scanner. Replaced with an exact allowlisted corpus in a disposable sparse worktree.
5. The optional Graphify pilot was part of the documentation Definition of Done. Moved to a separate follow-up plan.
6. Graphify acceptance used an unspecified model and vague queries. The follow-up must freeze a model digest and now has four exact queries, expected target sets, and an objective top-five score.

The outside voice changed privacy scope and sequencing but did not change the accepted docs-first architecture. No cross-review disagreement remains.

## Parallelization Strategy

| Step | Modules touched | Depends on |
|---|---|---|
| Truth reconciliation | `docs/adr/`, Missions audit/backlog | - |
| Feature workspace and entry points | `docs/features/`, root docs, `docs/README.md` | Truth contract agreed |
| Link checker | `scripts/ci/` | - |
| Feature-role contract | `scripts/ci/` | Canonical metadata shape agreed |
| Integration verification | docs and CI checks | All prior steps |
| Graphify pilot | root ignore files, `graphify-out/` | Clean merged Phases 1-2 |

```text
Lane A: truth reconciliation -> feature workspace -> repository entry points
Lane B: link-checker fixtures -> implementation -> feature-role contract

Launch Lane A and Lane B in parallel worktrees after agreeing the metadata shape.
Merge both, resolve fixture/content coupling, then run integration verification.
Lane C: Graphify pilot starts only from the clean reviewed result.
```

Conflict flag: both Lane A and Lane B depend on the exact metadata and pointer contract. Freeze that contract before parallel work. Lane B should use isolated fixtures first and integrate against Lane A after merge.

## Definition of Done

- A new agent can start at AGENTS and reach all current Missions authorities.
- The repository has one current status index, one current handoff, one durable decision authority, one approved backlog, and one dated evidence record.
- No active document presents `scopeId` or legacy migration as accepted work.
- No unreachable commit is labeled landed, deployed, verified, complete, or shipped.
- Root handoff is pointer-only and checked by CI.
- Link and semantic role contracts fail on representative drift fixtures.
- All documented paths, anchors, and commands are verified.
- Focused checks, full unit checks, builds, and available integration checks pass from a clean intentional worktree.
- The feature metadata and Markdown links are ready for a separately reviewed Graphify pilot; no Graphify runtime or generated artifact is required to close this plan.

## Review Completion Summary

- Step 0: Scope Challenge - scope reduced to the Missions reference slice.
- Architecture Review: 6 issues found; all folded into the plan.
- Code Quality Review: 4 issues found; documentation-system work folded in and runtime fixes explicitly separated.
- Test Review: coverage diagram produced; 4 grouped gaps identified and mapped to tests.
- Performance Review: 3 issues found; all folded into the Graphify and CI lifecycle.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: no `TODOS.md` exists; P3 adoption work is captured as T8 and must not create a new global TODO file in this slice.
- Failure modes: 7 listed; 0 documentation-system critical gaps remain unaddressed in the reviewed plan.
- Outside voice: fresh subagent ran; 6 findings, including 2 genuine tensions. Both were resolved using the delegated maintainability preference: allowlisted corpus and a separate follow-up pilot.
- Parallelization: 3 lanes; 2 parallel, 1 sequential after merge.
- Lake Score: 19/19 actionable recommendations use the complete maintainable option.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | NOT RUN | Optional for this docs-first engineering change |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ABSORBED | 6 findings; 2 scope/sequence tensions resolved |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 17 issues, 0 critical gaps, 0 unresolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | NOT NEEDED | No runtime UI change in the accepted slice |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | NOT RUN | Agent discovery is covered by this plan's acceptance test |

- **CROSS-MODEL:** Both reviews support the docs-first architecture. The outside voice narrowed Graphify to an allowlisted corpus and moved it to a separately reviewed follow-up.
- **VERDICT:** ENG CLEARED - Phases 1 and 2 are ready to implement; Graphify is explicitly separate.

NO UNRESOLVED DECISIONS
