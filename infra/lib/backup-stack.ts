/**
 * A4 · DDB → S3 daily exports with Glacier.
 *
 * One Lambda iterates every DDB table and calls
 * ExportTableToPointInTime → s3://<logsBucket>/ddb-exports/<table>/<date>/.
 * Triggered by an EventBridge cron every day at 02:00 UTC. The logs
 * bucket already has a 90-day → Glacier lifecycle rule (storage-stack)
 * so exports age into cheap storage automatically.
 *
 * Gated on `tier.flowLogsEnabled` (T1+); T0 hobby deploys don't need
 * the backup overhead. Recovery via `scripts/restore-ddb.ts`.
 */

import { Stack, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  Effect,
  ManagedPolicy,
} from 'aws-cdk-lib/aws-iam';
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
  Metric,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { APP, TAGS, TIERS } from './constants.js';
import type { BaseStackProps } from './interfaces.js';

export interface BackupStackProps extends BaseStackProps {
  logsBucket: IBucket;
  tableArns: string[];
  alertTopic: ITopic;
}

export class BackupStack extends Stack {
  constructor(scope: Construct, id: string, props: BackupStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const tier = TIERS[props.tier];
    if (!tier.flowLogsEnabled) {
      // No-op at T0 (hobby). Stack still exists for graph stability.
      return;
    }

    const bucketName = props.logsBucket.bucketName;

    // ── Lambda role ───────────────────────────────────────────────
    const role = new Role(this, 'BackupLambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'DDB to S3 daily export lambda',
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });
    role.addToPolicy(
      new PolicyStatement({
        sid: 'DdbExport',
        effect: Effect.ALLOW,
        actions: [
          'dynamodb:ExportTableToPointInTime',
          'dynamodb:DescribeTable',
          'dynamodb:DescribeContinuousBackups',
          'dynamodb:ListExports',
        ],
        resources: props.tableArns,
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'S3WriteExports',
        effect: Effect.ALLOW,
        actions: [
          's3:PutObject',
          's3:PutObjectAcl',
          's3:GetBucketLocation',
          's3:AbortMultipartUpload',
        ],
        resources: [
          props.logsBucket.bucketArn,
          `${props.logsBucket.bucketArn}/ddb-exports/*`,
        ],
      }),
    );

    // ── Lambda function (inline JS) ───────────────────────────────
    const logGroup = new LogGroup(this, 'BackupLambdaLogs', {
      logGroupName: `/aws/lambda/${APP}-ddb-export`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const lambdaSource = `
const { DynamoDB } = require('@aws-sdk/client-dynamodb');

const TABLE_ARNS = (process.env.TABLE_ARNS || '').split(',').filter(Boolean);
const BUCKET = process.env.BUCKET;
const PREFIX_ROOT = 'ddb-exports';

exports.handler = async () => {
  const ddb = new DynamoDB({ region: process.env.AWS_REGION });
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const results = [];
  for (const arn of TABLE_ARNS) {
    const tableName = arn.split('/').pop();
    try {
      const out = await ddb.exportTableToPointInTime({
        TableArn: arn,
        S3Bucket: BUCKET,
        S3Prefix: \`\${PREFIX_ROOT}/\${tableName}/\${date}/\`,
        ExportFormat: 'DYNAMODB_JSON',
      });
      console.log(JSON.stringify({
        msg: 'export started',
        table: tableName,
        exportArn: out.ExportDescription && out.ExportDescription.ExportArn,
        date,
      }));
      results.push({ table: tableName, ok: true });
    } catch (err) {
      console.error(JSON.stringify({
        msg: 'export failed',
        table: tableName,
        errMessage: err && err.message ? err.message : String(err),
      }));
      results.push({ table: tableName, ok: false, error: String(err) });
    }
  }
  return { date, results };
};
`;

    const fn = new LambdaFunction(this, 'BackupLambda', {
      functionName: `${APP}-ddb-export`,
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromInline(lambdaSource),
      role,
      timeout: Duration.minutes(5),
      memorySize: 256,
      logGroup,
      environment: {
        TABLE_ARNS: props.tableArns.join(','),
        BUCKET: bucketName,
      },
      description: 'Daily DDB to S3 export for all ClaudeClaw tables',
    });

    // ── EventBridge daily schedule (02:00 UTC) ────────────────────
    new Rule(this, 'BackupSchedule', {
      ruleName: `${APP}-ddb-export-daily`,
      description: 'Triggers the DDB export Lambda once per day at 02:00 UTC',
      schedule: Schedule.cron({ hour: '2', minute: '0' }),
      targets: [new LambdaTarget(fn)],
    });

    // ── Alarm: no invocations in 36 hours ────────────────────────
    // Lambda emits its own AWS/Lambda Invocations metric; we alarm if
    // it stops firing. 36h gives the daily cron a comfortable buffer.
    const noRunAlarm = new Alarm(this, 'BackupMissingAlarm', {
      alarmName: `${APP}-ddb-backup-missing`,
      alarmDescription:
        'DDB export Lambda has not run in 36 hours - daily cron is misfiring.',
      metric: new Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Invocations',
        dimensionsMap: { FunctionName: fn.functionName },
        statistic: 'Sum',
        period: Duration.hours(36),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.BREACHING,
    });
    noRunAlarm.addAlarmAction(new SnsAction(props.alertTopic));

    // ── Alarm: any Lambda error in last 24 hours ─────────────────
    const errorAlarm = new Alarm(this, 'BackupErrorAlarm', {
      alarmName: `${APP}-ddb-backup-errors`,
      alarmDescription:
        'DDB export Lambda errored on its last run - at least one table failed to export.',
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
