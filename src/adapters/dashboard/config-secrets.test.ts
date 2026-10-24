import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

/**
 * NZR-43 frozen tests: the generic runtime-config routes (/api/config*) refuse
 * secret and unknown categories for every principal, gate sensitive categories
 * on a capability, mask secret-shaped values on every way out, and audit each
 * refusal. Drives the real dashboard router (pattern: config-cost-guard.test.ts).
 * All secret-looking values here are fake fixtures.
 */

const { setConfig, getConfig, getConfigCategory, authenticateDashboardToken, writeAudit, logWarn } =
  vi.hoisted(() => ({
    setConfig: vi.fn(async (..._args: unknown[]) => {}),
    getConfig: vi.fn(async (_cat: string, _key: string): Promise<string | undefined> => undefined),
    getConfigCategory: vi.fn(async (_cat: string): Promise<Record<string, string>> => ({})),
    authenticateDashboardToken: vi.fn(),
    writeAudit: vi.fn(async (_e: unknown) => {}),
    logWarn: vi.fn(),
  }));

type Tier = 'seat-user' | 'viewer' | 'operator' | 'admin' | 'owner';
const ALL_TIERS: Tier[] = ['seat-user', 'viewer', 'operator', 'admin', 'owner'];

function principalFor(raw: string): TokenPrincipal | null {
  const id = raw.replace(/^Bearer\s+/i, '');
  if (id === 'viewer' || id === 'operator' || id === 'admin') {
    return { tokenHash: `hash-${id}`, label: id, hashPrefix16: id, role: id };
  }
  if (id === 'seat-user') {
    return { tokenHash: 'hash-seat', label: 'seat', hashPrefix16: 'seat', role: 'viewer', profileId: 'seat-user' };
  }
  if (id === 'owner') {
    return { tokenHash: 'hash-owner', label: 'Root token', hashPrefix16: 'owner', role: 'admin', profileId: 'owner' };
  }
  return null;
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => authenticateDashboardToken(raw),
  };
});

vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive: () => Promise.resolve({ active: false }) };
});

vi.mock('../../lib/state/runtime-config-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/runtime-config-repo.js')>();
  return { ...actual, setConfig, getConfig, getConfigCategory };
});

