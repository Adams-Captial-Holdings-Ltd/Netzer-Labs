import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  syncWarpTunnelSecret,
  WarpSetupBlocker,
  WARP_SECRET_READY_STAGE,
  type CloudflaredAdapter,
  type SecretsManagerLike,
} from './setup.js';

/**
 * The whole point of this module is that a Cloudflare connector token moves
 * from `cloudflared` into Secrets Manager WITHOUT ever becoming an argument,
 * a log line, an exception message, or a return value. These tests inject
 * fakes for both external systems so the suite never touches Cloudflare or
 * AWS, and assert the redaction contract directly.
 */

const TUNNEL_ID = '11111111-1111-4111-8111-111111111111';
const SECRET_ID = '/claudeclaw/cloudflare-tunnel';
const TOKEN = 'sensitive-tunnel-token';

function fakeCloudflared(opts: {
  tunnels: Array<{ id?: string; name?: string }>;
  token?: string;
}): CloudflaredAdapter & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async capture(args: string[]): Promise<string> {
      calls.push(args);
      if (args[0] === 'tunnel' && args[1] === 'list') return JSON.stringify(opts.tunnels);
      if (args[0] === 'tunnel' && args[1] === 'token') return `${opts.token ?? ''}\n`;
      throw new Error(`unexpected cloudflared invocation: ${args.join(' ')}`);
    },
  };
}

function fakeSecrets(versionId = 'version-42'): SecretsManagerLike & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    async send(command: unknown): Promise<{ VersionId?: string }> {
      sent.push(command);
      return { VersionId: versionId };
    },
  };
}

function denyCloudflared(): CloudflaredAdapter {
  return {
    async capture(): Promise<string> {
      throw new Error('cloudflared must not be invoked');
    },
  };
}

function denySecrets(): SecretsManagerLike {
  return {
    async send(): Promise<{ VersionId?: string }> {
      throw new Error('Secrets Manager must not be invoked');
    },
  };
}

const inputOf = (command: unknown): Record<string, unknown> =>
  (command as { input: Record<string, unknown> }).input;

