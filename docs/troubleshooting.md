# Troubleshooting: every doctor and verify check, and how to fix it

> When `npm run doctor` (before deploy) or `npm run verify` (after deploy) prints a FAIL, the check id in the output maps to an entry on this page. (`npm run up` runs both and prints the same remediations inline, waiting automatically through the gate-shaped ones like Bedrock model access.) Each entry says what the check actually inspects, the usual reason it fails, and the exact fix, lifted from the remediation the tool itself prints and expanded with context. Doctor is pure read-only and runs before anything is created; verify reads live AWS state plus, in strict mode, exactly two tiny paid Bedrock calls.

Check ids come from [`scripts/lib/preflight/checks.ts`](../scripts/lib/preflight/checks.ts) (doctor) and [`scripts/lib/verify/checks.ts`](../scripts/lib/verify/checks.ts) (verify). `skip` means "not applicable for this deploy mode / feature set" and is never a problem by itself.

## Doctor (`npm run doctor`, also auto-run by `npm run deploy`)

### `aws-identity`
- **What it checks:** STS `GetCallerIdentity` resolves, and the resolved account matches `AWS_ACCOUNT_ID` in `.env` when set (wrong-account protection).
- **Why it fails:** no credentials configured, an expired SSO session, or your shell's `AWS_PROFILE` points at a different account than your `.env` targets.
- **Fix:** configure credentials (`aws configure`, or set `AWS_PROFILE` / run SSO login) and re-run. On an account mismatch, switch credentials to the account named in `.env`, or update `AWS_ACCOUNT_ID` if the resolved account is genuinely the intended target.

### `cdk-bootstrap`
- **What it checks:** the `CDKToolkit` stack exists in the deploy region and the SSM parameter `/cdk-bootstrap/hnb659fds/version` reports version 6 or newer.
- **Why it fails:** the account/region has never been CDK-bootstrapped, or was bootstrapped long ago with a version that lacks the modern deploy roles (that case is a warn, not a fail).
- **Fix:** `npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>`. The doctor output prints the exact command with your account and region filled in. If the stack exists but the version parameter is missing, bootstrap is incomplete: run the same command.

### `region-capability`
- **What it checks:** Bedrock answers `ListFoundationModels` in your `AWS_REGION`, in other words the region supports Bedrock at all.
- **Why it fails:** the configured region has no Bedrock service, or your credentials lack `bedrock:ListFoundationModels`.
- **Fix:** pick a Bedrock-supported region (for example `us-east-1` or `us-west-2`) and set `AWS_REGION` in `.env`. Several later checks share this model listing, so fix this one first; their failures will say so.

### `bedrock-grant-claude`
- **What it checks:** every Claude model configured in `BEDROCK_DEFAULT/SONNET/HAIKU/OPUS_MODEL` appears in the region's granted-model list (inference-profile prefixes like `us.` are stripped before comparing).
- **Why it fails:** you have not requested model access for Anthropic Claude in this region, the most common first-deploy failure. A warn instead means no Claude model is configured at all.
- **Fix:** submit the one-time Anthropic use-case form in the Bedrock model catalog (the output prints the region-specific URL: `https://console.aws.amazon.com/bedrock/home?region=<region>#/model-catalog`). Access is granted on submission but can take a few minutes to propagate. If nothing is configured, run `npm run setup` or set `BEDROCK_DEFAULT_MODEL` in `.env`. A pass here means "grant visible"; actual invocation is probed later by `npm run verify`.

### `bedrock-grant-titan-embed`
- **What it checks:** when knowledge is enabled (`CCE_KNOWLEDGE_ENABLED` not `0`), an `amazon.titan-embed*` model (or your explicit `BEDROCK_EMBED_MODEL`) is accessible.
- **Why it fails:** Titan embeddings access was never granted; knowledge ingest and `s3_vectors_search` would fail at runtime.
- **Fix:** Titan embeddings need no manual request since the October 2025 Bedrock change (serverless models auto-enable on first invocation given a valid payment method). If the check still fails, confirm the model exists in the region's model catalog, or set `CCE_KNOWLEDGE_ENABLED=0` if you genuinely do not want the knowledge feature.

