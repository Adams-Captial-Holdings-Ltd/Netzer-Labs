import { describe, it, expect } from 'vitest';
import {
  resolvePublicDashboardAccess,
  assertPublicEntrypointRenderable,
  PUBLIC_DEFAULT_HOSTNAME,
  PUBLIC_TUNNEL_NAME,
  buildPublicTunnelName,
  buildPublicTunnelSecretName,
} from './public-dashboard-access.js';

/**
 * Public dashboard access is an OPT-IN overlay on the existing no-domain
 * `infra-only` posture. The resolver is kept pure (no CDK, no AWS, no
 * Cloudflare) so every safety invariant below is provable without
 * synthesizing a stack:
 *
 *   - default OFF, so no existing deploy changes shape;
 *   - only valid in the internal-ALB corner (`infra-only`, no DOMAIN_NAME),
 *     because Cloudflare must be the only public edge;
 *   - mutually exclusive with WARP, since both add a connector to one task;
 *   - `salessly.io` is prohibited outright — that zone and the `claudeclaw`
 *     tunnel belong to a different, already-live system;
 *   - the hostname must live inside `pgnos.ai`, so publishing anywhere else
 *     is impossible by construction.
 */

const on = {
  CCE_PUBLIC_ACCESS: '1',
  CCE_DEPLOY_MODE: 'infra-only',
};

describe('resolvePublicDashboardAccess', () => {
  it('defaults off without changing existing deploys', () => {
    expect(resolvePublicDashboardAccess({})).toEqual({ enabled: false });
  });

  it('stays off for any value other than the exact literal "1" (typo-safe)', () => {
    for (const value of ['', ' ', '0', 'true', 'yes', 'on', '11']) {
      expect(resolvePublicDashboardAccess({ CCE_PUBLIC_ACCESS: value })).toEqual({
        enabled: false,
      });
    }
  });

  it('resolves the agreed production hostname by default', () => {
    expect(resolvePublicDashboardAccess(on)).toEqual({
      enabled: true,
      hostname: 'app.pgnos.ai',
      zoneName: 'pgnos.ai',
      recordName: 'app',
      tunnelName: 'netzar-production-public',
      service: 'http://localhost:3000',
    });
  });

  it('pins the tunnel name and default hostname to the exact agreed literals', () => {
    expect(PUBLIC_TUNNEL_NAME).toBe('netzar-production-public');
    expect(PUBLIC_DEFAULT_HOSTNAME).toBe('app.pgnos.ai');
  });

  it('forwards only to the task-local orchestrator port', () => {
    const r = resolvePublicDashboardAccess(on);
    expect(r.enabled && r.service).toBe('http://localhost:3000');
  });

  it('accepts only no-domain infra-only mode', () => {
    expect(() =>
      resolvePublicDashboardAccess({ ...on, CCE_DEPLOY_MODE: 'chat' }),
    ).toThrow(/requires CCE_DEPLOY_MODE=infra-only/);

    expect(() =>
      resolvePublicDashboardAccess({ ...on, DOMAIN_NAME: 'app.pgnos.ai' }),
    ).toThrow(/requires CCE_DEPLOY_MODE=infra-only and no DOMAIN_NAME/);
  });

  it('treats a blank DOMAIN_NAME as no domain (still valid)', () => {
    expect(resolvePublicDashboardAccess({ ...on, DOMAIN_NAME: '   ' }).enabled).toBe(true);
  });

  it('refuses to run alongside the WARP connector', () => {
    expect(() =>
      resolvePublicDashboardAccess({ ...on, CCE_WARP_PRIVATE_ACCESS: '1' }),
    ).toThrow(/conflicts with CCE_WARP_PRIVATE_ACCESS/);
  });

  it('prohibits the salessly.io apex and every subdomain of it', () => {
    for (const hostname of [
      'salessly.io',
      'app.salessly.io',
      'a.b.salessly.io',
      'APP.SALESSLY.IO',
    ]) {
      expect(() =>
        resolvePublicDashboardAccess({ ...on, CCE_PUBLIC_HOSTNAME: hostname }),
      ).toThrow(/salessly\.io is prohibited/);
    }
  });

  it('refuses any zone other than pgnos.ai', () => {
    for (const hostname of ['app.example.com', 'app.pgnos.com', 'app.notpgnos.ai']) {
      expect(() =>
        resolvePublicDashboardAccess({ ...on, CCE_PUBLIC_HOSTNAME: hostname }),
      ).toThrow(/must be inside pgnos\.ai/);
    }
  });

  it('refuses the pgnos.ai apex, which carries unrelated records', () => {
    expect(() =>
      resolvePublicDashboardAccess({ ...on, CCE_PUBLIC_HOSTNAME: 'pgnos.ai' }),
    ).toThrow(/invalid CCE_PUBLIC_HOSTNAME/);
  });

  it('normalizes an explicit hostname and splits it against the real zone', () => {
    // The account holds exactly one zone, pgnos.ai. A naive first-label split
    // would claim zone "staging.pgnos.ai", which does not exist, and record
    // "app" instead of "app.staging".
    expect(
      resolvePublicDashboardAccess({ ...on, CCE_PUBLIC_HOSTNAME: '  App.Staging.PGNOS.ai  ' }),
    ).toEqual({
      enabled: true,
      hostname: 'app.staging.pgnos.ai',
      zoneName: 'pgnos.ai',
      recordName: 'app.staging',
      tunnelName: 'netzar-production-public',
      service: 'http://localhost:3000',
    });
  });

  it('treats a blank hostname as unset, the way cdkEnvBag forwards it', () => {
    // deploy.ts forwards every var as `env.X ?? ''`, so under a real deploy
    // this key is always defined and usually blank. `??` would keep the blank
    // and throw; blank must fall back to the default.
    for (const blank of ['', '   ']) {
      expect(resolvePublicDashboardAccess({ ...on, CCE_PUBLIC_HOSTNAME: blank })).toEqual({
        enabled: true,
        hostname: 'app.pgnos.ai',
        zoneName: 'pgnos.ai',
        recordName: 'app',
        tunnelName: 'netzar-production-public',
        service: 'http://localhost:3000',
      });
    }
  });

  it('rejects malformed hostnames instead of publishing a broken route', () => {
    for (const hostname of [
      'app',
      'app..pgnos.ai',
      '-bad.pgnos.ai',
      'bad-.pgnos.ai',
      'ap p.pgnos.ai',
      'app.pgnos.ai.',
      'ap_p.pgnos.ai',
    ]) {
      expect(() =>
        resolvePublicDashboardAccess({ ...on, CCE_PUBLIC_HOSTNAME: hostname }),
      ).toThrow();
    }
  });
});

