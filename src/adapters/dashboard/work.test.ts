/**
 * FROZEN acceptance tests for Work Platform step 7: the Work BFF (`/api/work`).
 * Written by the coordinator BEFORE any production code. Do not edit without
 * the owner's yes: the step gate pins this file. Add your own tests in other
 * files.
 *
 * The seam (the whole contract of these tests):
 *
 *   buildWorkRouter(deps: WorkDeps): Hono          // mounted at /api/work
 *
 *   WorkDeps = {
 *     authenticate(authorization: string | undefined): Promise<TokenPrincipal | null>
 *     hasCapability(principal, capability: 'work:read' | 'work:approve'): Promise<boolean>
 *     enabled(): boolean                            // CCE_PAPERCLIP_ENABLED
 *     killSwitch(name: 'paperclip_disabled'): Promise<{ active: boolean }>
 *     reads: WorkReads                              // Paperclip reads, already shape-checked
 *     shadows: { getByNetzerUser(netzerUserId): Promise<ShadowUser | undefined>
 *                getByPaperclipUser(paperclipUserId): Promise<ShadowUser | undefined> }
 *     displayName(netzerUserId: string): Promise<string | null>   // the decider's name on a decided approval
 *     payloads: PayloadRows                         // the payload row (approval-payloads.ts)
 *     decide(req: { netzerUserId, approvalId, decision, comment? }): Promise<unknown>   // step 6
 *   }
 *
 *   WorkReads = {
 *     listPipelines(): Promise<PipelineSummary[]>
 *     listCases(q: { pipeline?: string; stage?: string; status: 'active' | 'blocked' | 'done' | 'all' }):
 *       Promise<{ cases: WorkCase[]; truncated: boolean }>
 *     getCase(caseId: string): Promise<WorkCaseDetail | undefined>
 *     listApprovals(status: 'pending' | 'all'): Promise<{ approvals: WorkApproval[]; truncated: boolean }>
 *     getApproval(approvalId: string): Promise<WorkApproval | undefined>
 *   }
 *   WorkCase       = CaseSummary & { leaseUserId: string | null }       // leaseUserId never leaves the server
 *   WorkCaseDetail = WorkCase & { summary, fields, blockers, timeline }
 *   WorkApproval   = ApprovalRecord & { createdAt: string; decisionNote?: string | null }   // the raw Paperclip record
 *   WorkReadError(code: 'paperclip_unavailable' | 'paperclip_locked' | 'paperclip_ratelimited')
 *
 * ONE-WAY (owner): the seven routes, their bodies and their error codes.
 * A153: the decide route takes the Netzer user from the session and nowhere else.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildWorkRouter, WorkReadError,
  type WorkApproval, type WorkCase, type WorkCaseDetail, type WorkDeps,
} from './work.js';
import { payloadJson, type PayloadRow, type PayloadRows } from '../../lib/work/approval-payloads.js';
import { APPROVAL_TYPE, ApprovalAttributionError, ApprovalRefusedError, approvalPayload } from '../../lib/work/approvals.js';
import { payloadHash } from '../../lib/work/executor.js';
import type { EffectKey } from '../../lib/work/effect-ledger.js';
import type { ShadowUser } from '../../lib/paperclip/shadow-users.js';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// ── people ────────────────────────────────────────────────────────────────────
const principal = (label: string, userId?: string, role: TokenPrincipal['role'] = 'operator'): TokenPrincipal =>
  ({ tokenHash: `hash-${label}`, label, hashPrefix16: `prefix-${label}`, role, ...(userId ? { userId, profileId: role } : {}) });
const PEOPLE: Record<string, { principal: TokenPrincipal; caps: string[] }> = {
  alice: { principal: principal('alice', 'user-alice'), caps: ['work:read', 'work:approve'] },      // approver, clinical
  bob: { principal: principal('bob', 'user-bob'), caps: ['work:read', 'work:approve'] },            // approver, billing only
  carol: { principal: principal('carol', 'user-carol'), caps: ['work:read', 'work:approve'] },      // capabilities, no shadow row
  rita: { principal: principal('rita', 'user-rita'), caps: ['work:read'] },                         // read only
  vic: { principal: principal('vic', 'user-vic', 'viewer'), caps: [] },                             // neither capability
  root: { principal: principal('Root token', undefined, 'admin'), caps: ['work:read', 'work:approve'] }, // no user session
};
const CLASS = 'clinical_disposition';
const SHADOWS: ShadowUser[] = [
  { netzerUserId: 'user-alice', slot: '01', paperclipUserId: 'pc-user-01', decisionClasses: [CLASS], status: 'active', assignedAt: 1_000 },
  { netzerUserId: 'user-bob', slot: '02', paperclipUserId: 'pc-user-02', decisionClasses: ['billing_adjustment'], status: 'active', assignedAt: 1_000 },
];

// ── fixtures ──────────────────────────────────────────────────────────────────
const key: EffectKey = { caseKey: 'ref-2026-0001', stage: 'clinical-review', step: 'send_letter', stageEntryNo: 1 };
const payload = { patient: 'PATIENT-JANE-DOE', letter: 'DRAFT-TEXT-ABOUT-JANE', slot: '2026-10-05T09:00' };
const pipeline = { id: 'pl-1', name: 'Referral intake' };
const stage = { id: 'st-2', key: 'clinical-review', name: 'Clinical review', kind: 'review' };
const pipelines = [{ ...pipeline, stages: [{ id: 'st-1', key: 'intake', name: 'Intake', kind: 'working' }, stage] }];
const workCase = (over: Partial<WorkCase> = {}): WorkCase => ({
  id: 'case-1', caseKey: 'ref-2026-0001', title: 'Referral for J. D.', pipeline, stage, status: 'active',
  owner: { kind: 'agent', name: 'Intake agent' }, updatedAt: '2026-10-04T09:00:00.000Z', leaseUserId: null, ...over,
});
const CASES: WorkCase[] = [
  workCase(),
  workCase({ id: 'case-2', caseKey: 'ref-2026-0002', title: 'Blocked referral', status: 'blocked' }),
  workCase({ id: 'case-3', caseKey: 'ref-2026-0003', title: 'Held by Alice', owner: { kind: 'person', name: 'Alice' }, leaseUserId: 'pc-user-01' }),
];
const caseDetail: WorkCaseDetail = {
  ...workCase(), summary: 'New referral', fields: [{ name: 'priority', value: 'routine' }],
  blockers: [], timeline: [{ at: '2026-10-04T09:00:00.000Z', kind: 'event', actor: 'Intake agent', text: 'Moved to Clinical review' }],
};
const approvalRecord = (id: string, over: Partial<WorkApproval> = {}, p: unknown = payload, k: EffectKey = key, decisionClass = CLASS): WorkApproval => ({
  id, type: APPROVAL_TYPE, status: 'pending', payload: approvalPayload(k, p, decisionClass),
  decidedByUserId: null, decidedAt: null, createdAt: '2026-10-04T09:30:00.000Z', ...over,
});
const key2: EffectKey = { ...key, caseKey: 'ref-2026-0002', stage: 'billing-review', step: 'adjust' };
const APPROVALS: WorkApproval[] = [
  approvalRecord('apr-1'),
  approvalRecord('apr-2', {}, { amount: 120 }, key2, 'billing_adjustment'),
  approvalRecord('apr-3', { status: 'approved', decidedByUserId: 'pc-user-01', decidedAt: '2026-10-04T10:00:00.000Z', decisionNote: 'Looks right.' }, payload, { ...key, stageEntryNo: 2 }),
  { id: 'apr-foreign', type: 'hire_agent', status: 'pending', payload: { name: 'not ours' }, createdAt: '2026-10-04T08:00:00.000Z' },
];

function payloadRows(seed: [EffectKey, unknown][] = [[key, payload], [key2, { amount: 120 }]]) {
  const items = new Map<string, PayloadRow>();
  const id = (k: EffectKey) => `${k.caseKey}|${k.stage}|${k.step}|${k.stageEntryNo}`;
  for (const [k, p] of seed) items.set(id(k), { kind: 'payload', key: k, json: payloadJson(p), payloadSha256: payloadHash(p), createdAt: 1, version: 1 });
  const rows: PayloadRows = { get: vi.fn(async (k) => items.get(id(k))), create: vi.fn(async () => false) };
  return { rows, items, id };
}

function harness(over: Partial<WorkDeps> = {}) {
  const stored = payloadRows();
  const deps = {
    authenticate: vi.fn(async (authorization: string | undefined) => PEOPLE[(authorization ?? '').replace('Bearer ', '')]?.principal ?? null),
    hasCapability: vi.fn(async (p: TokenPrincipal, capability: string) =>
      Object.values(PEOPLE).find((person) => person.principal.label === p.label)?.caps.includes(capability) ?? false),
    enabled: vi.fn(() => true),
    killSwitch: vi.fn(async () => ({ active: false })),
    reads: {
      listPipelines: vi.fn(async () => pipelines),
      listCases: vi.fn(async () => ({ cases: CASES, truncated: false })),
      getCase: vi.fn(async (caseId: string) => (caseId === 'case-1' ? caseDetail : undefined)),
      listApprovals: vi.fn(async (status: 'pending' | 'all') =>
        ({ approvals: status === 'pending' ? APPROVALS.filter((a) => a.status === 'pending') : APPROVALS, truncated: false })),
      getApproval: vi.fn(async (approvalId: string) => APPROVALS.find((a) => a.id === approvalId)),
    },
    shadows: {
      getByNetzerUser: vi.fn(async (id: string) => SHADOWS.find((s) => s.netzerUserId === id)),
      getByPaperclipUser: vi.fn(async (id: string) => SHADOWS.find((s) => s.paperclipUserId === id)),
    },
    displayName: vi.fn(async (id: string) => (id === 'user-alice' ? 'Alice Example' : null)),
    payloads: stored.rows,
    decide: vi.fn(async (req: { approvalId: string; decision: string }) => ({ approvalId: req.approvalId, decision: req.decision, shadowUserId: 'pc-user-01' })),
    ...over,
  } satisfies WorkDeps;
  const app = buildWorkRouter(deps);
  const call = async (who: string | null, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await app.request(path, {
      method: init.method ?? 'GET',
      headers: { ...(who ? { authorization: `Bearer ${who}` } : {}), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
    });
    const text = await res.text();
    let body: unknown; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body: body as Record<string, any>, text, headers: res.headers };
  };
  const decision = (who: string | null, approvalId: string, body: unknown, headers?: Record<string, string>) =>
    call(who, `/approvals/${approvalId}/decision`, { method: 'POST', body, ...(headers ? { headers } : {}) });
  return { deps, app, call, decision, stored };
}
const GETS = ['/inbox', '/cases', '/cases/case-1', '/approvals', '/approvals/apr-1'];
const goodBody = { decision: 'approve', payloadSha256: payloadHash(payload) };

// ── gates ─────────────────────────────────────────────────────────────────────
describe('gate order: 401, then 403, then work_disabled, then the kill switch', () => {
  it.each([...GETS, '/status'])('GET %s without a token is 401', async (path) => {
    const h = harness();
    expect(await h.call(null, path)).toMatchObject({ status: 401, body: { error: 'unauthorized' } });
  });

  it('the decide route without a token is 401', async () => {
    const h = harness();
    expect(await h.decision(null, 'apr-1', goodBody)).toMatchObject({ status: 401, body: { error: 'unauthorized' } });
    expect(h.deps.decide).not.toHaveBeenCalled();
  });

  it.each(GETS)('GET %s without work:read is 403 and reads nothing', async (path) => {
    const h = harness();
    expect(await h.call('vic', path)).toEqual(expect.objectContaining({ status: 403, body: { error: 'forbidden', requiredCapability: 'work:read' } }));
    for (const read of Object.values(h.deps.reads)) expect(read).not.toHaveBeenCalled();
  });

  it('the decide route without work:approve is 403, even with work:read', async () => {
    const h = harness();
    expect(await h.decision('rita', 'apr-1', goodBody)).toEqual(expect.objectContaining({ status: 403, body: { error: 'forbidden', requiredCapability: 'work:approve' } }));
    expect(h.deps.decide).not.toHaveBeenCalled();
    expect(h.deps.reads.getApproval).not.toHaveBeenCalled();
  });

  it.each(GETS)('GET %s with the flag off is 503 work_disabled and reads nothing', async (path) => {
    const h = harness({ enabled: () => false });
    expect(await h.call('alice', path)).toEqual(expect.objectContaining({ status: 503, body: { error: 'work_disabled' } }));
    for (const read of Object.values(h.deps.reads)) expect(read).not.toHaveBeenCalled();
  });

  it('the capability check comes before the flag: no capability and the flag off is still 403', async () => {
    const h = harness({ enabled: () => false });
    expect((await h.call('vic', '/inbox')).status).toBe(403);
    expect((await h.decision('rita', 'apr-1', goodBody)).status).toBe(403);
  });

  it.each(GETS)('GET %s with the kill switch on is 503 paperclip_disabled', async (path) => {
    const h = harness({ killSwitch: async () => ({ active: true }) });
    expect(await h.call('alice', path)).toMatchObject({ status: 503, body: { error: 'paperclip_disabled' } });
    for (const read of Object.values(h.deps.reads)) expect(read).not.toHaveBeenCalled();
  });

  it('the decide route obeys the flag and the kill switch', async () => {
    expect(await harness({ enabled: () => false }).decision('alice', 'apr-1', goodBody)).toMatchObject({ status: 503, body: { error: 'work_disabled' } });
    const off = harness({ killSwitch: async () => ({ active: true }) });
    expect(await off.decision('alice', 'apr-1', goodBody)).toMatchObject({ status: 503, body: { error: 'paperclip_disabled' } });
    expect(off.deps.decide).not.toHaveBeenCalled();
  });
});

describe('GET /status', () => {
  it('any signed-in principal may ask, with no capability', async () => {
    expect(await harness().call('vic', '/status')).toEqual(expect.objectContaining({ status: 200, body: { enabled: true } }));
  });
  it('is false when the flag is off, and false when the kill switch is on', async () => {
    expect((await harness({ enabled: () => false }).call('vic', '/status')).body).toEqual({ enabled: false });
    expect((await harness({ killSwitch: async () => ({ active: true }) }).call('vic', '/status')).body).toEqual({ enabled: false });
  });
});

// ── reads ─────────────────────────────────────────────────────────────────────
const summary = (c: WorkCase) => { const { leaseUserId: _lease, ...rest } = c; return rest; };
// decisionLabel is the class id in words until a pack supplies its own label (step 8). stageName and the case
// fields are null when the pipeline stage or the case cannot be found; the screen then falls back to the keys.
const apr1 = { id: 'apr-1', status: 'pending', decisionClass: CLASS, decisionLabel: 'Clinical disposition',
  caseId: 'case-1', caseKey: 'ref-2026-0001', caseTitle: 'Referral for J. D.', stage: 'clinical-review', stageName: 'Clinical review',
  step: 'send_letter', stageEntryNo: 1, requestedAt: '2026-10-04T09:30:00.000Z', decidedAt: null };
const apr2 = { id: 'apr-2', status: 'pending', decisionClass: 'billing_adjustment', decisionLabel: 'Billing adjustment',
  caseId: 'case-2', caseKey: 'ref-2026-0002', caseTitle: 'Blocked referral', stage: 'billing-review', stageName: null,
  step: 'adjust', stageEntryNo: 1, requestedAt: '2026-10-04T09:30:00.000Z', decidedAt: null };
const apr3 = { ...apr1, id: 'apr-3', status: 'approved', stageEntryNo: 2, decidedAt: '2026-10-04T10:00:00.000Z' };

describe('GET /cases', () => {
  it('returns case summaries, the pipelines for the filters, and never the lease user id', async () => {
    const h = harness();
    const res = await h.call('rita', '/cases');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cases: CASES.map(summary), pipelines, truncated: false });
    expect(res.text).not.toContain('leaseUserId');
    expect(res.text).not.toContain('pc-user-01');
    expect(h.deps.reads.listCases).toHaveBeenCalledWith({ status: 'active' });
  });

  it('passes the filters through', async () => {
    const h = harness();
    await h.call('rita', '/cases?pipeline=pl-1&stage=st-2&status=all');
    expect(h.deps.reads.listCases).toHaveBeenCalledWith({ pipeline: 'pl-1', stage: 'st-2', status: 'all' });
    for (const status of ['active', 'blocked', 'done']) {
      await h.call('rita', `/cases?status=${status}`);
      expect(h.deps.reads.listCases).toHaveBeenLastCalledWith({ status });
    }
  });

  it('an unknown status is 400 invalid_query and reads nothing', async () => {
    const h = harness();
    expect(await h.call('rita', '/cases?status=everything')).toMatchObject({ status: 400, body: { error: 'invalid_query' } });
    expect(h.deps.reads.listCases).not.toHaveBeenCalled();
  });

  it('truncated is passed on', async () => {
    const h = harness();
    h.deps.reads.listCases.mockResolvedValueOnce({ cases: CASES, truncated: true });
    expect((await h.call('rita', '/cases')).body.truncated).toBe(true);
  });
});

describe('GET /cases/:caseId', () => {
  it('returns the detail with the approvals of that case key', async () => {
    const res = await harness().call('rita', '/cases/case-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ case: { ...summary(caseDetail), summary: 'New referral', fields: caseDetail.fields, blockers: [],
      timeline: caseDetail.timeline, approvals: [{ ...apr1, canDecide: false }, { ...apr3, canDecide: false }] } });
    expect(res.text).not.toContain('leaseUserId');
  });
  it('an unknown case is 404', async () => {
    expect(await harness().call('rita', '/cases/nope')).toMatchObject({ status: 404, body: { error: 'not_found' } });
  });
});

describe('GET /approvals', () => {
  it('lists pending Netzer approvals only, by default; a record that is not ours is never shown', async () => {
    const h = harness();
    const res = await h.call('alice', '/approvals');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approvals: [{ ...apr1, canDecide: true }, { ...apr2, canDecide: false }], truncated: false });
    expect(res.text).not.toContain('apr-foreign');
    expect(h.deps.reads.listApprovals).toHaveBeenCalledWith('pending');
  });

  it('status=all includes decided approvals; another value is 400', async () => {
    const h = harness();
    expect((await h.call('alice', '/approvals?status=all')).body.approvals.map((a: { id: string }) => a.id)).toEqual(['apr-1', 'apr-2', 'apr-3']);
    expect(await h.call('alice', '/approvals?status=approved')).toMatchObject({ status: 400, body: { error: 'invalid_query' } });
  });

  it('canDecide follows the caller: their decision class, their shadow row, their capability, their session', async () => {
    const ids = async (who: string) => (await harness().call(who, '/approvals')).body.approvals
      .filter((a: { canDecide: boolean }) => a.canDecide).map((a: { id: string }) => a.id);
    expect(await ids('alice')).toEqual(['apr-1']);
    expect(await ids('bob')).toEqual(['apr-2']);
    expect(await ids('carol')).toEqual([]);   // capabilities but no shadow row
    expect(await ids('rita')).toEqual([]);    // no work:approve
    expect(await ids('root')).toEqual([]);    // no user session
  });

  it('never contains the payload', async () => {
    expect((await harness().call('alice', '/approvals?status=all')).text).not.toMatch(/JANE|DRAFT-TEXT/);
  });
});

describe('GET /approvals/:approvalId', () => {
  it('shows the verified payload and says the caller can decide', async () => {
    const res = await harness().call('alice', '/approvals/apr-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approval: { ...apr1, canDecide: true, payloadSha256: payloadHash(payload),
      payload: { state: 'verified', value: payload }, cannotDecideReason: null, decidedBy: null, decisionComment: null } });
  });

  it('a decided approval names the person who decided it, with their comment', async () => {
    const stored = payloadRows([[{ ...key, stageEntryNo: 2 }, payload]]);
    const res = await harness({ payloads: stored.rows }).call('rita', '/approvals/apr-3');
    expect(res.body.approval).toMatchObject({ status: 'approved', decidedAt: '2026-10-04T10:00:00.000Z', decidedBy: 'Alice Example', decisionComment: 'Looks right.' });
    expect(res.text).not.toContain('pc-user-01');
    expect(res.text).not.toContain('user-alice');
  });

  it('a decider whose name cannot be found is shown as unknown, never as an id', async () => {
    const stored = payloadRows([[{ ...key, stageEntryNo: 2 }, payload]]);
    const res = await harness({ payloads: stored.rows, displayName: async () => null }).call('rita', '/approvals/apr-3');
    expect(res.body.approval.decidedBy).toBeNull();
    expect(res.text).not.toContain('pc-user-01');
  });

  it('no stored payload: state unavailable, no content, cannot decide', async () => {
    const h = harness({ payloads: payloadRows([]).rows });
    const res = await h.call('alice', '/approvals/apr-1');
    expect(res.body.approval).toMatchObject({ payload: { state: 'unavailable' }, canDecide: false, cannotDecideReason: 'payload_unavailable' });
    expect(res.text).not.toMatch(/JANE|DRAFT-TEXT/);
  });

  it('the stored payload is not the one that was hashed: state mismatch, no content, cannot decide', async () => {
    const tampered = payloadRows([[key, { ...payload, letter: 'SOMETHING ELSE ENTIRELY' }]]);
    const res = await harness({ payloads: tampered.rows }).call('alice', '/approvals/apr-1');
    expect(res.body.approval).toMatchObject({ payload: { state: 'mismatch' }, canDecide: false, cannotDecideReason: 'payload_mismatch' });
    expect(res.text).not.toMatch(/JANE|SOMETHING ELSE/);
  });

  it.each([
    ['bob', 'class_not_entitled'], ['carol', 'not_an_approver'], ['rita', 'missing_capability'], ['root', 'no_user_session'],
  ])('%s sees the payload but cannot decide: %s', async (who, reason) => {
    const res = await harness().call(who, '/approvals/apr-1');
    expect(res.body.approval).toMatchObject({ payload: { state: 'verified', value: payload }, canDecide: false, cannotDecideReason: reason });
  });

  it('a decided approval cannot be decided again: not_pending', async () => {
    const stored = payloadRows([[{ ...key, stageEntryNo: 2 }, payload]]);
    const res = await harness({ payloads: stored.rows }).call('alice', '/approvals/apr-3');
    expect(res.body.approval).toMatchObject({ status: 'approved', canDecide: false, cannotDecideReason: 'not_pending' });
  });

  it('an unknown approval and a record that is not a Netzer approval are both 404', async () => {
    const h = harness();
    expect(await h.call('alice', '/approvals/nope')).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await h.call('alice', '/approvals/apr-foreign')).toMatchObject({ status: 404, body: { error: 'not_found' } });
  });
});

describe('GET /inbox', () => {
  it('approvals the caller can decide, blocked cases, and cases the caller holds', async () => {
    const res = await harness().call('alice', '/inbox');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approverSetUp: true, approvals: [{ ...apr1, canDecide: true }], blocked: [summary(CASES[1]!)], mine: [summary(CASES[2]!)] });
  });

  it('says so when the caller is not set up to approve, instead of an empty queue that looks finished', async () => {
    for (const who of ['carol', 'rita', 'root']) expect((await harness().call(who, '/inbox')).body.approverSetUp).toBe(false);
    expect((await harness().call('bob', '/inbox')).body.approverSetUp).toBe(true);
  });

  it('a reader with no shadow row sees blocked cases only', async () => {
    expect((await harness().call('rita', '/inbox')).body).toEqual({ approverSetUp: false, approvals: [], blocked: [summary(CASES[1]!)], mine: [] });
  });
});

describe('a failed read is an error, never an empty list', () => {
  it.each([
    ['paperclip_unavailable', 503], ['paperclip_locked', 503], ['paperclip_ratelimited', 429],
  ] as const)('%s is %i on every list route', async (code, status) => {
    const failing = async () => { throw new WorkReadError(code); };
    const h = harness();
    h.deps.reads.listCases.mockImplementation(failing);
    h.deps.reads.listApprovals.mockImplementation(failing);
    for (const path of ['/inbox', '/cases', '/approvals']) {
      expect(await h.call('alice', path)).toEqual(expect.objectContaining({ status, body: { error: code } }));
    }
  });

  it('the decide route answers 503 when the approval cannot be read', async () => {
    const h = harness();
    h.deps.reads.getApproval.mockImplementation(async () => { throw new WorkReadError('paperclip_unavailable'); });
    expect(await h.decision('alice', 'apr-1', goodBody)).toMatchObject({ status: 503, body: { error: 'paperclip_unavailable' } });
    expect(h.deps.decide).not.toHaveBeenCalled();
  });
});

// ── the decide route ─────────────────────────────────────────────────────────
describe('POST /approvals/:approvalId/decision', () => {
  it('approves as the signed-in user and returns exactly ok, approvalId, decision', async () => {
    const h = harness();
    const res = await h.decision('alice', 'apr-1', goodBody);
    expect(res).toEqual(expect.objectContaining({ status: 200, body: { ok: true, approvalId: 'apr-1', decision: 'approve' } }));
    expect(h.deps.decide).toHaveBeenCalledTimes(1);
    expect(h.deps.decide).toHaveBeenCalledWith({ netzerUserId: 'user-alice', approvalId: 'apr-1', decision: 'approve', comment: undefined });
  });

  it('passes the comment through for reject and request_changes', async () => {
    const h = harness();
    await h.decision('alice', 'apr-1', { ...goodBody, decision: 'reject', comment: 'Wrong clinic.' });
    await h.decision('alice', 'apr-1', { ...goodBody, decision: 'request_changes', comment: 'Fix the date.' });
    expect(h.deps.decide.mock.calls.map(([req]) => req)).toEqual([
      { netzerUserId: 'user-alice', approvalId: 'apr-1', decision: 'reject', comment: 'Wrong clinic.' },
      { netzerUserId: 'user-alice', approvalId: 'apr-1', decision: 'request_changes', comment: 'Fix the date.' },
    ]);
  });

  it('A153: a token with no user session is 403 no_user_session and decide is never called', async () => {
    const h = harness();
    expect(await h.decision('root', 'apr-1', goodBody)).toEqual(expect.objectContaining({ status: 403, body: { error: 'no_user_session' } }));
    expect(h.deps.decide).not.toHaveBeenCalled();
  });

  it('A153: a user id in the body, the query or a header changes nothing', async () => {
    const h = harness();
    const res = await h.call('carol', '/approvals/apr-1/decision?netzerUserId=user-alice&userId=user-alice', {
      method: 'POST', body: { ...goodBody, netzerUserId: 'user-alice', userId: 'user-alice' },
      headers: { 'x-dashboard-user': 'user-alice', 'x-netzer-user-id': 'user-alice' },
    });
    expect(res.status).toBe(200);
    expect(h.deps.decide).toHaveBeenCalledWith(expect.objectContaining({ netzerUserId: 'user-carol' }));
    expect(JSON.stringify(h.deps.decide.mock.calls)).not.toContain('user-alice');

    const none = harness();
    await none.decision('root', 'apr-1', { ...goodBody, netzerUserId: 'user-alice' });
    expect(none.deps.decide).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', '{'], ['no decision', { payloadSha256: payloadHash(payload) }], ['an unknown decision', { ...goodBody, decision: 'escalate' }],
    ['no payloadSha256', { decision: 'approve' }], ['a payloadSha256 that is not a sha256', { decision: 'approve', payloadSha256: 'abc' }],
    ['a comment that is not a string', { ...goodBody, comment: 42 }], ['an array', [goodBody]],
  ])('400 invalid_body: %s', async (_name, body) => {
    const h = harness();
    expect(await h.decision('alice', 'apr-1', body)).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
    expect(h.deps.decide).not.toHaveBeenCalled();
  });

  it('stale: the hash the screen showed is not the approval`s hash', async () => {
    const h = harness();
    const res = await h.decision('alice', 'apr-1', { decision: 'approve', payloadSha256: payloadHash({ ...payload, letter: 'WHAT I SAW' }) });
    expect(res).toEqual(expect.objectContaining({ status: 409, body: { error: 'stale_payload' } }));
    expect(h.deps.decide).not.toHaveBeenCalled();
  });

  it('the stored payload is missing: 409 payload_unavailable, decide is not called', async () => {
    const h = harness({ payloads: payloadRows([]).rows });
    expect(await h.decision('alice', 'apr-1', goodBody)).toEqual(expect.objectContaining({ status: 409, body: { error: 'payload_unavailable' } }));
    expect(h.deps.decide).not.toHaveBeenCalled();
  });

  it('the stored payload is not what was hashed: 409 payload_mismatch, decide is not called', async () => {
    const h = harness({ payloads: payloadRows([[key, { ...payload, letter: 'SOMETHING ELSE ENTIRELY' }]]).rows });
    expect(await h.decision('alice', 'apr-1', goodBody)).toEqual(expect.objectContaining({ status: 409, body: { error: 'payload_mismatch' } }));
    expect(h.deps.decide).not.toHaveBeenCalled();
  });

  it('an unknown approval and a foreign record are 404 and decide is not called', async () => {
    const h = harness();
    expect(await h.decision('alice', 'nope', goodBody)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await h.decision('alice', 'apr-foreign', goodBody)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(h.deps.decide).not.toHaveBeenCalled();
  });

  it.each([
    ['comment_required', 400], ['comment_too_long', 400], ['not_an_approver', 403], ['class_not_entitled', 403], ['approver_inactive', 403],
    ['not_found', 404], ['not_a_netzer_approval', 404], ['not_pending', 409], ['paperclip_unavailable', 503], ['key_unavailable', 503],
  ] as const)('a %s refusal from decide is %i with that code and nothing else', async (code, status) => {
    const h = harness({ decide: vi.fn(async () => { throw new ApprovalRefusedError(code as never); }) });
    expect(await h.decision('alice', 'apr-1', goodBody)).toEqual(expect.objectContaining({ status, body: { error: code } }));
  });

  it('an attribution mismatch is 500 attribution_mismatch', async () => {
    const h = harness({ decide: vi.fn(async () => { throw new ApprovalAttributionError(); }) });
    expect(await h.decision('alice', 'apr-1', goodBody)).toEqual(expect.objectContaining({ status: 500, body: { error: 'attribution_mismatch' } }));
  });

  it('Paperclip refusing the decision (4xx) is 409 paperclip_rejected', async () => {
    const h = harness({ decide: vi.fn(async () => { throw Object.assign(new Error('Paperclip 422: SECRET-DETAIL'), { status: 422 }); }) });
    const res = await h.decision('alice', 'apr-1', goodBody);
    expect(res).toEqual(expect.objectContaining({ status: 409, body: { error: 'paperclip_rejected' } }));
    expect(res.text).not.toContain('SECRET-DETAIL');
  });

  it.each([
    ['a 5xx', Object.assign(new Error('Paperclip 502'), { status: 502 })], ['a timeout', new Error('The operation was aborted')],
  ])('%s after the decision was sent is 503 decision_outcome_unknown, never a plain failure', async (_name, error) => {
    const h = harness({ decide: vi.fn(async () => { throw error; }) });
    expect(await h.decision('alice', 'apr-1', goodBody)).toEqual(expect.objectContaining({ status: 503, body: { error: 'decision_outcome_unknown' } }));
  });

  it('no error body carries the payload or the comment', async () => {
    const h = harness({ decide: vi.fn(async () => { throw new ApprovalRefusedError('not_pending'); }) });
    const res = await h.decision('alice', 'apr-1', { ...goodBody, decision: 'reject', comment: 'COMMENT-TEXT-ABOUT-JANE' });
    expect(res.text).not.toMatch(/JANE|COMMENT-TEXT|DRAFT-TEXT/);
  });
});