### `bedrock-grant-image`
- **What it checks:** when image generation is enabled (`CCE_IMAGE_GEN_ENABLED` not `0`), the image model the runtime will actually invoke is listed as accessible. The check resolves the model exactly like the runtime does (`BEDROCK_IMAGE_MODEL`, then the legacy `BEDROCK_NOVA_CANVAS_MODEL` alias, else the default `stability.stable-image-core-v1:1`) and lists it in the model's serving region (us-west-2 for Stability models, the deploy region otherwise; `BEDROCK_IMAGE_REGION` overrides).
- **Why it fails:** the model is pinned to Nova Canvas (provider-Legacy since mid-2026, refused for new callers), the pinned model id has a typo, or the region is wrong.
- **Fix:** unset `BEDROCK_IMAGE_MODEL` / `BEDROCK_NOVA_CANVAS_MODEL` to use the Stability default (us-west-2-only, auto-subscribes on first use via a $0 AWS Marketplace agreement), fix `BEDROCK_IMAGE_REGION`, or set `CCE_IMAGE_GEN_ENABLED=0`.

### `bedrock-grant-nova-sonic`
- **What it checks:** when Jarvis voice is enabled (`JARVIS_LAUNCH_ENABLED=true|1`), an `amazon.nova-sonic*` model is accessible.
- **Why it fails:** Nova Sonic access not granted; the voice co-pilot would open a session and immediately die.
- **Fix:** Nova Sonic needs no manual request (auto-enabled on first invocation); confirm it is listed in the region's model catalog, or leave `JARVIS_LAUNCH_ENABLED` unset (the launch gate is fail-closed by default).

### `service-quotas`
- **What it checks:** quota headroom for the deploy's blast radius: EC2 EIPs (the NAT gateway needs one), VPCs per region, Fargate on-demand vCPU (static estimate), and ALBs per region.
- **Why it fails:** it never hard-fails; shortages and unreadable quotas surface as **warn**. A busy shared account that is at its VPC or ALB limit is the classic case.
- **Fix:** the output prints the exact request command per shortage, for example `aws service-quotas request-service-quota-increase --service-code vpc --quota-code L-F678F1CE --desired-value <n>`. Quota increases take minutes to days; request before deploy day.

### `cost-anomaly-monitor`
- **What it checks:** whether the account already has a DIMENSIONAL/SERVICE Cost Anomaly monitor. AWS allows exactly one per account and auto-creates `Default-Services-Monitor` the first time anomaly detection is enabled, so the CostGuardrails stack's default create collides on most non-fresh accounts. The deploy resolves this automatically (it attaches the anomaly subscription to the existing monitor instead of creating a duplicate); this check previews that decision.
- **Why it warns:** it never fails. A warn means the discovery call itself was not permitted (`ce:GetAnomalyMonitors` denied), so the deploy cannot know whether the create will collide.
- **Fix:** grant `ce:GetAnomalyMonitors` to the deploying principal so the deploy can discover and attach, or pin the monitor explicitly: `aws ce get-anomaly-monitors` prints the ARN, set it as `CCE_ANOMALY_MONITOR_ARN` in `.env`. No existing monitor and no pin means the stack creates its own, which is correct on a genuinely fresh account.

### `name-collisions`
- **What it checks:** whether the `<CDK_STACK_NAME>-Network` stack already exists (existing install vs fresh), and whether the deterministic state-bucket name is free, ours, or owned by **another** account (S3 names are global).
- **Why it fails:** a 403 on the state-bucket name means someone else's account owns it; your deploy would never be able to create it.
- **Fix:** set a fresh `CCE_NAME_SUFFIX` in `.env` so every named resource (including the state bucket) gets a non-colliding name, then re-run doctor.

