/**
 * Work Platform step 4: findings of the implementation review, each pinned by
 * a test written before its fix (spec sections 3, 4 and 6; ADR 0013).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../observability/logger.js';
import { buildPaperclipDispatchRouter, type PaperclipDispatchDeps } from './paperclip-dispatch.js';
import {
  createAttemptStore, FencedOutError, type AttemptOutcome, type AttemptRow, type AttemptRows,
} from '../../lib/paperclip/attempt-store.js';
import { DispatchFailure } from '../../lib/paperclip/dispatch-worker.js';
import {
  __resetDispatchDrainForTest, beginDispatchDrain, dispatchesIdle, dispatchesInFlight,
} from '../../lib/paperclip/dispatch-drain.js';
import { __resetPaperclipLockForTest } from '../../lib/paperclip/runtime-lock.js';

const OUTCOME: AttemptOutcome = { disposition: 'done', comment: 'the answer' };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function memoryRows(seed: AttemptRow[] = []) {
  const map = new Map(seed.map((row) => [row.issueId, structuredClone(row)]));
  let gets = 0;
  const rows: AttemptRows = {
    get: async (id) => { gets++; const row = map.get(id); return row ? structuredClone(row) : undefined; },
    create: async (row) => { if (map.has(row.issueId)) return false; map.set(row.issueId, structuredClone(row)); return true; },
    replace: async (id, version, next) => {
      if (map.get(id)?.version !== version) return false;
      map.set(id, structuredClone(next));
      return true;
    },
  };
  return { rows, map, gets: () => gets };
}

function seeded(over: Partial<AttemptRow>): AttemptRow {
  const now = Date.now();
  return { issueId: 'issue-1', attemptNo: 1, state: 'running', leaseToken: 1, holderId: 'dead-task', leaseExpiresAt: now + 60_000,
    runIds: ['run-1'], agentId: 'main', version: 1, startedAt: now, updatedAt: now, ...over };
}

function harness(over: Partial<PaperclipDispatchDeps> = {}, seed: AttemptRow[] = []) {
  const mem = memoryRows(seed);
  const store = createAttemptStore({ rows: mem.rows, holderId: 'task-b', now: Date.now });
  const work = vi.fn(async (): Promise<AttemptOutcome> => OUTCOME);
  const deliver = vi.fn(async (): Promise<void> => undefined);
  const deps: PaperclipDispatchDeps = {
    secret: () => 's3cret', knownAgents: () => ['main'], enabledAgents: async () => ['main'],
    attempts: store, work, deliver, holdMs: 1_000, pollMs: 20, renewMs: 1_000, ...over,
  };
  const router = buildPaperclipDispatchRouter(deps);
  const post = (body: unknown, headers: Record<string, string> = { authorization: 'Bearer s3cret' }) =>
    router.request('/dispatch', { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body) });
  const dispatch = (runId: string, extra: Record<string, unknown> = {}) =>
    post({ netzarAgentId: 'main', runId, context: { issueId: 'issue-1', ...extra } });
  return { ...mem, store, work: deps.work as typeof work, deliver: deps.deliver as typeof deliver, post, dispatch };
}

beforeEach(() => { __resetPaperclipLockForTest(); __resetDispatchDrainForTest(); });
afterEach(() => { vi.restoreAllMocks(); __resetPaperclipLockForTest(); __resetDispatchDrainForTest(); });

describe('the poll loop', () => {
  it('keeps pausing between reads after its own task settled without a terminal row (no hot loop)', async () => {
    const h = harness({ holdMs: 300, pollMs: 100 });
    // The starter's claim loses: another holder is delivering, with a live lease.
    const attempts = { ...h.store, claimDelivery: vi.fn(async (issueId: string) => {
      const row = h.map.get(issueId)!;
      h.map.set(issueId, { ...row, state: 'delivering', holderId: 'other-task', leaseToken: row.leaseToken + 1,
        leaseExpiresAt: Date.now() + 60_000, version: row.version + 1 });
      return undefined;
    }) };
    const router = buildPaperclipDispatchRouter({ secret: () => 's3cret', knownAgents: () => ['main'], enabledAgents: async () => ['main'],
      attempts, work: h.work, deliver: h.deliver, holdMs: 300, pollMs: 100, renewMs: 1_000 });
    const res = await router.request('/dispatch', { method: 'POST', headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ netzarAgentId: 'main', runId: 'run-1', context: { issueId: 'issue-1' } }) });
    expect(res.status).toBe(504);
    expect(h.gets()).toBeLessThan(40);
  });

  it('an attached request takes a dead holder\'s attempt over once the lease expires, instead of waiting out the cap', async () => {
    const h = harness({}, [seeded({ leaseExpiresAt: Date.now() + 120 })]);
    const res = await h.dispatch('run-2', { retryOfRunId: 'run-1' });
    expect(res.status).toBe(200);
    expect(h.work).toHaveBeenCalledTimes(1);
    expect(h.map.get('issue-1')).toMatchObject({ attemptNo: 2, state: 'delivered', holderId: 'task-b' });
  });

  it('an attached request on a delivery whose lease expires ends 500 delivery_unknown, never a second delivery', async () => {
    const h = harness({}, [seeded({ state: 'delivering', outcome: OUTCOME, leaseExpiresAt: Date.now() + 120 })]);
    const res = await h.dispatch('run-2', { retryOfRunId: 'run-1' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'delivery_unknown' });
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.map.get('issue-1')).toMatchObject({ state: 'failed', failure: { code: 'delivery_unknown', retryable: false } });
  });
});

describe('SIGTERM drain waits for attempts this task holds', () => {
  it('counts a held attempt until its outcome is delivered, and lets it finish during the drain', async () => {
    let finish!: (outcome: AttemptOutcome) => void;
    const h = harness({ work: vi.fn(() => new Promise<AttemptOutcome>((resolve) => { finish = resolve; })) });
    expect(dispatchesInFlight()).toBe(0);
    const held = h.dispatch('run-1');
    await sleep(30);
    expect(dispatchesInFlight()).toBe(1);
    beginDispatchDrain();
    let idle = false;
    void dispatchesIdle().then(() => { idle = true; });
    await sleep(30);
    expect(idle).toBe(false);
    finish(OUTCOME);
    expect((await held).status).toBe(200);
    await dispatchesIdle();
    expect(dispatchesInFlight()).toBe(0);
  });

  it('is idle at once when nothing is held, and a failed attempt is released too', async () => {
    await dispatchesIdle();
    const h = harness({ work: vi.fn(async () => { throw new DispatchFailure('agent_failed', 500, true); }) });
    expect((await h.dispatch('run-1')).status).toBe(500);
    expect(dispatchesInFlight()).toBe(0);
  });
});

describe('a store blip does not throw away finished work', () => {
  it.each(['record', 'markDelivered'] as const)('%s failing once is retried and the dispatch still ends 200', async (method) => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = harness({ storeRetryMs: 5 } as Partial<PaperclipDispatchDeps>);
    let blips = 1;
    const real = h.store[method].bind(h.store) as (...args: unknown[]) => Promise<unknown>;
    const flaky = vi.fn(async (...args: unknown[]) => { if (blips-- > 0) throw new Error('dynamo blip'); return real(...args); });
    const router = buildPaperclipDispatchRouter({ secret: () => 's3cret', knownAgents: () => ['main'], enabledAgents: async () => ['main'],
      attempts: { ...h.store, [method]: flaky }, work: h.work, deliver: h.deliver, holdMs: 1_000, pollMs: 20, renewMs: 1_000,
      storeRetryMs: 5 } as PaperclipDispatchDeps);
    const res = await router.request('/dispatch', { method: 'POST', headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ netzarAgentId: 'main', runId: 'run-1', context: { issueId: 'issue-1' } }) });
    expect(res.status).toBe(200);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.map.get('issue-1')?.state).toBe('delivered');
  });

  it('a store that stays down after the write was applied is logged as delivered-but-unrecorded, and nothing is delivered twice', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = harness();
    const router = buildPaperclipDispatchRouter({ secret: () => 's3cret', knownAgents: () => ['main'], enabledAgents: async () => ['main'],
      attempts: { ...h.store, markDelivered: vi.fn(async () => { throw new Error('dynamo down'); }) },
      work: h.work, deliver: h.deliver, holdMs: 300, pollMs: 20, renewMs: 1_000, storeRetryMs: 5 } as PaperclipDispatchDeps);
    await router.request('/dispatch', { method: 'POST', headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ netzarAgentId: 'main', runId: 'run-1', context: { issueId: 'issue-1' } }) });
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.some(([fields]) => (fields as { delivered?: boolean; issueId?: string }).delivered === true
      && (fields as { issueId?: string }).issueId === 'issue-1')).toBe(true);
    expect(JSON.stringify(error.mock.calls)).not.toContain('the answer');
  });
});

describe('a lost lease stops the agent turn', () => {
  it('a fenced renewal aborts the signal handed to the work; nothing is recorded; 409 lease_lost', async () => {
    const h = harness({ renewMs: 10 });
    let seen: AbortSignal | undefined;
    const work = vi.fn((_ctx: unknown, signal?: AbortSignal) => new Promise<AttemptOutcome>((_resolve, reject) => {
      seen = signal;
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('Turn stopped'), { name: 'AbortError' })));
    }));
    const record = vi.fn(h.store.record);
    const router = buildPaperclipDispatchRouter({ secret: () => 's3cret', knownAgents: () => ['main'], enabledAgents: async () => ['main'],
      attempts: { ...h.store, record, renew: vi.fn(async () => { throw new FencedOutError(); }) },
      work: work as never, deliver: h.deliver, holdMs: 1_000, pollMs: 20, renewMs: 10 });
    const res = await router.request('/dispatch', { method: 'POST', headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ netzarAgentId: 'main', runId: 'run-1', context: { issueId: 'issue-1' } }) });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(true);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'lease_lost' });
    expect(record).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('no successful renewal for the grace period aborts the work too (a store outage longer than the lease)', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const h = harness();
    let seen: AbortSignal | undefined;
    const work = vi.fn((_ctx: unknown, signal?: AbortSignal) => new Promise<AttemptOutcome>((_resolve, reject) => {
      seen = signal;
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('Turn stopped'), { name: 'AbortError' })));
    }));
    const record = vi.fn(h.store.record);
    const router = buildPaperclipDispatchRouter({ secret: () => 's3cret', knownAgents: () => ['main'], enabledAgents: async () => ['main'],
      attempts: { ...h.store, record, renew: vi.fn(async () => { throw new Error('dynamo down'); }) },
      work: work as never, deliver: h.deliver, holdMs: 400, pollMs: 20, renewMs: 10, renewGraceMs: 60 } as PaperclipDispatchDeps);
    const res = await router.request('/dispatch', { method: 'POST', headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ netzarAgentId: 'main', runId: 'run-1', context: { issueId: 'issue-1' } }) });
    expect(seen?.aborted).toBe(true);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('operator signals', () => {
  it('a store error at begin is logged once with the issue and the error name, never its text', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const h = harness();
    const router = buildPaperclipDispatchRouter({ secret: () => 's3cret', knownAgents: () => ['main'], enabledAgents: async () => ['main'],
      attempts: { ...h.store, begin: vi.fn(async () => { throw new TypeError('secret-xyz detail'); }) }, work: h.work, deliver: h.deliver });
    const res = await router.request('/dispatch', { method: 'POST', headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ netzarAgentId: 'main', runId: 'run-1', context: { issueId: 'issue-1' } }) });
    expect(res.status).toBe(503);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({ issueId: 'issue-1', errName: 'TypeError' });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-xyz');
  });

  it('a background store error (record keeps failing) is logged even though no request may be left to see it', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = harness();
    const router = buildPaperclipDispatchRouter({ secret: () => 's3cret', knownAgents: () => ['main'], enabledAgents: async () => ['main'],
      attempts: { ...h.store, record: vi.fn(async () => { throw new Error('dynamo down'); }) },
      work: h.work, deliver: h.deliver, holdMs: 400, pollMs: 20, renewMs: 1_000, storeRetryMs: 5 } as PaperclipDispatchDeps);
    const res = await router.request('/dispatch', { method: 'POST', headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ netzarAgentId: 'main', runId: 'run-1', context: { issueId: 'issue-1' } }) });
    expect(res.status).toBe(503);
    expect(error.mock.calls.some(([fields]) => (fields as { issueId?: string; errName?: string }).issueId === 'issue-1'
      && (fields as { errName?: string }).errName === 'Error')).toBe(true);
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('a genuine wake that replaces an undelivered outcome leaves a warn line (spec: the superseded outcome is logged)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = harness({}, [seeded({ state: 'recorded', outcome: { disposition: 'done', comment: 'old private answer' }, leaseExpiresAt: 0 })]);
    expect((await h.dispatch('run-9')).status).toBe(200);
    const line = warn.mock.calls.find(([fields]) => (fields as { reason?: string }).reason === 'outcome_superseded');
    expect(line?.[0]).toMatchObject({ issueId: 'issue-1', attemptNo: 1 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('old private answer');
  });

  it('a takeover of an expired running attempt leaves a warn line', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = harness({}, [seeded({ leaseExpiresAt: Date.now() - 1 })]);
    expect((await h.dispatch('run-9')).status).toBe(200);
    expect(warn.mock.calls.some(([fields]) => (fields as { reason?: string }).reason === 'attempt_takeover')).toBe(true);
  });

  it('terminal failures are logged above info', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const h = harness({ deliver: vi.fn(async () => { throw new Error('socket hang up'); }) });
    expect((await h.dispatch('run-1')).status).toBe(500);
    const loud = [...warn.mock.calls, ...error.mock.calls].some(([fields]) => (fields as { code?: string }).code === 'delivery_unknown');
    expect(loud).toBe(true);
    expect(info.mock.calls.some(([fields]) => (fields as { code?: string }).code === 'delivery_unknown')).toBe(false);
  });
});

describe('input bounds, after authentication', () => {
  it('a config-store failure while reading the armed agents is a coded 503, not an uncoded 500', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const h = harness({ enabledAgents: async () => { throw new Error('dynamo down'); } });
    const res = await h.dispatch('run-1');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'attempt_store_unavailable' });
    expect(h.map.size).toBe(0);
  });

  it.each(['netzarAgentId', 'runId', 'issueId'] as const)('an over-long %s is a 400 and creates no row', async (field) => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = harness();
    const long = 'x'.repeat(129);
    const body = { netzarAgentId: field === 'netzarAgentId' ? long : 'main', runId: field === 'runId' ? long : 'run-1',
      context: { issueId: field === 'issueId' ? long : 'issue-1' } };
    expect((await h.post(body)).status).toBe(400);
    expect(h.map.size).toBe(0);
    expect(h.work).not.toHaveBeenCalled();
  });

  it('a body over 64 KiB is refused 413 for an authenticated caller and still 401 for an unauthenticated one', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = harness();
    const big = JSON.stringify({ netzarAgentId: 'main', runId: 'run-1', context: { issueId: 'issue-1', pad: 'y'.repeat(70_000) } });
    const length = { 'content-length': String(Buffer.byteLength(big)) };
    expect((await h.post(big, { authorization: 'Bearer s3cret', ...length })).status).toBe(413);
    expect((await h.post(big, { authorization: 'Bearer wrong', ...length })).status).toBe(401);
    expect(h.map.size).toBe(0);
  });

  it('a corrupt stored status never throws: the replay answers 500', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const h = harness({}, [seeded({ state: 'failed', failure: { code: 'connector_auth', status: 99, retryable: false } })]);
    const res = await h.dispatch('run-1');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'connector_auth' });
  });
});

describe('adversarial case 6: a delivery that throws without a typed refusal is never retried blind', () => {
  it.each([
    ['an untyped throw', () => new Error('socket hang up')],
    ['delivery_unknown', () => new DispatchFailure('delivery_unknown', 500, false)],
  ])('%s: 500 delivery_unknown, terminal, replayed to the re-send, one delivery in all', async (_name, make) => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const h = harness({ deliver: vi.fn(async () => { throw make(); }) });
    const first = await h.dispatch('run-1');
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({ error: 'delivery_unknown' });
    expect(h.map.get('issue-1')).toMatchObject({ state: 'failed', failure: { code: 'delivery_unknown', status: 500, retryable: false } });
    const again = await h.dispatch('run-2', { retryOfRunId: 'run-1' });
    expect(again.status).toBe(500);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.work).toHaveBeenCalledTimes(1);
  });
});

describe('critic findings (F1, F2)', () => {
  it('F1: a request attached to attempt N answers 409 lease_lost when attempt N+1 is the one that was delivered', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = harness({ holdMs: 600 }, [seeded({})]);
    const waiting = h.dispatch('run-2', { retryOfRunId: 'run-1' });
    await sleep(40);
    const row = h.map.get('issue-1')!;
    h.map.set('issue-1', { ...row, attemptNo: 2, state: 'delivered', leaseToken: row.leaseToken + 1, holderId: 'task-c',
      runIds: ['run-7'], version: row.version + 1 });
    const res = await waiting;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'lease_lost' });
    expect(h.work).not.toHaveBeenCalled();
  });

  it('F2: an in-flight write that ends unknown through lease expiry is an ERROR line with the issue and the attempt', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const h = harness({}, [seeded({ state: 'delivering', outcome: { disposition: 'done', comment: 'private answer' }, leaseExpiresAt: Date.now() - 1 })]);
    const res = await h.dispatch('run-2', { retryOfRunId: 'run-1' });
    expect(res.status).toBe(500);
    expect(error.mock.calls.some(([fields]) => (fields as { issueId?: string; attemptNo?: number; code?: string }).issueId === 'issue-1'
      && (fields as { attemptNo?: number }).attemptNo === 1 && (fields as { code?: string }).code === 'delivery_unknown')).toBe(true);
    expect(JSON.stringify(error.mock.calls)).not.toContain('private answer');
  });
});
