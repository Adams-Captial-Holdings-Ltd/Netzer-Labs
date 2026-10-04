import { describe, expect, it, vi } from 'vitest';
import { PaperclipLockClosedError, PaperclipRatelimitedError, PaperclipUnavailableError } from '../paperclip/error.js';
import { PaperclipError } from '../paperclip/error.js';
import { approvalPayload, APPROVAL_TYPE } from './approvals.js';
import { paperclipWorkReads, WorkReadError } from './work-reads.js';

const pipeline = { id: 'p1', name: 'Intake', stages: [{ id: 's1', key: 'review', name: 'Review', kind: 'review' }] };
const item = { case: { id: 'c1', caseKey: 'k1', title: 'Private case title', updatedAt: '2026-10-04T10:00:00Z', leaseUserId: 'pc-user', terminalKind: null }, stage: pipeline.stages[0], activeWork: null };
const approval = { id: 'a1', type: APPROVAL_TYPE, status: 'pending', createdAt: '2026-10-04T10:00:00Z',
  payload: approvalPayload({ caseKey: 'k1', stage: 'review', step: 'send', stageEntryNo: 1 }, { secret: 'VENDOR-SECRET-1' }, 'payment_release') };
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
    const h = harness({ [pipelinesPath]: { secret: 'VENDOR-SECRET-1' } });
    await expect(h.reads.listPipelines()).rejects.toMatchObject({ code: 'paperclip_unavailable' });
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
    await expect(h.reads.getCase('c1')).rejects.toMatchObject({ code: 'paperclip_unavailable' });
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
    const h = harness({ [pipelinesPath]: [{ ...pipeline, id: undefined, title: 'VENDOR-SECRET-1' }] });
    await h.reads.listPipelines();
    expect(JSON.stringify(h.logs)).toBe('[{"code":"malformed_record","count":1}]');
  });
  it('shares one case index for concurrent and repeated filtered reads', async () => {
    const h = harness({ [pipelinesPath]: [pipeline], [casesPath]: [item] });
    await Promise.all([h.reads.listCases({ status: 'all' }), h.reads.listCases({ status: 'active' })]);
    await h.reads.listCases({ status: 'blocked' });
    expect(h.calls.filter((path) => path === '/api/cases/c1')).toHaveLength(1);
    expect(h.calls.filter((path) => path === casesPath)).toHaveLength(1);
  });
  it('does not cache a failed index read', async () => {
    const request = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue([]);
    const reads = paperclipWorkReads({ client: async () => ({ request }), companyId: async () => 'co1' });
    await expect(reads.listCases({ status: 'all' })).rejects.toMatchObject({ code: 'paperclip_unavailable' });
    await reads.listCases({ status: 'all' });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('limits case detail reads to eight in flight', async () => {
    let active = 0; let peak = 0;
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === pipelinesPath) return [pipeline];
      if (path === casesPath) return Array.from({ length: 20 }, (_, i) => ({ ...item, case: { ...item.case, id: `c${i}` } }));
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1; return { blockers: [] };
    });
    const reads = paperclipWorkReads({ client: async () => ({ request: request as never }), companyId: async () => 'co1' });
    expect((await reads.listCases({ status: 'all' })).cases).toHaveLength(20);
    expect(peak).toBe(8);
  });
  it('distinguishes exactly 200 approvals from 201', async () => {
    const h = harness({ [approvalsPath]: Array.from({ length: 200 }, (_, i) => ({ ...approval, id: `a${i}` })) });
    expect((await h.reads.listApprovals('all')).truncated).toBe(false);
  });
  it('distinguishes exactly 200 cases from 201', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ ...item, case: { ...item.case, id: `c${i}` }, blockers: [] }));
    const h = harness({ [pipelinesPath]: [pipeline], [casesPath]: rows });
    expect((await h.reads.listCases({ status: 'all' })).truncated).toBe(false);
  });
  it('a malformed approval detail fails rather than looking absent', async () => {
    const h = harness({ '/api/approvals/a1': { id: 'a1', type: APPROVAL_TYPE } });
    await expect(h.reads.getApproval('a1')).rejects.toMatchObject({ code: 'paperclip_unavailable' });
  });
  it('a missing case detail is absent', async () => {
    const h = harness({ '/api/cases/c1': new PaperclipError({ status: 404 }) });
    expect(await h.reads.getCase('c1')).toBeUndefined();
  });
  it('uses the real blocker link shape and a second case read', async () => {
    const h = harness({ '/api/cases/c1': { ...item, pipeline, blockers: [{ blockedByCaseId: 'c0' }], case: { ...item.case, fields: {} } },
      '/api/cases/c0': { case: { title: 'Earlier case' } }, '/api/cases/c1/events': [], '/api/cases/c1/issue-links': [] });
    expect((await h.reads.getCase('c1'))?.blockers).toEqual([{ id: 'c0', title: 'Earlier case' }]);
    expect(h.calls).toContain('/api/cases/c0');
  });
  it('skips missing blockers and comments, counts each, and caps read fanout', async () => {
    const blockers = Array.from({ length: 30 }, (_, i) => ({ blockedByCaseId: `b${i}` }));
    const links = Array.from({ length: 15 }, (_, i) => ({ issue: { id: `i${i}` } }));
    const responses: Record<string, unknown> = { '/api/cases/c1': { ...item, pipeline, blockers, case: { ...item.case, fields: {} } },
      '/api/cases/c1/events': [], '/api/cases/c1/issue-links': links };
    for (let i = 0; i < 30; i++) responses[`/api/cases/b${i}`] = new PaperclipError({ status: 404 });
    for (let i = 0; i < 15; i++) responses[`/api/issues/i${i}/comments`] = new PaperclipError({ status: 404 });
    const h = harness(responses);
    const result = await h.reads.getCase('c1');
    expect(result?.blockers).toEqual([]);
    expect(h.calls.filter((path) => path.startsWith('/api/cases/b'))).toHaveLength(25);
    expect(h.calls.filter((path) => path.includes('/comments'))).toHaveLength(10);
    expect(h.logs.filter((entry) => entry.code === 'malformed_record').reduce((sum, entry) => sum + entry.count, 0)).toBe(35);
  });
  it('orders timeline, truncates detail strings and limits comments', async () => {
    const long = 'x'.repeat(5_000);
    const h = harness({ '/api/cases/c1': { ...item, pipeline, blockers: [], case: { ...item.case, title: long, summary: long, fields: { long } } },
      '/api/cases/c1/events': [{ createdAt: '2026-10-04T09:00:00Z', type: 'moved', summary: long }],
      '/api/cases/c1/issue-links': [{ issue: { id: 'i1' } }],
      '/api/issues/i1/comments': [{ createdAt: '2026-10-04T10:00:00Z', body: long }] });
    const result = await h.reads.getCase('c1');
    expect(result?.title).toHaveLength(4_000);
    expect(result?.summary).toHaveLength(4_000);
    expect(result?.fields[0]?.value).toHaveLength(500);
    expect(result?.timeline.map((event) => event.kind)).toEqual(['comment', 'event']);
    expect(result?.timeline.every((event) => event.text.length === 4_000)).toBe(true);
    expect(h.request).toHaveBeenCalledWith('GET', '/api/issues/i1/comments', { query: { limit: 100 } });
  });
  it('maps TypeError and timeouts to unavailable', async () => {
    for (const error of [new TypeError('fetch failed'), new Error('request timeout')]) {
      const h = harness({ [pipelinesPath]: error });
      await expect(h.reads.listCases({ status: 'all' })).rejects.toMatchObject({ code: 'paperclip_unavailable' });
    }
  });
  it('filters cases by pipeline, stage and done status from one cached index', async () => {
    const second = { id: 'p2', name: 'Other', stages: [{ id: 's2', key: 'finish', name: 'Finish', kind: 'review' }] };
    const done = { ...item, case: { ...item.case, id: 'c2', terminalKind: 'done' }, stage: second.stages[0], blockers: [] };
    const h = harness({ [pipelinesPath]: [pipeline, second], [casesPath]: [item], '/api/pipelines/p2/cases': [done] });
    expect((await h.reads.listCases({ status: 'done' })).cases.map((row) => row.id)).toEqual(['c2']);
    expect((await h.reads.listCases({ status: 'all', pipeline: 'p2', stage: 's2' })).cases.map((row) => row.id)).toEqual(['c2']);
    expect((await h.reads.listCases({ status: 'active', stage: 'finish' })).cases).toEqual([]);
    expect(h.calls.filter((path) => path === casesPath)).toHaveLength(1);
  });
  it('rejects malformed foreign approval details but hides well-formed foreign approvals', async () => {
    const bad = harness({ '/api/approvals/a1': { id: 'a1', type: 'hire_agent' } });
    await expect(bad.reads.getApproval('a1')).rejects.toMatchObject({ code: 'paperclip_unavailable' });
    const foreign = harness({ '/api/approvals/a1': { ...approval, type: 'hire_agent', payload: { name: 'other approval' } } });
    expect(await foreign.reads.getApproval('a1')).toBeUndefined();
  });
  it('normalizes decidedAt like createdAt', async () => {
    const h = harness({ '/api/approvals/a1': { ...approval, decidedAt: '2026-10-04T10:00:00Z' } });
    expect((await h.reads.getApproval('a1'))?.decidedAt).toBe('2026-10-04T10:00:00.000Z');
  });
  it.each([
    { terminalKind: 'unknown' },
    { terminalKind: null, id: '' },
  ])('drops malformed case list records', async (bad) => {
    const h = harness({ [pipelinesPath]: [pipeline], [casesPath]: [{ ...item, case: { ...item.case, ...bad } }] });
    expect((await h.reads.listCases({ status: 'all' })).cases).toEqual([]);
    expect(h.logs).toContainEqual({ code: 'malformed_record', count: 1 });
  });
  it.each([
    { payloadSha256: 'short' },
    { payloadSha256: 'A'.repeat(64) },
    { stageEntryNo: 0 },
    { stageEntryNo: 1.5 },
    { decisionClass: 'Bad' },
    { extra: true },
  ])('drops malformed approval list payloads', async (bad) => {
    const h = harness({ [approvalsPath]: [{ ...approval, payload: { ...approval.payload, ...bad } }] });
    expect((await h.reads.listApprovals('all')).approvals).toEqual([]);
    expect(h.logs).toEqual([{ code: 'malformed_record', count: 1 }]);
  });
});
