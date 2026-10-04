import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ enabled: undefined as string | undefined, window: undefined as string | undefined,
  probeEmail: 'lock@netzer.invalid' as string | undefined }));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({ ...actual.loadEnv(), CCE_PAPERCLIP_ENABLED: settings.enabled,
      PAPERCLIP_LOCK_AUDITOR_KEY: 'auditor-key-for-test', PAPERCLIP_SIGNUP_PROBE_EMAIL: settings.probeEmail,
      PAPERCLIP_SIGNUP_WINDOW: settings.window }),
  };
});

import { bootPaperclipLock } from './lock-boot.js';
import { __resetPaperclipLockForTest, getPaperclipLockState } from './runtime-lock.js';

const loadConfig = async () => ({ baseUrl: 'http://paperclip.test.internal:3100', companyId: 'company-1' });
const cleanRead = (url: string | URL | Request) => {
  const path = String(url);
  if (path.endsWith('/api/health')) return new Response(JSON.stringify({ hiddenSettings: ['instance.adapters', 'instance.plugins'] }));
  if (path.endsWith('/api/instance/settings/experimental')) return new Response(JSON.stringify({ enableNativeRunner: false }));
  if (path.endsWith('/agents')) return new Response('[]');
  if (path.endsWith('/remote-agent-profiles')) return new Response('[]');
  if (path.endsWith('/tools/applications')) return new Response(JSON.stringify({ applications: [] }));
  if (path.endsWith('/tools/connections')) return new Response(JSON.stringify({ connections: [] }));
  return new Response(JSON.stringify({ code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' }), { status: 400 });
};

describe('bootPaperclipLock sign-up probe', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetPaperclipLockForTest(); settings.enabled = '1'; settings.window = undefined;
    settings.probeEmail = 'lock@netzer.invalid'; });
  afterEach(() => { vi.useRealTimers(); __resetPaperclipLockForTest(); settings.enabled = undefined; settings.window = undefined;
    settings.probeEmail = 'lock@netzer.invalid'; });

  it('an open sign-up closes the latch and refuses startup', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/api/auth/sign-up/email')
      ? new Response(JSON.stringify({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' }), { status: 422 })
      : cleanRead(url)) as unknown as typeof fetch;
    const starting = bootPaperclipLock({ loadConfig, fetchFn });
    const refusal = expect(starting).rejects.toThrow('sign_up_open');
    await vi.advanceTimersByTimeAsync(0);
    await refusal;
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'violated:sign_up_open' });
  });

  it('a closed sign-up keeps the latch open', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => cleanRead(url)) as unknown as typeof fetch;
    const loader = vi.fn(loadConfig);
    const starting = bootPaperclipLock({ loadConfig: loader, fetchFn });
    await vi.advanceTimersByTimeAsync(0);
    const lock = await starting;
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
    expect(loader).toHaveBeenCalledTimes(1);
    lock.stop();
  });

  it('loads the config once for both readers and latches on a missing base URL', async () => {
    const missing = vi.fn(async () => ({ baseUrl: '', companyId: 'company-1' }));
    const fetchFn = vi.fn(async (url: string | URL | Request) => cleanRead(url));
    const starting = bootPaperclipLock({ loadConfig: missing, fetchFn: fetchFn as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(2_100);
    const lock = await starting;
    expect(getPaperclipLockState().code).toBe('unknown:paperclip_config_missing');
    expect(missing).toHaveBeenCalledTimes(3);
    expect(fetchFn).not.toHaveBeenCalled();
    lock.stop();
  });

  it('a throwing config loader latches closed without an unhandled rejection', async () => {
    const loader = vi.fn(async () => { throw new Error('secret detail'); });
    const fetchFn = vi.fn();
    const starting = bootPaperclipLock({ loadConfig: loader, fetchFn: fetchFn as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(2_100);
    const lock = await starting;
    expect(getPaperclipLockState().code).toBe('unknown:paperclip_config_unavailable');
    expect(fetchFn).not.toHaveBeenCalled();
    lock.stop();
  });

  it('an open window latches closed without refusing startup', async () => {
    settings.window = 'open';
    const fetchFn = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/api/auth/sign-up/email')
      ? new Response('{}') : cleanRead(url)) as unknown as typeof fetch;
    const starting = bootPaperclipLock({ loadConfig, fetchFn });
    await vi.advanceTimersByTimeAsync(2_100);
    const lock = await starting;
    expect(getPaperclipLockState()).toEqual({ closed: true, code: 'unknown:sign_up_window_open' });
    lock.stop();
  });

  it('a missing probe address latches closed and sends no sign-up request', async () => {
    settings.probeEmail = undefined;
    const fetchFn = vi.fn(async (url: string | URL | Request) => cleanRead(url));
    const starting = bootPaperclipLock({ loadConfig, fetchFn: fetchFn as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(2_100);
    const lock = await starting;
    expect(getPaperclipLockState().closed).toBe(true);
    expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith('/api/auth/sign-up/email'))).toBe(false);
    lock.stop();
  });

  it('sends the trimmed probe address', async () => {
    settings.probeEmail = '  lock@netzer.invalid  ';
    const fetchFn = vi.fn(async (url: string | URL | Request) => cleanRead(url));
    const starting = bootPaperclipLock({ loadConfig, fetchFn: fetchFn as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(0);
    const lock = await starting;
    const call = fetchFn.mock.calls.find(([url]) => String(url).endsWith('/api/auth/sign-up/email'));
    expect(call).toBeDefined();
    const init = (call as unknown as [string | URL | Request, RequestInit] | undefined)?.[1];
    expect(JSON.parse(String(init?.body)).email).toBe('lock@netzer.invalid');
    lock.stop();
  });

  it('a violated runtime read stays violated when the probe is unknown', async () => {
    settings.probeEmail = undefined;
    const fetchFn = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/api/health')
      ? new Response(JSON.stringify({ hiddenSettings: [] })) : cleanRead(url)) as unknown as typeof fetch;
    const starting = bootPaperclipLock({ loadConfig, fetchFn });
    const refusal = expect(starting).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    await refusal;
    expect(getPaperclipLockState().code).toMatch(/^violated:/);
  });
});
