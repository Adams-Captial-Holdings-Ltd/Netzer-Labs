import { Hono } from 'hono';
import {
  subscribeEmail,
  listSubscriptions,
  removeRecipientByEmail,
  getAlertTopicArn,
} from '../../lib/alerting/sns-recipients.js';
import { assembleStatusData, type AlarmRow } from '../status/data.js';
import { authenticateDashboardToken, extractBearerToken, type TokenPrincipal } from '../../lib/auth/dashboard-auth.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';
import { logger } from '../../observability/logger.js';

type AlertsEnv = { Variables: { principal: TokenPrincipal } };

// viewer < operator < admin. Reads need operator; writes need admin.
const ROLE_RANK: Record<TokenPrincipal['role'], number> = { viewer: 0, operator: 1, admin: 2 };

// Conservative email shape check; SNS does the real validation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Shape rendered read-only on the Alerting page. Mirrors web AlertAlarm.
interface AlertAlarm {
  id: string;
  label: string;
  description: string;
  status: 'ok' | 'alarm' | 'insufficient' | 'unknown';
  metric?: string;
  threshold?: string;
}

// Map a CloudWatch alarm state to the page's alarm status enum.
const ALARM_STATUS: Record<AlarmRow['state'], AlertAlarm['status']> = {
  OK: 'ok',
  ALARM: 'alarm',
  INSUFFICIENT_DATA: 'insufficient',
};

// Turn a snake/dash/prefix alarm name into a readable label.
function alarmLabel(name: string): string {
  const stripped = name.replace(/^claudeclaw[-_]?/i, '');
  return stripped
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase()) || name;
}

// Map the CloudWatch alarm rows the status page already reads into the
// page's AlertAlarm shape. Fail-soft is handled by the caller.
function toAlertAlarms(alarms: AlarmRow[]): AlertAlarm[] {
  return alarms.map((a) => ({
    id: a.name,
    label: alarmLabel(a.name),
    description:
      a.reason ??
      (a.updatedAt ? `Last state change ${a.updatedAt}.` : 'CloudWatch alarm on the ops-alerts topic.'),
    status: ALARM_STATUS[a.state] ?? 'unknown',
  }));
}

export function buildAlertsRouter(): Hono<AlertsEnv> {
  const router = new Hono<AlertsEnv>();

  // Authenticate every request; per-route role gating happens below.
  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    await next();
  });

  // Add an email recipient to the ops-alerts topic. Admin-only.
  // AWS sends a confirmation link; subscription stays PendingConfirmation
  // until the recipient clicks it.
  router.post('/subscribe', async (c) => {
    const principal = c.get('principal');
    if (principal.role !== 'admin') {
      return c.json({ error: 'forbidden', requiredRole: 'admin', yourRole: principal.role }, 403);
    }
    const body = await c.req
      .json<{ email?: string; reason?: string }>()
      .catch(() => ({} as { email?: string; reason?: string }));
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!EMAIL_RE.test(email)) {
      return c.json({ error: 'a valid email is required' }, 400);
    }

    const result = await subscribeEmail(email, { addedBy: principal.label ?? 'dashboard' });

    void writeAudit({
      action: 'alert_recipient_added',
      detail: { email, reason: body.reason ?? undefined, status: result.status },
      userId: principal.hashPrefix16 ?? 'dashboard',
      operatorLabel: principal.label ?? undefined,
      surface: 'dashboard',
      result: result.status === 'error' ? 'error' : 'ok',
    });

    if (result.status === 'not_configured') {
      return c.json({ error: 'alert topic not configured' }, 503);
    }
    if (result.status === 'error') {
      return c.json({ error: 'subscribe failed', detail: result.error }, 502);
    }
    return c.json({ ok: true, email, status: result.status, subscriptionArn: result.arn });
  });

  // List recipients (PendingConfirmation / Confirmed), the CloudWatch alarms
  // wired to the ops-alerts topic, and the topic ARN. Operator+. The alarm read
  // reuses the same status aggregate the Security Posture > Observability tab
  // uses; it fails soft so a denied CloudWatch read still returns subscriptions.
  router.get('/subscriptions', async (c) => {
    const principal = c.get('principal');
    if (ROLE_RANK[principal.role] < ROLE_RANK.operator) {
      return c.json({ error: 'forbidden', requiredRole: 'operator', yourRole: principal.role }, 403);
    }
    const subscriptions = await listSubscriptions();

    let alarms: AlertAlarm[] = [];
    try {
      const status = await assembleStatusData();
      // assembleStatusData already fails soft per-source; an unreadable alarms
      // source surfaces as a sourceError with an empty alarms list.
      if (!status.sourceErrors.some((e) => e.startsWith('alarms:'))) {
        alarms = toAlertAlarms(status.alarms);
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'alerts: alarm read failed — returning empty alarms',
      );
    }

    return c.json({ subscriptions, alarms, topicArn: getAlertTopicArn() });
  });

  // Remove a recipient by email (path param). The page never has a subscription
  // ARN for pending rows, so removal keys on the email: we resolve email -> ARN
  // server-side and unsubscribe, or just drop the durable record if the
  // recipient is still PendingConfirmation (nothing to unsubscribe). Admin-only.
  router.delete('/subscriptions/:email', async (c) => {
    const principal = c.get('principal');
    if (principal.role !== 'admin') {
      return c.json({ error: 'forbidden', requiredRole: 'admin', yourRole: principal.role }, 403);
    }
    const email = decodeURIComponent(c.req.param('email') ?? '').trim();
    if (!EMAIL_RE.test(email)) {
      return c.json({ error: 'a valid email is required' }, 400);
    }

    const result = await removeRecipientByEmail(email, { updatedBy: principal.label ?? 'dashboard' });

    void writeAudit({
      action: 'alert_recipient_removed',
      detail: { email, ok: result.ok },
      userId: principal.hashPrefix16 ?? 'dashboard',
      operatorLabel: principal.label ?? undefined,
      surface: 'dashboard',
      result: result.ok ? 'ok' : 'error',
    });

    if (!result.ok) {
      return c.json({ error: 'unsubscribe failed', detail: result.error }, 502);
    }
    return c.json({ ok: true });
  });

  return router;
}
