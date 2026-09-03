---
feature: paperclip
document_role: handoff
status: current
observed_at: 2026-09-02
as_of_commit: 37e4a1a71a8fb5fb19bc3b1c485c8e92a2dda095
---

# Paperclip integration handoff

- **Branch:** `codex/paperclip-phases-8-5-12`; next merge target `development`. Neither reaches an AWS environment; staging is reached only by the later `qa` → `staging` merge.
- **Source state:** the staging contract probe and its CI-contract follow-up are committed and pushed through `291a457` and open against `development` as [PR #133](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/133) (CI run 33639063032 and Docs CI run 33639063012 green at that tip). This session's cuts — 22 files, 189 insertions, 356 deletions against `291a457` — are committed as four path-scoped commits (`7c4bbd1` infra, `06d9c11` probe, `14ed070` bootstrap, `37e4a1a` injection cut) and pushed to PR #133 together with this handoff; see the [2026-09-02 session handoff](handoffs/2026-09-02-staging-probe-cut-and-deploy.md).
- **Deployment:** the last green staging deploy is run [33067242593](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/runs/33067242593) at `ac70509` from PR #131. Nothing from this branch has been deployed; the probe has never run live. Production is untouched and no release exists.

## Current objective and required order

Scope decision (user, 2026-09-02): this branch lands the staging contract probe only. Phase 8.5, the same-origin UI/session bridge and Phases 10-12 move to a separate plan after it lands, in the README's order (probe → 8.5 → bridge → 10 → 11 → 12). Production needs its own go-ahead.

1. Commit and push this session's cuts to PR #133.
2. Run the one-time staging tenant bootstrap (P4) against the live instance: ECS Exec `bootstrap-ceo` invite → SSM port-forward → `--dry-run` → real run → no-op re-run → names-only secret diff.
3. Merge PR #133 into `development`; open and merge `development` → `qa`.
4. Open and merge `qa` → `staging` (merging is the deploy). Verify the run against 33067242593: the same job/step list plus the one probe step, all eight markers in CloudWatch, the redaction greps, the three `PaperclipProbe*` Sids live.
5. Final handoff pass with the run id.

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
- Staging contract probe: source and tests only; never run live; not merged; not deployed.
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
- Live staging probe — NOT RUN.
- Tenant bootstrap, real run — NOT RUN.

## Active blockers

- Staging tenant not bootstrapped: `company_id`, `agent_keys`, `reconciler_key`, `dispatch_secret` are `REPLACE_ME` in `/claudeclaw-staging/paperclip`; the probe fails correctly on them.
- Live probe evidence does not exist, and there is no pre-flight path: the running orchestrator (task definition `:13`, 2026-08-27) predates `dist/ops`.
- Docker daemon unreachable here: the integration suite is NOT RUN locally; CI runs it.
- Resolved since 2026-09-01: the Better Auth secret is set; AWS credentials are live in the operator shell.

## Smallest next action

Commit and push the working-tree cuts to PR #133, then run the P4 tenant bootstrap.

## Guardrails for the resuming agent

- Work only in `C:\dev\Netzer-Labs\.worktrees\paperclip-promote` on `codex/paperclip-phases-8-5-12`.
- Preserve unrelated work and keep commits path-scoped.
- Do not open the `qa` → `staging` PR until the tenant bootstrap has completed and its no-op re-run is proven.
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