### `domain-tls`
- **What it checks:** in chat mode (or whenever `DOMAIN_NAME` is set): an ISSUED ACM certificate **in the deploy region** covers the domain (wildcard SANs honored, one label only), and, on the auto-DNS path, a Route 53 hosted zone covers the apex.
- **Why it fails:** chat mode with no `DOMAIN_NAME` at all; a cert that exists in the wrong region (ACM certs are regional); a cert still PENDING_VALIDATION; or DNS managed outside Route 53 without providing `ACM_CERT_ARN`.
- **Fix:** one of: set `DOMAIN_NAME` with a Route 53 hosted zone (auto-DNS); request a cert in the deploy region (`aws acm request-certificate --domain-name <domain> --validation-method DNS --region <region>`) and complete DNS validation; set `ACM_CERT_ARN` to an existing ISSUED cert and manage DNS yourself; or switch to `CCE_DEPLOY_MODE=infra-only` (dashboard only, no chat webhooks).

### `tunnel-prereq`
- **What it checks:** only for no-domain `infra-only` installs: the `session-manager-plugin` binary is on PATH, because private dashboard access rides `npm run dashboard:tunnel` and AWS CLI v2 alone does not bundle the plugin.
- **Why it fails:** the plugin was never installed; the tunnel would die at session start.
- **Fix:** macOS `brew install --cask session-manager-plugin`; Debian/Ubuntu `curl -o /tmp/smp.deb https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb && sudo dpkg -i /tmp/smp.deb`; RPM `sudo yum install -y https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm`. AWS docs: Systems Manager "install the Session Manager plugin" page.

### `secrets-pending-deletion`
- **What it checks:** none of the six fixed secret names (`/claudeclaw[-suffix]/{slack,telegram,dashboard,db-encryption,bedrock-guardrails,vendor-keys}`) is in the Secrets Manager pending-deletion window from a prior teardown, which would block recreation for up to 7 days with a cryptic error mid-deploy.
- **Why it fails:** you tore down recently and are redeploying inside the recovery window.
- **Fix, one option per blocked secret:** restore it (`aws secretsmanager restore-secret --secret-id <id>`), force-delete it (`aws secretsmanager delete-secret --secret-id <id> --force-delete-without-recovery`, DESTRUCTIVE: the old value becomes unrecoverable), or set a fresh `CCE_NAME_SUFFIX` so this install uses non-colliding names.

### `ci-coherence`
- **What it checks:** only when `CCE_CICD_ENABLED=1` or `CCE_CODEBUILD_ENABLED=1`. For OIDC deploys: `CCE_GITHUB_OWNER` + `CCE_GITHUB_REPO` + a deploy ref (`CCE_GITHUB_DEPLOY_REFS` or `CCE_GITHUB_DEPLOY_ENVIRONMENTS`) are all explicitly set (synth fails closed without them so a fork can never inherit upstream deploy authority), and the account's GitHub OIDC provider has `sts.amazonaws.com` in its audience list. For CodeBuild: owner/repo set and a GITHUB source credential is imported.
- **Why it fails:** the CI flag was flipped on without the supporting values, or the shared account's OIDC provider was created by another team with a different audience list, or nobody ever imported the GitHub PAT.
- **Fix:** set the missing `CCE_GITHUB_*` values in `.env`; create the provider with `bash scripts/oidc-provider.sh`; add the audience with `aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn <arn> --client-id sts.amazonaws.com`; import the CodeBuild credential with `aws codebuild import-source-credentials --server-type GITHUB --auth-type PERSONAL_ACCESS_TOKEN --token <github-pat>`.

### `mode-readiness-inputs`
- **What it checks:** the `.env` values the selected deploy mode needs to ever pass `/ready`: chat mode needs at least one real surface token (`SLACK_BOT_TOKEN` or `TELEGRAM_TOKENS_JSON`); infra-only needs `DASHBOARD_TOKEN` plus a Bedrock model id. Placeholder-shaped values (`REPLACE_ME`, `<your-...>`) count as missing.
- **Why it fails:** the deploy would technically succeed and then sit at 503 forever; this check moves that failure to before any money is spent.
- **Fix:** run `npm run setup`, or set the missing values in `.env`; or switch `CCE_DEPLOY_MODE` to the mode that matches what you actually have.

