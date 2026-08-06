/**
 * Observability posture router (Tier B, read-only).
 *
 * GET /api/posture/observability -> { cards: PostureCard[] }
 *
 * Combines four observability signals into uniform posture cards:
 *   - CloudWatch alarms summary (count + how many in ALARM)
 *   - synthetic canary last-fire status
 *   - CloudTrail audit-trail cards (see cloudtrail-reader.ts)
 *   - a static X-Ray tier note (tracing enabled at Tier 2+)
 *
 * Every signal is read fail-soft: a denied permission or AWS error
 * degrades the relevant card(s) to an 'unknown' (amber) state with a
 * short note instead of 500-ing the page. Any authenticated dashboard
 * user (viewer+) may read this; it exposes only metadata, no secrets.
 *
 * The alarms + canary summary reuse src/adapters/status/data.ts. That
 * module does not export its per-signal fetchers (fetchAlarms /
 * fetchCanary are file-private), so we reuse the exported
 * assembleStatusData aggregate, which computes both internally and
 * already wraps each source in its own try/catch. See crossFileNeeds.
 */

import { Hono } from 'hono';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import {
  assembleStatusData,
  type StatusData,
} from '../status/data.js';
import {
  fetchCloudTrailPostureCards,
  type PostureCard,
} from '../../lib/aws/cloudtrail-reader.js';
import { logger } from '../../observability/logger.js';

type ObservabilityEnv = { Variables: { principal: TokenPrincipal } };

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the alarms-summary and canary cards from the status aggregate.
 * The aggregate fails soft internally and surfaces per-source failures
 * via `sourceErrors`; we translate those into 'unknown' cards.
 */
function statusCards(status: StatusData): PostureCard[] {
  const cards: PostureCard[] = [];

  // ── CloudWatch alarms summary ─────────────────────────────────────
  const alarmsErr = status.sourceErrors.find((e) => e.startsWith('alarms:'));
  if (alarmsErr) {
    cards.push({
      id: 'posture.observability.alarms',
      label: 'CloudWatch alarms',
      status: 'unknown',
      detail: `Could not read alarms: ${alarmsErr.replace(/^alarms:\s*/, '')}`,
    });
  } else {
    const total = status.alarms.length;
    const inAlarm = status.alarms.filter((a) => a.state === 'ALARM').length;
    if (inAlarm > 0) {
      cards.push({
        id: 'posture.observability.alarms',
        label: 'CloudWatch alarms',
        status: 'crit',
        detail: `${inAlarm} of ${total} alarm(s) currently in ALARM state.`,
        value: `${inAlarm} firing`,
      });
    } else if (total === 0) {
      // No alarms configured is itself a posture gap, not a clean pass.
      cards.push({
        id: 'posture.observability.alarms',
        label: 'CloudWatch alarms',
        status: 'warn',
        detail: 'No CloudWatch alarms are configured for this deployment.',
        value: '0 alarms',
      });
    } else {
      cards.push({
        id: 'posture.observability.alarms',
        label: 'CloudWatch alarms',
        status: 'ok',
        detail: `${total} alarm(s) configured, none firing.`,
        value: `${total} ok`,
      });
    }
  }

  // ── Synthetic canary last-fire ────────────────────────────────────
  const canaryErr = status.sourceErrors.find((e) => e.startsWith('canary:'));
  if (canaryErr) {
    cards.push({
      id: 'posture.observability.canary',
      label: 'Synthetic canary',
      status: 'unknown',
      detail: `Could not read canary history: ${canaryErr.replace(/^canary:\s*/, '')}`,
    });
  } else {
    const c = status.canary;
    if (c.total === 0) {
      cards.push({
        id: 'posture.observability.canary',
        label: 'Synthetic canary',
        status: 'warn',
        detail: `No canary runs recorded in the last ${c.windowHours}h.`,
        value: 'no data',
      });
    } else if (c.lastResult === 'error') {
      cards.push({
        id: 'posture.observability.canary',
        label: 'Synthetic canary',
        status: 'crit',
        detail: `Last canary run failed${c.lastFiredAt ? ` at ${c.lastFiredAt}` : ''}. Uptime ${c.uptimePct ?? 0}% over ${c.windowHours}h.`,
        value: c.uptimePct !== null ? `${c.uptimePct}%` : 'error',
      });
    } else if (c.uptimePct !== null && c.uptimePct < 95) {
      cards.push({
        id: 'posture.observability.canary',
        label: 'Synthetic canary',
        status: 'warn',
        detail: `Canary uptime ${c.uptimePct}% over ${c.windowHours}h (below 95%).`,
        value: `${c.uptimePct}%`,
      });
    } else {
      cards.push({
        id: 'posture.observability.canary',
        label: 'Synthetic canary',
        status: 'ok',
        detail: `Last canary run ok${c.lastFiredAt ? ` at ${c.lastFiredAt}` : ''}. Uptime ${c.uptimePct ?? 100}% over ${c.windowHours}h.`,
        value: c.uptimePct !== null ? `${c.uptimePct}%` : 'ok',
      });
    }
  }

  return cards;
}

