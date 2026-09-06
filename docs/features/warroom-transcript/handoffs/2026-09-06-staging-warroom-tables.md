---
feature: warroom-transcript
document_role: session-handoff
status: current
observed_at: 2026-09-06
as_of_commit: 54253361ee8740d5241c5ef8681f196a5c7657fa
session_slug: staging-warroom-tables
supersedes: 2026-09-05-scroll-and-pdf.md
---

# Session handoff: promotion complete, staging War Room blocked on missing `TABLE_WARROOM_*`

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-06 |
| Feature folder | `docs/features/warroom-transcript/` |
| Branch worked on | `development` (docs only, via `docs/warroom-transcript-handoff-0906`); the code is on `staging` |
| Branch it merges into next | `production` — via the standing promotion PR [#61](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/61) |
| AWS environment that branch reaches | `staging` is deployed (run 34004002068, attempt 2); `production` not deployed — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `5425336` (development, after #154) |
| Commit at session end | `54253361ee8740d5241c5ef8681f196a5c7657fa` |
| Pushed | yes |
| PR | this handoff's docs PR into `development`; code PRs #151, #152, #153 merged; #61 open |
| Deployed | staging, automatically, by `deploy.yml` on the push to `staging`; production: no |

## 2. Current state summary

The War Room sticky-bottom scroll fix and the transcript PDF export (PR [#151](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/151)) are merged through `development`, `qa` and `staging` and are live on https://staging.pgnos.ai (orchestrator task definition 18; the Paperclip service was not touched and stays on its task definition 4 from 2026-09-03). The five browser checks were proven green on the local stack with polling live, by independent critic agents; the deployed staging bundle carries the new UI and the route is mounted and gated (no token → 401). **What is not done:** the export cannot be verified end-to-end on staging, because every War Room read on staging returns 500 — a pre-existing infra gap, not this change (M12). Production's War Room works today only because its table names equal the code's fallbacks. The production promotion rides PR #61; the War Room evidence is a comment on it. A human dispatches the production deploy.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- Table names reach the orchestrator two ways: `infra/lib/constants.ts` `RESOURCE_NAMES.ddb.*` (`${app}-…`, where `app` is `claudeclaw` or `claudeclaw-staging`) exported as `TABLE_*` env vars in `infra/lib/compute-stack.ts` (~L395–L425), **and** hard-coded unsuffixed fallbacks in each repo module (`process.env.TABLE_X ?? 'claudeclaw-x'`). The War Room tables exist in `dynamo-stack.ts` and `constants.ts` (`warroomMeetings`, `warroomTurns`, `warroomConnections`) but compute-stack never exports them, so on staging the code reads production's names and is denied. This is the general form of the trap `development.md` records for `CCE_NAME_SUFFIX`.
- Staging deploys are `push` to `staging` → `deploy.yml` (Validate source → Typecheck + Unit Tests → Build + CDK Deploy + Smoke). The orchestrator image is cross-built for arm64 under QEMU on an amd64 runner; the Paperclip image is built natively on CodeBuild. A hung QEMU build cancels the run without touching AWS (M13).
- Only one `staging → production` PR can exist per head/base pair; `gh pr create` returns the existing one (#61, opened 2026-08-15) instead of creating a new one.
- Log group for the staging orchestrator: `/claudeclaw-staging/orchestrator` (pino JSON; `{ $.level >= 50 }` finds errors). In Git Bash, prefix such names with `MSYS_NO_PATHCONV=1` or the leading slash is rewritten.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `infra/lib/compute-stack.ts` | Orchestrator task definition, `TABLE_*` env block | Missing `TABLE_WARROOM_*` is the staging fault (M12) |
| `infra/lib/constants.ts` | `RESOURCE_NAMES`, the one source of truth for names | Has `warroomMeetings`/`warroomTurns`/`warroomConnections` ready to export |
| `src/lib/warroom/meetings-repo.ts`, `src/lib/warroom/publisher.ts` | War Room repos | The unsuffixed fallbacks that production happens to match |
| `.github/workflows/deploy.yml` | Staging/production deploy | Build+Push step, no retry; the QEMU hang (M13) |
| `docs/features/warroom-transcript/handoffs/2026-09-05-scroll-and-pdf.md` | Previous session | The build, critic loop and validation evidence |

### 3.3 Patterns and conventions to follow

- Promotion is one PR per rung, gated on `gh run list --workflow=deploy.yml` showing nothing in progress before the `qa → staging` merge.
- A staging deploy failure is diagnosed from the job log first; a cancelled run that never reached CDK leaves AWS untouched.
- Adding a table means three files: `dynamo-stack.ts`, `constants.ts`, and the `TABLE_*` export in `compute-stack.ts`.

## 4. Work completed

### 4.1 Tasks finished

- [x] WRT-5 — promoted #151 through `development → qa` (#152) and `qa → staging` (#153) behind the deploy gate.
- [x] WRT-6 — staging deploy (run 34004002068): attempt 1 cancelled after the QEMU build hang, attempt 2 green in 18 min; Paperclip untouched.
- [x] WRT-7 — staging verification: bundle live (Jump-to-latest, Export PDF, `/warroom-transcripts/` call, no `scrollIntoView`), route mounted and gated. End-to-end PDF blocked by M12.
- [x] WRT-8 — production promotion evidence added as a comment on #61; closing docs PR #154 merged.
- [ ] WRT-9 — fix M12 in `compute-stack.ts` and verify the export end-to-end on staging with a real room. **Not started.** See section 6.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/warroom-transcript/HANDOFF.md` | Current state and next action | Framework requirement |
| `docs/features/warroom-transcript/handoffs/2026-09-06-staging-warroom-tables.md` | This file | One handoff per session |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Do not fix M12 in the feature PR | Add the env lines to compute-stack in #151 | The task forbade `infra/` edits so the Paperclip deployment could not be disturbed; the fix is small but it is a CDK change and deserves its own PR and its own staging deploy |
| Re-run the cancelled staging deploy rather than change the workflow | Pin `binfmt`, add a retry to Build+Push | `.github/` was out of scope; the previous green run had no QEMU crash and `binfmt:latest` was unchanged, so one retry was the smallest correct action |
| Comment on #61 rather than open a second production PR | Edit #61's title/body | GitHub allows one PR per head/base pair and #61 is the owner's; a comment adds the evidence without rewriting their PR |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Staging lacks `TABLE_WARROOM_*`; production works by coincidence of names | `README.md` §7 (known risk), this ledger M12 | yes |
| Adding a table needs the compute-stack export too | this ledger M12 lesson; belongs in `development.md` architectural discoveries | no — `development.md` edit deferred to the fix PR |

## 5. Carried-forward mistakes, assumptions and precautions

> Copied forward from the previous session handoff, then appended to. Nothing is
> deleted. An entry that is fixed is marked `RESOLVED (<commit>)` and stays.

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

### 5.2 Mistakes already made, and their corrections

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M1 | Feature-documentation conventions were written on several pages at once. | The copies drifted and no page was trustworthy. | Single specification in [the framework](../../README.md), machine-checked by `scripts/ci/feature-knowledge.mjs`. | One rule, one home, enforced by CI rather than by discipline. |
| M2 | The repository-root `handoff.md` was used as live, writable operational state. | It became a stale global handoff that contradicted the per-feature ones. | Reduced to a one-sentence compatibility pointer; CI now fails if it grows back. | Operational state is per-feature. A global handoff always rots. |
| M3 | `infra/lib/dynamo-stack.ts` carries a header comment claiming "All 14 DynamoDB tables". | It creates **32**. The comment misled table-count work. | Read the synthesized template, never the comment. | Comments are not authorities. `infra/lib/constants.ts` and the synth output are. |
| M4 | The CodeBuild deploy branch default was changed from `main` to `production`, then reverted. | Churn on a live CI path; the doc fixes from that change were kept, the behaviour change was not. | Reverted in `4ce27a7`, doc fixes retained. | Do not re-apply this without first establishing why it was reverted. |
| M5 | A feature handoff recorded required checks as complete when the authoring machine had no Node runtime, so they could not have run. | The next reader would have trusted an unverified contract. | Disclosed explicitly in the handoff; Docs CI on `development` became the first real execution. | This is precisely what P2 exists to prevent. Disclosure is the minimum; running the check is the goal. |
| M6 | Targeted Vitest was run inside a Windows **linked worktree**. | Startup failed with `Cannot read directory "../../../../../../../.."` and could not resolve `vitest.config.ts`; no tests collected. | Ran from a normal checkout instead. | On Windows, run test suites from a normal clone. Dependency-free Node CI scripts are fine in a worktree; Vitest is not. **2026-09-05 note:** on `.worktrees/warroom-scroll-pdf` (Node 24.19.0, deps installed inside the worktree with `npm ci`) Vitest collected all 241 files and ran; the earlier failure may have been a worktree without its own `node_modules`. Keep the precaution, but try it. |
| M7 | `npm run test:integration:up` was assumed safe alongside the local stack. | It starts LocalStack on port 4566 and collides with Floci. Two emulators must never run at once. | Use `npm run local:test:integration`, which passes `--env-file=.env`. | One emulator on 4566, ever. |
| M8 | `.env` was created for local development while several lifecycle scripts default their environment flag to **prod** and read `.env`. | Commands that were previously inert became genuinely dangerous. | Catalogued in [dangerous commands](../../../../development.md#dangerous-commands-never-run-locally). | Read that list before running any unfamiliar `npm run` script. |
| M9 | `git worktree add` was interrupted mid-checkout (stale zero-byte `index.lock`, 126 files never written, worktree left `locked`). | The worktree looked like a checkout with hundreds of staged deletions. | Removed the stale lock (no git process running), `git reset` (index only) then `git restore -- .` in the brand-new worktree. | Check `git worktree list` for `locked` and the admin dir for `index.lock` before trusting a fresh worktree. Never `reset --hard` a worktree you did not just create. |
| M10 | The first autoscroll fix measured distance-from-bottom inside the `scroll` handler. A scroll event is dispatched at the next rendering opportunity, which can be after the next turn has been appended, so the handler saw the new bubble's height as the user leaving the bottom and un-pinned the view. | The transcript silently stopped following after a couple of arrivals; a code read could not have caught it. | Track the last known `scrollTop`; while pinned, ignore scroll events that did not move the view up (`WarRoom.tsx`). | Browser-verify scroll behaviour with real polling; reading the diff is not testing it. |
| M11 | `npm run local` (`scripts/local/dev.mjs`) dies with `spawn npm ENOENT` when launched by the Claude Browser preview tool on Windows, after Floci is provisioned. | The combined launcher cannot be used from the preview tool. | Two launch entries instead: `npm --prefix <worktree> run dev` (:3000) and `npm --prefix <worktree>/web run dev` (:5173). | From a normal terminal `npm run local` is unaffected. |
| M12 | Staging War Room returns 500 on every read. `infra/lib/compute-stack.ts` sets 25 `TABLE_*` env vars but not `TABLE_WARROOM_MEETINGS`, `TABLE_WARROOM_TURNS`, `TABLE_WARROOM_CONNECTIONS`, so `src/lib/warroom/*` fall back to the unsuffixed `claudeclaw-warroom-*` names and the staging task role is denied (`dynamodb:Scan on table/claudeclaw-warroom-meetings`). Production is unaffected only because its `${app}` prefix equals the fallback. | The transcript PDF could not be verified end-to-end on staging; looked like an app regression. | Not fixed in this session (infra change, out of scope). Fix: add the three env lines next to `TABLE_JARVIS_*` in compute-stack, deploy staging via the normal `qa → staging` merge, re-verify. | A table added to `dynamo-stack.ts` + `constants.ts` is not reachable on staging until compute-stack exports its `TABLE_*` name too. Check all three files when adding a table. |
| M13 | `deploy.yml` staging run 34004002068 attempt 1 hung 2.5 h and was cancelled: the arm64 orchestrator image build under QEMU (`docker buildx --platform linux/arm64` on an amd64 runner) crashed with `qemu: uncaught target signal 4 (Illegal instruction)` during `npm install` and never recovered. | A promotion looked failed; staging was in fact untouched (the run never reached CDK). | `gh run rerun <id> --failed`; attempt 2 was green in 18 min. `tonistiigi/binfmt:latest` (unpinned by `setup-qemu-action`) had not changed, same runner image, so transient. | Read the job log before assuming a deploy failure is the change. A watcher that cancels the run when the build step exceeds ~30 min saves two hours. |

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it any time with `npm run local:verify`, which requires account id `000000000000`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS**, Floci 1.6.0, Docker 28.3.2, Node 24.3.0, on 2026-08-10. | Windows and Linux behaviour is **not** covered by that verification. See M6. |
| A3 | Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. | Local development validates plumbing, never model behaviour. Tool use is unreachable locally by design. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; deployment is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const). | A `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception. |
| A6 | AWS console access for this account is root-user sign-in via `aws login` with the `netzer-root` profile. | The `netzer-dev` SSO profile is known broken. Do not burn time on it. |
| A7 | The local `DASHBOARD_TOKEN` equals the committed placeholder in `.env.local.example`, so setting it in the local SPA is not handling a credential. | Verified by comparing the two files this session. Never assume this for `.env.staging`. |
| A8 | `GET /api/warroom-transcripts/:id` behaves identically in production and locally because production table names equal the code defaults. | Verified by reading `constants.ts` (`${app}-warroom-*`, `app = claudeclaw` in prod) against the repo fallbacks; **not** yet verified by a request against production. |

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

## 6. Pending work

### 6.1 Smallest next action

Add `TABLE_WARROOM_MEETINGS: RESOURCE_NAMES.ddb.warroomMeetings`, `TABLE_WARROOM_TURNS: RESOURCE_NAMES.ddb.warroomTurns`, `TABLE_WARROOM_CONNECTIONS: RESOURCE_NAMES.ddb.warroomConnections` to the `TABLE_*` block in `infra/lib/compute-stack.ts`, with a unit assertion in `infra/lib/*.test.ts` that every `RESOURCE_NAMES.ddb` table is exported, then run `npx cdk synth` (hermetic) and confirm the production template's values equal the code fallbacks.

### 6.2 Immediate next steps

1. Fix branch off `development` for M12 (WRT-9); unit test first; `cdk synth` for both prod and staging contexts; PR into `development`.
2. Promote `development → qa → staging` behind the deploy gate. The staging deploy runs CDK, so it updates the orchestrator task definition; the Paperclip service is not part of that task definition. Check `gh run list --workflow=deploy.yml` is idle first.
3. On staging: create one room, post one turn, and run the five browser checks plus the transcript PDF check end-to-end (the script `verify-staging.mjs` from the 2026-09-06 scratchpad is the API half; the browser half needs a signed-in session).
4. Prove production is unchanged: before and after, the same War Room API probes against production must return the same status codes (list, history, unknown id, no token).
5. Human: merge #61 and dispatch `deploy.yml` with `env: prod`.

### 6.3 Blockers and open questions

- [ ] Blocker: end-to-end export verification on staging — needs: M12 fixed and deployed to staging.
- [ ] Question: should `TABLE_WARROOM_CONNECTIONS` also be exported (it is in `constants.ts`; check whether any module reads it) — suggested resolution: export all three, unused env vars are harmless.

### 6.4 Deferred, and why

- Pinning `tonistiigi/binfmt` or adding a retry to the QEMU build — deferred because `.github/` was out of scope; recorded as M13.
- Browser-level scroll checks on staging — deferred because the staging token is a real credential; a human-signed-in session or a scoped viewer token is needed.

### 6.5 Follow-on prompt

The paste-ready gauntlet-loop prompt for WRT-9 is recorded in the session log of the conversation that produced this file and reproduced here so the next session does not have to reconstruct it:

> Fix the War Room on staging so the transcript PDF export ships to production without changing production behaviour. The staging orchestrator reads the unsuffixed production table names because `infra/lib/compute-stack.ts` never exports `TABLE_WARROOM_MEETINGS`, `TABLE_WARROOM_TURNS`, `TABLE_WARROOM_CONNECTIONS` from `RESOURCE_NAMES.ddb`; every War Room read on staging is a 500. The bar is production's own War Room: record its status codes for list, history, unknown id and no token before you start, and the exact `TABLE_*` values in its current task definition; after the change the production `cdk synth` template must set those three variables to precisely the names the code already falls back to, and the recorded probes must return the same codes. On staging the bar is the five browser checks from `docs/features/warroom-transcript` plus the transcript PDF check, end to end, against a real room. Do not touch `vendor/`, the Paperclip stack, or `.github/`. Full details in section 6 above.

## 7. Verification actually performed

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `node scripts/ci/docs-links.mjs` | OK | OK |
| `node scripts/ci/feature-knowledge.mjs` | OK | OK |
| `git diff --check` | clean | clean |
| `npm run typecheck`, `npm test`, builds, integration | see the 2026-09-05 handoff §7 (no code changed this session) | not re-run — docs only |
| Staging probes (`verify-staging.mjs`) | — | whoami PASS; bundle markers PASS ×4; no-token 401 PASS; War Room reads 500 (M12), PDF end-to-end not run |

Anything not run, and why: the code suite was not re-run because this session changed only documentation. Browser checks on staging were not run (credential; see 6.4).

## 8. Environment state

- **Tools and services**: Docker Desktop + Floci left running on the developer machine; the two preview dev servers were stopped. Worktree `.worktrees/warroom-scroll-pdf` exists with nothing uncommitted (on the docs branch).
- **Active processes**: none started by this session remain besides Floci.
- **Environment variables**: `.env.staging` (main checkout) holds the staging `DASHBOARD_TOKEN`, used only as a request header, never printed. Names only.
- **Uncommitted work left in the tree**: the main checkout `C:/dev/Netzer-Labs` (branch `fix/knowledge-scope-fanout`) carries a large uncommitted tree that is not this session's; untouched (P6).

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-09-05-scroll-and-pdf.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
