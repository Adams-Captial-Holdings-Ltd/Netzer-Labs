/**
 * Atomic, key-separated, fail-CLOSED daily spend ledger (invariant I3).
 *
 * This is the PRIMARY Bedrock cap. It is the authoritative, strongly-consistent
 * gate that EVERY paid Bedrock entrypoint (chat, scheduled routines, memory
 * consolidation, war room, image gen) consults BEFORE it spends, across every
 * Fargate task. It deliberately does NOT use the 60s-cached getDailyCostUsd()
 * after-the-fact counter: that read is eventually-consistent and several
 * autoscaled tasks reading it concurrently would each see the same stale total
 * and collectively overspend past the cap. The ledger here closes that race by
 * RESERVING worst-case headroom atomically before the call and SETTLING the
 * actual cost after.
 *
 * Design (mirrors the proven Jarvis ledger in src/lib/jarvis/spend-ledger.ts):
 *   DynamoDB ConditionExpressions cannot do arithmetic across attributes (there
 *   is no `spent + reserved <= cap`), so the single authoritative day item
 *   carries a maintained `headroom` attribute (= cap - spent - reserved) and
 *   every admission decision is ONE `headroom >= :worstCase` comparison. The
 *   conditional update is all-or-nothing: it only lowers headroom (reserves
 *   budget) if doing so keeps the day under cap. There is no read-then-write
 *   window for two tasks to both pass.
 *
 * Fail-CLOSED contract (I3): if the store is unavailable, a condition cannot be
 * evaluated, or any error other than a clean ConditionalCheckFailed is seen,
 * reserve() returns { ok:false, reason:'store_unavailable' } and the caller MUST
 * NOT proceed with the paid call. A monitoring/store outage can never silently
 * downgrade to "spend freely". The ONLY case that admits a call is an explicit
 * conditional success; the ONLY clean refusal is a conditional failure
 * (cap_exceeded). Everything else blocks.
 *
 * Idempotency: every reserve carries an `idempotencyKey`. The reservation item
 * is keyed by that key (RES#<idempotencyKey>) and created attribute_not_exists,
 * so a retried reserve (same key) re-uses the existing reservation instead of
 * double-charging headroom. A retry therefore returns the SAME reservationId and
 * does not move headroom a second time.
 *
 * Table layout (one DDB table, `store.tableName`):
 *   - day record  PK=`DAY#<utcDay>`            {cap, spent, reserved, headroom, seq}
 *   - reservation PK=`RES#<idempotencyKey>`    {idempotencyKey, day, worstCase,
 *                                               settled, status, createdAt}
 *
 * `seq` is a monotonically increasing counter bumped on every mutation of the
 * day item; ledger-integrity.ts signs a record carrying it so a rolled-back or
 * decremented day total is detectable (non-monotonic seq => BLOCK).
 *
 * The `store` is a tiny injectable interface (just `send`, the doc-client shape)
 * so tests mock it without touching the real DynamoDBDocument singleton.
 */

