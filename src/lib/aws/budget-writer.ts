/**
 * Propagate the dashboard's daily cost cap to the AWS monthly Budget so the
 * limit the operator sets in the UI also drives AWS-native budget alerts.
 *
 * Best-effort by design: a failure here never fails the cap write (the in-app
 * cap is the real enforcement; the AWS Budget is the alerting mirror). The
 * Budget is created by the CCE-CostGuardrails stack; we only update its amount.
 */

import {
  BudgetsClient,
  DescribeBudgetCommand,
  UpdateBudgetCommand,
} from '@aws-sdk/client-budgets';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { logger } from '../../observability/logger.js';

// Budgets + STS are global services; pin to us-east-1.
const BUDGET_NAME = process.env.CCE_BUDGET_NAME ?? 'claudeclaw-monthly-cost';
// Average days per month, so a daily cap maps to a sensible monthly budget.
const DAYS_PER_MONTH = 30.4;

let _budgets: BudgetsClient | null = null;
let _sts: STSClient | null = null;
let _accountId: string | null = process.env.AWS_ACCOUNT_ID ?? null;

function budgets(): BudgetsClient {
  if (!_budgets) _budgets = new BudgetsClient({ region: 'us-east-1' });
  return _budgets;
}
function sts(): STSClient {
  if (!_sts) _sts = new STSClient({ region: 'us-east-1' });
  return _sts;
}

async function accountId(): Promise<string | null> {
  if (_accountId) return _accountId;
  try {
    const id = await sts().send(new GetCallerIdentityCommand({}));
    _accountId = id.Account ?? null;
    return _accountId;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'budget: could not resolve account id',
    );
    return null;
  }
}

/**
 * Set the monthly budget limit to `dailyCapUsd * ~30.4`. Returns the new
 * monthly amount on success, or null if it was skipped/failed (logged, never
 * thrown).
 */
export async function syncBudgetToDailyCap(dailyCapUsd: number): Promise<number | null> {
  if (!Number.isFinite(dailyCapUsd) || dailyCapUsd <= 0) return null;
  const acct = await accountId();
  if (!acct) return null;
  const monthly = Math.round(dailyCapUsd * DAYS_PER_MONTH * 100) / 100;
  try {
    const cur = await budgets().send(
      new DescribeBudgetCommand({ AccountId: acct, BudgetName: BUDGET_NAME }),
    );
    const budget = cur.Budget;
    if (!budget) {
      logger.warn({ BUDGET_NAME }, 'budget: not found, skipping sync');
      return null;
    }
    budget.BudgetLimit = { Amount: monthly.toFixed(2), Unit: 'USD' };
    // CalculatedSpend is read-only/derived; drop it so UpdateBudget validates.
    delete budget.CalculatedSpend;
    await budgets().send(new UpdateBudgetCommand({ AccountId: acct, NewBudget: budget }));
    logger.info({ dailyCapUsd, monthly }, 'budget: synced monthly limit to daily cap');
    return monthly;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'budget: update failed',
    );
    return null;
  }
}
