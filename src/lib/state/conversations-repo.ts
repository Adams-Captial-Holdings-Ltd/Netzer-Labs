/**
 * Owner-scoped dashboard conversations with a full durable transcript.
 *
 * Rides the SAME sessions table as sessions-repo/jarvis-memory-repo (generic
 * PK/SK; no infra change) with two item types, per ADR 0010:
 *
 *   Conversation meta  PK=USER#<ownerId>   SK=CONV#<conversationId>
 *   Message            PK=CONV#<convId>    SK=MSG#<pad13(epochMs)>#<0|1>#<uuid>
 *
 * Neither carries a `ttl` attribute, so DynamoDB TTL never deletes them — the
 * transcript is the durable product record, unlike the session row's rolling
 * 20-turn model-context window (which this module never touches).
 *
 * `conversationId` IS the session chatId (`dashboard:c_<uuid>`), so every
 * sessions-repo behavior (isPersistentChat, memory ingest, model override)
 * applies unchanged. Ownership is structural: the meta lives under the owner's
 * partition, and reading it there IS the authorization check — there is no
 * cross-partition lookup to get wrong.
 */

import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { logger } from '../../observability/logger.js';

const TABLE = process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions';

/** Bounded list, house style (no cursor pagination exists in this API). */
const LIST_SLICE = 100;
const LIST_SCAN_CAP = 500;
/** Title mirrors the sessions-repo firstMessage convention. */
const TITLE_CHARS = 120;

export interface ConversationMeta {
  conversationId: string;
  ownerId: string;
  agentId: string;
  title: string;
  messageCount: number;
  createdAt: number; // epoch seconds
  updatedAt: number; // epoch seconds
  lastClientMessageId?: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number; // epoch seconds
}

/**
 * Stable owner identity for a dashboard principal. NEVER the per-login token
 * hash (`dashboardIdentity`) — that rotates on every magic-link sign-in.
 * Users-table uuid when present; the env break-glass token maps to a stable
 * 'root'; legacy minted operator tokens (no user binding) fall back to their
 * stable hash prefix so they at least keep their own history per token.
 */
export function conversationOwnerId(p: {
  userId?: string;
  label?: string;
  profileId?: string;
  hashPrefix16: string;
}): string {
  if (p.userId) return p.userId;
  if (p.label === 'Root token' || p.profileId === 'owner') return 'root';
  return `token:${p.hashPrefix16}`;
}

/** Server-minted, unguessable, and a valid `dashboard:` chatId as-is. */
export function newConversationId(): string {
  return `dashboard:c_${randomUUID()}`;
}

/** True for ids minted by newConversationId (not legacy timestamp chatIds). */
export function isConversationChatId(id: string): boolean {
  return id.startsWith('dashboard:c_');
}

function metaPk(ownerId: string): string {
  return `USER#${ownerId}`;
}
function metaSk(conversationId: string): string {
  return `CONV#${conversationId}`;
}
function msgPk(conversationId: string): string {
  return `CONV#${conversationId}`;
}

function toMeta(item: Record<string, unknown>): ConversationMeta {
  return {
    conversationId: String(item.conversationId ?? ''),
    ownerId: String(item.ownerId ?? ''),
    agentId: String(item.agentId ?? 'main'),
    title: String(item.title ?? ''),
    messageCount: typeof item.messageCount === 'number' ? item.messageCount : 0,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    ...(typeof item.lastClientMessageId === 'string'
      ? { lastClientMessageId: item.lastClientMessageId }
      : {}),
  };
}

/**
 * The meta read doubles as the ownership check: it only ever looks under the
 * CALLER'S partition, so another user's conversation is indistinguishable from
 * a nonexistent one (uniform not-found, no existence leak).
 */
export async function getConversation(
  ownerId: string,
  conversationId: string,
): Promise<ConversationMeta | null> {
  const out = await ddb().send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: metaPk(ownerId), SK: metaSk(conversationId) },
    }),
  );
  return out.Item ? toMeta(out.Item) : null;
}

/** All of one owner's conversations, newest-updated first, sliced to 100. */
export async function listConversations(ownerId: string): Promise<ConversationMeta[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': metaPk(ownerId), ':sk': 'CONV#' },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...((out.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey && items.length < LIST_SCAN_CAP);
  if (items.length >= LIST_SCAN_CAP) {
    logger.warn({ ownerId, cap: LIST_SCAN_CAP }, 'conversation list hit scan cap');
  }
  return items
    .map(toMeta)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, LIST_SLICE);
}

