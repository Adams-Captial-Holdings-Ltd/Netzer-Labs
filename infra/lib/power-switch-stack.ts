/**
 * CCE-PowerSwitch — the external control plane for the demo pause/wake system
 * (Phase B). A no-VPC Lambda (so it never depends on the NAT a deep hibernate
 * removes) behind a secret-gated Function URL, plus a nightly auto-pause
 * EventBridge Scheduler. It lives OUTSIDE the system it toggles, so you can
 * always wake prod even when everything else is dark.
 *
 * Isolated by design (like CostGuardrailsStack): it imports nothing from the
 * other stacks and references their resources by constructed ARN, so
 * `cdk deploy CCE-PowerSwitch` can never drift Compute/Network.
 *
 * Triggers, both gated:
 *   - Function URL: POST + X-Power-Token header (token in Secrets Manager).
 *   - EventBridge Scheduler: direct invoke, IAM-restricted to the scheduler role.
 *
 * Handler: infra/lib/power-switch-handler/index.js.
 */
import { Stack, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import {
  Function as LambdaFunction,
  Runtime,
  Code,
  FunctionUrlAuthType,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  Table,
  AttributeType,
  BillingMode,
  TableEncryption,
} from 'aws-cdk-lib/aws-dynamodb';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  Effect,
  ManagedPolicy,
} from 'aws-cdk-lib/aws-iam';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import { APP, TAGS, RESOURCE_NAMES } from './constants.js';
import type { BaseStackProps } from './interfaces.js';

export interface PowerSwitchStackProps extends BaseStackProps {
  /** ECS cluster/service to pause. Defaults to the prod names. */
  clusterName?: string;
  serviceName?: string;
  /** Wake target. Defaults to the T3 floor. */
  wakeMin?: number;
  wakeMax?: number;
  wakeDesired?: number;
  /** Keep-awake hold set on each wake (hours). */
  holdHours?: number;
  /** Nightly auto-pause cron + timezone. */
  autoPauseCron?: string;
  autoPauseTimezone?: string;
  /**
   * Service-down alarms to mute while paused. Entries are NAME PREFIXES
   * (CDK-generated alarm names carry random suffixes); the handler resolves
   * them via DescribeAlarms AlarmNamePrefix. Empty = none.
   */
  mutedAlarms?: string[];
  /**
   * Public base URL of the dashboard (e.g. https://claudeclaw-enterprise.com).
   * Drives the /status end-to-end health probe (GET <url>/health) and the
   * panel's "open dashboard" link. Unset = probe skipped.
   */
  dashboardUrl?: string;
  /** Free-text cost line shown on the panel (e.g. paused vs awake $/mo). */
  costNote?: string;
}

