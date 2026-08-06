/**
 * Transcode synthesized speech (Polly MP3) into OGG/Opus.
 *
 * Telegram voice notes MUST be OGG/Opus — anything else (Polly emits MP3 or
 * OGG/Vorbis) is accepted by sendVoice but plays back blank and silent. Polly
 * cannot produce Opus and there is no usable pure-JS encoder, so we shell out
 * to ffmpeg, which the runtime image installs (`apk add ffmpeg`). Mono, 32 kbps,
 * `voip` application profile — small and clear for speech.
 *
 * Rejects if ffmpeg is missing, exits non-zero, or runs long. The Telegram
 * caller already sends the text reply before TTS, and catches a rejection to
 * fall back to text-only — so a transcode failure degrades gracefully.
 */

import { spawn } from 'node:child_process';

export function transcodeToOpusOgg(input: Buffer, timeoutMs = 15_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0', // read MP3 from stdin
      '-ac',
      '1', // mono
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-application',
      'voip',
      '-f',
      'ogg',
      'pipe:1', // write OGG/Opus to stdout
    ]);

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      ff.kill('SIGKILL');
      reject(new Error('ffmpeg transcode timed out'));
    }, timeoutMs);

    ff.stdout.on('data', (d: Buffer) => out.push(d));
    ff.stderr.on('data', (d: Buffer) => err.push(d));
    ff.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg spawn failed: ${e.message}`));
    });
    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.length > 0) {
        resolve(Buffer.concat(out));
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`));
      }
    });
    // ffmpeg may close stdin early on error; ignore the resulting EPIPE.
    ff.stdin.on('error', () => {});
    ff.stdin.end(input);
  });
}
