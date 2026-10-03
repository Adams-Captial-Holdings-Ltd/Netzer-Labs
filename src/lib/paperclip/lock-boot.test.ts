/**
 * A124 (Work Platform step 4): what the orchestrator's `main()` passes to the
 * lock wrapper. The mutant `enabled: false` survived every earlier test because
 * the wiring lived in `src/index.ts`, which no test can import. The wiring now
 * lives in `bootPaperclipLock`, and these tests drive it through the real
 * `paperclipRoutingEnabled()` and the real reader.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flag = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({ ...actual.loadEnv(), CCE_PAPERCLIP_ENABLED: flag.value, PAPERCLIP_LOCK_AUDITOR_KEY: 'auditor-key-for-test' }),
  };
});

import { bootPaperclipLock } from './lock-boot.js';
import { __resetPaperclipLockForTest, getPaperclipLockState } from './runtime-lock.js';

const loadConfig = async () => ({ baseUrl: 'http://paperclip.test.internal:3100', companyId: 'company-1' });

describe('bootPaperclipLock (what main() passes to the lock wrapper)', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetPaperclipLockForTest(); });
  afterEach(() => { vi.useRealTimers(); __resetPaperclipLockForTest(); flag.value = undefined; });

  it.each(['1', 'true', 'TRUE'])('flag %s: the live read runs and carries the auditor key', async (value) => {
    flag.value = value;
    const fetchFn = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const starting = bootPaperclipLock({ loadConfig, fetchFn });
    await vi.advanceTimersByTimeAsync(5_000);
    const lock = await starting;
    expect(fetchFn).toHaveBeenCalled();
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([url]) => String(url).startsWith('http://paperclip.test.internal:3100/api/'))).toBe(true);
    expect(JSON.stringify(calls)).toContain('auditor-key-for-test');
    // An unreachable Paperclip is `unknown`: the start is not blocked and the latch is closed.
    expect(getPaperclipLockState().closed).toBe(true);
    expect(getPaperclipLockState().code).not.toBe('unknown:paperclip_routing_off');
    lock.stop();
  });

  it.each([undefined, '', '0', 'false', 'no'])('flag %s: no read at all, and the latch closes with paperclip_routing_off', async (value) => {
    flag.value = value;
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const load = vi.fn(loadConfig);
    const lock = await bootPaperclipLock({ loadConfig: load, fetchFn });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'unknown:paperclip_routing_off' });
    lock.stop();
  });
});
