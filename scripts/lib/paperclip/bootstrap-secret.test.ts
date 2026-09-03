import { describe, expect, it } from 'vitest';
import {
  loadBootstrapSecretFields,
  mergeBootstrapSecretFields,
  parseBootstrapAgentKeys,
} from './bootstrap-secret.js';

describe('Paperclip bootstrap secret safety', () => {
  it.each([
    ['an unreadable secret', async () => Promise.reject(new Error('access denied'))],
    ['invalid JSON', async () => '{"agent_keys":"pcp_live"'],
    ['a non-object JSON value', async () => 'null'],
  ])('stops the run for %s before credentials can be reconciled', async (_label, read) => {
    await expect(
      loadBootstrapSecretFields({ secretId: '/claudeclaw-staging/paperclip', read }),
    ).rejects.toThrow(
      'could not read or parse /claudeclaw-staging/paperclip; refusing to reconcile live one-time agent keys',
    );
  });

  it('accepts only the explicit first-install agent-key states as empty', () => {
    for (const value of [undefined, '', 'REPLACE_ME']) {
      expect(
        parseBootstrapAgentKeys({ value, secretId: '/claudeclaw-staging/paperclip' }),
      ).toEqual({});
    }
  });

  it('stops the run when the stored agent-key JSON is corrupt', () => {
    expect(() =>
      parseBootstrapAgentKeys({
        value: '{"main":"pcp-live-secret"',
        secretId: '/claudeclaw-staging/paperclip',
      }),
    ).toThrow(
      'could not parse agent_keys in /claudeclaw-staging/paperclip; refusing to reconcile live one-time agent keys',
    );
  });

  it('returns a valid stored agent-key map unchanged', () => {
    expect(
      parseBootstrapAgentKeys({
        value: '{"main":"pcp-main","research":"pcp-research"}',
        secretId: '/claudeclaw-staging/paperclip',
      }),
    ).toEqual({ main: 'pcp-main', research: 'pcp-research' });
  });

  it('merges company_id beside agent_keys while preserving the complete prior field set', () => {
    const next = mergeBootstrapSecretFields({
      current: {
        better_auth_secret: 'auth-kept',
        database_url: 'postgres-kept',
        dispatch_secret: 'dispatch-kept',
        future_field: 'future-kept',
      },
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

    expect(next).toEqual({
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
    expect(Object.keys(next).sort()).toEqual([
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
