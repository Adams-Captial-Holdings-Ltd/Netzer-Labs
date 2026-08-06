/**
 * Chat → knowledge base auto-ingest.
 *
 * When a user drops a document (or a voice/video note that produced a
 * transcript) into ANY chat surface — Telegram, Slack, dashboard chat — the
 * file is not just analyzed inline for the current turn: it is also ingested
 * into the vector knowledge base, so it becomes permanently queryable from
 * every surface via the s3_vectors_search tool. That is the product promise:
 * "drop a PDF in Telegram, ask about it from Slack tomorrow."
 *
 * Safety posture:
 *   - Scope defaults to the TARGET AGENT's knowledgeScope (not `shared`), so a
 *     chat-dropped doc reaches the agent it was sent to — on every surface —
 *     without leaking to the whole fleet. `media/chat_kb_ingest_scope=shared`
 *     opts into org-wide.
 *   - Kill switch `chat_kb_ingest_disabled` and runtime flag
 *     `media/chat_kb_ingest_enabled` gate the behavior (switch > flag).
 *   - Dedup: docId is a content hash, so the same file re-sent (on any
 *     surface) skips extraction + embedding entirely.
 *   - This function NEVER throws into a chat turn: ingest failure is logged +
 *     audited and the turn proceeds with inline analysis only.
 */

import { createHash } from 'node:crypto';
import { getConfig } from '../state/runtime-config-repo.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { ingestDocument, type IngestFormat } from '../vectors/ingest.js';
import { documentExists } from '../vectors/store.js';
import {
  loadAgent,
  DEFAULT_KNOWLEDGE_SCOPE,
  SHARED_KNOWLEDGE_SCOPE,
} from '../config/agent-loader.js';
import { writeAudit } from '../audit/audit-writer.js';
import { logger } from '../../observability/logger.js';

export type ChatSurface = 'telegram' | 'slack' | 'dashboard';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // matches dashboard MAX_DOC_BYTES

/** Deterministic content-hash docId — surface-agnostic dedup key. */
export function contentDocId(bytes: Buffer): string {
  return `chat-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`;
}

/**
 * Map a chat filename to an IngestFormat. Returns null for formats the
 * pipeline can't index (images, archives, binaries) — those are inline-only.
 */
export function ingestFormatFor(fileName: string): IngestFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pptx')) return 'pptx';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.txt') || lower.endsWith('.csv')) return 'text';
  return null;
}

export async function resolveChatIngestScope(targetAgentId: string): Promise<string> {
  const mode = (await getConfig('media', 'chat_kb_ingest_scope')) ?? 'agent';
  if (mode === 'shared') return SHARED_KNOWLEDGE_SCOPE;
  try {
    const agent = await loadAgent(targetAgentId);
    return agent.knowledgeScope || DEFAULT_KNOWLEDGE_SCOPE;
  } catch {
    return DEFAULT_KNOWLEDGE_SCOPE;
  }
}

export interface ChatKbIngestArgs {
  targetAgentId: string;
  chatId: string;
  surface: ChatSurface;
  fileName: string;
  /** Document bytes (pdf/docx/pptx/txt/md/csv path). */
  bytes?: Buffer;
  /** Pre-transcribed text (voice/audio/video path) — ingested as 'audio'. */
  transcript?: string;
  /** s3://… of the raw upload, recorded as the doc source. */
  sourceS3Url: string;
  extraTags?: string[];
}

export interface ChatKbIngestResult {
  docId: string;
  scope: string;
  chunks: number;
  deduped: boolean;
}

/**
 * Ingest a chat-dropped doc/transcript into the KB. Returns null (and the
 * caller proceeds without a KB confirmation) when the feature is off, the
 * file is too big or an unsupported format, or the ingest failed.
 */
export async function ingestChatMedia(
  args: ChatKbIngestArgs,
): Promise<ChatKbIngestResult | null> {
  try {
    const killed = await isKillSwitchActive('chat_kb_ingest_disabled');
    if (killed.active) {
      logger.warn(
        { surface: args.surface, chatId: args.chatId, reason: killed.reason },
        'chat_kb_ingest_disabled kill switch active; skipping KB ingest',
      );
      return null;
    }
    const enabled = (await getConfig('media', 'chat_kb_ingest_enabled')) ?? '1';
    if (enabled === '0') return null;

    const maxBytes = Number(
      (await getConfig('media', 'chat_kb_ingest_max_bytes')) ?? DEFAULT_MAX_BYTES,
    );
    const isTranscript = typeof args.transcript === 'string';
    if (!isTranscript) {
      if (!args.bytes || args.bytes.length === 0) return null;
      if (args.bytes.length > maxBytes) {
        logger.info(
          { fileName: args.fileName, bytes: args.bytes.length, maxBytes },
          'chat KB ingest skipped: over size cap',
        );
        return null;
      }
    } else if (!args.transcript || args.transcript.trim().length === 0) {
      return null;
    }

    const format: IngestFormat | null = isTranscript
      ? 'audio'
      : ingestFormatFor(args.fileName);
    if (!format) return null;

    const scope = await resolveChatIngestScope(args.targetAgentId);
    const docId = isTranscript
      ? contentDocId(Buffer.from(args.transcript ?? '', 'utf8'))
      : contentDocId(args.bytes as Buffer);

    if (await documentExists(scope, docId)) {
      return { docId, scope, chunks: 0, deduped: true };
    }

    const tags = [
      'chat',
      args.surface,
      `agent:${args.targetAgentId}`,
      ...(args.extraTags ?? []),
    ];
    const result = await ingestDocument({
      docId,
      scope,
      docTitle: args.fileName,
      source: args.sourceS3Url,
      format,
      ...(isTranscript
        ? { content: args.transcript }
        : { contentBase64: (args.bytes as Buffer).toString('base64') }),
      tags,
    });

    void writeAudit({
      action: 'knowledge_ingest',
      agentId: args.targetAgentId,
      chatId: args.chatId,
      surface: args.surface,
      detail: {
        docId: result.docId,
        scope: result.scope,
        chunks: result.chunks,
        failed: result.failed,
        fileName: args.fileName,
        via: 'chat',
      },
      result: 'ok',
    });
    return { docId: result.docId, scope: result.scope, chunks: result.chunks, deduped: false };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.warn(
      { fileName: args.fileName, surface: args.surface, errMessage },
      'chat KB ingest failed; turn continues with inline analysis only',
    );
    void writeAudit({
      action: 'knowledge_ingest',
      agentId: args.targetAgentId,
      chatId: args.chatId,
      surface: args.surface,
      detail: { fileName: args.fileName, via: 'chat', errMessage },
      result: 'error',
    });
    return null;
  }
}

/** User-facing confirmation line, sent as a follow-up message after the turn. */
export function buildKbConfirmation(
  kb: ChatKbIngestResult,
  fileName: string,
): string {
  if (kb.deduped) {
    return `📚 ${fileName} is already in the knowledge base — ask me about it anytime.`;
  }
  return `📚 Indexed ${fileName} (${kb.chunks} chunk${kb.chunks === 1 ? '' : 's'}). Ask me about it anytime — from Slack, Telegram, or the dashboard.`;
}
