/**
 * Strongly-consistent daily-spend ledger (JARVIS-PLAN.md §1b H5 + Reference
 * Contracts B). The cap decision uses THIS ledger, not the 60s-cached
 * getDailyCostUsd() (which several autoscaled tasks would read concurrently and
 * overspend).
 *
 * DynamoDB ConditionExpressions cannot do arithmetic across attributes (no
 * `spent + reserved <= cap`), so the day record carries a maintained
 * `headroom` attribute (= cap − spent − reserved) and every condition is a
 * single `attr >= :v` comparison. Every reservation carries `ownerId` and every
 * mutation is owner-conditioned.
 *
 * Table `claudeclaw-jarvis-ledger`:
 *   - day record   PK=`DAY#<utcDate>`  {cap, spent, reserved, headroom}
 *   - reservation  PK=`RES#<ownerId>`  {ownerId, estimate, settled, expiresAt,
 *                                       utcDate, slotIndex, tokenHash, gpk:'RES'}
 *   - GSI `res-by-expiry` (PK=gpk='RES', SK=expiresAt) for the reaper.
 *
 * This module owns the ledger half of the admission/release transactions and
 * exposes op BUILDERS so `session-leases.ts` can assemble the single
 * all-or-nothing four-operation admission TransactWriteItems.
 */

import {
  PutCommand,
  TransactWriteCommand,
  QueryCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import { logger } from '../../observability/logger.js';

const TABLE = process.env.TABLE_JARVIS_LEDGER ?? 'claudeclaw-jarvis-ledger';
const RES_BY_EXPIRY_GSI = 'res-by-expiry';
const GPK = 'RES'; // constant partition for the reaper GSI

type TxItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export const dayPk = (utcDate: string): string => `DAY#${utcDate}`;
export const resPk = (ownerId: string): string => `RES#${ownerId}`;

/** Current UTC calendar day, YYYY-MM-DD. */
export function utcDate(d: Date = new Date(Date.now())): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Seed the day record (headroom=cap) create-only on first touch of a day. The
 * admission's conditional `headroom >= :est` update needs the item to exist, so
 * this runs before the admission transaction. Idempotent — a
 * ConditionalCheckFailed (already seeded) is swallowed.
 */
export async function ensureDay(date: string, cap: number): Promise<void> {
  try {
    await ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: { PK: dayPk(date), cap, spent: 0, reserved: 0, headroom: cap },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw err;
  }
}

export interface ReserveContext {
  ownerId: string;
  estimate: number;
  expiresAt: number;
  utcDate: string;
  slotIndex: number;
  tokenHash: string;
}

/**
 * The two ledger operations for admission: bump the day aggregate (cond
 * headroom >= estimate) and create the per-session reservation (cond
 * attribute_not_exists). Returned for assembly into the single admission
 * transaction in session-leases.ts.
 */
export function buildReserveOps(ctx: ReserveContext): TxItem[] {
  return [
    {
      Update: {
        TableName: TABLE,
        Key: { PK: dayPk(ctx.utcDate) },
        ConditionExpression: 'headroom >= :est',
        UpdateExpression: 'SET headroom = headroom - :est ADD reserved :est',
        ExpressionAttributeValues: { ':est': ctx.estimate },
      },
    },
    {
      Put: {
        TableName: TABLE,
        Item: {
          PK: resPk(ctx.ownerId),
          ownerId: ctx.ownerId,
          estimate: ctx.estimate,
          settled: 0,
          expiresAt: ctx.expiresAt,
          utcDate: ctx.utcDate,
          slotIndex: ctx.slotIndex,
          tokenHash: ctx.tokenHash,
          gpk: GPK,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
  ];
}

/**
 * The two ledger operations for release: return the unused reservation
 * (`rem = estimate − settled`) to headroom and delete the reservation record,
 * both owner-conditioned. Returned for assembly with the lease deletes.
 */
export function buildReleaseOps(ownerId: string, date: string, rem: number): TxItem[] {
  return [
    {
      Update: {
        TableName: TABLE,
        Key: { PK: dayPk(date) },
        ConditionExpression: 'reserved >= :rem',
        UpdateExpression: 'SET headroom = headroom + :rem, reserved = reserved - :rem',
        ExpressionAttributeValues: { ':rem': rem },
      },
    },
    {
      Delete: {
        TableName: TABLE,
        Key: { PK: resPk(ownerId) },
        ConditionExpression: 'ownerId = :o',
        ExpressionAttributeValues: { ':o': ownerId },
      },
    },
  ];
}

/**
 * Owner-conditioned reservation-expiry renewal, for bundling into the lease
 * heartbeat TransactWriteItems (renews SLOT + TOK + RES together).
 */
export function buildResHeartbeatOp(ownerId: string, newExpiresAt: number): TxItem {
  return {
    Update: {
      TableName: TABLE,
      Key: { PK: resPk(ownerId) },
      ConditionExpression: 'ownerId = :o',
      UpdateExpression: 'SET expiresAt = :e',
      ExpressionAttributeValues: { ':e': newExpiresAt, ':o': ownerId },
    },
  };
}

/** Settle a turn's actual `delta` (moves reserved→spent; headroom unchanged). */
export async function settleTurn(ownerId: string, date: string, delta: number): Promise<void> {
  if (delta <= 0) return;
  await ddb().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { PK: dayPk(date) },
            ConditionExpression: 'reserved >= :d',
            UpdateExpression: 'SET spent = spent + :d, reserved = reserved - :d',
            ExpressionAttributeValues: { ':d': delta },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: { PK: resPk(ownerId) },
            ConditionExpression: 'ownerId = :o',
            UpdateExpression: 'SET settled = settled + :d',
            ExpressionAttributeValues: { ':d': delta, ':o': ownerId },
          },
        },
      ],
    }),
  );
}

