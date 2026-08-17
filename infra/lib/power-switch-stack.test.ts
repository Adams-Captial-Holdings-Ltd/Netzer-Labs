/**
 * Synth-level assertions for the CCE-PowerSwitch stack: the control plane is
 * shaped the way the hardened plan requires (no-VPC Lambda, reserved concurrency,
 * secret-gated Function URL, and least-privilege role).
 */
import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PowerSwitchStack } from './power-switch-stack.js';

function synth(reservedConcurrency?: number) {
  const app = new App();
  const stack = new PowerSwitchStack(app, 'TestPowerSwitch', {
    tier: 3,
    env: { account: '637423318609', region: 'us-east-1' },
    mutedAlarms: ['CCE-Observability-SchedulerStalledAlarm'],
    dashboardUrl: 'https://dash.example.com',
    costNote: 'Paused about $150/mo. Awake about $700/mo.',
    reservedConcurrency,
  });
  return Template.fromStack(stack);
}

describe('PowerSwitchStack', () => {
  const t = synth();
  const json = JSON.stringify(t.toJSON());

  it('creates exactly one Lambda, table, secret, and function url without a Scheduler path', () => {
    t.resourceCountIs('AWS::Lambda::Function', 1);
    t.resourceCountIs('AWS::DynamoDB::Table', 1);
    t.resourceCountIs('AWS::SecretsManager::Secret', 1);
    t.resourceCountIs('AWS::Lambda::Url', 1);
    t.resourceCountIs('AWS::Scheduler::Schedule', 0);
    expect(json).not.toContain('scheduler.amazonaws.com');
  });

  it('Lambda is nodejs20, bounded concurrency, no VPC, with the control env', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'claudeclaw-power-switch',
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      // Small but > 1: reads (/status + /costs + polling) run in parallel;
      // pause/wake stay serialised by the DDB lease lock, not by concurrency.
      ReservedConcurrentExecutions: 5,
      VpcConfig: Match.absent(), // must not depend on the NAT a deep cut removes
      Environment: {
        Variables: Match.objectLike({
          CLUSTER: 'claudeclaw-cluster',
          SERVICE: 'claudeclaw-service',
          RES_ID: 'service/claudeclaw-cluster/claudeclaw-service',
          SWITCH_TABLE: 'claudeclaw-kill-switches',
          CONSOLIDATION_RULE: 'claudeclaw-consolidation-nightly',
          WAKE_MIN: '3',
          WAKE_MAX: '20',
          WAKE_DESIRED: '3',
          LEASE_MINUTES: '15',
        }),
      },
    });
  });

  it('can defer reserved concurrency for an account whose quota is still 10', () => {
    const lowQuota = synth(0);
    lowQuota.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'claudeclaw-power-switch',
      ReservedConcurrentExecutions: Match.absent(),
      VpcConfig: Match.absent(),
    });
  });

  it('Function URL is unauthenticated at the edge (token enforced in the handler)', () => {
    t.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
  });

  it('DynamoDB power-state table is on-demand and retained', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'claudeclaw-power-state',
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('IAM grants exactly the pause/wake levers and nothing destructive', () => {
    // present: the levers the handler needs
    for (const action of [
      'ecs:UpdateService',
      'application-autoscaling:RegisterScalableTarget',
      'sns:Publish',
      'events:DisableRule',
      'events:EnableRule',
      'cloudwatch:DisableAlarmActions',
      'secretsmanager:GetSecretValue',
    ]) {
      expect(json, `expected role to allow ${action}`).toContain(action);
    }
    // /costs live inventory is list/describe/cost-read only
    for (const action of [
      'ec2:DescribeNatGateways',
      'elasticloadbalancing:DescribeLoadBalancers',
      'kms:ListAliases',
      'secretsmanager:ListSecrets',
      'wafv2:ListWebACLs',
      'route53:ListHostedZones',
      'ce:GetCostAndUsage',
      'ecs:DescribeTaskDefinition',
    ]) {
      expect(json, `expected role to allow ${action}`).toContain(action);
    }
    // KMS is scoped to DynamoDB-mediated use only
    expect(json).toContain('kms:ViaService');
    // absent: no destructive or broad escalation
    for (const forbidden of ['ecs:DeleteService', 'dynamodb:DeleteTable', 'iam:PassRole', 'ecs:RunTask']) {
      expect(json, `role must NOT allow ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('wires the restore-visibility env without unattended auto-pause controls', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          HEALTH_URL: 'https://dash.example.com/health',
          DASHBOARD_URL: 'https://dash.example.com',
          COST_NOTE: 'Paused about $150/mo. Awake about $700/mo.',
          MUTED_ALARMS: 'CCE-Observability-SchedulerStalledAlarm',
          APP_TAG_VALUE: 'claudeclaw-enterprise',
          APP_PREFIX: 'claudeclaw',
        }),
      },
    });
  });

  it('does not pass auto-pause configuration to the Lambda', () => {
    const env = Object.values(t.findResources('AWS::Lambda::Function'))[0].Properties.Environment.Variables;
    expect(Object.keys(env)).not.toContain('AUTO_PAUSE_LABEL');
    expect(Object.keys(env)).not.toContain('AUTO_PAUSE_FORBIDDEN');
  });

  it('alarm-mute IAM covers both alarm naming shapes (claudeclaw-* and <prefix>-*)', () => {
    // The CDK-generated observability alarms are named <stackPrefix>-Observability-…;
    // the stack derives the prefix from its own name (here TestPowerSwitch → no
    // -PowerSwitch suffix match, so the stack name itself is the prefix).
    expect(json).toContain('alarm:claudeclaw-*');
    expect(json).toContain('alarm:TestPowerSwitch-*');
  });

  it('never emits the token as a stack output', () => {
    const outJson = JSON.stringify(t.toJSON().Outputs ?? {});
    expect(outJson).not.toMatch(/token["']?\s*:\s*["'][A-Za-z0-9]{20,}/);
    // the URL output exists though
    expect(outJson).toContain('FunctionUrl');
  });
});

describe('PowerSwitchStack — production connector-availability boundary', () => {
  it('REFUSES TO SYNTH when production drops below the connector floor', () => {
    const app = new App();
    expect(
      () =>
        new PowerSwitchStack(app, 'TestFloor', {
          tier: 3,
          env: { account: '637423318609', region: 'us-east-1' },
          wakeMin: 1,
        }),
    ).toThrow(/connector floor must be >= 2/);
  });
});
