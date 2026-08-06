import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManifestSlice,
  isRouteAllowed,
  resolveRoute,
  RESOURCE_META,
  JARVIS_RESOURCES,
  ROUTE_TABLE,
  type JarvisRole,
} from './route-manifest.js';

describe('resolveRoute (fuzzy navigate target)', () => {
  it('resolves labels, paths, and near-misses to the allowed route', () => {
    expect(resolveRoute('admin', 'Memories')).toBe('/memories');
    expect(resolveRoute('admin', 'memories')).toBe('/memories');
    expect(resolveRoute('admin', '/memories')).toBe('/memories');
    expect(resolveRoute('admin', 'memory')).toBe('/memories');
    expect(resolveRoute('admin', 'overview')).toBe('/');
    expect(resolveRoute('admin', 'audit log')).toBe('/audit');
    // The Vectors route is labelled "Knowledge" in the UI; both names resolve.
    expect(resolveRoute('admin', 'knowledge')).toBe('/vectors');
    expect(resolveRoute('admin', 'vectors')).toBe('/vectors');
  });
  it('returns null for a gross mishearing rather than guessing wrong', () => {
    expect(resolveRoute('admin', 'thermostat')).toBeNull();
    expect(resolveRoute('admin', '')).toBeNull();
  });
  it('does not resolve an above-role route for a viewer', () => {
    expect(resolveRoute('viewer', 'kill switches')).toBeNull();
  });
});

describe('route-manifest — canonical resource matrix (Reference Contracts C)', () => {
  it('gates every launch resource at viewer EXCEPT audit (operator)', () => {
    for (const res of JARVIS_RESOURCES) {
      const expected = res === 'audit' ? 'operator' : 'viewer';
      expect(RESOURCE_META[res].minRole).toBe(expected);
    }
  });

  it('excludes tokens, config, and export entirely', () => {
    for (const excluded of ['tokens', 'config', 'export', 'inbox']) {
      expect(JARVIS_RESOURCES).not.toContain(excluded);
    }
  });

  it('keeps the exact 17-resource launch set', () => {
    expect(JARVIS_RESOURCES).toHaveLength(17);
    expect(JARVIS_RESOURCES).toContain('agent_health_single');
  });
});

describe('buildManifestSlice — role filtering', () => {
  it('hides audit from a viewer, shows it to an operator', () => {
    const viewer = buildManifestSlice('viewer').resources.map((r) => r.resource);
    const operator = buildManifestSlice('operator').resources.map((r) => r.resource);
    expect(viewer).not.toContain('audit');
    expect(operator).toContain('audit');
  });

  it('filters routes by role and always includes /jarvis', () => {
    const viewerRoutes = buildManifestSlice('viewer').routes.map((r) => r.route);
    expect(viewerRoutes).toContain('/jarvis');
    expect(viewerRoutes).toContain('/agents');
    expect(viewerRoutes).not.toContain('/kill-switches');

    const adminRoutes = buildManifestSlice('admin').routes.map((r) => r.route);
    expect(adminRoutes).toContain('/kill-switches');
  });

  it('never lists a higher-role resource for a lower role', () => {
    const roles: JarvisRole[] = ['viewer', 'operator', 'admin'];
    for (const role of roles) {
      for (const r of buildManifestSlice(role).resources) {
        expect(['viewer', 'operator', 'admin']).toContain(r.minRole);
      }
    }
  });
});

describe('isRouteAllowed', () => {
  it('allows exact + dynamic-child routes for the role', () => {
    expect(isRouteAllowed('viewer', '/agents')).toBe(true);
    expect(isRouteAllowed('viewer', '/agents/main')).toBe(true);
    expect(isRouteAllowed('viewer', '/jarvis')).toBe(true);
  });

  it('rejects path-traversal that would land above the role after normalization', () => {
    expect(isRouteAllowed('viewer', '/settings/../kill-switches')).toBe(false);
    expect(isRouteAllowed('viewer', '/agents/../dlp')).toBe(false);
  });

  it('blocks an above-role route for a viewer but allows it for admin', () => {
    expect(isRouteAllowed('viewer', '/kill-switches')).toBe(false);
    expect(isRouteAllowed('admin', '/kill-switches')).toBe(true);
  });

  it('rejects an unknown route', () => {
    expect(isRouteAllowed('admin', '/definitely-not-a-route')).toBe(false);
  });
});

