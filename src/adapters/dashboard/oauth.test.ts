import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// Contract test for the OAuth router: auth boundaries (start=admin,
// status=operator+, callback=public), state validation on the callback, and
// redaction of the status read. External providers and DDB are mocked.

function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (h?: string) => (h ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
  };
});
vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive: () => Promise.resolve({ active: false }) };
});
vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  truncateForLog: (s: string) => s,
}));

const { configStore, consumeStateMock, connectSlackMock, writeAuditMock } = vi.hoisted(() => ({
  configStore: new Map<string, string>(),
  consumeStateMock: vi.fn(),
  connectSlackMock: vi.fn(),
  writeAuditMock: vi.fn(),
}));

vi.mock('../../lib/state/runtime-config-repo.js', () => ({
  getConfig: async (cat: string, key: string) => configStore.get(`${cat}/${key}`),
  setConfig: async (cat: string, key: string, value: string) => {
    configStore.set(`${cat}/${key}`, value);
  },
  deleteConfig: async (cat: string, key: string) => {
    configStore.delete(`${cat}/${key}`);
  },
}));
vi.mock('../../lib/oauth/state-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/oauth/state-repo.js')>();
  return { ...actual, consumeOAuthState: consumeStateMock };
});
vi.mock('../../lib/agents/agent-manager.js', () => ({
  connectSlack: connectSlackMock,
}));
vi.mock('../../lib/mcp/servers-repo.js', () => ({
  listMcpServers: vi.fn().mockResolvedValue([]),
  saveMcpServers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../lib/audit/audit-writer.js', () => ({
  writeAudit: writeAuditMock,
}));
vi.mock('../../lib/config/agent-loader.js', () => ({
  listKnownAgents: () => ['main', 'ops'],
}));

import { buildOAuthRouter } from './oauth.js';

function app() {
  const a = new Hono();
  a.route('/api/oauth', buildOAuthRouter());
  return a;
}

function req(path: string, init: RequestInit & { role?: string } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.role) headers.Authorization = `Bearer ${init.role}`;
  if (init.body) headers['content-type'] = 'application/json';
  return app().request(`/api/oauth${path}`, { ...init, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  configStore.clear();
  process.env.CCE_DASHBOARD_URL = 'https://cce.example.com';
});

describe('oauth router auth boundaries', () => {
  it('start requires admin', async () => {
    expect((await req('/slack/start', { method: 'POST', role: 'operator', body: '{"mode":"mcp"}' })).status).toBe(403);
    expect((await req('/slack/start', { method: 'POST', body: '{"mode":"mcp"}' })).status).toBe(401);
  });

  it('status requires operator+', async () => {
    expect((await req('/status', { role: 'viewer' })).status).toBe(403);
    expect((await req('/status', { role: 'operator' })).status).toBe(200);
  });

  it('credentials write requires admin and never echoes values', async () => {
    const res = await req('/salesforce/credentials', {
      method: 'PUT',
      role: 'admin',
      body: JSON.stringify({ clientId: 'cid', clientSecret: 'SECRET' }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('SECRET');
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'oauth_credentials_set' }),
    );
    const auditDetail = writeAuditMock.mock.calls[0][0].detail;
    expect(JSON.stringify(auditDetail)).not.toContain('SECRET');
  });
});

describe('start flow', () => {
  it('409s with the precise missing key when creds are absent', async () => {
    const res = await req('/salesforce/start', { method: 'POST', role: 'admin', body: '{}' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'credentials_needed',
      missing: ['oauth/salesforce_client_id'],
    });
  });

  it('returns an authorize url once creds exist', async () => {
    configStore.set('oauth/salesforce_client_id', 'cid');
    configStore.set('oauth/salesforce_client_secret', 'cs');
    const res = await req('/salesforce/start', { method: 'POST', role: 'admin', body: '{}' });
    expect(res.status).toBe(200);
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    expect(authorizeUrl).toContain('login.salesforce.com/services/oauth2/authorize');
  });
});

describe('callback', () => {
  it('is public and redirects with reason=state on a bad state', async () => {
    consumeStateMock.mockResolvedValue(null);
    const res = await req('/callback?code=abc&state=bad');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('oauth=error');
    expect(res.headers.get('location')).toContain('reason=state');
    expect(connectSlackMock).not.toHaveBeenCalled();
  });

  it('redirects with provider_denied when the provider sends error=', async () => {
    const res = await req('/callback?error=access_denied');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('reason=provider_denied');
  });

  it('never echoes the code or token material into the redirect', async () => {
    consumeStateMock.mockResolvedValue(null);
    const res = await req('/callback?code=supersecretcode&state=x'.padEnd(80, 'x'));
    expect(res.headers.get('location')).not.toContain('supersecretcode');
  });
});
