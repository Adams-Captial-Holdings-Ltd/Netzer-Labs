#!/usr/bin/env node
/**
 * Public-contract surface extraction + diff + deprecation validation
 * (IaC readiness item 49). Pure functions over SOURCE TEXT, no fs and no
 * git in here, so both release tools and the vitest suite can feed
 * fixture strings:
 *
 *   - scripts/release/sync-deprecations.mjs uses the extractors to prove
 *     docs/deprecations.json still covers the CURRENT env + runtime-config
 *     surfaces (the drift gate, runs on every test run);
 *   - scripts/release/contract-check.mjs uses extract + diff + validate
 *     against a PREVIOUS git ref at release time.
 *
 * The support-window POLICY these checks enforce (warn-then-remove, N-1
 * direct upgrades, chained hops beyond) is documented in
 * docs/release-pipeline.md; the machine-readable registry the checks read
 * is docs/deprecations.json.
 */

export const DEPRECATIONS_SCHEMA_VERSION = 1;

/** The contract surfaces item 49 covers. */
export const SURFACES = [
  'env',
  'env-reference',
  'cli-flag',
  'runtime-config-key',
  'agent-yaml',
  'updater-format',
];

// ─────────────────────────────────────────────────────────────────────
// Extractors (source text in, sorted id lists out)
// ─────────────────────────────────────────────────────────────────────

/**
 * Keys of the zod env schema in src/config/env.ts. Scans the object
 * literal between `z.object({` and its closing `});`, taking every
 * `  KEY: <declaration>` line (env.ts declarations are single-line by
 * convention). Returns [{ key, declaration }] in file order.
 */
export function extractEnvSchemaKeys(source) {
  const start = source.indexOf('z.object({');
  if (start < 0) return [];
  const body = source.slice(start);
  const out = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\}\);/.test(line)) break;
    const m = line.match(/^ {2}([A-Z][A-Z0-9_]*):\s*(.+?),?\s*$/);
    if (m) out.push({ key: m[1], declaration: m[2] });
  }
  return out;
}

/**
 * Does a zod declaration line carry a WORKING DEFAULT (item 49's "new env
 * vars always ship with working defaults")? `.optional()`, `.default(...)`
 * and the repo's optionalNonPlaceholder() helper all count.
 */
