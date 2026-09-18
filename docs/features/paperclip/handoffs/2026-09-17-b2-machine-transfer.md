---
feature: paperclip
document_role: session-handoff
status: current
observed_at: 2026-09-17
as_of_commit: e5168f9572810fba696f3d32876debfa716b70d9
session_slug: b2-machine-transfer
supersedes: 2026-09-07-p1-hierarchy-closeout.md
---

# Session handoff: bridge piece B-2, parked, handed over for the machine transfer

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-17 |
| Feature folder | `docs/features/paperclip/` |
| Branch worked on | `feat/paperclip-b2-missions-board-infra` (worktree `C:\dev\Netzer-Labs\.worktrees\paperclip-b2` on the old machine) |
| Branch it merges into next | `development`, but only after it is merged up to (or rebased onto) the current `origin/development` and the implementation exists (see 6.1) |
| AWS environment that branch reaches | none. Nothing from this branch has been pushed, promoted or deployed. |
| Commit at session start | `e5168f9572810fba696f3d32876debfa716b70d9` (the B-2 / W1 SPECIFICATION red test) |
| Commit at session end | docs commits only, on top of `e5168f9`: `a429a1ad6709b2a6e37ff7543060b8ee8c82ac64` adds this file, and one follow-up correction commit after an independent review renumbers the new ledger rows and refreshes the Phase 0 pointers (see 4.3). A file cannot name its own commit's SHA; read the tip with `git log -1 --format=%H feat/paperclip-b2-missions-board-infra`. |
| Pushed | Not yet at the time of writing. The coordinator pushes this branch to origin under the same name immediately after this commit as an owner-approved backup (no PR, no merge, no deploy). Confirm with `git ls-remote origin refs/heads/feat/paperclip-b2-missions-board-infra`. |
| PR | none. The backup push opens none. |
| Deployed | no |

## 2. Current state summary

Bridge piece B-2 puts the public hostname `missions.staging.pgnos.ai` (GitHub environment variable `CCE_MISSIONS_BOARD_HOSTNAME`) into every Paperclip configuration home, and it has to work whether the variable is set or not. **B-2 is parked** behind Paperclip Phase 0 (WI-1 P0-0b image build, WI-2 A61 dispatch disposition loop, WI-3 A62 cross-board provenance), following the owner's "Workflows" direction change of 2026-09-07. The Phase 0 record sits on another branch, `fix/paperclip-p0-0b-image-build` (tip `5a7af9bc3d2b59c12e08f413cfde51799e32751d` on 2026-09-17), whose `HANDOFF.md`, last updated at `5a7af9b`, still says that 8.5, the same-origin UI/session bridge and Phases 10-12 "follow Phase 0". The B-2 branch, `feat/paperclip-b2-missions-board-infra`, had exactly one commit at session start over its fork point `15922df` (the Phase 1 merge, PR #162). That commit is `e5168f9`, the W1 (pass A) specification gate. It adds a `publicHostname` knob to the synth harness in `infra/lib/paperclip-stack.test.ts`, plus one test that pins `PAPERCLIP_PUBLIC_URL=https://missions.staging.pgnos.ai` and `PAPERCLIP_ALLOWED_HOSTNAMES=paperclip.claudeclaw.internal,missions.staging.pgnos.ai` on the synthesized `paperclip-server` container. The test is **red by design**, and implementation has not started. `infra/lib/paperclip-stack.ts` still has no `publicHostname` prop and still sets `PAPERCLIP_ALLOWED_HOSTNAMES` to the Cloud Map hostname alone. It is an **open owner question** whether B-2 is still wanted under the Workflows direction, which surfaces Paperclip's own features under a Netzar tab instead of rebuilding them. This session changed no code. It measured the branch, confirmed that the four W1 files are unchanged on the current `origin/development` (`271339b`, which this branch trails by 7 commits and leads by 1), and wrote this handoff so the work can resume on a new machine. Branch `feat/paperclip-b2-missions-board-infra`: the session started at `e5168f9572810fba696f3d32876debfa716b70d9`, and its docs commits sit on top (section 1). Pushed: not yet at the time of writing; the coordinator pushes this branch to origin under the same name immediately after this commit as an owner-approved backup (no PR, no merge, no deploy) - confirm with `git ls-remote origin refs/heads/feat/paperclip-b2-missions-board-infra`.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

Every point below was read from this worktree at `e5168f9` this session, not taken from the plan text.

