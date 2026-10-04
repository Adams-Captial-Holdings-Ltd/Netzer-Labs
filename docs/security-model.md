# Security model

> Netzar OS Enterprise runs inside your own AWS account: the model calls go to Amazon Bedrock, the state lives in your DynamoDB and S3, and the app ships no third-party telemetry of its own. Data does leave your account in a small, named set of cases, chat platforms you connect, web-search vendors you give keys to, MCP servers you register, and build-time package registries, and every one of those flows is listed in a machine-readable inventory in this folder. This page explains who can touch what (IAM roles and their blast radius), where secrets live, how the audit trail is retained, what the network can reach, and what to harden before you put real data on it.

This is the page that backs the "runs entirely in your AWS account" claim with specifics. Serious adopters should read it before deploying.

## The data-flow inventory is the source of truth

Every external data flow lives in [`data-flows.json`](./data-flows.json), one entry per processor with what leaves, when, and how to opt out. The table below is rendered from that file by hand; when this page and the JSON disagree, the JSON wins, and any PR that adds a new outbound call must add an entry there.

| Flow | Processor | What leaves | When | Opt out |
|---|---|---|---|---|
| `slack-payloads` | Slack | Message text, user/channel ids, agent replies | Slack connected | Don't connect Slack; `slack_posting` kill switch |
| `telegram-payloads` | Telegram | Messages, chat ids, voice/photo/PDF media, replies | Telegram connected | Don't connect Telegram; `telegram_posting` kill switch |
| `bedrock-prompts` | Amazon Bedrock (AWS, in-account boundary) | Full prompts: system prompt, memories, hive notes, history, attachments | Every agent turn | `bedrock_global` kill switch halts all calls |
| `web-search-tavily` / `-brave` / `-exa` / `-serper` | Tavily, Brave, Exa, Serper | Search query text (PII-gated) | The matching key is set and `web_search` runs | Unset the key; `web_search_disabled`; `CCE_WEB_SEARCH_PII_POLICY=refuse` |
| `google-gemini` | Google | Nothing today, see below | Never (no runtime consumer) | Leave `GOOGLE_GEMINI_API_KEY` unset |
| `mcp-tool-endpoints` | Whatever MCP servers you register | Tool arguments and results | Servers registered in runtime-config `mcp/servers` | Remove the server; `tool_use` kill switch |
| `ses-outbound-email` | SES to arbitrary recipients | Model-generated email body + recipients | `CCE_EMAIL_FROM` set, `send_email` invoked | Unset it; `email_send_disabled` |
| `npm-registry-build` | npm registry | Package names/versions, build-machine IP | Every image build | Private registry mirror |
| `container-registries-build` | Docker Hub / ECR Public | Base-image pulls | Every image build | Mirror base images |
| `codebuild-github-credential` | GitHub | Repo contents into CodeBuild via a stored PAT | `CCE_CODEBUILD_ENABLED=1` | Keep the flag off, deploy locally |
| `github-actions-ci` | GitHub | CI logs/artifacts on GitHub infra; OIDC deploys when enabled | Workflows run | Disable Actions; keep `CCE_CICD_ENABLED` off |
| `github-releases-update-check` | GitHub | Egress IP + timing only, no payload | Active: daily backend releases check (`src/lib/updates/discovery.ts`, wired via the dashboard handler) | `CCE_UPDATE_CHECK_DISABLED=1` (implemented; zero network calls when set) |

Two honesty notes baked into the inventory:

- **Gemini.** `GOOGLE_GEMINI_API_KEY` is plumbed end-to-end (vendor-keys secret, task env, zod schema) but no code in `src/` calls Google today. The entry exists so the provisioned key is not invisible; it is marked `provisioned-unused`.
- **Web-search PII gate.** The query about to leave for a search vendor passes an outbound PII check first. `CCE_WEB_SEARCH_PII_POLICY` is `refuse | redact (default) | allow`; see [`src/lib/tools/web-search-tools.ts`](../src/lib/tools/web-search-tools.ts).

