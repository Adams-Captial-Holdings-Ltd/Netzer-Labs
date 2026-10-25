/**
 * NZR-5: the one rule for who may read (and so write or delete) a knowledge
 * scope. default/shared are public to anyone holding vectors:read; every other
 * name (an agent's private scope, an unknown name, a reserved chat_* scope)
 * needs knowledge:private:read. Unknown is denied by default, which also covers
 * names created later. Pure: no I/O.
 */

import { createHash } from 'node:crypto';
import type { Capability } from '../auth/permissions.js';

export const PUBLIC_SCOPES = ['default', 'shared'] as const;
/** Namespace for per-chat scopes (NZR-6). No agent knowledgeScope may use it. */
export const RESERVED_SCOPE_PREFIX = 'chat_';

/**
 * Canonical on-disk form of a scope. MUST be applied on BOTH write and read.
 *
 * Scopes are operator-supplied — `knowledgeScope` in `agents/<id>/agent.yaml`,
 * free-form and unvalidated — and the documented format includes values like
 * `agent:ops`. Until 2026-08 this folding happened only on the write path, so
 * `agent:ops` was written to `index/agent_ops/` and listed from
 * `index/agent:ops/`: every read returned empty, with no error and nothing
 * actually missing. Any new code that builds an `index/` prefix goes through
 * here. (Lives here, re-exported by store.ts, so the scope rule has no S3 import.)
 */
export function normalizeScope(scope: string): string {
  return scope.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Compared after normalizeScope and case-sensitively: 'DEFAULT' is a different prefix. */
export function canReadScope(caps: ReadonlySet<Capability>, scope: string): boolean {
  const n = normalizeScope(scope);
  if (!n) return false;
  if ((PUBLIC_SCOPES as readonly string[]).includes(n)) return caps.has('vectors:read');
  return caps.has('knowledge:private:read');
}

/** NZR-6: admin-only home of legacy chat files whose uploader is unknown (Q83). */
export const QUARANTINE_SCOPE = 'chat_quarantine';

export function isChatScope(scope: string): boolean {
  return normalizeScope(scope).startsWith(RESERVED_SCOPE_PREFIX);
}

/**
 * NZR-6: the private scope of one uploader's files in one chat with one agent.
 * Binding the uploader means a reused chatId under another principal reaches
 * nothing. Hex only, so normalizeScope leaves it unchanged. The chatId is keyed
 * as sessions-repo saves it ('#' -> '_'), so a reopened conversation finds its files.
 */
export function chatKnowledgeScope(agentId: string, chatId: string, uploaderId: string): string {
  const saved = chatId.replace(/#/g, '_');
  return `${RESERVED_SCOPE_PREFIX}${createHash('sha256').update(`${agentId}|${saved}|${uploaderId}`).digest('hex').slice(0, 24)}`;
}

/** NZR-6 tag naming a chat file's uploader without naming them. */
export function ownerTag(uploaderId: string): string {
  return `owner:${createHash('sha256').update(uploaderId).digest('hex').slice(0, 16)}`;
}

/** First 12 hex chars of sha256(normalized name): audit rows carry this, never the name. */
export function scopeHash(scope: string): string {
  return createHash('sha256').update(normalizeScope(scope)).digest('hex').slice(0, 12);
}
