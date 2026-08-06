/**
 * `npm run seed` — idempotent runtime-config seeding (IaC plan items 8c + 27).
 *
 * Writes the sane defaults in scripts/lib/seed-defaults.ts into the
 * runtime-config DDB table with a conditional put (attribute_not_exists), so
 * existing keys are NEVER overwritten: re-running is always safe, and
 * operator-tuned values survive. deploy.ts embeds the same runSeed() as its
 * phase (c) after the Dynamo stack completes.
 *
 * Usage:
 *   tsx scripts/seed.ts                 # prod (.env)
 *   tsx scripts/seed.ts --env=staging   # staging (.env.staging, suffixed table)
 *   tsx scripts/seed.ts --json          # machine-readable output for CI
 *
 * Exit code is nonzero only on real API errors (missing table, auth, throttle
 * after SDK retries). "Key already exists" is the success path (a skip).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { parseEnvFile, resolveEnvFlag, envFileNameFor } from './lib/env-file.js';
import { SEED_DEFAULTS, applyEnvOverrides, runSeed } from './lib/seed-defaults.js';
import { buildResourceNames } from '../infra/lib/constants.js';
import { bold, dim, fail, ok } from './lib/ansi.js';
import { maybePrintHelp } from './lib/help.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(__filename), '..');

interface CliArgs {
  json: boolean;
  envFlag: string;
}

function parseArgs(argv: string[]): CliArgs {
  return {
    json: argv.includes('--json'),
    envFlag: resolveEnvFlag(argv),
  };
}

/**
 * Resolve the runtime-config table name the same way the app and infra do:
 * an explicit TABLE_RUNTIME_CONFIG wins (mirrors src/config/env.ts /
 * runtime-config-repo.ts reading process.env.TABLE_RUNTIME_CONFIG); otherwise
 * derive `claudeclaw[-suffix]-runtime-config` via infra/lib/constants.ts
 * buildResourceNames, with the suffix following deploy.ts's rule: explicit
 * CCE_NAME_SUFFIX, else the --env name ('' for prod).
 */
export function resolveTableName(env: Record<string, string | undefined>, envFlag: string): string {
  if (env.TABLE_RUNTIME_CONFIG) return env.TABLE_RUNTIME_CONFIG;
  const suffix = env.CCE_NAME_SUFFIX ?? (envFlag === 'prod' ? '' : envFlag);
  return buildResourceNames(suffix).ddb.runtimeConfig;
}

async function main(): Promise<void> {
  if (
    maybePrintHelp(process.argv.slice(2), {
      command: 'npm run seed',
      oneLiner: 'idempotent runtime-config seeding (also embedded in deploy phase c)',
      flags: [
        ['--env=<name>', 'target .env.<name> instead of .env'],
        ['--json', 'machine-readable output for CI'],
      ],
      contract: 'Conditional puts only: existing keys are never overwritten, so re-running is always safe.',
    })
  ) {
    return;
  }
  const args = parseArgs(process.argv.slice(2));

  const envFileName = envFileNameFor(args.envFlag);
  const envPath = join(repoRoot, envFileName);
  const fileEnv = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf-8')) : {};
  // File values win over ambient shell values, matching deploy.ts/status.ts.
  const env: Record<string, string | undefined> = { ...process.env, ...fileEnv };

  const tableName = resolveTableName(env, args.envFlag);
  const region = env.AWS_REGION;
  if (!region) {
    const msg = `Missing AWS_REGION (looked in ${envFileName} and the shell env). Run \`npm run setup\` or export it.`;
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(fail(msg));
    }
    process.exit(1);
  }

  const rows = applyEnvOverrides(SEED_DEFAULTS, env);
  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  if (!args.json) {
    console.log(bold(`Seeding runtime-config defaults → ${tableName} (${region})`));
  }

  let exitCode = 0;
  try {
    const result = await runSeed({ ddbClient, tableName, rows });
    if (args.json) {
      console.log(
        JSON.stringify({
          ok: true,
          table: tableName,
          region,
          created: result.created,
          skipped: result.skipped,
        }),
      );
    } else {
      for (const id of result.created) console.log(ok(`seeded  ${id}`));
      for (const id of result.skipped) console.log(dim(`exists  ${id} (left untouched)`));
      console.log(
        bold(`seeded ${result.created.length}, left ${result.skipped.length} existing`),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (args.json) {
      console.log(JSON.stringify({ ok: false, table: tableName, region, error: msg }));
    } else {
      console.error(fail(msg));
    }
    exitCode = 1;
  } finally {
    ddbClient.destroy();
  }
  process.exit(exitCode);
}

void main();
