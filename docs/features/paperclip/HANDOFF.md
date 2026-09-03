---
feature: paperclip
document_role: handoff
status: current
observed_at: 2026-09-02
as_of_commit: 44fa53f7f911513a47bcf33ef1bc440d06ac4a5a
---

# Paperclip integration handoff

- **Branch:** `fix/paperclip-bind-lan` (from `development` `65f5f29`); next merge target `development`, then `qa`, then `staging` (merging `qa` → `staging` is the deploy). `codex/paperclip-phases-8-5-12` and `fix/paperclip-allowed-hostnames` are merged and finished.
- **Source state:** the staging contract probe and its CI-contract follow-up are committed and pushed through `291a457` and open against `development` as [PR #133](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/133) (CI run 33639063032 and Docs CI run 33639063012 green at that tip). This session's cuts — 22 files, 189 insertions, 356 deletions against `291a457` — were committed as four path-scoped commits (`7c4bbd1` infra, `06d9c11` probe, `14ed070` bootstrap, `37e4a1a` injection cut) plus the docs commit `2623a87`. PR #133 merged into `development` as `d8c6f7e`; [PR #134](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/134) promoted it to `qa` (`345f238`, 19/19 checks); [PR #138](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/138) promoted it to `staging` (`fd04227`, 20/20 checks). [PR #139](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/139) (`PAPERCLIP_ALLOWED_HOSTNAMES`) merged into `development` as `65f5f29`, then `qa` (#140, `fc7ec05`) and `staging` (#141, `3a6e040`). This branch adds the second variable the probe surfaced, `PAPERCLIP_BIND=lan`, with a literal test and a drift-gate note; see the [2026-09-02 session handoff](handoffs/2026-09-02-staging-probe-cut-and-deploy.md).
- **Deployment:** staging Deploy run [33773788920](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/runs/33773788920) at `3a6e040` deployed the hostname fix (the Paperclip service was replaced 16:00-16:05:54 UTC with `PAPERCLIP_ALLOWED_HOSTNAMES`; staging now runs orchestrator `:16` and Paperclip `:3`), and the probe failed in attempts 1 and 2 with `request-failed-before-response`: its fetch never got a response, where the run before it had reached the guard from the same subnets and security group. Attempt 2 changed nothing on Paperclip, so the replaced task is persistently unreachable from the VPC — see Active blockers. Before that, run [33733071639](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/runs/33733071639) at `fd04227` (attempt 4) ran every bar step green through `Force ECS rollout` — staging now runs orchestrator task definition `:14`, the image that carries `dist/ops` — and then **failed at the new probe step**: the probe executed as ECS task `e071943c4f2c45b2be381ddd3073c0b7` and its stream holds exactly one line, `PAPERCLIP_PHASE_PROBE_FAILED PaperclipPhaseProbeError: request-rejected (HTTP 403)`, so its first request (`GET /api/companies/{cid}/org`) was refused and the smoke test was skipped. Attempts 1-3 of the same run never reached deployment (image build: one stall, two `npm install` read timeouts in the emulated `[build]` stage; lockfiles and Dockerfile unchanged since the bar). The last **green** staging deploy remains [33067242593](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/runs/33067242593) at `ac70509`. Production is untouched and no release exists.

## Current objective and required order

Scope decision (user, 2026-09-02): this branch lands the staging contract probe only. Phase 8.5, the same-origin UI/session bridge and Phases 10-12 move to a separate plan after it lands, in the README's order (probe → 8.5 → bridge → 10 → 11 → 12). Production needs its own go-ahead.

1. Done — cuts committed and pushed; PR #133 merged (`d8c6f7e`).
2. Done 2026-09-03 — one-time staging tenant bootstrap: invite via ECS Exec, SSM port-forward, `--dry-run`, real run (company `Netzar OS` prefix `NZR`, agents `main`/`research`, keys `netzar-reconciler`/`netzar-agent-main`/`netzar-agent-research`, one new secret version), no-op re-run (`agents created 0, reused 2; keys created 0, reused 3`), independently re-verified by a fresh-context critic (prior fields byte-identical by hash).
3. Done — PR #134 `development` → `qa` (`345f238`).
4. Done, red — PR #138 `qa` → `staging` (`fd04227`); run 33733071639 attempt 4 deployed and the probe ran live and was refused with HTTP 403 (see Deployment and Active blockers).
5. Done, red — `PAPERCLIP_ALLOWED_HOSTNAMES` shipped (#139 → #140 → #141); run 33773788920 deployed it and the probe's fetch got no response (attempts 1 and 2).
6. **Now:** ship `PAPERCLIP_BIND=lan` (this branch) through `development` → `qa` → `staging`; verify the new run against 33067242593: the same job/step list plus the one probe step, all eight markers in CloudWatch, the redaction greps, the three `PaperclipProbe*` Sids live.
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
- Staging contract probe: merged and deployed to staging; ran live three times. Run 33733071639: refused with HTTP 403 by Paperclip's private-hostname guard (fixed by `PAPERCLIP_ALLOWED_HOSTNAMES`, deployed). Run 33773788920, attempts 1 and 2: the fetch never got a response — the replaced Paperclip task listens on loopback only (fix `PAPERCLIP_BIND=lan` on this branch, not yet deployed).
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
- Live staging probe — RAN in run 33733071639 attempt 4 as ECS task `e071943c4f2c45b2be381ddd3073c0b7`: exactly one log line, `PAPERCLIP_PHASE_PROBE_FAILED PaperclipPhaseProbeError: request-rejected (HTTP 403)`; no marker, no token fragment (the live failure path redacted correctly).
- Reproduction over the SSM tunnel with the task's Host header forced: `GET /org` with `Host: paperclip.claudeclaw-staging.internal:3100` → 403 `{"error":"Hostname 'paperclip.claudeclaw-staging.internal' is not allowed for this Paperclip instance ..."}`; the same request with `Host: 127.0.0.1:3100` → 200; unauthenticated `/api/health` with the internal Host → 403. Instance `config.json` `server.allowedHostnames` is `[]`. The goal created while checking `POST /goals` (201 via loopback) was deleted; the goal list is empty again.
- Second full validation on `fix/paperclip-allowed-hostnames` (runner finished 2026-09-03T14:20:02Z): `npm run typecheck` 0; `npm test` exit 1 with the same five Windows-only files by name (`Tests 1 failed | 3004 passed | 6 skipped (3011)`); `npm run build` 0; `npm --prefix web run typecheck` 0; `npm --prefix web run build` 0; `git diff --check` 0; integration NOT RUN (Docker absent). New test `allows the orchestrator hostname through the private-hostname guard` failed on `undefined` before the change and passes after (53/53 in `infra/lib/paperclip-stack.test.ts`).

## Active blockers

- **The replaced Paperclip task listens on loopback only.** Upstream resolves the bind mode as `PAPERCLIP_BIND` ?? `config.json` `server.bind` ?? inferred from `HOST`, and `loopback` maps the listener to `127.0.0.1` whatever `HOST` says (`packages/shared/src/network-bind.ts`, `resolveRuntimeBind`). The instance file on EFS holds `server.bind: "loopback", host: "127.0.0.1"` (read via ECS Exec on 2026-09-03; which upstream path wrote it is not identified — `bootstrap-ceo` only reads the file, and the quickstart onboarding would have written `lan` from `HOST=0.0.0.0`). The task booted by run 33773788920 therefore answers its own localhost health check and nothing else; the orchestrator's connection gets no response. The task it replaced had booted on 2026-09-02, before the file held that value, and listened on all interfaces (it answered the 403). Fix on this branch: `PAPERCLIP_BIND=lan` on the task definition, so the file can no longer shrink the listener.
- Resolved by #139 and deployed: the private-hostname guard no longer refuses `paperclip.claudeclaw-staging.internal` (the hostname is in `PAPERCLIP_ALLOWED_HOSTNAMES` on Paperclip `:3`). Not yet proven live, because the listener problem above sits in front of it.
- The staging Deploy run is red at the probe step; the smoke test did not run. Staging serves orchestrator `:16` and Paperclip `:3`, both 1/1.
- The operator AWS session expired at 15:33 UTC on 2026-09-03; live ECS, Cloud Map and CloudWatch reads need `aws login` again.
- Docker daemon unreachable here: the integration suite is NOT RUN locally; CI runs it.
- Resolved: tenant bootstrapped; Better Auth secret set; AWS credentials live.

## Smallest next action

Open the PR for this branch (`PAPERCLIP_BIND=lan`) into `development`, wait for 9/9, merge; promote `development` → `qa` → `staging`; watch the Deploy run's probe step and verify it against 33067242593. Then `aws login` and run the redaction greps against the green run's Actions log and probe stream.

## Guardrails for the resuming agent

- Work only in `C:\dev\Netzer-Labs\.worktrees\paperclip-promote` on `fix/paperclip-bind-lan` (branched from `development`).
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
| [Staging probe cut and deploy](handoffs/2026-09-02-staging-probe-cut-and-deploy.md) | 2026-09-02 | Cut the dead dry-run/checkpoint/injection code, restored schema-bearing redaction, recorded the scope decision and the real validation by file name |
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
