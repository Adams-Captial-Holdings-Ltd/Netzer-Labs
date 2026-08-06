import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// Router-to-client CONTRACT test for the compliance router. The REAL router +
// REAL control catalog are driven via app.request(); only the auth layer, the
// AWS evidence collector, and the Bedrock analyst are mocked, so no network is
// touched. Locks: the compliance:read gate, the summary shape the dashboard
// reads, fail-soft behaviour, and /analyze input validation.

function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

vi.mock('../../lib/auth/dashboard-auth.js', () => ({
  extractBearerToken: (authHeader?: string) => (authHeader ?? '').replace(/^Bearer\s+/i, ''),
  authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
}));

vi.mock('../../lib/auth/route-capability.js', () => ({
  // compliance:read is operator-tier: operator/admin hold it, viewer does not.
  // The router gates on principalHasRouteCapability (custom-profile aware); here
  // we drive auth by role so the suite stays role-based.
  principalHasRouteCapability: (p: TokenPrincipal, required: string) =>
    Promise.resolve(required === 'compliance:read' && (p.role === 'operator' || p.role === 'admin')),
}));

const collectComplianceEvidence = vi.fn();
vi.mock('../../lib/compliance/evidence.js', () => ({
  collectComplianceEvidence: () => collectComplianceEvidence(),
}));

const analyzeControl = vi.fn();
vi.mock('../../lib/compliance/analyst.js', () => ({
  analyzeControl: (...args: unknown[]) => analyzeControl(...args),
}));

import { buildComplianceRouter } from './compliance.js';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const readJson = async (res: Response): Promise<Rec> => (await res.json()) as Rec;

function makeApp() {
  const app = new Hono();
  app.route('/api/compliance', buildComplianceRouter());
  return app;
}

function get(path: string, role: string | undefined) {
  const headers: Record<string, string> = {};
  if (role) headers.Authorization = `Bearer ${role}`;
  return makeApp().request(`/api/compliance${path}`, { method: 'GET', headers });
}

function post(path: string, role: string | undefined, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (role) headers.Authorization = `Bearer ${role}`;
  return makeApp().request(`/api/compliance${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  collectComplianceEvidence.mockReset();
  analyzeControl.mockReset();
});

describe('compliance router contract', () => {
  it('GET /summary returns soc2 + hipaa frameworks scored from live evidence', async () => {
    collectComplianceEvidence.mockResolvedValue([
      { id: 'kms', label: 'KMS', status: 'ok', detail: 'rotating', area: 'encryption', tags: ['encryption-at-rest', 'key-rotation'] },
    ]);

    const res = await get('/summary', 'operator');
    expect(res.status).toBe(200);
    const json = await readJson(res);

    expect(Object.keys(json).sort()).toEqual(['disclaimer', 'evidenceCount', 'frameworks', 'generatedAt', 'scan']);
    expect(json.frameworks.map((f: Rec) => f.id)).toEqual(['soc2', 'hipaa']);
    // Per-domain scan tally drives the scanning visual.
    expect(json.scan.areas.find((a: Rec) => a.id === 'encryption')).toMatchObject({ total: 1, ok: 1 });
    // The encryption control should now read 'met' off the ok evidence.
    const enc = json.frameworks[0].controls.find((c: Rec) => c.id === 'soc2-cc6.1-encryption');
    expect(enc.status).toBe('met');
    // Framework row shape the dashboard reads.
    expect(Object.keys(json.frameworks[0]).sort()).toEqual([
      'controls',
      'counts',
      'description',
      'gradedCount',
      'id',
      'label',
      'score',
    ]);
  });

  it('GET /summary fails soft (evidence-less, all-unknown) when the collector throws', async () => {
    collectComplianceEvidence.mockRejectedValue(new Error('AWS down'));
    const res = await get('/summary', 'operator');
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.evidenceCount).toBe(0);
    expect(json.frameworks).toHaveLength(2);
    // No evidence ⇒ no automated control is graded as a pass.
    expect(json.frameworks[0].counts.met).toBe(0);
  });

  it('enforces the compliance:read gate', async () => {
    collectComplianceEvidence.mockResolvedValue([]);
    expect((await get('/summary', undefined)).status).toBe(401); // no token
    expect((await get('/summary', 'viewer')).status).toBe(403); // lacks compliance:read
    expect((await get('/summary', 'operator')).status).toBe(200);
  });

  it('GET /brief returns a paste-ready markdown brief + stats from live evidence', async () => {
    collectComplianceEvidence.mockResolvedValue([
      { id: 'gd', label: 'GuardDuty', status: 'crit', detail: 'disabled', area: 'network', tags: ['threat-detection'] },
    ]);
    const res = await get('/brief', 'operator');
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(Object.keys(json).sort()).toEqual(['generatedAt', 'markdown', 'stats']);
    expect(json.markdown).toContain('# ClaudeClaw Compliance Remediation Brief');
    expect(json.markdown).toContain('Priority 1'); // the crit threat-detection signal is a gap
    expect(json.markdown).toContain('Needs human'); // manual controls always present
    expect(json.stats.gap).toBeGreaterThanOrEqual(1);
  });

  it('enforces compliance:read on /brief', async () => {
    collectComplianceEvidence.mockResolvedValue([]);
    expect((await get('/brief', undefined)).status).toBe(401);
    expect((await get('/brief', 'viewer')).status).toBe(403);
  });

  it('POST /analyze returns the analyst result for a known control', async () => {
    collectComplianceEvidence.mockResolvedValue([]);
    analyzeControl.mockResolvedValue({
      controlId: 'soc2-cc6.1-encryption',
      framework: 'soc2',
      ref: 'CC6.1',
      title: 'Data at rest is encrypted with managed keys',
      edition: 'SOC 2 / 2017 TSC',
      requirement: 'Encrypt at rest.',
      currentState: 'Encrypted.',
      gaps: [],
      remediation: ['Keep rotation on.'],
      references: ['CC6.1'],
      modelId: 'us.anthropic.claude-sonnet-4-6',
    });

    const res = await post('/analyze', 'operator', { controlId: 'soc2-cc6.1-encryption' });
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.controlId).toBe('soc2-cc6.1-encryption');
    expect(analyzeControl).toHaveBeenCalledOnce();
  });

  it('POST /analyze validates the controlId', async () => {
    collectComplianceEvidence.mockResolvedValue([]);
    expect((await post('/analyze', 'operator', {})).status).toBe(400); // missing
    expect((await post('/analyze', 'operator', { controlId: 'nope' })).status).toBe(404); // unknown
    expect(analyzeControl).not.toHaveBeenCalled();
  });

  it('POST /analyze surfaces a 502 when the analyst throws', async () => {
    collectComplianceEvidence.mockResolvedValue([]);
    analyzeControl.mockRejectedValue(new Error('model unavailable'));
    const res = await post('/analyze', 'operator', { controlId: 'hipaa-164.312b-audit-controls' });
    expect(res.status).toBe(502);
  });
});
