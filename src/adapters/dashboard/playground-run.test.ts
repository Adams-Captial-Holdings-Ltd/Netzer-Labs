import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * Spend / abuse controls on POST /api/playground/run.
 *
 * The Playground fans out one paid Bedrock call per selected model from the SPA,
 * with no per-user limit, no concurrency ceiling, and (before this change) no
 * usage recording — so the daily cost cap was structurally blind until after the
 * money was spent. These tests drive the REAL dashboard router through
 * app.request() (no AWS in the loop) and lock the four controls:
 *
 *   1. over the per-principal rate limit  -> 429 and ZERO model invocations;
 *   2. under limit + under cap            -> the model is invoked AND usage is
 *      recorded so spend feeds the daily total / cap;
 *   3. already over the daily cost cap    -> 503 cost_cap_exceeded, ZERO calls;
 *   4. process concurrency ceiling reached -> 429, ZERO new calls.
 *
 * Plus a model-level failure path: an invoke that throws records NO usage.
 */

const {
  converseTurn,
  checkAndConsume,
  recordUsage,
  getDailyCostUsd,
  getEffectiveCostCap,
  isKillSwitchActive,
  writeAudit,
  authenticateDashboardToken,
} = vi.hoisted(() => ({
  converseTurn: vi.fn(),
  checkAndConsume: vi.fn(),
  recordUsage: vi.fn(async (_usage: unknown) => true),
  getDailyCostUsd: vi.fn(async () => 0),
  getEffectiveCostCap: vi.fn(async () => 50),
  isKillSwitchActive: vi.fn(async (_name: string) => ({ active: false })),
  writeAudit: vi.fn(async (_event: unknown) => {}),
  authenticateDashboardToken: vi.fn(),
}));

// Allowlisted model so listPlaygroundModels(env).find(...) resolves. The OpenAI
// GPT-OSS entry is unconditionally present (it is a non-Anthropic static row, no
// env var needed) and has no verified price -> costUsd is null.
const TEST_MODEL_ID = 'openai.gpt-oss-120b-1:0';

function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

// Keep the REAL capability resolution (admin -> owner profile holds chat:read);
// only stub the token-extraction / authentication entrypoints so we drive auth
// by role string, exactly like handler.middleware.test.ts.
vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => authenticateDashboardToken(raw),
  };
});

vi.mock('../../lib/bedrock/client.js', () => ({ converseTurn }));

vi.mock('../../lib/state/rate-limits-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/rate-limits-repo.js')>();
  return { ...actual, checkAndConsume };
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
import { SpendIndeterminateError } from '../../lib/usage/token-tracker.js';

const ALLOWED = { allowed: true, remaining: 59, resetAt: Date.now() + 60_000 };
const BLOCKED = { allowed: false, remaining: 0, resetAt: Date.now() + 60_000 };

function makeApp() {
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  return app;
}

function runReq(body: unknown, headers: Record<string, string> = {}) {
  return makeApp().request('/api/playground/run', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const readJson = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  converseTurn.mockReset();
  checkAndConsume.mockReset();
  recordUsage.mockReset();
  getDailyCostUsd.mockReset();
  getEffectiveCostCap.mockReset();
  isKillSwitchActive.mockReset();
  writeAudit.mockReset();
  authenticateDashboardToken.mockReset();

  // Defaults: admin auth, under limit, under cap, no kill switch, a normal
  // converse result. Individual tests override what they exercise.
  authenticateDashboardToken.mockImplementation(async (raw: string) => principalFor(raw));
  checkAndConsume.mockResolvedValue(ALLOWED);
  getDailyCostUsd.mockResolvedValue(0);
  getEffectiveCostCap.mockResolvedValue(50);
  isKillSwitchActive.mockResolvedValue({ active: false });
  recordUsage.mockResolvedValue(true);
  converseTurn.mockResolvedValue({
    text: 'hi',
    inputTokens: 12,
    outputTokens: 7,
    stopReason: 'end_turn',
    latencyMs: 42,
  });
});

