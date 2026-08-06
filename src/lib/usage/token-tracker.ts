/**
 * Token usage tracker — writes one row per Bedrock call.
 *
 * Schema:
 *   PK = AGENT#<agentId>#DAY#<YYYY-MM-DD>
 *   SK = <isoTime>#<id>
 *   GSI1PK = MODEL#<modelId>          (cross-agent by-model lookups)
 *   GSI1SK = <isoTime>#<id>
 *
 * 30-day TTL. Aggregations are out-of-band; v1 just stores rows.
 */

import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { ddb } from '../state/ddb.js';
import { logger } from '../../observability/logger.js';
import { listKnownAgents } from '../config/agent-loader.js';
import { listAgents } from '../state/agents-repo.js';

const TABLE = process.env.TABLE_TOKEN_USAGE ?? 'claudeclaw-token-usage';
const TTL_DAYS = 30;
const DAILY_TOTAL_CACHE_TTL_MS = 60_000;

interface DailyTotalCacheEntry {
  total: number;
  expiresAt: number;
}
const dailyTotalCache = new Map<string, DailyTotalCacheEntry>();

/** Synthetic agentId Jarvis voice usage rows are stored under so the daily
 * cost aggregation (which walks per-agent PKs) picks them up. */
export const JARVIS_USAGE_AGENT = 'jarvis';

/** Synthetic agentId the Model Playground records its raw model-comparison
 * spend under, so getDailyCostUsd() (which walks per-agent PKs) folds Playground
 * cost into the daily total and the cost cap, just like Jarvis voice. The
 * Playground is not a registered agent, so it needs its own PK in the walk. */
export const PLAYGROUND_USAGE_AGENT = 'playground';

/** Synthetic agentId the grounded Knowledge model test (POST /vectors/answer)
 * records its paid Bedrock spend under, so getDailyCostUsd() folds it into the
 * daily total and the cost cap. Like Playground, it is not a registered agent. */
export const KNOWLEDGE_USAGE_AGENT = 'knowledge';

/**
 * Thrown by getDailyCostUsd({ strict: true }) when the day's spend total cannot
 * be computed completely (the agent partition set could not be enumerated, or a
 * per-partition query failed). Enforcement prechecks catch this and FAIL CLOSED
 * (block the paid call), so a DDB/IAM/throttle failure can no longer hide
 * already-incurred spend and admit calls past the cap. Display reads stay soft
 * (they call getDailyCostUsd() without strict and accept a partial figure).
 */
export class SpendIndeterminateError extends Error {}

/**
 * The authoritative set of usage PK partitions to walk for any cross-agent
 * aggregation: every registered agent plus the synthetic `jarvis` and
 * `playground` partitions, deduped. Jarvis voice cost (stored under
 * AGENT#jarvis#DAY#...) and Playground model-comparison cost (stored under
 * AGENT#playground#DAY#...) live under synthetic PKs because neither is a
 * registered agent, so any "all agents" walk that only iterates
 * listKnownAgents() silently omits them. Use this helper everywhere a daily
 * total or an "all agents" view is computed so the two stay in lockstep.
 */
export async function usageAgentPartitions(): Promise<{
  partitions: string[];
  complete: boolean;
}> {
  // Source the agent set from the DURABLE agents table, not just the in-memory
  // listKnownAgents() cache. The cache starts as built-ins only and hydrates
  // from ACTIVE agents later, so on a cold task it would omit existing custom
  // agents, and it never includes a deactivated agent whose same-day usage rows
  // still count as real spend. listAgents() returns every stored agent row
  // (active and inactive). Union with the built-in known ids (which may have no
  // DB row) and the synthetic jarvis/playground partitions.
  //
  // `complete` is true only when listAgents() succeeded, so the returned set is
  // the authoritative partition list. On a listAgents error we still fall back
  // to the known-agent cache (so display reads degrade rather than throw), but
  // we flag the set INCOMPLETE so an enforcement precheck can tell a partial
  // discovery apart from a full one and fail closed instead of admitting a paid
  // call on a total that silently omits partitions.
  let dbAgentIds: string[] = [];
  let complete = true;
  try {
    dbAgentIds = (await listAgents()).map((a) => a.agentId);
  } catch (err) {
    complete = false;
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'usageAgentPartitions: listAgents failed; falling back to known-agent cache',
    );
  }
  return {
    partitions: [
      ...new Set([
        ...dbAgentIds,
        ...listKnownAgents(),
        JARVIS_USAGE_AGENT,
        PLAYGROUND_USAGE_AGENT,
        KNOWLEDGE_USAGE_AGENT,
      ]),
    ],
    complete,
  };
}

