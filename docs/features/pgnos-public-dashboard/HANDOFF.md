---
feature: pgnos-public-dashboard
document_role: handoff
status: current
observed_at: 2026-08-14
as_of_commit: eaa9e61ad99284582beebcb82bab491182be1e3f
---

# pgnos public dashboard handoff

- Branch: `fix/prod-deploy-domain-and-email`; merge target: `development`, then
  the full `development → qa → staging → production` ladder.
- **Production has never been deployed through `deploy.yml`.** `production` is
  52 files behind `development`; every prior production deploy ran from a
  laptop. Two `deploy.yml` defects blocked the CI path and are fixed on the
  branch above: prod's `DOMAIN_NAME` was `claudeclaw-enterprise.com` (the
  account has no Route 53 zone and no ACM certificate, and it would flip the
  internal ALB), and `CCE_EMAIL_FROM` / `CCE_SES_CONFIG_SET` were not forwarded,
  so a CI deploy would have gone green with magic-link email silently off.
  `development`, `qa` and `staging` are content-identical; only the production
  rung was broken.
- Scope widened on 2026-08-14: this feature is no longer production-only. The
  same machinery now publishes **`staging.pgnos.ai`**, which required making
  every Cloudflare-facing name suffix-aware.
- Pushed: **yes**. `origin/feature/pgnos-public-dashboard` now exists and PR
  #46 merged it into `development`. Until 2026-08-14 the branch was local only,
  which meant production's running configuration was reproducible from exactly
  one laptop and any CI deploy from `origin/production` would have dropped the
  cloudflared sidecar and taken `app.pgnos.ai` offline.
- Deployment: **live**. Three sequential runs of
  `AWS_PROFILE=netzer-process npm run deploy -- --build-cloud`:
  1. created the retained `claudeclaw-public-tunnel` secret (no connector),
  2. after `npm run public:setup`, attached the `cloudflared` sidecar,
  3. deployed `CCE_EMAIL_FROM` and `CCE_DASHBOARD_URL`.
  Task definition `claudeclaw-orchestrator:5`, 3/3 running.
- Phases/tasks: design components 1, 2, 3, 5 complete. Component 9 (always-on
  alarm) and the Cloudflare login rate-limit remain deferred.

## Verified on 2026-08-13

- `https://app.pgnos.ai/dashboard/` returns **200** with the Netzar sign-in SPA.
- `https://app.pgnos.ai/api/agents` unauthenticated returns **401**.
- Task contains three containers: `orchestrator`, digest-pinned `cloudflared`
  (`sha256:e39ee8daâ€¦`, essential), `xray-daemon`.
- Tunnel `netzar-production-public` reports 12 edge connections (3 tasks Ã— 4).
- `claudeclaw` / `salessly.io` untouched, still its own 4 connections.
- Apex `TXT "MS=ms53482844"` unchanged; all six SES records are on subdomains.
- SES `pgnos.ai`: DKIM **SUCCESS**, MAIL FROM **SUCCESS**, verified for sending.

## Blockers

- **SES production access is not granted yet.** AWS support case
  **`178661777600815`**. The API reports
  `Details.ReviewDetails.Status: DENIED`, but that status is misleading on its
  own: AWS's actual reply asks for more detail about sending practices and
  keeps the case open, with a 24h response cycle. It is a request for
  information, not a final refusal.
  The account stays in the sandbox meanwhile: 200 messages/day, 1/sec, and
  delivery only to verified identities. Reply in AWS Support Center rather than
  re-submitting `put-account-details`, which would not add the detail they
  asked for.
- Consequence today: magic-link sends to unverified addresses fail-soft and
  audit as `ses_error`. The login box still returns its constant 202 by design,
  so nothing appears broken to a user, and nothing is delivered. Sign in with
  `DASHBOARD_TOKEN`.
- To exercise the flow before the sandbox lifts, verify a single recipient
  address as an SES identity and invite only that address.

## Environment facts that cost time to rediscover

- `aws login --profile netzer-root` (root-user browser sign-in). **Not**
  `aws sso login`; the `netzer-dev` SSO profile is broken independently.
- **Use `AWS_PROFILE=netzer-process` for anything long-running.** `netzer-root`
  uses `login_session`, whose cached credentials the AWS CLI can refresh but the
  Node SDK cannot, so a ~10-minute deploy dies with
  `CredentialsProviderError` in its SDK-based tail. `netzer-process` wraps the
  CLI via `credential_process` and self-refreshes.
