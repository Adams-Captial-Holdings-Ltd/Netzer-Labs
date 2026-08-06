/**
 * Integration test: the I3 atomic spend ledger against a REAL DynamoDB
 * (LocalStack), NOT a mocked store.
 *
 * This is the crown jewel of the integration suite. The mocked unit tests
 * can verify the command shapes the ledger emits, but they CANNOT prove the
 * one property the whole design exists for: that DynamoDB's conditional write
 * is genuinely atomic under concurrency, so two autoscaled Fargate tasks can
 * never both pass the `headroom >= :worstCase` admission gate and collectively
 * overspend the cap. Here we fire real concurrent reserves at a real table and
 * assert exactly floor(cap/worstCase) win and the final reserved never exceeds
 * the cap.
 *
 * We also exercise the real settle/release accounting math and the fail-CLOSED
 * contract (store_unavailable, never throw-through to "proceed") against a real
 * endpoint that genuinely cannot be reached.
 *
 * LocalStack coverage note: DynamoDB PutCommand/UpdateCommand/TransactWrite with
 * ConditionExpressions and CancellationReasons are all supported by the
 * community image (localstack/localstack:3.8). We PROBE TransactWrite +
 * conditional cancellation in beforeAll and throw a clear reason if the running
 * image does not return CancellationReasons, because every meaningful assertion
 * below depends on that decode. No assertion is faked when an op is unsupported.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  ensureLocalStack,
  configureLocalAwsEnv,
  createDdbTable,
} from '../../__test-utils__/localstack.js';
import {
  reserve,
  settle,
  release,
  utcDay,
  newReservationId,
  dayPk,
  resPk,
  type LedgerStore,
} from './spend-ledger.js';

const TABLE = 'claudeclaw-integ-spend-ledger';
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

// Built in beforeAll once LocalStack is confirmed up.
let store: LedgerStore;
let rawClient: DynamoDBClient;

/** A real lib-dynamodb DynamoDBDocument pointed at LocalStack, EXACTLY the way
 * dynamoClient() in the helper builds its low-level client. */
function localDoc(): DynamoDBDocument {
  const low = new DynamoDBClient({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  return DynamoDBDocument.from(low, {
    marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  });
}

/** Read the authoritative DAY# item straight from DDB (bypassing the ledger)
 * so assertions check the persisted truth, not the function's return value. */
async function readDay(
  day: string,
): Promise<{ cap: number; spent: number; reserved: number; headroom: number; seq: number } | null> {
  const out = await rawClient.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: { PK: { S: dayPk(day) } },
    }),
  );
  if (!out.Item) return null;
  const n = (k: string): number => Number(out.Item?.[k]?.N ?? '0');
  return {
    cap: n('cap'),
    spent: n('spent'),
    reserved: n('reserved'),
    headroom: n('headroom'),
    seq: n('seq'),
  };
}

/** Read a RES# reservation item directly from DDB. */
async function readRes(
  reservationId: string,
): Promise<{ status: string; worstCase: number; settled: number } | null> {
  const out = await rawClient.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: { PK: { S: resPk(reservationId) } },
    }),
  );
  if (!out.Item) return null;
  return {
    status: out.Item.status?.S ?? '',
    worstCase: Number(out.Item.worstCase?.N ?? '0'),
    settled: Number(out.Item.settled?.N ?? '0'),
  };
}

beforeAll(async () => {
  configureLocalAwsEnv();
  // The module reads TABLE_SPEND_LEDGER for its default, but every call below
  // passes a store with an explicit tableName, so the env is belt-and-braces.
  process.env.TABLE_SPEND_LEDGER = TABLE;

  await ensureLocalStack();

  await createDdbTable({
    name: TABLE,
    partitionKey: { name: 'PK', type: 'S' },
  });

  rawClient = new DynamoDBClient({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  store = { send: (c) => localDoc().send(c as never), tableName: TABLE };

  // PROBE: confirm this LocalStack image actually returns CancellationReasons
  // on a conditionally-canceled TransactWrite. Every concurrency / idempotency
  // assertion below decodes reasons?.[0]/[1] to tell cap_exceeded from an
  // idempotent retry; if the image does not surface them, the ledger cannot
  // distinguish those cases and the tests would be meaningless. Throw with a
  // clear reason (vitest reports beforeAll failure) rather than fake a pass.
  const probeDoc = localDoc();
  const probeDay = '1999-01-01';
  // Seed a probe day item that will FAIL a `headroom >= :w` condition.
  await probeDoc.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: { PK: dayPk(probeDay), headroom: 0, reserved: 0, seq: 0 },
          },
        },
      ],
    }),
  );
  let reasons: Array<{ Code?: string }> | undefined;
  try {
    await probeDoc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { PK: dayPk(probeDay) },
              ConditionExpression: 'headroom >= :w',
              UpdateExpression: 'SET headroom = headroom - :w',
              ExpressionAttributeValues: { ':w': 5 },
            },
          },
        ],
      }),
    );
  } catch (err) {
    reasons = (err as { CancellationReasons?: Array<{ Code?: string }> })
      .CancellationReasons;
  }
  if (!reasons || reasons[0]?.Code !== 'ConditionalCheckFailed') {
    throw new Error(
      'LocalStack at ' +
        ENDPOINT +
        ' did not return CancellationReasons[0].Code=ConditionalCheckFailed on a canceled TransactWrite. ' +
        'The ledger cannot distinguish cap_exceeded from an idempotent retry on this image, so these tests would be meaningless. ' +
        'Probe reasons=' +
        JSON.stringify(reasons) +
        '. Skipping rather than asserting against an unsupported op.',
    );
  }
});

