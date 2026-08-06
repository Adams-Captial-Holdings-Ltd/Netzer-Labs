/**
 * Webhook health monitor. Runs every 2 minutes and checks:
 *   1. Telegram getWebhookInfo - alerts on errors or growing pending count
 *   2. Sends a synthetic POST to the webhook URL to verify WAF + ALB pass
 *
 * If either check fails, sends an alert via Telegram DM to the operator
 * and writes an audit event. This catches WAF blocks, cert mismatches,
 * DNS issues, and webhook misconfiguration before users notice.
 */

import { logger } from '../observability/logger.js';
import { tryAcquireRunnerLease } from '../lib/state/runner-lease.js';
import { writeAudit } from '../lib/audit/audit-writer.js';
import { getBotToken, knownAgents } from '../adapters/telegram/send.js';

const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const ALERT_CHAT_ID = process.env.CCE_OPERATOR_TELEGRAM_CHAT_ID ?? '';

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastAlertAt = 0;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

export function startWebhookMonitor(): void {
  if (process.env.CCE_WEBHOOK_MONITOR_DISABLED === '1') {
    logger.info({}, 'webhook monitor disabled');
    return;
  }
  if (timer) return;
  const delay = 60_000 + Math.floor(Math.random() * 60_000);
  logger.info({ intervalMs: CHECK_INTERVAL_MS, initialDelayMs: delay }, 'webhook monitor armed');
  timer = setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  }, delay);
}

export function stopWebhookMonitor(): void {
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }
}

export interface WebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

// Exported so the integrations inventory (src/lib/state/integrations-inventory.ts)
// can reuse the exact same Telegram probe instead of duplicating the fetch.
export async function getWebhookInfo(botToken: string): Promise<WebhookInfo | null> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
      signal: AbortSignal.timeout(10_000),
    });
    const data = await resp.json() as { ok: boolean; result: WebhookInfo };
    return data.ok ? data.result : null;
  } catch {
    return null;
  }
}

export async function syntheticWebhookTest(webhookUrl: string, secret: string): Promise<{ ok: boolean; status: number }> {
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': secret,
      },
      body: JSON.stringify({ update_id: 0 }),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: resp.status === 200, status: resp.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function alertOperator(botToken: string, message: string): Promise<void> {
  if (!ALERT_CHAT_ID) return;
  if (Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ALERT_CHAT_ID, text: message }),
      signal: AbortSignal.timeout(10_000),
    });
    lastAlertAt = Date.now();
  } catch {
    logger.warn({}, 'webhook monitor: failed to send operator alert');
  }
}

/**
 * Probe a single agent's Telegram webhook. Returns the detected problems
 * (empty array means healthy) plus the webhook URL for alert context.
 * Pure read against the Telegram API; never throws.
 */
async function probeAgentWebhook(
  botToken: string,
): Promise<{ problems: string[]; url: string } | null> {
  const info = await getWebhookInfo(botToken);
  if (!info) return null;

  const problems: string[] = [];

  if (info.last_error_message) {
    const errorAge = info.last_error_date
      ? Math.floor(Date.now() / 1000) - info.last_error_date
      : 999;
    if (errorAge < 300) {
      problems.push(`Webhook error (${errorAge}s ago): ${info.last_error_message}`);
    }
  }

  if (info.pending_update_count > 5) {
    problems.push(`${info.pending_update_count} pending updates (messages stuck)`);
  }

  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (info.url && webhookSecret) {
    const probe = await syntheticWebhookTest(info.url, webhookSecret);
    if (!probe.ok) {
      problems.push(`Synthetic webhook POST returned ${probe.status} (expected 200)`);
    }
  }

  return { problems, url: info.url };
}

async function tick(): Promise<void> {
  // H6: one monitor across the fleet — N tasks would each re-register the
  // webhook and each alert the operator. Fail-open on a lease-store error.
  if (!(await tryAcquireRunnerLease({ name: 'webhook-monitor', ttlMs: CHECK_INTERVAL_MS * 2 }))) {
    return;
  }
  if (running) return;
  running = true;
  try {
    // Probe every connected agent's bot, not just 'main'. knownAgents()
    // returns the static TELEGRAM_TOKENS_JSON ids; we always include 'main'
    // as a fallback so a single-bot deploy without the map still works.
    const agentIds = Array.from(new Set(['main', ...knownAgents()]));

    for (const agentId of agentIds) {
      const botToken = getBotToken(agentId);
      if (!botToken) continue;

      const result = await probeAgentWebhook(botToken);
      if (!result) {
        logger.warn({ agentId }, 'webhook monitor: getWebhookInfo failed');
        continue;
      }

      if (result.problems.length > 0) {
        const msg = `[WEBHOOK ALERT] agent=${agentId}\n${result.problems.join('\n')}\n\nURL: ${result.url}`;
        logger.error(
          { agentId, problems: result.problems, url: result.url },
          'webhook monitor: issues detected',
        );
        void writeAudit({
          action: 'canary_fired',
          surface: 'system',
          detail: { monitor: 'webhook', agentId, problems: result.problems },
          result: 'error',
        });
        await alertOperator(botToken, msg);
      } else {
        logger.debug({ agentId, url: result.url }, 'webhook monitor: healthy');
      }
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'webhook monitor tick failed');
  } finally {
    running = false;
  }
}
