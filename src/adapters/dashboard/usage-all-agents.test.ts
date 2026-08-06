import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * GET /usage?agentId=all must aggregate across EVERY usage partition.
 *
 * The token-usage table has no per-day-across-agents index, so an "all agents"
 * read has to walk each agent PK. Before this change the route queried a single
 * literal `AGENT#all#DAY#...` partition (which holds nothing) and returned false
 * zeros, AND the per-agent walk omitted the synthetic jarvis/playground PKs that
 * Jarvis voice and the Model Playground record spend under.
 *
 * These tests drive the REAL dashboard router through app.request() (no AWS in
 * the loop) with a fake DDB whose QueryCommand dispatch returns rows keyed by
 * the requested PK, and assert the 'all' totals sum across two registered agent
 * partitions PLUS the synthetic playground partition (not zero, not one agent).
 */

const { authenticateDashboardToken, send, listAgents } = vi.hoisted(() => ({
  authenticateDashboardToken: vi.fn(),
  send: vi.fn(),
  listAgents: vi.fn(async () => [] as Array<{ agentId: string }>),
}));

function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

// Keep the REAL capability resolution (admin holds the viewer-tier usage:read);
// only stub the token-extraction / authentication entrypoints so we drive auth
// by role string, exactly like playground-run.test.ts.
vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => authenticateDashboardToken(raw),
  };
});

// Two registered agents so the partition set is { main, support, jarvis, playground }.
vi.mock('../../lib/config/agent-loader.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/config/agent-loader.js')>();
  return { ...actual, listKnownAgents: () => ['main', 'support'] };
});

// Fake DocumentClient: dispatch QueryCommand by the requested PK.
vi.mock('../../lib/state/ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/ddb.js')>();
  return { ...actual, ddb: () => ({ send }) };
});

// usageAgentPartitions() now sources the durable agents list (so custom and
// deactivated agents with usage are not omitted). Mock it so we control exactly
// which agents the partition walk includes.
vi.mock('../../lib/state/agents-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/agents-repo.js')>();
  return { ...actual, listAgents: () => listAgents() };
});

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';

// One usage row per partition. The PK encodes which agent it belongs to so the
// 'all' walk should pick up main + support + playground (and an empty jarvis).
const ROWS_BY_AGENT: Record<string, Array<Record<string, unknown>>> = {
  main: [{ inputTokens: 100, outputTokens: 50, costUsd: 1.0, modelId: 'm-main', SK: '2026-06-07T00:00:00Z#a' }],
  support: [{ inputTokens: 200, outputTokens: 80, costUsd: 2.0, modelId: 'm-support', SK: '2026-06-07T00:00:00Z#b' }],
  playground: [{ inputTokens: 300, outputTokens: 120, costUsd: 3.0, modelId: 'm-play', SK: '2026-06-07T00:00:00Z#c' }],
  jarvis: [],
  // A custom agent that is NOT in listKnownAgents (cold-start cache) and a
  // deactivated agent: both reachable only via the durable listAgents() source.
  'custom-x': [{ inputTokens: 10, outputTokens: 5, costUsd: 0.5, modelId: 'm-custom', SK: '2026-06-07T00:00:00Z#d' }],
  'old-agent': [{ inputTokens: 20, outputTokens: 10, costUsd: 0.25, modelId: 'm-old', SK: '2026-06-07T00:00:00Z#e' }],
};

function agentFromPk(pk: string): string {
  // PK shape: AGENT#<agentId>#DAY#<YYYY-MM-DD>
  const m = /^AGENT#(.+)#DAY#/.exec(pk);
  return m ? m[1] : '';
}

function makeApp() {
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  return app;
}

function runReq(path: string) {
  return makeApp().request(path, {
    method: 'GET',
    headers: { Authorization: 'Bearer admin' },
  });
}

const readJson = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  authenticateDashboardToken.mockReset();
  send.mockReset();
  listAgents.mockReset();
  // Default: durable agents list is empty, so the partition set is just the
  // listKnownAgents() cache + synthetics (matches the original two tests).
  listAgents.mockResolvedValue([]);
  authenticateDashboardToken.mockImplementation(async (raw: string) => principalFor(raw));
  // Return each partition's rows ONLY the first time that partition is queried
  // (the most recent day), empty for the rest of the day range, so the totals
  // are deterministic regardless of `days` and never double-counted.
  const served: Record<string, boolean> = {};
  send.mockImplementation(async (cmd: { input?: { ExpressionAttributeValues?: Record<string, unknown> } }) => {
    const pk = String(cmd.input?.ExpressionAttributeValues?.[':pk'] ?? '');
    const agent = agentFromPk(pk);
    if (!served[agent]) {
      served[agent] = true;
      return { Items: ROWS_BY_AGENT[agent] ?? [] };
    }
    return { Items: [] };
  });
});

