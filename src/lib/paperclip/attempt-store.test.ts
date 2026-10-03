/**
 * Work Platform step 4 (ADR 0013): the attempt row. FROZEN acceptance tests.
 *
 * One row per issue. A dispatch belongs to the current attempt when its run id,
 * or the run id it retries, is already on the row; anything else is a genuine
 * new wake. Every holder write is fenced by (attemptNo, leaseToken, holderId).
 */
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_LEASE_MS,
  ATTEMPT_RUN_IDS_MAX,
  FencedOutError,
  createAttemptStore,
  decideDispatch,
  type AttemptRow,
  type AttemptRows,
} from './attempt-store.js';

/** In-memory rows with the same compare-and-set rule the DynamoDB adapter must keep. */
function memoryRows(): AttemptRows & { peek: (issueId: string) => AttemptRow | undefined } {
  const map = new Map<string, AttemptRow>();
  return {
    peek: (issueId) => map.get(issueId),
    get: async (issueId) => { const row = map.get(issueId); return row ? structuredClone(row) : undefined; },
    create: async (row) => { if (map.has(row.issueId)) return false; map.set(row.issueId, structuredClone(row)); return true; },
    replace: async (issueId, expectedVersion, next) => {
      const current = map.get(issueId);
      if (!current || current.version !== expectedVersion) return false;
      map.set(issueId, structuredClone(next));
      return true;
    },
  };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function row(over: Partial<AttemptRow> = {}): AttemptRow {
  return {
    issueId: 'issue-1', attemptNo: 1, state: 'running', leaseToken: 1, holderId: 'task-a',
    leaseExpiresAt: 1_000_000 + ATTEMPT_LEASE_MS, runIds: ['run-1'], version: 1, startedAt: 1_000_000, updatedAt: 1_000_000,
    ...over,
  };
}

const NOW = 1_000_000;
const retry = { issueId: 'issue-1', runId: 'run-2', retryOfRunId: 'run-1' };
const same = { issueId: 'issue-1', runId: 'run-1' };
const genuine = { issueId: 'issue-1', runId: 'run-9' };

describe('decideDispatch (pure decision table)', () => {
  it('no row: start attempt 1', () => {
    expect(decideDispatch(undefined, genuine, NOW)).toEqual({ action: 'start', attemptNo: 1, leaseToken: 1 });
  });

  it.each([['same run id', same], ['a retry of a run on the row', retry]])('running, lease live, %s: attach', (_n, dispatch) => {
    expect(decideDispatch(row(), dispatch, NOW).action).toBe('attach');
  });

  it('running, lease live, genuine wake: busy (nothing runs twice)', () => {
    expect(decideDispatch(row(), genuine, NOW).action).toBe('busy');
  });

  it.each([['belongs', retry], ['genuine', genuine]])('running, lease expired, %s: takeover starts attempt N+1 with a higher token', (_n, dispatch) => {
    const expired = row({ attemptNo: 3, leaseToken: 7, leaseExpiresAt: NOW });
    expect(decideDispatch(expired, dispatch, NOW)).toEqual({ action: 'start', attemptNo: 4, leaseToken: 8 });
  });

  it('recorded + belongs: deliver; recorded + genuine: next attempt', () => {
    const recorded = row({ state: 'recorded', outcome: { disposition: 'done', comment: 'x' } });
    expect(decideDispatch(recorded, retry, NOW).action).toBe('deliver');
    expect(decideDispatch(recorded, genuine, NOW)).toEqual({ action: 'start', attemptNo: 2, leaseToken: 2 });
  });

  it('delivering: attach while the lease is live, unknown once it expired (never a second delivery)', () => {
    const delivering = row({ state: 'delivering', outcome: { disposition: 'done', comment: 'x' } });
    expect(decideDispatch(delivering, retry, NOW).action).toBe('attach');
    expect(decideDispatch({ ...delivering, leaseExpiresAt: NOW - 1 }, retry, NOW).action).toBe('unknown');
    expect(decideDispatch({ ...delivering, leaseExpiresAt: NOW - 1 }, genuine, NOW).action).toBe('unknown');
  });

  it('delivered + belongs: replay; delivered + genuine: next attempt', () => {
    const delivered = row({ state: 'delivered', outcome: { disposition: 'done', comment: 'x' } });
    expect(decideDispatch(delivered, retry, NOW).action).toBe('replay');
    expect(decideDispatch(delivered, same, NOW).action).toBe('replay');
    expect(decideDispatch(delivered, genuine, NOW)).toEqual({ action: 'start', attemptNo: 2, leaseToken: 2 });
  });

  it('failed: a retryable failure always runs again; a terminal one is replayed to its own retries only', () => {
    const retryable = row({ state: 'failed', failure: { code: 'cost_cap', status: 402, retryable: true } });
    const terminal = row({ state: 'failed', failure: { code: 'connector_auth', status: 502, retryable: false } });
    expect(decideDispatch(retryable, retry, NOW).action).toBe('start');
    expect(decideDispatch(retryable, genuine, NOW).action).toBe('start');
    expect(decideDispatch(terminal, retry, NOW)).toEqual({ action: 'replay_failure', failure: terminal.failure });
    expect(decideDispatch(terminal, genuine, NOW).action).toBe('start');
  });

  it('adversarial: a retry of a run that is NOT on the row is a genuine wake, never an attach', () => {
    const stale = { issueId: 'issue-1', runId: 'run-50', retryOfRunId: 'run-of-an-older-attempt' };
    expect(decideDispatch(row(), stale, NOW).action).toBe('busy');
    expect(decideDispatch(row({ state: 'delivered' }), stale, NOW).action).toBe('start');
  });

  it('adversarial: an empty retryOfRunId never matches', () => {
    expect(decideDispatch(row({ runIds: [''] }), { issueId: 'issue-1', runId: 'run-3', retryOfRunId: '' }, NOW).action).toBe('busy');
  });
});

describe('createAttemptStore', () => {
  function setup() {
    const rows = memoryRows();
    const c = clock();
    const a = createAttemptStore({ rows, holderId: 'task-a', now: c.now });
    const b = createAttemptStore({ rows, holderId: 'task-b', now: c.now });
    return { rows, c, a, b };
  }

  it('two tasks racing the first dispatch: exactly one starts, the other attaches', async () => {
    const { a, b, rows } = setup();
    const [first, second] = await Promise.all([a.begin(same), b.begin(same)]);
    expect([first.action, second.action].sort()).toEqual(['attach', 'start']);
    expect(rows.peek('issue-1')?.attemptNo).toBe(1);
  });

  it('start → record → deliver → delivered, and a late re-send replays without a write', async () => {
    const { a, b, rows } = setup();
    const started = await a.begin(same);
    if (started.action !== 'start') throw new Error('expected start');
    await a.record(started.handle, { disposition: 'done', comment: 'the answer' });
    expect(rows.peek('issue-1')?.state).toBe('recorded');
    const deliver = await b.begin(retry);
    if (deliver.action !== 'deliver') throw new Error('expected deliver');
    expect(deliver.outcome).toEqual({ disposition: 'done', comment: 'the answer' });
    expect(rows.peek('issue-1')?.state).toBe('delivering');
    await b.markDelivered(deliver.handle);
    expect(rows.peek('issue-1')?.state).toBe('delivered');
    const version = rows.peek('issue-1')?.version;
    const again = await a.begin({ issueId: 'issue-1', runId: 'run-3', retryOfRunId: 'run-2' });
    expect(again.action).toBe('replay');
    expect(rows.peek('issue-1')?.version).toBe(version);
  });

  it('attach records the new run id so a retry of the retry still belongs', async () => {
    const { a, b } = setup();
    await a.begin(same);
    expect((await b.begin(retry)).action).toBe('attach');
    expect((await b.begin({ issueId: 'issue-1', runId: 'run-3', retryOfRunId: 'run-2' })).action).toBe('attach');
  });

  it('fencing: after a takeover the old holder can renew, record, fail or deliver nothing', async () => {
    const { a, b, c, rows } = setup();
    const old = await a.begin(same);
    if (old.action !== 'start') throw new Error('expected start');
    c.advance(ATTEMPT_LEASE_MS + 1);
    const taken = await b.begin(retry);
    if (taken.action !== 'start') throw new Error('expected a takeover start');
    expect(taken.handle.attemptNo).toBe(2);
    expect(taken.handle.leaseToken).toBeGreaterThan(old.handle.leaseToken);
    await expect(a.renew(old.handle)).rejects.toBeInstanceOf(FencedOutError);
    await expect(a.record(old.handle, { disposition: 'done', comment: 'stale' })).rejects.toBeInstanceOf(FencedOutError);
    await expect(a.fail(old.handle, { code: 'agent_failed', status: 500, retryable: true })).rejects.toBeInstanceOf(FencedOutError);
    await expect(a.assertFence(old.handle)).rejects.toBeInstanceOf(FencedOutError);
    expect(rows.peek('issue-1')?.state).toBe('running');
    expect(rows.peek('issue-1')?.outcome).toBeUndefined();
    await expect(b.assertFence(taken.handle)).resolves.toBeUndefined();
  });

  it('fencing: a handle with the right numbers but another holder id is rejected', async () => {
    const { a, b } = setup();
    const started = await a.begin(same);
    if (started.action !== 'start') throw new Error('expected start');
    await expect(b.record(started.handle, { disposition: 'done', comment: 'not mine' })).rejects.toBeInstanceOf(FencedOutError);
  });

  it('renew keeps the lease alive past its first expiry', async () => {
    const { a, b, c } = setup();
    const started = await a.begin(same);
    if (started.action !== 'start') throw new Error('expected start');
    c.advance(ATTEMPT_LEASE_MS - 1_000);
    await a.renew(started.handle);
    c.advance(ATTEMPT_LEASE_MS - 1_000);
    expect((await b.begin(retry)).action).toBe('attach');
  });

  it('a transient delivery failure hands the outcome back; an expired delivery lease is unknown and terminal', async () => {
    const { a, b, c, rows } = setup();
    const started = await a.begin(same);
    if (started.action !== 'start') throw new Error('expected start');
    await a.record(started.handle, { disposition: 'done', comment: 'the answer' });
    const first = await b.begin(retry);
    if (first.action !== 'deliver') throw new Error('expected deliver');
    await b.releaseDelivery(first.handle);
    expect(rows.peek('issue-1')?.state).toBe('recorded');
    const second = await a.begin({ issueId: 'issue-1', runId: 'run-3', retryOfRunId: 'run-2' });
    if (second.action !== 'deliver') throw new Error('expected deliver again');
    c.advance(ATTEMPT_LEASE_MS + 1);
    const third = await b.begin({ issueId: 'issue-1', runId: 'run-4', retryOfRunId: 'run-3' });
    expect(third.action).toBe('unknown');
    expect(rows.peek('issue-1')?.state).toBe('failed');
    expect(rows.peek('issue-1')?.failure).toEqual({ code: 'delivery_unknown', status: 500, retryable: false });
    await expect(a.markDelivered(second.handle)).rejects.toBeInstanceOf(FencedOutError);
    const fourth = await b.begin({ issueId: 'issue-1', runId: 'run-5', retryOfRunId: 'run-4' });
    expect(fourth.action).toBe('replay_failure');
  });

  it('a retryable failure lets the re-send run a new attempt; busy changes nothing', async () => {
    const { a, b, rows } = setup();
    const started = await a.begin(same);
    if (started.action !== 'start') throw new Error('expected start');
    const before = rows.peek('issue-1')?.version;
    expect((await b.begin(genuine)).action).toBe('busy');
    expect(rows.peek('issue-1')?.version).toBe(before);
    await a.fail(started.handle, { code: 'cost_cap', status: 402, retryable: true });
    const next = await b.begin(retry);
    if (next.action !== 'start') throw new Error('expected start');
    expect(next.handle.attemptNo).toBe(2);
  });

  it('runIds is bounded and keeps the newest', async () => {
    const { a, rows } = setup();
    await a.begin(same);
    let previous = 'run-1';
    for (let i = 0; i < ATTEMPT_RUN_IDS_MAX + 15; i++) {
      const runId = `retry-${i}`;
      expect((await a.begin({ issueId: 'issue-1', runId, retryOfRunId: previous })).action).toBe('attach');
      previous = runId;
    }
    const stored = rows.peek('issue-1')?.runIds ?? [];
    expect(stored.length).toBeLessThanOrEqual(ATTEMPT_RUN_IDS_MAX);
    expect(stored.at(-1)).toBe(previous);
  });

  it('rows are per issue: a run id on another issue gives no attach here', async () => {
    const { a, b } = setup();
    await a.begin({ issueId: 'issue-2', runId: 'run-1' });
    const other = await b.begin({ issueId: 'issue-1', runId: 'run-7', retryOfRunId: 'run-1' });
    expect(other.action).toBe('start');
  });

  it('a store that cannot answer fails closed (it throws; it never says start)', async () => {
    const broken: AttemptRows = {
      get: async () => { throw new Error('dynamo down'); },
      create: async () => { throw new Error('dynamo down'); },
      replace: async () => { throw new Error('dynamo down'); },
    };
    const store = createAttemptStore({ rows: broken, holderId: 'task-a', now: () => NOW });
    await expect(store.begin(same)).rejects.toThrow();
  });
});
