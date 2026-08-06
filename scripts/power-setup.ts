#!/usr/bin/env tsx
/**
 * Power-switch post-deploy wiring. One command makes pause/wake turnkey after
 * `cdk deploy` has created the <prefix>-PowerSwitch stack:
 *
 *   npm run power:setup                # wire + print instructions
 *   npm run power:setup -- --show-token  # also print the token value once
 *
 * What it does:
 *   1. Reads the Function URL from the PowerSwitch stack outputs.
 *   2. Writes runtime-config power/url so the dashboard's Power card + proxy
 *      find the control plane (propagates in ~30s, no redeploy).
 *   3. Prints the panel URL to bookmark and how to fetch the token.
 *
 * Read-only against AWS except for the single runtime-config PutItem. Touches
 * ONLY ClaudeClaw resources; nothing else in the account.
 */

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { setConfig } from '../src/lib/state/runtime-config-repo.js';
import { maybePrintHelp } from './lib/help.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const STACK = `${process.env.CDK_STACK_NAME ?? 'CCE'}-PowerSwitch`;
const SHOW_TOKEN = process.argv.includes('--show-token');

async function main(): Promise<void> {
  if (
    maybePrintHelp(process.argv.slice(2), {
      command: 'npm run power:setup',
      oneLiner: 'wire the pause/wake panel after deploy (Function URL into runtime-config)',
      flags: [['--show-token', 'also print the token value once']],
      contract: 'Read-only except ONE runtime-config PutItem (power/url); touches only ClaudeClaw resources.',
    })
  ) {
    return;
  }
  const cfn = new CloudFormationClient({ region: REGION });
  const out = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const stack = out.Stacks?.[0];
  if (!stack) {
    console.error(`Stack ${STACK} not found. Deploy it first: npx cdk deploy ${STACK}`);
    process.exit(1);
  }
  const outputs = Object.fromEntries(
    (stack.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']),
  );
  const url = (outputs.FunctionUrl ?? '').replace(/\/$/, '');
  const secretName = outputs.TokenSecretName ?? 'claudeclaw/power-switch-token';
  if (!url) {
    console.error(`Stack ${STACK} has no FunctionUrl output; is it the power-switch stack?`);
    process.exit(1);
  }

  await setConfig('power', 'url', url, { updatedBy: 'power-setup' });
  console.log(`✓ runtime-config power/url = ${url}`);
  console.log('  The dashboard Power card picks this up within ~30 seconds.');
  console.log('');
  console.log(`Power panel (bookmark this on your phone AND laptop): ${url}`);
  console.log('It stays reachable even while the whole stack is paused.');
  console.log('');
  if (SHOW_TOKEN) {
    const sm = new SecretsManagerClient({ region: REGION });
    const sec = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
    let token = sec.SecretString ?? '';
    try {
      token = (JSON.parse(token) as { token?: string }).token ?? token;
    } catch {
      /* plain string secret */
    }
    console.log(`Power token (paste into the panel once; it stores locally): ${token}`);
  } else {
    console.log('Get the panel token once with:');
    console.log(
      `  aws secretsmanager get-secret-value --secret-id ${secretName} --query SecretString --output text`,
    );
    console.log('(or rerun with --show-token)');
  }
  console.log('');
  console.log('Defaults: nightly auto-pause at 06:00 America/Toronto; each wake holds 6h.');
  console.log('Wake takes 2 to 3 minutes; the panel shows RESTORED when everything answers.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
