import { readSignUpProbe } from '../../../src/lib/paperclip/sign-up-probe.js';

export function probeEmailFromSecret(secret: string): string | undefined {
  const parsed: unknown = JSON.parse(secret);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const email = (parsed as Record<string, unknown>).signup_probe_email;
  return typeof email === 'string' && email.trim() && email.trim() !== 'REPLACE_ME' ? email.trim() : undefined;
}

export async function checkPostDeploySignUp(options: {
  fetchFn: typeof fetch;
  baseUrl: string;
  probeEmail: string | undefined;
  windowOpen: boolean;
}): Promise<{ status: 'pass' | 'warn' | 'fail'; code: string }> {
  const verdict = await readSignUpProbe(options);
  if (verdict.verdict === 'violated') return { status: 'fail', code: 'sign_up_open' };
  if (verdict.verdict === 'clean') return { status: 'pass', code: 'sign_up_closed' };
  return { status: 'warn', code: verdict.reason };
}

export async function runPostDeploySignUpProbe(options: {
  fetchFn: typeof fetch;
  readSecret: () => Promise<string>;
  env: { PAPERCLIP_BASE_URL?: string; CCE_PAPERCLIP_SIGNUP_WINDOW?: string };
  print: (line: string) => void;
  abort: (message: string) => Error;
}): Promise<void> {
  const baseUrl = options.env.PAPERCLIP_BASE_URL?.trim();
  if (!baseUrl) {
    options.print('The deploy host cannot reach Paperclip; the orchestrator proves sign-up closed at start ' +
      'and refuses to start if it is open.');
    return;
  }
  let email: string | undefined;
  try { email = probeEmailFromSecret(await options.readSecret()); }
  catch {
    options.print('Paperclip sign-up probe warning (paperclip_secret_unreadable)');
    return;
  }
  const result = await checkPostDeploySignUp({ fetchFn: options.fetchFn, baseUrl, probeEmail: email,
    windowOpen: options.env.CCE_PAPERCLIP_SIGNUP_WINDOW === 'open' });
  if (result.status === 'fail') throw options.abort('sign_up_open: Paperclip sign-up is open after deploy');
  options.print(result.status === 'pass' ? 'Paperclip sign-up is closed' : `Paperclip sign-up probe warning (${result.code})`);
}