## The telemetry claim, stated narrowly

**There is no app-owned third-party telemetry.** No analytics SDK, no crash reporter, no usage phone-home, no vendor beacon is compiled into the orchestrator or the dashboard SPA.

What DOES leave, so the claim cannot be misread as "nothing ever leaves":

- Build-time pulls from npm and public container registries (every image build).
- GitHub traffic when CI is enabled, including workflow logs stored on GitHub.
- Chat payloads to Slack and Telegram, the surfaces you connected.
- Prompts to Amazon Bedrock (an AWS service; see model privacy below).
- Search queries to the vendor whose key you configured, and MCP traffic to the servers you registered.
- AWS-native logs, metrics, traces, and audit records, which stay inside the customer account (CloudWatch, X-Ray, CloudTrail, the audit table and WORM bucket).
- A daily GitHub releases check (backend-side, fail-silent) that reveals only egress IP and timing, opt out with `CCE_UPDATE_CHECK_DISABLED=1` (inventory entry `github-releases-update-check`, `src/lib/updates/discovery.ts`).

## Model and data privacy assumptions

All model invocation goes through Amazon Bedrock: Claude (Opus/Sonnet/Haiku), Titan embeddings, Nova Canvas, Nova Sonic. Per AWS's service terms, Bedrock does not use customer inputs or outputs to train models, and prompts are processed within the AWS regions your configuration targets. Two qualifiers worth knowing:

- **Cross-region inference profiles** (`us.anthropic...` model ids) route requests among a set of destination AWS regions. `npm run verify` resolves the configured profile to its destination regions and checks model access in each, and is explicit that one successful probe cannot force Bedrock to exercise every routed region.
- A **Bedrock Guardrail** (12 PII entity types, 6 content filters) is attached to every Converse call unless the `guardrail_disabled` kill switch is on or a turn explicitly skips it (the War Room transcript shape trips the prompt-attack filter; that skip is per-turn and documented in [`src/agent/agent-loop.ts`](../src/agent/agent-loop.ts)). Guardrail-blocked turns are never persisted to session history.

## IAM roles and their blast radius

| Role | Created by | What it can do | Blast radius if compromised |
|---|---|---|---|
| **Task role** (`infra/lib/iam-stack.ts`, `TaskRole`) | CDK | The orchestrator's runtime identity: Bedrock invoke, the app's DDB tables and S3 buckets, SQS/SNS/Scheduler, Polly/Transcribe/SES, Secrets Manager reads for the app's secret paths, and `ecs:UpdateTaskProtection` / `ecs:GetTaskProtection` scoped to this cluster's tasks (an attempt in progress keeps its task from scale-in). Explicit IAM **Deny** on DeleteItem/UpdateItem/DeleteTable for the audit-log table | App data and model spend in this account. Cannot rewrite audit history, cannot touch CDK roles |
| **Task execution role** (`infra/lib/compute-stack.ts`, `executionRole`) | CDK | Pull the image from private ECR and resolve Secrets Manager values into the container at task start | Secret values it is scoped to, image pulls. No app-data access |
| **Deploy identity** (your CLI credentials + the CDK bootstrap roles) | You / `cdk bootstrap` | Full stack create/update/destroy. `npm run deploy` runs under whatever admin-level profile you configured | The whole install. Protect it like root |
| **GitHub OIDC deploy role** (`ClaudeClawGitHubDeploy`, opt-in) | CDK when `CCE_CICD_ENABLED=1` | Deploy from GitHub Actions. Trust is fail-closed: synth errors without an explicit `CCE_GITHUB_OWNER`/`REPO`, the trust condition pins exact `sub` subjects (never repo-wide) and requires the `sts.amazonaws.com` audience | Deploys from your repo's approved refs only; a fork can never inherit it |
| **CodeBuild service role** (opt-in, `CCE_CODEBUILD_ENABLED=1`) | CDK | Build + push images, image-only ECS roll | Image supply chain for the service. Anyone who can push a deploy tag ships code; protect tag creation |
| **Drift-check role** (`CDK_DIFF_ROLE_ARN` workflow secret) | CLI/out-of-band | Read-only `cdk diff` from the daily drift workflow | Read access to stack templates and the synth inputs |
| **Opt-in managed policies** (`CCE-IamCopilot`, `CCE-Playground-NonAnthropicInvoke`, `CCE-CostRemediation`) | CDK constructs gated by env flags, or attached live via CLI on existing installs | Each arms one dashboard feature (gated IAM apply, non-Anthropic Playground models, cost remediation). `CCE-IamCopilot` carries its own Deny protecting the task and CDK roles | Detach the policy to revoke the capability entirely; all three are listed in the [out-of-band catalog](./out-of-band-catalog.md) |