export interface UsageRow {
  agentId: string;
  chatId: string;
  surface: 'telegram' | 'slack' | 'dashboard' | 'system' | 'jarvis';
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  costUsd: number;
  latencyMs: number;
  toolCallCount?: number;
  /** Jarvis voice (Nova Sonic bills per token; seconds are for reporting). */
  audioInputSeconds?: number;
  audioOutputSeconds?: number;
  /** Optional speaker id (Slack user, Telegram chat, etc.). */
  userId?: string;
}

/**
 * Persist a usage row. Returns true on a confirmed write, false on failure, so
 * a caller enforcing a soft cap (e.g. Jarvis text) can stop when spend cannot be
 * confirmed instead of running on past the limit (Codex review). Existing
 * fire-and-forget callers ignore the return.
 */
export async function recordUsage(row: UsageRow): Promise<boolean> {
  const id = randomUUID();
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  const ttl = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
  try {
    await ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `AGENT#${row.agentId}#DAY#${day}`,
          SK: `${ts}#${id}`,
          GSI1PK: `MODEL#${row.modelId}`,
          GSI1SK: `${ts}#${id}`,
          id,
          ts,
          ttl,
          ...row,
        },
      }),
    );
    // Bump cached daily total optimistically so the next call sees the
    // freshest figure without re-querying.
    const cacheKey = day;
    const entry = dailyTotalCache.get(cacheKey);
    if (entry && entry.expiresAt > Date.now()) {
      entry.total += row.costUsd;
    }
    return true;
  } catch (err) {
    logger.warn(
      {
        errMessage: err instanceof Error ? err.message : String(err),
        agentId: row.agentId,
      },
      'usage record write failed',
    );
    return false;
  }
}

/**
 * Sum costUsd across every agent for the given UTC day. Used by the
 * cost_cap_per_day kill switch to short-circuit Bedrock when spend
 * exceeds the cap.
 *
 * Caches a COMPLETE result for 60s. With per-turn writes this means the cap
 * can be exceeded by up to one minute of traffic, which is fine for a
 * soft cap; tighten the TTL if you need a hard ceiling.
 *
 * Failure semantics (Codex review): the total is "complete" only when the agent
 * partition set was fully enumerated AND every per-partition query succeeded. A
 * partial total (a partition that could not be discovered, or a query that
 * threw) understates spend, so:
 *   - an incomplete total is NEVER cached (the next call recomputes instead of
 *     serving a stale partial for 60s);
 *   - with `strict: true`, an incomplete total throws SpendIndeterminateError so
 *     an enforcement precheck FAILS CLOSED (blocks the paid call) rather than
 *     admitting it on an understated figure.
 * Display reads call this without `strict` and accept the partial figure.
 */
