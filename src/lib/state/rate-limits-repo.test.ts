import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }));

import {
  getPolicy,
  setPolicy,
  checkAndConsume,
  getSchedulerMinIntervalSec,
  invalidateRateLimitCache,
} from './rate-limits-repo.js';

beforeEach(() => {
  send.mockReset();
  invalidateRateLimitCache();
});

describe('rate-limits-repo', () => {
  it('getPolicy returns the stored row', async () => {
    send.mockResolvedValueOnce({ Item: { limit: 100, windowSec: 30 } });
    expect(await getPolicy('user')).toEqual({ limit: 100, windowSec: 30 });
  });

  it('getPolicy falls back to the built-in default when no row exists', async () => {
    send.mockResolvedValueOnce({ Item: undefined });
    expect(await getPolicy('scheduler')).toEqual({ limit: 60, windowSec: 60 });
  });

  it('getPolicy for user#<id> falls back to the bare user scope', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined }) // user#abc miss
      .mockResolvedValueOnce({ Item: { limit: 200, windowSec: 60 } }); // user hit
    expect(await getPolicy('user#abc')).toEqual({ limit: 200, windowSec: 60 });
  });

  it('getPolicy serves the 30s cache without a second DDB read', async () => {
    send.mockResolvedValueOnce({ Item: { limit: 10, windowSec: 60 } });
    expect((await getPolicy('agent')).limit).toBe(10);
    expect((await getPolicy('agent')).limit).toBe(10);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('getPolicy fails open to the default on DDB error', async () => {
    send.mockRejectedValueOnce(new Error('ddb down'));
    expect(await getPolicy('user')).toEqual({ limit: 60, windowSec: 60 });
  });

  it('setPolicy writes a POLICY#<scope>/LIMIT row and invalidates cache', async () => {
    send.mockResolvedValueOnce({}); // PutCommand
    await setPolicy('user', { limit: 25, windowSec: 120 }, { updatedBy: 'admin@x' });
    const put = send.mock.calls[0][0];
    expect(put.input.Item).toMatchObject({
      PK: 'POLICY#user',
      SK: 'LIMIT',
      limit: 25,
      windowSec: 120,
      updatedBy: 'admin@x',
    });

    send.mockResolvedValueOnce({ Item: { limit: 25, windowSec: 120 } });
    expect((await getPolicy('user')).limit).toBe(25);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('checkAndConsume allows under limit and blocks at the cap', async () => {
    // policy read, then counter increment returning count 1 of 2.
    send
      .mockResolvedValueOnce({ Item: { limit: 2, windowSec: 60 } })
      .mockResolvedValueOnce({ Attributes: { count: 1 } });
    const first = await checkAndConsume('user#abc', 'user');
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);

    // policy now cached; counter increment returns count 3 (over cap of 2).
    send.mockResolvedValueOnce({ Attributes: { count: 3 } });
    const over = await checkAndConsume('user#abc', 'user');
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it('checkAndConsume is unlimited (opt-in) when no policy is configured', async () => {
    // Both the exact-scope and default-scope policy reads return no row, so
    // enforcement must treat the identity as unlimited and NOT consume a token.
    // This guards the "no surprise throttle on deploy" property.
    send.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({ Item: undefined });
    const r = await checkAndConsume('user#nobody', 'user#nobody');
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(Number.POSITIVE_INFINITY);
    // Exactly the two policy reads happened; no counter UpdateCommand was sent.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('checkAndConsume fails open when the counter write errors', async () => {
    send
      .mockResolvedValueOnce({ Item: { limit: 1, windowSec: 60 } })
      .mockRejectedValueOnce(new Error('ddb down'));
    const r = await checkAndConsume('user#abc', 'user');
    expect(r.allowed).toBe(true);
  });

  it('getSchedulerMinIntervalSec returns the fallback when scheduler is unset', async () => {
    send.mockResolvedValueOnce({ Item: undefined });
    expect(await getSchedulerMinIntervalSec(60)).toBe(60);
  });

  it('getSchedulerMinIntervalSec honors a configured floor', async () => {
    send.mockResolvedValueOnce({ Item: { limit: 300, windowSec: 60 } });
    expect(await getSchedulerMinIntervalSec(60)).toBe(300);
  });
});
