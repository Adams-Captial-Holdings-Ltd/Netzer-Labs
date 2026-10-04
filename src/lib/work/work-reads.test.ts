import { describe, expect, it, vi } from 'vitest';
import { PaperclipLockClosedError, PaperclipRatelimitedError, PaperclipUnavailableError } from '../paperclip/error.js';
import { PaperclipError } from '../paperclip/error.js';
import { approvalPayload, APPROVAL_TYPE } from './approvals.js';
import { paperclipWorkReads, WorkReadError } from './work-reads.js';

const pipeline = { id: 'p1', name: 'Intake', stages: [{ id: 's1', key: 'review', name: 'Review', kind: 'review' }] };
const item = { case: { id: 'c1', caseKey: 'k1', title: 'Private case title', updatedAt: '2026-10-04T10:00:00Z', leaseUserId: 'pc-user', terminalKind: null }, stage: pipeline.stages[0], activeWork: null };
const approval = { id: 'a1', type: APPROVAL_TYPE, status: 'pending', createdAt: '2026-10-04T10:00:00Z',
  payload: approvalPayload({ caseKey: 'k1', stage: 'review', step: 'send', stageEntryNo: 1 }, { secret: 'PATIENT-JANE' }, 'clinical_disposition') };
function harness(responses: Record<string, unknown> = {}) {
  const calls: string[] = []; const logs: { code: string; count: number }[] = [];
  const request = vi.fn(async (_method: string, path: string) => {
    calls.push(path);
    const value = responses[path];
    if (value instanceof Error) throw value;
    return value ?? (path.startsWith('/api/cases/') ? { blockers: [] } : []);
  });
  const reads = paperclipWorkReads({ client: async () => ({ request } as never), companyId: async () => 'co1', log: (code, count) => logs.push({ code, count }) });
  return { reads, request, calls, logs };
}
const pipelinesPath = '/api/companies/co1/pipelines';
const casesPath = '/api/pipelines/p1/cases';
const approvalsPath = '/api/companies/co1/approvals';

