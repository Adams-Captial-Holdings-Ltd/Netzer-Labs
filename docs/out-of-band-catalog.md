# Out-of-band resource catalog

> Everything this app creates or depends on that `cdk destroy` cannot see.
> The machine-readable version is [`out-of-band-catalog.json`](./out-of-band-catalog.json);
> `scripts/teardown.ts` loads that file as one of its four inventory sources
> (live CloudFormation, the deploy manifest, this catalog, name-prefix scan).
> If you add an out-of-band resource anywhere — a CLI runbook, a deploy-script
> side effect, a runtime-created resource — it MUST get an entry here, or
> teardown will strand it.

Name patterns use three placeholders, resolved at teardown time:
`<suffix>` is the `CCE_NAME_SUFFIX` rendering (empty for prod, `-staging` for
staging — note the leading hyphen is part of the placeholder), `<account>` is
the AWS account id, `<region>` the deploy region.

## App-owned (teardown deletes these)

| id | kind | name / pattern | created by |
|----|------|----------------|------------|
| `state-bucket` | S3 bucket | `claudeclaw<suffix>-deploy-<account>-<region>` | bootstrap-state |
| `deploy-lock-table` | DynamoDB table | `claudeclaw<suffix>-deploy-lock` | bootstrap-state |
| `private-ecr-repo` | ECR repository | `claudeclaw<suffix>-orchestrator` | bootstrap-state |
| `agentcore-mcp-gateways` | AgentCore MCP gateway(s) | `cce-mcp-gateway-*` + service roles | CLI runbook (`docs/mcp/`) |
| `scheduler-group` | EventBridge Scheduler group | `claudeclaw<suffix>` | deploy script (`ensureSchedulerGroup`) |
| `runtime-eventbridge-schedules` | EventBridge Scheduler schedules | `schedule/claudeclaw<suffix>/*` | runtime (orchestrator) |
| `managed-policy-iam-copilot` | IAM managed policy | `CCE-IamCopilot` | CLI (live-attached) |
| `managed-policy-playground-nonanthropic` | IAM managed policy | `CCE-Playground-NonAnthropicInvoke` | CLI (live-attached) |
| `managed-policy-cost-remediation` | IAM managed policy | `CCE-CostRemediation` | CLI (live-attached) |
| `managed-policy-imagegen-stability` | IAM managed policy | `CCE-ImageGen-Stability` | CLI (live-attached) |

Notes that matter for ordering:

- The **three bootstrap primitives** (state bucket, deploy-lock table, private
  ECR repo) are created by `scripts/lib/lifecycle/bootstrap-state.ts` via the
  SDK, outside CDK, because deploys need them before the first stack exists.
  Teardown deletes them **last**: the manifest in the state bucket and the
  lifecycle lock in the table are what teardown itself runs on.
- **The scheduler group** is created idempotently by the deploy script
  (`ensureSchedulerGroup`), NOT by CloudFormation: existing installs created
  it out-of-band, and a CFN `AWS::Scheduler::ScheduleGroup` with the same
  explicit name would fail their next Messaging deploy with AlreadyExists.
  The Messaging stack owns only the group's *name*.
- **Runtime EventBridge schedules**: the schedules *inside* the group are app
  data. Teardown inventories and deletes them **before** deleting the group
  itself (`aws scheduler delete-schedule-group`) so deletion cannot wedge.
- The **three live-attached managed policies** (`CCE-IamCopilot`,
  `CCE-Playground-NonAnthropicInvoke`, `CCE-CostRemediation`) are detached from
  every entity before deletion (IAM refuses to delete an attached policy).
  Detaching is also each feature's documented kill switch, so this path doubles
  as revocation. `CCE-ImageGen-Stability` is a fourth catalog policy that
  teardown does NOT auto-remove — it grants the task role `bedrock:InvokeModel`
  on `arn:aws:bedrock:*::foundation-model/stability.*`; detach and delete it
  manually to revoke image generation entirely.

## App-owned but report-only

| id | why teardown cannot delete it |
|----|-------------------------------|
| `telegram-webhook` | The registration lives at `api.telegram.org`, not in AWS. Deleting it requires the bot token, and by the time teardown's final sweep runs, the Telegram secret is already schedule-deleted. The manual checklist prints the exact `curl .../deleteWebhook` command instead. |

## Shared account prerequisites (report-only by default)

These exist at the **account** level and may carry workloads that have nothing
to do with this app. Deleting them from a shared account can break unrelated
teams' CI. That is the WHY behind every report-only classification below: the
blast radius is not knowable from this app's own state alone, so teardown
refuses to guess.

| id | what breaks if you delete it |
|----|------------------------------|
| `github-oidc-provider` | IAM allows ONE provider per URL per account. Every IAM role in the account that trusts `token.actions.githubusercontent.com` — including other repos' GitHub Actions deploy roles — authenticates through this single object. Deleting it kills all of them simultaneously. |
| `codebuild-source-credential` | `import-source-credentials` stores ONE GitHub credential per provider for the account/region. Every CodeBuild project with a GitHub source shares it. Deleting it disconnects all of them, not just ours. |
| `cdk-bootstrap-stack` | `CDKToolkit` (asset bucket, asset ECR repo, deploy/exec roles) is the substrate for EVERY CDK app in the account/region. Removing it breaks all other CDK deployments, and recreating it rotates the deploy-role ARNs other pipelines may have pinned. |

`scripts/teardown.ts --delete-shared-prereqs` unlocks deletion of the first
two ONLY after a dependents scan (IAM roles whose trust policy references the
OIDC provider; CodeBuild projects with GitHub sources) prints the blast radius
and the operator passes an extra typed confirmation. The CDK bootstrap stack
stays report-only even then — teardown prints the removal commands and steps
aside.

## Deliberately NOT in this catalog

- **Cost Anomaly Detection monitor, anomaly subscription, and monthly budget**
  — these are CDK-owned (created inside `infra/lib/cost-guardrails-stack.ts`)
  and are destroyed with the `CCE-CostGuardrails` stack like any other stack
  resource. One exception to know about: when `CCE_ANOMALY_MONITOR_ARN` was
  set at synth, the stack *attached to a pre-existing shared monitor instead
  of creating one* (AWS allows exactly one DIMENSIONAL SERVICE monitor per
  account). That monitor was never ours; teardown must not touch it, and stack
  deletion correctly removes only our subscription.
- **The audit-lock (WORM) bucket** — CDK-owned (Storage stack, tier ≥ 2), but
  RETAIN'd and governance-locked. Teardown classifies it as an INTENTIONAL
  RESIDUAL and prints `bypass-governance-retention` instructions; see
  `scripts/teardown.ts` and plan item 26.
- **Slack app, Telegram bot (BotFather), Bedrock model-access grants** —
  external/console state no AWS API can remove. They live on teardown's
  closing manual checklist.
