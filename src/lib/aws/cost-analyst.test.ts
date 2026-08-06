import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CostSummary, CostRisksResult } from './cost-reader.js';

/**
 * The cost analyst is the read-only Bedrock explainer behind POST
 * /api/cost/report. These tests lock the two guarantees that matter:
 *   1. Dollar figures on the drivers are the AUTHORITATIVE Cost Explorer amounts
 *      re-attached by service name — never numbers the model emits.
 *   2. When Cost Explorer data is unavailable it short-circuits to
 *      available:false WITHOUT spending a model call.
 * The model itself is mocked; we only exercise the prompt assembly, parsing,
 * reconciliation, and coercion.
 */

const { converseTurn } = vi.hoisted(() => ({ converseTurn: vi.fn() }));
vi.mock('../bedrock/client.js', () => ({ converseTurn }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { generateCostReport } from './cost-analyst.js';

function makeSummary(over = true): CostSummary {
  return {
    generatedAt: '2026-06-08T00:00:00.000Z',
    currency: 'USD',
    available: true,
    monthToDateUsd: 400,
    lastMonthUsd: 500,
    projectedMonthUsd: over ? 800 : 400,
    daysElapsed: 8,
    daysInMonth: 30,
    byService: [
      { service: 'Amazon EC2', amountUsd: 300 },
      { service: 'AWS Lambda', amountUsd: 100 },
    ],
    daily: [],
  };
}

function makeRisks(): CostRisksResult {
  return {
    generatedAt: '2026-06-08T00:00:00.000Z',
    available: true,
    regionsScanned: ['us-east-1'],
    risks: [
      {
        id: 'nat-1',
        severity: 'high',
        title: 'Duplicate NAT gateways',
        detail: 'two NATs in one VPC',
        region: 'us-east-1',
        estMonthlyUsd: 65,
        estMonthlySavingsUsd: 33,
        resourceIds: ['nat-aaa', 'nat-bbb'],
      },
    ],
    totalMonthlySavingsUsd: 33,
  };
}

beforeEach(() => converseTurn.mockReset());

describe('generateCostReport', () => {
  it('re-attaches authoritative CE amounts and ignores model-supplied numbers', async () => {
    converseTurn.mockResolvedValue({
      text: JSON.stringify({
        headline: 'EC2 is most of the bill and you are over budget.',
        verdict: 'over-budget',
        drivers: [
          // model echoes a bogus dollar amount — it must be discarded.
          {
            service: 'Amazon EC2',
            whatItIs: 'VMs',
            necessity: 'essential',
            assessment: 'core',
            cheaperAlternative: 'Compute Savings Plan, ~30% less',
            monthToDateUsd: 99999,
          },
          // a service not in the breakdown still renders, at $0, with a bad
          // necessity coerced to the safe fallback.
          { service: 'Mystery Service', whatItIs: '?', necessity: 'banana', assessment: 'unknown' },
        ],
        hiddenCosts: [
          { title: 'Inter-AZ data transfer', detail: 'cross-AZ chatter adds up', estMonthlyUsd: 12 },
          { title: '', detail: 'dropped — no title', estMonthlyUsd: 5 },
        ],
        optimizations: [
          { title: 'Collapse NATs', rationale: 'one is enough', alternative: 'VPC endpoints', estMonthlySavingsUsd: 33, estNewMonthlyUsd: 7, effort: 'low', priority: 'high' },
          { title: 'Right-size', rationale: 'over-provisioned', estMonthlySavingsUsd: 17, effort: 'huge', priority: 'urgent' },
        ],
        claudeCodePlan: 'aws ec2 describe-nat-gateways --region us-east-1',
      }),
      modelId: 'model-x',
      costUsd: 0.0123,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      stopReason: 'end_turn',
      latencyMs: 1,
    });

    const r = await generateCostReport({ summary: makeSummary(true), risks: makeRisks(), dailyCapUsd: 20 });

    expect(r.available).toBe(true);
    expect(r.verdict).toBe('over-budget');
    expect(r.modelId).toBe('model-x');
    expect(r.generationCostUsd).toBe(0.0123);

    // Authoritative amount + computed share, NOT the model's 99999. Cheaper
    // alternative is carried through verbatim.
    expect(r.drivers[0]).toMatchObject({
      service: 'Amazon EC2',
      monthToDateUsd: 300,
      sharePct: 75,
      cheaperAlternative: 'Compute Savings Plan, ~30% less',
    });
    // Unmatched service renders at 0 with the necessity coerced to 'review'.
    expect(r.drivers[1]).toMatchObject({ service: 'Mystery Service', monthToDateUsd: 0, necessity: 'review' });

    // Hidden costs: the titled one survives, the untitled one is dropped.
    expect(r.hiddenCosts).toHaveLength(1);
    expect(r.hiddenCosts[0]).toMatchObject({ title: 'Inter-AZ data transfer', estMonthlyUsd: 12 });

    // Optimizations: savings summed; substitution carried; bad enums coerced.
    expect(r.totalEstSavingsUsd).toBe(50);
    expect(r.optimizations[0]).toMatchObject({ alternative: 'VPC endpoints', estNewMonthlyUsd: 7 });
    expect(r.optimizations[1]).toMatchObject({ effort: 'medium', priority: 'medium' });

    // Authoritative projection passed straight through; after-bill = 800 − 50.
    expect(r.projectedMonthlyNowUsd).toBe(800);
    expect(r.projectedMonthlyAfterUsd).toBe(750);

    expect(converseTurn).toHaveBeenCalledTimes(1);
  });

  it('caps total savings at the projection so the after-bill can never go negative', async () => {
    converseTurn.mockResolvedValue({
      text: JSON.stringify({
        headline: 'lean-ish',
        drivers: [],
        hiddenCosts: [],
        // Hallucinated savings far exceeding the bill.
        optimizations: [
          { title: 'Delete everything', rationale: 'x', estMonthlySavingsUsd: 5000, effort: 'low', priority: 'high' },
        ],
        claudeCodePlan: 'noop',
      }),
      modelId: 'model-x',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      stopReason: 'end_turn',
      latencyMs: 1,
    });
    // projection 400 → savings capped at 400, after-bill floored at 0.
    const r = await generateCostReport({ summary: makeSummary(false), risks: makeRisks(), dailyCapUsd: 20 });
    expect(r.totalEstSavingsUsd).toBe(400);
    expect(r.projectedMonthlyNowUsd).toBe(400);
    expect(r.projectedMonthlyAfterUsd).toBe(0);
  });

  it('recovers a truncated (max_tokens) JSON body instead of failing, and flags it', async () => {
    // A response cut off mid-claudeCodePlan (the last field): no closing quote/braces.
    const truncated =
      '{"headline":"Big bill.","verdict":"over-budget",' +
      '"drivers":[{"service":"Amazon EC2","whatItIs":"VMs","necessity":"essential","assessment":"core","cheaperAlternative":"Savings Plan"}],' +
      '"hiddenCosts":[{"title":"Egress","detail":"data transfer","estMonthlyUsd":10}],' +
      '"optimizations":[{"title":"Collapse NATs","rationale":"one is enough","alternative":"VPC endpoints","estMonthlySavingsUsd":33,"estNewMonthlyUsd":7,"effort":"low","priority":"high"}],' +
      '"claudeCodePlan":"Step 1: aws ec2 describe-nat-gateways --region us-east-1\\nStep 2: confirm then aws ec2 delete-nat-gateway --nat-gateway-id nat-';
    converseTurn.mockResolvedValue({
      text: truncated,
      modelId: 'model-x',
      costUsd: 0.02,
      inputTokens: 1,
      outputTokens: 5000,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      stopReason: 'max_tokens',
      latencyMs: 1,
    });

    const r = await generateCostReport({ summary: makeSummary(true), risks: makeRisks(), dailyCapUsd: 20 });

    // The whole report is salvaged — only the plan tail is clipped.
    expect(r.available).toBe(true);
    expect(r.headline).toBe('Big bill.');
    expect(r.drivers).toHaveLength(1);
    expect(r.drivers[0]).toMatchObject({ service: 'Amazon EC2', monthToDateUsd: 300 });
    expect(r.hiddenCosts).toHaveLength(1);
    expect(r.optimizations).toHaveLength(1);
    expect(r.claudeCodePlan).toContain('describe-nat-gateways');
    // And the truncation is surfaced (honestly, not hidden).
    expect(r.note).toMatch(/trim|budget/i);
  });

  it('short-circuits to available:false without a model call when CE is down', async () => {
    const downSummary: CostSummary = { ...makeSummary(), available: false, note: 'AccessDenied' };

    const r = await generateCostReport({ summary: downSummary, risks: makeRisks(), dailyCapUsd: 20 });

    expect(r.available).toBe(false);
    expect(r.note).toContain('AccessDenied');
    expect(r.drivers).toEqual([]);
    expect(r.claudeCodePlan).toBe('');
    expect(converseTurn).not.toHaveBeenCalled();
  });

  it('falls back to the budget-derived verdict when the model omits one', async () => {
    converseTurn.mockResolvedValue({
      text: JSON.stringify({ headline: 'lean', drivers: [], optimizations: [], claudeCodePlan: 'noop' }),
      modelId: 'model-x',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      stopReason: 'end_turn',
      latencyMs: 1,
    });

    // projected 400 < budget 600 (cap 20 * 30 days) → on-track.
    const r = await generateCostReport({ summary: makeSummary(false), risks: makeRisks(), dailyCapUsd: 20 });
    expect(r.verdict).toBe('on-track');
  });
});
