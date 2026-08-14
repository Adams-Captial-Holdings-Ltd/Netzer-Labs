---
feature: pgnos-public-dashboard
document_role: session-handoff
status: current
observed_at: 2026-08-14
as_of_commit: eaa9e61ad99284582beebcb82bab491182be1e3f
---

# Session handoff — 2026-08-14 — production deploy ladder and SES email

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-14 |
| Feature folder | `docs/features/pgnos-public-dashboard/` |
| Branch worked on | `fix/prod-deploy-domain-and-email` |
| Branch it merges into next | `development`, then the `qa → staging → production` ladder |
| AWS environment that branch reaches | none directly — production only via `deploy.yml` dispatch from `production` |
| Commit at session start | `eaa9e61ad99284582beebcb82bab491182be1e3f` |
| Commit at session end | see PR |
| Pushed | see PR |
| PR | see feature `HANDOFF.md` |
| Deployed | **no** — production still runs `claudeclaw-orchestrator:5` / image `77a3df9c3ae9` |

## 2. Current state summary

The owner asked for production email on `app.pgnos.ai` to be deployed **through
the documented `development → qa → staging → production` ladder**, not from a
laptop as every prior production deploy has been. Investigating why that ladder
had never been used end to end turned up two defects in `.github/workflows/deploy.yml`
that would have broken or silently damaged the first CI production deploy. This
session fixes those two defects plus a KMS grant needed for SES bounce
telemetry, and leaves the work on `fix/prod-deploy-domain-and-email` ready to
walk the ladder. **Nothing is deployed yet.** SES production access is still
denied, which is a separate human-only blocker.

## 3. Codebase understanding

### Why the ladder had not worked

`development`, `qa` and `staging` are **content-identical** — `git diff --name-only`
returns zero files for both pairs. The ladder works for those three rungs. Only
`production` is behind, by 52 files. The reason it was never promoted is that a
production dispatch would have hit these:

**Defect 1 — `DOMAIN_NAME` was wrong for prod.** `deploy.yml` set
`public_host=claudeclaw-enterprise.com` and fed it to `DOMAIN_NAME`. Verified
in-account: **zero Route 53 hosted zones, zero ACM certificates** in us-east-1.
`compute-stack.ts:973-991` sends a non-empty `DOMAIN_NAME` into
`HostedZone.fromLookup` plus a DNS-validated `Certificate`. It also flips the
ALB internet-facing via `deploy-mode.ts:47` → `compute-stack.ts:934`, and both
live ALBs (`claudeclaw-alb`, `claudeclaw-staging-alb`) are `internal`.

**Defect 2 — the email variables were not forwarded, which silently disables
email.** The CDK-deploy `env:` block carried `CCE_DASHBOARD_URL` but not
`CCE_EMAIL_FROM` or `CCE_SES_CONFIG_SET`. `compute-stack.ts:345` resolves
`process.env.CCE_EMAIL_FROM ?? ''`, and `invite-email.ts` treats a blank sender
as `skippedReason:'unconfigured'`. The deploy would have gone green, every
health check would have passed, and magic-link email would have been off. The
workflow already carried this exact warning for `CCE_PUBLIC_ACCESS`; the
reasoning had never been applied to the email vars.

**Also — `CCE_DEPLOY_MODE` was blank for prod**, resolving to `chat`, while the
live task definition carries `infra-only`.

### Cleared, not defects

- GitHub **environment-scoped** variables were already present and correct for
  both `production` and `staging`. `gh variable list` without `--env` shows only
  repository variables and is actively misleading here — an early pass in this
  session nearly reported them missing on that basis.
- `iam-stack.ts:640-645` already grants `ses:SendEmail`/`ses:SendRawEmail` on `*`.
- The `claudeclaw-ops-alerts` topic **access policy** already allows in-account
  `SNS:Publish`. That was necessary but not sufficient — see the ledger.
- `compute-stack.ts:335` takes `CCE_DAILY_COST_CAP_USD` from
  `tier.dailyCostCapDefaultUsd`, not `.env`, so a CDK deploy cannot move the cap.

## 4. Work completed

