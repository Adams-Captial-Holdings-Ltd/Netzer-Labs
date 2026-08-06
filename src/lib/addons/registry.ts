/**
 * Add-on registry — single source of truth for which capabilities the
 * orchestrator actually has wired up.
 *
 * Every optional tool registers itself here at module-load time with:
 *   - id          (stable identifier; matches the kill-switch name when applicable)
 *   - title       (human-readable)
 *   - required    (env vars or AWS conditions that must be met)
 *   - enabled     (computed lazily — checks env at read time)
 *   - killSwitch  (matching kill-switch name, if any)
 *
 * The /api/addons endpoint reads this registry. The setup wizard's
 * Q7-Q12 prompts use this list to decide which keys to ask for. The
 * tools themselves use the registry to gate their own registration.
 */

import { logger } from '../../observability/logger.js';

export interface AddonRequirement {
  /** Env var that must be set (non-empty, non-REPLACE_ME). */
  envVar?: string;
  /** Human description if the requirement isn't an env var (e.g. "Bedrock IAM"). */
  description?: string;
}

export interface AddonRecord {
  id: string;
  title: string;
  category: 'tool' | 'output' | 'integration' | 'security' | 'infra';
  /** Short marketing one-liner. */
  description: string;
  /** What must be true for this add-on to function. ALL must be satisfied. */
  required: AddonRequirement[];
  /** OR-style: configured if ANY of these env vars is set. Used by
   * umbrella add-ons (e.g. web_search where multiple vendor keys
   * each independently enable the capability). */
  envVarAnyOf?: string[];
  /** Matching kill-switch name (if any). */
  killSwitch?: string;
  /** Default-on if requirements met (vs explicit opt-in). */
  defaultOn: boolean;
}

const addons = new Map<string, AddonRecord>();

export function registerAddon(addon: AddonRecord): void {
  addons.set(addon.id, addon);
}

export function listAddons(): AddonRecord[] {
  return Array.from(addons.values());
}

/** Check whether an add-on's required env vars are satisfied.
 *
 * Some add-ons declare "any of N" via a custom satisfier — we wrap that
 * via the envVarAnyOf array set in the description field. For simple
 * single-env-var add-ons, all required env vars must be set.
 */
export function addonConfigured(id: string): boolean {
  const a = addons.get(id);
  if (!a) return false;
  // If every requirement is description-only (no envVar), treat as
  // requiring an explicit override via `envVarAnyOf` below.
  const requirementsWithVar = a.required.filter((r) => r.envVar);
  if (requirementsWithVar.length === 0) {
    // Use the anyOf list if present (for web_search etc.).
    if (a.envVarAnyOf && a.envVarAnyOf.length > 0) {
      return a.envVarAnyOf.some((envVar) => {
        const v = process.env[envVar];
        return Boolean(v) && v !== 'REPLACE_ME';
      });
    }
    return false;
  }
  return requirementsWithVar.every((req) => {
    const v = process.env[req.envVar!];
    return Boolean(v) && v !== 'REPLACE_ME';
  });
}

/**
 * Helper: register an add-on, then either run the tool's register fn
 * or log a one-line skip. Keeps every tool module short and consistent.
 */
export function registerIfConfigured(
  addon: AddonRecord,
  register: () => void,
): void {
  registerAddon(addon);
  if (addonConfigured(addon.id)) {
    register();
    logger.info(
      { addon: addon.id, title: addon.title },
      'add-on registered',
    );
  } else {
    logger.info(
      { addon: addon.id, missing: addon.required.map((r) => r.envVar).filter(Boolean) },
      'add-on skipped (requirements not met)',
    );
  }
}
