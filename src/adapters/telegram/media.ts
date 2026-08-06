/**
 * Telegram media downloader — Telegram-specific download only.
 *
 * Flow:
 *   1. getFile(file_id) -> file_path (Bot API caps downloads at 20MB)
 *   2. download from https://api.telegram.org/file/bot<TOKEN>/<file_path>
 *   3. delegate to the surface-agnostic pipeline (src/lib/media/process.ts):
 *      S3 raw store, classification, multimodal blocks, Transcribe,
 *      knowledge-base auto-ingest.
 */

import { logger } from '../../observability/logger.js';
import type { IncomingAttachment } from './types.js';
import { getBotToken } from './send.js';
import { isKillSwitchActive } from '../../lib/state/kill-switches-repo.js';
import {
  processMedia,
  type MediaStage,
  type ProcessedMedia,
} from '../../lib/media/process.js';

export type { ProcessedMedia as MediaProcessed } from '../../lib/media/process.js';

interface TgFileResp {
  ok: boolean;
  result?: { file_id: string; file_path?: string; file_size?: number };
  description?: string;
}

export async function downloadAndStore(
  botAgentId: string,
  chatId: string,
  attachment: IncomingAttachment,
  opts?: {
    /** Picked agent for KB scope resolution; defaults to the bot agent. */
    targetAgentId?: string;
    onStage?: (stage: MediaStage) => void;
  },
): Promise<ProcessedMedia | null> {
  const killed = await isKillSwitchActive('media_upload_disabled');
  if (killed.active) {
    logger.warn(
      { botAgentId, chatId, reason: killed.reason },
      'media_upload_disabled kill switch active; refusing download',
    );
    return {
      s3Url: '',
      s3Key: '',
      byteLength: 0,
      blocks: [],
      kind: attachment.kind,
      ackText:
        'Media uploads are temporarily disabled. Type your question and I\'ll answer.',
    };
  }
  const token = getBotToken(botAgentId);
  if (!token) {
    logger.warn({ botAgentId }, 'no token for media download');
    return null;
  }

  // 1. resolve file_path via getFile
  const metaResp = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(attachment.fileId)}`,
  );
  const meta = (await metaResp.json()) as TgFileResp;
  if (!meta.ok || !meta.result?.file_path) {
    // The Bot API refuses getFile for files over 20MB with "file is too big".
    // Surface that as a friendly ack instead of a generic failure.
    if (meta.description?.toLowerCase().includes('too big')) {
      return {
        s3Url: '',
        s3Key: '',
        byteLength: attachment.size ?? 0,
        blocks: [],
        kind: attachment.kind,
        ackText:
          'Telegram only lets bots fetch files up to 20MB — this one is bigger. Upload it via the dashboard Knowledge tab instead and I can work with it there.',
      };
    }
    logger.warn({ botAgentId, attachment, meta }, 'telegram getFile failed');
    return null;
  }
  const filePath = meta.result.file_path;

  // 2. download
  const dl = await fetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`,
  );
  if (!dl.ok) {
    logger.warn({ status: dl.status, filePath }, 'telegram file download failed');
    return null;
  }
  const bytes = Buffer.from(await dl.arrayBuffer());
  const fileName =
    attachment.fileName ?? filePath.split('/').pop() ?? `${attachment.kind}.bin`;

  // 3. surface-agnostic pipeline (S3, classify, transcribe, KB ingest)
  return processMedia(
    {
      surface: 'telegram',
      agentId: botAgentId,
      targetAgentId: opts?.targetAgentId ?? botAgentId,
      chatId,
      kind: attachment.kind,
      fileName,
      mimeType: attachment.mimeType,
      bytes,
    },
    opts?.onStage,
  );
}
