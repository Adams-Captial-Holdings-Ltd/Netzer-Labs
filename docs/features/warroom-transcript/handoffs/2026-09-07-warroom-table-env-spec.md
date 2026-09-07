---
feature: warroom-transcript
document_role: session-handoff
status: current
observed_at: 2026-09-07
as_of_commit: 15922df50bae36839cbd2004c27b7794d9f19f1d
session_slug: warroom-table-env-spec
supersedes: 2026-09-06-staging-warroom-tables.md
---

# Session handoff: WRT-9 production baseline (WI-0) and the failing infra test (WI-1 specification)

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-07 |
| Feature folder | `docs/features/warroom-transcript/` |
| Branch worked on | `fix/warroom-table-env-vars` (cut from `origin/development`) |
| Branch it merges into next | `development` |
| AWS environment that branch reaches | none — per the [branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping) |
| Commit at session start | `15922df50bae36839cbd2004c27b7794d9f19f1d` |
| Commit at session end | see section 7 |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

WRT-9 (fix M12) is in its specification phase. This session collected the
**live production baseline** that the production-invariance bar is measured
against, and wrote the single failing infrastructure test that freezes the
implementation contract. No production or staging system was changed: every
production interaction was a read. `infra/lib/compute-stack.ts` is deliberately
**not** edited in this session — that is the next session's only code change.
The baseline in section 4.5 is the reference the eventual re-probe must match
exactly; it was measured against the live production system, not inferred from
source.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- The orchestrator `TABLE_*` env block on `origin/development` is
  `infra/lib/compute-stack.ts:395-421` — exactly 25 entries, ending with
  `TABLE_JARVIS_CANARY` at `:421`. The count and the names match the **live**
  production task definition key-for-key (section 4.5), so the deployed
  production system and this source tree agree about this block.
- `infra/lib/paperclip-stack.test.ts:22` records convention **A20**: assertions
  are on literals or on `buildResourceNames('')`, *never* on the same constant
  the stack used to synthesize the value, because `expect(x).toBe(THE_CONSTANT)`
  compares a constant with itself and passes under any rename. The new test
  obeys this — it asserts the three literal strings.
- Nothing in `src/` reads `TABLE_WARROOM_CONNECTIONS`. IAM carries a separate
  `ApiGwWarroomConnections` grant, so that table is consumed by the API Gateway
  WebSocket path rather than the orchestrator container. This answers the open
  question carried in the previous handoff's §6.3.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `infra/lib/compute-stack.ts:395` | Orchestrator `TABLE_*` env block, 25 entries | The one seam WRT-9 changes; insertion point is after `TABLE_JARVIS_CANARY` at `:421` |
| `infra/lib/constants.ts:108` | `warroomMeetings` / `warroomTurns` / `warroomConnections` | The three names already exist; only the export is missing |
| `infra/lib/constants.ts:236` | `RESOURCE_NAMES = buildResourceNames()` | Frozen at module import, so a suffix-dependent test needs `vi.resetModules()` + dynamic import |
| `infra/lib/paperclip-stack.test.ts:524` | `computeTemplateUnguarded` | The existing, working recipe for synthesizing a real `ComputeStack`; reused rather than reinvented |
| `src/lib/warroom/meetings-repo.ts:14-15` | `TABLE` / `TURNS_TABLE` fallbacks | The literals the production-invariance gate compares against |
| `src/lib/warroom/publisher.ts:6-7` | `TURNS_TABLE` / `MEETINGS_TABLE` fallbacks | Same |

### 3.3 Patterns and conventions to follow

- Assert **literal** expected strings in infra tests (A20 above). Comparing
  `RESOURCE_NAMES.ddb.warroomMeetings` to itself proves nothing.
- Synth is hermetic and needs no AWS credentials **provided `DOMAIN_NAME` stays
  unset**; `compute-stack.ts:1109` is the one branch that would call
  `HostedZone.fromLookup` and reach AWS.
- Adding a table means three files: `dynamo-stack.ts`, `constants.ts`, and the
  `TABLE_*` export in `compute-stack.ts` (carried from the previous session).

## 4. Work completed

### 4.1 Tasks finished

- [x] WI-0 — live production baseline recorded (section 4.5). Blocking gate for
      every later edit; satisfied before any file was written.
