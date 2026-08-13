#!/usr/bin/env tsx
/**
 * Private WARP access setup (permanent private dashboard plan, Task 2).
 *
 *   npm run warp:setup             # authorize + transfer the connector token
 *   npm run warp:setup -- --plan   # say what it would do; touches nothing
 *   npm run warp:setup -- --json   # machine-readable result
 *
 * What it does: finds the remotely managed `netzar-production-private`
 * tunnel, reads its connector token straight out of `cloudflared`, and writes
 * that token into the encrypted Secrets Manager entry the Fargate sidecar
 * reads. The token is never printed, never an argument, and never stored in
 * `.env`. The operator's only interactive step is approving Cloudflare access
 * in a browser.
 *
 * Mutation contract: exactly ONE AWS write — PutSecretValue on
 * `/claudeclaw[-suffix]/cloudflare-tunnel`. No Cloudflare resource is created,
 * modified, or deleted by this command; `claudeclaw` and `salessly.io` are
 * never touched. `--help` and `--plan` mutate nothing at all.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  SecretsManagerClient,
  DescribeSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { buildResourceNames } from '../infra/lib/constants.js';
import {
  resolveWarpPrivateAccess,
  WARP_TUNNEL_NAME,
} from '../infra/lib/warp-private-access.js';
import { maybePrintHelp } from './lib/help.js';
import { parseEnvFile, resolveEnvFlag, envFileNameFor } from './lib/env-file.js';
import {
  syncWarpTunnelSecret,
  realCloudflared,
  cloudflaredAvailable,
  WarpSetupBlocker,
  WARP_LOGIN_REMEDIATION,
  WARP_SECRET_MISSING_REMEDIATION,
  WARP_SECRET_READY_STAGE,
} from './lib/warp/setup.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const PLAN_ONLY = argv.includes('--plan');

/** Structured stdout; never carries a token. */
function emit(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  if (JSON_OUT) console.log(JSON.stringify(payload, null, 2));
}

function say(line: string): void {
  // eslint-disable-next-line no-console
  if (!JSON_OUT) console.log(line);
}

async function main(): Promise<number> {
  if (
    maybePrintHelp(argv, {
      command: 'npm run warp:setup',
      oneLiner: 'transfer the Cloudflare connector token into Secrets Manager without showing it',
      flags: [
        ['--plan', 'print the intended actions and exit; touches nothing'],
        ['--json', 'machine-readable result (never includes the token)'],
        ['--env=<name>', 'which env file to read (default prod -> .env)'],
      ],
      contract:
        'ONE AWS write (PutSecretValue on the tunnel secret). Creates no Cloudflare resource; ' +
        'never touches claudeclaw or salessly.io. --help/--plan mutate nothing.',
      docs: 'docs/deployment.md',
    })
  ) {
    return 0;
  }

  // ── Local configuration (no network) ────────────────────────────────
  const envFile = join(repoRoot, envFileNameFor(resolveEnvFlag(argv)));
  if (!existsSync(envFile)) {
    say(`Missing ${envFile}. Run \`npm run setup\` first.`);
    emit({ ok: false, reason: 'env-file-missing', envFile });
    return 1;
  }
  const env = parseEnvFile(readFileSync(envFile, 'utf-8'));

  // Throws a typed error when the flag is set outside the private posture.
  const warp = resolveWarpPrivateAccess(env);
  if (!warp.enabled) {
    say(
      'Private WARP access is off. Set CCE_WARP_PRIVATE_ACCESS=1 (with ' +
        'CCE_DEPLOY_MODE=infra-only and no DOMAIN_NAME) in your env file first.',
    );
    emit({ ok: false, reason: 'feature-disabled' });
    return 1;
  }

  const region = env.AWS_REGION ?? 'us-east-1';
  const expectedAccountId = env.AWS_ACCOUNT_ID ?? '';
  const names = buildResourceNames(env.CCE_NAME_SUFFIX ?? '');
  const secretId = names.secrets.cloudflareTunnel;

  if (PLAN_ONLY) {
    say('Plan (nothing is contacted or changed):');
    say(`  1. Verify the current AWS account is ${expectedAccountId || '(AWS_ACCOUNT_ID unset)'}.`);
    say(`  2. Verify \`cloudflared\` is installed and authorized in a browser.`);
    say(`  3. Verify the encrypted secret ${secretId} already exists.`);
    say(`  4. Read the connector token for tunnel ${WARP_TUNNEL_NAME} (never displayed).`);
    say(`  5. PutSecretValue ${secretId} staged AWSCURRENT + ${WARP_SECRET_READY_STAGE}.`);
    say(`  Private hostname: ${warp.hostname}`);
    emit({
      ok: true,
      mode: 'plan',
      mutations: [],
      account: expectedAccountId,
      region,
      secretId,
      tunnelName: warp.tunnelName,
      hostname: warp.hostname,
      readyStage: WARP_SECRET_READY_STAGE,
    });
    return 0;
  }

  // ── Gate 1: the right AWS account ───────────────────────────────────
  if (!expectedAccountId) {
    say('AWS_ACCOUNT_ID is not set in your env file; refusing to guess the target account.');
    emit({ ok: false, reason: 'account-unset' });
    return 1;
  }
  const sts = new STSClient({ region });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const actualAccountId = identity.Account ?? '';
  if (actualAccountId !== expectedAccountId) {
    say(
      `Refusing to continue: expected AWS account ${expectedAccountId}, ` +
        `current credentials resolve to ${actualAccountId || '(unknown)'}. ` +
        'Run `aws login --profile netzer-root` and retry.',
    );
    emit({ ok: false, reason: 'account-mismatch', expected: expectedAccountId, actual: actualAccountId });
    return 1;
  }

  // ── Gate 2: cloudflared present and browser-authorized ──────────────
  if (!(await cloudflaredAvailable())) {
    say(WARP_LOGIN_REMEDIATION);
    emit({ ok: false, reason: 'cloudflared-unavailable', remediation: WARP_LOGIN_REMEDIATION });
    return 1;
  }

  // ── Gate 3: the foundation phase created the secret ─────────────────
  const secrets = new SecretsManagerClient({ region });
  try {
    await secrets.send(new DescribeSecretCommand({ SecretId: secretId }));
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    if (name === 'ResourceNotFoundException') {
      say(WARP_SECRET_MISSING_REMEDIATION);
      emit({ ok: false, reason: 'secret-missing', secretId, remediation: WARP_SECRET_MISSING_REMEDIATION });
      return 1;
    }
    throw err;
  }

  // ── The transfer ────────────────────────────────────────────────────
  const result = await syncWarpTunnelSecret({
    expectedAccountId,
    actualAccountId,
    secretId,
    cloudflared: realCloudflared(),
    secrets,
    log: say,
  });

  say('');
  say(`✓ tunnel      ${result.tunnelName} (${result.tunnelId})`);
  say(`✓ secret      ${secretId} version ${result.secretVersionId}`);
  say(`✓ hostname    ${warp.hostname}`);
  say('');
  say('Next: AWS_PROFILE=netzer-root npm run deploy');
  emit({ ok: true, mode: 'apply', secretId, ...result });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof WarpSetupBlocker) {
      // eslint-disable-next-line no-console
      console.error(JSON_OUT ? JSON.stringify({ ok: false, blocker: message }, null, 2) : message);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.error(JSON_OUT ? JSON.stringify({ ok: false, error: message }, null, 2) : message);
    process.exit(1);
  });
