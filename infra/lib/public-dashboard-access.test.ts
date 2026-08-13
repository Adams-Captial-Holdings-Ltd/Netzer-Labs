import { describe, it, expect } from 'vitest';
import {
  resolvePublicDashboardAccess,
  PUBLIC_DEFAULT_HOSTNAME,
  PUBLIC_TUNNEL_NAME,
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

  it('normalizes an explicit hostname and splits it into record + zone', () => {
    expect(
      resolvePublicDashboardAccess({ ...on, CCE_PUBLIC_HOSTNAME: '  App.Staging.PGNOS.ai  ' }),
    ).toEqual({
      enabled: true,
      hostname: 'app.staging.pgnos.ai',
      zoneName: 'staging.pgnos.ai',
      recordName: 'app',
      tunnelName: 'netzar-production-public',
      service: 'http://localhost:3000',
    });
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
