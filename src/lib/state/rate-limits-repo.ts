/**
 * Rate limits repo — per-user / per-agent request quotas plus a fixed-window
 * counter, backed by the already-provisioned 'claudeclaw-rate-limits' table.
 *
 * Two item families share the table (PK + SK, with a 'ttl' attribute the
 * counter rows use for auto-expiry):
 *
 *   Policy   PK = POLICY#<scope>     SK = LIMIT
 *            scope is 'user', 'agent', 'scheduler', or a specific
 *            'user#<id>' / 'agent#<id>' override. Holds { limit, windowSec }.
 *
 *   Counter  PK = COUNT#<identity>   SK = WINDOW#<windowStartUnix>
 *            holds { count, ttl }. One row per identity per fixed window;
 *            the previous window's row expires on its own via DDB TTL.
 *
 * Policies are cached locally for 30s (CACHE_TTL_MS), mirroring the kill
 * switches / runtime-config repos so a change propagates to every Fargate
 * task within the same window without SNS fanout. Everything fails open: a
 * DDB error on a policy read yields the default policy, and a counter error
 * lets the request through (a DDB blip must never brick the orchestrator).
 */

import { GetCommand, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { logger } from '../../observability/logger.js';
import { publishInvalidation } from '../config/invalidation-publisher.js';

const TABLE = process.env.TABLE_RATE_LIMITS ?? 'claudeclaw-rate-limits';
const CACHE_TTL_MS = 30_000;

/** Built-in fallbacks used when no policy row exists and on DDB read error. */
const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_SEC = 60;

/**
 * Per-scheduler minimum interval (seconds) between recurring task fires. Kept
 * here so scheduled-tasks-repo can read it as a configurable floor; the table
 * homes it under POLICY#scheduler as { limit: <minIntervalSec> }.
 */
export const DEFAULT_SCHEDULER_MIN_INTERVAL_SEC = 60;

export interface RateLimitPolicy {
  /** Max requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Unix millis when the current window resets and the count clears. */
  resetAt: number;
}

interface PolicyCacheEntry {
  policy: RateLimitPolicy;
  expiresAt: number;
}

const policyCache = new Map<string, PolicyCacheEntry>();

function policyPk(scope: string): string {
  return `POLICY#${scope}`;
}

function countPk(identity: string): string {
  return `COUNT#${identity}`;
}

/**
 * Resolve the policy scope for an identity. 'user#<id>' / 'agent#<id>' fall
 * back to the bare 'user' / 'agent' default scope when no override exists.
 */
function defaultScopeFor(scope: string): string | undefined {
  if (scope.startsWith('user#')) return 'user';
  if (scope.startsWith('agent#')) return 'agent';
  return undefined;
}

async function readPolicyRow(scope: string): Promise<RateLimitPolicy | undefined> {
  const out = await ddb().send(
    new GetCommand({ TableName: TABLE, Key: { PK: policyPk(scope), SK: 'LIMIT' } }),
  );
  const item = out.Item as { limit?: number; windowSec?: number } | undefined;
  if (!item || typeof item.limit !== 'number') return undefined;
  return {
    limit: item.limit,
    windowSec: typeof item.windowSec === 'number' ? item.windowSec : DEFAULT_WINDOW_SEC,
  };
}

/**
 * Read the effective policy for a scope. Tries the exact scope, then its
 * default scope ('user'/'agent'), then the built-in default. Cached 30s.
 * Fails open to the built-in default on DDB error.
 */
export async function getPolicy(scope: string): Promise<RateLimitPolicy> {
  const cached = policyCache.get(scope);
  if (cached && cached.expiresAt > Date.now()) return cached.policy;
  try {
    let policy = await readPolicyRow(scope);
    if (!policy) {
      const fallbackScope = defaultScopeFor(scope);
      if (fallbackScope) policy = await readPolicyRow(fallbackScope);
    }
    const resolved = policy ?? { limit: DEFAULT_LIMIT, windowSec: DEFAULT_WINDOW_SEC };
    policyCache.set(scope, { policy: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
    return resolved;
  } catch (err) {
    logger.warn(
      { scope, err: err instanceof Error ? err.message : String(err) },
      'rate-limit policy read failed — failing open to default',
    );
    return cached?.policy ?? { limit: DEFAULT_LIMIT, windowSec: DEFAULT_WINDOW_SEC };
  }
}

/**
 * Write a policy for a scope. Invalidates the local cache for this scope so
 * the writer sees its own change immediately; other tasks pick it up within
 * CACHE_TTL_MS.
 */
export async function setPolicy(
  scope: string,
  policy: RateLimitPolicy,
  opts: { updatedBy: string },
): Promise<void> {
  const limit = Math.max(0, Math.floor(policy.limit));
  const windowSec = Math.max(1, Math.floor(policy.windowSec || DEFAULT_WINDOW_SEC));
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: policyPk(scope),
        SK: 'LIMIT',
        limit,
        windowSec,
        updatedBy: opts.updatedBy,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
  policyCache.delete(scope);
  // Identity-keyed enforced entries (e.g. 'user#abc') derive from the default
  // scope policy, so clear the whole enforced cache on any write. Policy writes
  // are rare admin actions, so the full clear is cheap.
  enforcedCache.clear();
  // Best-effort SNS fanout so peer tasks invalidate immediately instead of
  // waiting out the 30s cache TTL. Never throws; the local clears above are the
  // writer's own invalidation and the 30s poll covers correctness if this fails.
  void publishInvalidation('rate_limit', scope);
}

/**
 * Enforcement-time policy lookup. Unlike getPolicy(), this does NOT fall back
 * to a built-in non-zero default: when an admin has not explicitly set a policy
 * for the scope (or its default scope), it returns limit 0 (unlimited). This
 * keeps per-request rate limiting OFF until an operator opts in, so merging the
 * enforcement path never throttles production by surprise. Fails open.
 */
const enforcedCache = new Map<string, PolicyCacheEntry>();

export async function getEnforcedPolicy(scope: string): Promise<RateLimitPolicy> {
  const cached = enforcedCache.get(scope);
  if (cached && cached.expiresAt > Date.now()) return cached.policy;
  try {
    let policy = await readPolicyRow(scope);
    if (!policy) {
      const fallbackScope = defaultScopeFor(scope);
      if (fallbackScope) policy = await readPolicyRow(fallbackScope);
    }
    const resolved = policy ?? { limit: 0, windowSec: DEFAULT_WINDOW_SEC };
    enforcedCache.set(scope, { policy: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
    return resolved;
  } catch (err) {
    logger.warn(
      { scope, err: err instanceof Error ? err.message : String(err) },
      'rate-limit enforced-policy read failed — failing open to unlimited',
    );
    return cached?.policy ?? { limit: 0, windowSec: DEFAULT_WINDOW_SEC };
  }
}

function windowStart(nowMs: number, windowSec: number): number {
  const windowMs = windowSec * 1000;
  return Math.floor(nowMs / windowMs) * windowMs;
}

/**
 * Atomically increment the fixed-window counter for an identity and decide
 * whether the request is allowed. The DDB ADD on a fresh window row starts at
 * the increment, and the row's ttl auto-expires one window after it resets.
 *
 * Fails open: any DDB error returns allowed=true so a transient blip never
 * blocks live traffic.
 *
 * @param identity stable id of the caller (e.g. 'user#abc' or 'agent#main').
 * @param scope    policy scope to resolve the limit from (defaults to identity).
 */
export async function checkAndConsume(
  identity: string,
  scope: string = identity,
): Promise<RateLimitResult> {
  // Enforcement uses the explicit-only policy: unconfigured scope -> limit 0 ->
  // unlimited, so rate limiting is opt-in. The display/usage path uses
  // getPolicy() (with its sane default) separately.
  const policy = await getEnforcedPolicy(scope);
  const now = Date.now();
  const start = windowStart(now, policy.windowSec);
  const resetAt = start + policy.windowSec * 1000;
  // Keep the row a full extra window past reset so a late read still sees it.
  const ttl = Math.floor(resetAt / 1000) + policy.windowSec;

  if (policy.limit <= 0) {
    // limit 0 disables the quota entirely (unlimited).
    return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetAt };
  }

  try {
    const out = await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: countPk(identity), SK: `WINDOW#${start}` },
        UpdateExpression: 'ADD #c :one SET #ttl = :ttl',
        ExpressionAttributeNames: { '#c': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': ttl },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const count = Number((out.Attributes as { count?: number } | undefined)?.count ?? 1);
    const remaining = Math.max(0, policy.limit - count);
    return { allowed: count <= policy.limit, remaining, resetAt };
  } catch (err) {
    logger.warn(
      { identity, scope, err: err instanceof Error ? err.message : String(err) },
      'rate-limit consume failed — failing open',
    );
    return { allowed: true, remaining: policy.limit, resetAt };
  }
}

/**
 * Strict, fail-CLOSED consume for security-sensitive scopes (auth login /
 * verify / invite). Unlike checkAndConsume (opt-in, fails open), this enforces a
 * built-in `fallback` policy whenever the scope has no seeded policy (or one
 * that resolves to unlimited), and BLOCKS (allowed:false) on any DynamoDB error
 * rather than letting traffic through. This guarantees brute-force / enumeration
 * protection even on a fresh deploy where no policy row has been seeded.
 */
export async function checkAndConsumeStrict(
  identity: string,
  scope: string,
  fallback: RateLimitPolicy,
): Promise<RateLimitResult> {
  const seeded = await getEnforcedPolicy(scope);
  const policy = seeded.limit > 0 ? seeded : fallback;
  const now = Date.now();
  const start = windowStart(now, policy.windowSec);
  const resetAt = start + policy.windowSec * 1000;
  const ttl = Math.floor(resetAt / 1000) + policy.windowSec;
  try {
    const out = await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: countPk(identity), SK: `WINDOW#${start}` },
        UpdateExpression: 'ADD #c :one SET #ttl = :ttl',
        ExpressionAttributeNames: { '#c': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': ttl },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const count = Number((out.Attributes as { count?: number } | undefined)?.count ?? 1);
    const remaining = Math.max(0, policy.limit - count);
    return { allowed: count <= policy.limit, remaining, resetAt };
  } catch (err) {
    logger.warn(
      { identity, scope, err: err instanceof Error ? err.message : String(err) },
      'strict rate-limit consume failed — failing CLOSED',
    );
    return { allowed: false, remaining: 0, resetAt };
  }
}

/**
 * Read the current window usage for an identity without consuming. Returns
 * count 0 on a missing row or DDB error (fail-open / best-effort).
 */
export async function getUsage(
  identity: string,
  scope: string = identity,
): Promise<{ count: number; limit: number; resetAt: number }> {
  const policy = await getPolicy(scope);
  const now = Date.now();
  const start = windowStart(now, policy.windowSec);
  const resetAt = start + policy.windowSec * 1000;
  try {
    const out = await ddb().send(
      new GetCommand({
        TableName: TABLE,
        Key: { PK: countPk(identity), SK: `WINDOW#${start}` },
      }),
    );
    const count = Number((out.Item as { count?: number } | undefined)?.count ?? 0);
    return { count, limit: policy.limit, resetAt };
  } catch (err) {
    logger.warn(
      { identity, scope, err: err instanceof Error ? err.message : String(err) },
      'rate-limit usage read failed — returning zero',
    );
    return { count: 0, limit: policy.limit, resetAt };
  }
}

/** Clear the current window counter for an identity (admin reset). */
export async function resetUsage(identity: string, scope: string = identity): Promise<void> {
  const policy = await getPolicy(scope);
  const start = windowStart(Date.now(), policy.windowSec);
  await ddb().send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: countPk(identity), SK: `WINDOW#${start}` },
    }),
  );
}

