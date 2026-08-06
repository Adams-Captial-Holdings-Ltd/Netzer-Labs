import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeVideo,
  extractKeyframes,
  extractAudioTrack,
  writeTempFile,
} from './frames.js';

// These tests exercise the real ffmpeg/ffprobe binaries (present in the
// runtime image via `apk add ffmpeg`). On dev machines without ffmpeg the
// suite skips rather than fails — the mocked-pipeline tests in
// src/lib/media/process.test.ts still cover the orchestration.
function ffmpegAvailable(): boolean {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    execSync('ffprobe -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_FFMPEG = ffmpegAvailable();

describe.skipIf(!HAVE_FFMPEG)('video frames (real ffmpeg)', () => {
  let dir: string;
  let clipPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cce-frames-test-'));
    clipPath = join(dir, 'clip.mp4');
    // 2s synthetic test clip with a tone so there is an audio track to pull.
    execSync(
      `ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=duration=2:size=320x240:rate=10 ` +
        `-f lavfi -i sine=frequency=440:duration=2 -pix_fmt yuv420p -c:a aac -shortest "${clipPath}"`,
    );
  }, 30_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('probes duration and dimensions', async () => {
    const probe = await probeVideo(clipPath);
    expect(probe.durationSec).toBeGreaterThan(1.5);
    expect(probe.durationSec).toBeLessThan(3);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
  });

  it('extracts evenly spaced JPEG keyframes', async () => {
    const frames = await extractKeyframes(clipPath, 2, { count: 4 });
    expect(frames.length).toBe(4);
    for (const f of frames) {
      expect(f[0]).toBe(0xff);
      expect(f[1]).toBe(0xd8);
    }
  });

  it('clamps frame count to 8', async () => {
    const frames = await extractKeyframes(clipPath, 2, { count: 50 });
    expect(frames.length).toBeLessThanOrEqual(8);
  });

  it('extracts an audio track', async () => {
    const audio = await extractAudioTrack(clipPath);
    expect(audio.length).toBeGreaterThan(500);
  });

  it('writeTempFile round-trips bytes and cleanup removes them', async () => {
    const bytes = await readFile(clipPath);
    const temp = await writeTempFile(bytes, 'mp4');
    expect((await readFile(temp.path)).length).toBe(bytes.length);
    await temp.cleanup();
    await expect(access(temp.path)).rejects.toThrow();
  });

  it('probe rejects garbage input', async () => {
    const temp = await writeTempFile(Buffer.from('not a video at all'), 'mp4');
    try {
      await expect(probeVideo(temp.path)).rejects.toThrow();
    } finally {
      await temp.cleanup();
    }
  });
});
