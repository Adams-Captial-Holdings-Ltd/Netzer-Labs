#!/usr/bin/env node
/**
 * docs/diagrams.map drift gate (IaC readiness items 32 / 38a).
 * Dependency-free; hermetic apart from local `git diff`.
 *
 *   node scripts/ci/diagrams-drift.mjs [rootDir]
 *
 * Two checks:
 *
 *  1. PATH VALIDATION (always): every mapped diagram file and every mapped
 *     source path must exist — renames/deletions must update the map in the
 *     same PR. This is all that runs outside PR context.
 *
 *  2. DRIFT (PR context only, detected via env GITHUB_BASE_REF): diff the PR
 *     against the base branch; if any mapped SOURCE changed and its diagram
 *     did NOT, fail and name the diagram's owner. Bare CODEOWNERS can never
 *     catch this case — it only triggers when the diagram file itself is
 *     touched, which is exactly what a drifting PR doesn't do.
 *
 * Escape hatch: item 32 specifies a review-approval bypass (an authorized
 * owner approving AFTER the latest mapped-source commit, with stale reviews
 * dismissed by a launch-time repository RULESET). That needs the PR-reviews
 * API and the ruleset, both launch-time work — this script implements the
 * simple fail, and docs/launch-checklist.md carries the ruleset step.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

export function loadMap(rootDir) {
  const mapPath = join(rootDir, 'docs', 'diagrams.map');
  if (!existsSync(mapPath)) throw new Error(`no diagrams map at ${mapPath}`);
  return JSON.parse(readFileSync(mapPath, 'utf-8'));
}

/** Check every mapped diagram + source path exists. Returns failure strings. */
export function validatePaths(rootDir, map) {
  const failures = [];
  for (const [diagram, entry] of Object.entries(map)) {
    if (!existsSync(join(rootDir, diagram))) {
      failures.push(`mapped diagram missing: ${diagram} (renamed or deleted without updating docs/diagrams.map)`);
    }
    if (!entry || !Array.isArray(entry.sources) || entry.sources.length === 0) {
      failures.push(`map entry for ${diagram} has no sources`);
      continue;
    }
    if (!entry.owner) failures.push(`map entry for ${diagram} has no owner`);
    for (const src of entry.sources) {
      if (!existsSync(join(rootDir, src))) {
        failures.push(`mapped source missing: ${src} (depicted by ${diagram})`);
      }
    }
  }
  return failures;
}

/**
 * PR drift check over a changed-files list. Pure so tests can drive it
 * without git. Returns failure strings naming the diagram owner.
 */
export function driftFailures(map, changedFiles) {
  const changed = new Set(changedFiles);
  const failures = [];
  for (const [diagram, entry] of Object.entries(map)) {
    const touchedSources = (entry.sources ?? []).filter((s) => changed.has(s));
    if (touchedSources.length > 0 && !changed.has(diagram)) {
      failures.push(
        `${diagram} may have rotted: this PR changes ${touchedSources.join(', ')} ` +
          `without touching the diagram. Update the diagram in this PR, or get approval ` +
          `from its owner ${entry.owner ?? '(unowned)'}.`,
      );
    }
  }
  return failures;
}

function changedFilesAgainstBase(rootDir, baseRef) {
  // actions/checkout in PR context: the base branch exists as origin/<base>.
  // `...` (merge-base diff) so unrelated base-branch churn doesn't count.
  const out = execFileSync('git', ['diff', '--name-only', `origin/${baseRef}...HEAD`], {
    cwd: rootDir,
    encoding: 'utf-8',
  });
  return out.split('\n').filter(Boolean);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const map = loadMap(rootDir);
  const diagramCount = Object.keys(map).length;

  const pathFailures = validatePaths(rootDir, map);
  if (pathFailures.length > 0) {
    for (const f of pathFailures) console.error(`  FAIL ${f}`);
    console.error(`diagrams-drift: map references ${pathFailures.length} missing path(s)`);
    process.exit(1);
  }
  console.log(`diagrams-drift: ${diagramCount} mapped diagrams, all paths valid`);

  const baseRef = process.env.GITHUB_BASE_REF;
  if (!baseRef) {
    console.log('diagrams-drift: no GITHUB_BASE_REF — not a PR context, path validation only');
    process.exit(0);
  }

  let changed;
  try {
    changed = changedFilesAgainstBase(rootDir, baseRef);
  } catch (err) {
    console.error(`diagrams-drift: git diff against origin/${baseRef} failed: ${err.message}`);
    console.error('  (use fetch-depth: 0 in actions/checkout so the base branch is available)');
    process.exit(1);
  }

  const failures = driftFailures(map, changed);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log(`diagrams-drift: no drift across ${changed.length} changed file(s)`);
}
