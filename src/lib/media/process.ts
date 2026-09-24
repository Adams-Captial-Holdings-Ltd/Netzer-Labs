/**
 * Surface-agnostic chat media pipeline.
 *
 * Every chat surface (Telegram, Slack, dashboard chat) downloads its file its
 * own way, then hands the bytes here. One pipeline = parity by construction
 * (CLAUDE.md "chat surface parity" rule):
 *
 *   1. store raw bytes to s3://RAW_BUCKET/<surface>/<chat>/<date>/<file>
 *   2. classify (image magic bytes / doc extension)
 *   3. supported images and documents -> Bedrock blocks within their per-block limits
 *   4. voice/audio -> Amazon Transcribe -> transcript text
 *   5. opted-in documents and video transcripts -> knowledge-base ingest
 *
 * Extracted from src/adapters/telegram/media.ts, which now only does the
 * Telegram-specific download and delegates here.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { writeAudit } from '../audit/audit-writer.js';
import { logger, truncateForLog } from '../../observability/logger.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import {
  transcribeAudio,
  type TranscribeMimeType,
} from '../transcribe/transcriber.js';
import { captureAwsClient } from '../observability/xray.js';
import type { AttachmentBlock } from '../../agent/agent-loop.js';
import { getConfig } from '../state/runtime-config-repo.js';
import { checkZip, ZipCheckError } from '../chat/zip-check.js';
import { extractPptxText } from '../vectors/extractors.js';
import {
  extractAudioTrack,
  extractKeyframes,
  probeVideo,
  writeTempFile,
} from '../video/frames.js';
import {
  ingestChatMedia,
  ingestFormatFor,
  type ChatSurface,
  type ChatKbIngestResult,
} from './chat-kb-ingest.js';

export type { ChatSurface } from './chat-kb-ingest.js';
export { buildKbConfirmation } from './chat-kb-ingest.js';

/** Fetch a raw-bucket object (e.g. a generated image for native delivery). */
export async function getRawObject(key: string, bucket?: string): Promise<Buffer> {
  const b = bucket || RAW_BUCKET;
  if (!b) throw new Error('RAW_BUCKET not configured');
  const out = await s3().send(new GetObjectCommand({ Bucket: b, Key: key }));
  if (!out.Body) throw new Error(`object not found: s3://${b}/${key}`);
  return Buffer.from(await out.Body.transformToByteArray());
}

/** Re-mint a short-lived download for a stored chat attachment. */
export async function presignRawAttachment(key: string, name: string): Promise<string> {
  if (!RAW_BUCKET) throw new Error('RAW_BUCKET not configured');
  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: RAW_BUCKET, Key: key, ResponseContentDisposition: disposition,
  }), { expiresIn: 300 });
}

/** Classify a chat upload by MIME type — shared by Slack + dashboard. */
export function kindForMime(mimeType?: string): MediaKind {
  const mt = (mimeType ?? '').toLowerCase();
  if (mt.startsWith('image/')) return 'photo';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.startsWith('video/')) return 'video';
  return 'document';
}

/** Display copy for pipeline stages — surfaces edit their placeholder with it. */
export function stageLabel(stage: MediaStage, fileName: string): string {
  switch (stage) {
    case 'storing':
      return `📥 saving ${fileName}…`;
    case 'transcribing':
      return `🎙️ transcribing ${fileName}…`;
    case 'extracting_frames':
      return `🎞️ watching ${fileName}…`;
    case 'indexing':
      return `📚 indexing ${fileName} into the knowledge base…`;
  }
}

const region = process.env.AWS_REGION ?? 'us-east-1';
const RAW_BUCKET = process.env.RAW_BUCKET ?? '';
const MAX_IMAGE_BYTES = 3_750_000;
const MAX_DOCUMENT_BYTES = 4_500_000;
const MAX_TRANSCRIBE_BYTES = 20 * 1024 * 1024;

let _s3: S3Client | null = null;
function s3(): S3Client {
  if (!_s3) _s3 = captureAwsClient(new S3Client({ region }));
  return _s3;
}

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';
export type DocFormat = 'pdf' | 'txt' | 'md' | 'csv' | 'docx' | 'pptx';
export type MediaKind = 'photo' | 'voice' | 'audio' | 'document' | 'video';
export type MediaStage = 'storing' | 'transcribing' | 'extracting_frames' | 'indexing';

