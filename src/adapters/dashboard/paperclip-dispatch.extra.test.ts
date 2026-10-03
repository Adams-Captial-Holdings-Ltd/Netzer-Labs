import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaperclipDispatchRouter, type PaperclipDispatchDeps } from './paperclip-dispatch.js';
import { createAttemptStore, type AttemptOutcome, type AttemptRow, type AttemptRows } from '../../lib/paperclip/attempt-store.js';
import { DispatchFailure } from '../../lib/paperclip/dispatch-worker.js';
import { __resetDispatchDrainForTest } from '../../lib/paperclip/dispatch-drain.js';
import { __resetPaperclipLockForTest } from '../../lib/paperclip/runtime-lock.js';

const outcome: AttemptOutcome = { disposition: 'done', comment: 'answer' };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function fixture(seed?: Partial<AttemptRow>, extra: Partial<PaperclipDispatchDeps> = {}) {
  const now = Date.now();
  const initial: AttemptRow = { issueId: 'issue-1', attemptNo: 1, state: 'recorded', leaseToken: 1,
    holderId: 'old', leaseExpiresAt: 0, runIds: ['run-1'], agentId: 'main', outcome,
    version: 1, startedAt: now, updatedAt: now, ...seed };
  const map = new Map<string, AttemptRow>(seed ? [['issue-1', initial]] : []);
  const rows: AttemptRows = {
    get: async (id) => { const row = map.get(id); return row && structuredClone(row); },
    create: async (row) => { if (map.has(row.issueId)) return false; map.set(row.issueId, structuredClone(row)); return true; },
    replace: async (id, version, next) => { if (map.get(id)?.version !== version) return false; map.set(id, structuredClone(next)); return true; },
  };
  const attempts = createAttemptStore({ rows, holderId: 'task-a', now: Date.now });
  const protection = { hold: vi.fn(), release: vi.fn(), refresh: vi.fn() };
  const deps: PaperclipDispatchDeps = { secret: () => 'secret', knownAgents: () => ['main'], enabledAgents: async () => ['main'],
    attempts, work: async () => outcome, deliver: async () => undefined, protection, holdMs: 500, pollMs: 10, renewMs: 10, ...extra };
  const router = buildPaperclipDispatchRouter(deps);
  const post = (target = router, runId = 'run-1', retryOfRunId?: string) => target.request('/dispatch', {
    method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ netzarAgentId: 'main', runId, context: { issueId: 'issue-1', retryOfRunId } }),
  });
  return { map, rows, attempts, protection, deps, router, post };
}
beforeEach(() => { __resetPaperclipLockForTest(); __resetDispatchDrainForTest(); });
afterEach(() => { vi.restoreAllMocks(); __resetPaperclipLockForTest(); __resetDispatchDrainForTest(); });

describe('held route extras', () => {
  it('refreshes protection during long work and stops after settlement', async () => {
    const h = fixture(undefined, { work: async () => { await wait(55); return outcome; } });
    expect((await h.post()).status).toBe(200);
    expect(h.protection.refresh).toHaveBeenCalled();
    const count = h.protection.refresh.mock.calls.length;
    await wait(30);
    expect(h.protection.refresh).toHaveBeenCalledTimes(count);
    expect(h.protection.hold).toHaveBeenCalledTimes(1);
    expect(h.protection.release).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('holds and releases delivery once when failure=%s', async (fails) => {
    const h = fixture({ state: 'recorded' }, { deliver: async () => { if (fails) throw new DispatchFailure('delivery_failed', 502, true); } });
    const response = await h.post();
    expect(response.status).toBe(fails ? 502 : 200);
    expect(h.protection.hold).toHaveBeenCalledTimes(1);
    expect(h.protection.release).toHaveBeenCalledTimes(1);
  });
  it('releases protection once when work fails', async () => {
    const h = fixture(undefined, { work: async () => { throw new Error('failed'); } });
    expect((await h.post()).status).toBe(500);
    expect(h.protection.hold).toHaveBeenCalledTimes(1);
    expect(h.protection.release).toHaveBeenCalledTimes(1);
  });
  it('an attached request on another router sees a retryable delivery failure as 502', async () => {
    let finish!: () => void;
    const h = fixture(undefined, { work: async () => { await new Promise<void>((resolve) => { finish = resolve; }); return outcome; },
      deliver: async () => { throw new DispatchFailure('delivery_failed', 502, true); } });
    const other = buildPaperclipDispatchRouter({ ...h.deps,
      attempts: createAttemptStore({ rows: h.rows, holderId: 'task-b', now: Date.now }) });
    const first = h.post(); await wait(20);
    const attached = h.post(other, 'run-2', 'run-1');
    await wait(20); finish();
    expect((await first).status).toBe(502);
    expect((await attached).status).toBe(502);
  });
  it('an attached request times out at its short hold cap', async () => {
    const h = fixture({ state: 'running', leaseExpiresAt: Date.now() + 60_000 }, { holdMs: 45 });
    const response = await h.post(h.router, 'run-2', 'run-1');
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: 'attempt_timeout' });
  });
  it('attaches to a live delivery and waits until it is delivered', async () => {
    const h = fixture({ state: 'delivering', leaseExpiresAt: Date.now() + 60_000 });
    const pending = h.post(h.router, 'run-2', 'run-1');
    await wait(30);
    const row = h.map.get('issue-1')!;
    h.map.set('issue-1', { ...row, state: 'delivered', version: row.version + 1 });
    expect((await pending).status).toBe(200);
  });
  it('renews the lease while the delivery write is pending', async () => {
    let finish!: () => void;
    const h = fixture({ state: 'recorded' }, { deliver: async () => new Promise<void>((resolve) => { finish = resolve; }) });
    const pending = h.post();
    await wait(20);
    const expiry = h.map.get('issue-1')!.leaseExpiresAt;
    await wait(40);
    expect(h.map.get('issue-1')!.leaseExpiresAt).toBeGreaterThan(expiry);
    finish();
    expect((await pending).status).toBe(200);
  });
});
