---
feature: paperclip
document_role: session-handoff
status: current
observed_at: 2026-08-18
as_of_commit: a7ab7a325487c6ea06a3158f88d8cd45b73e0b53
session_slug: updated-since-patch-and-phase-0
supersedes: none
---

# Session handoff: finish Milestone 1D, resolve the I3 blocker, Phase 0 docs

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-18 |
| Feature folder | `docs/features/paperclip/` |
| Branch worked on | `codex/paperclip-integration` |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `7a2e733254a6a353dd30e2056cf6aabc0704d8c2` |
| Commit at session end | see the Phase 0 docs commit that follows `a7ab7a325487c6ea06a3158f88d8cd45b73e0b53` |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

This session resumed the Paperclip integration from the previous session's
pause (Milestone 1D interrupted mid-edit, I3 deliberately red as an
architecture gate). It finished Milestone 1D (`paperclip_disabled` kill switch
+ mission authorization pin, commits `4552445` and `483f5a7`), then presented
the I3 blocker to the user, who approved patching our self-hosted Paperclip
copy (plan-amendment option 3). The 37-line `updatedSince` patch was written
against the pinned release source, adversarially reviewed (3 findings, all
fixed pre-commit), built into `netzer-paperclip:2026.722.0-netzar.1`
(commits `527512d`, `a7ab7a3`), and proven live: I3 and FI-4 green on a fresh
stack, green again from a second process, and the review fixes proven by
direct HTTP probes plus greps of the compiled dist inside the running
container. Phase 0 (ADR 0010, ADR 0009 note, this feature folder) was then
written. Left off at: Phase 0 validation + commit.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- The pinned Paperclip image runs `server/dist` (plain `tsc` output) but ships
  full `src`, `tsconfig.json`, and a complete `node_modules` including `tsc`
  and `tsx`, as root, on Debian trixie without `patch`(1). A derived image can
  therefore apply a source patch and recompile in place with no external
  toolchain (`vendor/paperclip/Dockerfile`).
- Paperclip's `updated_at` is `timestamptz` with `defaultNow()` — microsecond
  storage — while every API caller only ever observes millisecond-truncated
  values. A naive `>` watermark re-returns a row at its own watermark; the
  correct indexed form is `updated_at >= watermark + 1ms` (ADR 0010
  amendment; `vendor/paperclip/updated-since.patch`).
- Paperclip's issue-list request coordination
  (`issueListRequestKey`/`normalizeIssueListCacheValue`) normalizes a `Date`
  value to `{}`; any new filter carried as a Date must be keyed as its ISO
  string or distinct requests coalesce into one in-flight compute.
- `updated_at` is stamped from two clocks (Postgres `now()` on insert, Node
  `new Date()` on update), so Node-behind-Postgres skew can write an update at
  or before an already-observed watermark. Pre-existing upstream behavior; the
  future reconciler must overlap polls rather than trust exact watermarks.
- Viewer-tier denials on the mission POST routes come from the coarse legacy
  `requiredRole='operator'` middleware (`{error, requiredRole, yourRole}`)
  before the per-route capability gate; the authz matrix pins that exact
  envelope, and the capability decisions are pinned at the decision level.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `vendor/paperclip/updated-since.patch` | The one approved upstream-source change | The I3 blocker's resolution; re-evaluated on every re-pin |
| `vendor/paperclip/Dockerfile` | Builds pinned digest + patch reproducibly | The harness and any future deploy build from this |
| `src/lib/paperclip/client.paperclip.integration.test.ts` | I3 + FI-4 live contracts | The architecture gate that was red and is now green |
| `tests/fixtures/paperclip-bootstrap.ts` | Authenticated bootstrap + credential cache | Its `docker compose` calls require `PAPERCLIP_TEST_AUTH_SECRET` in the *test* process env |
| `src/lib/state/kill-switches-repo.ts` | Kill-switch registry (now 41) | `paperclip_disabled` added in three hand-maintained places |
| `docs/adr/0010-paperclip-work-engine.md` | Ratified decisions, DL-1…DL-9 verbatim | The durable home of everything this session decided |

### 3.3 Patterns and conventions to follow

- Kill-switch union, `ALL_KILL_SWITCHES`, and `KILL_SWITCH_META` are
  hand-maintained together; `kill-switches-repo.test.ts` pins the count (41).
- Authorization tests drive the real dashboard router with only token-auth
  entrypoints stubbed; coarse legacy denials are pinned exactly, capability
  decisions separately.
- Cross-surface chat parity per [`CLAUDE.md`](../../../../CLAUDE.md) — not
  touched this session, applies once Missions UI work starts.

## 4. Work completed

### 4.1 Tasks finished

