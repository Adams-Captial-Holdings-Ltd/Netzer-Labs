import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildPaperclipDispatchRouter, verifyDispatchSecret } from './paperclip-dispatch.js';
import { createAttemptStore, type AttemptRow, type AttemptRows } from '../../lib/paperclip/attempt-store.js';
import { __resetPaperclipLockForTest } from '../../lib/paperclip/runtime-lock.js';
import { __resetDispatchDrainForTest, beginDispatchDrain } from '../../lib/paperclip/dispatch-drain.js';

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
  return { send, body, work, deliver, map, protection, router };
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
    expect(verifyDispatchSecret('secret', undefined)).toBe(false);
    expect(verifyDispatchSecret('', ''), 'two empty values must never match (fail open)').toBe(false);
  });
  it('answers a wrong, longer or absent bearer with the bare 401 body, and no_secret only when unconfigured', async () => {
    const h = harness();
    for (const bearer of ['Bearer wrong', 'Bearer secretx', '']) {
      const res = await h.send(h.body, bearer);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    const closed = buildPaperclipDispatchRouter({ secret: () => undefined });
    const res = await closed.request('/dispatch', { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', reason: 'no_secret' });
    expect(h.work).not.toHaveBeenCalled();
  });
  it('answers malformed JSON 400 invalid_json and each missing field 400 invalid_body with the required list', async () => {
    const h = harness();
    const raw = await h.router.request('/dispatch', { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: '{not json' });
    expect(raw.status).toBe(400);
    expect(await raw.json()).toEqual({ error: 'invalid_json' });
    for (const drop of ['netzarAgentId', 'runId', 'context']) {
      const body: Record<string, unknown> = { ...h.body }; delete body[drop];
      const res = await h.send(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_body', required: expect.arrayContaining(['netzarAgentId', 'runId']) });
    }
    const ghost = await h.send({ ...h.body, netzarAgentId: 'ghost' });
    expect(await ghost.json()).toEqual({ error: 'unknown_agent', netzarAgentId: 'ghost' });
    expect(h.map.size).toBe(0);
  });
  it('an unauthenticated caller learns nothing about draining', async () => {
    const h = harness();
    beginDispatchDrain();
    expect((await h.send(h.body, 'Bearer wrong')).status).toBe(401);
    expect((await h.send(h.body)).status).toBe(503);
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
    // The public app answers 404 for the dispatch path BEFORE the dashboard catch-all can see it.
    const deny = source.indexOf("app.all('/api/paperclip/dispatch'");
    const catchAll = source.indexOf("app.route('/api', buildDashboardRouter())");
    expect(deny).toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(deny);
  });
  it('does not add a human capability for a machine dispatch', async () => {
    const source = await readFile(new URL('../../lib/auth/permissions.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('paperclip:dispatch');
    // C-17: the machine route authenticates with its bearer only; it must not lean on the human capability model.
    const route = await readFile(new URL('./paperclip-dispatch.ts', import.meta.url), 'utf8');
    expect(route).not.toMatch(/hasCapability|requiredRole|authz-matrix|auth\/permissions/);
  });
  it('passes the attempt handle number to work as its third argument', async () => {
    const h = harness();
    await h.send(h.body);
    expect(h.work).toHaveBeenCalledTimes(1);
    expect((h.work as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2]).toBe(h.map.get(ISSUE)?.attemptNo);
  });

});
