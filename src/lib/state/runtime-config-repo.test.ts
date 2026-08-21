import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }));

import {
  getConfig,
  setConfig,
  setConfigIfGreater,
  getConfigCategory,
  invalidateRuntimeConfigCache,
} from './runtime-config-repo.js';

beforeEach(() => {
  send.mockReset();
  invalidateRuntimeConfigCache();
});

describe('runtime-config-repo', () => {
  it('getConfig returns the stored value', async () => {
    send.mockResolvedValueOnce({ Item: { value: '42.50' } });
    expect(await getConfig('cost', 'daily_cap_usd')).toBe('42.50');
  });

  it('getConfig returns undefined when the key is unset', async () => {
    send.mockResolvedValueOnce({ Item: undefined });
    expect(await getConfig('cost', 'missing')).toBeUndefined();
  });

  it('getConfig serves the 30s cache without a second DDB read', async () => {
    send.mockResolvedValueOnce({ Item: { value: 'cached' } });
    expect(await getConfig('cost', 'daily_cap_usd')).toBe('cached');
    expect(await getConfig('cost', 'daily_cap_usd')).toBe('cached');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('getConfig fails open to undefined on DDB error', async () => {
    send.mockRejectedValueOnce(new Error('ddb down'));
    expect(await getConfig('cost', 'daily_cap_usd')).toBeUndefined();
  });

  it('setConfig stamps updatedAt/updatedBy and invalidates the cache', async () => {
    send.mockResolvedValueOnce({}); // PutCommand
    await setConfig('cost', 'daily_cap_usd', '99', { updatedBy: 'admin@x' });
    const putArg = send.mock.calls[0][0];
    expect(putArg.input.Item).toMatchObject({
      PK: 'CONFIG#cost',
      SK: 'daily_cap_usd',
      value: '99',
      updatedBy: 'admin@x',
    });
    expect(typeof putArg.input.Item.updatedAt).toBe('string');

    // Cache was invalidated, so the next read hits DDB again.
    send.mockResolvedValueOnce({ Item: { value: '99' } });
    expect(await getConfig('cost', 'daily_cap_usd')).toBe('99');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('getConfigCategory flattens query items into a record', async () => {
    send.mockResolvedValueOnce({
      Items: [
        { SK: 'daily_cap_usd', value: '50' },
        { SK: 'idle_timeout_ms', value: '900000' },
      ],
    });
    expect(await getConfigCategory('cost')).toEqual({
      daily_cap_usd: '50',
      idle_timeout_ms: '900000',
    });
  });

  it('getConfigCategory fails open to an empty record on DDB error', async () => {
    send.mockRejectedValueOnce(new Error('ddb down'));
    expect(await getConfigCategory('cost')).toEqual({});
  });

  describe('setConfigIfGreater — the monotonic guard a cursor needs', () => {
    it('writes one conditional put that only wins when the stored value is absent or older', async () => {
      send.mockResolvedValueOnce({});
      await expect(
        setConfigIfGreater('paperclip', 'reconciler_watermark', '2026-08-21T10:00:00.000Z', {
          updatedBy: 'paperclip-reconciler',
        }),
      ).resolves.toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      const input = send.mock.calls[0][0].input;
      expect(input.Item).toMatchObject({
        PK: 'CONFIG#paperclip',
        SK: 'reconciler_watermark',
        value: '2026-08-21T10:00:00.000Z',
        updatedBy: 'paperclip-reconciler',
      });
      expect(input.ConditionExpression).toBe('attribute_not_exists(PK) OR #value < :value');
      expect(input.ExpressionAttributeNames).toEqual({ '#value': 'value' });
      expect(input.ExpressionAttributeValues).toEqual({ ':value': '2026-08-21T10:00:00.000Z' });
    });

    it('a losing conditional write is false, caught by err.name and never rethrown', async () => {
      send.mockRejectedValueOnce(
        Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' }),
      );
      await expect(
        setConfigIfGreater('paperclip', 'reconciler_watermark', '2026-08-20T00:00:00.000Z', {
          updatedBy: 'paperclip-reconciler',
        }),
      ).resolves.toBe(false);
    });

    it('any OTHER store error throws — a caller must know its write did not land', async () => {
      send.mockRejectedValueOnce(Object.assign(new Error('down'), { name: 'InternalServerError' }));
      await expect(
        setConfigIfGreater('paperclip', 'reconciler_watermark', '2026-08-21T10:00:00.000Z', {
          updatedBy: 'paperclip-reconciler',
        }),
      ).rejects.toThrow('down');
    });

    it('the winner sees its own write: the key and category caches are dropped', async () => {
      send.mockResolvedValueOnce({ Item: { value: 'old' } });
      expect(await getConfig('paperclip', 'reconciler_watermark')).toBe('old');
      send.mockResolvedValueOnce({});
      await setConfigIfGreater('paperclip', 'reconciler_watermark', 'new', { updatedBy: 't' });
      send.mockResolvedValueOnce({ Item: { value: 'new' } });
      expect(await getConfig('paperclip', 'reconciler_watermark')).toBe('new');
    });
  });
});
