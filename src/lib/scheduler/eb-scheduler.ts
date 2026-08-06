/**
 * EventBridge Scheduler client wrapper (A1).
 *
 * One scheduler entry per scheduled_tasks row. The target is the
 * scheduled-fire SQS queue and the input is the task identity, so
 * the orchestrator only needs SQS + DDB to fire a due task.
 *
 * Per-task schedule names are deterministic so update/cancel work
 * without storing the schedule arn in DDB. Format:
 *     claudeclaw[-suffix]-<taskId>
 *
 * The whole module no-ops when CCE_USE_IN_PROCESS_SCHEDULER=1 or
 * when SCHEDULED_FIRE_QUEUE_ARN / SCHEDULER_ROLE_ARN are unset (T0/T1
 * deploys that skip the queue). Every method swallows failures with
 * a logged warning so a missing IAM grant or a transient API error
 * cannot brick scheduled-task creation — the DDB row is still
 * written, and the in-process tick (if enabled) catches up.
 */

import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ListSchedulesCommand,
  FlexibleTimeWindowMode,
  ActionAfterCompletion,
  type CreateScheduleCommandInput,
  type UpdateScheduleCommandInput,
} from '@aws-sdk/client-scheduler';
import { logger } from '../../observability/logger.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';

let client: SchedulerClient | null = null;

function sdk(): SchedulerClient {
  if (!client) client = new SchedulerClient({ region: REGION });
  return client;
}

/** Test seam: replace the SDK client with a mock. */
export function __setSchedulerClient(c: SchedulerClient | null): void {
  client = c;
}

/**
 * True iff EB Scheduler is the active scheduling backend in this
 * deploy. Both the queue drain and the schedule-tools call site honor
 * this — flipping the env var rolls back to the in-process tick.
 */
export function isEbSchedulerEnabled(): boolean {
  if (process.env.CCE_USE_IN_PROCESS_SCHEDULER === '1') return false;
  if (!process.env.SCHEDULED_FIRE_QUEUE_ARN) return false;
  if (!process.env.SCHEDULER_ROLE_ARN) return false;
  return true;
}

export function scheduleGroupName(): string {
  return process.env.SCHEDULER_GROUP_NAME ?? 'default';
}

/**
 * Deterministic schedule name. Schedules live under a group so the
 * IAM policy can scope by group; the per-row name is the task id.
 *
 * AWS EB Scheduler name constraint: ^[0-9a-zA-Z-_.]+$, max 64 chars.
 * UUIDs satisfy this; we prefix with `task-` for searchability.
 */
export function scheduleName(taskId: string): string {
  return `task-${taskId}`;
}

/** Build the AWS scheduler `at(...)` expression from a unix-seconds value. */
export function atExpression(nextRunAtUnixSec: number): string {
  // EB Scheduler expects ISO without timezone suffix in `at(...)`.
  // Example: at(2026-05-20T15:00:00)
  const iso = new Date(nextRunAtUnixSec * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, '');
  return `at(${iso})`;
}

export interface ScheduleTaskRef {
  taskId: string;
  agentId: string;
  /** Unix seconds the schedule should fire at. */
  nextRunAtUnixSec: number;
}

function commonInput(ref: ScheduleTaskRef): Omit<CreateScheduleCommandInput, 'Name'> {
  const queueArn = process.env.SCHEDULED_FIRE_QUEUE_ARN!;
  const roleArn = process.env.SCHEDULER_ROLE_ARN!;
  return {
    GroupName: scheduleGroupName(),
    ScheduleExpression: atExpression(ref.nextRunAtUnixSec),
    // UTC keeps things unambiguous; the input is already absolute.
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
    // One-shot semantics: each row gets a fresh schedule when its
    // nextRunAt changes (recurring) and the schedule auto-deletes
    // after firing so we don't accumulate completed entries.
    ActionAfterCompletion: ActionAfterCompletion.DELETE,
    Target: {
      Arn: queueArn,
      RoleArn: roleArn,
      Input: JSON.stringify({
        taskId: ref.taskId,
        agentId: ref.agentId,
      }),
    },
    Description: `scheduled_task ${ref.taskId} for agent ${ref.agentId}`,
  };
}

/** Idempotent create-or-update. Returns true if EB was contacted. */
export async function upsertSchedule(ref: ScheduleTaskRef): Promise<boolean> {
  if (!isEbSchedulerEnabled()) return false;
  const Name = scheduleName(ref.taskId);
  try {
    // GetSchedule returns 404 (ResourceNotFoundException) when missing.
    // We try update first, fall back to create.
    await sdk().send(
      new GetScheduleCommand({ Name, GroupName: scheduleGroupName() }),
    );
    const update: UpdateScheduleCommandInput = { Name, ...commonInput(ref) };
    await sdk().send(new UpdateScheduleCommand(update));
    return true;
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name ?? '';
    if (name === 'ResourceNotFoundException') {
      try {
        await sdk().send(new CreateScheduleCommand({ Name, ...commonInput(ref) }));
        return true;
      } catch (createErr) {
        logger.warn(
          {
            taskId: ref.taskId,
            errMessage: createErr instanceof Error ? createErr.message : String(createErr),
          },
          'eb-scheduler create failed; in-process tick will still cover',
        );
        return false;
      }
    }
    logger.warn(
      {
        taskId: ref.taskId,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      'eb-scheduler update failed; in-process tick will still cover',
    );
    return false;
  }
}

export async function deleteSchedule(taskId: string): Promise<boolean> {
  if (!isEbSchedulerEnabled()) return false;
  try {
    await sdk().send(
      new DeleteScheduleCommand({
        Name: scheduleName(taskId),
        GroupName: scheduleGroupName(),
      }),
    );
    return true;
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name ?? '';
    if (name === 'ResourceNotFoundException') return true; // already gone
    logger.warn(
      {
        taskId,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      'eb-scheduler delete failed',
    );
    return false;
  }
}

/**
 * List task IDs (not full schedule entries) currently present in the
 * group. Used by the backfill on first boot to detect schedules that
 * exist already, so we don't try to recreate them.
 */
export async function listExistingTaskIds(): Promise<Set<string>> {
  if (!isEbSchedulerEnabled()) return new Set();
  const out = new Set<string>();
  let token: string | undefined;
  try {
    do {
      const resp = await sdk().send(
        new ListSchedulesCommand({
          GroupName: scheduleGroupName(),
          MaxResults: 100,
          NextToken: token,
        }),
      );
      for (const s of resp.Schedules ?? []) {
        const n = s.Name ?? '';
        if (n.startsWith('task-')) out.add(n.slice('task-'.length));
      }
      token = resp.NextToken;
    } while (token);
  } catch (err) {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'eb-scheduler list failed; backfill will not run this boot',
    );
  }
  return out;
}
