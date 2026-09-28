/**
 * Sessions repository: per-(agent, chat) conversation history.
 *
 * Schema (DDB sessions table):
 *   PK: AGENT#{agentId}
 *   SK: CHAT#{chatId}
 *   turns: Array<{role, text, ts}>  (last N turns; we cap on write)
 *   modelOverride: string | undefined
 *   updatedAt: epoch seconds
 *   ttl: epoch seconds (7 days from updatedAt; auto-deletes idle sessions)
 *
 * P1 (owner decision 11: new item types in this table, no CDK): every message
 * is ALSO its own record in the conversation's partition — there is no GSI, so
 * it cannot live anywhere else (A132):
 *   PK: AGENT#{agentId}
 *   SK: CHAT#{chatId}#MSG#{seq, 10 digits}   seq = its place in the conversation
 *   role, text, ts, surface?, userId (the conversation's owner), truncated?, ttl?
 * The `turns` window above stays: it is what the model replays. The records are
 * the durable transcript the user reads back (getFullHistory) and the delete
 * removes (deleteSession). WI-1.0's containment rule keeps every reader that
 * lists conversations off them.
 *
 * Item-size budget: measured at 284-324KB worst case against DDB's 400KB cap,
 * NOT the ~50KB this comment claimed while the output ceiling was 1024 tokens.
 * TURN_MAX_TOKENS is now 8192, which multiplies every persisted assistant turn
 * by eight. appendTurns keeps the stored window at or under 300,000 bytes
 * (UTF-8 text plus 64 bytes per turn). A regenerated reply may temporarily
 * take it over that budget without evicting unsummarized turns; the next append
 * trims it. The remaining scalar attributes and firstMessage are small.
 */

import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  DeleteCommand,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { ddb } from './ddb.js';
import type { ArtifactDescriptor } from '../chat/artifacts-repo.js';
import { ingestEvictedTurns } from '../../agent/memory-ingest.js';
import { logger } from '../../observability/logger.js';
import { getConfig } from './runtime-config-repo.js';
import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';

const TABLE = process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions';
const MAX_TURNS = 20;
/**
 * Byte budget for the stored turn window, on top of the MAX_TURNS count cap.
 *
 * DynamoDB rejects an item over 400KB, and `appendTurns` only retries a lost
 * version fence — anything else throws, so an oversized item fails the write
 * and the turn is lost. That is the same class of bug as the
 * empty-turn poisoning: a size problem in one turn breaking the whole chat.
 *
 * The count cap alone does not bound bytes. Measured at TURN_MAX_TOKENS 8192,
 * 20 maxed turns reach 284-324KB — already ~81% of the limit, so the ceiling
 * could not be raised again without this. Trimming by bytes is what makes the
 * ceiling safely tunable at runtime.
 *
 * Oldest turns are dropped first and still flow to memory ingest, so nothing
 * is silently lost: recent context stays WHOLE rather than every turn being
 * truncated, because a half-sentence in every turn is worse context than fewer
 * complete ones.
 */
const MAX_TURN_WINDOW_BYTES = 300_000;

/** Byte size of a turn as DynamoDB will store it. */
function turnBytes(t: Turn): number {
  return Buffer.byteLength(t.text ?? '', 'utf8') + Buffer.byteLength(JSON.stringify(t.tools ?? [])) +
    Buffer.byteLength(JSON.stringify(t.attachments ?? [])) + Buffer.byteLength(JSON.stringify(t.artifacts ?? [])) +
    64; // 64 ~ role/ts/surface overhead
}

/**
 * Trim the oldest turns until the window fits the byte budget. The cut moves to
 * a user turn because every later request replays the stored window first: a
 * window that starts with a reply makes every later request start with the
 * assistant's message, which Bedrock rejects, so the chat fails from then on.
 * Converse's strict user/assistant alternation is noted at the post-loop
 * synthesis call in agent/agent-loop.ts. An empty window is valid because the
 * next request starts with a new user message. A reply ceiling bounds only
 * replies, not user turns, so kept may be empty and never exceeds the budget.
 * Dropped turns still reach memory ingest.
 */
export function trimTurnsToBudget(
  turns: Turn[],
  budget = MAX_TURN_WINDOW_BYTES,
): { kept: Turn[]; dropped: Turn[] } {
  // Tool output is expendable before conversation text; copy before clearing it.
  const window = turns.map((t) => ({ ...t, ...(t.tools ? { tools: t.tools.map((tool) => ({ ...tool })) } : {}) }));
  let bytes = window.reduce((sum, t) => sum + turnBytes(t), 0);
  for (const turn of window) {
    for (const tool of turn.tools ?? []) {
      if (bytes <= budget) break;
      if (!tool.output) continue;
      const before = turnBytes(turn);
      tool.output = '';
      tool.truncated = true;
      bytes += turnBytes(turn) - before;
    }
    if (bytes <= budget) break;
  }
  let total = 0;
  let cut = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    total += turnBytes(window[i]!);
    if (total > budget) {
      cut = i + 1;
      break;
    }
  }
  if (cut > 0) {
    while (cut < turns.length && turns[cut]?.role !== 'user') cut++;
  }
  return { kept: window.slice(cut), dropped: turns.slice(0, cut) };
}
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
// Default ingest cadence: distill the conversation into memory every N turns,
// runtime-tunable via runtime-config `memory/ingest_every_n_turns`. Clamped to
// [2, MAX_TURNS] so a turn can never evict off the window before it is ingested.
const DEFAULT_INGEST_EVERY_N = 8;

/**
 * Whether a chat's history is kept indefinitely instead of expiring.
 *
 * Dashboard conversations are browsable and resumable in the SPA, so deleting
 * them after a week silently destroys work the user can see listed. Telegram
 * and Slack have no history UI at all, so a permanent row there is pure storage
 * growth plus a retention change nobody asked for — they keep the 7-day TTL.
 *
 * Matched on the chatId prefix rather than the surface because the surface is
 * only known to appendTurns, while setModelOverride and clearSession also write
 * the TTL and see nothing but the id. `safeDashboardChatId` guarantees every
 * dashboard chat carries this prefix.
 *
 * DynamoDB TTL only deletes items that CARRY the attribute, so persisting means
 * omitting `ttl` entirely — never setting a far-future value.
 */
export function isPersistentChat(chatId: string): boolean {
  return chatId.startsWith('dashboard:');
}

/**
 * Serialize artifact writes with conversation erasure using a durable child
 * row. There is deliberately no TTL: if a process dies while holding it, an
 * operator must inspect and recover the conversation before removing the row.
 */