describe('spend-ledger I3 atomic reserve/settle/release (real DynamoDB on LocalStack)', () => {
  it('1. two reserves under cap both succeed and headroom/reserved reflect both', async () => {
    const day = '2030-01-02';
    const r1 = await reserve({
      store,
      day,
      capUsd: 100,
      worstCaseUsd: 30,
      idempotencyKey: 'd1-a',
    });
    const r2 = await reserve({
      store,
      day,
      capUsd: 100,
      worstCaseUsd: 25,
      idempotencyKey: 'd1-b',
    });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok) expect(r1.reservationId).toBe('d1-a');
    if (r2.ok) expect(r2.reservationId).toBe('d1-b');

    const d = await readDay(day);
    expect(d).not.toBeNull();
    // cap - 30 - 25 = 45 headroom; reserved = 55; spent untouched.
    expect(d?.cap).toBe(100);
    expect(d?.reserved).toBe(55);
    expect(d?.headroom).toBe(45);
    expect(d?.spent).toBe(0);
  });

  it('2. a reserve that would breach cap returns cap_exceeded and does NOT move headroom', async () => {
    const day = '2030-01-03';
    // Seed near the ceiling: cap 50, reserve 40 (ok), then ask for 20 (would be 60 > 50).
    const ok = await reserve({
      store,
      day,
      capUsd: 50,
      worstCaseUsd: 40,
      idempotencyKey: 'd2-a',
    });
    expect(ok.ok).toBe(true);

    const before = await readDay(day);
    expect(before?.headroom).toBe(10);
    expect(before?.reserved).toBe(40);

    const breach = await reserve({
      store,
      day,
      capUsd: 50,
      worstCaseUsd: 20,
      idempotencyKey: 'd2-b',
    });
    expect(breach).toEqual({ ok: false, reason: 'cap_exceeded' });

    const after = await readDay(day);
    // Headroom and reserved UNCHANGED by the refused reserve.
    expect(after?.headroom).toBe(10);
    expect(after?.reserved).toBe(40);
    // The refused reserve's reservation record must NOT exist.
    expect(await readRes('d2-b')).toBeNull();
  });

  it('3. CONCURRENCY: exactly floor(cap/worstCase) of N concurrent reserves win, reserved <= cap', async () => {
    const day = '2030-01-04';
    const cap = 10;
    const worstCase = 3;
    const N = 8;
    const expectedWinners = Math.floor(cap / worstCase); // 3

    // Fire N reserves with DISTINCT idempotency keys ALL AT ONCE. They race on
    // the SAME day item's `headroom >= :w` conditional update. Real DDB
    // serializes the conditional writes; only `expectedWinners` can each lower
    // headroom by worstCase without it going negative.
    const results = await Promise.all(
      Array.from({ length: N }, (_unused, i) =>
        reserve({
          store,
          day,
          capUsd: cap,
          worstCaseUsd: worstCase,
          idempotencyKey: `conc-${i}`,
        }),
      ),
    );

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);

    // EXACTLY floor(cap/worstCase) admitted; the rest are clean cap refusals.
    expect(winners.length).toBe(expectedWinners);
    expect(losers.length).toBe(N - expectedWinners);
    for (const l of losers) {
      // No loser may fail-open or fail with store_unavailable here; the store
      // is healthy, so every refusal must be a real cap_exceeded.
      expect(l).toEqual({ ok: false, reason: 'cap_exceeded' });
    }

    // The authoritative invariant: persisted reserved NEVER exceeds the cap.
    // If two reserves had both passed the headroom condition (a torn read), this
    // would be cap + worstCase. It must be exactly expectedWinners * worstCase.
    const d = await readDay(day);
    expect(d?.reserved).toBe(expectedWinners * worstCase); // 9
    expect(d?.reserved).toBeLessThanOrEqual(cap);
    expect(d?.headroom).toBe(cap - expectedWinners * worstCase); // 1
    expect(d?.headroom).toBeGreaterThanOrEqual(0);

    // Exactly the winners left RES# records.
    let resCount = 0;
    for (let i = 0; i < N; i++) {
      if (await readRes(`conc-${i}`)) resCount++;
    }
    expect(resCount).toBe(expectedWinners);
  });

  it('4. idempotent retry: same key twice returns ok both times and charges headroom ONCE', async () => {
    const day = '2030-01-05';
    const key = 'idem-key-xyz';

    const first = await reserve({
      store,
      day,
      capUsd: 100,
      worstCaseUsd: 40,
      idempotencyKey: key,
    });
    const afterFirst = await readDay(day);

    const second = await reserve({
      store,
      day,
      capUsd: 100,
      worstCaseUsd: 40,
      idempotencyKey: key,
    });
    const afterSecond = await readDay(day);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      // Same reservationId both times.
      expect(second.reservationId).toBe(first.reservationId);
    }

    // Headroom was charged exactly ONCE: identical before/after the retry.
    expect(afterFirst?.headroom).toBe(60);
    expect(afterFirst?.reserved).toBe(40);
    expect(afterSecond?.headroom).toBe(60);
    expect(afterSecond?.reserved).toBe(40);
    // seq did NOT advance on the retry (the transaction was canceled, no write).
    expect(afterSecond?.seq).toBe(afterFirst?.seq);
  });

  it('5. settle moves reserved->spent; release returns an unused hold to headroom', async () => {
    const day = '2030-01-06';

    // Reserve worst-case 20 of a 100 cap.
    const held = await reserve({
      store,
      day,
      capUsd: 100,
      worstCaseUsd: 20,
      idempotencyKey: 'settle-1',
    });
    expect(held.ok).toBe(true);
    const afterReserve = await readDay(day);
    expect(afterReserve?.reserved).toBe(20);
    expect(afterReserve?.headroom).toBe(80);
    expect(afterReserve?.spent).toBe(0);

    // Settle for an ACTUAL cost of 12 (under the 20 held). Net: spent += 12,
    // reserved -= 20, headroom += (20 - 12) = +8 => headroom 80 -> 88.
    await settle({ store, day, reservationId: 'settle-1', actualUsd: 12 });
    const afterSettle = await readDay(day);
    expect(afterSettle?.spent).toBe(12);
    expect(afterSettle?.reserved).toBe(0);
    expect(afterSettle?.headroom).toBe(88);
    // Reservation marked settled with the actual recorded.
    const settledRes = await readRes('settle-1');
    expect(settledRes?.status).toBe('settled');
    expect(settledRes?.settled).toBe(12);

    // A second settle (retry) is a no-op; spent must not double-count.
    await settle({ store, day, reservationId: 'settle-1', actualUsd: 12 });
    const afterRetry = await readDay(day);
    expect(afterRetry?.spent).toBe(12);
    expect(afterRetry?.reserved).toBe(0);

    // Now a separate reserve that we RELEASE unused: full hold returns to headroom.
    const rel = await reserve({
      store,
      day,
      capUsd: 100,
      worstCaseUsd: 15,
      idempotencyKey: 'release-1',
    });
    expect(rel.ok).toBe(true);
    const afterHold = await readDay(day);
    expect(afterHold?.reserved).toBe(15);
    expect(afterHold?.headroom).toBe(88 - 15); // 73

    await release({ store, day, reservationId: 'release-1' });
    const afterRelease = await readDay(day);
    // Hold fully returned: reserved back to 0, headroom back up by 15.
    expect(afterRelease?.reserved).toBe(0);
    expect(afterRelease?.headroom).toBe(88);
    // Spent unchanged by a release (no money was spent).
    expect(afterRelease?.spent).toBe(12);
    const releasedRes = await readRes('release-1');
    expect(releasedRes?.status).toBe('released');
  });

  it('6. fail-CLOSED: an unreachable store returns store_unavailable and NEVER throws-through to proceed', async () => {
    // A doc client pointed at a dead endpoint. The seed PutCommand in reserve()
    // hits a connection error (NOT a conditional failure), so the contract is to
    // return { ok:false, reason:'store_unavailable' } rather than throw or admit.
    const deadLow = new DynamoDBClient({
      endpoint: 'http://localhost:1',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    });
    const deadDoc = DynamoDBDocument.from(deadLow);
    const deadStore: LedgerStore = {
      send: (c) => deadDoc.send(c as never),
      tableName: TABLE,
    };

    let threw = false;
    let result: Awaited<ReturnType<typeof reserve>> | undefined;
    try {
      result = await reserve({
        store: deadStore,
        day: utcDay(),
        capUsd: 100,
        worstCaseUsd: 10,
        idempotencyKey: newReservationId(),
      });
    } catch {
      threw = true;
    }

    // The fail-closed invariant: it must NOT throw (a throw could be swallowed by
    // a caller's catch and treated as proceed), and it must NOT admit.
    expect(threw).toBe(false);
    expect(result).toEqual({ ok: false, reason: 'store_unavailable' });
  });
});