/**
 * Configured minimum interval (seconds) between recurring scheduled-task
 * fires. Homed under POLICY#scheduler as { limit: <seconds> }. Falls back to
 * the supplied default (and fails open to it on DDB error).
 */
export async function getSchedulerMinIntervalSec(
  fallback: number = DEFAULT_SCHEDULER_MIN_INTERVAL_SEC,
): Promise<number> {
  try {
    const policy = await getPolicy('scheduler');
    // A non-default policy row sets the floor via its `limit` field.
    if (policy.limit > 0 && policy.limit !== DEFAULT_LIMIT) return policy.limit;
    return fallback;
  } catch {
    return fallback;
  }
}

/** Test/break-glass helper: drop cached policies (one scope or everything). */
export function invalidateRateLimitCache(scope?: string): void {
  if (scope) {
    policyCache.delete(scope);
    // Identity-keyed enforced entries (e.g. 'user#abc') derive from the
    // default-scope policy, so a scoped invalidation must clear the WHOLE
    // enforced cache, mirroring setPolicy's enforcedCache.clear(). A single
    // enforcedCache.delete(scope) would leave derived entries enforcing the
    // old limit on peer tasks for up to the cache TTL.
    enforcedCache.clear();
  } else {
    policyCache.clear();
    enforcedCache.clear();
  }
}