/**
 * Top up the reservation when actual spend would exceed the estimate. Returns
 * false when the day cap is reached (the relay closes 4013).
 */
export async function topUp(ownerId: string, date: string, extra: number): Promise<boolean> {
  if (extra <= 0) return true;
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { PK: dayPk(date) },
              ConditionExpression: 'headroom >= :x',
              UpdateExpression: 'SET headroom = headroom - :x ADD reserved :x',
              ExpressionAttributeValues: { ':x': extra },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: { PK: resPk(ownerId) },
              ConditionExpression: 'ownerId = :o',
              UpdateExpression: 'SET estimate = estimate + :x',
              ExpressionAttributeValues: { ':x': extra, ':o': ownerId },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') return false;
    throw err;
  }
}

/**
 * UTC-midnight rollover (Reference Contracts B #1). Before forwarding audio when
 * the live UTC date moved past the cached one, return the remaining reservation
 * to yesterday and re-acquire it against today's ledger, preserving all RES
 * fields. Returns false if today's cap has no headroom (relay closes 4013).
 * Already-settled spend stays on the day it occurred.
 */
export async function rolloverReservation(
  ctx: ReserveContext & { yesterday: string; rem: number },
): Promise<boolean> {
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { PK: dayPk(ctx.yesterday) },
              ConditionExpression: 'reserved >= :rem',
              UpdateExpression: 'SET headroom = headroom + :rem, reserved = reserved - :rem',
              ExpressionAttributeValues: { ':rem': ctx.rem },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: { PK: dayPk(ctx.utcDate) },
              ConditionExpression: 'headroom >= :rem',
              UpdateExpression: 'SET headroom = headroom - :rem ADD reserved :rem',
              ExpressionAttributeValues: { ':rem': ctx.rem },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                PK: resPk(ctx.ownerId),
                ownerId: ctx.ownerId,
                estimate: ctx.rem,
                settled: 0,
                expiresAt: ctx.expiresAt,
                utcDate: ctx.utcDate,
                slotIndex: ctx.slotIndex,
                tokenHash: ctx.tokenHash,
                gpk: GPK,
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') return false;
    throw err;
  }
}

export interface ExpiredReservation {
  ownerId: string;
  utcDate: string;
  estimate: number;
  settled: number;
  slotIndex: number;
  tokenHash: string;
}

/** Query the reaper GSI for reservations whose expiresAt is in the past. */
export async function findExpiredReservations(
  nowSec: number,
  limit = 25,
): Promise<ExpiredReservation[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: RES_BY_EXPIRY_GSI,
      KeyConditionExpression: 'gpk = :g AND expiresAt < :now',
      ExpressionAttributeValues: { ':g': GPK, ':now': nowSec },
      Limit: limit,
    }),
  );
  return (out.Items ?? []).map((i) => ({
    ownerId: String(i.ownerId),
    utcDate: String(i.utcDate),
    estimate: Number(i.estimate ?? 0),
    settled: Number(i.settled ?? 0),
    slotIndex: Number(i.slotIndex ?? -1),
    tokenHash: String(i.tokenHash ?? ''),
  }));
}

/**
 * Reap one expired reservation: return its unspent estimate to headroom and
 * delete the reservation record, owner-conditioned so it never frees a
 * replacement's reservation. Ledger-only — the SLOT/TOK leases self-heal via
 * their `expiresAt < now` acquire condition + TTL GC, and are cleaned
 * best-effort by the reaper Lambda outside this transaction.
 */
export async function reapReservation(r: ExpiredReservation): Promise<void> {
  const rem = Math.max(0, r.estimate - r.settled);
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { PK: dayPk(r.utcDate) },
              ConditionExpression: 'reserved >= :rem',
              UpdateExpression: 'SET headroom = headroom + :rem, reserved = reserved - :rem',
              ExpressionAttributeValues: { ':rem': rem },
            },
          },
          {
            Delete: {
              TableName: TABLE,
              Key: { PK: resPk(r.ownerId) },
              ConditionExpression: 'ownerId = :o',
              ExpressionAttributeValues: { ':o': r.ownerId },
            },
          },
        ],
      }),
    );
  } catch (err) {
    // A replacement that already settled/released this owner, or a concurrent
    // reaper, cancels the transaction — safe to skip.
    if ((err as { name?: string }).name === 'TransactionCanceledException') return;
    logger.warn({ err: err instanceof Error ? err.message : String(err), ownerId: r.ownerId }, 'reap failed');
    throw err;
  }
}
