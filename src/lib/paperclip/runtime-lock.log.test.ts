import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logInfo, logWarn } = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: logInfo, warn: logWarn, error: vi.fn(), fatal: vi.fn(), debug: vi.fn() },
}));

import { __resetPaperclipLockForTest, enforceStartupLock, type LockVerdict } from './runtime-lock.js';

describe('paperclip lock verdict logging', () => {
  beforeEach(() => {
    __resetPaperclipLockForTest();
    logInfo.mockClear();
    logWarn.mockClear();
  });

  it('logs each changed verdict once, at the correct level, without the auditor key', async () => {
    const key = 'TEST_ONLY_SENTINEL';
    const read = async (verdict: LockVerdict) => enforceStartupLock({ read: async () => verdict, attempts: 1 });
    await read({ verdict: 'clean' });
    await read({ verdict: 'clean' });
    await expect(read({ verdict: 'violated', violations: [{ code: 'native_runner_on', detail: key }] })).rejects.toThrow();
    await read({ verdict: 'unknown', reason: 'paperclip_unreachable' });
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith({ verdict: 'clean', codes: [], closed: false }, 'paperclip lock verdict');
    expect(logWarn).toHaveBeenCalledTimes(2);
    expect(logWarn).toHaveBeenNthCalledWith(1, { verdict: 'violated', codes: ['native_runner_on'], closed: true }, 'paperclip lock verdict');
    expect(logWarn).toHaveBeenNthCalledWith(2, { verdict: 'unknown', codes: ['paperclip_unreachable'], closed: true }, 'paperclip lock verdict');
    expect(JSON.stringify([...logInfo.mock.calls, ...logWarn.mock.calls])).not.toContain(key);
  });
});
