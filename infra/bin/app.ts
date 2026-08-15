#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack.js';
import { StorageStack } from '../lib/storage-stack.js';
import { SecretsStack } from '../lib/secrets-stack.js';
import { DynamoStack } from '../lib/dynamo-stack.js';
import { IamStack } from '../lib/iam-stack.js';
import { GuardrailsStack } from '../lib/guardrails-stack.js';
import { ComputeStack } from '../lib/compute-stack.js';
import { ObservabilityStack } from '../lib/observability-stack.js';
import { MessagingStack } from '../lib/messaging-stack.js';
import { SecurityStack } from '../lib/security-stack.js';
import { BackupStack } from '../lib/backup-stack.js';
import { ChaosStack } from '../lib/chaos-stack.js';
import { ExtensionsStack } from '../lib/extensions-stack.js';
import { CodeBuildStack } from '../lib/codebuild-stack.js';
import { CostGuardrailsStack } from '../lib/cost-guardrails-stack.js';
import { PowerSwitchStack } from '../lib/power-switch-stack.js';
import { DemoResetStack } from '../lib/demo-reset-stack.js';
import { APP_NAME_SUFFIX } from '../lib/constants.js';
import type { DeployTier } from '../lib/constants.js';

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
};

// Tier is read from either DEPLOY_TIER (legacy) or the new CCE_TIER env.
const tier = Number(
  process.env.CCE_TIER ?? process.env.DEPLOY_TIER ?? '1',
) as DeployTier;
const stackPrefix = process.env.CDK_STACK_NAME ?? 'CCE';
const powerReservedConcurrency = Number(
  process.env.CCE_POWER_RESERVED_CONCURRENCY ?? '5',
);
if (!Number.isInteger(powerReservedConcurrency) || powerReservedConcurrency < 0) {
  throw new Error(
    'CCE_POWER_RESERVED_CONCURRENCY must be a non-negative integer',
  );
}

const baseProps = { env, tier };

// Foundation: no inter-stack dependencies
const network = new NetworkStack(app, `${stackPrefix}-Network`, baseProps);
const storage = new StorageStack(app, `${stackPrefix}-Storage`, baseProps);
const guardrails = new GuardrailsStack(app, `${stackPrefix}-Guardrails`, baseProps);

// Depends on storage (for KMS keys)
const secrets = new SecretsStack(app, `${stackPrefix}-Secrets`, {
  ...baseProps,
  dataKey: storage.dataKey,
});
const dynamo = new DynamoStack(app, `${stackPrefix}-Dynamo`, {
  ...baseProps,
  dataKey: storage.dataKey,
});

// Messaging depends on storage (configBucket for the EventBridge rule).
// A1 lifted this above IAM so the scheduler-exec role ARN is available
// to IAM grants on the task role (PassRole + scheduler:*).
const messaging = new MessagingStack(app, `${stackPrefix}-Messaging`, {
  ...baseProps,
  configBucket: storage.configBucket,
});

// IAM with least-privilege grants from storage, secrets, dynamo, and
// messaging (A1: scheduler:* + PassRole on the scheduler exec role).
const iam = new IamStack(app, `${stackPrefix}-Iam`, {
  ...baseProps,
  storage,
  secrets,
  dynamo,
  messaging,
});

// Compute consumes network (VPC + SGs), iam (task role), secrets (for env injection)
const compute = new ComputeStack(app, `${stackPrefix}-Compute`, {
  ...baseProps,
  vpc: network.vpc,
  albSecurityGroup: network.albSecurityGroup,
  fargateSecurityGroup: network.fargateSecurityGroup,
  taskRole: iam.taskRole,
  secrets,
  logsBucket: storage.logsBucket,
  messaging,
});

// Observability depends on storage (logsKey + logsBucket)
const observability = new ObservabilityStack(app, `${stackPrefix}-Observability`, {
  ...baseProps,
  logsKey: storage.logsKey,
  logsBucket: storage.logsBucket,
  // Outside-in reachability probe. Same hostname the Cloudflare tunnel
  // publishes, so the probe fails exactly when users see Error 1033.
  publicHostname: process.env.CCE_PUBLIC_HOSTNAME?.trim() || undefined,
  // Ops alert destination. The topic existed with zero subscribers until
  // 2026-08-15, so every alarm published into a void.
  opsAlertEmail: process.env.CCE_OPS_ALERT_EMAIL?.trim() || undefined,
});