- [ ] WI-1 — specification only. The failing test is written and proven red;
      the implementation is deliberately **not** done here. See section 6.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/warroom-transcript/handoffs/2026-09-07-warroom-table-env-spec.md` | This file | One handoff per session |
| `infra/lib/compute-stack.test.ts` | New file — one failing test | Freezes the WRT-9 contract before implementation |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Assert the three War Room variables specifically, not "every `RESOURCE_NAMES.ddb` table is exported" | The previous handoff's §6.1 suggested the blanket invariant | There are 33 `ddb` keys and 25 exports; `extensionsRegistry`, `extensionSubnetPool`, `hookIdempotency` and `spawnLedger` are deliberate non-exports, so the blanket form is red for four unrelated tables. Owner decision, not re-litigated here. |
| Export `TABLE_WARROOM_CONNECTIONS` even though no `src/` module reads it | Export only the two the app reads | Owner decision. It answers the previous §6.3 question; an unused env var is harmless and the name is then correct for the WebSocket consumer. |
| Reuse `computeTemplateUnguarded`'s recipe rather than build a new harness | A lighter fake-stack harness | It already synthesizes a real `ComputeStack` and asserts on the orchestrator container env; a new harness would be unproven at exactly the point that matters. |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Production War Room baseline is now measured, not assumed (resolves the previous A8 caveat) | this ledger A9 | yes |
| `TABLE_WARROOM_CONNECTIONS` is read by no `src/` module; IAM grants it via `ApiGwWarroomConnections` | this ledger A11; answers previous §6.3 | yes |
| Adding a table needs the compute-stack export too | `development.md` architectural discoveries | no — still deferred to the WRT-9 fix PR, per the previous session |

### 4.5 WI-0 — live production baseline (recorded before any repository edit)

Collected 2026-09-07 by a fresh-context evidence agent against the **live**
production system. Every interaction was a read. The dashboard token was read
from Secrets Manager, used only as an `Authorization: Bearer` header, and was
never printed, echoed, logged, or written to any file.

**Identifiers, each confirmed live rather than assumed:**

| Field | Value | How confirmed |
|---|---|---|
| AWS account | `239887088812` | `aws sts get-caller-identity` |
| Region | `us-east-1` | `infra/bin/app.ts:29` default; every targeted call succeeded |
| ECS cluster | `claudeclaw-cluster` | `describe-clusters` → `ACTIVE`, 3 running tasks |
| ECS service | `claudeclaw-service` | `describe-services` → `ACTIVE`, desired 3 / running 3, single `PRIMARY` deployment, `rolloutState: COMPLETED` |
| Task definition | `arn:aws:ecs:us-east-1:239887088812:task-definition/claudeclaw-orchestrator:13` | read from the live service's `taskDefinition` field, not guessed |
| Container inspected | `orchestrator` (86 env vars; siblings are `xray-daemon`, `cloudflared`) | `compute-stack.ts:316` `containerName: 'orchestrator'` |
| Public host | `app.pgnos.ai` | `public-dashboard-access.ts:83` `PUBLIC_DEFAULT_HOSTNAME`, and the live container's `CCE_DASHBOARD_URL = https://app.pgnos.ai` |
| Token source | `/claudeclaw/dashboard`, field `token` (ARN suffix `-W62oU8`) | the container's `CCE_SECRET_DASHBOARD_ARN` is this exact ARN; `DASHBOARD_TOKEN` is in the container's ECS `secrets` list, not plaintext |

**The four probes. These status codes are the invariance reference.**

| # | Request | Status | Body shape |
|---|---|---|---|
| 1 | `GET /api/warroom` (authenticated) | **200** | JSON object, `meetings` array, 5 items |
| 2 | `GET /api/warroom/dd6392bb-1df6-4781-a08b-fa1378377eaf/history` (authenticated) | **200** | JSON object, `turns` array, 35 items |
| 3 | `GET /api/warroom/00000000-0000-0000-0000-000000000000/history` (authenticated) | **404** | `{"error":"not found"}` |
| 4 | `GET /api/warroom` (no token) | **401** | `{"error":"unauthorized"}` |

Room id used for probe 2 was taken from probe 1's first meeting. No meeting
content is reproduced here.

**Live production task-definition values, orchestrator container:**

```text
TABLE_WARROOM_MEETINGS    = ABSENT
TABLE_WARROOM_TURNS       = ABSENT
TABLE_WARROOM_CONNECTIONS = ABSENT
```

`ABSENT` is the measured result, not a placeholder. The container carries
exactly **25** `TABLE_*` keys and none of them is a War Room table:

