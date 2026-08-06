import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { configStore } = vi.hoisted(() => ({
  configStore: new Map<string, string>(),
}));

vi.mock('../state/runtime-config-repo.js', () => ({
  getConfig: async (cat: string, key: string) => configStore.get(`${cat}/${key}`),
  setConfig: async (cat: string, key: string, value: string) => {
    configStore.set(`${cat}/${key}`, value);
  },
  deleteConfig: async (cat: string, key: string) => {
    configStore.delete(`${cat}/${key}`);
  },
}));

import { mintOAuthState, consumeOAuthState } from './state-repo.js';
import {
  buildPkcePair,
  oauthRedirectUri,
  slackBotAuthorizeUrl,
  salesforceAuthorizeUrl,
  MissingOAuthConfigError,
  slackAppCreds,
} from './providers.js';

const SAVED_URL = process.env.CCE_DASHBOARD_URL;

beforeEach(() => {
  configStore.clear();
  process.env.CCE_DASHBOARD_URL = 'https://cce.example.com';
});

afterEach(() => {
  if (SAVED_URL === undefined) delete process.env.CCE_DASHBOARD_URL;
  else process.env.CCE_DASHBOARD_URL = SAVED_URL;
});

describe('oauth state rows', () => {
  it('round-trips and is single-use', async () => {
    const raw = await mintOAuthState({
      provider: 'salesforce',
      mode: 'api',
      principalLabel: 'admin@x',
      codeVerifier: 'v',
    });
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    // Stored under the hash, not the raw value.
    expect([...configStore.keys()].some((k) => k.includes(raw))).toBe(false);

    const row = await consumeOAuthState(raw);
    expect(row?.provider).toBe('salesforce');
    expect(row?.codeVerifier).toBe('v');
    // Replay refused.
    expect(await consumeOAuthState(raw)).toBeNull();
  });

  it('refuses expired rows', async () => {
    const raw = await mintOAuthState({ provider: 'slack', mode: 'chat', agentId: 'a', principalLabel: 'p' });
    // Rewrite the stored row with a past expiry.
    const key = [...configStore.keys()].find((k) => k.startsWith('oauth_state/'))!;
    const row = JSON.parse(configStore.get(key)!);
    row.expiresAt = new Date(Date.now() - 1000).toISOString();
    configStore.set(key, JSON.stringify(row));
    expect(await consumeOAuthState(raw)).toBeNull();
  });

  it('refuses junk states without throwing', async () => {
    expect(await consumeOAuthState('')).toBeNull();
    expect(await consumeOAuthState('short')).toBeNull();
    expect(await consumeOAuthState('z'.repeat(64))).toBeNull();
  });
});

describe('providers', () => {
  it('builds an RFC7636 PKCE pair', () => {
    const { verifier, challenge } = buildPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url sha256
    expect(challenge).not.toBe(verifier);
  });

  it('builds the redirect uri from server config only', () => {
    expect(oauthRedirectUri()).toBe('https://cce.example.com/api/oauth/callback');
    delete process.env.CCE_DASHBOARD_URL;
    delete process.env.DASHBOARD_URL;
    expect(() => oauthRedirectUri()).toThrow(/DASHBOARD_URL/);
  });

  it('slack bot authorize url carries per-agent client id, scopes, and state', async () => {
    configStore.set('oauth/slack_app_ops', JSON.stringify({ clientId: 'cid1', clientSecret: 'cs1', signingSecret: 'ss' }));
    const url = new URL(await slackBotAuthorizeUrl('ops', 'STATE123'));
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid1');
    expect(url.searchParams.get('state')).toBe('STATE123');
    expect(url.searchParams.get('scope')).toContain('files:write');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cce.example.com/api/oauth/callback');
  });

  it('throws a precise MissingOAuthConfigError when creds are absent', async () => {
    await expect(slackAppCreds('ghost')).rejects.toBeInstanceOf(MissingOAuthConfigError);
    await expect(slackAppCreds('ghost')).rejects.toMatchObject({ configKey: 'oauth/slack_app_ghost' });
  });

  it('salesforce authorize url uses PKCE and the configured login url', async () => {
    configStore.set('oauth/salesforce_client_id', 'sfcid');
    configStore.set('oauth/salesforce_login_url', 'https://test.salesforce.com');
    const url = new URL(await salesforceAuthorizeUrl('ST', 'CHAL'));
    expect(url.origin).toBe('https://test.salesforce.com');
    expect(url.searchParams.get('code_challenge')).toBe('CHAL');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('api refresh_token');
  });
});
