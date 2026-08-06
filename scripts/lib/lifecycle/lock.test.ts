import { describe, it, expect, vi } from 'vitest';
import {
  acquireLock,
  LOCK_PK,
  type LockHandle,
  releaseLock,
  renewLock,
  startHeartbeat,
} from './lock.js';

type AttrValue = { S?: string; N?: string };
type Item = Record<string, AttrValue>;

function ccfe(): Error {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  });
}

/**
 * Stateful fake of the one-item lock table. Implements exactly the condition
 * and update expressions lock.ts uses, so the CAS-takeover and fencing-token
 * semantics are exercised for real instead of stubbed per call.
 */
function fakeLockTable(initial?: Item) {
  let item: Item | undefined = initial;
  const calls: { name: string; input: any }[] = [];

  return {
    get item() {
      return item;
    },
    calls,
    send: async (cmd: any): Promise<any> => {
      const name = cmd.constructor.name as string;
      const input = cmd.input;
      calls.push({ name, input });
      expect(input.Key.pk.S).toBe(LOCK_PK);

      if (name === 'GetItemCommand') {
        return { Item: item };
      }

      if (name === 'UpdateItemCommand') {
        const values = input.ExpressionAttributeValues as Record<string, AttrValue>;
        const cond = input.ConditionExpression as string;
        if (cond.includes('attribute_not_exists(pk)')) {
          // acquire: free table OR expired lease
          const now = Number(values[':now']!.N);
          const free = item === undefined || Number(item.expiresAt!.N) < now;
          if (!free) throw ccfe();
          const prevToken = item ? Number(item.fencingToken!.N) : 0;
          item = {
            pk: { S: LOCK_PK },
            owner: { S: values[':owner']!.S! },
            operation: { S: values[':op']!.S! },
            expiresAt: { N: values[':exp']!.N! },
            acquiredAt: { S: values[':at']!.S! },
            fencingToken: { N: String(prevToken + 1) },
          };
          return { Attributes: item };
        }
        // renew: owner AND token must still match
        const matches =
          item !== undefined &&
          item.owner!.S === values[':owner']!.S &&
          item.fencingToken!.N === values[':ft']!.N;
        if (!matches) throw ccfe();
        item = { ...item!, expiresAt: { N: values[':exp']!.N! } };
        return { Attributes: item };
      }

      if (name === 'DeleteItemCommand') {
        const values = input.ExpressionAttributeValues as Record<string, AttrValue>;
        const matches =
          item !== undefined &&
          item.owner!.S === values[':owner']!.S &&
          item.fencingToken!.N === values[':ft']!.N;
        if (!matches) throw ccfe();
        item = undefined;
        return {};
      }

      throw new Error(`fakeLockTable: unexpected command ${name}`);
    },
  };
}

const TABLE = 'claudeclaw-deploy-lock';

describe('acquireLock', () => {
  it('acquires on an empty table with fencing token 1', async () => {
    const table = fakeLockTable();
    const handle = await acquireLock(table, TABLE, {
      owner: 'alice@laptop',
      operation: 'deploy',
      leaseMs: 60_000,
      now: () => 1_000_000,
    });
    expect(handle).toEqual({
      owner: 'alice@laptop',
      fencingToken: 1,
      expiresAt: 1_060_000,
      leaseMs: 60_000,
    });
    expect(table.item?.operation?.S).toBe('deploy');
  });

  it('second acquire fails, naming the holder, operation, and expiry', async () => {
    const table = fakeLockTable();
    await acquireLock(table, TABLE, {
      owner: 'alice@laptop',
      operation: 'deploy',
      leaseMs: 60_000,
      now: () => 1_000_000,
    });
    await expect(
      acquireLock(table, TABLE, {
        owner: 'bob@ci',
        operation: 'rollback',
        leaseMs: 60_000,
        now: () => 1_030_000,
      }),
    ).rejects.toThrow(/held by "alice@laptop" \(operation: deploy, lease expires 1970-01-01T00:17:40\.000Z\)/);
    expect(table.item?.owner?.S).toBe('alice@laptop');
  });

  it('takes over an EXPIRED lease via CAS and increments the fencing token', async () => {
    const table = fakeLockTable();
    const first = await acquireLock(table, TABLE, {
      owner: 'alice@laptop',
      operation: 'deploy',
      leaseMs: 60_000,
      now: () => 1_000_000,
    });
    expect(first.fencingToken).toBe(1);
    const second = await acquireLock(table, TABLE, {
      owner: 'bob@ci',
      operation: 'deploy',
      leaseMs: 60_000,
      now: () => 1_100_000, // past alice's expiry
    });
    expect(second.fencingToken).toBe(2);
    expect(table.item?.owner?.S).toBe('bob@ci');
  });
});

