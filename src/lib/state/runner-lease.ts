/**
 * Single-runner lease for periodic background loops (Afroz review H6).
 *
 * The orchestrator autoscales to N Fargate tasks, and every task starts the
 * same in-process loops (synthetic canary, webhook monitor). Without a
 * leader, each tick runs N-way: N paid canary turns, N duplicate audit rows,
 * N duplicate alert messages. Each loop's tick now acquires a named lease
 * first and skips when another task holds it.
 *
 * One item per loop in the queue-lease table (already provisioned; leases
 * are exactly its purpose):
 *
 *   PK = RUNNER#<name>   { holderId, expiresAt (ms), ttl (sec, DDB cleanup) }
 *
 * The acquire is ONE conditional put: it succeeds when the lease is absent,
 * expired, or already ours (renewal). There is no separate read, so two
 * tasks racing the same expired lease cannot both win.
 *
 * FAIL-OPEN by design: on a store error the caller is told to run. These are
 * monitoring loops — a lease-store blip must degrade to "briefly duplicated
 * monitoring" (bounded: canary spend rides the ledger cap), never to "all
 * tasks silently stop monitoring". This is the opposite polarity from the
 * spend ledger, and deliberate.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { logger } from '../../observability/logger.js';

const TABLE = process.env.TABLE_QUEUE_LEASE ?? 'claudeclaw-queue-lease';

/** Stable per-process holder id (task identity for the life of the process). */
export const RUNNER_HOLDER_ID = `${hostname()}#${process.pid}#${randomUUID().slice(0, 8)}`;

export interface RunnerLeaseArgs {
  /** Loop name, e.g. 'canary' or 'webhook-monitor'. */
  name: string;
  /** Lease duration; pick comfortably above the loop interval so a healthy
   * holder renews before expiry, and a dead holder frees the loop within
   * one lease period. */
  ttlMs: number;
  /** Injectable for tests. */
  holderId?: string;
  now?: number;
}

/**
 * True when THIS process holds the lease for `name` (fresh acquire, renewal,
 * or takeover of an expired lease). False when another live holder has it.
 * True with a warn log on a store error (fail-open, see module doc).
 */
export async function tryAcquireRunnerLease(args: RunnerLeaseArgs): Promise<boolean> {
  const holderId = args.holderId ?? RUNNER_HOLDER_ID;
  const now = args.now ?? Date.now();
  const expiresAt = now + args.ttlMs;
  try {
    await ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `RUNNER#${args.name}`,
          holderId,
          expiresAt,
          // DDB TTL cleanup well after logical expiry; correctness never
          // depends on the sweeper, only on the expiresAt comparison below.
          ttl: Math.floor(expiresAt / 1000) + 3600,
        },
        ConditionExpression:
          'attribute_not_exists(PK) OR expiresAt <= :now OR holderId = :me',
        ExpressionAttributeValues: { ':now': now, ':me': holderId },
      }),
    );
    return true;
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'ConditionalCheckFailedException') return false;
    logger.warn(
      {
        errMessage: err instanceof Error ? err.message : String(err),
        lease: args.name,
      },
      'runner lease store error; running anyway (fail-open for monitoring)',
    );
    return true;
  }
}