## Secrets

- **Where they live:** AWS Secrets Manager, six entries per install under `/claudeclaw[-suffix]/`: `slack`, `telegram`, `dashboard`, `db-encryption`, `bedrock-guardrails`, `vendor-keys` (the optional Tavily/Brave/Exa/Serper/Gemini keys; moved out of plain task-def env so synth artifacts and CloudFormation templates contain no key material).
- **How they reach the app:** injected as env vars **at task start** via ECS Secrets Manager value resolution (`infra/lib/compute-stack.ts`). Changing a secret does nothing to running tasks until a new ECS deployment forces a restart; the deploy and rollback tooling does that for you.
- **Templates stay clean:** CDK creates secrets with `REPLACE_ME` placeholders; real values are written post-stack by the deploy's phase (b) with per-deploy staging labels, and recorded version ids make secret rollback (`docs/lifecycle.md`, class 3) possible.
- **Encryption:** customer-managed KMS keys cover the S3 buckets and DDB tables (three CMK aliases: `-data`, `-curated`, `-logs`). KMS keys are treated as dependencies at teardown, never casually deleted (see [`lifecycle.md`](./lifecycle.md) and the teardown tooling).
- **Placeholder discipline:** the app treats `REPLACE_ME` and `<your-...>` shaped values as "not configured" everywhere (`src/config/env.ts`), so a half-populated secret can never arm a tool with a garbage key, and `/ready` stays 503 until the deploy mode's real requirements are met.

## Audit retention

Every audited action (agent turns, tool invokes, kill-switch blocks, exports, IAM applies) is written by [`src/lib/audit/audit-writer.ts`](../src/lib/audit/audit-writer.ts):

- **Hot path:** the `claudeclaw-audit-log` DynamoDB table, day-partitioned. The task role carries an explicit IAM Deny on DeleteItem/UpdateItem/DeleteTable, so the app cannot rewrite its own history.
- **Cold path (tier 2 and up):** an S3 **Object Lock** bucket in governance mode with 2555-day (7-year) default retention (`infra/lib/storage-stack.ts`). T0/T1 deliberately skip the WORM bucket (cost and teardown honesty: for its retention window a governance-mode object can only be deleted by a principal holding `s3:BypassGovernanceRetention` — it is tamper-resistant, not the absolute immutability of Object Lock *compliance* mode); the audit writer no-ops cleanly when the bucket is absent.
- An optional PII redaction pass (`pii_redaction_enabled` kill switch) regex-scrubs email/SSN/CC/phone/AWS-key/JWT/IPv4 shapes from audit detail strings before write.

## Outbound network posture

