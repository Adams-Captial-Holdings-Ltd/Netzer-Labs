/**
 * v5.6 Extensions infrastructure stack.
 *
 * Provisions:
 *   - Extensions S3 bucket (KMS, versioning, Object Lock governance)
 *   - AWS Signer profile for code signing
 *   - Hook + consolidation DLQ queues
 *   - DLQ watcher alarm
 *
 * The Extensions VPC + Network Firewall are deferred to a future phase
 * where egress is needed; gated on CCE_EXTENSIONS_EGRESS_ENABLED.
 */

import { Stack, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectLockMode } from 'aws-cdk-lib/aws-s3';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { RESOURCE_NAMES, TAGS } from './constants.js';
import type { BaseStackProps } from './interfaces.js';

export interface ExtensionsStackProps extends BaseStackProps {
  dataKey: IKey;
  alertTopic: ITopic;
}

export class ExtensionsStack extends Stack {
  public readonly extensionsBucket: Bucket;
  public readonly hookDlq: Queue;
  public readonly consolidationDlq: Queue;

  constructor(scope: Construct, id: string, props: ExtensionsStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    // ── Extensions bucket ──────────────────────────────────────────
    this.extensionsBucket = new Bucket(this, 'ExtensionsBucket', {
      bucketName: `${RESOURCE_NAMES.extensionsBucket}-${this.account}-${this.region}`,
      encryption: BucketEncryption.KMS,
      encryptionKey: props.dataKey,
      versioned: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      objectLockEnabled: true,
      objectLockDefaultRetention: {
        mode: ObjectLockMode.GOVERNANCE,
        duration: Duration.days(90),
      },
    });

    // ── Hook DLQ ───────────────────────────────────────────────────
    this.hookDlq = new Queue(this, 'HookDlq', {
      queueName: RESOURCE_NAMES.hookDlq,
      retentionPeriod: Duration.days(14),
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: props.dataKey,
    });

    // ── Consolidation DLQ ──────────────────────────────────────────
    this.consolidationDlq = new Queue(this, 'ConsolidationDlq', {
      queueName: RESOURCE_NAMES.consolidationDlq,
      retentionPeriod: Duration.days(14),
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: props.dataKey,
    });

    // ── DLQ depth alarms ───────────────────────────────────────────
    const hookDlqAlarm = new Alarm(this, 'HookDlqDepthAlarm', {
      alarmName: `${RESOURCE_NAMES.hookDlq}-depth`,
      metric: this.hookDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    hookDlqAlarm.addAlarmAction(new SnsAction(props.alertTopic));

    const consolidationDlqAlarm = new Alarm(this, 'ConsolidationDlqDepthAlarm', {
      alarmName: `${RESOURCE_NAMES.consolidationDlq}-depth`,
      metric: this.consolidationDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    consolidationDlqAlarm.addAlarmAction(new SnsAction(props.alertTopic));

    // ── Outputs ────────────────────────────────────────────────────
    new CfnOutput(this, 'ExtensionsBucketName', { value: this.extensionsBucket.bucketName });
    new CfnOutput(this, 'HookDlqUrl', { value: this.hookDlq.queueUrl });
    new CfnOutput(this, 'ConsolidationDlqUrl', { value: this.consolidationDlq.queueUrl });
  }
}
