/**
 * FROZEN acceptance tests for Work Platform step 6 (ADR 0016, human decisions
 * through shadow users). Written by the coordinator BEFORE any production code.
 * Do not edit without the owner's yes: the step gate pins this file's sha256.
 * Add your own tests in other files.
 *
 * The roadmap's three named proofs:
 *   1. the Paperclip record names the real person,
 *   2. a payload change invalidates the approval,
 *   3. an operator approval is rejected.
 *
 * The record (ONE-WAY, owner 2026-10-04): a Paperclip classic approval of type
 * `request_board_approval` whose payload is exactly
 *   { netzerApproval: 1, payloadSha256, caseKey, stage, step, stageEntryNo, decisionClass }.
 * Paperclip neither binds the hash nor requires a comment (ledger A86), so both
 * rules are Netzer's and are pinned here.
 *
 * The fakes below are the whole contract: `ApprovalsPort` (Paperclip's three
 * approval calls), the two registry reads and the key store. `createApprovals`
 * and the step 5 executor are the real ones. Nothing here touches AWS or a real
 * Paperclip.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  APPROVAL_TYPE,
  ApprovalAttributionError,
  ApprovalInvalidError,
  ApprovalRefusedError,
  approvalPayload,
  createApprovals,
  gateFor,
  requiresHumanApproval,
  type ApprovalRecord,
  type ApprovalsPort,
} from './approvals.js';
import { createExecutor, payloadHash, InvalidEffectKeyError } from './executor.js';
import type { DraftRow, EffectKey, EffectRow, EffectRows } from './effect-ledger.js';
import type { ShadowUser } from '../paperclip/shadow-users.js';

const key: EffectKey = { caseKey: 'ref-2026-0001', stage: 'clinical-review', step: 'send_letter', stageEntryNo: 1 };
const payload = { patient: 'PATIENT-JANE-DOE', letter: 'DRAFT-TEXT-ABOUT-JANE', slot: '2026-10-05T09:00' };
const CLASS = 'clinical_disposition';
const fence = async () => {};

const alice: ShadowUser = { netzerUserId: 'user-alice', slot: '01', paperclipUserId: 'pc-user-01',
  decisionClasses: [CLASS], status: 'active', assignedAt: 1_000 };
const bob: ShadowUser = { netzerUserId: 'user-bob', slot: '02', paperclipUserId: 'pc-user-02',
  decisionClasses: ['billing_adjustment'], status: 'active', assignedAt: 1_000 };

/** Who Paperclip believes holds each board key. Operators and inert pool slots hold keys too. */
const KEY_OWNERS: Record<string, string> = {
  'pcp_board_slot_01': 'pc-user-01',
  'pcp_board_slot_02': 'pc-user-02',
  'pcp_board_operator': 'pc-operator',
  'pcp_board_instance_admin': 'pc-instance-admin',
  'pcp_board_lock_auditor': 'pc-lock-auditor',
  'pcp_board_unassigned_slot_07': 'pc-user-07',
};

function fakePaperclip(over: Partial<ApprovalsPort> = {}) {
  const records = new Map<string, ApprovalRecord & { decisionNote?: string | null }>();
  let clock = Date.parse('2026-10-04T10:00:00.000Z');
  let seq = 0;
  const port: ApprovalsPort = {
    create: vi.fn(async (body) => {
      const record = { id: `apr-${++seq}`, type: body.type, status: 'pending', payload: structuredClone(body.payload),
        decidedByUserId: null, decidedAt: null };
      records.set(record.id, record);
      return structuredClone(record);
    }),
    get: vi.fn(async (approvalId) => { const row = records.get(approvalId); return row && structuredClone(row); }),
    decide: vi.fn(async (approvalId, verb, decisionNote, boardKey) => {
      const row = records.get(approvalId);
      const owner = KEY_OWNERS[boardKey];
      if (!row || !owner) throw new Error('paperclip 404');
      if (row.status !== 'pending') throw new Error('paperclip 422');
      const status = verb === 'approve' ? 'approved' : verb === 'reject' ? 'rejected' : 'revision_requested';
      const next = { ...row, status, decidedByUserId: owner, decidedAt: new Date(clock).toISOString(), decisionNote };
      records.set(approvalId, next);
      return structuredClone(next);
    }),
    ...over,
  };
  return { port, records, setClock: (iso: string) => { clock = Date.parse(iso); } };
}

