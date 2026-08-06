import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  reserve,
  settle,
  release,
  dayPk,
  resPk,
  utcDay,
  type LedgerStore,
} from './spend-ledger.js';

function canceled(reasons?: Array<{ Code?: string }>): Error {
  return Object.assign(new Error('canceled'), {
    name: 'TransactionCanceledException',
    ...(reasons ? { CancellationReasons: reasons } : {}),
  });
}

function conditionalFail(): Error {
  return Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
}

function storeWith(send: ReturnType<typeof vi.fn>): LedgerStore {
  return { send, tableName: 'test-ledger' };
}

describe('spend-ledger reserve (I3 atomic, fail-closed)', () => {
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    send = vi.fn();
  });

  it('reserves under cap: seeds the day then atomically lowers headroom by worstCase', async () => {
    // 1: ensureDay Put succeeds (fresh day). 2: admission transaction succeeds.
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const res = await reserve({
      store: storeWith(send),
      day: '2026-06-16',
      capUsd: 50,
      worstCaseUsd: 0.4,
      idempotencyKey: 'turn-1',
    });
    expect(res).toEqual({ ok: true, reservationId: 'turn-1' });

    // The seed put.
    const seed = send.mock.calls[0][0];
    expect(seed.input.Item).toMatchObject({
      PK: dayPk('2026-06-16'),
      cap: 50,
      spent: 0,
      reserved: 0,
      headroom: 50,
      seq: 0,
    });
    expect(seed.input.ConditionExpression).toBe('attribute_not_exists(PK)');

    // The admission transaction: day headroom condition + reservation create.
    const tx = send.mock.calls[1][0].input.TransactItems;
    expect(tx[0].Update.ConditionExpression).toBe('headroom >= :w');
    expect(tx[0].Update.UpdateExpression).toBe(
      'SET headroom = headroom - :w, reserved = reserved + :w, seq = seq + :one',
    );
    expect(tx[0].Update.ExpressionAttributeValues[':w']).toBeCloseTo(0.4, 6);
    expect(tx[1].Put.Item).toMatchObject({
      PK: resPk('turn-1'),
      idempotencyKey: 'turn-1',
      worstCase: 0.4,
      settled: 0,
      status: 'reserved',
    });
    expect(tx[1].Put.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('an already-seeded day swallows the seed conditional failure and still reserves', async () => {
    send.mockRejectedValueOnce(conditionalFail()).mockResolvedValueOnce({});
    const res = await reserve({
      store: storeWith(send),
      day: '2026-06-16',
      capUsd: 50,
      worstCaseUsd: 1,
      idempotencyKey: 'turn-2',
    });
    expect(res).toEqual({ ok: true, reservationId: 'turn-2' });
  });

  it('fails cap_exceeded when reserving worstCase would breach the cap (day condition fails)', async () => {
    // seed: already exists (cond fail, swallowed). admission: tx canceled with
    // the DAY condition (index 0) failing.
    send
      .mockRejectedValueOnce(conditionalFail())
      .mockRejectedValueOnce(
        canceled([{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }]),
      );
    const res = await reserve({
      store: storeWith(send),
      day: '2026-06-16',
      capUsd: 50,
      worstCaseUsd: 49.9,
      idempotencyKey: 'turn-3',
    });
    expect(res).toEqual({ ok: false, reason: 'cap_exceeded' });
  });

  it('FAILS CLOSED (store_unavailable) when the seed Put throws a non-conditional store error', async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error('throttle'), { name: 'ProvisionedThroughputExceededException' }),
    );
    const res = await reserve({
      store: storeWith(send),
      day: '2026-06-16',
      capUsd: 50,
      worstCaseUsd: 0.1,
      idempotencyKey: 'turn-4',
    });
    expect(res).toEqual({ ok: false, reason: 'store_unavailable' });
    // Must NOT have attempted the admission transaction after a store failure.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('FAILS CLOSED when the admission throws a non-conditional store error', async () => {
    send
      .mockResolvedValueOnce({}) // seed ok
      .mockRejectedValueOnce(
        Object.assign(new Error('net'), { name: 'TimeoutError' }),
      );
    const res = await reserve({
      store: storeWith(send),
      day: '2026-06-16',
      capUsd: 50,
      worstCaseUsd: 0.1,
      idempotencyKey: 'turn-5',
    });
    expect(res).toEqual({ ok: false, reason: 'store_unavailable' });
  });

  it('FAILS CLOSED when a transaction is canceled with no decodable reasons', async () => {
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(canceled());
    const res = await reserve({
      store: storeWith(send),
      day: '2026-06-16',
      capUsd: 50,
      worstCaseUsd: 0.1,
      idempotencyKey: 'turn-6',
    });
    expect(res).toEqual({ ok: false, reason: 'store_unavailable' });
  });

  it('is idempotent: a retry with the same key (reservation already exists, day ok) returns the same id without re-charging', async () => {
    // seed already exists (swallowed); admission canceled with ONLY the
    // reservation create-only condition (index 1) failing, day condition None.
    send
      .mockRejectedValueOnce(conditionalFail())
      .mockRejectedValueOnce(
        canceled([{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }]),
      );
    const res = await reserve({
      store: storeWith(send),
      day: '2026-06-16',
      capUsd: 50,
      worstCaseUsd: 0.1,
      idempotencyKey: 'turn-1',
    });
    expect(res).toEqual({ ok: true, reservationId: 'turn-1' });
  });

  it('regression: a same-key retry returns ok even when BOTH legs fail (reservation exists AND day since filled to cap)', async () => {
    // The original reserve already charged headroom for this key. On the retry the
    // day has since filled, so DynamoDB cancels with BOTH conditions failed. This
    // must still be an idempotent success, not a spurious cap_exceeded that strands
    // the already-paid hold.
    send
      .mockRejectedValueOnce(conditionalFail())
      .mockRejectedValueOnce(
        canceled([{ Code: 'ConditionalCheckFailed' }, { Code: 'ConditionalCheckFailed' }]),
      );
    const res = await reserve({
      store: storeWith(send),
      day: '2026-06-16',
      capUsd: 50,
      worstCaseUsd: 3,
      idempotencyKey: 'turn-1',
    });
    expect(res).toEqual({ ok: true, reservationId: 'turn-1' });
  });

  it('regression: a 0 (or negative) worstCase clamps UP to a positive epsilon so the headroom conditional is exercised', async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await reserve({
      store: storeWith(send),
      day: '2026-06-16',
      capUsd: 50,
      worstCaseUsd: 0,
      idempotencyKey: 'turn-zero',
    });
    const tx = send.mock.calls[1][0].input.TransactItems;
    const reserved = tx[0].Update.ExpressionAttributeValues[':w'];
    expect(reserved).toBeGreaterThan(0); // not literal 0 — cannot bypass a breached day
    expect(reserved).toBeLessThan(1e-6);
  });

  it('utcDay formats a calendar day', () => {
    expect(utcDay(new Date('2026-06-16T23:59:00Z'))).toBe('2026-06-16');
  });
});

