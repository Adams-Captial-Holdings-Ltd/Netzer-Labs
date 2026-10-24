const sentences = new Map<string, string>(Object.entries({
  work_disabled: 'Work is not switched on for this deployment.',
  paperclip_disabled: 'The work engine is not available right now. Try again in a minute.',
  paperclip_unavailable: 'The work engine is not available right now. Try again in a minute.',
  paperclip_locked: 'The work engine is not available right now. Try again in a minute.',
  paperclip_ratelimited: 'Too many requests. Wait a moment and try again.',
  forbidden: 'You do not have access to this. Ask an admin.',
  not_found: 'This could not be found. It may have been removed.',
  stale_payload: 'This changed after you opened it. Review the new version before deciding.',
  not_pending: 'This has already been decided.',
  not_an_approver: 'You are not set up to decide this one. Ask an admin.',
  class_not_entitled: 'You are not set up to decide this one. Ask an admin.',
  approver_inactive: 'You are not set up to decide this one. Ask an admin.',
  missing_capability: 'You are not set up to decide this one. Ask an admin.',
  no_user_session: 'Sign in with your own account to decide.',
  payload_unavailable: 'We cannot show what would be approved, so it cannot be decided.',
  payload_mismatch: 'We cannot show what would be approved, so it cannot be decided.',
  comment_required: 'Add a comment to reject or request changes.',
  comment_too_long: 'The comment is too long (4 000 characters at most).',
  paperclip_rejected: 'The decision was not accepted. Reload and check the approval.',
  cannot_decide: 'You cannot decide this one. Ask an admin.',
  decision_outcome_unknown: 'We could not confirm the decision was recorded. Check again to see.',
  attribution_mismatch: 'Your decision may have been recorded, but we could not confirm it under your name. Do not decide again. Contact your admin.',
}));
export const fallbackMessage =
  'Something went wrong on our side. Try again, or contact your admin.';
/** The code in an error: for an Error the text before any ":", otherwise its string form. */
export function errorCode(error: unknown): string {
  return error instanceof Error ? (error.message.split(':').at(0) ?? '') : String(error);
}
export function workMessage(error: unknown): string {
  return sentences.get(errorCode(error)) ?? fallbackMessage;
}
/** The sentence for a reason the person cannot decide: an unknown reason still says that, not "went wrong". */
export function cannotDecideMessage(reason: string | null): string {
  return sentences.get(reason ?? 'not_an_approver') ?? sentences.get('cannot_decide') ?? fallbackMessage;
}
export function canRetry(error: unknown): boolean {
  const code = error instanceof Error ? error.message : String(error);
  return !['forbidden', 'work_disabled', 'not_found'].includes(code);
}