function harness(opts: { shadows?: ShadowUser[]; port?: Partial<ApprovalsPort>; audit?: (event: unknown) => Promise<void> } = {}) {
  const paperclip = fakePaperclip(opts.port);
  const people = opts.shadows ?? [alice, bob];
  const shadows = {
    getByNetzerUser: vi.fn(async (id: string) => people.find((p) => p.netzerUserId === id)),
    getByPaperclipUser: vi.fn(async (id: string) => people.find((p) => p.paperclipUserId === id)),
  };
  const keys = { boardKeyFor: vi.fn(async (slot: string) => `pcp_board_slot_${slot}`) };
  const audit = vi.fn(opts.audit ?? (async (_event: unknown) => {}));
  const approvals = createApprovals({ port: paperclip.port, shadows, keys, audit, now: () => 5_000 });
  return { ...paperclip, shadows, keys, audit, approvals };
}

const actions = (audit: ReturnType<typeof vi.fn>) => audit.mock.calls.map(([event]) => (event as { action: string }).action);
const lastAudit = (audit: ReturnType<typeof vi.fn>, action: string) =>
  audit.mock.calls.map(([event]) => event as { action: string; userId?: string; result?: string; detail?: Record<string, unknown> })
    .filter((event) => event.action === action).at(-1);

async function requested(h: ReturnType<typeof harness>, over: { key?: EffectKey; payload?: unknown; decisionClass?: string } = {}) {
  return h.approvals.requestApproval({ key: over.key ?? key, payload: over.payload ?? payload, decisionClass: over.decisionClass ?? CLASS });
}
async function approvedByAlice(h: ReturnType<typeof harness>) {
  const { approvalId } = await requested(h);
  await h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision: 'approve' });
  return approvalId;
}
const code = async (promise: Promise<unknown>) => promise.then(() => 'RESOLVED', (error: { code?: string }) => error.code);

describe('the approval record (frozen shape)', () => {
  it('approvalPayload is exactly the seven fields, with the step 5 payload hash', () => {
    expect(APPROVAL_TYPE).toBe('request_board_approval');
    expect(approvalPayload(key, payload, CLASS)).toEqual({
      netzerApproval: 1, payloadSha256: payloadHash(payload), caseKey: 'ref-2026-0001',
      stage: 'clinical-review', step: 'send_letter', stageEntryNo: 1, decisionClass: CLASS,
    });
  });

  it('requestApproval creates one Paperclip approval that carries the hash and never the payload', async () => {
    const h = harness();
    const result = await requested(h);
    expect(result).toEqual({ approvalId: 'apr-1', payloadSha256: payloadHash(payload) });
    expect(h.port.create).toHaveBeenCalledTimes(1);
    expect(h.port.create).toHaveBeenCalledWith({ type: 'request_board_approval', payload: approvalPayload(key, payload, CLASS) });
    expect(JSON.stringify(vi.mocked(h.port.create).mock.calls)).not.toContain('JANE');
  });

  it('requestApproval audits approval_requested with IDs and the hash only', async () => {
    const h = harness();
    await requested(h);
    expect(lastAudit(h.audit, 'approval_requested')?.detail).toMatchObject({
      approvalId: 'apr-1', payloadSha256: payloadHash(payload), caseKey: key.caseKey, stage: key.stage,
      step: key.step, stageEntryNo: 1, decisionClass: CLASS,
    });
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('JANE');
  });

  it.each([
    ['a stage with a #', { ...key, stage: 'a#b' }],
    ['round 0', { ...key, stageEntryNo: 0 }],
    ['an empty case key', { ...key, caseKey: '' }],
  ])('refuses %s before any Paperclip call', async (_name, badKey) => {
    const h = harness();
    await expect(requested(h, { key: badKey })).rejects.toBeInstanceOf(InvalidEffectKeyError);
    expect(h.port.create).not.toHaveBeenCalled();
  });

  it.each(['', 'Clinical', '9lives', 'a-b', 'a b'])('refuses the decision class id %j before any Paperclip call', async (decisionClass) => {
    const h = harness();
    await expect(requested(h, { decisionClass })).rejects.toThrow();
    expect(h.port.create).not.toHaveBeenCalled();
  });
});

