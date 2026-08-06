import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send, logWarn } = vi.hoisted(() => ({ send: vi.fn(), logWarn: vi.fn() }));
vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: logWarn, error: vi.fn() },
}));

import { tryAcquireRunnerLease } from './runner-lease.js';

const conditionalFail = () =>
  Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => {
  send.mockReset();
  logWarn.mockClear();
});

describe('tryAcquireRunnerLease', () => {
  it('acquires with a single conditional put (absent OR expired OR own)', async () => {
    send.mockResolvedValue({});
    const ok = await tryAcquireRunnerLease({
      name: 'canary',
      ttlMs: 600_000,
      holderId: 'me',
      now: 1_000_000,
    });
    expect(ok).toBe(true);
    const input = send.mock.calls[0][0].input;
    expect(input.Item.PK).toBe('RUNNER#canary');
    expect(input.Item.holderId).toBe('me');
    expect(input.Item.expiresAt).toBe(1_600_000);
    expect(input.ConditionExpression).toContain('attribute_not_exists(PK)');
    expect(input.ConditionExpression).toContain('expiresAt <= :now');
    expect(input.ConditionExpression).toContain('holderId = :me');
    expect(input.ExpressionAttributeValues[':now']).toBe(1_000_000);
  });

  it('returns false when another live holder has the lease', async () => {
    send.mockRejectedValue(conditionalFail());
    const ok = await tryAcquireRunnerLease({ name: 'canary', ttlMs: 600_000, holderId: 'me' });
    expect(ok).toBe(false);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('renewal by the same holder succeeds (holderId = :me arm)', async () => {
    send.mockResolvedValue({});
    const ok = await tryAcquireRunnerLease({ name: 'canary', ttlMs: 600_000, holderId: 'me' });
    expect(ok).toBe(true);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues[':me']).toBe('me');
  });

  it('fails OPEN on a store error, with a loud warn', async () => {
    send.mockRejectedValue(Object.assign(new Error('down'), { name: 'InternalServerError' }));
    const ok = await tryAcquireRunnerLease({ name: 'webhook-monitor', ttlMs: 240_000, holderId: 'me' });
    expect(ok).toBe(true);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ lease: 'webhook-monitor' }),
      expect.stringContaining('fail-open'),
    );
  });
});