/**
 * The most recent `limit` messages, returned oldest-first for display.
 * (Query newest-first + reverse, the jarvis-memory loadRecent pattern.)
 */
export async function listMessages(
  conversationId: string,
  limit = 200,
): Promise<ConversationMessage[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': msgPk(conversationId), ':sk': 'MSG#' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return ((out.Items ?? []) as Record<string, unknown>[])
    .map((i) => ({
      role: i.role === 'user' ? ('user' as const) : ('assistant' as const),
      text: String(i.text ?? ''),
      ts: typeof i.ts === 'number' ? i.ts : 0,
    }))
    .reverse();
}

function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/**
 * Durably record one completed turn (user + assistant) and touch the meta.
 *
 * Both messages share one server-clock millisecond prefix with a role
 * tiebreaker (#0 user, #1 assistant), so the pair sorts adjacently and in
 * order without a sequence counter — they are written from one code path at
 * one instant (ADR 0010).
 *
 * Errors propagate: durability is the feature, so a failed write must surface
 * on the stream rather than vanish into a fire-and-forget.
 */
export async function persistTurn(args: {
  ownerId: string;
  conversationId: string;
  agentId: string;
  userText: string;
  assistantText: string;
  clientMessageId?: string;
}): Promise<void> {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const msPrefix = String(nowMs).padStart(13, '0');

  const put = (roleIndex: 0 | 1, role: 'user' | 'assistant', text: string) =>
    ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: msgPk(args.conversationId),
          SK: `MSG#${msPrefix}#${roleIndex}#${randomUUID()}`,
          role,
          text,
          ts: now,
          ownerId: args.ownerId,
          // no ttl: the transcript never expires
        },
      }),
    );
  await put(0, 'user', args.userText);
  await put(1, 'assistant', args.assistantText);

  // Meta upsert ladder: update-if-exists → create-if-absent → update (a lost
  // race on create means the row now exists). The composer sends serially, so
  // the ladder is a correctness backstop, not a hot path.
  const update = () =>
    ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: metaPk(args.ownerId), SK: metaSk(args.conversationId) },
        ConditionExpression: 'attribute_exists(PK)',
        UpdateExpression:
          'SET updatedAt = :u, agentId = :a' +
          (args.clientMessageId ? ', lastClientMessageId = :m' : '') +
          ' ADD messageCount :n',
        ExpressionAttributeValues: {
          ':u': now,
          ':a': args.agentId,
          ':n': 2,
          ...(args.clientMessageId ? { ':m': args.clientMessageId } : {}),
        },
      }),
    );
  try {
    await update();
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
    try {
      await ddb().send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            PK: metaPk(args.ownerId),
            SK: metaSk(args.conversationId),
            conversationId: args.conversationId,
            ownerId: args.ownerId,
            agentId: args.agentId,
            title: args.userText.slice(0, TITLE_CHARS),
            messageCount: 2,
            createdAt: now,
            updatedAt: now,
            ...(args.clientMessageId ? { lastClientMessageId: args.clientMessageId } : {}),
            // no ttl: conversations never expire
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (createErr) {
      if (!isConditionalFailure(createErr)) throw createErr;
      await update();
    }
  }
}

/**
 * Remove a conversation's durable data (GDPR purge path). The owner is read
 * off the message items, so callers that only know the chatId (forget_me)
 * need no separate owner lookup.
 */
export async function deleteConversationData(
  conversationId: string,
): Promise<{ messagesDeleted: number; metaDeleted: boolean }> {
  const keys: Array<{ PK: string; SK: string }> = [];
  let ownerId: string | undefined;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': msgPk(conversationId), ':sk': 'MSG#' },
        ProjectionExpression: 'PK, SK, ownerId',
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    for (const item of (out.Items ?? []) as Array<{ PK: string; SK: string; ownerId?: string }>) {
      keys.push({ PK: item.PK, SK: item.SK });
      ownerId ??= item.ownerId;
    }
    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  if (keys.length === 0) return { messagesDeleted: 0, metaDeleted: false };

  for (let i = 0; i < keys.length; i += 25) {
    await ddb().send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE]: keys
            .slice(i, i + 25)
            .map((Key) => ({ DeleteRequest: { Key } })),
        },
      }),
    );
  }

  let metaDeleted = false;
  if (ownerId) {
    await ddb().send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: metaPk(ownerId), SK: metaSk(conversationId) },
      }),
    );
    metaDeleted = true;
  }
  return { messagesDeleted: keys.length, metaDeleted };
}
