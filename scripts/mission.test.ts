import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerMissionRoutes } from '../src/adapters/dashboard/missions.js';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('./lib/api-client.js', () => ({ apiGet, apiPost: vi.fn() }));
vi.mock('./lib/ansi.js', () => ({
  bold: (value: string) => value,
  dim: (value: string) => value,
  green: (value: string) => value,
  red: (value: string) => value,
  yellow: (value: string) => value,
  section: vi.fn(),
}));

import { listMissions, showMission } from './mission.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('mission CLI routes', () => {
  it('list sends the owner query the real route reads and prints the real wire fields', async () => {
    apiGet.mockResolvedValue({
      missions: [{
        id: 'mission-1',
        ownerAgent: 'research',
        title: 'Verify rollout',
        status: 'in_review',
        priority: 'high',
      }],
    });

    await listMissions({ agent: 'research' });

    expect(apiGet).toHaveBeenCalledWith('/api/missions?owner=research');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('research'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('high'));
  });

  it('show resolves through agent inventory and owner-scoped lists, never an imaginary detail route', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/agents') return Promise.resolve({ agents: [{ id: 'main' }, { id: 'research' }] });
      if (path === '/api/missions?owner=main') return Promise.resolve({ missions: [] });
      if (path === '/api/missions?owner=research') {
        return Promise.resolve({
          missions: [{
            id: 'abc12345-1111-4111-8111-111111111111',
            ownerAgent: 'research',
            title: 'Verify rollout',
            status: 'in_review',
            priority: 'high',
          }],
        });
      }
      throw new Error(`unexpected path ${path}`);
    });

    await showMission('abc12345-1111-4111-8111-111111111111');

    expect(apiGet.mock.calls.map(([path]) => path)).toEqual([
      '/api/agents',
      '/api/missions?owner=main',
      '/api/missions?owner=research',
    ]);
    expect(apiGet.mock.calls.flat()).not.toContain(
      '/api/missions/abc12345-1111-4111-8111-111111111111',
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Verify rollout'));
  });

  it('resolves a unique mission-id prefix', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/agents') return Promise.resolve({ agents: [{ id: 'research' }] });
      if (path === '/api/missions?owner=research') {
        return Promise.resolve({
          missions: [{
            id: 'abc12345-1111-4111-8111-111111111111',
            ownerAgent: 'research',
            title: 'Unique prefix',
            status: 'in_review',
            priority: 'high',
          }],
        });
      }
      throw new Error(`unexpected path ${path}`);
    });

    await showMission('abc12345');

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Unique prefix'));
  });

  it('refuses an ambiguous mission-id prefix', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/agents') return Promise.resolve({ agents: [{ id: 'research' }] });
      if (path === '/api/missions?owner=research') {
        return Promise.resolve({
          missions: [
            { id: 'abc12345-one', ownerAgent: 'research', title: 'One', status: 'open', priority: 'medium' },
            { id: 'abc12345-two', ownerAgent: 'research', title: 'Two', status: 'blocked', priority: 'critical' },
          ],
        });
      }
      throw new Error(`unexpected path ${path}`);
    });

    await expect(showMission('abc12345')).rejects.toThrow(
      "Mission id 'abc12345' is ambiguous; pass a full mission id.",
    );
  });

  it('scans fleets serially, keeping owner-list max in-flight at one', async () => {
    const agents = Array.from({ length: 12 }, (_, index) => ({ id: `agent-${index}` }));
    let inFlight = 0;
    let maxInFlight = 0;
    apiGet.mockImplementation(async (path: string) => {
      if (path === '/api/agents') return { agents };
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return {
        missions: path.endsWith('agent-11')
          ? [{
              id: 'target-mission', ownerAgent: 'agent-11', title: 'Target',
              status: 'open', priority: 'medium',
            }]
          : [],
      };
    });

    await showMission('target-mission');

    expect(maxInFlight).toBe(1);
    expect(apiGet).toHaveBeenCalledTimes(13);
  });

  it('works through the real api-client fetch path and the mounted Hono mission router', async () => {
    const target = {
      id: 'router-probe-mission',
      ownerAgent: 'research',
      createdByAgent: 'dashboard',
      createdByChat: 'dashboard:test',
      title: 'Router probe',
      body: 'Drive the real route.',
      status: 'in_review' as const,
      priority: 'high' as const,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    const api = new Hono();
    api.get('/agents', (c) => c.json({ agents: [{ id: 'main' }, { id: 'research' }] }));
    let inFlight = 0;
    let maxInFlight = 0;
    registerMissionRoutes(api as never, {
      hasCapability: () => Promise.resolve(true),
      identity: () => 'dashboard:test',
      killSwitch: () => Promise.resolve({ active: false }),
      knownAgents: () => ['main', 'research'],
      list: async (owner) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return owner === 'research' ? [target] : [];
      },
    });
    const app = new Hono();
    app.route('/api', api);

    const originalFetch = globalThis.fetch;
    const originalBase = process.env.CCE_API_BASE_URL;
    const originalToken = process.env.CCE_DASHBOARD_TOKEN;
    process.env.CCE_API_BASE_URL = 'http://mission-cli.test';
    process.env.CCE_DASHBOARD_TOKEN = 'probe-token';
    globalThis.fetch = vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      app.fetch(new Request(String(input), init))) as typeof fetch;
    vi.resetModules();
    vi.doUnmock('./lib/api-client.js');

    try {
      const actualCli = await import('./mission.js');
      await actualCli.showMission(target.id);
      const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([input]) =>
        new URL(String(input)));
      expect(urls.map((url) => `${url.pathname}${url.search}`)).toEqual([
        '/api/agents',
        '/api/missions?owner=main',
        '/api/missions?owner=research',
      ]);
      expect(urls.every((url) => !/^\/api\/missions\/[^?]/.test(url.pathname))).toBe(true);
      expect(maxInFlight).toBe(1);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Router probe'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"ownerAgent": "research"'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"status": "in_review"'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"priority": "high"'));
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBase === undefined) delete process.env.CCE_API_BASE_URL;
      else process.env.CCE_API_BASE_URL = originalBase;
      if (originalToken === undefined) delete process.env.CCE_DASHBOARD_TOKEN;
      else process.env.CCE_DASHBOARD_TOKEN = originalToken;
    }
  });
});
