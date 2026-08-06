/**
 * Custom (operator-supplied) exfil/DLP patterns.
 *
 * Stored as a single item in the kill-switches table so we don't need a
 * dedicated table or a CDK change (the panic state machine reuses the same
 * table the same way). All custom patterns live under one key as an array,
 * which keeps add/remove atomic and lets the hot path read them in a single
 * GetItem behind a short cache, mirroring kill-switches-repo.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { logger } from '../../observability/logger.js';
import type { ExfilPattern } from '../safety/exfil-patterns.js';

const TABLE = process.env.TABLE_KILL_SWITCHES ?? 'claudeclaw-kill-switches';
const KEY = { PK: 'EXFIL_PATTERNS', SK: 'CUSTOM' };
const CACHE_TTL_MS = 30_000;

let cache: { patterns: ExfilPattern[]; at: number } | null = null;

export async function getCustomPatterns(force = false): Promise<ExfilPattern[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.patterns;
  }
  try {
    const out = await ddb().send(new GetCommand({ TableName: TABLE, Key: KEY }));
    const patterns = (out.Item?.patterns as ExfilPattern[] | undefined) ?? [];
    cache = { patterns, at: Date.now() };
    return patterns;
  } catch (err) {
    // Fail open to the last known set (or empty). DLP custom patterns are
    // additive; a DDB blip must never crash the outbound scan path.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'exfil-patterns: failed to load custom patterns',
    );
    return cache?.patterns ?? [];
  }
}

async function write(patterns: ExfilPattern[]): Promise<ExfilPattern[]> {
  await ddb().send(new PutCommand({ TableName: TABLE, Item: { ...KEY, patterns } }));
  cache = { patterns, at: Date.now() };
  return patterns;
}

/** Upsert a custom pattern by id. Returns the full custom set after the write. */
export async function saveCustomPattern(pattern: ExfilPattern): Promise<ExfilPattern[]> {
  const existing = await getCustomPatterns(true);
  const next = [...existing.filter((p) => p.id !== pattern.id), pattern];
  return write(next);
}

/** Remove a custom pattern by id. Returns the full custom set after the write. */
export async function deleteCustomPattern(id: string): Promise<ExfilPattern[]> {
  const existing = await getCustomPatterns(true);
  const next = existing.filter((p) => p.id !== id);
  return write(next);
}
