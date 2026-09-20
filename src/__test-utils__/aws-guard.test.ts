import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import http from 'node:http';
import https from 'node:https';

/**
 * WI-0.3 red state. The unit suite is not hermetic: `src/adapters/dashboard/
 * cost-cap.test.ts` drives the real `cost-cap.ts` POST route, which calls
 * `syncBudgetToDailyCap` (`src/lib/aws/budget-writer.ts`) — STS
 * GetCallerIdentity, then Budgets DescribeBudget + UpdateBudget on
 * `claudeclaw-monthly-cost`, in whatever account the credential chain resolves.
 * Every error there is swallowed, so the suite stays green either way.
 *
 * These tests pin the seam that fixes it: a vitest setup file, loaded into
 * every worker, that (a) neutralises every ambient credential source and
 * (b) arms a tripwire which records and refuses any dial to *.amazonaws.com.
 *
 * The contract is published on globalThis so the guard's file location stays
 * an implementation choice:
 *
 *   globalThis.__netzarAwsGuard = {
 *     neutralised: string[],        // env var names it removed or redirected
 *     takeViolations(): string[],   // drains the amazonaws.com hosts dialled
 *   }
 *
 * and `http.request`/`https.request`/`.get` carry `__netzarAwsGuard === true`.
 */

type AwsGuard = {
  neutralised: string[];
  takeViolations(): string[];
};

declare global {
  // eslint-disable-next-line no-var
  var __netzarAwsGuard: AwsGuard | undefined;
}

const PROBE_HOST = 'netzar-guard-probe.amazonaws.com';

describe('AWS test guard (WI-0.3)', () => {
  it('the unit config loads a setup file into every worker', () => {
    const config = readFileSync(new URL('../../vitest.config.ts', import.meta.url), 'utf8');
    expect(config).toMatch(/setupFiles\s*:/);
  });

  it('is armed in this worker', () => {
    expect(globalThis.__netzarAwsGuard).toBeDefined();
  });

  it('neutralises every ambient credential source', () => {
    for (const name of [
      'AWS_PROFILE',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]) {
      expect(process.env[name], `${name} must be unset`).toBeUndefined();
    }
    expect(process.env.AWS_CONFIG_FILE).toBe(devNull);
    expect(process.env.AWS_SHARED_CREDENTIALS_FILE).toBe(devNull);
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true');
  });

  it('refuses and records a dial to *.amazonaws.com, on both http and https', () => {
    // Assert the patch FIRST. Unpatched, the calls below would open a real
    // socket, so this expectation is what keeps the red state offline.
    for (const fn of [https.request, https.get, http.request, http.get]) {
      expect((fn as { __netzarAwsGuard?: boolean }).__netzarAwsGuard).toBe(true);
    }

    expect(() => https.request({ host: PROBE_HOST })).toThrow(/amazonaws\.com/);
    expect(() => http.request(`http://${PROBE_HOST}/`)).toThrow(/amazonaws\.com/);

    // Drained here so the guard's own end-of-test check sees a clean slate.
    expect(globalThis.__netzarAwsGuard?.takeViolations()).toEqual([PROBE_HOST, PROBE_HOST]);
  });

  it('fails a test even when the caller swallows the error', () => {
    // Same gate as above: unpatched, the swallowed call really would dial.
    expect((https.request as { __netzarAwsGuard?: boolean }).__netzarAwsGuard).toBe(true);
    try {
      https.request({ host: PROBE_HOST });
    } catch {
      // Exactly what budget-writer.ts does with its AWS errors.
    }
    // The dial is recorded regardless of the swallow, which is what lets the
    // guard fail a test that never sees the throw.
    expect(globalThis.__netzarAwsGuard?.takeViolations()).toEqual([PROBE_HOST]);
  });
});
