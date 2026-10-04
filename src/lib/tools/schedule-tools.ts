/**
 * Schedule tools — let the model set reminders and recurring jobs.
 *
 * schedule_task creates one row in `scheduled_tasks`. The in-process
 * scheduler ticker (src/agent/scheduler.ts) picks it up at `nextRunAt`
 * and runs `runAgentTurn` with the saved prompt under the same agent
 * and chat as the original turn.
 *
 * Time inputs accept either an ISO timestamp or a relative duration
 * like `+30m`, `+2h`, `+1d`. Relative parsing is intentional because
 * the model has shown a tendency to confuse the user's local time
 * with UTC otherwise.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { tools } from './registry.js';
import {
  cancelScheduledTask,
  createScheduledTask,
  listScheduledTasksForAgent,
} from '../state/scheduled-tasks-repo.js';
import { upsertSchedule, deleteSchedule } from '../scheduler/eb-scheduler.js';
import { nextOccurrenceUtc } from '../scheduler/local-time.js';

function spec(name: string, description: string, schema: unknown): BedrockTool {
  return {
    toolSpec: {
      name,
      description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: { json: schema as any },
    },
  };
}

const REL_DURATION = /^\+(\d+)([smhd])$/i;

export function parseWhen(when: string, now = new Date()): number {
  const rel = REL_DURATION.exec(when);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const multiplier =
      unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
    return Math.floor(now.getTime() / 1000) + amount * multiplier;
  }
  const t = Date.parse(when);
  if (!Number.isFinite(t)) {
    throw new Error(
      `Couldn't parse 'when' value: ${when}. Use ISO 8601 ("2026-05-20T15:00:00Z") or a relative like "+30m", "+2h", "+1d".`,
    );
  }
  return Math.floor(t / 1000);
}

const HUMAN_INTERVALS: Record<string, number> = {
  hourly: 3600,
  daily: 86400,
  weekly: 7 * 86400,
};

export function parseInterval(input: unknown): number | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 60) {
      throw new Error('interval seconds must be >= 60');
    }
    return Math.floor(input);
  }
  const s = String(input).trim().toLowerCase();
  if (HUMAN_INTERVALS[s] !== undefined) return HUMAN_INTERVALS[s];
  const m = /^every\s+(\d+)\s*(s|m|h|d)$/.exec(s);
  if (m) {
    const amount = Number(m[1]);
    const unit = m[2];
    const mult = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
    const seconds = amount * mult;
    if (seconds < 60) throw new Error('interval seconds must be >= 60');
    return seconds;
  }
  throw new Error(
    `Couldn't parse 'recur_every': ${input}. Try "hourly", "daily", "every 30m", "every 2h", or a number of seconds.`,
  );
}

tools.register('schedule_task', {
  spec: spec(
    'schedule_task',
    'Create a one-shot reminder or recurring scheduled task. The bot will run the saved prompt at the chosen time as if the user had just typed it, and reply on the same surface (Telegram/Slack). Use this when the user says "remind me at 3pm", "every Monday morning send X", or "in 30 minutes ask Y".',
    {
      type: 'object',
      required: ['prompt_text'],
      properties: {
        when: {
          type: 'string',
          description:
            'First (or only) firing time as an ISO 8601 timestamp ("2026-05-20T15:00:00Z") or a relative duration ("+30m", "+2h", "+1d"). For wall-clock times ("every morning at 8") use at_local_time + timezone instead — do NOT convert to UTC yourself.',
        },
        at_local_time: {
          type: 'string',
          description:
            'Wall-clock first-fire time "HH:mm" (24h) in the user\'s timezone. Preferred whenever the user names a clock time ("at 8am", "every morning at 8"). Requires timezone. The backend converts to UTC, including DST.',
        },
        timezone: {
          type: 'string',
          description:
            'IANA timezone for at_local_time (e.g. "America/Toronto"). Check long-term memory for the user\'s timezone, or ask if unknown.',
        },
        prompt_text: {
          type: 'string',
          description:
            'Exact prompt that will be replayed when the task fires. Be self-contained; the model will not have access to this conversation\'s short-term context, only the user\'s long-term memories.',
        },
        recur_every: {
          type: 'string',
          description:
            'Optional recurrence. Accepts "hourly", "daily", "weekly", a phrase like "every 30m" / "every 2h", or a raw number of seconds (>=60). Omit for one-shot.',
        },
        end_at: {
          type: 'string',
          description:
            'Optional UTC ISO timestamp to stop recurring. Ignored for one-shot tasks.',
        },
        description: {
          type: 'string',
          description: 'Optional short label so the user can find this in /api/scheduled.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const when = String(args.when ?? '').trim();
    const atLocalTime = String(args.at_local_time ?? '').trim();
    const timezone = String(args.timezone ?? '').trim();
    const promptText = String(args.prompt_text ?? '').trim();
    if (!when && !atLocalTime) {
      return { text: 'when or at_local_time is required', isError: true };
    }
    if (!promptText) return { text: 'prompt_text is required', isError: true };
    let nextRunAt: number;
    try {
      if (atLocalTime) {
        // Wall-clock path: the backend owns the timezone math (the model
        // converting to UTC itself was the recurring failure mode).
        if (!timezone) {
          return { text: 'timezone (IANA, e.g. America/Toronto) is required with at_local_time', isError: true };
        }
        nextRunAt = nextOccurrenceUtc(atLocalTime, timezone);
      } else {
        nextRunAt = parseWhen(when);
      }
    } catch (err) {
      return { text: (err as Error).message, isError: true };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (nextRunAt < nowSec - 5) {
      return { text: 'when is in the past', isError: true };
    }
    let intervalSec: number | undefined;
    try {
      intervalSec = parseInterval(args.recur_every);
    } catch (err) {
      return { text: (err as Error).message, isError: true };
    }
    // Stamp the surface-native reply id as the delivery target: ctx.chatId
    // may be a principal alias (owner:*) no chat API can deliver to. This is
    // what makes "brief me every morning at 8" from an aliased owner chat
    // actually arrive (see src/lib/scheduler/delivery.ts).
    //
    // STORED VERBATIM, IDENTITY SEGMENT AND ALL. On a surface with more than
    // one bot the id carries which one owns the chat (`:bot-<agentId>` on
    // Telegram, `:app-<agentId>` on Slack), so tomorrow's brief goes out over
    // the same bot the person asked for it in rather than over `ctx.agentId`,
    // which is the turn's agent and can be a sticky default. `send()` in
    // delivery.ts is the one consumer and it parses both shapes; an id without
    // a segment — a legacy row, or a target typed into the dashboard's form —
    // still falls back to the task's agent.
    const deliveryTarget =
      (ctx.surface === 'telegram' || ctx.surface === 'slack') && ctx.replyChatId
        ? { surface: ctx.surface, chatId: ctx.replyChatId }
        : undefined;
    const task = await createScheduledTask({
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      promptText,
      nextRunAt,
      ...(intervalSec !== undefined ? { intervalSec } : {}),
      ...(typeof args.end_at === 'string' && args.end_at ? { endAt: args.end_at } : {}),
      createdBy: 'agent',
      ...(typeof args.description === 'string' && args.description
        ? { description: args.description }
        : {}),
      ...(deliveryTarget ? { deliveryTarget } : {}),
      ...(timezone ? { timezone } : {}),
    });
    // A1: pair the DDB row with an EB Scheduler one-shot entry that
    // fires SQS at nextRunAt. No-op when EB Scheduler is disabled.
    await upsertSchedule({
      taskId: task.id,
      agentId: task.agentId,
      nextRunAtUnixSec: task.nextRunAt,
    });
    const whenIso = new Date(nextRunAt * 1000).toISOString();
    const recurDesc = intervalSec ? ` every ${intervalSec}s` : ' (one-shot)';
    return {
      text: `Scheduled task ${task.id.slice(0, 8)} for ${whenIso}${recurDesc}.`,
    };
  },
});

tools.register('list_scheduled_tasks', {
  readOnly: true,
  spec: spec(
    'list_scheduled_tasks',
    'Show scheduled tasks (active, done, and cancelled) for this agent so the user can review them. Use when the user asks "what reminders do I have", "show my scheduled tasks", or "what did you schedule for me".',
    {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum tasks to return. Defaults to 10.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const limit = Number.isFinite(args.limit) ? Number(args.limit) : 10;
    const rows = await listScheduledTasksForAgent(ctx.agentId, 200);
    const filtered = rows
      .filter((t) => t.chatId === ctx.chatId)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)
      .slice(0, limit);
    if (filtered.length === 0) {
      return { text: 'No scheduled tasks for this chat.' };
    }
    const lines = filtered.map((t) => {
      const when = new Date(t.nextRunAt * 1000).toISOString();
      const recur = t.intervalSec ? ` (every ${t.intervalSec}s)` : '';
      const desc = t.description ? ` ${t.description}` : '';
      return `- [${t.id.slice(0, 8)}] ${t.status} @ ${when}${recur}${desc}`;
    });
    return { text: `${filtered.length} scheduled tasks:\n${lines.join('\n')}` };
  },
});

tools.register('cancel_scheduled_task', {
  spec: spec(
    'cancel_scheduled_task',
    'Cancel a previously scheduled task. Use after the user asks to cancel or undo a reminder.',
    {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: {
          type: 'string',
          description: 'Full task id or 8-char prefix from list_scheduled_tasks.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const id = String(args.task_id ?? '').trim();
    if (!id) return { text: 'task_id is required', isError: true };
    // Resolve to the canonical id (cancelScheduledTask tolerates an
    // 8-char prefix; EB Scheduler does not).
    const all = await listScheduledTasksForAgent(ctx.agentId, 200);
    const match = all.find((t) => t.id === id || t.id.startsWith(id));
    const ok = await cancelScheduledTask(ctx.agentId, id);
    if (match) await deleteSchedule(match.id);
    return ok
      ? { text: `Cancelled task ${id}.` }
      : { text: `No scheduled task matches ${id}.`, isError: true };
  },
});
