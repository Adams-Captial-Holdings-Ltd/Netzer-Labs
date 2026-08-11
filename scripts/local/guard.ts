/**
 * Local AWS isolation guard.
 *
 * Everything in `src/` builds its AWS clients with `{ region }` only, so the
 * single thing standing between local development and a real AWS account is
 * the `AWS_ENDPOINT_URL` environment variable. That makes a missing or
 * mistyped variable a silent, dangerous failure: the SDK would quietly fall
 * back to the public AWS endpoints and, if the developer happens to have
 * credentials, write to a real environment.
 *
 * This guard turns that silent failure into a loud one. It runs before the
 * orchestrator boots and before anything is provisioned, and it FAILS CLOSED:
 * any check it cannot positively confirm is treated as unsafe.
 *
 *   npm run local:verify        # run every check, print a report
 *
 * The last check is the important one: it asks the configured endpoint who it
 * thinks we are (sts:GetCallerIdentity). A local emulator answers with the
 * reserved account id 000000000000. A real AWS account never does. That is a
 * positive proof of isolation rather than an assumption about configuration.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

/** The account id every AWS emulator reports. Real accounts never use it. */
export const EMULATOR_ACCOUNT_ID = '000000000000';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

export interface GuardCheck {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
}

/**
 * A real AWS access key id is 20 chars and starts with AKIA (long-lived) or
 * ASIA (temporary). Placeholder values like `local` or `test` do not match, so
 * this flags a developer who exported real credentials into the shell.
 */
function looksLikeRealAccessKey(value: string | undefined): boolean {
  return !!value && /^(AKIA|ASIA)[0-9A-Z]{16}$/.test(value);
}

function endpointHost(raw: string): string | null {
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

/** Static configuration checks. No network access. */
export function staticChecks(env: NodeJS.ProcessEnv = process.env): GuardCheck[] {
  const checks: GuardCheck[] = [];
  const endpoint = env.AWS_ENDPOINT_URL;

  checks.push({
    id: 'endpoint-set',
    title: 'AWS_ENDPOINT_URL is set',
    ok: !!endpoint,
    detail: endpoint
      ? `AWS_ENDPOINT_URL=${endpoint}`
      : 'AWS_ENDPOINT_URL is NOT set. Every AWS SDK call would go to real AWS. ' +
        'Copy .env.local.example to .env, or run: npm run local:up',
  });

  const host = endpoint ? endpointHost(endpoint) : null;
  checks.push({
    id: 'endpoint-loopback',
    title: 'AWS_ENDPOINT_URL points at this machine',
    ok: !!host && LOOPBACK_HOSTS.has(host),
    detail: host
      ? LOOPBACK_HOSTS.has(host)
        ? `Endpoint host "${host}" is loopback.`
        : `Endpoint host "${host}" is NOT loopback. Local development must not ` +
          'target a remote host. Refusing to continue.'
      : 'AWS_ENDPOINT_URL is missing or not a valid URL.',
  });

  const keyId = env.AWS_ACCESS_KEY_ID;
  checks.push({
    id: 'fake-credentials',
    title: 'AWS credentials are local placeholders',
    ok: !looksLikeRealAccessKey(keyId),
    detail: looksLikeRealAccessKey(keyId)
      ? `AWS_ACCESS_KEY_ID looks like a REAL AWS key (${keyId?.slice(0, 4)}...). ` +
        'Local development must use placeholder credentials. Refusing to continue.'
      : `AWS_ACCESS_KEY_ID=${keyId ?? '(unset)'} (not a real-looking key).`,
  });

  // A profile or session token would be picked up by the default credential
  // chain. Harmless while the endpoint override holds, but it means a single
  // missing variable separates this shell from a real account.
  const inherited = ['AWS_PROFILE', 'AWS_SESSION_TOKEN'].filter((k) => env[k]);
  checks.push({
    id: 'no-inherited-identity',
    title: 'No real AWS identity inherited from the shell',
    ok: inherited.length === 0,
    detail:
      inherited.length === 0
        ? 'No AWS_PROFILE or AWS_SESSION_TOKEN in the environment.'
        : `Found ${inherited.join(', ')} in the environment. Unset them for local work.`,
  });

  return checks;
}

/**
 * Ask the configured endpoint for its account id. This is the proof step: a
 * local emulator answers 000000000000, a real account answers its own id.
 */
export async function identityCheck(env: NodeJS.ProcessEnv = process.env): Promise<GuardCheck> {
  const endpoint = env.AWS_ENDPOINT_URL;
  if (!endpoint) {
    return {
      id: 'emulator-identity',
      title: 'Endpoint reports the emulator account id',
      ok: false,
      detail: 'Skipped: AWS_ENDPOINT_URL is not set, so there is nothing safe to probe.',
    };
  }
  try {
    const sts = new STSClient({ region: env.AWS_REGION ?? 'us-east-1' });
    const id = await sts.send(new GetCallerIdentityCommand({}));
    const account = id.Account ?? '(none)';
    const ok = account === EMULATOR_ACCOUNT_ID;
    return {
      id: 'emulator-identity',
      title: 'Endpoint reports the emulator account id',
      ok,
      detail: ok
        ? `sts:GetCallerIdentity returned ${account} (the emulator account). Confirmed local.`
        : `sts:GetCallerIdentity returned ${account}, which is NOT the emulator ` +
          'account 000000000000. You may be talking to a REAL AWS account. Refusing to continue.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: 'emulator-identity',
      title: 'Endpoint reports the emulator account id',
      ok: false,
      detail:
        `Could not reach ${endpoint}: ${msg}. ` +
        'Start the emulator with: npm run local:up',
    };
  }
}

export async function runGuard(env: NodeJS.ProcessEnv = process.env): Promise<GuardCheck[]> {
  const checks = staticChecks(env);
  // Only probe when the static checks agree the target is safe to touch.
  const safeToProbe = checks.every((c) => c.ok);
  checks.push(
    safeToProbe
      ? await identityCheck(env)
      : {
          id: 'emulator-identity',
          title: 'Endpoint reports the emulator account id',
          ok: false,
          detail: 'Skipped: a static check failed, so no network probe was attempted.',
        },
  );
  return checks;
}

async function main(): Promise<number> {
  const checks = await runGuard();
  const pass = checks.every((c) => c.ok);
  process.stdout.write('\nAWS isolation guard\n');
  for (const c of checks) {
    process.stdout.write(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.title}\n        ${c.detail}\n`);
  }
  process.stdout.write(
    pass
      ? '\nAll checks passed. This process is talking to a local emulator, not AWS.\n\n'
      : '\nISOLATION NOT CONFIRMED. Refusing to treat this environment as local.\n\n',
  );
  return pass ? 0 : 1;
}

/**
 * True when this module is the process entry point. Compares real paths rather
 * than URL strings: the repo path contains a space, which `import.meta.url`
 * percent-encodes and `process.argv[1]` does not, and macOS resolves /tmp
 * through a symlink. Naive string comparison silently never matches.
 */
export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

// Run only when invoked directly, so importing the helpers stays side effect free.
if (isMainModule(import.meta.url)) {
  main().then((code) => process.exit(code));
}
