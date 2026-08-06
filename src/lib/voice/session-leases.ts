/**
 * Transactional concurrency leases (JARVIS-PLAN.md §1b H6 + Reference Contracts
 * B). An in-process Map cannot cap a service that autoscales to ~20 Fargate
 * tasks (real cap = tasks × limit), so the authority is DynamoDB conditional-
 * write leases. ONE TransactWriteItems acquires together — all-or-nothing —
 *   (1) the daily-spend reservation (the two ledger ops, H5),
 *   (2) a global slot (one of N fixed items), and
 *   (3) the per-token lease,
 * each owner-fenced. The session heartbeats to renew `expiresAt` (the
 * correctness mechanism); TTL is GC only. Release is owner-conditioned so stale
 * cleanup never frees a live replacement's slot.
 *
 * Table `claudeclaw-jarvis-leases`: PK=`SLOT#<i>` (i in 0..N-1) | `TOK#<hash>`,
 * attrs {ownerId, expiresAt}, TTL=`expiresAt` (GC only).
 *
 * Slot probing (Reference Contracts B #5): random start index, probe ≤ N slots;
 * a SLOT-item conditional failure → next index; a TOKEN failure → reject the
 * newcomer 4000 (no probe); a LEDGER failure → 4013; all N exhausted →
 * saturation (HTTP 503).
 */

import { TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import {
  ensureDay,
  buildReserveOps,
  buildReleaseOps,
  buildResHeartbeatOp,
} from '../jarvis/spend-ledger.js';

const TABLE = process.env.TABLE_JARVIS_LEASES ?? 'claudeclaw-jarvis-leases';

type TxItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export const slotPk = (i: number): string => `SLOT#${i}`;
export const tokPk = (tokenHash: string): string => `TOK#${tokenHash}`;

const nowSec = (): number => Math.floor(Date.now() / 1000);

interface CanceledError {
  name?: string;
  CancellationReasons?: Array<{ Code?: string }>;
}

function leasePutOp(pk: string, ownerId: string, expiresAt: number): TxItem {
  return {
    Put: {
      TableName: TABLE,
      Item: { PK: pk, ownerId, expiresAt },
      // attribute_not_exists OR expired — lets a newcomer reclaim a dead lease.
      ConditionExpression: 'attribute_not_exists(PK) OR expiresAt < :now',
      ExpressionAttributeValues: { ':now': nowSec() },
    },
  };
}

function leaseDeleteOp(pk: string, ownerId: string): TxItem {
  return {
    Delete: {
      TableName: TABLE,
      Key: { PK: pk },
      ConditionExpression: 'ownerId = :o',
      ExpressionAttributeValues: { ':o': ownerId },
    },
  };
}

export interface AdmitContext {
  ownerId: string;
  tokenHash: string;
  estimate: number;
  ttlSeconds: number;
  slotCount: number;
  cap: number;
  utcDate: string;
  /** Deterministic probe start for tests; otherwise a random slot. */
  startIndex?: number;
}

export type AdmitResult =
  | { ok: true; slotIndex: number; expiresAt: number }
  | { ok: false; reason: 'spend_cap' | 'token_conflict' | 'slot_full' };

/**
 * The single all-or-nothing admission. Returns the acquired slot index and the
 * lease expiry on success; a typed reason on refusal. Nothing is partially held
 * — a lease conflict leaves the reserved budget untouched (both-or-neither).
 */
export async function admitSession(ctx: AdmitContext): Promise<AdmitResult> {
  await ensureDay(ctx.utcDate, ctx.cap);
  const expiresAt = nowSec() + ctx.ttlSeconds;
  const start = ((ctx.startIndex ?? Math.floor(Math.random() * ctx.slotCount)) % ctx.slotCount + ctx.slotCount) % ctx.slotCount;

  for (let k = 0; k < ctx.slotCount; k++) {
    const slotIndex = (start + k) % ctx.slotCount;
    // Order is significant — CancellationReasons aligns to TransactItems:
    // [0]=DAY update, [1]=RES put, [2]=SLOT put, [3]=TOK put.
    const items: TxItem[] = [
      ...buildReserveOps({
        ownerId: ctx.ownerId,
        estimate: ctx.estimate,
        expiresAt,
        utcDate: ctx.utcDate,
        slotIndex,
        tokenHash: ctx.tokenHash,
      }),
      leasePutOp(slotPk(slotIndex), ctx.ownerId, expiresAt),
      leasePutOp(tokPk(ctx.tokenHash), ctx.ownerId, expiresAt),
    ];
    try {
      await ddb().send(new TransactWriteCommand({ TransactItems: items }));
      return { ok: true, slotIndex, expiresAt };
    } catch (err) {
      const e = err as CanceledError;
      if (e.name !== 'TransactionCanceledException') throw err;
      const reasons = e.CancellationReasons ?? [];
      const failed = (idx: number) => reasons[idx]?.Code === 'ConditionalCheckFailed';
      // Priority: spend cap and token conflict are terminal (no probe).
      if (failed(0)) return { ok: false, reason: 'spend_cap' };
      if (failed(3)) return { ok: false, reason: 'token_conflict' };
      if (failed(2)) continue; // this slot is taken — probe the next
      // RES (1) failing means this ownerId already has a reservation — caller bug.
      throw err;
    }
  }
  return { ok: false, reason: 'slot_full' };
}

/**
 * Renew the slot, token lease, AND the spend reservation together, all
 * owner-conditioned. A renewal that fails (the session lost ownership) signals
 * the caller to tear down.
 */
export async function heartbeat(opts: {
  ownerId: string;
  slotIndex: number;
  tokenHash: string;
  ttlSeconds: number;
}): Promise<boolean> {
  const expiresAt = nowSec() + opts.ttlSeconds;
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { PK: slotPk(opts.slotIndex) },
              ConditionExpression: 'ownerId = :o',
              UpdateExpression: 'SET expiresAt = :e',
              ExpressionAttributeValues: { ':e': expiresAt, ':o': opts.ownerId },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: { PK: tokPk(opts.tokenHash) },
              ConditionExpression: 'ownerId = :o',
              UpdateExpression: 'SET expiresAt = :e',
              ExpressionAttributeValues: { ':e': expiresAt, ':o': opts.ownerId },
            },
          },
          buildResHeartbeatOp(opts.ownerId, expiresAt),
        ],
      }),
    );
    return true;
  } catch (err) {
    if ((err as CanceledError).name === 'TransactionCanceledException') return false;
    throw err;
  }
}

/**
 * Owner-conditioned release on close/abort: return the unused reservation to
 * headroom, delete the reservation record, and free the slot + token lease —
 * all-or-nothing. The session still owns its leases here, so the conditions
 * pass; a crashed session is reclaimed by the reaper (ledger) + lease TTL.
 */
export async function releaseSession(opts: {
  ownerId: string;
  slotIndex: number;
  tokenHash: string;
  utcDate: string;
  rem: number;
}): Promise<void> {
  const items: TxItem[] = [
    ...buildReleaseOps(opts.ownerId, opts.utcDate, Math.max(0, opts.rem)),
    leaseDeleteOp(slotPk(opts.slotIndex), opts.ownerId),
    leaseDeleteOp(tokPk(opts.tokenHash), opts.ownerId),
  ];
  try {
    await ddb().send(new TransactWriteCommand({ TransactItems: items }));
  } catch (err) {
    // Owner already lost the lease (reclaimed by a newcomer after expiry) — the
    // reaper + TTL handle the ledger/lease remainder. Do not throw on close.
    if ((err as CanceledError).name === 'TransactionCanceledException') return;
    throw err;
  }
}
