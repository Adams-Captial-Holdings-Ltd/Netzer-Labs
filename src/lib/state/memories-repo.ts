/**
 * Memories repo — per-chat long-term recall.
 *
 * Schema:
 *   PK = AGENT#<agentId>
 *   SK = MEM#<chatId>#<isoTime>#<id>
 *   GSI1PK = AGENT#<agentId>           (for top-by-importance scans)
 *   GSI1SK = IMP#<padded>#<isoTime>
 *
 * Scope: each chat has its own memory namespace within an agent. Cross-
 * chat sharing happens later through a separate `hive_mind` table.
 *
 * Importance: 0-100. 50 default. Higher values bubble to the top of
 * the system-prompt injection window.
 */

import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { logger } from '../../observability/logger.js';

const TABLE = process.env.TABLE_MEMORIES ?? 'claudeclaw-memories';

export interface Memory {
  id: string;
  agentId: string;
  chatId: string;
  content: string;
  tags: string[];
  importance: number;
  source: 'user' | 'agent' | 'ingest';
  createdAt: string;
  /** Speaker id at the time the memory was saved (for multi-user channels). */
  userId?: string;
}

interface MemoryItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK?: string;
  GSI2SK?: string;
  id: string;
  chatId: string;
  content: string;
  tags: string[];
  importance: number;
  source: 'user' | 'agent' | 'ingest';
  createdAt: string;
  userId?: string;
  consolidated?: number;
  claimedBy?: string;
  claimedAt?: string;
}

function pad(n: number): string {
  return String(Math.max(0, Math.min(100, Math.round(n)))).padStart(3, '0');
}

export async function addMemory(args: {
  agentId: string;
  chatId: string;
  content: string;
  tags?: string[];
  importance?: number;
  source?: 'user' | 'agent' | 'ingest';
  userId?: string;
}): Promise<Memory> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const importance = args.importance ?? 50;
  const item: MemoryItem = {
    PK: `AGENT#${args.agentId}`,
    SK: `MEM#${args.chatId}#${createdAt}#${id}`,
    GSI1PK: `AGENT#${args.agentId}`,
    GSI1SK: `IMP#${pad(importance)}#${createdAt}`,
    GSI2PK: `AGENT#${args.agentId}`,
    GSI2SK: `UNCON#${args.chatId}#${createdAt}#${id}`,
    id,
    chatId: args.chatId,
    content: args.content,
    tags: args.tags ?? [],
    importance,
    source: args.source ?? 'user',
    createdAt,
    consolidated: 0,
    ...(args.userId ? { userId: args.userId } : {}),
  };
  await ddb().send(new PutCommand({ TableName: TABLE, Item: item }));
  return {
    id,
    agentId: args.agentId,
    chatId: args.chatId,
    content: args.content,
    tags: item.tags,
    importance,
    source: item.source,
    createdAt,
    ...(args.userId ? { userId: args.userId } : {}),
  };
}

export async function listMemoriesForChat(
  agentId: string,
  chatId: string,
  limit = 50,
): Promise<Memory[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `AGENT#${agentId}`,
        ':sk': `MEM#${chatId}#`,
      },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (out.Items ?? []).map((i) => toMemory(agentId, i as MemoryItem));
}

/**
 * Runaway backstop for listMemoriesForAgent. It pages through ALL of an agent's
 * memories (see below) to find the true newest; this cap only guards a
 * pathological agent from an unbounded scan. Set well above any realistic
 * per-agent memory count, and a warning is logged if it is ever hit.
 */
const AGENT_MEMORY_SCAN_CAP = 5000;

/**
 * List an agent's memories across ALL of its chats. Memories partition by
 * AGENT#<agentId> with SK MEM#<chatId>#<isoTime>#<id>, so a begins_with(SK,
 * 'MEM#') query (no chat scope) returns the agent's whole memory namespace.
 *
 * The SK sorts by chatId first, so a DDB-side `Limit` (or stopping early) would
 * slice by chatId order BEFORE recency is considered, dropping recent memories
 * that live under lexicographically-lower chatIds. There is no GSI keyed on
 * createdAt across all chats, so to return the true newest `limit` we page
 * through EVERY matching MEM# row, THEN sort by createdAt desc and slice. The
 * AGENT_MEMORY_SCAN_CAP backstop only trips for a pathological agent (far above
 * realistic volumes); if it does, we log a warning and the result is the newest
 * within the scanned prefix rather than guaranteed global-newest. Used by the
 * per-agent Memories tab, which has no single chat to scope to.
 */
export async function listMemoriesForAgent(
  agentId: string,
  limit = 50,
): Promise<Memory[]> {
  const items: MemoryItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `AGENT#${agentId}`,
          ':sk': 'MEM#',
        },
        ScanIndexForward: false,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((out.Items ?? []) as MemoryItem[]));
    exclusiveStartKey = out.LastEvaluatedKey;
  } while (exclusiveStartKey && items.length < AGENT_MEMORY_SCAN_CAP);

  if (exclusiveStartKey) {
    // The backstop tripped before we exhausted the partition: the returned list
    // is the newest within the scanned prefix, not guaranteed global-newest.
    logger.warn(
      { agentId, scanned: items.length, cap: AGENT_MEMORY_SCAN_CAP },
      'listMemoriesForAgent hit the scan cap; result may omit memories beyond the cap',
    );
  }

  return items
    .map((i) => toMemory(agentId, i))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/**
 * Half-life (days) for read-time importance decay. A memory's *stored*
 * importance is never mutated; we only down-weight it for ranking as it ages
 * so stale facts stop sitting permanently at the top of the prompt window.
 */
