import { describe, expect, it, vi } from 'vitest';
import { buildWorkRouter, type WorkCase, type WorkRouterDeps } from './work.js';
import { APPROVAL_TYPE, approvalPayload } from '../../lib/work/approvals.js';
import { logger } from '../../observability/logger.js';

const hash = 'a'.repeat(64);
const payload = approvalPayload({ caseKey: 'key1', stage: 'old', step: 'send', stageEntryNo: 1 }, { x: 1 }, 'review');
const approval = { id: 'ap1', type: APPROVAL_TYPE, status: 'pending', createdAt: '2026-10-04T10:00:00Z', payload };
const principal = { tokenHash: 'h', hashPrefix16: 'h', label: 'Dana', role: 'operator' as const, profileId: 'operator', userId: 'dana' };
const shadow = { netzerUserId: 'dana', paperclipUserId: 'pc1', slot: '01', decisionClasses: ['review'], status: 'active' as const, assignedAt: 1 };
function harness(over: Partial<WorkRouterDeps> = {}) {
  const reads = {
    listPipelines: vi.fn(async () => [{ id: 'p1', name: 'Flow', stages: [{ id: 's1', key: 'old', name: 'Old review', kind: 'review' }] }]),
    listCases: vi.fn(async () => ({ cases: [] as WorkCase[], truncated: false })),
    getCase: vi.fn(async () => undefined),
    listApprovals: vi.fn(async () => ({ approvals: [approval], truncated: false })),
    getApproval: vi.fn(async () => approval),
  };
  const deps: WorkRouterDeps = {
    authenticate: vi.fn(async () => principal), hasCapability: vi.fn(async () => true),
    enabled: () => true, killSwitch: vi.fn(async () => ({ active: false })), reads,
    shadows: { getByNetzerUser: vi.fn(async () => shadow), getByPaperclipUser: vi.fn(async () => undefined) },
    displayName: async () => null,
    payloads: { get: async () => undefined, create: async () => false },
    decide: vi.fn(async () => undefined), ...over,
  };
  const request = (path: string, init?: RequestInit) => buildWorkRouter(deps).request(path, { ...init,
    headers: { authorization: 'Bearer good', ...(init?.headers as Record<string, string> | undefined) } });
  return { deps, reads, request };
}
describe('Work route hardening', () => {
  it('rejects unsafe ids before any upstream read', async () => {
    const h = harness();
    expect((await h.request('/cases/%2E%2E')).status).toBe(404);
    expect((await h.request('/approvals/%2E%2E')).status).toBe(404);
    expect((await h.request('/approvals/bad%2Fid/decision', { method: 'POST' })).status).toBe(404);
    expect(h.reads.getCase).not.toHaveBeenCalled();
    expect(h.reads.getApproval).not.toHaveBeenCalled();
  });
  it('rejects non-string decisions, long comments and oversized bodies', async () => {
    const h = harness();
    const post = (body: string, headers?: Record<string, string>) => h.request('/approvals/ap1/decision', { method: 'POST', body, headers });
    expect(await (await post(JSON.stringify({ decision: ['reject'], payloadSha256: hash }))).json()).toEqual({ error: 'invalid_body' });
    expect(await (await post(JSON.stringify({ decision: 'reject', payloadSha256: hash, comment: 'x'.repeat(4001) }))).json()).toEqual({ error: 'comment_too_long' });
    const large = await post('x'.repeat(16_385));
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ error: 'body_too_large' });
    const declared = await post('{}', { 'content-length': '16385' });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: 'body_too_large' });
    expect(h.reads.getApproval).not.toHaveBeenCalled();
  });
  it('uses pipeline stage names and keeps approval detail available when the case index fails', async () => {
    const h = harness({ hasCapability: async (_p, cap) => cap === 'work:read' });
    expect((await (await h.request('/inbox')).json()) as { approverSetUp: boolean }).toMatchObject({ approverSetUp: false });
    const list = await h.request('/approvals');
    expect(((await list.json()) as { approvals: unknown[] }).approvals[0]).toMatchObject({ stageName: 'Old review', canDecide: false });
    h.reads.listCases.mockRejectedValueOnce(new Error('index down'));
    const detail = await h.request('/approvals/ap1');
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { approval: unknown }).approval).toMatchObject({ caseId: null, caseTitle: null, stageName: 'Old review', cannotDecideReason: 'missing_capability' });
  });
  it('uses the matched case pipeline when stage keys repeat', async () => {
    const caseRow = { id: 'c1', caseKey: 'key1', title: 'Case', pipeline: { id: 'p2', name: 'Second' },
      stage: { id: 's2', key: 'current', name: 'Current', kind: 'review' }, status: 'active' as const,
      owner: { kind: 'none' as const, name: null }, updatedAt: '2026-10-04T10:00:00Z', leaseUserId: null };
    const base = harness();
    base.reads.listCases.mockResolvedValue({ cases: [caseRow], truncated: false });
    base.reads.listPipelines.mockResolvedValue([
      { id: 'p1', name: 'First', stages: [{ id: 's1', key: 'old', name: 'Wrong stage', kind: 'review' }] },
      { id: 'p2', name: 'Second', stages: [{ id: 's2', key: 'old', name: 'Right stage', kind: 'review' }] },
    ]);
    const result = (await (await base.request('/approvals')).json()) as { approvals: { stageName: string }[] };
    expect(result.approvals[0]?.stageName).toBe('Right stage');
  });
  it('keeps detail available if both index and pipeline reads fail', async () => {
    const h = harness();
    h.reads.listCases.mockRejectedValueOnce(new Error('index down'));
    h.reads.listPipelines.mockRejectedValueOnce(new Error('pipeline down'));
    const res = await h.request('/approvals/ap1');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approval: unknown }).approval).toMatchObject({ caseId: null, caseTitle: null, stageName: null });
  });
  it('uses one approve-capability lookup for a list', async () => {
    const h = harness({ hasCapability: vi.fn(async (_p, cap) => cap === 'work:read') });
    await h.request('/inbox');
    expect(h.deps.hasCapability).toHaveBeenCalledTimes(2);
  });
  it('returns not_pending at the first approval read', async () => {
    const h = harness({ reads: { ...harness().reads, getApproval: async () => ({ ...approval, status: 'approved' }) } });
    const res = await h.request('/approvals/ap1/decision', { method: 'POST', body: JSON.stringify({ decision: 'approve', payloadSha256: payload.payloadSha256 }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_pending' });
  });
  it('a retired shadow row is not set up and cannot decide', async () => {
    const h = harness({ shadows: { getByNetzerUser: async () => ({ ...shadow, status: 'retired', retiredAt: 2 }),
      getByPaperclipUser: async () => undefined } });
    const inbox = (await (await h.request('/inbox')).json()) as { approverSetUp: boolean; approvals: unknown[] };
    expect(inbox).toMatchObject({ approverSetUp: false, approvals: [] });
    const detail = (await (await h.request('/approvals/ap1')).json()) as { approval: { cannotDecideReason: string } };
    expect(detail.approval.cannotDecideReason).toBe('not_an_approver');
  });
  it('logs only the error name and route pattern on an unexpected failure', async () => {
    const log = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      const h = harness();
      h.reads.listCases.mockRejectedValueOnce(new TypeError('SECRET-PAYLOAD'));
      const res = await h.request('/approvals');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_error' });
      expect(log).toHaveBeenCalledWith({ error: 'TypeError', route: '/approvals' }, 'work_route_failed');
      expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET-PAYLOAD');
    } finally { log.mockRestore(); }
  });
});
