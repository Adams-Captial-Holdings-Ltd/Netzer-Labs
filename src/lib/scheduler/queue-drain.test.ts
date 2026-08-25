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
// Imported for the P30 assertions below: these are the vi.fn()s declared in the
// factories above, reached through the module so nothing has to be re-plumbed.
import { appendTurns } from '../state/sessions-repo.js';
import { deliverScheduledReply } from './delivery.js';

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

/**
 * P30. THE SHAPE OF THESE TESTS IS THE POINT: `runAgentTurn` RESOLVES here, it
 * does not reject. Phase 6 shipped 538 green tests over this exact defect on the
 * dispatch path and not one caught it, because every scheduler test drove a
 * THROWN failure — and a throw already lands in the `catch` that releases the
 * claim and returns false. The loss channel is the outcome that returns
 * normally: `runAgentTurn`'s three pre-model gates refuse by RESOLVING a canned
 * notice with a typed `refusal` marker. A test that only rejects proves nothing
 * about it.
 */
describe('queue-drain refusal fence (P30)', () => {
  const refused = (kind: string, retryable: boolean) => ({
    text: 'Sessions are frozen for maintenance. Please try again shortly.',
    blocked: false,
    costUsd: 0,
    refusal: { kind, retryable },
  });

  it('does NOT consume the SQS message when a maintenance freeze refuses the turn', async () => {
    vi.mocked(appendTurns).mockClear();
    vi.mocked(deliverScheduledReply).mockClear();
    listScheduledTasksForAgent.mockResolvedValue([task({ nextRunAt: nowSec })]);
    runAgentTurn.mockResolvedValue(refused('sessions_frozen', true));

    const consumed = await handleMessage(msg('t1', 'a1'));

    // The whole defect in one assertion: true here deletes the message and the
    // user's scheduled work is gone for good.
    expect(consumed).toBe(false);
    // The schedule must not advance past a slot that never ran.
    expect(markFired).not.toHaveBeenCalled();
    // The refusal notice is not the agent speaking, so it must not enter the
    // session as an assistant turn nor reach the user as their answer.
    expect(appendTurns).not.toHaveBeenCalled();
    expect(deliverScheduledReply).not.toHaveBeenCalled();
    // And the claim goes back, or the redelivery finds STATUS#in_flight and
    // idles forever — a slower version of the same loss.
    const lastCall = ddbSend.mock.calls.at(-1)?.[0] as {
      input: { ExpressionAttributeValues?: Record<string, unknown> };
    };
    expect(lastCall.input.ExpressionAttributeValues).toMatchObject({
      ':a': 'STATUS#active',
    });
  });

  it('does NOT consume the message when the turn rate limit refuses it', async () => {
    listScheduledTasksForAgent.mockResolvedValue([task({ nextRunAt: nowSec })]);
    runAgentTurn.mockResolvedValue(refused('rate_limited', true));
    expect(await handleMessage(msg('t1', 'a1'))).toBe(false);
    expect(markFired).not.toHaveBeenCalled();
  });

  it('still consumes an ordinary turn, so the fence is not a blanket refusal', async () => {
    // The control. Without this, a fix that returned false unconditionally
    // would pass the two cases above and break every scheduled task.
    listScheduledTasksForAgent.mockResolvedValue([task({ nextRunAt: nowSec })]);
    runAgentTurn.mockResolvedValue({ text: 'alive', blocked: false, costUsd: 0 });
    expect(await handleMessage(msg('t1', 'a1'))).toBe(true);
    expect(markFired).toHaveBeenCalledTimes(1);
  });
});
