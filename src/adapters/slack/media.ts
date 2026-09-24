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
import { CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENT_MAX_FILES } from '../../lib/chat/attachments.js';

export function classifySlackFile(f: SlackFile): MediaKind {
  return kindForMime(f.mimetype);
}

async function slackFileMaxBytes(): Promise<number> {
  const configured = Number(await getConfig('media', 'chat_kb_ingest_max_bytes'));
  return Math.min(
    CHAT_ATTACHMENT_MAX_BYTES,
    Number.isFinite(configured) && configured >= 0 ? configured : CHAT_ATTACHMENT_MAX_BYTES,
  );
}

export async function downloadSlackFile(
  f: SlackFile,
  botToken: string,
  maxBytes?: number,
): Promise<{ bytes: Buffer; fileName: string; mimeType?: string } | null> {
  const url = f.url_private_download ?? f.url_private;
  if (!url) {
    logger.warn({ fileId: f.id }, 'slack file has no private url');
    return null;
  }
  const cap = maxBytes ?? await slackFileMaxBytes();
  if ((f.size ?? 0) > cap) {
    logger.info({ fileId: f.id, size: f.size, maxBytes: cap }, 'slack file over size cap; skipping');
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
    if (bytes.length > cap) {
      logger.info({ fileId: f.id, bytes: bytes.length, maxBytes: cap }, 'slack file over size cap after download; skipping');
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
  const files = args.files.slice(0, CHAT_ATTACHMENT_MAX_FILES);
  const maxBytes = await slackFileMaxBytes();
  for (const f of args.files.slice(CHAT_ATTACHMENT_MAX_FILES)) {
    out.acks.push(`${f.name ?? f.title ?? f.id} was skipped because only three files can be sent at once.`);
  }
  for (const f of files) {
    if ((f.size ?? 0) > maxBytes) {
      const fileName = f.name ?? f.title ?? f.id;
      const capMb = Math.max(1, Math.round(maxBytes / (1024 * 1024)));
      out.acks.push(`${fileName} is over the ${capMb} MB limit, so it was not read.`);
      out.failed += 1;
      continue;
    }
    const dl = await downloadSlackFile(f, args.botToken, maxBytes);
    if (!dl) {
      out.failed += 1;
      continue;
    }
    // decision 3: Slack has no per-file opt-in, so chat files are never imported into the knowledge base.
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
