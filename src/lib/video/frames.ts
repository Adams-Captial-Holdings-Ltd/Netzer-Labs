/**
 * ffmpeg/ffprobe helpers for chat-uploaded videos.
 *
 * Unlike the audio transcode (src/lib/audio/opus.ts) which streams via stdin,
 * video work needs SEEKABLE input — ffmpeg's `-ss` fast-seek can't run on a
 * pipe. So these helpers write a temp file under os.tmpdir() (Fargate
 * ephemeral storage, 20GB) and clean it up in `finally` at the call site.
 *
 * The runtime image installs ffmpeg (`apk add ffmpeg`), which includes
 * ffprobe. Local dev without ffmpeg degrades gracefully — callers catch and
 * fall back to "stored, couldn't watch it".
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface VideoProbe {
  durationSec: number;
  width: number;
  height: number;
}

export async function writeTempFile(
  bytes: Buffer,
  ext: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cce-video-'));
  const path = join(dir, `${randomUUID()}.${ext.replace(/[^a-z0-9]/gi, '') || 'mp4'}`);
  await writeFile(path, bytes);
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function probeVideo(
  filePath: string,
  timeoutMs = 10_000,
): Promise<VideoProbe> {
  const stdout = await run(
    'ffprobe',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    timeoutMs,
  );
  const json = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
  };
  const video = json.streams?.find((s) => s.codec_type === 'video');
  const durationSec = Number(json.format?.duration ?? video?.duration ?? 0);
  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
  };
}

/**
 * Extract N evenly spaced keyframes as JPEG buffers, scaled to maxDim on the
 * long edge. Frame i is sampled at t = duration * (i + 0.5) / count, so a
 * 6-frame pull of a 60s video sees seconds 5, 15, 25, 35, 45, 55.
 */
export async function extractKeyframes(
  filePath: string,
  durationSec: number,
  opts?: { count?: number; maxDim?: number; timeoutMs?: number },
): Promise<Buffer[]> {
  const count = Math.max(1, Math.min(8, opts?.count ?? 6));
  const maxDim = opts?.maxDim ?? 1024;
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const frames: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.max(0, (durationSec * (i + 0.5)) / count);
    try {
      const frame = await runBinary(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-ss', t.toFixed(2),
          '-i', filePath,
          '-frames:v', '1',
          // Scale the long edge down to maxDim, keep aspect, even dims.
          '-vf', `scale='min(${maxDim},iw)':-2`,
          '-q:v', '4',
          '-f', 'image2pipe',
          '-c:v', 'mjpeg',
          'pipe:1',
        ],
        timeoutMs,
      );
      // JPEG magic ff d8 — an empty/garbage frame (seek past EOF) is dropped.
      if (frame.length > 2 && frame[0] === 0xff && frame[1] === 0xd8) {
        frames.push(frame);
      }
    } catch {
      // One bad seek (e.g. past the end of a stream with sparse keyframes)
      // should not kill the whole pull — keep whatever frames we got.
    }
  }
  return frames;
}

/**
 * Extract the audio track as fragmented MP4/AAC for containers Transcribe
 * can't ingest directly (mov/mkv/avi). mp4/webm skip this — they go to
 * Transcribe straight from the raw S3 URI.
 */
export async function extractAudioTrack(
  filePath: string,
  timeoutMs = 60_000,
): Promise<Buffer> {
  return runBinary(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-vn',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-movflags', 'frag_keyframe+empty_moov',
      '-f', 'mp4',
      'pipe:1',
    ],
    timeoutMs,
  );
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return runBinary(cmd, args, timeoutMs).then((b) => b.toString('utf8'));
}

function runBinary(cmd: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} spawn failed: ${e.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(out));
      } else {
        reject(
          new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`),
        );
      }
    });
  });
}