/**
 * Every name this feature touches has to carry the environment suffix. These
 * pin the three ways a suffixed deploy could otherwise reach into production:
 * reading prod's tunnel, writing prod's secret, or claiming prod's hostname.
 */
describe('environment isolation', () => {
  it('derives a distinct tunnel per environment, prod unchanged', () => {
    expect(buildPublicTunnelName('')).toBe('netzar-production-public');
    expect(PUBLIC_TUNNEL_NAME).toBe('netzar-production-public');
    expect(buildPublicTunnelName('staging')).toBe('netzar-staging-public');
  });

  it('derives a distinct tunnel secret per environment, prod unchanged', () => {
    expect(buildPublicTunnelSecretName('')).toBe('claudeclaw-public-tunnel');
    expect(buildPublicTunnelSecretName('staging')).toBe('claudeclaw-staging-public-tunnel');
  });

  it('resolves the suffixed tunnel name for a suffixed environment', () => {
    const cfg = resolvePublicDashboardAccess({
      ...on,
      CCE_NAME_SUFFIX: 'staging',
      CCE_PUBLIC_HOSTNAME: 'staging.pgnos.ai',
    });
    expect(cfg.enabled).toBe(true);
    if (cfg.enabled) {
      expect(cfg).toEqual({
        enabled: true,
        hostname: 'staging.pgnos.ai',
        zoneName: 'pgnos.ai',
        recordName: 'staging',
        tunnelName: 'netzar-staging-public',
        service: 'http://localhost:3000',
      });
    }
  });

  it('refuses to let a suffixed environment inherit prod’s default hostname', () => {
    // Without this guard a staging deploy that forgot CCE_PUBLIC_HOSTNAME
    // would silently publish app.pgnos.ai and point prod's hostname at
    // staging's tunnel.
    for (const hostname of [undefined, '', '   ']) {
      expect(() =>
        resolvePublicDashboardAccess({
          ...on,
          CCE_NAME_SUFFIX: 'staging',
          CCE_PUBLIC_HOSTNAME: hostname,
        }),
      ).toThrow(/CCE_PUBLIC_HOSTNAME is required/);
    }
  });

  it('still defaults to the prod hostname when there is no suffix', () => {
    const cfg = resolvePublicDashboardAccess({ ...on, CCE_NAME_SUFFIX: '' });
    expect(cfg.enabled).toBe(true);
    if (cfg.enabled) expect(cfg.hostname).toBe(PUBLIC_DEFAULT_HOSTNAME);
  });
});

