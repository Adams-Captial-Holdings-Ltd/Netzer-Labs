import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));

import { admitSession, heartbeat, releaseSession } from './session-leases.js';

function canceled(codes: string[]): Error {
  return Object.assign(new Error('TransactionCanceledException'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

const OK = 'None';
const FAIL = 'ConditionalCheckFailed';

const base = {
  ownerId: 'owner-1',
  tokenHash: 'tok-hash',
  estimate: 0.02,
  ttlSeconds: 470,
  slotCount: 3,
  cap: 50,
  utcDate: '2026-05-30',
  startIndex: 0,
};

/** Resolve ensureDay (PutCommand) automatically; script the TransactWrite outcomes. */
function scriptTransacts(outcomes: Array<'ok' | Error>): void {
  let i = 0;
  send.mockImplementation(async (cmd: { input?: { TransactItems?: unknown } }) => {
    // Only TransactWrite (the admission) is scripted; ensureDay's Put resolves.
    if (!cmd?.input?.TransactItems) return {};
    const outcome = outcomes[i++];
    if (outcome === 'ok' || outcome === undefined) return {};
    throw outcome;
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function transacts(): Array<{ input: { TransactItems: any[] } }> {
  return send.mock.calls
    .map((c) => c[0] as { input?: { TransactItems?: any[] } })
    .filter((cmd): cmd is { input: { TransactItems: any[] } } => Boolean(cmd?.input?.TransactItems));
}

describe('admitSession — transactional leases (H6)', () => {
  beforeEach(() => send.mockReset());

  it('acquires on the first slot and emits the 4-op admission in order', async () => {
    scriptTransacts(['ok']);
    const r = await admitSession(base);
    expect(r).toMatchObject({ ok: true, slotIndex: 0 });

    const tx = transacts()[0];
    const items = tx.input.TransactItems;
    expect(items).toHaveLength(4);
    expect(items[0].Update.Key.PK).toBe('DAY#2026-05-30'); // ledger headroom
    expect(items[1].Put.Item.PK).toBe('RES#owner-1'); // reservation
    expect(items[2].Put.Item.PK).toBe('SLOT#0'); // global slot
    expect(items[3].Put.Item.PK).toBe('TOK#tok-hash'); // per-token lease
    // owner fencing on the reservation record
    expect(items[1].Put.Item.ownerId).toBe('owner-1');
  });

  it('refuses with spend_cap when the ledger condition fails (terminal, no probe)', async () => {
    scriptTransacts([canceled([FAIL, OK, OK, OK])]);
    const r = await admitSession(base);
    expect(r).toEqual({ ok: false, reason: 'spend_cap' });
    // Only one admission attempt (no slot probing on a cap failure).
    expect(transacts()).toHaveLength(1);
  });

  it('rejects the newcomer with token_conflict when the token lease is held (incumbent untouched)', async () => {
    scriptTransacts([canceled([OK, OK, OK, FAIL])]);
    const r = await admitSession(base);
    expect(r).toEqual({ ok: false, reason: 'token_conflict' });
    expect(transacts()).toHaveLength(1);
  });

  it('probes the next slot when a slot is busy, then acquires', async () => {
    scriptTransacts([canceled([OK, OK, FAIL, OK]), 'ok']);
    const r = await admitSession(base);
    expect(r).toMatchObject({ ok: true, slotIndex: 1 });
    expect(transacts()).toHaveLength(2);
  });

  it('returns slot_full after probing all N slots', async () => {
    scriptTransacts([
      canceled([OK, OK, FAIL, OK]),
      canceled([OK, OK, FAIL, OK]),
      canceled([OK, OK, FAIL, OK]),
    ]);
    const r = await admitSession(base);
    expect(r).toEqual({ ok: false, reason: 'slot_full' });
    expect(transacts()).toHaveLength(3);
  });
});

describe('heartbeat / releaseSession', () => {
  beforeEach(() => send.mockReset());

  it('heartbeat renews slot + token + reservation, returns false if ownership lost', async () => {
    send.mockResolvedValueOnce({});
    expect(await heartbeat({ ownerId: 'o', slotIndex: 0, tokenHash: 't', ttlSeconds: 470 })).toBe(true);
    const tx = send.mock.calls[0][0];
    expect(tx.input.TransactItems).toHaveLength(3);

    send.mockRejectedValueOnce(canceled([FAIL, OK, OK]));
    expect(await heartbeat({ ownerId: 'o', slotIndex: 0, tokenHash: 't', ttlSeconds: 470 })).toBe(false);
  });

  it('release deletes the reservation + both leases owner-conditioned', async () => {
    send.mockResolvedValueOnce({});
    await releaseSession({ ownerId: 'o', slotIndex: 2, tokenHash: 't', utcDate: '2026-05-30', rem: 0.01 });
    const items = send.mock.calls[0][0].input.TransactItems;
    expect(items).toHaveLength(4);
    expect(items[0].Update.Key.PK).toBe('DAY#2026-05-30');
    expect(items[1].Delete.Key.PK).toBe('RES#o');
    expect(items[2].Delete.Key.PK).toBe('SLOT#2');
    expect(items[3].Delete.Key.PK).toBe('TOK#t');
    expect(items[2].Delete.ConditionExpression).toBe('ownerId = :o');
  });

  it('release swallows a cancellation (lease reclaimed after expiry)', async () => {
    send.mockRejectedValueOnce(canceled([OK, OK, FAIL, OK]));
    await expect(
      releaseSession({ ownerId: 'o', slotIndex: 0, tokenHash: 't', utcDate: '2026-05-30', rem: 0 }),
    ).resolves.toBeUndefined();
  });
});
