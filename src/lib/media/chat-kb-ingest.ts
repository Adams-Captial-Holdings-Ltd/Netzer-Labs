/**
 * Chat → knowledge base ingest, when the sender opts in (`addToKnowledge`).
 *
 * The file is analyzed inline for the current turn and also ingested into the
 * vector knowledge base, so the agent can search it in later turns of the
 * SAME chat via s3_vectors_search.
 *
 * Safety posture (NZR-6):
 *   - Scope is the chat-private `chatKnowledgeScope(agent, chat, uploader)`.
 *     Nothing else (agent knowledgeScope, `media/chat_kb_ingest_scope`) can
 *     widen it: one user's file never reaches another user of the same agent.
 *   - No uploader identity → no ingest (fail closed), audited.
 *   - Kill switch `chat_kb_ingest_disabled` and runtime flag
 *     `media/chat_kb_ingest_enabled` gate the behavior (switch > flag).
 *   - Dedup: docId is a content hash, checked only within the chat's own scope,
 *     so "already in the knowledge base" never reveals another user's file.
 *   - This function NEVER throws into a chat turn: ingest failure is logged +
 *     audited and the turn proceeds with inline analysis only.
 */

import { createHash } from 'node:crypto';
import { getConfig } from '../state/runtime-config-repo.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { ingestDocument, type IngestFormat } from '../vectors/ingest.js';
import { documentExists } from '../vectors/store.js';
import { chatKnowledgeScope, ownerTag, scopeHash } from '../vectors/scope-access.js';
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

export interface ChatKbIngestArgs {
  targetAgentId: string;
  chatId: string;
  surface: ChatSurface;
  /** Who sent the file (dashboardIdentity on the dashboard). Empty → no ingest. */
  uploaderId: string;
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

    if (!args.uploaderId) {
      void writeAudit({
        action: 'knowledge_ingest',
        agentId: args.targetAgentId,
        chatId: args.chatId,
        surface: args.surface,
        detail: { via: 'chat', reason: 'no_uploader' },
        result: 'blocked',
      });
      return null;
    }
    const scope = chatKnowledgeScope(args.targetAgentId, args.chatId, args.uploaderId);
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
      ownerTag(args.uploaderId),
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
        // Hash only, no file name: the audit log is viewer-readable (NZR-6).
        docId: result.docId,
        scopeHash: scopeHash(result.scope),
        chunks: result.chunks,
        failed: result.failed,
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
      detail: { via: 'chat', errMessage },
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
  // Dedup is checked in this chat's own scope only, so this never reveals another user's file.
  if (kb.deduped) {
    return `📚 ${fileName} is already in the knowledge base — ask me about it in this chat.`;
  }
  return `📚 Indexed ${fileName} (${kb.chunks} chunk${kb.chunks === 1 ? '' : 's'}). Ask me about it in this chat.`;
}
