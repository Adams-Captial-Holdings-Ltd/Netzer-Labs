import { describe, expect, it, vi } from 'vitest';
import { checkPostDeploySignUp, probeEmailFromSecret, runPostDeploySignUpProbe } from './sign-up-deploy-probe.js';
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

describe('post-deploy host wiring', () => {
  it.each([{}, { signup_probe_email: 3 }, { signup_probe_email: '' },
    { signup_probe_email: 'REPLACE_ME' }, { signup_probe_email: ' REPLACE_ME ' }])(
    'treats an absent or placeholder probe address as missing', (value) => {
      expect(probeEmailFromSecret(JSON.stringify(value))).toBeUndefined();
    });
  it('uses the operator tunnel and reports closed sign-up', async () => {
    const fetchFn = vi.fn(async () => json(400, 'EMAIL_PASSWORD_SIGN_UP_DISABLED')) as unknown as typeof fetch;
    const lines: string[] = [];
    await runPostDeploySignUpProbe({ fetchFn, readSecret: async () => JSON.stringify({ signup_probe_email: 'existing@netzer.invalid' }),
      env: { PAPERCLIP_BASE_URL: 'http://tunnel.invalid' }, print: (line) => lines.push(line), abort: (message) => new Error(message) });
    expect(String(vi.mocked(fetchFn).mock.calls[0][0])).toContain('http://tunnel.invalid/');
    expect(lines).toEqual(['Paperclip sign-up is closed']);
  });
  it('sends nothing without a reachable address', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const readSecret = vi.fn(); const lines: string[] = [];
    await runPostDeploySignUpProbe({ fetchFn, readSecret, env: {}, print: (line) => lines.push(line), abort: (message) => new Error(message) });
    expect(fetchFn).not.toHaveBeenCalled(); expect(readSecret).not.toHaveBeenCalled();
    expect(lines[0]).toContain('orchestrator proves sign-up closed at start');
  });
  it('aborts on open sign-up and warns on unknown or unreadable secret', async () => {
    const lines: string[] = [];
    const base = { env: { PAPERCLIP_BASE_URL: 'http://tunnel.invalid' }, print: (line: string) => lines.push(line),
      abort: (message: string) => new Error(message), readSecret: async () => JSON.stringify({ signup_probe_email: 'existing@netzer.invalid' }) };
    await expect(runPostDeploySignUpProbe({ ...base, fetchFn: async () => json(422, 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') })).rejects.toThrow('sign_up_open');
    await runPostDeploySignUpProbe({ ...base, fetchFn: async () => json(500, 'error') });
    expect(lines.at(-1)).toContain('sign_up_probe_unprovable');
    await runPostDeploySignUpProbe({ ...base, fetchFn: vi.fn(), readSecret: async () => { throw new Error('private'); } });
    expect(lines.at(-1)).toContain('paperclip_secret_unreadable');
  });
});
