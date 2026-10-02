import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPaperclipLockForTest, enforceStartupLock } from '../../lib/paperclip/runtime-lock.js';

const { killSwitch, knownAgents, enabledAgents, claim, work } = vi.hoisted(() => ({
  killSwitch: vi.fn(async () => ({ active: false })),
  knownAgents: vi.fn(() => ['main']),
  enabledAgents: vi.fn(async () => ['main']),
  claim: vi.fn(async () => true),
  work: vi.fn(async () => {}),
}));
vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => ({
  ...await importActual<typeof import('../../lib/state/kill-switches-repo.js')>(),
  isKillSwitchActive: killSwitch,
}));
vi.mock('../../lib/config/agent-loader.js', async (importActual) => ({
  ...await importActual<typeof import('../../lib/config/agent-loader.js')>(),
  listKnownAgents: knownAgents,
}));
vi.mock('../../lib/state/runtime-config-repo.js', async (importActual) => ({
  ...await importActual<typeof import('../../lib/state/runtime-config-repo.js')>(),
  getConfigCategory: vi.fn(async () => ({ enabled_agents: 'main' })),
}));
vi.mock('../../lib/state/runner-lease.js', () => ({ tryClaimOnce: claim, releaseClaimOnce: vi.fn() }));
vi.mock('../../lib/paperclip/dispatch-worker.js', async (importActual) => ({
  ...await importActual<typeof import('../../lib/paperclip/dispatch-worker.js')>(),
  runDispatchWork: work,
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
  vi.stubEnv('PAPERCLIP_RECONCILER_KEY', 'test-other-bearer-value');
  killSwitch.mockResolvedValue({ active: false });
  knownAgents.mockReturnValue(['main']);
  enabledAgents.mockResolvedValue(['main']);
  claim.mockResolvedValue(true);
  __resetPaperclipLockForTest();
});
afterEach(() => { __resetPaperclipLockForTest(); vi.unstubAllEnvs(); });

describe('private dispatch defaults', () => {
  it('uses the default secret, repositories and kill switch', async () => {
    expect((await post(token)).status).toBe(202);
    expect((await post('test-other-bearer-value')).status).toBe(401);
    killSwitch.mockResolvedValue({ active: true, reason: 'test-disabled' } as never);
    const switched = await post(token);
    expect(switched.status).toBe(503);
    expect(await switched.json()).toEqual({ error: 'paperclip_disabled', reason: 'test-disabled' });
    killSwitch.mockResolvedValue({ active: false });
    const unknown = await post(token, JSON.stringify({ netzarAgentId: 'missing', issueId: 'a1b2c3d4-0000-4000-8000-000000000001', runId: '11111111-2222-4333-8444-555555555555' }));
    expect(unknown.status).toBe(404);
  });

  it('checks auth, then lock, before kill switch and body validation', async () => {
    killSwitch.mockResolvedValue({ active: true, reason: 'test-disabled' } as never);
    await enforceStartupLock({ read: async () => ({ verdict: 'unknown', reason: 'paperclip_unreachable' }), attempts: 1 });
    const locked = await post(token);
    expect(locked.status).toBe(503);
    expect(await locked.json()).toMatchObject({ error: 'paperclip_locked' });
    const invalid = await post(token, '{}');
    expect(invalid.status).toBe(503);
    expect((await post('test-other-bearer-value')).status).toBe(401);
  });
});