describe('proof 1: the Paperclip record names the real person', () => {
  it('Approve is sent with that person`s own board key and Paperclip records their shadow user', async () => {
    const h = harness();
    const { approvalId } = await requested(h);
    const result = await h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision: 'approve' });
    expect(result).toEqual({ approvalId, decision: 'approve', shadowUserId: 'pc-user-01' });
    expect(h.keys.boardKeyFor).toHaveBeenCalledWith('01');
    expect(h.port.decide).toHaveBeenCalledTimes(1);
    expect(h.port.decide).toHaveBeenCalledWith(approvalId, 'approve', null, 'pcp_board_slot_01');
    expect(h.records.get(approvalId)).toMatchObject({ status: 'approved', decidedByUserId: 'pc-user-01' });
  });

  it('the audit row links the Netzer user, the shadow user, the class and the hash', async () => {
    const h = harness();
    const approvalId = await approvedByAlice(h);
    const row = lastAudit(h.audit, 'approval_decided');
    expect(row).toMatchObject({ userId: 'user-alice', result: 'ok' });
    expect(row?.detail).toMatchObject({
      approvalId, shadowUserId: 'pc-user-01', slot: '01', decisionClass: CLASS, decision: 'approve',
      payloadSha256: payloadHash(payload), caseKey: key.caseKey, stage: key.stage, step: key.step, stageEntryNo: 1,
    });
  });

  it('Reject carries the trimmed comment to Paperclip as the decision note', async () => {
    const h = harness();
    const { approvalId } = await requested(h);
    await h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision: 'reject', comment: '  wrong clinic  ' });
    expect(h.port.decide).toHaveBeenCalledWith(approvalId, 'reject', 'wrong clinic', 'pcp_board_slot_01');
    expect(h.records.get(approvalId)?.status).toBe('rejected');
  });

  it('Request Changes uses Paperclip`s request-revision verb', async () => {
    const h = harness();
    const { approvalId } = await requested(h);
    await h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision: 'request_changes', comment: 'fix the date' });
    expect(h.port.decide).toHaveBeenCalledWith(approvalId, 'request-revision', 'fix the date', 'pcp_board_slot_01');
    expect(lastAudit(h.audit, 'approval_decided')?.detail).toMatchObject({ decision: 'request_changes' });
  });

  it('Approve needs no comment (owner 2026-10-04, A74) and keeps one when given', async () => {
    const h = harness();
    const first = await requested(h);
    await h.approvals.decide({ netzerUserId: 'user-alice', approvalId: first.approvalId, decision: 'approve', comment: '   ' });
    expect(h.port.decide).toHaveBeenLastCalledWith(first.approvalId, 'approve', null, 'pcp_board_slot_01');
    const second = await requested(h, { key: { ...key, stageEntryNo: 2 } });
    await h.approvals.decide({ netzerUserId: 'user-alice', approvalId: second.approvalId, decision: 'approve', comment: 'looks right' });
    expect(h.port.decide).toHaveBeenLastCalledWith(second.approvalId, 'approve', 'looks right', 'pcp_board_slot_01');
  });

  it('fails loudly when Paperclip attributes the decision to someone else', async () => {
    const h = harness({ port: {
      decide: vi.fn(async (approvalId) => ({ id: approvalId, type: APPROVAL_TYPE, status: 'approved',
        payload: approvalPayload(key, payload, CLASS), decidedByUserId: 'pc-operator', decidedAt: '2026-10-04T10:00:00.000Z' })),
    } });
    const { approvalId } = await requested(h);
    await expect(h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision: 'approve' }))
      .rejects.toBeInstanceOf(ApprovalAttributionError);
    expect(actions(h.audit)).not.toContain('approval_decided');
  });

  it('a comment never reaches an audit row; only its sha256 does', async () => {
    const h = harness();
    const { approvalId } = await requested(h);
    await h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision: 'reject', comment: 'PATIENT-JANE-DOE has moved' });
    const text = JSON.stringify(h.audit.mock.calls);
    expect(text).not.toContain('JANE');
    expect(text).not.toContain('pcp_board_');
    expect(lastAudit(h.audit, 'approval_decided')?.detail?.commentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a failed audit fails the call; the Paperclip decision stands', async () => {
    const h = harness({ audit: async (event) => {
      if ((event as { action: string }).action === 'approval_decided') throw new Error('audit store down');
    } });
    const { approvalId } = await requested(h);
    await expect(h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision: 'approve' })).rejects.toThrow();
    expect(h.records.get(approvalId)).toMatchObject({ status: 'approved', decidedByUserId: 'pc-user-01' });
  });
});