export async function acquireConversationChildLock(agentId: string, chatId: string): Promise<() => Promise<void>> {
  const token = randomUUID();
  const key = { PK: pk(agentId), SK: `${childPrefix(chatId)}CHILD_LOCK` };
  try {
    await ddb().send(new PutCommand({
      TableName: TABLE,
      Item: { ...key, lockToken: token, createdAt: new Date().toISOString() },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      throw new Error('Conversation child storage is busy; retry after the active operation completes');
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    await ddb().send(new DeleteCommand({
      TableName: TABLE,
      Key: key,
      ConditionExpression: 'lockToken = :token',
      ExpressionAttributeValues: { ':token': token },
    }));
    released = true;
  };
}

/** Parse + clamp the configured ingest cadence. Exported for tests. */
export function clampIngestEveryN(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_INGEST_EVERY_N;
  return Math.max(2, Math.min(MAX_TURNS, Math.floor(n)));
}

async function ingestEveryN(): Promise<number> {
  const raw = await getConfig('memory', 'ingest_every_n_turns').catch(() => undefined);
  return clampIngestEveryN(raw);
}

/**
 * Decide whether to run a memory-ingest pass and how many trailing turns to
 * feed it. Pure (no IO) so it is unit-testable. `pendingCount` is the number of
 * not-yet-ingested turns still present in the live window. We ingest when at
 * least 2 turns are pending AND either the cadence threshold is hit OR turns
 * are about to be evicted off the window (the backstop that guarantees no turn
 * is ever dropped without being summarized first).
 */
export function decideIngest(a: {
  turnsTotal: number;
  turnsIngested: number;
  evictedCount: number;
  everyN: number;
  windowLen: number;
}): { ingest: boolean; pendingCount: number } {
  const pendingCount = Math.max(0, Math.min(a.turnsTotal - a.turnsIngested, a.windowLen));
  const ingest = pendingCount >= 2 && (a.evictedCount > 0 || pendingCount >= a.everyN);
  return { ingest, pendingCount };
}

/** Stand-in for a stored turn whose text is empty. See repairEmptyTurns. */
export const NO_RESPONSE_NOTICE = '(no response)';

/**
 * A turn with empty text makes Bedrock reject the WHOLE request
 * ("messages: text content blocks must be non-empty"), which kills every later
 * turn in that chat, permanently — not just the one that produced it. A reply
 * truncated at `max_tokens` mid-tool-call stores exactly that, and generating a
 * document is the common trigger because the whole spec is emitted inline as
 * tool-call JSON.
 *
 * Applied on read, in `getSession`, for two reasons: every consumer that turns
 * stored turns into Bedrock messages goes through there, and chats already
 * poisoned before this fix recover on their own with no migration.
 *
 * Text is replaced rather than the turn dropped, because Bedrock also requires
 * roles to alternate — removing a lone assistant turn would leave two user
 * turns adjacent and trade one rejection for another.
 */
export function repairEmptyTurns(turns: Turn[]): Turn[] {
  return turns.map((t) =>
    // `typeof`, not `t.text?.trim()`: optional chaining guards null and
    // undefined but NOT a wrong type, and a legacy row whose text is a number
    // would throw a TypeError inside getSession — turning a poisoned chat into
    // a 500 instead of repairing it.
    typeof t.text === 'string' && t.text.trim() ? t : { ...t, text: NO_RESPONSE_NOTICE },
  );
}

export interface ToolRecord {
  label: string;
  step: number;
  toolUseId?: string;
  output?: string;
  isError?: boolean;
  truncated?: boolean;
}

export interface Turn {
  /** 'notice' = a fixed note the server wrote, not a model reply; it cannot be regenerated. */
  status?: 'stopped' | 'notice';
  /** The clientMessageId of the request that produced this reply; assistant turns only. Absent on replies saved before P7. */
  requestId?: string;
  tools?: ToolRecord[];
  attachments?: TurnAttachment[];
  artifacts?: ArtifactDescriptor[];
  role: 'user' | 'assistant';
  text: string;
  ts: number; // epoch seconds
  /**
   * Which surface produced this turn. Optional (older stored turns lack it).
   * Stamped centrally by appendTurns from enrichment.surface. For
   * owner-aliased/claimed principals, Telegram and Slack write into the SAME
   * session row — the per-turn tag is what makes that merged transcript
   * legible to the model (see buildCrossSurfaceNote in agent-loop).
   */
  surface?: 'telegram' | 'slack' | 'dashboard' | 'system';
}

export interface TurnAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  key: string;
}

export interface Session {
  agentId: string;
  chatId: string;
  turns: Turn[];
  modelOverride?: string;
  title?: string;
  pinned?: boolean;
  updatedAt: number;
  lastInputTokens?: number;
  lastOutputTokens?: number;
  contextWindow?: number;
  lastModelId?: string;
  activeWarroomId?: string;
  messageCount?: number;
  firstMessage?: string;
  createdAt?: number;
  surface?: 'telegram' | 'slack' | 'dashboard' | 'system';
  userId?: string;
  /** Cumulative count of all turns ever appended (survives window trimming). */
  turnsTotal?: number;
  /** High-water mark: count of turns already summarized into memory. */
  turnsIngested?: number;
  /**
   * Optimistic-concurrency counter, bumped by appendTurns on every write.
   * Absent on rows written before the fence existed.
   */
  version?: number;
  /** When DynamoDB deletes the conversation (epoch seconds); absent when it is durable. */
  ttl?: number;
}

function pk(agentId: string): string {
  return `AGENT#${agentId}`;
}
/**
 * Owner decision 47: a chat id never carries `#` into a key. A message record
 * is keyed CHAT#<chatId>#MSG#<seq>, so a chat named like `x#MSG#1` would read as
 * one of x's messages, and WI-1.0's containment rule (`^CHAT#[^#]+$`) would hide
 * it from every list. Mapped here, where every read and write builds its key,
 * so the id a caller already holds keeps working. None existed in production
 * when this was decided (decision 46's count).
 */
function sk(chatId: string): string {
  return `CHAT#${chatId.replace(/#/g, '_')}`;
}
/** The key prefix every record belonging to a conversation shares. */
function childPrefix(chatId: string): string {
  return `${sk(chatId)}#`;
}
function msgPrefix(chatId: string): string {
  return `${childPrefix(chatId)}MSG#`;
}
/** Zero-padded so the sort key orders messages exactly as the sequence does. */
function msgSk(chatId: string, seq: number): string {
  return `${msgPrefix(chatId)}${String(seq).padStart(10, '0')}`;
}

/**
 * A message record is one DynamoDB item, and an item over 400KB fails the
 * write — which would lose the turn that wanted recording. The window already
 * drops a turn that big (MAX_TURN_WINDOW_BYTES); the record keeps its first
 * 350,000 bytes less its tool results and says so. ponytail: truncate, not split;
 * chunk it across records if a single message ever needs to survive whole.
 */
const MAX_MESSAGE_BYTES = 350_000;

function capMessageText(text: string, byteBudget: number): { text: string; truncated?: true } {
  const maxBytes = Math.max(0, byteBudget);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text };
  // A cut inside a multi-byte character decodes to U+FFFD; drop that remnant.
  return { text: bytes.subarray(0, maxBytes).toString('utf8').replace(/�$/, ''), truncated: true };
}

/**
 * The tool results a record can carry. When their JSON alone is over the record
 * cap, outputs give way oldest first — the replay window's rule (decision 41) —
 * and every call stays listed. Works on a copy; the caller's turn is unchanged.
 */
function fitToolRecords(tools: ToolRecord[], budget = MAX_MESSAGE_BYTES): ToolRecord[] {
  const fitted = tools.map((tool) => ({ ...tool }));
  let bytes = Buffer.byteLength(JSON.stringify(fitted), 'utf8');
  for (const tool of fitted) {
    if (bytes <= budget) break;
    if (!tool.output) continue;
    const before = Buffer.byteLength(JSON.stringify(tool), 'utf8');
    tool.output = '';
    tool.truncated = true;
    bytes += Buffer.byteLength(JSON.stringify(tool), 'utf8') - before;
  }
  return fitted;
}

/** A record's text and tool results, capped so the item fits: the text takes whatever budget the results leave. */
const MAX_MESSAGE_ARTIFACTS = 8;

function safeMessageArtifacts(values: unknown): ArtifactDescriptor[] {
  if (!Array.isArray(values)) return [];
  const descriptors: ArtifactDescriptor[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (typeof row.artifactId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.artifactId) ||
        !Number.isInteger(row.version) || (row.version as number) < 1 ||
        typeof row.fileName !== 'string' || row.fileName.length < 1 || row.fileName.length > 255 ||
        /[/\\\u0000-\u001f\u007f]/.test(row.fileName) ||
        typeof row.contentType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(row.contentType) ||
        typeof row.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(row.createdAt) ||
        !Number.isFinite(Date.parse(row.createdAt))) continue;
    descriptors.push({ artifactId: row.artifactId, version: row.version as number, fileName: row.fileName,
      contentType: row.contentType, createdAt: row.createdAt });
    if (descriptors.length >= MAX_MESSAGE_ARTIFACTS) break;
  }
  return descriptors;
}

