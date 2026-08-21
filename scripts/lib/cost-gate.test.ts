import { describe, it, expect } from 'vitest';
import { clampTier, resourceSummary, estimateLine, FALLBACK_RANGES } from './cost-gate.js';
import { TIERS } from '../../infra/lib/constants.js';

describe('clampTier', () => {
  it('accepts the four valid tiers', () => {
    expect(clampTier('0')).toBe(0);
    expect(clampTier('1')).toBe(1);
    expect(clampTier('2')).toBe(2);
    expect(clampTier('3')).toBe(3);
  });

  it('defaults to tier 1 on unset, garbage, and out-of-range values', () => {
    expect(clampTier(undefined)).toBe(1);
    expect(clampTier('')).toBe(1);
    expect(clampTier('7')).toBe(1);
    expect(clampTier('banana')).toBe(1);
  });
});

describe('resourceSummary', () => {
  it('tier 0 lists a single NAT and single task, no WAF/CloudFront', () => {
    const s = resourceSummary(0, false);
    expect(s).toContain('NAT x1');
    expect(s).toContain('Fargate x1');
    expect(s).not.toContain('WAF');
    expect(s).not.toContain('CloudFront');
    expect(s).not.toContain('VPC interface endpoints');
  });

  it('tier 1 default omits interface endpoints (they are opt-in)', () => {
    const s = resourceSummary(1, false);
    expect(s).toContain('NAT x2');
    expect(s).toContain('Fargate x2');
    expect(s).not.toContain('VPC interface endpoints');
  });

  it('lists interface endpoints only when the flag is set', () => {
    expect(resourceSummary(1, true)).toContain('VPC interface endpoints');
  });

  it('lists the Paperclip substrate only when it is armed', () => {
    // Default off: infra/bin/app.ts synthesizes CCE-Database/CCE-Filesystem
    // only when CCE_PAPERCLIP_ENABLED=1, so the gate must not promise an
    // Aurora cluster a routine deploy never creates.
    expect(resourceSummary(1, false)).not.toContain('Aurora');
    expect(resourceSummary(1, false)).not.toContain('EFS');
    expect(resourceSummary(1, false, true)).toContain('Aurora Serverless v2 (Paperclip)');
    expect(resourceSummary(1, false, true)).toContain('EFS');
  });

  it('names the Paperclip Fargate task separately from the orchestrator count', () => {
    // The engine's service is a SECOND always-on task (2 vCPU / 4 GB, no
    // autoscaling) and the largest single item arming adds. Folding it into
    // the `Fargate xN` count would hide it behind a number that looks like it
    // only went up by one, which is how the gate came to under-report the
    // cost of arming by roughly half.
    expect(resourceSummary(1, false)).not.toContain('Paperclip');
    const armed = resourceSummary(1, false, true);
    expect(armed).toContain('Fargate x1 (Paperclip)');
    expect(armed).toContain(`Fargate x${TIERS[1].fargateMinTasks}`);
  });

  it('prices the Paperclip Fargate task, not just the Aurora floor and EFS', () => {
    // The note carried a "fold in the Fargate task in Phase 2" TODO long
    // after that task landed, so the money gate said ~$50 for something that
    // actually costs ~$110. Both halves must be named or the next person
    // cannot tell which one the estimate forgot.
    const off = estimateLine(null, 1, false, false);
    expect(off).not.toContain('Paperclip');
    const on = estimateLine(null, 1, false, true);
    expect(on).toContain('$110');
    expect(on).toContain('Aurora min-ACU floor and EFS');
    expect(on).toContain('2 vCPU / 4 GB Fargate task');
    // Still flagged as arithmetic, not a Pricing API result.
    expect(on).toContain('estimated, not verified against pricing APIs');
  });

  it('tier 2 adds WAF, tier 3 adds WAF + CloudFront', () => {
    expect(resourceSummary(2, false)).toContain('WAF');
    expect(resourceSummary(2, false)).not.toContain('CloudFront');
    expect(resourceSummary(3, false)).toContain('WAF');
    expect(resourceSummary(3, false)).toContain('CloudFront');
  });
});

describe('estimateLine', () => {
  const estimatorJson = JSON.stringify({
    asOf: '2026-06',
    results: [
      { tier: 0, fixedMonthlyUsd: 82.1 },
      { tier: 1, fixedMonthlyUsd: 159.4 },
    ],
  });

  it('formats the estimator figure for the requested tier', () => {
    const line = estimateLine(estimatorJson, 1, false);
    expect(line).toContain('~$159/mo');
    expect(line).toContain('2026-06');
    expect(line).toContain('Bedrock token spend');
  });

  it('falls back to the docs range when stdout is null', () => {
    const line = estimateLine(null, 2, false);
    expect(line).toContain(FALLBACK_RANGES[2]);
    expect(line).toContain('docs/cost-guide.md');
  });

  it('falls back on unparseable stdout and on a missing tier row', () => {
    expect(estimateLine('not json', 0, false)).toContain(FALLBACK_RANGES[0]);
    expect(estimateLine(estimatorJson, 3, false)).toContain(FALLBACK_RANGES[3]);
  });

  it('fallback mentions the endpoint cost only when the flag is set', () => {
    expect(estimateLine(null, 1, true)).toContain('VPC interface endpoints');
    expect(estimateLine(null, 1, false)).not.toContain('VPC interface endpoints');
  });

  it('prices the Paperclip substrate in BOTH branches, only when armed', () => {
    // The endpoints clause above reaches only the fallback: the estimator
    // branch returns before it is built. The Paperclip note must not inherit
    // that bug, because the estimator branch is the one that normally runs
    // and scripts/cost-estimate.mjs has no Aurora/EFS line item.
    expect(estimateLine(estimatorJson, 1, false, true)).toContain('Paperclip');
    expect(estimateLine(null, 1, false, true)).toContain('Paperclip');
    expect(estimateLine(estimatorJson, 1, false)).not.toContain('Paperclip');
    expect(estimateLine(null, 1, false)).not.toContain('Paperclip');
  });
});
