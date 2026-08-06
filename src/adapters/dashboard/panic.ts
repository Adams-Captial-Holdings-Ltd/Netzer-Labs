import { Hono } from 'hono';
import {
  getCurrentPanicState,
  tryAcquirePanic,
  releasePanic,
  forceReleasePanic,
} from '../../lib/state/panic-state-repo.js';
import { authenticateDashboardToken, extractBearerToken, type TokenPrincipal } from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';

type PanicEnv = { Variables: { principal: TokenPrincipal } };

export function buildPanicRouter(): Hono<PanicEnv> {
  const router = new Hono<PanicEnv>();

  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    // Panic acquire/restore/force-release is a security-critical control. This
    // SWITCHES the gate from the legacy admin ROLE to the security:write
    // CAPABILITY — same admin/owner tier, not a privilege change — so a custom
    // admin-rank profile with security:write stripped is correctly denied.
    // Mirrors the warroom capability + custom-profile resolution (env break-glass
    // / owner token always passes).
    if (!(await principalHasRouteCapability(principal, 'security:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'security:write' }, 403);
    }
    await next();
  });

  router.get('/', async (c) => {
    const state = await getCurrentPanicState();
    return c.json(state);
  });

  router.post('/', async (c) => {
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}));
    const reason = (body as { reason?: string }).reason ?? 'manual trigger';
    // Attribution comes from the authenticated principal, never the request
    // body, so a caller cannot spoof who triggered the freeze.
    const principal = c.get('principal');
    const result = await tryAcquirePanic(reason, principal.label);
    if (!result.acquired) {
      return c.json({ error: 'panic already active', state: result.state }, 409);
    }
    return c.json(result.state);
  });

  router.post('/restore', async (c) => {
    const body = await c.req.json<{ generation?: number }>().catch(() => ({}));
    const generation = (body as { generation?: number }).generation;
    if (generation == null) {
      return c.json({ error: 'generation required' }, 400);
    }
    const principal = c.get('principal');
    try {
      const state = await releasePanic(generation, principal.label);
      return c.json(state);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        409,
      );
    }
  });

  router.post('/force-release', async (c) => {
    const principal = c.get('principal');
    const result = await forceReleasePanic(principal.label);
    if (!result.released) {
      return c.json({ error: 'no panic active', state: result.state }, 409);
    }
    return c.json(result.state);
  });

  return router;
}
