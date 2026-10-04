/**
 * Review-round tests for Work Platform step 6 (written by the coordinator after
 * the five-reviewer fan-out, BEFORE the fixes: each one failed on 79b06d0).
 * They pin what the frozen acceptance tests did not: untrusted registry rows and
 * Paperclip records fail CLOSED, every refusal and mismatch leaves an audit
 * trail, and a comment's hash cannot be guessed across approvals.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  APPROVAL_TYPE, ApprovalAttributionError, ApprovalRefusedError, approvalPayload, createApprovals,
  type ApprovalRecord, type ApprovalsPort,
} from './approvals.js';
import type { EffectKey } from './effect-ledger.js';
import type { ShadowUser } from '../paperclip/shadow-users.js';

const key: EffectKey = { caseKey: 'ref-2026-0001', stage: 'clinical-review', step: 'send_letter', stageEntryNo: 1 };
const payload = { letter: 'DRAFT' };
const CLASS = 'clinical_disposition';
const alice: ShadowUser = { netzerUserId: 'user-alice', slot: '01', paperclipUserId: 'pc-user-01',
  decisionClasses: [CLASS], status: 'active', assignedAt: 1_000 };
const approved = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({ id: 'apr-1', type: APPROVAL_TYPE, status: 'approved',
  payload: approvalPayload(key, payload, CLASS), decidedByUserId: 'pc-user-01', decidedAt: '2026-10-04T10:00:00.000Z', ...over });

function harness(opts: { record?: ApprovalRecord; reverse?: unknown; port?: Partial<ApprovalsPort> } = {}) {
  const record = opts.record ?? approved();
  const port: ApprovalsPort = {
    create: vi.fn(async (body) => ({ id: 'apr-1', type: body.type, status: 'pending', payload: body.payload })),
    get: vi.fn(async () => structuredClone(record)),
    decide: vi.fn(async () => approved()),
    ...opts.port,
  };
  const shadows = {
    getByNetzerUser: vi.fn(async (id: string) => (id === 'user-alice' ? alice : undefined)),
    getByPaperclipUser: vi.fn(async (_id: string) => ('reverse' in opts ? opts.reverse : alice) as ShadowUser | undefined),
  };
  const audit = vi.fn(async (_event: unknown) => {});
  const approvals = createApprovals({ port, shadows, keys: { boardKeyFor: async () => 'pcp_board_slot_01' }, audit, now: () => 5_000 });
  const verify = () => approvals.verifyApproval({ approvalId: 'apr-1', key, payload, decisionClass: CLASS });
  return { port, shadows, audit, approvals, verify };
}
const code = async (promise: Promise<unknown>) => promise.then(() => 'RESOLVED', (error: { code?: string }) => error.code);
const audits = (audit: ReturnType<typeof vi.fn>, action: string) =>
  audit.mock.calls.map(([event]) => event as { action: string; result?: string; userId?: string; detail?: Record<string, unknown> })
    .filter((event) => event.action === action);

describe('verifyApproval fails closed on a registry row it cannot trust', () => {
  it.each([
    ['no status', { ...alice, status: undefined }],
    ['an unknown status', { ...alice, status: 'suspended' }],
    ['a status with the wrong case', { ...alice, status: 'Active' }],
    ['classes that are not a list', { ...alice, decisionClasses: CLASS }],
    ['a class that is not a string', { ...alice, decisionClasses: [CLASS, 7] }],
    ['no Netzer user id', { ...alice, netzerUserId: undefined }],
    ['a row for another Paperclip user', { ...alice, paperclipUserId: 'pc-user-99' }],
    ['a retired row with no retirement time', { ...alice, status: 'retired' }],
  ])('a shadow row with %s never counts as an approver', async (_name, reverse) => {
    const h = harness({ reverse });
    expect(['not_a_shadow_user', 'approver_retired']).toContain(await code(h.verify()));
  });

  it.each([
    ['a list', ['pc-user-01']],
    ['a number', 42],
    ['an object', { id: 'pc-user-01' }],
    ['true', true],
  ])('a decider that is %s is not_a_shadow_user and is never looked up', async (_name, decider) => {
    const h = harness({ record: approved({ decidedByUserId: decider as unknown as string }) });
    expect(await code(h.verify())).toBe('not_a_shadow_user');
    expect(h.shadows.getByPaperclipUser).not.toHaveBeenCalled();
  });

  it('a record that answers under another approval id is not_found', async () => {
    const h = harness({ record: approved({ id: 'apr-2' }) });
    expect(await code(h.verify())).toBe('not_found');
  });
});

describe('decide leaves a trail for every outcome', () => {
  const decide = (h: ReturnType<typeof harness>, comment?: string) =>
    h.approvals.decide({ netzerUserId: 'user-alice', approvalId: 'apr-1', decision: comment ? 'reject' : 'approve', comment });
  const pending = { record: approved({ status: 'pending', decidedByUserId: null, decidedAt: null }) };

  it('an attribution mismatch is audited as an error before it throws', async () => {
    const h = harness({ ...pending, port: { decide: vi.fn(async () => approved({ decidedByUserId: 'pc-operator' })) } });
    await expect(decide(h)).rejects.toBeInstanceOf(ApprovalAttributionError);
    // The frozen acceptance test forbids an `approval_decided` row here, so the trail is an `approval_refused` error row.
    expect(audits(h.audit, 'approval_decided')).toHaveLength(0);
    const rows = audits(h.audit, 'approval_refused');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 'user-alice', result: 'error' });
    expect(rows[0]?.detail).toMatchObject({ approvalId: 'apr-1', code: 'attribution_mismatch', shadowUserId: 'pc-user-01' });
    expect(JSON.stringify(rows)).not.toContain('pc-operator');
  });

  it('a Paperclip read failure is a refusal (paperclip_unavailable), with nothing sent', async () => {
    const h = harness({ port: { get: vi.fn(async () => { throw new Error('ECONNREFUSED 10.0.0.7 secret-looking-text'); }) } });
    const promise = decide(h);
    await expect(promise).rejects.toBeInstanceOf(ApprovalRefusedError);
    expect(await code(promise)).toBe('paperclip_unavailable');
    expect(h.port.decide).not.toHaveBeenCalled();
  });

  it('a Paperclip refusal of the decision (a revoked key, a lost race) is audited and rethrown', async () => {
    const rejected = Object.assign(new Error('Paperclip approval request failed (HTTP 401)'), { status: 401 });
    const h = harness({ ...pending, port: { decide: vi.fn(async () => { throw rejected; }) } });
    await expect(decide(h)).rejects.toBe(rejected);
    expect(audits(h.audit, 'approval_refused').at(-1)?.detail).toMatchObject({ approvalId: 'apr-1', code: 'paperclip_rejected' });
    expect(audits(h.audit, 'approval_decided')).toHaveLength(0);
  });
  it.each([new Error('timeout'), Object.assign(new Error('service unavailable'), { status: 503 })])
  ('an unknown decision outcome is audited as an error and rethrown', async (failure) => {
    const h = harness({ ...pending, port: { decide: vi.fn(async () => { throw failure; }) } });
    await expect(decide(h)).rejects.toBe(failure);
    expect(audits(h.audit, 'approval_refused').at(-1)).toMatchObject({ result: 'error',
      detail: { approvalId: 'apr-1', code: 'decision_outcome_unknown' } });
    expect(audits(h.audit, 'approval_decided')).toHaveLength(0);
  });

  it('refuses a board key with a control character before sending', async () => {
    const h = harness(pending);
    const approvals = createApprovals({ port: h.port, shadows: h.shadows, audit: h.audit, now: () => 5_000,
      keys: { boardKeyFor: async () => 'pcp_board_x\n' } });
    const promise = approvals.decide({ netzerUserId: 'user-alice', approvalId: 'apr-1', decision: 'approve' });
    expect(await code(promise)).toBe('key_unavailable');
    expect(h.port.decide).not.toHaveBeenCalled();
  });

  it('a key that cannot be read is a refusal (key_unavailable), with nothing sent', async () => {
    const h = harness(pending);
    const approvals = createApprovals({ port: h.port, shadows: h.shadows, audit: h.audit, now: () => 5_000,
      keys: { boardKeyFor: async () => { throw new Error('Shadow key unavailable for slot 01'); } } });
    const promise = approvals.decide({ netzerUserId: 'user-alice', approvalId: 'apr-1', decision: 'approve' });
    await expect(promise).rejects.toBeInstanceOf(ApprovalRefusedError);
    expect(await code(promise)).toBe('key_unavailable');
    expect(h.port.decide).not.toHaveBeenCalled();
  });

  it('the same comment on two approvals has two different hashes', async () => {
    const hashOf = async (approvalId: string) => {
      const h = harness({ record: approved({ id: approvalId, status: 'pending', decidedByUserId: null, decidedAt: null }),
        port: { decide: vi.fn(async () => approved({ id: approvalId, status: 'rejected' })) } });
      await h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision: 'reject', comment: 'no' });
      return audits(h.audit, 'approval_decided')[0]?.detail?.commentSha256;
    };
    const [a, b] = [await hashOf('apr-1'), await hashOf('apr-2')];
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('requestApproval trusts nothing Paperclip returns', () => {
  it.each([undefined, '', 42, null])('a created record whose id is %j is an error and is not audited as requested', async (id) => {
    const h = harness({ port: { create: vi.fn(async () => ({ id, type: APPROVAL_TYPE, status: 'pending', payload: {} }) as unknown as ApprovalRecord) } });
    await expect(h.approvals.requestApproval({ key, payload, decisionClass: CLASS })).rejects.toThrow();
    expect(audits(h.audit, 'approval_requested')).toHaveLength(0);
  });
});
