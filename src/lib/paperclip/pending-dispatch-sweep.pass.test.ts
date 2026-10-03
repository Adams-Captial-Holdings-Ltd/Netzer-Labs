/** Step 4 review findings on the sweep (red first): an honest alarm, and one bad row never ends the pass. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../observability/logger.js';
import { createAttemptStore, type AttemptRow, type AttemptRows } from './attempt-store.js';
import { runPendingDispatchSweep } from './pending-dispatch-sweep.js';

const NOW = 10_000_000;
function recorded(issueId: string, ageMs: number): AttemptRow {
  return { issueId, attemptNo: 1, state: 'recorded', leaseToken: 1, holderId: 'gone', leaseExpiresAt: 0, runIds: ['run-1'],
    agentId: 'main', outcome: { disposition: 'done', comment: 'the answer' }, version: 1, startedAt: NOW - ageMs, updatedAt: NOW - ageMs };
}
function harness(seed: AttemptRow[]) {
  const map = new Map(seed.map((row) => [row.issueId, row]));
  const rows: AttemptRows = {
    get: async (id) => { const row = map.get(id); return row ? structuredClone(row) : undefined; },
    create: async () => false,
    replace: async (id, version, next) => { if (map.get(id)?.version !== version) return false; map.set(id, structuredClone(next)); return true; },
  };
  const attempts = createAttemptStore({ rows, holderId: 'sweeper', now: () => NOW });
  const base = { scan: async () => [...map.values()].map((row) => structuredClone(row)), attempts, now: () => NOW,
    lockState: () => ({ closed: false }) as never, lease: async () => true };
  return { map, attempts, base };
}

describe('pending_dispatch sweep: one pass', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('a stale outcome that this pass delivers raises no alarm', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const h = harness([recorded('old', 20 * 60_000)]);
    await runPendingDispatchSweep({ ...h.base, deliver: async () => undefined });
    expect(h.map.get('old')?.state).toBe('delivered');
    expect(error).not.toHaveBeenCalled();
  });

  it('a stale outcome that is still undelivered after the pass raises the alarm', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const h = harness([{ ...recorded('orphan', 20 * 60_000), agentId: undefined }]);
    await runPendingDispatchSweep({ ...h.base, deliver: async () => undefined });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({ count: 1 });
  });

  it('a row that is fenced out or whose store write fails does not stop the rows after it', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = harness([recorded('first', 5 * 60_000), recorded('second', 5 * 60_000)]);
    const markDelivered = vi.fn(async (handle: Parameters<typeof h.attempts.markDelivered>[0]) => {
      if (handle.issueId === 'first') throw new Error('dynamo blip');
      return h.attempts.markDelivered(handle);
    });
    const deliver = vi.fn(async () => undefined);
    await runPendingDispatchSweep({ ...h.base, attempts: { ...h.attempts, markDelivered }, deliver });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(h.map.get('second')?.state).toBe('delivered');
  });
});
