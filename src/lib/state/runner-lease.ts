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
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
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

/**
 * ONE-SHOT CLAIM on the same table: true the FIRST time a key is seen, false
 * every time after. This is the durable half of "a duplicate `(runId, issueId)`
 * dispatch is a no-op" — a module-level `Set` cannot satisfy it, because the
 * orchestrator autoscales and the two deliveries can land on two Fargate tasks.
 *
 * NOT `tryAcquireRunnerLease`. That one's condition includes
 * `OR holderId = :me`, which is exactly right for a renewal and exactly wrong
 * here: the second delivery of the same dispatch to the SAME task would renew
 * its own lease and be told to run. The condition below is
 * `attribute_not_exists(PK)` and nothing else, so a re-put always loses.
 *
 * NO NEW TABLE, AND THAT IS DELIBERATE. The queue-lease table is already
 * provisioned and already injected as `TABLE_QUEUE_LEASE`
 * (`infra/lib/compute-stack.ts`); adding an idempotency table would make this
 * phase a full `npm run deploy` rather than an image-only `deploy:cloud`.
 * `ttlSeconds` is a real expiry: a key is remembered for that long and no
 * longer, so this suppresses a retry storm, not a redelivery a week later.
 *
 * FAIL-OPEN on a store error, matching this module's stated polarity: a
 * lease-store blip degrades to "briefly duplicated work" (bounded by the spend
 * ledger's daily cap), never to "inbound work is silently dropped".
 */
export async function tryClaimOnce(key: string, ttlSeconds: number): Promise<boolean> {
  const now = Date.now();
  try {
    await ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `CLAIM#${key}`,
          claimedAt: now,
          ttl: Math.floor(now / 1000) + ttlSeconds,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    return true;
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'ConditionalCheckFailedException') return false;
    logger.warn(
      {
        errMessage: err instanceof Error ? err.message : String(err),
        claim: key,
      },
      'claim store error; treating as unclaimed (fail-open)',
    );
    return true;
  }
}

/**
 * DROPS a claim `tryClaimOnce` took, so the same key can be claimed again
 * before its ttl would have expired.
 *
 * This exists because a one-shot claim taken BEFORE the work runs is a promise
 * the work has to keep. A caller that claims, then fails transiently, has
 * suppressed every redelivery of that key for the whole ttl while having
 * produced nothing — the claim stops being dedupe and starts being silent loss.
 * Releasing on the failure path is what makes the claim mean "this key is being
 * worked on or is done" rather than "this key was once seen".
 *
 * NEVER THROWS AND NEVER REPORTS. There is nothing a caller could do with the
 * outcome: the release runs on a path that is already failing, and a failed
 * release degrades to exactly the behaviour that existed before this function
 * — the key stays claimed until its ttl expires. It is logged at warn because a
 * PERSISTENT release failure is the difference between at-least-once and
 * at-most-once delivery, and that is worth seeing.
 *
 * The delete is UNCONDITIONAL on purpose. A conditional delete would need to
 * name a holder, and `tryClaimOnce` deliberately writes no holder id (see its
 * doc); the only writer of `CLAIM#<key>` is the claim this releases.
 */
export async function releaseClaimOnce(key: string): Promise<void> {
  try {
    await ddb().send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `CLAIM#${key}` },
      }),
    );
  } catch (err) {
    logger.warn(
      {
        errMessage: err instanceof Error ? err.message : String(err),
        claim: key,
      },
      'claim release failed; the key stays claimed until its ttl expires and a redelivery will be deduplicated',
    );
  }
}