describe('POST /playground/run — spend / abuse controls', () => {
  it('returns 429 and invokes ZERO models when over the rate limit', async () => {
    checkAndConsume.mockResolvedValue(BLOCKED);

    const res = await runReq({ prompt: 'hello', modelId: TEST_MODEL_ID });

    expect(res.status).toBe(429);
    expect(await readJson(res)).toMatchObject({ error: 'rate_limited' });
    expect(converseTurn).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('checks the rate limit BEFORE any Bedrock call (no kill-switch / cap reads needed to reject)', async () => {
    checkAndConsume.mockResolvedValue(BLOCKED);
    await runReq({ prompt: 'hello', modelId: TEST_MODEL_ID });
    // Rejected purely on the limiter — never reached the paid invoke.
    expect(converseTurn).not.toHaveBeenCalled();
    expect(checkAndConsume).toHaveBeenCalled();
  });

  it('invokes the model and records usage when under limit and under cap', async () => {
    const res = await runReq({ prompt: 'compare this', modelId: TEST_MODEL_ID });

    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json).toMatchObject({ ok: true, modelId: TEST_MODEL_ID, text: 'hi' });

    // The paid call happened exactly once.
    expect(converseTurn).toHaveBeenCalledTimes(1);
    expect(converseTurn).toHaveBeenCalledWith(expect.objectContaining({ modelId: TEST_MODEL_ID }));

    // Usage was recorded so spend feeds the daily total / cap, under the
    // synthetic 'playground' agent, with the real token counts.
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'playground',
        modelId: TEST_MODEL_ID,
        inputTokens: 12,
        outputTokens: 7,
      }),
    );
  });

  it('records a CONSERVATIVE non-zero cost for an unpriced model so the cap is never blind', async () => {
    // TEST_MODEL_ID has no verified price, so playgroundCost() is null. Before
    // the fix it recorded costUsd:0 and stayed invisible to the cap. It must now
    // record a conservative fallback estimate (> 0) from the token counts.
    const res = await runReq({ prompt: 'price me', modelId: TEST_MODEL_ID });
    expect(res.status).toBe(200);
    // The UI still gets the honest null price.
    expect(await readJson(res)).toMatchObject({ ok: true, costUsd: null });
    // But the metered usage row carries a real, positive cost.
    expect(recordUsage).toHaveBeenCalledTimes(1);
    const recorded = recordUsage.mock.calls[0][0] as { costUsd: number };
    expect(recorded.costUsd).toBeGreaterThan(0);
  });

  it('returns 503 cost_cap_exceeded and invokes ZERO models when already over the daily cap', async () => {
    getEffectiveCostCap.mockResolvedValue(50);
    getDailyCostUsd.mockResolvedValue(75); // already over the $50 cap

    const res = await runReq({ prompt: 'hello', modelId: TEST_MODEL_ID });

    expect(res.status).toBe(503);
    expect(await readJson(res)).toMatchObject({ error: 'cost_cap_exceeded', spendUsd: 75, capUsd: 50 });
    expect(converseTurn).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('enforces the cost cap even when the cost_cap_per_day kill switch is OFF', async () => {
    // The pre-fix code only checked spend while the kill switch was active. The
    // switch is OFF here; the cap must still be enforced.
    isKillSwitchActive.mockResolvedValue({ active: false });
    getEffectiveCostCap.mockResolvedValue(50);
    getDailyCostUsd.mockResolvedValue(60);

    const res = await runReq({ prompt: 'hello', modelId: TEST_MODEL_ID });

    expect(res.status).toBe(503);
    expect(converseTurn).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED: an indeterminate spend total returns 503 cost_cap_unverifiable and invokes ZERO models', async () => {
    // The strict cost-cap pre-read could not compute a complete day total (a
    // usage partition was unreadable). Admitting the call on a partial total
    // would fail OPEN and let paid fan-out slip past the cap. The strict read
    // throws SpendIndeterminateError, which the precheck must convert into a
    // hard block: no Bedrock call, no usage row.
    getEffectiveCostCap.mockResolvedValue(50);
    getDailyCostUsd.mockRejectedValue(
      new SpendIndeterminateError('daily cost total is indeterminate (a usage partition could not be read)'),
    );

    const res = await runReq({ prompt: 'hello', modelId: TEST_MODEL_ID });

    expect(res.status).toBe(503);
    expect(await readJson(res)).toMatchObject({ error: 'cost_cap_unverifiable' });
    expect(converseTurn).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('audits a meter failure (and still returns 200) when recordUsage returns false', async () => {
    // recordUsage returns FALSE on a caught DDB write failure (it does NOT
    // throw). The model already ran and the money is spent, so the response is
    // still 200, but the failed/unconfirmed write must be loud: an audit event
    // is emitted so the blind-spend is visible rather than silently succeeding.
    recordUsage.mockResolvedValue(false);

    const res = await runReq({ prompt: 'hello', modelId: TEST_MODEL_ID });

    // The model ran, so the response is success even though metering failed.
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ ok: true, modelId: TEST_MODEL_ID });
    expect(converseTurn).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);

    // The meter failure was audited with the dedicated action.
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'playground_meter_failed',
        surface: 'dashboard',
        result: 'error',
        detail: expect.objectContaining({ modelId: TEST_MODEL_ID }),
      }),
    );
  });

  it('does NOT record usage when the model call throws (no tokens billed)', async () => {
    converseTurn.mockRejectedValue(Object.assign(new Error('AccessDenied'), { name: 'AccessDeniedException' }));

    const res = await runReq({ prompt: 'hello', modelId: TEST_MODEL_ID });

    // Model-level failure is surfaced as 200 ok:false (per-column error), no usage row.
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ ok: false, error: 'AccessDeniedException' });
    expect(converseTurn).toHaveBeenCalledTimes(1);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('caps process-wide concurrency: a 4th call while 3 are in flight is rejected with 429', async () => {
    // Hold the gate by making converseTurn hang until we release it. Fire 3
    // overlapping requests (filling the default cap of 3), then a 4th that must
    // be rejected without ever reaching converseTurn.
    const release: Array<() => void> = [];
    converseTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          release.push(() =>
            resolve({ text: 'x', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', latencyMs: 1 }),
          );
        }),
    );

    const p1 = runReq({ prompt: 'a', modelId: TEST_MODEL_ID });
    const p2 = runReq({ prompt: 'b', modelId: TEST_MODEL_ID });
    const p3 = runReq({ prompt: 'c', modelId: TEST_MODEL_ID });

    // Let the 3 in-flight requests reach (and park inside) converseTurn.
    await vi.waitFor(() => expect(converseTurn).toHaveBeenCalledTimes(3));

    // The 4th request runs while all 3 slots are held -> rejected, no new call.
    const res4 = await runReq({ prompt: 'd', modelId: TEST_MODEL_ID });
    expect(res4.status).toBe(429);
    expect(await readJson(res4)).toMatchObject({ error: 'rate_limited', reason: 'too_many_concurrent' });
    expect(converseTurn).toHaveBeenCalledTimes(3); // still 3 — the 4th never invoked

    // Drain the held calls so the gate is clean for later tests.
    for (const r of release) r();
    await Promise.all([p1, p2, p3]);

    // With slots freed, a fresh call goes through again.
    converseTurn.mockResolvedValue({ text: 'ok', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', latencyMs: 1 });
    const res5 = await runReq({ prompt: 'e', modelId: TEST_MODEL_ID });
    expect(res5.status).toBe(200);
  });
});
