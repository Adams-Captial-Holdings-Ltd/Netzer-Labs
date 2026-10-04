import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { approvalPayload, APPROVAL_TYPE } from '../../lib/work/approvals.js';
import { payloadHash } from '../../lib/work/executor.js';
import { payloadJson } from '../../lib/work/approval-payloads.js';

const state = vi.hoisted(() => ({ enabled: true, canRead: true, dashboardReadDisabled: false, userId: 'user-alice' as string | undefined, audits: [] as unknown[],
  switches: [] as string[], approval: null as unknown, payloadRow: null as unknown }));
vi.mock('../../lib/auth/dashboard-auth.js', () => ({
  extractBearerToken: (value?: string) => (value ?? '').replace(/^Bearer /, ''),
  authenticateDashboardToken: async (raw: string) => raw === 'good' ? { tokenHash: 'h', hashPrefix16: 'h', label: 'Alice', role: 'operator', profileId: 'operator', ...(state.userId ? { userId: state.userId } : {}) } : null,
}));
vi.mock('../../lib/auth/route-capability.js', () => ({ principalHasRouteCapability: async () => state.canRead }));
vi.mock('../../lib/missions/mission-acl.js', async (importActual) => ({ ...await importActual<typeof import('../../lib/missions/mission-acl.js')>(),
  paperclipRoutingEnabled: () => state.enabled }));
vi.mock('../../lib/state/kill-switches-repo.js', async (importActual) => ({ ...await importActual<typeof import('../../lib/state/kill-switches-repo.js')>(),
  isKillSwitchActive: async (name: string) => { state.switches.push(name); return { active: name === 'dashboard_read_disabled' && state.dashboardReadDisabled }; } }));
vi.mock('../../lib/paperclip/shadow-rows-dynamo.js', () => ({ dynamoShadowRows: () => ({
  getByNetzerUser: async () => ({ netzerUserId: 'user-alice', paperclipUserId: 'pc-user-01', slot: '01', decisionClasses: ['payment_release'], status: 'active', assignedAt: 1 }),
  getByPaperclipUser: async () => undefined,
}) }));
vi.mock('../../lib/paperclip/shadow-keys.js', () => ({ defaultShadowKeyStore: () => ({ boardKeyFor: async () => 'board-key' }) }));
vi.mock('../../lib/state/users-repo.js', async (importActual) => ({ ...await importActual<typeof import('../../lib/state/users-repo.js')>(),
  getUser: async () => ({ email: 'alice@example.com', status: 'active' }) }));
vi.mock('../../lib/work/approval-payloads.js', async (importActual) => ({ ...await importActual<typeof import('../../lib/work/approval-payloads.js')>(),
  dynamoPayloadRows: () => ({ get: async () => state.payloadRow, create: async () => false }),
}));
vi.mock('../../lib/work/work-reads.js', async (importActual) => ({ ...await importActual<typeof import('../../lib/work/work-reads.js')>(),
  paperclipWorkReads: () => ({ listPipelines: async () => [], listCases: async () => ({ cases: [], truncated: false }),
    getCase: async () => undefined, listApprovals: async () => ({ approvals: [], truncated: false }), getApproval: async () => state.approval }),
}));
vi.mock('../../lib/paperclip/client.js', () => ({ paperclipClientFromEnvironment: async () => ({ request: async () => state.approval }) }));
vi.mock('../../lib/paperclip/config.js', () => ({ loadPaperclipConfig: async () => ({ companyId: 'co1', baseUrl: 'https://paperclip.invalid' }) }));
vi.mock('../../lib/paperclip/runtime-lock.js', () => ({ getPaperclipLockState: () => ({ closed: false }) }));
vi.mock('../../lib/audit/audit-writer.js', async (importActual) => ({ ...await importActual<typeof import('../../lib/audit/audit-writer.js')>(),
  writeAuditOrThrow: async (row: unknown) => { state.audits.push(row); }, writeAudit: async (row: unknown) => { state.audits.push(row); } }));

import { buildWorkRouter } from './work.js';
import { buildApp } from '../../server.js';
import type { Env } from '../../config/env.js';
const key = { caseKey: 'k1', stage: 'review', step: 'send', stageEntryNo: 1 };
const payload = { result: 'approved' };
const hash = payloadHash(payload);
function call(path: string, body?: unknown, token = 'good') {
  return buildWorkRouter().request(path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
  state.enabled = true; state.canRead = true; state.dashboardReadDisabled = false; state.userId = 'user-alice'; state.audits.length = 0; state.switches.length = 0;
  state.approval = { id: 'a1', type: APPROVAL_TYPE, status: 'pending', payload: approvalPayload(key, payload, 'payment_release'), createdAt: '2026-10-04T10:00:00Z' };
  state.payloadRow = { kind: 'payload', key, json: payloadJson(payload), payloadSha256: hash, createdAt: 1, version: 1 };
});

describe('default Work wiring', () => {
  it('mounts Work before the API catch-all', async () => {
    const res = await buildApp({} as Env).request('/api/work/status', { headers: { authorization: 'Bearer good' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });
  it('asks the paperclip kill switch by name', async () => {
    await call('/status');
    expect(state.switches).toContain('paperclip_disabled');
  });
  it('honors dashboard_read_disabled on default GET routes', async () => {
    state.dashboardReadDisabled = true;
    const res = await call('/status');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'dashboard_read_disabled' });
    expect(state.switches).toContain('dashboard_read_disabled');
  });
  it('authenticates the bearer on the default router', async () => {
    const res = await call('/status', undefined, 'bad');
    expect(res.status).toBe(401);
    expect(state.audits).toContainEqual(expect.objectContaining({ action: 'auth_failure', result: 'blocked' }));
  });
  it('reads the existing rollout flag', async () => {
    state.enabled = false;
    expect(await (await call('/status')).json()).toEqual({ enabled: false });
  });
  it('keeps mounted status token-only while inbox remains capability-gated', async () => {
    state.enabled = false; state.canRead = false;
    const app = new Hono().route('/api/work', buildWorkRouter());
    const status = await app.request('/api/work/status', { headers: { authorization: 'Bearer good' } });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ enabled: false });
    const inbox = await app.request('/api/work/inbox', { headers: { authorization: 'Bearer good' } });
    expect(inbox.status).toBe(403);
  });
  it('the default router refuses a token with no user session', async () => {
    state.userId = undefined;
    const res = await call('/approvals/a1/decision', { decision: 'approve', payloadSha256: hash });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'no_user_session' });
    expect(state.audits).toEqual([]);
  });
  it('writes approval_decided through the route', async () => {
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ...(state.approval as object), status: 'approved', decidedByUserId: 'pc-user-01', decidedAt: '2026-10-04T11:00:00Z' }), { status: 200 }));
    try {
      const res = await call('/approvals/a1/decision', { decision: 'approve', payloadSha256: hash });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, approvalId: 'a1', decision: 'approve' });
      expect(state.audits).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'approval_decided' })]));
    } finally { globalThis.fetch = priorFetch; }
  });
});
