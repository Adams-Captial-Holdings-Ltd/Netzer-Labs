/**
 * Work Platform step 4 (ADR 0013): the SYNC_ATTACH route. FROZEN acceptance tests.
 *
 * The response is held until the outcome is written. 2xx means delivered;
 * every other ending is a non-2xx with an `error` code. Nothing answers 202.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaperclipDispatchRouter, type PaperclipDispatchDeps } from './paperclip-dispatch.js';
import {
  ATTEMPT_LEASE_MS,
  createAttemptStore,
  type AttemptOutcome,
  type AttemptRow,
  type AttemptRows,
} from '../../lib/paperclip/attempt-store.js';
import { DispatchFailure } from '../../lib/paperclip/dispatch-worker.js';
import { __resetDispatchDrainForTest, beginDispatchDrain } from '../../lib/paperclip/dispatch-drain.js';
import { __resetPaperclipLockForTest, startPaperclipLock } from '../../lib/paperclip/runtime-lock.js';
import type { PaperclipDispatchContext } from '../../lib/paperclip/types.js';

function memoryRows(): AttemptRows & { peek: (issueId: string) => AttemptRow | undefined; writes: () => number } {
  const map = new Map<string, AttemptRow>();
  let writes = 0;
  return {
    peek: (issueId) => map.get(issueId),
    writes: () => writes,
    get: async (issueId) => { const row = map.get(issueId); return row ? structuredClone(row) : undefined; },
    create: async (row) => { if (map.has(row.issueId)) return false; map.set(row.issueId, structuredClone(row)); writes++; return true; },
    replace: async (issueId, expectedVersion, next) => {
      const current = map.get(issueId);
      if (!current || current.version !== expectedVersion) return false;
      map.set(issueId, structuredClone(next));
      writes++;
      return true;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const OUTCOME: AttemptOutcome = { disposition: 'done', comment: 'the answer' };
const tick = (ms = 25) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function harness(over: Partial<PaperclipDispatchDeps> = {}, holderId = 'task-a') {
  const rows = (over as { rows?: ReturnType<typeof memoryRows> }).rows ?? memoryRows();
  let now = 1_000_000;
  const events: string[] = [];
  const work = vi.fn(async (_ctx: PaperclipDispatchContext): Promise<AttemptOutcome> => { events.push('work'); return OUTCOME; });
  const deliver = vi.fn(async (ctx: PaperclipDispatchContext, _outcome: AttemptOutcome): Promise<void> => { events.push(`deliver:${ctx.runId}`); });
  const deps: PaperclipDispatchDeps = {
    secret: () => 's3cret',
    knownAgents: () => ['main', 'sleeper'],
    enabledAgents: async () => ['main'],
    attempts: createAttemptStore({ rows, holderId, now: () => now }),
    work,
    deliver,
    holdMs: 400,
    pollMs: 5,
    renewMs: 50,
    ...over,
  };
  const router = buildPaperclipDispatchRouter(deps);
  const send = (body: Record<string, unknown>, headers: Record<string, string> = { authorization: 'Bearer s3cret' }) =>
    router.request('/dispatch', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const dispatch = (runId: string, extra: Record<string, unknown> = {}, issueId = 'issue-1', agent = 'main') =>
    send({ netzarAgentId: agent, agentId: 'pc-agent', runId, context: { issueId, wakeReason: 'issue_assigned', ...extra } });
  return { rows, events, work, deliver, deps, send, dispatch, advance: (ms: number) => { now += ms; } };
}

describe('SYNC_ATTACH dispatch route', () => {
  beforeEach(() => { __resetPaperclipLockForTest(); __resetDispatchDrainForTest(); });
  afterEach(() => { __resetPaperclipLockForTest(); __resetDispatchDrainForTest(); });

  it('holds the response until the outcome is delivered, then answers 200', async () => {
    const gate = deferred<AttemptOutcome>();
    const h = harness({ work: vi.fn(() => gate.promise) });
    let settled = false;
    const pending = h.dispatch('run-1').then((res) => { settled = true; return res; });
    await tick(60);
    expect(settled).toBe(false);
    expect(h.rows.peek('issue-1')?.state).toBe('running');
    gate.resolve(OUTCOME);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, issueId: 'issue-1', attemptNo: 1 });
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0]?.[0].runId).toBe('run-1');
    expect(h.deliver.mock.calls[0]?.[1]).toEqual(OUTCOME);
    expect(h.rows.peek('issue-1')?.state).toBe('delivered');
  });

  it('records the outcome before it delivers (a crash between the two loses nothing)', async () => {
    const h = harness();
    const seen: unknown[] = [];
    h.deliver.mockImplementation(async () => { const row = h.rows.peek('issue-1'); seen.push([row?.state, structuredClone(row?.outcome)]); });
    expect((await h.dispatch('run-1')).status).toBe(200);
    expect(seen).toEqual([['delivering', OUTCOME]]);
    // Delivered: the customer text leaves the row, the disposition stays.
    expect(h.rows.peek('issue-1')?.outcome).toEqual({ disposition: 'done', comment: '' });
  });

  it('duplicate dispatch (same run id, concurrent): one execution, one delivery, both 200', async () => {
    const gate = deferred<AttemptOutcome>();
    const work = vi.fn(() => gate.promise);
    const h = harness({ work });
    const first = h.dispatch('run-1');
    await tick();
    const second = h.dispatch('run-1');
    await tick();
    gate.resolve(OUTCOME);
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('a retry on another task attaches to the running attempt and gets the same result', async () => {
    const gate = deferred<AttemptOutcome>();
    const workA = vi.fn(() => gate.promise);
    const a = harness({ work: workA }, 'task-a');
    const b = harness({ rows: a.rows } as never, 'task-b');
    const first = a.dispatch('run-1');
    await tick();
    const second = b.dispatch('run-2', { retryOfRunId: 'run-1', wakeReason: 'issue_continuation_needed' });
    await tick();
    expect(b.work).not.toHaveBeenCalled();
    gate.resolve(OUTCOME);
    const [ra, rb] = await Promise.all([first, second]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(workA).toHaveBeenCalledTimes(1);
    const deliveries = [...a.deliver.mock.calls, ...b.deliver.mock.calls];
    expect(deliveries).toHaveLength(1);
    // The write carries the NEWEST run id on the row: the one Paperclip still holds open.
    expect(deliveries[0]?.[0].runId).toBe('run-2');
  });

  it('a re-send after delivery replays 200 with no work and no write', async () => {
    const h = harness();
    expect((await h.dispatch('run-1')).status).toBe(200);
    const writes = h.rows.writes();
    const res = await h.dispatch('run-2', { retryOfRunId: 'run-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, replayed: true, attemptNo: 1 });
    expect(h.work).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.rows.writes()).toBe(writes);
  });

  it('hold cap: 504 attempt_timeout, and the holder still delivers the outcome late with the newest run id', async () => {
    const gate = deferred<AttemptOutcome>();
    const work = vi.fn(() => gate.promise);
    const h = harness({ work, holdMs: 40 });
    const timedOut = await h.dispatch('run-1');
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toMatchObject({ error: 'attempt_timeout' });
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.rows.peek('issue-1')?.state).toBe('running');
    gate.resolve(OUTCOME);
    await tick(60);
    expect(h.rows.peek('issue-1')?.state).toBe('delivered');
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0]?.[0].runId).toBe('run-1');
    const res = await h.dispatch('run-2', { retryOfRunId: 'run-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replayed: true });
    expect(work).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('a recorded outcome left by a crashed holder is delivered by the re-send, with the re-send run id', async () => {
    const h = harness();
    await h.rows.create({
      issueId: 'issue-1', attemptNo: 1, state: 'recorded', leaseToken: 1, holderId: 'dead-task',
      leaseExpiresAt: 1, runIds: ['run-1'], outcome: OUTCOME, version: 2, startedAt: 1, updatedAt: 1,
    });
    const res = await h.dispatch('run-2', { retryOfRunId: 'run-1' });
    expect(res.status).toBe(200);
    expect(h.work).not.toHaveBeenCalled();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0]?.[0].runId).toBe('run-2');
    expect(h.deliver.mock.calls[0]?.[1]).toEqual(OUTCOME);
    expect(h.rows.peek('issue-1')?.state).toBe('delivered');
  });

  it('a genuine new wake after delivery runs a new attempt', async () => {
    const h = harness();
    expect((await h.dispatch('run-1')).status).toBe(200);
    const res = await h.dispatch('run-7', { wakeReason: 'issue_commented', wakeCommentId: 'comment-2' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ attemptNo: 2 });
    expect(h.work).toHaveBeenCalledTimes(2);
    expect(h.deliver).toHaveBeenCalledTimes(2);
  });

  it('a genuine wake while an attempt runs is refused 409 and nothing runs twice', async () => {
    const gate = deferred<AttemptOutcome>();
    const work = vi.fn(() => gate.promise);
    const h = harness({ work });
    const first = h.dispatch('run-1');
    await tick();
    const res = await h.dispatch('run-8', { wakeReason: 'issue_commented' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'attempt_in_progress' });
    gate.resolve(OUTCOME);
    expect((await first).status).toBe(200);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['cost_cap', 402, true],
    ['model_access', 503, true],
    ['agent_failed', 500, true],
    ['connector_auth', 502, false],
  ] as const)('a failed attempt answers %s with %i and delivers nothing', async (code, status, retryable) => {
    const h = harness({ work: vi.fn(async () => { throw new DispatchFailure(code, status, retryable); }) });
    const res = await h.dispatch('run-1');
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: code, attemptNo: 1 });
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.rows.peek('issue-1')).toMatchObject({ state: 'failed', failure: { code, status, retryable } });
  });

  it('an unexpected throw is agent_failed 500, retryable, and its message never reaches the body', async () => {
    const h = harness({ work: vi.fn(async () => { throw new Error('vendor said: secret-token-123'); }) });
    const res = await h.dispatch('run-1');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'agent_failed' });
    expect(text).not.toContain('secret-token-123');
    expect(h.rows.peek('issue-1')?.failure).toMatchObject({ retryable: true });
  });

  it('after a retryable failure the re-send runs again; after a terminal one it is replayed without work', async () => {
    const work = vi.fn<(ctx: PaperclipDispatchContext) => Promise<AttemptOutcome>>()
      .mockRejectedValueOnce(new DispatchFailure('cost_cap', 402, true))
      .mockResolvedValueOnce(OUTCOME);
    const h = harness({ work });
    expect((await h.dispatch('run-1')).status).toBe(402);
    const again = await h.dispatch('run-2', { retryOfRunId: 'run-1' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ attemptNo: 2 });

    const dead = vi.fn(async () => { throw new DispatchFailure('connector_auth', 502, false); });
    const t = harness({ work: dead });
    expect((await t.dispatch('run-1')).status).toBe(502);
    const replay = await t.dispatch('run-2', { retryOfRunId: 'run-1' });
    expect(replay.status).toBe(502);
    expect(await replay.json()).toMatchObject({ error: 'connector_auth' });
    expect(dead).toHaveBeenCalledTimes(1);
  });

  it('a holder whose lease was taken over delivers nothing and answers 409 lease_lost', async () => {
    const gate = deferred<AttemptOutcome>();
    const a = harness({ work: vi.fn(() => gate.promise), renewMs: 60_000 }, 'task-a');
    const first = a.dispatch('run-1');
    await tick();
    a.advance(ATTEMPT_LEASE_MS + 1);
    let now = 1_000_000 + ATTEMPT_LEASE_MS + 1;
    const rowsB = a.rows;
    const b = harness({ attempts: createAttemptStore({ rows: rowsB, holderId: 'task-b', now: () => now }) }, 'task-b');
    const second = await b.dispatch('run-2', { retryOfRunId: 'run-1' });
    now += 1;
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ attemptNo: 2 });
    gate.resolve({ disposition: 'done', comment: 'stale answer' });
    const stale = await first;
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'lease_lost' });
    expect(a.deliver).not.toHaveBeenCalled();
    expect(a.rows.peek('issue-1')).toMatchObject({ state: 'delivered', attemptNo: 2, holderId: 'task-b' });
  });

  it('a transient delivery failure answers 502 delivery_failed and the re-send delivers once', async () => {
    const h = harness();
    h.deliver.mockRejectedValueOnce(new DispatchFailure('delivery_failed', 502, true));
    const res = await h.dispatch('run-1');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'delivery_failed' });
    expect(h.rows.peek('issue-1')?.state).toBe('recorded');
    expect((await h.dispatch('run-2', { retryOfRunId: 'run-1' })).status).toBe(200);
    expect(h.work).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledTimes(2);
  });

  it('a delivery refused for good ends the attempt connector_auth and is never retried', async () => {
    const h = harness();
    h.deliver.mockRejectedValue(new DispatchFailure('connector_auth', 502, false));
    expect((await h.dispatch('run-1')).status).toBe(502);
    expect(h.rows.peek('issue-1')).toMatchObject({ state: 'failed', failure: { code: 'connector_auth', retryable: false } });
    expect((await h.dispatch('run-2', { retryOfRunId: 'run-1' })).status).toBe(502);
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('a delivery whose lease expired mid-write is unknown: 500, no second delivery', async () => {
    const h = harness();
    const rows = h.rows;
    await rows.create({
      issueId: 'issue-1', attemptNo: 1, state: 'delivering', leaseToken: 2, holderId: 'dead-task',
      leaseExpiresAt: 1_000_000 - 1, runIds: ['run-1'], outcome: OUTCOME, version: 3, startedAt: 1, updatedAt: 1,
    });
    const res = await h.dispatch('run-2', { retryOfRunId: 'run-1' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'delivery_unknown' });
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.work).not.toHaveBeenCalled();
  });

  it('a guardrail-blocked turn: the notice is delivered as a comment, then the request ends 409 agent_blocked (never a 2xx)', async () => {
    const notice: AttemptOutcome = { disposition: 'blocked', comment: 'blocked by a guardrail' };
    const blockedWork = vi.fn(async () => notice);
    const h = harness({ work: blockedWork });
    const res = await h.dispatch('run-1');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'agent_blocked', attemptNo: 1 });
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0]?.[1]).toEqual(notice);
    expect(h.rows.peek('issue-1')).toMatchObject({ state: 'failed', failure: { code: 'agent_blocked', status: 409, retryable: false } });
    const replay = await h.dispatch('run-2', { retryOfRunId: 'run-1' });
    expect(replay.status).toBe(409);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(blockedWork).toHaveBeenCalledTimes(1);
  });

  it('never answers 202; an agent that is not armed is 409 agent_not_enabled and creates no row', async () => {
    const h = harness();
    const res = await h.dispatch('run-1', {}, 'issue-1', 'sleeper');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'agent_not_enabled' });
    expect(h.rows.peek('issue-1')).toBeUndefined();
    expect(h.work).not.toHaveBeenCalled();
    const source = readFileSync(new URL('./paperclip-dispatch.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/\b202\b/);
    expect(source).not.toMatch(/paperclip_disabled/);
    expect(source).not.toMatch(/isKillSwitchActive/);
  });

  it('auth, lock, body and unknown agent are refused before any row exists', async () => {
    const h = harness();
    expect((await h.send({ netzarAgentId: 'main', runId: 'r', context: { issueId: 'issue-1' } }, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await h.send({ netzarAgentId: 'main', context: { issueId: 'issue-1' } })).status).toBe(400);
    expect((await h.dispatch('run-1', {}, 'issue-1', 'ghost')).status).toBe(404);
    await startPaperclipLock({ enabled: false, read: async () => ({ verdict: 'clean' }) });
    const locked = await h.dispatch('run-1');
    expect(locked.status).toBe(503);
    expect(await locked.json()).toMatchObject({ error: 'paperclip_locked', code: 'unknown:paperclip_routing_off' });
    expect(h.rows.peek('issue-1')).toBeUndefined();
    expect(h.work).not.toHaveBeenCalled();
  });

  it('draining: a new dispatch is 503 draining with no row; an attached request ends 503 and the holder row is untouched', async () => {
    const gate = deferred<AttemptOutcome>();
    const a = harness({ work: vi.fn(() => gate.promise) }, 'task-a');
    const first = a.dispatch('run-1');
    await tick();
    const b = harness({ rows: a.rows } as never, 'task-b');
    const attached = b.dispatch('run-2', { retryOfRunId: 'run-1' });
    await tick();
    const before = structuredClone(a.rows.peek('issue-1'));
    beginDispatchDrain();
    const fresh = await b.dispatch('run-5', {}, 'issue-2');
    expect(fresh.status).toBe(503);
    expect(await fresh.json()).toMatchObject({ error: 'draining' });
    expect(a.rows.peek('issue-2')).toBeUndefined();
    const ended = await attached;
    expect(ended.status).toBe(503);
    expect(a.rows.peek('issue-1')).toMatchObject({ state: 'running', holderId: before?.holderId, attemptNo: before?.attemptNo, leaseToken: before?.leaseToken });
    gate.resolve(OUTCOME);
    await first;
  });

  it('a store that cannot answer is 503 attempt_store_unavailable and runs nothing', async () => {
    const broken: AttemptRows = {
      get: async () => { throw new Error('dynamo down'); },
      create: async () => { throw new Error('dynamo down'); },
      replace: async () => { throw new Error('dynamo down'); },
    };
    const h = harness({ attempts: createAttemptStore({ rows: broken, holderId: 'task-a', now: () => 1 }) });
    const res = await h.dispatch('run-1');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'attempt_store_unavailable' });
    expect(h.work).not.toHaveBeenCalled();
  });

  it('retryOfRunId that is not a short string is ignored, never stored', async () => {
    const h = harness();
    expect((await h.dispatch('run-1', { retryOfRunId: 42 })).status).toBe(200);
    expect((await h.dispatch('run-2', { retryOfRunId: 'x'.repeat(10_000) })).status).toBe(200);
    expect(JSON.stringify(h.rows.peek('issue-1'))).not.toContain('xxxxxxxxxx');
    expect(h.work).toHaveBeenCalledTimes(2);
  });

  it('the holder renews its lease while the work runs', async () => {
    const gate = deferred<AttemptOutcome>();
    const h = harness({ work: vi.fn(() => gate.promise), renewMs: 10 });
    const pending = h.dispatch('run-1');
    await tick(20);
    const firstExpiry = h.rows.peek('issue-1')?.leaseExpiresAt ?? 0;
    h.advance(5_000);
    await tick(40);
    expect(h.rows.peek('issue-1')?.leaseExpiresAt ?? 0).toBeGreaterThan(firstExpiry);
    gate.resolve(OUTCOME);
    expect((await pending).status).toBe(200);
  });
});
