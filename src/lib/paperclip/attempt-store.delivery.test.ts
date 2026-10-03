/**
 * Work Platform step 4 (ADR 0013): delivery of a recorded outcome. FROZEN acceptance tests.
 *
 * Measured in the sealed Paperclip container (spike A120): a non-2xx is never
 * re-sent, and a result can be written later with the run id of the ended run.
 * So the holder (or the sweep) claims the delivery itself, exactly once.
 */
import { describe, expect, it } from 'vitest';
import { ATTEMPT_LEASE_MS, FencedOutError, createAttemptStore, type AttemptRow, type AttemptRows } from './attempt-store.js';

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

function setup() {
  const rows = memoryRows();
  let t = 1_000_000;
  const a = createAttemptStore({ rows, holderId: 'task-a', now: () => t });
  const b = createAttemptStore({ rows, holderId: 'task-b', now: () => t });
  return { rows, a, b, advance: (ms: number) => { t += ms; } };
}

const OUTCOME = { disposition: 'done' as const, comment: 'the answer' };

async function recorded(s: ReturnType<typeof setup>) {
  const started = await s.a.begin({ issueId: 'issue-1', runId: 'run-1' });
  if (started.action !== 'start') throw new Error('expected start');
  await s.a.begin({ issueId: 'issue-1', runId: 'run-2', retryOfRunId: 'run-1' });
  await s.a.record(started.handle, OUTCOME);
  return started.handle;
}

describe('claimDelivery', () => {
  it('recorded → delivering, with the outcome and the NEWEST run id on the row', async () => {
    const s = setup();
    await recorded(s);
    const claim = await s.b.claimDelivery('issue-1');
    expect(claim).toMatchObject({ outcome: OUTCOME, runId: 'run-2' });
    expect(s.rows.peek('issue-1')).toMatchObject({ state: 'delivering', holderId: 'task-b' });
    expect(claim?.handle.leaseToken).toBe(s.rows.peek('issue-1')?.leaseToken);
    expect(s.rows.peek('issue-1')?.leaseExpiresAt).toBe(1_000_000 + ATTEMPT_LEASE_MS);
  });

  it('only one of two concurrent claims wins', async () => {
    const s = setup();
    await recorded(s);
    const claims = await Promise.all([s.a.claimDelivery('issue-1'), s.b.claimDelivery('issue-1')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('returns undefined (and writes nothing) when there is no row or the row is not recorded', async () => {
    const s = setup();
    expect(await s.a.claimDelivery('issue-1')).toBeUndefined();
    const started = await s.a.begin({ issueId: 'issue-1', runId: 'run-1' });
    if (started.action !== 'start') throw new Error('expected start');
    const version = s.rows.peek('issue-1')?.version;
    expect(await s.b.claimDelivery('issue-1')).toBeUndefined();
    expect(s.rows.peek('issue-1')?.version).toBe(version);
    await s.a.record(started.handle, OUTCOME);
    const claim = await s.a.claimDelivery('issue-1');
    expect(await s.b.claimDelivery('issue-1')).toBeUndefined();
    await s.a.markDelivered(claim!.handle);
    expect(await s.b.claimDelivery('issue-1')).toBeUndefined();
  });

  it('the old handle is fenced out once another task claimed the delivery', async () => {
    const s = setup();
    const old = await recorded(s);
    const claim = await s.b.claimDelivery('issue-1');
    await expect(s.a.assertFence(old)).rejects.toBeInstanceOf(FencedOutError);
    await expect(s.a.markDelivered(claim!.handle)).rejects.toBeInstanceOf(FencedOutError);
    await s.b.markDelivered(claim!.handle);
    expect(s.rows.peek('issue-1')?.state).toBe('delivered');
  });

  it('the same task holding an OLDER lease token for the same attempt is fenced out too', async () => {
    const s = setup();
    const old = await recorded(s);
    const claim = await s.a.claimDelivery('issue-1');
    expect(claim!.handle.leaseToken).toBeGreaterThan(old.leaseToken);
    expect(claim!.handle.attemptNo).toBe(old.attemptNo);
    await expect(s.a.assertFence(old)).rejects.toBeInstanceOf(FencedOutError);
    await expect(s.a.renew(old)).rejects.toBeInstanceOf(FencedOutError);
    await expect(s.a.assertFence(claim!.handle)).resolves.toBeUndefined();
  });

  it('markDelivered drops the comment text from the row and keeps the disposition', async () => {
    const s = setup();
    await recorded(s);
    const claim = await s.a.claimDelivery('issue-1');
    await s.a.markDelivered(claim!.handle);
    expect(s.rows.peek('issue-1')?.outcome).toEqual({ disposition: 'done', comment: '' });
    expect(JSON.stringify(s.rows.peek('issue-1'))).not.toContain('the answer');
  });

  it('a terminal failure is replayed to a retry of the retry too (the run id is appended)', async () => {
    const s = setup();
    const started = await s.a.begin({ issueId: 'issue-1', runId: 'run-1' });
    if (started.action !== 'start') throw new Error('expected start');
    await s.a.fail(started.handle, { code: 'connector_auth', status: 502, retryable: false });
    expect((await s.b.begin({ issueId: 'issue-1', runId: 'run-2', retryOfRunId: 'run-1' })).action).toBe('replay_failure');
    expect((await s.b.begin({ issueId: 'issue-1', runId: 'run-3', retryOfRunId: 'run-2' })).action).toBe('replay_failure');
    expect(s.rows.peek('issue-1')?.attemptNo).toBe(1);
  });
});
