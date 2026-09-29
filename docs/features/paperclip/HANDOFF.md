---
feature: paperclip
document_role: handoff
status: current
observed_at: 2026-09-29
as_of_commit: 29309c8fab1d9b37121aee7d92f0efa0bb30fbc8
---

# Paperclip integration handoff

## Current state (2026-09-29)

This section was checked on 2026-09-29 against `origin/development` `29309c8`. **Everything below it is prior state as of 2026-09-17 (`4f1a860`) and was not re-checked.**

- **Branch:** `chore/work-platform-docs` (from `origin/development` `29309c8`; merge target `development`). Docs only. **Pushed:** no. **PR:** none.
- **What it does:** records the owner-approved Work Platform plan (2026-09-26): ADRs 0012–0020, the ADR 0010 amendment and the ADR 0009 supersession, the [DO NOT BUILD list](do-not-build.md), the [decision log](decision-log.md) and the [minimum sellable product](minimum-sellable-product.md); marks the superseded pieces of [missions-engine-plan.md](missions-engine-plan.md). It decides nothing new. Session: [2026-09-29 handoff](handoffs/2026-09-29-work-platform-architecture-record.md).
- **Deployment:** none. No code changed and no AWS call was made; staging and production are untouched.
- **Other branches, pushed and untouched by this session:** `fix/paperclip-p0-0b-image-build` at `5a7af9b` (the plan folds P0-0b into step 2) and `feat/paperclip-b2-missions-board-infra` at `9fcd6a3`. B-2 belongs to the superseded board bridge; what happens to that branch is the owner's call.