describe('syncWarpTunnelSecret', () => {
  it('reuses the exact tunnel name and writes its token without logging it', async () => {
    const logs: string[] = [];
    const result = await syncWarpTunnelSecret({
      expectedAccountId: '239887088812',
      actualAccountId: '239887088812',
      secretId: SECRET_ID,
      cloudflared: fakeCloudflared({
        tunnels: [{ id: TUNNEL_ID, name: 'netzar-production-private' }],
        token: TOKEN,
      }),
      secrets: fakeSecrets(),
      log: (line) => logs.push(line),
    });
    expect(result.tunnelId).toBe(TUNNEL_ID);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('refuses the wrong AWS account before Cloudflare or Secrets Manager mutation', async () => {
    await expect(
      syncWarpTunnelSecret({
        expectedAccountId: '239887088812',
        actualAccountId: '000000000000',
        secretId: SECRET_ID,
        cloudflared: denyCloudflared(),
        secrets: denySecrets(),
      }),
    ).rejects.toThrow(/expected 239887088812/);
  });

  it('returns the tunnel name and secret version, and never the token itself', async () => {
    const result = await syncWarpTunnelSecret({
      expectedAccountId: '239887088812',
      actualAccountId: '239887088812',
      secretId: SECRET_ID,
      cloudflared: fakeCloudflared({
        tunnels: [{ id: TUNNEL_ID, name: 'netzar-production-private' }],
        token: TOKEN,
      }),
      secrets: fakeSecrets('version-42'),
    });
    expect(result).toEqual({
      tunnelId: TUNNEL_ID,
      tunnelName: 'netzar-production-private',
      secretVersionId: 'version-42',
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('stages the new version as both AWSCURRENT and the deploy-gate stage', async () => {
    const secrets = fakeSecrets();
    await syncWarpTunnelSecret({
      expectedAccountId: '239887088812',
      actualAccountId: '239887088812',
      secretId: SECRET_ID,
      cloudflared: fakeCloudflared({
        tunnels: [{ id: TUNNEL_ID, name: 'netzar-production-private' }],
        token: TOKEN,
      }),
      secrets,
    });
    expect(secrets.sent).toHaveLength(1);
    const input = inputOf(secrets.sent[0]);
    expect(input.SecretId).toBe(SECRET_ID);
    expect(input.VersionStages).toEqual(['AWSCURRENT', WARP_SECRET_READY_STAGE]);
    // The token rides the JSON `token` field and nothing else.
    expect(input.SecretString).toBe(JSON.stringify({ token: TOKEN }));
  });

  it('never passes the token as a command-line argument', async () => {
    const cloudflared = fakeCloudflared({
      tunnels: [{ id: TUNNEL_ID, name: 'netzar-production-private' }],
      token: TOKEN,
    });
    await syncWarpTunnelSecret({
      expectedAccountId: '239887088812',
      actualAccountId: '239887088812',
      secretId: SECRET_ID,
      cloudflared,
      secrets: fakeSecrets(),
    });
    for (const call of cloudflared.calls) {
      expect(call.join(' ')).not.toContain(TOKEN);
    }
    // Exactly the two read-only cloudflared calls, in order.
    expect(cloudflared.calls).toEqual([
      ['tunnel', 'list', '--output', 'json'],
      ['tunnel', 'token', TUNNEL_ID],
    ]);
  });

  it('is idempotent: re-running reuses the existing tunnel and creates none', async () => {
    const cloudflared = fakeCloudflared({
      tunnels: [
        { id: 'other-id', name: 'claudeclaw' },
        { id: TUNNEL_ID, name: 'netzar-production-private' },
      ],
      token: TOKEN,
    });
    const opts = {
      expectedAccountId: '239887088812',
      actualAccountId: '239887088812',
      secretId: SECRET_ID,
      cloudflared,
      secrets: fakeSecrets(),
    };
    const first = await syncWarpTunnelSecret(opts);
    const second = await syncWarpTunnelSecret(opts);
    expect(second.tunnelId).toBe(first.tunnelId);
    expect(cloudflared.calls.some((c) => c.includes('create'))).toBe(false);
    expect(cloudflared.calls.some((c) => c.includes('delete'))).toBe(false);
  });

  it('blocks with the connected-API remediation when the named tunnel is absent', async () => {
    const secrets = fakeSecrets();
    await expect(
      syncWarpTunnelSecret({
        expectedAccountId: '239887088812',
        actualAccountId: '239887088812',
        secretId: SECRET_ID,
        cloudflared: fakeCloudflared({ tunnels: [{ id: 'other-id', name: 'claudeclaw' }] }),
        secrets,
      }),
    ).rejects.toThrow(WarpSetupBlocker);
    // Nothing was written when the tunnel does not exist.
    expect(secrets.sent).toHaveLength(0);
  });

  it('names the remotely managed tunnel in the blocker, not a local substitute', async () => {
    const err = (await syncWarpTunnelSecret({
      expectedAccountId: '239887088812',
      actualAccountId: '239887088812',
      secretId: SECRET_ID,
      cloudflared: fakeCloudflared({ tunnels: [] }),
      secrets: fakeSecrets(),
    }).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('netzar-production-private');
    expect(err.message).toContain('npm run warp:setup');
    expect(err.message).not.toMatch(/cloudflared tunnel create/);
  });

  it('rejects an empty or placeholder token instead of writing it', async () => {
    for (const token of ['', '   ', 'REPLACE_ME']) {
      const secrets = fakeSecrets();
      await expect(
        syncWarpTunnelSecret({
          expectedAccountId: '239887088812',
          actualAccountId: '239887088812',
          secretId: SECRET_ID,
          cloudflared: fakeCloudflared({
            tunnels: [{ id: TUNNEL_ID, name: 'netzar-production-private' }],
            token,
          }),
          secrets,
        }),
      ).rejects.toThrow(/no tunnel token/);
      expect(secrets.sent).toHaveLength(0);
    }
  });

  it('redacts the token if the Secrets Manager write fails', async () => {
    const err = (await syncWarpTunnelSecret({
      expectedAccountId: '239887088812',
      actualAccountId: '239887088812',
      secretId: SECRET_ID,
      cloudflared: fakeCloudflared({
        tunnels: [{ id: TUNNEL_ID, name: 'netzar-production-private' }],
        token: TOKEN,
      }),
      secrets: {
        async send(): Promise<{ VersionId?: string }> {
          throw new Error(`AccessDenied while storing ${TOKEN}`);
        },
      },
    }).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain(SECRET_ID);
  });

  it('refuses a blank expected account rather than trusting whatever is current', async () => {
    await expect(
      syncWarpTunnelSecret({
        expectedAccountId: '',
        actualAccountId: '239887088812',
        secretId: SECRET_ID,
        cloudflared: denyCloudflared(),
        secrets: denySecrets(),
      }),
    ).rejects.toThrow();
  });
});

describe('warp setup source contract', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const setupSource = readFileSync(join(here, 'setup.ts'), 'utf8');
  const commandSource = readFileSync(join(here, '..', '..', 'warp-setup.ts'), 'utf8');

  it('pipes cloudflared stdout instead of inheriting it, so the token is never printed', () => {
    expect(setupSource).toMatch(/spawn\(/);
    expect(setupSource).toContain("'pipe'");
  });

  it('inherits a TTY only for the interactive browser login', () => {
    expect(setupSource).toMatch(/tunnel['"]?,\s*['"]login/);
    expect(setupSource).toContain('inherit');
  });

  it('exposes the operator command without any token-bearing flag', () => {
    expect(commandSource).toContain('--help');
    expect(commandSource).toContain('--plan');
    expect(commandSource).toContain('--json');
    expect(commandSource).not.toMatch(/--token\b/);
    expect(commandSource).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(commandSource).not.toContain('TUNNEL_TOKEN');
  });

  it('tells the operator to authorize in a browser and never to paste a token', () => {
    expect(commandSource + setupSource).toContain('cloudflared tunnel login');
    expect(commandSource + setupSource).toMatch(/Do not paste any token/);
  });

  it('names the deploy-first remediation when the secret does not exist yet', () => {
    expect(commandSource + setupSource).toMatch(/run `npm run deploy` once/);
  });

  it('registers the npm script that the remediation text tells people to run', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['warp:setup']).toBe('tsx scripts/warp-setup.ts');
  });
});