export async function getDailyCostUsd(opts?: {
  day?: string;
  strict?: boolean;
}): Promise<number> {
  const targetDay = opts?.day ?? new Date().toISOString().slice(0, 10);
  const cached = dailyTotalCache.get(targetDay);
  if (cached && cached.expiresAt > Date.now()) return cached.total;

  let total = 0;
  // Track whether the figure is trustworthy as a hard ceiling. Starts true;
  // flipped false if the partition set is incomplete OR any partition query
  // throws (both of which would silently understate spend).
  let complete = true;
  // We don't have a per-day-across-agents index, so we walk every
  // registered agent. listKnownAgents() reads from the in-memory agent
  // loader, which includes both built-in agents and any custom agents
  // loaded from S3. The list is small (single digits at v1) and reads
  // are strongly consistent; query results stream cheaply.
  // Walk every registered agent PK plus the synthetic `jarvis` and `playground`
  // PKs so voice cost (surface:'jarvis', stored under AGENT#jarvis#DAY#...) and
  // Playground model-comparison cost (stored under AGENT#playground#DAY#...) are
  // both included in the daily total even though neither is a registered agent.
  const { partitions: agents, complete: partitionsComplete } = await usageAgentPartitions();
  if (!partitionsComplete) complete = false;
  for (const agentId of agents) {
    try {
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const out: {
          Items?: Array<Record<string, unknown>>;
          LastEvaluatedKey?: Record<string, unknown>;
        } = await ddb().send(
          new QueryCommand({
            TableName: TABLE,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': `AGENT#${agentId}#DAY#${targetDay}` },
            ProjectionExpression: 'costUsd',
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );
        for (const item of out.Items ?? []) {
          total += Number(item.costUsd ?? 0);
        }
        exclusiveStartKey = out.LastEvaluatedKey;
      } while (exclusiveStartKey);
    } catch (err) {
      complete = false;
      logger.warn(
        {
          errMessage: err instanceof Error ? err.message : String(err),
          agentId,
          day: targetDay,
        },
        'daily cost query failed',
      );
    }
  }
  if (complete) {
    // Only a complete total is safe to serve for 60s; a partial one would let a
    // transient failure understate spend for the whole cache window.
    dailyTotalCache.set(targetDay, {
      total,
      expiresAt: Date.now() + DAILY_TOTAL_CACHE_TTL_MS,
    });
  } else if (opts?.strict) {
    // Enforcement asked for a trustworthy ceiling and we cannot give one. Fail
    // closed: the caller blocks the paid call.
    throw new SpendIndeterminateError(
      'daily cost total is indeterminate (a usage partition could not be read)',
    );
  }
  return total;
}

export function invalidateDailyCostCache(): void {
  dailyTotalCache.clear();
}

export interface DailyAggregate {
  date: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
}

export async function getUsageByDay(
  agentId: string,
  days: number,
): Promise<DailyAggregate[]> {
  // Sum one day-partition, following pagination (sequential by necessity —
  // each page's ExclusiveStartKey comes from the previous page). A failed
  // partition logs and contributes zeros, preserving the old fail-soft
  // behaviour where a bad day rendered as zero rather than breaking the page.
  const sumPartition = async (
    pk: string,
  ): Promise<{ inputTokens: number; outputTokens: number; costUsd: number; calls: number }> => {
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let calls = 0;
    try {
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const out = await ddb().send(
          new QueryCommand({
            TableName: TABLE,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': pk },
            ProjectionExpression: 'inputTokens, outputTokens, costUsd',
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );
        for (const item of out.Items ?? []) {
          inputTokens += Number(item.inputTokens ?? 0);
          outputTokens += Number(item.outputTokens ?? 0);
          costUsd += Number(item.costUsd ?? 0);
          calls += 1;
        }
        exclusiveStartKey = out.LastEvaluatedKey;
      } while (exclusiveStartKey);
    } catch (err) {
      logger.warn(
        { pk, errMessage: err instanceof Error ? err.message : String(err) },
        'daily aggregate query failed',
      );
    }
    return { inputTokens, outputTokens, costUsd, calls };
  };

  // 'all' walks the same authoritative partition set getDailyCostUsd uses, so
  // the synthetic jarvis/playground partitions are included and the "All
  // Agents" view matches the daily total instead of reporting false zeros for
  // that spend. This is a display read, so an incomplete partition set just
  // degrades coverage; `complete` is ignored here. Fetched ONCE, not per day.
  const agentIds = agentId === 'all'
    ? (await usageAgentPartitions()).partitions
    : [agentId];

  const today = new Date();
  // Fan out every day × agent partition concurrently — this read used to walk
  // them one query at a time (~50 sequential round-trips for the Overview's
  // 7-day all-agents summary, ~550ms of latency) and gated the Overview paint.
  // The SDK's socket pool naturally caps in-flight requests, so no explicit
  // concurrency limiter is needed at this fan-out size.
  const results = await Promise.all(
    Array.from({ length: days }, (_, i) => {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() - i);
      const day = d.toISOString().slice(0, 10);
      return Promise.all(
        agentIds.map((aid) => sumPartition(`AGENT#${aid}#DAY#${day}`)),
      ).then((parts) => ({
        date: day,
        inputTokens: parts.reduce((s, p) => s + p.inputTokens, 0),
        outputTokens: parts.reduce((s, p) => s + p.outputTokens, 0),
        costUsd: parts.reduce((s, p) => s + p.costUsd, 0),
        calls: parts.reduce((s, p) => s + p.calls, 0),
      }));
    }),
  );
  return results.reverse();
}
