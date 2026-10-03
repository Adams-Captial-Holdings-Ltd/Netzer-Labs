import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../observability/logger.js';
import { createAttemptStore, type AttemptRow } from './attempt-store.js';
import { DispatchFailure } from './dispatch-worker.js';
import { runPendingDispatchSweep } from './pending-dispatch-sweep.js';

const NOW = 2_000_000;
function fixture(overrides: Partial<AttemptRow> = {}) {
  const row: AttemptRow = {
    issueId: 'issue-1', attemptNo: 1, state: 'recorded', leaseToken: 1,
    holderId: 'old', leaseExpiresAt: NOW - 1, runIds: ['run-1', 'run-2'],
    agentId: 'research', outcome: { disposition: 'done', comment: 'private comment' },
    version: 2, startedAt: 1, updatedAt: NOW - 61_000, ...overrides,
  };
  const data = new Map([[row.issueId, row]]);
  const rows = {
    get: async (id: string) => data.get(id),
    create: async (next: AttemptRow) => { if (data.has(next.issueId)) return false; data.set(next.issueId, next); return true; },
    replace: async (id: string, version: number, next: AttemptRow) => {
      if (data.get(id)?.version !== version) return false;
      data.set(id, next); return true;
    },
  };
  const attempts = createAttemptStore({ rows, holderId: 'sweeper', now: () => NOW });
  const deliver = vi.fn().mockResolvedValue(undefined);
  const scan = vi.fn(async () => [...data.values()]);
  const lease = vi.fn().mockResolvedValue(true);
  const lockState = vi.fn(() => ({ closed: false, code: null }));
  const deps = { attempts, deliver, scan, lease, lockState, now: () => NOW };
  return { data, deps, deliver, scan, lease };
}

afterEach(() => vi.restoreAllMocks());

describe('pending dispatch sweep', () => {
  it('does nothing with a closed lock', async () => {
    const f = fixture(); f.deps.lockState = vi.fn(() => ({ closed: true, code: null }));
    await runPendingDispatchSweep(f.deps);
    expect(f.lease).not.toHaveBeenCalled(); expect(f.scan).not.toHaveBeenCalled();
  });

  it('does nothing without the runner lease', async () => {
    const f = fixture(); f.lease.mockResolvedValue(false);
    await runPendingDispatchSweep(f.deps);
    expect(f.scan).not.toHaveBeenCalled();
  });

  it('skips a young recorded row', async () => {
    const f = fixture({ updatedAt: NOW - 59_999 });
    await runPendingDispatchSweep(f.deps);
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('delivers with the newest run id and stored agent id', async () => {
    const f = fixture();
    await runPendingDispatchSweep(f.deps);
    expect(f.deliver).toHaveBeenCalledWith({ netzarAgentId: 'research', issueId: 'issue-1',
      runId: 'run-2', dedupeKey: 'run-2#issue-1', context: {} }, expect.objectContaining({ disposition: 'done' }));
    expect(f.data.get('issue-1')?.state).toBe('delivered');
  });

  it('ends a blocked outcome as agent_blocked', async () => {
    const f = fixture({ outcome: { disposition: 'blocked', comment: 'private comment' } });
    await runPendingDispatchSweep(f.deps);
    expect(f.data.get('issue-1')?.failure).toEqual({ code: 'agent_blocked', status: 409, retryable: false });
  });

  it('releases a retryable delivery failure', async () => {
    const f = fixture(); f.deliver.mockRejectedValue(new DispatchFailure('delivery_failed', 502, true));
    await runPendingDispatchSweep(f.deps);
    expect(f.data.get('issue-1')?.state).toBe('recorded');
  });

  it('ends an unknown throw and does not retry it on the next pass', async () => {
    const f = fixture(); f.deliver.mockRejectedValue(new Error('private comment'));
    await runPendingDispatchSweep(f.deps);
    await runPendingDispatchSweep(f.deps);
    expect(f.data.get('issue-1')?.failure).toEqual({ code: 'delivery_unknown', status: 500, retryable: false });
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });

  it('fails an expired delivering row without another write', async () => {
    const f = fixture({ state: 'delivering', leaseExpiresAt: NOW - 1 });
    await runPendingDispatchSweep(f.deps);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.data.get('issue-1')?.failure?.code).toBe('delivery_unknown');
  });

  it('skips a recorded row without an agent id', async () => {
    const f = fixture({ agentId: undefined });
    await runPendingDispatchSweep(f.deps);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.data.get('issue-1')?.state).toBe('recorded');
  });

  it('logs one stale error with count and age, without comment text', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const f = fixture({ updatedAt: NOW - 901_000 });
    await runPendingDispatchSweep(f.deps);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toEqual({ count: 1, oldestAgeMs: 901_000 });
    expect(JSON.stringify(error.mock.calls)).not.toContain('private comment');
  });

  it('warns once and ends on a scan error', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const f = fixture(); f.scan.mockRejectedValue(new Error('private comment'));
    await expect(runPendingDispatchSweep(f.deps)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private comment');
  });
});