function capRecordContent(t: Turn): {
  text: string; truncated?: true; tools?: ToolRecord[]; attachments?: TurnAttachment[]; artifacts?: ArtifactDescriptor[];
} {
  const attachmentBytes = Buffer.byteLength(JSON.stringify(t.attachments ?? []), 'utf8');
  const artifacts = safeMessageArtifacts(t.artifacts);
  const artifactBytes = Buffer.byteLength(JSON.stringify(artifacts), 'utf8');
  const tools = t.tools ? fitToolRecords(t.tools, MAX_MESSAGE_BYTES - attachmentBytes - artifactBytes) : undefined;
  const toolBytes = Buffer.byteLength(JSON.stringify(tools ?? []), 'utf8');
  return {
    ...capMessageText(String(t.text ?? ''), MAX_MESSAGE_BYTES - toolBytes - attachmentBytes - artifactBytes),
    ...(tools ? { tools } : {}),
    ...(t.attachments ? { attachments: t.attachments } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  };
}

export async function getSession(
  agentId: string,
  chatId: string,
  opts?: { consistentRead?: boolean },
): Promise<Session | null> {
  const out = await ddb().send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: pk(agentId), SK: sk(chatId) },
      ...(opts?.consistentRead ? { ConsistentRead: true } : {}),
    }),
  );
  if (!out.Item) return null;
  return {
    agentId,
    chatId,
    turns: repairEmptyTurns((out.Item.turns as Turn[] | undefined) ?? []),
    modelOverride: out.Item.modelOverride as string | undefined,
    title: out.Item.title as string | undefined,
    pinned: out.Item.pinned as boolean | undefined,
    updatedAt: (out.Item.updatedAt as number | undefined) ?? 0,
    lastInputTokens: out.Item.lastInputTokens as number | undefined,
    lastOutputTokens: out.Item.lastOutputTokens as number | undefined,
    contextWindow: out.Item.contextWindow as number | undefined,
    lastModelId: out.Item.lastModelId as string | undefined,
    activeWarroomId: out.Item.activeWarroomId as string | undefined,
    messageCount: out.Item.messageCount as number | undefined,
    firstMessage: out.Item.firstMessage as string | undefined,
    createdAt: out.Item.createdAt as number | undefined,
    surface: out.Item.surface as Session['surface'],
    userId: out.Item.userId as string | undefined,
    turnsTotal: out.Item.turnsTotal as number | undefined,
    turnsIngested: out.Item.turnsIngested as number | undefined,
    version: out.Item.version as number | undefined,
    ttl: out.Item.ttl as number | undefined,
  };
}

/**
 * Replace one saved assistant reply without adding a message number. Preserve
 * the whole window so only appendTurns evicts turns, after arranging memory
 * ingest. Rewind the ingest mark when the replaced reply was already summarized.
 */
