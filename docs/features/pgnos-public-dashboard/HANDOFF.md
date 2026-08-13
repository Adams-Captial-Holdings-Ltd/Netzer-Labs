---
feature: pgnos-public-dashboard
document_role: handoff
status: current
observed_at: 2026-08-13
as_of_commit: 77a3df9c3ae9d479ba13db6e9374dca19f621ff5
---

# pgnos public dashboard handoff

- Branch: `feature/pgnos-public-dashboard`; merge target: `development`.
  The owner explicitly directed this work straight to production rather than
  through the documented `development â†’ qa â†’ staging â†’ production` promotion.
  Whether to merge back afterwards is still open.
- Pushed: **no**. Two commits local only (`5790d96`, `77a3df9`). PR: none.
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
| `npm test` | **5 files / 1 test failed â€” identical to baseline**, 1975 passed |
| `npm run build` | pass |
| `npm --prefix web run typecheck` | pass |
| `npm --prefix web run build` | pass (9.05s) |
| integration suite vs Floci | **31/32**, the one documented `ListSecrets` emulator gap |
| `node scripts/ci/docs-links.mjs` | pass (438 internal links) |
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

Reply to AWS support case `178661777600815` to appeal the SES sandbox denial.
Until then, verify one recipient address in SES to exercise the invite flow.

Authorities: [README](README.md),
[design spec](../../superpowers/specs/2026-08-11-netzar-os-pgnos-public-dashboard-email-design.md).