describe('route-drift guard', () => {
  it('has unique routes, each with a known minRole', () => {
    const routes = ROUTE_TABLE.map((r) => r.route);
    expect(new Set(routes).size).toBe(routes.length);
    for (const r of ROUTE_TABLE) {
      expect(['viewer', 'operator', 'admin']).toContain(r.minRole);
    }
  });

  // Reference Contracts C: the manifest MUST match the live App.tsx route table.
  // An engineer who adds/regates a route in App.tsx without updating ROUTE_TABLE
  // would otherwise silently drift the Jarvis authorization surface (R8).
  it('matches the live web/src/App.tsx route table (paths + minRole)', () => {
    const appPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'web',
      'src',
      'App.tsx',
    );
    const app = readFileSync(appPath, 'utf8');
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // The pre-auth routes (/accept, /verify) render OUTSIDE the AuthGate in the
    // top-level Switch — they are reached from a magic-link email before a
    // session exists. They are intentionally NOT part of the authenticated,
    // Jarvis-navigable surface, so they are excluded from the drift check.
    const PRE_AUTH_ROUTES = new Set(['/accept', '/verify']);

    // Static routes in App.tsx (exclude the `:param` detail routes, the
    // path-less NotFound catch-all, and the pre-auth routes above).
    const appPaths = [...app.matchAll(/<Route\s+path="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((p) => !p.includes(':') && !PRE_AUTH_ROUTES.has(p));

    expect(new Set(ROUTE_TABLE.map((r) => r.route))).toEqual(new Set(appPaths));

    // minRole drift: App.tsx encodes the gate either as a <RequireRole need="…">
    // wrapper (legacy role rank) or, for finer-grained surfaces, a
    // <RequireCapability need="…"> wrapper. Map the capability to the templated
    // profile tier that holds it so the table's minRole stays honest:
    // Each capability maps to the LOWEST templated-profile tier in the Jarvis
    // role space (viewer < operator < admin) that holds it (src/lib/auth/
    // permissions.ts TEMPLATED_PROFILES), which is the navigable minRole for any
    // route gated on that capability. NOTE: the analyst tier (cost:read) collapses
    // to the Jarvis `viewer` rung, but no route gates on cost:read — /cost gates
    // on the operator-tier cost:write to preserve the operator baseline.
    //   Wave 5 per-tab viewer reads (overview/agents/chat/sessions/usage/audit/
    //     vectors/missions/memories/hive/scheduled/warroom):read -> viewer tier
    //     (held by VIEWER_CAPS and up; they replace the coarse dashboard:read).
    //   cost:write, members:read           -> operator tier (operator/admin/owner)
    //   posture:read, integrations:read    -> operator tier (operator/admin/owner)
    //   kill-switches:read, members:write, security:read, security:write
    //                                      -> admin tier (admin/owner). NOTE the
    //     /kill-switches ROUTE itself gates on security:write (the mutation gate,
    //     unchanged); the admin-only kill-switches:read is the backend LIST-read
    //     cap, listed here so an explicit (not defaulted) entry stays honest.
    const CAPABILITY_MIN_ROLE: Record<string, JarvisRole> = {
      'overview:read': 'viewer',
      'agents:read': 'viewer',
      'chat:read': 'viewer',
      'sessions:read': 'viewer',
      'usage:read': 'viewer',
      'audit:read': 'viewer',
      'vectors:read': 'viewer',
      'missions:read': 'viewer',
      'memories:read': 'viewer',
      'hive:read': 'viewer',
      'scheduled:read': 'viewer',
      'warroom:read': 'viewer',
      'kill-switches:read': 'admin',
      'cost:write': 'operator',
      'members:read': 'operator',
      'posture:read': 'operator',
      'compliance:read': 'operator',
      'integrations:read': 'operator',
      'members:write': 'admin',
      'security:read': 'admin',
      'security:write': 'admin',
      // Seat plane: seats:read is held by org-admin/owner only, which
      // collapses to the admin rung in the 3-rung Jarvis role space.
      // usage:self:read is the seat-user floor tier -> viewer rung.
      'seats:read': 'admin',
      'usage:self:read': 'viewer',
    };
    for (const r of ROUTE_TABLE) {
      const roleWrap = app.match(
        new RegExp(`path="${escape(r.route)}"><RequireRole need="(\\w+)"`),
      );
      const capWrap = app.match(
        new RegExp(`path="${escape(r.route)}">\\s*<RequireCapability need="([\\w:]+)"`),
      );
      const appRole = roleWrap
        ? roleWrap[1]
        : capWrap
          ? CAPABILITY_MIN_ROLE[capWrap[1]] ?? 'viewer'
          : 'viewer';
      expect(appRole, `minRole drift on ${r.route}`).toBe(r.minRole);
    }
  });
});