export async function replaceLastReply(
  agentId: string, chatId: string, reply: Turn,
  expected?: { turnsTotal: number; owner: string },
): Promise<boolean> {
  const key = { PK: pk(agentId), SK: sk(chatId) };
  for (let attempt = 0; attempt < 3; attempt++) {
    const { Item: row } = await ddb().send(new GetCommand({ TableName: TABLE, Key: key, ConsistentRead: true }));
    if (!row) return false;
    const turns = (row.turns as Turn[] | undefined) ?? [];
    const turnsTotal = (row.turnsTotal as number | undefined) ?? turns.length;
    if (expected && (turnsTotal !== expected.turnsTotal || row.userId !== expected.owner)) return false;
    if (turns.at(-1)?.role !== 'assistant' || turns.at(-2)?.role !== 'user') return false;
    const seq = turnsTotal - 1;
    const { Item: oldRecord } = await ddb().send(new GetCommand({
      TableName: TABLE, Key: { PK: key.PK, SK: msgSk(chatId, seq) }, ConsistentRead: true,
    }));
    if (!oldRecord || oldRecord.role !== 'assistant') return false;
    const stamped = row.surface && !reply.surface ? { ...reply, surface: row.surface as Turn['surface'] } : reply;
    const turnsIngested = row.turnsIngested as number | undefined;
    const now = Math.floor(Date.now() / 1000);
    const { text: _text, truncated: _truncated, tools: _tools, artifacts: _artifacts,
      attachments: _attachments, status: _status, requestId: _requestId, ...recordBase } = oldRecord;
    try {
      await ddb().send(new TransactWriteCommand({ TransactItems: [
        { Put: {
          TableName: TABLE,
          Item: { ...row, turns: [...turns.slice(0, -1), stamped],
            ...(turnsIngested !== undefined && seq < turnsIngested ? { turnsIngested: seq } : {}),
            updatedAt: now, version: ((row.version as number | undefined) ?? 0) + 1 },
          ConditionExpression: row.version !== undefined ? '#v = :v' : 'attribute_not_exists(#v)',
          ExpressionAttributeNames: { '#v': 'version' },
          ...(row.version !== undefined ? { ExpressionAttributeValues: { ':v': row.version } } : {}),
        } },
        { Put: {
          TableName: TABLE,
          Item: { ...recordBase, role: 'assistant', ...capRecordContent(stamped), ts: reply.ts,
            ...(reply.status ? { status: reply.status } : {}),
            ...(stamped.requestId !== undefined ? { requestId: stamped.requestId } : {}),
            ...(stamped.surface ? { surface: stamped.surface } : {}) },
          ConditionExpression: 'attribute_exists(SK) AND #r = :assistant',
          ExpressionAttributeNames: { '#r': 'role' },
          ExpressionAttributeValues: { ':assistant': 'assistant' },
        } },
      ] }));
      return true;
    } catch (err) {
      const e = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (e.name !== 'TransactionCanceledException' ||
          !e.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')) throw err;
    }
  }
  return false;
}

/** Rename or pin a row only while it still belongs to its owner. */
export async function setConversationMeta(
  agentId: string, chatId: string, owner: string, patch: { title?: string | null; pinned?: boolean },
): Promise<boolean> {
  const set = ['#v = if_not_exists(#v, :zero) + :one'];
  const remove: string[] = [];
  const names: Record<string, string> = { '#v': 'version' };
  const values: Record<string, unknown> = { ':zero': 0, ':one': 1, ':owner': owner };
  if (patch.title !== undefined) {
    names['#t'] = 'title';
    if (patch.title === null) remove.push('#t');
    else { set.push('#t = :t'); values[':t'] = patch.title; }
  }
  if (patch.pinned !== undefined) {
    names['#p'] = 'pinned';
    if (patch.pinned) { set.push('#p = :p'); values[':p'] = true; }
    else remove.push('#p');
  }
  try {
    await ddb().send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(agentId), SK: sk(chatId) },
      UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
      ConditionExpression: 'attribute_exists(PK) AND userId = :owner',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export type TurnStatus = 'streaming' | 'complete' | 'stopped' | 'error' | 'refused';

export async function beginTurn(
  agentId: string, chatId: string, clientMessageId: string, payloadHash: string,
): Promise<{ started: true } | { started: false; status: TurnStatus; sameMessage: boolean }> {
  const Key = { PK: pk(agentId), SK: `${childPrefix(chatId)}TURN#${clientMessageId}` };
  const createdAt = Math.floor(Date.now() / 1000);
  try {
    await ddb().send(new PutCommand({
      TableName: TABLE,
      Item: { ...Key, status: 'streaming', payloadHash, createdAt, ttl: createdAt + TTL_SECONDS },
      ConditionExpression: 'attribute_not_exists(SK)',
    }));
    return { started: true };
  } catch (err) {
    if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') throw err;
    const { Item } = await ddb().send(new GetCommand({ TableName: TABLE, Key, ConsistentRead: true }));
    if (!Item) throw err; // A concurrent deletion must not authorize another paid call.
    return { started: false, status: Item.status as TurnStatus, sameMessage: Item.payloadHash === payloadHash };
  }
}

export async function endTurn(
  agentId: string, chatId: string, clientMessageId: string, status: Exclude<TurnStatus, 'streaming'>,
): Promise<boolean> {
  try {
    await ddb().send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(agentId), SK: `${childPrefix(chatId)}TURN#${clientMessageId}` },
      UpdateExpression: 'SET #s = :s, endedAt = :now',
      ConditionExpression: '#s = :streaming',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status, ':now': Math.floor(Date.now() / 1000), ':streaming': 'streaming' },
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
  modelId: string;
}

export interface SessionEnrichment {
  surface?: 'telegram' | 'slack' | 'dashboard' | 'system';
  requestId?: string;
  /**
   * The conversation's owner. Stamped when the row is CREATED and never changed
   * afterwards (owner decision 1): the dashboard used to overwrite it with
   * whoever sent last, which let one message into someone else's conversation
   * take it (A131).
   */
  userId?: string;
  /**
   * Owner decision 1: a dashboard principal with no person behind it (a token
   * with no user and no link) gets no durable chat, so its conversation keeps
   * the expiring TTL every other surface uses instead of persisting.
   */
  ephemeral?: boolean;
}

/**
 * Append two turns (user + assistant) to the session, trimming to
 * MAX_TURNS most recent. Creates the session if missing. Refreshes TTL.
 */
export async function appendTurns(
  agentId: string,
  chatId: string,
  turnsIn: Turn[],
  usage?: ContextUsage,
  enrichment?: SessionEnrichment,
): Promise<void> {
  // Stamp each turn with the producing surface (from the enrichment every
  // call site already passes) so merged cross-surface sessions stay legible.
  const newTurns = turnsIn.map((t) => ({
    ...t,
    ...(enrichment?.surface && !t.surface ? { surface: enrichment.surface } : {}),
    ...(t.role === 'assistant' && enrichment?.requestId !== undefined && t.requestId === undefined
      ? { requestId: enrichment.requestId } : {}),
  }));
  // Optimistic concurrency: three ECS tasks share this table, and a blind
  // read-then-put let two near-simultaneous turns for the same chat (webhook
  // retry, a scheduled fire racing a live turn, a merged cross-surface
  // session) overwrite each other: dropped turns, under-counted messageCount,
  // regressed ingest bookkeeping. The version fence makes the loser re-read
  // and re-merge instead.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await getSession(agentId, chatId);
    const combined = [...(existing?.turns ?? []), ...newTurns];
    const byCount = combined.slice(-MAX_TURNS);
    const countEvicted = combined.slice(0, Math.max(0, combined.length - MAX_TURNS));
    // Bytes as well as count: see MAX_TURN_WINDOW_BYTES. Byte-dropped turns join
    // the count-evicted ones because evicted.length is what trips decideIngest's
    // evict backstop. Without them, a trim by bytes alone could drop turns that
    // were never summarized.
    const { kept: merged, dropped: byteEvicted } = trimTurnsToBudget(byCount);
    const evicted = [...countEvicted, ...byteEvicted];

    // Memory ingest on a high-water mark: summarize the conversation into memory
    // every N turns (runtime-tunable) and ALWAYS before any turn evicts off the
    // window. This captures short conversations too, not only >MAX_TURNS ones.
    // `turnsTotal` is cumulative (survives trimming); for sessions created before
    // this field existed we seed it from the current window length.
    const prevTotal = existing?.turnsTotal ?? existing?.turns?.length ?? 0;
    const turnsTotal = prevTotal + newTurns.length;
    let turnsIngested = existing?.turnsIngested ?? 0;
    const decision = decideIngest({
      turnsTotal,
      turnsIngested,
      evictedCount: evicted.length,
      everyN: await ingestEveryN(),
      windowLen: combined.length,
    });
    if (decision.ingest) turnsIngested = turnsTotal;
    const now = Math.floor(Date.now() / 1000);
    const existingCount = existing?.messageCount ?? 0;
    const userTurns = newTurns.filter((t) => t.role === 'user');
    const firstUserText = userTurns[0]?.text;
    // The first owner stays the owner (see SessionEnrichment.userId).
    const owner = existing?.userId ?? enrichment?.userId;
    // Whether a dashboard conversation lasts is settled ONCE, when it first has
    // an owner (owner decisions 1 and 46): a person's lasts; anyone else's
    // expires. Until then — a scheduled reply saved before the first turn of its
    // chat, say — it expires, and the first write that stamps an owner settles it
    // by the rule for a new conversation (the third critic's C3-1). After that
    // nothing changes it, whoever continues it: an expiring conversation is
    // refreshed and a lasting one never gains a ttl. So a principal with no person
    // cannot drop a legacy chat out of the migration (the first critic's F3), a
    // scheduled turn cannot make a chat permanent (the second critic's NEW-3), and
    // no lasting conversation keeps records that expire under it (NEW-2). Bot chats
    // always expire. Each record carries the expiry its conversation had when the
    // record was written.
    const settled = existing?.userId !== undefined;
    const expires = settled
      ? !isPersistentChat(chatId) || existing!.ttl !== undefined
      : newConversationExpires(chatId, enrichment);
    const ttl = expires ? now + TTL_SECONDS : undefined;
    // Settling a conversation that already has records — the scheduled reply's —
    // gives them its owner and, when it now lasts, takes their expiry away first.
    if (existing && !settled && owner !== undefined && isPersistentChat(chatId)) {
      await adoptRecords(pk(agentId), chatId, owner, !expires);
    }
    // WI-1.2: each new message ALSO becomes its own immutable record, numbered by
    // its place in the whole conversation (prevTotal is the cumulative count the
    // window cannot lose). Written in the same all-or-nothing transaction as the
    // window, so a turn is never in one without the other, and the version fence
    // below guards both. ponytail: callers append a user/assistant pair; a single
    // call with more than 99 turns would exceed the 100-item transaction limit.
    const records = newTurns.map((t, i) => ({
      Put: {
        TableName: TABLE,
        Item: {
          PK: pk(agentId),
          SK: msgSk(chatId, prevTotal + i),
          seq: prevTotal + i,
          role: t.role,
          ...capRecordContent(t),
          ts: t.ts,
          ...(t.status ? { status: t.status } : {}),
          ...(t.requestId !== undefined ? { requestId: t.requestId } : {}),
          ...(t.surface ? { surface: t.surface } : {}),
          ...(owner ? { userId: owner } : {}),
          ...(ttl ? { ttl } : {}),
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      },
    }));
    try {
      await ddb().send(new TransactWriteCommand({ TransactItems: [{
        Put: {
          TableName: TABLE,
          Item: {
            PK: pk(agentId),
            SK: sk(chatId),
            turns: merged,
            ...(existing?.modelOverride ? { modelOverride: existing.modelOverride } : {}),
            ...(existing?.title !== undefined ? { title: existing.title } : {}),
            ...(existing?.pinned !== undefined ? { pinned: existing.pinned } : {}),
            ...(usage ? {
              lastInputTokens: usage.inputTokens,
              lastOutputTokens: usage.outputTokens,
              contextWindow: usage.contextWindow,
              lastModelId: usage.modelId,
            } : {}),
            messageCount: existingCount + userTurns.length,
            ...(existing?.firstMessage
              ? { firstMessage: existing.firstMessage }
              : firstUserText
                ? { firstMessage: firstUserText.slice(0, 120) }
                : {}),
            createdAt: existing?.createdAt ?? now,
            ...(enrichment?.surface ? { surface: enrichment.surface } : existing?.surface ? { surface: existing.surface } : {}),
            ...(owner ? { userId: owner } : {}),
            turnsTotal,
            turnsIngested,
            updatedAt: now,
            ...(ttl ? { ttl } : {}),
            version: (existing?.version ?? 0) + 1,
          },
          // Fence on exactly what the read saw: a missing row must still be
          // missing, a legacy (pre-version) row still unversioned, a versioned
          // row unchanged. ("version" is a DDB reserved word, hence #v.)
          ...(existing
            ? existing.version !== undefined
              ? {
                  ConditionExpression: '#v = :v',
                  ExpressionAttributeNames: { '#v': 'version' },
                  ExpressionAttributeValues: { ':v': existing.version },
                }
              : {
                  ConditionExpression: 'attribute_not_exists(#v)',
                  ExpressionAttributeNames: { '#v': 'version' },
                }
            : { ConditionExpression: 'attribute_not_exists(PK)' }),
        },
      }, ...records] }));
    } catch (err) {
      // Re-read only when the conversation's own fence (item 0) lost a race or
      // another transaction was in flight. A record whose sequence number is
      // already taken is NOT retried — re-reading cannot free the number, and
      // overwriting durable history is exactly what the condition forbids —
      // unless that record has already expired (below).
      const e = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      const reasons = e.CancellationReasons ?? [];
      const cancelled = e.name === 'TransactionCanceledException';
      const fenced =
        cancelled && (reasons[0]?.Code === 'ConditionalCheckFailed' || reasons[0]?.Code === 'TransactionConflict');
      // A throttled item cancels the whole transaction, and the SDK does not
      // retry a cancelled transaction (it did retry the single Put this
      // replaced), so back off and try again rather than lose the turn.
      const throttled = cancelled && reasons.some((r) => r.Code === 'ThrottlingError');
      // Numbers held by records already past their own expiry, while the
      // conversation itself is as it was read: an earlier conversation under this
      // id expired, and DynamoDB's TTL swept its row before its records — it
      // deletes in no set order, and a Telegram or Slack chat keeps its id for
      // good. Clear them and write again (the second critic's NEW-1). A record that
      // has not expired is never cleared. A lost race (the fence) just re-reads:
      // the records it collided with are the winner's (the third critic's C3-4).
      let staleNumbers = false;
      if (cancelled && !fenced && attempt < MAX_ATTEMPTS - 1 && reasons.slice(1).some((r) => r.Code === 'ConditionalCheckFailed')) {
        try {
          staleNumbers = (await deleteExpiredRecords(agentId, chatId)) > 0;
        } catch (sweepErr) {
          // The write's own error is the one to report.
          logger.warn(
            { agentId, chatId, errMessage: sweepErr instanceof Error ? sweepErr.message : String(sweepErr) },
            'sessions: clearing expired records failed',
          );
        }
      }
      if ((fenced || throttled || staleNumbers) && attempt < MAX_ATTEMPTS - 1) {
        if (throttled) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
        continue;
      }
      throw err;
    }
    // Fire the ingest only after the write recording turnsIngested landed, so
    // a fenced-out attempt can never double-summarize the same turns.
    if (decision.ingest) {
      const pending = combined.slice(-decision.pendingCount);
      void ingestEvictedTurns({ agentId, chatId, evicted: pending });
    }
    return;
  }
  // Unreachable while every retry above is bounded: never resolve without writing.
  throw new Error(`appendTurns: gave up after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Whether a NEW conversation expires — or one nobody owns yet, when its first
 * owner arrives: a person's dashboard conversation lasts; anything else expires.
 */
function newConversationExpires(chatId: string, who?: SessionEnrichment): boolean {
  return !isPersistentChat(chatId) || !(who?.ephemeral === false && who.userId);
}

/**
 * Give every record a conversation already has its owner and, when the
 * conversation lasts, no expiry — so a conversation that has just been settled
 * never keeps a record that expires under it. One idempotent update per record;
 * a record that expired meanwhile is not brought back. Returns the sequence
 * numbers it found.
 */
async function adoptRecords(conversationPk: string, chatId: string, owner: string, lasts: boolean): Promise<Set<number>> {
  const recorded = new Set<number>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': conversationPk, ':prefix': msgPrefix(chatId) },
        ProjectionExpression: '#s',
        ExpressionAttributeNames: { '#s': 'seq' },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    for (const r of out.Items ?? []) recorded.add(Number(r.seq));
    startKey = out.LastEvaluatedKey;
  } while (startKey);
  for (const seq of recorded) {
    await updateIfExists(
      { PK: conversationPk, SK: msgSk(chatId, seq) },
      lasts
        ? { UpdateExpression: 'SET userId = :o REMOVE #t', ExpressionAttributeNames: { '#t': 'ttl' }, ExpressionAttributeValues: { ':o': owner } }
        : { UpdateExpression: 'SET userId = :o', ExpressionAttributeValues: { ':o': owner } },
    );
  }
  return recorded;
}

/**
 * Update an item only if it exists; false when there was none. The slash-command
 * helpers below used to upsert, and a conversation a command CREATED carried no
 * owner — which the owner check (decision 9) then refused to its own author, for
 * good (the first critic's F2). A dashboard conversation's expiry is left alone
 * here too: it is settled when the conversation is created (appendTurns).
 */
async function updateIfExists(
  Key: Record<string, string>,
  update: Pick<UpdateCommandInput, 'UpdateExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'>,
): Promise<boolean> {
  try {
    await ddb().send(new UpdateCommand({ TableName: TABLE, Key, ...update, ConditionExpression: 'attribute_exists(PK)' }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** The update that refreshes a bot chat's expiry; a dashboard chat's is left alone. */
function refreshTtl(chatId: string, set: string, values: Record<string, unknown>) {
  if (isPersistentChat(chatId)) return { UpdateExpression: set, ExpressionAttributeValues: values };
  return {
    UpdateExpression: `${set}, #t = :t`,
    ExpressionAttributeNames: { '#t': 'ttl' },
    ExpressionAttributeValues: { ...values, ':t': Math.floor(Date.now() / 1000) + TTL_SECONDS },
  };
}

/** Set or clear the per-chat model override of a conversation that exists. */
export async function setModelOverride(
  agentId: string,
  chatId: string,
  modelId: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const Key = { PK: pk(agentId), SK: sk(chatId) };
  await updateIfExists(
    Key,
    modelId
      ? refreshTtl(chatId, 'SET modelOverride = :m, updatedAt = :u', { ':m': modelId, ':u': now })
      : { UpdateExpression: 'REMOVE modelOverride SET updatedAt = :u', ExpressionAttributeValues: { ':u': now } },
  );
}

/**
 * Enter or leave a war room. Entering one is the one command that must remember
 * something in a chat that does not exist yet, so it creates the conversation —
 * owned by whoever entered, and expiring on appendTurns' rule for a new one.
 */
export async function setWarroomMode(
  agentId: string,
  chatId: string,
  meetingId: string | null,
  owner?: SessionEnrichment,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const Key = { PK: pk(agentId), SK: sk(chatId) };
  if (!meetingId) {
    await updateIfExists(Key, { UpdateExpression: 'REMOVE activeWarroomId SET updatedAt = :u', ExpressionAttributeValues: { ':u': now } });
    return;
  }
  const entered = await updateIfExists(Key, {
    UpdateExpression: 'SET activeWarroomId = :w, updatedAt = :u',
    ExpressionAttributeValues: { ':w': meetingId, ':u': now },
  });
  if (entered) return;
  const expires = newConversationExpires(chatId, owner);
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...Key,
        turns: [],
        activeWarroomId: meetingId,
        createdAt: now,
        updatedAt: now,
        ...(owner?.surface ? { surface: owner.surface } : {}),
        ...(owner?.userId ? { userId: owner.userId } : {}),
        ...(expires ? { ttl: now + TTL_SECONDS } : {}),
      },
      // Created by a concurrent write since the update above missed it: the
      // command reports the failure rather than overwrite that conversation.
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
}