describe('decide refuses before any Paperclip write', () => {
  async function refused(h: ReturnType<typeof harness>, input: Parameters<ReturnType<typeof harness>['approvals']['decide']>[0], expected: string) {
    const promise = h.approvals.decide(input);
    await expect(promise).rejects.toBeInstanceOf(ApprovalRefusedError);
    expect(await code(promise)).toBe(expected);
    expect(h.port.decide).not.toHaveBeenCalled();
    expect(lastAudit(h.audit, 'approval_refused')?.detail).toMatchObject({ code: expected });
  }

  it.each([
    ['reject', undefined], ['reject', ''], ['reject', '   \n\t '],
    ['request_changes', undefined], ['request_changes', ' '],
  ] as const)('%s without a real comment (%j) is comment_required', async (decision, comment) => {
    const h = harness();
    const { approvalId } = await requested(h);
    await refused(h, { netzerUserId: 'user-alice', approvalId, decision, comment }, 'comment_required');
  });

  it('a comment over 4 000 characters is comment_too_long', async () => {
    const h = harness();
    const { approvalId } = await requested(h);
    await refused(h, { netzerUserId: 'user-alice', approvalId, decision: 'reject', comment: 'x'.repeat(4_001) }, 'comment_too_long');
  });

  it('a Netzer user with no shadow user is not_an_approver', async () => {
    const h = harness();
    const { approvalId } = await requested(h);
    await refused(h, { netzerUserId: 'user-nobody', approvalId, decision: 'approve' }, 'not_an_approver');
    expect(h.keys.boardKeyFor).not.toHaveBeenCalled();
  });

  it('a retired approver is not_an_approver', async () => {
    const h = harness({ shadows: [{ ...alice, status: 'retired', retiredAt: 2_000 }] });
    const { approvalId } = await requested(h);
    await refused(h, { netzerUserId: 'user-alice', approvalId, decision: 'approve' }, 'not_an_approver');
  });

  it('an unknown approval is not_found', async () => {
    const h = harness();
    await refused(h, { netzerUserId: 'user-alice', approvalId: 'apr-404', decision: 'approve' }, 'not_found');
  });

  it.each([
    ['another approval type', (r: ApprovalRecord) => ({ ...r, type: 'hire_agent' })],
    ['an extra payload field', (r: ApprovalRecord) => ({ ...r, payload: { ...(r.payload as object), note: 'x' } })],
    ['a newer record version', (r: ApprovalRecord) => ({ ...r, payload: { ...(r.payload as object), netzerApproval: 2 } })],
    ['a hash that is not 64 hex characters', (r: ApprovalRecord) => ({ ...r, payload: { ...(r.payload as object), payloadSha256: 'abc' } })],
    ['a payload that is not an object', (r: ApprovalRecord) => ({ ...r, payload: 'approved' })],
  ])('%s is not_a_netzer_approval', async (_name, tamper) => {
    const h = harness();
    const { approvalId } = await requested(h);
    h.records.set(approvalId, tamper(h.records.get(approvalId)!));
    await refused(h, { netzerUserId: 'user-alice', approvalId, decision: 'approve' }, 'not_a_netzer_approval');
  });

  it('a second decision on a decided approval is not_pending', async () => {
    const h = harness();
    const approvalId = await approvedByAlice(h);
    vi.mocked(h.port.decide).mockClear();
    await refused(h, { netzerUserId: 'user-alice', approvalId, decision: 'reject', comment: 'changed my mind' }, 'not_pending');
  });

  it('an approver who does not hold the decision class is class_not_entitled', async () => {
    const h = harness();
    const { approvalId } = await requested(h);
    await refused(h, { netzerUserId: 'user-bob', approvalId, decision: 'approve' }, 'class_not_entitled');
  });

  it('a failing audit store never hides the refusal', async () => {
    const h = harness({ audit: async () => { throw new Error('audit store down'); } });
    const created = await h.port.create({ type: APPROVAL_TYPE, payload: approvalPayload(key, payload, CLASS) });
    const promise = h.approvals.decide({ netzerUserId: 'user-bob', approvalId: created.id, decision: 'approve' });
    await expect(promise).rejects.toBeInstanceOf(ApprovalRefusedError);
    expect(await code(promise)).toBe('class_not_entitled');
  });
});

