---
feature: pgnos-public-dashboard
document_role: handoff
status: current
observed_at: 2026-08-14
as_of_commit: cc905b6e88a27b15976e891f3e52bac5e7586f03
---

# Session handoff — 2026-08-14 — staging public URL

## 1. What this session was for

Give the already-live staging environment its own permanent URL,
`staging.pgnos.ai`, mirroring how production serves `app.pgnos.ai`, and make
staging deploy continuously so development and QA fixes land there without a
manual dispatch.

## 2. State at the start, verified rather than assumed

Production **is** a long-running server, confirmed in-account, not from docs:

| Check | Evidence |
|---|---|
| ECS service | `claudeclaw-service`, `ACTIVE`, desired 3 / running 3, created 2026-08-08 |
| App | `GET https://app.pgnos.ai/health` → `{"status":"ok","uptime":61042}` |
| DNS | `app.pgnos.ai` → proxied CNAME → `8729640c-….cfargotunnel.com` |
| Tunnel | `netzar-production-public`, `config_src=cloudflare`, healthy, **12 connections** (3 tasks × 4) |
| Ingress | `app.pgnos.ai → http://localhost:3000`, then `http_status:404` |
| Task def | `claudeclaw-orchestrator:5` = cloudflared (essential) + xray-daemon + orchestrator |

Staging was **already** an equivalently long-lived service —
`claudeclaw-staging-service`, `ACTIVE`, 1/1 since 2026-08-13, 13 healthy
`CCE-STAGING-*` stacks — with task definition
`claudeclaw-staging-orchestrator:3` carrying **only** the orchestrator
container. So the gap was never "stand up staging". It was three things: a
Cloudflare tunnel and DNS record, the sidecar in staging's task, and
suffix-awareness in the code that puts it there.

**Correction to the earlier topology note:** the internal ALB is *not* in the
public request path. cloudflared forwards to `http://localhost:3000` inside the
task. Both environments are simpler than the prior handoff implied.

## 3. What was done

1. **Pushed `feature/pgnos-public-dashboard` to origin.** It had never been
   pushed, so production's running configuration existed on one laptop, and
   `origin/development`, `origin/staging` and `origin/production` all had zero
   `cloudflared` references in `compute-stack.ts` and no
   `public-dashboard-access.ts`. A CI deploy from `origin/production` would have
   dropped the sidecar and taken `app.pgnos.ai` offline.
2. **PR #46** merged that branch into `development`. Three conflicts, all
   resolved toward what production actually runs (see §5).
3. **Fixed four environment-isolation bugs** (§4) on `fix/staging-public-url`.
4. **Made staging continuous** in `.github/workflows/deploy.yml`.
5. **Rewrote `docs/staging.md`**, which described an environment that cannot
   exist in this account, and amended the `development.md` branch mapping.

## 4. The bugs, and why each mattered

All four would have fired the first time staging tried to publish.

| # | Location | Defect | Consequence |
|---|---|---|---|
| 1 | `public-dashboard-access.ts` | `PUBLIC_TUNNEL_NAME = 'netzar-production-public'` frozen literal, types pinned via `typeof` | staging looks up prod's tunnel |
| 2 | `scripts/public-setup.ts` | secret name frozen at module import from `process.env`, while config comes from `parseEnvFile` (which never touches `process.env`) | **`PutSecretValue` over prod's tunnel secret** — the only write path, highest severity |
| 3 | `scripts/deploy.ts` | same frozen name in the readiness probe | reads prod's *ready* secret → false ready for staging → essential connector attaches to a `REPLACE_ME` token → crash-loop → circuit-breaker rollback |
| 4 | `public-dashboard-access.ts` | blank `CCE_PUBLIC_HOSTNAME` silently defaults to `app.pgnos.ai` | staging claims **prod's hostname** |

Bug 4 was not in the previous handoff's list; it was found while reading the
resolver.

The fix follows a pattern that already existed in this repo —
`scripts/warp-setup.ts:106-107` resolves names via
`buildResourceNames(env.CCE_NAME_SUFFIX ?? '')`. Frozen constants became
`buildPublicTunnelName(suffix)` / `buildPublicTunnelSecretName(suffix)`, both
defaulting to the prod value for an empty suffix, so **production behaviour is
byte-identical**.

Proven by synth rather than by argument:

| | staging synth | prod synth |
|---|---|---|
| tunnel secret | `claudeclaw-staging-public-tunnel` | `claudeclaw-public-tunnel` |
| tunnel name | `netzar-staging-public` | `netzar-production-public` |
| ALB scheme | `internal` | `internal` |
| ACM / Route 53 | none | none |

## 5. Merge conflicts and how they were resolved

