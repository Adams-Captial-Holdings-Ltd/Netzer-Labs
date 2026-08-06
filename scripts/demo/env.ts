/**
 * Shared env bootstrap for the demo scripts (scripts/demo/*).
 *
 * The app's state repos capture their DynamoDB table name at module-load time
 * from process.env (e.g. `const TABLE = process.env.TABLE_MEMORIES ?? '...'`).
 * So we MUST populate process.env BEFORE those modules are imported. Every demo
 * script therefore calls bootstrapDemoEnv() first, then reaches the app via
 * dynamic `await import()` inside its run function, never a top-level static
 * import of anything under src/lib.
 *
 * Resolution mirrors scripts/seed.ts: the --env file wins over the ambient
 * shell, and table names are derived from infra/lib/constants.ts for the same
 * suffix deploy.ts uses (explicit CCE_NAME_SUFFIX, else the env name, '' for
 * prod). Point this at a dedicated demo deployment with `--env=demo`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile, resolveEnvFlag, envFileNameFor } from '../lib/env-file.js';
import { buildResourceNames } from '../../infra/lib/constants.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface DemoEnv {
  region: string;
  suffix: string;
  envFlag: string;
}

/**
 * Merge the resolved env file into process.env, derive any missing table names,
 * and assert the values the demo scripts cannot run without. Returns the
 * resolved region/suffix for logging. Throws (caught by each script's main) on
 * a missing hard requirement.
 */
export function bootstrapDemoEnv(argv: string[]): DemoEnv {
  const envFlag = resolveEnvFlag(argv);
  const envFileName = envFileNameFor(envFlag);
  const envPath = join(repoRoot, envFileName);
  const fileEnv = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf-8')) : {};

  // File values win over the ambient shell, matching deploy.ts/seed.ts. We write
  // straight into process.env (not a local copy) because the app repos read
  // process.env at module load.
  for (const [k, v] of Object.entries(fileEnv)) {
    if (typeof v === 'string') process.env[k] = v;
  }

  const region = process.env.AWS_REGION;
  if (!region) {
    throw new Error(
      `Missing AWS_REGION (looked in ${envFileName} and the shell). Run \`npm run setup\` or export it.`,
    );
  }
  if (!process.env.CONFIG_BUCKET) {
    throw new Error(
      'Missing CONFIG_BUCKET. The demo fleet phase needs the agent config bucket to write CLAUDE.md / agent.yaml.',
    );
  }

  const suffix = process.env.CCE_NAME_SUFFIX ?? (envFlag === 'prod' ? '' : envFlag);
  const ddb = buildResourceNames(suffix).ddb;

  // Derive table names only when the env file did not set them. The repos
  // already default to the unsuffixed prod names, so this is the line that makes
  // a suffixed demo deployment the actual target instead of prod.
  const derived: Record<string, string> = {
    TABLE_SESSIONS: ddb.sessions,
    TABLE_MEMORIES: ddb.memories,
    TABLE_HIVE_MIND: ddb.hiveMind,
    TABLE_CONSOLIDATIONS: ddb.consolidations,
    TABLE_MISSION_TASKS: ddb.missionTasks,
    TABLE_SCHEDULED_TASKS: ddb.scheduledTasks,
    TABLE_KILL_SWITCHES: ddb.killSwitches,
    TABLE_INTER_AGENT_TASKS: ddb.interAgentTasks,
    TABLE_AGENTS: ddb.agents,
    TABLE_RUNTIME_CONFIG: ddb.runtimeConfig,
  };
  for (const [k, v] of Object.entries(derived)) {
    if (!process.env[k]) process.env[k] = v;
  }

  return { region, suffix, envFlag };
}
