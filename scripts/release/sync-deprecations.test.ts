/**
 * Drift gate for docs/deprecations.json (IaC readiness item 49), tested
 * against the REAL repo files: the current tree must pass (every env
 * schema key and runtime-config key has an active registry entry), and
 * fabricated drift fixtures must fail. This is the test that breaks when
 * someone adds an env var or seed row without registering it — that is
 * its job, run `node scripts/release/sync-deprecations.mjs --write
 * --introduced <upcoming-tag>` and review the diff.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs release helper, no type declarations on purpose
import { parseDeprecations, syncCheck } from './contract-surfaces.mjs';
// @ts-expect-error — plain .mjs release helper, no type declarations on purpose
import { runSyncCheck, ENV_SCHEMA_PATH, SEED_DEFAULTS_PATH, DEPRECATIONS_PATH } from './sync-deprecations.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Element {
  surface: string;
  id: string;
  introduced: string;
  removed?: string;
}
interface Registry {
  schemaVersion: number;
  elements: Element[];
}

const envSource = readFileSync(join(repoRoot, ENV_SCHEMA_PATH), 'utf-8');
const seedSource = readFileSync(join(repoRoot, SEED_DEFAULTS_PATH), 'utf-8');
const realRegistry = parseDeprecations(
  readFileSync(join(repoRoot, DEPRECATIONS_PATH), 'utf-8'),
) as Registry;

describe('sync-deprecations against the real tree', () => {
  it('the current tree passes: registry covers every env + runtime-config element', () => {
    const { missing, stale } = runSyncCheck(repoRoot) as {
      missing: Element[];
      stale: Element[];
    };
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('extracts a sane number of elements (the surfaces are not silently empty)', () => {
    const { current } = syncCheck({ envSource, seedSource, registry: realRegistry }) as {
      current: { env: string[]; 'runtime-config-key': string[] };
    };
    // Guards against a refactor of env.ts/seed-defaults.ts silently
    // breaking extraction (an empty surface would make the gate vacuous).
    expect(current.env.length).toBeGreaterThan(50);
    expect(current['runtime-config-key'].length).toBeGreaterThanOrEqual(10);
    expect(current.env).toContain('AWS_REGION');
    expect(current['runtime-config-key']).toContain('cost/daily_cap_usd');
  });
});

describe('sync-deprecations drift fixtures', () => {
  it('FAILS when the registry is missing a current element', () => {
    const doctored: Registry = {
      ...realRegistry,
      elements: realRegistry.elements.filter(
        (e) => !(e.surface === 'env' && e.id === 'AWS_REGION'),
      ),
    };
    const { missing } = syncCheck({ envSource, seedSource, registry: doctored }) as {
      missing: Element[];
    };
    expect(missing).toEqual([{ surface: 'env', id: 'AWS_REGION' }]);
  });

  it('FAILS when the registry marks a still-present element as removed', () => {
    const doctored: Registry = {
      ...realRegistry,
      elements: realRegistry.elements.map((e) =>
        e.surface === 'runtime-config-key' && e.id === 'cost/daily_cap_usd'
          ? { ...e, deprecated: 'v1.0.0', removed: 'v1.1.0' }
          : e,
      ),
    };
    const { stale } = syncCheck({ envSource, seedSource, registry: doctored }) as {
      stale: Element[];
    };
    expect(stale).toEqual([
      { surface: 'runtime-config-key', id: 'cost/daily_cap_usd', removed: 'v1.1.0' },
    ]);
  });
});
