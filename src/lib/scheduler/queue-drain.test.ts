import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const listScheduledTasksForAgent = vi.fn();
const markFired = vi.fn();
vi.mock('../state/scheduled-tasks-repo.js', () => ({
  listScheduledTasksForAgent: (...a: unknown[]) => listScheduledTasksForAgent(...a),
  markFired: (...a: unknown[]) => markFired(...a),
}));

const ddbSend = vi.fn();
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send: ddbSend }) }));

const runAgentTurn = vi.fn();
vi.mock('../../agent/agent-loop.js', () => ({
  runAgentTurn: (...a: unknown[]) => runAgentTurn(...a),
}));

vi.mock('../state/sessions-repo.js', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  appendTurns: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./delivery.js', () => ({
  deliverScheduledReply: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../audit/audit-writer.js', () => ({ writeAudit: vi.fn() }));
vi.mock('./eb-scheduler.js', () => ({
  upsertSchedule: vi.fn().mockResolvedValue(true),
  deleteSchedule: vi.fn().mockResolvedValue(true),
  isEbSchedulerEnabled: vi.fn().mockReturnValue(true),
}));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleMessage } from './queue-drain.js';

const NOW_MS = 1_800_000_000_000;
const nowSec = Math.floor(NOW_MS / 1000);

function msg(taskId: string, agentId: string): { Body: string } {
  return { Body: JSON.stringify({ taskId, agentId }) };
}

function task(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 't1',
    agentId: 'a1',
    chatId: 'c1',
    promptText: 'do the thing',
    nextRunAt: nowSec,
    status: 'active',
    createdAt: new Date(NOW_MS).toISOString(),
    createdBy: 'user',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  listScheduledTasksForAgent.mockReset();
  markFired.mockReset().mockResolvedValue(undefined);
  ddbSend.mockReset().mockResolvedValue({});
  runAgentTurn
    .mockReset()
    .mockResolvedValue({ text: 'alive', blocked: false, costUsd: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('queue-drain stale-fire fence', () => {
  it('drops a message whose row was re-armed to a future slot', async () => {
    listScheduledTasksForAgent.mockResolvedValue([
      task({ nextRunAt: nowSec + 86400 }), // wake catch-up moved it a day out
    ]);
    const consumed = await handleMessage(msg('t1', 'a1'));
    expect(consumed).toBe(true); // deleted from the queue
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(markFired).not.toHaveBeenCalled();
  });

  it('fires a live message whose row is due now', async () => {
    listScheduledTasksForAgent.mockResolvedValue([task({ nextRunAt: nowSec })]);
    const consumed = await handleMessage(msg('t1', 'a1'));
    expect(consumed).toBe(true);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(markFired).toHaveBeenCalledTimes(1);
  });

  it('fires a late replay (row nextRunAt in the past, e.g. short pause)', async () => {
    listScheduledTasksForAgent.mockResolvedValue([
      task({ nextRunAt: nowSec - 2 * 86400 }),
    ]);
    const consumed = await handleMessage(msg('t1', 'a1'));
    expect(consumed).toBe(true);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('still drops fires for cancelled rows', async () => {
    listScheduledTasksForAgent.mockResolvedValue([task({ status: 'cancelled' })]);
    const consumed = await handleMessage(msg('t1', 'a1'));
    expect(consumed).toBe(true);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