### `config-epoch`
- **What it checks:** post-handover authority. `npm run handover` stamps `state/config-epoch.json` in the state bucket and writes `CCE_CONFIG_EPOCH` into the incoming operator's `.env`; this check compares the two. No recorded epoch (no handover ever completed) is a clean pass.
- **Why it fails:** this `.env` predates the recorded handover, which almost always means it is the DEPARTING operator's stale file. Deploying with it would silently re-point owner IDs and secrets back to the previous operator, so this is the one mutation-blocking check that protects a completed transfer. A warn (not fail) means the epoch object could not be read or is malformed, so the comparison is impossible.
- **Fix:** the incoming operator re-runs `npm run setup` against the recorded handover state, which writes the matching `CCE_CONFIG_EPOCH` into `.env`. A departing operator's stale `.env` must never deploy again. For a warn: restore S3 read access to the state bucket (or inspect the malformed `state/config-epoch.json`) before any deploy.

### `update-available`
- **What it checks:** informational only: whether a newer signed release exists on GitHub, and how far behind this checkout is. Verified via the pinned trust roots.
- **Why it never fails:** by design it is `pass` (verified result) or `skip` (disabled, unverifiable, or GitHub unreachable), never warn or fail; doctor must not go red because GitHub is down. `CCE_UPDATE_CHECK_DISABLED=1` skips it entirely and no request leaves the machine.
- **Fix:** nothing to fix. To move to the newer release: `npm run update -- <tag>` (one verified hop per tag; see [`UPGRADING.md`](./UPGRADING.md)).

### `magic-link-email`
- **What it checks:** whether dashboard email sign-in (magic links) can work: `CCE_EMAIL_FROM` and `CCE_DASHBOARD_URL` are both set in `.env`. Without them, every send fail-softs with reason `unconfigured`, so the login box's "email me a sign-in link" silently does nothing while the API still returns its constant 202 (by design, to prevent account enumeration).
- **Why it warns:** it never fails, because email login is optional. On a fresh deploy this warn is EXPECTED: the users table is empty (users come from invites, not self-signup) and the email vars are unset. The initial way into the dashboard is the bearer `DASHBOARD_TOKEN` from setup.
- **Fix:** sign in with `DASHBOARD_TOKEN` first. To enable email sign-in, set `CCE_EMAIL_FROM` to an identity you have verified in SES (plus SES production access if recipients are outside your verified identities) and `CCE_DASHBOARD_URL` to the dashboard URL, redeploy so the values reach the task, then invite users from the dashboard. Until an invited user is ACTIVE, no address receives links, again silently and by design.

## Verify (`npm run verify` = `npm run status -- --strict`)

Layer A is CloudFormation-derived, layer B compares values against the deploy manifest, layer C is external (and includes the two paid probes that only run under `--strict`).

> **Right after a deploy, some FAILs are just propagation.** `ecs-service-steady`, `dashboard-endpoint`, `waf-cloudfront`, and the two Bedrock probes can fail for a few minutes while ECS reaches steady state and CloudFront/WAF changes propagate. `npm run up` settles through exactly these automatically (30s cadence, 15-minute cap, printed as `SETTLING`); running verify by hand, re-run it a few minutes later before treating one of these as real. Everything else in this section fails because something is wrong, not because it is early.

### `stacks-live` (A)
- **What it checks:** live stacks named `<CDK_STACK_NAME>-*` exist and are all in a stable COMPLETE status.
- **Why it fails:** nothing is deployed yet; a stack is in a FAILED/ROLLBACK/DELETE state; warns on `UPDATE_ROLLBACK_COMPLETE` (the last update was rolled back) or an operation still in progress.
- **Fix:** fresh install: `npm run deploy`. Broken stack: `aws cloudformation describe-stack-events --stack-name <name> --region <region>` to find the first failed resource event, then see [`lifecycle.md`](./lifecycle.md) class 2 for infra rollback / `UPDATE_ROLLBACK_FAILED` recovery.