describe('proof 2: a payload change invalidates the approval', () => {
  const verify = (h: ReturnType<typeof harness>, approvalId: string, over: { key?: EffectKey; payload?: unknown; decisionClass?: string } = {}) =>
    h.approvals.verifyApproval({ approvalId, key: over.key ?? key, payload: over.payload ?? payload, decisionClass: over.decisionClass ?? CLASS });

  it('the exact approved payload verifies and names the Netzer user', async () => {
    const h = harness();
    const approvalId = await approvedByAlice(h);
    expect(await verify(h, approvalId)).toEqual({
      approvalId, netzerUserId: 'user-alice', shadowUserId: 'pc-user-01', decidedAt: '2026-10-04T10:00:00.000Z',
    });
  });

  it('the same payload with its keys in another order still verifies (canonical hash)', async () => {
    const h = harness();
    const approvalId = await approvedByAlice(h);
    const reordered = { slot: payload.slot, letter: payload.letter, patient: payload.patient };
    await expect(verify(h, approvalId, { payload: reordered })).resolves.toMatchObject({ netzerUserId: 'user-alice' });
  });

  it.each([
    ['one character changed', { ...payload, letter: 'DRAFT-TEXT-ABOUT-JANe' }],
    ['a field added', { ...payload, cc: 'someone' }],
    ['a field removed', { patient: payload.patient, slot: payload.slot }],
    ['a different type', 'DRAFT-TEXT-ABOUT-JANE'],
  ])('%s is hash_mismatch', async (_name, changed) => {
    const h = harness();
    const approvalId = await approvedByAlice(h);
    const promise = verify(h, approvalId, { payload: changed });
    await expect(promise).rejects.toBeInstanceOf(ApprovalInvalidError);
    expect(await code(promise)).toBe('hash_mismatch');
  });

  it.each([
    ['another case', { ...key, caseKey: 'ref-2026-0002' }],
    ['another stage', { ...key, stage: 'intake' }],
    ['another step', { ...key, step: 'send_fax' }],
    ['another round', { ...key, stageEntryNo: 2 }],
  ])('an approval for %s is key_mismatch', async (_name, otherKey) => {
    const h = harness();
    const approvalId = await approvedByAlice(h);
    expect(await code(verify(h, approvalId, { key: otherKey }))).toBe('key_mismatch');
  });

  it('an approval of another decision class is class_mismatch', async () => {
    const h = harness();
    const approvalId = await approvedByAlice(h);
    expect(await code(verify(h, approvalId, { decisionClass: 'billing_adjustment' }))).toBe('class_mismatch');
  });

  it.each([
    ['pending', undefined],
    ['rejected', 'reject'],
    ['revision requested', 'request_changes'],
  ] as const)('a %s approval is not_approved', async (_name, decision) => {
    const h = harness();
    const { approvalId } = await requested(h);
    if (decision) await h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision, comment: 'no' });
    expect(await code(verify(h, approvalId))).toBe('not_approved');
  });

  it('reads Paperclip live on every check, never a cached answer', async () => {
    const h = harness();
    const approvalId = await approvedByAlice(h);
    vi.mocked(h.port.get).mockClear();
    await verify(h, approvalId);
    await verify(h, approvalId);
    expect(h.port.get).toHaveBeenCalledTimes(2);
    h.records.set(approvalId, { ...h.records.get(approvalId)!, status: 'cancelled' });
    expect(await code(verify(h, approvalId))).toBe('not_approved');
  });

  it('an unknown approval is not_found and Paperclip being down is paperclip_unavailable', async () => {
    const h = harness();
    expect(await code(verify(h, 'apr-404'))).toBe('not_found');
    const down = harness({ port: { get: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) } });
    expect(await code(verify(down, 'apr-1'))).toBe('paperclip_unavailable');
  });

  it('runApprovedEffect writes once for the approved payload and nothing for a changed one', async () => {
    const h = harness();
    const approvalId = await approvedByAlice(h);
    const store = memoryRows();
    const executor = createExecutor({ rows: store.rows, isDraining: () => false, audit: async () => {}, now: () => 1_000 });
    const apply = vi.fn(async () => ({ sent: true }));

    const changed = h.approvals.runApprovedEffect(executor, { approvalId, decisionClass: CLASS, key, fence, apply,
      payload: { ...payload, letter: 'A DIFFERENT LETTER' } });
    await expect(changed).rejects.toBeInstanceOf(ApprovalInvalidError);
    expect(apply).not.toHaveBeenCalled();
    expect(store.effects.size).toBe(0);

    expect(await h.approvals.runApprovedEffect(executor, { approvalId, decisionClass: CLASS, key, payload, fence, apply }))
      .toEqual({ sent: true });
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe('proof 3: an operator approval is rejected', () => {
  async function decidedDirectlyInPaperclip(boardKey: string) {
    const h = harness();
    const { approvalId } = await requested(h);
    // Someone uses the Paperclip screens (or API) directly, outside Netzer.
    await h.port.decide(approvalId, 'approve', null, boardKey);
    return { h, approvalId };
  }
  const verify = (h: ReturnType<typeof harness>, approvalId: string) =>
    h.approvals.verifyApproval({ approvalId, key, payload, decisionClass: CLASS });

  it.each([
    ['the operator', 'pcp_board_operator'],
    ['the instance admin', 'pcp_board_instance_admin'],
    ['the lock auditor', 'pcp_board_lock_auditor'],
    ['an unassigned pool slot', 'pcp_board_unassigned_slot_07'],
  ])('an approval decided by %s is not_a_shadow_user', async (_name, boardKey) => {
    const { h, approvalId } = await decidedDirectlyInPaperclip(boardKey);
    expect(h.records.get(approvalId)?.status).toBe('approved');
    const promise = verify(h, approvalId);
    await expect(promise).rejects.toBeInstanceOf(ApprovalInvalidError);
    expect(await code(promise)).toBe('not_a_shadow_user');
  });

  it.each([null, undefined, ''])('an approved record with the decider %j is not_a_shadow_user', async (decider) => {
    const h = harness();
    const { approvalId } = await requested(h);
    h.records.set(approvalId, { ...h.records.get(approvalId)!, status: 'approved', decidedByUserId: decider, decidedAt: '2026-10-04T10:00:00.000Z' });
    expect(await code(verify(h, approvalId))).toBe('not_a_shadow_user');
  });

  it('an operator approval never lets the write run', async () => {
    const { h, approvalId } = await decidedDirectlyInPaperclip('pcp_board_operator');
    const store = memoryRows();
    const executor = createExecutor({ rows: store.rows, isDraining: () => false, audit: async () => {}, now: () => 1_000 });
    const apply = vi.fn(async () => ({ sent: true }));
    await expect(h.approvals.runApprovedEffect(executor, { approvalId, decisionClass: CLASS, key, payload, fence, apply }))
      .rejects.toBeInstanceOf(ApprovalInvalidError);
    expect(apply).not.toHaveBeenCalled();
    expect(store.effects.size).toBe(0);
  });

  it('a real approver who does not hold the class, deciding directly in Paperclip, is class_not_entitled', async () => {
    const { h, approvalId } = await decidedDirectlyInPaperclip('pcp_board_slot_02');
    expect(await code(verify(h, approvalId))).toBe('class_not_entitled');
  });

  it('a decision made before the approver retired still counts; one made after does not', async () => {
    const retiredAt = Date.parse('2026-10-04T12:00:00.000Z');
    const retiredAlice: ShadowUser = { ...alice, status: 'retired', retiredAt };

    const before = harness();
    const early = await approvedByAlice(before);
    vi.mocked(before.shadows.getByPaperclipUser).mockResolvedValue(retiredAlice);
    await expect(verify(before, early)).resolves.toMatchObject({ netzerUserId: 'user-alice' });

    const after = harness({ shadows: [retiredAlice, bob] });
    const { approvalId } = await requested(after);
    after.setClock('2026-10-04T13:00:00.000Z');
    await after.port.decide(approvalId, 'approve', null, 'pcp_board_slot_01'); // a leaked key, used after retirement
    expect(await code(verify(after, approvalId))).toBe('approver_retired');
  });

  it('a retired approver`s decision with no readable time is approver_retired', async () => {
    const h = harness({ shadows: [{ ...alice, status: 'retired', retiredAt: 2_000 }] });
    const { approvalId } = await requested(h);
    h.records.set(approvalId, { ...h.records.get(approvalId)!, status: 'approved', decidedByUserId: 'pc-user-01', decidedAt: 'not a date' });
    expect(await code(verify(h, approvalId))).toBe('approver_retired');
  });
});

describe('decision classes: high-impact decisions are human by default', () => {
  const classes = [
    { id: 'clinical_disposition', impact: 'high', default: 'human_required' },
    { id: 'reminder_text', impact: 'standard', default: 'automated_allowed' },
    { id: 'refund', impact: 'standard', default: 'human_required' },
  ] as const;

  it('a human_required class needs a human', () => {
    expect(requiresHumanApproval(classes, 'clinical_disposition')).toBe(true);
    expect(requiresHumanApproval(classes, 'refund')).toBe(true);
  });
  it('an automated_allowed class does not', () => {
    expect(requiresHumanApproval(classes, 'reminder_text')).toBe(false);
  });
  it('a class the pack never declared needs a human (fails closed)', () => {
    expect(requiresHumanApproval(classes, 'made_up')).toBe(true);
    expect(requiresHumanApproval([], 'clinical_disposition')).toBe(true);
  });
  it('only the customer`s recorded exception for that exact class lifts the rule', () => {
    expect(requiresHumanApproval(classes, 'clinical_disposition', ['clinical_disposition'])).toBe(false);
    expect(requiresHumanApproval(classes, 'clinical_disposition', ['refund'])).toBe(true);
    expect(requiresHumanApproval(classes, 'made_up', ['made_up'])).toBe(true);
  });

  const policies = { toolRisk: {}, approvalGates: [{ pipeline: 'referral', stage: 'clinical-review', decisionClass: 'clinical_disposition' }] };
  it('gateFor returns the class bound to a pipeline stage, and nothing for an ungated stage', () => {
    expect(gateFor(policies, 'referral', 'clinical-review')).toBe('clinical_disposition');
    expect(gateFor(policies, 'referral', 'intake')).toBeUndefined();
    expect(gateFor(policies, 'other', 'clinical-review')).toBeUndefined();
  });
});

const rowId = (k: EffectKey) => `${k.caseKey}|${k.stage}|${k.step}|${k.stageEntryNo}`;
function memoryRows() {
  const effects = new Map<string, EffectRow>();
  const drafts = new Map<string, DraftRow>();
  const rows: EffectRows = {
    get: async (k) => { const row = effects.get(rowId(k)); return row && structuredClone(row); },
    create: async (row) => { if (effects.has(rowId(row.key))) return false; effects.set(rowId(row.key), structuredClone(row)); return true; },
    replace: async (k, expectedVersion, next) => {
      if (effects.get(rowId(k))?.version !== expectedVersion) return false;
      effects.set(rowId(k), structuredClone(next)); return true;
    },
    listUnknown: async () => [...effects.values()].filter((row) => row.state === 'unknown'),
    getDraft: async (k) => drafts.get(rowId(k)),
    createDraft: async (row) => { if (drafts.has(rowId(row.key))) return false; drafts.set(rowId(row.key), row); return true; },
  };
  return { rows, effects, drafts };
}
