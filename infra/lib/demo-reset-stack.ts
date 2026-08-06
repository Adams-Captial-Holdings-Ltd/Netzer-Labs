/**
 * Nightly reset for the PUBLIC DEMO instance.
 *
 * One Lambda, triggered by an EventBridge cron once a day, that:
 *   1. Wipes the conversational tables visitors filled (sessions, memories,
 *      hive-mind, war room, usage, etc.) via DescribeTable -> Scan keys ->
 *      BatchWrite delete, so it works regardless of each table's key schema.
 *   2. Deletes any agent a visitor created (DDB row + its S3 CLAUDE.md /
 *      agent.yaml), preserving the seed fleet (SEED_AGENT_IDS).
 *
 * It deliberately does NOT re-ingest the knowledge base or rewrite the lockdown
 * config: those persist (the demo dashboard token is read-gated, so visitors
 * cannot change config / kill switches / KB), and re-ingest needs Bedrock + S3
 * Vectors, which would bloat this dependency-light function. The full re-seed
 * (fleet + KB + lockdown) lives in `scripts/demo/seed.ts` for setup and
 * recovery; this stack is only the cheap nightly scrub.
 *
 * Gated by `CCE_DEMO_RESET_ENABLED=1` in infra/bin/app.ts (fail-closed, like
 * the CodeBuild stack), so prod deploys never materialize it. Point it at a
 * dedicated demo deployment. Mirrors backup-stack.ts: inline JS on the Node 20
 * runtime (AWS SDK v3 is in the runtime, nothing to bundle), plus a missing-run
 * alarm and an error alarm wired to the alert topic.
 */

