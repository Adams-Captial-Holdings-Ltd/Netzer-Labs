import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * POST /vectors/answer runs a PAID converseTurn, so its Bedrock spend must be
 * metered into the daily total the cost cap reads. Before this fix the route
 * never called recordUsage, so its spend was invisible to getDailyCostUsd even
 * though the route itself prechecks the cap. These tests lock that the route
 * records usage under the synthetic 'knowledge' partition with a conservative
 * non-zero cost for an unpriced model, and audits a metering failure.
 */

const {
  authenticateDashboardToken,
  converseTurn,
  embedOne,
  search,
  recordUsage,
  getDailyCostUsd,
  getEffectiveCostCap,
  isKillSwitchActive,
  writeAudit,
} = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(),
  converseTurn: vi.fn(),
  embedOne: vi.fn(),
  search: vi.fn(),
  recordUsage: vi.fn(async (_u: unknown) => true),
  getDailyCostUsd: vi.fn(async () => 0),
  getEffectiveCostCap: vi.fn(async () => 50),
  isKillSwitchActive: vi.fn(async (_n: string) => ({ active: false })),
  writeAudit: vi.fn(async (_e: unknown) => {}),
}));

function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

// Unpriced non-Anthropic model so playgroundCost() is null and the metered cost
// must come from the conservative fallback.
const TEST_MODEL_ID = 'openai.gpt-oss-120b-1:0';

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => authenticateDashboardToken(raw),
  };
});
vi.mock('../../lib/bedrock/client.js', () => ({ converseTurn }));
vi.mock('../../lib/vectors/embedder.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/vectors/embedder.js')>();
  return { ...actual, embedOne };
});
vi.mock('../../lib/vectors/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/vectors/store.js')>();
  return { ...actual, search };
});
vi.mock('../../lib/usage/token-tracker.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/usage/token-tracker.js')>();
  return { ...actual, recordUsage, getDailyCostUsd };
});
vi.mock('../../lib/state/cost-cap-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/cost-cap-repo.js')>();
  return { ...actual, getEffectiveCostCap };
});
vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive };
});
vi.mock('../../lib/audit/audit-writer.js', () => ({ writeAudit }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';

function post(body: unknown) {
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  return app.request('/api/vectors/answer', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const readJson = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  authenticateDashboardToken.mockReset().mockImplementation(async (raw: string) => principalFor(raw));
  converseTurn.mockReset().mockResolvedValue({ text: 'grounded answer [1]', inputTokens: 40, outputTokens: 20, stopReason: 'end_turn', latencyMs: 30 });
  embedOne.mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
  search.mockReset().mockResolvedValue([{ score: 0.9, row: { text: 'passage', metadata: { docId: 'd', chunkIndex: 0 } } }]);
  recordUsage.mockReset().mockResolvedValue(true);
  getDailyCostUsd.mockReset().mockResolvedValue(0);
  getEffectiveCostCap.mockReset().mockResolvedValue(50);
  isKillSwitchActive.mockReset().mockResolvedValue({ active: false });
  writeAudit.mockReset().mockResolvedValue(undefined);
});

describe('POST /vectors/answer meters its paid Bedrock spend', () => {
  it('records usage under the synthetic knowledge partition with a conservative non-zero cost', async () => {
    const res = await post({ query: 'what is x?', modelId: TEST_MODEL_ID, scope: 'default' });
    expect(res.status).toBe(200);
    // UI still gets the honest null price for an unpriced model.
    expect(await readJson(res)).toMatchObject({ ok: true, costUsd: null });

    expect(recordUsage).toHaveBeenCalledTimes(1);
    const recorded = recordUsage.mock.calls[0][0] as { agentId: string; costUsd: number; modelId: string };
    expect(recorded.agentId).toBe('knowledge');
    expect(recorded.modelId).toBe(TEST_MODEL_ID);
    expect(recorded.costUsd).toBeGreaterThan(0); // conservative fallback, not zero
  });

  it('enforces the daily cap even when the cost_cap_per_day kill switch is OFF (zero models invoked over cap)', async () => {
    isKillSwitchActive.mockResolvedValue({ active: false }); // switch OFF
    getEffectiveCostCap.mockResolvedValue(50);
    getDailyCostUsd.mockResolvedValue(60); // already over cap

    const res = await post({ query: 'what is x?', modelId: TEST_MODEL_ID, scope: 'default' });

    expect(res.status).toBe(503);
    expect(await readJson(res)).toMatchObject({ error: 'cost_cap_exceeded', spendUsd: 60, capUsd: 50 });
    expect(converseTurn).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('audits a metering failure when the usage write is not confirmed', async () => {
    recordUsage.mockResolvedValue(false);
    const res = await post({ query: 'what is x?', modelId: TEST_MODEL_ID, scope: 'default' });
    // The answer still returns (the model already ran), but the failure is audited.
    expect(res.status).toBe(200);
    const audited = writeAudit.mock.calls.map((c) => (c[0] as { action?: string }).action);
    expect(audited).toContain('knowledge_meter_failed');
  });
});
