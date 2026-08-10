import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWarpPrivateAccess } from './warp-private-access.js';

/**
 * Private WARP access is an OPT-IN overlay on the existing no-domain
 * `infra-only` posture. The resolver is kept pure (no CDK, no AWS, no
 * Cloudflare) so every safety invariant below is provable without
 * synthesizing a stack:
 *
 *   - default OFF, so no existing client deploy changes shape;
 *   - only valid in the internal-ALB corner (`infra-only`, no DOMAIN_NAME),
 *     because the connector must never front a public HTTPS listener;
 *   - `salessly.io` is prohibited outright — that zone and the `claudeclaw`
 *     tunnel belong to a different, already-live system.
 */

const repoDir = dirname(fileURLToPath(import.meta.url));

describe('resolveWarpPrivateAccess', () => {
  it('defaults off without changing existing deploys', () => {
    expect(resolveWarpPrivateAccess({})).toEqual({ enabled: false });
  });

  it('stays off for any value other than the exact literal "1" (typo-safe)', () => {
    for (const value of ['', ' ', '0', 'true', 'yes', 'on', '11']) {
      expect(resolveWarpPrivateAccess({ CCE_WARP_PRIVATE_ACCESS: value })).toEqual({
        enabled: false,
      });
    }
  });

  it('accepts only no-domain infra-only mode', () => {
    expect(() =>
      resolveWarpPrivateAccess({
        CCE_WARP_PRIVATE_ACCESS: '1',
        CCE_DEPLOY_MODE: 'chat',
      }),
    ).toThrow(/requires CCE_DEPLOY_MODE=infra-only/);
  });

  it('derives the private zone and record', () => {
    expect(
      resolveWarpPrivateAccess({
        CCE_WARP_PRIVATE_ACCESS: '1',
        CCE_DEPLOY_MODE: 'infra-only',
      }),
    ).toEqual({
      enabled: true,
      hostname: 'dashboard.pgn.internal',
      zoneName: 'pgn.internal',
      recordName: 'dashboard',
      tunnelName: 'netzar-production-private',
    });
  });

  it('rejects salessly.io and public-domain mode', () => {
    for (const env of [
      { CCE_WARP_PRIVATE_ACCESS: '1', CCE_DEPLOY_MODE: 'infra-only', DOMAIN_NAME: 'pgn.example.com' },
      {
        CCE_WARP_PRIVATE_ACCESS: '1',
        CCE_DEPLOY_MODE: 'infra-only',
        CCE_WARP_PRIVATE_HOSTNAME: 'dashboard.salessly.io',
      },
    ]) {
      expect(() => resolveWarpPrivateAccess(env)).toThrow();
    }
  });

  it('prohibits the salessly.io apex and every subdomain of it', () => {
    for (const hostname of ['salessly.io', 'dash.salessly.io', 'a.b.salessly.io', 'DASH.SALESSLY.IO']) {
      expect(() =>
        resolveWarpPrivateAccess({
          CCE_WARP_PRIVATE_ACCESS: '1',
          CCE_DEPLOY_MODE: 'infra-only',
          CCE_WARP_PRIVATE_HOSTNAME: hostname,
        }),
      ).toThrow(/salessly\.io is prohibited/);
    }
  });

  it('normalizes an explicit hostname and splits it into record + zone', () => {
    expect(
      resolveWarpPrivateAccess({
        CCE_WARP_PRIVATE_ACCESS: '1',
        CCE_DEPLOY_MODE: 'infra-only',
        CCE_WARP_PRIVATE_HOSTNAME: '  Dashboard.Ops.PGN.Internal  ',
      }),
    ).toEqual({
      enabled: true,
      hostname: 'dashboard.ops.pgn.internal',
      zoneName: 'ops.pgn.internal',
      recordName: 'dashboard',
      tunnelName: 'netzar-production-private',
    });
  });

  it('rejects malformed hostnames instead of synthesizing a broken zone', () => {
    for (const hostname of [
      'dashboard',
      'dashboard.internal',
      'dashboard..internal',
      '-bad.pgn.internal',
      'bad-.pgn.internal',
      'dash board.pgn.internal',
      'dashboard.pgn.internal.',
      'dash_board.pgn.internal',
    ]) {
      expect(() =>
        resolveWarpPrivateAccess({
          CCE_WARP_PRIVATE_ACCESS: '1',
          CCE_DEPLOY_MODE: 'infra-only',
          CCE_WARP_PRIVATE_HOSTNAME: hostname,
        }),
      ).toThrow();
    }
  });

  it('treats a blank DOMAIN_NAME as no domain (still private)', () => {
    const r = resolveWarpPrivateAccess({
      CCE_WARP_PRIVATE_ACCESS: '1',
      CCE_DEPLOY_MODE: 'infra-only',
      DOMAIN_NAME: '   ',
    });
    expect(r.enabled).toBe(true);
  });

  it('pins the tunnel name to the exact agreed literal', () => {
    const r = resolveWarpPrivateAccess({
      CCE_WARP_PRIVATE_ACCESS: '1',
      CCE_DEPLOY_MODE: 'infra-only',
    });
    expect(r.enabled && r.tunnelName).toBe('netzar-production-private');
  });
});

describe('lifecycle forwarding (source-level)', () => {
  const deploySource = readFileSync(join(repoDir, '..', '..', 'scripts', 'deploy.ts'), 'utf8');
  const manifestSource = readFileSync(
    join(repoDir, '..', '..', 'scripts', 'lib', 'lifecycle', 'manifest.ts'),
    'utf8',
  );

  it('forwards the two non-secret WARP vars into the cdk env bag', () => {
    const bag = deploySource.slice(deploySource.indexOf('function cdkEnvBag'));
    expect(bag).toMatch(/CCE_WARP_PRIVATE_ACCESS: env\.CCE_WARP_PRIVATE_ACCESS \?\? ''/);
    expect(bag).toMatch(/CCE_WARP_PRIVATE_HOSTNAME: env\.CCE_WARP_PRIVATE_HOSTNAME \?\? ''/);
  });

  it('records those vars as synth inputs so rollback replays the same shape', () => {
    expect(manifestSource).toContain("'CCE_WARP_PRIVATE_ACCESS'");
    expect(manifestSource).toContain("'CCE_WARP_PRIVATE_HOSTNAME'");
  });

  it('never forwards a Cloudflare token or credential path through the lifecycle', () => {
    for (const forbidden of ['TUNNEL_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY']) {
      expect(deploySource).not.toContain(forbidden);
      expect(manifestSource).not.toContain(forbidden);
    }
  });
});
