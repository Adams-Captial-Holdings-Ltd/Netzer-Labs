/**
 * Step 4 review findings on the held route (red first, then fixed):
 * a lease-store blip during a renewal must not throw away finished work, and
 * the operator-facing warn lines the fast-ACK route had must survive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../observability/logger.js';
import { buildPaperclipDispatchRouter } from './paperclip-dispatch.js';
import { createAttemptStore, type AttemptOutcome, type AttemptRow, type AttemptRows } from '../../lib/paperclip/attempt-store.js';
import { __resetDispatchDrainForTest } from '../../lib/paperclip/dispatch-drain.js';
import { __resetPaperclipLockForTest } from '../../lib/paperclip/runtime-lock.js';

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

const OUTCOME: AttemptOutcome = { disposition: 'done', comment: 'the answer' };
const body = (runId: string) => JSON.stringify({ netzarAgentId: 'main', runId, context: { issueId: 'issue-1' } });
const post = (router: ReturnType<typeof buildPaperclipDispatchRouter>, init: { auth?: string; body?: string } = {}) =>
  router.request('/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.auth === undefined ? { authorization: 'Bearer s3cret' } : init.auth ? { authorization: init.auth } : {}) },
    body: init.body ?? body('run-1'),
  });

describe('held dispatch route: resilience and operator signals', () => {
  beforeEach(() => { __resetPaperclipLockForTest(); __resetDispatchDrainForTest(); });
  afterEach(() => { vi.restoreAllMocks(); __resetPaperclipLockForTest(); __resetDispatchDrainForTest(); });

  it('a transient store error on ONE lease renewal does not discard a finished outcome', async () => {
    const rows = memoryRows();
    const store = createAttemptStore({ rows, holderId: 'task-a', now: () => 1_000_000 });
    let blips = 1;
    const attempts = { ...store, renew: vi.fn(async (handle: Parameters<typeof store.renew>[0]) => {
      if (blips-- > 0) throw new Error('dynamo blip');
      return store.renew(handle);
    }) };
    const deliver = vi.fn(async () => undefined);
    const router = buildPaperclipDispatchRouter({
      secret: () => 's3cret', knownAgents: () => ['main'], enabledAgents: async () => ['main'],
      attempts, deliver, holdMs: 1_000, pollMs: 5, renewMs: 10,
      work: () => new Promise<AttemptOutcome>((resolve) => setTimeout(() => resolve(OUTCOME), 60)),
    });
    const res = await post(router);
    expect(attempts.renew.mock.calls.length).toBeGreaterThan(1);
    expect(res.status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(rows.peek('issue-1')?.state).toBe('delivered');
  });

  it('the starter answers as soon as its attempt settles, not a whole poll interval later', async () => {
    const rows = memoryRows();
    const router = buildPaperclipDispatchRouter({
      secret: () => 's3cret', knownAgents: () => ['main'], enabledAgents: async () => ['main'],
      attempts: createAttemptStore({ rows, holderId: 'task-a', now: () => 1_000_000 }),
      work: async () => OUTCOME, deliver: async () => undefined, holdMs: 5_000, pollMs: 2_000, renewMs: 10_000,
    });
    const started = Date.now();
    const res = await post(router);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('an unconfigured secret and a wrong bearer each leave one warn line with a reason and no secret', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const closed = buildPaperclipDispatchRouter({ secret: () => undefined });
    expect((await post(closed)).status).toBe(401);
    expect(warn).toHaveBeenCalledTimes(1);
    const open = buildPaperclipDispatchRouter({ secret: () => 's3cret' });
    expect((await post(open, { auth: 'Bearer wrong-value-123' })).status).toBe(401);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toMatchObject({ reason: 'bad_secret' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('wrong-value-123');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('s3cret');
  });

  it('a rejected body and an unknown agent each leave one warn line', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const router = buildPaperclipDispatchRouter({ secret: () => 's3cret', knownAgents: () => ['main'], enabledAgents: async () => ['main'] });
    expect((await post(router, { body: JSON.stringify({ netzarAgentId: 'main' }) })).status).toBe(400);
    expect(warn.mock.calls.at(-1)?.[0]).toMatchObject({ reason: 'invalid_body' });
    expect((await post(router, { body: JSON.stringify({ netzarAgentId: 'ghost', runId: 'r', context: { issueId: 'i' } }) })).status).toBe(404);
    expect(warn.mock.calls.at(-1)?.[0]).toMatchObject({ agentId: 'ghost' });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
