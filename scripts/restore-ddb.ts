/**
 * A4 · DDB restore CLI.
 *
 * Two recovery paths, both destructive enough to require a typed confirm:
 *
 *   1. PITR restore (default — uses DynamoDB's continuous backup window,
 *      typically ~35 days):
 *        npm run restore:ddb -- --table=claudeclaw-sessions \
 *          --at=2026-05-20T08:00:00Z \
 *          --as-table=claudeclaw-sessions-restore-20260521
 *
 *   2. S3-export import (uses one of the daily exports the BackupStack
 *      Lambda writes — typically older than the PITR window but cheaper
 *      to keep around for years):
 *        npm run restore:ddb -- --table=claudeclaw-sessions \
 *          --from-date=2026-04-19 \
 *          --as-table=claudeclaw-sessions-restore-20260521
 *
 *      (Flags take the --key=value form; the parser does not accept a
 *      space-separated value.)
 *
 * Neither path overwrites the source table — both create a NEW table
 * (`--as-table`) so an operator can verify before swapping references.
 */

import { ask, closePrompt } from './lib/prompt.js';
import { bold, info, ok, fail, section, warn, gray } from './lib/ansi.js';
import { maybePrintHelp } from './lib/help.js';
import { run, capture } from './lib/shell.js';

interface Args {
  table: string;
  asTable: string;
  at?: string;
  fromDate?: string;
  bucket?: string;
  region: string;
  yes: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
  const yes = argv.includes('--yes') || argv.includes('-y');

  const table = get('table');
  const asTable = get('as-table');
  const at = get('at');
  const fromDate = get('from-date');
  const region = get('region') ?? process.env.AWS_REGION ?? 'us-east-1';
  const bucket = get('bucket');

  if (!table) {
    // eslint-disable-next-line no-console
    console.log(fail('--table=<source-table-name> is required'));
    process.exit(1);
  }
  if (!asTable) {
    // eslint-disable-next-line no-console
    console.log(fail('--as-table=<new-table-name> is required'));
    process.exit(1);
  }
  if (!at && !fromDate) {
    // eslint-disable-next-line no-console
    console.log(
      fail('Provide exactly one of: --at=<ISO timestamp> (PITR), --from-date=YYYY-MM-DD (S3 export)'),
    );
    process.exit(1);
  }
  if (at && fromDate) {
    // eslint-disable-next-line no-console
    console.log(fail('Pass only one of --at OR --from-date, not both'));
    process.exit(1);
  }

  const out: Args = { table, asTable, region, yes };
  if (at) out.at = at;
  if (fromDate) out.fromDate = fromDate;
  if (bucket) out.bucket = bucket;
  return out;
}

