import { describe, it, expect } from 'vitest';
import {
  syncPublicTunnelSecret,
  PublicSetupBlocker,
  PUBLIC_SECRET_READY_STAGE,
  type CloudflaredAdapter,
  type SecretsManagerLike,
} from './setup.js';

/**
 * The connector token is the one value here that must never be seen. These
 * tests pin the paths it could leak through: the return value, the progress
 * log, and any thrown error. They also pin the ordering guarantee that makes
 * a wrong-profile run harmless — the account guard fires before Cloudflare is
 * read and before Secrets Manager is written.
 */

const ACCOUNT = '239887088812';
const TOKEN = 'eyJhIjoiVE9LRU4tTVVTVC1OT1QtTEVBSyJ9';
const SECRET_ID = 'claudeclaw-public-tunnel';
const TUNNEL = 'netzar-production-public';

function cloudflaredStub(opts: { tunnels?: unknown; token?: string; calls?: string[][] } = {}) {
  const calls = opts.calls ?? [];
  const adapter: CloudflaredAdapter = {
    async capture(args: string[]): Promise<string> {
      calls.push(args);
      if (args[1] === 'list') {
        return JSON.stringify(
          opts.tunnels ?? [
            { id: 'claudeclaw-id', name: 'claudeclaw' },
            { id: 'public-id', name: 'netzar-production-public' },
          ],
        );
      }
      if (args[1] === 'token') return opts.token ?? TOKEN;
      return '';
    },
  };
  return { adapter, calls };
}

function secretsStub(opts: { throws?: Error; sent?: unknown[] } = {}) {
  const sent = opts.sent ?? [];
  const client: SecretsManagerLike = {
    async send(command: unknown): Promise<{ VersionId?: string }> {
      sent.push(command);
      if (opts.throws) throw opts.throws;
      return { VersionId: 'v1' };
    },
  };
  return { client, sent };
}

describe('syncPublicTunnelSecret', () => {
  it('writes the token under the field compute-stack reads, with both stages', async () => {
    const { adapter } = cloudflaredStub();
    const { client, sent } = secretsStub();

    const result = await syncPublicTunnelSecret({
      expectedAccountId: ACCOUNT,
      actualAccountId: ACCOUNT,
      secretId: SECRET_ID,
      tunnelName: TUNNEL,
      cloudflared: adapter,
      secrets: client,
    });

    expect(result).toEqual({
      tunnelId: 'public-id',
      tunnelName: 'netzar-production-public',
      secretVersionId: 'v1',
    });

    const input = (sent[0] as { input: Record<string, unknown> }).input;
    expect(input.SecretId).toBe(SECRET_ID);
    // The key must be `token`: EcsSecret.fromSecretsManager(secret, 'token').
    expect(JSON.parse(input.SecretString as string)).toEqual({ token: TOKEN });
    expect(input.VersionStages).toEqual(['AWSCURRENT', PUBLIC_SECRET_READY_STAGE]);
  });

  it('never returns or logs the token', async () => {
    const { adapter } = cloudflaredStub();
    const { client } = secretsStub();
    const lines: string[] = [];

    const result = await syncPublicTunnelSecret({
      expectedAccountId: ACCOUNT,
      actualAccountId: ACCOUNT,
      secretId: SECRET_ID,
      tunnelName: TUNNEL,
      cloudflared: adapter,
      secrets: client,
      log: (l) => lines.push(l),
    });

    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).toContain('token not displayed');
  });

  it('scrubs the token out of a Secrets Manager error', async () => {
    const { adapter } = cloudflaredStub();
    // Simulates an SDK error that echoes request context including the body.
    const { client } = secretsStub({ throws: new Error(`ValidationException: body was ${TOKEN}`) });

    await expect(
      syncPublicTunnelSecret({
        expectedAccountId: ACCOUNT,
        actualAccountId: ACCOUNT,
        secretId: SECRET_ID,
        tunnelName: TUNNEL,
        cloudflared: adapter,
        secrets: client,
      }),
    ).rejects.toThrow(/\[redacted\]/);

    await expect(
      syncPublicTunnelSecret({
        expectedAccountId: ACCOUNT,
        actualAccountId: ACCOUNT,
        secretId: SECRET_ID,
        tunnelName: TUNNEL,
        cloudflared: adapter,
        secrets: client,
      }),
    ).rejects.not.toThrow(new RegExp(TOKEN));
  });

  it('refuses a wrong account BEFORE reading Cloudflare or writing AWS', async () => {
    const { adapter, calls } = cloudflaredStub();
    const { client, sent } = secretsStub();

    await expect(
      syncPublicTunnelSecret({
        expectedAccountId: ACCOUNT,
        actualAccountId: '111122223333',
        secretId: SECRET_ID,
        tunnelName: TUNNEL,
        cloudflared: adapter,
        secrets: client,
      }),
    ).rejects.toBeInstanceOf(PublicSetupBlocker);

    // The whole point: a wrong-profile run mutates nothing, anywhere.
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('refuses to run with no expected account id at all', async () => {
    const { adapter, calls } = cloudflaredStub();
    const { client, sent } = secretsStub();

    await expect(
      syncPublicTunnelSecret({
        expectedAccountId: '',
        actualAccountId: ACCOUNT,
        secretId: SECRET_ID,
        tunnelName: TUNNEL,
        cloudflared: adapter,
        secrets: client,
      }),
    ).rejects.toThrow(/expected AWS account id/);
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('never selects the unrelated claudeclaw tunnel', async () => {
    // Only the salessly.io tunnel exists. Matching must be exact, so this is
    // a blocker rather than a silent hijack of another system's tunnel.
    const { adapter } = cloudflaredStub({ tunnels: [{ id: 'cc', name: 'claudeclaw' }] });
    const { client, sent } = secretsStub();

    await expect(
      syncPublicTunnelSecret({
        expectedAccountId: ACCOUNT,
        actualAccountId: ACCOUNT,
        secretId: SECRET_ID,
        tunnelName: TUNNEL,
        cloudflared: adapter,
        secrets: client,
      }),
    ).rejects.toThrow(/Create the remotely managed `netzar-production-public`/);
    expect(sent).toEqual([]);
  });

  it('blocks on an empty or placeholder token instead of writing it', async () => {
    for (const token of ['', '   ', 'REPLACE_ME']) {
      const { adapter } = cloudflaredStub({ token });
      const { client, sent } = secretsStub();

      await expect(
        syncPublicTunnelSecret({
          expectedAccountId: ACCOUNT,
          actualAccountId: ACCOUNT,
          secretId: SECRET_ID,
          tunnelName: TUNNEL,
          cloudflared: adapter,
          secrets: client,
        }),
      ).rejects.toBeInstanceOf(PublicSetupBlocker);
      expect(sent).toEqual([]);
    }
  });

  it('does not echo raw cloudflared output when the listing is unparseable', async () => {
    const adapter: CloudflaredAdapter = {
      async capture(): Promise<string> {
        return 'You need to login: operator-account-detail-that-must-not-echo';
      },
    };
    const { client } = secretsStub();

    await expect(
      syncPublicTunnelSecret({
        expectedAccountId: ACCOUNT,
        actualAccountId: ACCOUNT,
        secretId: SECRET_ID,
        tunnelName: TUNNEL,
        cloudflared: adapter,
        secrets: client,
      }),
    ).rejects.not.toThrow(/operator-account-detail/);
  });
});
