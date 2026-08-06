import { Stack, Tags, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CfnAnomalyMonitor, CfnAnomalySubscription } from 'aws-cdk-lib/aws-ce';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { APP, TAGS } from './constants.js';
import type { BaseStackProps } from './interfaces.js';

/**
 * Standalone, push-based cost guardrails. Native AWS services so a spike
 * finds you instead of you finding it (the dashboard Cost page is pull-based;
 * this is the alarm bell).
 *
 *   - Cost Anomaly Detection: an ML monitor over per-service spend plus an
 *     IMMEDIATE email subscription that fires when the abnormal impact crosses
 *     a dollar threshold. This is the direct guard against the kind of
 *     overnight step-change that tripled the May bill.
 *   - AWS Budgets: a monthly cost budget with alerts at 80% / 100% actual and
 *     100% forecasted, so you hear about a drift toward the cap early.
 *
 * Both use EMAIL subscribers (no SNS topic, no confirmation handshake) to stay
 * dependency-free. This stack imports NOTHING from the other CCE stacks, so it
 * deploys in isolation (`cdk deploy CCE-CostGuardrails --exclusively`) without
 * disturbing the rest of the app — important while the older stacks carry
 * undeployed drift.
 *
 * Config (env, read at synth):
 *   CCE_COST_ALERT_EMAIL    recipient for anomaly + budget alerts. When unset,
 *                           the monitor/budget are still created but with no
 *                           subscribers (set the email and redeploy to arm).
 *   CCE_MONTHLY_BUDGET_USD  monthly budget ceiling in USD (default 600).
 *   CCE_ANOMALY_MIN_USD     min anomaly impact to alert on (default 25).
 */
export class CostGuardrailsStack extends Stack {
  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, props);

    const email = process.env.CCE_COST_ALERT_EMAIL?.trim();
    const monthlyBudgetUsd = Number(process.env.CCE_MONTHLY_BUDGET_USD ?? '600');
    const anomalyMinUsd = Number(process.env.CCE_ANOMALY_MIN_USD ?? '25');

    // ── Cost Anomaly Detection ────────────────────────────────────────
    // AWS allows exactly ONE DIMENSIONAL SERVICE monitor per account, and it
    // auto-creates "Default-Services-Monitor" the first time anomaly detection
    // is enabled. So: if CCE_ANOMALY_MONITOR_ARN is provided, attach our
    // subscription to that existing monitor (the shared-account / already-
    // enabled case); otherwise create our own (fresh-install case).
    const existingMonitorArn = process.env.CCE_ANOMALY_MONITOR_ARN?.trim();
    const monitorArn = existingMonitorArn
      ? existingMonitorArn
      : new CfnAnomalyMonitor(this, 'ServiceAnomalyMonitor', {
          monitorName: `${APP}-service-anomaly`,
          monitorType: 'DIMENSIONAL',
          monitorDimension: 'SERVICE',
        }).attrMonitorArn;

    if (email) {
      new CfnAnomalySubscription(this, 'AnomalyEmailSubscription', {
        subscriptionName: `${APP}-anomaly-email`,
        // EMAIL subscribers require DAILY/WEEKLY (IMMEDIATE is SNS-only). DAILY
        // is well-matched anyway: Cost Explorer's anomaly data settles ~daily,
        // so an immediate channel would not actually surface a spike sooner.
        frequency: 'DAILY',
        monitorArnList: [monitorArn],
        subscribers: [{ type: 'EMAIL', address: email }],
        // Alert when the total dollar impact of an anomaly is at least N USD.
        thresholdExpression: JSON.stringify({
          Dimensions: {
            Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
            Values: [String(anomalyMinUsd)],
            MatchOptions: ['GREATER_THAN_OR_EQUAL'],
          },
        }),
      });
    }

    // ── Monthly budget with forecast alerts ───────────────────────────
    const subscribers = email
      ? [{ subscriptionType: 'EMAIL', address: email }]
      : undefined;
    new CfnBudget(this, 'MonthlyCostBudget', {
      budget: {
        budgetName: `${APP}-monthly-cost`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: subscribers
        ? [
            {
              notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80 },
              subscribers,
            },
            {
              notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 100 },
              subscribers,
            },
            {
              notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100 },
              subscribers,
            },
          ]
        : undefined,
    });

    new CfnOutput(this, 'CostAlertEmail', { value: email ?? '(unset — alerts disabled)' });
    new CfnOutput(this, 'MonthlyBudgetUsd', { value: String(monthlyBudgetUsd) });

    Tags.of(this).add('Application', TAGS.Application);
  }
}