- [x] Milestone 1D — `paperclip_disabled` + mission authz pin (`4552445`, `483f5a7`)
- [x] I3 blocker resolution via user-approved artifact patch (`527512d`, `a7ab7a3`)
- [x] Phase 0 — ADR 0010, ADR 0009 superseding note, this feature folder
- [ ] Phase 0 validation + commit — in progress at time of writing; real results in §7

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `src/lib/state/kill-switches-repo.ts` | +`paperclip_disabled` (union, array, meta) | Plan Phase 0 / Milestone 1D |
| `src/adapters/dashboard/authz-matrix.test.ts` | Mission route matrix, kill-switch inventory, decision-level tests | Pin authz before any route swap |
| `src/lib/state/kill-switches-repo.test.ts` | Count 40→41 | The registry grew |
| `vendor/paperclip/{Dockerfile,updated-since.patch}` | New | The approved patched artifact |
| `docker-compose.paperclip.yml`, `package.json` | Build patched image; `--build` on up | Harness runs the patched artifact |
| `.gitattributes` | New; LF pin for vendored patch | CRLF checkout breaks `patch`(1) in the Linux build |
| `docs/adr/0010-paperclip-work-engine.md` | New | Phase 0 step 1 |
| `docs/adr/0009-mission-container-model.md` | Superseding note | Phase 0 step 4 |
| `docs/features/paperclip/*` | New folder | Phase 0 step 3 |
| `docs/features/missions/HANDOFF.md` | Volatile-state update | Phase 0 files-affected |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Patch our pinned copy (user-approved) | Wait for upstream; redesign the feed; fork | User chose option 3; smallest diff, keeps DL-9 otherwise intact; recorded as the ADR 0010 amendment |
| `>= watermark + 1ms` not naive `>` | Bare `>`; `date_trunc` in SQL | Correct at ms resolution against microsecond storage, index-friendly |
| Offset-required ISO validation | Accept anything `new Date` parses | A bare local time silently shifts a watermark by the server TZ — data-loss class |
| Pin the coarse 403 envelope in the authz matrix | Assert the capability envelope | The legacy middleware fires first; the route swap must reproduce both layers |

Durable items are in [ADR 0010](../../../adr/0010-paperclip-work-engine.md).

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| DL-1…DL-9, hard constraints, patch amendment | `docs/adr/0010-paperclip-work-engine.md` | yes |
| Watermark semantics, patch mechanics, validation commands | `docs/features/paperclip/README.md` | yes |
| ADR 0009 partial supersession | superseding note in ADR 0009 | yes |
| Clock-skew reconciler caveat | README §7 risk table | yes |

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

## 6. Pending work

### 6.1 Smallest next action

Commit the Phase 0 documentation set (ADR 0010, ADR 0009 note, this folder,
missions HANDOFF update) after both docs gates pass.

### 6.2 Immediate next steps

1. Run Phase 0 validation (docs gates, typecheck, full `npm test`) and commit.
2. Start the plan's Paperclip client (C1): typed HTTP transport with the
   `paperclip_disabled` gate at invoke, modelled on `src/lib/salesforce/client.ts`.
3. Decide with the user when to push and open the PR into `development`.

### 6.3 Blockers and open questions

- [ ] Question: should the `updatedSince` patch be offered upstream? — user
  approved "patch our copy" only; upstreaming is optional follow-up.

### 6.4 Deferred, and why

- Paperclip ECS/Aurora/EFS infrastructure, client, reconciler, ACL, tools, UI
  — later plan phases, in order.
- Full pre-push validation suite — owed at push time; this session did not push.

## 7. Verification actually performed

Fill in the real result. `not run` is an acceptable and expected answer;
a false `pass` is not.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | clean (prior session) | clean (run twice this session, after 1D and after the count fix) |
| `npm test` | at `4bdbf08`: 181 files / 2019 tests passed; 7 files / 20 failed; 6 skipped (environmental) | 182 files / 2098 passed; 7 files / 8 failed — kill-switch count regression found and fixed (`483f5a7`); remaining 6 failing files are the recorded environmental set |
| Paperclip live gate (I3 + FI-4, focused vitest integration run) | I3 red by design (server lacked `updatedSince`) | green ×3: fresh stack, accumulated DB, second cached-credential process |
| `npm run build` | not run | not run — no push this session; owed at push time |
| `npm --prefix web run typecheck` | not run | not run — no web changes; owed at push time |
| `npm --prefix web run build` | not run | not run — owed at push time |
| `npm run local:test:integration` | not run | not run — Floci stack not brought up this session; owed at push time |
| `node scripts/ci/docs-links.mjs` | not run | **OK** — 89 files, 605 internal links checked |
| `node scripts/ci/feature-knowledge.mjs` | not run | **OK** |
| `git diff --check` | not run | clean (working tree and staged) |

Anything not run, and why: the four build/web/Floci commands above — this
session ends with local commits, no push; the full pre-push list is owed by
whoever pushes. A second full `npm test` after the Phase 0 docs: 183 files /
2099 tests passed; the 6 failing files are exactly the recorded environmental
set (see A9), none new. Note the `scripts/ci/docs-links.test.ts` and
`feature-knowledge.test.ts` *vitest* files are part of that environmental
parser-failure set on Windows — the `.mjs` gates themselves (what Docs CI
executes) ran green directly, as recorded above.

## 8. Environment state

- **Tools and services**: Node v24.19.0, npm 11.17.0, Docker server 29.7.2,
  Vitest 2.1.9, PowerShell on Windows 11.
- **Active processes**: disposable Paperclip stack left **running and
  healthy** (`netzer-labs-paperclip-1` on the patched image,
  `netzer-labs-paperclip-db-1`); stop with `npm run test:paperclip:down`
  (requires `PAPERCLIP_TEST_AUTH_SECRET` set and Docker on `PATH`).
- **Environment variables**: `PAPERCLIP_TEST_AUTH_SECRET`,
  `PAPERCLIP_TEST_BASE_URL` (optional), `DOCKER_BIN` (optional),
  `LOCALAPPDATA`. Names only; values were generated per-process and never
  recorded.
- **Uncommitted work left in the tree**: the user's unrelated untracked items
  (`fix-windows-test-suite/`, `handoff-connector-availability-2026-08-15.md`,
  `handoff-staging-deploy-2026-08-14.md`, `handoffs/`) — per **P6**, not
  staged, not touched.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