// Security stack: WAFv2 only provisioned for tier >= 2 (otherwise the
// stack creates no resources but still resolves cleanly).
const security = new SecurityStack(app, `${stackPrefix}-Security`, {
  ...baseProps,
  albArn: compute.albArn,
  alertTopic: observability.alertTopic,
  logsBucket: storage.logsBucket,
  // While paused (origin dark), CloudFront 302s page loads to the power
  // panel so the dashboard URL is never a dead end. Same env var the
  // dashboard /api/power proxy uses as its runtime-config fallback.
  powerPanelUrl: process.env.CCE_POWER_URL,
});
security.addDependency(compute);
security.addDependency(observability);
security.addDependency(storage);

// A4: daily DDB → S3 export Lambda + cron + alarms. Gated on T1+ inside
// the stack itself; the construct is always declared so the dependency
// graph stays uniform across tiers.
const backup = new BackupStack(app, `${stackPrefix}-Backup`, {
  ...baseProps,
  logsBucket: storage.logsBucket,
  alertTopic: observability.alertTopic,
  tableArns: [
    dynamo.sessionsTable.tableArn,
    dynamo.hiveMindTable.tableArn,
    dynamo.auditLogTable.tableArn,
    dynamo.chatConfigTable.tableArn,
    dynamo.tokenUsageTable.tableArn,
    dynamo.memoriesTable.tableArn,
    dynamo.consolidationsTable.tableArn,
    dynamo.agentFileHistoryTable.tableArn,
    dynamo.missionTasksTable.tableArn,
    dynamo.scheduledTasksTable.tableArn,
    dynamo.killSwitchesTable.tableArn,
    dynamo.interAgentTasksTable.tableArn,
    dynamo.compactionEventsTable.tableArn,
    dynamo.queueLeaseTable.tableArn,
    dynamo.identitiesTable.tableArn,
    dynamo.hookIdempotencyTable.tableArn,
    dynamo.spawnLedgerTable.tableArn,
    dynamo.extensionSubnetPoolTable.tableArn,
    dynamo.extensionsRegistryTable.tableArn,
    dynamo.warroomMeetingsTable.tableArn,
    dynamo.warroomTurnsTable.tableArn,
    dynamo.warroomConnectionsTable.tableArn,
    dynamo.rateLimitsTable.tableArn,
  ],
});
backup.addDependency(dynamo);
backup.addDependency(storage);
backup.addDependency(observability);

// F3: AWS FIS experiment templates (tier >= 2 only). The stack
// resolves cleanly at lower tiers — it just emits no resources.
const chaos = new ChaosStack(app, `${stackPrefix}-Chaos`, {
  ...baseProps,
  taskRoleArn: iam.taskRole.roleArn,
});
chaos.addDependency(compute);
chaos.addDependency(iam);

// v5.6: Extensions infrastructure (bucket, DLQs, alarms)
const extensions = new ExtensionsStack(app, `${stackPrefix}-Extensions`, {
  ...baseProps,
  dataKey: storage.dataKey,
  alertTopic: observability.alertTopic,
});
extensions.addDependency(storage);
extensions.addDependency(observability);

// Mark stack-level dependencies so cdk deploy resolves order automatically
// VPC Flow Logs write to the storage stack's logs bucket; the bucket
// policy in storage must exist before the flow log is created.
network.addDependency(storage);
secrets.addDependency(storage);
dynamo.addDependency(storage);
iam.addDependency(storage);
iam.addDependency(secrets);
iam.addDependency(dynamo);
compute.addDependency(network);
compute.addDependency(iam);
compute.addDependency(observability); // log group must exist before ECS task def references it
compute.addDependency(messaging);
observability.addDependency(storage);
messaging.addDependency(storage);
iam.addDependency(messaging);

// Push-based cost guardrails (Cost Anomaly Detection + monthly Budget).
// Standalone: imports nothing from the other stacks, so it deploys in
// isolation via `cdk deploy CCE-CostGuardrails --exclusively`.
const costGuardrails = new CostGuardrailsStack(app, `${stackPrefix}-CostGuardrails`, {
  ...baseProps,
});

