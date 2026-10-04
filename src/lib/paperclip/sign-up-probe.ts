import { randomBytes } from 'node:crypto';
import type { LockVerdict } from './runtime-lock.js';

type SignUpProbeOptions = {
  fetchFn: typeof fetch;
  baseUrl: string;
  probeEmail: string | undefined;
  windowOpen: boolean;
};

export function combineLockVerdicts(a: LockVerdict, b: LockVerdict): LockVerdict {
  if (a.verdict === 'violated' && b.verdict === 'violated') {
    return { verdict: 'violated', violations: [...a.violations, ...b.violations] };
  }
  if (a.verdict === 'violated') return a;
  if (b.verdict === 'violated') return b;
  if (a.verdict === 'unknown') return a;
  if (b.verdict === 'unknown') return b;
  return { verdict: 'clean' };
}

export async function readSignUpProbe({ fetchFn, baseUrl, probeEmail, windowOpen }: SignUpProbeOptions): Promise<LockVerdict> {
  if (!probeEmail?.trim()) return { verdict: 'unknown', reason: 'sign_up_probe_email_missing' };
  try {
    const response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: probeEmail.trim(), password: randomBytes(24).toString('hex'), name: 'Lock auditor' }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    let code: unknown;
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) code = (body as Record<string, unknown>).code;
    } catch { /* malformed response is unprovable */ }
    if (response.status === 400 && code === 'EMAIL_PASSWORD_SIGN_UP_DISABLED') return { verdict: 'clean' };
    if ((response.status === 422 && code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL')
      || (response.status >= 200 && response.status < 300)) {
      if (windowOpen) return { verdict: 'unknown', reason: 'sign_up_window_open' };
      return { verdict: 'violated', violations: [{ code: 'sign_up_open', detail: 'Paperclip sign-up is open' }] };
    }
    return { verdict: 'unknown', reason: 'sign_up_probe_unprovable' };
  } catch {
    return { verdict: 'unknown', reason: 'sign_up_probe_unprovable' };
  }
}
