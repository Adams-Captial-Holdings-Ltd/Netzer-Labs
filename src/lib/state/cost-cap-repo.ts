/**
 * Daily cost cap — the effective USD cap for Bedrock spend in a day.
 *
 * The cap is an overlay: an operator can set a runtime value in the
 * 'claudeclaw-runtime-config' table (category 'cost', key 'daily_cap_usd')
 * that any task picks up within the runtime-config 30s cache TTL. When no
 * runtime value is set we fall back to the env/tier default
 * CCE_DAILY_COST_CAP_USD (and a hard-coded 50 if even that is unset).
 *
 * getEffectiveCostCap() is fail-open by construction: runtime-config-repo
 * returns undefined on a DDB blip, so we transparently fall back to the env
 * default rather than bricking the cost-cap gate.
 */

import { getConfig, setConfig } from './runtime-config-repo.js';
import { isKillSwitchActive } from './kill-switches-repo.js';

const CONFIG_CATEGORY = 'cost';
const CONFIG_KEY = 'daily_cap_usd';
const ENABLED_KEY = 'cap_enabled';
const DEFAULT_CAP_USD = 50;

/**
 * Whether the daily Bedrock cost cap is enforced. This is a second, seedable,
 * dashboard-visible enable path alongside the `cost_cap_per_day` kill switch
 * (which is NOT seeded, so a fresh install historically had no cap at all). The
 * agent loop enforces the cap when EITHER this flag is 'true' OR the kill switch
 * is active. Absent/anything-else means off, matching the repo's other cost/*
 * toggles (watch_enabled, remediation_enabled), so seeding it 'false' is
 * behavior-neutral; flip it to 'true' (one runtime-config write, no redeploy) to
 * turn the cap on by default. Fail-open on a DDB blip — returns false — so a
 * transient read error can never brick all turns; the kill-switch path remains
 * available as the hard stop.
 */
export async function isCostCapEnabled(): Promise<boolean> {
  try {
    return (await getConfig(CONFIG_CATEGORY, ENABLED_KEY)) === 'true';
  } catch {
    return false;
  }
}

/**
 * Whether the daily Bedrock cost cap should be enforced right now: the
 * cost_cap_per_day kill switch is active OR the seedable cost/cap_enabled flag
 * is on. EVERY Bedrock spend path (agent turns, Jarvis text, image/doc tool
 * re-checks) gates on this single helper, so flipping cap_enabled enforces the
 * cap everywhere rather than only on the main agent loop. Both inputs fail open
 * (a DDB blip reads as "not enforced") so a transient error can't brick spend;
 * the bedrock_global switch remains the hard stop.
 */
export async function isCostCapEnforced(): Promise<boolean> {
  const [killed, flag] = await Promise.all([
    isKillSwitchActive('cost_cap_per_day').catch(() => ({ active: false })),
    isCostCapEnabled(),
  ]);
  return killed.active || flag;
}

/** Env/tier default cap. Hard-coded fallback when the env var is unset or junk. */
function envDefaultCap(): number {
  const raw = Number(process.env.CCE_DAILY_COST_CAP_USD ?? String(DEFAULT_CAP_USD));
  return Number.isFinite(raw) ? raw : DEFAULT_CAP_USD;
}

/** Where the effective cap resolved from. */
export type CostCapSource = 'runtime-config' | 'env-default';

/**
 * Effective daily cost cap AND where it came from, resolved in ONE place so the
 * enforced value and its reported source can never diverge. Prefers the
 * runtime-config override; falls back to the env/tier default. A non-numeric,
 * empty, or non-positive override is ignored (see the guard note below) and the
 * source is then reported as 'env-default' — NOT 'runtime-config' — even though
 * a row physically exists, because that row is not what is being enforced.
 */
export async function resolveEffectiveCostCap(): Promise<{ capUsd: number; source: CostCapSource }> {
  const override = await getConfig(CONFIG_CATEGORY, CONFIG_KEY);
  if (override !== undefined && override.trim() !== '') {
    const parsed = Number(override);
    // A non-numeric or non-positive override is ignored in favor of the env
    // default. Without the trim()/> 0 guard an empty string would slip through
    // (Number('') === 0, which is finite), silently pinning the cap to 0 and
    // bricking all spend the moment the cost_cap_per_day switch is on. The SET
    // path (POST /api/cost-cap) rejects <= 0 for the SAME reason, so the two
    // ends agree: a stored value is honored iff it is > 0. A bad write can never
    // disable the cap; use the bedrock_global switch to stop spend intentionally.
    if (Number.isFinite(parsed) && parsed > 0) return { capUsd: parsed, source: 'runtime-config' };
  }
  return { capUsd: envDefaultCap(), source: 'env-default' };
}

/**
 * Effective daily cost cap in USD. Thin wrapper over resolveEffectiveCostCap()
 * for the many spend gates that only need the number, not the source.
 */
export async function getEffectiveCostCap(): Promise<number> {
  return (await resolveEffectiveCostCap()).capUsd;
}

/**
 * Persist a new daily cost cap. Writes through runtime-config-repo, which
 * invalidates the writer's local cache so the new cap is visible immediately
 * to this task and propagates to other tasks within the 30s cache TTL.
 */
export async function setDailyCostCap(
  usd: number,
  opts: { updatedBy: string },
): Promise<void> {
  // setConfig already publishes a 'runtime_config' invalidation, which clears
  // the whole runtime-config cache on peers (the cost cap lives in it). No
  // separate 'cost_cap' publish is needed; a second message would be pure
  // overhead doing a strict subset of the same work.
  await setConfig(CONFIG_CATEGORY, CONFIG_KEY, String(usd), { updatedBy: opts.updatedBy });
}
