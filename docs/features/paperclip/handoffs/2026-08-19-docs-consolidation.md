---
feature: paperclip
document_role: session-handoff
status: current
observed_at: 2026-08-19
as_of_commit: bfe870724dc38ee8cd470b4a44ce95e121e22f21
session_slug: docs-consolidation
supersedes: 2026-08-18-updated-since-patch-and-phase-0
---

# Session handoff: consolidate the Paperclip project material

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-19 |
| Feature folder | `docs/features/paperclip/` |
| Branch worked on | `fix/oidc-immutable-subject-claims` (checked out at the merge commit; this session's changes are documentation only) |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `bfe870724dc38ee8cd470b4a44ce95e121e22f21` |
| Commit at session end | the documentation commit that follows it |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

Documentation-only session. No source file, test, infrastructure file or
dependency was touched.

The user's complaint was that the Paperclip material was "all over the place".
It was: the 822 KB implementation plan the entire feature is being built from
lived **only** in a Claude temporary scratchpad
(`AppData/Local/Temp/claude/.../scratchpad/`), which the feature README openly
acknowledged as "an external session artifact (not tracked in this
repository)". The first session log — the Codex deep dive that produced that
plan — sat untracked in `handoffs/` with no frontmatter. The README described
the feature as "first-milestone validation only" three commits after Phase 1
infrastructure landed, and the HANDOFF still described PR #72 as open and
blocked on GitHub Actions billing after it had merged.

This session vendored the plan and its adversarial audit into the repository,
tracked and framed the Codex log, and rewrote the README and HANDOFF from all
three session handoffs. The feature folder is now self-contained: every
authority the work depends on is in the repository or linked from it.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- Nothing new about the runtime. The architecture facts in this folder were
  read, not extended.
- The plan carries **34 markdown links and all of them are same-document
  anchors** — no relative file links and no external links. That is why an
  822 KB document could be dropped into `docs/` without
  `scripts/ci/docs-links.mjs` acquiring 250 new citation targets to resolve.
- `scripts/ci/feature-knowledge.mjs` validates only `README.md` and `HANDOFF.md`
  plus whatever those two *declare* in frontmatter. Adding files to a feature
  folder is unconstrained; adding them to `evidence:` is not — an evidence
  target must be Markdown, Git-tracked, contain the word "historical", and carry
  a relative link back to the feature README. Both new documents were written to
  satisfy that contract deliberately, not incidentally.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `docs/features/paperclip/implementation-plan.md` | **New.** The vendored §1–§34 design study and 10-phase build sheet | The material Phases 2–10 are built from; it was one temp-directory sweep away from being lost |
| `docs/features/paperclip/plan-audit.md` | **New.** Two adversarial audit passes over the plan | 16 wrong citations and 4 structural defects; without it the plan is unsafe to follow |
| `docs/features/paperclip/handoffs/2026-08-18-codex-review.md` | The origin session log | Was untracked and frontmatter-less; now tracked and indexed |
| `docs/features/README.md` | The feature knowledge framework | Its section 3 frontmatter contract and section 6a session rules governed every choice here |
| `scripts/ci/feature-knowledge.mjs` | The machine check for that framework | Read directly to confirm what `evidence:` targets must satisfy |

### 3.3 Patterns and conventions to follow

- Feature-documentation rules have exactly one home,
  [the framework](../../README.md). Nothing about them was restated in the new
  documents (**P9**).
- A vendored historical artifact is reproduced **verbatim** and framed by a
  preamble, never edited in place. Corrections live in a separate audit document
  so the record of what was originally claimed survives.
- Cross-surface chat parity per [`CLAUDE.md`](../../../../CLAUDE.md) — not
  touched this session, still applies once Missions UI work starts.

## 4. Work completed

### 4.1 Tasks finished

- [x] Vendored `implementation_plan.md` (822 KB, §1–§34) from the temporary
      scratchpad into `docs/features/paperclip/implementation-plan.md`, verbatim,
      under a preamble stating its historical status, the precedence order
      against ADR 0010 and the audit, and the three claims in it that are no
      longer true.
- [x] Converted the two-pass adversarial critique into
      `docs/features/paperclip/plan-audit.md` — 16 fabrications/miscitations,
      16 contradictions, 7 gaps — with a `sN.md`-to-section mapping table and a
      summary of the four defects that need an author decision.
- [x] Added session-handoff frontmatter and an editorial note to
      `handoffs/2026-08-18-codex-review.md`, and tracked it.
