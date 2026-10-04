import { afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ send: vi.fn(), construct: vi.fn() }));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  GetSecretValueCommand: class { constructor(public readonly input: { SecretId: string }) {} },
  SecretsManagerClient: class {
    constructor(options: unknown) { sdk.construct(options); }
    send(command: { input: { SecretId: string } }) { return sdk.send(command); }
  },
}));

import { createShadowKeyStore, defaultShadowKeyStore, ShadowKeyUnavailableError } from './shadow-keys.js';
import { resetEnvCache } from '../../config/env.js';
import { logger } from '../../observability/logger.js';

const secret = (boardKey: string | null) => JSON.stringify({ v: 1, slots: { '01': { boardKey } } });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetEnvCache(); sdk.send.mockReset(); sdk.construct.mockReset(); });

describe('shadow key cache and default store', () => {
  it('fetches once when an expired cache has an absent slot', async () => {
    let time = 0;
    const getSecretString = vi.fn(async () => secret('key'));
    const store = createShadowKeyStore({ getSecretString, now: () => time, ttlMs: 10 });
    await store.boardKeyFor('01');
    time = 11;
    await expect(store.boardKeyFor('02')).rejects.toBeInstanceOf(ShadowKeyUnavailableError);
    expect(getSecretString).toHaveBeenCalledTimes(2);
  });

  it('refetches once for a cached null key', async () => {
    const getSecretString = vi.fn().mockResolvedValueOnce(secret(null)).mockResolvedValueOnce(secret('new-key'));
    const store = createShadowKeyStore({ getSecretString, now: () => 0 });
    await expect(store.boardKeyFor('01')).rejects.toBeInstanceOf(ShadowKeyUnavailableError);
    expect(await store.boardKeyFor('01')).toBe('new-key');
    expect(getSecretString).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    const getSecretString = vi.fn(async () => secret('key'));
    const store = createShadowKeyStore({ getSecretString, now: () => 0 });
    expect(await Promise.all([store.boardKeyFor('01'), store.boardKeyFor('01')])).toEqual(['key', 'key']);
    expect(getSecretString).toHaveBeenCalledTimes(1);
  });

  it('rejects an unset id, an empty SecretString and an AWS error without leaking details', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('SHADOW_APPROVERS_SECRET_ID', undefined);
    await expect(defaultShadowKeyStore().boardKeyFor('01')).rejects.toBeInstanceOf(ShadowKeyUnavailableError);
    vi.stubEnv('SHADOW_APPROVERS_SECRET_ID', '/my/runtime-secret');
    vi.stubEnv('AWS_REGION', 'us-west-2');
    resetEnvCache();
    sdk.send.mockResolvedValueOnce({ SecretString: '' })
      .mockRejectedValueOnce(Object.assign(new Error('sensitive detail'), { name: 'AccessDeniedException' }));
    await expect(defaultShadowKeyStore().boardKeyFor('01')).rejects.toBeInstanceOf(ShadowKeyUnavailableError);
    await expect(defaultShadowKeyStore().boardKeyFor('01')).rejects.not.toThrow('sensitive detail');
    expect(sdk.send.mock.calls[0]?.[0].input.SecretId).toBe('/my/runtime-secret');
    expect(sdk.construct.mock.calls[0]?.[0]).toEqual({ region: 'us-west-2' });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([fields]) => fields)).toEqual([
      { errorName: 'ShadowKeyUnavailableError' }, { errorName: 'AccessDeniedException' },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive detail');
  });
  it.each(['{broken', JSON.stringify({ v: 1, slots: { '01': { boardKey: 7 } } })])
  ('warns once without secret content when the default secret is invalid', async (body) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('SHADOW_APPROVERS_SECRET_ID', '/my/runtime-secret'); resetEnvCache();
    sdk.send.mockResolvedValueOnce({ SecretString: body });
    await expect(defaultShadowKeyStore().boardKeyFor('01')).rejects.toBeInstanceOf(ShadowKeyUnavailableError);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe('shadow key secret invalid');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(body);
  });
});
