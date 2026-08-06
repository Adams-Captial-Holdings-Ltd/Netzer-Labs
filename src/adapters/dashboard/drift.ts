/**
 * CDK drift router. Mounted at /api/drift (see src/server.ts). Admin-only.
 *
 *   GET  /status  { enabled, lastRun }  — is the daily drift-watch armed
 *   POST /check   run CloudFormation drift detection across CCE-* now and
 *                 return { ran, checked, drifted[] } (also alerts if drifted)
 *
 * Read-only with respect to AWS resources (DetectStackDrift initiates a scan;
 * it does not modify anything). Useful to verify drift on demand.
 */

import { Hono } from 'hono';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { getConfig } from '../../lib/state/runtime-config-repo.js';
import { runDriftCheckOnce } from '../../workers/drift-watch.js';
import { logger } from '../../observability/logger.js';

type DriftEnv = { Variables: { principal: TokenPrincipal } };

export function buildDriftRouter(): Hono<DriftEnv> {
  const router = new Hono<DriftEnv>();

  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    if (principal.role !== 'admin') {
      return c.json({ error: 'forbidden', requiredRole: 'admin', yourRole: principal.role }, 403);
    }
    c.set('principal', principal);
    await next();
  });

  router.get('/status', async (c) => {
    return c.json({
      enabled: (await getConfig('drift', 'watch_enabled')) === 'true',
      lastRun: (await getConfig('drift', 'last_run')) ?? null,
    });
  });

  router.post('/check', async (c) => {
    try {
      const result = await runDriftCheckOnce({ force: true });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'drift/check failed');
      return c.json({ error: 'drift check failed' }, 502);
    }
  });

  return router;
}
