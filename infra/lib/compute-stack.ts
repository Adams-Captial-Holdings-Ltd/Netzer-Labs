import { Stack, Duration, CfnOutput, RemovalPolicy, SecretValue } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { execSync } from 'node:child_process';

/**
 * Deterministic deploy marker: the git commit being deployed. Used for
 * DEPLOY_SHA so `cdk diff` is a true clean/dirty signal (a synth timestamp
 * would make CCE-Compute perpetually "drifted"). Falls back to '' when git
 * isn't available so synth never fails.
 */
function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
import { Repository } from 'aws-cdk-lib/aws-ecr';
import {
  Cluster,
  ContainerInsights,
  ContainerImage,
  CpuArchitecture,
  FargateTaskDefinition,
  LogDrivers,
  OperatingSystemFamily,
  FargateService,
  Protocol as EcsProtocol,
  Secret as EcsSecret,
  PropagatedTagSource,
} from 'aws-cdk-lib/aws-ecs';
import { SubnetType, type IVpc, type SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  TargetType,
  ListenerAction,
  ListenerCertificate,
  ListenerCondition,
  type ApplicationListener,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Role, ServicePrincipal, PolicyStatement, Effect, type IRole } from 'aws-cdk-lib/aws-iam';
import { Secret as SmSecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import {
  APP,
  BEDROCK_MODELS,
  RESOURCE_NAMES,
  TAGS,
  TIERS,
  bucketName,
  paperclipProvisioned,
} from './constants.js';
import {
  cloudFrontOriginSecret,
  ORIGIN_HEADER_NAME,
} from './cf-origin-secret.js';
import { resolveDeployMode } from './deploy-mode.js';
import {
  resolvePublicDashboardAccess,
  assertPublicEntrypointRenderable,
  PUBLIC_TUNNEL_SECRET_NAME,
} from './public-dashboard-access.js';
import type {
  BaseStackProps,
  ComputeOutputs,
  SecretsOutputs,
  MessagingOutputs,
} from './interfaces.js';

export interface ComputeStackProps extends BaseStackProps {
  vpc: IVpc;
  albSecurityGroup: SecurityGroup;
  fargateSecurityGroup: SecurityGroup;
  taskRole: IRole;
  secrets: SecretsOutputs;
  logsBucket: IBucket;
  /** A1: messaging outputs (scheduled-fire queue + scheduler exec role). */
  messaging: MessagingOutputs;
}

/**
 * Fargate task definition, ECS service, ALB, target group, auto-scaling.
 *
 * Per Codex #29 + #30: desired count = 2 spread across 2 AZs so the ALB
 * always has a healthy target during deploys, replacements, and AZ events.
 *
 * Per Codex #31: ALB idle timeout = 4000s for SSE. The orchestrator must
 * still send heartbeat comments below this threshold; the timeout is just
 * the ceiling.
 *
 * The container image is imported from ECR by name. The deploy script
 * (`scripts/deploy.ts`) is responsible for creating the repo and pushing
 * the image BEFORE this stack deploys.
 */
export class ComputeStack extends Stack implements ComputeOutputs {
  public readonly albDnsName: string;
  public readonly albArn: string;
  public readonly cluster: Cluster;
  public readonly service: FargateService;
  public readonly loadBalancer: ApplicationLoadBalancer;
  /**
   * HTTPS:443 listener, so another stack can attach a rule (Paperclip, ADR
   * 0010 Phase 2). Undefined when DOMAIN_NAME is unset: no cert, no listener.
   * Adding a rule: priorities 1-2 are taken, and at cloudFrontEnabled tiers
   * the default action is 403, so a new rule needs its own condition.
   */
  public readonly httpsListener?: ApplicationListener;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const account = this.account;
    const region = this.region;
    const tier = TIERS[props.tier];

    // ── Deployment mode (IaC readiness: no-domain `infra-only`) ─────
    // `privateAccessOnly` is true ONLY for CCE_DEPLOY_MODE=infra-only with no
    // DOMAIN_NAME: the ALB is then synthesized INTERNAL in private subnets,
    // so plain-HTTP public dashboard auth is impossible by construction and
    // the only access path is the SSM port-forward tunnel
    // (`npm run dashboard:tunnel`). For every existing chat-mode deploy
    // (CCE_DEPLOY_MODE unset/`chat`, or a domain set) this flag is false and
    // every branch below is a no-op against today's synth.
    const { privateAccessOnly, mode: deployMode } = resolveDeployMode(process.env);
    // Public dashboard access (pgnos design, Task 3). Resolved here so an
    // invalid combination fails at synth, before anything is created. Off by
    // default, so this is a guaranteed no-op for every existing deploy.
    const publicAccess = resolvePublicDashboardAccess(process.env);

    // ── Import ECR repo (deploy script creates it before this stack runs) ──
    const ecrRepo = Repository.fromRepositoryName(
      this,
      'OrchestratorRepo',
      RESOURCE_NAMES.ecrRepo,
    );

    // ── Per-deploy image pin (IaC readiness item 9) ─────────────
    // Task definitions never reference the mutable `latest` tag: rollback
    // re-deploying an archived template must reproduce the rolled-back
    // image, not whatever `latest` points at. The deploy pipeline passes
    // the immutable per-deploy tag via CCE_IMAGE_TAG (deploy.ts and the
    // CI workflow both set it to the git short sha they pushed);
    // DEPLOY_SHA / local git are the fallback so a bare `cdk synth`
    // still resolves to a deterministic, commit-addressed tag.
    const imageTag =
      process.env.CCE_IMAGE_TAG?.trim() || process.env.DEPLOY_SHA?.trim() || gitSha() || 'dev';

    // ── ECS cluster ─────────────────────────────────────────────
    this.cluster = new Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: RESOURCE_NAMES.ecsCluster,
      containerInsightsV2: ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
    });

    // ── Log group (imported by deterministic name from observability) ──
    const logGroup = LogGroup.fromLogGroupName(
      this,
      'OrchestratorLogGroup',
      RESOURCE_NAMES.logGroupOrchestrator,
    );

    // ── Task execution role (in this stack to avoid cross-stack cycle) ──
    // CDK's EcsSecret.fromSecretsManager automatically grants the
    // execution role read on the secret. Keeping the role local avoids
    // the bidirectional cross-stack reference.
    const taskExecutionRole = new Role(this, 'TaskExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS task execution role for ClaudeClaw orchestrator',
    });
    taskExecutionRole.addToPolicy(
      new PolicyStatement({
        sid: 'EcrAuth',
        effect: Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    taskExecutionRole.addToPolicy(
      new PolicyStatement({
        sid: 'EcrPull',
        effect: Effect.ALLOW,
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: [ecrRepo.repositoryArn],
      }),
    );
    taskExecutionRole.addToPolicy(
      new PolicyStatement({
        sid: 'Logs',
        effect: Effect.ALLOW,
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:aws:logs:${region}:${account}:log-group:/claudeclaw/*`],
      }),
    );

    // Re-import secrets and KMS key by ARN. We do this to prevent CDK's
    // auto-grant from modifying the source stack's resource policies,
    // which would create a cross-stack dependency cycle.
    const reimportSecret = (id: string, arn: string): SmSecret =>
      SmSecret.fromSecretCompleteArn(this, id, arn) as SmSecret;
    const slackSecret = reimportSecret('SlackSecretImport', props.secrets.slackSecret.secretArn);
    const telegramSecret = reimportSecret(
      'TelegramSecretImport',
      props.secrets.telegramSecret.secretArn,
    );
    const dashboardSecret = reimportSecret(
      'DashboardSecretImport',
      props.secrets.dashboardSecret.secretArn,
    );
    const dbEncryptionSecret = reimportSecret(
      'DbEncryptionSecretImport',
      props.secrets.dbEncryptionSecret.secretArn,
    );
    const guardrailsSecret = reimportSecret(
      'GuardrailsSecretImport',
      props.secrets.bedrockGuardrailsSecret.secretArn,
    );
    const vendorKeysSecret = reimportSecret(
      'VendorKeysSecretImport',
      props.secrets.vendorKeysSecret.secretArn,
    );
    // Paperclip bridge credentials (ADR 0010). Safe to inject on day one even
    // though the fields still read REPLACE_ME: secrets-stack.ts creates
    // `agent_keys`, `reconciler_key` and `dispatch_secret` with the secret
    // itself, deploy phase b merge-adds `company_id`, and src/config/env.ts
    // declares each with optionalNonPlaceholder(), so a placeholder resolves
    // to "unset" rather than to a bad credential. A missing FIELD would be different in kind: it
    // fails the task at START with a ResourceInitializationError. That is the
    // cloudflared rollout failure, and it is why these are added now rather
    // than left for a later "when the values exist" commit.
    const paperclipSecret = reimportSecret(
      'PaperclipSecretImport',
      props.secrets.paperclipSecret.secretArn,
    );

    // Grant exec role secretsmanager + KMS decrypt manually
    const allSecretArns = [
      props.secrets.slackSecret.secretArn,
      props.secrets.telegramSecret.secretArn,
      props.secrets.dashboardSecret.secretArn,
      props.secrets.dbEncryptionSecret.secretArn,
      props.secrets.bedrockGuardrailsSecret.secretArn,
      props.secrets.vendorKeysSecret.secretArn,
      // Paperclip work engine (ADR 0010). The execution role grants on a FIXED
      // ARN list, so a secret this task definition later injects but that is
      // missing from this list fails the task at START with a
      // ResourceInitializationError — before any container runs, so it reads as
      // a rollout failure, not an application error. Granted here ahead of the
      // Phase 2 client's EcsSecret lines for exactly the reason the cloudflared
      // token grant is held open unconditionally: re-attaching an injection
      // must be a one-step change, never permission-plus-container.
      props.secrets.paperclipSecret.secretArn,
      // The Aurora-generated credentials secret. Named, not passed: DatabaseStack
      // is gated off and is not a prop of this stack, and taking it as one would
      // make the whole compute plane depend on a flag. The trailing `-*` covers
      // Secrets Manager's six-character ARN suffix, which is not knowable at
      // synth time.
      `arn:aws:secretsmanager:${region}:${account}:secret:${RESOURCE_NAMES.secrets.paperclipDb}-*`,
    ];
    taskExecutionRole.addToPolicy(
      new PolicyStatement({
        sid: 'SecretsRead',
        effect: Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: allSecretArns,
      }),
    );
    // KMS decrypt comes via the default CMK key policy granting account root +
    // any IAM principal with explicit kms:Decrypt. Add the explicit grant.
    taskExecutionRole.addToPolicy(
      new PolicyStatement({
        sid: 'KmsDecryptForSecrets',
        effect: Effect.ALLOW,
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `secretsmanager.${region}.amazonaws.com`,
          },
        },
      }),
    );

    // ── Task definition ─────────────────────────────────────────
    const taskDef = new FargateTaskDefinition(this, 'TaskDef', {
      family: RESOURCE_NAMES.taskFamily,
      cpu: tier.fargateCpu,
      memoryLimitMiB: tier.fargateMemoryMb,
      runtimePlatform: {
        operatingSystemFamily: OperatingSystemFamily.LINUX,
        // ARM64 (Graviton). Matches Apple Silicon dev machines so builds are
        // native (no QEMU emulation) and Fargate Graviton is ~20% cheaper.
        cpuArchitecture: CpuArchitecture.ARM64,
      },
      taskRole: props.taskRole,
      executionRole: taskExecutionRole,
    });

    // ── Container ───────────────────────────────────────────────
    taskDef.addContainer('orchestrator', {
      image: ContainerImage.fromEcrRepository(ecrRepo, imageTag),
      containerName: 'orchestrator',
      portMappings: [{ containerPort: 3000 }],
      essential: true,
      logging: LogDrivers.awsLogs({
        streamPrefix: 'task',
        logGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        LOG_LEVEL: 'info',
        AWS_REGION: region,
        DEPLOY_SHA: process.env.DEPLOY_SHA ?? gitSha(),
        AWS_ACCOUNT_ID: account,
        // Make the deploy mode explicit on the running task. The readiness
        // (/ready) and startup fail-fast (loadEnv) logic in env.ts key off this;
        // without it set, a deployed task previously read it as undefined and
        // the prod config fail-fast never ran. Sourced from resolveDeployMode so
        // chat vs infra-only requirements are evaluated correctly.
        CCE_DEPLOY_MODE: deployMode,
        // Bedrock model IDs. The deploy environment can override via
        // BEDROCK_*_MODEL env vars (local `npm run deploy` reads them
        // from .env). When unset (e.g. CI deploys, which don't carry
        // the .env file), we fall back to the canonical inference
        // profile IDs in BEDROCK_MODELS. Result: CI deploys produce a
        // working task def without having to plumb model IDs through
        // workflow inputs.
        BEDROCK_OPUS_MODEL: process.env.BEDROCK_OPUS_MODEL || BEDROCK_MODELS.opus,
        BEDROCK_SONNET_MODEL: process.env.BEDROCK_SONNET_MODEL || BEDROCK_MODELS.sonnet,
        BEDROCK_DEFAULT_MODEL:
          process.env.BEDROCK_DEFAULT_MODEL ||
          process.env.BEDROCK_SONNET_MODEL ||
          BEDROCK_MODELS.sonnet,
        BEDROCK_HAIKU_MODEL: process.env.BEDROCK_HAIKU_MODEL || BEDROCK_MODELS.haiku,
        BEDROCK_OPUS_1M_MODEL: process.env.BEDROCK_OPUS_1M_MODEL || BEDROCK_MODELS.opus1m,
        BEDROCK_SONNET_1M_MODEL: process.env.BEDROCK_SONNET_1M_MODEL || BEDROCK_MODELS.sonnet1m,
        BEDROCK_EMBED_MODEL:
          process.env.BEDROCK_EMBED_MODEL || BEDROCK_MODELS.embedTitanV2,
        CONFIG_BUCKET: bucketName(RESOURCE_NAMES.configBucket, account, region),
        RAW_BUCKET: bucketName(RESOURCE_NAMES.rawBucket, account, region),
        CURATED_BUCKET: bucketName(RESOURCE_NAMES.curatedBucket, account, region),
        VECTORS_STAGING_BUCKET: bucketName(RESOURCE_NAMES.vectorsStagingBucket, account, region),
        // The durable vector index. Deliberately NOT the staging bucket: they
        // shared one bucket until 2026-08, and the staging expiry deleted the
        // whole knowledge base. Keep these two pointing at different buckets.
        VECTORS_BUCKET: bucketName(RESOURCE_NAMES.vectorsBucket, account, region),
        // Tier-gated with the WORM bucket (plan item 26): T0/T1 have no
        // audit-lock bucket, so pass '' — empty string reads as "unset"
        // through env.ts's optional schema, and the audit writer no-ops
        // cleanly on a falsy bucket (single debug log, no error spam).
        AUDIT_LOCK_BUCKET:
          props.tier >= 2 ? bucketName(RESOURCE_NAMES.auditLockBucket, account, region) : '',
        CCE_TIER: String(props.tier),
        CCE_TIER_LABEL: tier.label,
        // Sourced ONLY from the tier default at deploy (never process.env), so a
        // stray CCE_DAILY_COST_CAP_USD in the deploy shell can't cut the cap.
        // Operators change it live via runtime-config (cost/daily_cap_usd), which
        // getEffectiveCostCap() prefers over this env value.
        CCE_DAILY_COST_CAP_USD: String(tier.dailyCostCapDefaultUsd),
        CCE_SCHEDULER_TICK_SEC: process.env.CCE_SCHEDULER_TICK_SEC ?? '30',
        CCE_XRAY_ENABLED: tier.xrayEnabled ? '1' : '0',
        // Canary runs on T1+ (matches tier.flowLogsEnabled today).
        CCE_CANARY_ENABLED: tier.flowLogsEnabled ? '1' : '0',
        // Vendor keys for the optional capability tools moved to Secrets
        // Manager (see the `secrets:` block below) so the keys never land
        // in the synthesized CloudFormation template. REPLACE_ME
        // placeholders are normalized to "unset" by src/config/env.ts and
        // the tool registry skips registration.
        CCE_EMAIL_FROM: process.env.CCE_EMAIL_FROM ?? '',
        // Base URL for magic-link login/invite emails (buildMagicLink reads
        // CCE_DASHBOARD_URL ?? DASHBOARD_URL). MUST be wired here or a cdk deploy
        // drops it and every magic-link send skips with reason "unconfigured" —
        // the user still sees "check your email" but nothing is sent.
        CCE_DASHBOARD_URL: process.env.CCE_DASHBOARD_URL ?? '',
        // Optional SES configuration set magic-link sends route through, so
        // bounce/complaint events publish to SNS + addresses auto-suppress.
        CCE_SES_CONFIG_SET: process.env.CCE_SES_CONFIG_SET ?? '',
        CCE_IMAGE_GEN_ENABLED: process.env.CCE_IMAGE_GEN_ENABLED ?? '1',
        CCE_TTS_ENABLED: process.env.CCE_TTS_ENABLED ?? '1',
        TABLE_SESSIONS: RESOURCE_NAMES.ddb.sessions,
        TABLE_HIVE_MIND: RESOURCE_NAMES.ddb.hiveMind,
        TABLE_AUDIT_LOG: RESOURCE_NAMES.ddb.auditLog,
        TABLE_CHAT_CONFIG: RESOURCE_NAMES.ddb.chatConfig,
        TABLE_TOKEN_USAGE: RESOURCE_NAMES.ddb.tokenUsage,
        TABLE_MEMORIES: RESOURCE_NAMES.ddb.memories,
        TABLE_CONSOLIDATIONS: RESOURCE_NAMES.ddb.consolidations,
        TABLE_AGENT_FILE_HISTORY: RESOURCE_NAMES.ddb.agentFileHistory,
        TABLE_MISSION_TASKS: RESOURCE_NAMES.ddb.missionTasks,
        TABLE_SCHEDULED_TASKS: RESOURCE_NAMES.ddb.scheduledTasks,
        TABLE_KILL_SWITCHES: RESOURCE_NAMES.ddb.killSwitches,
        TABLE_INTER_AGENT_TASKS: RESOURCE_NAMES.ddb.interAgentTasks,
        TABLE_COMPACTION_EVENTS: RESOURCE_NAMES.ddb.compactionEvents,
        TABLE_QUEUE_LEASE: RESOURCE_NAMES.ddb.queueLease,
        TABLE_SPEND_LEDGER: RESOURCE_NAMES.ddb.spendLedger,
        TABLE_IDENTITIES: RESOURCE_NAMES.ddb.identities,
        TABLE_DASHBOARD_TOKENS: RESOURCE_NAMES.ddb.dashboardTokens,
        TABLE_RUNTIME_CONFIG: RESOURCE_NAMES.ddb.runtimeConfig,
        TABLE_RATE_LIMITS: RESOURCE_NAMES.ddb.rateLimits,
        // Wave 4a: multi-user + RBAC. User profiles + magic-link tokens.
        TABLE_USERS: RESOURCE_NAMES.ddb.users,
        TABLE_AGENTS: RESOURCE_NAMES.ddb.agents,
        // Jarvis voice co-pilot (Phase 1).
        TABLE_JARVIS_TICKETS: RESOURCE_NAMES.ddb.jarvisTickets,
        TABLE_JARVIS_LEASES: RESOURCE_NAMES.ddb.jarvisLeases,
        TABLE_JARVIS_LEDGER: RESOURCE_NAMES.ddb.jarvisLedger,
        TABLE_JARVIS_CANARY: RESOURCE_NAMES.ddb.jarvisCanary,
        // War Room (M12). Without these the repos fall back to the unsuffixed
        // literals in src/lib/warroom/*, so a suffixed environment asks for
        // production's tables and is denied. Production is unaffected: its
        // ${app} prefix IS that fallback.
        TABLE_WARROOM_MEETINGS: RESOURCE_NAMES.ddb.warroomMeetings,
        TABLE_WARROOM_TURNS: RESOURCE_NAMES.ddb.warroomTurns,
        TABLE_WARROOM_CONNECTIONS: RESOURCE_NAMES.ddb.warroomConnections,
        // Launch gate (H7). Jarvis is GA in prod, so the default is now 'true' —
        // baked into the CDK so an infra deploy can never silently disable it
        // (a previous `cdk deploy` reset this to false and 503'd the manifest).
        // The jarvis_disabled kill switch is the runtime on/off (no redeploy); a
        // non-prod env can still force it off with JARVIS_LAUNCH_ENABLED=false.
        JARVIS_LAUNCH_ENABLED: process.env.JARVIS_LAUNCH_ENABLED ?? 'true',
        // Operability knobs — defaults mirror src/config/env.ts so the task is
        // behaviourally identical to today until an operator overrides one.
        NOVA_SONIC_MODEL: process.env.NOVA_SONIC_MODEL ?? 'amazon.nova-2-sonic-v1:0',
        // Jarvis speaks with Nova 2 Sonic's NATIVE audio. 'amy' is Nova's en-GB
        // (British) voice — Nova has no British MALE voice, so this is the closest
        // butler fit and the chosen GA voice.
        JARVIS_VOICE_ID: process.env.JARVIS_VOICE_ID ?? 'amy',
        JARVIS_MAX_SESSION_SECONDS: process.env.JARVIS_MAX_SESSION_SECONDS ?? '420',
        JARVIS_MAX_CONCURRENT_SESSIONS: process.env.JARVIS_MAX_CONCURRENT_SESSIONS ?? '5',
        // Polly is NO LONGER Nova's voice (Nova speaks natively), but it IS the
        // voice for spoken narration on the text path (guided routine chips) and
        // the Telegram voice adapter. This MUST be a FEMALE en-GB Polly voice
        // matching the Nova persona 'amy' above. 'Amy' on the GENERATIVE engine
        // sounds warm and natural (neural is more robotic); a male voice (e.g.
        // Brian) mismatches the persona. JARVIS_TTS_RATE is the SSML prosody rate
        // that keeps narration brisk rather than slow.
        JARVIS_TTS_VOICE_ID: process.env.JARVIS_TTS_VOICE_ID ?? 'Amy',
        JARVIS_TTS_ENGINE: process.env.JARVIS_TTS_ENGINE ?? 'generative',
        JARVIS_TTS_LANGUAGE: process.env.JARVIS_TTS_LANGUAGE ?? 'en-GB',
        JARVIS_TTS_RATE: process.env.JARVIS_TTS_RATE ?? '116%',
        // The opening line Nova is scripted to speak (greet-first). Name-templated
        // so it honors profile/first_name; buildGreetingLine ignores any STATIC
        // override, so the configured name (not a hardcoded honorific) drives it.
        JARVIS_GREETING:
          process.env.JARVIS_GREETING ?? 'Good to see you, {name}. What can I help you with?',
        NOVA_HTTP2_TIMEOUT_MS: process.env.NOVA_HTTP2_TIMEOUT_MS ?? '470000',
        // A1: EventBridge Scheduler integration. When CCE_USE_IN_PROCESS_SCHEDULER=1
        // the orchestrator ignores these and falls back to the legacy
        // DDB-polling tick in src/agent/scheduler.ts.
        SCHEDULED_FIRE_QUEUE_URL: props.messaging.scheduledFireQueueUrl,
        SCHEDULED_FIRE_QUEUE_ARN: props.messaging.scheduledFireQueueArn,
        SCHEDULER_GROUP_NAME: props.messaging.schedulerGroupName,
        SCHEDULER_ROLE_ARN: props.messaging.schedulerExecutionRoleArn,
        CCE_USE_IN_PROCESS_SCHEDULER:
          process.env.CCE_USE_IN_PROCESS_SCHEDULER ?? '0',
        // D5: status page filters CloudWatch alarms by this prefix and
        // reads CFN stack events for this stack.
        CCE_RESOURCE_PREFIX: APP,
        CCE_COMPUTE_STACK: this.stackName,
        // Ops alert SNS topic ARN. The topic itself is owned by
        // observability-stack (RESOURCE_NAMES.alertTopic), but that stack
        // synthesizes AFTER compute, so we cannot take it as a prop without
        // reordering the app graph. The topic name is deterministic, so we
        // rebuild the ARN here from account + region exactly the way the
        // SNS publish IAM policy already targets claudeclaw-* topics. The
        // alert-recipient console uses this to Subscribe / Unsubscribe an
        // operator email on the existing topic; no new topic is created.
        CCE_ALERT_TOPIC_ARN: `arn:aws:sns:${region}:${account}:${RESOURCE_NAMES.alertTopic}`,
        // Config-invalidation SNS topic ARN. The topic itself is owned by
        // messaging-stack (RESOURCE_NAMES.configInvalidationTopic) and is
        // already passed in via props.messaging, so there is no cross-stack
        // cycle. We still rebuild the ARN deterministically from account +
        // region the same way CCE_ALERT_TOPIC_ARN is handled, keeping the
        // env value stable regardless of synthesis order. Each task uses
        // this to subscribe an ephemeral SQS queue for fast config-cache
        // fanout and to Publish invalidation messages on write. This only
        // speeds up cache invalidation; the in-process 30s cache poll
        // remains the correctness fallback if the fanout is unavailable.
        CCE_CONFIG_TOPIC_ARN: `arn:aws:sns:${region}:${account}:${RESOURCE_NAMES.configInvalidationTopic}`,
        // ── Tier B security-posture reads (/api/posture/*) ──────────
        // Identifiers the posture routers use to target describe / get
        // calls. All metadata only; no secret VALUES are exposed here.
        // The CloudTrail trail name is deterministic from constants.
        CCE_CLOUDTRAIL_NAME: RESOURCE_NAMES.cloudTrailName,
        // KMS key alias names (deterministic). The KMS posture card uses
        // ListAliases + GetKeyRotationStatus; these aliases let it map a
        // green/amber/red rotation card to each of our CMKs by name.
        CCE_KMS_DATA_KEY_ALIAS: RESOURCE_NAMES.dataKeyAlias,
        CCE_KMS_CURATED_KEY_ALIAS: RESOURCE_NAMES.curatedKeyAlias,
        CCE_KMS_LOGS_KEY_ALIAS: RESOURCE_NAMES.logsKeyAlias,
        // Secret ARNs (metadata target for secretsmanager:DescribeSecret).
        // The posture reader returns name + last-rotated + ARN suffix only,
        // never a secret value.
        CCE_SECRET_SLACK_ARN: props.secrets.slackSecret.secretArn,
        CCE_SECRET_TELEGRAM_ARN: props.secrets.telegramSecret.secretArn,
        CCE_SECRET_DASHBOARD_ARN: props.secrets.dashboardSecret.secretArn,
        CCE_SECRET_DB_ENCRYPTION_ARN: props.secrets.dbEncryptionSecret.secretArn,
        CCE_SECRET_BEDROCK_GUARDRAILS_ARN: props.secrets.bedrockGuardrailsSecret.secretArn,
        CCE_SECRET_VENDOR_KEYS_ARN: props.secrets.vendorKeysSecret.secretArn,
        // Since Phase 9 this is a RUNTIME flag and NOTHING ELSE: it is what
        // `paperclipRoutingEnabled()` reads to decide whether the
        // `/api/missions*` ACL is registered in front of the legacy handlers.
        // It no longer decides what synth produces — the Paperclip stacks are
        // always constructed and tier-gated internally — so provisioning the
        // engine and serving from it are now separately switchable, which is
        // the whole point: the substrate lands first and the router flips
        // later, as its own reviewed change. Unset (or anything but '1'/true)
        // leaves the legacy stack serving, which stays the safe default.
        CCE_PAPERCLIP_ENABLED: process.env.CCE_PAPERCLIP_ENABLED ?? '',
        // WHERE the engine is, which is a different question from whether the
        // router is on above. This did not exist anywhere under infra/ before:
        // PAPERCLIP_BASE_URL was read by src/lib/paperclip/config.ts and set by
        // nothing, so a standard install provisioned a Paperclip the
        // orchestrator had no address for.
        //
        // It is the Cloud Map record paperclip-stack registers, built from the
        // same RESOURCE_NAMES constant rather than passed across stacks:
        // CCE-Compute is created BEFORE CCE-Paperclip (Paperclip imports this
        // stack's cluster and listener), so a reference the other way is a
        // cycle. This is the pattern RESOURCE_NAMES exists for — deterministic
        // names so the task can be configured without a CDK output.
        //
        // IT DOES NOT FIGHT THE RUNTIME-CONFIG PLANE, and that was checked
        // against the reader rather than assumed. `loadPaperclipConfig()` in
        // src/lib/paperclip/config.ts resolves
        // `baseUrl: configured ?? env.PAPERCLIP_BASE_URL`, where `configured`
        // is runtime-config `paperclip/base_url` — which
        // scripts/lib/seed-defaults.ts deliberately does NOT seed ("an instance
        // URL's default is absence, not a tunable"). So this env var is what
        // the client actually reads today, and an operator can still override
        // it with a config write, no deploy, exactly as C-19 intends.
        //
        // Gated on the SAME predicate that decides whether the engine is
        // provisioned at all. At Tier 0 there is no Paperclip, and setting a
        // URL there would turn `PaperclipDisabledError` ("no base URL", with
        // the remediation) into a DNS failure inside a fetch.
        ...(paperclipProvisioned(props.tier)
          ? { PAPERCLIP_BASE_URL: RESOURCE_NAMES.paperclipInternalUrl }
          : {}),
      },
      secrets: {
        SLACK_BOT_TOKEN: EcsSecret.fromSecretsManager(slackSecret, 'bot_token'),
        SLACK_SIGNING_SECRET: EcsSecret.fromSecretsManager(slackSecret, 'signing_secret'),
        TELEGRAM_TOKENS_JSON: EcsSecret.fromSecretsManager(telegramSecret, 'tokens'),
        TELEGRAM_WEBHOOK_SECRET: EcsSecret.fromSecretsManager(telegramSecret, 'webhook_secret'),
        DASHBOARD_TOKEN: EcsSecret.fromSecretsManager(dashboardSecret, 'token'),
        // Emergency kill phrase: any chat message containing it trips the
        // panic freeze (src/agent/agent-loop.ts). deploy phase b writes the
        // kill_phrase field on every deploy BEFORE this task def rolls, so
        // the key always exists when ECS resolves it.
        EMERGENCY_KILL_PHRASE: EcsSecret.fromSecretsManager(dashboardSecret, 'kill_phrase'),
        APP_ENCRYPTION_KEY: EcsSecret.fromSecretsManager(dbEncryptionSecret, 'key'),
        BEDROCK_GUARDRAIL_ID: EcsSecret.fromSecretsManager(guardrailsSecret, 'guardrail_id'),
        BEDROCK_GUARDRAIL_VERSION: EcsSecret.fromSecretsManager(
          guardrailsSecret,
          'guardrail_version',
        ),
        // Optional vendor keys (item 5, IaC readiness): injected at task
        // start from Secrets Manager, never baked into the template.
        TAVILY_API_KEY: EcsSecret.fromSecretsManager(vendorKeysSecret, 'tavily_api_key'),
        BRAVE_SEARCH_API_KEY: EcsSecret.fromSecretsManager(
          vendorKeysSecret,
          'brave_search_api_key',
        ),
        EXA_API_KEY: EcsSecret.fromSecretsManager(vendorKeysSecret, 'exa_api_key'),
        // Paperclip bridge (ADR 0010). C-19: the SHIPPED field spellings win.
        // `agent_keys` is a JSON STRING because one secret field injects as
        // one env var, hence the _JSON suffix on the variable but not on the
        // field. `agent_keys_json` / `dispatch_token` are the plan's wrong
        // variants and a field mismatch is a task that cannot START.
        PAPERCLIP_AGENT_KEYS_JSON: EcsSecret.fromSecretsManager(paperclipSecret, 'agent_keys'),
        PAPERCLIP_RECONCILER_KEY: EcsSecret.fromSecretsManager(
          paperclipSecret,
          'reconciler_key',
        ),
        PAPERCLIP_DISPATCH_SECRET: EcsSecret.fromSecretsManager(
          paperclipSecret,
          'dispatch_secret',
        ),
        // Referenced only when Paperclip is provisioned: an ECS secret naming a
        // field the stored secret lacks fails the task at start. Deploy phase b
        // merge-adds a REPLACE_ME placeholder (env.ts treats it as unset) and the
        // tenant bootstrap writes the real company id into the same retained
        // secret; ECS resolves the current version on the next rollout.
        ...(paperclipProvisioned(props.tier)
          ? {
              PAPERCLIP_COMPANY_ID: EcsSecret.fromSecretsManager(
                paperclipSecret,
                'company_id',
              ),
            }
          : {}),
        SERPER_API_KEY: EcsSecret.fromSecretsManager(vendorKeysSecret, 'serper_api_key'),
        GOOGLE_GEMINI_API_KEY: EcsSecret.fromSecretsManager(
          vendorKeysSecret,
          'google_gemini_api_key',
        ),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:3000/health || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
    });

    // ── X-Ray sidecar (D1) ──────────────────────────────────────
    // Only added at T2+ where tier.xrayEnabled is true. awsvpc mode
    // means localhost:2000 inside the orchestrator reaches the daemon
    // — no env-var change needed in the app. With the daemon in place
    // we flip xray.ts back from IGNORE_ERROR to LOG_ERROR so missing
    // segments surface in logs instead of silently dropping.
    if (tier.xrayEnabled) {
      taskDef.addContainer('xray-daemon', {
        // Public sidecar pinned by version AND digest (IaC readiness item
        // 9): a floating `latest` here would make archived-template
        // rollback non-reproducible for the full container set.
        image: ContainerImage.fromRegistry(
          'public.ecr.aws/xray/aws-xray-daemon:3.6.0@sha256:c64b7d6dd3a9bd5bbf117ca4e876b7677ff548a6de2f2377b9bb1fd649a31b3b',
        ),
        containerName: 'xray-daemon',
        essential: false,
        cpu: 32,
        memoryReservationMiB: 64,
        portMappings: [
          { containerPort: 2000, protocol: EcsProtocol.UDP },
        ],
        logging: LogDrivers.awsLogs({
          streamPrefix: 'xray',
          logGroup,
        }),
      });
    }

    // ── Cloudflare connector sidecar (pgnos design, Task 3) ─────
    // Publishes the dashboard at app.pgnos.ai WITHOUT giving AWS any new
    // ingress: the connector dials out to Cloudflare, so there is no public
    // task IP, no public ALB listener and no security-group hole. awsvpc mode
    // means the sidecar reaches the orchestrator on task-local port 3000, the
    // same way the X-Ray daemon above is reached, so the app needs no change.
    // Seeded with a placeholder `token` field, matching secrets-stack.ts. With
    // no secretObjectValue CDK emits `GenerateSecretString: {}` and Secrets
    // Manager stores a random PLAINTEXT string, not JSON, so the ECS agent
    // cannot extract the `token` key and every task dies with
    // ResourceInitializationError before any container runs. The placeholder
    // guarantees the key exists from creation; the setup lifecycle overwrites
    // the whole value with the real token.
    //
    // Retained on purpose: the token is written out-of-band, so a stack
    // replacement must never silently drop it and leave the tunnel
    // unauthenticated. Note this sits on the Secrets Manager AWS-managed key,
    // NOT the `claudeclaw-data` CMK the secrets-stack entries use, because
    // importing that key here would create a cross-stack cycle.
    const publicTunnelSecret = publicAccess.enabled
      ? new SmSecret(this, 'PublicTunnelSecret', {
          secretName: PUBLIC_TUNNEL_SECRET_NAME,
          description: `Cloudflare connector token for the ${publicAccess.tunnelName} tunnel. Written by the setup lifecycle, never by CDK.`,
          secretObjectValue: {
            token: SecretValue.unsafePlainText('REPLACE_ME'),
          },
          removalPolicy: RemovalPolicy.RETAIN,
        })
      : undefined;

    // Granted unconditionally, NOT as a side effect of attaching the sidecar.
    // `EcsSecret.fromSecretsManager` auto-grants read to the execution role, so
    // when the 2026-08-14 deploy dropped the container it dropped this grant in
    // the same changeset (CCE-Compute TaskExecutionRoleDefaultPolicy,
    // UPDATE_COMPLETE 16:00:47Z). The hand-rolled recovery 33 minutes later then
    // failed with AccessDeniedException on GetSecretValue and the circuit
    // breaker rolled back to a connector-less revision — the outage outlived the
    // fix attempt purely because the permission had gone with the container.
    // Holding the grant open costs nothing while the sidecar is absent and makes
    // re-attaching it a one-step operation instead of two.
    if (publicTunnelSecret) {
      publicTunnelSecret.grantRead(taskDef.obtainExecutionRole());
    }

    // Fail the synth rather than silently emit a task definition with no public
    // entrypoint. See assertPublicEntrypointRenderable for the incident this
    // encodes: without it, an unreadable readiness probe is indistinguishable
    // from "not ready yet", and the deploy that demolishes the only public path
    // reports success.
    assertPublicEntrypointRenderable(publicAccess, process.env);

    // Two-phase on purpose. The secret above is created and left EMPTY; the
    // connector is added only once the setup lifecycle has actually written a
    // token into it. Doing both in one deploy would put an essential container
    // into the task referencing a JSON field (`token`) that does not exist
    // yet: ECS cannot resolve the secret, the essential container never
    // starts, and the rollout of a live service fails. deploy.ts sets
    // CCE_PUBLIC_CONNECTOR_READY only after confirming the ready version stage
    // exists, so deploy #1 creates the secret, `npm run public:setup` fills
    // it, and deploy #2 lands the connector against a token already in place.
    if (publicAccess.enabled && publicTunnelSecret && process.env.CCE_PUBLIC_CONNECTOR_READY === '1') {
      taskDef.addContainer('cloudflared', {
        // Pinned by version AND digest for the same reason as the X-Ray
        // daemon above: a floating tag makes archived-template rollback
        // non-reproducible. 2026.7.3 is the current release and its manifest
        // list carries linux/arm64, which this ARM64 task requires.
        image: ContainerImage.fromRegistry(
          'cloudflare/cloudflared:2026.7.3@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf',
        ),
        containerName: 'cloudflared',
        // Essential: if the connector dies the task is replaced, because a
        // task that is up but unreachable from the published hostname is a
        // silent outage. The SSM tunnel remains the break-glass route.
        essential: true,
        cpu: 64,
        memoryReservationMiB: 128,
        // `--no-autoupdate` because the image is digest-pinned: letting the
        // binary self-update at runtime would defeat that pin. Config comes
        // from the remotely-managed tunnel, so the route and its 404
        // catch-all live in Cloudflare, not in this template.
        //
        // Metrics bind to loopback, not 0.0.0.0: nothing outside the task
        // scrapes them, and the X-Ray daemon above already holds port 2000 in
        // this shared network namespace. Loopback keeps /ready available for
        // `ecs execute-command` debugging without putting it on the task ENI.
        command: ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:20241', 'run'],
        secrets: {
          // The token reaches the container ONLY as an ECS secret reference
          // resolved at task start. It is never a command argument, never in
          // the template, and never in an env var written by a deploy.
          TUNNEL_TOKEN: EcsSecret.fromSecretsManager(publicTunnelSecret, 'token'),
        },
        logging: LogDrivers.awsLogs({
          streamPrefix: 'cloudflared',
          logGroup,
        }),
        // Deliberately NO container healthCheck. The published image is
        // distroless: it has no `sh`, and no curl or wget, so a CMD-SHELL
        // probe cannot execute and a CMD probe could only re-run the binary,
        // which proves nothing about tunnel health. Because this container is
        // essential, a probe that can never pass would roll the task forever.
        // Liveness therefore rests on `essential: true` alone today: a
        // connector that EXITS replaces the task. Two gaps are open and
        // deliberately named rather than papered over. First, cloudflared can
        // stay alive with a dead tunnel registration (revoked token, tunnel
        // deleted Cloudflare-side), which keeps the task RUNNING while
        // app.pgnos.ai serves edge errors, and nothing in AWS notices.
        // Second, because it is essential, a Cloudflare-side failure that does
        // exit takes the orchestrator down with it, so a service that has no
        // Cloudflare dependency today acquires one. The always-on alarm the
        // design calls for closes the first gap and must land before this is
        // considered finished; it belongs in observability-stack, which owns
        // the alert topic.
      });

    }

    // Emitted whenever the feature is on, including after the secret-only
    // first deploy, so the operator can see the secret to fill before the
    // connector exists.
    if (publicAccess.enabled && publicTunnelSecret) {
      new CfnOutput(this, 'PublicHostname', { value: publicAccess.hostname });
      new CfnOutput(this, 'PublicTunnelName', { value: publicAccess.tunnelName });
      new CfnOutput(this, 'PublicTunnelSecretArn', { value: publicTunnelSecret.secretArn });
      new CfnOutput(this, 'PublicConnectorAttached', {
        value: String(process.env.CCE_PUBLIC_CONNECTOR_READY === '1'),
      });
    }

    // ── Memory-consolidation worker task def (Wave 3a) ──────────
    // A nightly Fargate one-shot. It reuses the SAME orchestrator image
    // (the consolidation worker entrypoint compiles into the image at
    // dist/workers/consolidation-worker.js) but runs a different command
    // and only carries the env the consolidator actually touches
    // (memories + consolidations tables, the kill switch, audit log, and
    // the Bedrock Haiku model). It deliberately does NOT carry the ALB /
    // Jarvis / scheduler / posture env, and it has no ports or health
    // check — it runs to completion and exits. The spawner Lambda below
    // injects CONSOLIDATION_AGENT_ID / CONSOLIDATION_CHAT_ID per task.
    const consolidationTaskFamily = `${APP}-consolidation-worker`;
    const consolidationTaskDef = new FargateTaskDefinition(this, 'ConsolidationTaskDef', {
      family: consolidationTaskFamily,
      // A one-shot summarizer; the orchestrator tier sizing is overkill, so
      // pin the smallest valid Fargate shape to keep the nightly run cheap.
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        operatingSystemFamily: OperatingSystemFamily.LINUX,
        cpuArchitecture: CpuArchitecture.ARM64,
      },
      taskRole: props.taskRole,
      executionRole: taskExecutionRole,
    });
    consolidationTaskDef.addContainer('worker', {
      image: ContainerImage.fromEcrRepository(ecrRepo, imageTag),
      containerName: 'worker',
      // Run the worker entrypoint instead of the orchestrator server. The
      // spawner targets the container named 'worker' for its env overrides.
      command: ['node', 'dist/workers/consolidation-worker.js'],
      essential: true,
      logging: LogDrivers.awsLogs({
        streamPrefix: 'consolidation',
        logGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        AWS_REGION: region,
        AWS_ACCOUNT_ID: account,
        // Bedrock model used by the consolidator (Haiku). Same fallback
        // chain as the orchestrator container so CI deploys still work.
        BEDROCK_HAIKU_MODEL: process.env.BEDROCK_HAIKU_MODEL || BEDROCK_MODELS.haiku,
        BEDROCK_DEFAULT_MODEL:
          process.env.BEDROCK_DEFAULT_MODEL ||
          process.env.BEDROCK_SONNET_MODEL ||
          BEDROCK_MODELS.sonnet,
        // Tables the consolidator and its dependencies read/write.
        TABLE_MEMORIES: RESOURCE_NAMES.ddb.memories,
        TABLE_CONSOLIDATIONS: RESOURCE_NAMES.ddb.consolidations,
        TABLE_KILL_SWITCHES: RESOURCE_NAMES.ddb.killSwitches,
        TABLE_AUDIT_LOG: RESOURCE_NAMES.ddb.auditLog,
        TABLE_RUNTIME_CONFIG: RESOURCE_NAMES.ddb.runtimeConfig,
      },
    });

    // ── Consolidation spawner Lambda + nightly schedule (Wave 3a) ──
    // The spawner scans the sparse gsi2-unconsolidated index for every
    // (agent, chat) pair with pending memories and runs one consolidation
    // worker task per pair (idempotent via the spawn ledger + RunTask
    // clientToken). It lives here in compute-stack because it needs the
    // cluster name, the worker task-def family, and the Fargate subnets +
    // security group — all defined in this stack.
    //
    // The handler logic is the canonical TypeScript in
    // src/lambdas/consolidation-spawner.ts; this inline JS mirrors that
    // (fixed) query so the stack stays deployable without a Lambda bundler
    // step (matching the Code.fromInline convention in backup-stack and
    // the dynamo reaper). Keep the two in sync when either changes.
    const privateSubnets = props.vpc.selectSubnets({
      subnetType: SubnetType.PRIVATE_WITH_EGRESS,
    });
    const consolidationSpawnerSource = `
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs');
const { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { createHash, randomUUID } = require('node:crypto');

const region = process.env.AWS_REGION;
const CLUSTER = process.env.ECS_CLUSTER;
const TASK_DEFINITION = process.env.CONSOLIDATION_TASK_DEF;
const SUBNET_IDS = (process.env.CONSOLIDATION_SUBNETS || '').split(',').filter(Boolean);
const SECURITY_GROUP = process.env.CONSOLIDATION_SG || '';
const SPAWN_LEDGER_TABLE = process.env.TABLE_SPAWN_LEDGER;
const MEMORIES_TABLE = process.env.TABLE_MEMORIES;
const MAX_SCAN_PAGES = 50;

const ecs = new ECSClient({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

function clientToken(agentId, chatId, date) {
  return createHash('sha256').update(agentId + ':' + chatId + ':' + date).digest('hex').slice(0, 32);
}

async function isAlreadySpawned(agentId, chatId, date) {
  const out = await ddb.send(new GetCommand({
    TableName: SPAWN_LEDGER_TABLE,
    Key: { PK: 'SPAWN#' + agentId + '#' + chatId, SK: 'DATE#' + date },
  }));
  return !!out.Item;
}

async function recordSpawn(agentId, chatId, date, taskArn) {
  await ddb.send(new PutCommand({
    TableName: SPAWN_LEDGER_TABLE,
    Item: {
      PK: 'SPAWN#' + agentId + '#' + chatId,
      SK: 'DATE#' + date,
      taskArn,
      spawnedAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + 7 * 86400,
    },
  }));
}

async function findAgentsWithUnconsolidated() {
  // Sparse GSI: rows drop off the index once marked consolidated, so a Scan
  // of the small index enumerates every pending (agent, chat) pair. A Query
  // KeyCondition cannot use begins_with on the partition key.
  const seen = new Set();
  const results = [];
  let lastKey;
  let pages = 0;
  do {
    const out = await ddb.send(new ScanCommand({
      TableName: MEMORIES_TABLE,
      IndexName: 'gsi2-unconsolidated',
      ProjectionExpression: 'GSI2PK, GSI2SK',
      ExclusiveStartKey: lastKey,
    }));
    for (const item of out.Items || []) {
      const agentId = String(item.GSI2PK || '').replace('AGENT#', '');
      const skParts = String(item.GSI2SK || '').split('#');
      const chatId = skParts[0] === 'UNCON' ? (skParts[1] || '') : '';
      const key = agentId + ':' + chatId;
      if (agentId && chatId && !seen.has(key)) {
        seen.add(key);
        results.push({ agentId, chatId });
      }
    }
    lastKey = out.LastEvaluatedKey;
    pages++;
  } while (lastKey && pages < MAX_SCAN_PAGES);
  if (lastKey) {
    console.warn('findAgentsWithUnconsolidated hit MAX_SCAN_PAGES (' + MAX_SCAN_PAGES + '); next run continues');
  }
  return results;
}

exports.handler = async () => {
  const date = new Date().toISOString().slice(0, 10);
  const targets = await findAgentsWithUnconsolidated();
  let spawned = 0;
  for (const t of targets) {
    const { agentId, chatId } = t;
    if (await isAlreadySpawned(agentId, chatId, date)) continue;
    const token = clientToken(agentId, chatId, date);
    const workerId = randomUUID();
    try {
      const result = await ecs.send(new RunTaskCommand({
        cluster: CLUSTER,
        taskDefinition: TASK_DEFINITION,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: SUBNET_IDS,
            securityGroups: SECURITY_GROUP ? [SECURITY_GROUP] : undefined,
            assignPublicIp: 'DISABLED',
          },
        },
        overrides: {
          containerOverrides: [{
            name: 'worker',
            environment: [
              { name: 'CONSOLIDATION_AGENT_ID', value: agentId },
              { name: 'CONSOLIDATION_CHAT_ID', value: chatId },
              { name: 'CONSOLIDATION_WORKER_ID', value: workerId },
            ],
          }],
        },
        clientToken: token,
      }));
      const taskArn = (result.tasks && result.tasks[0] && result.tasks[0].taskArn) || 'unknown';
      await recordSpawn(agentId, chatId, date, taskArn);
      spawned++;
    } catch (err) {
      console.error('Failed to spawn consolidation for ' + agentId + '/' + chatId + ':', err && err.message ? err.message : String(err));
    }
  }
  return { spawned };
};
`;

    const consolidationSpawnerRole = new Role(this, 'ConsolidationSpawnerRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Nightly memory-consolidation spawner Lambda',
    });
    consolidationSpawnerRole.addToPolicy(
      new PolicyStatement({
        sid: 'Logs',
        effect: Effect.ALLOW,
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${APP}-consolidation-spawner*`],
      }),
    );
    consolidationSpawnerRole.addToPolicy(
      new PolicyStatement({
        sid: 'ScanMemoriesAndLedger',
        effect: Effect.ALLOW,
        actions: ['dynamodb:Scan', 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [
          `arn:aws:dynamodb:${region}:${account}:table/${RESOURCE_NAMES.ddb.memories}`,
          `arn:aws:dynamodb:${region}:${account}:table/${RESOURCE_NAMES.ddb.memories}/index/*`,
          `arn:aws:dynamodb:${region}:${account}:table/${RESOURCE_NAMES.ddb.spawnLedger}`,
        ],
      }),
    );
    consolidationSpawnerRole.addToPolicy(
      new PolicyStatement({
        sid: 'RunConsolidationWorker',
        effect: Effect.ALLOW,
        actions: ['ecs:RunTask'],
        resources: [
          `arn:aws:ecs:${region}:${account}:task-definition/${consolidationTaskFamily}:*`,
        ],
        conditions: {
          ArnEquals: { 'ecs:cluster': this.cluster.clusterArn },
        },
      }),
    );
    // RunTask must PassRole both the task role and the execution role to ECS.
    consolidationSpawnerRole.addToPolicy(
      new PolicyStatement({
        sid: 'PassEcsRoles',
        effect: Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [props.taskRole.roleArn, taskExecutionRole.roleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
        },
      }),
    );

    const consolidationSpawner = new LambdaFunction(this, 'ConsolidationSpawner', {
      functionName: `${APP}-consolidation-spawner`,
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromInline(consolidationSpawnerSource),
      role: consolidationSpawnerRole,
      timeout: Duration.minutes(5),
      memorySize: 256,
      environment: {
        ECS_CLUSTER: this.cluster.clusterName,
        CONSOLIDATION_TASK_DEF: consolidationTaskFamily,
        CONSOLIDATION_SUBNETS: privateSubnets.subnetIds.join(','),
        CONSOLIDATION_SG: props.fargateSecurityGroup.securityGroupId,
        TABLE_SPAWN_LEDGER: RESOURCE_NAMES.ddb.spawnLedger,
        TABLE_MEMORIES: RESOURCE_NAMES.ddb.memories,
      },
      description: 'Nightly scan for unconsolidated memories; spawns one Fargate consolidation worker per agent+chat',
    });

    // Nightly at 02:30 UTC (offset from the 02:00 DDB-export cron so the two
    // daily jobs don't contend). EventBridge invokes the spawner, which then
    // fans out to per-(agent,chat) Fargate one-shots.
    new Rule(this, 'ConsolidationSchedule', {
      ruleName: `${APP}-consolidation-nightly`,
      description: 'Triggers the memory-consolidation spawner once per day at 02:30 UTC',
      schedule: Schedule.cron({ hour: '2', minute: '30' }),
      targets: [new LambdaTarget(consolidationSpawner)],
    });

    new CfnOutput(this, 'ConsolidationTaskDefFamily', {
      value: consolidationTaskFamily,
      description: 'Fargate task-def family for the memory-consolidation worker',
    });
    new CfnOutput(this, 'ConsolidationSpawnerName', {
      value: consolidationSpawner.functionName,
    });

    // ── ALB ─────────────────────────────────────────────────────
    // In privateAccessOnly mode the ALB is INTERNAL and pinned to the
    // private (egress) subnets: no public IP, no internet route to it at
    // all — private access is structural, not a documentation promise. In
    // every other configuration (all current chat-mode deploys, including
    // prod) this synthesizes exactly as before: internet-facing, default
    // (public) subnet placement.
    this.loadBalancer = new ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: !privateAccessOnly,
      ...(privateAccessOnly
        ? { vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS } }
        : {}),
      loadBalancerName: RESOURCE_NAMES.alb,
      securityGroup: props.albSecurityGroup,
      idleTimeout: Duration.seconds(tier.albIdleTimeoutSec),
    });
    // ALB access logs to the logs bucket. ALB rejects prefixes that start
    // or end with '/'; use bare segment.
    this.loadBalancer.logAccessLogs(props.logsBucket, 'alb');

    const targetGroup = new ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      targetGroupName: RESOURCE_NAMES.targetGroup,
      port: 3000,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(20),
    });

    // Listener strategy:
    //   - If DOMAIN_NAME is provided (e.g. claw.example.com), CDK will:
    //       1. Look up the parent hosted zone in Route 53
    //       2. Issue an ACM cert with DNS validation
    //       3. Add an A record (alias) pointing the FQDN at the ALB
    //       4. Add HTTPS:443 listener with the cert
    //       5. Redirect HTTP:80 to HTTPS:443
    //   - Else if ACM_CERT_ARN is provided, import the cert directly
    //     (user manages DNS themselves).
    //   - Else fall back to HTTP-only (dev / test deploys).
    const domainName = process.env.DOMAIN_NAME;
    const acmCertArn = process.env.ACM_CERT_ARN;

    if (domainName && domainName.length > 0) {
      const parts = domainName.split('.');
      const apex = parts.slice(-2).join('.'); // e.g. example.com
      // When HOSTED_ZONE_ID is set, reference the zone directly instead of
      // looking it up by the 2-segment apex. This supports the delegated-
      // subzone case (apex lives elsewhere; only cce.<domain> is in this
      // account's Route 53) where the zone's apex is NOT the 2-segment apex.
      const hostedZoneId = process.env.HOSTED_ZONE_ID;
      const hostedZoneName = process.env.HOSTED_ZONE_NAME;
      const zoneName = hostedZoneId ? (hostedZoneName ?? apex) : apex;
      const hostedZone = hostedZoneId
        ? HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
            hostedZoneId,
            zoneName,
          })
        : HostedZone.fromLookup(this, 'HostedZone', {
            domainName: apex,
          });
      // At T3 we also expose the ALB under origin.<apex> so the
      // CloudFront distribution in security-stack can hit it via a
      // properly-certificated hostname (CloudFront origin needs SSL
      // match; ELB's auto-generated AWS DNS doesn't have a cert).
      const originHost = `origin.${domainName}`;
      const cert = new Certificate(this, 'Cert', {
        domainName,
        ...(tier.cloudFrontEnabled
          ? { subjectAlternativeNames: [originHost] }
          : {}),
        validation: CertificateValidation.fromDns(hostedZone),
      });
      // B1: at T3, the HTTPS listener defaults to 403 and only forwards
      // requests carrying the shared `X-CloudFront-Origin` secret header.
      // CloudFront (security-stack) sends this header on every origin
      // request, so legitimate edge traffic passes; direct ALB DNS hits
      // get 403. Target-group health checks bypass listener rules and
      // remain green. At lower tiers (no CloudFront), keep the default
      // forward behavior so the ALB is still reachable directly.
      const httpsListener = this.loadBalancer.addListener('HttpsListener', {
        port: 443,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [ListenerCertificate.fromCertificateManager(cert)],
        defaultAction: tier.cloudFrontEnabled
          ? ListenerAction.fixedResponse(403, {
              messageBody: 'origin only',
              contentType: 'text/plain',
            })
          : ListenerAction.forward([targetGroup]),
      });
      this.httpsListener = httpsListener;

      if (tier.cloudFrontEnabled) {
        const cfOriginSecret = cloudFrontOriginSecret(this.account, this.region);
        httpsListener.addAction('CloudFrontOnly', {
          priority: 1,
          conditions: [
            ListenerCondition.httpHeader(ORIGIN_HEADER_NAME, [cfOriginSecret]),
          ],
          action: ListenerAction.forward([targetGroup]),
        });
        // Allow Cloudflare-proxied traffic via host header match.
        // Cloudflare doesn't send X-CloudFront-Origin, so we match on
        // the Host header instead. Only the configured domain passes.
        if (domainName) {
          const originHost = `origin.${parts.slice(-2).join('.')}`;
          httpsListener.addAction('DirectHost', {
            priority: 2,
            conditions: [
              ListenerCondition.hostHeaders([domainName, originHost]),
            ],
            action: ListenerAction.forward([targetGroup]),
          });
        }
      }
      this.loadBalancer.addListener('HttpRedirect', {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        defaultAction: ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
      // A record (alias) pointing the user-facing FQDN at the ALB.
      // For apex records (e.g., claudeclaw-enterprise.com), recordName
      // must be undefined; the zone's apex is the implicit target.
      // Subdomain relative to the hosted zone's own apex (zoneName), so the
      // record name is correct whether R53 holds the whole zone (zoneName ===
      // 2-segment apex) or only a delegated subzone (zoneName === cce.<domain>,
      // where the FQDN equals the zone apex → recordName must be undefined).
      const sub =
        domainName === zoneName
          ? ''
          : domainName.endsWith(`.${zoneName}`)
            ? domainName.slice(0, -(zoneName.length + 1))
            : parts.slice(0, parts.length - 2).join('.'); // misconfig fallback
      new ARecord(this, 'AliasRecord', {
        zone: hostedZone,
        recordName: sub.length > 0 ? sub : undefined,
        target: RecordTarget.fromAlias(new LoadBalancerTarget(this.loadBalancer)),
        comment: 'ClaudeClaw Enterprise orchestrator',
      });
      if (tier.cloudFrontEnabled) {
        // Origin alias so CloudFront has a stable, properly-certificated
        // hostname to use. The apex stays on ALB until the operator
        // manually flips it (see security-stack output for the
        // CloudFront domain to alias to).
        new ARecord(this, 'OriginAliasRecord', {
          zone: hostedZone,
          recordName: `origin.${sub.length > 0 ? sub : ''}`.replace(/\.$/, ''),
          target: RecordTarget.fromAlias(new LoadBalancerTarget(this.loadBalancer)),
          comment: 'ClaudeClaw origin alias for CloudFront',
        });
        new CfnOutput(this, 'OriginDomainName', { value: originHost });
      }
      new CfnOutput(this, 'DomainName', { value: domainName });
    } else if (acmCertArn && acmCertArn.length > 0) {
      const cert = Certificate.fromCertificateArn(this, 'Cert', acmCertArn);
      this.loadBalancer.addListener('HttpsListener', {
        port: 443,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [ListenerCertificate.fromCertificateManager(cert)],
        defaultAction: ListenerAction.forward([targetGroup]),
      });
      this.loadBalancer.addListener('HttpRedirect', {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        defaultAction: ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
    } else {
      // No domain and no cert. In privateAccessOnly mode this HTTP listener
      // lives on an INTERNAL ALB in private subnets, so it is unreachable
      // from the internet — it exists only to keep target-group health
      // checks green. Dashboard access in that mode goes through the SSM
      // tunnel (localhost), never through this listener.
      this.loadBalancer.addListener('HttpListener', {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        defaultAction: ListenerAction.forward([targetGroup]),
      });
    }

    // ── ECS Service ─────────────────────────────────────────────
    // In privateAccessOnly mode (no-domain infra-only) the SSM messages
    // channel is a hard REQUIREMENT, not break-glass: `npm run
    // dashboard:tunnel` port-forwards through ECS Exec's agent, and it is
    // the ONLY dashboard access path. iam-stack already grants the task
    // role ssmmessages unconditionally (sid SsmExec) for break-glass
    // debugging; we re-assert it here gated to this mode so the tunnel
    // architecture stays self-contained even if that break-glass grant is
    // ever tightened. No-op for chat-mode deploys.
    if (privateAccessOnly) {
      props.taskRole.addToPrincipalPolicy(
        new PolicyStatement({
          sid: 'SsmExecTunnel',
          effect: Effect.ALLOW,
          actions: [
            'ssmmessages:CreateControlChannel',
            'ssmmessages:CreateDataChannel',
            'ssmmessages:OpenControlChannel',
            'ssmmessages:OpenDataChannel',
          ],
          resources: ['*'],
        }),
      );
    }
    this.service = new FargateService(this, 'Service', {
      serviceName: RESOURCE_NAMES.fargateService,
      cluster: this.cluster,
      taskDefinition: taskDef,
      // Intentionally NO desiredCount: autoscaling (below) owns the running
      // count. Setting desiredCount here writes it into the CFN template, so
      // every deploy would reconcile capacity back to the floor and yank tasks
      // mid-spike. Omitting it makes CloudFormation preserve the live count on
      // update; autoScaleTaskCount's minCapacity still floors it at deploy time.
      securityGroups: [props.fargateSecurityGroup],
      assignPublicIp: false,
      // Already true for ALL modes (break-glass debugging predates the
      // tunnel). privateAccessOnly RELIES on this staying enabled — it is
      // what `npm run dashboard:tunnel` rides. Do not gate it off.
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      // 100% min healthy = never drop below desiredCount during rolling deploy.
      // 200% max = can run up to 2x desired during deploy (replacements
      // are healthy before old tasks are stopped). Zero-downtime guarantee.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      propagateTags: PropagatedTagSource.SERVICE,
      healthCheckGracePeriod: Duration.seconds(90),
    });
    this.service.attachToApplicationTargetGroup(targetGroup);

    // Auto-scaling: scale on CPU and RequestCountPerTarget
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: tier.fargateMinTasks,
      maxCapacity: tier.fargateMaxTasks,
    });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: Duration.seconds(300),
      scaleOutCooldown: Duration.seconds(120),
    });
    scaling.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: 500,
      targetGroup,
      scaleInCooldown: Duration.seconds(300),
      scaleOutCooldown: Duration.seconds(120),
    });

    // ── Outputs ─────────────────────────────────────────────────
    this.albDnsName = this.loadBalancer.loadBalancerDnsName;
    this.albArn = this.loadBalancer.loadBalancerArn;
    new CfnOutput(this, 'AlbDnsName', {
      value: this.albDnsName,
      description: 'Public DNS for the orchestrator ALB',
    });
    new CfnOutput(this, 'AlbArn', { value: this.albArn });
    new CfnOutput(this, 'FargateClusterArn', {
      value: this.cluster.clusterArn,
    });
    new CfnOutput(this, 'FargateServiceName', {
      value: this.service.serviceName,
    });
  }
}
