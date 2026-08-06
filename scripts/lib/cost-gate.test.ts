import { describe, it, expect } from 'vitest';
import { clampTier, resourceSummary, estimateLine, FALLBACK_RANGES } from './cost-gate.js';

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
});
