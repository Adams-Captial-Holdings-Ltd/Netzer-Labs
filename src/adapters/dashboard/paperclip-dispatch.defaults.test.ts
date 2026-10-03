import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPaperclipLockForTest, enforceStartupLock } from '../../lib/paperclip/runtime-lock.js';
import { __resetDispatchDrainForTest } from '../../lib/paperclip/dispatch-drain.js';
import type { AttemptRow } from '../../lib/paperclip/attempt-store.js';
import { ATTEMPT_LEASE_MS } from '../../lib/paperclip/attempt-store.js';
import { RUNNER_HOLDER_ID } from '../../lib/state/runner-lease.js';
import { ATTEMPT_RENEW_MS } from './paperclip-dispatch.js';

const { knownAgents, work, deliver, rows } = vi.hoisted(() => ({
  knownAgents: vi.fn(() => ['main']),
  work: vi.fn(async () => ({ disposition: 'done' as const, comment: 'done' })),
  deliver: vi.fn(async () => {}),
  rows: new Map<string, AttemptRow>(),
}));
vi.mock('../../lib/config/agent-loader.js', async (importActual) => ({
  ...await importActual<typeof import('../../lib/config/agent-loader.js')>(), listKnownAgents: knownAgents,
}));
vi.mock('../../lib/state/runtime-config-repo.js', async (importActual) => ({
  ...await importActual<typeof import('../../lib/state/runtime-config-repo.js')>(),
  getConfigCategory: vi.fn(async () => ({ enabled_agents: '["main"]' })),
}));
vi.mock('../../lib/paperclip/attempt-rows-dynamo.js', () => ({ dynamoAttemptRows: () => ({
  get: async (id: string) => { const row = rows.get(id); return row && structuredClone(row); },
  create: async (row: AttemptRow) => { if (rows.has(row.issueId)) return false; rows.set(row.issueId, structuredClone(row)); return true; },
  replace: async (id: string, version: number, row: AttemptRow) => { if (rows.get(id)?.version !== version) return false; rows.set(id, structuredClone(row)); return true; },
}) }));
vi.mock('../../lib/paperclip/dispatch-worker.js', async (importActual) => ({
  ...await importActual<typeof import('../../lib/paperclip/dispatch-worker.js')>(),
  runDispatchAttempt: work, deliverOutcome: deliver,
}));
import { buildPrivateDispatchApp } from '../../server.js';

const token = 'test-bearer-value';
const path = '/api/paperclip/dispatch';
const body = JSON.stringify({ netzarAgentId: 'main', issueId: 'a1b2c3d4-0000-4000-8000-000000000001', runId: '11111111-2222-4333-8444-555555555555' });
const post = (auth: string, payload = body) => buildPrivateDispatchApp().request(path, {
  method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: payload,
});
beforeEach(() => {
  vi.stubEnv('PAPERCLIP_DISPATCH_SECRET', token);
  rows.clear(); work.mockClear(); deliver.mockClear();
  __resetPaperclipLockForTest(); __resetDispatchDrainForTest();
});
afterEach(() => { __resetPaperclipLockForTest(); __resetDispatchDrainForTest(); vi.unstubAllEnvs(); });

describe('private dispatch defaults', () => {
  it('uses the default secret, agent list, attempt store, work and delivery', async () => {
    expect((await post(token)).status).toBe(200);
    expect(work).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(rows.get('a1b2c3d4-0000-4000-8000-000000000001')?.holderId).toBe(RUNNER_HOLDER_ID);
    expect(ATTEMPT_RENEW_MS).toBe(10_000);
    expect(ATTEMPT_RENEW_MS).toBeLessThan(ATTEMPT_LEASE_MS);
    expect((await post('test-other-bearer-value')).status).toBe(401);
    const unknown = await post(token, JSON.stringify({ netzarAgentId: 'missing', issueId: 'other', runId: 'other-run' }));
    expect(unknown.status).toBe(404);
  });
  it('checks auth, then lock, before body validation or store access', async () => {
    await enforceStartupLock({ read: async () => ({ verdict: 'unknown', reason: 'paperclip_unreachable' }), attempts: 1 });
    const locked = await post(token, '{}');
    expect(locked.status).toBe(503);
    expect(await locked.json()).toMatchObject({ error: 'paperclip_locked' });
    expect((await post('test-other-bearer-value')).status).toBe(401);
    expect(rows.size).toBe(0);
  });
});
