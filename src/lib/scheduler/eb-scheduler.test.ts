import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  atExpression,
  scheduleName,
  scheduleGroupName,
  isEbSchedulerEnabled,
  upsertSchedule,
  deleteSchedule,
  __setSchedulerClient,
} from './eb-scheduler.js';
import {
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  type SchedulerClient,
} from '@aws-sdk/client-scheduler';

interface SentCommand {
  name: string;
  input: unknown;
}

function makeMockClient(sequence: Array<unknown | Error>): {
  client: SchedulerClient;
  sent: SentCommand[];
} {
  const sent: SentCommand[] = [];
  let i = 0;
  const client = {
    send: async (cmd: object) => {
      sent.push({
        name: cmd.constructor.name,
        input: (cmd as { input: unknown }).input,
      });
      const next = sequence[i++];
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as SchedulerClient;
  return { client, sent };
}

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIG_ENV,
    SCHEDULED_FIRE_QUEUE_ARN: 'arn:aws:sqs:us-east-1:111:claudeclaw-scheduled-fire',
    SCHEDULER_ROLE_ARN: 'arn:aws:iam::111:role/claudeclaw-scheduler-exec',
    SCHEDULER_GROUP_NAME: 'claudeclaw',
    CCE_USE_IN_PROCESS_SCHEDULER: '0',
  };
  __setSchedulerClient(null);
});

afterEach(() => {
  process.env = ORIG_ENV;
  __setSchedulerClient(null);
});

describe('atExpression', () => {
  it('produces an EB Scheduler at(...) value without milliseconds', () => {
    const t = Math.floor(Date.UTC(2026, 4, 20, 15, 0, 0) / 1000);
    expect(atExpression(t)).toBe('at(2026-05-20T15:00:00)');
  });
});

describe('scheduleName', () => {
  it('prefixes the task id so list-by-prefix works', () => {
    expect(scheduleName('abc-123')).toBe('task-abc-123');
  });
});

describe('scheduleGroupName', () => {
  it('defaults to "default" when env unset', () => {
    delete process.env.SCHEDULER_GROUP_NAME;
    expect(scheduleGroupName()).toBe('default');
  });
  it('honors SCHEDULER_GROUP_NAME', () => {
    process.env.SCHEDULER_GROUP_NAME = 'claudeclaw-staging';
    expect(scheduleGroupName()).toBe('claudeclaw-staging');
  });
});

describe('isEbSchedulerEnabled', () => {
  it('returns false when CCE_USE_IN_PROCESS_SCHEDULER=1', () => {
    process.env.CCE_USE_IN_PROCESS_SCHEDULER = '1';
    expect(isEbSchedulerEnabled()).toBe(false);
  });
  it('returns false when SCHEDULED_FIRE_QUEUE_ARN missing', () => {
    delete process.env.SCHEDULED_FIRE_QUEUE_ARN;
    expect(isEbSchedulerEnabled()).toBe(false);
  });
  it('returns false when SCHEDULER_ROLE_ARN missing', () => {
    delete process.env.SCHEDULER_ROLE_ARN;
    expect(isEbSchedulerEnabled()).toBe(false);
  });
  it('returns true when both env vars present and in-process is off', () => {
    expect(isEbSchedulerEnabled()).toBe(true);
  });
});

describe('upsertSchedule', () => {
  it('calls UpdateSchedule when GetSchedule succeeds', async () => {
    const { client, sent } = makeMockClient([
      {}, // Get → exists
      {}, // Update OK
    ]);
    __setSchedulerClient(client);
    const ok = await upsertSchedule({
      taskId: 't1',
      agentId: 'main',
      nextRunAtUnixSec: Math.floor(Date.UTC(2026, 4, 20, 15, 0, 0) / 1000),
    });
    expect(ok).toBe(true);
    expect(sent.map((s) => s.name)).toEqual([
      'GetScheduleCommand',
      'UpdateScheduleCommand',
    ]);
    void GetScheduleCommand;
    void UpdateScheduleCommand;
  });

  it('falls back to CreateSchedule when GetSchedule returns ResourceNotFoundException', async () => {
    const notFound = Object.assign(new Error('not found'), {
      name: 'ResourceNotFoundException',
    });
    const { client, sent } = makeMockClient([notFound, {}]);
    __setSchedulerClient(client);
    const ok = await upsertSchedule({
      taskId: 't2',
      agentId: 'main',
      nextRunAtUnixSec: Math.floor(Date.UTC(2026, 4, 20, 15, 0, 0) / 1000),
    });
    expect(ok).toBe(true);
    expect(sent.map((s) => s.name)).toEqual([
      'GetScheduleCommand',
      'CreateScheduleCommand',
    ]);
    void CreateScheduleCommand;
  });

  it('no-ops when EB Scheduler is disabled', async () => {
    process.env.CCE_USE_IN_PROCESS_SCHEDULER = '1';
    const { client, sent } = makeMockClient([]);
    __setSchedulerClient(client);
    const ok = await upsertSchedule({
      taskId: 't3',
      agentId: 'main',
      nextRunAtUnixSec: 0,
    });
    expect(ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it('swallows create failures rather than throwing', async () => {
    const notFound = Object.assign(new Error('not found'), {
      name: 'ResourceNotFoundException',
    });
    const denied = Object.assign(new Error('AccessDenied'), { name: 'AccessDeniedException' });
    const { client } = makeMockClient([notFound, denied]);
    __setSchedulerClient(client);
    const ok = await upsertSchedule({
      taskId: 't4',
      agentId: 'main',
      nextRunAtUnixSec: 0,
    });
    expect(ok).toBe(false);
  });
});

describe('deleteSchedule', () => {
  it('issues DeleteSchedule with the expected name and group', async () => {
    const { client, sent } = makeMockClient([{}]);
    __setSchedulerClient(client);
    const ok = await deleteSchedule('t5');
    expect(ok).toBe(true);
    expect(sent[0].name).toBe('DeleteScheduleCommand');
    expect((sent[0].input as { Name: string }).Name).toBe('task-t5');
    expect((sent[0].input as { GroupName: string }).GroupName).toBe('claudeclaw');
    void DeleteScheduleCommand;
  });

  it('treats ResourceNotFoundException on delete as success (already gone)', async () => {
    const notFound = Object.assign(new Error('not found'), {
      name: 'ResourceNotFoundException',
    });
    const { client } = makeMockClient([notFound]);
    __setSchedulerClient(client);
    const ok = await deleteSchedule('t6');
    expect(ok).toBe(true);
  });

  it('no-ops when EB Scheduler is disabled', async () => {
    delete process.env.SCHEDULED_FIRE_QUEUE_ARN;
    const { client, sent } = makeMockClient([]);
    __setSchedulerClient(client);
    const ok = await deleteSchedule('t7');
    expect(ok).toBe(false);
    expect(sent).toEqual([]);
  });
});