export interface RawMediaInput {
  surface: ChatSurface;
  /** Bot / owning agent — S3 metadata + audit attribution. */
  agentId: string;
  /** Picked target agent — resolves the KB ingest scope. */
  targetAgentId: string;
  chatId: string;
  kind: MediaKind;
  fileName?: string;
  mimeType?: string;
  /** Raw bytes, already downloaded by the surface adapter. */
  bytes: Buffer;
  /** Pre-staged S3 key (dashboard presigned uploads) — skips the raw put. */
  s3Key?: string;
  /** Pre-staged objects live in a different bucket (vectors staging). */
  s3Bucket?: string;
  addToKnowledge?: boolean;
}

export interface ProcessedMedia {
  s3Url: string;
  s3Key: string;
  byteLength: number;
  /** Inline multimodal blocks for the agent turn (images / documents). */
  blocks: AttachmentBlock[];
  /** Transcribed text when voice/audio went through Transcribe. */
  transcript?: string;
  transcriptKind?: 'audio' | 'video';
  /**
   * Non-empty => the adapter should ack with this text and stop the turn
   * (nothing analyzable). Empty => proceed to the agent loop.
   */
  ackText: string;
  /** Set when the sender opted in and the file was ingested into the knowledge base. */
  kb?: ChatKbIngestResult | null;
  kind: MediaKind;
  imageFormat?: ImageFormat;
  docFormat?: DocFormat;
}

