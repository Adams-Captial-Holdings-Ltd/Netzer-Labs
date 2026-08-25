import { Stack, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SecurityGroup, Port, SubnetType } from 'aws-cdk-lib/aws-ec2';
import type { IVpc } from 'aws-cdk-lib/aws-ec2';
import { FileSystem, AccessPoint, LifecyclePolicy } from 'aws-cdk-lib/aws-efs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { RESOURCE_NAMES, TAGS, TIERS, paperclipProvisioned } from './constants.js';
import type { BaseStackProps, FilesystemOutputs } from './interfaces.js';

export interface FilesystemStackProps extends BaseStackProps {
  vpc: IVpc;
  paperclipSecurityGroup: SecurityGroup;
}

/**
 * EFS + access point + log group for the Paperclip work engine (ADR 0010).
 *
 * The filesystem holds Paperclip's PAPERCLIP_HOME: git worktrees
 * (reconstructible), the instance config.json, and — unless it is later
 * supplied from Secrets Manager — the secrets master key file, which is
 * emphatically NOT reconstructible. Automatic backups stay ON until that
 * key is sourced from Secrets Manager instead of the filesystem.
 *
 * The access point pins posix uid/gid 1000, matching the `node` user
 * Paperclip's docker-entrypoint drops to; a mismatch produces a recursive
 * chown over NFS on every cold start.
 *
 * TIER-GATED INTERNALLY, same shape as DatabaseStack: always constructed,
 * creates nothing at Tier 0. See TierShape.paperclipEnabled.
 */
export class FilesystemStack extends Stack implements FilesystemOutputs {
  public readonly paperclipFileSystem: FileSystem | undefined;
  public readonly paperclipAccessPoint: AccessPoint | undefined;
  public readonly paperclipLogGroup: LogGroup | undefined;
  public readonly paperclipEfsSecurityGroup: SecurityGroup | undefined;

  constructor(scope: Construct, id: string, props: FilesystemStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    // Tier 0 (Hobby): no EFS, no access point, no log group — the RETAIN'd
    // filesystem is half of the always-on cost the Hobby tier is opting out
    // of. Every consumer already tolerates absence (the fields are optional
    // and PaperclipStack is gated on the same flag).
    if (!paperclipProvisioned(props.tier)) return;

    this.paperclipEfsSecurityGroup = new SecurityGroup(this, 'PaperclipEfsSg', {
      vpc: props.vpc,
      description: 'Paperclip EFS - NFS ingress from the Paperclip task SG only',
      allowAllOutbound: false,
    });
    this.paperclipEfsSecurityGroup.addIngressRule(
      props.paperclipSecurityGroup,
      Port.tcp(2049),
      'Paperclip task to EFS',
    );

    this.paperclipFileSystem = new FileSystem(this, 'PaperclipFs', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: this.paperclipEfsSecurityGroup,
      fileSystemName: RESOURCE_NAMES.paperclipEfs,
      encrypted: true,
      enableAutomaticBackups: true,
      lifecyclePolicy: LifecyclePolicy.AFTER_30_DAYS,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.paperclipAccessPoint = new AccessPoint(this, 'PaperclipAp', {
      fileSystem: this.paperclipFileSystem,
      path: '/paperclip',
      posixUser: { uid: '1000', gid: '1000' },
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
    });

    // The Paperclip service task (Phase 2) references this group by name.
    // Created here, not in ObservabilityStack, so the Paperclip substrate
    // stays inside the two Paperclip stacks.
    this.paperclipLogGroup = new LogGroup(this, 'PaperclipLogGroup', {
      logGroupName: RESOURCE_NAMES.paperclipLogGroup,
      // RetentionDays is a numeric enum whose members ARE day counts
      // (ONE_WEEK = 7 ... ONE_YEAR = 365) and TierShape.logRetentionDays is
      // typed `7 | 30 | 90 | 365`, so the tier value is already a valid
      // member. The mapping helper this replaced was an identity function.
      retention: TIERS[props.tier].logRetentionDays as RetentionDays,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