/** /newchat — wipe the history of a conversation that exists, keeping its row (and its model override). */
export async function clearSession(agentId: string, chatId: string): Promise<void> {
  // Flush any un-ingested tail before wiping, so closing a short conversation
  // (one that never hit the cadence threshold) still captures its memory.
  const existing = await getSession(agentId, chatId);
  // Nothing to clear in a chat that does not exist — and writing one would
  // leave a conversation nobody owns (F2).
  if (!existing) return;
  if (existing.turns.length > 0) {
    const total = existing.turnsTotal ?? existing.turns.length;
    const pendingCount = Math.max(0, Math.min(total - (existing.turnsIngested ?? 0), existing.turns.length));
    if (pendingCount >= 2) {
      void ingestEvictedTurns({ agentId, chatId, evicted: existing.turns.slice(-pendingCount) });
    }
  }
  // /newchat starts a fresh conversation for the MODEL: the window empties and
  // nothing is pending ingest. turnsTotal is NOT reset — it numbers the durable
  // per-message records (WI-1.2), which /newchat keeps, and a reset would hand
  // the next message a sequence number that is already taken. Marking every turn
  // so far as ingested gives the zero pending count the old reset gave.
  await updateIfExists(
    { PK: pk(agentId), SK: sk(chatId) },
    refreshTtl(chatId, 'SET turns = :empty, turnsIngested = if_not_exists(turnsTotal, :z), updatedAt = :u', {
      ':empty': [],
      ':z': 0,
      ':u': Math.floor(Date.now() / 1000),
    }),
  );
}

