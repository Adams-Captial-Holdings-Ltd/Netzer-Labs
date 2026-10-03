import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTEMPT_ROW_TTL_SECONDS, type AttemptRow } from './attempt-store.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));

import { dynamoAttemptRows, scanRecordedAttempts } from './attempt-rows-dynamo.js';

const row: AttemptRow = {
  issueId: 'issue-1', attemptNo: 1, state: 'recorded', leaseToken: 1,
  holderId: 'task-a', leaseExpiresAt: 30_000, runIds: ['run-1'],
  outcome: { disposition: 'done', comment: 'customer text' },
  version: 2, startedAt: 0, updatedAt: 1,
};
const conditionalFail = () => Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => send.mockReset());

describe('dynamoAttemptRows', () => {
  it('reads the prefixed key consistently and returns only the row', async () => {
    send.mockResolvedValue({ Item: { PK: 'ATTEMPT#issue-1', ...row, ttl: 123 } });
    expect(await dynamoAttemptRows().get('issue-1')).toEqual(row);
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: { PK: 'ATTEMPT#issue-1' }, ConsistentRead: true,
    });
  });

  it('creates only when absent and refreshes TTL', async () => {
    send.mockResolvedValue({});
    const before = Math.floor(Date.now() / 1000);
    expect(await dynamoAttemptRows().create(row)).toBe(true);
    const input = send.mock.calls[0][0].input;
    expect(input.Item).toMatchObject({ PK: 'ATTEMPT#issue-1', ...row });
    expect(input.Item.ttl).toBeGreaterThanOrEqual(before + ATTEMPT_ROW_TTL_SECONDS);
    expect(input.Item.ttl).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + ATTEMPT_ROW_TTL_SECONDS);
    expect(input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(input.TableName).toBe(process.env.TABLE_QUEUE_LEASE ?? 'claudeclaw-queue-lease');
  });

  it('replaces only the expected version and refreshes TTL', async () => {
    send.mockResolvedValue({});
    const before = Math.floor(Date.now() / 1000);
    expect(await dynamoAttemptRows().replace('issue-1', 1, row)).toBe(true);
    const input = send.mock.calls[0][0].input;
    expect(input.Item.PK).toBe('ATTEMPT#issue-1');
    expect(input.ConditionExpression).toBe('#v = :expected');
    expect(input.ExpressionAttributeNames).toEqual({ '#v': 'version' });
    expect(input.ExpressionAttributeValues).toEqual({ ':expected': 1 });
    expect(input.Item.ttl).toBeGreaterThanOrEqual(before + ATTEMPT_ROW_TTL_SECONDS);
  });

  it('returns false only for a failed condition; other store errors propagate', async () => {
    const rows = dynamoAttemptRows();
    send.mockRejectedValueOnce(conditionalFail()).mockRejectedValueOnce(conditionalFail());
    expect(await rows.create(row)).toBe(false);
    expect(await rows.replace('issue-1', 1, row)).toBe(false);
    const error = new Error('Dynamo unavailable');
    send.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    await expect(rows.create(row)).rejects.toBe(error);
    await expect(rows.replace('issue-1', 1, row)).rejects.toBe(error);
  });

  it('scans recorded attempt rows through every page', async () => {
    const cursor = { PK: 'ATTEMPT#issue-1' };
    send.mockResolvedValueOnce({ Items: [{ PK: 'ATTEMPT#issue-1', ...row, ttl: 123 }], LastEvaluatedKey: cursor })
      .mockResolvedValueOnce({ Items: [{ PK: 'ATTEMPT#issue-2', ...row, issueId: 'issue-2', ttl: 124 }] });
    expect(await scanRecordedAttempts()).toEqual([row, { ...row, issueId: 'issue-2' }]);
    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0][0].input;
    const second = send.mock.calls[1][0].input;
    expect(first.FilterExpression).toBe('begins_with(PK, :p) AND #s = :recorded');
    expect(first.ExpressionAttributeNames).toEqual({ '#s': 'state' });
    expect(first.ExpressionAttributeValues).toEqual({ ':p': 'ATTEMPT#', ':recorded': 'recorded' });
    expect(first.ExclusiveStartKey).toBeUndefined();
    expect(second.ExclusiveStartKey).toEqual(cursor);
  });
});