export async function processMedia(
  input: RawMediaInput,
  onStage?: (stage: MediaStage) => void,
): Promise<ProcessedMedia> {
  const killed = await isKillSwitchActive('media_upload_disabled');
  if (killed.active) {
    logger.warn(
      { surface: input.surface, chatId: input.chatId, reason: killed.reason },
      'media_upload_disabled kill switch active; refusing to process media',
    );
    return {
      s3Url: '',
      s3Key: '',
      byteLength: 0,
      blocks: [],
      kind: input.kind,
      ackText:
        "Media uploads are temporarily disabled. Type your question and I'll answer.",
    };
  }

  const bytes = input.bytes;
  const baseName = input.fileName ?? `${input.kind}.bin`;
  const safeName = baseName.replace(/[^A-Za-z0-9._-]/g, '_');

  // 1. store raw (skip when the surface already staged the object in S3)
  let s3Key = input.s3Key ?? '';
  let s3Url: string;
  if (input.s3Key) {
    s3Url = `s3://${input.s3Bucket ?? RAW_BUCKET}/${input.s3Key}`;
  } else {
    safeStage(onStage, 'storing');
    const now = new Date();
    const dayPath = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')}`;
    s3Key = `${input.surface}/${input.chatId}/${dayPath}/${Date.now()}-${safeName}`;
    if (RAW_BUCKET) {
      try {
        await s3().send(
          new PutObjectCommand({
            Bucket: RAW_BUCKET,
            Key: s3Key,
            Body: bytes,
            ContentType: input.mimeType ?? guessContentType(safeName, input.kind),
            Metadata: {
              'agent-id': input.agentId,
              'chat-id': input.chatId,
              kind: input.kind,
            },
          }),
        );
      } catch (err) {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err), s3Key },
          's3 raw upload failed',
        );
      }
    }
    s3Url = RAW_BUCKET ? `s3://${RAW_BUCKET}/${s3Key}` : `local://${s3Key}`;
  }

  // 2. classify
  const docFormat = recognizeDoc(input.mimeType, safeName);
  const imageFormat = input.kind === 'document' && docFormat
    ? undefined
    : recognizeImage(input.kind, input.mimeType, safeName, bytes);
  const blocks: AttachmentBlock[] = [];
  let unsafeDocument = false;
  let zipCheckCode: ZipCheckError['code'] | undefined;
  if (input.kind === 'document' && (docFormat === 'docx' || docFormat === 'pptx')) {
    try {
      checkZip(bytes);
    } catch (err) {
      if (!(err instanceof ZipCheckError)) throw err;
      unsafeDocument = true;
      zipCheckCode = err.code;
      logger.warn({ fileName: safeName, code: err.code }, 'zip check failed');
    }
  }
  if (imageFormat && bytes.length <= MAX_IMAGE_BYTES) {
    blocks.push({ kind: 'image', format: imageFormat, bytes });
  } else if (input.kind === 'document' && docFormat && !unsafeDocument && bytes.length <= MAX_DOCUMENT_BYTES) {
    if (docFormat === 'pptx') {
      try {
        const extracted = await extractPptxText(bytes);
        const text = Buffer.from(extracted.text, 'utf8');
        if (text.length > 0 && text.length <= MAX_DOCUMENT_BYTES) {
          blocks.push({ kind: 'document', format: 'txt', name: safeName, bytes: text });
        }
      } catch (err) {
        unsafeDocument = true;
        logger.warn({ fileName: safeName, errMessage: err instanceof Error ? err.message : String(err) }, 'pptx extraction failed');
      }
    } else {
      blocks.push({ kind: 'document', format: docFormat, name: safeName, bytes });
    }
  }

  // 3. voice/audio -> Transcribe (needs the object in S3)
  let transcript: string | undefined;
  let transcriptKind: 'audio' | 'video' | undefined;
  if (
    (input.kind === 'voice' || input.kind === 'audio') &&
    s3Url.startsWith('s3://') &&
    bytes.length <= MAX_TRANSCRIBE_BYTES &&
    process.env.CCE_TRANSCRIBE_DISABLED !== '1'
  ) {
    safeStage(onStage, 'transcribing');
    try {
      const mime =
        input.mimeType ?? (input.kind === 'voice' ? 'audio/ogg' : 'audio/mpeg');
      const result = await transcribeAudio({
        s3Uri: s3Url,
        mimeType: mime as TranscribeMimeType,
        jobNameSuffix: `${input.agentId}-${input.chatId}`,
      });
      if (result.transcript) {
        transcript = result.transcript;
        transcriptKind = 'audio';
        logger.info(
          {
            surface: input.surface,
            chatId: input.chatId,
            jobName: result.jobName,
            language: result.languageCode,
            length: transcript.length,
          },
          'voice transcribed',
        );
      }
    } catch (err) {
      logger.warn(
        {
          surface: input.surface,
          chatId: input.chatId,
          errMessage: err instanceof Error ? err.message : String(err),
        },
        'transcribe failed; falling back to ack',
      );
    }
  }

  // 3b. video -> transcript (Transcribe) + keyframes (ffmpeg)
  let videoFailureAck: string | undefined;
  if (input.kind === 'video') {
    const v = await processVideo(input, s3Url, safeName, onStage);
    blocks.push(...v.blocks);
    if (v.transcript) {
      transcript = v.transcript;
      transcriptKind = 'video';
    }
    videoFailureAck = v.failureAck;
  }

  // 4. knowledge-base ingest only when the sender opted in
  let kb: ChatKbIngestResult | null = null;
  if (input.addToKnowledge === true && input.kind === 'document' && docFormat && !unsafeDocument && ingestFormatFor(safeName)) {
    safeStage(onStage, 'indexing');
    kb = await ingestChatMedia({
      targetAgentId: input.targetAgentId,
      chatId: input.chatId,
      surface: input.surface,
      fileName: safeName,
      bytes,
      sourceS3Url: s3Url,
    });
  } else if (input.addToKnowledge === true && input.kind === 'video' && transcript) {
    safeStage(onStage, 'indexing');
    kb = await ingestChatMedia({
      targetAgentId: input.targetAgentId,
      chatId: input.chatId,
      surface: input.surface,
      fileName: safeName,
      transcript,
      sourceS3Url: s3Url,
      extraTags: ['video'],
    });
  }

  const ackText =
    input.kind === 'video'
      ? blocks.length > 0 || transcript
        ? ''
        : (videoFailureAck ?? `got the video (${Math.round(bytes.length / 1024)} KB), stored. Couldn't watch it just now — type out the question and I'll answer.`)
      : unsafeDocument
        ? `Could not open ${safeName} safely. The file was stored but not read.`
        : input.kind === 'photo' && !imageFormat
          ? `${safeName} is not a PNG, JPEG, GIF or WebP image, so it was stored but not read.`
        : input.kind === 'document' && docFormat && bytes.length > MAX_DOCUMENT_BYTES
          ? `${safeName} is over the 4.5 MB document limit, so it was stored but not read.`
          : imageFormat && bytes.length > MAX_IMAGE_BYTES
            ? `${safeName} is over the 3.75 MB image limit, so it was stored but not read.`
            : buildAck(input.kind, safeName, bytes.length, blocks.length > 0, !!transcript, kb);

  void writeAudit({
    action: 'media_upload',
    agentId: input.agentId,
    chatId: input.chatId,
    surface: input.surface,
    detail: {
      kind: input.kind,
      bytes: bytes.length,
      s3Url,
      analyzed: blocks.length > 0,
      ...(zipCheckCode ? { zipCheck: zipCheckCode } : {}),
      ...(kb ? { kbDocId: kb.docId, kbScope: kb.scope, kbDeduped: kb.deduped } : {}),
    },
    result: 'ok',
  });
  logger.info(
    {
      surface: input.surface,
      agentId: input.agentId,
      chatId: input.chatId,
      kind: input.kind,
      bytes: bytes.length,
      s3Url: truncateForLog(s3Url, 120),
      analyzable: blocks.length > 0,
      kbIngested: !!kb && !kb.deduped,
    },
    'media stored',
  );

  return {
    s3Url,
    s3Key,
    byteLength: bytes.length,
    blocks,
    transcript,
    transcriptKind,
    ackText,
    kb,
    kind: input.kind,
    imageFormat,
    docFormat,
  };
}

