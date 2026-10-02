import { describe, expect, it } from 'vitest';
import {
  loadPaperclipConfig,
  paperclipConfig,
  parseAgentKeys,
  PAPERCLIP_READ_TIMEOUT_MS,
  PAPERCLIP_SECRET_PATH,
  PAPERCLIP_WRITE_TIMEOUT_MS,
} from './config.js';
import { PaperclipDisabledError } from './error.js';
import { expectPaperclipError } from './test-helpers.js';

// Fakes only. Nothing here reads DynamoDB or process.env.
const complete = {
  baseUrl: 'https://paperclip.internal',
  companyId: 'c0ffee00-0000-4000-8000-000000000001',
  agentKeys: { main: 'key-main', analyst: 'key-analyst' },
};

/** Stands in for `getConfig`, which is fail-open and answers undefined on a DDB error. */
function fakeGetConfig(values: Record<string, string> = {}) {
  return async (category: string, key: string): Promise<string | undefined> => values[`${category}/${key}`];
}

describe('paperclipConfig', () => {
  it('A2-9: construction throws SYNCHRONOUSLY, so no caller can await its way past a missing base URL', () => {
    // Not a rejected promise: a synchronous throw, exactly as Linear's
    // parseClientOptions does when neither credential is present.
    expect(() => paperclipConfig({ ...complete, baseUrl: undefined })).toThrow(PaperclipDisabledError);
  });

  it('A2-9: the missing-base-URL message names the runtime-config key AND the env fallback', async () => {
    const err = await expectPaperclipError(
      () => paperclipConfig({ ...complete, baseUrl: '' }),
      PaperclipDisabledError,
      'paperclip/base_url',
    );
    expect(err.body?.remediation).toContain('PAPERCLIP_BASE_URL');
    expect(err.type).toBe('disabled');
  });

  it('A2-9: the missing-credential message names the secret path and the bootstrap that populates it', async () => {
    const err = await expectPaperclipError(
      () => paperclipConfig({ ...complete, agentKeys: {} }),
      PaperclipDisabledError,
      'no agent keys',
    );
    expect(err.body?.remediation).toContain(PAPERCLIP_SECRET_PATH);
    expect(err.body?.remediation).toContain('agent_keys');
    expect(err.body?.remediation).toContain('PAPERCLIP_AGENT_KEYS_JSON');
  });

  it('A2-9: a default actor with no key names the actors that do have one', async () => {
    const err = await expectPaperclipError(
      () => paperclipConfig({ ...complete, defaultActor: 'ghost' }),
      PaperclipDisabledError,
      '"ghost"',
    );
    expect(err.body?.remediation).toContain('analyst, main');
  });

  it('A2-9: a complete input resolves, and the base URL loses its trailing slash', () => {
    const resolved = paperclipConfig({ ...complete, baseUrl: 'https://paperclip.internal//' });
    expect(resolved.baseUrl).toBe('https://paperclip.internal');
    expect(resolved.defaultActor).toBe('main');
    expect(resolved.readTimeoutMs).toBe(PAPERCLIP_READ_TIMEOUT_MS);
    expect(resolved.writeTimeoutMs).toBe(PAPERCLIP_WRITE_TIMEOUT_MS);
  });

  it('A2-11: the 10 s read / 20 s write divergence is what the defaults actually are', () => {
    expect(PAPERCLIP_READ_TIMEOUT_MS).toBe(10_000);
    expect(PAPERCLIP_WRITE_TIMEOUT_MS).toBe(20_000);
  });
});

describe('parseAgentKeys', () => {
  it('a malformed blob is treated exactly like an absent one, so both reach the same typed error', () => {
    expect(parseAgentKeys(undefined)).toEqual({});
    expect(parseAgentKeys('')).toEqual({});
    expect(parseAgentKeys('{not json')).toEqual({});
    expect(parseAgentKeys('["main"]')).toEqual({});
    expect(parseAgentKeys('{"main":"k","broken":7,"blank":""}')).toEqual({ main: 'k' });
  });
});

describe('loadPaperclipConfig', () => {
  it('A2-9: a DDB outage and an unconfigured install are the same undefined, and env answers for both', async () => {
    const input = await loadPaperclipConfig({
      env: { PAPERCLIP_BASE_URL: 'https://from-env', PAPERCLIP_COMPANY_ID: 'co', PAPERCLIP_AGENT_KEYS_JSON: '{"main":"k"}' },
      getConfigFn: fakeGetConfig(),
    });
    expect(input.baseUrl).toBe('https://from-env');
    expect(input.agentKeys).toEqual({ main: 'k' });
  });

  it('runtime-config paperclip/base_url wins over the env fallback', async () => {
    const input = await loadPaperclipConfig({
      env: { PAPERCLIP_BASE_URL: 'https://from-env' },
      getConfigFn: fakeGetConfig({ 'paperclip/base_url': 'https://from-config.internal' }),
    });
    expect(input.baseUrl).toBe('https://from-config.internal');
  });

  it('an empty-string timeout does not defeat the default and does not throw at load', async () => {
    // `node --env-file` turns a bare `PAPERCLIP_READ_TIMEOUT_MS=` into '' and
    // `.env.example` ships 58 such lines. Against a z.coerce.number() this
    // would make loadEnv() throw at startup; here it simply falls back.
    const input = await loadPaperclipConfig({
      env: { PAPERCLIP_READ_TIMEOUT_MS: '', PAPERCLIP_WRITE_TIMEOUT_MS: 'REPLACE_ME' },
      getConfigFn: fakeGetConfig(),
    });
    expect(input.readTimeoutMs).toBeUndefined();
    expect(input.writeTimeoutMs).toBeUndefined();
    const resolved = paperclipConfig({
      ...complete,
      readTimeoutMs: input.readTimeoutMs,
      writeTimeoutMs: input.writeTimeoutMs,
    });
    expect(resolved.readTimeoutMs).toBe(PAPERCLIP_READ_TIMEOUT_MS);
  });
});