- The AWS CLI, `cloudflared`, and `session-manager-plugin` must all be on the
  **deploy shell's PATH**. Installed-but-not-on-PATH fails preflight:
  `C:\Program Files\Amazon\AWSCLIV2`,
  `C:\Program Files\Amazon\SessionManagerPlugin\bin`,
  `C:\Program Files (x86)\cloudflared`.
- Docker builds fail locally (ARM64 task, x86 host). Always `--build-cloud`.
- Run the deploy with **stdin attached to a real file**. It prompts once at the
  money gate (`scripts/deploy.ts:1138`); backgrounded with no stdin it blocks
  there forever while heartbeating the deploy lock, wedging every other mutating
  operation. A wedged holder is cleared by killing the process, never by
  force-breaking the lock: `acquireLock` takes over the expired lease by CAS.
- The deploy's trailing ALB health poll cannot succeed from a laptop â€” the ALB
  is `internal`. Judge the deploy by "service is stable", not by that poll.
- Before deploying, confirm `.env` matches the live `/claudeclaw/dashboard`
  secret. `deploy-phases.ts:154-158` writes it as `env.X ?? ''` with no
  preservation. Verified 2026-08-13: `.env` and the live secret both hold
  `token(64) / pin_hash(empty) / kill_phrase(22)`, so the write is a no-op.
- Local dev and prod share `.env`. To run the integration suite without
  swapping the production file, point it at the preserved local one:
  `node --env-file=.env.localdev.bak node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts`.

## Last required checks and their real results

Baseline recorded on `development` before any change: **5 test files / 1 test**
already failing (4 docs-CI harness collection failures plus one Windows
path-separator assertion in `rollback-classes.test.ts`).

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | **5 files / 1 test failed â€” identical to baseline**, 2010 passed |
| `npm run build` | pass |
| `npm --prefix web run typecheck` | pass |
| `npm --prefix web run build` | pass (11.52s) |
| integration suite vs Floci | **38/39**, the one documented `ListSecrets` emulator gap |
| `node scripts/ci/docs-links.mjs` | pass (494 internal links) |
| `node scripts/ci/feature-knowledge.mjs` | pass |
| `git diff --check` | clean |

Two deviations worth naming rather than hiding: the suite was run from
PowerShell, where `sh` is absent, which fails
`buildspec-tag-normalization.test.ts`; adding `C:\Program Files\Git\usr\bin` to
PATH makes it pass 15/15, so it is environmental, not a regression. And
`npm run local:test:integration` cannot run as written on Windows because
`node_modules/.bin/vitest` is a `#!/bin/sh` script â€” the equivalent JS entry
was invoked instead.

## Smallest next action

Merge `fix/prod-deploy-domain-and-email` into `development`, then walk the full
ladder. The `qa → staging` push auto-deploys and is the real proof that the
fixed workflow works before production sees it: confirm the staging task
definition comes back carrying `CCE_EMAIL_FROM` and `CCE_SES_CONFIG_SET`. Then
`staging → production`, then dispatch `deploy.yml` with `env: prod`,
**`tier: 2`** (the dispatch default is `3`), `confirm: deploy`.

After that deploy lands, create the SES event destination on the
`netzar-magic-link` configuration set — it needs the `AllowSES` KMS grant from
this branch to exist first — and subscribe an address to
`claudeclaw-ops-alerts`, which has none.

Separately, and blocking real invitations: reply to AWS support case
`178661777600815` to appeal the SES sandbox denial. Until then, verify one
recipient address in SES to exercise the invite flow. Note `pgnos.ai` has **no
MX record**, so no `@pgnos.ai` address can receive mail.

## Session index

- [2026-08-14 — staging public URL](handoffs/2026-08-14-staging-public-url.md):
  pushed the feature branch, merged it through PR #46, made every
  Cloudflare-facing name suffix-aware, and made staging deploy on merge.
- [2026-08-14 — production deploy ladder and SES email](handoffs/2026-08-14-prod-deploy-ladder-and-ses-email.md):
  found and fixed the two `deploy.yml` defects that would have broken the first
  CI production deploy, added the KMS grant SES needs for bounce telemetry, and
  created the `netzar-magic-link` configuration set. Not deployed.

Authorities: [README](README.md),
[design spec](../../superpowers/specs/2026-08-11-netzar-os-pgnos-public-dashboard-email-design.md),
[staging runbook](../../staging.md).