/**
 * Static X-Ray tier note. X-Ray tracing is wired in at Tier 2 and above
 * (CCE_XRAY_ENABLED=1 is set by the CDK at those tiers). This is a posture
 * note, not a live AWS read, so it never errors.
 */
function xrayCard(): PostureCard {
  const enabled = process.env.CCE_XRAY_ENABLED === '1';
  const tier = Number(process.env.CCE_TIER ?? '1');
  if (enabled) {
    return {
      id: 'posture.observability.xray',
      label: 'X-Ray tracing',
      status: 'ok',
      detail: `Distributed tracing is enabled (Tier ${Number.isFinite(tier) ? tier : '?'}).`,
      value: 'enabled',
    };
  }
  return {
    id: 'posture.observability.xray',
    label: 'X-Ray tracing',
    status: 'warn',
    detail: 'Distributed tracing is not enabled. X-Ray activates at Tier 2 and above.',
    value: 'tier 2+',
  };
}

export function buildObservabilityPostureRouter(): Hono<ObservabilityEnv> {
  const router = new Hono<ObservabilityEnv>();

  // Authenticate every request, then gate on posture:read (operator-tier).
  // This surfaces LIVE AWS observability posture data, so it is NOT viewer-
  // readable: viewer/analyst lack posture:read and are denied. Mirrors the
  // warroom capability + custom-profile resolution (env break-glass / owner
  // always passes).
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
    const cards: PostureCard[] = [];

    // Alarms + canary, via the status aggregate (fails soft internally).
    try {
      const status = await assembleStatusData();
      cards.push(...statusCards(status));
    } catch (err) {
      const msg = errMsg(err);
      logger.warn({ errMessage: msg }, 'posture: status aggregate failed');
      cards.push({
        id: 'posture.observability.alarms',
        label: 'CloudWatch alarms',
        status: 'unknown',
        detail: `Could not read observability status: ${msg}`,
      });
      cards.push({
        id: 'posture.observability.canary',
        label: 'Synthetic canary',
        status: 'unknown',
        detail: `Could not read observability status: ${msg}`,
      });
    }

    // CloudTrail cards (reader fails soft per-card).
    try {
      cards.push(...(await fetchCloudTrailPostureCards()));
    } catch (err) {
      const msg = errMsg(err);
      logger.warn({ errMessage: msg }, 'posture: cloudtrail reader failed');
      cards.push({
        id: 'posture.cloudtrail.enabled',
        label: 'CloudTrail audit trail',
        status: 'unknown',
        detail: `Could not read CloudTrail posture: ${msg}`,
      });
    }

    // Static X-Ray tier note.
    cards.push(xrayCard());

    return c.json({ cards });
  });

  return router;
}
