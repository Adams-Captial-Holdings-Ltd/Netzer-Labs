import { describe, expect, it } from 'vitest';
import { createAttemptStore, FencedOutError, type AttemptRow, type AttemptRows } from './attempt-store.js';

const NOW = 4_000_000;
const outcome = { disposition: 'done' as const, comment: 'answer' };
function fixture(over: Partial<AttemptRow> = {}, replaceWins = true) {
  const row: AttemptRow = { issueId: 'issue-1', attemptNo: 1, state: 'delivering', leaseToken: 2,
    holderId: 'task-a', leaseExpiresAt: NOW + 1, runIds: ['run-1'], agentId: 'main', outcome,
    version: 3, startedAt: NOW - 1_000, updatedAt: NOW - 1_000, ...over };
  const map = new Map([[row.issueId, row]]);
  let writes = 0;
  const rows: AttemptRows = {
    get: async (id) => map.get(id), create: async () => false,
    replace: async (id, version, next) => { writes++; if (!replaceWins || map.get(id)?.version !== version) return false; map.set(id, next); return true; },
  };
  return { map, writes: () => writes, store: createAttemptStore({ rows, holderId: 'task-a', now: () => NOW }) };
}

describe('attempt store extras', () => {
  it('renews delivering, but rejects recorded, delivered, and failed', async () => {
    const h = fixture();
    const handle = { issueId: 'issue-1', attemptNo: 1, leaseToken: 2 };
    expect((await h.store.renew(handle)).leaseExpiresAt).toBeGreaterThan(NOW);
    for (const state of ['recorded', 'delivered', 'failed'] as const) {
      const row = h.map.get('issue-1')!;
      h.map.set('issue-1', { ...row, state });
      await expect(h.store.renew(handle)).rejects.toBeInstanceOf(FencedOutError);
    }
  });
  it('does not fail a live delivery or write its row', async () => {
    const h = fixture();
    expect(await h.store.failExpiredDelivery('issue-1')).toBe(false);
    expect(h.writes()).toBe(0);
  });
  it('fences an expired delivery as unknown and bumps its token', async () => {
    const h = fixture({ leaseExpiresAt: NOW - 1 });
    expect(await h.store.failExpiredDelivery('issue-1')).toBe(true);
    expect(h.map.get('issue-1')).toMatchObject({ state: 'failed', leaseToken: 3,
      failure: { code: 'delivery_unknown', retryable: false } });
  });
  it('returns false on a lost compare and set', async () => {
    const h = fixture({ leaseExpiresAt: NOW - 1 }, false);
    expect(await h.store.failExpiredDelivery('issue-1')).toBe(false);
    expect(h.map.get('issue-1')?.state).toBe('delivering');
  });
  it('attaches a belonging run to a live delivery', async () => {
    const h = fixture();
    expect((await h.store.begin({ issueId: 'issue-1', runId: 'run-2', retryOfRunId: 'run-1' })).action).toBe('attach');
  });
});
