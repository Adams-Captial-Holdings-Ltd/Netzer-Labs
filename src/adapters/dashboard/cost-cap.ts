import { Hono } from 'hono';
import { resolveEffectiveCostCap, setDailyCostCap } from '../../lib/state/cost-cap-repo.js';
import { syncBudgetToDailyCap } from '../../lib/aws/budget-writer.js';
import { authenticateDashboardToken, extractBearerToken, type TokenPrincipal } from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';

type CostCapEnv = { Variables: { principal: TokenPrincipal } };

// viewer < operator < admin. Reads need operator (ROLE_RANK). Writes are now
// gated on the cost:write CAPABILITY (operator-tier) — a product-approved LOOSEN
// from the prior admin-only role gate, so operator+ may set the cap.
const ROLE_RANK: Record<TokenPrincipal['role'], number> = { viewer: 0, operator: 1, admin: 2 };

export function buildCostCapRouter(): Hono<CostCapEnv> {
  const router = new Hono<CostCapEnv>();

  // Authenticate every request; per-route role gating happens below.
  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    await next();
  });

  // Effective daily cost cap + where it came from. Operator-readable.
  router.get('/', async (c) => {
    const principal = c.get('principal');
    if (ROLE_RANK[principal.role] < ROLE_RANK.operator) {
      return c.json({ error: 'forbidden', requiredRole: 'operator', yourRole: principal.role }, 403);
    }
    // Value and source come from the SAME resolution so 'runtime-config' can
    // never be reported for a stored value that isn't actually being enforced
    // (e.g. a 0/negative/junk override that silently falls back to the env
    // default). This was the source-mislabel bug: source was derived from a raw
    // getConfig() while the value came from getEffectiveCostCap().
    const { capUsd, source } = await resolveEffectiveCostCap();
    return c.json({ dailyCapUsd: capUsd, source });
  });

  // Set the daily cost cap. Operator-tier: gated on the cost:write capability
  // (product-approved loosen from admin-only). Mirrors the warroom capability +
  // custom-profile resolution (env break-glass / owner token always passes).
  router.post('/', async (c) => {
    const principal = c.get('principal');
    if (!(await principalHasRouteCapability(principal, 'cost:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'cost:write' }, 403);
    }
    const body = await c.req
      .json<{ dailyCapUsd?: number; reason?: string }>()
      .catch(() => ({} as { dailyCapUsd?: number; reason?: string }));
    const dailyCapUsd = Number(body.dailyCapUsd);
    // Reject <= 0. A cap of 0 is NOT a hard stop: getEffectiveCostCap() ignores
    // any stored value <= 0 and falls back to the env default, so accepting 0
    // here would store an intent that is never enforced (the silent-divergence
    // bug). Intentional full stops go through the bedrock_global kill switch.
    // The web UI mirrors this check client-side (Cost.tsx saveCap blocks <= 0).
    if (!Number.isFinite(dailyCapUsd) || dailyCapUsd <= 0) {
      return c.json({ error: 'dailyCapUsd must be a positive number' }, 400);
    }

    await setDailyCostCap(dailyCapUsd, { updatedBy: principal.label });

    // Propagate to the AWS monthly Budget so the limit set here also drives
    // AWS-native budget/forecast alerts. Best-effort: the in-app cap is the
    // hard enforcement; a Budget sync failure must not fail the cap write.
    const awsBudgetMonthlyUsd = await syncBudgetToDailyCap(dailyCapUsd).catch(() => null);

    void writeAudit({
      action: 'cost_cap_updated',
      detail: { dailyCapUsd, reason: body.reason ?? undefined, awsBudgetMonthlyUsd },
      userId: principal.hashPrefix16 ?? 'dashboard',
      operatorLabel: principal.label ?? undefined,
      surface: 'dashboard',
      result: 'ok',
    });

    return c.json({ ok: true, dailyCapUsd, source: 'runtime-config', awsBudgetMonthlyUsd });
  });

  return router;
}