// Demo pause/wake control plane (Phase B). Isolated like CostGuardrails: imports
// nothing, so `cdk deploy CCE-PowerSwitch --exclusively` can never drift the
// Compute/Network stacks. The Lambda runs with no VPC config so a deep NAT cut
// cannot strand the very thing that brings prod back.
const powerSwitch = new PowerSwitchStack(app, `${stackPrefix}-PowerSwitch`, {
  ...baseProps,
  // Nightly auto-pause is OFF unless an environment explicitly arms it, and
  // production can never arm it — PowerSwitchStack throws at synth if it tries.
  // A pause sets desiredCount=0, which removes every cloudflared connector and
  // serves Cloudflare 1033 until a human calls wake through the Function URL;
  // there is no wake schedule. Staging may opt in with
  // CCE_POWER_AUTO_PAUSE_ENABLED=1, matching the fail-closed convention used by
  // CCE_CODEBUILD_ENABLED and CCE_DEMO_RESET_ENABLED below.
  autoPauseEnabled:
    APP_NAME_SUFFIX !== '' && process.env.CCE_POWER_AUTO_PAUSE_ENABLED === '1',
  // Prefix, not exact name: the CDK-generated alarm name carries a random
  // suffix. This alarm is treatMissingData=BREACHING, so it fires the whole
  // time the service is intentionally at 0 tasks — mute it during a pause.
  mutedAlarms: [`${stackPrefix}-Observability-SchedulerStalledAlarm`],
  // Optional: powers the end-to-end health probe + panel links/cost copy.
  // Same env var the magic-link emails use for the public dashboard URL.
  dashboardUrl: process.env.CCE_DASHBOARD_URL,
  costNote: process.env.CCE_POWER_COST_NOTE,
  reservedConcurrency: powerReservedConcurrency,
});

void guardrails;
void powerSwitch;
void costGuardrails;
void compute;
void observability;
void messaging;
void security;
void backup;
void chaos;
void extensions;

// CodeBuild: image-only deploys triggered by GitHub push.
// Gated on CCE_CODEBUILD_ENABLED=1 so the project only materializes
// when explicitly opted in. Fail closed: the GitHub repo identity has
// no default — a default would wire a newcomer's CodeBuild project to
// the upstream repository. The account-level GitHub source credential
// (`aws codebuild import-source-credentials`) is an operator
// prerequisite, created out-of-band before enabling this flag.
if (process.env.CCE_CODEBUILD_ENABLED === '1') {
  const githubOwner = process.env.CCE_GITHUB_OWNER?.trim();
  const githubRepo = process.env.CCE_GITHUB_REPO?.trim();
  if (!githubOwner || !githubRepo) {
    throw new Error(
      'CCE_CODEBUILD_ENABLED=1 requires CCE_GITHUB_OWNER and CCE_GITHUB_REPO ' +
        'to be set explicitly (no default). Set them to YOUR GitHub org/user ' +
        'and repository name.',
    );
  }
  const codebuild = new CodeBuildStack(app, `${stackPrefix}-CodeBuild`, {
    ...baseProps,
    githubOwner,
    githubRepo,
    githubBranch: process.env.CCE_GITHUB_BRANCH?.trim() || 'main',
  });
  codebuild.addDependency(iam);
  void codebuild;
}

// Public-demo nightly reset (a Lambda + daily cron that scrubs conversational
// tables and visitor-created agents, preserving the seed fleet). Fail-closed
// like CodeBuild: only materializes when CCE_DEMO_RESET_ENABLED=1, so prod
// deploys never create it. Point it at a dedicated demo deployment. The seed
// ids mirror SEED_AGENT_IDS in scripts/demo/seed.ts (the fleet to preserve).
if (process.env.CCE_DEMO_RESET_ENABLED === '1') {
  const demoReset = new DemoResetStack(app, `${stackPrefix}-DemoReset`, {
    ...baseProps,
    alertTopic: observability.alertTopic,
    configBucket: storage.configBucket,
    agentsTable: dynamo.agentsTable,
    seedAgentIds: [
      'support',
      'sdr',
      'social',
      'marketing-strategist',
      'community-manager',
      'bookkeeper',
    ],
    wipeTables: [
      dynamo.sessionsTable,
      dynamo.memoriesTable,
      dynamo.hiveMindTable,
      dynamo.consolidationsTable,
      dynamo.missionTasksTable,
      dynamo.scheduledTasksTable,
      dynamo.interAgentTasksTable,
      dynamo.warroomMeetingsTable,
      dynamo.warroomTurnsTable,
      dynamo.warroomConnectionsTable,
      dynamo.chatConfigTable,
      dynamo.tokenUsageTable,
      dynamo.auditLogTable,
      dynamo.rateLimitsTable,
      dynamo.compactionEventsTable,
    ],
  });
  demoReset.addDependency(dynamo);
  demoReset.addDependency(storage);
  demoReset.addDependency(observability);
  void demoReset;
}

app.synth();