describe('renewLock', () => {
  it('extends the lease while owner + token match', async () => {
    const table = fakeLockTable();
    const handle = await acquireLock(table, TABLE, {
      owner: 'alice@laptop',
      operation: 'deploy',
      leaseMs: 60_000,
      now: () => 1_000_000,
    });
    const renewed = await renewLock(table, TABLE, handle, () => 1_050_000);
    expect(renewed.expiresAt).toBe(1_110_000);
    expect(table.item?.expiresAt?.N).toBe('1110000');
  });

  it('throws "lock lost" with a stale fencing token', async () => {
    const table = fakeLockTable();
    const stale = await acquireLock(table, TABLE, {
      owner: 'alice@laptop',
      operation: 'deploy',
      leaseMs: 10,
      now: () => 1_000_000,
    });
    await acquireLock(table, TABLE, {
      owner: 'bob@ci',
      operation: 'deploy',
      leaseMs: 60_000,
      now: () => 2_000_000,
    });
    await expect(renewLock(table, TABLE, stale)).rejects.toThrow(/lock lost/);
  });
});

describe('releaseLock', () => {
  it('deletes the item when owner + token match', async () => {
    const table = fakeLockTable();
    const handle = await acquireLock(table, TABLE, {
      owner: 'alice@laptop',
      operation: 'seed',
      leaseMs: 60_000,
    });
    await expect(releaseLock(table, TABLE, handle)).resolves.toBe(true);
    expect(table.item).toBeUndefined();
  });

  it('does NOT throw with a stale token; returns false and leaves the new holder alone', async () => {
    const table = fakeLockTable();
    const stale = await acquireLock(table, TABLE, {
      owner: 'alice@laptop',
      operation: 'deploy',
      leaseMs: 10,
      now: () => 1_000_000,
    });
    await acquireLock(table, TABLE, {
      owner: 'bob@ci',
      operation: 'deploy',
      leaseMs: 60_000,
      now: () => 2_000_000,
    });
    await expect(releaseLock(table, TABLE, stale)).resolves.toBe(false);
    expect(table.item?.owner?.S).toBe('bob@ci');
  });
});

describe('startHeartbeat', () => {
  it('renews on the interval and calls onLost when the lease is gone', async () => {
    vi.useFakeTimers();
    try {
      const table = fakeLockTable();
      const handle: LockHandle = await acquireLock(table, TABLE, {
        owner: 'alice@laptop',
        operation: 'deploy',
        leaseMs: 60_000,
        now: () => 1_000_000,
      });
      const onLost = vi.fn();
      const stop = startHeartbeat(table, TABLE, handle, 1_000, onLost);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(onLost).not.toHaveBeenCalled();

      // Someone takes over (simulating lease expiry mid-run): their clock is
      // far enough ahead of the renewed lease that the CAS condition passes.
      await acquireLock(table, TABLE, {
        owner: 'bob@ci',
        operation: 'deploy',
        leaseMs: 60_000,
        now: () => Date.now() + 600_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(String((onLost.mock.calls[0] as unknown[])[0])).toMatch(/lock lost/);

      // Heartbeat stopped itself; no further renew attempts.
      const callsAfter = table.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(table.calls.length).toBe(callsAfter);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
