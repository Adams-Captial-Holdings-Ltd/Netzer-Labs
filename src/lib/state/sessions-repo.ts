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
 * Item-size budget: measured at 284-324KB worst case against DDB's 400KB cap,
 * NOT the ~50KB this comment claimed while the output ceiling was 1024 tokens.
 * TURN_MAX_TOKENS is now 8192, which multiplies every persisted assistant turn
 * by eight. MAX_TURN_WINDOW_BYTES keeps the stored window at or under 300,000
 * bytes (UTF-8 text plus 64 bytes per turn) whatever the ceiling; the remaining
 * scalar attributes and firstMessage (at most 120 chars) are small.
 */

import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { ingestEvictedTurns } from '../../agent/memory-ingest.js';
import { getConfig } from './runtime-config-repo.js';

const TABLE = process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions';
const MAX_TURNS = 20;
/**
 * Byte budget for the stored turn window, on top of the MAX_TURNS count cap.
 *
 * DynamoDB rejects an item over 400KB, and `appendTurns` only retries
 * ConditionalCheckFailedException — anything else throws, so an oversized item
 * fails the write and the turn is lost. That is the same class of bug as the
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
  return Buffer.byteLength(t.text ?? '', 'utf8') + 64; // 64 ~ role/ts/surface overhead
}

/**
 * Trim the oldest turns until the window fits the byte budget. The cut moves to
 * a user turn: Bedrock rejects a conversation whose first message is the
 * assistant's, and later Converse calls require strict alternation. An empty
 * window is valid because the next request starts with a new user message.
 * A reply ceiling bounds only replies, not user turns, so kept may be empty and
 * never exceeds the budget. Dropped turns still reach memory ingest.
 */
export function trimTurnsToBudget(
  turns: Turn[],
  budget = MAX_TURN_WINDOW_BYTES,
): { kept: Turn[]; dropped: Turn[] } {
  let total = 0;
  let cut = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    total += turnBytes(turns[i]!);
    if (total > budget) {
      cut = i + 1;
      break;
    }
  }
  if (cut > 0) {
    while (cut < turns.length && turns[cut]?.role !== 'user') cut++;
  }
  return { kept: turns.slice(cut), dropped: turns.slice(0, cut) };
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

export interface Turn {
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

export interface Session {
  agentId: string;
  chatId: string;
  turns: Turn[];
  modelOverride?: string;
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
}

function pk(agentId: string): string {
  return `AGENT#${agentId}`;
}
function sk(chatId: string): string {
  return `CHAT#${chatId}`;
}

export async function getSession(
  agentId: string,
  chatId: string,
): Promise<Session | null> {
  const out = await ddb().send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: pk(agentId), SK: sk(chatId) },
    }),
  );
  if (!out.Item) return null;
  return {
    agentId,
    chatId,
    turns: repairEmptyTurns((out.Item.turns as Turn[] | undefined) ?? []),
    modelOverride: out.Item.modelOverride as string | undefined,
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
  };
}

export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
  modelId: string;
}

export interface SessionEnrichment {
  surface?: 'telegram' | 'slack' | 'dashboard' | 'system';
  userId?: string;
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
  const newTurns = enrichment?.surface
    ? turnsIn.map((t) => (t.surface ? t : { ...t, surface: enrichment.surface }))
    : turnsIn;
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
    try {
      await ddb().send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            PK: pk(agentId),
            SK: sk(chatId),
            turns: merged,
            ...(existing?.modelOverride ? { modelOverride: existing.modelOverride } : {}),
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
            ...(enrichment?.userId ? { userId: enrichment.userId } : existing?.userId ? { userId: existing.userId } : {}),
            turnsTotal,
            turnsIngested,
            updatedAt: now,
            // Omitted entirely for dashboard chats — a Put replaces the whole
            // item, so this also strips the ttl off rows written before
            // conversations became persistent.
            ...(isPersistentChat(chatId) ? {} : { ttl: now + TTL_SECONDS }),
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
        }),
      );
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (name === 'ConditionalCheckFailedException' && attempt < MAX_ATTEMPTS - 1) {
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
}

/** Set or clear the per-chat model override. */
export async function setModelOverride(
  agentId: string,
  chatId: string,
  modelId: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (modelId) {
    // Strip the ttl on persistent chats rather than refreshing it. Without
    // this, picking a model on a dashboard conversation would quietly re-arm
    // the 7-day expiry that appendTurns just removed.
    const persist = isPersistentChat(chatId);
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk(agentId), SK: sk(chatId) },
        UpdateExpression: persist
          ? 'SET modelOverride = :m, updatedAt = :u REMOVE #t'
          : 'SET modelOverride = :m, updatedAt = :u, #t = :t',
        ExpressionAttributeNames: { '#t': 'ttl' },
        ExpressionAttributeValues: {
          ':m': modelId,
          ':u': now,
          // DynamoDB rejects a declared-but-unused expression value.
          ...(persist ? {} : { ':t': now + TTL_SECONDS }),
        },
      }),
    );
  } else {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk(agentId), SK: sk(chatId) },
        UpdateExpression: 'REMOVE modelOverride SET updatedAt = :u',
        ExpressionAttributeValues: { ':u': now },
      }),
    );
  }
}

export async function setWarroomMode(
  agentId: string,
  chatId: string,
  meetingId: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (meetingId) {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk(agentId), SK: sk(chatId) },
        UpdateExpression: 'SET activeWarroomId = :w, updatedAt = :u',
        ExpressionAttributeValues: { ':w': meetingId, ':u': now },
      }),
    );
  } else {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk(agentId), SK: sk(chatId) },
        UpdateExpression: 'REMOVE activeWarroomId SET updatedAt = :u',
        ExpressionAttributeValues: { ':u': now },
      }),
    );
  }
}

/** /newchat — wipe history but keep the row so model override persists. */
export async function clearSession(agentId: string, chatId: string): Promise<void> {
  // Flush any un-ingested tail before wiping, so closing a short conversation
  // (one that never hit the cadence threshold) still captures its memory.
  const existing = await getSession(agentId, chatId);
  if (existing && existing.turns.length > 0) {
    const total = existing.turnsTotal ?? existing.turns.length;
    const pendingCount = Math.max(0, Math.min(total - (existing.turnsIngested ?? 0), existing.turns.length));
    if (pendingCount >= 2) {
      void ingestEvictedTurns({ agentId, chatId, evicted: existing.turns.slice(-pendingCount) });
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const persist = isPersistentChat(chatId);
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(agentId), SK: sk(chatId) },
      // Reset the ingest counters — /newchat starts a fresh conversation.
      // Same TTL rule as everywhere else: refresh it on expiring chats, strip
      // it on persistent ones.
      UpdateExpression: persist
        ? 'SET turns = :empty, turnsTotal = :z, turnsIngested = :z, updatedAt = :u REMOVE #t'
        : 'SET turns = :empty, turnsTotal = :z, turnsIngested = :z, updatedAt = :u, #t = :t',
      ExpressionAttributeNames: { '#t': 'ttl' },
      ExpressionAttributeValues: {
        ':empty': [],
        ':z': 0,
        ':u': now,
        ...(persist ? {} : { ':t': now + TTL_SECONDS }),
      },
    }),
  );
}

/** Delete the session entirely. */
export async function deleteSession(
  agentId: string,
  chatId: string,
): Promise<void> {
  await ddb().send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: pk(agentId), SK: sk(chatId) },
    }),
  );
}
