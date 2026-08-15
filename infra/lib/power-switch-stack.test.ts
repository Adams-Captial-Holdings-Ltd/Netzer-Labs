/**
 * Synth-level assertions for the CCE-PowerSwitch stack: the control plane is
 * shaped the way the hardened plan requires (no-VPC Lambda, reserved concurrency,
 * secret-gated Function URL, IAM-gated auto-pause scheduler, least-privilege role).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PowerSwitchStack } from './power-switch-stack.js';

function synth(reservedConcurrency?: number, autoPauseEnabled?: boolean) {
  const app = new App();
  const stack = new PowerSwitchStack(app, 'TestPowerSwitch', {
    tier: 3,
    env: { account: '637423318609', region: 'us-east-1' },
    mutedAlarms: ['CCE-Observability-SchedulerStalledAlarm'],
    dashboardUrl: 'https://dash.example.com',
    costNote: 'Paused about $150/mo. Awake about $700/mo.',
    reservedConcurrency,
    autoPauseEnabled,
  });
  return Template.fromStack(stack);
}

describe('PowerSwitchStack', () => {
  const t = synth();
  const json = JSON.stringify(t.toJSON());

  it('creates exactly one Lambda, table, secret, function url, and schedule', () => {
    t.resourceCountIs('AWS::Lambda::Function', 1);
    t.resourceCountIs('AWS::DynamoDB::Table', 1);
    t.resourceCountIs('AWS::SecretsManager::Secret', 1);
    t.resourceCountIs('AWS::Lambda::Url', 1);
    t.resourceCountIs('AWS::Scheduler::Schedule', 1);
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

  it('auto-pause schedule invokes the lambda with the scheduler contract', () => {
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'claudeclaw-power-auto-pause',
      ScheduleExpressionTimezone: 'America/Toronto',
      Target: Match.objectLike({
        Input: Match.stringLikeRegexp('auto-pause'),
      }),
    });
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

  it('wires the restore-visibility env: health probe, panel copy, muted alarms', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          HEALTH_URL: 'https://dash.example.com/health',
          DASHBOARD_URL: 'https://dash.example.com',
          COST_NOTE: 'Paused about $150/mo. Awake about $700/mo.',
          MUTED_ALARMS: 'CCE-Observability-SchedulerStalledAlarm',
          // 'disabled', not a cron. This synth is production (no
          // CCE_NAME_SUFFIX), where the nightly pause is now off by default —
          // the panel must say so rather than advertise a schedule that will
          // never fire. The armed-label case is covered in the staging suite.
          AUTO_PAUSE_LABEL: 'disabled',
          APP_TAG_VALUE: 'claudeclaw-enterprise',
          APP_PREFIX: 'claudeclaw',
        }),
      },
    });
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

/**
 * The connector-availability boundary.
 *
 * A pause sets the autoscaling target to (0,0) and desiredCount to 0. Every
 * cloudflared connector lives in those tasks, so a successful pause makes the
 * published hostname serve Cloudflare Error 1033 — and nothing undoes it,
 * because the stack creates exactly one schedule and its only payload is
 * `auto-pause`. Wake is reachable only through the Function URL.
 *
 * Until 2026-08-15 the CfnSchedule set no `state` at all, so CloudFormation
 * defaulted it to ENABLED in production. These tests pin the three independent
 * guards that replaced that: the schedule is DISABLED unless armed, the handler
 * is told to refuse regardless, and production cannot arm it at all.
 */
describe('PowerSwitchStack — production connector-availability boundary', () => {
  const scheduleOf = (t: ReturnType<typeof synth>) =>
    Object.values(t.findResources('AWS::Scheduler::Schedule'))[0].Properties;
  const lambdaEnvOf = (t: ReturnType<typeof synth>) =>
    Object.values(t.findResources('AWS::Lambda::Function'))[0].Properties.Environment.Variables;

  it('DISABLES the auto-pause schedule by default', () => {
    expect(scheduleOf(synth()).State).toBe('DISABLED');
  });

  it('tells the handler to refuse auto-pause by default', () => {
    expect(lambdaEnvOf(synth()).AUTO_PAUSE_FORBIDDEN).toBe('1');
  });

  it('reports the pause as disabled on the panel rather than advertising a cron', () => {
    expect(lambdaEnvOf(synth()).AUTO_PAUSE_LABEL).toBe('disabled');
  });

  it('still creates the schedule resource, so re-arming is one key and stays auditable', () => {
    synth().resourceCountIs('AWS::Scheduler::Schedule', 1);
  });

  it('REFUSES TO SYNTH when production tries to arm it', () => {
    // The default test env has no CCE_NAME_SUFFIX, so APP_NAME_SUFFIX is ''
    // — i.e. this IS production. Arming must fail the deploy, not warn.
    expect(() => synth(undefined, true)).toThrow(/production must never arm the nightly auto-pause/);
  });

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

/**
 * Staging keeps the cost-saving pause. Same code path, different environment,
 * so the suffix has to be stubbed before the constants module is evaluated —
 * APP_NAME_SUFFIX is read from process.env at import time.
 */
describe('PowerSwitchStack — a suffixed environment may still arm the pause', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('CCE_NAME_SUFFIX', 'staging');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function synthStaging(autoPauseEnabled: boolean) {
    const { PowerSwitchStack: Staging } = await import('./power-switch-stack.js');
    const app = new App();
    return Template.fromStack(
      new Staging(app, 'TestStagingPowerSwitch', {
        tier: 0,
        env: { account: '637423318609', region: 'us-east-1' },
        autoPauseEnabled,
      }),
    );
  }

  it('ENABLES the schedule and clears the refusal when staging arms it', async () => {
    const t = await synthStaging(true);
    const schedule = Object.values(t.findResources('AWS::Scheduler::Schedule'))[0].Properties;
    const envVars = Object.values(t.findResources('AWS::Lambda::Function'))[0].Properties
      .Environment.Variables;
    expect(schedule.State).toBe('ENABLED');
    expect(schedule.ScheduleExpressionTimezone).toBe('America/Toronto');
    expect(schedule.Target.Input).toContain('auto-pause');
    expect(envVars.AUTO_PAUSE_FORBIDDEN).toBe('');
    expect(envVars.AUTO_PAUSE_LABEL).toMatch(/nightly at 06:00/);
  });

  it('still defaults to DISABLED when staging does not arm it', async () => {
    const t = await synthStaging(false);
    const schedule = Object.values(t.findResources('AWS::Scheduler::Schedule'))[0].Properties;
    expect(schedule.State).toBe('DISABLED');
  });
});
