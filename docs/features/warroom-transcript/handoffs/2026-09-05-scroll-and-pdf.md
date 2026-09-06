---
feature: warroom-transcript
document_role: session-handoff
status: current
observed_at: 2026-09-05
as_of_commit: f8863b0b56fa67e5e5db3c7254690814412c4c81
session_slug: scroll-and-pdf
supersedes: none
---

# Session handoff: War Room sticky-bottom scroll and transcript PDF export

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-05 |
| Feature folder | `docs/features/warroom-transcript/` |
| Branch worked on | `fix/warroom-scroll-and-pdf` (git worktree `.worktrees/warroom-scroll-pdf`, branched from `origin/development`) |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `17f0456b670296b3877c0b782708ebcbe0d35b31` |
| Commit at session end | `f8863b0b56fa67e5e5db3c7254690814412c4c81` (code) plus the docs commit that follows it |
| Pushed | yes |
| PR | [#151](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/151) into `development` (merged); promotions [#152](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/152), [#153](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/153) (merged); [production promotion](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/61) open |
| Deployed | staging, automatically: `deploy.yml` run 34004002068 on the push to `staging`. Production: no. |

## 2. Current state summary

Two War Room fixes on `fix/warroom-scroll-and-pdf`: the transcript no longer snaps to the bottom on every 2.5 s history poll (it pins only while the reader is at the bottom, releases on scroll-up, re-pins on return, and offers a Jump-to-latest control), and an Export PDF button streams the whole transcript from a new `GET /api/warroom-transcripts/:id` route on `buildDashboardRouter` through the shared `buildPdf`. Both were proven against the real running page with polling live by independent critic agents, one per check, in a real browser: (1) pinned while messages arrive, (2) still scrolled up after several polling ticks, (3) returning re-pins, (4) an empty tick never moves the view, (5) the PDF matches the screen with every speaker and message in order. Check 3 failed on the first round and exposed a real race (a scroll event dispatched after the next bubble appended un-pinned the view); the fix tracks the last known scroll position. The full validation list was run (section 7). The change is ready for the PR into `development`; promotion state is in the feature [HANDOFF](../HANDOFF.md).

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- War Room routes live on `buildWarroomRouter` (`src/adapters/dashboard/warroom.ts`, mounted at `/api/warroom`), **not** on `buildDashboardRouter`. Hono flattens mounted sub-apps into one router, so a dashboard-router path under `/api/warroom/*` would run both routers' middlewares (two bearer authentications). The PDF route therefore lives at `/api/warroom-transcripts/:id` on `buildDashboardRouter` and re-checks `warroom:read` itself via the router's own `hasCapability` helper.
- `getHistory(meetingId, sinceSeq, limit = 100)` returns one DynamoDB page and nothing paginates it; the SPA poll therefore shows at most 100 turns. The PDF route loops on `sinceSeq` so it is never truncated.
- The SPA history poll (`WarRoom.tsx`, every 2.5 s) calls `setMessages(reconcileMessages(...))`, which returns a **new array every tick even when nothing changed**. Any effect keyed on `messages` fires every tick; that is why the old `scrollIntoView` effect dragged the view down. The fix keys pinning on scroll position (`pinnedRef`), not on array identity, and scrolls instantly (a smooth scroll emits intermediate `scroll` events that would un-pin itself).
- `web/src/lib/api.ts downloadFile(path, filename)` is the one sanctioned authenticated blob download (bearer from `getToken`, `res.ok` checked before saving).
- `pdf-parse` is already a production dependency (`src/lib/vectors/extractors.ts`) and exposes a `PDFParse` class in the installed version, so tests and critics can read a PDF back without a new dependency.
- Vitest **did** collect and run inside this Windows linked worktree (241 files), so the M6 trap did not reproduce here.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `web/src/pages/WarRoom.tsx` | War Room SPA page: polling, SSE, transcript pane | Scroll pinning (`scrollRef`, `pinnedRef`, `onTranscriptScroll`, `jumpToLatest`), Export PDF button (`exportPdf`) |
| `src/adapters/dashboard/handler.ts` | `buildDashboardRouter` (mounted at `/api`) | New `GET /warroom-transcripts/:id` next to `GET /sessions/transcript`; `hasCapability` + `requiredRole` gates |
| `src/adapters/dashboard/warroom.ts` | `buildWarroomRouter` (mounted at `/api/warroom`) | The read/write gates and `warroom_disabled` kill switch the PDF route mirrors |
| `src/lib/documents/pdf.ts` | `buildPdf(spec)` on pdfkit | Reused unchanged; standard Helvetica is WinAnsi (no emoji/CJK) |
| `src/lib/warroom/publisher.ts` | `getHistory` | One DynamoDB page per call; the route paginates on `sinceSeq` |
| `src/adapters/dashboard/authz-matrix.test.ts` | Route auth test harness | The mocking pattern the new test copies |
| `web/src/lib/api.ts` | `downloadFile` | Authenticated blob download reused by the button |

### 3.3 Patterns and conventions to follow

- Binary responses from a Hono route: `c.body(new Uint8Array(buf), 200, headers)` (as `src/adapters/dashboard/spa.ts`).
- Dashboard-router capability gates return `{ error: 'forbidden', requiredCapability }` with 403; kill switches are read with `isKillSwitchActive(...).catch(() => ({ active: false }))`.
- Route tests drive the real router through `app.request()` with `dashboard-auth.js` stubbed by `vi.mock(..., importActual)`; never hit AWS.
- Cross-surface parity ([`CLAUDE.md`](../../../../CLAUDE.md)): this change is dashboard-only by nature (a viewport scroll fix and a file download); Telegram and Slack have no transcript pane to mirror. Noted here rather than silently omitted.

## 4. Work completed

### 4.1 Tasks finished

- [x] WRT-1 — sticky-bottom transcript scroll: pin only while the user is at the bottom, release on scroll-up, re-pin on return, Jump-to-latest control, no movement on an empty poll tick.
- [x] WRT-2 — `GET /api/warroom-transcripts/:id` on `buildDashboardRouter`: bearer + role middleware, `warroom:read` capability, `warroom_disabled` kill switch, paginated history, `buildPdf`, attachment filename. Five vitest cases (401/403/404/200+content order/pagination).
- [x] WRT-3 — Export PDF button in the War Room header via the shared `downloadFile` helper.
- [x] WRT-4 — the five browser checks green against the live page with polling (see section 7 and the critic evidence in section 2).

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `web/src/pages/WarRoom.tsx` | `scrollRef`/`pinnedRef`/`lastTopRef`, `onTranscriptScroll`, `jumpToLatest`, instant scroll-to-bottom effect keyed on `[messages, typingAgents.length]`, pin reset in `openRoom`, Jump-to-latest and Export PDF buttons, `exportPdf` | Replace the `scrollIntoView` effect that fired on every poll tick; give the user a way down; expose the export |
| `src/adapters/dashboard/handler.ts` | New route `GET /warroom-transcripts/:id` (+ imports `getMeeting`, `getHistory`, `buildPdf`) | Stream the transcript PDF with the dashboard router's auth and role checks |
| `src/adapters/dashboard/warroom-transcript.test.ts` | New | Route contract: 401, 403 body, 404, PDF headers + ordered content, pagination |
| `docs/features/warroom-transcript/*` | New feature folder | Framework requirement |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Route on `buildDashboardRouter` at `/warroom-transcripts/:id`, re-checking `warroom:read` in the handler | Add it to `buildWarroomRouter`; nest under `/api/warroom/*` on the dashboard router | The request named `buildDashboardRouter`; a path under `/api/warroom/*` would run both routers' middlewares; the in-handler capability check keeps parity with every other War Room read |
| Pin state lives in refs (`pinnedRef`, `lastTopRef`), not React state; scrolling is instant | Key the effect on message ids; smooth scroll; a ResizeObserver | The poll hands a new array every tick, so array identity is useless; a smooth scroll and a late-dispatched scroll event both un-pin the view the user never touched (the critic reproduced the latter) |
| Paginate `getHistory` in the route rather than raise its limit | `getHistory(id, 0, 10_000)` | DynamoDB `Limit` caps a page, not the result; only a loop guarantees nothing is truncated |
| Standard pdfkit Helvetica, no embedded font | Ship a TTF | No new file or dependency; the ceiling (no emoji/CJK glyphs) is marked with a `ponytail:` comment in the route |

Anything durable here must also become an ADR. A decision recorded only in a
session log is not an accepted decision.

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| The poll returns a new `messages` array every tick, so effects keyed on it fire every 2.5 s | `docs/features/warroom-transcript/README.md` §6 | yes |
| `getHistory` returns one DynamoDB page; callers must paginate on `sinceSeq` | `docs/features/warroom-transcript/README.md` §6 | yes |
| Vitest collects and runs in a Windows linked worktree (contradicts M6) | section 5 of this handoff (M6 annotated) | yes |

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

A human merges the [production promotion PR](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/61) and dispatches `deploy.yml` with `env: prod` and the typed confirmation.

### 6.2 Immediate next steps

1. ~~Merge into `development`, delete the branch~~ — done (#151, branch deleted).
2. ~~Promote `development → qa → staging` behind the deploy gate~~ — done (#152, #153; gate checked twice, no deploy.yml run in progress; staging deploy run 34004002068).
3. ~~Verify on staging~~ — API-level verification done: the deployed bundle carries the new UI (Jump-to-latest, Export PDF, the `/warroom-transcripts/` call, no `scrollIntoView` in the War Room chunk) and the route is mounted and gated (no token → 401). The end-to-end PDF check could not run: every War Room read on staging returns 500 because the staging task definition sets no `TABLE_WARROOM_MEETINGS`/`TABLE_WARROOM_TURNS`, so the orchestrator reads the unsuffixed production table name and the staging task role is denied `dynamodb:Scan` (log evidence from 04:04Z, before this deploy rolled at 04:24Z). Pre-existing infra fault, out of scope; recorded in README §7.
4. Human: merge the production promotion PR and dispatch `deploy.yml` (`env: prod`).

### 6.3 Blockers and open questions

- [ ] Question: should `GET /warroom-transcripts/:id` be added to the `ROUTES` catalog in `authz-matrix.test.ts`? — suggested resolution: no; the structurally identical `GET /sessions/transcript` is not listed there either, and every templated tier holds `warroom:read`, so the matrix would have no deny row.

### 6.4 Deferred, and why

- Embedding a Unicode font in `buildPdf` — deferred because it is a shared builder and no transcript has needed it yet; marked with a `ponytail:` comment at the route.
- Rendering Markdown in the PDF — deferred because the PDF mirrors the raw turn content the API serves.
- The on-screen 100-turn cap of the history poll — deferred because it is pre-existing and out of scope; the PDF paginates and is complete.

## 7. Verification actually performed

Fill in the real result. `not run` is an acceptable and expected answer;
a false `pass` is not.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | not run at baseline | pass (exit 0) |
| `npm test` | 3009 passed, 1 failed (`scripts/lib/lifecycle/rollback-classes.test.ts` — `/tmp/fake/cdk.out` vs `\tmp\fake\cdk.out`, a Windows path-separator assertion), 4 files fail to parse on Windows (`scripts/ci/docs-links.test.ts`, `scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`, `scripts/release/sync-deprecations.test.ts`: "Invalid or unexpected token"). All pre-existing on `17f0456`. | 3014 passed, the identical 1 failure and 4 parse failures, nothing new; `src/adapters/dashboard/warroom-transcript.test.ts` 5/5 pass |
| `npm run build` | not run at baseline | pass (exit 0) |
| `npm --prefix web run typecheck` | not run at baseline | pass (exit 0) |
| `npm --prefix web run build` | not run at baseline | pass (built in 4.67 s) |
| `npm run local:test:integration` | not run at baseline | 38 passed, 1 failed, 25 skipped: the one failure is `scripts/destroy.integration.test.ts > checkSecrets … schedule-deleted`, the documented Floci `ListSecrets` gap ([known local limitations](../../../../development.md#known-local-limitations) item 9) |
| `node scripts/ci/docs-links.mjs` | not run at baseline | OK (130 files, 1517 internal links) |
| `node scripts/ci/feature-knowledge.mjs` | not run at baseline | OK |
| `git diff --check` | clean (fresh worktree) | clean |

Anything not run, and why: everything in the table ran. The browser checks are not in the table; their evidence is in section 2 and in the [progress log](https://claude.ai/code/artifact/a34083bf-7621-4104-adec-c3dd25aa2c97) kept during the session.

## 8. Environment state

- **Tools and services**: Windows 11, Node 24.19.0, Docker Desktop with Floci 1.6.0 (`netzer-os-floci`, 32 tables provisioned), Git worktree `.worktrees/warroom-scroll-pdf` with its own `node_modules` (root and `web/`).
- **Active processes**: orchestrator `tsx watch` on :3000 and Vite on :5173, both launched from the worktree by the Claude Browser preview tool (launch entries `warroom-api`, `warroom-web` in the untracked `.claude/launch.json` of the main checkout). The fixture room `9e68f350-5ca9-4f1e-8985-f26c72a54ab2` ("Scroll fixture room") lives only in the in-memory emulator.
- **Environment variables**: `.env` copied from the main checkout (`AWS_ENDPOINT_URL`, `NODE_ENV=development`, `PORT`, `DASHBOARD_TOKEN` = the committed local placeholder). Names only.
- **Uncommitted work left in the tree**: none in this worktree beyond this change. The main checkout `C:/dev/Netzer-Labs` (branch `fix/knowledge-scope-fanout`) carries a large uncommitted tree that is not this session's; it was not touched (P6).

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
