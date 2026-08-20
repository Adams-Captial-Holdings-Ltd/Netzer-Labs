import { Stack, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SecurityGroup, Port, SubnetType } from 'aws-cdk-lib/aws-ec2';
import type { IVpc } from 'aws-cdk-lib/aws-ec2';
import {
  DatabaseCluster,
  DatabaseClusterEngine,
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
} from 'aws-cdk-lib/aws-rds';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { RESOURCE_NAMES, TAGS } from './constants.js';
import type { BaseStackProps, DatabaseOutputs } from './interfaces.js';

export interface DatabaseStackProps extends BaseStackProps {
  vpc: IVpc;
  paperclipSecurityGroup: SecurityGroup;
}

/**
 * Aurora Serverless v2 PostgreSQL 17 for the Paperclip work engine
 * (ADR 0010). Paperclip is the only client: the DB security group admits
 * 5432 from the Paperclip task SG and nothing else — explicitly NOT from
 * the orchestrator's Fargate SG, which must keep failing to connect
 * (DL-2: service boundary, not shared database).
 *
 * Deletion protection + RETAIN are deliberate: this cluster becomes the
 * system of record for work items. Rollback of the stack must never take
 * the data with it (the plan's Phase 1 rollback notes the explicit
 * override that removing it requires).
 */
export class DatabaseStack extends Stack implements DatabaseOutputs {
  public readonly paperclipDbCluster: DatabaseCluster;
  public readonly paperclipDbSecret: ISecret;
  public readonly paperclipDbSecurityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    this.paperclipDbSecurityGroup = new SecurityGroup(this, 'PaperclipDbSg', {
      vpc: props.vpc,
      description: 'Paperclip Aurora - ingress from the Paperclip task SG only',
      allowAllOutbound: false,
    });
    this.paperclipDbSecurityGroup.addIngressRule(
      props.paperclipSecurityGroup,
      Port.tcp(5432),
      'Paperclip task to Aurora',
    );

    this.paperclipDbCluster = new DatabaseCluster(this, 'PaperclipDb', {
      engine: DatabaseClusterEngine.auroraPostgres({
        // PG 17 to match the pinned Paperclip release's postgres:17 harness.
        // Bump minor versions deliberately, with a snapshot before migration.
        version: AuroraPostgresEngineVersion.VER_17_4,
      }),
      clusterIdentifier: RESOURCE_NAMES.paperclipDbCluster,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.paperclipDbSecurityGroup],
      writer: ClusterInstance.serverlessV2('Writer'),
      // Min ACU is the dominant fixed cost (bills continuously). Keep the
      // floor at the lowest supported setting until observed load says
      // otherwise; the anomaly monitor watches the first weeks.
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      defaultDatabaseName: 'paperclip',
      credentials: Credentials.fromGeneratedSecret('paperclip', {
        secretName: RESOURCE_NAMES.secrets.paperclipDb,
      }),
      storageEncrypted: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // Automated backups + PITR window. A snapshot precedes every
      // Paperclip migration job run (deploy-script responsibility).
      backup: { retention: Duration.days(14) },
    });

    // The generated credentials secret ships DATABASE_URL ingredients to the
    // Paperclip task definition in a later phase (re-imported by ARN there,
    // per the compute-stack cycle-avoidance pattern).
    this.paperclipDbSecret = this.paperclipDbCluster.secret!;
  }
}