### `ecs-service-steady` (A)
- **What it checks:** the `claudeclaw-service` ECS service exists in `claudeclaw-cluster`, `runningCount == desiredCount`, desired is not zero, and no deployment has rollout state FAILED.
- **Why it fails:** the task is crash-looping (bad image, bad env, an x86 image on ARM64 Fargate), the service was scaled to zero (maintenance mode left on), or a deployment failed its circuit breaker.
- **Fix:** the service events panel and the CloudWatch log group `/claudeclaw/orchestrator` usually name the crash cause in the first stack trace. If the new image is the problem, `npm run deploy:rollback` (class 1 in [`lifecycle.md`](./lifecycle.md)). If scaled to zero, finish or unwind the maintenance procedure.

### `dashboard-endpoint` (A)
- **What it checks:** mode-aware HTTPS: chat mode probes `GET https://<DOMAIN_NAME>/ready` for 200; infra-only-with-domain probes `/health` plus a dashboard auth round-trip. Skipped for no-domain infra-only (no public endpoint exists by design; `private-posture` is the verification there).
- **Why it fails:** a 503 from `/ready` means the deployment is up but NOT ready for traffic, almost always placeholder secrets or a missing surface token; a connection failure means DNS does not resolve to the ALB or the cert/listener is not live.
- **Fix:** for 503: read the `/ready` response body and the task logs, populate the missing values it names, then force a new ECS deployment (secrets inject at task start). For connection errors: confirm DNS resolves to the ALB and the ACM cert / HTTPS listener are live (`domain-tls` in doctor covers the prerequisites).

### `private-posture` (A)
- **What it checks:** no-domain infra-only only: the ALB's scheme is `internal`, and no security-group rule opens any listener port to `0.0.0.0/0` or `::/0`. The verdict comes from the live network surface (listeners + SG rules), not the template's intent.
- **Why it fails:** the install was deployed with a domain or in chat mode earlier and the ALB is still internet-facing, or someone hand-widened a security group.
- **Fix:** redeploy with `CCE_DEPLOY_MODE=infra-only` and no `DOMAIN_NAME` so the Compute stack synthesizes the ALB internal, or set a domain + ACM cert if you actually want public HTTPS. Tighten any world-open SG ingress it lists.

### `dashboard-plain-http` (A)
- **What it checks:** in EVERY mode: an authenticated request to `http://<alb-dns>/api/agents` must not return 200 over plain HTTP. A redirect to HTTPS or a refused connection both pass.
- **Why it fails:** a public HTTP listener forwards to the service instead of redirecting, so bearer tokens would ride the wire unencrypted.
- **Fix:** make port 80 redirect to HTTPS (the domain + ACM path does this) or remove the public HTTP listener entirely. Never operate dashboard auth over plain HTTP.

### `ddb-tables-active` (A)
- **What it checks:** every DynamoDB table declared by the `<prefix>-Dynamo` stack (enumerated from stack resources, not a hardcoded list) is ACTIVE.
- **Why it fails:** a table was deleted out-of-band, or a restore left a table outside CloudFormation's ownership; both are CFN drift.
- **Fix:** see the data-restore notes in [`lifecycle.md`](./lifecycle.md) class 4, including the CloudFormation re-adoption step (`cdk import`).

### `messaging-queues-topics` (A)
- **What it checks:** the Messaging stack's SQS queues and SNS topics are recorded complete, plus a live probe of ONE sampled queue and ONE sampled topic (the detail says exactly what was sampled; the rest are CFN-record assertions).
- **Why it fails:** a queue or topic was deleted out-of-band; the CFN record says it exists but the live probe 404s.
- **Fix:** redeploy the Messaging stack so CloudFormation reconciles it.

### `storage-buckets` (A)
- **What it checks:** `HeadBucket` succeeds on every bucket the Storage stack declares.
- **Why it fails:** a bucket was deleted out-of-band (CFN drift), or a permissions change broke access.
- **Fix:** redeploy the Storage stack; investigate who deleted the bucket first, since its data is gone.

### `ecr-image` (A)
- **What it checks:** the private ECR repo exists and still holds the image tag the latest deploy manifest recorded. This is the rollback guarantee: if the tag is gone, rolling back to this deploy would have nothing to run.
- **Why it fails:** the repo was never created (bootstrap-state did not run), or a lifecycle policy pruned the per-deploy tag.
- **Fix:** missing repo: `npm run deploy` (bootstrap-state creates it before the first build). Missing tag: the lifecycle policy must keep per-deploy tags; re-push the image or run a fresh deploy to re-establish a rollback-able baseline.

