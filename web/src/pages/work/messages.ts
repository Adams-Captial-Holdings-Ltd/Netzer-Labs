const sentences: Record<string, string> = {
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
  decision_outcome_unknown: 'We could not confirm the decision was recorded. Reload to check.',
};
export const fallbackMessage =
  'Something went wrong on our side. Nothing was decided by you here. Contact your admin.';
export function workMessage(error: unknown): string {
  const code = error instanceof Error ? error.message.split(':')[0] : String(error);
  return sentences[code] ?? fallbackMessage;
}
export function canRetry(error: unknown): boolean {
  const code = error instanceof Error ? error.message : String(error);
  return !['forbidden', 'work_disabled', 'not_found'].includes(code);
}
