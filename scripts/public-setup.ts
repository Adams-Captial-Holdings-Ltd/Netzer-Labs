#!/usr/bin/env tsx
/**
 * Public dashboard access setup (pgnos public dashboard plan, Task 2).
 *
 *   npm run public:setup
 *
 * Finds the remotely managed `netzar-production-public` tunnel, reads its
 * connector token straight out of `cloudflared`, and writes that token into
 * the encrypted Secrets Manager entry the Fargate sidecar reads. The token is
 * never printed, never an argument, and never stored in `.env`. The operator's
 * only interactive step is approving Cloudflare access in a browser.
 *
 * Mutation contract: exactly ONE AWS write, PutSecretValue on the tunnel
 * secret. No Cloudflare resource is created, modified, or deleted here;
 * `claudeclaw` and `salessly.io` are never touched. `--help` mutates nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SecretsManagerClient, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import {
  resolvePublicDashboardAccess,
  PUBLIC_TUNNEL_SECRET_NAME,
} from '../infra/lib/public-dashboard-access.js';
import { maybePrintHelp } from './lib/help.js';
import { parseEnvFile, resolveEnvFlag, envFileNameFor } from './lib/env-file.js';
import {
  syncPublicTunnelSecret,
  realCloudflared,
  PublicSetupBlocker,
  PUBLIC_LOGIN_REMEDIATION,
  PUBLIC_SECRET_MISSING_REMEDIATION,
  PUBLIC_SECRET_READY_STAGE,
} from './lib/public-tunnel/setup.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);

function say(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

async function main(): Promise<number> {
  if (
    maybePrintHelp(argv, {
      command: 'npm run public:setup',
      oneLiner:
        'transfer the Cloudflare connector token into Secrets Manager without showing it',
      flags: [['--env=<name>', 'which env file to read (default prod -> .env)']],
      contract:
        'ONE AWS write (PutSecretValue on the tunnel secret). Creates no Cloudflare resource; ' +
        'never touches claudeclaw or salessly.io. --help mutates nothing.',
      docs: 'docs/deployment.md',
    })
  ) {
    return 0;
  }

  const envFile = join(repoRoot, envFileNameFor(resolveEnvFlag(argv)));
  if (!existsSync(envFile)) {
    say(`Missing ${envFile}. Run \`npm run setup\` first.`);
    return 1;
  }
  const env = parseEnvFile(readFileSync(envFile, 'utf-8'));

  // Throws a typed error when the flag is set outside the private posture.
  const publicAccess = resolvePublicDashboardAccess(env);
  if (!publicAccess.enabled) {
    say(
      'Public dashboard access is off. Set CCE_PUBLIC_ACCESS=1 (with ' +
        'CCE_DEPLOY_MODE=infra-only and no DOMAIN_NAME) in your env file first.',
    );
    return 1;
  }

  const region = env.AWS_REGION ?? 'us-east-1';
  const expectedAccountId = env.AWS_ACCOUNT_ID ?? '';
  if (!expectedAccountId) {
    say('AWS_ACCOUNT_ID is not set in your env file; refusing to guess the target account.');
    return 1;
  }

  // Gate 1: the right AWS account, before anything else is contacted.
  const sts = new STSClient({ region });
  const actualAccountId = (await sts.send(new GetCallerIdentityCommand({}))).Account ?? '';
  if (actualAccountId !== expectedAccountId) {
    say(
      `Refusing to continue: expected AWS account ${expectedAccountId}, ` +
        `current credentials resolve to ${actualAccountId || '(unknown)'}. ` +
        'Run `aws login --profile netzer-root` and retry.',
    );
    return 1;
  }

  // Gate 2: the foundation phase created the secret.
  const secrets = new SecretsManagerClient({ region });
  try {
    await secrets.send(new DescribeSecretCommand({ SecretId: PUBLIC_TUNNEL_SECRET_NAME }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ResourceNotFoundException') {
      say(PUBLIC_SECRET_MISSING_REMEDIATION);
      return 1;
    }
    throw err;
  }

  const result = await syncPublicTunnelSecret({
    expectedAccountId,
    actualAccountId,
    secretId: PUBLIC_TUNNEL_SECRET_NAME,
    cloudflared: realCloudflared(),
    secrets,
    log: say,
  });

  say('');
  say(`OK tunnel    ${result.tunnelName} (${result.tunnelId})`);
  say(`OK secret    ${PUBLIC_TUNNEL_SECRET_NAME} version ${result.secretVersionId}`);
  say(`OK hostname  ${publicAccess.hostname}`);
  say(`   staged    AWSCURRENT + ${PUBLIC_SECRET_READY_STAGE}`);
  say('');
  say('Next: AWS_PROFILE=netzer-root npm run deploy');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(err instanceof PublicSetupBlocker ? message : message);
    if (!(err instanceof PublicSetupBlocker) && !message.includes('cloudflared')) {
      // eslint-disable-next-line no-console
      console.error(PUBLIC_LOGIN_REMEDIATION);
    }
    process.exit(1);
  });