| File | Change | Why |
|---|---|---|
| `.github/workflows/deploy.yml` | prod `public_host` → empty | No Route 53 zone / ACM cert; keeps the ALB internal |
| `.github/workflows/deploy.yml` | `CCE_DEPLOY_MODE: infra-only` unconditionally | Matches the live task definition; blank resolved to `chat` |
| `.github/workflows/deploy.yml` | forward `CCE_EMAIL_FROM`, `CCE_SES_CONFIG_SET` | Otherwise a CI deploy silently turns email off |
| `infra/lib/storage-stack.ts` | `AllowSES` statement on `logsKey` | SES cannot publish to the KMS-encrypted ops-alerts topic without it |

Out of band (no branch, already applied to the live account):

- SES configuration set **`netzar-magic-link`** created.
- GitHub environment variables set on **both** `production` and `staging`:
  `CCE_EMAIL_FROM=no-reply@pgnos.ai`, `CCE_SES_CONFIG_SET=netzar-magic-link`.

**No application source was changed.** `src/lib/email/invite-email.ts` was
already complete and correct; the whole gap was deploy-time plumbing.

### 4.4 Durable facts promoted

The `DOMAIN_NAME`-must-stay-empty rule and the env-forwarding rule are now
recorded as comments at the exact call sites in `deploy.yml`, which is where the
next person editing that file will see them. The branch-to-environment reality
they depend on already lives in `development.md`.

## 5. Carried-forward mistakes, assumptions and precautions

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

Appended this session:

- **Never set `DOMAIN_NAME` for production either.** The rule above was written
  for staging, and the gap let `claudeclaw-enterprise.com` sit in the prod branch
  of `deploy.yml` unnoticed. The account has no hosted zone and no certificate at
  all, so the rule is account-wide, not environment-specific.
- **I repeated the very first ledger entry.** I ran Docker, Floci, provisioning
  and the integration suite for a change touching one workflow file and one CDK
  policy statement. It passed, and it was still disproportionate — the entry
  above says so in plain words and I read it only afterwards. **Read section 5 of
  the newest session handoff before choosing the validation scope, not after.**
- **`--image-only` cannot ship an application change.** `scripts/deploy.ts:360`
  builds and pushes, then calls `rollFargateService`, which is only
  `ecs update-service --force-new-deployment`. It never registers a task
  definition, and the task definition pins the image **by tag**. The new image
  lands in ECR and the old one is redeployed, and the command reports success. A
  prior handoff recommended this exact command to ship the brand rename.
- **An SNS topic access policy is not the whole story when the topic is
  encrypted.** `claudeclaw-ops-alerts` is encrypted with `alias/claudeclaw-logs`.
  Confirming `SNS:Publish` in the topic policy was not enough:
  `CreateConfigurationSetEventDestination` still failed with *"Access denied to
  KMS key for SNS topic … Verify the KMS key policy grants Amazon SES the
  kms:GenerateDataKey and kms:Decrypt permissions."* The key policy had
  `AllowSNS` but no `AllowSES`. **Check the key policy, not just the topic
  policy.** Fixed in this branch's `storage-stack.ts`.
- **`gh variable list` hides environment-scoped variables.** It lists repository
  variables only. Use `gh variable list --env <name>`. Reporting "the variables
  are missing" from the bare command would have been wrong.
- **`.env` in this checkout holds PRODUCTION values and has no
  `AWS_ENDPOINT_URL`.** The documented `npm run local:test:integration` passes
  `--env-file=.env`, so running it as written here points the integration suite
  at **real AWS with production credentials**. Use `.env.localdev.bak`
  explicitly. The isolation guard is what makes this safe to discover rather
  than suffer — it fails closed.

## 6. Pending work

1. **Reply to AWS support case `178661777600815`** in the console. This is the
   only thing blocking delivery to any address that is not an SES-verified
   identity, and no code change can route around it. Both API routes are closed:
   `aws support` returns `SubscriptionRequiredException` (Basic support) and
   `put-account-details` returns `ConflictException`. Draft text is in the
   owner's `Downloads/ses-case-178661777600815-reply.md`.
2. **Verify a recipient identity** so the path can be proven before the sandbox
   lifts. `pgnos.ai` has **no MX record**, so no `@pgnos.ai` address can receive
   anything and the usual verified-domain shortcut does not exist here.
