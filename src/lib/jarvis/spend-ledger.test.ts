import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));

import {
  ensureDay,
  buildReserveOps,
  buildReleaseOps,
  settleTurn,
  topUp,
  reapReservation,
  findExpiredReservations,
  utcDate,
} from './spend-ledger.js';

function canceled(): Error {
  return Object.assign(new Error('canceled'), { name: 'TransactionCanceledException' });
}

describe('spend-ledger (H5)', () => {
  beforeEach(() => send.mockReset());

  it('buildReserveOps bumps the day headroom and creates an owner-fenced reservation', () => {
    const ops = buildReserveOps({
      ownerId: 'o', estimate: 0.02, expiresAt: 123, utcDate: '2026-05-30', slotIndex: 1, tokenHash: 't',
    });
    expect(ops[0].Update!.ConditionExpression).toBe('headroom >= :est');
    expect(ops[0].Update!.UpdateExpression).toBe('SET headroom = headroom - :est ADD reserved :est');
    expect(ops[1].Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(ops[1].Put!.Item).toMatchObject({ PK: 'RES#o', ownerId: 'o', estimate: 0.02, settled: 0, slotIndex: 1, tokenHash: 't', gpk: 'RES' });
  });

  it('buildReleaseOps returns rem to headroom and deletes the reservation, owner-conditioned', () => {
    const ops = buildReleaseOps('o', '2026-05-30', 0.01);
    expect(ops[0].Update!.ConditionExpression).toBe('reserved >= :rem');
    expect(ops[0].Update!.UpdateExpression).toBe('SET headroom = headroom + :rem, reserved = reserved - :rem');
    expect(ops[1].Delete!.ConditionExpression).toBe('ownerId = :o');
  });

  it('ensureDay seeds headroom=cap create-only and swallows an already-seeded day', async () => {
    send.mockResolvedValueOnce({});
    await ensureDay('2026-05-30', 50);
    const cmd = send.mock.calls[0][0];
    expect(cmd.input.Item).toEqual({ PK: 'DAY#2026-05-30', cap: 50, spent: 0, reserved: 0, headroom: 50 });
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(PK)');

    send.mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }));
    await expect(ensureDay('2026-05-30', 50)).resolves.toBeUndefined();
  });

  it('settleTurn moves reserved→spent (cond reserved >= delta) and bumps RES settled', async () => {
    send.mockResolvedValueOnce({});
    await settleTurn('o', '2026-05-30', 0.005);
    const items = send.mock.calls[0][0].input.TransactItems;
    expect(items[0].Update.UpdateExpression).toBe('SET spent = spent + :d, reserved = reserved - :d');
    expect(items[0].Update.ConditionExpression).toBe('reserved >= :d');
    expect(items[1].Update.ConditionExpression).toBe('ownerId = :o');
  });

  it('topUp returns false at the cap (TransactionCanceled → 4013)', async () => {
    send.mockRejectedValueOnce(canceled());
    expect(await topUp('o', '2026-05-30', 0.01)).toBe(false);

    send.mockResolvedValueOnce({});
    expect(await topUp('o', '2026-05-30', 0.01)).toBe(true);
  });

  it('reapReservation returns estimate−settled to headroom, owner-conditioned, and skips a reclaimed reservation', async () => {
    send.mockResolvedValueOnce({});
    await reapReservation({ ownerId: 'o', utcDate: '2026-05-30', estimate: 0.02, settled: 0.005, slotIndex: 1, tokenHash: 't' });
    const items = send.mock.calls[0][0].input.TransactItems;
    expect(items[0].Update.ExpressionAttributeValues[':rem']).toBeCloseTo(0.015, 6);
    expect(items[1].Delete.ConditionExpression).toBe('ownerId = :o');

    // A replacement already settled/released → cancellation is swallowed (no double-free).
    send.mockRejectedValueOnce(canceled());
    await expect(
      reapReservation({ ownerId: 'o', utcDate: '2026-05-30', estimate: 0.02, settled: 0, slotIndex: 1, tokenHash: 't' }),
    ).resolves.toBeUndefined();
  });

  it('findExpiredReservations queries the res-by-expiry GSI for expiresAt < now', async () => {
    send.mockResolvedValueOnce({ Items: [{ ownerId: 'o', utcDate: '2026-05-30', estimate: 0.02, settled: 0, slotIndex: 2, tokenHash: 't' }] });
    const rows = await findExpiredReservations(1000);
    const cmd = send.mock.calls[0][0];
    expect(cmd.input.IndexName).toBe('res-by-expiry');
    expect(cmd.input.KeyConditionExpression).toBe('gpk = :g AND expiresAt < :now');
    expect(cmd.input.ExpressionAttributeValues).toMatchObject({ ':g': 'RES', ':now': 1000 });
    expect(rows[0]).toMatchObject({ ownerId: 'o', slotIndex: 2 });
  });

  it('utcDate formats a calendar day', () => {
    expect(utcDate(new Date('2026-05-30T23:59:00Z'))).toBe('2026-05-30');
  });
});