function safeStage(onStage: ((s: MediaStage) => void) | undefined, stage: MediaStage): void {
  try {
    onStage?.(stage);
  } catch {
    /* stage UX must never break processing */
  }
}

// ── Video understanding ─────────────────────────────────────────────────────
// Transcript via Amazon Transcribe (mp4/webm ingest natively from the raw S3
// URI; other containers get an ffmpeg audio extraction first) + N evenly
// spaced keyframes as inline image blocks, so the model "watched" the video.
// Every failure degrades — frames without transcript, transcript without
// frames, or a stored-only ack — never a failed turn.

/** Bound concurrent in-task video jobs: bytes + temp file + frames are held
 * in memory, so N simultaneous videos could stack ~150MB each on Fargate. */
const MAX_CONCURRENT_VIDEO = 2;
let activeVideoJobs = 0;

const DEFAULT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_VIDEO_MAX_DURATION_SEC = 600;
const DEFAULT_VIDEO_FRAME_COUNT = 6;
const DEFAULT_VIDEO_TRANSCRIBE_WAIT_MS = 180_000;

interface VideoResult {
  blocks: AttachmentBlock[];
  transcript?: string;
  /** Set when nothing usable came out — the user-facing reason. */
  failureAck?: string;
}

async function processVideo(
  input: RawMediaInput,
  s3Url: string,
  safeName: string,
  onStage?: (stage: MediaStage) => void,
): Promise<VideoResult> {
  const killed = await isKillSwitchActive('video_processing_disabled');
  const enabled = (await getConfig('media', 'video_enabled')) ?? '1';
  if (killed.active || enabled === '0') {
    return {
      blocks: [],
      failureAck: 'got the video, stored. Video understanding is switched off right now.',
    };
  }
  const maxBytes = Number(
    (await getConfig('media', 'video_max_bytes')) ?? DEFAULT_VIDEO_MAX_BYTES,
  );
  if (input.bytes.length > maxBytes) {
    return {
      blocks: [],
      failureAck: `got the video (${Math.round(input.bytes.length / 1024 / 1024)} MB), stored — but it's over the ${Math.round(maxBytes / 1024 / 1024)} MB processing cap.`,
    };
  }
  if (activeVideoJobs >= MAX_CONCURRENT_VIDEO) {
    return {
      blocks: [],
      failureAck: "got the video, stored. I'm processing other videos right now — send it again in a minute.",
    };
  }

  activeVideoJobs += 1;
  let temp: { path: string; cleanup: () => Promise<void> } | null = null;
  try {
    const ext = safeName.includes('.') ? safeName.split('.').pop()! : 'mp4';
    temp = await writeTempFile(input.bytes, ext);

    const probe = await probeVideo(temp.path).catch(() => null);
    if (!probe || probe.durationSec <= 0) {
      return {
        blocks: [],
        failureAck: "got the video, stored. Couldn't read it as a video file (ffprobe failed).",
      };
    }
    const maxDuration = Number(
      (await getConfig('media', 'video_max_duration_sec')) ?? DEFAULT_VIDEO_MAX_DURATION_SEC,
    );
    const tooLong = probe.durationSec > maxDuration;

    // Transcript — skipped for over-length videos (frames still extracted).
    let transcript: string | undefined;
    const mime = (input.mimeType ?? '').toLowerCase();
    if (!tooLong && s3Url.startsWith('s3://') && process.env.CCE_TRANSCRIBE_DISABLED !== '1') {
      safeStage(onStage, 'transcribing');
      const maxWaitMs = Number(
        (await getConfig('media', 'video_transcribe_max_wait_ms')) ?? DEFAULT_VIDEO_TRANSCRIBE_WAIT_MS,
      );
      try {
        if (mime === 'video/mp4' || mime === 'video/webm' || /\.(mp4|webm)$/i.test(safeName)) {
          // Transcribe ingests these containers natively from S3.
          const result = await transcribeAudio({
            s3Uri: s3Url,
            mimeType: (mime === 'video/webm' ? 'video/webm' : 'video/mp4') as TranscribeMimeType,
            jobNameSuffix: `${input.agentId}-${input.chatId}`,
            maxWaitMs,
          });
          transcript = result.transcript || undefined;
        } else {
          // mov/mkv/avi: extract the audio track, stage it, then transcribe.
          const audio = await extractAudioTrack(temp.path);
          const audioKey = `${input.surface}/${input.chatId}/audio-${Date.now()}.mp4`;
          await s3().send(
            new PutObjectCommand({
              Bucket: RAW_BUCKET,
              Key: audioKey,
              Body: audio,
              ContentType: 'audio/mp4',
            }),
          );
          const result = await transcribeAudio({
            s3Uri: `s3://${RAW_BUCKET}/${audioKey}`,
            mimeType: 'audio/mp4',
            jobNameSuffix: `${input.agentId}-${input.chatId}`,
            maxWaitMs,
          });
          transcript = result.transcript || undefined;
        }
      } catch (err) {
        logger.warn(
          {
            surface: input.surface,
            chatId: input.chatId,
            errMessage: err instanceof Error ? err.message : String(err),
          },
          'video transcription failed; degrading to frames-only',
        );
      }
    }

    // Keyframes
    safeStage(onStage, 'extracting_frames');
    const frameCount = Math.max(
      1,
      Math.min(8, Number((await getConfig('media', 'video_frame_count')) ?? DEFAULT_VIDEO_FRAME_COUNT)),
    );
    const frames = await extractKeyframes(temp.path, probe.durationSec, {
      count: frameCount,
    }).catch(() => [] as Buffer[]);
    const blocks: AttachmentBlock[] = frames.map((f) => ({
      kind: 'image' as const,
      format: 'jpeg' as const,
      bytes: f,
    }));

    logger.info(
      {
        surface: input.surface,
        chatId: input.chatId,
        durationSec: Math.round(probe.durationSec),
        frames: blocks.length,
        transcriptLength: transcript?.length ?? 0,
        tooLong,
      },
      'video processed',
    );
    return { blocks, transcript };
  } finally {
    activeVideoJobs -= 1;
    if (temp) await temp.cleanup().catch(() => {});
  }
}

