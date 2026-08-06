import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// Router-to-client CONTRACT test. Locks the response JSON KEY NAMES the
// dashboard reads off the integrations router so frontend/backend drift fails
// CI. The REAL buildIntegrationsRouter is driven via app.request() with the
// state + posture layers mocked, so no AWS / network is touched.

function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

vi.mock('../../lib/auth/dashboard-auth.js', () => ({
  extractBearerToken: (authHeader?: string) => (authHeader ?? '').replace(/^Bearer\s+/i, ''),
  authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
}));

// GET / inventory source.
const getIntegrationsInventory = vi.fn();
vi.mock('../../lib/state/integrations-inventory.js', () => ({
  getIntegrationsInventory: () => getIntegrationsInventory(),
}));

// GET /secrets-posture source. The router filters to id.startsWith('secret-')
// and maps each card via cardToSecretPosture.
const getSecurityPosture = vi.fn();
vi.mock('../../lib/security/posture-repo.js', () => ({
  getSecurityPosture: () => getSecurityPosture(),
}));

import { buildIntegrationsRouter } from './integrations.js';

// res.json() is typed as Promise<unknown>; read it as a loose record so the
// assertion matchers accept it and we can index nested keys
// (entries[0].health, secrets[0]) freely without per-field casts.
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const readJson = async (res: Response): Promise<Rec> => (await res.json()) as Rec;

function makeApp() {
  const app = new Hono();
  app.route('/api/integrations', buildIntegrationsRouter());
  return app;
}

function req(path: string, role: string | undefined) {
  const headers: Record<string, string> = {};
  if (role) headers.Authorization = `Bearer ${role}`;
  // Mounted at /api/integrations with the router's index route at '/', so the
  // inventory endpoint is exactly /api/integrations (no trailing slash).
  const url = path === '/' ? '/api/integrations' : `/api/integrations${path}`;
  return makeApp().request(url, { method: 'GET', headers });
}

beforeEach(() => {
  getIntegrationsInventory.mockReset();
  getSecurityPosture.mockReset();
});

describe('integrations router contract', () => {
  it('GET / returns { generatedAt, entries } with the per-surface entry shape', async () => {
    getIntegrationsInventory.mockResolvedValue({
      generatedAt: '2026-05-30T00:00:00.000Z',
      entries: [
        {
          surface: 'telegram',
          agentId: 'main',
          verificationMode: true,
          softBypassRisk: false,
          health: { status: 'ok', detail: 'webhook healthy' },
        },
      ],
    });

    const res = await req('/', 'operator');
    expect(res.status).toBe(200);
    const json = await readJson(res);

    // Lock the top-level key the dashboard reads.
    expect(Object.keys(json).sort()).toEqual(['entries', 'generatedAt']);
    expect(Array.isArray(json.entries)).toBe(true);

    // Lock the entry keys (surface/agentId/verificationMode/softBypassRisk/health).
    expect(Object.keys(json.entries[0]).sort()).toEqual([
      'agentId',
      'health',
      'softBypassRisk',
      'surface',
      'verificationMode',
    ]);
    expect(Object.keys(json.entries[0].health).sort()).toEqual(['detail', 'status']);
    expect(json.entries[0].surface).toBe('telegram');
  });

  it('GET / fails soft to { generatedAt, entries: [] } when the inventory read throws', async () => {
    getIntegrationsInventory.mockRejectedValue(new Error('scan denied'));
    const res = await req('/', 'operator');
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(Object.keys(json).sort()).toEqual(['entries', 'generatedAt']);
    expect(json.entries).toEqual([]);
  });

  it('GET /secrets-posture returns { generatedAt, secrets } with the metadata-only secret shape', async () => {
    getSecurityPosture.mockResolvedValue([
      {
        id: 'secret-telegram-token',
        label: 'Telegram bot token',
        status: 'ok',
        detail: 'rotation schedule on, last rotated 2026-01-15',
      },
      // Non-secret card must be filtered out by the id prefix.
      { id: 'iam-root-mfa', label: 'Root MFA', status: 'ok', detail: 'enabled' },
    ]);

    const res = await req('/secrets-posture', 'operator');
    expect(res.status).toBe(200);
    const json = await readJson(res);

    expect(Object.keys(json).sort()).toEqual(['generatedAt', 'secrets']);
    expect(json.secrets).toHaveLength(1); // iam card filtered out

    // Lock the per-secret key set the dashboard renders.
    expect(Object.keys(json.secrets[0]).sort()).toEqual([
      'detail',
      'hasRotationSchedule',
      'id',
      'lastRotated',
      'name',
      'status',
    ]);
    expect(json.secrets[0]).toMatchObject({
      id: 'secret-telegram-token',
      name: 'Telegram bot token',
      lastRotated: '2026-01-15',
      hasRotationSchedule: true,
      status: 'ok',
    });
  });

  it('GET /secrets-posture fails soft to { secrets: [] } when posture read throws', async () => {
    getSecurityPosture.mockRejectedValue(new Error('posture down'));
    const res = await req('/secrets-posture', 'operator');
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(Object.keys(json).sort()).toEqual(['generatedAt', 'secrets']);
    expect(json.secrets).toEqual([]);
  });

  it('enforces operator+ on both reads', async () => {
    getIntegrationsInventory.mockResolvedValue({ generatedAt: 'x', entries: [] });
    getSecurityPosture.mockResolvedValue([]);

    expect((await req('/', undefined)).status).toBe(401); // no token
    expect((await req('/', 'viewer')).status).toBe(403); // below operator
    expect((await req('/secrets-posture', 'viewer')).status).toBe(403);
  });
});
