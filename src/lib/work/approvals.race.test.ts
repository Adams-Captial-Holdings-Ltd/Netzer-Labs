import { describe, expect, it, vi } from 'vitest';
import { approvalPayload, createApprovals, APPROVAL_TYPE } from './approvals.js';
import { payloadJson } from './approval-payloads.js';

const key = { caseKey: 'case1', stage: 'review', step: 'send', stageEntryNo: 1 };
const body = approvalPayload(key, { x: 1 }, 'review');
function harness(mode: 'missing' | 'changed' | 'throws') {
  const events: unknown[] = [];
  const decide = vi.fn(async () => ({ id: 'ap1', type: APPROVAL_TYPE, status: 'approved', payload: body, decidedByUserId: 'pc1' }));
  const approvals = createApprovals({
    port: { create: vi.fn(), get: async () => ({ id: 'ap1', type: APPROVAL_TYPE, status: 'pending', payload: body }), decide },
    shadows: { getByNetzerUser: async () => ({ netzerUserId: 'dana', paperclipUserId: 'pc1', slot: '01', decisionClasses: ['review'], status: 'active', assignedAt: 1 }),
      getByPaperclipUser: async () => undefined },
    keys: { boardKeyFor: async () => 'key' }, audit: async (event) => { events.push(event); }, now: () => 1,
    payloads: { get: async () => {
      if (mode === 'throws') throw new Error('Dynamo unavailable');
      return mode === 'missing' ? undefined : { kind: 'payload', key, json: payloadJson({ x: 2 }), payloadSha256: body.payloadSha256, createdAt: 1, version: 1 };
    },
      create: async () => false },
  });
  return { approvals, decide, events };
}
describe('fresh decision payload', () => {
  it.each([['missing', 'payload_unavailable'], ['changed', 'payload_mismatch'], ['throws', 'payload_unavailable']] as const)('%s is audited and refused before Paperclip decides', async (mode, code) => {
    const h = harness(mode);
    await expect(h.approvals.decide({ netzerUserId: 'dana', approvalId: 'ap1', decision: 'approve' })).rejects.toMatchObject({ code });
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.events).toContainEqual(expect.objectContaining({ action: 'approval_refused', detail: { approvalId: 'ap1', code } }));
  });
});
