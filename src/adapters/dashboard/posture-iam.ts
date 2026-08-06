/**
 * IAM posture router (Tier B, read-only).
 *
 * GET / -> { cards: PostureCard[] }
 *
 * Reads the orchestrator's OWN task role (iam-reader) and grades its
 * least-privilege posture (iam-evaluator). Readable by any authenticated
 * dashboard user (viewer+). Fails SOFT: a denied describe or any unexpected
 * error degrades to 'unknown'/amber cards, it never 500s the page.
 *
 * No write paths to AWS. No secret VALUES are ever returned; policy documents
 * are public IAM metadata.
 */

import { Hono } from 'hono';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import { fetchIamPosture } from '../../lib/posture/iam-reader.js';
import { evaluateIamPosture, type PostureCard } from '../../lib/posture/iam-evaluator.js';
import { logger } from '../../observability/logger.js';

type IamPostureEnv = { Variables: { principal: TokenPrincipal } };

export function buildIamPostureRouter(): Hono<IamPostureEnv> {
  const router = new Hono<IamPostureEnv>();

  // Authenticate every request, then gate on posture:read (operator-tier).
  // This surfaces LIVE AWS IAM posture data, so it is NOT viewer-readable:
  // viewer/analyst lack posture:read and are denied. Mirrors the warroom
  // capability + custom-profile resolution (env break-glass / owner always passes).
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
    try {
      const posture = await fetchIamPosture();
      const { cards } = evaluateIamPosture(posture);
      return c.json({ cards });
    } catch (err) {
      // Fail-soft: never 500 the posture page. Surface an amber card.
      logger.error({ err }, 'posture-iam: unexpected error, returning unknown card');
      const fallback: PostureCard[] = [
        {
          id: 'iam-role-discovered',
          label: 'Task role discovery',
          status: 'unknown',
          detail: 'IAM posture read failed unexpectedly; posture unknown.',
          value: 'unknown',
        },
      ];
      return c.json({ cards: fallback });
    }
  });

  return router;
}