- **VPC:** 2 AZs, private subnets for the Fargate tasks. Egress rides NAT gateways (1 at T0, 2 at T1+; see the tier table in [`cost-guide.md`](./cost-guide.md)).
- **VPC endpoints:** the free gateway endpoints (S3, DynamoDB) are always on, so bulk data traffic never crosses NAT. The ~15 **interface** endpoints are opt-in via `CCE_PRIVATE_ENDPOINTS=1` and default OFF: with NAT present the tasks already reach every AWS API over TLS, and the interface-endpoint set costs roughly $175–220/month depending on tier (≈$0.01 per endpoint per AZ per hour × 2 AZs, rate confirmed against live AWS pricing 2026-07: ~12 always-on endpoints ≈ $175, plus ~3 more at T2+, plus data-processing). Turn them on when PrivateLink isolation matters more than cost.
- **VPC Flow Logs** to S3 at T1+ (90 days to Glacier, 730-day expiry).
- **Inbound:** the ALB terminates TLS with an ACM cert. In the no-domain `infra-only` mode the ALB is synthesized **internal**, there is no public listener at all, and access is an SSM port-forward (`npm run dashboard:tunnel`); `npm run verify` scans live listeners and security groups and fails if any public path reaches the dashboard, and fails in **every** mode if dashboard auth answers on plain HTTP.
- **Edge (tier-gated):** WAFv2 on the ALB at T2+ (rate limit + AWS managed rule groups), CloudFront + GuardDuty + AWS Config at T3.

## Paperclip runtime lock

Paperclip, the work engine, runs as a private container beside the orchestrator. It must never become a second AI runtime: [ADR 0014](adr/0014-netzer-only-ai-runtime.md) keeps its native runner, local adapters and remote profiles off and fails closed. Three controls hold that line.

- **The Paperclip task's environment** makes the adapter, plugin and feedback settings operator-managed, allows only the `http` adapter, and turns Paperclip's own call-home off: `PAPERCLIP_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1` and `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false` (`infra/lib/paperclip-stack.ts`, mirrored in `docker-compose.paperclip.yml`).
- **A live check in the orchestrator.** At start and every 60 s it reads the five conditions (native runner off, no non-http agent, no remote profile, no tool access, no timer heartbeat) through one read-only company-member key, the **lock auditor** (`lock_auditor_key` in the Paperclip secret). A violation at start makes the orchestrator refuse to start, so the deploy fails and rolls back. A Paperclip that cannot be read starts the orchestrator with the Paperclip surface closed until a later read is clean. Each verdict change is logged once as `paperclip lock verdict`, with codes and never a credential. The check runs while Paperclip routing is on (`CCE_PAPERCLIP_ENABLED`); with the flag off it does not read, and the latch is closed with `unknown:paperclip_routing_off`, so the Paperclip surface answers a real non-2xx (decision 36; see the ADR). A verdict that has not been refreshed for five minutes, for example because a read never settles, closes the surface as `lock_check_stale`.
- **A private dispatch listener.** Paperclip reaches the orchestrator on port 3001, open to Paperclip's security group only. The public app answers 404 for the dispatch route. In front of that port sits an internal Network Load Balancer whose security group admits only the Paperclip security group on 3001 (the orchestrator's group admits only the load balancer's and Paperclip's groups there). The route checks the bearer secret first, then the runtime lock, then draining, so a caller learns nothing about lock or drain state without the secret. With the lock closed it answers 503 `paperclip_locked` and never touches an attempt row.

`scripts/paperclip-bootstrap.ts` creates the auditor. **Rotation is manual:** set `lock_auditor_key` to `REPLACE_ME` in the Paperclip secret and run the bootstrap, which creates a new auditor and a new key. Then **roll the orchestrator service** (a new deployment): ECS reads secrets only when a task starts, so a running task keeps the old value (or `REPLACE_ME`) and its lock reads `unknown` until it is replaced. Rotation does not revoke the old key: remove the old auditor's board key and membership in Paperclip after the roll. Residuals: the auditor key is a long-lived read-only member key, and a read-only member can read the full agent rows, which hold the dispatch bearer, so a leak exposes company work data and the means to forge a dispatch from inside Paperclip's security group; the lock reads an http agent's adapter type, not where it points; a violation read at start refuses every start of the orchestrator (a deploy, a scale-out, a crash restart), so one Paperclip toggle can become an outage until it is reverted; a retired auditor's key keeps working as a viewer until an operator revokes it; a bootstrap run that fails before it saves the secret leaves an orphan auditor too; tool gateways are not read at start; a violation that appears while running is caught within 60 s; log redaction covers the known secret field names at the top level and one level down, not arbitrary content.