/** Page text for the Work screens. Error sentences stay in the map above. */
export const copy = {
  loading: 'Loading',
  inbox: {
    title: 'Work Inbox',
    subtitle: 'What is waiting for you. A case is one piece of work an agent is handling, such as an invoice.',
    waiting: 'Waiting for your decision',
    blocked: 'Blocked cases',
    mine: 'Cases assigned to you',
    nothing: 'Nothing needs you',
    nothingHint: 'New approvals and blocked cases will appear here.',
    notSetUp: 'You are not set up to approve. Ask an admin.',
    noneWaiting: 'Nothing waiting for your decision.',
    noneBlocked: 'No blocked cases.',
    noneMine: 'No cases assigned to you.',
  },
  cases: {
    title: 'Cases',
    subtitle: 'Each case is one piece of work an agent is handling, such as an invoice.',
    empty: 'No cases match these filters.',
    pipeline: 'Pipeline',
    stage: 'Stage',
    status: 'Status',
    allPipelines: 'All pipelines',
    allStages: 'All stages',
    stageFirst: 'Choose a pipeline first',
    open: 'Open',
    blocked: 'Blocked',
    done: 'Done',
    all: 'All',
    truncated: 'Showing the first 200. Narrow the filters to find others.',
  },
  approvals: {
    title: 'Approvals',
    subtitle: "Actions an agent has prepared that need a person's yes or no before they happen.",
    empty: 'No approvals here.',
    tabs: 'Approval tabs',
    waiting: 'Waiting',
    all: 'All',
    truncated: 'Showing the first 200.',
  },
  detail: {
    caseTitle: 'Case',
    caseNotFound: 'Case not found',
    approvalTitle: 'Approval',
    approvalNotFound: 'Approval not found',
    backInbox: 'Back to Inbox',
    backCases: 'Back to Cases',
    backApprovals: 'Back to Approvals',
    viewCase: 'View case',
    blockers: 'Blockers',
    approvalsHeading: 'Approvals',
    noApprovals: 'No approvals for this case.',
    timeline: 'Timeline',
    noTimeline: 'No timeline entries yet.',
    facts: 'Facts',
    system: 'System',
  },
  status: {
    pending: 'Waiting',
    revision_requested: 'Changes requested',
    approved: 'Approved',
    rejected: 'Rejected',
    blocked: 'Blocked',
    done: 'Done',
    active: 'Open',
    cancelled: 'Cancelled',
  },
  row: {
    unassigned: 'Unassigned',
    blockedAt: (stage: string) => `Blocked at ${stage}`,
    waitingFor: (span: string) => `Waiting ${span}`,
    waitingViewOnly: 'Waiting · view only',
    openToSee: 'Open to see why',
  },
  payload: {
    goToDecision: 'Go to decision',
    itemCount: (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`,
    ifApproved: 'If you approve, this will be done',
    wasApproved: 'What was approved',
    wasProposed: 'What was proposed',
    cannotShow: 'We cannot show what would be approved, so it cannot be decided.',
    tellAdmin: 'Tell your admin. Nothing will happen until this is fixed.',
    fingerprint: 'A fingerprint of exactly what is shown above, kept for audit.',
  },
  decide: {
    comment: 'Comment',
    helper: 'Optional to approve. Needed to reject or request changes.',
    deciding: (label: string, subject: string) => `You are deciding ${label} for ${subject}. This cannot be undone.`,
    consequences: 'Approve: it goes ahead. Request changes: it goes back to be revised. Reject: it will not happen.',
    approve: 'Approve',
    requestChanges: 'Request changes',
    reject: 'Reject',
    sendingNote: 'Sending your decision.',
    lockedNote: 'Deciding is paused until this page has been checked again.',
    counter: (n: number) => `${n} / 4 000 characters`,
    counterShown: 'Comment character counter shown',
    counterOver: 'Comment exceeds 4 000 characters',
  },
  confirm: {
    title: (label: string) => `Approve ${label}`,
    lead: (label: string) => `Approve ${label} for `,
    tail: '? This cannot be undone.',
    approve: 'Approve',
  },
  result: {
    heading: 'Decision',
    comment: 'Comment',
    decided: 'Decided',
    cancelled: 'This approval was cancelled',
    unknownPerson: 'Decider unknown',
    approvedMine: 'You approved this. It will go ahead.',
    rejectedMine: 'You rejected this. It will not happen.',
    changesMine: 'You asked for changes. It goes back to be revised.',
    approvedBy: (who: string) => `${who} approved this. It will go ahead.`,
    rejectedBy: (who: string) => `${who} rejected this. It will not happen.`,
    changesBy: (who: string) => `${who} asked for changes. It goes back to be revised.`,
    recordedNoRead: 'The decision was recorded. Reload to see the latest approval.',
    checkAgain: 'Check again',
    checkedPending: 'It was not recorded. You can decide again.',
    checkFailed: 'We could not check just now. Try again.',
  },
  announce: {
    sending: 'Sending',
    recorded: 'Decision recorded',
    checked: 'Checked',
  },
  requested: 'Requested',
  error: { noAccess: 'You do not have access', askAdmin: 'Ask an admin to give you access.' },
};
