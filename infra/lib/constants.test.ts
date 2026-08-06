import { describe, it, expect } from 'vitest';
import {
  TIERS,
  bucketName,
  buildApp,
  buildResourceNames,
  RESOURCE_NAMES,
} from './constants.js';

describe('tier defaults', () => {
  it('has all four tiers defined', () => {
    expect(TIERS[0].label).toBe('Hobby');
    expect(TIERS[1].label).toBe('Standard');
    expect(TIERS[2].label).toBe('Pro');
    expect(TIERS[3].label).toBe('Enterprise');
  });

  it('escalates resources monotonically (sizing only increases)', () => {
    for (let t = 0; t < 3; t++) {
      expect(TIERS[(t + 1) as 1 | 2 | 3].fargateMaxTasks).toBeGreaterThanOrEqual(
        TIERS[t as 0 | 1 | 2].fargateMaxTasks,
      );
      expect(TIERS[(t + 1) as 1 | 2 | 3].logRetentionDays).toBeGreaterThanOrEqual(
        TIERS[t as 0 | 1 | 2].logRetentionDays,
      );
      expect(TIERS[(t + 1) as 1 | 2 | 3].dailyCostCapDefaultUsd).toBeGreaterThanOrEqual(
        TIERS[t as 0 | 1 | 2].dailyCostCapDefaultUsd,
      );
    }
  });

  it('only T0 ships with 1 NAT gateway', () => {
    expect(TIERS[0].natGatewayCount).toBe(1);
    // T1/T2/T3 all run 2 NATs across 2 AZs. Going to 3 NATs requires
    // a 3-AZ VPC, which the existing /16 layout can't accommodate
    // in-place; capped to keep upgrades non-destructive.
    expect(TIERS[1].natGatewayCount).toBe(2);
    expect(TIERS[2].natGatewayCount).toBe(2);
    expect(TIERS[3].natGatewayCount).toBe(2);
  });

  it('WAF and X-Ray only kick in at T2+', () => {
    expect(TIERS[0].wafEnabled).toBe(false);
    expect(TIERS[1].wafEnabled).toBe(false);
    expect(TIERS[2].wafEnabled).toBe(true);
    expect(TIERS[3].wafEnabled).toBe(true);
    expect(TIERS[0].xrayEnabled).toBe(false);
    expect(TIERS[1].xrayEnabled).toBe(false);
    expect(TIERS[2].xrayEnabled).toBe(true);
    expect(TIERS[3].xrayEnabled).toBe(true);
  });

  it('only T3 ships with CloudFront', () => {
    expect(TIERS[3].cloudFrontEnabled).toBe(true);
    for (const t of [0, 1, 2] as const) {
      expect(TIERS[t].cloudFrontEnabled).toBe(false);
    }
  });
});

describe('bucketName', () => {
  it('appends account and region', () => {
    expect(bucketName('claudeclaw-raw', '123', 'us-east-1')).toBe(
      'claudeclaw-raw-123-us-east-1',
    );
  });
});

describe('buildApp', () => {
  it('returns the base slug with no suffix', () => {
    expect(buildApp('')).toBe('claudeclaw');
  });

  it('joins a non-empty suffix with a dash', () => {
    expect(buildApp('staging')).toBe('claudeclaw-staging');
    expect(buildApp('preview')).toBe('claudeclaw-preview');
  });
});

describe('buildResourceNames', () => {
  it('produces prod-shape names with empty suffix', () => {
    const names = buildResourceNames('');
    expect(names.ecrRepo).toBe('claudeclaw-orchestrator');
    expect(names.ecsCluster).toBe('claudeclaw-cluster');
    expect(names.fargateService).toBe('claudeclaw-service');
    expect(names.alb).toBe('claudeclaw-alb');
    expect(names.ddb.sessions).toBe('claudeclaw-sessions');
    expect(names.ddb.auditLog).toBe('claudeclaw-audit-log');
    expect(names.secrets.dashboard).toBe('/claudeclaw/dashboard');
    expect(names.logGroupOrchestrator).toBe('/claudeclaw/orchestrator');
    expect(names.dataKeyAlias).toBe('alias/claudeclaw-data');
  });

  it('prefixes every name when a suffix is supplied', () => {
    const names = buildResourceNames('staging');
    expect(names.ecrRepo).toBe('claudeclaw-staging-orchestrator');
    expect(names.ecsCluster).toBe('claudeclaw-staging-cluster');
    expect(names.fargateService).toBe('claudeclaw-staging-service');
    expect(names.alb).toBe('claudeclaw-staging-alb');
    expect(names.ddb.sessions).toBe('claudeclaw-staging-sessions');
    expect(names.ddb.auditLog).toBe('claudeclaw-staging-audit-log');
    expect(names.secrets.dashboard).toBe('/claudeclaw-staging/dashboard');
    expect(names.logGroupOrchestrator).toBe('/claudeclaw-staging/orchestrator');
    expect(names.dataKeyAlias).toBe('alias/claudeclaw-staging-data');
  });

  it('default RESOURCE_NAMES export resolves the current-process suffix', () => {
    // In the test runtime CCE_NAME_SUFFIX is unset, so RESOURCE_NAMES is
    // the prod shape and matches buildResourceNames('').
    expect(RESOURCE_NAMES.ecrRepo).toBe(buildResourceNames('').ecrRepo);
    expect(RESOURCE_NAMES.ddb.sessions).toBe(buildResourceNames('').ddb.sessions);
  });
});
