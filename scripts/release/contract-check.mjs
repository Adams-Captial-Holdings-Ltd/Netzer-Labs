#!/usr/bin/env node
/**
 * Release-time contract check (IaC readiness item 49).
 *
 *   node scripts/release/contract-check.mjs --previous <ref>
 *   node scripts/release/contract-check.mjs --previous v1.2.0 --json
 *
 * Diffs the PUBLIC OPERATOR CONTRACT between a previous git ref (normally
 * the last release tag) and the current working tree, across five
 * surfaces: env schema keys (src/config/env.ts), .env.reference var
 * names, lifecycle CLI flags, runtime-config keys (seed-defaults), and
 * the agent.yaml schema. The previous side is read with `git show
 * <ref>:<path>` — READ-ONLY git, no checkout, no network.
 *
 * What fails the release (see validateContract in contract-surfaces.mjs):
 *   - any removal/rename without deprecation metadata in
 *     docs/deprecations.json AND a docs/UPGRADING.md section naming the
 *     element;
 *   - any registry element whose `removed` tag has no DISTINCT earlier
 *     `deprecated` tag — this validates the FULL declared support window,
 *     not just candidate-vs-N-1 (a removal that skipped its deprecation
 *     release is caught even when this diff cannot see it);
 *   - a `removed` element that is still present in the tree;
 *   - a NEW env var without a working default, unless its registry entry
 *     notes flag it `security-boundary`.
 *
 * The support-window POLICY (warn-then-remove; N-1 direct upgrades,
 * chained hops beyond) is documented in docs/release-pipeline.md — this
 * script is the enforcement, that doc is the contract.
 *
 * Updater-critical formats: where the modules exist, their
 * *_SCHEMA_VERSION constants are read (guarded by existence — the
 * scripts/lib/release/* modules belong to the release-pipeline
 * workstream) and each constant must have an updater-format entry in
 * the registry.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  extractAgentYamlKeys,
  extractCliFlags,
  extractEnvReferenceVars,
  extractEnvSchemaKeys,
  extractRuntimeConfigKeys,
  extractSchemaVersionConstants,
  parseDeprecations,
  validateContract,
} from './contract-surfaces.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Lifecycle scripts whose flags are public contract (cli-flag surface). */
export const CLI_SCRIPTS = ['setup', 'deploy', 'rollback', 'teardown', 'status', 'doctor', 'seed'];

export const AGENT_YAML_PATH = 'examples/agents/research-bot/agent.yaml';

/**
 * Modules whose *_SCHEMA_VERSION constants are updater-critical. The
 * scripts/lib/release/* modules belong to the release-pipeline
 * workstream; they are read only when present so this check works on
 * older refs too.
 */
const SCHEMA_CONSTANT_MODULES = [
  'scripts/lib/lifecycle/manifest.ts',
  'scripts/lib/release/metadata.ts',
  'scripts/lib/release/signing.ts',
  'scripts/lib/release/promotion.ts',
];

/** Map *_SCHEMA_VERSION constant names to registry updater-format ids. */
const SCHEMA_CONSTANT_TO_FORMAT_ID = {
  MANIFEST_SCHEMA_VERSION: 'deploy-manifest',
  APP_SCHEMA_VERSION: 'app-schema',
  JOURNAL_SCHEMA_VERSION: 'deploy-journal',
  RELEASE_METADATA_SCHEMA_VERSION: 'release-metadata',
  ARTIFACT_MANIFEST_SCHEMA_VERSION: 'artifact-manifest',
  ROTATION_DOC_SCHEMA_VERSION: 'key-rotation-metadata',
  SIGNATURE_ARTIFACT_SCHEMA_VERSION: 'signature-artifact',
  PROMOTION_ATTESTATION_SCHEMA_VERSION: 'promotion-attestation',
};

/** `git show ref:path`, read-only; '' when the path did not exist at ref. */
function gitShow(ref, path, cwd) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

/**
 * Extract every surface from a "reader" (path -> source or ''). Exported
 * so tests can drive it with in-memory fixtures instead of git.
 */
