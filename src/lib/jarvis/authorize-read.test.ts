import { describe, it, expect } from 'vitest';
import { authorizeRead } from './authorize-read.js';
import type { TokenPrincipal } from '../auth/dashboard-auth.js';

const viewer: TokenPrincipal = { tokenHash: 'h', label: 'V', hashPrefix16: 'h', role: 'viewer' };
const operator: TokenPrincipal = { tokenHash: 'h', label: 'O', hashPrefix16: 'h', role: 'operator' };

describe('authorizeRead (H3 shared guard)', () => {
  it('allows a viewer to read a viewer resource', () => {
    expect(authorizeRead(viewer, 'agents')).toEqual({ ok: true, resource: 'agents' });
    expect(authorizeRead(viewer, 'cost_today')).toEqual({ ok: true, resource: 'cost_today' });
  });

  it('blocks a viewer from the operator-only audit resource', () => {
    expect(authorizeRead(viewer, 'audit')).toEqual({ ok: false, code: 'RESOURCE_FORBIDDEN' });
    expect(authorizeRead(operator, 'audit')).toEqual({ ok: true, resource: 'audit' });
  });

  it('rejects an excluded / unknown resource (tokens, config, garbage)', () => {
    for (const bad of ['tokens', 'config', 'export', 'nonsense']) {
      expect(authorizeRead(operator, bad)).toEqual({ ok: false, code: 'UNKNOWN_RESOURCE' });
    }
  });

  it('requires chatId for memories (parameter-level scoping)', () => {
    expect(authorizeRead(viewer, 'memories')).toEqual({ ok: false, code: 'PARAM_REQUIRED', param: 'chatId' });
    expect(authorizeRead(viewer, 'memories', { chatId: 'c1' })).toEqual({ ok: true, resource: 'memories' });
  });

  it('blocks independently of any caller-supplied manifest (corrupted-manifest test)', () => {
    // The guard takes NO manifest argument — it reads the canonical RESOURCE_META
    // table directly. Even if a forged manifest claimed `audit` were viewer-level,
    // a viewer is still blocked here, which is the only authorization wall that
    // matters (the manifest is defense-in-depth + UX).
    expect(authorizeRead(viewer, 'audit').ok).toBe(false);
  });
});