/**
 * The most messages one history read returns. ponytail: a flag, not a cursor —
 * page the transcript route if a conversation ever outgrows it.
 */
const MAX_HISTORY_MESSAGES = 2_000;

/**
 * The whole conversation, oldest first (WI-1.3): every per-message record, plus
 * any window turn written before P1, which exists nowhere else. The window is
 * always the newest suffix of the conversation (turns only ever leave from the
 * front), so window turn i sits at sequence turnsTotal - window.length + i.
 *
 * Reads newest first so that, past MAX_HISTORY_MESSAGES, what is dropped is the
 * OLDEST history — and says so in `truncated` rather than ending silently.
 */
export async function getFullHistory(
  agentId: string,
  chatId: string,
  session: Session,
): Promise<{ turns: Turn[]; truncated: boolean }> {
  const bySeq = new Map<number, Turn>();
  let startKey: Record<string, unknown> | undefined;
  let truncated = false;
  do {
    const out = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': pk(agentId), ':prefix': msgPrefix(chatId) },
        ScanIndexForward: false,
        ExclusiveStartKey: startKey,
      }),
    );
    for (const r of out.Items ?? []) {
      if (bySeq.size >= MAX_HISTORY_MESSAGES) {
        truncated = true;
        break;
      }
      bySeq.set(Number(r.seq), {
        role: r.role as Turn['role'],
        text: r.text as string,
        ts: r.ts as number,
        ...(r.status ? { status: r.status as Turn['status'] } : {}),
        ...(r.requestId !== undefined ? { requestId: r.requestId as string } : {}),
        ...(r.tools ? { tools: r.tools as ToolRecord[] } : {}),
        ...(r.attachments ? { attachments: r.attachments as TurnAttachment[] } : {}),
        ...(r.artifacts ? { artifacts: safeMessageArtifacts(r.artifacts) } : {}),
        ...(r.surface ? { surface: r.surface as Turn['surface'] } : {}),
      });
    }
    startKey = out.LastEvaluatedKey;
    if (startKey && bySeq.size >= MAX_HISTORY_MESSAGES) truncated = true;
  } while (startKey && !truncated);
  const total = session.turnsTotal ?? session.turns.length;
  session.turns.forEach((t, i) => {
    const seq = total - session.turns.length + i;
    if (!bySeq.has(seq)) bySeq.set(seq, t);
  });
  const turns = [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  return { turns: repairEmptyTurns(turns), truncated };
}