### `scheduler-group` (A)
- **What it checks:** the EventBridge Scheduler group (named `claudeclaw[-suffix]`) exists and is ACTIVE; scheduled tasks fire schedules inside it.
- **Why it fails:** the group was deleted out-of-band, or a teardown half-completed.
- **Fix:** the Messaging stack owns the group; redeploy it.

### `waf-cloudfront` (A)
- **What it checks:** tier 2+: the regional WAF WebACL (`claudeclaw[-suffix]-web-acl`) exists; tier 3: the Security stack records a CloudFront distribution complete (CFN-derived; edge behavior is not live-probed here).
- **Why it fails:** the Security stack was skipped or failed at this tier, or the tier was raised without redeploying.
- **Fix:** redeploy the Security stack at this tier; WAF and CloudFront are tier-gated there.

### `manifest-present` (B)
- **What it checks:** a deploy manifest with the current schema version exists in the state bucket (`manifests/latest.json`).
- **Why it fails:** the install predates the manifest tooling, the state bucket is unreadable, or no deploy ever completed its promotion step.
- **Fix:** run a deploy with this version of the tooling (`npm run deploy`) so a current-schema manifest is promoted. Several other checks (secret freshness, ECR image pinning) degrade to warn/skip without it.

### `secret-versions-fresh` (B)
- **What it checks:** for every secret version the manifest recorded: the version id still exists (DescribeSecret only, never GetSecretValue) and is still `AWSCURRENT`. Honesty note printed by the check itself: placeholder (`REPLACE_ME`) detection without reading values is impossible, so placeholder detection rides the app's own `/ready` semantics.
- **Why it fails:** **missing** version means per-deploy labels were pruned or the secret was force-rotated, so secret rollback to this deploy is no longer possible (fail); **drifted** means someone moved `AWSCURRENT` after the deploy (warn).
- **Fix:** missing: run a fresh deploy to re-establish a rollback-able baseline. Drifted: if the rotation was intentional, the next deploy re-records versions; if not, investigate who moved `AWSCURRENT` (CloudTrail has the PutSecretValue event).

### `runtime-config-seed` (B)
- **What it checks:** every default row from `scripts/lib/seed-defaults.ts` exists in the runtime-config table.
- **Why it fails:** the seed phase was skipped (interrupted deploy), or the table was restored from an old export.
- **Fix:** `npm run seed`. It is idempotent and never overwrites values you have tuned; the deploy embeds the same step as phase (c).

### `external-slack` (C, strict-only)
- **What it checks:** with a Slack token configured: `auth.test` proves the token, and a synthetic **signed** request against your own `/slack/events` endpoint proves the signing secret matches what the deployment runs with. Reported as "token valid" vs "delivery verified", distinct statuses.
- **Why it fails:** a revoked/rotated bot token; a signing secret that differs between Slack's app config and the deployed secret; or Slack-side event-URL verification was never completed (that step is external, you do it once in the Slack app console).
- **Fix:** re-issue/re-populate the token or signing secret (then force a new ECS deployment so tasks restart onto it), and complete the event-URL verification in the Slack app's Event Subscriptions page. Day-to-day debugging: [`runbooks/debug-no-slack-response.md`](./runbooks/debug-no-slack-response.md).

### `external-telegram` (C, strict-only)
- **What it checks:** with Telegram tokens configured: `getMe` proves each token and `getWebhookInfo` must report exactly the expected `https://<DOMAIN_NAME>/...` webhook URL. Verify NEVER mutates (`register: false`): a mismatch fails with the manual fix rather than silently re-registering.
- **Why it fails:** the webhook was never registered (deploy ran before DNS resolved), points at an old domain, or was unset.
- **Fix:** the failure prints the exact manual command, shaped like: `curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" -d url=https://<domain>/tg/<agentId>/webhook -d secret_token=$TELEGRAM_WEBHOOK_SECRET` plus the allowed-updates list, then confirm with `getWebhookInfo`. Day-to-day debugging: [`runbooks/debug-no-telegram-response.md`](./runbooks/debug-no-telegram-response.md).

