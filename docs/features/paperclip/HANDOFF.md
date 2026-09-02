---
feature: paperclip
document_role: handoff
status: current
observed_at: 2026-09-01
as_of_commit: b3b427497d63d8f4d1faa147b46c9681c19bc460
---

# Paperclip integration handoff

- **Branch:** `codex/paperclip-phases-8-5-12`; next merge target `development`.
- **Source state:** the staging contract-probe readiness changes and CI-contract follow-up are committed through `9b5edad`, pushed, and open against `development` as green [PR #133](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/133).
- **Deployment:** the last green staging deploy is run [33067242593](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/runs/33067242593) at `ac70509` from PR #131. The current completion diff has not been deployed. Production is untouched and no release has been created.

## Current objective and required order

Finish the Paperclip plan without skipping evidence gates:

1. Make the redacted staging contract probe deployable and fail-safe.
2. Configure the staging-only per-install Better Auth secret.
3. Promote through `development` → `qa` → `staging` and capture live `/org` and goals shapes.
4. Implement and verify Phase 8.5 from observed contracts.
5. Implement the same-origin Netzar-to-Paperclip UI/session bridge.
6. Build and verify Four Pillars Phases 10-12.
7. Promote to production only after staging is green.
8. Create the GitHub release only after every planned Paperclip phase is safely in production.

## Current in-progress work

The local diff adds the redacted eight-marker probe and its post-rollout,
pre-smoke staging workflow step; narrow staging-only ECS, PassRole, and log
grants; bounded CloudWatch ingestion and marker completeness checks; stable
single-owner Better Auth seeding; fail-closed bootstrap secret parsing; and
per-environment dispatch/admin inputs. The IAM slice passed an independent
source-and-synth critic. Fresh spec and standards reviewers found the nested
`agent_keys` fallback and stale documentation; both are corrected locally.

## Authentication model

Each customer receives a separate Paperclip installation. `BETTER_AUTH_SECRET` is a unique internal session-signing secret per installation, generated during setup and stored in that customer's AWS Secrets Manager. It is not a shared customer credential and must never become one repository-wide fleet secret. GitHub environment secrets are only for Netzer-operated staging/production.

This decision is promoted to the feature README and ADR 0010's 2026-09-01 amendment.

## Phase status

- Existing base integration: deployed and healthy in staging.
- Phase 8.5: not implemented; blocked on live contract evidence.
- Phases 10-12: not implemented; blocked on the same-origin UI/session bridge.
- Current probe/auth readiness work: pushed in PR #133, not merged or deployed.
- Production/release: untouched.

## Last commands actually run

- Combined focused IAM, bootstrap-secret, lifecycle, workflow, and probe suite — PASS, 189 tests across 5 files.
- `npm run typecheck` and `npm run build` — PASS against the completed source diff.
- `npm --prefix web run typecheck` and `npm --prefix web run build` — PASS after restoring the lockfile-declared web dependencies.
- `git diff --check` — PASS.
- `node scripts/ci/feature-knowledge.mjs` — PASS after staging only the intended files so its Git-tracked-path contract could resolve the four new helper/probe source and test files.
- `node scripts/ci/docs-links.mjs` — PASS; 123 Markdown files and 1,385 internal links checked.
- `node scripts/ci/secret-scan.mjs --denylist scripts/ci/denylist.txt .github/workflows/deploy.yml scripts/lib/paperclip scripts/paperclip-bootstrap.ts src/ops` — PASS; 4 paths scanned.
- `npm test` — FAIL only in `scripts/lib/lifecycle/rollback-classes.test.ts` on the known Windows `/tmp/fake/cdk.out` versus `\tmp\fake\cdk.out` separator assertion; the same file fails identically in the unchanged normal checkout.
- `node --env-file=C:\dev\Netzer-Labs\.env node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts` — infrastructure-backed validation could not execute: Docker is unavailable, so 9 LocalStack suites timed out in setup and all 64 tests skipped.
- Three fresh final critics were launched in parallel, but the shared agent workspace rejected all three before inspection because it is out of credits; no verdict was produced. The earlier independent IAM critic remains PASS, and the earlier spec/standards findings are corrected.
- PR #133 first CI round — integration, hermetic synth, rollback dry-run, secret scan, internal links, Mermaid rendering, and asset budget PASS. The diagram drift gate named five mapped diagrams and the full unit job found two missing compatibility-registry entries; both exact contract failures are corrected in the follow-up commit.
- PR #133 corrected CI round — all eight checks PASS: Typecheck + Unit Tests, LocalStack Integration Tests, Hermetic CDK Synth, Rollback Dry-Run, Secret Scan, Internal links/runnable blocks, Mermaid rendering, Docs asset budget, and diagrams.map drift. Evidence: runs `33638432087` and `33638432121`.
- Live staging probe — NOT RUN.

## Active blockers

- Staging currently has placeholder `REPLACE_ME` rather than a valid Better Auth secret.
- `aws sts get-caller-identity` reports `NoCredentials` in this shell.
- Live contract evidence has not been captured.
- Docker/LocalStack integration evidence cannot be produced on this machine because Docker is not installed.
- Fresh final critics cannot execute until the shared agent workspace has credits.
- The UI/session bridge does not exist.

## Smallest next action

Restore critic capacity and obtain fresh verdicts, then restore staging AWS
credentials, perform the one-time tenant bootstrap without exposing credentials,
and promote through `development` → `qa` → `staging`.

## Guardrails for the resuming agent

- Work only in `C:\dev\Netzer-Labs\.worktrees\paperclip-promote` on `codex/paperclip-phases-8-5-12`.
- Preserve unrelated work and keep commits path-scoped.
- Do not merge `qa` into `staging` until the one-time tenant bootstrap can complete; the probe correctly fails on placeholder company/key fields.
- Never print, commit, or paste a Better Auth secret.
- Do not invent live payload types; capture redacted staging evidence first.
- Do not begin Phases 10-12 before the same-origin session bridge is defined and verified.
- Do not deploy production or create a release before staging is fully green.

## Session log index

Newest first. Every session working in this folder adds one file to `handoffs/` from the [session handoff template](../HANDOFF-TEMPLATE.md).

| Session | Date | Summary |
|---|---|---|
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

Authorities: [README](README.md), [implementation plan](implementation-plan.md), [plan audit](plan-audit.md), [ADR 0010](../../adr/0010-paperclip-work-engine.md), and [today's session handoff](handoffs/2026-09-01-staging-readiness-and-auth-model.md).