/**
 * Regression cover for the 2026-08-14 outage.
 *
 * The two-phase gate (deploy #1 creates an empty secret, `public:setup` fills
 * it, deploy #2 attaches the connector) is correct for a FIRST deploy and
 * catastrophic for a LIVE one. On 2026-08-14 the CI readiness probe ran at
 * 15:54:05 UTC — six minutes before the same deploy granted it
 * `secretsmanager:DescribeSecret` at 16:00:04 — and `2>/dev/null` turned the
 * resulting AccessDeniedException into "not ready". CloudFormation then removed
 * the cloudflared sidecar from a healthy production task, reported
 * UPDATE_COMPLETE, and app.pgnos.ai served Cloudflare 1033 for nine hours.
 *
 * The invariant locked down here: an environment that DECLARES a public
 * hostname may synthesize without a connector only when a human has said so in
 * as many words. An unreadable probe must stop the deploy, never quietly
 * demolish the only public entrypoint.
 */
describe('assertPublicEntrypointRenderable', () => {
  const on = {
    CCE_PUBLIC_ACCESS: '1',
    CCE_DEPLOY_MODE: 'infra-only',
    DOMAIN_NAME: '',
  };

  it('is a no-op when the feature is off', () => {
    const cfg = resolvePublicDashboardAccess({ CCE_PUBLIC_ACCESS: '0' });
    expect(() => assertPublicEntrypointRenderable(cfg, {})).not.toThrow();
  });

  it('passes when the connector is ready', () => {
    const cfg = resolvePublicDashboardAccess(on);
    expect(() =>
      assertPublicEntrypointRenderable(cfg, { ...on, CCE_PUBLIC_CONNECTOR_READY: '1' }),
    ).not.toThrow();
  });

  it('THROWS when the feature is on but the connector is not ready', () => {
    const cfg = resolvePublicDashboardAccess(on);
    expect(() =>
      assertPublicEntrypointRenderable(cfg, { ...on, CCE_PUBLIC_CONNECTOR_READY: '' }),
    ).toThrow(/no connector/);
  });

  it('names the hostname it is refusing to take offline', () => {
    const cfg = resolvePublicDashboardAccess({ ...on, CCE_PUBLIC_HOSTNAME: 'app.pgnos.ai' });
    expect(() => assertPublicEntrypointRenderable(cfg, on)).toThrow(/app\.pgnos\.ai/);
  });

  it('allows the secret-only first deploy ONLY behind an explicit opt-in', () => {
    const cfg = resolvePublicDashboardAccess(on);
    expect(() =>
      assertPublicEntrypointRenderable(cfg, { ...on, CCE_PUBLIC_BOOTSTRAP: '1' }),
    ).not.toThrow();
  });

  it('treats the bootstrap opt-in as an exact literal, like every other flag here', () => {
    const cfg = resolvePublicDashboardAccess(on);
    for (const value of ['true', 'yes', '0', ' 1', '']) {
      expect(() =>
        assertPublicEntrypointRenderable(cfg, { ...on, CCE_PUBLIC_BOOTSTRAP: value }),
      ).toThrow();
    }
  });

  it('does not accept a ready flag that is merely truthy', () => {
    const cfg = resolvePublicDashboardAccess(on);
    for (const value of ['true', 'yes', ' 1']) {
      expect(() =>
        assertPublicEntrypointRenderable(cfg, { ...on, CCE_PUBLIC_CONNECTOR_READY: value }),
      ).toThrow();
    }
  });
});
