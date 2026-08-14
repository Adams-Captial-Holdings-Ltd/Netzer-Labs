/**
 * Cost watch — in-app daily cost evaluator (the push complement to the
 * pull-based Cost page, and to the native AWS Budget / Anomaly Detection).
 *
 * Its UNIQUE job vs the native guardrails: resource-delta detection. AWS
 * Budgets/Anomaly alert on DOLLARS (which lag ~a day). This watches the live
 * waste scan (NAT/endpoints/EIPs/volumes/LBs) and alerts the moment the
 * recoverable-waste total jumps, i.e. the instant someone spins up expensive
 * infra, before it has cost a cent. It also re-checks projection vs budget.
 *
 * Safe by construction:
 *   - OFF by default. Runs only when runtime-config cost/watch_enabled='true'
 *     (live-toggleable, no redeploy).
 *   - Acts at most once per UTC day (runtime-config cost/watch_last_run guard),
 *     so the 3 Fargate tasks don't each alert. First-tick jitter further
 *     shrinks the dup-alert race; worst case is one duplicate email.
 *   - Cost Explorer is only queried on the day's first real run, bounding CE
 *     cost to a few calls/day even though the timer ticks every 6h.
 *   - Every failure is caught and logged; it can never crash the orchestrator.
 *
 * Alerts publish to the existing ops-alerts SNS topic (CCE_ALERT_TOPIC_ARN),
 * so recipients configured on the Alerting page receive them.
 */

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { readCostSummary, readCostRisks } from '../lib/aws/cost-reader.js';
import { getConfig, setConfig } from '../lib/state/runtime-config-repo.js';
import { logger } from '../observability/logger.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // tick every 6h; acts once/UTC-day
const BOOT_DELAY_MS = 60_000;
// Alert when recoverable waste rises by at least this much vs the last run
// (new wasteful resources appeared).
const WASTE_JUMP_USD = 20;

let timer: ReturnType<typeof setInterval> | null = null;
let _sns: SNSClient | null = null;
function sns(): SNSClient {
  if (!_sns) _sns = new SNSClient({ region: REGION });
  return _sns;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function publishAlert(message: string): Promise<void> {
  const arn = process.env.CCE_ALERT_TOPIC_ARN;
  if (!arn) {
    logger.warn({}, 'cost-watch: CCE_ALERT_TOPIC_ARN unset; alert not sent');
    return;
  }
  await sns().send(
    new PublishCommand({ TopicArn: arn, Subject: 'Netzar OS cost alert', Message: message }),
  );
}

export interface CostWatchResult {
  ran: boolean;
  alerted: boolean;
  reason?: string;
  alerts?: string[];
}

/**
 * Run one evaluation. `force` bypasses the enabled flag and the once-a-day
 * guard (used by the admin test endpoint).
 */
export async function runCostWatchOnce(opts: { force?: boolean } = {}): Promise<CostWatchResult> {
  if (!opts.force) {
    const enabled = (await getConfig('cost', 'watch_enabled')) === 'true';
    if (!enabled) return { ran: false, alerted: false, reason: 'disabled' };
    const today = todayUtc();
    if ((await getConfig('cost', 'watch_last_run')) === today) {
      return { ran: false, alerted: false, reason: 'already-ran-today' };
    }
    // Claim the day before doing the work so peer tasks short-circuit.
    await setConfig('cost', 'watch_last_run', today, { updatedBy: 'cost-watch' });
  }

  const [summary, risks] = await Promise.all([readCostSummary(), readCostRisks()]);
  const alerts: string[] = [];

  // 1) Projection vs the configured monthly budget.
  const budget = Number(process.env.CCE_MONTHLY_BUDGET_USD ?? '600');
  if (summary.available && budget > 0 && summary.projectedMonthUsd > budget) {
    alerts.push(
      `Projected month-end $${summary.projectedMonthUsd.toFixed(0)} exceeds the $${budget} budget.`,
    );
  }

  // 2) Waste delta: did recoverable waste jump since the last run?
  if (risks.available) {
    const prev = Number((await getConfig('cost', 'watch_last_risk_total')) ?? 'NaN');
    const total = risks.totalMonthlySavingsUsd;
    if (Number.isFinite(prev) && total - prev >= WASTE_JUMP_USD) {
      const high = risks.risks
        .filter((r) => r.severity === 'high')
        .map((r) => `${r.title} (${r.region})`);
      alerts.push(
        `Recoverable waste rose to $${total.toFixed(0)}/mo (was $${prev.toFixed(0)}). ` +
          (high.length ? `High-severity: ${high.join('; ')}.` : ''),
      );
    }
    await setConfig('cost', 'watch_last_risk_total', String(total), { updatedBy: 'cost-watch' });
  }

  if (alerts.length === 0) return { ran: true, alerted: false };

  const body = [
    'Netzar OS cost watch',
    `MTD $${(summary.monthToDateUsd ?? 0).toFixed(2)} | projected $${(summary.projectedMonthUsd ?? 0).toFixed(0)} | last month $${(summary.lastMonthUsd ?? 0).toFixed(0)}`,
    '',
    ...alerts,
    '',
    'Open the dashboard Cost page for the full breakdown.',
  ].join('\n');
  await publishAlert(body);
  return { ran: true, alerted: true, alerts };
}

export function startCostWatch(): void {
  if (timer) return;
  // Jitter the first tick so the 3 tasks don't fire simultaneously (shrinks the
  // once-a-day claim race). Math.random is fine here (real runtime, not a
  // replayable workflow).
  const jitter = Math.floor(Math.random() * 90_000);
  const kick = (): void => {
    void runCostWatchOnce().catch((err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'cost-watch tick failed',
      ),
    );
  };
  setTimeout(() => {
    kick();
    timer = setInterval(kick, CHECK_INTERVAL_MS);
  }, BOOT_DELAY_MS + jitter).unref();
  logger.info({}, 'cost-watch started (gated by runtime-config cost/watch_enabled)');
}

export function stopCostWatch(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