import {
  PutCommand,
  GetCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

/**
 * The smallest reservation we will ever take. A 0-cost (or sign-flipped negative)
 * worst-case estimate is clamped UP to this so the `headroom >= :w` admission
 * conditional is always exercised and cannot silently bypass an already-breached
 * day. It is negligible against any real per-turn cost.
 */
const MIN_RESERVE_USD = 1e-9;

/**
 * Minimal store seam. The real implementation is the @aws-sdk/lib-dynamodb
 * DynamoDBDocument (the `ddb()` singleton in src/lib/state/ddb.ts), whose
 * `.send()` accepts the lib-dynamodb command objects below. Kept narrow so
 * tests pass a `{ send: vi.fn() }` fake without constructing a real client.
 */
export interface LedgerStore {
  send(command: unknown): Promise<unknown>;
  /** The single ledger table. Defaults so a real caller can omit it. */
  tableName?: string;
}

const DEFAULT_TABLE = process.env.TABLE_SPEND_LEDGER ?? 'claudeclaw-spend-ledger';

function tableOf(store: LedgerStore): string {
  return store.tableName ?? DEFAULT_TABLE;
}

export const dayPk = (utcDay: string): string => `DAY#${utcDay}`;
export const resPk = (idempotencyKey: string): string => `RES#${idempotencyKey}`;

/** Current UTC calendar day, YYYY-MM-DD. */
export function utcDay(d: Date = new Date(Date.now())): string {
  return d.toISOString().slice(0, 10);
}

/** True for a clean DynamoDB conditional failure (cap reached / item state). */
function isConditionalFailure(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return (
    name === 'ConditionalCheckFailedException' ||
    name === 'TransactionCanceledException'
  );
}

export interface ReserveArgs {
  store: LedgerStore;
  /** UTC calendar day (YYYY-MM-DD) the spend lands on. */
  day: string;
  /** The day's hard cap in USD. */
  capUsd: number;
  /** Worst-case USD this call could cost (upper-bound estimate). */
  worstCaseUsd: number;
  /**
   * Caller-stable key. A retried reserve with the SAME key never
   * double-charges headroom; it returns the existing reservation.
   */
  idempotencyKey: string;
}

export type ReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: 'cap_exceeded' | 'store_unavailable' };

/**
 * ATOMICALLY reserve worst-case headroom for one paid call. Succeeds only if the
 * day item exists with `headroom >= worstCaseUsd`; on success it lowers headroom
 * and raises reserved by worstCaseUsd in a single all-or-nothing transaction,
 * AND creates the reservation record keyed by idempotencyKey.
 *
 * Returns:
 *   { ok:true, reservationId }            admitted; caller may spend.
 *   { ok:false, reason:'cap_exceeded' }   day would breach cap; do NOT spend.
 *   { ok:false, reason:'store_unavailable' } store/condition could not be
 *                                          evaluated; FAIL CLOSED, do NOT spend.
 *
 * Idempotent: a retry with the same idempotencyKey returns the original
 * reservationId and does not move headroom twice.
 */
