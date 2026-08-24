/**
 * Cross-stack prop interfaces. Each stack imports what it needs from
 * here so we don't pass raw construct references through unrelated stacks.
 */

import type { StackProps } from 'aws-cdk-lib';
import type { IVpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { IRole } from 'aws-cdk-lib/aws-iam';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type { IDatabaseCluster } from 'aws-cdk-lib/aws-rds';
import type { IFileSystem, IAccessPoint } from 'aws-cdk-lib/aws-efs';
import type { ILogGroup } from 'aws-cdk-lib/aws-logs';
import type { DeployTier } from './constants.js';

/**
 * Base props every stack inherits. Carries deploy-tier and env context.
 */
export interface BaseStackProps extends StackProps {
  tier: DeployTier;
}

/**
 * NetworkStack exports.
 */
export interface NetworkOutputs {
  vpc: IVpc;
  albSecurityGroup: SecurityGroup;
  fargateSecurityGroup: SecurityGroup;
  endpointsSecurityGroup: SecurityGroup;
  /** Paperclip server task SG (ADR 0010) — single-node, stateful; port 3100. */
  paperclipSecurityGroup: SecurityGroup;
}

/**
 * StorageStack exports.
 */
export interface StorageOutputs {
  dataKey: IKey;
  curatedKey: IKey;
  logsKey: IKey;
  configBucket: IBucket;
  rawBucket: IBucket;
  curatedBucket: IBucket;
  vectorsStagingBucket: IBucket;
  /** Durable vector index. No lifecycle expiry, versioning on. */
  vectorsBucket: IBucket;
  logsBucket: IBucket;
  /**
   * WORM audit bucket (S3 Object Lock). Tier-gated: only created at
   * tier >= 2 (plan item 26 — T0/T1 skip WORM so a hobby/trial account is
   * never stuck with a 2555-day-governance-locked bucket it can't delete).
   * Undefined at T0/T1; every consumer must tolerate absence.
   */
  auditLockBucket: IBucket | undefined;
}

/**
 * SecretsStack exports.
 */
export interface SecretsOutputs {
  slackSecret: ISecret;
  telegramSecret: ISecret;
  dashboardSecret: ISecret;
  dbEncryptionSecret: ISecret;
  bedrockGuardrailsSecret: ISecret;
  vendorKeysSecret: ISecret;
  /** Paperclip work engine (ADR 0010): operator-populated integration keys. */
  paperclipSecret: ISecret;
}

/**
 * DatabaseStack exports (Paperclip work engine, ADR 0010).
 * The generated DB credentials secret is re-imported by ARN downstream
 * (compute-stack.ts:200-226 pattern) to avoid cross-stack cycles.
 */
export interface DatabaseOutputs {
  paperclipDbCluster: IDatabaseCluster;
  paperclipDbSecret: ISecret;
}

/**
 * FilesystemStack exports (Paperclip work engine, ADR 0010).
 */
export interface FilesystemOutputs {
  paperclipFileSystem: IFileSystem;
  paperclipAccessPoint: IAccessPoint;
  paperclipLogGroup: ILogGroup;
}

/**
 * DynamoStack exports. 23 tables (15 pre-v5.6 + 8 v5.6).
 */
export interface DynamoOutputs {
  sessionsTable: ITable;
  hiveMindTable: ITable;
  auditLogTable: ITable;
  chatConfigTable: ITable;
  tokenUsageTable: ITable;
  memoriesTable: ITable;
  consolidationsTable: ITable;
  agentFileHistoryTable: ITable;
  missionTasksTable: ITable;
  scheduledTasksTable: ITable;
  killSwitchesTable: ITable;
  interAgentTasksTable: ITable;
  compactionEventsTable: ITable;
  queueLeaseTable: ITable;
  /** C4: cross-surface identity mapping. */
  identitiesTable: ITable;
  /** Per-operator dashboard tokens (read at auth time, root-token seed write). */
  dashboardTokensTable: ITable;
  // v5.6 tables
  hookIdempotencyTable: ITable;
  spawnLedgerTable: ITable;
  spendLedgerTable: ITable;
  extensionSubnetPoolTable: ITable;
  extensionsRegistryTable: ITable;
  warroomMeetingsTable: ITable;
  warroomTurnsTable: ITable;
  warroomConnectionsTable: ITable;
  rateLimitsTable: ITable;
  agentsTable: ITable;
  runtimeConfigTable: ITable;
  // Jarvis voice co-pilot (Phase 1).
  jarvisTicketsTable: ITable;
  jarvisLeasesTable: ITable;
  jarvisLedgerTable: ITable;
  jarvisCanaryTable: ITable;
}

/**
 * IamStack exports.
 *
 * Only the task role lives here (the application's runtime identity).
 * The task execution role is created in ComputeStack because it grants
 * permissions on secrets that are wired in by EcsSecret.fromSecretsManager,
 * and that bidirectional grant would otherwise cycle through stacks.
 */
export interface IamOutputs {
  taskRole: IRole;
}

/**
 * GuardrailsStack exports.
 */
export interface GuardrailsOutputs {
  guardrailId: string;
  guardrailVersion: string;
}

/**
 * ComputeStack exports.
 */
export interface ComputeOutputs {
  albDnsName: string;
}

/**
 * ObservabilityStack exports.
 */
export interface ObservabilityOutputs {
  alertTopic: ITopic;
}

/**
 * MessagingStack exports.
 */
export interface MessagingOutputs {
  configInvalidationTopicArn: string;
  ingestQueueUrl: string;
  /** A1: SQS queue EventBridge Scheduler fires into. */
  scheduledFireQueueUrl: string;
  scheduledFireQueueArn: string;
  /** Execution role EB Scheduler assumes to write into the scheduled-fire queue. */
  schedulerExecutionRoleArn: string;
  /** EB Scheduler schedule-group name (defaults to app slug). */
  schedulerGroupName: string;
}
