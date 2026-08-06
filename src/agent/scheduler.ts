/**
 * In-process scheduler for scheduled_tasks.
 *
 * Every SCHEDULER_TICK_SEC seconds we query the GSI1 active+nextrun
 * index for tasks that are due, fire them through the agent loop with
 * `surface: 'system'`, then advance recurring tasks or close one-shots.
 *
 * Two ECS tasks run in parallel, so a naive tick would fire each task
 * twice. We guard by transitioning STATUS to a sentinel
 * `STATUS#in_flight` with a conditional write — only one task can win
 * the race. If the underlying agent turn throws, we bounce the task
 * back to active so it'll fire on the next tick.
 *
 * If the schedule_task surface needs to push a reply back to the user,
 * we send through the Telegram or Slack adapter based on the chatId
 * prefix. chatIds shaped like `slack:CXXXX` route to Slack;
 * `tg:<chatId>` (or anything else) routes to Telegram.
 */

import { logger } from '../observability/logger.js';
import {
  listDueTasks,
  markFired,
  type ScheduledTask,
} from '../lib/state/scheduled-tasks-repo.js';
import { ddb } from '../lib/state/ddb.js';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { runAgentTurn } from './agent-loop.js';
import { appendTurns, getSession } from '../lib/state/sessions-repo.js';
import { deliverScheduledReply } from '../lib/scheduler/delivery.js';
import { writeAudit } from '../lib/audit/audit-writer.js';

const TABLE = process.env.TABLE_SCHEDULED_TASKS ?? 'claudeclaw-scheduled-tasks';
const TICK_SEC = Math.max(
  10,
  Math.min(600, Number(process.env.CCE_SCHEDULER_TICK_SEC ?? '30')),
);
const FETCH_LIMIT = 25;

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startScheduler(): void {
  if (process.env.CCE_SCHEDULER_DISABLED === '1') {
    logger.info({}, 'scheduler disabled via CCE_SCHEDULER_DISABLED');
    return;
  }
  if (timer) return;
  logger.info({ tickSec: TICK_SEC }, 'scheduler started');
  // Stagger the first tick so two tasks don't race on boot.
  const initialDelayMs = Math.floor(Math.random() * TICK_SEC * 1000);
  timer = setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), TICK_SEC * 1000);
  }, initialDelayMs);
}

export function stopScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  if (running) return; // skip overlapping invocations
  running = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const due = await listDueTasks(now, FETCH_LIMIT).catch((err) => {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err) },
        'scheduler list-due failed',
      );
      return [] as ScheduledTask[];
    });
    // Heartbeat log every tick — picked up by the CloudWatch metric
    // filter `SchedulerTick` so the dashboard can show "is the scheduler
    // still running?" without us emitting a custom metric every poll.
    logger.info({ due: due.length }, 'scheduler tick');
    if (due.length === 0) return;
    logger.info({ count: due.length }, 'scheduler picked up due tasks');
    for (const task of due) {
      try {
        if (!(await claim(task))) continue;
        await fireTask(task);
        await markFired(task, new Date());
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        logger.warn(
          { taskId: task.id, errMessage },
          'scheduler task fire failed; releasing for retry',
        );
        await releaseClaim(task).catch(() => {});
        void writeAudit({
          action: 'tool_invoke',
          agentId: task.agentId,
          chatId: task.chatId,
          surface: 'system',
          toolName: 'scheduled_task',
          detail: { taskId: task.id, errMessage },
          result: 'error',
        });
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Conditional UPDATE that transitions a task from STATUS#active to
 * STATUS#in_flight. Only the first task to write succeeds; the other
 * task sees ConditionalCheckFailedException and skips.
 */
async function claim(task: ScheduledTask): Promise<boolean> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `AGENT#${task.agentId}`, SK: `TASK#${task.id}` },
        UpdateExpression: 'SET GSI1PK = :inflight',
        ConditionExpression: 'GSI1PK = :active',
        ExpressionAttributeValues: {
          ':inflight': 'STATUS#in_flight',
          ':active': 'STATUS#active',
        },
      }),
    );
    return true;
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name ?? '';
    if (name === 'ConditionalCheckFailedException') return false;
    logger.warn(
      {
        taskId: task.id,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      'scheduler claim failed',
    );
    return false;
  }
}

async function releaseClaim(task: ScheduledTask): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `AGENT#${task.agentId}`, SK: `TASK#${task.id}` },
      UpdateExpression: 'SET GSI1PK = :a',
      ExpressionAttributeValues: { ':a': 'STATUS#active' },
    }),
  );
}

async function fireTask(task: ScheduledTask): Promise<void> {
  logger.info(
    {
      taskId: task.id,
      agentId: task.agentId,
      chatId: task.chatId,
      recurring: task.intervalSec !== undefined,
    },
    'firing scheduled task',
  );

  const session = await getSession(task.agentId, task.chatId);
  const history = session?.turns ?? [];
  const result = await runAgentTurn({
    agentId: task.agentId,
    chatId: task.chatId,
    userText: task.promptText,
    history,
    surface: 'system',
  });

  // Persist as a scheduled-system turn pair so the next conversation
  // turn has context. Guardrail-blocked turns are skipped: a persisted block
  // notice poisons the session and re-trips the guardrail on later turns.
  if (!result.blocked) {
    const now = Math.floor(Date.now() / 1000);
    await appendTurns(task.agentId, task.chatId, [
      { role: 'user', text: `[scheduled] ${task.promptText}`, ts: now },
      { role: 'assistant', text: result.text, ts: now },
    ]);
  }

  // Notify the right surface.
  await deliverScheduledReply(task, result.text).catch((err) => {
    logger.warn(
      {
        taskId: task.id,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      'scheduled delivery failed',
    );
  });

  void writeAudit({
    action: 'tool_invoke',
    agentId: task.agentId,
    chatId: task.chatId,
    surface: 'system',
    toolName: 'scheduled_task',
    detail: { taskId: task.id, costUsd: result.costUsd },
    result: 'ok',
  });
}

