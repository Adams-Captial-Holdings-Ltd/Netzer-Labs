export function toolDecision(
  name: string,
  opts: { aiStep?: boolean; allow?: readonly string[]; readOnly: boolean; remote: boolean },
): { allowed: true } | { allowed: false; reason: 'not_in_role_allowlist' | 'write_denied_in_ai_step' } {
  if (opts.allow !== undefined && !opts.allow.includes(name)) {
    return { allowed: false, reason: 'not_in_role_allowlist' };
  }
  if (opts.aiStep && !opts.remote && !opts.readOnly) {
    return { allowed: false, reason: 'write_denied_in_ai_step' };
  }
  if (opts.aiStep && opts.remote && opts.allow === undefined) {
    return { allowed: false, reason: 'write_denied_in_ai_step' };
  }
  return { allowed: true };
}
