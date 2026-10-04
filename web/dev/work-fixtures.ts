import type { ApprovalDetail, CaseDetail, PipelineSummary } from '../src/pages/work/shared';
// Made-up people and cases only. Mutable copies are created by the plugin per Vite run.
const requestedAt = '2026-10-01T12:00:00.000Z';
const updatedAt = '2026-10-02T12:00:00.000Z';
const hash = 'a'.repeat(64);
export const pipeline = {
  id: 'pipeline-vendor-invoices',
  name: 'Vendor invoices',
  stages: [
    { id: 'stage-coding', key: 'coding', name: 'Coding', kind: 'work' },
    { id: 'stage-payment', key: 'payment_approval', name: 'Payment approval', kind: 'approval' },
  ],
} satisfies PipelineSummary;
export const cases = Array.from({ length: 16 }, (_, i): Omit<CaseDetail, 'approvals'> => ({
  id: `case-${i + 1}`,
  caseKey: `INV-${1001 + i}`,
  title: `Invoice INV-${1001 + i} from Sample Vendor ${String.fromCharCode(65 + i)}`,
  pipeline: { id: pipeline.id, name: pipeline.name },
  stage: pipeline.stages[i % 2],
  status: i === 5 ? 'blocked' : i === 12 ? 'done' : i === 13 ? 'cancelled' : 'active',
  owner: { kind: 'person', name: `Sample Worker ${String.fromCharCode(65 + i)}` },
  updatedAt,
  summary: `Made-up invoice INV-${1001 + i}.`,
  fields: [{ name: 'invoice_priority', value: 'Routine' }],
  blockers: i === 5 ? [{ id: 'block-1', title: 'Waiting for invoice coding' }] : [],
  timeline: i === 6 ? [] : [{ at: updatedAt, kind: 'event', actor: null, text: 'Invoice opened.' }],
})) satisfies Omit<CaseDetail, 'approvals'>[];
export const approvals = Array.from({ length: 16 }, (_, i): ApprovalDetail => ({
  id: `approval-${i + 1}`,
  status:
    i === 3
      ? 'approved'
      : i === 13
        ? 'rejected'
        : i === 14
          ? 'revision_requested'
          : i === 15
            ? 'cancelled'
            : 'pending',
  decisionClass: 'payment_release',
  decisionLabel: 'Payment release',
  caseId: cases[i].id,
  caseKey: cases[i].caseKey,
  caseTitle: cases[i].title,
  stage: 'payment_approval',
  stageName: 'Payment approval',
  step: 'signoff',
  stageEntryNo: 1,
  requestedAt,
  decidedAt: [3, 13, 14, 15].includes(i) ? updatedAt : null,
  canDecide: ![2, 3, 4, 9, 13, 14, 15].includes(i),
  payloadSha256: hash,
  payload:
    i === 2
      ? { state: 'mismatch' }
      : i === 9
        ? { state: 'unavailable' }
      : {
          state: 'verified',
          value:
            i === 1
              ? { action: 'Release payment', invoice: { key: 'INV-1002', vendor: 'Sample Vendor B' } }
              : {
                  action: 'Release payment',
                  vendor: `Sample Vendor ${String.fromCharCode(65 + i)}`,
                  amount: '1,250.00 USD',
                  due: '2026-10-15',
                },
        },
  cannotDecideReason:
    i === 2
      ? 'payload_mismatch'
      : i === 9
        ? 'payload_unavailable'
      : [3, 13, 14, 15].includes(i)
        ? 'not_pending'
        : i === 4
          ? 'not_an_approver'
          : null,
  decidedBy: [3, 13, 14, 15].includes(i) ? 'approver.a@example.test' : null,
  decisionComment: [3, 13, 14, 15].includes(i) ? 'Sample decision recorded.' : null,
})) satisfies ApprovalDetail[];