/**
 * P1 WI-1.4: re-own a conversation written before WI-1.1 for the person proven
 * for it (legacy-chat-migration.ts decides who). ONE transaction, so it lands
 * whole or not at all:
 *  - the conversation row with the new owner and a bumped version — fenced on
 *    the owner and version just read, so a concurrent turn cannot slip between
 *    (appendTurns re-reads on the new version) and a second run finds nothing;
 *  - an immutable source record, CHAT#<chatId>#SRC, naming the old owner and how
 *    the new one was proven (decision 8's "immutable source record");
 *  - a record for each window turn that has none: before P1 the window was the
 *    ONLY copy of those turns, and it drops them as the conversation moves on.
 */
export async function reownLegacyConversation(
  agentId: string,
  chatId: string,
  legacyOwner: string,
  newOwner: string,
  provenBy: 'session' | 'link',
): Promise<{ backfilled: number }> {
  const key = { PK: pk(agentId), SK: sk(chatId) };
  const { Item: item } = await ddb().send(new GetCommand({ TableName: TABLE, Key: key, ConsistentRead: true }));
  if (!item || item.userId !== legacyOwner) {
    throw new Error('reownLegacyConversation: the conversation changed since it was read');
  }
  const turns = (item.turns as Turn[] | undefined) ?? [];
  const total = (item.turnsTotal as number | undefined) ?? turns.length;
  // A record written before the re-own carries the old owner, so each is
  // re-owned, and any expiry on it stripped: none should carry one under a
  // durable conversation, but a durable conversation must never lose a message
  // to a stray one (the first critic's F3). Done FIRST, so a failure leaves the
  // conversation legacy for a re-run to finish.
  const recorded = await adoptRecords(key.PK, chatId, newOwner, true);
  const backfill = turns.flatMap((t, i) => {
    const seq = total - turns.length + i;
    if (recorded.has(seq)) return [];
    return [{
      Put: {
        TableName: TABLE,
        Item: {
          ...key,
          SK: msgSk(chatId, seq),
          seq,
          role: t.role,
          ...capRecordContent(t),
          ts: t.ts,
          ...(t.status ? { status: t.status } : {}),
          ...(t.requestId !== undefined ? { requestId: t.requestId } : {}),
          ...(t.surface ? { surface: t.surface } : {}),
          userId: newOwner,
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      },
    }];
  });
  const versioned = item.version !== undefined;
  await ddb().send(new TransactWriteCommand({ TransactItems: [
    {
      Put: {
        TableName: TABLE,
        Item: { ...item, userId: newOwner, version: ((item.version as number | undefined) ?? 0) + 1 },
        ConditionExpression: versioned ? 'userId = :legacy AND #v = :v' : 'userId = :legacy AND attribute_not_exists(#v)',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':legacy': legacyOwner, ...(versioned ? { ':v': item.version } : {}) },
      },
    },
    {
      Put: {
        TableName: TABLE,
        Item: { PK: key.PK, SK: `${childPrefix(chatId)}SRC`, legacyOwner, owner: newOwner, provenBy, migratedAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(SK)',
      },
    },
    ...backfill,
  ] }));
  return { backfilled: backfill.length };
}

/**
 * Delete a conversation and every record that belongs to it (WI-1.3). The
 * records go FIRST: if the delete stops part-way, the conversation row is still
 * there for the caller to retry — deleting it first would strand its messages
 * with nothing left that finds them.
 */
export async function deleteSession(
  agentId: string,
  chatId: string,
): Promise<void> {
  await deleteSessionAttachments(agentId, chatId);
  const releaseChildLock = await acquireConversationChildLock(agentId, chatId);
  try {
  // Pending, version, and head rows all live under this child prefix. Their
  // presence is the durable signal that this chat may own CURATED objects,
  // including an upload whose physical VersionId was never recorded.
  let artifactRowsExist = false;
  let artifactStartKey: Record<string, unknown> | undefined;
  do {
    const artifactRows = await ddb().send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': pk(agentId), ':prefix': `${childPrefix(chatId)}ARTIFACT#` },
      ProjectionExpression: 'PK, SK',
      ConsistentRead: true,
      ExclusiveStartKey: artifactStartKey,
    }));
    if ((artifactRows.Items ?? []).length > 0) artifactRowsExist = true;
    artifactStartKey = artifactRows.LastEvaluatedKey;
  } while (!artifactRowsExist && artifactStartKey);

  if (artifactRowsExist) {
    // Load lazily to avoid an evaluation-time cycle: artifacts-repo imports
    // the child-lock API from this module.
    const { eraseConversationArtifacts } = await import('../chat/artifacts-repo.js');
    await eraseConversationArtifacts(agentId, chatId);
  }

  for (;;) {
    // Re-query from the top each round: the rows just deleted are gone, so the
    // next page is simply what is left.
    const out = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': pk(agentId), ':prefix': childPrefix(chatId) },
        ProjectionExpression: 'PK, SK',
        // A message written a moment before the delete must be found, or it is
        // stranded once the row is gone (the first critic's A3).
        ConsistentRead: true,
      }),
    );
    const keys = (out.Items ?? [])
      .filter((i) => i.SK !== `${childPrefix(chatId)}CHILD_LOCK`)
      .map((i) => ({ PK: i.PK, SK: i.SK }));
    for (let i = 0; i < keys.length; i += 25) {
      await batchDelete(keys.slice(i, i + 25));
    }
    if (!out.LastEvaluatedKey) break;
  }
  await ddb().send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: pk(agentId), SK: sk(chatId) },
    }),
  );
  } finally {
    // Keep the lock row through parent deletion. A writer that acquires after
    // release re-reads the parent consistently. Only a finalizing draft refuses a
    // missing parent; a first-turn artifact save or a draft start re-creates the
    // chat (known gap M1, carried to hardening by owner decision 59).
    await releaseChildLock();
  }
}

