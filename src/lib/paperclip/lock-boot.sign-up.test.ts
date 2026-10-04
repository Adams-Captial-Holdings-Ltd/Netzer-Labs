import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ enabled: undefined as string | undefined, window: undefined as string | undefined }));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({ ...actual.loadEnv(), CCE_PAPERCLIP_ENABLED: settings.enabled,
      PAPERCLIP_LOCK_AUDITOR_KEY: 'auditor-key-for-test', PAPERCLIP_SIGNUP_PROBE_EMAIL: 'lock@netzer.invalid',
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
  beforeEach(() => { vi.useFakeTimers(); __resetPaperclipLockForTest(); settings.enabled = '1'; settings.window = undefined; });
  afterEach(() => { vi.useRealTimers(); __resetPaperclipLockForTest(); settings.enabled = undefined; settings.window = undefined; });

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
    const lock = await bootPaperclipLock({ loadConfig, fetchFn });
    expect(getPaperclipLockState()).toEqual({ closed: false, code: null });
    lock.stop();
  });
});