describe('spend-ledger settle (reserved -> spent)', () => {
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    send = vi.fn();
  });

  it('marks the reservation settled and moves the held worstCase to spent ATOMICALLY (one transaction)', async () => {
    // 1: GetItem reads the reserved reservation's held worstCase. 2: ONE atomic
    // TransactWrite marks it settled AND adjusts the day together.
    send
      .mockResolvedValueOnce({ Item: { worstCase: 0.4, status: 'reserved' } })
      .mockResolvedValueOnce({});
    await settle({
      store: storeWith(send),
      day: '2026-06-16',
      reservationId: 'turn-1',
      actualUsd: 0.12,
    });

    expect(send.mock.calls[0][0].constructor.name).toBe('GetCommand');

    const tx = send.mock.calls[1][0].input.TransactItems;
    expect(send.mock.calls[1][0].constructor.name).toBe('TransactWriteCommand');
    const resUpd = tx[0].Update;
    expect(resUpd.ConditionExpression).toBe('#st = :reserved');
    expect(resUpd.ExpressionAttributeValues[':settled']).toBe('settled');

    const dayUpd = tx[1].Update;
    expect(dayUpd.ConditionExpression).toBe('reserved >= :held');
    expect(dayUpd.UpdateExpression).toBe(
      'SET spent = spent + :actual, reserved = reserved - :held, headroom = headroom + :delta, seq = seq + :one',
    );
    expect(dayUpd.ExpressionAttributeValues[':actual']).toBeCloseTo(0.12, 6);
    expect(dayUpd.ExpressionAttributeValues[':held']).toBeCloseTo(0.4, 6);
    // headroom delta = held - actual = 0.28 (the over-reservation comes back).
    expect(dayUpd.ExpressionAttributeValues[':delta']).toBeCloseTo(0.28, 6);
  });

  it('settle is a no-op on a retry (GetItem shows the reservation already settled, no transaction runs)', async () => {
    send.mockResolvedValueOnce({ Item: { worstCase: 0.4, status: 'settled' } });
    await expect(
      settle({ store: storeWith(send), day: '2026-06-16', reservationId: 'turn-1', actualUsd: 0.1 }),
    ).resolves.toBeUndefined();
    // Only the GetItem ran; the atomic transaction was never attempted.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('settle is a no-op when the atomic transaction is canceled (a concurrent settle won the race)', async () => {
    send
      .mockResolvedValueOnce({ Item: { worstCase: 0.4, status: 'reserved' } })
      .mockRejectedValueOnce(conditionalFail());
    await expect(
      settle({ store: storeWith(send), day: '2026-06-16', reservationId: 'turn-1', actualUsd: 0.1 }),
    ).resolves.toBeUndefined();
  });

  it('settle surfaces a non-conditional store error on the transaction', async () => {
    send
      .mockResolvedValueOnce({ Item: { worstCase: 0.4, status: 'reserved' } })
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'InternalServerError' }));
    await expect(
      settle({ store: storeWith(send), day: '2026-06-16', reservationId: 'turn-1', actualUsd: 0.1 }),
    ).rejects.toThrow('boom');
  });
});

describe('spend-ledger release (unused reservation)', () => {
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    send = vi.fn();
  });

  it('returns the full held worstCase to headroom and marks released ATOMICALLY (one transaction)', async () => {
    send
      .mockResolvedValueOnce({ Item: { worstCase: 0.5, status: 'reserved' } })
      .mockResolvedValueOnce({});
    await release({ store: storeWith(send), day: '2026-06-16', reservationId: 'turn-7' });

    expect(send.mock.calls[0][0].constructor.name).toBe('GetCommand');
    const tx = send.mock.calls[1][0].input.TransactItems;
    expect(send.mock.calls[1][0].constructor.name).toBe('TransactWriteCommand');
    expect(tx[0].Update.ExpressionAttributeValues[':released']).toBe('released');
    const dayUpd = tx[1].Update;
    expect(dayUpd.UpdateExpression).toBe(
      'SET reserved = reserved - :held, headroom = headroom + :held, seq = seq + :one',
    );
    expect(dayUpd.ExpressionAttributeValues[':held']).toBeCloseTo(0.5, 6);
  });

  it('release is a no-op when the reservation was already settled (GetItem shows non-reserved status)', async () => {
    send.mockResolvedValueOnce({ Item: { worstCase: 0.5, status: 'settled' } });
    await expect(
      release({ store: storeWith(send), day: '2026-06-16', reservationId: 'turn-7' }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
