import { describe, it, expect } from 'vitest';
import {
  CONFIG_POLICY,
  SECRET_CONFIG_CATEGORIES,
  isSecretConfigKey,
  maskSecret,
  maskConfigValue,
} from './config-policy.js';

// NZR-43 unit tests for the runtime-config category policy and value masking.
// All secret-looking values are fake fixtures.

describe('CONFIG_POLICY', () => {
  it('pins the read capability of every served category', () => {
    const expected: Record<string, string> = {
      profile: 'dashboard:read', branding: 'dashboard:read', themes: 'dashboard:read',
      cost: 'dashboard:read', sessions: 'dashboard:read', rate_limits: 'dashboard:read',
      memory: 'dashboard:read', media: 'dashboard:read', images: 'dashboard:read',
      agent: 'dashboard:read', bedrock: 'dashboard:read', delegation: 'dashboard:read',
      drift: 'dashboard:read', iam: 'dashboard:read',
      paperclip: 'integrations:read',
      power: 'security:read', alerting: 'security:read', jarvis: 'security:read',
    };
    expect(Object.fromEntries([...CONFIG_POLICY].map(([k, v]) => [k, v.read]))).toEqual(expected);
  });

  it('never serves a secret category and has no prototype keys', () => {
    expect([...SECRET_CONFIG_CATEGORIES].sort()).toEqual(['mcp', 'oauth', 'oauth_state']);
    for (const c of [...SECRET_CONFIG_CATEGORIES, 'OAUTH', 'constructor', '__proto__', 'toString', '']) {
      expect(CONFIG_POLICY.get(c)).toBeUndefined();
    }
  });
});

describe('isSecretConfigKey', () => {
  it('isSecretConfigKey matches secret names and not tunables', () => {
    for (const k of ['client_secret', 'clientSecret', 'signingSecret', 'bearerToken', 'api_key', 'apiKey',
      'slack_bot_token', 'refresh_token', 'accessToken', 'password', 'private_key', 'aws_credentials']) {
      expect(isSecretConfigKey(k), k).toBe(true);
    }
    for (const k of ['max_output_tokens', 'watch_enabled', 'first_name', 'library', 'active',
      'daily_cap_usd', 'base_url', 'hive_promote_min_confidence', 'tokens', 'id']) {
      expect(isSecretConfigKey(k), k).toBe(false);
    }
  });
});

describe('maskSecret', () => {
  it('keeps only the last 4 characters from 12 up, nothing below', () => {
    expect(maskSecret('abc')).toBe('****');
    expect(maskSecret('abcdefghijk')).toBe('****');
    expect(maskSecret('abcdefghijkl')).toBe('****ijkl');
    expect(maskSecret('x'.repeat(36) + 'WXYZ')).toBe('****WXYZ');
    expect(maskSecret('')).toBe('****');
  });
});

describe('maskConfigValue', () => {
  it('masks the whole value when the key is secret-shaped', () => {
    expect(maskConfigValue('api_key', 'sk-live-1234567890abcd')).toBe('****abcd');
    expect(maskConfigValue('apiKey', '{"a":1}')).toBe('****');
  });

  it('passes non-secret keys, null and undefined through', () => {
    expect(maskConfigValue('base_url', 'https://pc.internal')).toBe('https://pc.internal');
    expect(maskConfigValue('first_name', null)).toBeNull();
    expect(maskConfigValue('first_name', undefined)).toBeUndefined();
  });

  it('maskConfigValue masks nested JSON fields and leaves untouched JSON byte-identical', () => {
    const nested = '{"items":[{"id":"a","bearerToken":"tok-abcdefgh1234wxyz","cfg":{"clientSecret":"short"}}]}';
    const out = maskConfigValue('servers_json', nested) as string;
    expect(JSON.parse(out)).toEqual({ items: [{ id: 'a', bearerToken: '****wxyz', cfg: { clientSecret: '****' } }] });

    // A secret-named field holding a non-string is masked too.
    expect(JSON.parse(maskConfigValue('x', '{"credentials":{"user":"u","pw":"p"}}') as string))
      .toEqual({ credentials: '****' });

    // Untouched JSON: same string, not re-serialized (spacing kept).
    const library = '[ {"id":"dawn", "tokens": {"bg":"#fff"}} ]';
    expect(maskConfigValue('library', library)).toBe(library);
  });

  it('leaves a non-JSON value that starts with { unchanged', () => {
    expect(maskConfigValue('note', '{not json')).toBe('{not json');
    expect(maskConfigValue('note', '[1,')).toBe('[1,');
  });
});
