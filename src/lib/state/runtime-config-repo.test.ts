import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }));

import {
  getConfig,
  setConfig,
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
});
