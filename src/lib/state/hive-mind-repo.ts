/**
 * Hive Mind — cross-chat, cross-agent shared memory.
 *
 * Where `memories-repo` is scoped to (agent, chat), the hive mind is
 * shared across every agent and every chat. Useful for facts like
 * "the user's company is named X" or "the user prefers concise replies"
 * that any agent could benefit from on any future turn.
 *
 * Schema:
 *   PK = DATE#YYYYMMDD
 *   SK = TS#<ms>#AGENT#<agent>#ID#<ulid>
 *   GSI1PK = AGENT#<agent>
 *   GSI1SK = TS#<ms>#<id>
 *   GSI2PK = TOPIC#<topic>
 *   GSI2SK = TS#<ms>#<id>
 *
 * Importance + tags carry the same semantics as the per-chat memories.
 */

import { randomUUID } from 'node:crypto';
import { PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';

const TABLE = process.env.TABLE_HIVE_MIND ?? 'claudeclaw-hive-mind';

export interface HiveNote {
  id: string;
  authorAgentId: string;
  authorChatId: string;
  content: string;
  topic?: string;
  tags: string[];
  importance: number;
  createdAt: string;
}

/**
 * Shared hive contract row consumed by `buildSystemPrompt`'s
 * `<hive_context>` block and by the HiveMind dashboard page.
 * `ts` is the ISO timestamp (alias of `createdAt`). `HiveNote`
 * is a superset of this shape so existing callers keep compiling.
 */
export interface HiveEntry {
  authorAgentId: string;
  authorChatId: string;
  topic?: string;
  content: string;
  ts: string;
}

export interface RecentHiveOpts {
  agentId?: string;
  sinceDays?: number;
  limit?: number;
  topic?: string;
}

export async function logToHive(args: {
  authorAgentId: string;
  authorChatId: string;
  content: string;
  topic?: string;
  tags?: string[];
  importance?: number;
}): Promise<HiveNote> {
  const id = randomUUID();
  const createdAt = new Date();
  const dateKey = createdAt.toISOString().slice(0, 10).replace(/-/g, '');
  const tsMs = createdAt.getTime();
  const importance = args.importance ?? 50;
  const note: HiveNote = {
    id,
    authorAgentId: args.authorAgentId,
    authorChatId: args.authorChatId,
    content: args.content,
    ...(args.topic ? { topic: args.topic } : {}),
    tags: args.tags ?? [],
    importance,
    createdAt: createdAt.toISOString(),
  };
  // Activate the table's TTL (attribute name `ttl`, epoch seconds). Without a
  // ttl attribute on the item DynamoDB never expires it, so the table — and
  // the searchHiveText scan corpus — would grow without bound. Higher-
  // importance notes live longer: 60 days floor, up to ~360 days at imp 100.
  const ttl = Math.floor(tsMs / 1000) + (60 + importance * 3) * 86_400;
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `DATE#${dateKey}`,
        SK: `TS#${tsMs}#AGENT#${args.authorAgentId}#ID#${id}`,
        GSI1PK: `AGENT#${args.authorAgentId}`,
        GSI1SK: `TS#${tsMs}#${id}`,
        ...(args.topic
          ? { GSI2PK: `TOPIC#${args.topic}`, GSI2SK: `TS#${tsMs}#${id}` }
          : {}),
        ttl,
        ...note,
      },
    }),
  );
  return note;
}

export async function searchHiveByTopic(
  topic: string,
  limit = 10,
): Promise<HiveNote[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi2-xagent',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': `TOPIC#${topic}` },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (out.Items ?? []).map((i) => toNote(i as Record<string, unknown>));
}

/**
 * Recent hive entries within a rolling window (default 30 days).
 *
 * Accepts either the legacy positional `limit` (kept so existing
 * callers in jarvis.ts / handler.ts / agent-tools.ts compile
 * unchanged) or the shared-contract `RecentHiveOpts` object.
 * Returned rows satisfy both `HiveNote` and `HiveEntry` (they carry
 * the contract's `ts` field aliasing `createdAt`).
 *
 * The Hive Mind is cross-agent by design, so `agentId` is a BIAS, not a
 * filter: it pushes the calling agent's own notes to the front while still
 * surfacing org-wide context from every other agent (the hive contract).
 * `topic`, where given, is a hard filter — that scoping is intentional.
 */
export async function recentHive(
  opts: RecentHiveOpts | number = {},
): Promise<(HiveNote & HiveEntry)[]> {
  const o: RecentHiveOpts = typeof opts === 'number' ? { limit: opts } : opts;
  const limit = o.limit ?? 50;
  const sinceDays = o.sinceDays ?? 30;
  const wantAgent = o.agentId;
  const wantTopic = o.topic;

  // Walk back through the window of daily partitions, collecting candidates.
  // Each day's rows already arrive newest-first; days are visited newest-first,
  // so `candidates` stays globally newest-first. We over-collect (no agent
  // filter here) so the org-wide notes are available to surface alongside the
  // calling agent's own.
  const candidates: (HiveNote & HiveEntry)[] = [];
  const today = new Date();
  for (let i = 0; i < sinceDays && candidates.length < limit; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10).replace(/-/g, '');
    const resp = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `DATE#${key}` },
        ScanIndexForward: false,
        Limit: limit - candidates.length,
      }),
    );
    for (const item of resp.Items ?? []) {
      const note = toNote(item as Record<string, unknown>);
      if (wantTopic && note.topic !== wantTopic) continue;
      candidates.push(note);
      if (candidates.length >= limit) break;
    }
  }

  if (!wantAgent) return candidates;

  // Bias: the calling agent's own notes first (preserving recency within each
  // group), then every other agent's notes. Nothing is dropped — the block
  // still carries org-wide context, just ordered toward this agent.
  const own: (HiveNote & HiveEntry)[] = [];
  const others: (HiveNote & HiveEntry)[] = [];
  for (const note of candidates) {
    (note.authorAgentId === wantAgent ? own : others).push(note);
  }
  return [...own, ...others];
}

/**
 * Naive substring search for low-volume use. Swap to OpenSearch /
 * S3 Vectors once we cross ~10k notes.
 */
export async function searchHiveText(
  query: string,
  limit = 10,
): Promise<HiveNote[]> {
  const out = await ddb().send(
    new ScanCommand({
      TableName: TABLE,
      Limit: 500,
    }),
  );
  const lower = query.toLowerCase();
  const matches: HiveNote[] = [];
  for (const item of out.Items ?? []) {
    const content = String((item as Record<string, unknown>).content ?? '');
    if (content.toLowerCase().includes(lower)) {
      matches.push(toNote(item as Record<string, unknown>));
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

function toNote(i: Record<string, unknown>): HiveNote & HiveEntry {
  const createdAt = String(i.createdAt ?? '');
  return {
    id: String(i.id ?? ''),
    authorAgentId: String(i.authorAgentId ?? ''),
    authorChatId: String(i.authorChatId ?? ''),
    content: String(i.content ?? ''),
    ...(i.topic ? { topic: String(i.topic) } : {}),
    tags: Array.isArray(i.tags) ? (i.tags as string[]) : [],
    importance: Number(i.importance ?? 50),
    createdAt,
    ts: createdAt,
  };
}