## AI steps cannot write (step 5)

A turn that Paperclip dispatches is an AI step. An AI step reads, analyzes, recommends and drafts. It does not write to a business system ([ADR 0013](adr/0013-sync-attach-execution-contract.md), "Deterministic writes only"). The agent loop enforces this with a tool policy (`src/lib/tools/tool-policy.ts`, applied in `src/agent/agent-loop.ts`). The dispatch worker (`src/lib/paperclip/dispatch-worker.ts`) runs every dispatched turn with `toolPolicy: { aiStep: true }`.

- **Built-in tools: default deny.** In an AI step, a built-in tool runs only when its handler is marked `readOnly: true`. An unmarked tool counts as a write, and so does a tool the registry does not know. Only a handler that creates, updates, deletes or sends nothing on any store or outside system may be marked. The marked tools are `get_time`, `list_agents`, `dynamodb_query`, `search_hive`, `list_memories`, `search_memories`, `list_missions`, `salesforce_query`, `list_scheduled_tasks` and `s3_vectors_search`. `read_artifact` and `web_search` are not marked, because their handlers write audit rows or can disable a pattern, so an AI step cannot call them.
- **Remote tools.** In an AI step, a remote (MCP) tool runs only when the role allowlist names it. With no allowlist, every remote tool is denied in an AI step.
- **Role allowlist.** The allowlist is the top-level `tools` key in the agent's `agents/<id>/agent.yaml` in the config bucket, loaded with the agent's other config (`src/lib/config/agent-loader.ts`). It applies in every turn, not only in AI steps. The loader parses the file as YAML and reads only that key. These cases hold:
  - A missing `agent.yaml` is normal. It means no allowlist.
  - An empty file, a file with only comments, and a file with no top-level `tools` key mean no allowlist.
  - A `tools` value that is a list of strings is the allowlist. An empty list (`tools: []`) allows nothing.
  - Any other shape denies every tool: a value that is not a list of strings, a top-level value that is not a mapping, or YAML that does not parse. The loader logs a warning with the agent ID and returns an empty list.
  - A storage error other than "not found" while reading the file fails the turn with `AgentConfigUnavailableError`. The result is not cached, so the next turn reads the file again.

  An AI step stays default-deny when there is no allowlist, so a missing allowlist never lets an AI step write. An allowlist cannot grant a write to an AI step: a name on the list still has to be read-only, or remote and named, to run there.
- **Two checks.** The policy is applied to the list of tools offered to the model, and again at dispatch, because the model can name a tool that was never offered. The existing per-agent `allowedAgents` check and the War Room tool blocklist still apply.
- **Denied calls.** A denied call is not run. The model gets an error tool result, and the call is audited as `tool_invoke` with `result: blocked` and `detail.reason` set to `not_in_role_allowlist` or `write_denied_in_ai_step`. The warning log line holds IDs and the reason only.
- **Agent Paperclip writes need a run.** `paperclip_add_comment` and `paperclip_create_subtask` refuse before any Paperclip call when the turn holds no run (A109, A119). Humans act through their own keys (step 6) and the work screens (step 7).

Every turn has a `turnId`, minted when `runAgentTurn` starts. It is returned on the turn result, passed to the tools, written in the turn's log lines and written in the `agent_turn` audit row with `runId`, `issueId` and `attemptNo` when the caller gave them.

