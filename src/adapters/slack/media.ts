/**
 * Slack file download + processing.
 *
 * Slack file events carry `files[]` with a `url_private` that requires the
 * bot token as a Bearer header and the `files:read` scope. Two identities
 * exist (main bot via env SLACK_BOT_TOKEN, per-agent apps via DDB creds), so
 * the caller passes the right token explicitly.
 *
 * Load-bearing gotcha: when the token lacks `files:read`, Slack does NOT 401
 * — it returns HTTP 200 with an HTML login page. The content-type guard below
 * is what keeps HTML bytes from being "analyzed" or ingested as a document.
 *
 * Everything after download runs through the surface-agnostic pipeline
 * (src/lib/media/process.ts) — same path as Telegram and dashboard chat.
 */

import { logger } from '../../observability/logger.js';
import type { SlackFile } from './types.js';
import {
  processMedia,
  buildKbConfirmation,
  kindForMime,
  type MediaKind,
  type MediaStage,
} from '../../lib/media/process.js';
import type { AttachmentBlock } from '../../agent/agent-loop.js';
import { getConfig } from '../../lib/state/runtime-config-repo.js';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
/** Process at most this many files per message — bounds turn latency. */
const MAX_FILES_PER_MESSAGE = 3;

export function classifySlackFile(f: SlackFile): MediaKind {
  return kindForMime(f.mimetype);
}

export async function downloadSlackFile(
  f: SlackFile,
  botToken: string,
): Promise<{ bytes: Buffer; fileName: string; mimeType?: string } | null> {
  const url = f.url_private_download ?? f.url_private;
  if (!url) {
    logger.warn({ fileId: f.id }, 'slack file has no private url');
    return null;
  }
  const maxBytes = Number(
    (await getConfig('media', 'chat_kb_ingest_max_bytes')) ?? DEFAULT_MAX_BYTES,
  );
  if (f.size && f.size > maxBytes) {
    logger.info({ fileId: f.id, size: f.size, maxBytes }, 'slack file over size cap; skipping');
    return null;
  }
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!resp.ok) {
      logger.warn({ fileId: f.id, status: resp.status }, 'slack file download failed');
      return null;
    }
    const contentType = resp.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      // 200 + HTML = Slack login page = the token can't read files
      // (missing files:read scope or wrong workspace). Never treat as content.
      logger.warn(
        { fileId: f.id },
        'slack returned HTML for url_private — bot token likely missing the files:read scope',
      );
      return null;
    }
    const bytes = Buffer.from(await resp.arrayBuffer());
    if (bytes.length > maxBytes) {
      logger.info({ fileId: f.id, bytes: bytes.length, maxBytes }, 'slack file over size cap after download; skipping');
      return null;
    }
    return {
      bytes,
      fileName: f.name ?? f.title ?? `${f.id}.bin`,
      mimeType: f.mimetype,
    };
  } catch (err) {
    logger.warn(
      { fileId: f.id, errMessage: err instanceof Error ? err.message : String(err) },
      'slack file download threw',
    );
    return null;
  }
}

export interface SlackFilesResult {
  /** Inline multimodal blocks for the agent turn. */
  blocks: AttachmentBlock[];
  /** Transcripts from voice/audio/video files. */
  transcripts: Array<{ text: string; kind: 'audio' | 'video' }>;
  /** Ack lines for files that could not be analyzed inline (stored/KB-only). */
  acks: string[];
  /** Knowledge-base confirmations to post after the turn. */
  kbConfirmations: string[];
  /** Count of files that failed to download entirely. */
  failed: number;
}

export async function processSlackFiles(args: {
  files: SlackFile[];
  botToken: string;
  /** Owning bot agent (main app => 'main'; per-agent app => that agent). */
  agentId: string;
  /** Picked target agent — KB scope resolution. */
  targetAgentId: string;
  chatId: string;
  onStage?: (stage: MediaStage, fileName: string) => void;
}): Promise<SlackFilesResult> {
  const out: SlackFilesResult = {
    blocks: [],
    transcripts: [],
    acks: [],
    kbConfirmations: [],
    failed: 0,
  };
  const files = args.files.slice(0, MAX_FILES_PER_MESSAGE);
  for (const f of files) {
    const dl = await downloadSlackFile(f, args.botToken);
    if (!dl) {
      out.failed += 1;
      continue;
    }
    const media = await processMedia(
      {
        surface: 'slack',
        agentId: args.agentId,
        targetAgentId: args.targetAgentId,
        chatId: args.chatId,
        kind: classifySlackFile(f),
        fileName: dl.fileName,
        mimeType: dl.mimeType,
        bytes: dl.bytes,
      },
      (stage) => args.onStage?.(stage, dl.fileName),
    );
    out.blocks.push(...media.blocks);
    if (media.transcript) {
      out.transcripts.push({
        text: media.transcript,
        kind: media.transcriptKind ?? 'audio',
      });
    }
    if (media.ackText) out.acks.push(media.ackText);
    if (media.kb) out.kbConfirmations.push(buildKbConfirmation(media.kb, dl.fileName));
  }
  return out;
}

export { stageLabel } from '../../lib/media/process.js';
