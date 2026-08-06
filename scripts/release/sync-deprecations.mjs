#!/usr/bin/env node
/**
 * Deprecations-registry drift gate (IaC readiness item 49).
 *
 *   node scripts/release/sync-deprecations.mjs            # check, exit 1 on drift
 *   node scripts/release/sync-deprecations.mjs --write    # append missing baseline entries
 *   node scripts/release/sync-deprecations.mjs --write --introduced v1.3.0
 *
 * Re-derives the env surface (src/config/env.ts zod schema keys) and the
 * runtime-config surface (scripts/lib/seed-defaults.ts SEED_DEFAULTS keys)
 * from the CODE, then fails when docs/deprecations.json is missing any
 * current element, or carries a removed-marked entry for an element that
 * is still present. This is what keeps the registry honest between
 * releases; the release-time diff against a previous tag lives in
 * scripts/release/contract-check.mjs.
 *
 * The other surfaces (cli-flag, agent-yaml, env-reference, updater-format)
 * are seeded in the registry and diffed at release time by contract-check,
 * but are NOT re-derived here — their extraction is heuristic enough that
 * a per-commit hard gate would cry wolf.
 *
 * Support-window policy text: docs/release-pipeline.md.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { parseDeprecations, syncCheck } from './contract-surfaces.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ENV_SCHEMA_PATH = 'src/config/env.ts';
export const SEED_DEFAULTS_PATH = 'scripts/lib/seed-defaults.ts';
export const DEPRECATIONS_PATH = 'docs/deprecations.json';

/** Run the drift gate against a directory tree. Pure given the tree. */
export function runSyncCheck(rootDir) {
  const envSource = readFileSync(join(rootDir, ENV_SCHEMA_PATH), 'utf-8');
  const seedSource = readFileSync(join(rootDir, SEED_DEFAULTS_PATH), 'utf-8');
  const registry = parseDeprecations(readFileSync(join(rootDir, DEPRECATIONS_PATH), 'utf-8'));
  return { ...syncCheck({ envSource, seedSource, registry }), registry };
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const introducedIdx = args.indexOf('--introduced');
  const introduced = introducedIdx >= 0 ? args[introducedIdx + 1] : '0.0.1';

  const { missing, stale, current, registry } = runSyncCheck(repoRoot);

  if (write && missing.length > 0) {
    for (const { surface, id } of missing) {
      registry.elements.push({ surface, id, introduced });
    }
    writeFileSync(
      join(repoRoot, DEPRECATIONS_PATH),
      JSON.stringify(registry, null, 2) + '\n',
    );
    console.log(`sync-deprecations: appended ${missing.length} element(s) as introduced ${introduced}`);
    return;
  }

  let failed = false;
  if (missing.length > 0) {
    failed = true;
    console.error('sync-deprecations: docs/deprecations.json is MISSING current contract elements:');
    for (const { surface, id } of missing) console.error(`  - ${surface}:${id}`);
    console.error('Fix: re-run with --write --introduced <upcoming-tag> and review the diff.');
  }
  if (stale.length > 0) {
    failed = true;
    console.error('sync-deprecations: registry marks these elements removed, but they are still present:');
    for (const { surface, id, removed } of stale) console.error(`  - ${surface}:${id} (removed: ${removed})`);
    console.error('Fix: finish the removal in code, or drop the "removed" tag from the entry.');
  }
  if (failed) process.exit(1);
  console.log(
    `sync-deprecations: registry covers all ${current.env.length} env keys and ` +
      `${current['runtime-config-key'].length} runtime-config keys — no drift.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
