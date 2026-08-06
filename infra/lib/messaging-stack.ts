import { Stack, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Queue, DeadLetterQueue } from 'aws-cdk-lib/aws-sqs';
import { Rule, RuleTargetInput, EventField } from 'aws-cdk-lib/aws-events';
import { SnsTopic } from 'aws-cdk-lib/aws-events-targets';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  Effect,
} from 'aws-cdk-lib/aws-iam';
import { RESOURCE_NAMES, TAGS } from './constants.js';
import type { BaseStackProps, MessagingOutputs } from './interfaces.js';
import type { IBucket } from 'aws-cdk-lib/aws-s3';

export interface MessagingStackProps extends BaseStackProps {
  configBucket: IBucket;
}

/**
 * SNS + SQS for config invalidation and document ingest.
 *
 * Config invalidation pipeline:
 *   S3 PutObject on configBucket  →  EventBridge default bus  →
 *   SNS topic claudeclaw-config-invalidation  →
 *   standard SQS queue (one per Fargate task subscribes at runtime).
 *
 * Ingest pipeline:
 *   S3 PutObject on rawBucket prefix `ingest/`  →
 *   SQS queue claudeclaw-ingest  →
 *   embedding pipeline Lambda (session 4+).
 *
 * Per Codex finding #21: S3 event notifications do not support FIFO
 * destinations directly. We use EventBridge as the relay and standard
 * (not FIFO) SQS with idempotent consumers using config version numbers.
 *
 * Per Codex finding #20: S3 events are at-least-once and unordered.
 * Consumers must dedupe.
 */
export class MessagingStack extends Stack implements MessagingOutputs {
  public readonly configInvalidationTopic: Topic;
  public readonly ingestQueue: Queue;
  public readonly ingestDlq: Queue;
  public readonly configInvalidationTopicArn: string;
  public readonly ingestQueueUrl: string;
  /** A1 outputs. */
  public readonly scheduledFireQueue: Queue;
  public readonly scheduledFireDlq: Queue;
  public readonly scheduledFireQueueUrl: string;
  public readonly scheduledFireQueueArn: string;
  public readonly schedulerExecutionRoleArn: string;
  public readonly schedulerGroupName: string;

  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    // ── Config invalidation: SNS topic ──────────────────────────
    this.configInvalidationTopic = new Topic(this, 'ConfigInvalidationTopic', {
      topicName: RESOURCE_NAMES.configInvalidationTopic,
      displayName: 'ClaudeClaw config invalidation fanout',
    });

    // EventBridge rule fires when an object is created in the config bucket
    new Rule(this, 'ConfigChangeRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [(props.configBucket as Bucket).bucketName] },
        },
      },
      targets: [
        new SnsTopic(this.configInvalidationTopic, {
          message: RuleTargetInput.fromObject({
            bucket: EventField.fromPath('$.detail.bucket.name'),
            key: EventField.fromPath('$.detail.object.key'),
            version: EventField.fromPath('$.detail.object.version-id'),
            time: EventField.fromPath('$.time'),
          }),
        }),
      ],
    });

    // ── Ingest queue with DLQ ───────────────────────────────────
    this.ingestDlq = new Queue(this, 'IngestDlq', {
      queueName: `${RESOURCE_NAMES.ingestQueue}-dlq`,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const dlqConfig: DeadLetterQueue = {
      queue: this.ingestDlq,
      maxReceiveCount: 5,
    };
    this.ingestQueue = new Queue(this, 'IngestQueue', {
      queueName: RESOURCE_NAMES.ingestQueue,
      visibilityTimeout: Duration.seconds(300),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: dlqConfig,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.configInvalidationTopicArn = this.configInvalidationTopic.topicArn;
    this.ingestQueueUrl = this.ingestQueue.queueUrl;

    new CfnOutput(this, 'ConfigInvalidationTopicArn', {
      value: this.configInvalidationTopicArn,
    });
    new CfnOutput(this, 'IngestQueueUrl', { value: this.ingestQueueUrl });
    new CfnOutput(this, 'IngestDlqUrl', { value: this.ingestDlq.queueUrl });

    // ── A1 · EventBridge Scheduler fire queue ───────────────────
    // Each scheduled_tasks row has a paired one-shot EB schedule that
    // fires a JSON message into this queue at the row's nextRunAt.
    // The orchestrator's queue-drain loop polls, claims, and runs the
    // task. Recurring rows update the EB schedule after each fire.
    //
    // The reason this is here at all (instead of the in-process tick
    // that scheduler.ts still implements) is durability: if both
    // Fargate replicas restart simultaneously, the in-process tick
    // would miss the fire window. EB Scheduler buffers in SQS until
    // the queue drain is healthy again.
    //
    // visibilityTimeout 60s — long enough for a typical agent turn
    // including a model round-trip + audit write; short enough that a
    // dead worker's lease expires within a minute.
    this.scheduledFireDlq = new Queue(this, 'ScheduledFireDlq', {
      queueName: `${RESOURCE_NAMES.scheduledFireQueue}-dlq`,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.scheduledFireQueue = new Queue(this, 'ScheduledFireQueue', {
      queueName: RESOURCE_NAMES.scheduledFireQueue,
      visibilityTimeout: Duration.seconds(60),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: {
        queue: this.scheduledFireDlq,
        maxReceiveCount: 5,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Execution role EB Scheduler assumes to write into the queue.
    // Scoped to SendMessage on this queue only — no other actions, no
    // other resources. EB Scheduler also needs PassRole, which the
    // task role gets in iam-stack.ts.
    const schedulerExecRole = new Role(this, 'SchedulerExecutionRole', {
      roleName: RESOURCE_NAMES.schedulerExecutionRole,
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Assumed by EventBridge Scheduler to fire scheduled-task SQS messages',
    });
    schedulerExecRole.addToPolicy(
      new PolicyStatement({
        sid: 'ScheduledFireQueueSend',
        effect: Effect.ALLOW,
        actions: ['sqs:SendMessage'],
        resources: [this.scheduledFireQueue.queueArn],
      }),
    );

    this.scheduledFireQueueUrl = this.scheduledFireQueue.queueUrl;
    this.scheduledFireQueueArn = this.scheduledFireQueue.queueArn;
    this.schedulerExecutionRoleArn = schedulerExecRole.roleArn;
    this.schedulerGroupName = RESOURCE_NAMES.schedulerGroupName;

    new CfnOutput(this, 'ScheduledFireQueueUrl', {
      value: this.scheduledFireQueueUrl,
    });
    new CfnOutput(this, 'ScheduledFireQueueArn', {
      value: this.scheduledFireQueueArn,
    });
    new CfnOutput(this, 'SchedulerExecutionRoleArn', {
      value: this.schedulerExecutionRoleArn,
    });
    new CfnOutput(this, 'SchedulerGroupName', {
      value: this.schedulerGroupName,
    });
  }
}
