import { Stack, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { LogGroup, RetentionDays, MetricFilter, FilterPattern } from 'aws-cdk-lib/aws-logs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Alarm, ComparisonOperator, TreatMissingData, Metric } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Trail, ReadWriteType } from 'aws-cdk-lib/aws-cloudtrail';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { APP, RESOURCE_NAMES, TAGS, TIERS } from './constants.js';
import type { BaseStackProps, ObservabilityOutputs } from './interfaces.js';
import {
  Dashboard,
  GraphWidget,
  SingleValueWidget,
  TextWidget,
  AlarmStatusWidget,
  LogQueryWidget,
  LogQueryVisualizationType,
} from 'aws-cdk-lib/aws-cloudwatch';
// aws-events is used by the outside-in public endpoint probe below. The older
// note here said it was kept out on purpose: that applied to the in-process
// application canary (src/agent/canary.ts), which still runs inside the task.
// This probe answers a different question — "can a user reach us at all" —
// and by construction cannot live inside the thing it is testing.

/** Namespace for probe metrics; scoped in the probe's IAM condition. */
const PROBE_NAMESPACE = 'ClaudeClaw/Uptime';

export interface ObservabilityStackProps extends BaseStackProps {
  logsKey: IKey;
  logsBucket: IBucket;
  /**
   * Public hostname to probe from OUTSIDE the cluster (e.g. app.pgnos.ai).
   * Unset = no uptime probe, which is correct for an environment that has no
   * public edge. See PublicEndpointProbe below for why this matters.
   */
  publicHostname?: string;
  /**
   * Address subscribed to the ops alert topic, following the
   * CCE_COST_ALERT_EMAIL precedent in cost-guardrails-stack.ts. AWS emails a
   * confirmation link a human must click; until then the subscription sits in
   * PendingConfirmation and delivers nothing.
   */
  opsAlertEmail?: string;
  /**
   * Minimum healthy ECS tasks before the connector-capacity alarm fires. Every
   * task carries a cloudflared sidecar, so this IS the connector floor.
   */
  minHealthyTasks?: number;
}

/**
 * CloudWatch log groups, ops alert SNS topic.
 *
 * Session 1: log groups and SNS topic only. CloudTrail trail, metric
 * filters, and alarms are added in session 2.
 *
 * Per Codex review: short retention by default (7 days) with sampling
 * to keep ingestion cost from dominating the bill.
 */
export class ObservabilityStack extends Stack implements ObservabilityOutputs {
  public readonly alertTopic: Topic;
  public readonly orchestratorLogGroup: LogGroup;
  public readonly trail: Trail;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const tier = TIERS[props.tier];

    this.orchestratorLogGroup = new LogGroup(this, 'OrchestratorLogGroup', {
      logGroupName: RESOURCE_NAMES.logGroupOrchestrator,
      retention: retentionFromDays(tier.logRetentionDays),
      encryptionKey: props.logsKey,
      removalPolicy: RemovalPolicy.RETAIN, // never auto-delete logs
    });

    this.alertTopic = new Topic(this, 'AlertTopic', {
      topicName: RESOURCE_NAMES.alertTopic,
      displayName: 'ClaudeClaw Ops Alerts',
      masterKey: props.logsKey,
    });

    // ── Metric filters on the orchestrator log group ─────────────
    const errorFilter = new MetricFilter(this, 'ErrorFilter', {
      logGroup: this.orchestratorLogGroup,
      filterPattern: FilterPattern.literal('{ $.level = 50 }'), // pino error level
      metricNamespace: 'ClaudeClaw',
      metricName: 'OrchestratorErrors',
      metricValue: '1',
      defaultValue: 0,
    });
    const fatalFilter = new MetricFilter(this, 'FatalFilter', {
      logGroup: this.orchestratorLogGroup,
      filterPattern: FilterPattern.literal('{ $.level = 60 }'), // pino fatal
      metricNamespace: 'ClaudeClaw',
      metricName: 'OrchestratorFatals',
      metricValue: '1',
      defaultValue: 0,
    });

    // ── Alarms ──────────────────────────────────────────────────
    const errorAlarm = new Alarm(this, 'ErrorAlarm', {
      metric: errorFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Orchestrator emitting >10 errors per 5 min',
    });
    errorAlarm.addAlarmAction(new SnsAction(this.alertTopic));

    const fatalAlarm = new Alarm(this, 'FatalAlarm', {
      metric: fatalFilter.metric({ period: Duration.minutes(1), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Orchestrator emitted a fatal log entry',
    });
    fatalAlarm.addAlarmAction(new SnsAction(this.alertTopic));

    // Bedrock throttling rate (via standard CloudWatch metrics)
    const bedrockThrottleAlarm = new Alarm(this, 'BedrockThrottleAlarm', {
      metric: new Metric({
        namespace: 'AWS/Bedrock',
        metricName: 'InvocationThrottles',
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: 20,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Bedrock throttled >20 calls per 5 min',
    });
    bedrockThrottleAlarm.addAlarmAction(new SnsAction(this.alertTopic));

    // Bedrock 5xx (server errors)
    const bedrockServerErrorAlarm = new Alarm(this, 'BedrockServerErrorAlarm', {
      metric: new Metric({
        namespace: 'AWS/Bedrock',
        metricName: 'InvocationServerErrors',
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Bedrock returned >5 5xx in 5 min',
    });
    bedrockServerErrorAlarm.addAlarmAction(new SnsAction(this.alertTopic));

    // Kill switch tripped — a kill_switch_blocked audit row landed in
    // the orchestrator log. Any single occurrence pages because it
    // means user-facing traffic is being refused.
    const killSwitchFilter = new MetricFilter(this, 'KillSwitchBlockedFilter', {
      logGroup: this.orchestratorLogGroup,
      filterPattern: FilterPattern.literal('"kill_switch_blocked"'),
      metricNamespace: 'ClaudeClaw',
      metricName: 'KillSwitchBlocked',
      metricValue: '1',
      defaultValue: 0,
    });
    const killSwitchAlarm = new Alarm(this, 'KillSwitchBlockedAlarm', {
      metric: killSwitchFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: 'A kill switch blocked at least one request',
    });
    killSwitchAlarm.addAlarmAction(new SnsAction(this.alertTopic));

    // Dashboard auth failures — Inc-1 emits a pino logger.warn with the
    // msg "dashboard auth failure" (and an audit row action=auth_failure)
    // on every rejected dashboard token. A burst means someone is probing
    // the admin console with bad / stale tokens, so we surface it as an
    // alarm. We match on $.msg the same way SchedulerTickFilter and the
    // CostPerTurnFilter below pattern-match pino's structured fields.
    const authFailedFilter = new MetricFilter(this, 'AuthFailedFilter', {
      logGroup: this.orchestratorLogGroup,
      filterPattern: FilterPattern.literal('{ $.msg = "dashboard auth failure" }'),
      metricNamespace: 'ClaudeClaw',
      metricName: 'DashboardAuthFailures',
      metricValue: '1',
      defaultValue: 0,
    });
    // Conservative: more than 10 failed dashboard auths in 5 min is well
    // above any fat-finger rate and points at credential probing.
    const authFailedAlarm = new Alarm(this, 'AuthFailedAlarm', {
      metric: authFailedFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: 'More than 10 dashboard auth failures in 5 min — possible credential probing',
    });
    authFailedAlarm.addAlarmAction(new SnsAction(this.alertTopic));

    // ── CloudTrail trail ─────────────────────────────────────────
    this.trail = new Trail(this, 'AuditTrail', {
      trailName: RESOURCE_NAMES.cloudTrailName,
      bucket: props.logsBucket,
      s3KeyPrefix: 'cloudtrail/',
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: false,
      enableFileValidation: true,
      managementEvents: ReadWriteType.ALL,
    });

    // ── Mission Control dashboard ────────────────────────────────
    // One CloudWatch dashboard pinning the must-see metrics. Free up to
    // three dashboards per account.
    // Dashboard names are account-global. Honor the suffix so prod
    // and staging don't collide on `claudeclaw-mission-control`.
    const dashboard = new Dashboard(this, 'MissionControl', {
      dashboardName: `${APP}-mission-control`,
    });
    dashboard.addWidgets(
      new TextWidget({
        markdown:
          `# ClaudeClaw · Mission Control (tier ${props.tier} / ${tier.label})\n` +
          `Updated by the [observability stack](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Dashboards.html). ` +
          `App dashboard at \`/dashboard\` on the orchestrator host.`,
        width: 24,
        height: 3,
      }),
    );
    dashboard.addWidgets(
      new SingleValueWidget({
        title: 'Errors per 5min',
        metrics: [
          errorFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
        ],
        width: 6,
        height: 4,
      }),
      new SingleValueWidget({
        title: 'Fatals per 1min',
        metrics: [
          fatalFilter.metric({ period: Duration.minutes(1), statistic: 'Sum' }),
        ],
        width: 6,
        height: 4,
      }),
      new SingleValueWidget({
        title: 'Kill switches blocked per 5min',
        metrics: [
          killSwitchFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
        ],
        width: 6,
        height: 4,
      }),
      new SingleValueWidget({
        title: 'Bedrock throttles 5min',
        metrics: [
          new Metric({
            namespace: 'AWS/Bedrock',
            metricName: 'InvocationThrottles',
            statistic: 'Sum',
            period: Duration.minutes(5),
          }),
        ],
        width: 6,
        height: 4,
      }),
    );
    dashboard.addWidgets(
      new GraphWidget({
        title: 'Bedrock invocations',
        left: [
          new Metric({
            namespace: 'AWS/Bedrock',
            metricName: 'Invocations',
            statistic: 'Sum',
            period: Duration.minutes(5),
          }),
        ],
        right: [
          new Metric({
            namespace: 'AWS/Bedrock',
            metricName: 'InvocationLatency',
            statistic: 'p95',
            period: Duration.minutes(5),
          }),
        ],
        width: 12,
        height: 6,
      }),
      new GraphWidget({
        title: 'Bedrock token throughput',
        left: [
          new Metric({
            namespace: 'AWS/Bedrock',
            metricName: 'InputTokenCount',
            statistic: 'Sum',
            period: Duration.minutes(5),
          }),
          new Metric({
            namespace: 'AWS/Bedrock',
            metricName: 'OutputTokenCount',
            statistic: 'Sum',
            period: Duration.minutes(5),
          }),
        ],
        width: 12,
        height: 6,
      }),
    );
    // Cost per turn — extract $.costUsd from "agent turn complete" log
    // lines so the Sum statistic over a day equals total Bedrock spend.
    const costFilter = new MetricFilter(this, 'CostPerTurnFilter', {
      logGroup: this.orchestratorLogGroup,
      filterPattern: FilterPattern.literal('{ ($.msg = "agent turn complete*") && ($.costUsd > 0) }'),
      metricNamespace: 'ClaudeClaw',
      metricName: 'CostUsd',
      metricValue: '$.costUsd',
      defaultValue: 0,
    });

    // Cost-spike alarm on the existing CostPerTurn filter. The metric is
    // the per-turn cost in USD extracted from "agent turn complete" lines;
    // summed over a 5 min window it is total Bedrock spend for that window.
    // Threshold is deliberately conservative: a single 5 min window costing
    // more than 25 USD is far above normal steady-state and almost always
    // means a runaway loop or an unexpectedly expensive job. Tune up if a
    // legitimate workload trips it. This is a cost guardrail, not a hard
    // cap (the daily cost cap in CCE_DAILY_COST_CAP_USD enforces the cap).
    const costSpikeAlarm = new Alarm(this, 'CostSpikeAlarm', {
      metric: costFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 25,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Bedrock spend exceeded 25 USD in a 5 min window — possible runaway cost',
    });
    costSpikeAlarm.addAlarmAction(new SnsAction(this.alertTopic));

    // Scheduler heartbeat — emitted every tick by src/agent/scheduler.ts.
    // Absence of this metric for >5 min means both Fargate tasks have
    // either died or had their schedulers disabled.
    const schedulerTickFilter = new MetricFilter(this, 'SchedulerTickFilter', {
      logGroup: this.orchestratorLogGroup,
      filterPattern: FilterPattern.literal('{ $.msg = "scheduler tick" }'),
      metricNamespace: 'ClaudeClaw',
      metricName: 'SchedulerTick',
      metricValue: '1',
      defaultValue: 0,
    });
    const schedulerStalledAlarm = new Alarm(this, 'SchedulerStalledAlarm', {
      metric: schedulerTickFilter.metric({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.BREACHING,
      alarmDescription: 'Scheduler tick missing for 10 min — orchestrator scheduler appears dead',
    });
    schedulerStalledAlarm.addAlarmAction(new SnsAction(this.alertTopic));

    // Canary success/failure (metric filter on `canary_fired` audit entries
    // written by src/agent/canary.ts via the orchestrator log group).
    const canaryFiredFilter = new MetricFilter(this, 'CanaryFiredFilter', {
      logGroup: this.orchestratorLogGroup,
      filterPattern: FilterPattern.literal('"canary_fired"'),
      metricNamespace: 'ClaudeClaw',
      metricName: 'CanaryFired',
      metricValue: '1',
      defaultValue: 0,
    });
    const canaryErrorFilter = new MetricFilter(this, 'CanaryErrorFilter', {
      logGroup: this.orchestratorLogGroup,
      filterPattern: FilterPattern.literal('"canary failed"'),
      metricNamespace: 'ClaudeClaw',
      metricName: 'CanaryError',
      metricValue: '1',
      defaultValue: 0,
    });
    const canaryErrorAlarm = new Alarm(this, 'CanaryErrorAlarm', {
      metric: canaryErrorFilter.metric({ period: Duration.minutes(10), statistic: 'Sum' }),
      threshold: 2,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: '2+ synthetic-canary failures in 10 min — orchestrator is degraded',
    });
    canaryErrorAlarm.addAlarmAction(new SnsAction(this.alertTopic));

    // ── connector capacity ───────────────────────────────────────────
    // Every task carries a cloudflared sidecar, so RunningTaskCount IS the
    // connector count. Dimensioned by the same name constants ComputeStack
    // registers with — taking `compute.service` as a prop instead would invert
    // the existing compute→observability dependency edge (app.ts) and fail synth.
    //
    // BREACHING on missing data: ContainerInsights stops publishing entirely
    // when a service reaches zero tasks, so "no data" is exactly the outage
    // this alarm exists to catch.
    // Capped at 2, and never above what the tier actually runs.
    //
    // Two ways to get this wrong, and the first draft hit both. Taking
    // tier.fargateMinTasks straight makes the threshold equal the desired count
    // at T3, so a single task being replaced — the normal, self-healing case —
    // pages someone. Hardcoding 2 instead fires permanently on Tier 0, which
    // legitimately runs one task: the 2026-08-15 staging deploy came up healthy
    // with claudeclaw-staging-connector-capacity stuck in ALARM.
    //
    // So: 2 where there are at least 2 tasks to lose (below that, one AZ
    // failure takes the hostname dark), and the tier floor where there are not.
    const minHealthyTasks = props.minHealthyTasks ?? Math.min(2, tier.fargateMinTasks);
    const connectorCapacityAlarm = new Alarm(this, 'ConnectorCapacityAlarm', {
      alarmName: `${APP}-connector-capacity`,
      metric: new Metric({
        namespace: 'ECS/ContainerInsights',
        metricName: 'RunningTaskCount',
        dimensionsMap: {
          ClusterName: RESOURCE_NAMES.ecsCluster,
          ServiceName: RESOURCE_NAMES.fargateService,
        },
        statistic: 'Minimum',
        period: Duration.minutes(1),
      }),
      threshold: minHealthyTasks,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.BREACHING,
      alarmDescription:
        `Fewer than ${minHealthyTasks} running tasks — each task carries a cloudflared ` +
        'connector, so the published hostname is losing tunnel capacity.',
    });
    connectorCapacityAlarm.addAlarmAction(new SnsAction(this.alertTopic));

    // ── public endpoint reachability (Layer C) ───────────────────────
    // The failure that matters is "users get Cloudflare 1033", and nothing in
    // AWS could see it before this: the orchestrator was healthy, ECS was
    // healthy, the ALB targets were healthy, and app.pgnos.ai was dark for ten
    // hours on 2026-08-14 because the connector had been removed from the task.
    //
    // So probe the way a user does — from outside, over the real hostname,
    // through Cloudflare. That single check covers 1033, 530, 5xx, a revoked
    // token, a Cloudflare-side ingress edit, DNS failure, TLS failure, and the
    // blind spot the container health check cannot see: cloudflared alive but
    // its tunnel registration dead.
    //
    // Deliberately NOT in the VPC. A probe that shares the network path it is
    // testing cannot report on that path failing, and staying out of the VPC
    // also keeps it off the NAT bill.
    const publicEndpointAlarm = props.publicHostname
      ? this.addPublicEndpointProbe(props.publicHostname)
      : undefined;

    // ── human alerting ───────────────────────────────────────────────
    // Every alarm above already routed here; until 2026-08-15 the topic had
    // zero subscribers, so all of it went nowhere. Subscription is IaC now.
    if (props.opsAlertEmail) {
      this.alertTopic.addSubscription(new EmailSubscription(props.opsAlertEmail));
    }

    dashboard.addWidgets(
      new SingleValueWidget({
        title: "Today's Bedrock spend (USD)",
        metrics: [
          costFilter.metric({
            period: Duration.hours(24),
            statistic: 'Sum',
          }),
        ],
        width: 8,
        height: 4,
      }),
      new SingleValueWidget({
        title: 'Scheduler ticks per 5 min',
        metrics: [
          schedulerTickFilter.metric({
            period: Duration.minutes(5),
            statistic: 'Sum',
          }),
        ],
        width: 8,
        height: 4,
      }),
      new SingleValueWidget({
        title: 'Avg cost per turn (10 min)',
        metrics: [
          costFilter.metric({
            period: Duration.minutes(10),
            statistic: 'Average',
          }),
        ],
        width: 8,
        height: 4,
      }),
    );

    // Top-5 chats by cost over the last hour — runs as a Logs Insights
    // query inside the dashboard. Pulls the agentId + chatId + summed
    // costUsd from the orchestrator log group; no custom metric needed.
    dashboard.addWidgets(
      new LogQueryWidget({
        title: 'Top 5 chats by cost (last 1h)',
        logGroupNames: [this.orchestratorLogGroup.logGroupName],
        queryString:
          'fields @timestamp, agentId, chatId, costUsd\n' +
          '| filter ispresent(costUsd) and costUsd > 0\n' +
          '| stats sum(costUsd) as totalUsd, count() as turns by agentId, chatId\n' +
          '| sort totalUsd desc\n' +
          '| limit 5',
        view: LogQueryVisualizationType.TABLE,
        width: 24,
        height: 6,
      }),
    );

    dashboard.addWidgets(
      new GraphWidget({
        title: 'Synthetic canary',
        left: [
          canaryFiredFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
        ],
        right: [
          canaryErrorFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
        ],
        width: 12,
        height: 6,
      }),
      new SingleValueWidget({
        title: 'Errors per 5 min (rolling)',
        metrics: [
          errorFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
        ],
        width: 6,
        height: 6,
      }),
      new SingleValueWidget({
        title: 'Bedrock 5xx (5 min)',
        metrics: [
          new Metric({
            namespace: 'AWS/Bedrock',
            metricName: 'InvocationServerErrors',
            statistic: 'Sum',
            period: Duration.minutes(5),
          }),
        ],
        width: 6,
        height: 6,
      }),
    );

    // D2: per-tool invocation metrics. EMF lines from src/lib/tools/registry.ts
    // populate the ClaudeClaw namespace (Metrics: ToolInvocation, ToolLatency,
    // ToolError; Dimensions: ToolName, AgentId). Tool names are dynamic, so we
    // use Logs Insights for "top N" rather than enumerating Metric() calls at
    // synth time.
    dashboard.addWidgets(
      new LogQueryWidget({
        title: 'Top 10 tools by invocations (last 1h)',
        logGroupNames: [this.orchestratorLogGroup.logGroupName],
        queryString:
          'fields @timestamp, ToolName, ToolInvocation, ToolError\n' +
          '| filter ispresent(ToolName)\n' +
          '| stats sum(ToolInvocation) as invocations, sum(ToolError) as errors by ToolName\n' +
          '| sort invocations desc\n' +
          '| limit 10',
        view: LogQueryVisualizationType.TABLE,
        width: 12,
        height: 6,
      }),
      new LogQueryWidget({
        title: 'Tool latency p95 / p50 (last 1h)',
        logGroupNames: [this.orchestratorLogGroup.logGroupName],
        queryString:
          'fields @timestamp, ToolName, ToolLatency\n' +
          '| filter ispresent(ToolName) and ispresent(ToolLatency)\n' +
          '| stats pct(ToolLatency, 50) as p50_ms, pct(ToolLatency, 95) as p95_ms, count() as samples by ToolName\n' +
          '| sort p95_ms desc\n' +
          '| limit 10',
        view: LogQueryVisualizationType.TABLE,
        width: 12,
        height: 6,
      }),
    );

    dashboard.addWidgets(
      new AlarmStatusWidget({
        title: 'Alarm status',
        alarms: [
          ...(publicEndpointAlarm ? [publicEndpointAlarm] : []),
          connectorCapacityAlarm,
          errorAlarm,
          fatalAlarm,
          bedrockThrottleAlarm,
          bedrockServerErrorAlarm,
          killSwitchAlarm,
          canaryErrorAlarm,
          schedulerStalledAlarm,
          authFailedAlarm,
          costSpikeAlarm,
        ],
        width: 24,
        height: 4,
      }),
    );

    // Synthetic canary is implemented in-process (src/agent/canary.ts)
    // and gated on the CCE_CANARY_ENABLED env var set by compute-stack
    // for T1+. We don't ship the EB Scheduler rule because there's no
    // target to bind it to — leaving an orphaned rule with no target
    // would fire into a void and emit CloudWatch warnings.

    new CfnOutput(this, 'AlertTopicArn', { value: this.alertTopic.topicArn });
    new CfnOutput(this, 'OrchestratorLogGroupName', {
      value: this.orchestratorLogGroup.logGroupName,
    });
    new CfnOutput(this, 'MissionControlDashboardName', {
      value: dashboard.dashboardName,
    });
    if (publicEndpointAlarm) {
      new CfnOutput(this, 'PublicEndpointAlarmName', {
        value: publicEndpointAlarm.alarmName,
      });
    }
  }

  /**
   * Probes `https://<hostname>/health` once a minute from outside the VPC and
   * alarms when it stops answering correctly.
   *
   * Health is deliberately stricter than "HTTP 200": Cloudflare returns 200 for
   * plenty of pages that are not this application, so the body must also parse
   * as JSON with `status: "ok"`. A 530/1033 page, a Cloudflare error page, a
   * TLS failure and a DNS failure all land in the same 0 datapoint.
   *
   * Runs at 128 MB with a 10s timeout on the Lambda and a 5s abort on the
   * fetch, so a hung origin cannot hold the invocation open.
   */
  private addPublicEndpointProbe(hostname: string): Alarm {
    const probe = new Function(this, 'PublicEndpointProbe', {
      functionName: `${APP}-public-endpoint-probe`,
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: Duration.seconds(10),
      memorySize: 128,
      // No vpc: on purpose — see the call site.
      environment: {
        PROBE_URL: `https://${hostname}/health`,
        PROBE_HOSTNAME: hostname,
        METRIC_NAMESPACE: PROBE_NAMESPACE,
      },
      description: `Outside-in reachability probe for https://${hostname}/health`,
      code: Code.fromInline(`
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const cw = new CloudWatchClient({});

exports.handler = async () => {
  const url = process.env.PROBE_URL;
  let healthy = 0;
  let detail = '';
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'manual' });
    const body = await res.text();
    if (res.status !== 200) {
      // Cloudflare surfaces tunnel failures as 530; the numeric 1033 is in the body.
      detail = 'http ' + res.status + (body.includes('1033') ? ' (cloudflare 1033)' : '');
    } else {
      try {
        healthy = JSON.parse(body).status === 'ok' ? 1 : 0;
        if (!healthy) detail = 'unexpected health body';
      } catch { detail = 'health body was not JSON'; }
    }
  } catch (err) {
    detail = err && err.name === 'AbortError' ? 'timeout after 5s' : String(err && err.message || err);
  } finally {
    clearTimeout(t);
  }
  if (!healthy) console.error(JSON.stringify({ msg: 'public endpoint unhealthy', url, detail }));
  await cw.send(new PutMetricDataCommand({
    Namespace: process.env.METRIC_NAMESPACE,
    MetricData: [{
      MetricName: 'PublicEndpointHealthy',
      Dimensions: [{ Name: 'Hostname', Value: process.env.PROBE_HOSTNAME }],
      Value: healthy,
      Unit: 'None',
    }],
  }));
  return { healthy, detail };
};
`),
    });
    probe.addToRolePolicy(
      new PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        // PutMetricData takes no resource ARN; scope by namespace instead.
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': PROBE_NAMESPACE } },
      }),
    );

    new Rule(this, 'PublicEndpointProbeSchedule', {
      ruleName: `${APP}-public-endpoint-probe`,
      schedule: Schedule.rate(Duration.minutes(1)),
      targets: [new LambdaFunction(probe)],
      description: `Run the ${hostname} reachability probe every minute`,
    });

    // Three consecutive misses, not one: a single 1-minute blip during a normal
    // rolling deploy is not an outage, and paging on it trains people to ignore
    // the alarm. Three minutes of a dark hostname is.
    const alarm = new Alarm(this, 'PublicEndpointDownAlarm', {
      alarmName: `${APP}-public-endpoint-down`,
      metric: new Metric({
        namespace: PROBE_NAMESPACE,
        metricName: 'PublicEndpointHealthy',
        dimensionsMap: { Hostname: hostname },
        statistic: 'Minimum',
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      // No datapoints means the probe itself stopped running — also an outage.
      treatMissingData: TreatMissingData.BREACHING,
      alarmDescription: `https://${hostname}/health has not answered correctly for 3 minutes`,
    });
    alarm.addAlarmAction(new SnsAction(this.alertTopic));
    return alarm;
  }
}

function retentionFromDays(days: number): RetentionDays {
  if (days <= 7) return RetentionDays.ONE_WEEK;
  if (days <= 30) return RetentionDays.ONE_MONTH;
  if (days <= 90) return RetentionDays.THREE_MONTHS;
  if (days <= 365) return RetentionDays.ONE_YEAR;
  return RetentionDays.TWO_YEARS;
}
