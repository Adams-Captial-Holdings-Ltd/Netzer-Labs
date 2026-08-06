import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// eslint-disable-next-line import/first
import { transcodeToOpusOgg } from './opus.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn(), on: vi.fn() };
  child.kill = vi.fn();
  return child;
}

describe('transcodeToOpusOgg', () => {
  beforeEach(() => spawnMock.mockReset());

  it('invokes ffmpeg with libopus/ogg, pipes input, and resolves stdout', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = transcodeToOpusOgg(Buffer.from('mp3-bytes'));
    child.stdout.emit('data', Buffer.from('OggS'));
    child.stdout.emit('data', Buffer.from('opus'));
    child.emit('close', 0);
    const out = await p;
    expect(out.toString()).toBe('OggSopus');

    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('ffmpeg');
    expect(args).toContain('libopus');
    expect(args).toContain('ogg');
    expect(args).toContain('voip');
    expect(child.stdin.end).toHaveBeenCalledWith(Buffer.from('mp3-bytes'));
  });

  it('rejects with stderr detail on a non-zero exit', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = transcodeToOpusOgg(Buffer.from('x'));
    child.stderr.emit('data', Buffer.from('decode error'));
    child.emit('close', 1);
    await expect(p).rejects.toThrow(/ffmpeg exited 1.*decode error/s);
  });

  it('rejects clearly when ffmpeg is missing from the image', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = transcodeToOpusOgg(Buffer.from('x'));
    child.emit('error', new Error('spawn ffmpeg ENOENT'));
    await expect(p).rejects.toThrow(/ffmpeg spawn failed/);
  });

  it('rejects on empty output even with a clean exit', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = transcodeToOpusOgg(Buffer.from('x'));
    child.emit('close', 0);
    await expect(p).rejects.toThrow(/ffmpeg exited 0/);
  });
});