| File | Resolution |
|---|---|
| `.github/workflows/deploy.yml` | Kept **both** sides — development's `CCE_ANOMALY_MONITOR_ARN` and the feature's `CCE_PUBLIC_ACCESS`/`CCE_PUBLIC_HOSTNAME` forwards. Dropping the latter makes a CI deploy silently undo the public dashboard. |
| `src/server.ts` | Feature side: `GET /` → 302 to `/dashboard`. This is what prod serves. |
| `src/server.test.ts` | Feature side, to match. |

## 6. Mistakes, assumptions and precautions — carried forward

Entries are kept and marked `RESOLVED (<commit>)` rather than deleted.

- **Do not run the full documented validation list for infra-or-config-only
  changes.** This session started Docker Desktop and the Floci emulator to run
  `local:test:integration` for a change that adds a hostname; the owner
  correctly called that out of proportion. CI runs the integration suite
  anyway — it passed there on PR #46. Typecheck + unit tests is the right local
  gate; name any skipped step instead of claiming it passed.
- **`git status` is slow here** (nested repo under `fix-windows-test-suite/`).
  Use targeted `git -C <path> <cmd>`.
- **Remote-tracking refs go stale and produce false findings.** An early pass
  concluded that `fix/staging-anomaly-monitor` had skipped `development`, a
  ladder violation. After `git fetch` it was plainly merged. Fetch before
  drawing conclusions about branch topology.
- **`web/node_modules` is separate from the root install.** `npm ci` at the root
  does not populate it, and the resulting `JSX.IntrinsicElements` errors look
  like real type breakage. Run `npm --prefix web ci` before believing them.
- **The diagrams drift gate is real, and it compares committed changes.** It
  correctly flagged that adding a sidecar to `compute-stack.ts` left the compute
  and security diagrams stale. Editing the files is not enough — commit, then
  re-run.
- **The `environment:` expression in `deploy.yml` must key off the resolved
  `TARGET_ENV`, never `github.event.inputs.env`.** On a push event the input is
  empty, which would select the *production* environment and hand a staging
  deploy production's variables. Same trap in the source-guard step.
- **Secrets are created as `REPLACE_ME` placeholders by design** and populated
  out of band; `cdk deploy` does not overwrite a populated secret. A container
  logging `Refusing to start: … placeholder` means an unpopulated secret, not a
  failed deploy.
- **Never set `DOMAIN_NAME` for staging.** It triggers `HostedZone.fromLookup`
  against a zone that does not exist and flips the ALB internet-facing.
  `HOSTED_ZONE_ID` does not rescue it.
- **`AWS_PROFILE=netzer-process` for anything SDK-based**, after
  `aws login --profile netzer-root`. Sessions expire in hours.
- **The `claudeclaw` tunnel belongs to `salessly.io`.** Never touch it. The
  exact-name match in `public-tunnel/setup.ts` is what protects it.

## 7. Validation actually run

Per the owner's instruction this session, the local gate was typecheck + unit
tests; CI ran the rest on PR #46 and all ten checks passed there.

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` (baseline, before any change) | 6 files / 14 tests failed |
| `npm test` (after PR #46 merge) | 6 files / 14 tests failed — **identical**; 1992 passed (+45) |
| `npx vitest run` on the two changed test files | 27 passed |
| `cdk synth CCE-STAGING-Compute` | staging names, no ACM/Route 53 |
| `cdk synth CCE-Compute` | prod names unchanged |
| `node scripts/ci/docs-links.mjs` | OK |
| `node scripts/ci/feature-knowledge.mjs` | OK |
| `node scripts/ci/diagrams-drift.mjs` | OK after the diagram updates |
| CI on PR #46 | 10/10 green, including Integration Tests (LocalStack) |

Baseline failures on untouched `development`, for comparison:
`scripts/ci/{docs-links,feature-knowledge,runnable-blocks}.test.ts`,
`scripts/lib/lifecycle/rollback-classes.test.ts`,
`scripts/release/sync-deprecations.test.ts`,
`src/adapters/dashboard/jarvis.flow.test.ts` (the last is the documented
cache-warmth flake).

## 8. Smallest next action

Promote `development → qa → staging`. The push to `staging` auto-deploys and
creates the tunnel secret with no sidecar (expected). Then
`npm run public:setup -- --env=staging`, and the next deploy attaches the
connector.

## 9. Not done, deliberately

Production deploys or any merge to `production`; reconciling `origin/production`
with prod's running code (**worth doing soon** — production is still 5 commits
behind the branch it actually runs); the SES sandbox case; staging Slack and
Telegram bots; NAT-free staging; ECR lifecycle rules. An uncommitted 40-line
`development.md` edit in the main checkout (canonical-checkout and worktree
conventions) was left untouched for the owner to commit separately.
