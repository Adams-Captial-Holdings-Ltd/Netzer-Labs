/**
 * Security posture router (Tier B, READ-ONLY).
 *
 * GET /api/posture/security -> { cards: PostureCard[] }
 *
 * Surfaces encryption / secrets / backup posture as uniform status cards.
 * Readable by any authenticated dashboard user (viewer+); there is no
 * write path and no secret VALUE ever leaves this router. Every underlying
 * describe call fails soft to an 'unknown' card, so a denied permission
 * degrades a card rather than 500-ing the page.
 */

import { Hono } from 'hono';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import { getSecurityPosture } from '../../lib/security/posture-repo.js';

type SecurityPostureEnv = { Variables: { principal: TokenPrincipal } };

export function buildSecurityPostureRouter(): Hono<SecurityPostureEnv> {
  const router = new Hono<SecurityPostureEnv>();

  // Authenticate every request, then gate on posture:read (operator-tier).
  // This surfaces LIVE AWS posture data, so it is NOT viewer-readable: viewer/
  // analyst lack posture:read and are denied. Mirrors the warroom capability +
  // custom-profile resolution (the env break-glass / owner token always passes).
  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    if (!(await principalHasRouteCapability(principal, 'posture:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'posture:read' }, 403);
    }
    await next();
  });

  router.get('/', async (c) => {
    // getSecurityPosture is internally fail-soft per source, but guard the
    // whole call too: a posture page must never 500.
    const cards = await getSecurityPosture().catch(() => [
      {
        id: 'security-posture',
        label: 'security posture',
        status: 'unknown' as const,
        detail: 'posture snapshot temporarily unavailable',
      },
    ]);
    return c.json({ cards });
  });

  return router;
}
