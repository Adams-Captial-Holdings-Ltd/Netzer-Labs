/**
 * Scheduled tasks repo — single-shot reminders and recurring jobs.
 *
 * Schema:
 *   PK = AGENT#<agentId>
 *   SK = TASK#<taskId>
 *   GSI1PK = STATUS#<active|done|cancelled>
 *   GSI1SK = NEXTRUN#<unix-seconds-padded>#<taskId>
 *
 * The scheduler loop in `scheduler.ts` polls `GSI1PK = STATUS#active`
 * with `GSI1SK <= NEXTRUN#<now>` to pull every task due to fire. After
 * firing, recurring tasks have their `nextRunAt` advanced; one-shot
 * tasks transition to STATUS#done.
 */

import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { getSchedulerMinIntervalSec } from './rate-limits-repo.js';

const TABLE = process.env.TABLE_SCHEDULED_TASKS ?? 'claudeclaw-scheduled-tasks';

/** Hard floor on recurrence; the configured scheduler limit overrides upward. */
const MIN_INTERVAL_SEC_FALLBACK = 60;

export type ScheduledTaskStatus = 'active' | 'done' | 'cancelled';

export interface ScheduledTask {
  id: string;
  agentId: string;
  chatId: string;
  promptText: string;
  /** Unix seconds when this task should next fire. */
  nextRunAt: number;
  /** Recurrence in seconds (>=60). Undefined = one-shot. */
  intervalSec?: number;
  /** Optional UTC ISO string we stop firing after. */
  endAt?: string;
  status: ScheduledTaskStatus;
  createdAt: string;
  createdBy: 'user' | 'agent' | 'system';
  /** Last firing timestamp (ISO). */
  lastFiredAt?: string;
  /** Free-form description shown in dashboard. */
  description?: string;
  /**
   * Explicit delivery target. Without it, delivery falls back to chatId
   * prefix routing — which cannot deliver principal-scoped chatIds
   * (owner:* / user:*). See src/lib/scheduler/delivery.ts.
   */
  deliveryTarget?: { surface: 'telegram' | 'slack'; chatId: string };
  /** IANA timezone the schedule was authored in (display + local-time math). */
  timezone?: string;
  /** Jarvis routine this task was created from (prompt is snapshotted). */
  sourceRoutineId?: string;
  /** Dashboard operator identity for audit/UI attribution. */
  createdByIdentity?: string;
}

function pad(n: number): string {
  return String(n).padStart(12, '0');
}

export async function createScheduledTask(args: {
  agentId: string;
  chatId: string;
  promptText: string;
  nextRunAt: number;
  intervalSec?: number;
  endAt?: string;
  createdBy?: 'user' | 'agent' | 'system';
  description?: string;
  deliveryTarget?: { surface: 'telegram' | 'slack'; chatId: string };
  timezone?: string;
  sourceRoutineId?: string;
  createdByIdentity?: string;
}): Promise<ScheduledTask> {
  if (args.intervalSec !== undefined) {
    // The minimum recurrence interval is configurable per-scheduler via the
    // rate-limits policy (POLICY#scheduler). Falls back to the historical
    // 60s floor, and fails open to it if the policy read errors.
    const minInterval = await getSchedulerMinIntervalSec(MIN_INTERVAL_SEC_FALLBACK);
    if (args.intervalSec < minInterval) {
      throw new Error(`intervalSec must be >= ${minInterval} (rate limiting)`);
    }
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const task: ScheduledTask = {
    id,
    agentId: args.agentId,
    chatId: args.chatId,
    promptText: args.promptText,
    nextRunAt: Math.floor(args.nextRunAt),
    ...(args.intervalSec !== undefined ? { intervalSec: args.intervalSec } : {}),
    ...(args.endAt ? { endAt: args.endAt } : {}),
    status: 'active',
    createdAt,
    createdBy: args.createdBy ?? 'agent',
    ...(args.description ? { description: args.description } : {}),
    ...(args.deliveryTarget ? { deliveryTarget: args.deliveryTarget } : {}),
    ...(args.timezone ? { timezone: args.timezone } : {}),
    ...(args.sourceRoutineId ? { sourceRoutineId: args.sourceRoutineId } : {}),
    ...(args.createdByIdentity ? { createdByIdentity: args.createdByIdentity } : {}),
  };
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `AGENT#${args.agentId}`,
        SK: `TASK#${id}`,
        GSI1PK: 'STATUS#active',
        GSI1SK: `NEXTRUN#${pad(task.nextRunAt)}#${id}`,
        ...task,
      },
    }),
  );
  return task;
}

export async function listScheduledTasksForAgent(
  agentId: string,
  limit = 50,
): Promise<ScheduledTask[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `AGENT#${agentId}` },
      Limit: limit,
    }),
  );
  return (out.Items ?? []).map((i) => toTask(i as Record<string, unknown>));
}

