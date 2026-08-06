/**
 * Jarvis cross-session memory — durable, per-user conversation recall.
 *
 * Where `sessions-repo` holds the per-(agent, chat) rolling transcript and
 * `memories-repo` holds per-chat long-term facts, THIS repo persists the
 * stream of Jarvis conversation turns for a single signed-in principal so a
 * BRAND-NEW Jarvis session can be seeded with what was said in earlier ones.
 *
 * It rides the EXISTING `claudeclaw-sessions` table (no new table, no new
 * IAM grant — the task role already has read/write there). Rows live in a
 * distinct partition keyed by the principal's hashPrefix16, fully namespaced
 * away from the AGENT#/CHAT# session rows:
 *
 *   PK  = JARVIS#<hashPrefix16>          (the same 16-char principal id the
 *                                          jarvis audit rows already use)
 *   SK  = TURN#<isoTime>#<id>            (lexicographic = chronological;
 *                                          the id breaks same-ms ties)
 *   role = 'user' | 'assistant'
 *   text = the DLP-REDACTED turn text (never the raw transcript — H1)
 *   createdAt = ISO timestamp
 *   ttl = epoch seconds, ~30 days out (DynamoDB self-prunes; matches the
 *         table's configured `ttl` attribute, so no infra change is needed)
 *
 * SECURITY: callers MUST pass already-redactForModel'd text. This repo is a
 * dumb store; it does not (and cannot) re-derive the DLP guarantee. The
 * partition is per-principal, so one user's memory can never seed another's.
 */

import { randomUUID } from 'node:crypto';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { logger } from '../../observability/logger.js';

const TABLE = process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions';

/** ~30 days, so the partition self-prunes long after a user stops returning. */
const TTL_SECONDS = 30 * 24 * 60 * 60;

/** Defensive per-turn text cap so one runaway turn can't bloat the row. */
const MAX_TURN_TEXT = 4000;

/** Hard ceiling on how many turns a single load will ever pull back. */
const MAX_LOAD_LIMIT = 50;

export interface JarvisTurn {
  role: 'user' | 'assistant';
  text: string;
  /** ISO timestamp the turn was persisted. */
  createdAt: string;
}

function pk(principalHash: string): string {
  return `JARVIS#${principalHash}`;
}

/**
 * Append one committed, DLP-REDACTED turn to a principal's Jarvis memory.
 *
 * Fail-soft: memory is an enhancement, not a correctness path, so a write
 * error is logged and swallowed — it must never break the live turn that the
 * user is mid-conversation on. The caller passes the redactForModel output;
 * raw transcript text must NEVER reach here.
 */
export async function appendTurn(
  principalHash: string,
  turn: { role: 'user' | 'assistant'; text: string },
): Promise<void> {
  const text = (turn.text ?? '').trim().slice(0, MAX_TURN_TEXT);
  if (!principalHash || !text) return;
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const now = Math.floor(Date.now() / 1000);
  try {
    await ddb().send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: pk(principalHash),
          SK: `TURN#${createdAt}#${id}`,
          role: turn.role,
          text,
          createdAt,
          ttl: now + TTL_SECONDS,
        },
      }),
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'jarvis-memory: appendTurn failed (non-fatal)',
    );
  }
}

/**
 * Load the most recent `limit` turns for a principal, returned OLDEST-FIRST so
 * the caller can fold them directly into a chronological message history.
 *
 * Fail-soft: returns [] on any error (a fresh session simply starts cold).
 * We query newest-first (ScanIndexForward:false) with a Limit, then reverse —
 * that keeps DynamoDB from paging the whole partition just to grab the tail.
 */
export async function loadRecent(
  principalHash: string,
  limit = 12,
): Promise<JarvisTurn[]> {
  if (!principalHash) return [];
  const n = Math.max(1, Math.min(MAX_LOAD_LIMIT, Math.trunc(limit) || 1));
  try {
    const out = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': pk(principalHash),
          ':sk': 'TURN#',
        },
        ScanIndexForward: false, // newest-first, so Limit grabs the tail
        Limit: n,
      }),
    );
    const rows = (out.Items ?? [])
      .map((i): JarvisTurn | null => {
        const role = i.role;
        const text = typeof i.text === 'string' ? i.text : '';
        if ((role !== 'user' && role !== 'assistant') || !text) return null;
        return { role, text, createdAt: String(i.createdAt ?? '') };
      })
      .filter((t): t is JarvisTurn => t !== null);
    // Newest-first from DDB → flip to oldest-first for chronological seeding.
    rows.reverse();
    return rows;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'jarvis-memory: loadRecent failed (non-fatal)',
    );
    return [];
  }
}
