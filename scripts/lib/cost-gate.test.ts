import { describe, it, expect } from 'vitest';
import { clampTier, resourceSummary, estimateLine, FALLBACK_RANGES } from './cost-gate.js';
import { TIERS, clampTier as constantsClampTier } from '../../infra/lib/constants.js';

describe('clampTier', () => {
  it('accepts the four valid tiers', () => {
    expect(clampTier('0')).toBe(0);
    expect(clampTier('1')).toBe(1);
    expect(clampTier('2')).toBe(2);
    expect(clampTier('3')).toBe(3);
  });

  it('defaults to tier 1 on unset, blank, garbage, and out-of-range values', () => {
    expect(clampTier(undefined)).toBe(1);
    // The blank and whitespace cases are the ones that matter now: since
    // Phase 9 the tier decides whether the Paperclip Aurora cluster EXISTS,
    // and `Number('')` is 0 — a VALID tier, and the one that creates nothing.
    expect(clampTier('')).toBe(1);
    expect(clampTier(' ')).toBe(1);
    expect(clampTier('	')).toBe(1);
    expect(clampTier('7')).toBe(1);
    expect(clampTier('-1')).toBe(1);
    expect(clampTier('banana')).toBe(1);
  });

  it('is the SAME function infra/bin/app.ts parses the tier with', () => {
    // Not a copy that happens to agree: app.ts imports this identity from
    // infra/lib/constants.ts, and so does this module. Two parsers that
    // disagree about '' is two answers to "does this install have a database".
    // The behavioural half is asserted against a real synth in
    // infra/bin/app.stack-set.test.ts.
    expect(clampTier).toBe(constantsClampTier);
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

  it('lists the Paperclip substrate at exactly the tiers that provision it', () => {
    // The gate reads the SAME TierShape field infra/bin/app.ts deploys from,
    // so it cannot promise an Aurora cluster synth does not create, or stay
    // silent about one it does. Since Phase 9 the substrate installs by
    // default at Tier 1+ and never at Tier 0.
    expect(TIERS[0].paperclipEnabled).toBe(false);
    expect(resourceSummary(0, false)).not.toContain('Aurora');
    expect(resourceSummary(0, false)).not.toContain('EFS');
    expect(resourceSummary(1, false)).toContain('Aurora Serverless v2 (Paperclip)');
    expect(resourceSummary(1, false)).toContain('EFS');
    expect(resourceSummary(3, false)).toContain('Aurora Serverless v2 (Paperclip)');
  });

  it('prices a Tier 0 Paperclip override supplied through the deploy EnvBag', () => {
    const env = { CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE: '1' };

    expect(resourceSummary(0, false, env)).toContain('Aurora Serverless v2 (Paperclip)');
    expect(resourceSummary(0, false, env)).toContain('Fargate x1 (Paperclip)');
    expect(estimateLine(null, 0, false, env)).toContain('plus roughly $110/mo');
  });

  it('names the Paperclip Fargate task separately from the orchestrator count', () => {
    // The engine's service is a SECOND always-on task (2 vCPU / 4 GB, no
    // autoscaling) and the largest single item the substrate adds. Folding it
    // into the `Fargate xN` count would hide it behind a number that looks
    // like it only went up by one, which is how the gate came to under-report
    // the cost by roughly half.
    expect(resourceSummary(0, false)).not.toContain('Paperclip');
    const provisioned = resourceSummary(1, false);
    expect(provisioned).toContain('Fargate x1 (Paperclip)');
    expect(provisioned).toContain(`Fargate x${TIERS[1].fargateMinTasks}`);
  });

  it('prices the Paperclip Fargate task, not just the Aurora floor and EFS', () => {
    // The note carried a "fold in the Fargate task in Phase 2" TODO long
    // after that task landed, so the money gate said ~$50 for something that
    // actually costs ~$110. Both halves must be named or the next person
    // cannot tell which one the estimate forgot.
    const off = estimateLine(null, 0, false);
    expect(off).not.toContain('Paperclip');
    const on = estimateLine(null, 1, false);
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

  it('does not append the Paperclip note to the estimator figure', () => {
    // scripts/cost-estimate.mjs now carries the Aurora floor, EFS and the
    // engine's Fargate task as real line items, gated on the same
    // TierShape.paperclipEnabled — so the figure already includes them and
    // appending the prose note would bill the operator twice. It says the
    // engine is included instead, from the one place that knows.
    const line = estimateLine(estimatorJson, 1, false);
    expect(line).toContain('Paperclip work engine included');
    expect(line).not.toContain('plus roughly $110/mo');
    // ...and says nothing about it at a tier that provisions none.
    expect(estimateLine(estimatorJson, 0, false)).not.toContain('Paperclip');
  });

  it('still prices Paperclip on the fallback branch, which cannot recompute', () => {
    // FALLBACK_RANGES is static docs prose, so the note is the only thing
    // pricing the substrate there. Dropping it from BOTH branches would have
    // under-reported a Tier 1+ deploy by roughly $110 whenever the estimator
    // spawn failed.
    expect(estimateLine(null, 1, false)).toContain('plus roughly $110/mo');
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

  it('prices the Paperclip substrate in BOTH branches, at the tiers that get it', () => {
    // The endpoints clause above reaches only the fallback: the estimator
    // branch returns before it is built. The Paperclip note must not inherit
    // that bug, because the estimator branch is the one that normally runs
    // and scripts/cost-estimate.mjs has no Aurora/EFS line item — the note is
    // the ONLY place that ~$110/mo is stated on either path.
    expect(estimateLine(estimatorJson, 1, false)).toContain('Paperclip');
    expect(estimateLine(null, 1, false)).toContain('Paperclip');
    // Tier 0 provisions none of it, so quoting it there would over-state a
    // Hobby deploy — the exact defect this whole helper was written to fix.
    expect(estimateLine(estimatorJson, 0, false)).not.toContain('Paperclip');
    expect(estimateLine(null, 0, false)).not.toContain('Paperclip');
  });
});
