import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ddbSend = vi.fn();
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send: ddbSend }) }));

const upsertSchedule = vi.fn();
const listExistingTaskIds = vi.fn();
const isEbSchedulerEnabled = vi.fn();
vi.mock('./eb-scheduler.js', () => ({
  upsertSchedule: (...a: unknown[]) => upsertSchedule(...a),
  listExistingTaskIds: (...a: unknown[]) => listExistingTaskIds(...a),
  isEbSchedulerEnabled: (...a: unknown[]) => isEbSchedulerEnabled(...a),
}));

const advanceOverdueTask = vi.fn();
const expireOverdueTask = vi.fn();
vi.mock('../state/scheduled-tasks-repo.js', () => ({
  advanceOverdueTask: (...a: unknown[]) => advanceOverdueTask(...a),
  expireOverdueTask: (...a: unknown[]) => expireOverdueTask(...a),
}));

const writeAudit = vi.fn();
vi.mock('../audit/audit-writer.js', () => ({
  writeAudit: (...a: unknown[]) => writeAudit(...a),
}));

vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runScheduleBackfill } from './backfill.js';

const NOW_MS = 1_800_000_000_000; // fixed clock
const nowSec = Math.floor(NOW_MS / 1000);

function scanPage(items: Array<Record<string, unknown>>): { Items: unknown[] } {
  return { Items: items };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  ddbSend.mockReset();
  upsertSchedule.mockReset().mockResolvedValue(true);
  listExistingTaskIds.mockReset().mockResolvedValue(new Set());
  isEbSchedulerEnabled.mockReset().mockReturnValue(true);
  advanceOverdueTask.mockReset().mockResolvedValue(true);
  expireOverdueTask.mockReset().mockResolvedValue(true);
  writeAudit.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runScheduleBackfill wake catch-up', () => {
  it('no-ops when EB scheduler is disabled', async () => {
    isEbSchedulerEnabled.mockReturnValue(false);
    const s = await runScheduleBackfill();
    expect(s.active).toBe(0);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it('re-arms fresh rows exactly as before (within the 5 min window)', async () => {
    ddbSend.mockResolvedValueOnce(
      scanPage([{ id: 't1', agentId: 'a1', nextRunAt: nowSec - 60 }]),
    );
    const s = await runScheduleBackfill();
    expect(s.created).toBe(1);
    expect(upsertSchedule).toHaveBeenCalledWith({
      taskId: 't1',
      agentId: 'a1',
      nextRunAtUnixSec: nowSec + 5,
    });
  });

  it('advances a recurring row past a multi-day gap to the next on-grid slot', async () => {
    const day = 86400;
    const old = nowSec - 3 * day; // 3 days overdue, daily cadence
    ddbSend.mockResolvedValueOnce(
      scanPage([{ id: 'r1', agentId: 'a1', nextRunAt: old, intervalSec: day }]),
    );
    const s = await runScheduleBackfill();
    expect(s.caughtUp).toBe(1);
    const expectedNext = old + 4 * day; // first strictly-future grid slot
    expect(advanceOverdueTask).toHaveBeenCalledWith('a1', 'r1', old, expectedNext);
    expect(upsertSchedule).toHaveBeenCalledWith({
      taskId: 'r1',
      agentId: 'a1',
      nextRunAtUnixSec: expectedNext,
    });
  });

  it('retires a recurring row whose endAt passed during the gap', async () => {
    const day = 86400;
    const old = nowSec - 3 * day;
    const endAt = new Date((old + day) * 1000).toISOString();
    ddbSend.mockResolvedValueOnce(
      scanPage([
        { id: 'r2', agentId: 'a1', nextRunAt: old, intervalSec: day, endAt },
      ]),
    );
    const s = await runScheduleBackfill();
    expect(s.expired).toBe(1);
    expect(expireOverdueTask).toHaveBeenCalledWith('a1', 'r2', old);
    expect(advanceOverdueTask).not.toHaveBeenCalled();
  });

  it('leaves one-shots inside SQS retention for the queue replay', async () => {
    ddbSend.mockResolvedValueOnce(
      scanPage([{ id: 'o1', agentId: 'a1', nextRunAt: nowSec - 2 * 86400 }]),
    );
    const s = await runScheduleBackfill();
    expect(s.deferredToQueue).toBe(1);
    expect(advanceOverdueTask).not.toHaveBeenCalled();
    expect(upsertSchedule).not.toHaveBeenCalled();
  });

  it('re-arms a one-shot overdue past SQS retention to fire ~1 min out', async () => {
    const old = nowSec - 5 * 86400;
    ddbSend.mockResolvedValueOnce(
      scanPage([{ id: 'o2', agentId: 'a1', nextRunAt: old }]),
    );
    const s = await runScheduleBackfill();
    expect(s.lateRearmed).toBe(1);
    expect(advanceOverdueTask).toHaveBeenCalledWith('a1', 'o2', old, nowSec + 60);
  });

  it('expires a one-shot overdue beyond the late-fire horizon, with audit', async () => {
    const old = nowSec - 10 * 86400;
    ddbSend.mockResolvedValueOnce(
      scanPage([{ id: 'o3', agentId: 'a1', nextRunAt: old }]),
    );
    const s = await runScheduleBackfill();
    expect(s.expired).toBe(1);
    expect(expireOverdueTask).toHaveBeenCalledWith('a1', 'o3', old);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'scheduled_task',
        detail: expect.objectContaining({ source: 'wake-catchup', taskId: 'o3' }),
      }),
    );
  });

  it('counts a lost fence as skipped instead of erroring', async () => {
    advanceOverdueTask.mockResolvedValue(false); // another replica won
    ddbSend.mockResolvedValueOnce(
      scanPage([
        { id: 'r3', agentId: 'a1', nextRunAt: nowSec - 86400, intervalSec: 3600 },
      ]),
    );
    const s = await runScheduleBackfill();
    expect(s.skipped).toBe(1);
    expect(upsertSchedule).not.toHaveBeenCalled();
  });

  it('skips rows that already have a live schedule', async () => {
    listExistingTaskIds.mockResolvedValue(new Set(['r4']));
    ddbSend.mockResolvedValueOnce(
      scanPage([
        { id: 'r4', agentId: 'a1', nextRunAt: nowSec - 86400, intervalSec: 3600 },
      ]),
    );
    const s = await runScheduleBackfill();
    expect(s.alreadyPresent).toBe(1);
    expect(advanceOverdueTask).not.toHaveBeenCalled();
  });
});
