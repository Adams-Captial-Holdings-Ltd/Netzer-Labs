import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../observability/logger.js';
import {
  PAPERCLIP_LOCK_RECHECK_MS,
  PAPERCLIP_LOCK_STALE_MS,
  __resetPaperclipLockForTest,
  enforceStartupLock,
  getPaperclipLockState,
  readConfiguredLockVerdict,
  startPaperclipLockWatcher,
  startPaperclipLock,
  type LockVerdict,
} from './runtime-lock.js';

const clean: LockVerdict = { verdict: 'clean' };

describe('runtime lock latch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetPaperclipLockForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetPaperclipLockForTest();
  });

  it('closes a stale clean verdict while a watcher read hangs, then reopens on a fresh clean verdict', async () => {
    expect(PAPERCLIP_LOCK_STALE_MS).toBe(300_000);
    await enforceStartupLock({ read: async () => clean });
    let release: (verdict: LockVerdict) => void = () => {};
    const read = vi.fn(() => new Promise<LockVerdict>((resolve) => { release = resolve; }));
    const watcher = startPaperclipLockWatcher({ read });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_STALE_MS);
    expect(read).toHaveBeenCalledTimes(1);
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
    await vi.advanceTimersByTimeAsync(1);
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'unknown:lock_check_stale' });
    release(clean);
    await Promise.resolve();
    await Promise.resolve();
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
    watcher.stop();
  });

  it('stays open before any verdict, regardless of elapsed time', async () => {
    await vi.advanceTimersByTimeAsync(600_000);
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
  });

  it('warns once per stale episode while a watcher read remains pending', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    await enforceStartupLock({ read: async () => clean });
    const watcher = startPaperclipLockWatcher({ read: () => new Promise<LockVerdict>(() => {}) });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS * 7);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ ageMs: PAPERCLIP_LOCK_RECHECK_MS * 6 }, 'paperclip lock verdict is stale');
    watcher.stop();
  });

  it('uses the default attempts when attempts is NaN', async () => {
    const read = vi.fn(async (): Promise<LockVerdict> => ({ verdict: 'unknown', reason: 'unreachable' }));
    const sleep = vi.fn(async () => {});
    await expect(enforceStartupLock({ read, attempts: NaN, sleep })).resolves.toEqual({ verdict: 'unknown', reason: 'unreachable' });
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'unknown:unreachable' });
  });

  it('ignores a read that settles after stop', async () => {
    let release: (verdict: LockVerdict) => void = () => {};
    const watcher = startPaperclipLockWatcher({
      read: () => new Promise<LockVerdict>((resolve) => { release = resolve; }),
    });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS);
    watcher.stop();
    release({ verdict: 'unknown', reason: 'late' });
    await Promise.resolve();
    await Promise.resolve();
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
  });

  it('handles a rejected watcher read even when its warning logger throws', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    const warn = vi.spyOn(logger, 'warn').mockImplementationOnce(() => { throw new Error('transport down'); });
    try {
      const watcher = startPaperclipLockWatcher({ read: async () => { throw new Error('read failed'); } });
      await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS);
      await Promise.resolve();
      watcher.stop();
      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalledWith({ errMessage: 'transport down' }, 'paperclip lock watcher tick failed');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('startPaperclipLock', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetPaperclipLockForTest(); });
  afterEach(() => { vi.useRealTimers(); __resetPaperclipLockForTest(); });

  // Decision 36 (owner-approved change of this test, 2026-10-03): with routing
  // off the wrapper closes the latch instead of doing nothing. No read, no
  // watcher, and the start is never blocked.
  it('closes the latch without a read when disabled', async () => {
    const read = vi.fn(async () => clean);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const lock = await startPaperclipLock({ enabled: false, read });
    expect(read).not.toHaveBeenCalled();
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'unknown:paperclip_routing_off' });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_STALE_MS * 2);
    expect(read).not.toHaveBeenCalled();
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'unknown:paperclip_routing_off' });
    lock.stop();
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'unknown:paperclip_routing_off' });
    expect(info).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    info.mockRestore();
    warn.mockRestore();
  });

  it('a later enabled start with a clean verdict reopens a latch closed by routing off', async () => {
    await startPaperclipLock({ enabled: false, read: vi.fn(async () => clean) });
    const lock = await startPaperclipLock({ enabled: true, read: vi.fn(async () => clean) });
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
    lock.stop();
  });

  it('starts a watcher after a clean startup and stops it', async () => {
    const read = vi.fn(async () => clean);
    const lock = await startPaperclipLock({ enabled: true, read });
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS);
    expect(read).toHaveBeenCalledTimes(2);
    lock.stop();
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS * 2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refuses a violated startup verdict without starting a watcher', async () => {
    const read = vi.fn(async (): Promise<LockVerdict> => ({ verdict: 'violated', violations: [{ code: 'blocked', detail: 'blocked' }] }));
    await expect(startPaperclipLock({ enabled: true, read })).rejects.toThrow('Refusing to start');
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('latches an unknown verdict and keeps watching', async () => {
    const read = vi.fn(async (): Promise<LockVerdict> => ({ verdict: 'unknown', reason: 'auditor_missing' }));
    const starting = startPaperclipLock({ enabled: true, read });
    await vi.advanceTimersByTimeAsync(2_000);
    const lock = await starting;
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'unknown:auditor_missing' });
    await vi.advanceTimersByTimeAsync(PAPERCLIP_LOCK_RECHECK_MS);
    expect(read).toHaveBeenCalledTimes(4);
    lock.stop();
  });
});

describe('configured runtime lock reader', () => {
  beforeEach(() => __resetPaperclipLockForTest());
  afterEach(() => __resetPaperclipLockForTest());

  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const body = path === '/api/health' ? { hiddenSettings: ['instance.adapters', 'instance.plugins'] }
      : path === '/api/instance/settings/experimental' ? { enableNativeRunner: false }
        : path.endsWith('/tools/applications') ? { applications: [] }
          : path.endsWith('/tools/connections') ? { connections: [] } : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  it('returns unknown when configuration loading throws', async () => {
    const loadConfig = vi.fn(async (): Promise<never> => { throw new Error('config failed'); });
    await expect(readConfiguredLockVerdict({ loadConfig, fetchFn })).resolves.toEqual({ verdict: 'unknown', reason: 'paperclip_config_unavailable' });
  });

  it.each([
    { companyId: 'company-1' },
    { baseUrl: 'http://paperclip.test' },
  ])('returns unknown when configuration is incomplete: %j', async (config) => {
    await expect(readConfiguredLockVerdict({ loadConfig: async () => config, fetchFn })).resolves.toEqual({
      verdict: 'unknown', reason: 'paperclip_config_missing',
    });
  });

  it('delegates a complete configuration to the six-route reader', async () => {
    const read = vi.fn(fetchFn);
    await expect(readConfiguredLockVerdict({
      loadConfig: async () => ({ baseUrl: 'http://paperclip.test', companyId: 'company-1' }),
      fetchFn: read as typeof fetch,
      auditorKey: 'x',
    })).resolves.toEqual(clean);
    expect(read).toHaveBeenCalledTimes(6);
  });
});
