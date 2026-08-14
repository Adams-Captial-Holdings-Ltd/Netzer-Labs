#!/usr/bin/env tsx
/**
 * SES sender setup for `no-reply@pgnos.ai` (pgnos public dashboard + email
 * design, Component 5).
 *
 *   npm run email:setup
 *
 * Discovers or creates the `pgnos.ai` SES domain identity, attaches the
 * `bounce.pgnos.ai` custom MAIL FROM, and prints the PUBLIC DNS records to
 * publish in Cloudflare. Re-run it to poll verification while DNS propagates.
 *
 * Mutation contract: at most TWO AWS writes (CreateEmailIdentity once, and
 * PutEmailIdentityMailFromAttributes until it matches). It creates no DNS
 * record, sends no mail, and touches no Cloudflare resource; `salessly.io` and
 * the `claudeclaw` tunnel are never referenced. `--help` mutates nothing.
 *
 * Every value this command prints is public by design: DKIM CNAME targets,
 * an SPF include, a bounce MX and a DMARC policy all have to be published in
 * DNS to do anything at all. No credential is read, written, or displayed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { maybePrintHelp } from './lib/help.js';
import { parseEnvFile, resolveEnvFlag, envFileNameFor } from './lib/env-file.js';
import {
  syncSesIdentity,
  SesSetupBlocker,
  EMAIL_DEFAULT_SENDER,
  EMAIL_DASHBOARD_URL,
  type SesDnsRecord,
} from './lib/ses/setup.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);

function say(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

/** Operator-facing DNS table. Cloudflare's UI takes these fields verbatim. */
function printRecords(records: SesDnsRecord[]): void {
  say('');
  say('Publish these records in the pgnos.ai Cloudflare zone (DNS-only, not proxied):');
  say('');
  for (const r of records) {
    const prio = r.priority === undefined ? '' : `  priority ${r.priority}`;
    say(`  ${r.type.padEnd(5)} ${r.name}`);
    say(`        -> ${r.value}${prio}`);
    say(`        (${r.purpose})`);
    say('');
  }
  say('  None of these is an apex record: the Microsoft 365 apex TXT');
  say('  (MS=ms53482844) and apex mail routing are deliberately untouched.');
}

async function main(): Promise<number> {
  if (
    maybePrintHelp(argv, {
      command: 'npm run email:setup',
      oneLiner:
        'create or discover the pgnos.ai SES sender and print its public DNS records',
      flags: [['--env=<name>', 'which env file to read (default prod -> .env)']],
      contract:
        'At most TWO AWS writes (CreateEmailIdentity, PutEmailIdentityMailFromAttributes). ' +
        'Creates no DNS record, sends no mail, never touches salessly.io. --help mutates nothing.',
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

  const region = env.AWS_REGION ?? 'us-east-1';
  const expectedAccountId = env.AWS_ACCOUNT_ID ?? '';
  if (!expectedAccountId) {
    say('AWS_ACCOUNT_ID is not set in your env file; refusing to guess the target account.');
    return 1;
  }

  // Blank means "not chosen yet", so fall back to the sender the design names
  // rather than failing: this command is how the value gets established.
  const sender = (env.CCE_EMAIL_FROM ?? '').trim() || EMAIL_DEFAULT_SENDER;

  // Gate: the right AWS account, before anything else is contacted.
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

  const result = await syncSesIdentity({
    expectedAccountId,
    actualAccountId,
    sender,
    region,
    ses: new SESv2Client({ region }),
    log: say,
  });

  printRecords(result.records);

  say('');
  say(`   identity   ${result.domain} (${result.created ? 'created' : 'existing'})`);
  say(`   sender     ${result.sender}`);
  say(`   mail from  ${result.mailFromDomain}`);
  say(`   DKIM       ${result.dkimStatus}`);
  say(`   MAIL FROM  ${result.mailFromStatus}`);
  say(`   sending    ${result.verifiedForSending ? 'verified' : 'not verified yet'}`);
  say(`   production ${result.productionAccessEnabled ? 'enabled' : 'SANDBOX'}`);

  if (result.sandboxRemediation) {
    say('');
    say(result.sandboxRemediation);
  }

  const ready = result.verifiedForSending && result.productionAccessEnabled;
  say('');
  if (ready) {
    say('SES is ready. Set these in .env and redeploy so they reach the task:');
    say(`  CCE_EMAIL_FROM=${result.sender}`);
    say(`  CCE_DASHBOARD_URL=${EMAIL_DASHBOARD_URL}`);
  } else {
    say('Not ready to deploy the email env values yet. Publish the DNS records above,');
    say('then re-run `npm run email:setup` to poll verification.');
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(message);
    if (!(err instanceof SesSetupBlocker)) {
      // eslint-disable-next-line no-console
      console.error('Run `aws login --profile netzer-root` if this was an auth failure.');
    }
    process.exit(1);
  });
