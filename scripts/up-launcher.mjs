#!/usr/bin/env node
/**
 * ClaudeClaw Enterprise · up launcher (dependency-free preflight)
 *
 * `npm run up` lands here FIRST, on plain Node with zero dependencies,
 * because the conductor itself (scripts/up.ts) runs under tsx, and tsx only
 * exists after `npm ci`. Without this shim, the very first command a
 * newcomer is told to run can fail with a bare "tsx: command not found".
 * This shim turns the two clone-time stumbles into one-line instructions:
 *
 *   - Node older than 20  -> say so, name the version found, stop.
 *   - node_modules missing -> print the exact `npm ci --ignore-scripts`
 *     to run, stop.
 *
 * Then it execs the real conductor (node -> tsx cli -> scripts/up.ts) with
 * all flags forwarded and stdio inherited, exiting with the child's code.
 * No em dashes by house rule.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const major = Number(process.versions.node.split('.')[0]);
if (Number.isFinite(major) && major < 20) {
  console.error(
    `✗ Node ${process.versions.node} found, but ClaudeClaw Enterprise needs Node 20 or newer.\n` +
      '  Install it from https://nodejs.org (or: brew install node@20), then re-run: npm run up',
  );
  process.exit(1);
}

const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!existsSync(tsxCli)) {
  console.error(
    '✗ Dependencies are not installed yet (this is step 4a; it takes about two minutes).\n' +
      '  Run these two commands from the repo root:\n\n' +
      '    npm ci --ignore-scripts\n' +
      '    npm run up\n',
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [tsxCli, join(repoRoot, 'scripts', 'up.ts'), ...process.argv.slice(2)],
  { cwd: repoRoot, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