### `github-oidc` (C)
- **What it checks:** when `CCE_CICD_ENABLED=1`: the GitHub OIDC provider exists in the account with `sts.amazonaws.com` in its audience list.
- **Why it fails:** the provider was never created, or exists with the wrong audience (common when another team created it).
- **Fix:** `bash scripts/oidc-provider.sh` to create it; `aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn <arn> --client-id sts.amazonaws.com` to fix the audience.

### `codebuild-credential` (C)
- **What it checks:** when `CCE_CODEBUILD_ENABLED=1`: an account-level GITHUB source credential is imported in CodeBuild, without which tag-triggered builds cannot read the repo.
- **Why it fails:** nobody ran the one-time import; AWS cannot infer a GitHub credential.
- **Fix:** issue a GitHub PAT (external step), then `aws codebuild import-source-credentials --server-type GITHUB --auth-type PERSONAL_ACCESS_TOKEN --token <github-pat>`.

### `bedrock-probe-claude` (C, strict-only, PAID ~a cent)
- **What it checks:** one live Converse call (`maxTokens` 16, prompt "ping") against your configured Claude model WITH the configured guardrail attached. For cross-region inference profiles it first resolves the profile to its destination regions and checks model availability in each, stating plainly that one probe cannot force Bedrock to exercise every routed region.
- **Why it fails:** model access granted in the home region but missing in a profile destination region; a wrong `BEDROCK_GUARDRAIL_ID`/`VERSION` pair; or no Claude model configured at all.
- **Fix:** grant access to the named model in the named region (the remediation prints the per-region console URL). If the error names the guardrail, confirm `BEDROCK_GUARDRAIL_ID`/`BEDROCK_GUARDRAIL_VERSION` match the Guardrails stack outputs.

### `bedrock-probe-titan-embed` (C, strict-only, PAID, tiny)
- **What it checks:** when knowledge is enabled: one live `InvokeModel` embedding call against `BEDROCK_EMBED_MODEL` (default `amazon.titan-embed-text-v2:0`).
- **Why it fails:** Titan access missing in the region (the doctor grant check passed on a family match but the exact model differs, or the grant landed after a deploy to a different region).
- **Fix:** the embed model auto-enables on first invocation; confirm the exact model id exists in the deploy region's model catalog and that the deploy region matches where the grant landed.

### `bedrock-availability-image` (C)
- **What it checks:** when image gen is enabled: the image model the runtime will actually invoke (same resolution as `bedrock-grant-image`: `BEDROCK_IMAGE_MODEL` → `BEDROCK_NOVA_CANVAS_MODEL` → the Stability default) is listed as accessible in its serving region (us-west-2 for Stability). Availability ONLY: an image generation is not cheap, so it is deliberately not exercised.
- **Why it fails:** the model is pinned to Legacy-flagged Nova Canvas without historical access, or the model id/region is wrong.
- **Fix:** unset the pin to use the Stability default, fix `BEDROCK_IMAGE_MODEL` / `BEDROCK_IMAGE_REGION`, or disable image gen (`CCE_IMAGE_GEN_ENABLED=0`).

### `bedrock-availability-nova-sonic` (C)
- **What it checks:** when `JARVIS_LAUNCH_ENABLED` is on: an `amazon.nova-sonic*` model is listed as accessible. Availability ONLY: a speech invocation is not exercised.
- **Why it fails:** Nova Sonic access missing in the region.
- **Fix:** confirm `amazon.nova-sonic*` in the region's model catalog (it auto-enables on first invocation), or leave the Jarvis launch gate off.

## When a check is not the problem

- **`/ready` is 503 but every check passes:** secrets inject at task START. If you populated a secret after the tasks started, force a new ECS deployment.
- **A check warns about "could not check":** verify and doctor degrade to warn rather than fail when a read API is inaccessible; grant the missing read permission to your operator credentials and re-run rather than ignoring it forever.
- **Everything fails at once:** check `aws-identity` first. Nine times out of ten it is the wrong AWS profile.