- [x] Corrected `supersedes:` on the 2026-08-18 patch/Phase-0 log to name the
      Codex log it actually follows.
- [x] Rewrote `README.md`: accurate status through Phase 1 code, a ranked
      source-of-truth table, the Phase 1 infrastructure implementation map, the
      plan's structural defects as named risks, and the declared `evidence:`
      authorities.
- [x] Rewrote `HANDOFF.md`: PR #72 merged, Actions billing blocker cleared, no
      active branch, both remaining blockers stated as decisions rather than
      work.
- [x] Added Paperclip to the documentation index (`docs/README.md`).
- [x] Removed the empty stray `handoffs/paperclip-integration/` directory at the
      repository root.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/paperclip/implementation-plan.md` | New (826 KB) | The blueprint was untracked and lived in a temp directory |
| `docs/features/paperclip/plan-audit.md` | New | The plan's citations are wrong in 16 places; following it unaided burns a day |
| `docs/features/paperclip/README.md` | Rewritten | Stale status; no pointer to the plan; no precedence order |
| `docs/features/paperclip/HANDOFF.md` | Rewritten | Described a merged PR as open and a cleared blocker as active |
| `docs/features/paperclip/handoffs/2026-08-18-codex-review.md` | Frontmatter + editorial note; now tracked | Violated the section 6a session-handoff convention |
| `docs/features/paperclip/handoffs/2026-08-18-updated-since-patch-and-phase-0.md` | `supersedes:` corrected | The chain now names the log it follows |
| `docs/README.md` | Paperclip added to the feature index | The feature was undiscoverable from the docs index |
| `handoffs/paperclip-integration/` | Removed (empty) | Stray directory, never held anything |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Vendor the plan + the audit, not the 780 KB of raw archaeology notes | Plan only; everything (~1.6 MB); nothing, copy out of temp instead | User choice. The plan distils and cites the notes; the audit is what makes the plan safe to follow. The notes add provenance but no instruction. |
| `document_role: evidence`, `status: historical` for both new documents | `decision` (belongs to ADR 0010); `backlog` (needs task-record vocabulary the plan does not have) | The framework's `evidence` role is "an audit or report — dated historical findings", which is exactly what a dated design study and its audit are. `historical` states honestly that neither is maintained. |
| Reproduce the plan verbatim; put corrections in a separate document | Apply the 16 corrections inline | Editing a historical artifact destroys the record of what was originally claimed, and a partially-corrected document is more dangerous than an uncorrected one — a reader cannot tell which citations were checked. |
| Keep the plan as one 826 KB file | Split into the seven section files it was assembled from | The audit's findings reference those files' line numbers, which no longer resolve either way; one file with working anchors is navigable, seven files with dead cross-references are not. A mapping table covers the gap. |
| Leave the root `handoff-*.md` files and `fix-windows-test-suite/` untouched | Tidy them up while cleaning | **P6.** They are the user's unrelated in-flight work and contain no Paperclip content (verified: zero matches). |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The plan is historical, and ADR 0010 + the audit outrank it | plan preamble, README §1 and §4 | yes |
| The 16 citation corrections and 4 structural defects | `plan-audit.md`; the two blocking ones also in README §7 and HANDOFF blockers | yes |
| Phase 1 infrastructure implementation map | README §5 | yes |
| PR #72 merged; Actions billing blocker cleared; `CDK_DIFF_ROLE_ARN` still missing | HANDOFF | yes |
| The dual-write / `PAPERCLIP_ENABLED` contradiction blocks Phase 4 | README §7 risk table, HANDOFF blocker 2 | yes |

## 5. Carried-forward mistakes, assumptions and precautions

> Copied forward from the template seed (new feature folder), then appended to.
> Nothing is deleted. An entry that is fixed is marked `RESOLVED (<commit>)`
> and stays.

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

### 5.5 Appended this session (2026-08-19)

| # | Entry | Detail |
|---|---|---|
| M13 | The single most load-bearing document in this feature — the 822 KB implementation plan — was left in a Claude temporary scratchpad for a day, and the feature README recorded that as an acceptable state ("an external session artifact (not tracked in this repository)"). | A temp directory is not a location. Anything a future phase must be built from belongs in the repository the moment it is written, even if it is large and even if it is historical. RESOLVED (this session). |
| M14 | The first session log was written before the feature folder existed and then never brought into the framework: untracked, no frontmatter, absent from the session index. | The origin record of a feature is the one log most likely to be needed and least likely to be reproducible. When a feature folder is created after work has started, back-fill the earlier logs into it in the same session. RESOLVED (this session). |
| M15 | The README and HANDOFF drifted three commits behind the code they described — the README still said "first-milestone validation only" after Phase 1 infrastructure landed, and the HANDOFF called a merged PR open. | Phase-completion commits must update the canonical two files in the same commit, not in a later documentation pass. |
| P12 | An adversarial audit of a plan is worth as much as the plan and must be stored beside it. | The audit found two cited paths that do not exist and a five-citation cluster with a systematic +92-line offset anchoring an architecture argument. A plan without its audit reads as more certain than it is. |
| A10 | The implementation plan is **historical**, not current. ADR 0010's amendment and `plan-audit.md` both outrank it. | Its "Paperclip source changes required: **None**" premise is dead — the harness runs a patched artifact. Do not quote the plan as a live constraint. |

## 6. Pending work

### 6.1 Smallest next action

Nothing in this session is unfinished. The feature's next action is unchanged
and belongs to the previous session's thread: get the user's explicit go for
Phase 1 steps 6–8 (`cdk diff` against the real account, deploy the foundation
stacks, answer ARM64 with one `docker buildx build --platform linux/arm64`,
push the patched image to the new ECR repo).

### 6.2 Immediate next steps

1. Commit this documentation work on a branch cut from `development` and open a
   PR. Docs CI runs `feature-knowledge.mjs` and `docs-links.mjs` on it.
2. Then the feature's own next step: Phase 1 steps 6–8, deploy-gated.
3. **Before Phase 4**, resolve `plan-audit.md` P1-C6 and P1-C7 with the user —
   §30's rollout and §25/§27's cutover cannot both be executed as written.

### 6.3 Blockers and open questions

- [ ] Question: should the 780 KB of raw archaeology notes (`nz-*.md`,
      `pc-*.md`, `synthesis.md`, `verify-*.md`) also be preserved? The user
      chose plan + audit only. They remain in the temporary scratchpad and will
      be lost when it is swept. The plan cites and distils them, so nothing
      instructional is lost — only provenance.
- [ ] The `CDK_DIFF_ROLE_ARN` repository secret did not survive the org
      transfer. Non-gating (scheduled drift workflow only), still missing.
- [ ] Question: should the `updatedSince` patch be offered upstream? — carried
      forward unresolved; the user approved "patch our copy" only.

### 6.4 Deferred, and why

- Applying the audit's 16 citation corrections to the plan text — deliberate,
  see §4.3. The plan stays verbatim.
- Reconciling the plan's four structural defects — those are author decisions
  for the user, not editorial fixes.
- Everything in the feature's own backlog (Phase 1 steps 6–8, Phases 2–10) —
  untouched this session by design.

## 7. Verification actually performed

Documentation-only session: no source, test, or infrastructure file was
changed, so no source lane could regress. Recorded honestly, including what was
not run and why.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `node scripts/ci/feature-knowledge.mjs` | **OK** | **OK** |
| `node scripts/ci/docs-links.mjs` | **OK** — 89 files, 605 internal links | **OK** — 93 files, 740 internal links, 11 external skipped |
| `git diff --check` | not run | clean (working tree and staged) |
| `npm test` | **not run** | **not run** — no source file changed this session. The full suite is owed by whoever pushes, per **P4**; the last real result is in the 2026-08-18 log (185 files / 2108 tests passed, 6 environmental failures per **A9**). |
| `npm run typecheck` | **not run** | **not run** — no TypeScript changed. |
| Paperclip live gate (I3 + FI-4) | **not run** | **not run** — no harness, projection, patch or fixture file changed. Last green: 2026-08-18, three runs. |

## 8. Environment state

- **Tools and services**: Node v24.19.0, PowerShell on Windows 11. Docker was
  not used this session.
- **Active processes**: none started. Any disposable Paperclip or Floci stack
  left running by an earlier session is unaffected by this work.
- **Environment variables**: none required. `PAPERCLIP_TEST_AUTH_SECRET` was not
  needed because the live suite was not run.
- **Uncommitted work left in the tree**: the user's unrelated untracked items
  (`fix-windows-test-suite/`, `handoff-connector-availability-2026-08-15.md`,
  `handoff-staging-deploy-2026-08-14.md`) and a modified
  `infra/lib/github-oidc.test.ts` belonging to the checked-out OIDC branch —
  per **P6**, not staged, not touched.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Implementation plan](../implementation-plan.md) and its [audit](../plan-audit.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
