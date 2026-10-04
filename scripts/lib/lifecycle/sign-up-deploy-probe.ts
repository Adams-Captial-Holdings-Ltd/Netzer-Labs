import { readSignUpProbe } from '../../../src/lib/paperclip/sign-up-probe.js';

export async function checkPostDeploySignUp(options: {
  fetchFn: typeof fetch;
  baseUrl: string;
  probeEmail: string | undefined;
  windowOpen: boolean;
}): Promise<{ status: 'pass' | 'warn' | 'fail'; code: string }> {
  const verdict = await readSignUpProbe(options);
  if (verdict.verdict === 'violated' && !options.windowOpen) return { status: 'fail', code: 'sign_up_open' };
  if (verdict.verdict === 'clean') return { status: 'pass', code: 'sign_up_closed' };
  return { status: 'warn', code: verdict.verdict === 'unknown' ? verdict.reason : 'sign_up_window_open' };
}