`TABLE_QUEUE_LEASE`, `TABLE_RATE_LIMITS`, `TABLE_JARVIS_LEDGER`,
`TABLE_CHAT_CONFIG`, `TABLE_RUNTIME_CONFIG`, `TABLE_MISSION_TASKS`,
`TABLE_AGENTS`, `TABLE_CONSOLIDATIONS`, `TABLE_JARVIS_LEASES`,
`TABLE_DASHBOARD_TOKENS`, `TABLE_AUDIT_LOG`, `TABLE_USERS`,
`TABLE_JARVIS_TICKETS`, `TABLE_JARVIS_CANARY`, `TABLE_MEMORIES`,
`TABLE_COMPACTION_EVENTS`, `TABLE_SPEND_LEDGER`, `TABLE_AGENT_FILE_HISTORY`,
`TABLE_IDENTITIES`, `TABLE_HIVE_MIND`, `TABLE_SCHEDULED_TASKS`,
`TABLE_SESSIONS`, `TABLE_KILL_SWITCHES`, `TABLE_INTER_AGENT_TASKS`,
`TABLE_TOKEN_USAGE`.

That set matches `compute-stack.ts:395-421` on `origin/development` key-for-key,
which is the first direct confirmation that M12's diagnosis holds at the
**deployed production** layer and not only in source.

Production is healthy on these probes only because its `${app}` prefix is
`claudeclaw`, which equals the code's hard-coded fallbacks. The coupling is
real and fragile; that is what WRT-9 removes.

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
| P10 | Never let a production credential reach a command whose output is copied into a document. Pass it via an environment variable used only as a request header. | Added 2026-09-07 for the WI-0 probes. The baseline in §4.5 was collected under this rule; no token value exists in this repository or in any session log. |

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
| M14 | Under the Git Bash tool, `aws secretsmanager describe-secret --secret-id /claudeclaw/dashboard` failed with `Invalid name`. | Looked like a missing or misnamed secret; nearly recorded as a WI-0 blocker. | MSYS path conversion rewrites the leading `/` into a Windows path. Re-ran the same call from PowerShell and it succeeded. | An AWS identifier beginning with `/` needs PowerShell or `MSYS_NO_PATHCONV=1` here. A path-mangling error is not evidence about the resource. |

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
| A9 | Production War Room answers `200 / 200 / 404 / 401` for list, history, unknown id and no-token respectively, on task definition `claudeclaw-orchestrator:13`. | **Measured live 2026-09-07** against `app.pgnos.ai` (§4.5). This supersedes A8's "not yet verified by a request against production" caveat. Any later probe differing from these four codes is a legal failure, not a flake to be explained away. |
| A10 | The deployed production orchestrator carries 25 `TABLE_*` keys and none of the three War Room ones. | Measured live 2026-09-07 from task definition revision 13 (§4.5). Confirms M12 at the deployed layer, not only in source. Re-read the ACTIVE revision rather than reusing `13` in a later session. |
| A11 | No module under `src/` reads `TABLE_WARROOM_CONNECTIONS`; the connections table is reached through the API Gateway WebSocket path, which IAM grants separately as `ApiGwWarroomConnections`. | Verified by full-repository search. This answers the previous session's §6.3 open question: the variable is exported for name correctness, and its production value has no application fallback to match — its bar is the literal `claudeclaw-warroom-connections`. |

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

In `infra/lib/compute-stack.ts`, immediately after `TABLE_JARVIS_CANARY` at
`:421`, add the three entries
`TABLE_WARROOM_MEETINGS: RESOURCE_NAMES.ddb.warroomMeetings`,
`TABLE_WARROOM_TURNS: RESOURCE_NAMES.ddb.warroomTurns`,
`TABLE_WARROOM_CONNECTIONS: RESOURCE_NAMES.ddb.warroomConnections`, then run
`npx vitest run infra/lib/compute-stack.test.ts --maxWorkers=1`.

### 6.2 Immediate next steps

1. Make the red test in `infra/lib/compute-stack.test.ts` green with that
   three-line edit and nothing else.
2. Production synth invariance: hermetic `cdk synth` with `CCE_NAME_SUFFIX`
   and `DOMAIN_NAME` unset and `CCE_IMAGE_TAG` pinned identically before and
   after; the only template delta may be the three added environment entries.
3. Full `npm test` and `npm run typecheck` against the recorded baseline.
4. Promote `fix/warroom-table-env-vars → development → qa → staging`, one PR
   per rung, with `gh run list --workflow=deploy.yml` idle before the
   `qa → staging` merge.