vi.mock('../../lib/audit/audit-writer.js', () => ({ writeAudit }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: logWarn, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

import { buildDashboardRouter } from './handler.js';

function req(path: string, tier: Tier, method = 'GET', body?: unknown): Promise<Response> {
  const app = new Hono();
  app.route('/api', buildDashboardRouter());
  const headers: Record<string, string> = { Authorization: `Bearer ${tier}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(path, init));
}

/** A fake runtime-config table: category -> key -> value. */
let store: Record<string, Record<string, string>> = {};

beforeEach(() => {
  store = {};
  setConfig.mockReset().mockResolvedValue(undefined);
  getConfig.mockReset().mockImplementation(async (cat: string, key: string) => store[cat]?.[key]);
  getConfigCategory.mockReset().mockImplementation(async (cat: string) => ({ ...(store[cat] ?? {}) }));
  authenticateDashboardToken.mockReset().mockImplementation(async (raw: string) => principalFor(raw));
  writeAudit.mockReset().mockResolvedValue(undefined);
  logWarn.mockReset();
});

async function expectForbiddenCategory(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'forbidden_category' });
}

function expectNoStoreCall(): void {
  expect(getConfig).not.toHaveBeenCalled();
  expect(getConfigCategory).not.toHaveBeenCalled();
  expect(setConfig).not.toHaveBeenCalled();
}

function seedSecrets(): void {
  store.oauth = {
    slack_app_ops: '{"clientId":"cid","clientSecret":"fake-client-secret-0001","signingSecret":"fake-signing-secret-0002"}',
    slack_client_secret: 'fake-slack-client-secret-0003',
  };
  store.mcp = { servers: '[{"id":"slack","bearerToken":"fake-bearer-token-0004"}]' };
  store.oauth_state = { abc: '{"codeVerifier":"fake-code-verifier-0005"}' };
}

describe('NZR-43 /api/config secret categories', () => {
  it('F43-1 GET /config/oauth refuses every tier, owner included', async () => {
    seedSecrets();
    for (const tier of ALL_TIERS) {
      await expectForbiddenCategory(await req('/api/config/oauth', tier));
    }
    expectNoStoreCall();
  });

  it('F43-2 GET /config/:category/:key refuses oauth, oauth_state and mcp keys', async () => {
    seedSecrets();
    for (const tier of ALL_TIERS) {
      for (const path of ['/api/config/oauth/slack_app_ops', '/api/config/oauth_state/abc', '/api/config/mcp/servers']) {
        await expectForbiddenCategory(await req(path, tier));
      }
    }
    expectNoStoreCall();
  });

  it('F43-3 GET /config?category=oauth is refused like the path form', async () => {
    seedSecrets();
    for (const tier of ALL_TIERS) {
      for (const cat of ['oauth', 'oauth_state', 'mcp']) {
        await expectForbiddenCategory(await req(`/api/config?category=${cat}`, tier));
      }
    }
    expectNoStoreCall();
  });

  it('F43-4 refuses a category that is not on the allowlist, in any spelling', async () => {
    seedSecrets();
    for (const path of [
      '/api/config/no_such_category',
      '/api/config/OAUTH',
      '/api/config/oau%74h',
      '/api/config/oau%74h/x',
      '/api/config/constructor',
      '/api/config/__proto__/x',
      '/api/config?category=no_such_category',
    ]) {
      await expectForbiddenCategory(await req(path, 'admin'));
    }
    await expectForbiddenCategory(await req('/api/config/no_such_category/k', 'admin', 'POST', { value: 'x' }));
    expectNoStoreCall();
  });

  it('F43-5 masks a secret-shaped key inside an allowed category', async () => {
    store.paperclip = { base_url: 'https://pc.internal', api_key: 'sk-live-1234567890abcd' };
    store.media = { servers_json: '{"items":[{"id":"a","bearerToken":"tok-abcdefgh1234wxyz"}]}' };

    const cat = await req('/api/config/paperclip', 'admin');
    expect(cat.status).toBe(200);
    expect(await cat.json()).toEqual({
      category: 'paperclip',
      values: { base_url: 'https://pc.internal', api_key: '****abcd' },
    });

    const viaQuery = await req('/api/config?category=paperclip', 'admin');
    expect(((await viaQuery.json()) as { values: Record<string, string> }).values.api_key).toBe('****abcd');

    const one = await req('/api/config/paperclip/api_key', 'admin');
    expect(await one.json()).toEqual({ category: 'paperclip', key: 'api_key', value: '****abcd' });

    const nested = await req('/api/config/media/servers_json', 'admin');
    const body = (await nested.json()) as { value: string };
    expect(JSON.parse(body.value)).toEqual({ items: [{ id: 'a', bearerToken: '****wxyz' }] });
    expect(body.value).not.toContain('abcdefgh1234');
  });

  it('F43-6 serves the categories the SPA reads unchanged to a viewer and a seat-user', async () => {
    const library = '[{"id":"dawn","name":"Dawn","tokens":{"bg":"#fff"}}, {"id":"dusk"}]';
    store.profile = { first_name: 'Ada' };
    store.cost = { report_async_enabled: 'true', watch_enabled: 'false', daily_cap_usd: '50' };
    store.themes = { library, active: 'dawn' };
    store.branding = { company_name: 'Acme' };
    store.memory = { ingest_every_n_turns: '5' };
    store.sessions = { idle_timeout_min: '30' };
    store.rate_limits = { per_minute: '20' };

    for (const tier of ['viewer', 'seat-user'] as const) {
      expect(await (await req('/api/config/profile/first_name', tier)).json()).toEqual({
        category: 'profile', key: 'first_name', value: 'Ada',
      });
      expect(await (await req('/api/config/cost/report_async_enabled', tier)).json()).toEqual({
        category: 'cost', key: 'report_async_enabled', value: 'true',
      });
      const themes = (await (await req('/api/config/themes', tier)).json()) as { values: Record<string, string> };
      expect(themes).toEqual({ category: 'themes', values: { library, active: 'dawn' } });
      expect(themes.values.library).toBe(library);
      expect(await (await req('/api/config/branding', tier)).json()).toEqual({
        category: 'branding', values: { company_name: 'Acme' },
      });
      expect(await (await req('/api/config/memory/ingest_every_n_turns', tier)).json()).toEqual({
        category: 'memory', key: 'ingest_every_n_turns', value: '5',
      });
      const all = await req('/api/config', tier);
      expect(all.status).toBe(200);
      expect(await all.json()).toEqual({
        categories: { cost: store.cost, sessions: store.sessions, rate_limits: store.rate_limits },
      });
    }
  });

  it('F43-7 audits each refusal as config_access_denied with names only', async () => {
    seedSecrets();
    const res = await req('/api/config/oauth/slack_app_ops', 'viewer');
    await expectForbiddenCategory(res);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith({
      action: 'config_access_denied',
      surface: 'dashboard',
      result: 'blocked',
      userId: 'dashboard:hash-viewer',
      detail: {
        category: 'oauth',
        key: 'slack_app_ops',
        method: 'GET',
        reason: 'secret_category',
        event: 'security.config_denied',
      },
    });

    writeAudit.mockClear();
    await expectForbiddenCategory(await req('/api/config/no_such_category', 'admin'));
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const unknown = writeAudit.mock.calls[0]![0] as { action: string; detail: Record<string, unknown> };
    expect(unknown.action).toBe('config_access_denied');
    expect(unknown.detail.category).toBe('no_such_category');
    expect(unknown.detail.reason).toBe('unknown_category');
    expect(unknown.detail).not.toHaveProperty('key');

    writeAudit.mockClear();
    await expectForbiddenCategory(await req('/api/config/oauth/slack_client_secret', 'owner', 'POST', { value: 'x' }));
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const posted = writeAudit.mock.calls[0]![0] as { detail: Record<string, unknown> };
    expect(posted.detail).toMatchObject({ category: 'oauth', key: 'slack_client_secret', method: 'POST' });
    expect(posted.detail).not.toHaveProperty('value');
    expect(JSON.stringify(posted)).not.toContain('fake-slack-client-secret');
  });

  it('F43-7b a failing audit write or store never turns a refusal into a 200', async () => {
    // Store down: the real repo fails open to {} (runtime-config-repo.ts:121-127).
    getConfigCategory.mockImplementation(async () => ({}));
    // Audit down: the write never settles; the refusal must not wait on it.
    writeAudit.mockImplementation(() => new Promise<void>(() => {}));
    await expectForbiddenCategory(await req('/api/config/oauth', 'viewer'));
    const profile = await req('/api/config/profile', 'viewer');
    expect(profile.status).toBe(200);
    expect(await profile.json()).toEqual({ category: 'profile', values: {} });
  });

  it('F43-8 POST /config/oauth/* is refused even for the owner and never writes', async () => {
    seedSecrets();
    for (const tier of ['admin', 'owner'] as const) {
      for (const path of ['/api/config/oauth/slack_client_secret', '/api/config/mcp/servers', '/api/config/oauth_state/abc']) {
        await expectForbiddenCategory(await req(path, tier, 'POST', { value: 'x' }));
      }
    }
    // Lower roles still meet the legacy admin gate first (seat-user has role viewer).
    for (const tier of ['seat-user', 'viewer', 'operator'] as const) {
      const res = await req('/api/config/oauth/slack_client_secret', tier, 'POST', { value: 'x' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'forbidden',
        requiredRole: 'admin',
        yourRole: tier === 'operator' ? 'operator' : 'viewer',
      });
    }
    expectNoStoreCall();
    expect(writeAudit.mock.calls.some(([e]) => (e as { action: string }).action === 'config_updated')).toBe(false);
  });

  it('F43-9 config_updated audit, log line and echo never carry a secret-shaped value', async () => {
    store.paperclip = { api_key: 'sk-live-1234567890abcd' };
    const res = await req('/api/config/paperclip/api_key', 'admin', 'POST', { value: 'sk-new-9999999999zzzz' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, category: 'paperclip', key: 'api_key', value: '****zzzz' });
    expect(setConfig).toHaveBeenCalledWith('paperclip', 'api_key', 'sk-new-9999999999zzzz', expect.anything());

    const updated = writeAudit.mock.calls.map(([e]) => e as { action: string; detail: Record<string, unknown> })
      .find((e) => e.action === 'config_updated');
    expect(updated?.detail).toMatchObject({ category: 'paperclip', key: 'api_key', oldValue: '****abcd', newValue: '****zzzz' });

    const logged = JSON.stringify(logWarn.mock.calls);
    expect(logged).toContain('runtime config set');
    expect(logged).not.toContain('sk-new-9999999999zzzz');
    expect(logged).not.toContain('sk-live-1234567890abcd');
    expect(JSON.stringify(writeAudit.mock.calls)).not.toContain('9999999999');
  });

  it('F43-11 a secret pasted into reason is masked in the log line and the config_updated row', async () => {
    store.paperclip = { api_key: 'sk-live-1234567890abcd' };
    const res = await req('/api/config/paperclip/api_key', 'admin', 'POST', {
      value: 'sk-new-9999999999zzzz',
      reason: 'swap sk-live-1234567890abcd for sk-new-9999999999zzzz, pasted fake-pasted-0000111122223333',
    });
    expect(res.status).toBe(200);
    const updated = writeAudit.mock.calls.map(([e]) => e as { action: string; detail: Record<string, unknown> })
      .find((e) => e.action === 'config_updated');
    expect(updated?.detail.reason).toBe('swap ****abcd for ****zzzz, pasted ****3333');
    const out = JSON.stringify([logWarn.mock.calls, writeAudit.mock.calls]);
    for (const leak of ['1234567890', '9999999999', '0000111122223333']) expect(out).not.toContain(leak);
    expect(JSON.stringify(logWarn.mock.calls)).toContain('swap ****abcd for ****zzzz');
  });

  it('F43-10 security-tier and integrations-tier categories refuse lower tiers', async () => {
    store.power = { url: 'https://power.example.invalid' };
    store.alerting = { recipients: 'ops@example.invalid' };
    store.jarvis = { routine_1: '{"name":"morning"}' };
    store.paperclip = { enabled_agents: 'main' };

    const cases: Array<{ path: string; allowed: Tier[] }> = [
      { path: '/api/config/power/url', allowed: ['admin'] },
      { path: '/api/config/alerting', allowed: ['admin'] },
      { path: '/api/config/jarvis/routine_1', allowed: ['admin'] },
      { path: '/api/config?category=power', allowed: ['admin'] },
      { path: '/api/config/paperclip/enabled_agents', allowed: ['operator', 'admin'] },
    ];
    for (const { path, allowed } of cases) {
      for (const tier of ['viewer', 'operator', 'admin'] as const) {
        const res = await req(path, tier);
        if (allowed.includes(tier)) expect(res.status).toBe(200);
        else await expectForbiddenCategory(res);
      }
    }
    // The capability check runs before the store: no read on any refusal.
    getConfig.mockClear();
    getConfigCategory.mockClear();
    await expectForbiddenCategory(await req('/api/config/power', 'operator'));
    expectNoStoreCall();
  });
});
