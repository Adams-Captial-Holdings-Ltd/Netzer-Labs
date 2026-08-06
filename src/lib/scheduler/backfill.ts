/**
 * One-shot backfill: ensure every active scheduled_task row has a
 * paired EB Scheduler entry (A1), and reconcile rows that went overdue
 * during downtime (deploys, crashes, power-switch pauses).
 *
 * Runs once at boot when EB Scheduler is enabled. Idempotent — each
 * boot lists existing schedules and only creates the missing ones, and
 * every overdue-row write is fenced on the row's PRIOR nextRunAt, so N
 * replicas booting at once (or a concurrent queue-drain fire) cannot
 * double-apply a catch-up.
 *
 * We scan only ACTIVE rows because cancelled / done rows shouldn't
 * fire. The scan is bounded — we list the whole table once across
 * partitions via a Scan call, since there's no GSI keyed on status
 * alone we can hit without already knowing an agent id.
 *
 * Overdue policy (the wake catch-up):
 *   - Fresh rows (future, or up to 5 min past): re-arm as before.
 *   - Recurring rows further in the past are ADVANCED to their next
 *     on-grid future occurrence and re-armed. They deliberately do NOT
 *     fire late — the queue-drain stale fence drops any replayed SQS
 *     message for a row that was advanced, so a morning brief missed
 *     during a pause is skipped cleanly instead of firing at a random
 *     wake time. Rows whose endAt passed during downtime are retired.
 *   - One-shot rows overdue by less than the SQS retention (4 days)
 *     are left alone: their fire already sits in the queue and will
 *     deliver late once the drain starts.
 *   - One-shot rows overdue 4-7 days are re-armed to fire ~1 min out
 *     (late is better than lost for a reminder).
 *   - One-shot rows older than 7 days are retired as expired, with an
 *     audit row so the miss is visible instead of silent.
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import { logger } from '../../observability/logger.js';
import { writeAudit } from '../audit/audit-writer.js';
import {
  advanceOverdueTask,
  expireOverdueTask,
} from '../state/scheduled-tasks-repo.js';
import {
  upsertSchedule,
  listExistingTaskIds,
  isEbSchedulerEnabled,
} from './eb-scheduler.js';

const TABLE = process.env.TABLE_SCHEDULED_TASKS ?? 'claudeclaw-scheduled-tasks';

/** Rows this recently overdue are simply re-armed, not reconciled. */
const RECOVERY_WINDOW_SEC = 300;
/** Scheduled-fire SQS retention: fires within this window still replay. */
const SQS_RETENTION_SEC = 4 * 86400;
/** One-shots overdue beyond this are retired instead of fired late. */
const LATE_ONESHOT_MAX_AGE_SEC = 7 * 86400;

interface ActiveRow {
  id: string;
  agentId: string;
  nextRunAt: number;
  intervalSec?: number;
  endAt?: string;
}

async function listActiveRows(): Promise<ActiveRow[]> {
  const out: ActiveRow[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const resp = await ddb().send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: '#s = :active',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':active': 'active' },
        ProjectionExpression: 'id, agentId, nextRunAt, intervalSec, endAt',
        Limit: 100,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    for (const item of resp.Items ?? []) {
      if (typeof item.id === 'string' && typeof item.agentId === 'string') {
        out.push({
          id: item.id,
          agentId: item.agentId,
          nextRunAt: Number(item.nextRunAt ?? 0),
          ...(item.intervalSec !== undefined
            ? { intervalSec: Number(item.intervalSec) }
            : {}),
          ...(item.endAt ? { endAt: String(item.endAt) } : {}),
        });
      }
    }
    cursor = resp.LastEvaluatedKey;
  } while (cursor);
  return out;
}

export interface BackfillSummary {
  active: number;
  created: number;
  alreadyPresent: number;
  /** Recurring rows advanced past the downtime gap and re-armed. */
  caughtUp: number;
  /** One-shots left for the SQS replay to deliver late. */
  deferredToQueue: number;
  /** One-shots re-armed to fire ~1 min out (past SQS retention). */
  lateRearmed: number;
  /** Rows retired: one-shots past the late-fire horizon, or endAt passed. */
  expired: number;
  /** Fence lost to a concurrent writer or EB call failed; healed next boot. */
  skipped: number;
}

