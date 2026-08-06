/**
 * Tier B read-only network posture router. Mounted at
 * /api/posture/network (see src/server.ts).
 *
 * GET / returns { cards: PostureCard[] } aggregated from three runtime
 * readers:
 *
 *   - WAF        (src/lib/aws/waf-reader.ts)
 *   - VPC        (src/lib/aws/network-reader.ts)
 *   - GuardDuty  (src/lib/aws/guardduty-reader.ts)
 *
 * Readable by any authenticated dashboard user (viewer+). There are NO
 * write paths here and no secret VALUES are ever returned. Every reader is
 * already fail-soft (a denied describe yields an 'unknown' card), and this
 * router adds one more catch layer per reader so a single thrown reader
 * never 500s the page.
 */

import { Hono } from 'hono';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import { logger } from '../../observability/logger.js';
import { readWafPosture } from '../../lib/aws/waf-reader.js';
import { readNetworkPosture } from '../../lib/aws/network-reader.js';
import { readGuardDutyPosture } from '../../lib/aws/guardduty-reader.js';

/**
 * Shared posture-card shape. Identical across all four posture routers so
 * the dashboard renders them through one uniform component. The three
 * network readers import this type from here.
 *
 *   status: 'ok'      -> green   (control present and healthy)
 *           'warn'    -> amber   (control missing or partial; not fatal)
 *           'crit'    -> red     (control actively wrong / exposed)
 *           'unknown' -> grey    (could not read; describe denied/errored)
 */
export interface PostureCard {
  /** Stable id, kebab-case, unique within this router's card set. */
  id: string;
  /** Short human label for the card header. */
  label: string;
  /** Traffic-light status. */
  status: 'ok' | 'warn' | 'crit' | 'unknown';
  /** One-line explanation. Never contains a secret value. */
  detail: string;
  /** Optional compact value badge (count, name, limit). */
  value?: string;
}

type PostureEnv = { Variables: { principal: TokenPrincipal } };

/** Run one reader; if it throws, degrade to a single 'unknown' card. */
async function safeRead(
  source: string,
  fallbackId: string,
  fallbackLabel: string,
  fn: () => Promise<PostureCard[]>,
): Promise<PostureCard[]> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ errMessage: msg, source }, 'posture/network: reader threw');
    return [
      {
        id: fallbackId,
        label: fallbackLabel,
        status: 'unknown',
        detail: `Reader failed (${msg}).`,
      },
    ];
  }
}

export function buildNetworkPostureRouter(): Hono<PostureEnv> {
  const router = new Hono<PostureEnv>();

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
    // Run the three readers in parallel; each is independently fail-soft.
    const [waf, network, guardduty] = await Promise.all([
      safeRead('waf', 'waf-enabled', 'WAF enabled', readWafPosture),
      safeRead(
        'network',
        'net-private-subnets',
        'Private-subnet isolation',
        readNetworkPosture,
      ),
      safeRead(
        'guardduty',
        'guardduty-enabled',
        'GuardDuty threat detection',
        readGuardDutyPosture,
      ),
    ]);

    const cards: PostureCard[] = [...waf, ...network, ...guardduty];
    return c.json({ cards });
  });

  return router;
}
