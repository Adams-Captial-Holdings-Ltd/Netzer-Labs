/**
 * Work Platform step 4: review findings on the worker, the store and the sweep,
 * each pinned by a test written before its fix.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnResponse } from '../../agent/agent-loop.js';
import { logger } from '../../observability/logger.js';
import { createAttemptStore, type AttemptRow, type AttemptRows } from './attempt-store.js';
import { DispatchFailure, deliverOutcome, parseDispatchBody, runDispatchAttempt } from './dispatch-worker.js';
import { PaperclipError } from './error.js';
import type { MissionEngine } from './mission-engine.js';
import { runPendingDispatchSweep } from './pending-dispatch-sweep.js';
import type { PaperclipDispatchContext } from './types.js';

const ISSUE = '11111111-1111-4111-8111-111111111111';
const ctx: PaperclipDispatchContext = { netzarAgentId: 'main', issueId: ISSUE, runId: 'run-live', dedupeKey: `run-live#${ISSUE}`, context: {} };
const mission = { id: ISSUE, title: 'T', body: 'B', status: 'in_progress', priority: 'medium' };
const engine = (over: Record<string, unknown> = {}) => ({
  getMission: vi.fn(async () => mission), comment: vi.fn(async () => undefined), setStatus: vi.fn(async () => mission),
  completeMission: vi.fn(async () => mission), ...over,
}) as unknown as MissionEngine & { getMission: ReturnType<typeof vi.fn> };
const turn = (over: Partial<AgentTurnResponse> = {}) => ({ text: 'the answer', costUsd: 0, toolCallCount: 0, ...over }) as AgentTurnResponse;
async function failureOf(promise: Promise<unknown>): Promise<DispatchFailure> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(DispatchFailure); return error as DispatchFailure; }
  throw new Error('expected a DispatchFailure');
}

afterEach(() => { vi.restoreAllMocks(); });

describe('the completion write: provably not sent is retryable', () => {
  it('a Paperclip error marked notSent (breaker open, lock closed, switch on) is delivery_failed, kept and retried', async () => {
    const refused = Object.assign(new PaperclipError({ type: 'unavailable' }), { notSent: true });
    const failure = await failureOf(deliverOutcome(ctx, { disposition: 'done', comment: 'x' },
      { engine: engine({ completeMission: vi.fn(async () => { throw refused; }) }) }));
    expect(failure).toMatchObject({ code: 'delivery_failed', status: 502, retryable: true });
  });

  it('the same error WITHOUT the mark stays delivery_unknown (the request may have gone out)', async () => {
    const failure = await failureOf(deliverOutcome(ctx, { disposition: 'done', comment: 'x' },
      { engine: engine({ completeMission: vi.fn(async () => { throw new PaperclipError({ type: 'unavailable' }); }) }) }));
    expect(failure).toMatchObject({ code: 'delivery_unknown', retryable: false });
  });

  it('the client marks exactly its pre-request refusals', () => {
    const source = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');
    expect(source.match(/notSent:\s*true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe('the work: stoppable, and the read carries the run id', () => {
  it('hands its abort signal to the turn, and reads the issue with the actor and the run id', async () => {
    const e = engine();
    const runTurn = vi.fn(async () => turn());
    const controller = new AbortController();
    await runDispatchAttempt(ctx, { engine: e, runTurn, getSessionFn: async () => undefined, appendTurnsFn: async () => undefined,
      abortSignal: controller.signal } as never);
    expect((runTurn.mock.calls[0] as unknown[])[0]).toMatchObject({ abortSignal: controller.signal, agentId: 'main', surface: 'system' });
    expect(e.getMission).toHaveBeenCalledWith(ISSUE, { actor: 'main', runId: 'run-live' });
  });

  it('a turn stopped by the signal is a non-retryable failure and is never appended to the session', async () => {
    const controller = new AbortController();
    const append = vi.fn(async () => undefined);
    const runTurn = vi.fn(async () => { controller.abort(); throw Object.assign(new Error('Turn stopped'), { name: 'AbortError' }); });
    const failure = await failureOf(runDispatchAttempt(ctx, { engine: engine(), runTurn, getSessionFn: async () => undefined,
      appendTurnsFn: append, abortSignal: controller.signal } as never));
    expect(failure).toMatchObject({ code: 'agent_failed', retryable: false });
    expect(append).not.toHaveBeenCalled();
  });
});

describe('parseDispatchBody: identifier bounds', () => {
  const body = (over: Record<string, unknown> = {}) => ({ netzarAgentId: 'main', runId: 'run-1', context: { issueId: ISSUE }, ...over });
  it('accepts identifiers of 128 characters', () => {
    expect(parseDispatchBody(body({ runId: 'r'.repeat(128) }))).not.toBeNull();
  });
  it.each([['netzarAgentId'], ['runId']])('rejects a %s over 128 characters', (field) => {
    expect(parseDispatchBody(body({ [field]: 'x'.repeat(129) }))).toBeNull();
  });
  it('rejects an issueId over 128 characters', () => {
    expect(parseDispatchBody(body({ context: { issueId: 'x'.repeat(129) } }))).toBeNull();
  });
});

describe('the undelivered-outcome alarm measures from when the outcome was recorded', () => {
  const NOW = 50_000_000;
  function setup(row: AttemptRow) {
    const map = new Map([[row.issueId, row]]);
    const rows: AttemptRows = {
      get: async (id) => { const found = map.get(id); return found ? structuredClone(found) : undefined; },
      create: async () => false,
      replace: async (id, version, next) => { if (map.get(id)?.version !== version) return false; map.set(id, structuredClone(next)); return true; },
    };
    let now = NOW;
    const attempts = createAttemptStore({ rows, holderId: 'sweeper', now: () => now });
    const base = { scan: async () => [...map.values()].map((r) => structuredClone(r)), attempts, now: () => now,
      lockState: () => ({ closed: false }) as never, lease: async () => true };
    return { map, attempts, base, advance: (ms: number) => { now += ms; } };
  }

  it('record() stamps recordedAt once; a claim and a release do not move it', async () => {
    const map = new Map<string, AttemptRow>();
    const rows: AttemptRows = {
      get: async (id) => { const found = map.get(id); return found ? structuredClone(found) : undefined; },
      create: async (row) => { map.set(row.issueId, structuredClone(row)); return true; },
      replace: async (id, version, next) => { if (map.get(id)?.version !== version) return false; map.set(id, structuredClone(next)); return true; },
    };
    let now = NOW;
    const store = createAttemptStore({ rows, holderId: 'task-a', now: () => now });
    const begun = await store.begin({ issueId: 'i', runId: 'run-1', agentId: 'main' });
    if (begun.action !== 'start') throw new Error('expected start');
    now += 1_000;
    await store.record(begun.handle, { disposition: 'done', comment: 'c' });
    expect((map.get('i') as AttemptRow & { recordedAt?: number }).recordedAt).toBe(NOW + 1_000);
    now += 600_000;
    const claim = await store.claimDelivery('i');
    await store.releaseDelivery(claim!.handle);
    expect((map.get('i') as AttemptRow & { recordedAt?: number }).recordedAt).toBe(NOW + 1_000);
  });

  it('an outcome retried every pass (its updatedAt is always fresh) still raises the alarm 15 minutes after it was recorded', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const row = { issueId: 'stuck', attemptNo: 1, state: 'recorded', leaseToken: 3, holderId: 'gone', leaseExpiresAt: 0, runIds: ['run-1'],
      agentId: 'main', outcome: { disposition: 'done', comment: 'private' }, version: 7, startedAt: NOW - 30 * 60_000,
      updatedAt: NOW - 5 * 60_000, recordedAt: NOW - 20 * 60_000 } as AttemptRow;
    const h = setup(row);
    await runPendingDispatchSweep({ ...h.base, deliver: async () => { throw new DispatchFailure('delivery_failed', 502, true); } });
    expect(h.map.get('stuck')?.state).toBe('recorded');
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({ count: 1, oldestAgeMs: 20 * 60_000 });
    expect(JSON.stringify(error.mock.calls)).not.toContain('private');
  });

  it('a pass that only ends expired deliveries or skips rows still says so', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const row = { issueId: 'gone', attemptNo: 1, state: 'delivering', leaseToken: 2, holderId: 'dead', leaseExpiresAt: NOW - 1, runIds: ['run-1'],
      agentId: 'main', outcome: { disposition: 'done', comment: 'private' }, version: 4, startedAt: NOW - 60_000, updatedAt: NOW - 60_000 } as AttemptRow;
    const h = setup(row);
    await runPendingDispatchSweep({ ...h.base, deliver: async () => undefined });
    expect(h.map.get('gone')).toMatchObject({ state: 'failed', failure: { code: 'delivery_unknown' } });
    const said = [...info.mock.calls, ...warn.mock.calls].some(([fields]) => (fields as { expired?: number }).expired === 1);
    expect(said).toBe(true);
  });

  it('a delivering row whose lease is still live is left alone', async () => {
    const row = { issueId: 'busy', attemptNo: 1, state: 'delivering', leaseToken: 2, holderId: 'alive', leaseExpiresAt: NOW + 10_000, runIds: ['run-1'],
      agentId: 'main', outcome: { disposition: 'done', comment: 'c' }, version: 4, startedAt: NOW - 60_000, updatedAt: NOW - 60_000 } as AttemptRow;
    const h = setup(row);
    const deliver = vi.fn(async () => undefined);
    await runPendingDispatchSweep({ ...h.base, deliver });
    expect(deliver).not.toHaveBeenCalled();
    expect(h.map.get('busy')).toMatchObject({ state: 'delivering', version: 4 });
    expect(await h.attempts.failExpiredDelivery('busy')).toBe(false);
  });
});

describe('shutdown order (source guard; the live proof is staging S4-L1)', () => {
  it('index.ts waits for held dispatches before it closes the servers and exits', () => {
    const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    const drain = source.indexOf('beginDispatchDrain()');
    const idle = source.indexOf('dispatchesIdle()');
    const close = source.indexOf('privateServer.close(');
    expect(drain).toBeGreaterThan(-1);
    expect(idle).toBeGreaterThan(drain);
    expect(close).toBeGreaterThan(idle);
    expect(source).toMatch(/await\s+dispatchesIdle\(\)/);
  });
});

describe('critic finding F2: the sweep', () => {
  const NOW = 70_000_000;
  function setup(row: AttemptRow) {
    const map = new Map([[row.issueId, row]]);
    const rows: AttemptRows = {
      get: async (id) => { const found = map.get(id); return found ? structuredClone(found) : undefined; },
      create: async () => false,
      replace: async (id, version, next) => { if (map.get(id)?.version !== version) return false; map.set(id, structuredClone(next)); return true; },
    };
    const attempts = createAttemptStore({ rows, holderId: 'sweeper', now: () => NOW });
    const base = { scan: async () => [...map.values()].map((r) => structuredClone(r)), attempts, now: () => NOW,
      lockState: () => ({ closed: false }) as never, lease: async () => true };
    return { map, attempts, base };
  }

  it('ending an expired in-flight write as delivery_unknown is an ERROR line with the issue and the attempt, never the comment', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const h = setup({ issueId: 'lost', attemptNo: 3, state: 'delivering', leaseToken: 2, holderId: 'dead', leaseExpiresAt: NOW - 1, runIds: ['run-1'],
      agentId: 'main', outcome: { disposition: 'done', comment: 'private answer' }, version: 4, startedAt: NOW - 60_000, updatedAt: NOW - 60_000 } as AttemptRow);
    await runPendingDispatchSweep({ ...h.base, deliver: async () => undefined });
    expect(error.mock.calls.some(([fields]) => (fields as { issueId?: string }).issueId === 'lost'
      && (fields as { attemptNo?: number }).attemptNo === 3 && (fields as { code?: string }).code === 'delivery_unknown')).toBe(true);
    expect(JSON.stringify(error.mock.calls)).not.toContain('private answer');
  });

  it('one store blip while handing a provably unsent outcome back does not turn it into a terminal loss', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = setup({ issueId: 'kept', attemptNo: 1, state: 'recorded', leaseToken: 1, holderId: 'gone', leaseExpiresAt: 0, runIds: ['run-1'],
      agentId: 'main', outcome: { disposition: 'done', comment: 'c' }, version: 2, startedAt: NOW - 300_000, updatedAt: NOW - 300_000,
      recordedAt: NOW - 300_000 } as AttemptRow);
    let blips = 1;
    const releaseDelivery = vi.fn(async (handle: Parameters<typeof h.attempts.releaseDelivery>[0]) => {
      if (blips-- > 0) throw new Error('dynamo blip');
      return h.attempts.releaseDelivery(handle);
    });
    await runPendingDispatchSweep({ ...h.base, attempts: { ...h.attempts, releaseDelivery }, storeRetryMs: 1,
      deliver: async () => { throw new DispatchFailure('delivery_failed', 502, true); } } as never);
    expect(releaseDelivery).toHaveBeenCalledTimes(2);
    expect(h.map.get('kept')?.state).toBe('recorded');
  });
});
