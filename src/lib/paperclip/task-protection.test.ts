import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../observability/logger.js';
import { createTaskProtection } from './task-protection.js';

const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
afterEach(() => vi.restoreAllMocks());

describe('ECS task protection', () => {
  it('makes no request without an agent URI', async () => {
    const fetchFn = vi.fn();
    const protection = createTaskProtection({ agentUri: '', fetchFn: fetchFn as unknown as typeof fetch });
    protection.hold(); protection.refresh(); protection.release();
    await flush();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('enables for ten minutes on the first hold', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    createTaskProtection({ agentUri: 'http://agent', fetchFn }).hold();
    await flush();
    expect(fetchFn).toHaveBeenCalledWith('http://agent/task-protection/v1/state', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ ProtectionEnabled: true, ExpiresInMinutes: 10 }),
    }));
  });

  it('nested holds send one enable', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const protection = createTaskProtection({ agentUri: 'http://agent', fetchFn });
    protection.hold(); protection.hold();
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refreshes while held and stays silent at zero', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const protection = createTaskProtection({ agentUri: 'http://agent', fetchFn });
    protection.refresh(); protection.hold(); protection.refresh();
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][1].body).toBe(fetchFn.mock.calls[0][1].body);
  });

  it('disables only after the last release and never goes negative', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const protection = createTaskProtection({ agentUri: 'http://agent', fetchFn });
    protection.hold(); protection.hold(); protection.release(); protection.release(); protection.release();
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][1].body).toBe(JSON.stringify({ ProtectionEnabled: false }));
  });

  it('warns once for a rejected call without throwing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const protection = createTaskProtection({ agentUri: 'http://agent', fetchFn: vi.fn().mockRejectedValue(new Error('secret')) });
    expect(() => protection.hold()).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({ reason: 'task_protection_request' });
  });

  it('warns once for a 500 with status only', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    createTaskProtection({ agentUri: 'http://agent', fetchFn: vi.fn().mockResolvedValue({ ok: false, status: 500 }) }).hold();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({ reason: 'task_protection_http', status: 500 });
  });
  it('aborts an unresponsive fetch after two seconds and warns once', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
      createTaskProtection({ agentUri: 'http://agent', fetchFn: fetchFn as typeof fetch }).hold();
      await vi.advanceTimersByTimeAsync(2_001);
      expect((fetchFn.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: expect.objectContaining({ aborted: true }) });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
