/**
 * Item 49 contract tooling: pure-function tests for the surface
 * extractors and the diff-with-metadata validation. Fixture strings only,
 * no git and no AWS — the release-time wiring (git show) lives in
 * contract-check.mjs and is deliberately thin.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs release helper, no type declarations on purpose
import { extractEnvSchemaKeys, extractEnvReferenceVars, extractCliFlags, extractRuntimeConfigKeys, extractAgentYamlKeys, extractSchemaVersionConstants, hasWorkingDefault, diffIds, tagLessThan, parseDeprecations, validateContract } from './contract-surfaces.mjs';

const ENV_FIXTURE = `
import { z } from 'zod';
const envSchema = z.object({
  // ── Runtime ──
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  AWS_REGION: z.string().default('us-east-1'),
  OLD_FLAG: z.string().optional(),
  TAVILY_API_KEY: optionalNonPlaceholder(),
  STRICT_BOUNDARY: z.string(),
});
export type Env = z.infer<typeof envSchema>;
`;

describe('extractEnvSchemaKeys', () => {
  it('takes every KEY line of the zod object, skipping comments', () => {
    const keys = extractEnvSchemaKeys(ENV_FIXTURE) as Array<{ key: string; declaration: string }>;
    expect(keys.map((k) => k.key)).toEqual([
      'NODE_ENV',
      'PORT',
      'AWS_REGION',
      'OLD_FLAG',
      'TAVILY_API_KEY',
      'STRICT_BOUNDARY',
    ]);
  });

  it('stops at the schema close and returns [] without a schema', () => {
    expect(extractEnvSchemaKeys('export const x = 1;')).toEqual([]);
    const keys = extractEnvSchemaKeys(ENV_FIXTURE + '\n  NOT_A_KEY: z.string(),\n');
    expect((keys as Array<{ key: string }>).some((k) => k.key === 'NOT_A_KEY')).toBe(false);
  });

  it('classifies working defaults: optional/default/optionalNonPlaceholder pass, bare required fails', () => {
    const keys = extractEnvSchemaKeys(ENV_FIXTURE) as Array<{ key: string; declaration: string }>;
    const byKey = Object.fromEntries(keys.map((k) => [k.key, k.declaration]));
    expect(hasWorkingDefault(byKey.NODE_ENV)).toBe(true);
    expect(hasWorkingDefault(byKey.OLD_FLAG)).toBe(true);
    expect(hasWorkingDefault(byKey.TAVILY_API_KEY)).toBe(true);
    expect(hasWorkingDefault(byKey.STRICT_BOUNDARY)).toBe(false);
  });
});

describe('extractEnvReferenceVars', () => {
  it('takes uncommented VAR= lines only', () => {
    const src = '# header\nAWS_REGION=us-east-1\n# DOC_ONLY=1\nDEPLOY_TIER=\n  INDENTED=no\n';
    expect(extractEnvReferenceVars(src)).toEqual(['AWS_REGION', 'DEPLOY_TIER']);
  });
});

describe('extractCliFlags', () => {
  it('finds includes / startsWith / flagValue / === idioms', () => {
    const src = `
      const dryRun = argv.includes('--dry-run');
      const yes = args.includes('--yes') || args.includes('-y');
      const tierArg = args.find((a) => a.startsWith('--tier='))?.split('=')[1];
      const klass = flagValue(argv, 'class');
      if (a === '--answers') { }
    `;
    expect(extractCliFlags(src)).toEqual(['--answers', '--class', '--dry-run', '--tier', '--yes', '-y']);
  });

  it('never counts AWS-CLI argument literals', () => {
    const src = `
      await capture('aws', ['ecr', 'describe-images', '--repository-name', repo, '--region', region]);
      args.push('--tags', ...tags);
    `;
    expect(extractCliFlags(src)).toEqual([]);
  });

  it('maps resolveEnvFlag / resolveAnswersFlag helper calls to their flags', () => {
    expect(extractCliFlags('const envFlag = resolveEnvFlag(argv);')).toEqual(['--env']);
    expect(extractCliFlags('const p = resolveAnswersFlag(process.argv.slice(2));')).toEqual([
      '--answers',
    ]);
  });
});

describe('extractRuntimeConfigKeys', () => {
  it('reads category/key pairs from SEED_DEFAULTS-shaped rows', () => {
    const src = `
  {
    category: 'memory',
    key: 'ingest_every_n_turns',
    value: '8',
  },
  {
    category: 'cost',
    key: 'daily_cap_usd',
    value: '50',
  },
`;
    expect(extractRuntimeConfigKeys(src)).toEqual(['memory/ingest_every_n_turns', 'cost/daily_cap_usd']);
  });
});

describe('extractAgentYamlKeys', () => {
  it('reads top-level flat keys, skipping comments', () => {
    const src = '# comment\nname: Research Bot\ndescription: Something\nmodel: x\nknowledgeScope: research\n';
    expect(extractAgentYamlKeys(src)).toEqual(['name', 'description', 'model', 'knowledgeScope']);
  });
});

describe('extractSchemaVersionConstants', () => {
  it('finds *_SCHEMA_VERSION constants', () => {
    const src = 'export const MANIFEST_SCHEMA_VERSION = 1;\nexport const APP_SCHEMA_VERSION = 2;\n';
    expect(extractSchemaVersionConstants(src)).toEqual([
      { name: 'MANIFEST_SCHEMA_VERSION', value: 1 },
      { name: 'APP_SCHEMA_VERSION', value: 2 },
    ]);
  });
});

describe('diffIds / tagLessThan', () => {
  it('diffs id sets', () => {
    expect(diffIds(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
  });
  it('orders semver-ish tags and returns null on garbage', () => {
    expect(tagLessThan('v1.2.0', 'v1.3.0')).toBe(true);
    expect(tagLessThan('1.3.0', 'v1.3.0')).toBe(false);
    expect(tagLessThan('v2.0.0', 'v1.9.9')).toBe(false);
    expect(tagLessThan('weird', 'v1.0.0')).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────
// validateContract — the item 49 gate as pure logic
// ─────────────────────────────────────────────────────────────────────

function registryOf(elements: unknown[]): unknown {
  return parseDeprecations(JSON.stringify({ schemaVersion: 1, elements }));
}

describe('validateContract', () => {
  it('passes a no-change diff against a clean registry', () => {
    const { violations } = validateContract({
      surfaces: { env: { prev: ['A'], curr: ['A'] } },
      registry: registryOf([{ surface: 'env', id: 'A', introduced: '0.0.1' }]),
      upgradingText: '',
      envSource: '',
    }) as { violations: string[] };
    expect(violations).toEqual([]);
  });

  it('FAILS a removal without deprecation metadata', () => {
    const { violations } = validateContract({
      surfaces: { env: { prev: ['A', 'B'], curr: ['A'] } },
      registry: registryOf([
        { surface: 'env', id: 'A', introduced: '0.0.1' },
        { surface: 'env', id: 'B', introduced: '0.0.1' },
      ]),
      upgradingText: 'B was removed',
      envSource: '',
    }) as { violations: string[] };
    expect(violations.some((v) => v.includes('env:B') && v.includes('without deprecation metadata'))).toBe(true);
  });

  it('FAILS a removal missing UPGRADING coverage even with metadata', () => {
    const { violations } = validateContract({
      surfaces: { env: { prev: ['B'], curr: [] } },
      registry: registryOf([
        { surface: 'env', id: 'B', introduced: '0.0.1', deprecated: 'v1.1.0', removed: 'v1.2.0' },
      ]),
      upgradingText: 'nothing about it',
      envSource: '',
    }) as { violations: string[] };
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('UPGRADING.md never names it');
  });

  it('passes a properly deprecated removal with UPGRADING coverage', () => {
    const { violations } = validateContract({
      surfaces: { env: { prev: ['B'], curr: [] } },
      registry: registryOf([
        { surface: 'env', id: 'B', introduced: '0.0.1', deprecated: 'v1.1.0', removed: 'v1.2.0' },
      ]),
      upgradingText: '## v1.2.0\n- removed `B` (deprecated since v1.1.0); use C instead.',
      envSource: '',
    }) as { violations: string[] };
    expect(violations).toEqual([]);
  });

  it('FAILS deprecated == removed (never shipped a warn release), across the FULL window', () => {
    // The diff itself sees nothing (prev == curr) — only the full-window
    // walk can catch this, which is exactly the not-just-N-1 property.
    const { violations } = validateContract({
      surfaces: { env: { prev: ['A'], curr: ['A'] } },
      registry: registryOf([
        { surface: 'env', id: 'A', introduced: '0.0.1' },
        { surface: 'cli-flag', id: 'deploy:--old', introduced: '0.0.1', deprecated: 'v1.2.0', removed: 'v1.2.0' },
      ]),
      upgradingText: 'deploy:--old',
      envSource: '',
    }) as { violations: string[] };
    expect(violations.some((v) => v.includes('deploy:--old') && v.includes('deprecated == removed'))).toBe(true);
  });

  it('FAILS a removed-marked element that is still present', () => {
    const { violations } = validateContract({
      surfaces: { env: { prev: ['A'], curr: ['A'] } },
      registry: registryOf([
        { surface: 'env', id: 'A', introduced: '0.0.1', deprecated: 'v1.0.0', removed: 'v1.1.0' },
      ]),
      upgradingText: 'A',
      envSource: '',
    }) as { violations: string[] };
    expect(violations.some((v) => v.includes('still present'))).toBe(true);
  });

  it('FAILS a deprecation tag that does not predate its removal tag', () => {
    const { violations } = validateContract({
      surfaces: { env: { prev: ['B'], curr: [] } },
      registry: registryOf([
        { surface: 'env', id: 'B', introduced: '0.0.1', deprecated: 'v1.3.0', removed: 'v1.2.0' },
      ]),
      upgradingText: 'B',
      envSource: '',
    }) as { violations: string[] };
    expect(violations.some((v) => v.includes('does not predate'))).toBe(true);
  });

  it('FAILS a NEW required env var without a working default', () => {
    const envSource = `
const envSchema = z.object({
  EXISTING: z.string().optional(),
  NEW_REQUIRED: z.string(),
});
`;
    const { violations } = validateContract({
      surfaces: { env: { prev: ['EXISTING'], curr: ['EXISTING', 'NEW_REQUIRED'] } },
      registry: registryOf([
        { surface: 'env', id: 'EXISTING', introduced: '0.0.1' },
        { surface: 'env', id: 'NEW_REQUIRED', introduced: 'v1.2.0' },
      ]),
      upgradingText: '',
      envSource,
    }) as { violations: string[] };
    expect(violations.some((v) => v.includes('NEW_REQUIRED') && v.includes('working defaults'))).toBe(true);
  });

  it('allows a new required env var flagged security-boundary in the registry notes', () => {
    const envSource = `
const envSchema = z.object({
  NEW_GATE: z.string(),
});
`;
    const { violations } = validateContract({
      surfaces: { env: { prev: [], curr: ['NEW_GATE'] } },
      registry: registryOf([
        {
          surface: 'env',
          id: 'NEW_GATE',
          introduced: 'v1.2.0',
          notes: 'security-boundary: fail-closed auth gate, no default by design',
        },
      ]),
      upgradingText: '',
      envSource,
    }) as { violations: string[] };
    expect(violations).toEqual([]);
  });
});

describe('parseDeprecations', () => {
  it('rejects wrong schemaVersion, unknown surfaces, and missing fields', () => {
    expect(() => parseDeprecations(JSON.stringify({ schemaVersion: 2, elements: [] }))).toThrow(/schemaVersion/);
    expect(() =>
      parseDeprecations(JSON.stringify({ schemaVersion: 1, elements: [{ surface: 'nope', id: 'x', introduced: '0.0.1' }] })),
    ).toThrow(/unknown surface/);
    expect(() =>
      parseDeprecations(JSON.stringify({ schemaVersion: 1, elements: [{ surface: 'env', id: 'X' }] })),
    ).toThrow(/introduced/);
  });
});