describe('GET /usage?agentId=all aggregates across all partitions', () => {
  it('sums two registered agents PLUS the synthetic playground partition (not false zeros)', async () => {
    const res = await runReq('/api/usage?agentId=all&days=7');
    expect(res.status).toBe(200);
    const json = await readJson(res);
    const totals = json.totals as Record<string, number>;

    // main(1.0) + support(2.0) + playground(3.0) = 6.0; jarvis empty.
    expect(totals.costUsd).toBeCloseTo(6.0, 6);
    expect(totals.inputTokens).toBe(600); // 100 + 200 + 300
    expect(totals.outputTokens).toBe(250); // 50 + 80 + 120
    expect(totals.calls).toBe(3);

    // Rows from every contributing partition are merged into the log.
    const rows = json.rows as Array<{ modelId?: string }>;
    const models = rows.map((r) => r.modelId);
    expect(models).toContain('m-main');
    expect(models).toContain('m-support');
    expect(models).toContain('m-play');
  });

  it('a specific agentId stays single-partition (no cross-agent bleed)', async () => {
    const res = await runReq('/api/usage?agentId=support&days=7');
    expect(res.status).toBe(200);
    const json = await readJson(res);
    const totals = json.totals as Record<string, number>;

    // Only the support partition's row.
    expect(totals.costUsd).toBeCloseTo(2.0, 6);
    expect(totals.inputTokens).toBe(200);
    expect(totals.calls).toBe(1);
  });

  it('counts custom and DEACTIVATED agents that live only in the durable list (not in the cold-start cache)', async () => {
    // listKnownAgents() (cold cache) still returns ['main','support'], but the
    // durable agents table additionally has a custom active agent and a
    // deactivated agent, each with same-day spend. Both must be summed.
    listAgents.mockResolvedValue([{ agentId: 'custom-x' }, { agentId: 'old-agent' }]);

    const res = await runReq('/api/usage?agentId=all&days=7');
    expect(res.status).toBe(200);
    const totals = (await readJson(res)).totals as Record<string, number>;

    // main(1.0) + support(2.0) + playground(3.0) + custom-x(0.5) + old-agent(0.25)
    expect(totals.costUsd).toBeCloseTo(6.75, 6);
    expect(totals.calls).toBe(5);
  });

  it('sums ALL usage rows for a day, not just the first 200 (pagination, no truncated totals)', async () => {
    // A single agent with 250 rows on the latest day, returned across two DDB
    // pages via LastEvaluatedKey. collectAllPages must follow the cursor so the
    // totals reflect all 250 calls, not a truncated 200.
    const page1 = Array.from({ length: 200 }, (_, i) => ({ inputTokens: 1, outputTokens: 0, costUsd: 0.01, modelId: `p1-${i}`, SK: `2026-06-07T00:00:00Z#${i}` }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({ inputTokens: 1, outputTokens: 0, costUsd: 0.01, modelId: `p2-${i}`, SK: `2026-06-07T01:00:00Z#${i}` }));
    let firstPageServed = false;
    send.mockImplementation(async (cmd: { input?: { ExpressionAttributeValues?: Record<string, unknown>; ExclusiveStartKey?: unknown } }) => {
      const pk = String(cmd.input?.ExpressionAttributeValues?.[':pk'] ?? '');
      if (!pk.startsWith('AGENT#main#DAY#')) return { Items: [] };
      // Only the most recent day paginates; older days are empty.
      if (cmd.input?.ExclusiveStartKey) return { Items: page2 };
      if (!firstPageServed) {
        firstPageServed = true;
        return { Items: page1, LastEvaluatedKey: { PK: 'AGENT#main#DAY#2026-06-07', SK: page1[page1.length - 1].SK } };
      }
      return { Items: [] };
    });

    const res = await runReq('/api/usage?agentId=main&days=7');
    expect(res.status).toBe(200);
    const json = await readJson(res);
    const totals = json.totals as Record<string, number>;

    // 250 rows summed, not truncated at 200, and the response is NOT flagged
    // truncated (the 200k scan guard is far above this).
    expect(totals.calls).toBe(250);
    expect(totals.inputTokens).toBe(250);
    expect(totals.costUsd).toBeCloseTo(2.5, 6);
    expect(json.truncated).toBe(false);
  });
});
