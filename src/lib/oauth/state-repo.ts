/**
 * OAuth state rows — CSRF protection for the in-app Connect flows.
 *
 * Mirrors the magic-link conventions (src/lib/auth/magic-link.ts): only the
 * sha256 of the state value is persisted (in the runtime-config table under
 * category oauth_state), rows are single-use (deleted on consume) and expire
 * after 10 minutes. The raw state travels only in the provider redirect.
 *
 * The runtime-config table has no DDB TTL attribute, so expiry is enforced in
 * code; minting opportunistically deletes any expired row it happens to read.
 * Volume is interactive-button-click scale, so no sweep is needed.
 */

import { createHash, randomBytes } from 'node:crypto';
import { getConfig, setConfig, deleteConfig } from '../state/runtime-config-repo.js';
import { logger } from '../../observability/logger.js';

const CATEGORY = 'oauth_state';
const TTL_MS = 10 * 60 * 1000;

export interface OAuthStateRow {
  provider: 'slack' | 'slack-user' | 'salesforce';
  /** What the callback does with the token: per-agent chat creds, the
   * vendor-MCP bearer, or a provider API connection. */
  mode: 'chat' | 'mcp' | 'api';
  agentId?: string;
  /** Who initiated — audit attribution. */
  principalLabel: string;
  /** PKCE verifier (slack-user, salesforce). */
  codeVerifier?: string;
  createdAt: string;
  expiresAt: string;
}

function hashState(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Mint a single-use state value. Returns the RAW state for the redirect. */
export async function mintOAuthState(
  row: Omit<OAuthStateRow, 'createdAt' | 'expiresAt'>,
): Promise<string> {
  const raw = randomBytes(32).toString('hex');
  const now = Date.now();
  const full: OAuthStateRow = {
    ...row,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
  };
  await setConfig(CATEGORY, hashState(raw), JSON.stringify(full), {
    updatedBy: row.principalLabel,
  });
  return raw;
}

/**
 * Single-use consume: read, delete, validate expiry. Null on any failure —
 * the callback treats null as a hard "start over".
 */
export async function consumeOAuthState(rawState: string): Promise<OAuthStateRow | null> {
  if (!rawState || rawState.length < 32 || rawState.length > 128) return null;
  const key = hashState(rawState);
  try {
    const stored = await getConfig(CATEGORY, key);
    if (!stored) return null;
    // Delete FIRST so a replayed callback can never consume twice.
    await deleteConfig(CATEGORY, key);
    const row = JSON.parse(stored) as OAuthStateRow;
    if (!row.provider || !row.mode || !row.expiresAt) return null;
    if (Date.parse(row.expiresAt) < Date.now()) return null;
    return row;
  } catch (err) {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'oauth state consume failed',
    );
    return null;
  }
}
