/**
 * Mandatory deploy lease lock (IaC readiness plan, item 14).
 *
 * EVERY mutating lifecycle path takes this same lock before touching state:
 * local deploy, CodeBuild image deploys, rollback, seed, teardown,
 * maintenance, handover, update. A second operation refuses to start and
 * names the current holder. The lock is a single DynamoDB item with a lease:
 *
 *  - acquisition is a conditional write that also TAKES OVER an expired
 *    lease (`expiresAt < now` CAS), so a crashed deploy never wedges the
 *    pipeline;
 *  - a HEARTBEAT renews the lease so a long CDK deploy never outlives it;
 *  - a FENCING TOKEN increases monotonically across acquisitions and is
 *    stamped on every journal/manifest write, so a holder that lost its
 *    lease (paused process, clock skew) cannot clobber the new holder's
 *    state even if it wakes up and keeps writing.
 *
 * Clients are injected as a minimal `{ send }` interface so unit tests can
 * fake DynamoDB; production passes a real DynamoDBClient.
 */

import {
  DeleteItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

/** Minimal AWS SDK v3 client shape; lets tests inject a fake. */
export interface AwsClientLike {
  send(cmd: any): Promise<any>;
}

/** The lock table holds exactly one item under this partition key. */
export const LOCK_PK = 'deploy-lock';

export type LockOperation =
  | 'deploy'
  | 'rollback'
  | 'seed'
  | 'teardown'
  | 'maintenance'
  | 'handover'
  | 'update';

export interface LockHandle {
  owner: string;
  /** Monotonic across acquisitions; stamp it on every journal/manifest write. */
  fencingToken: number;
  /** Epoch ms when the lease lapses unless renewed. */
  expiresAt: number;
  /** Lease duration, used by renewals to extend from "now". */
  leaseMs: number;
}

export interface AcquireLockOptions {
  owner: string;
  operation: LockOperation;
  leaseMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

/**
 * Acquire the lock, or take over an expired lease. Throws an error naming
 * the current holder, their operation, and the lease expiry when the lock
 * is genuinely held.
 */
export async function acquireLock(
  client: AwsClientLike,
  table: string,
  opts: AcquireLockOptions,
): Promise<LockHandle> {
  const now = (opts.now ?? Date.now)();
  const expiresAt = now + opts.leaseMs;
  try {
    const res = await client.send(
      new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: LOCK_PK } },
        // Free table OR expired lease. The fencing token always increments,
        // even on takeover, so a stale holder's token never matches again.
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
        UpdateExpression:
          'SET #owner = :owner, #op = :op, expiresAt = :exp, acquiredAt = :at, ' +
          'fencingToken = if_not_exists(fencingToken, :zero) + :one',
        ExpressionAttributeNames: { '#owner': 'owner', '#op': 'operation' },
        ExpressionAttributeValues: {
          ':now': { N: String(now) },
          ':owner': { S: opts.owner },
          ':op': { S: opts.operation },
          ':exp': { N: String(expiresAt) },
          ':at': { S: new Date(now).toISOString() },
          ':zero': { N: '0' },
          ':one': { N: '1' },
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    const attrs = (res?.Attributes ?? {}) as Record<string, { N?: string; S?: string }>;
    return {
      owner: opts.owner,
      fencingToken: Number(attrs.fencingToken?.N ?? '1'),
      expiresAt: Number(attrs.expiresAt?.N ?? String(expiresAt)),
      leaseMs: opts.leaseMs,
    };
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
    // Name the holder so the second operator knows who to talk to.
    const current = await client.send(
      new GetItemCommand({ TableName: table, Key: { pk: { S: LOCK_PK } }, ConsistentRead: true }),
    );
    const item = (current?.Item ?? {}) as Record<string, { N?: string; S?: string }>;
    const holder = item.owner?.S ?? 'unknown';
    const operation = item.operation?.S ?? 'unknown';
    const expiry = item.expiresAt?.N ? new Date(Number(item.expiresAt.N)).toISOString() : 'unknown';
    throw new Error(
      `deploy lock is held by "${holder}" (operation: ${operation}, lease expires ${expiry}); ` +
        'refusing to start a concurrent mutating operation. Wait for the lease to lapse or for the holder to finish.',
    );
  }
}

/**
 * Heartbeat renewal: extend the lease ONLY while we still hold it (owner and
 * fencing token both still match). Anything else means the lease lapsed and
 * someone took over; the caller must stop mutating immediately.
 */
export async function renewLock(
  client: AwsClientLike,
  table: string,
  handle: LockHandle,
  now: () => number = Date.now,
): Promise<LockHandle> {
  const at = now();
  const expiresAt = at + handle.leaseMs;
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: LOCK_PK } },
        ConditionExpression: '#owner = :owner AND fencingToken = :ft',
        UpdateExpression: 'SET expiresAt = :exp',
        ExpressionAttributeNames: { '#owner': 'owner' },
        ExpressionAttributeValues: {
          ':owner': { S: handle.owner },
          ':ft': { N: String(handle.fencingToken) },
          ':exp': { N: String(expiresAt) },
        },
      }),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new Error(
        `lock lost: owner "${handle.owner}" with fencing token ${handle.fencingToken} no longer holds ` +
          'the deploy lock (lease expired and was taken over). Abort all mutating work now.',
      );
    }
    throw err;
  }
  return { ...handle, expiresAt };
}

/**
 * Keep the lease alive for the duration of a long operation. Returns a
 * stop() function. Renewal failures are never swallowed: the interval stops
 * and `onLost` fires so the operation can abort.
 */
export function startHeartbeat(
  client: AwsClientLike,
  table: string,
  handle: LockHandle,
  intervalMs: number,
  onLost: (err: unknown) => void,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    void renewLock(client, table, handle)
      .then((renewed) => {
        handle.expiresAt = renewed.expiresAt;
      })
      .catch((err: unknown) => {
        if (stopped) return;
        stop();
        onLost(err);
      });
  }, intervalMs);
  // Never keep the process alive just for the heartbeat.
  (timer as { unref?: () => void }).unref?.();
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}

/**
 * Release the lock if we still hold it. Losing the owner/token condition is
 * NOT an error to throw past: it means the lease expired and someone else
 * took over, and their fencing token already protects state. Returns false
 * in that case so callers can log it.
 */
export async function releaseLock(
  client: AwsClientLike,
  table: string,
  handle: LockHandle,
): Promise<boolean> {
  try {
    await client.send(
      new DeleteItemCommand({
        TableName: table,
        Key: { pk: { S: LOCK_PK } },
        ConditionExpression: '#owner = :owner AND fencingToken = :ft',
        ExpressionAttributeNames: { '#owner': 'owner' },
        ExpressionAttributeValues: {
          ':owner': { S: handle.owner },
          ':ft': { N: String(handle.fencingToken) },
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}