export async function listDueTasks(
  nowUnix: number,
  limit = 25,
): Promise<ScheduledTask[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1-active-nextrun',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK <= :sk',
      ExpressionAttributeValues: {
        ':pk': 'STATUS#active',
        ':sk': `NEXTRUN#${pad(nowUnix)}#zzzzzzzz`,
      },
      Limit: limit,
    }),
  );
  return (out.Items ?? []).map((i) => toTask(i as Record<string, unknown>));
}

export async function markFired(
  task: ScheduledTask,
  firedAt: Date,
): Promise<void> {
  if (task.intervalSec !== undefined) {
    const nextRun = Math.floor(firedAt.getTime() / 1000) + task.intervalSec;
    const endStop =
      task.endAt && new Date(task.endAt).getTime() / 1000 <= nextRun;
    if (endStop) {
      await transition(task, 'done');
      return;
    }
    try {
      await ddb().send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `AGENT#${task.agentId}`, SK: `TASK#${task.id}` },
          UpdateExpression:
            'SET nextRunAt = :n, lastFiredAt = :l, GSI1SK = :sk, GSI1PK = :pk',
          // Fence on the slot this fire was claimed for (parity with
          // advanceOverdueTask/expireOverdueTask): a concurrent dashboard
          // edit or wake catch-up that already moved nextRunAt must not be
          // clobbered by this late advance.
          ConditionExpression: 'nextRunAt = :from',
          ExpressionAttributeValues: {
            ':n': nextRun,
            ':l': firedAt.toISOString(),
            ':sk': `NEXTRUN#${pad(nextRun)}#${task.id}`,
            ':pk': 'STATUS#active',
            ':from': task.nextRunAt,
          },
        }),
      );
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      // Someone else already moved the schedule; their write wins.
      if (name !== 'ConditionalCheckFailedException') throw err;
    }
    return;
  }
  await transition(task, 'done', firedAt.toISOString());
}

export async function cancelScheduledTask(
  agentId: string,
  taskId: string,
): Promise<boolean> {
  const tasks = await listScheduledTasksForAgent(agentId, 200);
  const target = tasks.find((t) => t.id === taskId || t.id.startsWith(taskId));
  if (!target) return false;
  await transition(target, 'cancelled');
  return true;
}

export async function deleteScheduledTask(
  agentId: string,
  taskId: string,
): Promise<void> {
  await ddb().send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: `AGENT#${agentId}`, SK: `TASK#${taskId}` },
    }),
  );
}

async function transition(
  task: ScheduledTask,
  status: ScheduledTaskStatus,
  lastFiredAt?: string,
): Promise<void> {
  // `status` is reserved in DDB UpdateExpressions — alias via #s.
  const updates: string[] = ['GSI1PK = :pk', '#s = :s'];
  const vals: Record<string, unknown> = {
    ':pk': `STATUS#${status}`,
    ':s': status,
  };
  if (lastFiredAt) {
    updates.push('lastFiredAt = :l');
    vals[':l'] = lastFiredAt;
  }
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `AGENT#${task.agentId}`, SK: `TASK#${task.id}` },
      UpdateExpression: `SET ${updates.join(', ')}`,
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: vals,
    }),
  );
}

function toTask(i: Record<string, unknown>): ScheduledTask {
  return {
    id: String(i.id ?? ''),
    agentId: String(i.agentId ?? ''),
    chatId: String(i.chatId ?? ''),
    promptText: String(i.promptText ?? ''),
    nextRunAt: Number(i.nextRunAt ?? 0),
    ...(i.intervalSec !== undefined
      ? { intervalSec: Number(i.intervalSec) }
      : {}),
    ...(i.endAt ? { endAt: String(i.endAt) } : {}),
    status: (i.status as ScheduledTaskStatus | undefined) ?? 'active',
    createdAt: String(i.createdAt ?? ''),
    createdBy: (i.createdBy as 'user' | 'agent' | 'system' | undefined) ?? 'agent',
    ...(i.lastFiredAt ? { lastFiredAt: String(i.lastFiredAt) } : {}),
    ...(i.description ? { description: String(i.description) } : {}),
    ...(i.deliveryTarget
      ? { deliveryTarget: i.deliveryTarget as ScheduledTask['deliveryTarget'] }
      : {}),
    ...(i.timezone ? { timezone: String(i.timezone) } : {}),
    ...(i.sourceRoutineId ? { sourceRoutineId: String(i.sourceRoutineId) } : {}),
    ...(i.createdByIdentity ? { createdByIdentity: String(i.createdByIdentity) } : {}),
  };
}

/**
 * Advance an overdue ACTIVE row to a new fire time, fenced on the old value.
 * Used by the boot catch-up after downtime (pause/wake): the condition on the
 * PRIOR nextRunAt makes the write idempotent across N tasks booting at once
 * and yields to a concurrent queue-drain fire that already advanced the row.
 * Returns false when the fence lost (someone else moved the row) — not an error.
 */
