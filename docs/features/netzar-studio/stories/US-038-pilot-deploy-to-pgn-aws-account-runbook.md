# [US-038] Pilot deploy to PGN AWS account + runbook

> Backlog task NZR-38 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-006.

## 1. User Story Statement
* **As a** Persona E, enterprise administrator (PRD 1.3)
* **I want** a written, step-by-step runbook and a pre-deploy gate that installs Netzar into the new PGN AWS account (NZR-42) with the repo's own `npm run up`, first as rebuild staging and then as the pilot
* **So that** the design partner can run the golden workflow on a live webhook by Dec 31, only after every pilot control is in place, at the T0 cost floor (~$65–95/month per install), with a tested way back

---

## 2. Business Context & Description
* **Background:**
  - **Owner decisions:** Q64: managed pilot in PGN's own AWS account, with a written exception to the "no PGN data plane" rule, no customer production data, partner consent. Q91: never use the `staging` branch; the owner adds a GitHub guard; the new account is installed with the repo's `npm run up` from the VPS; every deploy is its own owner yes; no GitHub Actions deploys this account in 2026 (DEPLOY D4). Q84: no deploy to the old account. Q92: pilot ingress through the existing Cloudflare public-tunnel scripts, controls in the app (NZR-35 review). Q93: Telegram and Slack off in the pilot. Q58: production (pilot-partner) reach is blocked until the drafter is re-measured on Bedrock.
  - DEPLOY §4 is the source for the sequence, the checklist and the per-step rollback. This story turns it into a runbook plus one code gate.
  - Terms: **install** = one copy of all stacks in one AWS account/region (set by the env file, e.g. `.env.pilot`). **Soak** = run the new release on staging for a set time and watch for errors before promoting. **Same-artifact rule** = the pilot runs the exact image digest that soaked on staging.
  - T0: one Fargate task, no WAF, no CloudFront, $5/day cost cap (`infra/lib/constants.ts:337-351`). **No canary at T0**: every deploy restarts the only task (DEPLOY §4, risk 11). No deploys Dec 24–31.
* **Current behaviour (d1d3a66):**
  - `npm run up` → `scripts/up-launcher.mjs` (Node ≥ 20 and `node_modules` check) → `scripts/up.ts`: setup (only if no env file; `--answers <file>`), doctor, early-win (one Bedrock probe), deploy (keeps its own cost gate unless `--yes`), verify (`scripts/up.ts:10-46,599-722`). `--env=<x>` selects `.env.<x>` (`scripts/lib/env-file.ts:30-32`; `prod` → `.env`).
  - Unattended answers file for this shape exists: `examples/answers/infra-only-t0.json` (us-east-1, tier 0, $5 cap, infra-only, `ciMode: none`, add-ons off).
  - A fresh T0 wizard run sets `CCE_PAPERCLIP_TEARDOWN=1` itself (`scripts/setup.ts:1006`), which satisfies the Paperclip-emptying guard in `infra/bin/app.ts:100-117`. A hand-written env file without it fails synth at T0 (DEPLOY risk 9).
  - Isolation: the deny-by-default emptiness scan and the Organizations/Control Tower profile run in `npm run bootstrap` (hard block, `scripts/bootstrap.ts:186-215,704-707`) and `npm run validate:tier1` Phase 3 (read-only, `scripts/tier1-validate.ts:10,97`). "No override flag" (`AGENTS.md:95-97`). `npm run deploy` itself uses `bootstrapState` (`scripts/deploy.ts:250`), not the scan. UNVERIFIED: whether `up`'s doctor step runs the scan.
  - Image: local Docker or in-account CodeBuild (`scripts/deploy.ts:199-206`, `--build-local` / `--build-cloud`, `:337-368`). Manifest-preserving digest copy exists in `scripts/lib/release/image-import.ts`.
  - Verify: `npm run verify` = `tsx scripts/status.ts --strict` (two paid Bedrock probes, pennies). Rollback: `npm run deploy:rollback -- --class=image|infra|config --to=<deployId|previous> [--dry-run] [--env=<x>]` (`scripts/rollback.ts:4-8`). Restore: `npm run restore:ddb` (`docs/runbooks/restore-from-ddb-export.md`). Cost: `node scripts/cost-estimate.mjs --tier=0`.
  - Public tunnel: `CCE_PUBLIC_ACCESS=1` overlay (`infra/lib/public-dashboard-access.ts`), tunnel name `netzar-${suffix || 'production'}-public` (:59), default hostname `app.pgnos.ai` (:83), suffixed installs must set `CCE_PUBLIC_HOSTNAME` (:132-142). `npm run public:setup` finds the **existing, remotely managed** tunnel and writes its connector token into Secrets Manager (one AWS write, `scripts/public-setup.ts:3-12`). The sidecar starts only with `CCE_PUBLIC_CONNECTOR_READY=1` (`infra/lib/compute-stack.ts:738`). Cloudflare tunnel names are per Cloudflare account, not per AWS account.
  - Telegram/Slack fail closed when their secrets are unset (`REPLACE_ME` reads as unset, `src/config/env.ts:17-31`): `/tg` → 401 `no_secret` (`src/adapters/telegram/handler.ts:60-79`), `/slack` rejects unsigned (`src/adapters/slack/handler.ts:63-80`).
  - GitHub: `deploy.yml` deploys on every push to `staging` (`.github/workflows/deploy.yml:14-16`) into `vars.AWS_ACCOUNT_ID` (old account). `branch-guard.yml` detects, does not block. `scripts/ci/deploy-source-guard.mjs` only checks the ref.
  - Production gate from NZR-30: `npx tsx scripts/ci/drafter-eval-gate.ts --require-production-score` exits 1 without a representative Bedrock score ≥ 80% (`evals/drafter/results/current.json`, US-030).