Every tool call writes one `tool_invoke` audit row with the tool name, the agent, the chat, the surface, the result (`ok`, `error` or `blocked`) and a `detail` of `turnId`, `toolCallId`, `argsHash` (a sha256 of the arguments) and the run, issue and attempt IDs when known. A row never holds the arguments, the result or error text. The write is fire-and-forget, so a failing audit store never breaks a turn, and the `audit_log_disabled` kill switch can drop these rows. A few tool handlers (for example the Paperclip tools and `send_email`) also write their own `tool_invoke` row, so one call can have two rows.

Known limits, recorded and not fixed in step 5 (they are taken up in step 16, security and audit depth):

- `tool_invoke` rows are not in the always-audited set, so the `audit_log_disabled` kill switch drops them.
- Some handlers write a second `tool_invoke` row of their own, so one call can have two rows.
- The effect ledger table shares the task role's general table grant, which includes delete and scan.
- A read error on an agent's `CLAUDE.md` still falls back to the built-in persona. The allowlist is read separately from `agent.yaml` and fails closed (above).
- A remote tool name that is cut to fit the name limit can map two remote tools to one name (this was already so before step 5).
- `--by` on `pack effect resolve` is self-asserted. In a customer's account the customer admin runs the command (decision 18).

Writes made through the effect executor are audited separately. `effect_applied`, `effect_unknown` and `effect_resolved` are always-audited actions and carry IDs and hashes only (see the ADR). The executor is a library in step 5; the completion write on the dispatch path is not ledgered yet.

## Human approvals (step 6)

A person's decision is recorded in Paperclip under that person's own identity, and what runs is exactly what they approved ([ADR 0016](adr/0016-human-decisions-via-shadow-users.md)). The code is a library (`src/lib/work/approvals.ts`) and an operator command line; the dashboard route that calls it is step 7. None of it has run against a real Paperclip or a real AWS account; the live proofs are pending.

- **Who can decide.** Only a Netzer user with an active shadow user, who holds the approval's decision class. Each approver has a headless Paperclip user (a slot) with its own board key. An agent key, an operator, the instance admin and the lock auditor can never be the recorded decider: `verifyApproval` reads the approval live and refuses with `not_a_shadow_user` when the decider has no registry row. A retired approver's decision counts only if it was made before retirement. A registry row that does not validate counts as absent, so verification fails closed.
- **The hash binding.** The approval's payload is the sha256 of the exact L1 payload plus the case, stage, step, round and decision class. The executor re-hashes the payload it is about to apply. A changed payload, another case, stage, step or round, or another class is refused (`hash_mismatch`, `key_mismatch`, `class_mismatch`) before any write. Only an `approved` status passes.
- **The comment rule.** A comment is required for Reject and Request Changes and optional for Approve. Paperclip enforces none, so Netzer does.
- **Where the board keys are.** Two secrets, both outside `/<app>/paperclip*`, so the deploy role's Paperclip secret grant does not reach them. `/<app>/shadow-approvers` holds only the board keys (`{v:1, slots:{<slot>:{boardKey|null}}}`). The orchestrator's task role can read it (`secretsmanager:GetSecretValue` on that one ARN, no write) and nothing else of the pair. `/<app>/shadow-approvers-setup` holds the slot logins (`{v:1, slots:{<slot>:{email,password}}}`). No service has a grant on it; only the operator's own credentials read and write it, because the running service never needs the passwords. A key or password is never in an error message or a log line.
- **Known limit (A153).** `decide()` trusts the `netzerUserId` its caller passes, and the task role can write the users table that holds the registry rows. Step 7's route must take the user from the authenticated session, never from the request body. Registry-row write access is taken up in step 16.
- **Audit.** `approval_requested`, `approval_decided`, `approval_refused`, `shadow_assigned`, `shadow_rotated` and `shadow_retired` are always-audited actions. Their details hold IDs and hashes only (a comment is a hash, never text), never a payload, a key or an email. Every refusal leaves an `approval_refused` row. If Paperclip names someone other than the shadow user as the decider, the row is `approval_refused` with result `error` and code `attribution_mismatch`, and the call throws; it is never audited as `approval_decided`, and the other user's id is not recorded.
- **Sign-up is closed and probed.** The Paperclip task runs with `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` unless a deploy sets the window switch `CCE_PAPERCLIP_SIGNUP_WINDOW=open`. The runtime lock proves it at start and every 60 s with a probe: an open sign-up is the violation `sign_up_open`, and during a window the verdict is `unknown` and the Paperclip surface stays closed ([ADR 0014](adr/0014-netzer-only-ai-runtime.md)). After a deploy, the orchestrator's start-time lock is the real check: with sign-up open and no window the new task refuses to start. The deploy script probes only when `PAPERCLIP_BASE_URL` is set, because the deploy host cannot reach Paperclip's private address. There is no network block of sign-up in this step (owner).
- **Not covered here:** a slot password cannot be rotated at the pinned Paperclip (A149); the board keys are long-lived until the operator runs `rotate`; the first live proofs (S6-L1 to S6-L5) are PENDING.

