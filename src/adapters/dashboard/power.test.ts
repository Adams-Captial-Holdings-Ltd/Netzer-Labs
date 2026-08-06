/**
 * Power proxy router: auth gates, proxy behavior, audit trail. The Lambda on
 * the other side is stubbed via global fetch; the token comes from a stubbed
 * Secrets client. No AWS in the loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

function principalFor(raw: string): TokenPrincipal | null {
  const id = raw.replace(/^Bearer\s+/i, '');
  if (id === 'viewer' || id === 'operator' || id === 'admin') {
    return { tokenHash: `hash-${id}`, label: id, hashPrefix16: id, role: id };
  }
  return null;
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (authHeader?: string) =>
      (authHeader ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
  };
});

const getConfig = vi.fn();
vi.mock('../../lib/state/runtime-config-repo.js', () => ({
  getConfig: (...a: unknown[]) => getConfig(...a),
}));

const writeAuditOrThrow = vi.fn();
vi.mock('../../lib/audit/audit-writer.js', () => ({
  writeAudit: () => Promise.resolve(),
  writeAuditOrThrow: (...a: unknown[]) => writeAuditOrThrow(...a),
}));

vi.mock('../../observability/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { buildPowerRouter, __setSecretsClient } from './power.js';

const fetchMock = vi.fn();

function app(): Hono {
  const a = new Hono();
  a.route('/api/power', buildPowerRouter());
  return a;
}

function fakeSecrets(secretString: string): SecretsManagerClient {
  return {
    send: async () => ({ SecretString: secretString }),
  } as unknown as SecretsManagerClient;
}

beforeEach(() => {
  getConfig.mockReset().mockResolvedValue('https://power.example.lambda-url.us-east-1.on.aws');
  writeAuditOrThrow.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  __setSecretsClient(fakeSecrets(JSON.stringify({ token: 'tok-123' })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setSecretsClient(null);
});

function jsonResponse(code: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });
}

describe('/api/power', () => {
  it('401s without a token', async () => {
    const res = await app().request('/api/power/status');
    expect(res.status).toBe(401);
  });

  it('status reports configured:false when no url is wired', async () => {
    getConfig.mockResolvedValue(undefined);
    const res = await app().request('/api/power/status', {
      headers: { authorization: 'Bearer viewer' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('status proxies to the Lambda with the server-side token and adds panelUrl', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, phase: 'paused', running: 0 }));
    const res = await app().request('/api/power/status', {
      headers: { authorization: 'Bearer viewer' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      configured: true,
      phase: 'paused',
      panelUrl: 'https://power.example.lambda-url.us-east-1.on.aws',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://power.example.lambda-url.us-east-1.on.aws/status');
    expect((init.headers as Record<string, string>)['X-Power-Token']).toBe('tok-123');
  });

  it('status is cached briefly (one upstream call for two requests)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, phase: 'restored' }));
    const a = app();
    await a.request('/api/power/status', { headers: { authorization: 'Bearer viewer' } });
    await a.request('/api/power/status', { headers: { authorization: 'Bearer viewer' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pause is denied without security:write (viewer)', async () => {
    const res = await app().request('/api/power/pause', {
      method: 'POST',
      headers: { authorization: 'Bearer viewer', 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pause requires confirm:true', async () => {
    const res = await app().request('/api/power/pause', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('pause proxies, audits break-glass-proof, and returns the Lambda result', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, mode: 'paused' }));
    const res = await app().request('/api/power/pause', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: 'paused' });
    expect(writeAuditOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'power_pause', result: 'ok' }),
    );
  });

  it('pause surfaces an audit-write failure as a 500', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, mode: 'paused' }));
    writeAuditOrThrow.mockRejectedValue(new Error('audit store down'));
    const res = await app().request('/api/power/pause', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(500);
  });
});