async function deleteSessionAttachments(agentId: string, chatId: string): Promise<void> {
  const fileKeys = new Set<string>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb().send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': pk(agentId), ':prefix': childPrefix(chatId) },
      ProjectionExpression: 'PK, SK, #a',
      ExpressionAttributeNames: { '#a': 'attachments' },
      ConsistentRead: true,
      ExclusiveStartKey: startKey,
    }));
    for (const item of out.Items ?? []) {
      for (const attachment of (item.attachments ?? []) as TurnAttachment[]) {
        if (attachment.key) fileKeys.add(attachment.key);
      }
    }
    startKey = out.LastEvaluatedKey;
  } while (startKey);

  if (fileKeys.size > 0) {
    const bucket = process.env.RAW_BUCKET;
    if (!bucket) throw new Error('RAW_BUCKET not configured');
    const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
    const files = [...fileKeys];
    for (let i = 0; i < files.length; i += 1000) {
      const result = await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: files.slice(i, i + 1000).map((Key) => ({ Key })) },
      }));
      if (result.Errors?.length) throw new Error(`Failed to delete ${result.Errors.length} stored attachment(s)`);
    }
  }
}

/**
 * Delete a chat id's message records that are already past their own expiry —
 * what DynamoDB's TTL sweep has not reached yet — and say how many. Never one
 * that has not expired, so a live conversation's records are safe from it.
 */
async function deleteExpiredRecords(agentId: string, chatId: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const expired: Array<Record<string, unknown>> = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': pk(agentId), ':prefix': msgPrefix(chatId) },
        ProjectionExpression: 'PK, SK, #t',
        ExpressionAttributeNames: { '#t': 'ttl' },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    for (const r of out.Items ?? []) {
      if (typeof r.ttl === 'number' && r.ttl <= now) expired.push({ PK: r.PK, SK: r.SK });
    }
    startKey = out.LastEvaluatedKey;
  } while (startKey);
  for (let i = 0; i < expired.length; i += 25) await batchDelete(expired.slice(i, i + 25));
  return expired.length;
}

/** BatchWriteItem, retrying what DynamoDB hands back unprocessed; throws if it never clears. */
async function batchDelete(keys: Array<Record<string, unknown>>): Promise<void> {
  let pending = keys.map((Key) => ({ DeleteRequest: { Key } }));
  for (let attempt = 0; pending.length > 0; attempt++) {
    if (attempt === 5) {
      throw new Error(`sessions: ${pending.length} record(s) still unprocessed after 5 attempts`);
    }
    if (attempt > 0) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    const out = await ddb().send(new BatchWriteCommand({ RequestItems: { [TABLE]: pending } }));
    pending = (out.UnprocessedItems?.[TABLE] ?? []) as typeof pending;
  }
}
