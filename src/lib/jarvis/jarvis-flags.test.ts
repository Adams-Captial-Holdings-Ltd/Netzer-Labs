import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send, getCurrentPanicState } = vi.hoisted(() => ({
  send: vi.fn(),
  getCurrentPanicState: vi.fn(),
}));

vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));
vi.mock('../state/panic-state-repo.js', () => ({ getCurrentPanicState }));

import {
  isJarvisEnabled,
  canaryAllowlistHas,
  addCanaryToken,
  removeCanaryToken,
  invalidateCanaryCache,
} from './jarvis-flags.js';
import type { TokenPrincipal } from '../auth/dashboard-auth.js';

const principal: TokenPrincipal = { tokenHash: 'abc', label: 'L', hashPrefix16: 'abc', role: 'admin' };

type SwitchSpec = { present: boolean; active: boolean } | 'throw';

function configure(opts: {
  jarvis_disabled?: SwitchSpec;
  jarvis_canary_mode?: SwitchSpec;
  canaryAllow?: boolean | 'throw';
}): void {
  send.mockImplementation(async (cmd: { input?: { TableName?: string; Key?: Record<string, unknown> } }) => {
    const input = cmd.input ?? {};
    const table = input.TableName ?? '';
    const key = input.Key ?? {};
    const pk = String(key.PK ?? '');

    if (table.includes('canary')) {
      if (opts.canaryAllow === 'throw') throw new Error('canary table missing');
      return { Item: opts.canaryAllow ? { PK: pk } : undefined };
    }
    if (pk === 'SWITCH#jarvis_disabled') return resolveSwitch(opts.jarvis_disabled);
    if (pk === 'SWITCH#jarvis_canary_mode') return resolveSwitch(opts.jarvis_canary_mode);
    return { Item: undefined };
  });
}

function resolveSwitch(spec: SwitchSpec | undefined): { Item?: { active: boolean } } {
  if (spec === 'throw') throw new Error('ddb down');
  if (!spec || !spec.present) return { Item: undefined };
  return { Item: { active: spec.active } };
}

describe('isJarvisEnabled — fail-closed admission (H7/H11)', () => {
  beforeEach(() => {
    send.mockReset();
    getCurrentPanicState.mockReset();
    getCurrentPanicState.mockResolvedValue({ active: false, generation: 0 });
    invalidateCanaryCache();
    process.env.JARVIS_LAUNCH_ENABLED = 'true';
  });

  it('denies when the launch flag is off, before any DDB read', async () => {
    delete process.env.JARVIS_LAUNCH_ENABLED;
    expect(await isJarvisEnabled(principal)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('denies under panic', async () => {
    getCurrentPanicState.mockResolvedValue({ active: true, generation: 3 });
    expect(await isJarvisEnabled(principal)).toBe(false);
  });

  it('denies when the panic read errors', async () => {
    getCurrentPanicState.mockRejectedValue(new Error('ddb down'));
    expect(await isJarvisEnabled(principal)).toBe(false);
  });

  it('denies on a MISSING jarvis_disabled item (fresh table — needs the seeded inactive row)', async () => {
    configure({ jarvis_disabled: { present: false, active: false } });
    expect(await isJarvisEnabled(principal)).toBe(false);
  });

  it('denies on a jarvis_disabled READ ERROR', async () => {
    configure({ jarvis_disabled: 'throw' });
    expect(await isJarvisEnabled(principal)).toBe(false);
  });

  it('denies when jarvis_disabled is active (emergency kill)', async () => {
    configure({ jarvis_disabled: { present: true, active: true } });
    expect(await isJarvisEnabled(principal)).toBe(false);
  });

  it('admits at GA: launch on, not panicked, jarvis_disabled present+inactive, no canary', async () => {
    configure({
      jarvis_disabled: { present: true, active: false },
      jarvis_canary_mode: { present: false, active: false },
    });
    expect(await isJarvisEnabled(principal)).toBe(true);
  });

  it('in canary mode, admits an allowlisted token and denies a non-allowlisted one', async () => {
    configure({
      jarvis_disabled: { present: true, active: false },
      jarvis_canary_mode: { present: true, active: true },
      canaryAllow: true,
    });
    expect(await isJarvisEnabled(principal)).toBe(true);

    configure({
      jarvis_disabled: { present: true, active: false },
      jarvis_canary_mode: { present: true, active: true },
      canaryAllow: false,
    });
    invalidateCanaryCache(); // an allowlist change publishes a `canary` invalidation
    expect(await isJarvisEnabled(principal)).toBe(false);
  });

  it('denies in canary mode when the allowlist read errors (fail-closed)', async () => {
    configure({
      jarvis_disabled: { present: true, active: false },
      jarvis_canary_mode: { present: true, active: true },
      canaryAllow: 'throw',
    });
    expect(await isJarvisEnabled(principal)).toBe(false);
  });

  it('emergency kill denies even an allowlisted canary token (kill BEFORE canary)', async () => {
    configure({
      jarvis_disabled: { present: true, active: true },
      jarvis_canary_mode: { present: true, active: true },
      canaryAllow: true,
    });
    expect(await isJarvisEnabled(principal)).toBe(false);
  });
});

describe('canary allowlist (Reference Contracts D)', () => {
  beforeEach(() => {
    send.mockReset();
    invalidateCanaryCache();
  });

  it('caches membership and only reads DDB once until invalidated', async () => {
    send.mockResolvedValue({ Item: { PK: 'h1', label: 'beta' } });
    expect(await canaryAllowlistHas('h1')).toBe(true);
    expect(await canaryAllowlistHas('h1')).toBe(true); // cache hit
    expect(send).toHaveBeenCalledTimes(1);

    invalidateCanaryCache('h1');
    await canaryAllowlistHas('h1');
    expect(send).toHaveBeenCalledTimes(2); // re-read after bust
  });

  it('a missing item is NOT a member (fail-closed)', async () => {
    send.mockResolvedValue({ Item: undefined });
    expect(await canaryAllowlistHas('nope')).toBe(false);
  });

  it('addCanaryToken writes the row and warms the cache to member=true', async () => {
    send.mockResolvedValue({});
    await addCanaryToken('h2', 'pilot', 'admin');
    const put = send.mock.calls[0][0];
    expect(put.constructor.name).toBe('PutCommand');
    expect(put.input.Item).toMatchObject({ PK: 'h2', label: 'pilot', addedBy: 'admin' });
    // Served from cache without another DDB read.
    expect(await canaryAllowlistHas('h2')).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('removeCanaryToken deletes the row and warms the cache to member=false', async () => {
    send.mockResolvedValue({});
    await removeCanaryToken('h3');
    const del = send.mock.calls[0][0];
    expect(del.constructor.name).toBe('DeleteCommand');
    expect(del.input.Key).toEqual({ PK: 'h3' });
    expect(await canaryAllowlistHas('h3')).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
