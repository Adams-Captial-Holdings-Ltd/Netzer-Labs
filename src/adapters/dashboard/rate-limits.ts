import { Hono } from 'hono';
import {
  getPolicy,
  setPolicy,
  getUsage,
  resetUsage,
  type RateLimitPolicy,
} from '../../lib/state/rate-limits-repo.js';
import { authenticateDashboardToken, extractBearerToken, type TokenPrincipal } from '../../lib/auth/dashboard-auth.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';

type RateLimitsEnv = { Variables: { principal: TokenPrincipal } };

// A rate-limit "key" addresses both a policy scope and a usage identity. The
// broad defaults are 'user', 'agent', 'scheduler'; specific overrides come in
// as 'user#<id>' or 'agent#<id>'. The same key string is used as the usage
// identity so the dashboard reads policy and usage off one address.
const KEY_RE = /^(user|agent)(#[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?$|^scheduler$/;

const ROLE_RANK: Record<TokenPrincipal['role'], number> = { viewer: 0, operator: 1, admin: 2 };

function requireRole(principal: TokenPrincipal, need: TokenPrincipal['role']): boolean {
  return ROLE_RANK[principal.role] >= ROLE_RANK[need];
}

/** Resolve the policy scope for a usage key (user#abc -> user policy scope). */
function scopeForKey(key: string): string {
  return key;
}

export function buildRateLimitsRouter(): Hono<RateLimitsEnv> {
  const router = new Hono<RateLimitsEnv>();

  // Authenticate every request; per-route role gates below. Reads are
  // operator (quota visibility is a routine ops concern); writes and resets
  // are admin (changing a quota is a security-sensitive control).
  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    if (!requireRole(principal, 'operator')) {
      return c.json({ error: 'forbidden', requiredRole: 'operator', yourRole: principal.role }, 403);
    }
    c.set('principal', principal);
    await next();
  });

  // GET /rate-limits/:key/policy (operator).
  router.get('/:key/policy', async (c) => {
    const key = c.req.param('key');
    if (!KEY_RE.test(key)) return c.json({ error: 'invalid key' }, 400);
    const policy = await getPolicy(scopeForKey(key));
    return c.json({ key, limit: policy.limit, windowSeconds: policy.windowSec });
  });

  // POST /rate-limits/:key/policy (admin). Attribution from the principal.
  router.post('/:key/policy', async (c) => {
    const principal = c.get('principal');
    if (!requireRole(principal, 'admin')) {
      return c.json({ error: 'forbidden', requiredRole: 'admin', yourRole: principal.role }, 403);
    }
    const key = c.req.param('key');
    if (!KEY_RE.test(key)) return c.json({ error: 'invalid key' }, 400);
    const body = await c.req
      .json<{ limit?: number; windowSeconds?: number }>()
      .catch(() => ({} as { limit?: number; windowSeconds?: number }));
    if (typeof body.limit !== 'number' || !Number.isFinite(body.limit) || body.limit < 0) {
      return c.json({ error: 'limit must be a non-negative number' }, 400);
    }
    if (
      body.windowSeconds !== undefined &&
      (typeof body.windowSeconds !== 'number' || !Number.isFinite(body.windowSeconds) || body.windowSeconds < 1)
    ) {
      return c.json({ error: 'windowSeconds must be >= 1' }, 400);
    }
    const policy: RateLimitPolicy = {
      limit: Math.floor(body.limit),
      windowSec: body.windowSeconds !== undefined ? Math.floor(body.windowSeconds) : 60,
    };
    await setPolicy(scopeForKey(key), policy, { updatedBy: principal.label });
    void writeAudit({
      action: 'rate_limit_policy_set',
      operatorLabel: principal.label,
      detail: { key, limit: policy.limit, windowSec: policy.windowSec },
      result: 'ok',
    });
    return c.json({ key, limit: policy.limit, windowSeconds: policy.windowSec });
  });

  // GET /rate-limits/:key/usage (operator). Current-window counts.
  router.get('/:key/usage', async (c) => {
    const key = c.req.param('key');
    if (!KEY_RE.test(key)) return c.json({ error: 'invalid key' }, 400);
    const u = await getUsage(key, scopeForKey(key));
    const remaining = u.limit > 0 ? Math.max(0, u.limit - u.count) : -1;
    return c.json({
      key,
      used: u.count,
      limit: u.limit,
      remaining,
      resetAt: new Date(u.resetAt).toISOString(),
    });
  });

  // POST /rate-limits/:key/reset (admin). Clears the current-window counter.
  router.post('/:key/reset', async (c) => {
    const principal = c.get('principal');
    if (!requireRole(principal, 'admin')) {
      return c.json({ error: 'forbidden', requiredRole: 'admin', yourRole: principal.role }, 403);
    }
    const key = c.req.param('key');
    if (!KEY_RE.test(key)) return c.json({ error: 'invalid key' }, 400);
    await resetUsage(key, scopeForKey(key));
    void writeAudit({
      action: 'rate_limit_reset',
      operatorLabel: principal.label,
      detail: { key },
      result: 'ok',
    });
    return c.json({ ok: true });
  });

  return router;
}
