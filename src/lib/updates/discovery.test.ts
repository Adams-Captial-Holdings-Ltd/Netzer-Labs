import { describe, it, expect } from 'vitest';
import {
  createUpdateChecker,
  unverifiedVerifier,
  UPDATE_BACKOFF_BASE_MS,
  UPDATE_CACHE_TTL_MS,
  type ReleaseVerifier,
} from './discovery.js';

// ─────────────────────────────────────────────────────────────────────
// Fakes — no real network call is ever made from this file.
// ─────────────────────────────────────────────────────────────────────

function fakeFetch(opts: {
  tag?: string;
  status?: number;
  fail?: boolean;
}): { fn: typeof fetch; calls: () => number } {
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    if (opts.fail) throw new Error('network down');
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({
        tag_name: opts.tag ?? 'v1.4.0',
        html_url: 'https://example.invalid/releases/v1.4.0',
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

const verifiedVerifier =
  (requiredActions: number): ReleaseVerifier =>
  async (release) => ({
    verified: true,
    metadata: {
      schemaVersion: 1,
      tag: release.tagName,
      requiredActions: Array.from({ length: requiredActions }, (_, i) => ({
        id: `action-${i}`,
        classification: 'manual-preflight',
        description: `do thing ${i}`,
      })),
      upgradingUrl: 'https://example.invalid/UPGRADING.md',
    },
  });

const baseEnv = { CCE_UPSTREAM_OWNER: 'acme', CCE_UPSTREAM_REPO: 'widget' };

describe('update discovery', () => {
  it('caches the result for the TTL (one fetch for repeated calls)', async () => {
    const { fn, calls } = fakeFetch({ tag: 'v1.4.0' });
    let t = 0;
    const check = createUpdateChecker({
      fetchFn: fn,
      verifier: verifiedVerifier(2),
      now: () => t,
      currentVersion: '1.2.1',
    });

    const first = await check(baseEnv);
    expect(first.available).toBe(true);
    expect(first.latestTag).toBe('v1.4.0');
    expect(first.verified).toBe(true);
    expect(first.requiredActionsCount).toBe(2);

    t += 60_000; // a minute later: cache must answer
    const second = await check(baseEnv);
    expect(second).toEqual(first);
    expect(calls()).toBe(1);

    t += UPDATE_CACHE_TTL_MS; // past the TTL: a fresh fetch
    await check(baseEnv);
    expect(calls()).toBe(2);
  });

  it('CCE_UPDATE_CHECK_DISABLED=1 short-circuits with zero fetches', async () => {
    const { fn, calls } = fakeFetch({ tag: 'v1.4.0' });
    const check = createUpdateChecker({ fetchFn: fn, currentVersion: '1.2.1' });
    const result = await check({ ...baseEnv, CCE_UPDATE_CHECK_DISABLED: '1' });
    expect(result).toEqual({
      available: false,
      currentVersion: '1.2.1',
      verified: false,
      reason: 'disabled',
    });
    expect(calls()).toBe(0);
  });

  it('fetch error is fail-silent and backs off exponentially', async () => {
    const { fn, calls } = fakeFetch({ fail: true });
    let t = 0;
    const check = createUpdateChecker({
      fetchFn: fn,
      now: () => t,
      currentVersion: '1.2.1',
    });

    const first = await check(baseEnv); // never throws
    expect(first.available).toBe(false);
    expect(first.verified).toBe(false);
    expect(first.reason).toBe('unreachable');
    expect(calls()).toBe(1);

    t += 1000; // inside the backoff window: no second fetch
    await check(baseEnv);
    expect(calls()).toBe(1);

    t += UPDATE_BACKOFF_BASE_MS; // past the first backoff: retry
    await check(baseEnv);
    expect(calls()).toBe(2);

    // Second consecutive failure doubles the backoff.
    t += UPDATE_BACKOFF_BASE_MS;
    await check(baseEnv);
    expect(calls()).toBe(2); // 2*base needed, only 1*base elapsed
    t += UPDATE_BACKOFF_BASE_MS;
    await check(baseEnv);
    expect(calls()).toBe(3);
  });

  it('non-2xx response is fail-silent too', async () => {
    const { fn, calls } = fakeFetch({ status: 403 }); // rate-limited
    const check = createUpdateChecker({ fetchFn: fn, currentVersion: '1.2.1' });
    const result = await check(baseEnv);
    expect(result.reason).toBe('unreachable');
    expect(calls()).toBe(1);
  });

  it('a backed-off caller still gets the last cached result', async () => {
    let fail = false;
    let calls = 0;
    const fn = (async () => {
      calls += 1;
      if (fail) throw new Error('network down');
      return {
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v1.4.0' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    let t = 0;
    const check = createUpdateChecker({
      fetchFn: fn,
      verifier: verifiedVerifier(1),
      now: () => t,
      currentVersion: '1.2.1',
    });

    const good = await check(baseEnv);
    expect(good.latestTag).toBe('v1.4.0');

    fail = true;
    t += UPDATE_CACHE_TTL_MS + 1; // cache expired → refetch fails
    const stale = await check(baseEnv);
    expect(stale).toEqual(good); // stale cache served, not an error
    expect(calls).toBe(2);
  });

  it('unverified metadata → verified:false, reason unverified, NO requiredActionsCount', async () => {
    const { fn } = fakeFetch({ tag: 'v1.4.0' });
    const check = createUpdateChecker({
      fetchFn: fn,
      verifier: unverifiedVerifier, // the default seam
      currentVersion: '1.2.1',
    });
    const result = await check(baseEnv);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('unverified');
    expect(result.requiredActionsCount).toBeUndefined();
    expect(result.latestTag).toBe('v1.4.0');
  });

  it('a crashing verifier degrades to unverified, never an error', async () => {
    const { fn } = fakeFetch({ tag: 'v1.4.0' });
    const check = createUpdateChecker({
      fetchFn: fn,
      verifier: async () => {
        throw new Error('verifier exploded');
      },
      currentVersion: '1.2.1',
    });
    const result = await check(baseEnv);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('unverified');
  });

  it('same tag as current version → up-to-date when verified', async () => {
    const { fn } = fakeFetch({ tag: 'v1.2.1' });
    const check = createUpdateChecker({
      fetchFn: fn,
      verifier: verifiedVerifier(0),
      currentVersion: '1.2.1', // 'v' prefix normalized away
    });
    const result = await check(baseEnv);
    expect(result.available).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.reason).toBe('up-to-date');
  });

  it('DEPLOY_SHA wins as currentVersion when set', async () => {
    const { fn } = fakeFetch({ tag: 'v1.4.0' });
    const check = createUpdateChecker({ fetchFn: fn });
    const result = await check({ ...baseEnv, DEPLOY_SHA: 'abc123def456' });
    expect(result.currentVersion).toBe('abc123def456');
  });
});
