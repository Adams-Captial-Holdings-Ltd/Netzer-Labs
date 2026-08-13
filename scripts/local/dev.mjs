#!/usr/bin/env node
/**
 * `npm run local` - the one command that brings up local development.
 *
 * Steps, in order, stopping at the first failure:
 *   1. create .env from .env.local.example if it is missing (never overwrites)
 *   2. start the Floci emulator via docker compose and wait for health
 *   3. run the AWS isolation guard (fails closed)
 *   4. provision tables, buckets, topic and queue into the emulator
 *   5. seed runtime config defaults
 *   6. run the orchestrator (tsx watch) and the dashboard (vite) together
 *
 * Dependency-free plain Node, matching scripts/up-launcher.mjs, so it works
 * before `npm ci` has finished and never needs tsx itself.
 *
 * No em dashes by house rule.
 */

import { existsSync, copyFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const COMPOSE = ['compose', '-f', join(repoRoot, 'docker-compose.local.yml')];

const say = (msg) => process.stdout.write(`${msg}\n`);
const die = (msg) => {
  process.stderr.write(`\n${msg}\n\n`);
  process.exit(1);
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: repoRoot, stdio: 'inherit', ...opts });
  if (r.error && r.error.code === 'ENOENT') die(`Could not run "${cmd}". Is it installed and on PATH?`);
  return r.status ?? 1;
}

// ---- 1. env file ----------------------------------------------------
const envPath = join(repoRoot, '.env');
const envTemplate = join(repoRoot, '.env.local.example');
if (!existsSync(envPath)) {
  if (!existsSync(envTemplate)) die('Missing .env.local.example. Cannot create a local .env.');
  copyFileSync(envTemplate, envPath);
  say('created .env from .env.local.example');
} else {
  // Never clobber an existing .env: it may hold a developer's own settings.
  say('using existing .env (not overwritten)');
}

// ---- 2. emulator ----------------------------------------------------
say('starting Floci emulator...');
if (run('docker', [...COMPOSE, 'up', '-d', '--wait']) !== 0) {
  die('Floci failed to start. Is Docker running? Check: docker compose -f docker-compose.local.yml logs');
}

// ---- 3 + 4 + 5. guard, provision, seed ------------------------------
// Each runs under tsx and inherits .env through --env-file so it sees exactly
// what the orchestrator will see.
const tsx = ['--env-file=.env', join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')];
if (!existsSync(join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'))) {
  die('Dependencies are not installed yet. Run:\n\n    npm ci --ignore-scripts\n    npm run local');
}

if (run(process.execPath, [...tsx, join(repoRoot, 'scripts', 'local', 'provision.ts')]) !== 0) {
  die('Provisioning failed. Nothing was started.');
}

// Runtime config defaults (cost cap, feature arms). Idempotent conditional
// puts, so re-running never overwrites a value you tuned locally.
if (run(process.execPath, [...tsx, join(repoRoot, 'scripts', 'seed.ts')]) !== 0) {
  say('warning: runtime-config seeding failed. The app still boots; some defaults will be missing.');
}

// ---- 6. app + dashboard ---------------------------------------------
say('\nstarting orchestrator (:3000) and dashboard (:5173)\npress Ctrl-C to stop both\n');

const children = [
  spawn('npm', ['run', 'dev'], { cwd: repoRoot, stdio: 'inherit' }),
  spawn('npm', ['run', 'dev'], { cwd: join(repoRoot, 'web'), stdio: 'inherit' }),
];

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) c.kill(signal);
  }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// If either process dies, take the other down too: a half-running stack is
// more confusing than a stopped one.
for (const c of children) {
  c.on('exit', (code) => {
    if (!shuttingDown) {
      shutdown('SIGTERM');
      process.exitCode = code ?? 1;
    }
  });
}
