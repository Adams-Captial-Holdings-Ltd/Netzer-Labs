/**
 * Amazon Transcribe wrapper for voice + audio messages.
 *
 * Telegram voice notes arrive as OGG/Opus; longer audio files are
 * usually MP3 or M4A. Transcribe accepts a fixed set of MediaFormats,
 * so we map upfront and bail when we hit an unsupported format.
 *
 * Implementation: batch StartTranscriptionJob with a polling wait.
 * We could stream, but voice notes are usually < 30s and the polling
 * adds ~5-10s wall clock — acceptable for now. The bot edits the
 * "thinking" placeholder so the user sees progress.
 *
 * Output: the raw transcript string is returned, ready to feed into
 * the agent loop as the user's message text.
 */

import {
  GetTranscriptionJobCommand,
  StartTranscriptionJobCommand,
  TranscribeClient,
  type MediaFormat,
} from '@aws-sdk/client-transcribe';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { logger, truncateForLog } from '../../observability/logger.js';
import { captureAwsClient } from '../observability/xray.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const POLL_INTERVAL_MS = 1500;
const MAX_WAIT_MS = 60_000;

let _transcribe: TranscribeClient | null = null;
function transcribeClient(): TranscribeClient {
  if (!_transcribe) _transcribe = new TranscribeClient({ region });
  return _transcribe;
}

let _s3: S3Client | null = null;
function s3(): S3Client {
  if (!_s3) _s3 = captureAwsClient(new S3Client({ region }));
  return _s3;
}

export type TranscribeMimeType =
  | 'audio/ogg'
  | 'audio/oga'
  | 'audio/mp3'
  | 'audio/mpeg'
  | 'audio/wav'
  | 'audio/x-wav'
  | 'audio/mp4'
  | 'audio/x-m4a'
  | 'audio/webm'
  | 'audio/flac'
  // Transcribe ingests mp4/webm containers natively, so chat-uploaded videos
  // go straight in from their raw S3 URI — no audio extraction needed.
  | 'video/mp4'
  | 'video/webm';

const FORMAT_MAP: Record<string, MediaFormat> = {
  'audio/ogg': 'ogg',
  'audio/oga': 'ogg',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'mp4',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

export interface TranscribeRequest {
  /** S3 URI of the audio (s3://bucket/key). */
  s3Uri: string;
  /** Source MIME from Telegram. Used to pick MediaFormat. */
  mimeType?: string;
  /** Optional BCP-47 language code; defaults to auto-detect. */
  languageCode?: string;
  /** Job name suffix for traceability (chatId is a good choice). */
  jobNameSuffix?: string;
  /**
   * Poll deadline. Defaults to 60s (voice notes); video callers pass a
   * longer window since a 10-minute recording can take minutes to process.
   */
  maxWaitMs?: number;
}

export interface TranscribeResult {
  transcript: string;
  languageCode?: string;
  durationSec?: number;
  jobName: string;
}

export class TranscribeUnsupportedFormatError extends Error {
  constructor(public mimeType: string) {
    super(`unsupported MediaFormat for Transcribe: ${mimeType}`);
    this.name = 'TranscribeUnsupportedFormatError';
  }
}

export class TranscribeTimeoutError extends Error {
  constructor(public jobName: string, waitedMs: number = MAX_WAIT_MS) {
    super(`Transcribe job did not complete within ${waitedMs}ms: ${jobName}`);
    this.name = 'TranscribeTimeoutError';
  }
}

function pickMediaFormat(mimeType?: string): MediaFormat | undefined {
  if (!mimeType) return undefined;
  const lower = mimeType.toLowerCase();
  return FORMAT_MAP[lower];
}

export async function transcribeAudio(
  req: TranscribeRequest,
): Promise<TranscribeResult> {
  const mediaFormat = pickMediaFormat(req.mimeType);
  if (!mediaFormat) {
    throw new TranscribeUnsupportedFormatError(req.mimeType ?? '(none)');
  }

  const suffix = (req.jobNameSuffix ?? 'job')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 32);
  const jobName = `cce-${Date.now()}-${suffix}-${Math.random().toString(36).slice(2, 8)}`;

  logger.info(
    {
      jobName,
      mediaFormat,
      s3Uri: truncateForLog(req.s3Uri, 120),
      language: req.languageCode ?? 'auto',
    },
    'starting transcription job',
  );

  await transcribeClient().send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      MediaFormat: mediaFormat,
      Media: { MediaFileUri: req.s3Uri },
      ...(req.languageCode
        ? { LanguageCode: req.languageCode as never }
        : { IdentifyLanguage: true }),
    }),
  );

  // Poll until the job finishes. Transcribe charges per second of
  // audio, not per second of wall clock, so the loop overhead is free.
  const maxWaitMs = req.maxWaitMs ?? MAX_WAIT_MS;
  const deadline = Date.now() + maxWaitMs;
  let lastStatus = 'IN_PROGRESS';
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const status = await transcribeClient().send(
      new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
    );
    const job = status.TranscriptionJob;
    lastStatus = job?.TranscriptionJobStatus ?? 'UNKNOWN';
    if (lastStatus === 'COMPLETED') {
      const transcriptUri = job?.Transcript?.TranscriptFileUri;
      if (!transcriptUri) throw new Error('Transcribe completed without TranscriptFileUri');
      const transcript = await fetchTranscript(transcriptUri);
      return {
        transcript,
        languageCode: job?.LanguageCode,
        durationSec: job?.Media ? undefined : undefined,
        jobName,
      };
    }
    if (lastStatus === 'FAILED') {
      throw new Error(
        `Transcribe job failed: ${job?.FailureReason ?? 'no reason given'}`,
      );
    }
  }
  throw new TranscribeTimeoutError(jobName, maxWaitMs);
}

interface TranscriptJson {
  results?: {
    transcripts?: Array<{ transcript: string }>;
  };
}

async function fetchTranscript(uri: string): Promise<string> {
  // TranscriptFileUri is an https:// presigned URL by default. We could
  // fetch it directly with the global fetch, but if the job was created
  // with OutputBucketName the URI is s3:// and we need the S3 client.
  if (uri.startsWith('s3://')) {
    const { bucket, key } = parseS3Uri(uri);
    const out = await s3().send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = await out.Body?.transformToString();
    if (!body) throw new Error('empty transcript body from S3');
    return parseTranscriptJson(body);
  }
  const resp = await fetch(uri);
  if (!resp.ok) {
    throw new Error(`failed to fetch transcript URI: ${resp.status}`);
  }
  return parseTranscriptJson(await resp.text());
}

function parseTranscriptJson(raw: string): string {
  const json = JSON.parse(raw) as TranscriptJson;
  return (json.results?.transcripts ?? [])
    .map((t) => t.transcript)
    .join(' ')
    .trim();
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`invalid s3 uri: ${uri}`);
  return { bucket: m[1], key: m[2] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
