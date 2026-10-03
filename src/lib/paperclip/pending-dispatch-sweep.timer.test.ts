import { afterEach, describe, expect, it, vi } from 'vitest';
const { lease, scan } = vi.hoisted(() => ({ lease: vi.fn(async () => true), scan: vi.fn(async () => []) }));
vi.mock('../state/runner-lease.js', () => ({ RUNNER_HOLDER_ID: 'runner', tryAcquireRunnerLease: lease }));
vi.mock('./attempt-rows-dynamo.js', () => ({
  dynamoAttemptRows: () => ({ get: async () => undefined, create: async () => false, replace: async () => false }),
  scanPendingAttempts: scan,
}));
vi.mock('./runtime-lock.js', () => ({ getPaperclipLockState: () => ({ closed: false }) }));
import { startPendingDispatchSweep, stopPendingDispatchSweep } from './pending-dispatch-sweep.js';

afterEach(() => { stopPendingDispatchSweep(); vi.useRealTimers(); vi.clearAllMocks(); });
describe('pending dispatch sweep timer', () => {
  it('starts once, runs at five minutes, suppresses an overlapping pass, stops and restarts', async () => {
    vi.useFakeTimers();
    startPendingDispatchSweep(); startPendingDispatchSweep();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(lease).toHaveBeenCalledWith({ name: 'paperclip-pending-dispatch', ttlMs: 600_000 });
    let finish!: () => void;
    scan.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve([]); }));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(scan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(scan).toHaveBeenCalledTimes(2);
    stopPendingDispatchSweep();
    expect(vi.getTimerCount()).toBe(0);
    finish(); await Promise.resolve();
    startPendingDispatchSweep();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(scan).toHaveBeenCalledTimes(3);
  });
});