export async function reserve(args: ReserveArgs): Promise<ReserveResult> {
  const { store, day, capUsd, worstCaseUsd, idempotencyKey } = args;

  // A non-positive worst case reserves nothing but still needs the day to exist
  // and stay under cap; clamp to a tiny POSITIVE epsilon so the `headroom >= :w`
  // conditional is genuinely exercised and a 0-cost (or sign-flipped negative)
  // estimate cannot bypass an already-breached day (headroom 0 fails `0 >= eps`).
  const reserveUsd = worstCaseUsd > 0 ? worstCaseUsd : MIN_RESERVE_USD;

  // Step 1: ensure the day item exists (headroom = cap), create-only. A retry of
  // any reserve on this day finds it already seeded and the conditional failure
  // is swallowed. Seeding is required before the conditional `headroom >= :w`
  // update below can reference an existing item. Any NON-conditional error here
  // is a store failure => fail closed.
  try {
    await store.send(
      new PutCommand({
        TableName: tableOf(store),
        Item: {
          PK: dayPk(day),
          day,
          cap: capUsd,
          spent: 0,
          reserved: 0,
          headroom: capUsd,
          seq: 0,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if (!isConditionalFailure(err)) {
      // Store unavailable / IAM / throttle while seeding — block.
      return { ok: false, reason: 'store_unavailable' };
    }
    // Conditional failure here just means the day was already seeded — fine.
  }

  const reservationId = idempotencyKey;

  // Step 2: the atomic admission. ONE TransactWriteItems:
  //   (a) lower the day's headroom by worstCase (cond headroom >= worstCase) and
  //       bump reserved + the monotonic seq;
  //   (b) create the reservation record keyed by idempotencyKey, create-only.
  // If the reservation already exists (a retry), the Put's attribute_not_exists
  // condition fails and the WHOLE transaction is canceled, so headroom is NOT
  // moved a second time — exactly the idempotent behavior we want. We then
  // distinguish "already reserved (retry => ok)" from "cap reached" by reading
  // back, but to stay fail-closed and store-light we treat a cancellation whose
  // ONLY failing condition is the reservation-exists check as an idempotent
  // success without re-charging.
  const tx: TransactWriteCommandInput['TransactItems'] = [
    {
      Update: {
        TableName: tableOf(store),
        Key: { PK: dayPk(day) },
        ConditionExpression: 'headroom >= :w',
        UpdateExpression:
          'SET headroom = headroom - :w, reserved = reserved + :w, seq = seq + :one',
        ExpressionAttributeValues: { ':w': reserveUsd, ':one': 1 },
      },
    },
    {
      Put: {
        TableName: tableOf(store),
        Item: {
          PK: resPk(reservationId),
          idempotencyKey,
          day,
          worstCase: reserveUsd,
          settled: 0,
          status: 'reserved',
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
  ];

  try {
    await store.send(new TransactWriteCommand({ TransactItems: tx }));
    return { ok: true, reservationId };
  } catch (err) {
    const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> })
      .CancellationReasons;
    // Decode which leg failed. Index 0 = day headroom condition; index 1 =
    // reservation create-only condition.
    const dayFailed = reasons?.[0]?.Code === 'ConditionalCheckFailed';
    const resExists = reasons?.[1]?.Code === 'ConditionalCheckFailed';

    if (resExists) {
      // Idempotent retry: the reservation already exists, so the ORIGINAL reserve
      // already moved headroom for this key. Return the same id WITHOUT
      // re-charging, REGARDLESS of the day leg. DynamoDB evaluates every leg, so
      // a same-key retry that coincides with the day having since filled to cap
      // reports BOTH legs failed; the day-leg failure is irrelevant here because
      // this key's hold was taken by the original reserve, not by this retry.
      // (Checking `!dayFailed` first would wrongly return cap_exceeded for a call
      // that already holds a valid, paid-for reservation, stranding its headroom.)
      return { ok: true, reservationId };
    }
    if (isConditionalFailure(err) && dayFailed) {
      // The day headroom condition failed and there is no existing reservation:
      // reserving worstCase would breach the cap. Clean refusal.
      return { ok: false, reason: 'cap_exceeded' };
    }
    if (isConditionalFailure(err) && reasons === undefined) {
      // A TransactionCanceledException with no decodable reasons (older clients /
      // partial responses). We cannot prove it was a cap refusal vs. a store
      // problem, so FAIL CLOSED.
      return { ok: false, reason: 'store_unavailable' };
    }
    // Any non-conditional error (throttle, IAM, network, timeout): FAIL CLOSED.
    return { ok: false, reason: 'store_unavailable' };
  }
}

export interface SettleArgs {
  store: LedgerStore;
  day: string;
  reservationId: string;
  /** Actual USD the call cost (>= 0). */
  actualUsd: number;
}

/**
 * Move a reservation from reserved -> spent after the call returns. Monotonic
 * and append-only in spirit: `spent` only ever increases and the reservation is
 * marked settled exactly once (idempotent on `status = 'reserved'`).
 *
 * Headroom net change: the reservation held `worstCase`. We release the held
 * `worstCase` back to headroom and then consume `actualUsd` from it, so the net
 * effect is headroom rises by (worstCase - actualUsd) and `spent` rises by
 * actualUsd. We read the reservation's worstCase from the record to know how
 * much was held.
 *
 * Fail-closed is not relevant here (the spend already happened); settle must
 * eventually succeed, so it surfaces a thrown store error to the caller for
 * retry/alerting rather than silently dropping accounting. A settle for an
 * already-settled reservation (retry) is a no-op.
 */
export async function settle(args: SettleArgs): Promise<void> {
  const { store, day, reservationId, actualUsd } = args;
  const actual = actualUsd > 0 ? actualUsd : 0;

  // Read the held worstCase off the reservation. `worstCase` is written once at
  // reserve() and never mutated afterward, so this read is not racy on the value.
  // If the reservation is already settled/released (a retry) or absent, there is
  // nothing to apply — idempotent no-op.
  const got = (await store.send(
    new GetCommand({ TableName: tableOf(store), Key: { PK: resPk(reservationId) } }),
  )) as { Item?: { worstCase?: number; status?: string } };
  if (!got.Item || got.Item.status !== 'reserved') return;
  const held = Number(got.Item.worstCase ?? 0);
  const delta = held - actual;

  // ONE atomic transaction marks the reservation settled AND applies the day
  // adjustment together. This is the fix for the previous two-Update split: if
  // the day write had failed after the reservation was already marked settled, a
  // retry would early-return and the day adjustment would be lost FOREVER. With a
  // single TransactWriteItems, either BOTH apply or NEITHER does. A concurrent or
  // earlier settle that already flipped the reservation makes the `#st=:reserved`
  // condition fail, cancelling the whole transaction (idempotent no-op) so the
  // day is never double-counted.
  //   spent    += actual
  //   reserved -= held
  //   headroom += (held - actual)
  try {
    await store.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableOf(store),
              Key: { PK: resPk(reservationId) },
              ConditionExpression: '#st = :reserved',
              UpdateExpression: 'SET #st = :settled, settled = :actual',
              ExpressionAttributeNames: { '#st': 'status' },
              ExpressionAttributeValues: { ':reserved': 'reserved', ':settled': 'settled', ':actual': actual },
            },
          },
          {
            Update: {
              TableName: tableOf(store),
              Key: { PK: dayPk(day) },
              ConditionExpression: 'reserved >= :held',
              UpdateExpression:
                'SET spent = spent + :actual, reserved = reserved - :held, headroom = headroom + :delta, seq = seq + :one',
              ExpressionAttributeValues: { ':actual': actual, ':held': held, ':delta': delta, ':one': 1 },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (isConditionalFailure(err)) return; // already settled (retry) / hold gone; idempotent
    throw err;
  }
}

export interface ReleaseArgs {
  store: LedgerStore;
  day: string;
  reservationId: string;
}

/**
 * Release a reservation that was never spent (the call was aborted before any
 * Bedrock spend). Returns the full held worstCase to headroom and marks the
 * reservation released. Idempotent on `status = 'reserved'`. A release after a
 * settle is a no-op (the settle already cleared the hold).
 */
export async function release(args: ReleaseArgs): Promise<void> {
  const { store, day, reservationId } = args;

  // Same atomic shape as settle(): read the immutable held amount, then mark the
  // reservation released and return the hold to headroom in ONE transaction so a
  // retry after a partial failure can neither lose nor double-apply the release.
  const got = (await store.send(
    new GetCommand({ TableName: tableOf(store), Key: { PK: resPk(reservationId) } }),
  )) as { Item?: { worstCase?: number; status?: string } };
  if (!got.Item || got.Item.status !== 'reserved') return; // already settled/released or absent
  const held = Number(got.Item.worstCase ?? 0);

  try {
    await store.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableOf(store),
              Key: { PK: resPk(reservationId) },
              ConditionExpression: '#st = :reserved',
              UpdateExpression: 'SET #st = :released',
              ExpressionAttributeNames: { '#st': 'status' },
              ExpressionAttributeValues: { ':reserved': 'reserved', ':released': 'released' },
            },
          },
          {
            Update: {
              TableName: tableOf(store),
              Key: { PK: dayPk(day) },
              ConditionExpression: 'reserved >= :held',
              UpdateExpression:
                'SET reserved = reserved - :held, headroom = headroom + :held, seq = seq + :one',
              ExpressionAttributeValues: { ':held': held, ':one': 1 },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (isConditionalFailure(err)) return;
    throw err;
  }
}

/**
 * A signed snapshot of the authoritative day item, the unit ledger-integrity.ts
 * signs/verifies. `seq` is the monotonic mutation counter; `spent` only ever
 * rises within a day. A chain of these per day must be strictly non-decreasing
 * in both seq and spent (see verifyChain in ledger-integrity.ts).
 */
export interface LedgerRecord {
  day: string;
  cap: number;
  spent: number;
  reserved: number;
  headroom: number;
  seq: number;
}

/** Convenience: build a fresh reservation id (callers usually pass their own
 * idempotency key, but ad-hoc reserves can use this). */
export function newReservationId(): string {
  return randomUUID();
}
