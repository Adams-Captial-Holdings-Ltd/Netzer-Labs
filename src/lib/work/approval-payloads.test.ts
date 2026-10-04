/**
 * FROZEN acceptance tests for Work Platform step 7: the payload row and the two
 * approver checks of ledger A155. Written by the coordinator BEFORE any
 * production code. Do not edit without the owner's yes: the step gate pins this
 * file. Add your own tests in other files.
 *
 * The payload row (ONE-WAY, owner 2026-10-04 "Yes, add the row kind"): the
 * effect-ledger table, PK `CASE#<caseKey>`, SK `PAYLOAD#<stage>#<step>#<stageEntryNo>`,
 * item `{ kind: 'payload', key, json, payloadSha256, createdAt, version: 1 }`
 * where `json` is the canonical JSON string that `payloadHash` hashes. A screen
 * may show the content only when sha256(json), the row's hash and the
 * approval's hash are all the same value.
 *
 * Nothing here touches AWS or a real Paperclip.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  payloadJson, payloadSortKey, readApprovalPayload, savePayloadOnce,
  type PayloadRow, type PayloadRows,
} from './approval-payloads.js';
import {
  ApprovalInvalidError, ApprovalRefusedError, approvalPayload, createApprovals,
  type ApprovalRecord, type ApprovalsPort,
} from './approvals.js';
import { EffectConflictError, payloadHash } from './executor.js';
import type { EffectKey } from './effect-ledger.js';
import type { ShadowUser } from '../paperclip/shadow-users.js';

const key: EffectKey = { caseKey: 'ref-2026-0001', stage: 'clinical-review', step: 'send_letter', stageEntryNo: 1 };
const payload = { patient: 'PATIENT-JANE-DOE', letter: 'DRAFT-TEXT-ABOUT-JANE', slot: '2026-10-05T09:00' };
const CLASS = 'clinical_disposition';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const sk = (k: EffectKey) => `${k.caseKey}|${payloadSortKey(k)}`;

function memoryRows() {
  const items = new Map<string, PayloadRow>();
  const rows: PayloadRows = {
    get: vi.fn(async (k: EffectKey) => { const row = items.get(sk(k)); return row && structuredClone(row); }),
    create: vi.fn(async (row: PayloadRow) => {
      if (items.has(sk(row.key))) return false;
      items.set(sk(row.key), structuredClone(row));
      return true;
    }),
  };
  return { rows, items };
}
const approvalOf = (k: EffectKey, p: unknown) => approvalPayload(k, p, CLASS);

describe('the payload row (frozen shape)', () => {
  it('the sort key is PAYLOAD#<stage>#<step>#<stageEntryNo>', () => {
    expect(payloadSortKey(key)).toBe('PAYLOAD#clinical-review#send_letter#1');
    expect(payloadSortKey({ ...key, stageEntryNo: 3 })).toBe('PAYLOAD#clinical-review#send_letter#3');
  });

  it('payloadJson is the exact string payloadHash hashes, whatever the key order', () => {
    expect(sha(payloadJson(payload))).toBe(payloadHash(payload));
    const reordered = { slot: payload.slot, letter: payload.letter, patient: payload.patient };
    expect(payloadJson(reordered)).toBe(payloadJson(payload));
    expect(JSON.parse(payloadJson(payload))).toEqual(payload);
  });

  it('savePayloadOnce writes exactly the six fields', async () => {
    const { rows, items } = memoryRows();
    const row = await savePayloadOnce(rows, key, payload, 5_000);
    expect(row).toEqual({ kind: 'payload', key, json: payloadJson(payload), payloadSha256: payloadHash(payload), createdAt: 5_000, version: 1 });
    expect([...items.values()]).toEqual([row]);
  });

  it('saving the same payload again is a no-op that returns the stored row', async () => {
    const { rows, items } = memoryRows();
    const first = await savePayloadOnce(rows, key, payload, 5_000);
    const again = await savePayloadOnce(rows, key, { ...payload }, 9_000);
    expect(again).toEqual(first);
    expect(items.size).toBe(1);
  });

  it('a different payload under the same key is an EffectConflictError and the stored row is unchanged', async () => {
    const { rows, items } = memoryRows();
    const first = await savePayloadOnce(rows, key, payload, 5_000);
    await expect(savePayloadOnce(rows, key, { ...payload, letter: 'CHANGED' }, 6_000)).rejects.toBeInstanceOf(EffectConflictError);
    expect([...items.values()]).toEqual([first]);
  });

  it('a payload over 300 000 bytes is refused and nothing is written', async () => {
    const { rows, items } = memoryRows();
    await expect(savePayloadOnce(rows, key, { letter: 'x'.repeat(300_001) }, 5_000)).rejects.toThrow();
    expect(rows.create).not.toHaveBeenCalled();
    expect(items.size).toBe(0);
  });

  it('another round of the same stage is a separate row', async () => {
    const { rows, items } = memoryRows();
    await savePayloadOnce(rows, key, payload, 5_000);
    await savePayloadOnce(rows, { ...key, stageEntryNo: 2 }, { ...payload, letter: 'ROUND-TWO' }, 6_000);
    expect(items.size).toBe(2);
  });
});

describe('reading the payload for a screen: verified or nothing', () => {
  it('verified: the row exists and all three hashes agree', async () => {
    const { rows } = memoryRows();
    await savePayloadOnce(rows, key, payload, 5_000);
    expect(await readApprovalPayload(rows, approvalOf(key, payload)))
      .toEqual({ state: 'verified', value: payload, payloadSha256: payloadHash(payload) });
  });

  it('unavailable: no row. The answer carries no content', async () => {
    const { rows } = memoryRows();
    expect(await readApprovalPayload(rows, approvalOf(key, payload))).toEqual({ state: 'unavailable' });
  });

  it('mismatch: the stored text was changed after it was hashed', async () => {
    const { rows, items } = memoryRows();
    const row = await savePayloadOnce(rows, key, payload, 5_000);
    items.set(sk(key), { ...row, json: row.json.replace('JANE', 'JOHN') });
    const answer = await readApprovalPayload(rows, approvalOf(key, payload));
    expect(answer).toEqual({ state: 'mismatch' });
    expect(JSON.stringify(answer)).not.toMatch(/JANE|JOHN/);
  });

  it('mismatch: the row is for a different payload than the approval', async () => {
    const { rows } = memoryRows();
    await savePayloadOnce(rows, key, payload, 5_000);
    const answer = await readApprovalPayload(rows, approvalOf(key, { ...payload, letter: 'WHAT THE APPROVAL HASHED' }));
    expect(answer).toEqual({ state: 'mismatch' });
  });

  it('mismatch: the row`s own hash field was changed to match the approval', async () => {
    const { rows, items } = memoryRows();
    const row = await savePayloadOnce(rows, key, payload, 5_000);
    const other = { ...payload, letter: 'WHAT THE APPROVAL HASHED' };
    items.set(sk(key), { ...row, payloadSha256: payloadHash(other) });
    expect(await readApprovalPayload(rows, approvalOf(key, other))).toEqual({ state: 'mismatch' });
  });

  it('a read that throws is not swallowed', async () => {
    const rows: PayloadRows = { get: async () => { throw new Error('dynamo down'); }, create: async () => true };
    await expect(readApprovalPayload(rows, approvalOf(key, payload))).rejects.toThrow('dynamo down');
  });
});

// ── createApprovals: the optional `payloads` and `users` dependencies ─────────

const alice: ShadowUser = { netzerUserId: 'user-alice', slot: '01', paperclipUserId: 'pc-user-01',
  decisionClasses: [CLASS], status: 'active', assignedAt: Date.parse('2026-10-01T00:00:00.000Z') };

function harness(opts: { payloads?: PayloadRows; users?: { isActive(id: string): Promise<boolean> }; shadows?: ShadowUser[] } = {}) {
  const records = new Map<string, ApprovalRecord>();
  let seq = 0;
  const port: ApprovalsPort = {
    create: vi.fn(async (body) => {
      const record = { id: `apr-${++seq}`, type: body.type, status: 'pending', payload: structuredClone(body.payload),
        decidedByUserId: null, decidedAt: null };
      records.set(record.id, record);
      return structuredClone(record);
    }),
    get: vi.fn(async (id) => { const row = records.get(id); return row && structuredClone(row); }),
    decide: vi.fn(async (id, verb) => {
      const next = { ...records.get(id)!, status: verb === 'approve' ? 'approved' : verb === 'reject' ? 'rejected' : 'revision_requested',
        decidedByUserId: 'pc-user-01', decidedAt: '2026-10-04T10:00:00.000Z' };
      records.set(id, next);
      return structuredClone(next);
    }),
  };
  const people = opts.shadows ?? [alice];
  const shadows = {
    getByNetzerUser: vi.fn(async (id: string) => people.find((p) => p.netzerUserId === id)),
    getByPaperclipUser: vi.fn(async (id: string) => people.find((p) => p.paperclipUserId === id)),
  };
  const keys = { boardKeyFor: vi.fn(async (slot: string) => `pcp_board_slot_${slot}`) };
  const audit = vi.fn(async (_event: unknown) => {});
  const approvals = createApprovals({ port, shadows, keys, audit, now: () => 5_000,
    ...(opts.payloads ? { payloads: opts.payloads } : {}), ...(opts.users ? { users: opts.users } : {}) });
  return { port, records, shadows, keys, audit, approvals };
}
const code = async (promise: Promise<unknown>) => promise.then(() => 'RESOLVED', (error: { code?: string }) => error.code);
const refusals = (audit: ReturnType<typeof vi.fn>) => audit.mock.calls
  .map(([event]) => event as { action: string; detail?: { code?: string } })
  .filter((event) => event.action === 'approval_refused').map((event) => event.detail?.code);

describe('requestApproval stores the payload before it asks Paperclip', () => {
  it('the row is written first, then the approval is created', async () => {
    const { rows, items } = memoryRows();
    const h = harness({ payloads: rows });
    const order: string[] = [];
    vi.mocked(rows.create).mockImplementationOnce(async (row) => { order.push('row'); items.set(sk(row.key), row); return true; });
    vi.mocked(h.port.create).mockImplementationOnce(async (body) => {
      order.push('paperclip');
      return { id: 'apr-1', type: body.type, status: 'pending', payload: body.payload };
    });
    const result = await h.approvals.requestApproval({ key, payload, decisionClass: CLASS });
    expect(order).toEqual(['row', 'paperclip']);
    expect(result).toEqual({ approvalId: 'apr-1', payloadSha256: payloadHash(payload) });
    expect(items.get(sk(key))?.json).toBe(payloadJson(payload));
  });

  it('a changed payload under the same key creates no Paperclip approval', async () => {
    const { rows } = memoryRows();
    const h = harness({ payloads: rows });
    await h.approvals.requestApproval({ key, payload, decisionClass: CLASS });
    await expect(h.approvals.requestApproval({ key, payload: { ...payload, letter: 'CHANGED' }, decisionClass: CLASS }))
      .rejects.toBeInstanceOf(EffectConflictError);
    expect(h.port.create).toHaveBeenCalledTimes(1);
  });

  it('a row write that throws creates no Paperclip approval', async () => {
    const rows: PayloadRows = { get: async () => undefined, create: async () => { throw new Error('dynamo down'); } };
    const h = harness({ payloads: rows });
    await expect(h.approvals.requestApproval({ key, payload, decisionClass: CLASS })).rejects.toThrow('dynamo down');
    expect(h.port.create).not.toHaveBeenCalled();
  });

  it('the payload never reaches Paperclip or the audit row', async () => {
    const { rows } = memoryRows();
    const h = harness({ payloads: rows });
    await h.approvals.requestApproval({ key, payload, decisionClass: CLASS });
    expect(JSON.stringify(vi.mocked(h.port.create).mock.calls)).not.toContain('JANE');
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('JANE');
  });

  it('without the dependency, requestApproval behaves as in step 6', async () => {
    const h = harness();
    expect(await h.approvals.requestApproval({ key, payload, decisionClass: CLASS }))
      .toEqual({ approvalId: 'apr-1', payloadSha256: payloadHash(payload) });
  });
});

describe('A155: a deactivated Netzer user cannot decide', () => {
  it('approver_inactive: refused before any Paperclip read, and audited', async () => {
    const h = harness({ users: { isActive: vi.fn(async () => false) } });
    const { approvalId } = await h.approvals.requestApproval({ key, payload, decisionClass: CLASS });
    vi.mocked(h.port.get).mockClear();
    const attempt = h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision: 'approve' });
    await expect(attempt).rejects.toBeInstanceOf(ApprovalRefusedError);
    expect(await code(h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision: 'approve' }))).toBe('approver_inactive');
    expect(h.port.get).not.toHaveBeenCalled();
    expect(h.port.decide).not.toHaveBeenCalled();
    expect(h.keys.boardKeyFor).not.toHaveBeenCalled();
    expect(refusals(h.audit)).toContain('approver_inactive');
  });

  it('a lookup that throws refuses too (fail closed)', async () => {
    const h = harness({ users: { isActive: async () => { throw new Error('users table down'); } } });
    const { approvalId } = await h.approvals.requestApproval({ key, payload, decisionClass: CLASS });
    expect(await code(h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision: 'approve' }))).toBe('approver_inactive');
    expect(h.port.decide).not.toHaveBeenCalled();
  });

  it('the shadow-row check still comes first', async () => {
    const isActive = vi.fn(async () => false);
    const h = harness({ users: { isActive } });
    const { approvalId } = await h.approvals.requestApproval({ key, payload, decisionClass: CLASS });
    expect(await code(h.approvals.decide({ netzerUserId: 'user-nobody', approvalId, decision: 'approve' }))).toBe('not_an_approver');
    expect(isActive).not.toHaveBeenCalled();
  });

  it('an active user decides as before', async () => {
    const isActive = vi.fn(async () => true);
    const h = harness({ users: { isActive } });
    const { approvalId } = await h.approvals.requestApproval({ key, payload, decisionClass: CLASS });
    expect(await h.approvals.decide({ netzerUserId: 'user-alice', approvalId, decision: 'approve' }))
      .toEqual({ approvalId, decision: 'approve', shadowUserId: 'pc-user-01' });
    expect(isActive).toHaveBeenCalledWith('user-alice');
  });
});

describe('A155: a decision made before the approver was assigned does not verify', () => {
  const verify = (h: ReturnType<typeof harness>, approvalId: string) =>
    h.approvals.verifyApproval({ approvalId, key, payload, decisionClass: CLASS });
  const approvedAt = (h: ReturnType<typeof harness>, approvalId: string, decidedAt: string | null) =>
    h.records.set(approvalId, { ...h.records.get(approvalId)!, status: 'approved', decidedByUserId: 'pc-user-01', decidedAt });

  it('decided_before_assignment: the decision time is earlier than assignedAt', async () => {
    const h = harness();
    const { approvalId } = await h.approvals.requestApproval({ key, payload, decisionClass: CLASS });
    approvedAt(h, approvalId, '2026-09-30T23:59:59.000Z');
    await expect(verify(h, approvalId)).rejects.toBeInstanceOf(ApprovalInvalidError);
    expect(await code(verify(h, approvalId))).toBe('decided_before_assignment');
  });

  it('decided_before_assignment: an active approver`s decision with no readable time', async () => {
    const h = harness();
    const { approvalId } = await h.approvals.requestApproval({ key, payload, decisionClass: CLASS });
    approvedAt(h, approvalId, null);
    expect(await code(verify(h, approvalId))).toBe('decided_before_assignment');
  });

  it('a decision at the assignment instant, or after it, verifies', async () => {
    const h = harness();
    const { approvalId } = await h.approvals.requestApproval({ key, payload, decisionClass: CLASS });
    approvedAt(h, approvalId, '2026-10-01T00:00:00.000Z');
    expect(await verify(h, approvalId)).toMatchObject({ approvalId, netzerUserId: 'user-alice' });
    approvedAt(h, approvalId, '2026-10-04T10:00:00.000Z');
    expect(await verify(h, approvalId)).toMatchObject({ approvalId, netzerUserId: 'user-alice' });
  });
});
