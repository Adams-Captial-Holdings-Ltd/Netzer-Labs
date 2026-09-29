/**
 * Queue drain for EventBridge Scheduler fires (A1).
 *
 * EB Scheduler writes one JSON message into the scheduled-fire SQS
 * queue per due task. We poll with long-poll (20s), claim the task
 * via the same conditional-write pattern as the in-process tick, fire
 * it, and delete the message.
 *
 * SQS guarantees at-least-once delivery. Double-fire is prevented by
 * the conditional STATUS#active → STATUS#in_flight transition in
 * scheduled-tasks-repo. If the worker dies mid-fire, visibility times
 * out and another worker (or the in-process tick if enabled) sees the
 * STATUS#in_flight row and lets it idle until manual recovery — the
 * row will be picked up again only after a markFired() advances it,
 * which is fine because tasks are idempotent at the user level
 * (reminders that fire twice are a UX nuisance, not a data hazard).
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageBatchCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { logger } from '../../observability/logger.js';
import {
  listScheduledTasksForAgent,
  markFired,
  type ScheduledTask,
} from '../state/scheduled-tasks-repo.js';
import { ddb } from '../state/ddb.js';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { runAgentTurn } from '../../agent/agent-loop.js';
import { appendTurns, getSession } from '../state/sessions-repo.js';
import { deliverScheduledReply } from './delivery.js';
import { writeAudit } from '../audit/audit-writer.js';
import { upsertSchedule, deleteSchedule, isEbSchedulerEnabled } from './eb-scheduler.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const TABLE = process.env.TABLE_SCHEDULED_TASKS ?? 'claudeclaw-scheduled-tasks';

let client: SQSClient | null = null;
function sqs(): SQSClient {
  if (!client) client = new SQSClient({ region: REGION });
  return client;
}

/** Test seam. */
export function __setSqsClient(c: SQSClient | null): void {
  client = c;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let stopped = false;

interface FirePayload {
  taskId: string;
  agentId: string;
}

function parsePayload(body: string | undefined): FirePayload | null {
  if (!body) return null;
  try {
    const j = JSON.parse(body) as FirePayload;
    if (typeof j.taskId !== 'string' || typeof j.agentId !== 'string') return null;
    return j;
  } catch {
    return null;
  }
}

async function findTask(
  agentId: string,
  taskId: string,
): Promise<ScheduledTask | undefined> {
  // listScheduledTasksForAgent uses Query so this is one DDB call.
  // We pull a generous limit because filtering happens client-side
  // (the GSI we'd need to query by id directly doesn't exist).
  const rows = await listScheduledTasksForAgent(agentId, 200);
  return rows.find((t) => t.id === taskId);
}

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
      'queue-drain claim failed',
    );
    return false;
  }
}

async function fireTask(task: ScheduledTask): Promise<void> {
  logger.info(
    {
      taskId: task.id,
      agentId: task.agentId,
      chatId: task.chatId,
      recurring: task.intervalSec !== undefined,
      source: 'queue-drain',
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
  // A TURN REFUSED BEFORE ANY MODEL WORK MUST NOT CONSUME THE FIRE.
  //
  // Same defect Phase 6 closed on the dispatch path, same cause: `runAgentTurn`
  // has three gates that refuse by RETURNING a canned notice rather than
  // throwing (the emergency kill phrase, the `sessions_frozen` maintenance
  // switch, the turn-level rate limit). Because they return, this function used
  // to finish normally — the notice was appended to the session as words the
  // agent never said, delivered to the user as the answer to their reminder,
  // audited `result: 'ok'`, then `markFired` advanced the schedule and
  // `handleMessage` returned true so the SQS message was DELETED. A one-minute
  // maintenance freeze permanently consumed the user's scheduled work, and
  // every surface reported success.
  //
  // Detection is the typed `refusal` marker and nothing else — the refusal
  // texts are prose that may be reworded, and their zero cost/zero token
  // metrics are also what a cheap or cached real answer looks like.
  //
  // A retryable refusal did NO work, so it is neither an answer nor a failed
  // attempt: THROW, and let the `catch` in `handleMessage` do exactly what it
  // already does for a transient failure — put GSI1PK back to STATUS#active so
  // the row is claimable again, and return false so the message is left for the
  // visibility timeout to redeliver. That catch IS this path's equivalent of
  // the dispatch worker's `releaseWork`; reusing it is why this fix is three
  // lines and not a second release path.
  //
  // Only two of the three can reach here, and the third is unreachable rather
  // than unhandled: this turn declares no `origin`, so it is `origin: 'machine'`
  // and the kill-phrase gate (`'human_chat'` only) never runs. `sessions_frozen`
  // and `rate_limited` are both retryable. A non-retryable refusal is therefore
  // not produced today; if a future kind is, it falls through as terminal and is
  // delivered to the user like a blocked turn, because a user told nothing
  // cannot tell a refused reminder from a lost one.
  if (result.refusal?.retryable) {
    throw new Error(
      `scheduled turn refused before any model work (${result.refusal.kind})`,
    );
  }
  // Guardrail-blocked turns are skipped: a persisted block notice poisons the
  // session and re-trips the guardrail on later turns. A refusal notice is not
  // the agent speaking either — `AgentTurnResponse` says a caller writing
  // session history has to check BOTH, because neither flag implies the other.
  if (!result.blocked && result.refusal === undefined) {
    const now = Math.floor(Date.now() / 1000);
    // P7 (M1): no request id here, so a chat deleted mid-turn is not re-checked.
    await appendTurns(task.agentId, task.chatId, [
      { role: 'user', text: `[scheduled] ${task.promptText}`, ts: now },
      { role: 'assistant', text: result.text, ts: now },
    ]);
  }
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
    detail: { taskId: task.id, costUsd: result.costUsd, source: 'queue-drain' },
    result: 'ok',
  });
}

