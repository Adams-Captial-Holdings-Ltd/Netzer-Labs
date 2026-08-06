import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));

import {
  putSeat,
  getSeatForUser,
  listSeats,
  putSeatPolicy,
  listSeatPolicies,
  putSeatUsage,
  listSeatUsage,
  listSeatUsageForSeat,
  newSeat,
  patchSeat,
} from './seat-repo.js';
import type { Seat, SeatUsage } from './seat-model.js';

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({});
});

const seat: Seat = {
  seatId: 'seat-1',
  userId: 'user-1',
  status: 'active',
  policyId: 'pol-1',
  createdAt: '2026-07-01T00:00:00.000Z',
  createdBy: 'tester',
  updatedAt: '2026-07-01T00:00:00.000Z',
  updatedBy: 'tester',
};

describe('putSeat', () => {
  it('writes the canonical row AND the user→seat link item', async () => {
    await putSeat(seat);
    expect(send).toHaveBeenCalledTimes(2);
    const canonical = send.mock.calls[0][0].input;
    expect(canonical.Item.PK).toBe('SEATS');
    expect(canonical.Item.SK).toBe('SEAT#seat-1');
    const link = send.mock.calls[1][0].input;
    expect(link.Item.PK).toBe('USER#user-1');
    expect(link.Item.SK).toBe('SEAT');
    expect(link.Item.seatId).toBe('seat-1');
  });

  it('never uses SK=PROFILE (listUsers scan filter must not see seats)', async () => {
    await putSeat(seat);
    for (const call of send.mock.calls) {
      expect(call[0].input.Item.SK).not.toBe('PROFILE');
    }
  });
});

describe('getSeatForUser', () => {
  it('resolves via the link item then the canonical row', async () => {
    send
      .mockResolvedValueOnce({ Item: { seatId: 'seat-1' } })
      .mockResolvedValueOnce({ Item: seat });
    const out = await getSeatForUser('user-1');
    expect(out?.seatId).toBe('seat-1');
    expect(send.mock.calls[0][0].input.Key).toEqual({ PK: 'USER#user-1', SK: 'SEAT' });
    expect(send.mock.calls[1][0].input.Key).toEqual({ PK: 'SEATS', SK: 'SEAT#seat-1' });
  });

  it('returns null when the user holds no seat', async () => {
    send.mockResolvedValueOnce({});
    expect(await getSeatForUser('user-none')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('listSeats pagination', () => {
  it('queries the SEATS partition and round-trips the cursor', async () => {
    send.mockResolvedValueOnce({
      Items: [seat],
      LastEvaluatedKey: { PK: 'SEATS', SK: 'SEAT#seat-1' },
    });
    const page1 = await listSeats({ limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeDefined();

    send.mockResolvedValueOnce({ Items: [] });
    await listSeats({ cursor: page1.nextCursor });
    const second = send.mock.calls[1][0].input;
    expect(second.ExclusiveStartKey).toEqual({ PK: 'SEATS', SK: 'SEAT#seat-1' });
  });

  it('a garbage cursor restarts the list instead of throwing', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    await expect(listSeats({ cursor: '%%%not-base64json%%%' })).resolves.toEqual({
      items: [],
      nextCursor: undefined,
    });
    expect(send.mock.calls[0][0].input.ExclusiveStartKey).toBeUndefined();
  });
});

describe('seat policies', () => {
  it('writes and lists in the SEAT_POLICIES partition', async () => {
    await putSeatPolicy({
      policyId: 'pol-1',
      label: 'Default',
      allowedModels: ['us.anthropic.claude-haiku-4-5'],
      allowedTools: [],
      createdAt: '2026-07-01T00:00:00.000Z',
      createdBy: 'tester',
      updatedAt: '2026-07-01T00:00:00.000Z',
      updatedBy: 'tester',
    });
    expect(send.mock.calls[0][0].input.Item.PK).toBe('SEAT_POLICIES');
    expect(send.mock.calls[0][0].input.Item.SK).toBe('POLICY#pol-1');

    send.mockResolvedValueOnce({ Items: [] });
    await listSeatPolicies();
    const q = send.mock.calls[1][0].input;
    expect(q.ExpressionAttributeValues[':pk']).toBe('SEAT_POLICIES');
  });
});

describe('seat usage', () => {
  const usage: SeatUsage = {
    usageId: 'u-1',
    seatId: 'seat-1',
    userId: 'user-1',
    model: 'us.anthropic.claude-haiku-4-5',
    inputTokens: 100,
    outputTokens: 20,
    estimatedCostUsd: 0.001,
    policyId: 'pol-1',
    policyOutcome: 'allowed',
    createdAt: '2026-07-01T12:34:56.000Z',
  };

  it('partitions by day with the seatId leading the SK', async () => {
    await putSeatUsage(usage);
    const item = send.mock.calls[0][0].input.Item;
    expect(item.PK).toBe('USAGE#2026-07-01');
    expect(item.SK).toBe('SEAT#seat-1#2026-07-01T12:34:56.000Z#u-1');
  });

  it('org-wide list queries the full day partition newest-first', async () => {
    send.mockResolvedValueOnce({ Items: [usage] });
    const page = await listSeatUsage({ date: '2026-07-01' });
    expect(page.items).toHaveLength(1);
    const q = send.mock.calls[0][0].input;
    expect(q.ExpressionAttributeValues[':pk']).toBe('USAGE#2026-07-01');
    expect(q.ScanIndexForward).toBe(false);
  });

  it('per-seat list is a begins_with KEY CONDITION, not a filter', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    await listSeatUsageForSeat({ date: '2026-07-01', seatId: 'seat-1' });
    const q = send.mock.calls[0][0].input;
    expect(q.KeyConditionExpression).toContain('begins_with(SK, :sk)');
    expect(q.ExpressionAttributeValues[':sk']).toBe('SEAT#seat-1#');
    expect(q.FilterExpression).toBeUndefined();
  });
});

describe('newSeat / patchSeat', () => {
  it('newSeat defaults to active with matching audit stamps', () => {
    const s = newSeat({ seatId: 's', userId: 'u', policyId: 'p', createdBy: 'admin-1' });
    expect(s.status).toBe('active');
    expect(s.createdBy).toBe('admin-1');
    expect(s.updatedBy).toBe('admin-1');
    expect(s.createdAt).toBe(s.updatedAt);
  });

  it('patchSeat changes only status/policy and re-stamps the actor', () => {
    const patched = patchSeat(seat, { status: 'suspended' }, 'admin-2');
    expect(patched.status).toBe('suspended');
    expect(patched.policyId).toBe('pol-1');
    expect(patched.updatedBy).toBe('admin-2');
    expect(patched.createdBy).toBe('tester');
    expect(patched.seatId).toBe('seat-1');
  });
});