## Surface authentication

- **Slack:** HMAC signature verification on the raw body with a 5-minute replay window, on `/slack/events`, `/slack/commands`, and `/slack/interactive`. A missing signing secret fails **closed** (requests rejected, 401). Verification is unconditional — there is no `slack_signature_check_disabled` kill switch (it was removed as an auth-bypass primitive); break-glass for a broken secret is to close ingress, not to accept unsigned traffic.
- **Telegram:** the `x-telegram-bot-api-secret-token` header is checked against `TELEGRAM_WEBHOOK_SECRET` on every update; a missing secret fails closed the same way (401), and verification is likewise unconditional — there is no `telegram_signature_check_disabled` switch; break-glass is closed ingress.
- **Dashboard:** capability-based auth (magic-link sessions, bearer `DASHBOARD_TOKEN`, or minted tokens), each resolving to a permission profile (viewer to owner). The backend enforces; the SPA only hides UI.

## Production hardening steps

In rough priority order for an install that will hold real data:

1. **Run `npm run verify` after every deploy** and treat any FAIL as a stop-ship; it covers the HTTPS posture, secret freshness, and the live Bedrock probe. Failures are catalogued in [`troubleshooting.md`](./troubleshooting.md).
2. **Set a realistic daily cost cap** (runtime-config `cost/daily_cap_usd`) and deploy the standalone CostGuardrails stack (Budget + Anomaly Detection emails).
3. **Pick the right tier**: T2+ for WAF and the WORM audit bucket, T3 for CloudFront/GuardDuty/Config. See [`cost-guide.md`](./cost-guide.md).
4. **Keep the guardrail on** and leave `CCE_WEB_SEARCH_PII_POLICY` at `redact` or move to `refuse`.
5. **Scope MCP servers**: register only HTTPS endpoints, prefer IAM-auth AgentCore gateways over bearer-token vendors, and use the per-server agent allowlist.
6. **Rotate on schedule**: dashboard token and CloudFront origin secret runbooks live in [`runbooks/`](./runbooks/README.md).
7. **Leave the opt-in IAM features off** (`iam/apply_enabled` runtime-config, the three managed policies) until you need them; detaching the policy is the kill switch of last resort.
8. **If you enable CI deploys**, protect the deploy refs/tags on the GitHub side; the OIDC trust is pinned, but tag-triggered CodeBuild ships whatever an authorized tag points at.
9. **Consider `CCE_PRIVATE_ENDPOINTS=1`** when your compliance posture requires AWS API traffic to stay on PrivateLink.
10. **Know your residuals before teardown**: the WORM bucket and KMS keys are intentional residuals with documented handling ([`out-of-band-catalog.md`](./out-of-band-catalog.md), [`lifecycle.md`](./lifecycle.md)).
