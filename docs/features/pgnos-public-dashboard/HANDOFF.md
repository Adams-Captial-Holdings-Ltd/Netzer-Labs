---
feature: pgnos-public-dashboard
document_role: handoff
status: current
observed_at: 2026-08-13
as_of_commit: 0cde78943c8eb6e8df54e226a2c0999b6f228218
---

# pgnos public dashboard handoff

- Branch: `feature/pgnos-public-dashboard`; merge target: `development`.
  The owner explicitly directed this work straight to production rather than
  through the documented `development → qa → staging → production` promotion.
  Whether to merge back afterwards is still open.
- Pushed: **no**. Committed locally only. PR: none.
- Deployment: Cloudflare is **live** (tunnel `netzar-production-public`
  `8729640c-53cc-4b88-a1ed-6d0ba3ed37c6`, `app.pgnos.ai` CNAME, proxied).
  AWS deploy run with `AWS_PROFILE=netzer-root npm run deploy -- --build-cloud`.
- Phases/tasks: design components 1, 2, 3, 5 implemented. Component 9
  (always-on alarm) and the Cloudflare login rate-limit are deferred.
- Active objective: attach the connector so `app.pgnos.ai` serves, then verify
  SES DNS and lift the sandbox.

## Blockers

- **SES sandbox.** `GetAccount` returns `ProductionAccessEnabled: false`
  (200 msg/day, verified recipients only) and no `pgnos.ai` identity existed as
  of 2026-08-13. Production access is a human-reviewed AWS request with lead
  time. Until it is granted, `CCE_EMAIL_FROM` and `CCE_DASHBOARD_URL` are
  deliberately **not** deployed, per the design.
- `app.pgnos.ai` serves Cloudflare **Error 1033** until the sidecar attaches.
  Expected pre-attach state (tunnel exists, zero connectors), not a fault.

## Environment facts that cost time to rediscover

- `aws login --profile netzer-root` (root-user browser sign-in). **Not**
  `aws sso login`; the `netzer-dev` SSO profile is broken independently.
- The AWS CLI, `cloudflared`, and `session-manager-plugin` must all be on the
  **deploy shell's PATH**. Installed-but-not-on-PATH fails preflight:
  `C:\Program Files\Amazon\AWSCLIV2`,
  `C:\Program Files\Amazon\SessionManagerPlugin\bin`,
  `C:\Program Files (x86)\cloudflared`.
- Docker builds fail locally (ARM64 task, x86 host). Always `--build-cloud`.
- Run the deploy with **stdin attached to a real file**. It prompts once at the
  money gate (`scripts/deploy.ts:1138`); backgrounded with no stdin it blocks
  there forever while heartbeating the deploy lock, which wedges every other
  mutating operation.
- Before deploying, confirm `.env` matches the live `/claudeclaw/dashboard`
  secret. `deploy-phases.ts:154-158` writes it as `env.X ?? ''` with no
  preservation. Verified 2026-08-13: `.env` and the live secret both hold
  `token(64) / pin_hash(empty) / kill_phrase(22)`, so the write is a no-op.

## Last required checks and their real results

- **Baseline, recorded on `development` before any change**: 5 test files and 1
  test already failing (Windows path separators and docs-CI harnesses). Do not
  attribute those to this work.
- `npx vitest run scripts/lib/shell.test.ts scripts/lib/ses/setup.test.ts`
  → **23 passed**, 2026-08-13.
- The full pre-push list in [development.md](../../../development.md) step 7 has
  **not** been run in full yet on this branch. Outstanding: `npm run build`,
  `npm --prefix web run typecheck`, `npm --prefix web run build`,
  `npm run local:test:integration`, `node scripts/ci/docs-links.mjs`,
  `node scripts/ci/feature-knowledge.mjs`.

## Smallest next action

Re-run `npm run email:setup`, publish the printed DNS records in the `pgnos.ai`
Cloudflare zone, and poll until DKIM and MAIL FROM both report `SUCCESS`.

Authorities: [README](README.md),
[design spec](../../superpowers/specs/2026-08-11-netzar-os-pgnos-public-dashboard-email-design.md).