function buildAck(
  kind: MediaKind,
  fileName: string,
  bytes: number,
  willAnalyze: boolean,
  hasTranscript: boolean,
  kb: ChatKbIngestResult | null,
): string {
  const kbSize = Math.round(bytes / 1024);
  if (kind === 'photo') {
    return willAnalyze ? '' : `got the photo (${kbSize} KB), stored.`;
  }
  if (kind === 'document') {
    if (willAnalyze) return '';
    if (kb) {
      // Not inline-analyzable (docx/pptx/txt/...) but it IS in the KB now —
      // tell the user the superpower they just gained instead of "stored".
      return kb.deduped
        ? `got ${fileName} (${kbSize} KB) — it's already in the knowledge base. Ask me anything about it.`
        : `got ${fileName} (${kbSize} KB) and indexed it into the knowledge base (${kb.chunks} chunk${kb.chunks === 1 ? '' : 's'}). Ask me anything about it — from Slack, Telegram, or the dashboard.`;
    }
    return `got the file ${fileName} (${kbSize} KB), stored. It could not be read inline.`;
  }
  if (kind === 'voice' || kind === 'audio') {
    // When we got a transcript the caller flows it into the agent loop;
    // returning '' lets the handler swallow the ack and respond normally.
    if (hasTranscript) return '';
    return `got the ${kind} note (${kbSize} KB), stored. Couldn't transcribe it just now — type out the question and I'll answer.`;
  }
  return `got the attachment, stored.`;
}

export function recognizeImage(
  kind: MediaKind,
  mimeType: string | undefined,
  _fileName: string,
  bytes: Buffer,
): ImageFormat | undefined {
  if (kind !== 'photo' && !mimeType?.toLowerCase().startsWith('image/')) return undefined;
  // Sniff complete format signatures; labels never supply a fallback.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png';
  if (
    bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) return 'gif';
  if (
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'webp';
  return undefined;
}

export function recognizeDoc(
  _mimeType: string | undefined,
  fileName: string,
): DocFormat | undefined {
  const fn = fileName.toLowerCase();
  if (fn.endsWith('.pdf')) return 'pdf';
  if (fn.endsWith('.docx')) return 'docx';
  if (fn.endsWith('.pptx')) return 'pptx';
  if (fn.endsWith('.txt')) return 'txt';
  if (fn.endsWith('.md')) return 'md';
  if (fn.endsWith('.csv')) return 'csv';
  return undefined;
}

export function guessContentType(fileName: string, kind: MediaKind): string {
  if (kind === 'photo') return 'image/jpeg';
  if (kind === 'voice') return 'audio/ogg';
  if (kind === 'audio') return 'audio/mpeg';
  if (kind === 'video') return 'video/mp4';
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}
