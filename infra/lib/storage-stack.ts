import { Duration, RemovalPolicy, Stack, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Key } from 'aws-cdk-lib/aws-kms';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  ObjectLockRetention,
  StorageClass,
} from 'aws-cdk-lib/aws-s3';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { RESOURCE_NAMES, TAGS, bucketName } from './constants.js';
import type { BaseStackProps, StorageOutputs } from './interfaces.js';

/**
 * S3 buckets, KMS CMKs.
 *
 * Three CMKs (data, curated, logs) for clean blast-radius separation.
 * Bucket Keys are enabled on every bucket: per the Codex review, this
 * cuts KMS request cost by ~99% vs default SSE-KMS.
 *
 * Buckets are RETAIN'd on stack destroy so a misconfigured teardown
 * does not delete data. Removal requires explicit aws s3 rb commands.
 */
export class StorageStack extends Stack implements StorageOutputs {
  public readonly dataKey: Key;
  public readonly curatedKey: Key;
  public readonly logsKey: Key;
  public readonly configBucket: Bucket;
  public readonly rawBucket: Bucket;
  public readonly curatedBucket: Bucket;
  public readonly vectorsStagingBucket: Bucket;
  public readonly logsBucket: Bucket;
  /** WORM audit bucket — tier >= 2 only (plan item 26); undefined at T0/T1. */
  public readonly auditLockBucket: Bucket | undefined;

  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const account = Stack.of(this).account;
    const region = Stack.of(this).region;

    // ── KMS keys ────────────────────────────────────────────────────
    this.dataKey = new Key(this, 'DataKey', {
      alias: RESOURCE_NAMES.dataKeyAlias,
      enableKeyRotation: true,
      pendingWindow: Duration.days(30),
      removalPolicy: RemovalPolicy.RETAIN,
      description: 'CMK for config + raw + DDB tables',
    });

    this.curatedKey = new Key(this, 'CuratedKey', {
      alias: RESOURCE_NAMES.curatedKeyAlias,
      enableKeyRotation: true,
      pendingWindow: Duration.days(30),
      removalPolicy: RemovalPolicy.RETAIN,
      description: 'CMK for curated bucket (separate for future cross-account share)',
    });

    this.logsKey = new Key(this, 'LogsKey', {
      alias: RESOURCE_NAMES.logsKeyAlias,
      enableKeyRotation: true,
      pendingWindow: Duration.days(30),
      removalPolicy: RemovalPolicy.RETAIN,
      description: 'CMK for CloudWatch Logs and CloudTrail',
    });

