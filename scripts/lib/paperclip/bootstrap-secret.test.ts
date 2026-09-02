import { describe, expect, it, vi } from 'vitest';
import {
  loadBootstrapSecretFields,
  mergeBootstrapSecretFields,
  parseBootstrapAgentKeys,
  writeBootstrapSecretFields,
} from './bootstrap-secret.js';

describe('Paperclip bootstrap secret safety', () => {
  it.each([
    ['an unreadable secret', async () => Promise.reject(new Error('access denied'))],
    ['invalid JSON', async () => '{"agent_keys":"pcp_live"'],
    ['a non-object JSON value', async () => 'null'],
  ])('stops a real run for %s before credentials can be reconciled', async (_label, read) => {
    const warn = vi.fn();
    await expect(
      loadBootstrapSecretFields({
        secretId: '/claudeclaw-staging/paperclip',
        dryRun: false,
        read,
        warn,
      }),
    ).rejects.toThrow(
      'could not read or parse /claudeclaw-staging/paperclip; refusing to reconcile live one-time agent keys',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['an unreadable secret', async () => Promise.reject(new Error('access denied'))],
    ['invalid JSON', async () => '{"agent_keys":"pcp_live"'],
  ])('keeps %s inspectable in --dry-run without exposing the error message', async (_label, read) => {
    const warnings: string[] = [];
    await expect(
      loadBootstrapSecretFields({
        secretId: '/claudeclaw-staging/paperclip',
        dryRun: true,
        read,
        warn: (message) => warnings.push(message),
      }),
    ).resolves.toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('assuming nothing stored for --dry-run');
    expect(warnings[0]).not.toContain('access denied');
    expect(warnings[0]).not.toContain('pcp_live');
  });

  it('accepts only the explicit first-install agent-key states as empty', () => {
    for (const value of [undefined, '', 'REPLACE_ME']) {
      expect(
        parseBootstrapAgentKeys({
          value,
          secretId: '/claudeclaw-staging/paperclip',
          dryRun: false,
          warn: vi.fn(),
        }),
      ).toEqual({});
    }
  });

  it('stops a real run when the stored agent-key JSON is corrupt', () => {
    const secret = '{"main":"pcp-live-secret"';
    expect(() =>
      parseBootstrapAgentKeys({
        value: secret,
        secretId: '/claudeclaw-staging/paperclip',
        dryRun: false,
        warn: vi.fn(),
      }),
    ).toThrow(
      'could not parse agent_keys in /claudeclaw-staging/paperclip; refusing to reconcile live one-time agent keys',
    );
  });

  it('keeps corrupt nested agent keys inspectable only in --dry-run without leaking them', () => {
    const secret = '{"main":"pcp-live-secret"';
    const warnings: string[] = [];
    expect(
      parseBootstrapAgentKeys({
        value: secret,
        secretId: '/claudeclaw-staging/paperclip',
        dryRun: true,
        warn: (message) => warnings.push(message),
      }),
    ).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('assuming no stored agent keys for --dry-run');
    expect(warnings[0]).not.toContain('pcp-live-secret');
  });

  it('returns a valid stored agent-key map unchanged', () => {
    expect(
      parseBootstrapAgentKeys({
        value: '{"main":"pcp-main","research":"pcp-research"}',
        secretId: '/claudeclaw-staging/paperclip',
        dryRun: false,
        warn: vi.fn(),
      }),
    ).toEqual({ main: 'pcp-main', research: 'pcp-research' });
  });

  it('writes company_id beside agent_keys while preserving the complete prior field set', async () => {
    const current = {
      better_auth_secret: 'auth-kept',
      database_url: 'postgres-kept',
      dispatch_secret: 'dispatch-kept',
      future_field: 'future-kept',
    };
    const next = mergeBootstrapSecretFields({
      current,
      companyId: 'company-uuid',
      storedAgentKeys: { research: 'pcp_research_kept' },
      outcomes: [
        {
          slug: '(reconciler)',
          keyName: 'netzar-reconciler',
          keyId: 'reconciler-key-id',
          scope: 'standard',
          action: 'created',
          token: 'pcp_reconciler_new',
        },
        {
          slug: 'main',
          keyName: 'netzar:agent:main',
          keyId: 'main-key-id',
          scope: 'standard',
          action: 'created',
          token: 'pcp_main_new',
        },
      ],
    });

    const writes: string[] = [];
    await writeBootstrapSecretFields({
      fields: next,
      write: async (secretString) => {
        writes.push(secretString);
      },
    });

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toEqual({
      better_auth_secret: 'auth-kept',
      database_url: 'postgres-kept',
      dispatch_secret: 'dispatch-kept',
      future_field: 'future-kept',
      reconciler_key: 'pcp_reconciler_new',
      agent_keys: JSON.stringify({
        research: 'pcp_research_kept',
        main: 'pcp_main_new',
      }),
      company_id: 'company-uuid',
    });
    expect(Object.keys(JSON.parse(writes[0])).sort()).toEqual([
      'agent_keys',
      'better_auth_secret',
      'company_id',
      'database_url',
      'dispatch_secret',
      'future_field',
      'reconciler_key',
    ]);
  });
});