5. On staging, against a real room with real agent replies, run the six checks
   in §6.5.
6. Re-probe production; all four status codes must equal §4.5 exactly.

### 6.3 Blockers and open questions

- [x] Question (carried from the previous session): should
      `TABLE_WARROOM_CONNECTIONS` also be exported — **resolved.** Yes, all
      three. No `src/` module reads it (A11), so its bar is the literal
      `claudeclaw-warroom-connections` rather than a match against an
      application fallback.
- [ ] Blocker: **PR [#61](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/61) cannot merge as-is.**
      `gh pr view 61` reports `mergeable: CONFLICTING`, `mergeStateStatus: DIRTY`;
      `git rev-list --count origin/production..origin/staging` is 218, and the
      last successful production deploy was run `32818421862` on
      2026-08-25T06:46:07Z. Needs: a human decision on how to reconcile 218
      commits. Explicitly out of scope for WRT-9 — do not attempt it. Posting
      the WRT-9 evidence comment on #61 still works and is still the required
      final action.
- [ ] Blocker: end-to-end export verification on staging — needs M12 fixed and
      deployed to staging.

### 6.4 Deferred, and why

- Editing `infra/lib/compute-stack.ts` — deferred by design: this session is
  the specification half of WRT-9 and stops at a proven-red test.
- Pinning `tonistiigi/binfmt` or adding a retry to the QEMU build — deferred
  because `.github/` is out of scope; recorded as M13.
- The `development.md` "adding a table needs three files" entry — still
  deferred to the WRT-9 fix PR.

### 6.5 The six staging checks

Checks 1–5 are quoted verbatim from
[`2026-09-05-scroll-and-pdf.md`](./2026-09-05-scroll-and-pdf.md) §2 and must not
be paraphrased when they are judged:

> (1) pinned while messages arrive, (2) still scrolled up after several polling
> ticks, (3) returning re-pins, (4) an empty tick never moves the view, (5) the
> PDF matches the screen with every speaker and message in order

Check 6 is the transcript PDF export end to end: download, open, and verify
every speaker and message in order against the screen. All six run against a
real room with real agent replies, with polling live, in a real browser.

## 7. Verification actually performed

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npx vitest run infra/lib/compute-stack.test.ts --maxWorkers=1` | file did not exist | see section 7.1 |
| `npm run typecheck` | not run this session | not run this session |
| `npm test` | not run this session | not run this session |
| `npm run build` | not run this session | not run this session |
| `npm --prefix web run typecheck` | not run this session | not run this session |
| `npm --prefix web run build` | not run this session | not run this session |
| `npm run local:test:integration` | not run this session | not run this session |
| `node scripts/ci/docs-links.mjs` | see section 7.1 | see section 7.1 |
| `node scripts/ci/feature-knowledge.mjs` | see section 7.1 | see section 7.1 |
| `git diff --check` | see section 7.1 | see section 7.1 |

Anything not run, and why: the full suite, typecheck and both builds are the
**implementation** session's gate, not this one's. This session deliberately
changes no product or infrastructure code, so a full-suite result here would
describe `origin/development`, not WRT-9. Per **P2**, they are recorded as not
run rather than assumed green. The implementation session must capture the
baseline itself before editing.

### 7.1 Results

Filled in at the end of this session; see the session's final commit.

## 8. Environment state

- **Tools and services**: work happens in the linked worktree
  `C:/dev/Netzer-Labs/.worktrees/warroom-scroll-pdf`, verified clean and
  unlocked before use, with `node_modules` present for both the root and
  `web/`. Git identity was unset repository-wide and was configured **locally
  in this worktree only**.
- **Active processes**: none started by this session.
- **Environment variables**: names only. The production dashboard token was
  read transiently from Secrets Manager for the §4.5 probes and never written
  anywhere; `.env.staging` in the main checkout holds the staging token for the
  later browser checks. **Never values, never secrets.**
- **Uncommitted work left in the tree**: the main checkout
  `C:/dev/Netzer-Labs` (branch `fix/knowledge-scope-fanout`) carries a large
  uncommitted tree that is not this session's, including uncommitted edits to
  `infra/lib/compute-stack.ts`. Untouched, per **P6**. That is precisely why
  this work runs in a separate worktree.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-09-06-staging-warroom-tables.md)
- [Feature knowledge framework](../../README.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