export function collectSurfaces(read) {
  const cliIds = [];
  for (const script of CLI_SCRIPTS) {
    const src = read(`scripts/${script}.ts`);
    if (!src) continue;
    for (const flag of extractCliFlags(src)) cliIds.push(`${script}:${flag}`);
  }
  return {
    env: extractEnvSchemaKeys(read('src/config/env.ts')).map((e) => e.key),
    'env-reference': extractEnvReferenceVars(read('.env.reference')),
    'cli-flag': cliIds,
    'runtime-config-key': extractRuntimeConfigKeys(read('scripts/lib/seed-defaults.ts')),
    'agent-yaml': extractAgentYamlKeys(read(AGENT_YAML_PATH)),
  };
}

/** Updater-format coverage: every schema constant needs a registry entry. */
export function checkUpdaterFormats(registry, modules) {
  const violations = [];
  const found = [];
  for (const { path, source } of modules) {
    for (const { name, value } of extractSchemaVersionConstants(source)) {
      found.push({ path, name, value });
      const id = SCHEMA_CONSTANT_TO_FORMAT_ID[name];
      const entry = registry.elements.find(
        (e) => e.surface === 'updater-format' && e.id === (id ?? name),
      );
      if (!entry) {
        violations.push(
          `updater-format: schema constant ${name} (=${value}, ${path}) has no ` +
            `updater-format entry in docs/deprecations.json — old shims must be able to rely ` +
            `on the warn-then-remove window for this format`,
        );
      }
    }
  }
  return { violations, found };
}

function main() {
  const args = process.argv.slice(2);
  const prevIdx = args.indexOf('--previous');
  const previousRef = prevIdx >= 0 ? args[prevIdx + 1] : undefined;
  const jsonMode = args.includes('--json');
  if (!previousRef) {
    console.error(
      'usage: node scripts/release/contract-check.mjs --previous <ref> [--json]\n' +
        '<ref> is the previous release tag (e.g. v1.2.0); the current side is the working tree.',
    );
    process.exit(2);
  }

  const readCurrent = (path) => {
    const abs = join(repoRoot, path);
    return existsSync(abs) ? readFileSync(abs, 'utf-8') : '';
  };
  const readPrevious = (path) => gitShow(previousRef, path, repoRoot);

  const curr = collectSurfaces(readCurrent);
  const prev = collectSurfaces(readPrevious);
  const surfaces = Object.fromEntries(
    Object.keys(curr).map((s) => [s, { prev: prev[s], curr: curr[s] }]),
  );

  const registry = parseDeprecations(readCurrent('docs/deprecations.json'));
  const upgradingText = readCurrent('docs/UPGRADING.md');
  const envSource = readCurrent('src/config/env.ts');

  const { violations, warnings } = validateContract({ surfaces, registry, upgradingText, envSource });

  const schemaModules = SCHEMA_CONSTANT_MODULES.filter((p) => existsSync(join(repoRoot, p))).map(
    (p) => ({ path: p, source: readFileSync(join(repoRoot, p), 'utf-8') }),
  );
  const updater = checkUpdaterFormats(registry, schemaModules);
  violations.push(...updater.violations);

  const report = {
    previousRef,
    surfaces: Object.fromEntries(
      Object.entries(surfaces).map(([s, v]) => {
        const prevSet = new Set(v.prev);
        const currSet = new Set(v.curr);
        return [
          s,
          {
            previous: v.prev.length,
            current: v.curr.length,
            added: v.curr.filter((id) => !prevSet.has(id)),
            removed: v.prev.filter((id) => !currSet.has(id)),
          },
        ];
      }),
    ),
    schemaConstants: updater.found,
    warnings,
    violations,
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const [s, r] of Object.entries(report.surfaces)) {
      console.log(
        `${s}: ${r.previous} -> ${r.current}` +
          (r.added.length ? ` | added: ${r.added.join(', ')}` : '') +
          (r.removed.length ? ` | removed: ${r.removed.join(', ')}` : ''),
      );
    }
    for (const c of updater.found) console.log(`schema constant ${c.name}=${c.value} (${c.path})`);
    for (const w of warnings) console.log(`WARN: ${w}`);
    for (const v of violations) console.error(`FAIL: ${v}`);
  }

  if (violations.length > 0) {
    console.error(
      `contract-check: ${violations.length} violation(s) against the support window — ` +
        'see docs/release-pipeline.md for the policy and docs/UPGRADING.md for the prose contract.',
    );
    process.exit(1);
  }
  console.log('contract-check: public contract holds against ' + previousRef);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
