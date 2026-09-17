---
feature: paperclip
document_role: handoff
status: current
observed_at: 2026-09-07
as_of_commit: f0c26fbd2824862399d8357d26050662e7644870
---

# Paperclip integration handoff

- **Branch:** `feat/paperclip-p1-hierarchy` (from `development` `277095e`); Phase 1 close-out; PR pending.
- **Source state:** Phase 0 merged (#156 -> `development` `0a59063`, #157 -> `qa` `ec65ca5`, #158 -> `staging` `dd16ca4`).
- **Deployment:** staging Deploy run [34021795520](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/runs/34021795520) is green. Live verdicts from the Phase 0 live critic (2026-09-06 13:15-13:50Z, staging `dd16ca4`): **P0-1 PASS** (board read live over the tunnel, `CCE_PAPERCLIP_ENABLED=1` confirmed on task definition `:19`); **P0-2 FAIL then fixed on this branch** (every adapter push rejected 400 `invalid_body` -- the pinned image sends `context.issueId`, not top-level `issueId`; Research's adapter had no `url` -- both fixed, critic PASS, live re-check pending this branch's deploy plus the bootstrap repair); **P0-3 refusal/list PASS, update confounded** by the P0-2 dispatch defect cascading into a heartbeat re-block (re-check after P0-2 deploys). Production is untouched.

## Current objective and required order

**Now (2026-09-07):** read [the Phase 1 hierarchy close-out handoff](handoffs/2026-09-07-p1-hierarchy-closeout.md); its section 6 is the ordered next-action list (Piece E, then Piece F) and section 5 the campaign ledger.

Superseding order (owner, 2026-09-05): the campaign now follows [missions-engine-plan.md](missions-engine-plan.md): P0-0 image-build timeout (own PR), Phase 0 arm and collaborate, Phase 1 hierarchy, 8.5, the board bridge on missions.staging.pgnos.ai, then 10, 11, 12. The numbered list below is the 2026-09-03 state and stays as history.

### Phase 0 status

1. P0-0 -- done, deployed (staging run 33989570600).
2. P0-1 -- **live PASS** (2026-09-06, Phase 0 live critic, staging `dd16ca4`): `GET /api/missions?owner=main` returns `{owner,count,missions[]}` from Paperclip; `POST /api/missions` 201 with a uuid id and the issue visible over the tunnel; task definition `claudeclaw-staging-orchestrator:19` carries `CCE_PAPERCLIP_ENABLED=1`.
3. P0-2 -- the same live critic found the dispatch defect (every push 400 `invalid_body`: the pinned image nests the issue id under `context.issueId`, not top-level) and the Research-adapter defect (no `url`, so Paperclip escalated Research issues to Main within ~1 s). Both are **fixed on this branch** (`fix/paperclip-p0-2-dispatch-push`): critic PASS for the dispatch-parser fix (round 2) and the bootstrap-reconcile fix (round 1); live proof waits for this branch's deploy plus an operator bootstrap run with `PAPERCLIP_DISPATCH_SLUGS=main,research`.
4. P0-3 -- **live PASS** for refusal and list (byte-identical refusal message; correct empty-board read); the update case was **confounded** by the P0-2 dispatch defect cascading into a heartbeat re-block -- re-check once P0-2 deploys.

This branch, `fix/paperclip-p0-2-dispatch-push`, lands the P0-2 dispatch-parser and bootstrap-reconcile fixes on top of the already-deployed Phase 0 work. Phase 0 is now deployed to staging (run 34021795520) and the live critic has run once end to end; the remaining work is: deploy this branch, run the bootstrap repair over the tunnel, then re-run the live critic for P0-2 and P0-3's update case. Phase 8.5, the same-origin UI/session bridge and Phases 10-12 follow Phase 0 and Phase 1 in missions-engine-plan.md. Production needs its own go-ahead.

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

## Active blockers

- The deploy of this branch (`fix/paperclip-p0-2-dispatch-push`) to staging.
- After that deploy: a fresh `aws login` (the operator session expires within about two hours of 13:10Z) to run the bootstrap repair over the tunnel with `PAPERCLIP_DISPATCH_SLUGS=main,research`, and then the live re-check for P0-2 and P0-3's update case.

## Smallest next action

Open the PR `fix/paperclip-p0-2-dispatch-push` -> `development`. Once it promotes to staging: `aws login`, run the bootstrap over the tunnel with `PAPERCLIP_DISPATCH_SLUGS=main,research` (dry-run first -- expect the plan line naming `research`), then re-run the Phase 0 live critic for P0-2 (202 in CloudWatch, a worker turn, dedupe by `(runId, issueId)`) and for P0-3's update case.

## Guardrails for the resuming agent

- Start any new work from `development` (`0a59063` or later); Phase 0 is merged; `fix/paperclip-p0-2-dispatch-push` is not.
- Preserve unrelated work and keep commits path-scoped.
- The tenant is bootstrapped; do not run the bootstrap again except the one-time reconcile run with `PAPERCLIP_DISPATCH_SLUGS=main,research` (dry-run first), then only to prove the no-op. Never use `x-forwarded-host` to work around the hostname guard — it is honoured before `Host` and would silently disable the guard.
- Never print, commit, or paste a secret value; diff secrets by field name only.
- Do not invent live payload types; capture redacted staging evidence first.
- Do not start Phase 8.5, the bridge or Phases 10-12 on this branch; they follow Phase 0 and Phase 1 in missions-engine-plan.md.
- Do not deploy production or create a release before staging is green.

## Session log index

Newest first. Every session working in this folder adds one file to `handoffs/` from the [session handoff template](../HANDOFF-TEMPLATE.md).

| Session | Date | Summary |
|---|---|---|
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

Authorities: [README](README.md), [implementation plan](implementation-plan.md), [plan audit](plan-audit.md), [bar and phases](bar-and-phases.md), [ADR 0010](../../adr/0010-paperclip-work-engine.md), and [this session's handoff](handoffs/2026-09-06-p0-2-dispatch-push-fix.md).