import { Stack, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { Role, ServicePrincipal, PolicyStatement, Effect, ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
  Metric,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { APP, TAGS } from './constants.js';
import type { BaseStackProps } from './interfaces.js';

export interface DemoResetStackProps extends BaseStackProps {
  /** Conversational tables to empty completely each night. */
  wipeTables: ITable[];
  /** Agents metadata table (PK = AGENT#<id>, SK = META). */
  agentsTable: ITable;
  /** Config bucket holding agents/<id>/CLAUDE.md and agent.yaml. */
  configBucket: IBucket;
  /** Agent ids the reset must preserve (the seed fleet). */
  seedAgentIds: readonly string[];
  /** Alarm topic. */
  alertTopic: ITopic;
  /** UTC hour for the daily reset (default 09:00, after the 02:00 backup). */
  scheduleUtcHour?: string;
}

export class DemoResetStack extends Stack {
  constructor(scope: Construct, id: string, props: DemoResetStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const wipeArns = props.wipeTables.map((t) => t.tableArn);
    const allTableArns = [...wipeArns, props.agentsTable.tableArn];

    // ── Lambda role ───────────────────────────────────────────────
    const role = new Role(this, 'DemoResetRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Nightly demo reset: scrub conversational tables + visitor agents',
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    role.addToPolicy(
      new PolicyStatement({
        sid: 'DemoTableScrub',
        effect: Effect.ALLOW,
        actions: [
          'dynamodb:DescribeTable',
          'dynamodb:Scan',
          'dynamodb:BatchWriteItem',
          'dynamodb:DeleteItem',
        ],
        resources: allTableArns,
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'DemoAgentConfigDelete',
        effect: Effect.ALLOW,
        actions: ['s3:DeleteObject'],
        resources: [`${props.configBucket.bucketArn}/agents/*`],
      }),
    );

    // ── Lambda (inline JS, AWS SDK v3 is in the runtime) ──────────
    const logGroup = new LogGroup(this, 'DemoResetLogs', {
      logGroupName: `/aws/lambda/${APP}-demo-reset`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const lambdaSource = `
const { DynamoDB } = require('@aws-sdk/client-dynamodb');
const { S3 } = require('@aws-sdk/client-s3');
const ddb = new DynamoDB({ region: process.env.AWS_REGION });
const s3 = new S3({ region: process.env.AWS_REGION });
const WIPE = (process.env.WIPE_TABLES || '').split(',').filter(Boolean);
const AGENTS = process.env.AGENTS_TABLE;
const BUCKET = process.env.CONFIG_BUCKET;
const SEED = new Set((process.env.SEED_AGENT_IDS || '').split(',').filter(Boolean));
const PKP = process.env.AGENT_PK_PREFIX || 'AGENT#';
const SK = process.env.AGENT_SK || 'META';

async function wipe(table) {
  const d = await ddb.describeTable({ TableName: table });
  const keys = (d.Table.KeySchema || []).map((k) => k.AttributeName);
  const names = {};
  const proj = keys.map((a, i) => ((names['#k' + i] = a), '#k' + i)).join(',');
  let start, n = 0;
  do {
    const p = await ddb.scan({ TableName: table, ProjectionExpression: proj, ExpressionAttributeNames: names, ExclusiveStartKey: start });
    const items = p.Items || [];
    for (let i = 0; i < items.length; i += 25) {
      let req = { [table]: items.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
      for (let a = 0; a < 5 && req && Object.keys(req).length; a++) {
        const r = await ddb.batchWriteItem({ RequestItems: req });
        req = r.UnprocessedItems && Object.keys(r.UnprocessedItems).length ? r.UnprocessedItems : null;
      }
      n += Math.min(25, items.length - i);
    }
    start = p.LastEvaluatedKey;
  } while (start);
  return n;
}

async function cleanAgents() {
  if (!AGENTS) return [];
  let start; const del = [];
  do {
    const p = await ddb.scan({ TableName: AGENTS, ProjectionExpression: 'agentId', ExclusiveStartKey: start });
    for (const it of p.Items || []) {
      const agentId = it.agentId && it.agentId.S;
      if (!agentId || SEED.has(agentId)) continue;
      await ddb.deleteItem({ TableName: AGENTS, Key: { PK: { S: PKP + agentId }, SK: { S: SK } } });
      if (BUCKET) await s3.deleteObjects({ Bucket: BUCKET, Delete: { Objects: [{ Key: 'agents/' + agentId + '/CLAUDE.md' }, { Key: 'agents/' + agentId + '/agent.yaml' }] } });
      del.push(agentId);
    }
    start = p.LastEvaluatedKey;
  } while (start);
  return del;
}

exports.handler = async () => {
  const wiped = {};
  for (const t of WIPE) {
    try { wiped[t] = await wipe(t); }
    catch (e) { wiped[t] = 'ERR:' + ((e && e.message) || e); }
  }
  let agentsDeleted = [];
  try { agentsDeleted = await cleanAgents(); }
  catch (e) { agentsDeleted = ['ERR:' + ((e && e.message) || e)]; }
  console.log(JSON.stringify({ msg: 'demo reset', wiped, agentsDeleted }));
  return { wiped, agentsDeleted };
};
`;

    const fn = new LambdaFunction(this, 'DemoResetLambda', {
      functionName: `${APP}-demo-reset`,
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromInline(lambdaSource),
      role,
      timeout: Duration.minutes(5),
      memorySize: 256,
      logGroup,
      environment: {
        WIPE_TABLES: props.wipeTables.map((t) => t.tableName).join(','),
        AGENTS_TABLE: props.agentsTable.tableName,
        CONFIG_BUCKET: props.configBucket.bucketName,
        SEED_AGENT_IDS: props.seedAgentIds.join(','),
        AGENT_PK_PREFIX: 'AGENT#',
        AGENT_SK: 'META',
      },
      description: 'Nightly scrub of the public demo: conversational tables + visitor agents',
    });

    // ── Daily schedule ────────────────────────────────────────────
    new Rule(this, 'DemoResetSchedule', {
      ruleName: `${APP}-demo-reset-daily`,
      description: 'Resets the public demo once per day',
      schedule: Schedule.cron({ hour: props.scheduleUtcHour ?? '9', minute: '0' }),
      targets: [new LambdaTarget(fn)],
    });

    // ── Alarm: no invocation in 26 hours ──────────────────────────
    const noRunAlarm = new Alarm(this, 'DemoResetMissingAlarm', {
      alarmName: `${APP}-demo-reset-missing`,
      alarmDescription: 'Demo reset Lambda has not run in 26 hours - the daily cron is misfiring.',
      metric: new Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Invocations',
        dimensionsMap: { FunctionName: fn.functionName },
        statistic: 'Sum',
        period: Duration.hours(26),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.BREACHING,
    });
    noRunAlarm.addAlarmAction(new SnsAction(props.alertTopic));

    // ── Alarm: any error in the last 24 hours ─────────────────────
    const errorAlarm = new Alarm(this, 'DemoResetErrorAlarm', {
      alarmName: `${APP}-demo-reset-errors`,
      alarmDescription: 'Demo reset Lambda errored on its last run.',
      metric: new Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensionsMap: { FunctionName: fn.functionName },
        statistic: 'Sum',
        period: Duration.hours(24),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    errorAlarm.addAlarmAction(new SnsAction(props.alertTopic));
  }
}