/**
 * Backfill any missing EB schedules and reconcile overdue rows.
 * Returns a small summary for the boot log.
 */
export async function runScheduleBackfill(): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    active: 0,
    created: 0,
    alreadyPresent: 0,
    caughtUp: 0,
    deferredToQueue: 0,
    lateRearmed: 0,
    expired: 0,
    skipped: 0,
  };
  if (!isEbSchedulerEnabled()) return summary;
  const [rows, existing] = await Promise.all([
    listActiveRows().catch((err) => {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err) },
        'scheduler backfill: scan failed; skipping',
      );
      return [] as ActiveRow[];
    }),
    listExistingTaskIds(),
  ]);
  const nowSec = Math.floor(Date.now() / 1000);
  summary.active = rows.length;
  for (const row of rows) {
    if (existing.has(row.id)) {
      summary.alreadyPresent += 1;
      continue;
    }
    if (row.nextRunAt >= nowSec - RECOVERY_WINDOW_SEC) {
      const ok = await upsertSchedule({
        taskId: row.id,
        agentId: row.agentId,
        nextRunAtUnixSec: Math.max(row.nextRunAt, nowSec + 5),
      });
      if (ok) summary.created += 1;
      else summary.skipped += 1;
      continue;
    }
    await reconcileOverdueRow(row, nowSec, summary);
  }
  logger.info({ ...summary }, 'scheduler backfill done');
  return summary;
}

async function reconcileOverdueRow(
  row: ActiveRow,
  nowSec: number,
  summary: BackfillSummary,
): Promise<void> {
  const overdueBy = nowSec - row.nextRunAt;
  if (row.intervalSec !== undefined && row.intervalSec > 0) {
    const steps = Math.ceil((nowSec + 5 - row.nextRunAt) / row.intervalSec);
    const next = row.nextRunAt + steps * row.intervalSec;
    const endStop =
      row.endAt && new Date(row.endAt).getTime() / 1000 <= next;
    if (endStop) {
      if (await expireOverdueTask(row.agentId, row.id, row.nextRunAt)) {
        summary.expired += 1;
        auditCatchUp(row, 'recurrence ended during downtime');
      } else summary.skipped += 1;
      return;
    }
    if (await advanceOverdueTask(row.agentId, row.id, row.nextRunAt, next)) {
      const armed = await upsertSchedule({
        taskId: row.id,
        agentId: row.agentId,
        nextRunAtUnixSec: next,
      });
      if (armed) {
        summary.caughtUp += 1;
        logger.info(
          { taskId: row.id, overdueBy, next },
          'wake catch-up: recurring row advanced past downtime gap',
        );
      } else summary.skipped += 1;
    } else summary.skipped += 1;
    return;
  }
  // One-shot rows.
  if (overdueBy <= SQS_RETENTION_SEC) {
    // The fire already sits in the scheduled-fire queue; the drain
    // will deliver it late. Touching the row here would double-fire.
    summary.deferredToQueue += 1;
    return;
  }
  if (overdueBy <= LATE_ONESHOT_MAX_AGE_SEC) {
    const next = nowSec + 60;
    if (await advanceOverdueTask(row.agentId, row.id, row.nextRunAt, next)) {
      const armed = await upsertSchedule({
        taskId: row.id,
        agentId: row.agentId,
        nextRunAtUnixSec: next,
      });
      if (armed) {
        summary.lateRearmed += 1;
        logger.warn(
          { taskId: row.id, overdueBy },
          'wake catch-up: one-shot past SQS retention re-armed to fire late',
        );
      } else summary.skipped += 1;
    } else summary.skipped += 1;
    return;
  }
  if (await expireOverdueTask(row.agentId, row.id, row.nextRunAt)) {
    summary.expired += 1;
    logger.warn(
      { taskId: row.id, overdueBy },
      'wake catch-up: one-shot expired (overdue beyond late-fire horizon)',
    );
    auditCatchUp(row, 'one-shot expired during downtime');
  } else summary.skipped += 1;
}

function auditCatchUp(row: ActiveRow, note: string): void {
  void writeAudit({
    action: 'tool_invoke',
    agentId: row.agentId,
    surface: 'system',
    toolName: 'scheduled_task',
    detail: { taskId: row.id, source: 'wake-catchup', note },
    result: 'error',
  });
}