    // CloudWatch Logs uses a service-linked principal (not IAM) to write to
    // KMS-encrypted log groups. The grant must be in the key policy.
    this.logsKey.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
          },
        },
      }),
    );
    // CloudTrail principal for the audit trail (Block 4 adds the trail)
    this.logsKey.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowCloudTrail',
        principals: [new ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: ['*'],
      }),
    );
    // SNS for ops alerts encrypted at rest with this key
    this.logsKey.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowSNS',
        principals: [new ServicePrincipal('sns.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
      }),
    );

    // ── Logs bucket (target for server access logs from other buckets) ──
    // NOTE: S3 server access logging cannot deliver to SSE-KMS buckets, so
    // we use S3-managed encryption here. ALB access logs and CloudTrail can
    // still be delivered to this bucket (they use account-managed delivery
    // paths that bypass the SSE-KMS limitation).
    this.logsBucket = new Bucket(this, 'LogsBucket', {
      bucketName: bucketName(RESOURCE_NAMES.logsBucket, account, region),
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-after-2-years',
          enabled: true,
          expiration: Duration.days(730),
          transitions: [
            { storageClass: StorageClass.GLACIER, transitionAfter: Duration.days(90) },
          ],
        },
      ],
    });

    // CloudTrail needs explicit bucket-policy grants when its delivery
    // bucket is created in a separate stack. (When CDK's Trail creates
    // its own bucket it inserts these automatically; we have to do it
    // here because Trail imports the bucket cross-stack.)
    this.logsBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AWSCloudTrailAclCheck',
        principals: [new ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['s3:GetBucketAcl'],
        resources: [this.logsBucket.bucketArn],
      }),
    );
    this.logsBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AWSCloudTrailWrite',
        principals: [new ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [
          `${this.logsBucket.bucketArn}/cloudtrail/AWSLogs/${account}/*`,
        ],
        conditions: {
          StringEquals: {
            's3:x-amz-acl': 'bucket-owner-full-control',
          },
        },
      }),
    );

    // VPC Flow Logs delivery to S3. The VPC Flow Logs service writes
    // through the AWS log delivery service, which needs ACL check on
    // the bucket and write under the vpc-flow-logs/ prefix. The
    // existing 90-day → Glacier lifecycle rule applies here.
    this.logsBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AWSLogDeliveryAclCheck',
        principals: [new ServicePrincipal('delivery.logs.amazonaws.com')],
        actions: ['s3:GetBucketAcl'],
        resources: [this.logsBucket.bucketArn],
      }),
    );
    this.logsBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AWSLogDeliveryWrite',
        principals: [new ServicePrincipal('delivery.logs.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [`${this.logsBucket.bucketArn}/vpc-flow-logs/AWSLogs/${account}/*`],
        conditions: {
          StringEquals: {
            's3:x-amz-acl': 'bucket-owner-full-control',
          },
        },
      }),
    );

    // A4: DDB ExportTableToPointInTime uses the CALLING identity's S3
    // permissions (the backup Lambda's role), not the DDB service
    // principal — so no bucket-policy grant is needed here. The
    // existing 90-day → Glacier lifecycle rule on this bucket covers
    // the cost story for ddb-exports/ objects.

    // AWS Config delivery channel writes snapshots to config/ prefix.
    // The grants are inert without an associated ConfigRecorder +
    // DeliveryChannel (provisioned by security-stack at T3); keeping
    // them in storage-stack means no cross-stack bucket-policy cycle.
    this.logsBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AWSConfigBucketPermissionsCheck',
        principals: [new ServicePrincipal('config.amazonaws.com')],
        actions: ['s3:GetBucketAcl', 's3:ListBucket'],
        resources: [this.logsBucket.bucketArn],
      }),
    );
    this.logsBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AWSConfigBucketDelivery',
        principals: [new ServicePrincipal('config.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [`${this.logsBucket.bucketArn}/config/AWSLogs/${account}/Config/*`],
        conditions: {
          StringEquals: {
            's3:x-amz-acl': 'bucket-owner-full-control',
          },
        },
      }),
    );

    // ELBv2 access logs need a specific principal too. In us-east-1 the
    // ELB account ID is 127311923021. (Different in other regions.)
    // CDK normally handles this via `loadBalancer.logAccessLogs`, but
    // that adds the policy to the BUCKET stack only when the bucket
    // and ALB are in the same stack. Cross-stack we add it explicitly.
    const elbAccountIdByRegion: Record<string, string> = {
      'us-east-1': '127311923021',
      'us-east-2': '033677994240',
      'us-west-1': '027434742980',
      'us-west-2': '797873946194',
      'eu-west-1': '156460612806',
      'eu-central-1': '054676820928',
    };
    const elbAccountId = elbAccountIdByRegion[region];
    if (elbAccountId) {
      this.logsBucket.addToResourcePolicy(
        new PolicyStatement({
          sid: 'AWSALBAccessLogs',
          principals: [
            new ServicePrincipal('logdelivery.elasticloadbalancing.amazonaws.com'),
          ],
          actions: ['s3:PutObject'],
          resources: [`${this.logsBucket.bucketArn}/alb/AWSLogs/${account}/*`],
        }),
      );
    }

    // ── Audit lock bucket (S3 Object Lock, write-once-read-many) ─────
    // Codex finding #40: audit retention is not audit immutability.
    // Application code double-writes audit events here for true immutability.
    //
    // TIER-GATED (plan item 26): only tier >= 2 gets WORM. Governance
    // retention to 2555 days makes the bucket effectively undeletable in a
    // trial account, so T0/T1 skip it entirely; the audit writer no-ops
    // cleanly when AUDIT_LOCK_BUCKET is unset (src/lib/audit/audit-writer.ts)
    // and teardown classifies the T2+ bucket as an intentional residual.
    if (props.tier >= 2) {
      this.auditLockBucket = new Bucket(this, 'AuditLockBucket', {
        bucketName: bucketName(RESOURCE_NAMES.auditLockBucket, account, region),
        objectLockEnabled: true,
        objectLockDefaultRetention: ObjectLockRetention.governance(Duration.days(2555)),
        encryption: BucketEncryption.S3_MANAGED,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    }

    // ── Config bucket ───────────────────────────────────────────────
    this.configBucket = new Bucket(this, 'ConfigBucket', {
      bucketName: bucketName(RESOURCE_NAMES.configBucket, account, region),
      encryption: BucketEncryption.KMS,
      encryptionKey: this.dataKey,
      bucketKeyEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 'config/',
      lifecycleRules: [
        {
          id: 'expire-old-versions',
          enabled: true,
          noncurrentVersionExpiration: Duration.days(90),
        },
      ],
    });

    // ── Raw bucket ──────────────────────────────────────────────────
    this.rawBucket = new Bucket(this, 'RawBucket', {
      bucketName: bucketName(RESOURCE_NAMES.rawBucket, account, region),
      encryption: BucketEncryption.KMS,
      encryptionKey: this.dataKey,
      bucketKeyEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 'raw/',
      lifecycleRules: [
        {
          id: 'intelligent-tier-then-expire',
          enabled: true,
          transitions: [
            { storageClass: StorageClass.INTELLIGENT_TIERING, transitionAfter: Duration.days(30) },
          ],
          expiration: Duration.days(365),
        },
      ],
    });

    // ── Curated bucket ──────────────────────────────────────────────
    this.curatedBucket = new Bucket(this, 'CuratedBucket', {
      bucketName: bucketName(RESOURCE_NAMES.curatedBucket, account, region),
      encryption: BucketEncryption.KMS,
      encryptionKey: this.curatedKey,
      bucketKeyEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 'curated/',
      lifecycleRules: [
        {
          id: 'intelligent-tier',
          enabled: true,
          transitions: [
            { storageClass: StorageClass.INTELLIGENT_TIERING, transitionAfter: Duration.days(60) },
          ],
        },
      ],
    });

    // CfnOutputs (deploy script reads these to populate .env)
    new CfnOutput(this, 'ConfigBucketName', { value: this.configBucket.bucketName });
    new CfnOutput(this, 'RawBucketName', { value: this.rawBucket.bucketName });
    new CfnOutput(this, 'CuratedBucketName', { value: this.curatedBucket.bucketName });
    new CfnOutput(this, 'LogsBucketName', { value: this.logsBucket.bucketName });
    if (this.auditLockBucket) {
      new CfnOutput(this, 'AuditLockBucketName', { value: this.auditLockBucket.bucketName });
    }
    new CfnOutput(this, 'DataKeyArn', { value: this.dataKey.keyArn });
    new CfnOutput(this, 'CuratedKeyArn', { value: this.curatedKey.keyArn });
    new CfnOutput(this, 'LogsKeyArn', { value: this.logsKey.keyArn });

    // ── Vectors staging bucket ──────────────────────────────────────
    this.vectorsStagingBucket = new Bucket(this, 'VectorsStagingBucket', {
      bucketName: bucketName(RESOURCE_NAMES.vectorsStagingBucket, account, region),
      encryption: BucketEncryption.KMS,
      encryptionKey: this.dataKey,
      bucketKeyEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 'vectors-staging/',
      lifecycleRules: [
        {
          id: 'expire-staging-fast',
          enabled: true,
          expiration: Duration.days(7),
        },
      ],
      // Browser-PUT CORS for the dashboard's presigned uploads (the
      // branding-logo path: browser PUTs to staging, backend copies to
      // curated). Previously applied manually via put-bucket-cors; IaC
      // readiness item 27 moved it into CDK. Origins: the public
      // dashboard domain when configured, plus localhost for the
      // SSM-tunnel access path.
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [HttpMethods.PUT],
          allowedOrigins: [
            ...(process.env.DOMAIN_NAME?.trim()
              ? [`https://${process.env.DOMAIN_NAME.trim()}`]
              : []),
            'http://localhost:3000',
          ],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });
  }
}
