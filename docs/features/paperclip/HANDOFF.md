---
feature: paperclip
document_role: handoff
status: current
observed_at: 2026-09-05
as_of_commit: fc2968a7b9f96e4f19ab8e46adc29c604914e601
---

# Paperclip integration handoff

- **Branch:** `docs/paperclip-staging-probe-green` (from `development` `53dfc2a`, documentation only); next merge target `development`. `codex/paperclip-phases-8-5-12`, `fix/paperclip-allowed-hostnames` and `fix/paperclip-bind-lan` are merged and finished.
- **Source state:** everything is merged. Cuts: [PR #133](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/133) → `development` `d8c6f7e`, #134 → `qa` `345f238`, #138 → `staging` `fd04227`. First probe finding: [#139](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/139) (`PAPERCLIP_ALLOWED_HOSTNAMES`) → `65f5f29`, #140 → `fc7ec05`, #141 → `3a6e040`. Second probe finding: [#142](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/142) (`PAPERCLIP_BIND=lan`) → `53dfc2a`, #143 → `db65ef9`, #144 → `47a69db`. Every rung was green before merging (9/9, 19/19, 20/20). This branch carries only this closing documentation.
- **Deployment:** staging Deploy run [33783021194](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/runs/33783021194) at `47a69db` is **green** and is the new bar: the same three jobs and the same deploy-job steps as run 33067242593 plus exactly one added step, `Characterize Paperclip org and goals contracts` (68 s), which ran the probe as a one-shot task from the live orchestrator task definition and found all eight markers in CloudWatch (`org` 200, `whoami` 200, `goals-list` 200, `org-svg` 200 `image/svg+xml`, `goal-create` 201, `goal-get`/`goal-update`/`goal-delete` 200); the smoke test then passed. The two earlier runs were red at that step and each surfaced one real defect (see Phase status). Production is untouched and no release exists.

## Current objective and required order

Superseding order (owner, 2026-09-05): the campaign now follows [missions-engine-plan.md](missions-engine-plan.md): P0-0 image-build timeout (own PR), Phase 0 arm and collaborate, Phase 1 hierarchy, 8.5, the board bridge on missions.staging.pgnos.ai, then 10, 11, 12. The numbered list below is the 2026-09-03 state and stays as history.

Scope decision (user, 2026-09-02): this branch lands the staging contract probe only. Phase 8.5, the same-origin UI/session bridge and Phases 10-12 move to a separate plan after it lands, in the README's order (probe → 8.5 → bridge → 10 → 11 → 12). Production needs its own go-ahead.

1. Done — cuts committed and pushed; PR #133 merged (`d8c6f7e`).
2. Done 2026-09-03 — one-time staging tenant bootstrap: invite via ECS Exec, SSM port-forward, `--dry-run`, real run (company `Netzar OS` prefix `NZR`, agents `main`/`research`, keys `netzar-reconciler`/`netzar-agent-main`/`netzar-agent-research`, one new secret version), no-op re-run (`agents created 0, reused 2; keys created 0, reused 3`), independently re-verified by a fresh-context critic (prior fields byte-identical by hash).
3. Done — PR #134 `development` → `qa` (`345f238`).
4. Done, red — PR #138 `qa` → `staging` (`fd04227`); run 33733071639 attempt 4 deployed and the probe ran live and was refused with HTTP 403 (see Deployment and Active blockers).
5. Done, red — `PAPERCLIP_ALLOWED_HOSTNAMES` shipped (#139 → #140 → #141); run 33773788920 deployed it and the probe's fetch got no response (attempts 1 and 2).
6. Done, green — `PAPERCLIP_BIND=lan` shipped (#142 → #143 → #144); run 33783021194 matched the bar job for job, the probe passed with all eight markers, the smoke test passed.
7. Done — final handoff pass (this branch).
8. **Now:** `aws login`, then the stream-level redaction greps against the green run (the Actions-log greps are done: 0 hits for the company id and for token-shaped strings). Then the follow-on plan in the README's order: Phase 8.5 from the shapes captured in the README, the UI/session bridge, Phases 10-12.
6. Final handoff pass with the green run id and the eight observed shapes.

Then, separately and in order: Phase 8.5 from the observed contracts, the UI/session bridge, Phases 10-12, production, release.

## What is in the diff

Kept from Codex, audited correct: the three staging-only IAM statements (`RunTask`/`DescribeTasks` with the `ecs:cluster` condition, `PassRole`, log read) and their literal-string tests; the post-rollout, pre-smoke workflow step (describe-services network config, command-only override, bounded 12 × 10 s `filter-log-events`, every marker required, fails on the failure marker or a nonzero exit); the marker pin in the image-pipeline test; `writeIfAbsent` Better Auth minting iff absent or `REPLACE_ME`; the `company_id` write-back; the README section 6 per-install secret bullet and the ADR 0010 2026-09-01 amendment.

Cut this session; each cut passed a fresh-context critic that verified by execution:

- Probe: the uncommitted `<field-N>` key numbering is reverted to `safeShapeKey` (UUID keys become `<uuid-key>`, real field names stay — the schema evidence Phase 8.5 needs); the media-type normalization (`application/json` / `image/svg+xml` / `other`) and its test stay; the dead `+json` branch is gone.
- Bootstrap: `bootstrap-secret.ts` 130 → 96 lines (dead `dryRun`/`warn`/`errorName`/`writeBootstrapSecretFields`); source-text tests replaced by seven behavioural ones; `--dry-run` is now an unauthenticated `GET /api/health`, a fail-closed secret read, field names printed as set/`REPLACE_ME`, a plan echo, then return — no POST, no write; the `dispatch_secret` checkpoint (a second `PutSecretValue`) is removed so one bootstrap writes one Secrets Manager version; dead post-return dry-run branches and `reconcileKey`'s always-false `dryRun` parameter are deleted.
- Task-definition injection of `PAPERCLIP_DISPATCH_URL` / `CCE_PAPERCLIP_ADMIN_EMAIL` removed with every ripple (`compute-stack.ts`, `scripts/deploy.ts`, `manifest.ts`, `src/config/env.ts`, `docs/deprecations.json`, the two `deploy.yml` synth steps, the vars-presence test, `rollback-classes.md` back to `origin/development`, four drift notes, the `.env.example` sentence). Both names are read only by `scripts/paperclip-bootstrap.ts`; nothing live has them, so there is no drift.

## Authentication model

Per-install Better Auth secret; recorded in the [README](README.md) section 6 and ADR 0010's 2026-09-01 amendment. Staging's `better_auth_secret` was set on 2026-09-02 (AWSCURRENT 2026-09-02T10:28:29-04:00, two versions); the Paperclip service restarted HEALTHY on task definition `:2` at 10:31:50-04:00.

## Phase status

- Base integration: deployed and healthy in staging (run 33067242593).
- Staging contract probe: **green** in run 33783021194 with all eight markers. Its first two live runs each found a real defect that would have broken the ACL and the reconciler the moment `CCE_PAPERCLIP_ENABLED` flipped: Paperclip's private-hostname guard refused the orchestrator's Cloud Map hostname (fixed by `PAPERCLIP_ALLOWED_HOSTNAMES`, #139), and a re-booted Paperclip task shrank to a loopback listener because the EFS `config.json` says `server.bind: loopback` (fixed by `PAPERCLIP_BIND=lan`, #142). Both variables are on the Paperclip service task definition and pinned by literal tests.
- Phase 8.5: not implemented; deferred to a separate plan after the probe lands (scope decision 2026-09-02); still gated on live `/org` and goals shapes.
- Same-origin UI/session bridge (bar-and-phases Part F): does not exist; deferred to the same plan.
- Phases 10-12: not implemented; deferred behind the bridge.
- Production/release: untouched; needs a separate go-ahead.

## Last commands actually run

This session only, on the working tree with the cuts applied; the validation runner finished 2026-09-03T04:13:48Z; exits verbatim.

- `npm run typecheck` — exit 0.
- `npm test` — exit 1. `Test Files 5 failed | 234 passed | 1 skipped (240)`; `Tests 1 failed | 3003 passed | 6 skipped (3010)`. Failing files: `scripts/ci/docs-links.test.ts`, `scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`, `scripts/release/sync-deprecations.test.ts` — each fails at collect with `SyntaxError: Invalid or unexpected token`; the `.mjs` each imports is checked out `i/lf w/crlf` (`core.autocrlf=true`) including its shebang line, and each `.mjs` runs directly with exit 0; and `scripts/lib/lifecycle/rollback-classes.test.ts > deploys the archived assembly with --app and diffs first`, the known Windows `/tmp/fake/cdk.out` vs `\tmp\fake\cdk.out` separator assertion. None of the five differs from `origin/development` on this branch. CI's Linux `Typecheck + Unit Tests` job passed at `291a457` (run 33639063032).
- `npm run build` — exit 0.
- `npm --prefix web run typecheck` — exit 0.
- `npm --prefix web run build` — exit 0 (vite 6.4.2, built in 7.55 s).
- `npm run local:test:integration` — NOT RUN: the Docker daemon is unreachable on this machine (`docker info`: `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`). CI's `Integration Tests (LocalStack)` job passed at `291a457`.
- `git diff --check` — exit 0 (LF/CRLF warnings only).
- `node scripts/ci/docs-links.mjs` — `docs-links: 124 markdown files · 1420 internal links checked · 44 external links skipped` / `docs-links: OK`, exit 0 (run after the docs were written, 2026-09-03)
- `node scripts/ci/feature-knowledge.mjs` — `feature-knowledge: OK`, exit 0 (run after the docs were written, 2026-09-03; the validator checks only the two canonical files, so the new session file is not inspected by it)
- Fresh-context critics, one per cut, verifying by execution, round 1, all PASS. Probe: 14/14 tests; `dist` `redactShape({id,title,<uuid>:{t}})` printed `{"<uuid-key>":{"t":"string"},"id":"string","title":"string"}`; a malformed `PAPERCLIP_AGENT_KEYS_JSON` yields only `PAPERCLIP_PHASE_PROBE_FAILED PaperclipPhaseProbeError: invalid-agent-keys-json`. Bootstrap: 76/76 then 37/37 focused tests; `--dry-run` against `http://127.0.0.1:9` exits 1 at the health check before any AWS call; a local stub saw exactly one GET; with real credentials the dry-run printed field names only and the secret stayed at 2 versions; one `PutSecretValueCommand` call site. Injection: `git diff origin/development` empty for `manifest.ts`/`deploy.ts`/`env.ts`/`deprecations.json`/`rollback-classes.md`; hermetic synth 0 hits; staging synth 3 `PaperclipProbe*` Sids; diagrams-drift clean across 27 files.
- Tenant bootstrap (2026-09-03, gated script): `--dry-run` exit 0; real run exit 0 (`agents created 2, reused 0; keys created 3, reused 0`, one `wrote /claudeclaw-staging/paperclip` line); no-op re-run exit 0 (`agents created 0, reused 2; keys created 0, reused 3`, `nothing written`); secret AWSCURRENT 2026-09-03T04:04:37-04:00 with all seven fields set; 0 token-pattern hits across the saved logs. Fresh-context critic: PASS (AWSPREVIOUS vs AWSCURRENT per-field hashes: `admin_password`, `better_auth_secret`, `database_url` identical; nothing dropped; `/api/agents/me` and `/org` 200 with the main key, `/issues?limit=1` 200 with the reconciler key, 401 without a key).
- Live staging probe — run 33733071639 attempt 4: `request-rejected (HTTP 403)`; run 33773788920 attempts 1 and 2: `request-failed-before-response`; run 33783021194: all eight markers, exit 0, smoke test passed. Each failure line carried only its controlled code; the Actions log of the green run contains 0 occurrences of the company id and 0 token-shaped strings (`grep -c` on the full run log, 3699 lines).
- Bar comparison for run 33783021194 (`gh run view --json jobs`): job list identical to 33067242593 (three jobs, all success); deploy-job step list identical except one added line, `success  Characterize Paperclip org and goals contracts`, between `Force ECS rollout` and `Smoke test (health)`; the two conditionally-skipped steps stayed skipped.
- Stream-level redaction greps (agent key and company id against the probe task's CloudWatch stream) — NOT RUN: the operator AWS session expired at 15:33 UTC on 2026-09-03 and was not renewed in this session. The three `PaperclipProbe*` Sids were read live on the deploy role earlier the same day (run 33733071639 applied them).
- Reproduction over the SSM tunnel with the task's Host header forced: `GET /org` with `Host: paperclip.claudeclaw-staging.internal:3100` → 403 `{"error":"Hostname 'paperclip.claudeclaw-staging.internal' is not allowed for this Paperclip instance ..."}`; the same request with `Host: 127.0.0.1:3100` → 200; unauthenticated `/api/health` with the internal Host → 403. Instance `config.json` `server.allowedHostnames` is `[]`. The goal created while checking `POST /goals` (201 via loopback) was deleted; the goal list is empty again.
- Second full validation on `fix/paperclip-allowed-hostnames` (runner finished 2026-09-03T14:20:02Z): `npm run typecheck` 0; `npm test` exit 1 with the same five Windows-only files by name (`Tests 1 failed | 3004 passed | 6 skipped (3011)`); `npm run build` 0; `npm --prefix web run typecheck` 0; `npm --prefix web run build` 0; `git diff --check` 0; integration NOT RUN (Docker absent). New test `allows the orchestrator hostname through the private-hostname guard` failed on `undefined` before the change and passes after (53/53 in `infra/lib/paperclip-stack.test.ts`).

## Active blockers

- None for the probe: staging is green at `47a69db` with the probe in the deploy.
- Pending, needs a fresh `aws login`: the stream-level redaction greps against `task/orchestrator/<probe task id>` of run 33783021194 and a read of the live Paperclip task definition to confirm `PAPERCLIP_BIND=lan` and `PAPERCLIP_ALLOWED_HOSTNAMES` landed (the CI-equivalent synth and the green probe already imply both).
- Docker daemon unreachable on the operator machine: the integration suite is NOT RUN locally; CI runs it on every PR.
- Not a blocker but a debt: the orchestrator image build under QEMU sits on npm's socket-inactivity timeout (ledger A53); three of seven deploy attempts this session failed or stalled there before any code ran.

## Smallest next action

`aws login`, then run the stream-level redaction greps for run 33783021194 (find the probe task's stream with `describe-log-streams --order-by LastEventTime --descending`, `filter-log-events` for `PAPERCLIP_PHASE_PROBE`, then `grep -c -F` for the `main` agent key and the company id read from the secret into shell variables). After that, start the follow-on plan: Phase 8.5 from the README's observed shapes.

## Guardrails for the resuming agent

- Start any new work from `development` (`53dfc2a` or later); the three feature branches of this session are merged.
- Preserve unrelated work and keep commits path-scoped.
- The tenant is bootstrapped; do not run the bootstrap again except to prove the no-op. Never use `x-forwarded-host` to work around the hostname guard — it is honoured before `Host` and would silently disable the guard.
- Never print, commit, or paste a secret value; diff secrets by field name only.
- Do not invent live payload types; capture redacted staging evidence first.
- Do not start Phase 8.5, the bridge or Phases 10-12 on this branch; they belong to the follow-on plan.
- Do not deploy production or create a release before staging is green.

## Session log index

Newest first. Every session working in this folder adds one file to `handoffs/` from the [session handoff template](../HANDOFF-TEMPLATE.md).

| Session | Date | Summary |
|---|---|---|
| [Goal-first missions engine](handoffs/2026-09-05-goal-first-missions-engine.md) | 2026-09-05 | Runs the approved missions-engine plan as a per-piece gauntlet: P0-0 image-build timeout first, then arm staging, the collaboration predicate, hierarchy, 8.5, the board bridge, 10-12 |
| [Staging probe green and two findings](handoffs/2026-09-03-staging-probe-green-and-two-findings.md) | 2026-09-03 | Diagnosed and fixed the two defects the probe found live (hostname guard, loopback listener), took staging green at 47a69db in run 33783021194, verified it against the bar, closed the docs; records the follow-on gauntlet prompt |
| [Staging probe cut and deploy](handoffs/2026-09-02-staging-probe-cut-and-deploy.md) | 2026-09-02 → 2026-09-03 | Cut Codex's over-build, bootstrapped the staging tenant, promoted through the ladder; the probe's first two live runs found the hostname guard and the loopback listener; run 33783021194 green with all eight markers |
| [Staging readiness and auth model](handoffs/2026-09-01-staging-readiness-and-auth-model.md) | 2026-09-01 | Records the live-probe blocker, per-install secret model, validation, and exact next action |
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

Authorities: [README](README.md), [implementation plan](implementation-plan.md), [plan audit](plan-audit.md), [bar and phases](bar-and-phases.md), [ADR 0010](../../adr/0010-paperclip-work-engine.md), and [this session's handoff](handoffs/2026-09-02-staging-probe-cut-and-deploy.md).