describe('Paperclip Work reads', () => {
  it('reads the pinned pipeline route and strips extra fields', async () => {
    const h = harness({ [pipelinesPath]: [{ ...pipeline, private: 'NO' }] });
    expect(await h.reads.listPipelines()).toEqual([pipeline]);
    expect(h.calls).toEqual([pipelinesPath]);
  });
  it('a malformed record is dropped and counted', async () => {
    const h = harness({ [pipelinesPath]: [pipeline, { name: 'missing id' }] });
    expect(await h.reads.listPipelines()).toEqual([pipeline]);
    expect(h.logs).toEqual([{ code: 'malformed_record', count: 1 }]);
  });
  it('a malformed response is logged once', async () => {
    const h = harness({ [pipelinesPath]: { secret: 'PATIENT-JANE' } });
    expect(await h.reads.listPipelines()).toEqual([]);
    expect(h.logs).toEqual([{ code: 'malformed_response', count: 1 }]);
  });
  it('a record that is not a Netzer approval is kept out of the Work lists', async () => {
    const h = harness({ [approvalsPath]: [approval, { ...approval, id: 'foreign', type: 'hire_agent' }] });
    expect((await h.reads.listApprovals('all')).approvals.map((a) => a.id)).toEqual(['a1']);
    expect(h.logs).toEqual([{ code: 'malformed_record', count: 1 }]);
  });
  it('reads pending approvals with the status query', async () => {
    const h = harness({ [approvalsPath]: [approval] });
    expect((await h.reads.listApprovals('pending')).approvals).toHaveLength(1);
    expect(h.request).toHaveBeenCalledWith('GET', approvalsPath, { query: { status: 'pending' } });
  });
  it('caps approvals at 200 and marks truncation', async () => {
    const h = harness({ [approvalsPath]: Array.from({ length: 201 }, (_, i) => ({ ...approval, id: `a${i}` })) });
    const result = await h.reads.listApprovals('all');
    expect(result.approvals).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });
  it('reads cases from the pinned pipeline route', async () => {
    const h = harness({ [pipelinesPath]: [pipeline], [casesPath]: [item] });
    expect((await h.reads.listCases({ status: 'all' })).cases).toMatchObject([{ id: 'c1', leaseUserId: 'pc-user' }]);
    expect(h.calls).toEqual([pipelinesPath, casesPath, '/api/cases/c1']);
  });
  it('filters done cases from active', async () => {
    const h = harness({ [pipelinesPath]: [pipeline], [casesPath]: [item, { ...item, case: { ...item.case, id: 'c2', terminalKind: 'done' } }] });
    expect((await h.reads.listCases({ status: 'active' })).cases.map((c) => c.id)).toEqual(['c1']);
  });
  it('derives blocked status from the case detail blockers', async () => {
    const h = harness({ [pipelinesPath]: [pipeline], [casesPath]: [item], '/api/cases/c1': { blockers: [{ blockedByCaseId: 'c0' }] } });
    expect((await h.reads.listCases({ status: 'blocked' })).cases).toMatchObject([{ id: 'c1', status: 'blocked' }]);
  });
  it('caps case rows at 200 and marks truncation', async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ ...item, case: { ...item.case, id: `c${i}` }, blockers: [] }));
    const h = harness({ [pipelinesPath]: [pipeline], [casesPath]: rows });
    const result = await h.reads.listCases({ status: 'all' });
    expect(result.cases).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });
  it('builds detail fields and timeline from the pinned routes', async () => {
    const h = harness({ '/api/cases/c1': { ...item, pipeline, blockers: [{ id: 'c0', title: 'Missing form' }],
      case: { ...item.case, summary: 'Summary', fields: { urgency: 2, secret: { nested: 'omit' } } } },
    '/api/cases/c1/events': { items: [{ createdAt: '2026-10-04T10:00:00Z', type: 'moved', summary: 'Moved to review' }] },
    '/api/cases/c1/issue-links': [] });
    expect(await h.reads.getCase('c1')).toMatchObject({ id: 'c1', summary: 'Summary', fields: [{ name: 'urgency', value: '2' }],
      blockers: [{ id: 'c0', title: 'Missing form' }], timeline: [{ text: 'Moved to review' }] });
  });
  it('drops a malformed case detail before reading its events', async () => {
    const h = harness({ '/api/cases/c1': { ...item, pipeline, blockers: [] } });
    expect(await h.reads.getCase('c1')).toBeUndefined();
    expect(h.logs).toEqual([{ code: 'malformed_record', count: 1 }]);
    expect(h.calls).toEqual(['/api/cases/c1']);
  });
  it('reads one approval by its pinned route', async () => {
    const h = harness({ '/api/approvals/a1': approval });
    expect((await h.reads.getApproval('a1'))?.id).toBe('a1');
  });
  it('treats a missing approval as not found without logging a read failure', async () => {
    const h = harness({ '/api/approvals/missing': new PaperclipError({ status: 404 }) });
    expect(await h.reads.getApproval('missing')).toBeUndefined();
    expect(h.logs).toEqual([]);
  });
  it('maps a locked client to paperclip_locked', async () => {
    const h = harness({ [pipelinesPath]: new PaperclipLockClosedError({}, 'closed') });
    await expect(h.reads.listPipelines()).rejects.toMatchObject({ code: 'paperclip_locked' });
  });
  it('maps a rate limited client to paperclip_ratelimited', async () => {
    const h = harness({ [pipelinesPath]: new PaperclipRatelimitedError({ status: 429 }) });
    await expect(h.reads.listPipelines()).rejects.toMatchObject({ code: 'paperclip_ratelimited' });
  });
  it('maps an unavailable client to paperclip_unavailable', async () => {
    const h = harness({ [pipelinesPath]: new PaperclipUnavailableError({ status: 503 }) });
    await expect(h.reads.listPipelines()).rejects.toBeInstanceOf(WorkReadError);
  });
  it('logs codes and counts only', async () => {
    const h = harness({ [pipelinesPath]: [{ ...pipeline, id: undefined, title: 'PATIENT-JANE' }] });
    await h.reads.listPipelines();
    expect(JSON.stringify(h.logs)).toBe('[{"code":"malformed_record","count":1}]');
  });
});