3. **Walk the ladder**: PR into `development`, then `qa`, then `staging` (which
   auto-deploys and is the real proof), then `production`, then dispatch
   `deploy.yml` with `env: prod`, `tier: 2`, `confirm: deploy`. **Tier must be 2** —
   the dispatch default is `3`.
4. **Create the SES event destination** on `netzar-magic-link` pointing at
   `claudeclaw-ops-alerts`. This must wait until the `AllowSES` KMS grant in this
   branch is actually deployed, or it fails with the KMS error above.
5. **Subscribe an address to `claudeclaw-ops-alerts`** — it has **zero**
   subscribers today, so bounce events would notify nobody.

## 7. Verification actually performed

Run on `fix/prod-deploy-domain-and-email`, on Windows 11.

| Command | Result |
|---|---|
| `npm run typecheck` | **exit 0** |
| `npm test` | **5 files failed, 182 passed; 1 test failed, 2010 passed** — see below |
| `npm run build` | **exit 0** |
| `npm --prefix web run typecheck` | **clean** |
| `npm --prefix web run build` | **built in 11.52s** |
| integration suite | **1 failed, 38 passed** — the documented Floci gap |
| `node scripts/ci/docs-links.mjs` | **OK** (80 files, 489 links) |
| `node scripts/ci/feature-knowledge.mjs` | **OK** |
| `git diff --check` | **clean** |

**The unit-suite failures are pre-existing and none are in `infra/`.** They are
`scripts/ci/docs-links.test.ts`, `scripts/ci/feature-knowledge.test.ts`,
`scripts/ci/runnable-blocks.test.ts`, `scripts/release/sync-deprecations.test.ts`
(all fail to load with `SyntaxError: Invalid or unexpected token`) and one
assertion failure in `scripts/lib/lifecycle/rollback-classes.test.ts`, which
compares `/tmp/fake/cdk.out` against a Windows-separated `\tmp\fake\cdk.out`.
The four load failures are **not** an encoding problem — the files carry no BOM,
line 5 of `docs-links.test.ts` is clean ASCII, and all four are unmodified. The
same files pass on the Linux CI runner. Failure **counts** match the recorded
baseline (5 files, 1 test); the pass counts are higher only because more code
has merged since.

**The integration failure is the documented one**:
`scripts/destroy.integration.test.ts > checkSecrets`, expecting `warn` and
getting `pass`, which is `development.md` known limitation #9 — Floci's
`ListSecrets` omits secrets scheduled for deletion.

**Deviation to report:** the integration suite was **not** run via the documented
`npm run local:test:integration`. That script passes `--env-file=.env`, and this
checkout's `.env` holds production values with no `AWS_ENDPOINT_URL`, so the
documented command would have pointed the suite at real AWS. It was run as
`node --env-file=.env.localdev.bak node_modules/vitest/vitest.mjs run --config
vitest.integration.config.ts` instead, after `scripts/local/guard.ts` confirmed
isolation (`sts:GetCallerIdentity` → `000000000000`). Provisioning used the same
substitution. `.env` was never modified.

`deploy.yml` was additionally parsed with a YAML parser to confirm it is still a
valid workflow file, since an invalid one fails as a 0-second run with no jobs
rather than as a syntax error. All three jobs resolve and the four changed
variables read back as intended.

## 8. Environment state

- Floci was started for the integration suite and **stopped again**
  (`npm run local:down`, container and network removed). No processes left running.
- `scripts/local/dev.mjs` was modified and uncommitted at session start. It is
  parked at the owner's request and was **stashed, not committed** —
  `stash@{0}`, message `parked: local dev.mjs (do not commit)`. **It must be
  restored with `git stash pop`.**
- `.env.localdev.bak` is untracked and was left in place.
- `git fetch` and `git merge` both emit
  `error: failed to delete '.git/worktrees/persistent-workspaces': Permission denied`.
  Non-fatal — the operations complete. A stale worktree registration.
- SES account state unchanged apart from the new `netzar-magic-link`
  configuration set: `ProductionAccessEnabled: false`, `SentLast24Hours: 2.0`,
  identity `pgnos.ai` verified with DKIM and MAIL FROM both `SUCCESS`.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF](../HANDOFF.md)
- [Previous session — staging public URL](2026-08-14-staging-public-url.md)
- [`development.md` branch-to-environment mapping](../../../../development.md#branch-to-environment-mapping)
