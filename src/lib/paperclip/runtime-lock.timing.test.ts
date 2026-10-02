import { afterEach, describe, expect, it, vi } from 'vitest';
import { enforceStartupLock, readRuntimeLockVerdict } from './runtime-lock.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runtime lock time bounds', () => {
  it('returns unknown at the 10 second request timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    const fetchFn = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })) as unknown as typeof fetch;
    const verdict = readRuntimeLockVerdict({ fetchFn, baseUrl: 'http://paperclip.test', companyId: 'co', auditorKey: 'test-key' });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(await Promise.race([verdict.then(() => 'done'), Promise.resolve('pending')])).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await expect(verdict).resolves.toEqual({ verdict: 'unknown', reason: 'paperclip_unreachable' });
  });

  it('uses the default one second retry delay after an unknown verdict', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce({ verdict: 'unknown', reason: 'paperclip_unreachable' }).mockResolvedValueOnce({ verdict: 'clean' });
    const result = enforceStartupLock({ read });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ verdict: 'clean' });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
