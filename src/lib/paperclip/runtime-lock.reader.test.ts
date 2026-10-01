import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../observability/logger.js';
import { readRuntimeLockVerdict, REQUIRED_HIDDEN_SETTINGS } from './runtime-lock.js';

const company = 'company-1';
const agentsPath = `/api/companies/${company}/agents`;
const routes = () => ({
  '/api/health': { body: { hiddenSettings: [...REQUIRED_HIDDEN_SETTINGS] } },
  '/api/instance/settings/experimental': { body: { enableNativeRunner: false } },
  [agentsPath]: { body: [{ id: 'a1', name: 'main', adapterType: 'http', runtimeConfig: {} }] },
  [`/api/companies/${company}/remote-agent-profiles`]: { body: [] },
  [`/api/companies/${company}/tools/applications`]: { body: { applications: [] } },
  [`/api/companies/${company}/tools/connections`]: { body: { connections: [] } },
});
type Route = { body?: unknown; status?: number; raw?: string };

async function read(overrides: Record<string, Route> = {}, auditorKey = 'reader-sentinel') {
  const table: Record<string, Route> = { ...routes(), ...overrides };
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const route = table[path];
    if (!route) throw new Error(`Missing route: ${path}`);
    return new Response(route.raw ?? JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return readRuntimeLockVerdict({ fetchFn, baseUrl: 'http://paperclip.test', companyId: company, auditorKey });
}

describe('runtime lock reader shape and failure handling', () => {
  it('does not treat object hidden-settings entries as a proven violation', async () => {
    expect(await read({ '/api/health': { body: { hiddenSettings: [{ key: 'instance.adapters' }, { key: 'instance.plugins' }] } } }))
      .toEqual({ verdict: 'unknown', reason: 'unexpected_shape' });
  });

  it.each([true, false])('proves absent hidden settings even when agents fail: %s', async (agentsFail) => {
    expect(await read({
      '/api/health': { body: { status: 'ok' } },
      ...(agentsFail ? { [agentsPath]: { status: 503, body: {} } } : {}),
    })).toMatchObject({ verdict: 'violated', violations: [{ code: 'settings_not_locked' }] });
  });

  it.each([
    { runtimeConfig: 'x' },
    { runtimeConfig: { heartbeat: 'on' } },
  ])('fails closed for a wrong runtime container: %j', async (agent) => {
    expect(await read({ [agentsPath]: { body: [{ id: 'a1', name: 'main', adapterType: 'http', ...agent }] } }))
      .toEqual({ verdict: 'unknown', reason: 'unexpected_shape' });
  });

  it.each([{ runtimeConfig: null }, { runtimeConfig: { heartbeat: null } }])
    ('treats a null runtime container as absent: %j', async (agent) => {
      expect(await read({ [agentsPath]: { body: [{ id: 'a1', name: 'main', adapterType: 'http', ...agent }] } }))
        .toEqual({ verdict: 'clean' });
    });

  it('keeps a proven non-http violation when another agent has a wrong runtime container', async () => {
    const body = [
      { id: 'a1', name: 'worker', adapterType: 'process', runtimeConfig: {} },
      { id: 'a2', name: 'main', adapterType: 'http', runtimeConfig: 'x' },
    ];
    expect(await read({ [agentsPath]: { body } })).toMatchObject({ verdict: 'violated', violations: [{ code: 'non_http_agent' }] });
  });

  it.each([
    ['/api/health', 401, 'paperclip_unreachable'],
    [agentsPath, 429, 'paperclip_unreachable'],
    [agentsPath, 408, 'paperclip_unreachable'],
    [agentsPath, 401, 'auditor_key_rejected'],
  ])('maps %s status %i to %s', async (path, status, reason) => {
    expect(await read({ [path]: { status, body: {} } })).toEqual({ verdict: 'unknown', reason });
  });

  it('logs a failed read path and status without the auditor key', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      await read({ [agentsPath]: { status: 503, body: {} } }, 'distinctive-reader-sentinel');
      expect(warn).toHaveBeenCalledWith({ path: agentsPath, status: 503 }, 'paperclip lock read failed');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('distinctive-reader-sentinel');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a safe cause for invalid JSON without response text', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      expect(await read({ [agentsPath]: { raw: '<html>broken</html>' } }))
        .toEqual({ verdict: 'unknown', reason: 'unexpected_shape' });
      expect(warn).toHaveBeenCalledWith({ path: agentsPath, status: 200, errMessage: 'invalid JSON' }, 'paperclip lock read failed');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('broken');
    } finally {
      warn.mockRestore();
    }
  });
});
