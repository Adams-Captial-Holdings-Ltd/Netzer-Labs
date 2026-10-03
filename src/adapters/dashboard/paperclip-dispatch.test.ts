import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildPaperclipDispatchRouter, verifyDispatchSecret } from './paperclip-dispatch.js';
import { createAttemptStore, type AttemptRow, type AttemptRows } from '../../lib/paperclip/attempt-store.js';
import { __resetPaperclipLockForTest } from '../../lib/paperclip/runtime-lock.js';
import { __resetDispatchDrainForTest } from '../../lib/paperclip/dispatch-drain.js';

const ISSUE = 'a1b2c3d4-0000-4000-8000-000000000001';
function harness() {
  const map = new Map<string, AttemptRow>();
  const rows: AttemptRows = {
    get: async (id) => { const row = map.get(id); return row && structuredClone(row); },
    create: async (row) => { if (map.has(row.issueId)) return false; map.set(row.issueId, structuredClone(row)); return true; },
    replace: async (id, version, row) => { if (map.get(id)?.version !== version) return false; map.set(id, structuredClone(row)); return true; },
  };
  const work = vi.fn(async () => ({ disposition: 'done' as const, comment: 'done' }));
  const deliver = vi.fn(async () => {});
  const protection = { hold: vi.fn(), refresh: vi.fn(), release: vi.fn() };
  const router = buildPaperclipDispatchRouter({
    secret: () => 'secret', knownAgents: () => ['main', 'sleeping'], enabledAgents: async () => ['main'],
    attempts: createAttemptStore({ rows, holderId: 'older-test', now: Date.now }), work, deliver, pollMs: 2, protection,
  });
  const send = (body: unknown, authorization = 'Bearer secret') => router.request('/dispatch', {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const body = { netzarAgentId: 'main', agentId: 'paperclip-agent', runId: 'run-1', context: { issueId: ISSUE } };
  return { send, body, work, deliver, map, protection };
}
beforeEach(() => { __resetPaperclipLockForTest(); __resetDispatchDrainForTest(); });

describe('held dispatch route', () => {
  it('answers 200 after one completion write for the measured push shape', async () => {
    const h = harness();
    const res = await h.send(h.body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, issueId: ISSUE, attemptNo: 1 });
    expect(h.work).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.map.get(ISSUE)?.agentId).toBe('main');
    expect(h.protection.hold).toHaveBeenCalledTimes(1);
    expect(h.protection.release).toHaveBeenCalledTimes(1);
  });
  it('authenticates before touching the attempt row', async () => {
    const h = harness();
    expect((await h.send(h.body, 'Bearer wrong')).status).toBe(401);
    expect((await h.send(h.body, '')).status).toBe(401);
    expect(h.map.size).toBe(0);
  });
  it('compares bearer secrets with a length guard', () => {
    expect(verifyDispatchSecret('secret', 'secret')).toBe(true);
    expect(verifyDispatchSecret('secret', 'short')).toBe(false);
    expect(verifyDispatchSecret(undefined, 'secret')).toBe(false);
  });
  it('rejects malformed JSON and missing fields', async () => {
    const h = harness();
    expect((await h.send({ netzarAgentId: 'main' })).status).toBe(400);
    expect(h.map.size).toBe(0);
  });
  it('rejects an unknown or unarmed agent before touching the row', async () => {
    const h = harness();
    expect((await h.send({ ...h.body, netzarAgentId: 'ghost' })).status).toBe(404);
    const disabled = await h.send({ ...h.body, netzarAgentId: 'sleeping' });
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ error: 'agent_not_enabled' });
    expect(h.map.size).toBe(0);
  });
  it('mounts the private dispatch before the dashboard catch-all', async () => {
    const source = await readFile(new URL('../../server.ts', import.meta.url), 'utf8');
    expect(source).toContain('buildPrivateDispatchApp');
    expect(source).toContain('buildPaperclipDispatchRouter');
  });
  it('does not add a human capability for a machine dispatch', async () => {
    const source = await readFile(new URL('../../lib/auth/permissions.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('paperclip:dispatch');
  });
});
