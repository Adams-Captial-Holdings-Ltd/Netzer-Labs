import { describe, expect, it, vi } from 'vitest';
import { checkPostDeploySignUp } from './sign-up-deploy-probe.js';
const json = (status: number, code: string) => new Response(JSON.stringify({ code }), { status });
const options = (fetchFn: typeof fetch, windowOpen = false) => ({ fetchFn,
  baseUrl: 'http://paperclip.internal:3100', probeEmail: 'existing@netzer.invalid', windowOpen });

describe('post-deploy Paperclip sign-up gate', () => {
  it('passes only proven closed sign-up', async () => {
    const fetchFn = vi.fn(async () => json(400, 'EMAIL_PASSWORD_SIGN_UP_DISABLED')) as unknown as typeof fetch;
    expect(await checkPostDeploySignUp(options(fetchFn))).toEqual({ status: 'pass', code: 'sign_up_closed' });
  });
  it('fails with sign_up_open when Paperclip accepts sign-up outside a window', async () => {
    const fetchFn = vi.fn(async () => json(422, 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL')) as unknown as typeof fetch;
    expect(await checkPostDeploySignUp(options(fetchFn))).toEqual({ status: 'fail', code: 'sign_up_open' });
  });
  it('warns during the explicit window', async () => {
    const fetchFn = vi.fn(async () => json(422, 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL')) as unknown as typeof fetch;
    expect(await checkPostDeploySignUp(options(fetchFn, true))).toEqual({ status: 'warn', code: 'sign_up_window_open' });
  });
  it('warns on an unknown result and sends nothing without a probe address', async () => {
    const fetchFn = vi.fn(async () => json(500, 'server_error')) as unknown as typeof fetch;
    expect(await checkPostDeploySignUp(options(fetchFn))).toEqual({ status: 'warn', code: 'sign_up_probe_unprovable' });
    expect(await checkPostDeploySignUp({ ...options(fetchFn), probeEmail: undefined })).toEqual({ status: 'warn', code: 'sign_up_probe_email_missing' });
    expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(1);
  });
});
