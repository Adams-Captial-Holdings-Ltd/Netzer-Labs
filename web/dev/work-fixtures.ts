// Made-up people and cases only. Mutable copies are created by the plugin per Vite run.
const requestedAt = '2026-10-01T12:00:00.000Z';
const updatedAt = '2026-10-02T12:00:00.000Z';
const hash = 'a'.repeat(64);
export const pipeline = {
  id: 'pipeline-sample',
  name: 'Sample Intake',
  stages: [{ id: 'stage-review', key: 'review', name: 'Review', kind: 'approval' }],
};
export const cases = Array.from({ length: 16 }, (_, i) => ({
  id: `case-${i + 1}`,
  caseKey: `SAMPLE-${String(i + 1).padStart(3, '0')}`,
  title: `Sample Patient ${String.fromCharCode(65 + i)} intake`,
  pipeline: { id: pipeline.id, name: pipeline.name },
  stage: pipeline.stages[0],
  status: i === 5 ? 'blocked' : i === 12 ? 'done' : i === 13 ? 'cancelled' : 'active',
  owner: { kind: 'person', name: `Sample Worker ${String.fromCharCode(65 + i)}` },
  updatedAt,
  summary: `Sample case ${i + 1} for a made-up person.`,
  fields: [{ name: 'sample_priority', value: 'Routine' }],
  blockers: i === 5 ? [{ id: 'block-1', title: 'Waiting for sample record' }] : [],
  timeline: i === 6 ? [] : [{ at: updatedAt, kind: 'event', actor: null, text: 'Sample case opened.' }],
}));
export const approvals = Array.from({ length: 16 }, (_, i) => ({
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
  decisionClass: 'clinical_disposition',
  decisionLabel: 'Clinical disposition',
  caseId: cases[i].id,
  caseKey: cases[i].caseKey,
  caseTitle: cases[i].title,
  stage: 'review',
  stageName: 'Review',
  step: 'signoff',
  stageEntryNo: 1,
  requestedAt,
  decidedAt: [3, 13, 14, 15].includes(i) ? updatedAt : null,
  canDecide: ![2, 3, 4, 13, 14, 15].includes(i),
  payloadSha256: hash,
  payload:
    i === 2
      ? { state: 'mismatch' }
      : {
          state: 'verified',
          value:
            i === 1
              ? { instruction: 'Review sample', nested: { note: 'Made-up content' } }
              : {
                  action: 'Record sample outcome',
                  sample_patient: `Sample Patient ${String.fromCharCode(65 + i)}`,
                },
        },
  cannotDecideReason:
    i === 2
      ? 'payload_mismatch'
      : [3, 13, 14, 15].includes(i)
        ? 'not_pending'
        : i === 4
          ? 'not_an_approver'
          : null,
  decidedBy: [3, 13, 14, 15].includes(i) ? 'Sample Decider A' : null,
  decisionComment: [3, 13, 14, 15].includes(i) ? 'Sample decision recorded.' : null,
}));