async function pitrRestore(args: Args): Promise<void> {
  section(`PITR restore · ${args.table} @ ${args.at} → ${args.asTable}`);
  // eslint-disable-next-line no-console
  console.log(
    gray(
      'Restore creates a NEW table. The source remains untouched. ' +
        'Verify the restored table before swapping any application references.',
    ),
  );

  if (!args.yes) {
    const typed = await ask(`Type "${args.asTable}" to confirm: `);
    if (typed.trim() !== args.asTable) {
      // eslint-disable-next-line no-console
      console.log(warn('confirmation mismatch — aborted'));
      closePrompt();
      process.exit(1);
    }
  }

  const code = await run('aws', [
    'dynamodb',
    'restore-table-to-point-in-time',
    '--source-table-name',
    args.table,
    '--target-table-name',
    args.asTable,
    '--restore-date-time',
    args.at!,
    '--region',
    args.region,
    '--no-cli-pager',
  ]);
  if (code !== 0) {
    // eslint-disable-next-line no-console
    console.log(fail('PITR restore failed — see error above'));
    closePrompt();
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(ok('restore submitted; poll table state with:'));
  // eslint-disable-next-line no-console
  console.log(
    info(`  aws dynamodb wait table-exists --table-name ${args.asTable}`),
  );
}

async function s3ImportRestore(args: Args): Promise<void> {
  section(`S3 export import · ${args.table} from ${args.fromDate} → ${args.asTable}`);
  // eslint-disable-next-line no-console
  console.log(
    gray(
      'Reads from s3://<logs-bucket>/ddb-exports/<table>/<date>/ written ' +
        'by the daily backup Lambda. Creates a NEW table. The source is ' +
        'untouched.',
    ),
  );

  const bucket = args.bucket ?? (await findLogsBucket(args.region));
  if (!bucket) {
    // eslint-disable-next-line no-console
    console.log(
      fail(
        'Could not infer the logs bucket; pass --bucket=<name> explicitly.',
      ),
    );
    closePrompt();
    process.exit(1);
  }

  const s3Prefix = `ddb-exports/${args.table}/${args.fromDate}/`;
  const head = await capture('aws', [
    's3',
    'ls',
    `s3://${bucket}/${s3Prefix}`,
    '--region',
    args.region,
    '--no-cli-pager',
  ]);
  if (head.code !== 0 || head.stdout.trim().length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      fail(
        `No export found at s3://${bucket}/${s3Prefix} — check --from-date or list available with:\n  aws s3 ls s3://${bucket}/ddb-exports/${args.table}/`,
      ),
    );
    closePrompt();
    process.exit(1);
  }

  if (!args.yes) {
    const typed = await ask(`Type "${args.asTable}" to confirm: `);
    if (typed.trim() !== args.asTable) {
      // eslint-disable-next-line no-console
      console.log(warn('confirmation mismatch — aborted'));
      closePrompt();
      process.exit(1);
    }
  }

  // ImportTable takes the export prefix as input. Target schema mirrors
  // the source (we know our PK/SK shape from constants but the cleanest
  // thing is to let the operator pass `--source-table-schema` JSON if
  // needed). For our use case the source schema is implicit in the
  // export, and ImportTable infers it from the exported manifest.
  const code = await run('aws', [
    'dynamodb',
    'import-table',
    '--s3-bucket-source',
    `S3Bucket=${bucket},S3KeyPrefix=${s3Prefix}`,
    '--input-format',
    'DYNAMODB_JSON',
    '--table-creation-parameters',
    JSON.stringify({
      TableName: args.asTable,
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
    '--region',
    args.region,
    '--no-cli-pager',
  ]);
  if (code !== 0) {
    // eslint-disable-next-line no-console
    console.log(
      fail(
        'import-table failed — check schema match for non-PK/SK tables, pass JSON via aws CLI manually if needed',
      ),
    );
    closePrompt();
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(ok(`import started; poll table state with:`));
  // eslint-disable-next-line no-console
  console.log(
    info(`  aws dynamodb wait table-exists --table-name ${args.asTable}`),
  );
}

async function findLogsBucket(region: string): Promise<string | null> {
  // Hardcoded pattern from storage-stack: `claudeclaw-logs-<acct>-<region>`.
  const acct = await capture('aws', [
    'sts',
    'get-caller-identity',
    '--query',
    'Account',
    '--output',
    'text',
    '--region',
    region,
    '--no-cli-pager',
  ]);
  if (acct.code !== 0) return null;
  return `claudeclaw-logs-${acct.stdout.trim()}-${region}`;
}

async function main(): Promise<void> {
  if (
    maybePrintHelp(process.argv.slice(2), {
      command: 'npm run restore:ddb',
      oneLiner: 'restore a DynamoDB table from PITR or a daily S3 export, into a NEW table',
      flags: [
        ['--table=<name>', 'source table (required)'],
        ['--as-table=<name>', 'NEW table to restore into (required; the source is never overwritten)'],
        ['--at=<ISO time>', 'PITR restore point (default path, ~35-day window)'],
        ['--from-date=<YYYY-MM-DD>', 'S3-export import instead of PITR'],
        ['--region=<r>', 'override AWS_REGION'],
        ['--bucket=<name>', 'override the export bucket'],
        ['--yes, -y', 'skip the typed confirmation'],
      ],
      contract: 'Creates a NEW table from backup after a typed confirm; never overwrites the source table.',
      docs: 'docs/lifecycle.md',
    })
  ) {
    return;
  }
  const args = parseArgs();
  // eslint-disable-next-line no-console
  console.log('\n' + bold('ClaudeClaw · DDB restore'));
  if (args.at) {
    await pitrRestore(args);
  } else {
    await s3ImportRestore(args);
  }
  closePrompt();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(fail(`fatal: ${err instanceof Error ? err.message : String(err)}`));
  closePrompt();
  process.exit(1);
});