export function hasWorkingDefault(declaration) {
  return /\.optional\(\)|\.default\(|optionalNonPlaceholder\(\)/.test(declaration);
}

/** Uncommented `VAR=` names from .env.reference, in file order. */
export function extractEnvReferenceVars(source) {
  const out = [];
  for (const line of source.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * CLI flags a lifecycle script parses. Heuristic, but anchored to the
 * repo's actual flag-parsing idioms so AWS-CLI argument literals (e.g.
 * '--repository-name' inside capture('aws', ...)) are NEVER counted:
 *
 *   - argv.includes('--flag') / args.includes('-y')
 *   - .startsWith('--flag=')            (deploy.ts --env=, --tier=)
 *   - a === '--flag'                    (setup-answers.ts --answers)
 *   - flagValue(argv, 'name')           (rollback.ts --name=value flags)
 *   - resolveEnvFlag(...) call          → implies --env
 *   - resolveAnswersFlag(...) call      → implies --answers
 *
 * Returns sorted unique flag spellings ('--env', '-y', ...).
 */
export function extractCliFlags(source) {
  const flags = new Set();
  for (const m of source.matchAll(/\b(?:argv|args)\.includes\(\s*'(-{1,2}[A-Za-z][\w-]*)'\s*\)/g)) {
    flags.add(m[1]);
  }
  for (const m of source.matchAll(/\.startsWith\(\s*'(--[A-Za-z][\w-]*)=?'\s*\)/g)) {
    flags.add(m[1]);
  }
  for (const m of source.matchAll(/===\s*'(--[A-Za-z][\w-]*)'/g)) {
    flags.add(m[1]);
  }
  for (const m of source.matchAll(/\bflagValue\(\s*(?:argv|args),\s*'([\w-]+)'\s*\)/g)) {
    flags.add(`--${m[1]}`);
  }
  if (/\bresolveEnvFlag\(/.test(source)) flags.add('--env');
  if (/\bresolveAnswersFlag\(/.test(source)) flags.add('--answers');
  return [...flags].sort();
}

/**
 * `category/key` ids from scripts/lib/seed-defaults.ts SEED_DEFAULTS rows.
 * Matches the literal `category: '...'` newline `key: '...'` shape the
 * file uses for every row.
 */
export function extractRuntimeConfigKeys(source) {
  const out = [];
  for (const m of source.matchAll(/category:\s*'([^']+)',\s*\r?\n\s*key:\s*'([^']+)'/g)) {
    out.push(`${m[1]}/${m[2]}`);
  }
  return out;
}

/**
 * Top-level keys of the flat agent.yaml format (the runtime parser is a
 * line scanner — see src/lib/config/agent-loader.ts — so top-level
 * `key: value` lines ARE the whole schema).
 */
export function extractAgentYamlKeys(source) {
  const out = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_]*):/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * `<NAME>_SCHEMA_VERSION = <n>` constants from a module's source. Used to
 * report the updater-critical format versions (deploy manifest, app
 * schema, and — once the parallel release-pipeline work lands — release
 * metadata / artifact manifest / key rotation).
 */
export function extractSchemaVersionConstants(source) {
  const out = [];
  for (const m of source.matchAll(/export const ([A-Z][A-Z0-9_]*_SCHEMA_VERSION)\s*=\s*(\d+)/g)) {
    out.push({ name: m[1], value: Number(m[2]) });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Diff + deprecation-metadata validation
// ─────────────────────────────────────────────────────────────────────

/** Set diff over id arrays. */
export function diffIds(prevIds, currIds) {
  const prev = new Set(prevIds);
  const curr = new Set(currIds);
  return {
    added: [...curr].filter((id) => !prev.has(id)).sort(),
    removed: [...prev].filter((id) => !curr.has(id)).sort(),
  };
}

/** Loose semver-ish parse of 'v1.2.3' / '1.2.3' / '0.0.1'. Null when unparseable. */
export function parseTag(tag) {
  const m = String(tag ?? '').match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a < b for parseable tags; null when either side is unparseable. */
export function tagLessThan(a, b) {
  const pa = parseTag(a);
  const pb = parseTag(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return false;
}

/** Minimal structural validation of docs/deprecations.json. Throws on garbage. */
export function parseDeprecations(json) {
  const raw = JSON.parse(json);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('deprecations.json must be a JSON object');
  }
  if (raw.schemaVersion !== DEPRECATIONS_SCHEMA_VERSION) {
    throw new Error(
      `deprecations.json schemaVersion ${String(raw.schemaVersion)} is not supported ` +
        `(expected ${DEPRECATIONS_SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(raw.elements)) {
    throw new Error('deprecations.json must carry an "elements" array');
  }
  for (const el of raw.elements) {
    if (!SURFACES.includes(el.surface)) {
      throw new Error(`deprecations.json element has unknown surface "${String(el.surface)}"`);
    }
    if (typeof el.id !== 'string' || el.id.length === 0) {
      throw new Error('deprecations.json element is missing "id"');
    }
    if (typeof el.introduced !== 'string' || el.introduced.length === 0) {
      throw new Error(`deprecations.json element ${el.surface}:${el.id} is missing "introduced"`);
    }
  }
  return raw;
}

function findElement(registry, surface, id) {
  return registry.elements.find((e) => e.surface === surface && e.id === id);
}

/**
 * The item-49 release gate, as a pure function.
 *
 * Input:
 *   surfaces      { [surfaceName]: { prev: string[], curr: string[] } }
 *   registry      parsed deprecations.json
 *   upgradingText docs/UPGRADING.md contents
 *   envSource     CURRENT src/config/env.ts source (working-default check)
 *
 * Rules enforced (all hard FAILs, collected — never first-failure-only):
 *   1. Every REMOVAL needs deprecation metadata: a registry entry whose
 *      `deprecated` tag is set, whose `removed` tag is set for this
 *      removal, with deprecated ≠ removed (warn-then-remove) and
 *      deprecated < removed where both tags parse.
 *   2. Every removal needs UPGRADING coverage: docs/UPGRADING.md must
 *      name the element id verbatim.
 *   3. FULL support window, not just N-1: every registry element with
 *      `removed` set (whether or not this diff sees it) must carry a
 *      distinct earlier `deprecated` tag — a removal that skipped its
 *      deprecation release fails even when the candidate-vs-previous diff
 *      cannot see it.
 *   4. A `removed` element still PRESENT in the current tree fails (the
 *      registry is lying about the surface).
 *   5. New env vars must have working defaults unless the registry entry
 *      notes flag them `security-boundary` (fail-closed is allowed only
 *      for security boundaries).
 */
export function validateContract({ surfaces, registry, upgradingText, envSource }) {
  const violations = [];
  const warnings = [];
  const upgrading = upgradingText ?? '';

  for (const [surface, { prev, curr }] of Object.entries(surfaces)) {
    const { added, removed } = diffIds(prev, curr);

    for (const id of removed) {
      const el = findElement(registry, surface, id);
      if (!el || !el.deprecated) {
        violations.push(
          `${surface}:${id} was removed without deprecation metadata — add a ` +
            `docs/deprecations.json entry with a "deprecated" tag at least one release ` +
            `before the "removed" tag (warn-then-remove, never surprise-remove)`,
        );
      } else {
        if (!el.removed) {
          violations.push(
            `${surface}:${id} is removed in this tree but its registry entry has no ` +
              `"removed" tag — stamp the removal release in docs/deprecations.json`,
          );
        } else if (el.deprecated === el.removed) {
          violations.push(
            `${surface}:${id} has deprecated == removed (${el.removed}) — the element never ` +
              `shipped a working deprecation release; warn-then-remove requires at least one`,
          );
        } else {
          const lt = tagLessThan(el.deprecated, el.removed);
          if (lt === false) {
            violations.push(
              `${surface}:${id} deprecation tag ${el.deprecated} does not predate its ` +
                `removal tag ${el.removed}`,
            );
          } else if (lt === null) {
            warnings.push(
              `${surface}:${id} deprecated/removed tags (${el.deprecated}/${el.removed}) are ` +
                `not semver-parseable; ordering not verified`,
            );
          }
        }
      }
      if (!upgrading.includes(id)) {
        violations.push(
          `${surface}:${id} was removed but docs/UPGRADING.md never names it — every removal ` +
            `needs an UPGRADING section naming the element`,
        );
      }
    }

    if (surface === 'env' && envSource) {
      const decls = new Map(extractEnvSchemaKeys(envSource).map((e) => [e.key, e.declaration]));
      for (const id of added) {
        const decl = decls.get(id);
        if (decl !== undefined && !hasWorkingDefault(decl)) {
          const el = findElement(registry, surface, id);
          const securityBoundary = el?.notes?.includes('security-boundary');
          if (!securityBoundary) {
            violations.push(
              `env:${id} is NEW and required (no .optional()/.default()) — new env vars must ` +
                `ship with working defaults, or be flagged "security-boundary" in the notes of ` +
                `their docs/deprecations.json entry`,
            );
          }
        }
      }
    }
  }

  // Full-window walk (rules 3 + 4): independent of what this diff sees.
  const currentBySurface = Object.fromEntries(
    Object.entries(surfaces).map(([s, v]) => [s, new Set(v.curr)]),
  );
  for (const el of registry.elements) {
    if (!el.removed) continue;
    if (!el.deprecated) {
      violations.push(
        `${el.surface}:${el.id} has "removed: ${el.removed}" with NO "deprecated" tag — the ` +
          `full support window requires a warn release before every removal`,
      );
    } else if (el.deprecated === el.removed) {
      violations.push(
        `${el.surface}:${el.id} has deprecated == removed (${el.removed}) — never shipped a ` +
          `working deprecation release`,
      );
    }
    const curr = currentBySurface[el.surface];
    if (curr && curr.has(el.id)) {
      violations.push(
        `${el.surface}:${el.id} is marked removed (${el.removed}) but is still present in the ` +
          `current tree — fix the registry or finish the removal`,
      );
    }
  }

  return { violations, warnings };
}

/**
 * The sync-deprecations drift gate (pure part): every CURRENT env +
 * runtime-config element must have an ACTIVE registry entry (present, not
 * marked removed), and no entry marked removed may still be present.
 */
export function syncCheck({ envSource, seedSource, registry }) {
  const current = {
    env: extractEnvSchemaKeys(envSource).map((e) => e.key),
    'runtime-config-key': extractRuntimeConfigKeys(seedSource),
  };
  const missing = [];
  const stale = [];
  for (const [surface, ids] of Object.entries(current)) {
    for (const id of ids) {
      const el = findElement(registry, surface, id);
      if (!el) missing.push({ surface, id });
      else if (el.removed) stale.push({ surface, id, removed: el.removed });
    }
  }
  return { missing, stale, current };
}