- **The W1 seam in the stack.** `PaperclipStackProps` (`infra/lib/paperclip-stack.ts:94-119`) carries `imageDigest?: string` at `:116` and has no `publicHostname`. The container env block sets `PAPERCLIP_ALLOWED_HOSTNAMES: new URL(RESOURCE_NAMES.paperclipInternalUrl).hostname` at `:474`. That value is a synth-time string, not a CDK token, so the set-state value can be a plain comma join. `PAPERCLIP_PUBLIC_URL` appears in the stack only inside the explanatory comment (`:384`, `:389`).
- **Both states are pinned in the test file.** The unset state is covered twice: by the existing `it('omits PAPERCLIP_PUBLIC_URL rather than guessing it')` at `infra/lib/paperclip-stack.test.ts:376`, and by the Cloud-Map-only `PAPERCLIP_ALLOWED_HOSTNAMES` literal at `:712`. The set state is covered by `e5168f9`'s `it('carries the missions board hostname into both public-origin variables')` at `:384`, whose first assertion is at `:394`, the line the W1 handoff's recorded failure points to. The file has 55 `it(` call sites. The W1 handoff recorded "1 failed, 54 passed (55)".
- **The hostname must arrive as a prop.** `it('reads no process.env, ...')` at `infra/lib/paperclip-stack.test.ts:242` scans the stack's own source, so only `infra/bin/app.ts` may read the variable. `PaperclipStack` is constructed at `infra/bin/app.ts:181`, and the pattern to copy is `imageDigest: process.env.CCE_PAPERCLIP_IMAGE_DIGEST?.trim() || undefined` at `:194`.
- **Name trap.** `infra/bin/app.ts:223` already passes a `publicHostname` prop, but to `ObservabilityStack`, read from `CCE_PUBLIC_HOSTNAME` (the dashboard hostname the Cloudflare tunnel publishes). B-2's `PaperclipStack` prop carries a different value, read from `CCE_MISSIONS_BOARD_HOSTNAME`. See ledger P60.
- **A small correction to the W1 handoff (P5: the code wins).** The handoff lists `PUBLIC_ZONE='pgnos.ai' (:80)` among the "unexported" hostname rules. The code has `export const PUBLIC_ZONE = 'pgnos.ai';` at `infra/lib/public-dashboard-access.ts:80`, so it is already exported. The `LABEL` regex at `:109` is not exported. `resolvePublicDashboardAccess` starts at `:111`, and its three-or-more-labels check is at `:162`.
- **`origin/development` moved, but not under W1.** `git diff --stat 15922df..271339b` over the four W1 files (`infra/lib/public-dashboard-access.ts`, `infra/bin/app.ts`, `infra/lib/paperclip-stack.ts`, `infra/lib/paperclip-stack.test.ts`) is empty, and so is the same diff against `fix/paperclip-p0-0b-image-build` (measured at `4f1a860`; the independent review found it still empty at that branch's 2026-09-17 tip `5a7af9b`). Under `infra/`, `scripts/` and `.github/`, the 7 new development commits touch only `infra/lib/compute-stack.ts` (+7 lines: a War Room table-name block inserted after `:421`, as new lines `:422-428`) and `infra/lib/compute-stack.test.ts` (+178). The approved plan places pass B's compute-stack seams at `:544-546` and `:592-599`, both after that block, so on current development they are 7 lines further down. See ledger A68.

### 3.2 Critical files

| File | Purpose | Why it matters to the next session |
|---|---|---|
| `infra/lib/paperclip-stack.test.ts:384-398` | The `e5168f9` red test (set state) | The W1 / pass A specification. Do not weaken, skip or delete it. |
| `infra/lib/paperclip-stack.test.ts:52-57`, `:123` | `SynthOpts.publicHostname` and its pass-through into `PaperclipStack` | This is why `npm run typecheck` is expected to fail with exactly one TS2353 error until the prop exists (recorded in the W1 handoff, not re-run here) |
| `infra/lib/paperclip-stack.ts:94-119`, `:474` | Props interface; the `PAPERCLIP_ALLOWED_HOSTNAMES` seam | The implementation goes here |
| `infra/bin/app.ts:181`, `:194`, `:223` | `PaperclipStack` construction; the `?.trim() \|\| undefined` pattern; the unrelated Observability `publicHostname` | Where the variable is read |
| `infra/lib/public-dashboard-access.ts:80`, `:109`, `:111`, `:162` | Hostname shape rules that W1 may reuse | Its three callers must stay behaviourally identical (W1 handoff) |
| `docs/features/paperclip/missions-engine-plan.md:271-282` | The B-2 paragraph (every configuration home) | The bar. The approved plan records three evidence-backed corrections to it. |
| `docs/features/paperclip/missions-engine-plan.md:438-439` | "Bar text that cannot be implemented as written", item 4 | The pin that B-2 turns into both-state literal tests |

### 3.3 Patterns and conventions to follow

- Read environment variables only in `infra/bin/app.ts`, as `?.trim() || undefined` and never `??`, because deploy drivers forward blank strings (W1 handoff).
- Assert literals, never `RESOURCE_NAMES` (ledger A20). Keep both directions safe (ledger M33).
- The proof command is `npx vitest run infra/lib/paperclip-stack.test.ts --no-file-parallelism`, because `--maxWorkers=1` dies before any test is collected (W1 handoff; not re-run here). Never run two vitest or synth processes at once (ledger P44).
- The W1 handoff's PROHIBITED list, its owner decisions and its Cloudflare consent gate bind every downstream session. They are embedded verbatim in Appendix A, and the gate is repeated in 6.3.
- Cross-surface chat parity ([`CLAUDE.md`](../../../../CLAUDE.md)) does not apply. No chat UX is involved.

## 4. Work completed

### 4.1 Tasks finished

- [x] Measured the branch: tip, fork point, ahead/behind, remote presence, and the W1 seams at `e5168f9`
- [x] Confirmed that the four W1 files are unchanged on `origin/development` `271339b` and on `fix/paperclip-p0-0b-image-build`
- [x] Ran both docs gates before and after (section 7)
- [x] Wrote this session handoff, with section 5 carried forward byte for byte and appended
- [x] Two correction rounds after independent reviews: renumbered the new ledger rows past every ID the P0-0b branch uses at `5a7af9b`, renamed their subsection, pointed the Phase 0 references at `5a7af9b`, and stated the branch and push state in sections 2 and 8; then made P59's list of reused IDs exact and gave the compute-stack insertion point as after `:421` (see 4.3 and section 7)
- [ ] W1 / pass A implementation: **not started** (parked; see 6.1)
- [ ] Pass B (secrets and environment wiring), pass C (deploy driver, synth inputs, docs), and Verify (template-to-template synth diff): not started

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/paperclip/handoffs/2026-09-17-b2-machine-transfer.md` | New (this file), added at `a429a1a`, then corrected in one follow-up commit | Session handoff per framework section 6a, for the machine transfer. The correction fixes the ledger numbering and the stale Phase 0 pointers (4.3). |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| **`docs/features/paperclip/HANDOFF.md` is not edited on this branch.** | Update it here as well; leave it alone | The canonical transfer update is carried by the P0-0b branch (`fix/paperclip-p0-0b-image-build`). This branch's copy is still the Phase 1 version (`observed_at: 2026-09-07`, `as_of_commit: f0c26fb...`), and editing it here would conflict when the branches meet. As a result, this branch's `HANDOFF.md` does not list this file in its session index. The P0-0b branch's `HANDOFF.md` is the current-state page for the campaign. |
| Ledger rows appended as M76, A67-A69 and P59-P62, under the sub-heading `5.26` | Continue straight after this branch's own last rows (M67, A63, P53), which gives M68, A64 and P54; take the next numbers free on both branches | The first version of this file (`a429a1a`) used M72, A64-A66 and P54-P57 and claimed they were free on both branches. They were not: `fix/paperclip-p0-0b-image-build` was already at `5a7af9b`, committed three minutes earlier, whose `2026-09-15-p0-0b-validate-and-ship.md` uses M72, M73, A64, P54, P55 and P56 and whose `2026-09-17-machine-transfer.md` uses M74, M75, A65, P57 and P58, all with other meanings. The independent review caught this, and the correction commit renumbered the rows past the highest IDs there (M75, A65, P58). A66 is skipped on purpose, so that no reader who saw the first version mistakes a new row for the old A66. The sub-heading is `5.26` because that branch already has `5.24` (2026-09-15) and `5.25` (2026-09-17). See P59. |
| The red proof was not re-run | Re-run vitest and typecheck now; cite the W1 handoff's recorded run and check it statically | This is a docs-only transfer session on a machine running several transfer agents at once (ledger P44), with 2.9 GB free on C:. The static checks in 3.1 (assertion at `:394`, 55 `it(` sites, no `publicHostname` in the stack) agree with the recorded run. |

This decision covers this branch only. It is not a durable architectural decision, so it needs no ADR.

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Ledger IDs collide across the paperclip branches (P59) | `docs/features/README.md` section 6a would be the home (a rule that IDs stay unique across branches) | no. This task allows no README edits, and a rule change needs the owner. |
| `infra/bin/app.ts` feeds two different `publicHostname` props (P60) | `docs/features/paperclip/README.md`, configuration section, once pass A lands | no. The Paperclip prop does not exist yet, so documenting it now would describe code that is not there. |
| `PUBLIC_ZONE` is already exported (3.1) | Not promoted. It corrects a plan file in the devkit, not repository documentation. | no. The plan files are stable blueprints that later phases point back to rather than rewrite. The correction lives here and in the next session's reading. |
| B-2 is parked, and whether it is still wanted is an open question | The canonical `HANDOFF.md` on the P0-0b branch | no, not by this session. It is volatile state, and this branch must not edit `HANDOFF.md` (4.3). |

## 5. Carried-forward mistakes, assumptions and precautions

> Copied forward verbatim from 2026-09-03-staging-probe-green-and-two-findings.md, then appended to. Nothing is deleted.

> Copied forward verbatim from the previous session handoff,
> [`2026-08-24-paperclip-completion-audit.md`](2026-08-24-paperclip-completion-audit.md),
> then appended to. Nothing is deleted. An entry that is fixed is marked
> `RESOLVED (<commit>)` and stays.

### 5.1 Process precautions

| # | Precaution | Why it exists |
|---|---|---|
| P1 | Record a baseline before changing anything. | Without it a pre-existing failure is indistinguishable from a regression you caused. |
| P2 | Never record a command as passing unless it actually ran. Say what you skipped and why. | See M5: a handoff once carried checks that no runtime could have executed. |
| P3 | Name the branch. Never write "ready for production". | Four long-lived branches exist and only two reach an AWS environment. |
| P4 | Run the FULL `npm test` before pushing, never a scoped run. | Required by [`CLAUDE.md`](../../../../CLAUDE.md). Scoped runs have hidden cross-module regressions here. |
| P5 | When a document and the code disagree, **the code wins**. Fix the document. | The framework's stated tie-break. |
| P6 | Never force-add unrelated uncommitted work you find in the tree. Preserve it and hand it back to its owner. | Stray files found during cleanup are somebody's in-flight work, not yours to merge. |
| P7 | Delete a transient branch once it merges. | Only `development`, `qa`, `staging`, `production` survive, so a handoff that names a branch names something that still exists. |
| P8 | Docs changes must pass `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/docs-links.mjs` before pushing. | Docs CI runs them anyway; failing there costs a round trip. |
| P9 | Never restate feature-documentation rules outside [the framework](../../README.md). | A second copy is exactly how these conventions drifted before — see M1. |
| P10 | Set `PAPERCLIP_TEST_AUTH_SECRET` in **every** process that touches the Paperclip harness — including the vitest process, because the bootstrap fixture shells out to `docker compose`, whose YAML interpolation refuses to parse without it. | The integration file otherwise fails in under a second with `Docker command failed`, which looks like a Docker problem and is not. |
| P11 | Never print, commit, or hand off Paperclip test tokens; probe scripts read the `/dev/shm` cache into memory and print only statuses and bodies. | The fixture's secret-safety contract; tokens exist only inside the disposable container. |

### 5.2 Mistakes already made, and their corrections

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M1 | Feature-documentation conventions were written on several pages at once. | The copies drifted and no page was trustworthy. | Single specification in [the framework](../../README.md), machine-checked by `scripts/ci/feature-knowledge.mjs`. | One rule, one home, enforced by CI rather than by discipline. |
| M2 | The repository-root `handoff.md` was used as live, writable operational state. | It became a stale global handoff that contradicted the per-feature ones. | Reduced to a one-sentence compatibility pointer; CI now fails if it grows back. | Operational state is per-feature. A global handoff always rots. |
| M3 | `infra/lib/dynamo-stack.ts` carries a header comment claiming "All 14 DynamoDB tables". | It creates **32**. The comment misled table-count work. | Read the synthesized template, never the comment. | Comments are not authorities. `infra/lib/constants.ts` and the synth output are. |
| M4 | The CodeBuild deploy branch default was changed from `main` to `production`, then reverted. | Churn on a live CI path; the doc fixes from that change were kept, the behaviour change was not. | Reverted in `4ce27a7`, doc fixes retained. | Do not re-apply this without first establishing why it was reverted. |
| M5 | A feature handoff recorded required checks as complete when the authoring machine had no Node runtime, so they could not have run. | The next reader would have trusted an unverified contract. | Disclosed explicitly in the handoff; Docs CI on `development` became the first real execution. | This is precisely what P2 exists to prevent. Disclosure is the minimum; running the check is the goal. |
| M6 | Targeted Vitest was run inside a Windows **linked worktree**. | Startup failed with `Cannot read directory "../../../../../../../.."` and could not resolve `vitest.config.ts`; no tests collected. | Ran from a normal checkout instead. | On Windows, run test suites from a normal clone. Dependency-free Node CI scripts are fine in a worktree; Vitest is not. |
| M7 | `npm run test:integration:up` was assumed safe alongside the local stack. | It starts LocalStack on port 4566 and collides with Floci. Two emulators must never run at once. | Use `npm run local:test:integration`, which passes `--env-file=.env`. | One emulator on 4566, ever. |
| M8 | `.env` was created for local development while several lifecycle scripts default their environment flag to **prod** and read `.env`. | Commands that were previously inert became genuinely dangerous. | Catalogued in [dangerous commands](../../../../development.md#dangerous-commands-never-run-locally). | Read that list before running any unfamiliar `npm run` script. |
| M9 | The first `updatedSince` patch draft carried the watermark into Paperclip's request-coordination key as a `Date`, which `normalizeIssueListCacheValue` normalizes to `{}`. | Two different watermarks would share one in-flight compute and could return each other's results. | Key on `updatedSince?.toISOString()` explicitly (`527512d`). RESOLVED (`527512d`). | Trace a new parameter through every layer that fingerprints the request, not just the query. |
| M10 | A naive strict `>` watermark predicate was almost used against microsecond-stored `timestamptz`. | A row would be re-returned at its own millisecond-truncated watermark, failing I3 and duplicating reconciler work. | `updated_at >= watermark + 1ms` (`527512d`). RESOLVED (`527512d`). | API callers observe truncated timestamps; compare at the resolution the caller can actually observe. |
| M11 | The vendored `.patch` was first committed with no line-ending pin. | A Windows `autocrlf` checkout would deliver CRLF and `patch`(1) inside the Debian build container would reject it — the image build breaks only on other machines. | `.gitattributes` pins `eol=lf` (`a7ab7a3`). RESOLVED (`a7ab7a3`). | Any file consumed byte-exactly inside a Linux container needs an explicit `eol=lf`. |
| M12 | A first clone of the Paperclip release on Windows silently checked out incomplete (4,000+ files missing) with `Filename too long`. | Greps against the partial tree would have "proven" code absent that exists. | `git config core.longpaths true` + `git reset --hard HEAD`, then verify `git status` is clean before trusting the tree. | On Windows, verify a clone is complete before drawing any conclusion from it. |

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it any time with `npm run local:verify`, which requires account id `000000000000`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS**, Floci 1.6.0, Docker 28.3.2, Node 24.3.0, on 2026-08-10. | Windows and Linux behaviour is **not** covered by that verification. See M6. |
| A3 | Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. | Local development validates plumbing, never model behaviour. Tool use is unreachable locally by design. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; deployment is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const). | A `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception. |
| A6 | AWS console access for this account is root-user sign-in via `aws login` with the `netzer-root` profile. | The `netzer-dev` SSO profile is known broken. Do not burn time on it. |
| A7 | The pinned Paperclip image contains full source and toolchain and runs as root, so a derived image can patch + `tsc` in place. | Verified against `2026.722.0`. Re-verify on every re-pin; upstream could slim the image. |
| A8 | Paperclip stamps `updated_at` from two clocks (DB `now()` on insert, Node `new Date()` on update). | Verified in pinned source. The reconciler must tolerate skew; do not treat watermarks as exact. |
| A9 | The Windows baseline failures (4 `scripts/ci` parser suites, buildspec `sh` missing, rollback path separator, intermittent Jarvis timeouts) are environmental and predate this work. | Verified at `4bdbf08` and unchanged since. Compare failing file *names*, not counts. |

### 5.4 Known traps that cost time

Short pointers only. The owning document has the detail; do not copy it here.

| Trap | Where the detail lives |
|---|---|
| A bare `KEY=` in `.env` becomes `''`, and zod's `.optional()`/`.default()` only fire on `undefined`. Omit the line instead. | [Environment variables](../../../../development.md#environment-variables) |
| `.env.example`, `.env.reference` and `.env.staging.example` all fail `loadEnv()`. Only `.env.local.example` works. | [Environment variables](../../../../development.md#environment-variables) |
| `NODE_ENV=production` locally arms a deployed-task fail-fast; the orchestrator refuses to start. | [Environment variables](../../../../development.md#environment-variables) |
| `CCE_NAME_SUFFIX` renames tables but four modules read the unsuffixed literal anyway. | [Environment variables](../../../../development.md#environment-variables) |
| Vite does **not** always use port 5173, and binds `localhost` (IPv6 `::1`), so the IPv4 literal fails. Read the URL Vite prints. | [Troubleshooting](../../../../development.md#troubleshooting) |
| `GET /ready` returning `503` locally is **correct** — Slack and Telegram are genuinely unconfigured. | [Starting development](../../../../development.md#starting-development) |
| A poisoned row in `claudeclaw-dashboard-tokens` causes a permanent `401` with a correct token. Fix: `npm run local:provision`. | [Troubleshooting](../../../../development.md#troubleshooting) |
| Floci answers `ConverseStream` with 501; the replay-as-non-streaming fallback fires **only** when `AWS_ENDPOINT_URL` is set. | [Troubleshooting](../../../../development.md#troubleshooting) |
| `src/adapters/dashboard/jarvis.flow.test.ts` intermittently times out at 5000 ms. Pre-existing flake. Reproduce twice before chasing it. | [Troubleshooting](../../../../development.md#troubleshooting) |
| The IAM Copilot **degrades invisibly** locally: an empty findings list renders identically to "validated clean". | [Known local limitations](../../../../development.md#known-local-limitations) |
| The cost waste scan reports a **false clean** and caches it for 30 minutes. Local cost output is not meaningful. | [Known local limitations](../../../../development.md#known-local-limitations) |
| `npm run doctor`, `status` and `verify` fail rather than skip against an empty emulator. They give no useful local signal. | [Known local limitations](../../../../development.md#known-local-limitations) |
| `npm run test:paperclip:all` chains with `&&`, so when a test fails the `down` step never runs; clean up the disposable stack explicitly. | [Paperclip README §8](../README.md#8-exact-focused-and-full-validation-commands) |
| Docker Desktop's CLI is outside `PATH` on this machine; npm lifecycle scripts need it prepended, fixtures auto-detect via `LOCALAPPDATA` or `DOCKER_BIN`. | [Paperclip README §8](../README.md#8-exact-focused-and-full-validation-commands) |

### 5.5 Appended 2026-08-19 (docs consolidation)

| # | Entry | Detail |
|---|---|---|
| M13 | The single most load-bearing document in this feature — the 822 KB implementation plan — was left in a Claude temporary scratchpad for a day, and the feature README recorded that as an acceptable state ("an external session artifact (not tracked in this repository)"). | A temp directory is not a location. Anything a future phase must be built from belongs in the repository the moment it is written, even if it is large and even if it is historical. RESOLVED (that session). |
| M14 | The first session log was written before the feature folder existed and then never brought into the framework: untracked, no frontmatter, absent from the session index. | The origin record of a feature is the one log most likely to be needed and least likely to be reproducible. When a feature folder is created after work has started, back-fill the earlier logs into it in the same session. RESOLVED (that session). |
| M15 | The README and HANDOFF drifted three commits behind the code they described — the README still said "first-milestone validation only" after Phase 1 infrastructure landed, and the HANDOFF called a merged PR open. | Phase-completion commits must update the canonical two files in the same commit, not in a later documentation pass. |
| P12 | An adversarial audit of a plan is worth as much as the plan and must be stored beside it. | The audit found two cited paths that do not exist and a five-citation cluster with a systematic +92-line offset anchoring an architecture argument. A plan without its audit reads as more certain than it is. |
| A10 | The implementation plan is **historical**, not current. ADR 0010's amendment and `plan-audit.md` both outrank it. | Its "Paperclip source changes required: **None**" premise is dead — the harness runs a patched artifact. Do not quote the plan as a live constraint. |

### 5.6 Appended 2026-08-19 (OIDC and staging deploy)

| # | Entry | Detail |
|---|---|---|
| M18 | `infra/lib/{database,filesystem}-stack.ts` described their security groups with an em dash. EC2 rejects `GroupDescription` outside ASCII, so `CCE-STAGING-Filesystem` rolled back on first create. | The repo's prose style uses em dashes everywhere, so this will recur. Both stacks carried it; fixing only the one CloudFormation named would have failed again on the next stack. Guarded by a synth assertion in both stack test files. RESOLVED (`dac255a`). |
| M19 | The rolled-back `CCE-STAGING-Filesystem` left **orphans**: EFS `fs-08f70326911d2ae49` and log group `/claudeclaw-staging/paperclip` are `RemovalPolicy.RETAIN`, so CloudFormation logged `DELETE_SKIPPED` and abandoned them. | A rolled-back stack is not necessarily a clean slate. EFS names are tags, not unique keys, so a retry silently creates a *second* filesystem and bills for both. Check for orphans after any rollback of a RETAIN-bearing stack. |
| A14 | A staging deploy does **not** touch `ClaudeClawGitHubDeploy`: `iam-stack.ts` gates the role on `!isStagingDeploy` and staging sets `CCE_NAME_SUFFIX`. | Verified in source. Only a production deploy regenerates that trust policy, so an IAM hand-fix survives staging deploys indefinitely. This corrects the broader claim first written in P13. |
| M16 | After the org transfer, the trust policy was updated to the new **repo path** and the deploy still failed — a second session lost to an `AssumeRoleWithWebIdentity` error that reads like an AWS permissions problem. | An org transfer can change the claim **format**, not merely its contents. Decode the token's real `sub` before touching IAM. RESOLVED (`07a2570`). |
| M17 | A session committed with explicit `git add <paths>`, believing that scoped the commit — but a concurrent agent had staged its own work into the **shared index**, and `git commit` committed the index, sweeping ~900 KB of another session's docs into a commit whose message described a small refactor. | `git add <paths>` scopes what *you* add, not what the commit contains. When another process may share the working tree, verify with `git status`/`git diff --cached` immediately before committing, or use `git commit <paths>`. Corrected by splitting the commit in two. RESOLVED (`04c9f90`). |
| P13 | Set `CCE_GITHUB_IMMUTABLE_SUBJECT` **before the next production deploy**. Only the prod IAM stack creates this role (`iam-stack.ts` gates on `!isStagingDeploy`), so a prod deploy with the variable unset rewrites a hand-patched trust policy back to the classic form. Staging deploys never touch it. | The fix has two halves with a required order; reversing it re-creates the outage and looks like a regression. First stated without the prod-only qualifier — corrected against the code, per **P5**. |
| P14 | When an OIDC assume-role fails, decode the token's real `sub` before changing IAM. | The error names AWS; the cause was on GitHub's side. |
| A11 | `Adams-Captial-Holdings-Ltd/Netzer-Labs` mints **immutable** OIDC subjects: `repo:Adams-Captial-Holdings-Ltd@318461635/Netzer-Labs@1324639154:...`. | Verified twice on 2026-08-19 — a decoded token from run `32280530601`, and `sub_claim_prefix` from the OIDC customization API. Re-verify if the repo moves again. |
| A12 | The deploy workflow needs no repository or environment **secrets**; it reads only `vars`, all of which survived the transfer. | Verified with `gh variable list` and the per-environment variables/secrets API. `CDK_DIFF_ROLE_ARN` is still absent and still only affects the scheduled drift workflow. |
| A13 | The live `ClaudeClawGitHubDeploy` trust policy now lists the four id-bearing subjects and matches the fixed generator's output exactly. | Verified with `aws iam get-role` against the regenerated policy on 2026-08-19, so the next `cdk deploy` is a no-op on the trust rather than a flip-back. |
| Trap | A **production** `cdk deploy` rewrites `ClaudeClawGitHubDeploy`'s own trust policy; staging deploys skip the role entirely (`iam-stack.ts` gates on `!isStagingDeploy`). | [github-to-aws.md](../../../github-to-aws.md), `infra/lib/iam-stack.ts` |
| Trap | Phase 1's Aurora and EFS stacks have **no tier gate**, so Tier 0 staging provisions the same retained, deletion-protected cluster as production. | `infra/bin/app.ts`, `infra/lib/database-stack.ts` |
| Trap | The Paperclip bootstrap fixture aborts on a **stale** stack (`Active Paperclip integration keys exist without the in-memory credential cache`), not only a missing one. Reset the disposable stack per run rather than reusing one a previous session left up. | `tests/fixtures/paperclip-bootstrap.ts`, [README §8](../README.md) |

### 5.7 Appended 2026-08-19 (staging deploy green)

| # | Entry | Detail |
|---|---|---|
| M20 | Infrastructure that nothing consumes was wired unconditionally into the deploy path, so a failure in an unused experiment reported as a failure to ship application code. The orchestrator was healthy at 1/1 throughout. | Ship unconsumed infrastructure behind a flag from the first commit, not after it breaks a pipeline. `void database; void filesystem;` in `app.ts` was the tell — bindings that exist only to silence "unused" are infrastructure with no consumer. RESOLVED (`bc4909b`). |
| M21 | A local `scripts/ci/docs-mermaid.mjs` run reported 15 failures where CI reported 1, including blocks CI renders successfully. | The pinned renderer does not work on this Windows machine. Do not treat local mermaid output as signal; push and read CI. Add to the Windows environmental set with the four parser suites and the rollback path separator. |
| P15 | Before committing in a tree another agent may share, check `git diff --cached --name-only`. `git add <paths>` scopes what *you* add, not what the commit contains. | See M17. The index is shared; a concurrent `git add` rides along on your `git commit`. |
| A15 | Only a **production** deploy rewrites `ClaudeClawGitHubDeploy` (`iam-stack.ts` gates on `!isStagingDeploy`). | Proven from synthesized artifacts: 15 staging templates contain zero `ClaudeClawGitHubDeploy`; the prod template contains `GithubDeployRoleB0CF66A5`. Supersedes the broader claim first written in P13. |
| A16 | The EC2 non-ASCII constraint applies to security group descriptions, not to CloudFormation generally. | 9 live CloudWatch alarms in this account carry non-ASCII descriptions and are deployed and healthy. Do not "fix" em dashes outside EC2 SG descriptions. |
| A17 | Staging is green at `e8ba485` on task definition `claudeclaw-staging-orchestrator:8`, with `CCE_PAPERCLIP_ENABLED` unset so the Paperclip substrate is not deployed. | Verified 2026-08-19 by deploy run, `describe-services`, `describe-stacks`, and `GET https://staging.pgnos.ai/health`. |
| Trap | A rolled-back stack is not a clean slate: `RemovalPolicy.RETAIN` makes CloudFormation log `DELETE_SKIPPED` and abandon the resource. EFS names are tags, not unique keys, so a retry silently creates a second filesystem and bills for both. | `infra/lib/filesystem-stack.ts`; check for orphans after any rollback of a RETAIN-bearing stack. |
| Trap | `infra/bin/app.ts` is mapped to `docs/diagrams/architecture-compute.md` in `docs/diagrams.map`. Any change to it fails the drift gate without a diagram update or a verification note. | `docs/diagrams.map`, `scripts/ci/diagrams-drift.mjs` |

### 5.8 Appended this session (2026-08-19, Phase 1 ponytail audit)

| # | Entry | Detail |
|---|---|---|
| M22 | `bc4909b` gated the Paperclip stacks in `infra/bin/app.ts` and nowhere else, while `scripts/deploy.ts` phase a still named them and `cdkEnvBag` never forwarded the flag. Arming `CCE_PAPERCLIP_ENABLED=1` in `.env` therefore deployed **nothing**, and said so with a green deploy. | A feature flag in this repo has five homes (§3.1). Gating one is not gating the feature; it is creating a disagreement between synth and the deploy driver. When adding a flag, grep for how `CCE_CODEBUILD_ENABLED` is handled and match it in all five. RESOLVED (`e9de42b`). |
| M23 | Phase 1 shipped three ungated Paperclip side-effects that the later gate never covered: an ECR repo created on every deploy for an image nothing pushes, cost copy naming an Aurora cluster the deploy does not create, and a budget alarm raised $50 for a substrate that is off. | "Gate the stacks" is not the same as "gate the feature". After adding a gate, grep the whole repo for the feature's name and check every hit for whether it is now lying. RESOLVED (`e9de42b`). |
| A18 | **`cdk deploy`/`ls`/`diff` do not fail on an unmatched stack name when another pattern in the same invocation matches.** `validateStacksSelected` (`node_modules/aws-cdk/lib/cli/cdk-toolkit.js:1250-1254`) throws only when the total selected count is zero. | Verified by reading the installed `aws-cdk@2.1124.1` and demonstrated with `npx cdk ls CCE-Network CCE-Database` against a flag-off assembly: exit 0, `CCE-Database` silently absent. Never trust a green deploy to mean a named stack was deployed. |
| A19 | `estimateLine`'s estimator branch returns before the `privateEndpoints` clause is built, so the ~$220 endpoint note only ever appears when the estimator has **failed**. `scripts/cost-estimate.mjs` also prices no Aurora, EFS or RDS line item. | Do not copy the endpoints clause as a pattern — it is the buggy branch. Anything appended to the fallback alone is invisible on the path that normally runs. |
| A20 | `RESOURCE_NAMES` is derived from `CCE_NAME_SUFFIX` at import time, so asserting a synthesized name equals `RESOURCE_NAMES.x` compares the constant with itself. | `infra/lib/constants.test.ts:82,107-109` is the house precedent: assert literals, or call `buildResourceNames('')` explicitly. A test written the other way passes under any rename. |
| P16 | Do **not** gate the `/claudeclaw/paperclip` secret, or any other already-deployed `RETAIN` resource with a fixed name, behind a flag after the fact. | Removing it from the template makes CloudFormation `DELETE_SKIPPED` it. Secrets Manager names are unique keys, so a later re-arm fails `ResourceExistsException` — and the 7-day recovery window means even a deliberate cleanup is not instant. Gate before first deploy or not at all. |
| P17 | Do not merge `CCE-Database` into `CCE-Filesystem` or vice versa. | Both are `RETAIN`; Aurora is `deletionProtection: true`. A merged stack turns an EFS create failure into an orphaned, deletion-protected Aurora cluster. The plan's §14.6 describes a single combined stack that was never built — do not "restore" it. |
| A21 | Git Bash on this machine has **no coreutils**: `ls`, `cat`, `head`, `tail`, `grep`, `sed`, `sh` and `npm` are all absent from its PATH. | Use PowerShell for commands and the editor's own file tools. This is also why `scripts/release/buildspec-tag-normalization.test.ts` fails with `spawnSync sh ENOENT` — it is the same environmental cause as the rest of the **A9** set, not a code fault. |

### 5.9 Appended this session (2026-08-20, Phase 2 readiness)

| # | Entry | Detail |
|---|---|---|
| M24 | The out-of-band catalog was treated as if it drove teardown. It does not. `plan.catalogAppOwned` is parsed, classified and **printed** (`teardown.ts:582`); every actual deletion is hand-written, including the orchestrator ECR repo at `teardown.ts:801`. | The previous handoff's ECR instruction was "add it to `docs/out-of-band-catalog.json` so teardown removes it" — which would have produced a documented orphan. When a resource is created out of band, write the catalog row **and** the delete. Verified by grepping every use of `catalogAppOwned` before writing the comment that claims teardown removes it. |
| M25 | The Phase 1 audit deferred `observability-stack.ts:742`'s `retentionFromDays` as "still has its own dead `retentionFromDays`". It was **not dead** — `:80` called it. | "Dead" is a claim about callers, and it costs one grep to check. A deferred item inherited from a handoff is still unverified until you verify it. RESOLVED (`be807dd`). |
| M26 | Two consecutive handoffs carried "the ARM64 question is unanswered" as an unmet Phase 2 precondition requiring a `docker buildx` run. The base image had carried `linux/arm64` all along. | A precondition phrased as work-to-do can often be settled by **reading** instead. One anonymous GHCR token and one manifest GET closed a blocker that had been open across three sessions. Check whether a blocker is a question before scheduling it as a task. RESOLVED (**A22**). |
| A22 | The pinned artifact `ghcr.io/paperclipai/paperclip:2026.722.0@sha256:6b9daa3c…` is an **OCI image index** carrying `linux/amd64` (`sha256:6936579e…`), `linux/arm64` (`sha256:6ab3c816de36f9a69e9f462e950a153e3d30b6cbc03f9a78c5b140277fbafa25`) and two attestation manifests. | Verified 2026-08-20 by anonymous token + manifest GET against ghcr.io, HTTP 200. `vendor/paperclip/Dockerfile` pins the **index** digest, which is correct for multi-arch: the builder selects the platform. Re-verify on every re-pin — a slimmed upstream could drop arm64, and the whole compute plane is `CpuArchitecture.ARM64`. |
| A23 | `ComputeStack`'s HTTPS:443 listener exists **only** when `DOMAIN_NAME` is set, defaults to a **403** when `tier.cloudFrontEnabled`, and has priorities **1 and 2** already taken by `CloudFrontOnly` and `DirectHost`. | Now exported as an optional `httpsListener`. A Phase 2 listener rule must start at priority 3, carry its own condition, and handle the field being `undefined`. Target-group health checks bypass listener rules and stay green regardless. |
| A24 | `EnvBag` in `deploy.ts` has an index signature, so a new `.env` key reaches the deploy driver with no plumbing. `cdkEnvBag` is the `.env` → **synth** allowlist and matters only for values read during `cdk synth`. | `PAPERCLIP_BETTER_AUTH_SECRET` is consumed in phase b, so it correctly needs **no** `cdkEnvBag` entry. Do not cargo-cult the **M22** fix onto every new variable; ask whether synth reads it. |
| P18 | Never mint a secret value inside `planSecretWrites`. It runs on **every** deploy, so the value would be regenerated every deploy. | Generate once in `npm run setup` into `.env`, the shape `state.appEncryptionKey = state.appEncryptionKey ?? generateHexToken(32)` already uses. Rotating Paperclip's `better_auth_secret` invalidates every session. |
| P19 | `PutSecretValue` replaces the **whole** `SecretString`. A secret whose fields are owned by different phases needs `mergeExisting`, not a plain plan. | `/claudeclaw/paperclip` has one deploy-owned field and three minted against the running instance later. Before adding any secret plan, ask which phase owns each field. |
| P20 | `scripts/ci/diagrams-drift.mjs` diffs `origin/<base>...HEAD` — **committed** changes only. Editing a diagram without committing it does not clear the gate. | Costs a confusing re-run otherwise. Also: `compute-stack.ts` is mapped to **three** diagrams, so one source edit can require three notes. |
| Trap | `git commit -- <paths> -m "<msg>"` fails: everything after `--` is a pathspec. | Use `git commit -m "<msg>" -- <paths>`. |
| M27 | The Paperclip ECR create was added to `scripts/deploy.ts` phase a only. **CI does not run `scripts/deploy.ts`** — it runs `npx cdk deploy --all` and mirrors the phased driver with its own steps, so the fix would not have executed on the path that reaches staging. | The deploy driver has **two homes**, exactly as a feature flag has five (**M22**). The CI step's own comment already recorded the previous round of this: "scripts/deploy.ts does this for local deploys; the CI workflow never did, so the first staging deploy hit a 403". Grep `.github/workflows/deploy.yml` for anything you add to `deploy.ts`. RESOLVED (`c6d491f`). |
| A25 | **Staging deploys automatically on a push to the `staging` branch** (`on: push: branches: [staging]`). It is not `workflow_dispatch`-only. | **A4** says deployment "is `workflow_dispatch` only and requires typing `deploy`". That is correct for **production** and wrong for staging. Merging to `staging` IS a deploy. |
| A26 | **CI populates no secrets at all.** `put-secret-value` appears **zero** times in `.github/workflows/deploy.yml`, so `populateSecretsV2` never runs on the CI path — for any secret, not just Paperclip. | A staging deploy therefore leaves `/claudeclaw-staging/paperclip` at `REPLACE_ME` regardless of the phase-b plan. Pre-existing and architectural. Phase 2 needs a decision on how staging gets `better_auth_secret`. |
| P21 | Before re-deploying a `RETAIN`-bearing stack that previously rolled back, **check for orphans with FIXED names first**. | `filesystem-stack.ts:71` creates `/claudeclaw-staging/paperclip` with an explicit `logGroupName`, and **M19** says the 2026-08-19 rollback abandoned exactly that log group. CloudFormation cannot create a fixed-name log group that already exists, so the stack rolls back at the same point again. A tag-named resource like EFS fails differently and worse: it succeeds, and you pay twice. |

### 5.10 Appended this session (2026-08-20, image pipeline and Phase 2)

(entries appended as they are earned)

### 5.11 Appended this session (2026-08-20, Paperclip end to end)

| # | Entry | Detail |
|---|---|---|
| M28 | **Paperclip silently ignores unknown query parameters.** Sending `updatedSince` to a build without the vendored patch returns **HTTP 200 with the full, unfiltered issue list** — not a 400, not an error. | This is a silent data-correctness trap, and it is the failure mode a reconciler is least able to detect: it looks like a successful poll that just happened to return a lot of rows. Mitigated by the **A1-8 boot probe**, which asserts that `updatedSince=<now + 1h>` returns `[]` and refuses to start the reconciler if it does not. |
| M29 | The historical implementation plan's Paperclip line-number citations are from a **different revision** than the pinned tag, systematically — not the 16 one-off errors `plan-audit.md` catalogued. Checkout, release, comments and force-release all disagree by hundreds to thousands of lines. | Recorded as hard rule **A1-16**: never cite a Paperclip source line number as authority. Cite method + path + observed behaviour + the probe name that proves it. |
| M30 | ADR 0010's ratified watermark predicate `updated_at >= watermark + 1ms` is a **correctness hazard**, not merely a conservative choice. `updated_at` is microsecond-stored `timestamptz` while every API caller observes millisecond-truncated values, so querying `>= T + 1ms` permanently loses any row whose true timestamp falls in `[T, T+1ms)` and was not already in the processed page. | Superseded by C-2: query `>= (maxUpdatedAt − poll_overlap_ms)` and dedupe client-side on `(id, updatedAt)`. The ADR must be amended in the same PR as the reconciler. Prove it with a probe that writes two issues inside one millisecond. |
| M31 | `src/lib/paperclip/mission-projection.ts` hardcodes `createdByChat: 'paperclip'`, while `privacy-tools.ts` filters a subject's missions by `m.createdByChat === chatId`. Every Paperclip-origin mission would therefore **silently disappear from a user's GDPR export**. | A compliance regression with no test coverage, invisible until audited. Fixed by a Netzar-side provenance row written at create time; the test ships in the same PR. Blocking gate on Phase 7. |
| A27 | **The `updatedSince` patch is present and working in the running artifact.** Verified 2026-08-20 by grepping the built image: 14 occurrences across `/app/server/dist/routes/issues.js`, `/app/server/dist/services/issues.js` and `services/issues.d.ts`. | This is the first execution-time confirmation of ADR 0010's amendment; every prior statement was source-only. Re-verify on every re-pin. |
| A28 | Upstream now implements `updatedSince` natively: absent at `v2026.722.0` and `v2026.817.0`, present on master via PR #9050, released in `v2026.818.0-beta.1`. | The ADR amendment's re-pin rule is now live rather than hypothetical — **drop the patch** in the same change that bumps to a release carrying it. Until then the patch stays and A1-8 guards it. |
| A29 | **`A21` does not hold for every Bash in this repository.** The Bash tool in this session has coreutils, `sh`, `git`, `node` and `npm` on PATH. | `scripts/release/buildspec-tag-normalization.test.ts` passes here, which is why this session's baseline is 5 failing files where the previous session's was 6. Compare failing file **names**, never counts — exactly what **A9** already says. |
| A30 | `paperclip_disabled` is registered in all three places but has **zero callers** — it is inert. `neutralizeForPrompt` is likewise implemented, tested, and called by nothing. | Both are latent no-ops that read as shipped safety. The kill switch goes inside the client at every invoke so no caller can bypass it; `neutralizeForPrompt` is wired at the Jarvis and dispatch-ingest boundaries. |
| P22 | Set `PAPERCLIP_TEST_AUTH_SECRET` in **every** shell that touches the harness — including plain `docker compose ps`, which fails to interpolate the Compose file without it. | Broadens **P10**, which named only the vitest process. The failure message names the variable, but it looks like a Docker fault at a glance. |
| P23 | `/gsd-phase` and the GSD skill family operate on `.planning/ROADMAP.md`. This repository has no such directory and its process documentation forbids second copies of planning conventions. | Phase plans belong in `docs/features/paperclip/`. Do not stand up a parallel planning tree here; it is the exact drift **M1** records. |

### 5.12 Appended after the first live probe run (2026-08-20)

Eleven of thirteen contract probes ran green against the pinned artifact. These
are the facts that run produced, and several of them correct a document.

| # | Entry | Detail |
|---|---|---|
| A31 | **`GET /api/openapi.json` is reachable unauthenticated** and returns the full document: 475 paths, 704 KB, at the pinned digest. | This is the authoritative machine-readable contract (**A1-15**) and it needs no credentials, so the snapshot can be taken by anything that can reach the port. It settled two probe failures in minutes that a source read had left open. Take the snapshot from the running artifact, never from a source read. |
| A32 | The agent-key scope payload is `{name, scope: {kind: 'standard' \| 'task_bridge', …}}` — **nested under `scope`, with `name` required**. The `task_bridge` variant requires only `kind`; `projectId`/`projectIds`/`parentIssueId`/`parentIssueIds`/`allowedAssigneeAgentIds` are all optional. | The first A1-9 probe sent `{kind:'task_bridge'}` flat and omitted `name`, and got a bare `400 Validation error` that named nothing. Paperclip's validation errors do not tell you the shape; the OpenAPI does. |
| M32 | **The bar's own criterion A1-12 was wrong.** It asserted `/wakeup` answers **202** for both the run and the skipped envelope. The live OpenAPI declares **200** (plus 400/401/403) and types the response as an undocumented `additionalProperties: {}`. The probe observed `status: 'queued'`, not `'skipped'`. | The claim came from a source read of a 400 KB route file, which is exactly the class of claim **A1-16** already distrusts — it turns out status codes are as unreliable as line numbers when read at that scale. The bar's stated precedence already covers this: *a green contract probe against the pinned artifact beats all four documents*, and that includes the bar itself. Correct A1-12 against the artifact, and do not treat any unprobed status code in A1 as settled. |
| A33 | **C-3 is settled, and Packet 4 was right where Packet 1 was wrong.** A run-less agent actor can POST a comment and PATCH an issue: `commentRequiresRunId: false`, `patchRequiresRunId: false`, observed. | This is load-bearing for the ACL, which comments as a run-less actor. The ACL does **not** need to degrade to `wakeup` for comments. Recorded by characterization, not assertion. |
| A34 | **A1-8 is green against the patched artifact**: `updatedSince` one hour in the future returns `[]`. **C-2 is green**: an overlap-and-dedupe read sees same-millisecond writes exactly once. | These are the two blocking probes. A34 is the first end-to-end proof that the vendored patch does what ADR 0010's amendment claims, and that the C-2 predicate (`>= maxUpdatedAt − poll_overlap_ms` with `(id, updatedAt)` dedupe) is lossless where the ADR's `+1ms` is not. The reconciler may now be built on it. |
| P24 | **Reset the disposable stack before every probe run**, not just when one looks stale. | The fixture fails closed with `Active Paperclip integration keys exist without the in-memory credential cache` whenever a previous bootstrap left keys behind — and its credential cache is in `/dev/shm`, which **does not exist on Windows**, so on this platform the cache never survives a process boundary and the second run in a session always trips it. `npm run test:paperclip:down && :up` between runs. This broadens the existing Trap from "a stale stack" to "any second run on Windows". |

### 5.13 Appended at session close (2026-08-21)

| # | Entry | Detail |
|---|---|---|
| M33 | **A readiness gate can be catastrophic in the direction nobody checked.** Phase 4 made the Paperclip service's *existence* depend on a probe reading `cdk-outputs.json` — a **gitignored, machine-local** file — with a failure default of **omit the service**. On CI, a fresh clone, or a second engineer's machine the probe can never succeed, so `cdk deploy --all` would **delete a running Paperclip service and its listener rule**, print "re-run the deploy", and **exit 0**. | This is the cloudflared post-mortem repeating, whose own conclusion is quoted in `.github/workflows/deploy.yml`: *"Both directions have to be safe."* A gate that protects against starting a container against an unpopulated secret must not create a silent-delete path going the other way. When adding a readiness gate, write down what happens when the probe fails **on the resource that already exists**. |
| M34 | The five Paperclip CodeBuild IAM grants were written onto `cicdRole`, which `iam-stack.ts` creates **only** in the `!isStagingDeploy` branch — making a staging arm depend on a **production** IAM deploy. Verified against the live `ClaudeClawGitHubDeploy` role: every ECR grant was orchestrator-scoped and there were zero Paperclip statements, so an armed staging run would have failed `AccessDenied` at the ECR repo create **after Aurora already existed**. | Third instance of the shape **M22** and **M27** record. Fixed by mirroring into the staging branch with `Role.fromRoleName(...).addToPrincipalPolicy(...)` — the pattern `PublicTunnelReadinessStaging` already proves live in this account — narrowed to `claudeclaw-staging-paperclip*`. **Before granting anything to CI, read the LIVE role; the code is a plan, the role is the fact.** |
| M35 | Every one of the eight critic rejections across Phases 1 and 1.5 was the same defect class: **a claim no probe supported.** A wrong discriminator, a wrong status code, a wrong endpoint purpose, a fabricated `retryAfterSeconds` comment, a placeholder snapshot presented as a contract. | The remedy that finally worked was making "an honest `UNVERIFIED` marker beats a claim no probe supports" an explicit instruction. `ISSUE_LIST_DEFAULT_LIMIT` and friends now carry that marker, because the harness board is smaller than the thresholds and no probe can distinguish 500 from 5000. |
| A35 | **The pinned image ships its built UI and it serves.** `/app/ui/dist` (13 MB, with `index.html`) exists; the server resolves `../ui-dist`, which does not. With a symlink and `SERVE_UI=true`, `GET /` answers 200 `text/html` and `/assets/index-*.js` answers 200 with **6,484,747 bytes**. Runtime branding hooks exist (`PAPERCLIP_LOGO_SVG`, favicon markers). | Amends plan §16.6, which ruled "rebuild in Netzar". Its four reasons still hold but argue for controlling **access**, not rewriting. Re-verify on every re-pin: this is a path convention, not a supported contract — and §33 records upstream saying branding must not be counted on. |
| A36 | **Delegation needs no Paperclip change**, and the turn budget survives: `POST /api/issues/{id}/children` takes an **array** with per-child `assigneeAgentId`, so a fan-out to five agents costs **one** tool turn, not five. `wakeup` takes an `idempotencyKey`, so retries are safe. | But `suggest_tasks` is a trap: it looks ideal and its `/accept` is **board-only**, so an agent calling it stalls until a human clicks. And **co-owned projects have no model at all** — `leadAgentId` is a single uuid, zero hits for participant/watcher/collaborator across 475 paths, and `checkout` is an exclusive lock. Co-ownership must be one parent + N assigned sibling children, a Netzar convention. |
| A37 | `GET /api/companies/{cid}/timeline` is the **only fully-typed response schema** in the delegation area and returns `edges[]` with `kind: delegation\|assignment\|mention` — an **observed** collaboration graph, filterable by project. | Better than the org chart for the client-facing "see how agents work together" goal: `reportsTo` is hand-set and rots, the timeline is self-maintaining. Lead with the timeline, scoped by project. |
| A38 | **Open self-registration.** Probed live: `POST /api/auth/sign-up/email` returns **200 with no credential** even under `PAPERCLIP_DEPLOYMENT_MODE=authenticated`. | Matters the moment the board is reachable. Must be closed or fronted before any Netzar user can reach the UI. |
| P25 | Run one gauntlet per working tree. Two concurrent builder/critic loops sharing a checkout produced a red typecheck attributed to the wrong phase. | No damage — the builder proved attribution before proceeding — but it costs a confusing round. Serialize phases that share a tree, or give each a worktree. |
| P26 | `node scripts/ci/docs-mermaid.mjs --extract-only` runs the **node-budget** check WITHOUT rendering, so it is trustworthy on this machine despite **M21**. | M21 says local mermaid output is not signal. That applies to the *renderer* only. The budget check caught a 41-vs-40 failure locally in one second that would otherwise have cost a CI round trip. |


### 5.14 Appended this session (2026-08-21, phases 2 through 9)

| # | Entry | Detail |
|---|---|---|
| M36 | The Phase 2 client shipped a create body carrying `status`, and an `idempotencyKey` **without** `allowDuplicate: true`, while a comment cited A1-13's `200 + deduplicated: true` as proven. A1-13 proved that only for a body carrying `allowDuplicate: true` — and `client.ts` auto-retries any write that has an idempotency key. | Two independently harmless-looking choices combined into a duplicate-issue-on-retry bug. Caught only because the critic checked the *cited* probe rather than trusting the citation. **When a comment cites a probe as authority, open the probe and check that it proves the shape actually being sent.** RESOLVED this session — `status` deleted from `missionToIssueCreate`, `allowDuplicate: true` added, key made deterministic (`netzar-mission:<mission.id>`), pinned by a test asserting `not.toHaveProperty('status')`. |
| M37 | `types.ts` and `error.ts` shipped in the same changeset giving **opposite normative instructions** about the same two strings: `types.ts` said "Do not map them from prose; produce them first", while `error.ts` mapped them behind an UNVERIFIED marker. | Neither was wrong on its own; together they guarantee the next maintainer deletes one of them. A doc-vs-code disagreement inside one changeset is a defect even when the code is right — **P5** says fix the document, so `types.ts` now records what `error.ts` does and why. RESOLVED this session. |
| A39 | **A blind head-to-head is worth running and this project can win it.** Five rounds, three judges each (craft / three-year maintainer / consumer), both files anonymized and the A/B order deliberately flipped every round: ours was B, A, B, A, B and won **15 of 15**. | The alternating order is the control — without it a sweep proves position bias, not quality. Note what it did *not* do: the blind judges passed our client in round 1, while the bar critic kept rejecting it through round 4. **Winning blind is necessary, not sufficient** — beating a rival file says nothing about matching *this* artifact's observed contract. |
| A40 | `Agent(isolation: "remote")` does **not** reach a cloud machine from this session — the probe reported it running in a local git worktree under `.claude/worktrees/` with the same local Docker daemon. | So "run it in the cloud" is not available by that route. Do not assume the flag means what it says; probe it with `pwd` + `docker --version` before planning around it. |
| A41 | Creating a claude.ai cloud **routine** against this repo fails `HTTP 403 — You don't have access to a repository this routine uses`. `Netzer-Labs` is PRIVATE under the `Adams-Captial-Holdings-Ltd` org, and the Claude GitHub integration has not been granted access to it. A local `gh` login (scopes `repo`, `workflow`, `read:org`) does **not** carry over — the cloud has its own grant. | Probably a consequence of the org transfer (**M16**, **A11**). Unblocked only by an org owner authorizing the integration for that repo; it cannot be fixed from a non-interactive session and must never be worked around with a pasted token. |
| M41 | Phase 6's first critic passed every acceptance item, then named a loss channel: the route takes a durable 24 h claim BEFORE the work runs and the worker never rejects, so any post-ack failure was permanently swallowed — Paperclip got its 202 and would not retry. The compensating control its own contract names ("the reconciler is the mandatory mitigation for dispatch loss and must be live first") **does not exist**: Phase 5 ships observing-only and writes nothing even at `mode:'live'`. | A phase can satisfy every enumerated acceptance item and still ship a defect the acceptance list never thought to enumerate. Ask separately: *what does this lose, and what recovers it?* RESOLVED — transient failures release the claim, deterministic ones stay terminal. |
| M42 | The first fix released the claim on the THROW paths and missed that `runAgentTurn` has three refusal paths that **return normally**: the `sessions_frozen` kill switch, the turn-level rate limit, and the kill-phrase halt. They never reach the `catch`, so the claim was never released — a maintenance freeze silently ate the dispatch, and the board was told *"Please try again shortly"* when nothing ever would. **538 green tests said nothing**, because every test drove `Promise.reject` and none resolved a refusal-shaped result. | Found only because the verifier was told to prove it by EXECUTION. When classifying failures, enumerate what a function RETURNS as well as what it THROWS — and check whether your tests only ever exercise one of the two. RESOLVED by a typed `refusal` marker on `AgentTurnResponse`; the heuristic alternative (zero-cost/zero-token/empty-modelId) was deliberately rejected as fragile. |
| M43 | **A fix of mine was worse than the bug it closed.** Gating the kill phrase on `origin === 'human_chat'` correctly closed a low-severity Paperclip hole — and silently disabled the emergency stop for a human typing that phrase into an active **War Room** on Telegram and the dashboard, because that path diverts through `orchestrateWarroomTurn` with no origin. | This is **M33** in a new place: both directions have to be safe. Weigh what a fix BREAKS against what it closes; a silent loss of an emergency stop during an incident beats a hole that needs a high-entropy secret. Also note the trap in the obvious repair: the check does NOT go at the orchestrator, whose `userText` is a multi-speaker transcript — an agent's words would halt the fleet and a stale line would re-halt every round. It belongs at the entry points, on the human's raw message. RESOLVED via a shared check in `src/lib/warroom/kill-phrase.ts` (A3-1: the surface-agnostic layer, not duplicated into two adapters). |
| A45 | **11 production call sites reach `runAgentTurn`.** Every human-typed path halts on the kill phrase; five machine callers correctly do not. Two in-between states that nobody had enumerated also halt correctly: a stale `activeWarroomId` pointing at an ENDED room, and an active room plus an attachment (the divert is gated on `!attachment`) — both fall through to the ordinary chat call site. Slack has no War Room divert. | Verified by execution, not by reading. Re-verify this enumeration whenever a new divert, queue or orchestrator is added between an adapter and the turn loop; that is exactly the shape that was missed twice. |
| A46 | **Dispatch rollback is a BOARD-UI operation, not a scripted one.** There is no agent-UPDATE call anywhere in this repo — `bootstrap-core.ts` has `listAgents` and `createAgent` and nothing else — and none of the 21 probes exercises one, so the method and path that would rewrite an existing `adapter_config` are established by nothing green. | The acceptance item ("rollback is blanking that URL — a data edit, no deploy") still holds, but the edit is made in the Paperclip board by hand. Marked UNVERIFIED rather than guessed from the plan document, which A1-16 forbids and which is already wrong about this route's auth. |
| P29 | **Prove it by execution, not by reading.** Three consecutive verification rounds on Phase 6 each found a real defect with a throwaway probe, after a reading-based review had passed the same code. One of those verifiers caught its OWN false positive — a malformed mock threw before the code under test, so the right thing happened for the wrong reason — and re-ran. | Make "write a throwaway probe, then delete it and confirm `git status` is clean" an explicit instruction for any verifier of a failure-classification path. Reading finds the throws; only execution finds the returns. |
| P30 | **Follow-up owed, not done:** `src/lib/scheduler/queue-drain.ts:126` has the identical loss-channel shape and is PRE-EXISTING and outside Phase 6 — a scheduled task firing during a maintenance freeze is permanently consumed, because the refusal returns normally and the SQS message is then deleted. | Now trivially fixable using the `refusal` marker Phase 6 added to `AgentTurnResponse`. Recorded here rather than fixed so it is not lost; `src/agent/canary.ts:75` scoring a freeze as a canary failure is a cosmetic sibling. |
| M44 | **Six phases were validated with the feature flag OFF.** The whole integration is gated behind `CCE_PAPERCLIP_ENABLED`, so every "full validation, clean" exercised the LEGACY path. Phase 7's critic proved it: with the flag armed, `mission-tools.authz.test.ts` went 5/5 → 3/5, and CI runs flag-off so it would have stayed green forever while the new code's behaviour was asserted nowhere. | Bounded by luck, not diligence — a flag-on sweep found exactly the one file the critic named and nothing from Phases 2-6. **Validate a flag-gated feature in BOTH configurations, every time.** `npm test` AND `CCE_PAPERCLIP_ENABLED=1 npm test` are now both part of the pre-push list for this feature. RESOLVED — both now report 213 files passing with the identical 5-file environmental baseline. |
| A47 | `resolveOwned` swept the whole owner board TWICE per mutation via `paginateAll` (up to 100 pages) where legacy did one bounded `Limit=100`. This is not merely slow: **A1-10's refusal counts DISTINCT list reads in flight per actor**, so a mutation-heavy dashboard fan-out is exactly the shape that trips it. | Bounded in the same change. When porting a bounded query onto a paginating client, the bound is part of the contract, not an implementation detail. |
| A48 | **C-16's 8-char-prefix ambiguity was real, not theoretical.** `startsWith` silently picked the first match, so two missions sharing a prefix meant a mutation hit the WRONG mission. | Closed with a deterministic ambiguity error. That is a fix rather than a contract break: the ambiguous case could not previously succeed correctly, and the unambiguous cases stay byte-identical. |
| A49 | `infra/lib/compute-stack.ts` had to plumb `CCE_PAPERCLIP_ENABLED` into the Fargate task environment. Without it the flag is synth-time only and the ACL never arms in a deployed task. | The fifth home of the flag (**M22**). It defaults to unset, so the legacy stack serves — the safe direction. |
| P27 | A builder/critic loop must be capped, and the cap must be **reported as a cap**. Phase 2's first workflow exited `passed: false` at `rounds < 3` — not because it converged, but because it ran out of rounds with two criteria still failing. | Read the exit condition before concluding a phase failed on quality. A capped loop that is *close* deserves a focused follow-up round on the named failures, not a rebuild — the follow-up cleared both in two rounds while touching nothing that already passed. |
| M15 | A decision was put to the repository owner on a premise taken from **comments in the shipping code** rather than from the code's behaviour. Six comments — `infra/lib/iam-stack.ts:760, :838, :996` and `.github/workflows/deploy.yml:249, :354, :477` — all still assert that arming Paperclip in staging "depends on a production IAM deploy having run first". That was true before **M34** and has not been true since: `CCE-STAGING-Iam` exists, and already attaches all five `PaperclipCloudBuild*Staging` statements plus `PaperclipSecretPopulateStaging`, `EcrPushPaperclipStaging`, `EcrCreatePaperclipRepoStaging` and both migration grants to the shared `ClaudeClawGitHubDeploy` role via `Role.fromRoleName(...).addToPrincipalPolicy(...)`. | **P5 says the code wins when a document disagrees — a comment is a document.** The rule was applied to every external doc this session and not to the comments sitting beside the code being read. Verify a comment by synthesizing the stack and enumerating what it actually produces, exactly as an OpenAPI claim is verified by a probe. The six comments are corrected in this change. |
| P33 | The genuine defect the stale comments were hiding is **step ordering, not environment scoping**: an existing CI-enabled installation upgrading to this version runs the ECR, CodeBuild, secret-populate and migrate steps **before** the `CDK deploy` that creates their grants, so at the default tier (`clampTier('')` → Tier 1, which provisions Paperclip) all four fail `AccessDenied`. `deploy.yml:353` acknowledges it and offers a manual workaround. | Resolved by deploying `${CDK_STACK_NAME}-Iam --exclusively` early in the job so an upgrading installation grants itself what it needs in one unattended run. A **first** install is unaffected: `CCE_CICD_ENABLED` defaults empty so the role is never created, and opting into CI does one local deploy that lands the role and all fifteen statements at once. |
| P32 | `node scripts/ci/diagrams-drift.mjs` is **inert locally**. Without `GITHUB_BASE_REF` it prints "not a PR context, path validation only" and exits 0 — it validates that the mapped paths exist, and checks no drift at all. | A local green from this gate is not evidence a diagram is in step with the code it maps. `infra/bin/app.ts` is mapped (`docs/diagrams.map:4`), so any Phase 9 edit to it must update `docs/diagrams/architecture-compute.md` or carry a `drift-gate:` note — and only CI will actually enforce that. Verify the diagram by reading it, never by running the gate locally. |

### 5.15 Appended this session (2026-08-21, Phase 4 rework round 2)

| # | Entry | Detail |
|---|---|---|
| M38 | **M27 for the fourth time, and the most expensive shape of it yet.** Phase b.5 — compose `DATABASE_URL`, run the one-shot migration, abort on a non-zero exit — existed only in `scripts/deploy.ts`. CI does **not** run that script; it hand-mirrors each phase and then runs `npx cdk deploy --all`. `grep -n "migrat\|run-task" .github/workflows/deploy.yml` returned exactly one hit and it was a comment. So on the only driver that reaches staging and production, the schema was never migrated by anything: the service deliberately carries no `PAPERCLIP_MIGRATION_AUTO_APPLY`, so deploy 2 would have started an essential container against an empty schema, failed the rollout, and left `CCE-Paperclip` in `UPDATE_ROLLBACK` beside RETAIN + `deletionProtection` substrate (**P21**). | It failed *safely* — nothing would have been deleted — which is exactly why it survived a full review round: an M33-clean design can still be an unreachable one. **When a phase adds a step to `scripts/deploy.ts`, open `.github/workflows/deploy.yml` in the same edit and either mirror it or write down why it does not need mirroring.** RESOLVED this session — a `Migrate Paperclip database` step now sits between `Populate Paperclip secret` and `CDK deploy`, running `aws ecs run-task` + `ecs wait tasks-stopped` + an exit-code check, and hard-failing before the deploy rather than after it. |
| M39 | The round-1 workflow wrote the Paperclip secret and nothing granted it. `grep secretsmanager infra/lib/iam-stack.ts` returned only power-switch and public-tunnel statements — **zero** Paperclip statements in either branch — so the step would have died `AccessDenied` on its first armed run. | A capability added to a workflow is not added until the role can do it, and the role has two homes (**M34**). RESOLVED this session — three statements in the `!isStagingDeploy` branch and three mirrored `*Staging` ones, asserted by name in `paperclip-stack.test.ts`. **Still a prerequisite, not a fix:** the grants are created by the CDK deploy later in the same job, so they must land in a prior UNARMED deploy, and the live `ClaudeClawGitHubDeploy` role is the fact worth reading before arming. |
| M40 | `SYNTH_INPUT_ALLOWLIST` still carried `CCE_PAPERCLIP_SERVICE_READY` — a variable from the **rejected** design, referenced nowhere else in the tree — under a comment claiming synth "creates the FargateService only when the readiness gate is '1'", which is precisely the behaviour **M33** forbade and the code no longer has. Meanwhile the flag that *does* change synth output, `CCE_PAPERCLIP_BOOTSTRAP`, was missing from the list. | A replay list is executable documentation: a stale name there is a promise that a rollback will re-apply a gate that no longer exists. Worse, that particular name could only ever *remove* a resource. RESOLVED this session — removed, `CCE_PAPERCLIP_BOOTSTRAP` added, the comment rewritten to say why the old name must never come back, and a colocated test asserts both directions. Two diagram files carried the same stale claim and were corrected. |
| A42 | A comment can be *right about the decision and wrong about the evidence*. `paperclip-stack.ts` justified using `curl` in the health check by asserting the orchestrator's `wget` "is not" in the image. `curl` is genuinely there and `wget` is genuinely there too, at `/usr/bin/wget`. | The choice was fine; the reason given was false, and a false reason is what the next reader deletes the choice on. **A1-16 in miniature: state what the probe proved, not what it implied.** The comment now says `curl` was probed present and names the cost of naming a binary the image lacks (UNHEALTHY forever, which at `minHealthyPercent: 0` is an outage). |
| A43 | `resolvePaperclipMigrationTargets()` read the **gitignored** `cdk-outputs.json`. That was already M33-safe (its only consumer aborts, it removes nothing), but `null` still meant "a fresh clone" far more often than "not deployed" — and an operator on a fresh clone of a *working* environment would have been told to set `CCE_PAPERCLIP_BOOTSTRAP=1`, which scales the running service to zero. | Live CloudFormation answers the same question identically from anywhere, and `cloudformation:DescribeStacks` was already granted. Re-sourced this session; a non-`ValidationError` failure now aborts instead of masquerading as "not deployed". It is also what let the CI step reuse the same four outputs instead of inventing a second protocol. |
| A44 | **The image bump is the same two-deploy protocol as the first arm, and that is stated rather than hidden.** Both drivers run the migration task definition the *previous* deploy created, so an image that introduces a migration must ship with `CCE_PAPERCLIP_BOOTSTRAP=1` and then be cleared. | `vendor/paperclip` is content-tagged and changes only when its Dockerfile or patch changes, so this is rare. Named in `.github/workflows/deploy.yml` at the migration step, because an unnamed constraint is one somebody hits at 3am. |
| P28 | Both critics that mattered here disagreed about *what kind* of defect blocks a phase: the bar critic rejected on a reachability gap (the migration never running on CI), the blind judges passed the same file three times. | Blind head-to-heads test whether the artifact reads well; they do not test whether it *works on the path that reaches a customer*. Run both, and let the bar critic's verdict govern (**A39** already says winning blind is necessary, not sufficient — this is the second instance). |

### 5.6 Appended 2026-08-22 (phase 8 verification and phase 9)

| # | Entry | Detail |
|---|---|---|
| M14 | A red test was carried across a session boundary as evidence of a product defect. It was a defect in the **probe**: `PROBE 7` invoked `schedule_task` with `prompt` where the tool's parameter is `prompt_text`, so the tool refused the call, `createScheduledTask` was never reached, and the assertion read `undefined` — indistinguishable from an unimplemented feature. | Instrument a failing probe before believing it. One line printing the tool's own return value (`{"text":"prompt_text is required","isError":true}`) and the spy's call count (`0`) settled in one run what the handoff had carried forward as an open defect. **A red test that means the opposite of what it says is worse than no test.** |
| P31 | A verifier's throwaway probe must assert that the call it is probing actually **happened**, not only that the result looks right. `expect(created[0]?.deliveryTarget)` reads `undefined` both when the field is missing and when nothing was ever created. | Assert the arrange step (`expect(spy).toHaveBeenCalledTimes(1)`) before asserting the outcome, so a refused call fails loudly as a refused call. |
| A47 | Phase 8's identity scheme is verified on the wire, not inferred: the Telegram push from the research bot's conversation leaves over `botTOKEN-RESEARCH`; the per-agent Slack push carries that app's own bearer token; `schedule_task` stamps `42:bot-research` and the reply fires over the research token when the task runs. | Established by 12 probe cases driving the real routers with only `fetch` and the DDB-backed lookups stubbed. This supersedes the previous handoff's "Phase 8 was closing the wrong Telegram bot token" as an **open** item — it is closed. |

### 5.16 Appended 2026-08-24 (completion audit reconstruction)

- **RESOLVED (`7220d3e`)**: the assignment push uses the conversation's bot/app
  identity and propagates the real send result. The real-router probe observed
  the research Telegram token, correct Slack main/per-agent/thread identities,
  and honest 403/`not_in_channel` failure text.
- **RESOLVED (`7220d3e`)**: dispatch's genuine Paperclip run id now reaches
  `ToolContext`; ordinary chat omits it. Successful comment and subtask writes
  each produce exactly one audit event with actor, surface, chat, issue/parent,
  action, tool, and run when present.
- **A48 supersedes A36's request-shape claim**: the 2026-08-24 pinned live probe
  proves `POST /api/issues/{id}/children` rejects an array and accepts one
  object. Title-only defaults to backlog/medium/unassigned with
  `requestDepth: 1`; explicit parent and assignee persist. The company issue-
  create route with `parentId` remains the safer tool implementation because its
  deterministic idempotency behavior is already proven.
- The live characterization also proved that run-less work-product creation
  records no actor/run attribution and that complete/release after the fixture
  adapter fails both return `409 Issue run ownership conflict`. Do not add those
  verbs until a genuine-run lifecycle is proven.
- **M45 — corrected before implementation spread:** the critic shorthand
  "priority numeric remains, `dueAt` remains" was initially misread as a request
  to preserve both. The Phase 9 authority at `bar-and-phases.md:472-476` says the
  opposite: switch to Paperclip's four priority bands and remove public
  `dueAt`. The builder was corrected before applying domain edits. Read the
  phase authority, not a compressed verdict, whenever wording is directional.
- **P32 — interruption boundary:** both builders were stopped mid-phase. A
  read-only inspection found the intended workflow occurrence cleanup and the
  `paperclip-tools.ts` priority patch present, but no command has verified that
  state. Inspect current diffs before applying anything; never replay a patch
  from this prose blindly.
### 5.17 Appended 2026-09-01 (staging readiness and per-install auth model)

| ID | Type | New finding | Required correction or precaution |
|---|---|---|---|
| M46 | Mistake | Healthy staging endpoints masked broken sign-in because a placeholder Better Auth secret was nonfatal. | Keep deployment fail closed for missing, placeholder, or short secrets and rerun staging before declaring sign-in ready. |
| M47 | Mistake | The initial probe reused the orchestrator task without deployment permissions to run it and inspect its logs. | Add least-privilege ECS, Compute-role PassRole, and orchestrator log-read grants. |
| P34 | Precaution | CloudWatch ingestion is asynchronous; an empty first read is not a passing probe. | Retry for a bounded interval and require every expected redacted marker. |
| A50 | Assumption clarified | One customer installation owns one Paperclip instance/company; `BETTER_AUTH_SECRET` is an internal per-install secret. | Promote the decision to README/ADR; keep generation and storage in per-install setup and AWS Secrets Manager. |
| P35 | Precaution | A repository-wide secret would incorrectly centralize customer authentication material. | Use GitHub environment secrets only for Netzer-operated environments; never use one fleet-wide customer secret. |

### 5.18 Appended 2026-09-02 (staging probe cut and deploy)

> Sections 5 through 5.17 above are the 2026-09-01 file's section 5 copied
> verbatim, including its own pointer to the 2026-08-24 file. Numbering
> continues from the highest IDs used there: M47, P35, A50.

| ID | Type | New finding | Required correction or precaution |
|---|---|---|---|
| A51 | Assumption re-verified | M6 (Vitest fails in a Windows linked worktree) does **not** reproduce in `C:\dev\Netzer-Labs\.worktrees\paperclip-promote` on 2026-09-02: focused runs of 148 tests in 4 files, then 76 and 37, all passed, and the full `npm test` collected 240 files and ran 3010 tests here. | Keep M6; it is machine- or checkout-specific, not universal. Try the worktree first; fall back to a normal clone only if the `Cannot read directory` startup error appears. |
| M48 | Mistake | `HANDOFF.md` (2026-09-01) said the work was committed through `9b5edad` and PR #133 was green while six files — `infra/lib/iam-stack.ts`, `infra/lib/paperclip-stack.test.ts`, `scripts/lib/paperclip/bootstrap-core.test.ts`, `scripts/paperclip-bootstrap.ts`, `src/ops/paperclip-phase-probe.ts`, `src/ops/paperclip-phase-probe.test.ts` (189 insertions) — were uncommitted in the worktree, and the session file called itself a "handoff-only closeout". | Run `git status --short` and `git diff HEAD --stat` before writing source state, and paste the file list. "Committed" means the working tree is clean for every file you name. |
| M49 | Mistake | `HANDOFF.md` recorded "all eight checks PASS" for PR #133; GitHub reports nine (five CI jobs, four Docs CI jobs). | Count from the checks list and name the jobs. |
| M50 | Mistake | Three test counts in the 2026-09-01 file's section 7 were wrong: "2 files, 73 tests" was 87 (73 is `paperclip-image-pipeline.test.ts` alone); "49 tests" in `infra/lib/paperclip-stack.test.ts` was 52; "189 tests in 5 files" measured 190. That file is history and is left unedited. | Record test **file names** with cause; if you record a count, copy it from the runner's own summary line, never from memory. |
| M51 | Mistake | An uncommitted probe change renamed every object key to `<field-N>`, so the redacted shape no longer said which fields exist — the one thing Phase 8.5 needs from the probe. | Reverted to `safeShapeKey`: real field names stay, UUID-shaped keys become `<uuid-key>`, values are always typed placeholders. Redaction must remove values and identifiers, not schema. |
| M52 | Mistake | `scripts/paperclip-bootstrap.ts` carried dry-run branches after an unconditional `return`; `reconcileKey` had a `dryRun` parameter that all 10 call sites passed as `false`; `bootstrap-secret.ts` exported `dryRun`/`warn`/`errorName`/`writeBootstrapSecretFields` that no live caller used. | Dead-by-construction code deleted (`bootstrap-secret.ts` 130 → 96 lines). A parameter with one constant value is not a feature; it is a lie the tests then keep alive. |
| M53 | Mistake | `PAPERCLIP_DISPATCH_URL` / `CCE_PAPERCLIP_ADMIN_EMAIL` were threaded into the orchestrator task definition (`compute-stack.ts`, `scripts/deploy.ts`, `manifest.ts`, `env.ts`, `deprecations.json`, two `deploy.yml` synth steps, a diagram drift note, a vars-presence test) although no runtime code read them; only the local bootstrap script does. | Cut with every ripple; `git diff origin/development` is empty for `manifest.ts`, `deploy.ts`, `env.ts`, `deprecations.json`, `rollback-classes.md`. Before injecting an env var, name its reader. |
| M54 | Mistake | Source-text assertions (`readFileSync` + `toContain`/`indexOf` on a sibling `.ts` file) in `paperclip-stack.test.ts` and `bootstrap-core.test.ts` were counted as proof of behaviour. | Deleted; replaced by seven behavioural `bootstrap-secret` tests (fail-closed ×3, `REPLACE_ME`/empty, corrupt `agent_keys`, valid map unchanged, merge preserves prior fields). A test that reads source text proves the text exists, nothing more. |
| M55 | Mistake | The bootstrap wrote a `dispatch_secret` checkpoint with a second `PutSecretValue`, producing two Secrets Manager versions per run and breaking the "one bootstrap, one version" contract the no-op re-run check depends on. | Removed; exactly one `PutSecretValueCommand` call site remains (`scripts/paperclip-bootstrap.ts:382`). Verify with the version count before and after a run (2 → 3, then 3 → 3 on the no-op). |
| A52 | Assumption | On this Windows checkout (`core.autocrlf=true`) `npm test` exits 1 on exactly five files this branch does not touch: `scripts/ci/docs-links.test.ts`, `scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`, `scripts/release/sync-deprecations.test.ts` (each `SyntaxError: Invalid or unexpected token` at collect; the `.mjs` each imports is `i/lf w/crlf` including its `#!/usr/bin/env node` line and runs directly with exit 0) and `scripts/lib/lifecycle/rollback-classes.test.ts > deploys the archived assembly with --app and diffs first` (`/tmp/fake/cdk.out` vs `\tmp\fake\cdk.out`). CI's Linux `Typecheck + Unit Tests` job passed at `291a457` (run 33639063032). | Treat these five, by name, as the Windows baseline. Any other failing file is a regression. |
| P36 | Precaution | Record failing test **file names** with cause; never counts alone. | Counts change with every cut and were wrong three times in one session file (M50). |
| P37 | Precaution | In Git Bash, prefix `aws` calls that take a leading-slash argument (`--secret-id /claudeclaw-staging/paperclip`, log-group names) with `MSYS_NO_PATHCONV=1`. | MSYS rewrites the argument into a Windows path and the call fails validation. |
| P38 | Precaution | Diff secrets by field name and set/`REPLACE_ME` state only; the dry-run prints names, the deploy step prints "value not shown". | No handoff, log, PR or chat ever carries a value. |
| P39 | Precaution | The probe cannot be pre-flighted against the running orchestrator: task definition `:13` predates `dist/ops`. Its first live run is inside the staging deploy run, after the tenant bootstrap. | Do not open the `qa` → `staging` PR until the bootstrap's no-op re-run has been proven; the probe fails correctly on `REPLACE_ME` fields. |
| M56 | Mistake (found by the probe) | Paperclip's `privateHostnameGuard` (authenticated/private mode, pinned `v2026.722.0`) answers 403 to every request — `/api/health` included — whose Host is neither loopback nor in `PAPERCLIP_ALLOWED_HOSTNAMES`. The stack never set that variable and `config.json` holds `server.allowedHostnames: []`, while the orchestrator dials the Cloud Map name `paperclip.claudeclaw-staging.internal`. The probe's first live run (staging Deploy run 33733071639 attempt 4, task `e071943c4f2c45b2be381ddd3073c0b7`) was refused on its first `GET`; every earlier check had gone through the SSM tunnel, whose Host is `127.0.0.1`. | Set `PAPERCLIP_ALLOWED_HOSTNAMES` on the Paperclip task definition to the bare Cloud Map hostname (upstream `server/src/config.ts`: comma list, lowercased, replaces the file list; the guard compares `URL.hostname`). Pinned by a literal test. When a private service is reached through a tunnel, force the real Host header at least once. |
| P40 | Precaution | The guard reads `x-forwarded-host` before `Host`, so a forged forwarded header (`127.0.0.1:3100`) bypasses it — observed 200 over the tunnel. | Never use it as a workaround; it disables the control silently. |
| M57 | Mistake | `stop_forward` in the operator helper used `pkill`, which this Git Bash does not have, so the first dry port-forward check leaked a `session-manager-plugin.exe` (PID 106732) for six hours; the piece-5 critic found it. | Kill the plugin by image name with `taskkill //PID … //F` (`tasklist //FI "IMAGENAME eq session-manager-plugin.exe"`); verify with `netstat -ano \| findstr :3100`. |
| A53 | Assumption | The orchestrator image's `[build]` stage (`npm install` with devDependencies, `aws-cdk-lib` included, under QEMU arm64) sits on npm's socket-inactivity timeout: 259 s in the bar run, `read ETIMEDOUT` at ~266-274 s in two consecutive attempts, one 83-minute stall before that; `deps` and `web` stage timings matched the bar to the second; lockfiles and Dockerfile unchanged since `ac70509`. | Re-running is the current remedy (attempt 4 built in 9 m 19 s). The durable fix is one `ENV npm_config_fetch_timeout=…` line in the `[build]` stage, or not installing `aws-cdk-lib` in the image build at all; it belongs to its own PR. |
| P41 | Precaution | ECS forgets stopped tasks after about an hour, so the probe task cannot be found by `list-tasks --desired-status STOPPED` later. | Find it in CloudWatch: `describe-log-streams --order-by LastEventTime --descending` (no prefix — the API refuses prefix + LastEventTime), then `filter-log-events` for `PAPERCLIP_PHASE_PROBE` on each candidate stream. |
| M58 | Mistake (found by the probe) | With the hostname allowed (run 33773788920), the probe's fetch never got a response, in two attempts, the second with no Paperclip change. Upstream `server/src/config.ts` resolves the bind mode as `PAPERCLIP_BIND` ?? `config.json` `server.bind` ?? inferred from `HOST`, and `resolveRuntimeBind` maps `loopback` to `127.0.0.1` whatever `HOST` says. The EFS `config.json` holds `server.bind: loopback` (writer not identified: `auth bootstrap-ceo` only reads; quickstart onboarding would have written `lan` from `HOST=0.0.0.0`), so the task booted after the hostname fix listened on loopback only while its localhost health check kept passing. The task it replaced had booted before the file said that, which is why it could answer the 403. | Set `PAPERCLIP_BIND=lan` explicitly on the task definition beside `HOST`; pinned by a literal test. Every knob the file can override must be set by the task definition, or a re-boot silently inherits whatever the file accumulated. |
| P42 | Precaution | A container health check on `localhost` cannot see a listener that shrank to loopback; ECS, CloudFormation and the deploy all report green while nothing in the VPC can connect. | The probe is the only check on that path; read its failure code literally — `request-failed-before-response` means no TCP/HTTP answer at all, not a refusal. |
| A54 | Assumption (now evidence) | Run 33783021194 recorded the live shapes: `/api/companies/{cid}/org` is an array of agents with nested `reports`; `/api/agents/me` is a wide object (`access`, `chainOfCommand`, `orgChainHealth`, `reportsTo`, `permissions` among its keys); goals are `{companyId, createdAt, description, id, level, ownerAgentId, parentId, status, title, updatedAt}`; `goals-list` is an empty array on a fresh company; `org.svg` is served as `image/svg+xml`. Values were never logged, only types. | Phase 8.5 types `org.ts` and `goals.ts` against these shapes (promoted to README section 6), not against the OpenAPI's `additionalProperties: {}`. |
| P43 | Precaution | Seven deploy attempts were needed for three green-capable runs: two npm timeouts and one stall in the emulated image build (A53), then two probe findings. Each attempt costs ~30 minutes. | Budget an hour per staging round trip and keep the AWS session alive across it (`aws login` lasts less than the ladder did). |
| M56 | Mistake | This file's first draft copied the comment at `infra/lib/compute-stack.ts:236-244` ("secrets-stack.ts creates all four … `company_id` … with the secret itself") into section 3.3 as a convention. The code disagrees: `infra/lib/secrets-stack.ts:113-118` creates `better_auth_secret`, `reconciler_key`, `agent_keys`, `dispatch_secret` only, and `company_id` is merge-added as `REPLACE_ME` by deploy phase b (`scripts/lib/lifecycle/deploy-phases.ts:300-302`). Caught by the piece-4 critic. | M15 again: a comment is a document, and P5 applies to it. Before writing "X creates Y", open the constructor or the plan that creates Y, not the comment beside its consumer. The comment itself stays wrong in source until the deferred fix in section 6.4 lands. |

### 5.19 Appended 2026-09-03 (staging probe green and two findings)

| ID | Kind | What happened | What to do about it |
|---|---|---|---|
| M59 | Mistake | The closing docs critic found a stale sentence (README section 2: the probe completion "remains local and has not yet produced deployment evidence") that a literal grep sweep for "not yet deployed" had missed. | Sweep for meaning, not strings: read sections 2 and 3 of the README together whenever section 3 changes; the critic's job includes semantic staleness. |
| A55 | Assumption (now evidence) | A full staging round trip on this pipeline costs about an hour and the ladder about 15 minutes; `aws login` expires in roughly two hours. Three of seven deploy attempts this session died in the emulated image build before any code ran. | Renew the AWS session at the start of each round trip; budget an hour per attempt; ship the `npm_config_fetch_timeout` fix (A53) before the next long campaign. |
| P44 | Precaution | The previous Claude Code process died on a memory-starved machine (309 MB free of 16 GB) while several vitest and synth processes from concurrent critics were running; every external command then hung. | Do not run two critics that both synthesize or run vitest at the same time on this machine; check free memory when commands start timing out; the harness may then report completed agents as lost after a restart even though their verdicts were received. |
| P45 | Precaution | The harness reported the three critics of this session as "did not complete" after a process restart; all three verdicts had in fact been received and acted on before the restart. | Trust the journal and the recorded verdicts, not the restart notification. |


### 5.20 Appended 2026-09-05 (goal-first missions engine)

| ID | Type | New finding | Required correction or precaution |
|---|---|---|---|
| A56 | Assumption (one green run) | Staging run 33989570600's build stage took 251.6 s vs 230.9 s in the bar, both under the old 300 s default fetch timeout. | Run 33989570600 did not exercise the new timeout, so the causal claim for A53 stays open. |
| P46 | Precaution | A process restart orphaned a Monitor, a background watch and the running P0-3 workflow; the builder result was already in the journal and only the critic needed to be re-run by resuming the workflow. | Read the journal before rebuilding anything a restart appears to have lost. |
| M60 | Mistake | `create_mission` stamped the SESSION scope `ctx.agentId` as creator while `list_missions`/`update_mission` judged the BOARD scope `ctx.boardAgentId ?? ctx.agentId`, so under Telegram's sticky default the agent that opened a mission could not transition it. Corrected by `boardSelf`. | Provenance and authorization must use one identity; a test must exercise the surface where the two scopes differ. |
| P47 | Precaution | graft indexes the main checkout, not a branch with uncommitted edits. | On such a branch, use grep/sed in the worktree for changed files instead of graft. |
| M61 | Mistake | Focused critic sets passed while the full suite failed on two adapter parity tests whose partial vi.mock omitted the new exports; P4 caught it. | A critic for a src/lib change runs the full suite; partial module mocks spread importOriginal. |
| A57 | Assumption (now evidence) | Another session promoted unrelated work (#151-#155) through the ladder while this session was blocked; staging run 34004002068 armed Paperclip before the Phase 0 branch deployed. | Check `git log origin/development` and `gh run list --branch staging` at every resume; a variable set for the next deploy is consumed by whichever deploy comes next. |

### 5.21 Appended 2026-09-06 (P0-2 dispatch-push fix)

| ID | Type | New finding | Required correction or precaution |
|---|---|---|---|
| M62 | Mistake | The ADR 0010 :316-321 push payload was a source reading, marked UNVERIFIED; measured 2026-09-06 as `{netzarAgentId, agentId, runId, context{issueId, ...}}`: the dispatch parser wanted a top-level `issueId` and 400'd every push; no agent turn was ever driven by Paperclip in staging until the fix landed. | A shape marked UNVERIFIED that gates a whole path must be probed before the flag flips, not left unverified until an incident. |
| M63 | Mistake | The bootstrap armed only `dispatchSlugs=['main']` and never patched a reused agent, so Research had no `url` and Paperclip escalated its issues to Main. | Idempotent create is not reconcile; a bootstrap re-run must repair drift on existing agents, not skip them. |
| A58 | Assumption (now evidence) | Paperclip 2026.722.0 does not dedupe wakeups by `idempotencyKey` -- the field is only stored, never looked up. | Netzar's own `(runId, issueId)` claim in `paperclip-dispatch.ts` is the only de-dupe guard; do not rely on upstream idempotency. |
| A59 | Assumption (now evidence) | The same legacy DynamoDB mission-tasks table also stores provenance sidecar rows (`{PK,SK,missionId,createdByAgent,createdByChat,assignmentReason}`) written by the Paperclip branch. | Its raw item COUNT is not the legacy mission count; filter by row shape before citing a count. |
| A60 | Assumption (now evidence) | `status:"blocked"` is not dependency state on this artifact -- Paperclip rewrites status to `blocked` after an `adapter_failed` run, independent of the blocking graph. | Read `blockerAttention` (list) or `blockedBy` (detail) for dependency state, never `status`. |
| P48 | Precaution | A characterization issue assigned to an agent whose adapter is broken (no `url`) gets reassigned by Paperclip's escalation path within about a second. | Assign characterization issues only to an agent whose adapter is known-working, or the probe measures the escalation path instead of the intended one. |
| P49 | Precaution | `tool_invoke` audit rows are written only by tools that call `writeAudit` (`paperclip_add_comment`, `paperclip_create_subtask`); `mission-tools.ts` has none. | Expect audit coverage per-tool, not per-surface; a missing `tool_invoke` row for a mission mutation is a known gap (P49), not evidence of a broken guarantee. |

### 5.22 Appended 2026-09-06 (P0/P1 state and 8.5 bridge)

| ID | Kind | What happened | What to do |
|---|---|---|---|
| M64 | Mistake | P0-0's fetch-timeout knob shipped on a source reading; the next failure (run 34045747255 attempt 1, 268.6 s) proved it irrelevant: the kernel socket timeout fires first and npm already retries it. | Fix the cause (do not download the 117 MB dev tree under QEMU), not the timer. |
| M65 | Mistake | Ledger A53 attributed two 2026-09-03 deaths to run 33773788920; the API shows both its attempts passed Build + Push. | Cite run ids and attempts from `gh api .../runs/<id>/attempts/<n>/jobs`, never from memory. |
| A61 | Assumption now evidence | Paperclip's http adapter treats the POST response as the run result: a run is `succeeded` in under a second; recovery re-dispatches under new run ids; the agent's own status PATCH is refused while a run holds the issue. | Characterize the disposition protocol from the image before touching the worker (next action 3). |
| A62 | Assumption now evidence | A foreign board's rows are projected without the provenance join, so `createdByAgent` reads `paperclip` there. | P0-3b. |
| P50 | Precaution | Agents that must read credentials into the shell trip the safety classifier when the brief says so in credential words; phrase such briefs as the repository's documented runbook. | Two agents were blocked before their first command this session. |
| P51 | Precaution | Resume paths under a worktree-keyed session directory are refused by the Workflow tool; relaunch inline. | Cost two turns this session. |

### 5.23 Appended 2026-09-07 (P1 hierarchy closeout)

| ID | Kind | New finding | Required correction or precaution |
|---|---|---|---|
| M66 | Mistake | `npm run deploy:cloud` is hardcoded to PRODUCTION's CodeBuild project (`claudeclaw-orchestrator-deploy`, us-east-1) with no `--env`, no confirmation and no source-branch guard, yet `CLAUDE.md` recommends it for "normal feature work"; `npm run deploy` likewise defaults to `--env=prod`. | The only safe staging deploy is merging the `qa`→`staging` promotion PR; never run either `deploy` command against a feature branch. |
| M67 | Mistake/Assumption | A feature can be "critic-passed piece by piece" and still never have been run through the full suite or pushed — `ci.yml` triggers only on `development`/`qa`/`staging`/`production`, so a `feat/*` branch is invisible to CI for its entire life. | Piecewise critic passes are necessary, not sufficient; schedule a full-suite, both-flag-states close-out pass before calling a feature done, exactly as this session did for Phase 1. |
| A63 | Assumption (now evidence) | The CI test job never sets `CCE_PAPERCLIP_ENABLED`: `ci.yml` does not mention it at all, so the flag-ON suite M44 made mandatory exists ONLY as a local, manually-run gate. (`deploy.yml:943` and `:1053` DO set it, but those populate the deployed task environment, not the suite that gates a PR.) | Nothing in CI will ever catch a flag-ON regression; a flag-on pass recorded in a session handoff is the only evidence that configuration was ever exercised, and it must be re-run by hand every session that touches Paperclip-gated code. |
| P52 | Precaution | A usage-limit kill can leave a workflow journal with ZERO result lines while a dead builder subagent has already written real files into the worktree. | `git status` the tree before relaunching a killed workflow, or the already-finished work is silently discarded and rebuilt from scratch. |
| P53 | Precaution | Graft indexes the MAIN checkout only (whatever branch is checked out at the repo root), not a worktree — sharper than P47's "not a branch with uncommitted edits": even fully committed work on a worktree's own branch is invisible to it. | Use graft for pre-existing, branch-independent structure; read the worktree's own file directly for any claim specific to that branch. |

### 5.26 Added 2026-09-17 (machine transfer)

Section 5 above, from its heading through the end of 5.23, is carried forward byte for byte from `2026-09-07-p1-hierarchy-closeout.md` (lines 93-463), the newest session log on this branch. The rows below continue that ledger's ID scheme at M76, A67 and P59, the first numbers past every ID that `fix/paperclip-p0-0b-image-build` uses at `5a7af9b` (its highest are M75, A65 and P58). This sub-heading is numbered 5.26, not 5.24, because that branch already has a 5.24 (2026-09-15) and a 5.25 (2026-09-17). See P59.

| ID | Kind | New finding | Required correction or precaution |
|---|---|---|---|
| M76 | Conflict (open) | The two B-2 blueprints disagree about what follows W1. `B2-W1-IMPLEMENTATION-handoff.txt` (modified 2026-09-07 11:30) says to make a local checkpoint and "emit a self-bootstrapping ... CLEANUP handoff". The approved plan's "PLAN B" section in `gauntlet-mode-plan-gauntlet-phase-plan-compressed-hickey.md` (modified 11:53, headed "owner-directed 2026-09-07, supersedes the 6-item x 5-phase ladder") says "No CLEANUP phase" and runs passes A, B, C and then one Verify. | Follow PLAN B for sequencing. Keep the W1 handoff's gates, four-file scope, prohibitions and consent gate. Ask the owner if in doubt. Do not rewrite either file; both are stable blueprints. |
| A67 | Assumption (now evidence) | `feat/paperclip-b2-missions-board-infra` is parked, not abandoned. At `e5168f9` it has exactly one commit over `15922df` (`infra/lib/paperclip-stack.test.ts`, 18 insertions) and no implementation: `infra/lib/paperclip-stack.ts` has no `publicHostname`, and `PAPERCLIP_ALLOWED_HOSTNAMES` at `:474` is still the Cloud Map hostname alone. The one red test is deliberate. | Do not "fix" the red test outside W1 / pass A, and never weaken, skip or delete it; it is the specification. A red `paperclip-stack.test.ts` on this branch is not a regression. |
| A68 | Assumption (now evidence) | On 2026-09-17 the four W1 files were identical at the fork point `15922df`, on `origin/development` `271339b` and on `fix/paperclip-p0-0b-image-build` (measured at `4f1a860`; the independent review found the same four-file diff empty at that branch's tip `5a7af9b`), so the W1 seam line numbers still hold (`app.ts:181/:194`, `paperclip-stack.ts:116/:474`). The only infra change on development since the fork is 7 lines inserted after `infra/lib/compute-stack.ts:421` (new lines `:422-428`), which moves pass B's planned compute-stack seams (`:544-546`, `:592-599`) down by 7. | When resuming, re-run the four-file `git diff --stat <fork>..origin/development` and re-derive every compute-stack line number before pass B. Phase 0's remaining work may move them again. |
| A69 | Assumption (open) | Whether B-2 is still worth building under the owner's 2026-09-07 Workflows direction is unsettled. The direction (Phase 0 plan section 6; `HANDOFF.md` on `fix/paperclip-p0-0b-image-build`, recorded at `4f1a860` and still present at `5a7af9b`) surfaces Paperclip's own SPA under a Netzar "Workflows" tab and states its effect on WI-1, WI-2 and WI-3 only. It says nothing either way about the bridge B-1..B-6. | Ask the owner before resuming B-2. Do not read an answer into the direction text either way. |
| P59 | Precaution | Ledger IDs collide across branches. This branch's carried ledger ends at M67 / A63 / P53. At `5a7af9b`, `fix/paperclip-p0-0b-image-build` reuses M66, M67, A63 and P46-P48 with other meanings and adds M68-M75, A64, A65 and P54-P58, none of which mean what the rows below mean: `2026-09-08-p0-completion-and-workflows-direction.md` appends M66-M71, A63 and P46-P48 (the Phase 0 criterion checklist counts ten IDs in that file that each carry two meanings), `2026-09-15-p0-0b-validate-and-ship.md` appends M72, M73, A64, P54, P55 and P56, and `2026-09-17-machine-transfer.md` appends M74, M75, A65, P57 and P58. The first version of this file (`a429a1a`) numbered its rows M72, A64-A66 and P54-P57 and wrongly called those numbers free on both branches, so seven of its eight IDs clashed. The correction commit renumbered them M76, A67-A69 and P59-P62, past every ID in use on both branches when it was written. A session writing on either branch later may still pick a clashing number. | Cite a ledger row by its ID **and** the session file it came from. Before appending, read the highest IDs on every live paperclip branch, not only your own. When the branches meet, keep both rows and add a cross-reference; never renumber carried entries. |
| P60 | Precaution | `infra/bin/app.ts:223` already passes a `publicHostname` prop, to `ObservabilityStack`, read from `CCE_PUBLIC_HOSTNAME` (the dashboard hostname). B-2 adds a prop with the same name to `PaperclipStack`, read from `CCE_MISSIONS_BOARD_HOSTNAME`. | Search by stack, not by prop name. Never feed `CCE_PUBLIC_HOSTNAME` into `PaperclipStack`. |
| P61 | Precaution | The W1 proof command `npx vitest run infra/lib/paperclip-stack.test.ts --maxWorkers=1` dies before collecting any test (`RangeError: options.minThreads and options.maxThreads must not conflict`, vitest 2.1.9), as the W1 handoff records. This was not re-run on 2026-09-17. | Use `--no-file-parallelism` instead. It serializes test files, which is what P44 requires. |
| P62 | Precaution | The approved B-2 plan, the SPECIFICATION and IMPLEMENTATION handoffs, and the session transcripts live only under `~/.claude`, never in this repository. On 2026-09-17 the branch itself existed only locally (`git ls-remote` returned no ref for it), on a machine with 2.9 GB free. | On a new machine, restore the devkit (`emmanuelmadams4-lgtm/netzer-devkit`) before resuming, and confirm the backup ref with `git ls-remote origin refs/heads/feat/paperclip-b2-missions-board-infra`. |

## 6. Pending work

### 6.1 Smallest next action

After Paperclip Phase 0 (WI-1..WI-3) is complete, and once the owner confirms B-2 is still wanted, merge (or rebase) `feat/paperclip-b2-missions-board-infra` onto the current `origin/development`. Then implement W1 / pass A as the W1 IMPLEMENTATION handoff (Appendix A) specifies: add `publicHostname?: string` to `PaperclipStackProps` and set both env values in `infra/lib/paperclip-stack.ts`, with the prop read in `infra/bin/app.ts`, staying inside that handoff's four-file scope. The pass is done when `npx vitest run infra/lib/paperclip-stack.test.ts --no-file-parallelism` passes (the `e5168f9` test included) and `npm run typecheck` exits 0.

### 6.2 Immediate next steps

1. Ask the owner whether B-2, a separate origin `missions.staging.pgnos.ai` for Paperclip's own board, is still the route under the Workflows direction. Do not infer the answer (ledger A69).
2. Wait for Phase 0 to finish. Its state lives on `fix/paperclip-p0-0b-image-build` (tip `5a7af9bc3d2b59c12e08f413cfde51799e32751d` on 2026-09-17, which last updated that branch's `docs/features/paperclip/HANDOFF.md`), in its session logs `docs/features/paperclip/handoffs/2026-09-17-machine-transfer.md` (newest), `2026-09-15-p0-0b-validate-and-ship.md` and `2026-09-08-p0-completion-and-workflows-direction.md`, and in the Phase 0 plan files listed in section 8. Judge whether Phase 0 is complete from those two newer logs and that `HANDOFF.md`, not from the 2026-09-08 log alone.
3. On a fresh clone, check out this branch and merge or rebase it onto `origin/development`. Re-run `git diff --stat 15922df..origin/development -- infra/lib/public-dashboard-access.ts infra/bin/app.ts infra/lib/paperclip-stack.ts infra/lib/paperclip-stack.test.ts` and re-derive any seam that moved.
4. Capture a fresh baseline on the new machine before changing anything (ledger P1). The five-file A52 failure set is specific to Windows; see 6.3.
5. Pass A (W1), run by the W1 handoff: both gates green, then the coordinator's seven-point independent check, then a local commit.
6. Passes B, C and Verify, per the approved plan's "PLAN B". Re-derive the compute-stack seams first (ledger A68).
7. Stop at the Cloudflare consent gate (6.3).

### 6.3 Blockers and open questions

- [ ] Blocker: Paperclip Phase 0 (WI-1..WI-3) is not complete. Needs: Phase 0 shipped and closed out on its own branches.
- [ ] Question: is B-2 still wanted under the 2026-09-07 Workflows direction? That direction names WI-3 as possibly wasted work and says nothing about the bridge. Suggested resolution: ask the owner before any B-2 work resumes.
- [ ] Question: the W1 handoff ends by telling the next session to emit a `GAUNTLET_PHASE: CLEANUP` handoff. The approved plan's "PLAN B" section, marked owner-directed 2026-09-07, deletes the per-item CLEANUP and VERIFICATION phases in favour of passes A, B, C and one Verify. The plan file's modification time (2026-09-07 11:53) is later than the W1 handoff's (11:30). Suggested resolution: follow PLAN B, which is later and owner-directed, and keep every gate, scope limit and prohibition in the W1 handoff (ledger M76).
- [ ] Question: which baseline applies on the new machines? A52's five failing files are Windows collection failures, and the W1 handoff records that CI's Linux job passed at `291a457`. Suggested resolution: re-capture the baseline on macOS and on the new PC. Never carry A52 over as "expected" on another OS.
- [ ] Blocker for any deployment: the Cloudflare consent gate. The W1 handoff requires this paragraph to be reproduced verbatim in every downstream handoff:

```text
missions.staging.pgnos.ai is NOT live yet. After the local gates pass, STOP and ask the owner to
confirm the hostname is live before any staging deployment or round trip. Passing every local gate
does NOT authorize crossing this gate. Reproduce this paragraph verbatim in every downstream handoff.
```

### 6.4 Deferred, and why

- B-1 (live characterization and the operator hostname step) and B-3 to B-6: deferred. They are outside B-2 and come after it in the bridge order.
- Setting the GitHub variable `CCE_MISSIONS_BOARD_HOSTNAME`: deferred by owner decision. B-2 is code only, and an unset variable remains the staging behaviour.
- `TRUST_PROXY`: deferred until B-1 produces evidence (W1 handoff).
- Recording the approved plan's three evidence-backed corrections in `missions-engine-plan.md` under "Bar text that cannot be implemented as written" (the plan's definition of done, item 7): deferred to the session that finishes B-2.

## 7. Verification actually performed

Every command below was run in `C:\dev\Netzer-Labs\.worktrees\paperclip-b2` on 2026-09-17. The baseline was taken before any file was written.

| Command | Baseline (before changes, HEAD `e5168f9`, tree clean) | After changes (this file staged) |
|---|---|---|
| `git status --short` | empty (clean tree) | `A  docs/features/paperclip/handoffs/2026-09-17-b2-machine-transfer.md` and nothing else |
| `node scripts/ci/feature-knowledge.mjs` | exit 0; `feature-knowledge: OK` | exit 0; `feature-knowledge: OK` |
| `node scripts/ci/docs-links.mjs` | exit 0; `134 markdown files · 1621 internal links checked · 70 external links skipped`; `docs-links: OK` | exit 0; `135 markdown files · 1655 internal links checked · 70 external links skipped`; `docs-links: OK`. The extra file and the 34 extra internal links all come from this file. |
| `git ls-remote origin refs/heads/feat/paperclip-b2-missions-board-infra refs/heads/development` | exit 0; one line only, `271339bc8b2feea85e6c31b115fdd34e757a72e2 refs/heads/development`. The B-2 branch is **not** on origin. | not re-run (read-only fact, unchanged by a docs commit) |
| `git rev-list --left-right --count origin/development...HEAD` | `7 1` (7 behind, 1 ahead); merge base `15922df50bae36839cbd2004c27b7794d9f19f1d` | not re-run |
| `git diff --stat 15922df..271339b -- <the four W1 files>` | empty, exit 0 | not re-run |
| `git diff --stat 15922df..fix/paperclip-p0-0b-image-build -- <the four W1 files>` | empty | not re-run |
| `git diff --check` (staged: `git diff --cached --check`) | not applicable (nothing staged) | `git diff --cached --check`: exit 0, no output |
| `npm run typecheck` | not run | not run |
| `npx vitest run infra/lib/paperclip-stack.test.ts --no-file-parallelism` | not run this session. The W1 handoff recorded `Test Files 1 failed (1) \| Tests 1 failed \| 54 passed (55)`, failing at `:394:51`. | not run |
| `npm test` | not run | not run |
| `npm run build`, `npm --prefix web run typecheck`, `npm --prefix web run build`, `npm run local:test:integration` | not run | not run |

Anything not run, and why:

- The typecheck, vitest, full-suite, build and integration commands were not run. This session changed only documentation, several transfer agents were running on one memory-limited machine (ledger P44), and C: had 2.9 GB free. The red state of `e5168f9` is cited from the W1 IMPLEMENTATION handoff and backed only by the static reads in 3.1.
- No `aws` command, deploy, push, PR or merge was run. All are out of scope; the push is the coordinator's job, done after this commit.

Correction rounds (2026-09-17, after independent reviews of `a429a1a`). The table above records the first version of this file.

- **First correction round (no shell).** The environment's permission check refused this session's first shell call (a read-only `git status`) and said it would refuse every later one in that session. So that round ran neither gate, took no new baseline and made no commit. It edited only prose outside the carried section 5 body (sections 1, 2, 3.1, 3.2, 4.1, 4.2, 4.3, 4.4, the 5.26 heading, intro and rows, 6.2, 6.3, 7, 8 and 9) and added or removed no Markdown link. It checked the edits by reading the file back. Its facts come from the independent review, which measured `5a7af9b` directly, and from reads of files: the P0-0b worktree's reflog file (`.git/worktrees/p0-0b-image-build/logs/HEAD`, whose last entry moves `4f1a860` to `5a7af9b`), and the ID rows and `HANDOFF.md` in that worktree.
- **Second correction round (shell available).** A second review confirmed that content and asked for three wording fixes: P59's list of reused IDs, and the compute-stack insertion point in 3.1 and A68. This round ran the commands below, in this worktree unless noted. Its baseline is the `a429a1a` gate result in the table above.

| Command | Result |
|---|---|
| `df -h /c` | 3.1 GB free (99% used) |
| `git status --short`; `git rev-parse HEAD` | only ` M docs/features/paperclip/handoffs/2026-09-17-b2-machine-transfer.md`; HEAD `a429a1ad6709b2a6e37ff7543060b8ee8c82ac64` |
| `git rev-parse HEAD` in `.worktrees/p0-0b-image-build` | `5a7af9bc3d2b59c12e08f413cfde51799e32751d`, so the P0-0b branch has not moved |
| `git grep -nE` at `5a7af9b` under `docs/features/paperclip` for ledger rows M72-M79, A64-A69 and P54-P62 | only M72-M75, A64, A65 and P54-P58, in `2026-09-15-p0-0b-validate-and-ship.md` and `2026-09-17-machine-transfer.md` |
| `git grep` for rows M76-M79, A66-A69, P59-P62 across every local and remote-tracking branch whose name contains `paperclip` | one hit only: this branch's own file at `a429a1a` (its old A66) |
| `git diff 15922df..271339b -- infra/lib/compute-stack.ts` | one hunk, `@@ -419,6 +419,13 @@`; the 7 added lines follow `TABLE_JARVIS_CANARY` (`:421`) and are `:422-428` on `271339b` |
| `node scripts/ci/feature-knowledge.mjs` (after the fixes) | exit 0, `feature-knowledge: OK` |
| `node scripts/ci/docs-links.mjs` (after the fixes) | exit 0, 135 markdown files, 1655 internal links, 70 external skipped, `docs-links: OK` (same as at `a429a1a`) |
| `git diff --check` | clean |
| a read-only checker script (`verify-correction.mjs`, in the coordinator session's scratchpad), run after staging this file | `verify-correction: OK`: the carried section 5 body is byte-identical to `2026-09-07-p1-hierarchy-closeout.md` in the working tree and in the index, the working file is CRLF throughout, Appendix A still equals the plan file, the 5.26 row IDs are M76, A67-A69 and P59-P62, only this file is staged, and the staged diff has no secret-pattern hit |

## 8. Environment state

- **Branch and tip**: `feat/paperclip-b2-missions-board-infra`. The session started at `e5168f9572810fba696f3d32876debfa716b70d9`; its docs commits sit on top (section 1). Pushed: not yet at the time of writing; the coordinator pushes this branch to origin under the same name immediately after this commit as an owner-approved backup (no PR, no merge, no deploy) - confirm with `git ls-remote origin refs/heads/feat/paperclip-b2-missions-board-infra`.
- **Tools and services**: Windows 11 Pro 10.0.26200, Git Bash, `git version 2.55.0.windows.3`, Node `v24.19.0`. `core.autocrlf=true`, and the handoff files are stored `i/lf w/crlf`. C: had 2.9 GB free of 238 GB at session start. Docker and AWS were not used.
- **Active processes**: none left running. One read-only transcript search ran in the background and finished.
- **Environment variables**: none set by this session.
- **Uncommitted work left in the tree**: none. The worktree was clean at `e5168f9` before the session, and this file is its only change. The main checkout `C:\dev\Netzer-Labs` (branch `fix/knowledge-scope-fanout`) has many uncommitted changes that belong to other work. This session did not touch them (P6).
- **Where the non-git state lives** (private devkit repository `emmanuelmadams4-lgtm/netzer-devkit`, after the coordinator builds it):
  - `claude/plans/B2-W1-IMPLEMENTATION-handoff.txt`: the resume prompt, embedded verbatim in Appendix A.
  - `claude/plans/B2-SPECIFICATION-handoff.txt`: the SPECIFICATION handoff that produced `e5168f9`.
  - `claude/plans/gauntlet-mode-plan-gauntlet-phase-plan-compressed-hickey.md`: the **approved B-2 plan** (seam map, the three corrections, PLAN B, criterion/evidence matrix, definition of done).
  - `claude/plans/please-follow-the-structure-rosy-sifakis.md` (its section 6 is the 2026-09-07 Workflows direction), `claude/plans/phase0-criterion-checklist.md` and `claude/plans/phase0-live-evidence-recipe.md`: the Phase 0 plan that B-2 waits on.
  - `claude/plans/gauntlet-mode-direct-coordinator-gauntle-agile-hamster.md`: the Phase 0 WI-1 shipping plan (state measured 2026-09-15).
  - `claude/transcripts/23bf9dcf-be0b-4991-b5bd-b9fa6666df77.jsonl.gz`: the B-2 PLAN and SPECIFICATION session (2026-09-07 02:25Z-15:50Z). It contains the `e5168f9` commit message, and its time span covers that commit (15:23Z). The session also left a sibling directory, `C:\Users\EmmanuelAdams\.claude\projects\C--dev-Netzer-Labs\23bf9dcf-be0b-4991-b5bd-b9fa6666df77\` (`subagents/`, `tool-results/`, `workflows/`), which holds its subagent transcripts. It belongs next to the transcript in the devkit (`claude/transcripts/23bf9dcf-be0b-4991-b5bd-b9fa6666df77/`) if the devkit keeps subagent transcripts.
  - `claude/transcripts/b67881a4-a0fd-4072-9f75-76ee96dac794.jsonl.gz`: a short continuation of that session (2026-09-07 15:51Z-15:53Z).
  - `claude/transcripts/cc496668-b7eb-4604-8329-42a9b99a549b.jsonl.gz`: the Phase 0 completion session that recorded the Workflows direction (2026-09-07 17:27Z to 2026-09-08 05:01Z).
  - `claude/memory/paperclip-missions-engine-campaign.md`, `claude/memory/missions-tab-prototype-replacement.md`, `claude/memory/scope-discipline-current-phase-only.md`: campaign memory.
  - `claude/skills/gauntlet-loop/`: the skill the W1 handoff says to load. `claude/skills/claudex-loop/scripts/runner.py` is referenced only in the W1 handoff's detection record. Routing is already settled on Claude.
  - B-2 has no `~/.claude/gauntlet/<campaign>` folder; the only ones are `bedrock-all-models` and `seats-pickers-hotfix`. No B-2 scratchpad survives in `%TEMP%`: there is no directory for `23bf9dcf`, `b67881a4` or `cc496668`. The Phase 0 coordinator session's scratchpad goes to `archive/scratch/968da171/`.
  - The campaign's live progress page is the claude.ai Artifact "Missions Engine Campaign" (<https://claude.ai/code/artifact/de1aa8aa-508f-4617-a9bc-2819a927e6af>). It is hosted, not a file.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state on this branch; see 4.3)](../HANDOFF.md)
- [Previous session handoff on this branch](./2026-09-07-p1-hierarchy-closeout.md)
- [Missions engine plan (the B-2 paragraph)](../missions-engine-plan.md)
- [Bar and phases (Phase 4.5 acceptance, A1-18)](../bar-and-phases.md)
- [Session handoff template](../../HANDOFF-TEMPLATE.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
- [ADR 0010](../../../adr/0010-paperclip-work-engine.md), [ADR 0009](../../../adr/0009-mission-container-model.md)
- On another branch only (not linked, because the files do not exist here), all on `fix/paperclip-p0-0b-image-build` at its 2026-09-17 tip `5a7af9bc3d2b59c12e08f413cfde51799e32751d`: the Phase 0 session logs `docs/features/paperclip/handoffs/2026-09-17-machine-transfer.md` (newest) and `docs/features/paperclip/handoffs/2026-09-15-p0-0b-validate-and-ship.md`, both added at `5a7af9b`; `docs/features/paperclip/handoffs/2026-09-08-p0-completion-and-workflows-direction.md`; and that branch's `docs/features/paperclip/HANDOFF.md`, corrected at `4f1a860` and last updated at `5a7af9b` (`observed_at: 2026-09-17`). That `HANDOFF.md` does not mention this B-2 handoff, so a resuming session reaches this file only through this branch.

## Appendix A - Resume on a new machine

### A.1 Path map

| Old machine | New machine | Source |
|---|---|---|
| `C:\Users\EmmanuelAdams\.claude\plans\B2-W1-IMPLEMENTATION-handoff.txt` (and every other `plans\X` named here) | `~/.claude/plans/B2-W1-IMPLEMENTATION-handoff.txt` (`~/.claude/plans/X`) after running the devkit restore | devkit `claude/plans/X` |
| `C:\Users\EmmanuelAdams\.claude\gauntlet\Y` | `~/.claude/gauntlet/Y` (B-2 has none) | devkit `claude/gauntlet/Y` |
| `C:\Users\EmmanuelAdams\.claude\skills\gauntlet-loop` | `~/.claude/skills/gauntlet-loop` | devkit `claude/skills/` |
| `C:\dev\Netzer-Labs\.worktrees\paperclip-b2` (also written `C:/dev/Netzer-Labs/.worktrees/paperclip-b2` in the prompt) | `<dev-root>/Netzer-Labs`: a fresh clone of origin with `git checkout feat/paperclip-b2-missions-board-infra`, optionally added as a worktree at `<dev-root>/Netzer-Labs/.worktrees/paperclip-b2` | origin (the coordinator's backup push) |
| `C:\dev\Netzer-Labs` (the main checkout the prompt says not to use) | `<dev-root>/Netzer-Labs` on whatever branch; still do not do B-2 work on `fix/knowledge-scope-fanout` | origin |
| `%TEMP%` scratchpad paths of past sessions | devkit `archive/scratch/<session-id>/` (none survives for B-2) | devkit |
| `C:/Users/EmmanuelAdams/AppData/Local/OpenAI/Codex/bin/codex.exe` | the `codex` CLI on `PATH`; pass its absolute path to `--cli`. Not needed for W1, which is routed to Claude. | local install |
| `-c windows.sandbox="elevated"` | drop it on macOS (Windows only) | none |
| `cygpath`, `MSYS_NO_PATHCONV`, and the PowerShell 5.1 notes | Windows / Git Bash only; ignore them on macOS | none |
| Docker image builds | On Apple Silicon, arm64 builds run natively and amd64 builds run under emulation. B-2 builds no image. | none |

Read the embedded prompt with these adjustments. Its "BASELINE CORRECTION" (origin/development = `15922df`) is itself out of date: `origin/development` was `271339b` on 2026-09-17, and by the time you resume it will have moved again once Phase 0 lands. Its "WINDOWS BASELINE" applies only on Windows (see 6.3). The prompt's `HEAD = e5168f9` is now one commit behind, because this handoff's docs commit sits on top of it.

### A.2 Fresh-session resume prompt (verbatim)

Source on the old machine: `C:\Users\EmmanuelAdams\.claude\plans\B2-W1-IMPLEMENTATION-handoff.txt` (sha256 `19b0f5f868cf45b18ebec45c2d97db02c461e55c999c4f6cdf4e8a3f7f663010`). Devkit path: `claude/plans/B2-W1-IMPLEMENTATION-handoff.txt`. The approved plan it points to is devkit `claude/plans/gauntlet-mode-plan-gauntlet-phase-plan-compressed-hickey.md`, and the SPECIFICATION handoff before it is devkit `claude/plans/B2-SPECIFICATION-handoff.txt`. Paste the prompt only after the owner has answered 6.3 and Phase 0 is complete.

`````text
GAUNTLET_MODE: DIRECT_COORDINATOR
GAUNTLET_PHASE: IMPLEMENTATION
IMPLEMENTATION_PROVIDER: CLAUDE
CODEX_POLICY: CONSERVE
IMPLEMENTATION_MODEL: SONNET
CODEX_MODEL_CLASS: N/A — Claude fallback authorized by the owner 2026-09-07
CODEX_ATTEMPTS_USED: 0

This is a Gauntlet Loop execution handoff for a fresh session. Before substantive work,
load/re-read the `gauntlet-loop` skill. These markers are authorization to enter Direct Coordinator
Mode. Do NOT generate another generic Gauntlet prompt. Do NOT restart PLAN or SPECIFICATION. Do NOT
rely on prior conversation context. Execute IMPLEMENTATION and stop at its boundary.

GOAL
Bridge B-2 / work item W1 of docs/features/paperclip/missions-engine-plan.md: make the SPECIFICATION
RED gate pass with the smallest correct diff. B-2 wires the public hostname
missions.staging.pgnos.ai (GitHub env var CCE_MISSIONS_BOARD_HOSTNAME) through every configuration
home, in both set and unset states, with no unrelated CloudFormation drift.

APPROVED PLAN
C:/Users/EmmanuelAdams/.claude/plans/gauntlet-mode-plan-gauntlet-phase-plan-compressed-hickey.md
Stable. Point back to it; do not rewrite it.

=== BASELINE CORRECTION — READ FIRST ===
origin/development has MOVED. The prior handoff pinned 277095e; the actual tip is 15922df
("Merge pull request #162 ... feat/paperclip-p1-hierarchy" — Phase 1 has merged).
VERIFIED: `git diff --stat 277095e..15922df -- infra/ scripts/ .github/` is EMPTY, so every W1 seam
line number in the approved plan still holds exactly. P1 landed only src/ and web/ changes.

WORKTREE (already created, do not recreate)
C:/dev/Netzer-Labs/.worktrees/paperclip-b2
branch feat/paperclip-b2-missions-board-infra, from origin/development at 15922df.
HEAD = e5168f9 (the SPECIFICATION test commit; 1 file, 18 insertions, no implementation).
Do NOT use the main checkout C:/dev/Netzer-Labs (branch fix/knowledge-scope-fanout, materially
different infra/scripts). Do NOT use .worktrees/paperclip-promote.

=== PROOF COMMAND CORRECTION — THE PRIOR ONE IS BROKEN ===
`npx vitest run infra/lib/paperclip-stack.test.ts --maxWorkers=1` DOES NOT WORK in this repo.
It dies before collecting any test with:
  RangeError: options.minThreads and options.maxThreads must not conflict
      at new Tinypool (node_modules/tinypool/dist/index.js:745:120)
      at createForksPool (vitest/dist/chunks/resolveConfig...)
vitest is 2.1.9 and vitest.config.ts sets no pool options; the flag itself is rejected.
THE PROOF COMMAND IS:
  npx vitest run infra/lib/paperclip-stack.test.ts --no-file-parallelism
This serializes test files, which is what the campaign's P25/P44 "never two vitest or synth
processes at once" rule actually requires on this 16 GB machine.

CURRENT EVIDENCE — THE RED GATE (actually executed, not paraphrased)
Command: npx vitest run infra/lib/paperclip-stack.test.ts --no-file-parallelism
Result:  Test Files 1 failed (1) | Tests 1 failed | 54 passed (55)

  FAIL infra/lib/paperclip-stack.test.ts > UI serving and deployment mode >
       carries the missions board hostname into both public-origin variables
  AssertionError: expected undefined to be 'https://missions.staging.pgnos.ai' // Object.is equality
  - Expected: "https://missions.staging.pgnos.ai"
  + Received: undefined
  at infra/lib/paperclip-stack.test.ts:394:51

RED for the intended reason: the stack does not set PAPERCLIP_PUBLIC_URL. Not a syntax error, not a
bad fixture, not a missing credential, not a pre-existing failure. All 54 other tests in the file
pass, including "reads no process.env, so ambient state cannot change what exists" (the grep guard)
and the existing literal PAPERCLIP_ALLOWED_HOSTNAMES assertion.

SECOND RED GATE (also actually executed): `npm run typecheck` returns exit 2 with exactly ONE error,
repo-wide, and it is the expected TDD consequence:
  infra/lib/paperclip-stack.test.ts(123,5): error TS2353: Object literal may only specify known
  properties, and 'publicHostname' does not exist in type 'PaperclipStackProps'.
Both gates must be green when IMPLEMENTATION is done.

WINDOWS BASELINE (ledger A52, read verbatim — not guessed)
`npm test` exits 1 on exactly these five, untouched by this work:
  scripts/ci/docs-links.test.ts
  scripts/ci/feature-knowledge.test.ts
  scripts/ci/runnable-blocks.test.ts
  scripts/release/sync-deprecations.test.ts
      (each SyntaxError: Invalid or unexpected token at collect; the .mjs each imports is
       i/lf w/crlf including its shebang line and runs directly with exit 0)
  scripts/lib/lifecycle/rollback-classes.test.ts > "deploys the archived assembly with --app and
       diffs first" (/tmp/fake/cdk.out vs the Windows-separator form)
Plus the known jarvis.flow.test.ts load flake, which is re-run alone. Any OTHER failing file is a
regression. CI's Linux Typecheck + Unit Tests job passed at 291a457 (run 33639063032).

CONFIRMED CORRECTION (this session, against the worktree and graft)
Correction 3 is CONFIRMED. `resolvePublicDashboardAccess` (infra/lib/public-dashboard-access.ts,
span L111-L185) has exactly THREE callers, agreed by `graft callers --depth all` and by grep on the
worktree branch:
  infra/lib/compute-stack.ts:138   -> resolvePublicDashboardAccess(process.env)
  infra/lib/public-dashboard-access.test.ts (its own suite)
  scripts/public-setup.ts:main
It returns {enabled:false} unless CCE_PUBLIC_ACCESS==='1' and THROWS unless
CCE_DEPLOY_MODE==='infra-only' with no DOMAIN_NAME, so it is NOT directly reusable for the missions
hostname. The reusable shape rules are unexported inside it: the LABEL regex (:109), the
salessly.io prohibition, the >=3-label rule, PUBLIC_ZONE='pgnos.ai' (:80).
Any extraction must leave all three callers behaviourally identical; public-dashboard-access.test.ts
must stay green unmodified.
Corrections 1 and 2 belong to W3 and are NOT in W1 scope; do not act on them here.

=== CODEX WORK ORDER ===
GOAL: make the W1 set-state test pass with the smallest correct diff.

ALLOWED SCOPE — no file outside this list:
  infra/lib/public-dashboard-access.ts
  infra/bin/app.ts
  infra/lib/paperclip-stack.ts
  infra/lib/paperclip-stack.test.ts

REQUIREMENT:
- Expose/reuse hostname-shape validation WITHOUT changing existing public-dashboard behavior
  (all three callers above stay identical; public-dashboard-access.test.ts stays green unmodified).
- infra/bin/app.ts reads the variable with trim + `|| undefined`, copying the existing pattern at
  app.ts:194  `imageDigest: process.env.CCE_PAPERCLIP_IMAGE_DIGEST?.trim() || undefined`
  NEVER `??`. cdkEnvBag forwards every var as `env.X ?? ''`, so under a real deploy the key is
  always DEFINED and often BLANK; `??` would keep the blank string and synthesize `https://`.
  This trap is documented at public-dashboard-access.ts:150-155.
- Pass it into PaperclipStack as `publicHostname?: string` on PaperclipStackProps (beside
  `imageDigest?: string` at :116). The stack construction is app.ts:181.
- PaperclipStack MUST NOT read process.env. The hostname arrives as a prop. The guard test at
  paperclip-stack.test.ts:240 reads the stack source and greps it; it must stay green.
- When publicHostname === 'missions.staging.pgnos.ai', the paperclip-server container env carries
  EXACTLY:
    PAPERCLIP_PUBLIC_URL          = https://missions.staging.pgnos.ai
    PAPERCLIP_ALLOWED_HOSTNAMES   = paperclip.claudeclaw.internal,missions.staging.pgnos.ai
  (bare hostnames, comma-separated, lowercase, no ports — M56: the list REPLACES config.json's and
  the guard 403s any Host neither loopback nor listed, so the Cloud Map name must survive.)
- When unset, preserve existing behavior exactly: PAPERCLIP_PUBLIC_URL absent and
  PAPERCLIP_ALLOWED_HOSTNAMES === 'paperclip.claudeclaw.internal' (M33: both directions safe).
- The current seam is paperclip-stack.ts:474
    PAPERCLIP_ALLOWED_HOSTNAMES: new URL(RESOURCE_NAMES.paperclipInternalUrl).hostname
  which is a SYNTH-TIME string, not a CDK token — so a literal comma-join is correct here.
- Do not touch PAPERCLIP_DEPLOYMENT_MODE:'authenticated' (:466), PAPERCLIP_BIND:'lan' (:445),
  SERVE_UI:'true' (:463), or the image/digest wiring (:259).

PROOF (run both):
  npx vitest run infra/lib/paperclip-stack.test.ts --no-file-parallelism
  npm run typecheck

CONSTRAINTS: /ponytail smallest correct diff; follow the nearby existing pattern; no new dependency;
no speculative abstraction; no architecture redesign; no files outside scope; no IAM; no live AWS;
no deploy; no push; no production; no secret values; never two vitest/synth processes at once.
Do NOT weaken, skip, or delete the SPECIFICATION test.

RETURN: changed files, a concise summary, both proof results, and any blocker.

=== MODEL ROUTING: RESOLVED — CLAUDE FALLBACK, SONNET ===
The owner decided on 2026-09-07: route W1 to Claude/sonnet, NOT Codex. This invokes the routing
rule already in force ("If neither suitable tier is available, use Claude"). W1 is frozen by two
literal executable gates and an explicit seam list, so it needs no architectural judgment.
Do NOT re-open this. Do NOT delegate W1 to Codex. The detection below is kept as the record.

--- detection record (why Codex was not used) ---
Detected non-destructively this session (no coding attempt spent):
- Codex IS installed and authenticated, but NOT on PATH. Binary:
  C:/Users/EmmanuelAdams/AppData/Local/OpenAI/Codex/bin/codex.exe
  (~/.codex/auth.json present; contents not read.)
- `codex --version` => codex-cli 0.130.0-alpha.5
- ~/.codex/config.toml: model = "gpt-5.5", model_reasoning_effort = "medium",
  sandbox_mode = "workspace-write"
- The CLI exposes NO tier listing (`codex models list` => "unexpected argument 'list'"). `-m/--model`
  takes an arbitrary model string.
- Therefore LUNA and TERRA could NOT be detected as available model identifiers. Per the routing
  rules ("do not invent Luna/Terra availability"), no CODEX_MODEL_CLASS is asserted here.

COMPATIBILITY RISK, on the record: the claudex-loop runtime reference states its live-tested
baseline is Codex CLI 0.153.4, and that the older npm CLI 0.144.5 "exposed the required flags but
Astra rejected it with 'requires a newer version of Codex.'" The detected 0.130.0-alpha.5 is OLDER
than that already-rejected version. A version probe does not establish model compatibility.

Resolution taken (option b): Claude fallback, sonnet. Kept for the record, the alternatives were:
 (a) the owner names the actual model identifier for LUNA (and TERRA), which is then passed as
     `--model <id>` through the claudex runner at
     C:/Users/EmmanuelAdams/.claude/skills/claudex-loop/scripts/runner.py with
     `--cli C:/Users/EmmanuelAdams/AppData/Local/OpenAI/Codex/bin/codex.exe`; or
 (b) the owner authorizes the Claude fallback the routing rules already permit
     ("If neither suitable tier is available, use Claude"), in which case set
     IMPLEMENTATION_PROVIDER: CLAUDE and use sonnet — the task is now fully frozen by two literal
     executable gates and an explicit seam list, so it no longer needs architectural judgment.
Never silently substitute Sol. Sol requires separate explicit owner authorization.

POST-IMPLEMENTATION REQUIREMENT (whoever writes it)
A reported PASS is not proof. Before leaving IMPLEMENTATION the coordinator must independently:
 1. git status; 2. inspect untracked files; 3. read the actual diff; 4. verify only the four
 authorized W1 files changed; 5. confirm the SPECIFICATION test was not weakened or deleted;
 6. rerun BOTH proof commands itself; 7. compare failures against the A52 baseline above.
Only the coordinator's executed proof counts. If a Codex attempt fails, diagnose the actual cause
(specification / implementation defect / environment / capability) before escalating; one targeted
correction is allowed; do not reflexively escalate a tier.

PROHIBITED — CARRY INTO EVERY DOWNSTREAM HANDOFF
NEVER cdk deploy. NEVER touch production. NEVER run B-1 live characterization. NEVER open a tunnel.
NEVER sign in to the live board. NEVER perform a staging round trip. NEVER modify application code
(src/config/env.ts belongs to a later work item). NEVER push. NEVER print, echo, log or reconstruct
a secret value. NEVER run two vitest/synth processes at once. NEVER claim a command or lookup that
did not execute. NEVER silently select Codex Sol. TRUST_PROXY stays DEFERRED until B-1 evidence.

OWNER DECISIONS — DO NOT RE-LITIGATE
The diff gate is local template-to-template comparison, not deployed-stack cdk diff.
B-2 is CODE ONLY. Do NOT set the GitHub CCE_MISSIONS_BOARD_HOSTNAME variable during B-2; unset
remains staging behavior. Passing local gates does not authorize deployment.

CLOUDFLARE / DEPLOYMENT CONSENT GATE
missions.staging.pgnos.ai is NOT live yet. After the local gates pass, STOP and ask the owner to
confirm the hostname is live before any staging deployment or round trip. Passing every local gate
does NOT authorize crossing this gate. Reproduce this paragraph verbatim in every downstream handoff.

PHASE BOUNDARY
Execute IMPLEMENTATION only. When both proof gates are green and the coordinator has independently
verified the diff, make a local /git checkpoint (never push), then emit a self-bootstrapping
GAUNTLET_MODE: DIRECT_COORDINATOR / GAUNTLET_PHASE: CLEANUP handoff and stop.
The eventual VERIFICATION handoff must carry:
  VERIFICATION_MODEL: CLAUDE_OPUS_5
  IMPLEMENTATION_AUTHOR: <CODEX|CLAUDE, actual>
  CODEX_MODEL_CLASS: <actual tier used, or N/A>
Opus 5 judges the final diff and executable evidence only — never the writer's self-assessment —
and its legal output is PASS <criterion> or FAIL <criterion> + evidence. No praise.
`````