/**
 * Handle one SQS message. Returns true if the message should be
 * deleted from the queue (consumed), false to let visibility timeout
 * recycle it for retry.
 *
 * "Stale fire" (taskId no longer exists, status cancelled / done) is
 * a SUCCESS — delete the message. The schedule fired after the user
 * cancelled, or after the row was cleaned up. Nothing to do.
 */
export async function handleMessage(msg: Message): Promise<boolean> {
  const payload = parsePayload(msg.Body);
  if (!payload) {
    logger.warn({ messageId: msg.MessageId }, 'queue-drain bad payload, dropping');
    return true;
  }
  const task = await findTask(payload.agentId, payload.taskId);
  if (!task) {
    logger.info(
      { taskId: payload.taskId, agentId: payload.agentId },
      'queue-drain task not found, stale fire',
    );
    return true;
  }
  if (task.status !== 'active') {
    logger.info(
      { taskId: task.id, status: task.status },
      'queue-drain task not active, stale fire',
    );
    return true;
  }
  // Stale-fire fence: a live fire arrives with the row's nextRunAt at (or just
  // past) now. If the row's nextRunAt sits well in the FUTURE, the row was
  // re-armed after this message was enqueued — by the wake catch-up after a
  // pause, or by a user edit — and this message is a leftover from the old
  // schedule. Firing it would replay a slot the row has already moved past.
  const nowSec = Math.floor(Date.now() / 1000);
  if (task.nextRunAt > nowSec + 120) {
    logger.info(
      { taskId: task.id, nextRunAt: task.nextRunAt },
      'queue-drain dropping stale fire (row re-armed to a future slot)',
    );
    return true;
  }
  if (!(await claim(task))) {
    // Another worker (or the in-process tick) won the claim. Delete
    // the SQS message — only one fire should happen, and somebody is
    // doing it.
    return true;
  }
  try {
    await fireTask(task);
    await markFired(task, new Date());
    // After markFired, recurring tasks now have a fresh nextRunAt.
    // Replay it into EB Scheduler so the next fire is scheduled.
    if (task.intervalSec !== undefined) {
      const refreshed = await findTask(task.agentId, task.id);
      if (refreshed && refreshed.status === 'active') {
        await upsertSchedule({
          taskId: refreshed.id,
          agentId: refreshed.agentId,
          nextRunAtUnixSec: refreshed.nextRunAt,
        });
      } else {
        // markFired transitioned to done (endAt past) — clean up.
        await deleteSchedule(task.id);
      }
    }
    // One-shot tasks: ActionAfterCompletion=DELETE on the schedule
    // means EB already removed it for us. Nothing to do.
    return true;
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.warn(
      { taskId: task.id, errMessage },
      'queue-drain fire failed; releasing for retry',
    );
    await ddb()
      .send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `AGENT#${task.agentId}`, SK: `TASK#${task.id}` },
          UpdateExpression: 'SET GSI1PK = :a',
          ExpressionAttributeValues: { ':a': 'STATUS#active' },
        }),
      )
      .catch(() => {});
    void writeAudit({
      action: 'tool_invoke',
      agentId: task.agentId,
      chatId: task.chatId,
      surface: 'system',
      toolName: 'scheduled_task',
      detail: { taskId: task.id, errMessage, source: 'queue-drain' },
      result: 'error',
    });
    return false;
  }
}

async function pollOnce(): Promise<void> {
  const url = process.env.SCHEDULED_FIRE_QUEUE_URL;
  if (!url) return;
  let messages: Message[] = [];
  try {
    const resp = await sqs().send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
        VisibilityTimeout: 60,
      }),
    );
    messages = resp.Messages ?? [];
  } catch (err) {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'queue-drain receive failed',
    );
    return;
  }
  if (messages.length === 0) return;
  logger.info({ count: messages.length }, 'queue-drain received messages');
  const toDelete: Array<{ Id: string; ReceiptHandle: string }> = [];
  for (const msg of messages) {
    const consumed = await handleMessage(msg).catch((err) => {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err) },
        'queue-drain handler threw',
      );
      return false;
    });
    if (consumed && msg.MessageId && msg.ReceiptHandle) {
      toDelete.push({ Id: msg.MessageId, ReceiptHandle: msg.ReceiptHandle });
    }
  }
  if (toDelete.length > 0) {
    try {
      await sqs().send(
        new DeleteMessageBatchCommand({ QueueUrl: url, Entries: toDelete }),
      );
    } catch (err) {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err) },
        'queue-drain delete-batch failed',
      );
    }
  }
}

/**
 * Background loop. Long-polling against SQS so we don't burn the CPU
 * on empty intervals.
 */
export function startQueueDrain(): void {
  if (!isEbSchedulerEnabled()) {
    logger.info(
      {},
      'queue-drain skipped: in-process scheduler mode or missing queue config',
    );
    return;
  }
  if (timer) return;
  stopped = false;
  logger.info(
    { queueUrl: process.env.SCHEDULED_FIRE_QUEUE_URL },
    'queue-drain starting',
  );
  const loop = async (): Promise<void> => {
    if (stopped) return;
    if (!running) {
      running = true;
      try {
        await pollOnce();
      } finally {
        running = false;
      }
    }
    // No setInterval — ReceiveMessage already long-polls for 20s.
    // Just chain another poll immediately on completion.
    if (!stopped) {
      timer = setTimeout(() => void loop(), 0);
    }
  };
  // Stagger first poll so two tasks don't both connect at the same
  // second when both replicas just booted.
  timer = setTimeout(() => void loop(), Math.floor(Math.random() * 5000));
}

export function stopQueueDrain(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