/** Human label for the panel, derived from the auto-pause cron. */
function describeAutoPause(cron: string, timezone: string): string {
  const m = /^cron\((\d+)\s+(\d+)\s/.exec(cron);
  if (!m) return `on schedule (${timezone})`;
  const hh = String(parseInt(m[2], 10)).padStart(2, '0');
  const mm = String(parseInt(m[1], 10)).padStart(2, '0');
  return `nightly at ${hh}:${mm} (${timezone})`;
}

export class PowerSwitchStack extends Stack {
  constructor(scope: Construct, id: string, props: PowerSwitchStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const region = this.region;
    const account = this.account;
    const cluster = props.clusterName ?? `${APP}-cluster`;
    const service = props.serviceName ?? `${APP}-service`;
    const resId = `service/${cluster}/${service}`;
    const consolidationRule = `${APP}-consolidation-nightly`;

    const killSwitchTableName = RESOURCE_NAMES.ddb.killSwitches;
    const killSwitchTableArn = `arn:aws:dynamodb:${region}:${account}:table/${killSwitchTableName}`;
    const serviceArn = `arn:aws:ecs:${region}:${account}:service/${cluster}/${service}`;
    const topicArn = `arn:aws:sns:${region}:${account}:${RESOURCE_NAMES.configInvalidationTopic}`;
    const consolidationRuleArn = `arn:aws:events:${region}:${account}:rule/${consolidationRule}`;
    // Alarms carry two naming shapes: hand-named `claudeclaw-*` and
    // CDK-generated `<stackPrefix>-Observability-*` (e.g. CCE-Observability-…).
    // Cover both, or muting the stalled-scheduler alarm fails on IAM.
    const stackPrefix = this.stackName.replace(/-PowerSwitch$/, '');
    const alarmArns = [
      `arn:aws:cloudwatch:${region}:${account}:alarm:${APP}-*`,
      `arn:aws:cloudwatch:${region}:${account}:alarm:${stackPrefix}-*`,
    ];

    // ── durable marker + lease lock ───────────────────────────────
    const stateTable = new Table(this, 'PowerState', {
      tableName: `${APP}-power-state`,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ── Function URL token (generated, never an output) ───────────
    const token = new Secret(this, 'Token', {
      secretName: `${APP}/power-switch-token`,
      description: 'Bearer token for the CCE power-switch Function URL',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'token',
        excludePunctuation: true,
        passwordLength: 48,
      },
    });

    // ── Lambda role (least privilege) ─────────────────────────────
    const role = new Role(this, 'PowerLambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'CCE power-switch: scale the one service + flip pause levers',
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    role.addToPolicy(
      new PolicyStatement({
        sid: 'ScaleService',
        effect: Effect.ALLOW,
        actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
        resources: [serviceArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'AutoscalingBounds',
        effect: Effect.ALLOW,
        actions: [
          'application-autoscaling:RegisterScalableTarget',
          'application-autoscaling:DescribeScalableTargets',
        ],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'SwitchWrites',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem', 'dynamodb:GetItem'],
        resources: [killSwitchTableArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'PowerState',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        resources: [stateTable.tableArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'KmsViaDynamo',
        effect: Effect.ALLOW,
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `dynamodb.${region}.amazonaws.com` } },
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'PublishInvalidation',
        effect: Effect.ALLOW,
        actions: ['sns:Publish'],
        resources: [topicArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'ConsolidationRule',
        effect: Effect.ALLOW,
        actions: ['events:DisableRule', 'events:EnableRule', 'events:DescribeRule'],
        resources: [consolidationRuleArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'MuteServiceDownAlarms',
        effect: Effect.ALLOW,
        actions: ['cloudwatch:DisableAlarmActions', 'cloudwatch:EnableAlarmActions'],
        resources: alarmArns,
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'DescribeAlarms',
        effect: Effect.ALLOW,
        actions: ['cloudwatch:DescribeAlarms'],
        resources: ['*'],
      }),
    );
    // /costs live inventory: list/describe-only, no mutations. Most of these
    // APIs do not support resource-level scoping; the handler tenant-scopes
    // by the Application tag and name prefixes instead.
    role.addToPolicy(
      new PolicyStatement({
        sid: 'CostInventoryReadOnly',
        effect: Effect.ALLOW,
        actions: [
          'ec2:DescribeNatGateways',
          'elasticloadbalancing:DescribeLoadBalancers',
          'kms:ListAliases',
          'secretsmanager:ListSecrets',
          'wafv2:ListWebACLs',
          'route53:ListHostedZones',
          'ce:GetCostAndUsage',
          'ecs:DescribeTaskDefinition',
        ],
        resources: ['*'],
      }),
    );
    token.grantRead(role);

    // ── Lambda ────────────────────────────────────────────────────
    const logGroup = new LogGroup(this, 'PowerLambdaLogs', {
      logGroupName: `/aws/lambda/${APP}-power-switch`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const fn = new LambdaFunction(this, 'PowerLambda', {
      functionName: `${APP}-power-switch`,
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromAsset(fileURLToPath(new URL('./power-switch-handler', import.meta.url))),
      role,
      timeout: Duration.seconds(60),
      memorySize: 256,
      // Mutations (pause/wake) are serialised by the DynamoDB lease lock with
      // opId fencing — that is the real mutex. Concurrency here only needs to
      // cover READ traffic: the panel fires /status and /costs together and
      // polls, and the dashboard proxy adds its own reads. At 1, the second
      // concurrent read got a 429 whose JSON body the panel then rendered as
      // a status (the "RESTORED with undefined everywhere" bug, 2026-07-02).
      reservedConcurrentExecutions: 5,
      logGroup,
      environment: {
        CLUSTER: cluster,
        SERVICE: service,
        RES_ID: resId,
        SWITCH_TABLE: killSwitchTableName,
        POWER_TABLE: stateTable.tableName,
        TOPIC_ARN: topicArn,
        CONSOLIDATION_RULE: consolidationRule,
        TOKEN_SECRET_ARN: token.secretArn,
        WAKE_MIN: String(props.wakeMin ?? 3),
        WAKE_MAX: String(props.wakeMax ?? 20),
        WAKE_DESIRED: String(props.wakeDesired ?? 3),
        HOLD_HOURS: String(props.holdHours ?? 6),
        LEASE_MINUTES: '15',
        MUTED_ALARMS: (props.mutedAlarms ?? []).join(','),
        HEALTH_URL: props.dashboardUrl ? `${props.dashboardUrl.replace(/\/$/, '')}/health` : '',
        DASHBOARD_URL: props.dashboardUrl ?? '',
        COST_NOTE: props.costNote ?? '',
        // Live maintenance-cost inventory (/costs): tenant boundary for what
        // gets counted. Tag value scopes EC2 resources; prefixes scope
        // name-matched ones (ALB, KMS aliases, secrets, WAF ACLs).
        APP_TAG_VALUE: TAGS.Application,
        APP_PREFIX: APP,
        STACK_PREFIX: stackPrefix,
        AUTO_PAUSE_LABEL: describeAutoPause(
          props.autoPauseCron ?? 'cron(0 6 * * ? *)',
          props.autoPauseTimezone ?? 'America/Toronto',
        ),
      },
      description: 'CCE demo pause/wake control plane (Phase B)',
    });

    const url = fn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    // ── nightly auto-pause (direct invoke, IAM-gated to this role) ─
    const schedulerRole = new Role(this, 'AutoPauseSchedulerRole', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Lets the auto-pause schedule invoke the power-switch Lambda',
    });
    fn.grantInvoke(schedulerRole);

    new CfnSchedule(this, 'AutoPauseSchedule', {
      name: `${APP}-power-auto-pause`,
      groupName: 'default',
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: props.autoPauseCron ?? 'cron(0 6 * * ? *)',
      scheduleExpressionTimezone: props.autoPauseTimezone ?? 'America/Toronto',
      target: {
        arn: fn.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: 'cce.power.scheduler', action: 'auto-pause' }),
      },
      description: 'Nightly safety pause; no-ops if already paused or within a keep-awake hold',
    });

    // ── outputs (URL only; the token is NEVER emitted) ────────────
    new CfnOutput(this, 'FunctionUrl', { value: url.url, description: 'POST here with X-Power-Token header' });
    new CfnOutput(this, 'TokenSecretName', { value: token.secretName ?? `${APP}/power-switch-token` });
    new CfnOutput(this, 'PowerStateTable', { value: stateTable.tableName });
  }
}