**Next action:** Work Platform step 2 of 18, re-pin + runtime lock + P0-0b + feasibility spikes ([build steps](minimum-sellable-product.md#build-steps)). It includes a staging trip, so every owner gate applies: push, PR, merge, staging and any AWS call each need the owner's yes in that session. The 2026-09-17 "Smallest next action" further down is the earlier plan for the P0-0b lanes.

## State as of 2026-09-17

- **Branch:** `fix/paperclip-p0-0b-image-build` (from `development`, merged up to `271339b`); P0-0b image-build repair; no PR. **Pushed:** not yet at the time of writing; the coordinator pushes this branch to origin under the same name immediately after the 2026-09-17 commit as an owner-approved backup (no PR, no merge, no deploy) - confirm with `git ls-remote origin refs/heads/fix/paperclip-p0-0b-image-build`.
- **Source state:** Phase 0 merged (#156 -> `development` `0a59063`, #157 -> `qa` `ec65ca5`, #158 -> `staging` `dd16ca4`). **Phase 1 also merged and deployed** (#162 -> `development`, #163 -> `qa`, #164 -> `staging` `4442d86`); `origin/development` is now `271339b` after the War Room table fix (#165).
- **Deployment:** staging Deploy run [34021795520](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/runs/34021795520) is green. Live verdicts from the Phase 0 live critic (2026-09-06 13:15-13:50Z, staging `dd16ca4`): **P0-1 PASS** (board read live over the tunnel, `CCE_PAPERCLIP_ENABLED=1` confirmed on task definition `:19`); **P0-2 FAIL then fixed on this branch** (every adapter push rejected 400 `invalid_body` -- the pinned image sends `context.issueId`, not top-level `issueId`; Research's adapter had no `url` -- both fixed, critic PASS, live re-check pending this branch's deploy plus the bootstrap repair); **P0-3 refusal/list PASS, update confounded** by the P0-2 dispatch defect cascading into a heartbeat re-block (re-check after P0-2 deploys). Production is untouched.

## Objective and required order (2026-09-17)

**Then (2026-09-17):** development is moving to a new machine. Read [the 2026-09-17 machine-transfer handoff](handoffs/2026-09-17-machine-transfer.md) first, then [the 2026-09-15 handoff](handoffs/2026-09-15-p0-0b-validate-and-ship.md) with its correction in mind (ledger M74). That correction: on 2026-09-15 the plan in force (`gauntlet-mode-direct-coordinator-gauntle-agile-hamster.md`) ran STEP 1. Lanes 1.1 (image gate 3/3), 1.2 (text tests 11/11) and 1.3 (red-first, 5 expected failures) passed. Lane 1.4 (the no-cache build-stage build) failed at `exporting to image` with a containerd input/output error because `C:` reached 0 bytes free, after its install step had logged `added 5 packages`. Lanes 1.5 and 1.6 never ran, and STEPS 3-7 never started. There is no P0-0b PR and no staging deploy. Phase 1 is shipped; what remains is Phase 0's three open items, and two of the three were mis-recorded until the 2026-09-08 session measured them. [The Phase 0 completion handoff](handoffs/2026-09-08-p0-completion-and-workflows-direction.md)'s section 6 is still the ordered next-action list. The campaign ledger (section 5) is carried forward, with the 2026-09-17 additions, in the machine-transfer handoff.

**Three corrections that change what the next session should do:**

1. **P0-0b's committed fix could not work, and the image proved it.** All three compile packages are `devDependencies`, so under `--omit=dev` npm inferred a dev edge for each and reified none: the install reported `up to date in 3s` having added none of the three packages named on its own command line, and `npx tsc` then fetched the unrelated registry stub `tsc@2.0.4`. Repaired on this branch (isolated install prefix + `node node_modules/typescript/bin/tsc`), with a real image gate.
2. **A61's "report a run disposition" fix is struck.** Measured against the live service: `disposition`, `complete`, `completion`, `succeed` and `result` match **no** path. The only run-lifecycle writes are `POST /api/heartbeat-runs/{runId}/cancel` and `/watchdog-decisions`, and the latter is a watchdog control (`snooze` / `continue` / `dismissed_false_positive`). There is no channel to report a run's outcome; the issue-level claim must carry A61 alone.
3. **A62 is struck: the recorded cause is false.** `createdByAgentId` is null on 0 of 18 live rows, all three research-board rows read `createdByAgent=main` through our own ACL, and `slugForUuid` throws rather than returning `'paperclip'`. The real P0-3 failure is that **Paperclip refuses the write**: our ACL authorises a cross-board update, then `PATCH /api/issues/{id}` returns 403 because every write goes out with the acting agent's key and Paperclip scopes writes to the assignee.

Superseding order (owner, 2026-09-05): the campaign now follows [missions-engine-plan.md](missions-engine-plan.md): P0-0 image-build timeout (own PR), Phase 0 arm and collaborate, Phase 1 hierarchy, 8.5, the board bridge on missions.staging.pgnos.ai, then 10, 11, 12. The numbered list below is the 2026-09-03 state and stays as history.

### Phase 0 status

1. P0-0 -- done, deployed (staging run 33989570600).
2. P0-1 -- **live PASS** (2026-09-06, Phase 0 live critic, staging `dd16ca4`): `GET /api/missions?owner=main` returns `{owner,count,missions[]}` from Paperclip; `POST /api/missions` 201 with a uuid id and the issue visible over the tunnel; task definition `claudeclaw-staging-orchestrator:19` carries `CCE_PAPERCLIP_ENABLED=1`.
3. P0-2 -- the same live critic found the dispatch defect (every push 400 `invalid_body`: the pinned image nests the issue id under `context.issueId`, not top-level) and the Research-adapter defect (no `url`, so Paperclip escalated Research issues to Main within ~1 s). Both are **fixed on this branch** (`fix/paperclip-p0-2-dispatch-push`): critic PASS for the dispatch-parser fix (round 2) and the bootstrap-reconcile fix (round 1); live proof waits for this branch's deploy plus an operator bootstrap run with `PAPERCLIP_DISPATCH_SLUGS=main,research`.
4. P0-3 -- **live PASS** for refusal and list (byte-identical refusal message; correct empty-board read); the update case was **confounded** by the P0-2 dispatch defect cascading into a heartbeat re-block -- re-check once P0-2 deploys.

#### What is actually left (measured 2026-09-07/08, re-checked 2026-09-15)

| item | state |
|---|---|
| **P0-0b** image build | **code done** on this branch. On 2026-09-15: image gate 3/3, text tests 11/11, and red-first 5 of 11 failing as designed. The no-cache build-stage build failed at export on a full disk, which is an infrastructure failure, not the fix. Owes: the build-stage build, full-image build, arm64 lane, full suite in both flag states, and the ladder, all on the new machine (2026-09-17 handoff, section 6). |
| **P0-2c / A61** dispatch disposition loop | characterisation **done**; fix 3 **struck** (no disposition route exists). The issue-level in-flight claim is unwritten and is now the whole fix. |
| **P0-3b / A62** | **struck.** Provenance is correct; the real refusal is Paperclip's own authorisation boundary. Owner ruled: execute as the owner. **May become unnecessary** under the Workflows direction -- ask before building. |

**P0-3's live acceptance is unachievable as written.** `client.ts` sends every write with the acting agent's key and `config.ts` records `reconcilerKey`/`dispatchSecret` as deliberately absent, while Paperclip scopes issue writes to the assignee. Owner ruling (2026-09-07): Netzar's ACL stays the authority on *who may act*; once it authorises, the write is sent with the **assignee's** key so Paperclip accepts it, and the audit row must then record actor-vs-executor.

**Production is untouched and Paperclip has never run there.** `claudeclaw-orchestrator:13` is both running and latest ACTIVE and carries no `CCE_PAPERCLIP_ENABLED`; `claudeclaw-mission-tasks` holds 8 rows, all legacy `MISSION#`, zero `PROVENANCE#`. Query ECS container env **by name** -- index 0 is `cloudflared`, 1 is `xray-daemon`, so an index-based query returns a false empty.

**Direction (owner, 2026-09-07): "Workflows".** Keep all of Paperclip's features and surface them in Netzar under a tab named **Workflows**, restyled to our palette, rather than reimplementing them. Paperclip serves a full SPA and ships white-labelling (`/api/companies/{cid}/branding`, `/logo`, and a `PAPERCLIP_RUNTIME_BRANDING_START` slot in the app shell), so restyling is configuration, not code. `workflow*` appears zero times in Paperclip's 475 routes and nowhere in the Netzar SPA, so the name is free on both sides; Paperclip's own `project` (a dated milestone and a credential/billing boundary) stays internal and never becomes our noun. The repeatable-run primitive is Paperclip's **routine**. Ownership split: Paperclip owns the surface and the work model, Netzar owns the agents, Bedrock spend, kill switches, audit and seats. **Do not rename the agent tools** -- `tool-policy.ts` blocks `create_mission` by raw string with zero test coverage, so renaming fails open silently.

Phase 8.5, the same-origin UI/session bridge and Phases 10-12 follow Phase 0 in missions-engine-plan.md. Production needs its own go-ahead.

### History (2026-09-03)

Was (scope decision, user, 2026-09-02): this branch lands the staging contract probe only. Phase 8.5, the same-origin UI/session bridge and Phases 10-12 move to a separate plan after it lands, in the README's order (probe → 8.5 → bridge → 10 → 11 → 12). Production needs its own go-ahead.

1. Done — cuts committed and pushed; PR #133 merged (`d8c6f7e`).
2. Done 2026-09-03 — one-time staging tenant bootstrap: invite via ECS Exec, SSM port-forward, `--dry-run`, real run (company `Netzar OS` prefix `NZR`, agents `main`/`research`, keys `netzar-reconciler`/`netzar-agent-main`/`netzar-agent-research`, one new secret version), no-op re-run (`agents created 0, reused 2; keys created 0, reused 3`), independently re-verified by a fresh-context critic (prior fields byte-identical by hash).
3. Done — PR #134 `development` → `qa` (`345f238`).
4. Done, red — PR #138 `qa` → `staging` (`fd04227`); run 33733071639 attempt 4 deployed and the probe ran live and was refused with HTTP 403 (see Deployment and Active blockers).
5. Done, red — `PAPERCLIP_ALLOWED_HOSTNAMES` shipped (#139 → #140 → #141); run 33773788920 deployed it and the probe's fetch got no response (attempts 1 and 2).
6. Done, green — `PAPERCLIP_BIND=lan` shipped (#142 → #143 → #144); run 33783021194 matched the bar job for job, the probe passed with all eight markers, the smoke test passed.
7. Done — final handoff pass (this branch).
8. Was: `aws login`, then the stream-level redaction greps against the green run (the Actions-log greps are done: 0 hits for the company id and for token-shaped strings). Then the follow-on plan in the README's order: Phase 8.5 from the shapes captured in the README, the UI/session bridge, Phases 10-12.
6. Final handoff pass with the green run id and the eight observed shapes.

Was (2026-09-03): then, separately and in order: Phase 8.5 from the observed contracts, the UI/session bridge, Phases 10-12, production, release.

## What was in the 2026-09-03 diff

Kept from Codex, audited correct: the three staging-only IAM statements (`RunTask`/`DescribeTasks` with the `ecs:cluster` condition, `PassRole`, log read) and their literal-string tests; the post-rollout, pre-smoke workflow step (describe-services network config, command-only override, bounded 12 × 10 s `filter-log-events`, every marker required, fails on the failure marker or a nonzero exit); the marker pin in the image-pipeline test; `writeIfAbsent` Better Auth minting iff absent or `REPLACE_ME`; the `company_id` write-back; the README section 6 per-install secret bullet and the ADR 0010 2026-09-01 amendment.

Cut in the 2026-09-02/03 session; each cut passed a fresh-context critic that verified by execution:

- Probe: the uncommitted `<field-N>` key numbering is reverted to `safeShapeKey` (UUID keys become `<uuid-key>`, real field names stay — the schema evidence Phase 8.5 needs); the media-type normalization (`application/json` / `image/svg+xml` / `other`) and its test stay; the dead `+json` branch is gone.
- Bootstrap: `bootstrap-secret.ts` 130 → 96 lines (dead `dryRun`/`warn`/`errorName`/`writeBootstrapSecretFields`); source-text tests replaced by seven behavioural ones; `--dry-run` is now an unauthenticated `GET /api/health`, a fail-closed secret read, field names printed as set/`REPLACE_ME`, a plan echo, then return — no POST, no write; the `dispatch_secret` checkpoint (a second `PutSecretValue`) is removed so one bootstrap writes one Secrets Manager version; dead post-return dry-run branches and `reconcileKey`'s always-false `dryRun` parameter are deleted.
- Task-definition injection of `PAPERCLIP_DISPATCH_URL` / `CCE_PAPERCLIP_ADMIN_EMAIL` removed with every ripple (`compute-stack.ts`, `scripts/deploy.ts`, `manifest.ts`, `src/config/env.ts`, `docs/deprecations.json`, the two `deploy.yml` synth steps, the vars-presence test, `rollback-classes.md` back to `origin/development`, four drift notes, the `.env.example` sentence). Both names are read only by `scripts/paperclip-bootstrap.ts`; nothing live has them, so there is no drift.

The 2026-09-05 session added its own 12-file uncommitted Phase 0 diff on top (later merged as `#156`): the 5 P0-3 source/test files (`mission-acl.ts`, `mission-acl.test.ts`, `format.ts`, `mission-tools.ts`, `mission-tools.authz.test.ts`), 3 test-mock fixes (`handler.command-scope.test.ts` in `src/adapters/telegram/` and `src/adapters/slack/`, `mission-assignment-push.test.ts`), and 4 docs (that session's handoff, `HANDOFF.md`, `README.md`, `docs/adr/0009-mission-container-model.md`). Full detail in [that session's handoff, section 4.2](handoffs/2026-09-05-goal-first-missions-engine.md#42-files-modified). This session (2026-09-06) landed its own five-file source diff plus the fixture, tests and five docs; see [this session's handoff, section 4.2](handoffs/2026-09-06-p0-2-dispatch-push-fix.md#42-files-modified).

## Authentication model

Per-install Better Auth secret; recorded in the [README](README.md) section 6 and ADR 0010's 2026-09-01 amendment. Staging's `better_auth_secret` was set on 2026-09-02 (AWSCURRENT 2026-09-02T10:28:29-04:00, two versions); the Paperclip service restarted HEALTHY on task definition `:2` at 10:31:50-04:00.

## Phase status

- Base integration: deployed and healthy in staging (run 33067242593).
- Staging contract probe: **green** in run 33783021194 with all eight markers. Its first two live runs each found a real defect that would have broken the ACL and the reconciler the moment `CCE_PAPERCLIP_ENABLED` flipped: Paperclip's private-hostname guard refused the orchestrator's Cloud Map hostname (fixed by `PAPERCLIP_ALLOWED_HOSTNAMES`, #139), and a re-booted Paperclip task shrank to a loopback listener because the EFS `config.json` says `server.bind: loopback` (fixed by `PAPERCLIP_BIND=lan`, #142). Both variables are on the Paperclip service task definition and pinned by literal tests.
- Phase 8.5: not implemented; follows Phase 0 and Phase 1 in the superseding order (owner, 2026-09-05); still gated on the live `/org` and goals shapes in README section 6.
- Same-origin UI/session bridge (bar-and-phases Part F): does not exist; deferred to the same plan.
- Phases 10-12: not implemented; deferred behind the bridge.
- Production/release: untouched; needs a separate go-ahead.
- Missions authorization: any agent may list any board; an agent may mutate a mission it owns or created (owner-or-creator, `boardSelf`/`canReadBoard`/`canMutateMission`); live PASS for refusal/list, update confounded by the P0-2 dispatch defect (2026-09-06 live critic).
- Dispatch push: fixed on `fix/paperclip-p0-2-dispatch-push` (parser accepts `context.issueId`; bootstrap reconciles a reused agent's adapter config on drift via `PAPERCLIP_DISPATCH_SLUGS`); critic PASS; live re-check pending this branch's deploy and the operator bootstrap run.

## Last commands actually run

This session (2026-09-06), branch `fix/paperclip-p0-2-dispatch-push`, HEAD `68db92f`, git status clean. Full validation run serially from the worktree root, nothing edited by the runner:

- `git log --oneline -4 && git status --short` -- exit 0; HEAD `68db92f` (`docs(paperclip): the adapter push shape is measured, not unverified`), clean tree.
- `npm run typecheck` -- exit 0, no errors.
- `npm test -- --minWorkers=1 --maxWorkers=1` -- exit 1; 242 files: 236 passed, 5 failed, 1 skipped; 3046 tests: 3039 passed, 1 failed, 6 skipped. Failing files are exactly the A52 five-file Windows baseline: `scripts/ci/docs-links.test.ts`, `scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`, `scripts/release/sync-deprecations.test.ts`, `scripts/lib/lifecycle/rollback-classes.test.ts`. `jarvis.flow.test.ts` did not fail this run (no flake observed).
- `CCE_PAPERCLIP_ENABLED=1 npm test -- --minWorkers=1 --maxWorkers=1` -- exit 1; identical shape (236/5/1 files, 3039/1/6 tests), same five A52 files, no new failures under the flag.
- `npm run build` -- exit 0.
- `npm --prefix web run typecheck` -- exit 0.
- `npm --prefix web run build` -- exit 0 (vite build, 1760 modules, 4.61 s).
- `docker info` -- exit 0 (Docker Desktop reachable; recorded as a precondition check only).
- `npm run local:test:integration` -- NOT RUN: no `.env` in the worktree.
- **2026-09-07 (this session, `feat/paperclip-p1-hierarchy` `f0c26fb`):** `npm run local:test:integration` RAN and FAILED, exit 9, `node: .env: not found` (still no `.env` in the worktree). Docker Desktop, reachable at the start of this session, later reported "Docker Desktop is unable to start" -- a separate, later fact that does not change the recorded cause above, since the missing `.env` is checked before any Docker/Floci call.
- `node scripts/ci/docs-links.mjs` -- exit 0; 131 markdown files, 1547 internal links checked, 71 external skipped; OK (validation ran at `68db92f`, before this docs pass).
- `node scripts/ci/feature-knowledge.mjs` -- exit 0; OK.
- `node scripts/ci/docs-links.mjs` (docs-pass re-run) -- exit 0; 132 markdown files, 1576 internal links checked, 70 external skipped; OK.
- `node scripts/ci/feature-knowledge.mjs` (docs-pass re-run) -- exit 0; OK.
- `git diff --check` -- exit 0, no whitespace errors.
- `node scripts/ci/diagrams-drift.mjs` -- exit 0; 8 mapped diagrams, valid paths; no `GITHUB_BASE_REF`, so path-validation only (inert locally).
- `grep -n "dispatch\|bootstrap\|paperclip" docs/diagrams.map` -- exit 0; matches only `infra/lib/paperclip-stack.ts` and `scripts/lib/lifecycle/bootstrap-state.ts` (pre-existing, unrelated); this branch's five changed files (`dispatch-worker.ts`, `paperclip-dispatch.ts`, `bootstrap-core.ts`, `paperclip-bootstrap.ts`, `types.ts`) are UNMAPPED in `docs/diagrams.map` -- recorded, no diagram flagged.

Phase 0 live critic (2026-09-06 13:15-13:50Z, staging `dd16ca4`, run 34021795520; Fable live + Fable refuter, refuter PASS): tunnel opened via ECS Exec/SSM; `GET /api/missions?owner=main` and `POST /api/missions` both PASS (P0-1); `GET /api/companies/{cid}/agents` showed Research's `adapterConfig` missing `url` (P0-2 defect 1); repeated pushes to the orchestrator all logged 400 `invalid_body` in CloudWatch (P0-2 defect 2); `POST /agents/:id/wakeup` 202 for a self-wake, 403 `Agent can only invoke itself` cross-agent; five dashboard test-turns exercised the list/refuse/update mission-ACL paths (P0-3); `tool_invoke` audit scanned and found no rows for mission tools (expected, P49); cleanup cancelled six characterization missions, left `enabled_agents` at `["main","research"]`, closed the tunnel.

- **2026-09-15 (this session, `fix/paperclip-p0-0b-image-build` `4f1a860`):** `ORCHESTRATOR_IMAGE_BUILD_TEST=1 npx vitest run --config vitest.integration.config.ts scripts/lib/lifecycle/orchestrator-dockerfile.build.integration.test.ts` -- exit 0, 3/3 pass, 47 s (FACT 8: the build stage builds, TypeScript resolves inside the stage at the lockfile version, and `dist/index.js` is emitted). Then `df -h` / PowerShell `Get-PSDrive` -- host `C:` found at 0 bytes free, confirmed by a direct ~60 KB Node write failing `ENOSPC`. No image build, `npm test`, or deploy command was run this session; free space was at about 2.7 GB when the session closed, not yet proven sufficient for the full amd64+arm64 build.
- **2026-09-17 (machine transfer, `fix/paperclip-p0-0b-image-build` `4f1a860`):** docs only. The 2026-09-15 bullet above understates that session. Its evidence folder (devkit `archive/scratch/968da171/evidence/`) shows that lanes 1.2 (11/11), 1.3 (5 expected failures, Dockerfile restored) and 1.4 also ran. Lane 1.4 was `docker buildx build --platform linux/amd64 --target build --no-cache --load -t p0-0b:build --progress=plain .`, which exited 1 at `exporting to image` with a containerd input/output error on a full disk, after `added 5 packages in 5s` (ledger M74). On 2026-09-16 Docker Desktop's engine answered `docker system df` with HTTP 500 (ledger A65). This session ran only the two docs gates, git/gh reads and byte-copy checks.

## Active blockers

- This host cannot run the remaining image lanes. `C:` had 2.6-3.0 GB free on 2026-09-17, and Docker Desktop's engine has answered HTTP 500 since 2026-09-16 (ledger P57 and A65 in [the 2026-09-17 machine-transfer handoff](handoffs/2026-09-17-machine-transfer.md)). The work resumes on a new machine with at least 10 GB free and a healthy Docker.
- After that: lanes 1.1-1.6, the full suite in both flag states, and the PR ladder for `fix/paperclip-p0-0b-image-build` -> `development` (agile-hamster STEPS 1-4; 2026-09-08 handoff, section 6, item 1). The owner-approved backup push is not a ladder rung (ledger P58): open no PR from it until STEPS 1-3 pass on the proposed tip.

## Smallest next action (2026-09-17)

On the new machine, run agile-hamster STEP 0 preflight:

1. Make a fresh clone of origin, with a worktree of `fix/paperclip-p0-0b-image-build` at its pushed tip (the 2026-09-17 docs commit, parent `4f1a860`).
2. Re-check `git log -1 origin/development`, `gh run list --workflow deploy.yml --branch staging -L 3`, and the open PRs to qa and staging.
3. Confirm the tree is clean.
4. Start Docker, and require `docker info` and `docker system df` to answer, with at least 10 GB free.

Then run STEP 1 from lane 1.1: re-prove 1.1-1.3 there, then 1.4 -> 1.5 -> 1.6. STEP 2 reuses the committed docs instead of regenerating them. On Apple Silicon, arm64 builds natively and amd64 under emulation, so record which host ran each lane. See [the 2026-09-17 machine-transfer handoff](handoffs/2026-09-17-machine-transfer.md), section 6.

## Guardrails for the resuming agent

- Start any new work from `development` (`0a59063` or later); Phase 0 is merged; `fix/paperclip-p0-2-dispatch-push` is not.
- Preserve unrelated work and keep commits path-scoped.
- The tenant is bootstrapped; do not run the bootstrap again except the one-time reconcile run with `PAPERCLIP_DISPATCH_SLUGS=main,research` (dry-run first), then only to prove the no-op. Never use `x-forwarded-host` to work around the hostname guard — it is honoured before `Host` and would silently disable the guard.
- Never print, commit, or paste a secret value; diff secrets by field name only.
- Do not invent live payload types; capture redacted staging evidence first.
- Do not start Phase 8.5, the bridge or Phases 10-12 on this branch; they follow Phase 0 and Phase 1 in missions-engine-plan.md.
- Do not deploy production or create a release before staging is green.
- Check free disk space with a realistic-sized probe (or `df`/`Get-PSDrive` directly), not a trivial write, before starting an image build on this host — it reached 0 bytes free on 2026-09-15.

## Session log index

Newest first. Every session working in this folder adds one file to `handoffs/` from the [session handoff template](../HANDOFF-TEMPLATE.md).

| Session | Date | Summary |
|---|---|---|
| [Work Platform architecture record](handoffs/2026-09-29-work-platform-architecture-record.md) | 2026-09-29 | Recorded the owner-approved Work Platform plan as ADRs 0012–0020, an ADR 0010 amendment, the ADR 0009 supersession, the DO NOT BUILD list, the decision log and the minimum sellable product; marked the superseded pieces of the missions engine plan. Docs only; nothing built or deployed |
| [Machine transfer](handoffs/2026-09-17-machine-transfer.md) | 2026-09-17 | Landed the 2026-09-15 drafts byte-exact from a temp scratchpad. Corrected that record: lanes 1.1-1.3 passed, 1.4 failed at export on a full disk, 1.5-1.6 never ran. Recorded the Docker engine damage and the owner-approved backup push, plus a path map and resume prompt for the new machine. Nothing built or deployed |
| [B-2 machine transfer](handoffs/2026-09-17-b2-machine-transfer.md) | 2026-09-17 | Parked bridge piece B-2 (missions board at missions.staging.pgnos.ai) behind Phase 0; its RED test e5168f9 and this log live on `feat/paperclip-b2-missions-board-infra`. Nothing built or deployed |
| [P0-0b ship attempt, interrupted by a full disk](handoffs/2026-09-15-p0-0b-validate-and-ship.md) | 2026-09-15 | Reconfirmed the build-stage integration test (3/3, FACT 8); found the host disk at 0 bytes free before any image build ran; corrected a ten-ID collision in the section 5 ledger; nothing pushed, built, or deployed |
| [Phase 0 completion and Workflows direction](handoffs/2026-09-08-p0-completion-and-workflows-direction.md) | 2026-09-08 | P0-0b repaired and gated (3/3 image-build integration test); A61 struck (no disposition route exists); A62 struck (`slugForUuid` throws; real cause is Paperclip's own 403); recorded the owner's "Workflows" surfacing direction |
| [Phase 1 hierarchy close-out](handoffs/2026-09-07-p1-hierarchy-closeout.md) | 2026-09-07 | Confirmed the rebase reconcile was a no-op; closed the one coverage gap (`missions-hierarchy.test.ts`, 31 tests); ran the full step-7 validation in both flag states on `f0c26fb` (typecheck/build/both docs gates/`git diff --check` exit 0; both suites exit 1 on exactly the five A52 Windows-baseline files and nothing else, in both states; integration RAN, exit 9: no `.env`); nothing pushed or deployed |
| [P0/P1 state and the 8.5 + bridge brief](handoffs/2026-09-06-p0-p1-state-and-8-5-bridge-handoff.md) | 2026-09-06 | Phase 0 live results (dispatch turns run; disposition loop and cross-board provenance open), Phase 1 code-complete on feat/paperclip-p1-hierarchy, P0-0b built; paste-ready brief for Phase 8.5 and the bridge |
| [P0-2 dispatch-push fix](handoffs/2026-09-06-p0-2-dispatch-push-fix.md) | 2026-09-06 | Phase 0 live critic found the dispatch push 400ing and Research's adapter missing a url; both fixed on this branch; also characterized the issue-hierarchy/blocking wire shapes (P1-1) |
| [Goal-first missions engine](handoffs/2026-09-05-goal-first-missions-engine.md) | 2026-09-05 | Runs the approved missions-engine plan as a per-piece gauntlet: P0-0 image-build timeout first, then arm staging, the collaboration predicate, hierarchy, 8.5, the board bridge, 10-12 |
| [Staging probe green and two findings](handoffs/2026-09-03-staging-probe-green-and-two-findings.md) | 2026-09-03 | Diagnosed and fixed the two defects the probe found live (hostname guard, loopback listener), took staging green at 47a69db in run 33783021194, verified it against the bar, closed the docs; records the follow-on gauntlet prompt |
| [Staging probe cut and deploy](handoffs/2026-09-02-staging-probe-cut-and-deploy.md) | 2026-09-02 → 2026-09-03 | Cut Codex's over-build, bootstrapped the staging tenant, promoted through the ladder; the probe's first two live runs found the hostname guard and the loopback listener; run 33783021194 green with all eight markers |
| [Staging readiness and auth model](handoffs/2026-09-01-staging-readiness-and-auth-model.md) | 2026-09-01 | Records the live-probe blocker, per-install secret model, validation, and exact next action |
| [Staging deploy gate](handoffs/2026-08-25-staging-deploy-gate.md) | 2026-08-25 | Historical, imported 2026-09-17 from the never-committed `fix/paperclip-staging-test-gate` worktree (`as_of_commit` corrected on import): staging had never deployed with Paperclip because the deploy run died at `Typecheck + Unit Tests` on six Tier 0 assertions |
| [Completion audit](handoffs/2026-08-24-paperclip-completion-audit.md) | 2026-08-24 | Closed/committed Phase 8 and recorded the interrupted Phase 9 state |
| [Phase 8 and 9](handoffs/2026-08-22-paperclip-phase-8-and-9.md) | 2026-08-22 | Recorded Phase 8/9 verification and the mixed worktree |
| [Phase 5 reconciler](handoffs/2026-08-21-phase-5-reconciler.md) | 2026-08-21 | Built the observing reconciler |
| [Phases 2 through 9](handoffs/2026-08-21-paperclip-phases-2-to-9.md) | 2026-08-21 | Continued phase gauntlets |
| [Paperclip end to end](handoffs/2026-08-21-paperclip-end-to-end.md) | 2026-08-21 | Established the end-to-end bar |
| [Phase 2 readiness](handoffs/2026-08-20-phase-2-readiness.md) | 2026-08-20 | Verified prerequisites and ARM64 artifact condition |
| [Image pipeline and Phase 2](handoffs/2026-08-20-image-pipeline-and-phase-2.md) | 2026-08-20 | Recorded image-pipeline and client work |
| [Phase 1 ponytail audit](handoffs/2026-08-19-phase-1-ponytail-audit.md) | 2026-08-19 | Found incomplete feature-flag propagation |
| [OIDC and staging](handoffs/2026-08-19-org-transfer-oidc-and-staging-deploy.md) | 2026-08-19 | Diagnosed org-transfer OIDC deployment failure |
| [Documentation consolidation](handoffs/2026-08-19-docs-consolidation.md) | 2026-08-19 | Brought plan and audit into the repository |
| [updatedSince patch and Phase 0](handoffs/2026-08-18-updated-since-patch-and-phase-0.md) | 2026-08-18 | Added the approved artifact patch and ADR |
| [Codex review](handoffs/2026-08-18-codex-review.md) | 2026-08-18 | Established the original release-contract finding |

Authorities: [README](README.md), [implementation plan](implementation-plan.md), [plan audit](plan-audit.md), [bar and phases](bar-and-phases.md), [ADR 0010](../../adr/0010-paperclip-work-engine.md), the [Work Platform record](minimum-sellable-product.md) with its [DO NOT BUILD list](do-not-build.md) and [decision log](decision-log.md), and [the newest session handoff](handoffs/2026-09-29-work-platform-architecture-record.md).
