/**
 * Amazon Polly text-to-speech wrapper.
 *
 * Used by the Telegram adapter to send voice replies. Defaults to a
 * Neural voice when available (gender-neutral "Ruth"), falls back to
 * Standard "Joanna" if the engine isn't available in the region.
 *
 * Output: MP3 or OGG/Vorbis. Polly CANNOT emit Opus, which Telegram voice
 * notes require — the Telegram path synthesizes MP3 here and transcodes to
 * OGG/Opus via lib/audio/opus.ts (ffmpeg) before sending.
 */

import {
  PollyClient,
  SynthesizeSpeechCommand,
  type Engine,
  type LanguageCode,
  type OutputFormat,
  type VoiceId,
} from '@aws-sdk/client-polly';
import { logger } from '../../observability/logger.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const MAX_CHARS = 3000;

let _polly: PollyClient | null = null;
function polly(): PollyClient {
  if (!_polly) _polly = new PollyClient({ region });
  return _polly;
}

export interface SynthInput {
  text: string;
  /** OGG_VORBIS (Telegram voice), MP3, or PCM (raw signed-16 LE for the Jarvis browser path). */
  format?: OutputFormat;
  /** Neural by default; falls back to standard if Neural unsupported. */
  engine?: Engine;
  voiceId?: VoiceId;
  /** BCP-47 language. Defaults to en-US to preserve the Telegram caller's behaviour. */
  languageCode?: LanguageCode;
  /** PCM sample rate as a string ('8000' | '16000'); Polly default applies for non-PCM. */
  sampleRate?: string;
  /** When true, `text` is SSML (e.g. <speak><prosody rate="116%">…</prosody></speak>)
   *  and is sent with TextType:'ssml'. The caller owns valid, escaped SSML. */
  ssml?: boolean;
}

export interface SynthResult {
  bytes: Buffer;
  contentType: string;
  format: OutputFormat;
  /** Numeric sample rate of the returned audio — what a raw-PCM consumer must decode at. */
  sampleRate: number;
}

function contentTypeFor(format: OutputFormat): string {
  if (format === 'mp3') return 'audio/mpeg';
  if (format === 'pcm') return 'audio/pcm';
  return 'audio/ogg';
}

export async function synthesize(input: SynthInput): Promise<SynthResult> {
  // Never truncate SSML — slicing mid-tag yields invalid markup that Polly
  // rejects. SSML callers pass short, self-built documents, so the cap is moot.
  const text = !input.ssml && input.text.length > MAX_CHARS
    ? input.text.slice(0, MAX_CHARS - 1) + '…'
    : input.text;
  const format: OutputFormat = input.format ?? 'ogg_vorbis';
  const engine: Engine = input.engine ?? 'neural';
  const voice: VoiceId = input.voiceId ?? 'Ruth';
  const languageCode: LanguageCode = input.languageCode ?? 'en-US';
  // Polly PCM is signed-16 LE at 8 or 16 kHz; 16 kHz is the highest it offers.
  const sampleRate = input.sampleRate ?? (format === 'pcm' ? '16000' : undefined);

  const resp = await polly().send(
    new SynthesizeSpeechCommand({
      Text: text,
      ...(input.ssml ? { TextType: 'ssml' as const } : {}),
      OutputFormat: format,
      Engine: engine,
      VoiceId: voice,
      LanguageCode: languageCode,
      ...(sampleRate ? { SampleRate: sampleRate } : {}),
    }),
  );
  if (!resp.AudioStream) {
    throw new Error('Polly returned no AudioStream');
  }
  const bytes = await resp.AudioStream.transformToByteArray();
  logger.info(
    {
      chars: text.length,
      bytes: bytes.byteLength,
      engine,
      voice,
      format,
    },
    'polly synthesized',
  );
  return {
    bytes: Buffer.from(bytes),
    contentType: contentTypeFor(format),
    format,
    sampleRate: Number(sampleRate ?? (format === 'pcm' ? '16000' : '24000')),
  };
}
