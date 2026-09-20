import { afterEach } from 'vitest';
import { devNull } from 'node:os';
import http from 'node:http';
import https from 'node:https';

/**
 * WI-0.3 — the unit suite's AWS guard. Named in `vitest.config.ts`'s
 * `setupFiles`, so it reaches every worker and every collected file, including
 * files added later. It lives at the repository root because `tsconfig.build.json`
 * compiles only `src/`, so nothing here enters `dist/`.
 *
 * Two layers, because either alone is insufficient:
 *
 *  1. Neutralise every ambient credential source, ONCE, so the SDK's provider
 *     chain resolves nothing and fails before a socket is opened. Once and not
 *     continuously, so a test that sets its own credentials afterwards
 *     (`src/__test-utils__/localstack.ts`) still works.
 *  2. A tripwire on `http`/`https` that records and refuses any dial to
 *     `*.amazonaws.com`. Layer 1 is silent, and `src/lib/aws/budget-writer.ts`
 *     swallows every AWS error, so a throw alone leaves the suite green. The
 *     recorded hit is what survives the swallow: the `afterEach` below fails the
 *     test that made the call whether or not the caller ever saw the throw.
 *
 * `fetch` is not patched: the AWS SDK v3 dials through `@smithy/node-http-handler`,
 * i.e. `http`/`https`. The contract is published on `globalThis` so this file's
 * location stays an implementation choice — see `src/__test-utils__/aws-guard.test.ts`.
 */

type AwsGuard = { neutralised: string[]; takeViolations(): string[] };

const MARKER = 'NETZAR-AWS-GUARD VIOLATION';
const CREDENTIAL_VARS = [
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
];

const guardHost = globalThis as { __netzarAwsGuard?: AwsGuard };

/** The host a `request`/`get` argument names, in any of node's accepted forms. */
function hostOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    try {
      return new URL(arg).hostname;
    } catch {
      return undefined;
    }
  }
  if (arg instanceof URL) return arg.hostname;
  if (typeof arg === 'object' && arg !== null) {
    const opts = arg as { host?: unknown; hostname?: unknown };
    if (typeof opts.hostname === 'string') return opts.hostname;
    if (typeof opts.host === 'string') return opts.host.replace(/:\d+$/, '');
  }
  return undefined;
}

if (!guardHost.__netzarAwsGuard) {
  const neutralised: string[] = [];
  for (const name of CREDENTIAL_VARS) {
    delete process.env[name];
    neutralised.push(name);
  }
  process.env.AWS_CONFIG_FILE = devNull;
  process.env.AWS_SHARED_CREDENTIALS_FILE = devNull;
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  neutralised.push('AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_EC2_METADATA_DISABLED');

  const violations: string[] = [];
  function guarded<T>(dial: T): T {
    const wrapped = (...args: unknown[]): unknown => {
      const host = args.map(hostOf).find((h) => h !== undefined);
      if (host !== undefined && /(^|\.)amazonaws\.com$/i.test(host)) {
        violations.push(host);
        throw new Error(`${MARKER}: refused a request to ${host}`);
      }
      return (dial as (...a: unknown[]) => unknown)(...args);
    };
    (wrapped as { __netzarAwsGuard?: boolean }).__netzarAwsGuard = true;
    return wrapped as T;
  }

  // `get` is patched separately from `request`: node's `get` calls the
  // module-local `request`, not the export replaced here.
  http.request = guarded(http.request);
  http.get = guarded(http.get);
  https.request = guarded(https.request);
  https.get = guarded(https.get);

  guardHost.__netzarAwsGuard = { neutralised, takeViolations: () => violations.splice(0) };
}

afterEach(() => {
  const dialled = guardHost.__netzarAwsGuard?.takeViolations() ?? [];
  if (dialled.length > 0) {
    // Reported here rather than at the dial, so a test that asserts on the
    // tripwire can drain its own hits, and so the one line that names a real
    // leak is printed exactly once per test.
    throw new Error(
      `${MARKER}: this test dialled ${dialled.join(', ')}. ` +
        'Mock the AWS call — see development.md, "AWS safety".',
    );
  }
});