export async function advanceOverdueTask(
  agentId: string,
  taskId: string,
  fromNextRunAt: number,
  toNextRunAt: number,
): Promise<boolean> {
  const next = Math.floor(toNextRunAt);
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `AGENT#${agentId}`, SK: `TASK#${taskId}` },
        UpdateExpression: 'SET nextRunAt = :n, GSI1SK = :sk',
        ConditionExpression: '#s = :active AND nextRunAt = :from',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':n': next,
          ':sk': `NEXTRUN#${pad(next)}#${taskId}`,
          ':active': 'active',
          ':from': Math.floor(fromNextRunAt),
        },
      }),
    );
    return true;
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name ?? '';
    if (name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Retire an overdue ACTIVE row that can no longer fire (its one-shot moment
 * passed beyond the late-fire horizon, or recurrence ran past endAt during
 * downtime). Same fencing rules as advanceOverdueTask.
 */
export async function expireOverdueTask(
  agentId: string,
  taskId: string,
  fromNextRunAt: number,
): Promise<boolean> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `AGENT#${agentId}`, SK: `TASK#${taskId}` },
        UpdateExpression: 'SET GSI1PK = :done, #s = :doneStatus',
        ConditionExpression: '#s = :active AND nextRunAt = :from',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':done': 'STATUS#done',
          ':doneStatus': 'done',
          ':active': 'active',
          ':from': Math.floor(fromNextRunAt),
        },
      }),
    );
    return true;
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name ?? '';
    if (name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Edit an ACTIVE task (conditional — done/cancelled tasks are immutable).
 * Keeps GSI1SK in sync when nextRunAt changes; callers that use EventBridge
 * Scheduler must upsertSchedule() afterwards or EB fires on the stale time.
 * Pass null to clear intervalSec/endAt/deliveryTarget. Returns the updated
 * task, or null when the task is missing or not active.
 */
export async function updateScheduledTask(
  agentId: string,
  taskId: string,
  patch: {
    promptText?: string;
    nextRunAt?: number;
    intervalSec?: number | null;
    endAt?: string | null;
    description?: string;
    deliveryTarget?: { surface: 'telegram' | 'slack'; chatId: string } | null;
    timezone?: string;
  },
): Promise<ScheduledTask | null> {
  if (patch.intervalSec != null) {
    const minInterval = await getSchedulerMinIntervalSec(MIN_INTERVAL_SEC_FALLBACK);
    if (patch.intervalSec < minInterval) {
      throw new Error(`intervalSec must be >= ${minInterval} (rate limiting)`);
    }
  }
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = { '#s': 'status' };
  const vals: Record<string, unknown> = { ':active': 'active' };
  const setField = (field: string, value: unknown): void => {
    names[`#${field}`] = field;
    sets.push(`#${field} = :${field}`);
    vals[`:${field}`] = value;
  };
  if (patch.promptText !== undefined) setField('promptText', patch.promptText);
  if (patch.description !== undefined) setField('description', patch.description);
  if (patch.timezone !== undefined) setField('timezone', patch.timezone);
  if (patch.nextRunAt !== undefined) {
    setField('nextRunAt', Math.floor(patch.nextRunAt));
    setField('GSI1SK', `NEXTRUN#${pad(Math.floor(patch.nextRunAt))}#${taskId}`);
  }
  if (patch.intervalSec !== undefined) {
    if (patch.intervalSec === null) {
      names['#intervalSec'] = 'intervalSec';
      removes.push('#intervalSec');
    } else setField('intervalSec', patch.intervalSec);
  }
  if (patch.endAt !== undefined) {
    if (patch.endAt === null) {
      names['#endAt'] = 'endAt';
      removes.push('#endAt');
    } else setField('endAt', patch.endAt);
  }
  if (patch.deliveryTarget !== undefined) {
    if (patch.deliveryTarget === null) {
      names['#deliveryTarget'] = 'deliveryTarget';
      removes.push('#deliveryTarget');
    } else setField('deliveryTarget', patch.deliveryTarget);
  }
  if (sets.length === 0 && removes.length === 0) {
    const existing = await listScheduledTasksForAgent(agentId, 200);
    return existing.find((t) => t.id === taskId && t.status === 'active') ?? null;
  }
  const expr =
    (sets.length > 0 ? `SET ${sets.join(', ')}` : '') +
    (removes.length > 0 ? ` REMOVE ${removes.join(', ')}` : '');
  try {
    const out = await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `AGENT#${agentId}`, SK: `TASK#${taskId}` },
        UpdateExpression: expr.trim(),
        ConditionExpression: '#s = :active',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: vals,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return out.Attributes ? toTask(out.Attributes as Record<string, unknown>) : null;
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name ?? '';
    if (name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}