* **Target behaviour:**
  - `docs/runbooks/pilot-deploy.md` lists every step (staging walking skeleton, soak, drills, pilot, partner access, tear-down), each with the exact command, the expected output, the owner-yes point, and the rollback.
  - `scripts/pilot-gate.ts` (read-only, $0, no AWS call) refuses unless every pilot condition holds; `scripts/deploy.ts` runs it before the cost gate when the env file sets `CCE_PILOT_GATE=1`, so a pilot deploy cannot start without it.
  - The first rebuild-staging deploy goes out late Nov as soon as Bedrock works; the pilot deploy by ~Dec 18; partner access only after the ship message is approved.
  - Each deploy is run by the owner (or with the owner's yes in that conversation) from the VPS, never from GitHub Actions.
* **Out of scope:**
  - Opening the account and Bedrock access (NZR-42). The engine, triggers and lifecycle code (NZR-34/35/36). The golden workflow (NZR-31). Creating the Cloudflare tunnel object (owner action in the Cloudflare dashboard; this story names it).
  - Any deploy to the old account (Q84). GitHub Actions for NZR-42 (Q91/D4). Tier ≥ 2 controls (see Security notes; the exception must say T0).
  - Deleting legacy staging / Paperclip (NZR-37).
* **Target Value:** pilot `npm run verify` green after the first pilot deploy and after every later one; image rollback rehearsed on staging once, measured in minutes and recorded; restore test into a side table done once on staging; pilot standing cost ≤ $95/month (Cost Explorer, first full week).
* **User Persona Profile:** Persona E, enterprise administrator (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Pilot gate passes, deploy runs
* **Given** `.env.pilot` with `CCE_PILOT_GATE=1`, `CCE_TIER=0`, `CCE_NAME_SUFFIX=pilot`, `CCE_PUBLIC_HOSTNAME=pilot.pgnos.ai`, Slack/Telegram values unset, a clean checkout whose HEAD is on `origin/development`, a committed Bedrock drafter score ≥ 80%, and `docs/features/netzar-studio/pilot/exception.md` with both sign-off lines filled
* **When** the owner runs `npm run up -- --env=pilot` from the VPS
* **Then** `pilot-gate` prints `PASS pilot gate (9/9 checks)` before the cost gate, deploy continues to its own cost prompt, and after the owner accepts, `npm run verify -- --env=pilot` exits 0
* **Test:** `scripts/pilot-gate.test.ts` › "passes when every pilot condition holds"; runbook step log line "verify: exit 0" with the deploy id

### Scenario 2: Not re-baselined, no exception, wrong shape
* **Given** the same env file but (a) no representative Bedrock drafter score ≥ 80%; (b) the exception file missing or a sign-off line empty; (c) `CCE_TIER` ≠ `0`; (d) `CCE_PUBLIC_HOSTNAME` empty or `app.pgnos.ai`, or `CCE_NAME_SUFFIX` empty; (e) `TELEGRAM_TOKENS_JSON` or `SLACK_BOT_TOKEN` set to a real value; (f) dirty tree or HEAD not on `origin/development`; (g) `CCE_PRIVATE_ENDPOINTS=1`
* **When** `npm run up -- --env=pilot` (or `npm run deploy -- --env=pilot`) runs
* **Then** it exits non-zero **before** bootstrap, image build or the cost gate, printing one line per failed check, e.g. `FAIL production reach blocked: no Bedrock drafter score (Q58)`, `FAIL pilot exception not signed (SECURITY §5.1)`, `FAIL pilot must be Tier 0 (got 2)`, `FAIL pilot hostname must be set and must not be app.pgnos.ai`, `FAIL Telegram/Slack must stay off in the pilot (Q93)`; zero AWS calls are made (no SDK client constructed)
* **Test:** `scripts/pilot-gate.test.ts` › one test per check "(a) … (g) refuses"; `scripts/deploy.pilot-gate.test.ts` › "deploy stops before bootstrap when the pilot gate fails"

### Scenario 3: Account isolation recorded before the first install
* **Given** NZR-42 is ready and empty
* **When** the owner runs `aws sts get-caller-identity` and `npm run validate:tier1 -- --env=staging` before the first deploy
* **Then** the runbook log records the account id (matches NZR-42), the account profile `standalone` (Organizations answers "not in use"), the scan verdict `empty` and the region list; if the scan says `not-empty` or `indeterminate`, or the profile is Organizations-managed, the runbook stops at that step and links DEPLOY D1 (no override exists)
* **Test:** `docs/runbooks/pilot-deploy.md` › section "Step 1 Account check" (log template with these four fields); owner fills it

### Scenario 4: Old deploy path closed (Q91, Q84)
* **Given** the pilot plan is reviewed
* **When** the runbook pre-flight runs
* **Then** it records that the owner disabled `deploy.yml` (`gh workflow view deploy.yml` shows `disabled_manually`) or protected the `staging` branch so pushes are blocked (owner-only GitHub setting); `vars.AWS_ACCOUNT_ID` still names the old account (it is never repointed at NZR-42, DEPLOY risk 3); no NZR-42 credential exists in GitHub secrets; and the rebuild work has no branch or PR targeting `staging`
* **Test:** `docs/runbooks/pilot-deploy.md` › section "Step 0 Guards" (four checkboxes with the command output pasted)

### Scenario 5: Staging walking skeleton, soak and drills
* **Given** Bedrock works in NZR-42 and `.env.staging-r` (`CCE_NAME_SUFFIX=rstaging`, `CCE_PUBLIC_HOSTNAME=rstaging.pgnos.ai`, synthetic data only)
* **When** the owner deploys it with `npm run up -- --env=staging-r` and it soaks 24 h
* **Then** the log records: `DEPLOY_SHA` on the task definition equals the commit, the image digest, zero task restarts, no alarm, ops SNS subscription **confirmed**, daily spend under $5; an image rollback `npm run deploy:rollback -- --class=image --to=previous --env=staging-r` (after `--dry-run`) completes and its minutes are recorded; `npm run restore:ddb` into a side table matches item counts; the golden workflow passes on Bedrock and the live webhook passes through the tunnel
* **Test:** `docs/runbooks/pilot-deploy.md` › sections "Step 3 Staging deploy", "Step 4 Soak", "Step 5 Drills" (each with expected values and a pasted result)

### Scenario 6: Pilot reach is the soaked artifact
* **Given** staging soaked digest `sha256:S`
* **When** the pilot deploy runs
* **Then** the runbook records the pilot task's image digest; if it is not `sha256:S` (in-account rebuild), the step is FAIL and the pilot is redeployed from the copied digest (decision recorded in the runbook: digest copy via `scripts/lib/release/image-import.ts`, or digest match; DEPLOY §4 same-artifact gap)
* **Test:** `docs/runbooks/pilot-deploy.md` › section "Step 6 Pilot deploy" (digest table: staging, pilot, match yes/no)

### Scenario 7: Public reach is exactly what was reviewed
* **Given** the pilot is up with the tunnel connected
* **When** the post-deploy probe list in the runbook is run from outside (curl against `https://pilot.pgnos.ai`)
* **Then** each path returns what the NZR-35 review says: `/health` 200; `/dashboard` sign-in page; `POST /hooks/wf/<unknown>` 401 `{"error":"unauthorized"}`; `/tg/x` and `/slack/events` 404 (Cloudflare ingress rule) — or 401 if the rule is missing, which is a FAIL to fix before partner access; `/api/paperclip/dispatch` 404
* **Test:** `docs/runbooks/pilot-deploy.md` › section "Step 7 Public probe" (table: path, expected, actual)

### Scenario 8: Partner access only after every control
* **Given** the pilot install is verified
* **When** the owner considers giving the partner access
* **Then** the runbook's "Go-live" checklist shows every SECURITY §5 control 1–16 as done, or as a written, owner-signed deviation in the exception (at least §5.7 Tier ≥ 2 controls, see Security notes); partner users are created as seat-user or viewer only; the partner webhook trigger is created and its secret handed over out of band; the ship message is approved
* **Test:** `docs/runbooks/pilot-deploy.md` › section "Step 8 Go-live" (16 lines + sign-off)

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-42 / US-042](US-042-open-pgn-aws-account-request-bedrock-model.md) Open PGN AWS account + request Bedrock model access (owner, drop-dead Nov 9); [NZR-35 / US-035](US-035-triggers-webhook-api.md) Triggers: webhook + API; [NZR-36 / US-036](US-036-publish-activate-approval-rollback.md) Publish / Activate (approval) / Rollback
* **Builds on (other merged work; formal dependency changes are proposed in NOTES-H-live-deploy.md, not made here):** Also: NZR-30 `drafter-eval-gate.ts --require-production-score`; NZR-31 golden workflow; NZR-5/6 security fixes; DEPLOY D1 decided.
* **UI/UX Design:** N/A: deployment.
* **Non-Functional Requirements:** T0 ~$65–95/month per install (estimator $81.74, DEPLOY §4); Bedrock tokens bounded by the $5/day cap; soak 24 h for the first deploy and any infra/engine/webhook change, 2 h app-only, 30 min floor; no deploys Dec 24–31. Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

**Files to change**
| path | change |
|---|---|
| `scripts/deploy.ts:226-262` (preflight, before `bootstrapState` at :250) | If the parsed env file has `CCE_PILOT_GATE=1`, call `runPilotGate(env, { repoRoot })`; on failure print the lines and `process.exit(1)`. No other behaviour change. |
| `package.json` (scripts) | Add `"pilot:gate": "tsx scripts/pilot-gate.ts"`. No dependency. |
| `docs/runbooks/README.md` | Index line for `pilot-deploy.md` |
| `docs/data-flows.json` | Pilot flows (partner webhook in, Bedrock, SES if used) — SECURITY §5.15 |

**New files**
| path | purpose |
|---|---|
| `scripts/pilot-gate.ts` | Pure, read-only gate; exports `runPilotGate(env, ctx) → { ok, checks: [{ id, ok, line }] }`; CLI `npm run pilot:gate -- --env=pilot` |
| `scripts/pilot-gate.test.ts`, `scripts/deploy.pilot-gate.test.ts` | Scenarios 1–2 |
| `docs/runbooks/pilot-deploy.md` | The runbook (steps 0–9 below) with log templates |
| `docs/features/netzar-studio/pilot/exception.md` | Exception template (SECURITY §5.1 fields, T0 deviation, sign-off lines); the signed copy stays offline, the repo keeps the text + date + sha256 of the signed PDF |
| `docs/runbooks/pilot-incident.md` | SECURITY §5.14 page (named incident owner, 24 h partner notice, kill switches) |

**Pilot gate checks** (`scripts/pilot-gate.ts`; each one line, all run, no AWS call, no network)
1. `drafter-eval-gate --require-production-score` passes (spawned `npx tsx scripts/ci/drafter-eval-gate.ts --require-production-score`; exit code only) — Q58.
2. `docs/features/netzar-studio/pilot/exception.md` exists, both `Signed (owner):` and `Signed (partner):` lines non-empty, `End date:` ≤ 90 days ahead — SECURITY §5.1–5.2.
3. `CCE_TIER=0`, `CCE_DEPLOY_MODE=infra-only`, `DOMAIN_NAME` empty, `CCE_DAILY_COST_CAP_USD` ≤ 5 unless `CCE_PILOT_CAP_APPROVED=<date>` — Q92, DEPLOY risk 8.
4. `CCE_NAME_SUFFIX` non-empty and not `staging`; `CCE_PUBLIC_ACCESS=1`; `CCE_PUBLIC_HOSTNAME` ends `.pgnos.ai` and is not `app.pgnos.ai` or `staging.pgnos.ai` (legacy names).
5. `TELEGRAM_TOKENS_JSON`, `TELEGRAM_WEBHOOK_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` unset/blank/`REPLACE_ME` — Q93.
6. `CCE_PRIVATE_ENDPOINTS` ≠ `1`; `AWS_ENDPOINT_URL` unset (it is the Floci/local switch, `src/lib/bedrock/client.ts:413-424`) — SECURITY §5.5. Add any NZR-10 NVIDIA-proxy variable to this check when NZR-10 lands.
7. `CCE_PAPERCLIP_TEARDOWN=1` and `CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE` unset (no Paperclip in the pilot, `infra/bin/app.ts:100`).
8. Git: clean tree, `HEAD` is an ancestor of `origin/development` (`git merge-base --is-ancestor`), and not on `staging`.
9. The env file is not tracked by git (`git ls-files --error-unmatch .env.pilot` fails).

**Runbook steps** (`docs/runbooks/pilot-deploy.md`; each step: command, expected output, owner-yes point, rollback, log line)
0. *Guards* — GitHub guard done by the owner (Scenario 4); no `staging` target; `vars.AWS_ACCOUNT_ID` unchanged.
1. *Account check* — `aws sts get-caller-identity` (NZR-42 id), `npm run validate:tier1 -- --env=staging-r` (profile `standalone`, scan `empty`), Bedrock model ids from NZR-42 written down. Stop on any FAIL (D1).
2. *Synth check* — `CCE_TIER=0 CCE_PAPERCLIP_TEARDOWN=1 npx cdk synth` with the staging env, green (DEPLOY risk 9). Local, $0.
3. *Staging deploy* (owner yes) — `npm run up -- --env=staging-r --answers examples/answers/infra-only-t0.json` then edit suffix/public values; deploy stops at its cost gate; owner accepts; image build `--build-cloud` (VPS RAM 3.9 GB). Then Cloudflare: owner creates tunnel `netzar-rstaging-public` + public hostname route; `npm run public:setup -- --env=staging-r`; set `CCE_PUBLIC_CONNECTOR_READY=1`; redeploy (owner yes). Secrets/runtime config out of band (CDK leaves `REPLACE_ME`; check logs for "Refusing to start"). `npm run verify -- --env=staging-r`.
4. *Soak* — 24 h; pass = zero restarts, no new error types, flat memory, no alarm, spend < cap; ops SNS subscription confirmed.
5. *Drills* — image rollback (dry run, then real) timed; restore test into a side table; Bedrock drafter re-baseline (NZR-30) and golden workflow (NZR-31) on staging; live webhook through the tunnel with the NZR-35 probe list.
6. *Pilot deploy* (owner yes; target ~Dec 18) — `.env.pilot` with `CCE_PILOT_GATE=1`; `npm run up -- --env=pilot`; gate PASS; same-artifact check; tunnel `netzar-pilot-public`; verify.
7. *Public probe* — Scenario 7 table.
8. *Go-live* — SECURITY §5 1–16, partner principals, trigger + secret hand-over, ship message approved.
9. *After go-live* — every release: staging soak first, then pilot with its own owner yes; 30-min watched promote with `npm run deploy:rollback -- --class=image --to=previous --env=pilot` ready; no deploys Dec 24–31. *Tear-down* only on explicit owner request naming the install (`npm run destroy -- --env=<x>`), then check RETAIN leftovers.

* **Security notes:**
  - SECURITY §5 (all 16 controls) is the go-live checklist. Known gaps to write into the exception as signed deviations: **§5.7** Tier ≥ 2 controls (WAF, WORM audit, GuardDuty, VPC Flow Logs) are off at T0 (`constants.ts:349-352`); compensating controls = NZR-35 in-app limits, Cloudflare in front, CloudTrail on in the account (NZR-42). **§5.6** the deploy identity is the NZR-42 admin used from the VPS, not a data-blind role. **§5.4** "no cross-account trust except the deploy OIDC role" — there is no OIDC role (no GitHub Actions, Q91); say so.
  - Credentials: the VPS holds the NZR-42 credentials (US-042); never in GitHub, never in the repo; `.env.pilot` and `.env.staging-r` are untracked (gate check 9); run `node scripts/ci/secret-scan.mjs` on the runbook and exception files.
  - Data: staging synthetic only; pilot synthetic + partner-consented non-production; pilot data never copied to the VPS, NVIDIA, CI or evals (DEPLOY §5, SECURITY §5.13).
  - Do not pass `--yes` unless the owner approved the standing cost in that conversation; never `CCE_PRIVATE_ENDPOINTS=1` (+~$175/mo).
* **Test plan:**
  - Frozen failing tests first: `scripts/pilot-gate.test.ts` (one per check, using a fake env bag, a temp exception file and a stubbed spawn for the eval gate), red SHA recorded.
  - `scripts/deploy.pilot-gate.test.ts`: mock the preflight path so `runPilotGate` fails and assert no `bootstrapState`/SDK client is constructed (closest existing pattern: `scripts/lib/lifecycle/deploy-phases.test.ts`).
  - Commands: `npx vitest run scripts/pilot-gate.test.ts scripts/deploy.pilot-gate.test.ts`; `node scripts/ci/docs-links.mjs`; `node scripts/ci/runnable-blocks.mjs` (runbook code blocks); `node scripts/ci/secret-scan.mjs <changed files>`; full `npm test`.
  - The deploys themselves are not tests; their evidence is the filled runbook log.
* **Repo rules that apply:** every deploy, AWS call, flag flip and `npm run destroy` needs the owner's yes in that conversation (DEPLOY consent rule); never bare `cdk deploy` (use `npm run deploy`); never repoint `vars.AWS_ACCOUNT_ID`; never rename/replace a table or bucket (DEPLOY §5); `cdk diff` reviewed for `[-]`/replace on stateful resources before each promote; new runbook ⇒ `docs/runbooks/README.md` index; no new dependency.
* **Rollback:** per runbook step (DEPLOY §4 table): nothing created before the cost gate; failed first create → fix and re-run `npm run up` (idempotent); later releases → `npm run deploy:rollback -- --class=image --to=previous --env=pilot` (minutes) or `--class=infra --to=<deployId> --dry-run` first; webhook → disable the trigger / `workflow_triggers_disabled` / Cloudflare rule `/hooks/wf/*` → 404; partner access → revoke the partner principals. Code rollback of the gate: unset `CCE_PILOT_GATE` (owner yes) or revert the commit.
* **Build slices (proposal):**
  1. *Pilot gate* (2 h): `scripts/pilot-gate.ts`, deploy preflight hook, npm script, tests. Green: Scenarios 1–2 (unit).
  2. *Runbook + exception + incident page* (2 h): `pilot-deploy.md` (steps 0–9 with log templates), `exception.md`, `pilot-incident.md`, data-flows. Green: Scenarios 3–8 templates exist; docs CI.
  3. *Staging walking skeleton* (owner-run, ~2 h of factory support + 24 h soak): Scenario 5 filled.
  4. *Pilot deploy + go-live* (owner-run, ~2 h of factory support): Scenarios 6–8 filled.
* **Agent gotchas:**
  - **Tunnel name and hostname collide with legacy installs.** With no `CCE_NAME_SUFFIX` the pilot claims tunnel `netzar-production-public` and hostname `app.pgnos.ai` (`public-dashboard-access.ts:59,83`), which belong to the legacy production overlay in the same Cloudflare account; `public:setup` would hand the legacy tunnel's token to the pilot and Cloudflare would split `app.pgnos.ai` traffic between the two accounts. Suffix `staging` collides the same way with legacy staging. Use `pilot` and `rstaging` (or other owner-chosen names) and explicit hostnames. This differs from DEPLOY §1 "no suffix" — see NOTES.
  - **Second install in the same account fails the isolation scan.** After rebuild staging is installed, `validate:tier1` / `bootstrap` against NZR-42 report `not-empty` with no override (`AGENTS.md:95-97`). Record the scan before the **first** install; the pilot step may not rely on a fresh scan. D1 must be decided (second install vs second account) before Step 1.
  - The answers file has no name-suffix field (`scripts/lib/setup-answers.ts`); after setup, edit `.env.<x>` to add `CCE_NAME_SUFFIX`, `CCE_PUBLIC_ACCESS`, `CCE_PUBLIC_HOSTNAME`, `CCE_PILOT_GATE`.
  - `--env=<x>` maps to `.env.<x>` for any name (`scripts/lib/env-file.ts:26-32`), but `destroy`/teardown document only `--env=staging|prod` (`scripts/destroy.ts:53`). UNVERIFIED that every lifecycle command (deploy rules, rollback, teardown) accepts `pilot` / `staging-r`; dry-run each (`--dry-run`) in Step 2 before the first real deploy.
  - `npm run up` skips setup when the env file exists and ignores `--answers` then (`scripts/up.ts:635-641`); edit the env file instead of re-running with new answers.
  - A hand-written env file must carry `CCE_PAPERCLIP_TEARDOWN=1` at T0 or synth throws (`infra/bin/app.ts:100-117`); the wizard sets it only for a fresh T0 (`scripts/setup.ts:1006`).
  - `npm run public:setup` needs the tunnel to already exist in Cloudflare and needs `cloudflared` logged in (browser approval). It never creates Cloudflare resources.
  - Two deploys are needed for the tunnel: stacks first (secret created empty), then `public:setup`, then redeploy with `CCE_PUBLIC_CONNECTOR_READY=1`.
  - Docker image builds on the 3.9 GB VPS can OOM; prefer `--build-cloud` (in-account CodeBuild).
  - `npm run verify` makes two paid Bedrock calls; fine, but it is an AWS call: owner yes applies.
  - **Port 4566:** stop Floci/LocalStack on the VPS before running deploy tooling that honours `AWS_ENDPOINT_URL`, or a stray endpoint env var points the CLI at the emulator.

---

## 5. Estimation & Tracking
* **Epic Name:** M3 Live + pilot (cycle C3 Live (loop 2) + pilot, 2026-12-08 to 2026-12-31)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 5 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** pilot · **Labels:** needs-owner, deploy

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Persona E; partner live by Dec 31 only after all controls).
- [ ] Acceptance criteria cover both happy paths and edge cases (8 scenarios incl. gate refusals, isolation, old path closed, same-artifact, public probe, go-live).
- [ ] UX/UI designs: N/A: deployment.
- [ ] Dependencies have been identified and are unblocked (NZR-42 ready with Bedrock; NZR-35/36 merged; NZR-30 gate merged; DEPLOY D1 decided; install names and hostnames chosen by the owner; Cloudflare tunnels created by the owner; GitHub guard done by the owner, Q91).
- [ ] The team has reviewed and estimated the story points (5 pts; NOTES proposes 8; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail): the gate and the preflight hook only.
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (checks the SECURITY §5 mapping and the exception deviations) (+ NVIDIA roles after bake-off); owner reviews and signs the exception.
- [ ] A frozen failing test came first (red SHA recorded); `npx vitest run scripts/pilot-gate.test.ts scripts/deploy.pilot-gate.test.ts` and full `npm test` green on a clean checkout of the exact HEAD; CI green on that SHA.
- [ ] QA: the fresh critic re-runs the gate against these criteria and reads the filled runbook log. UAT: the owner runs the pilot deploy and the public probe and accepts the evidence.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR (one ADR line: straight 100% promote at T0 without canary, DEPLOY §4); `docs/runbooks/README.md`, `data-flows.json` updated.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50), rebuild staging soaked, pilot deployed with its own owner yes, `npm run verify -- --env=pilot` green, and the partner's first live webhook run recorded.