const IMPORTANCE_HALF_LIFE_DAYS = 45;

/**
 * Effective importance, used for ranking only. Decays exponentially with age.
 * Deliberately-saved memories (`source: 'user'`, i.e. an explicit add_memory)
 * decay toward a floor rather than to zero, so an intentional fact outlives an
 * auto-ingested one of equal raw importance.
 */
function effectiveImportance(m: Memory, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - Date.parse(m.createdAt)) / 86_400_000);
  const decay = Math.exp(-ageDays / IMPORTANCE_HALF_LIFE_DAYS);
  const floor = m.source === 'user' ? 0.5 : 0;
  return m.importance * (floor + (1 - floor) * decay);
}

/** Top-N by effective (age-decayed) importance, then recency, for an agent. */
export async function topMemoriesByImportance(
  agentId: string,
  chatId: string,
  limit = 10,
): Promise<Memory[]> {
  const now = Date.now();
  const byEffective = (a: Memory, b: Memory) =>
    effectiveImportance(b, now) - effectiveImportance(a, now) ||
    b.createdAt.localeCompare(a.createdAt);

  const recent = await listMemoriesForChat(agentId, chatId, 50);
  if (recent.length < 50) {
    return recent.sort(byEffective).slice(0, limit);
  }
  // Memory count >= 50: pull a candidate pool from gsi1-importance (sorted by
  // *stored* importance desc) so we don't silently drop high-importance older
  // memories beyond the recent-50 window, then re-rank by effective importance.
  // DDB applies Limit BEFORE FilterExpression, so a single small page could
  // contain zero rows for this chat on a busy multi-chat agent; page (bounded)
  // until enough post-filter candidates are collected or the partition ends.
  const want = limit * 3;
  const candidates: MemoryItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 10 && candidates.length < want; page++) {
    const out = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'gsi1-importance',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `AGENT#${agentId}`,
          ':chat': chatId,
        },
        FilterExpression: 'chatId = :chat',
        ScanIndexForward: false,
        Limit: 100,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }),
    );
    candidates.push(...((out.Items ?? []) as MemoryItem[]));
    lastKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!lastKey) break;
  }
  return candidates
    .map((i) => toMemory(agentId, i))
    .sort(byEffective)
    .slice(0, limit);
}

export async function forgetMemory(
  agentId: string,
  chatId: string,
  memoryId: string,
): Promise<boolean> {
  // SK contains the id at the end; we don't know the timestamp without a
  // lookup. Do a quick query bounded by chat scope.
  const items = await listMemoriesForChat(agentId, chatId, 100);
  const target = items.find((m) => m.id === memoryId);
  if (!target) return false;
  const sk = `MEM#${chatId}#${target.createdAt}#${memoryId}`;
  await ddb().send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: `AGENT#${agentId}`, SK: sk },
    }),
  );
  logger.info({ agentId, chatId, memoryId }, 'memory forgotten');
  return true;
}

export async function fetchUnconsolidated(
  agentId: string,
  chatId: string,
  limit = 100,
): Promise<Memory[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi2-unconsolidated',
      KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `AGENT#${agentId}`,
        ':sk': `UNCON#${chatId}#`,
      },
      Limit: limit,
    }),
  );
  return (out.Items ?? []).map((i) => toMemory(agentId, i as MemoryItem));
}

export async function markConsolidated(
  agentId: string,
  chatId: string,
  memoryId: string,
  createdAt: string,
): Promise<void> {
  const sk = `MEM#${chatId}#${createdAt}#${memoryId}`;
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `AGENT#${agentId}`, SK: sk },
      UpdateExpression: 'SET consolidated = :c REMOVE GSI2PK, GSI2SK',
      ExpressionAttributeValues: { ':c': 1 },
    }),
  );
}

export async function claimForConsolidation(
  agentId: string,
  chatId: string,
  memoryId: string,
  createdAt: string,
  workerId: string,
): Promise<boolean> {
  const sk = `MEM#${chatId}#${createdAt}#${memoryId}`;
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `AGENT#${agentId}`, SK: sk },
        UpdateExpression: 'SET claimedBy = :w, claimedAt = :t',
        ConditionExpression: 'attribute_not_exists(claimedBy)',
        ExpressionAttributeValues: {
          ':w': workerId,
          ':t': new Date().toISOString(),
        },
      }),
    );
    return true;
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    if (name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export async function releaseClaim(
  agentId: string,
  chatId: string,
  memoryId: string,
  createdAt: string,
): Promise<void> {
  const sk = `MEM#${chatId}#${createdAt}#${memoryId}`;
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `AGENT#${agentId}`, SK: sk },
      UpdateExpression: 'REMOVE claimedBy, claimedAt',
    }),
  );
}

function toMemory(agentId: string, i: MemoryItem): Memory {
  return {
    id: i.id,
    agentId,
    chatId: i.chatId,
    content: i.content,
    tags: i.tags ?? [],
    importance: i.importance ?? 50,
    source: i.source ?? 'user',
    createdAt: i.createdAt,
    ...(i.userId ? { userId: i.userId } : {}),
  };
}
