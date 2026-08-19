/**
 * Synth-level assertions for CCE-Filesystem (Paperclip EFS + log group,
 * ADR 0010). The plan's Phase 1 checks: the access point posix uid/gid is
 * 1000 (the `node` user Paperclip's entrypoint drops to — a mismatch
 * triggers a recursive chown over NFS on every cold start), NFS ingress is
 * from the Paperclip SG only, and the log group lives under /claudeclaw/.
 */
import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from './network-stack.js';
import { FilesystemStack } from './filesystem-stack.js';

const ENV = { account: '637423318609', region: 'us-east-1' };

function synth() {
  const app = new App();
  const network = new NetworkStack(app, 'CCE-Network', { tier: 1, env: ENV });
  const filesystem = new FilesystemStack(app, 'CCE-Filesystem', {
    tier: 1,
    env: ENV,
    vpc: network.vpc,
    paperclipSecurityGroup: network.paperclipSecurityGroup,
  });
  return Template.fromStack(filesystem);
}

const t = synth();

describe('FilesystemStack (Paperclip EFS)', () => {
  it('pins the access point to posix uid/gid 1000 at /paperclip', () => {
    t.hasResourceProperties('AWS::EFS::AccessPoint', {
      PosixUser: { Uid: '1000', Gid: '1000' },
      RootDirectory: {
        Path: '/paperclip',
        CreationInfo: {
          OwnerUid: '1000',
          OwnerGid: '1000',
          Permissions: '750',
        },
      },
    });
  });

  it('encrypts, backs up, and retains the filesystem', () => {
    t.hasResourceProperties('AWS::EFS::FileSystem', {
      Encrypted: true,
      BackupPolicy: { Status: 'ENABLED' },
    });
    t.hasResource('AWS::EFS::FileSystem', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('admits NFS 2049 from the Paperclip SG only', () => {
    // SG-to-SG rules synth as standalone ingress resources.
    const rules = Object.values(
      t.findResources('AWS::EC2::SecurityGroupIngress'),
    ).map((r) => r.Properties as Record<string, unknown>);
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule.FromPort).toBe(2049);
    expect(rule.ToPort).toBe(2049);
    expect(rule.Description).toBe('Paperclip task to EFS');
    expect(JSON.stringify(rule.SourceSecurityGroupId)).toMatch(/PaperclipSg/);
    expect(JSON.stringify(t.toJSON())).not.toMatch(/FargateSg/);
  });

  it('creates the Paperclip log group under /claudeclaw/', () => {
    t.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/claudeclaw/paperclip',
      RetentionInDays: 30,
    });
  });
});
