/**
 * Synth-level assertions for CCE-Database (Paperclip Aurora, ADR 0010).
 * The load-bearing checks from the plan's Phase 1: the DB admits 5432 from
 * the Paperclip task SG ONLY (never the orchestrator's Fargate SG), the
 * cluster cannot be deleted casually, and the orchestrator's own network
 * rules are untouched by the Paperclip additions.
 */
import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from './network-stack.js';
import { DatabaseStack } from './database-stack.js';

const ENV = { account: '637423318609', region: 'us-east-1' };

function synth() {
  const app = new App();
  const network = new NetworkStack(app, 'CCE-Network', { tier: 1, env: ENV });
  const database = new DatabaseStack(app, 'CCE-Database', {
    tier: 1,
    env: ENV,
    vpc: network.vpc,
    paperclipSecurityGroup: network.paperclipSecurityGroup,
  });
  return {
    network: Template.fromStack(network),
    database: Template.fromStack(database),
  };
}

// SG-to-SG rules synth as standalone AWS::EC2::SecurityGroupIngress
// resources (CDK's cyclic-reference avoidance), so assert on those.
type IngressProps = {
  IpProtocol: string;
  FromPort?: number;
  ToPort?: number;
  Description?: string;
  GroupId?: unknown;
  SourceSecurityGroupId?: unknown;
};

function ingressRules(template: Template): IngressProps[] {
  return Object.values(
    template.findResources('AWS::EC2::SecurityGroupIngress'),
  ).map((r) => r.Properties as IngressProps);
}

function auroraMaxAcuAt(tier: 0 | 1 | 2 | 3): number {
  const app = new App();
  const network = new NetworkStack(app, 'CCE-Network', { tier, env: ENV });
  const db = new DatabaseStack(app, 'CCE-Database', {
    tier,
    env: ENV,
    vpc: network.vpc,
    paperclipSecurityGroup: network.paperclipSecurityGroup,
  });
  const cluster = Object.values(
    Template.fromStack(db).findResources('AWS::RDS::DBCluster'),
  )[0] as { Properties: { ServerlessV2ScalingConfiguration: { MaxCapacity: number } } };
  return cluster.Properties.ServerlessV2ScalingConfiguration.MaxCapacity;
}

const { network, database } = synth();
const dbJson = JSON.stringify(database.toJSON());

describe('DatabaseStack (Paperclip Aurora)', () => {
  it('tiers the Aurora ceiling but never the floor', () => {
    // A Hobby install must not be able to burst to a production-sized bill.
    expect(auroraMaxAcuAt(0)).toBe(1);
    expect(auroraMaxAcuAt(1)).toBe(2);
    // Tier 2 keeps the value that used to be hardcoded for every tier.
    expect(auroraMaxAcuAt(2)).toBe(4);
    expect(auroraMaxAcuAt(3)).toBe(8);
    // The FLOOR stays untiered at 0.5, pinned by the case above: it is the
    // lowest non-zero ACU, so every tier carries the same continuous cost.
    // Cutting it means scale-to-zero, a behaviour change and a separate call.
  });

  it('admits 5432 from the Paperclip SG only — never the Fargate SG', () => {
    const rules = ingressRules(database);
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule.FromPort).toBe(5432);
    expect(rule.ToPort).toBe(5432);
    expect(rule.IpProtocol).toBe('tcp');
    expect(rule.Description).toBe('Paperclip task to Aurora');
    // The ingress source arrives as a cross-stack import whose export name
    // embeds the source construct path. Paperclip yes, Fargate no.
    expect(JSON.stringify(rule.SourceSecurityGroupId)).toMatch(/PaperclipSg/);
    expect(dbJson).not.toMatch(/FargateSg/);
  });

  it('is Aurora Serverless v2 PostgreSQL 17 with the minimum ACU floor', () => {
    database.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      EngineVersion: '17.4',
      DatabaseName: 'paperclip',
      // Floor is untiered; the ceiling is (this harness synths at tier 1).
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
      StorageEncrypted: true,
      BackupRetentionPeriod: 14,
      DeletionProtection: true,
    });
  });

  it('retains the cluster and names its generated secret deterministically', () => {
    database.hasResource('AWS::RDS::DBCluster', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    database.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: '/claudeclaw/paperclip-db',
    });
  });
});

describe('NetworkStack regression (orchestrator untouched by Paperclip)', () => {
  it('keeps the Fargate SG exactly as before: one 3000 ingress from the ALB, no 3100', () => {
    const fargateRules = ingressRules(network).filter((r) =>
      /FargateSg/.test(JSON.stringify(r.GroupId)),
    );
    expect(fargateRules).toHaveLength(1);
    expect(fargateRules[0].FromPort).toBe(3000);
    expect(fargateRules[0].Description).toBe('ALB to Fargate');
  });

  it('gives Paperclip its own SG with exactly one 3100 ingress from the ALB', () => {
    const paperclipRules = ingressRules(network).filter((r) =>
      /PaperclipSg/.test(JSON.stringify(r.GroupId)),
    );
    expect(paperclipRules).toHaveLength(1);
    expect(paperclipRules[0].FromPort).toBe(3100);
    expect(paperclipRules[0].ToPort).toBe(3100);
    expect(paperclipRules[0].Description).toBe('ALB to Paperclip');
  });
  it('keeps every security group description ASCII', () => {
    // EC2 rejects GroupDescription outside ASCII ("Character sets beyond
    // ASCII are not supported"), and this repo writes em dashes everywhere
    // else. One slipped in and rolled back a staging deploy.
    // NetworkStack is checked here too: it owns PaperclipSg, the one
    // Paperclip security group that is actually deployed, and this guard
    // previously asserted on `database` inside a describe block named for
    // NetworkStack — so nothing covered it.
    // ponytail: covers these two stacks plus FilesystemStack's own copy; a
    // whole-app synth check would catch every stack, at the cost of a slow
    // test. Add if a stack outside these three regresses.
    for (const template of [network, database]) {
      for (const sg of Object.values(template.findResources('AWS::EC2::SecurityGroup'))) {
        const d = sg.Properties?.GroupDescription;
        if (typeof d === 'string') expect(d).toMatch(/^[ -~]*$/);
      }
    }
  });
});
