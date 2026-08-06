/**
 * Deterministic naming + ownership tags for onboarding/bootstrap primitives
 * (onboarding plan, spine).
 *
 * Two jobs:
 *
 *  1. Reuse the EXISTING state-primitive naming. The state bucket, lock table,
 *     and ECR repo names already have one source of truth in
 *     scripts/lib/lifecycle/bootstrap-state.ts (resolveStateNames); this module
 *     re-exports it rather than reinventing a parallel naming scheme that could
 *     drift and orphan resources.
 *
 *  2. Own the CDK bootstrap qualifier and ownership tags. Onboarding bootstraps
 *     CDK under OUR OWN qualifier (derived deterministically from account+region)
 *     and OUR OWN toolkit stack name, NEVER the CDK default 'hnb659fds' /
 *     'CDKToolkit'. That makes a foreign or pre-existing default CDKToolkit
 *     detectable (isForeignToolkit) so onboarding refuses to ride someone else's
 *     bootstrap, and lets the destroy sweep recognize exactly what WE created via
 *     the install-id tag.
 *
 * Import-safe: no top-level side effects. Functions are pure (the qualifier is a
 * sha256, not random) so the same account+region always yields the same names.
 */

import { createHash } from 'node:crypto';
import { TAGS } from '../../../infra/lib/constants.js';
import {
  resolveStateNames,
  type StateNames,
} from '../lifecycle/bootstrap-state.js';

// Re-export the canonical state-name resolver so onboarding callers import the
// single source of truth instead of duplicating the bucket/table/repo shapes.
export { resolveStateNames };
export type { StateNames };

// ─────────────────────────────────────────────────────────────────────
// Ownership tags
// ─────────────────────────────────────────────────────────────────────

/**
 * The tag key whose VALUE is the per-install run id. The tripwire and destroy
 * sweeps match on this exact key to recognize resources THIS install created,
 * so they never touch a resource they did not own.
 */
export const OWNER_TAG_KEY = 'claudeclaw:install-id';

/** The tag key that marks a resource as onboarding-provisioned (vs steady-state). */
export const ONBOARDING_TAG_KEY = 'claudeclaw:onboarding';

/**
 * Build the ownership tag set for a resource created by this install. Merges
 * the existing project TAGS (Application / ManagedBy) with the onboarding
 * marker and the per-install run id, so destroy/tripwire can find exactly what
 * this run provisioned.
 */
export function onboardingTags(runId: string): Record<string, string> {
  if (!runId) throw new Error('onboardingTags: runId is required (it becomes the install-id tag)');
  return {
    ...TAGS,
    [ONBOARDING_TAG_KEY]: 'true',
    [OWNER_TAG_KEY]: runId,
  };
}

// ─────────────────────────────────────────────────────────────────────
// CDK bootstrap qualifier + toolkit stack
// ─────────────────────────────────────────────────────────────────────

/** The CDK default qualifier we must NEVER reuse, so a foreign default toolkit
 * cannot be mistaken for ours. */
export const CDK_DEFAULT_QUALIFIER = 'hnb659fds';

/** The CDK default toolkit stack name. Ours is deliberately different. */
export const CDK_DEFAULT_TOOLKIT_STACK = 'CDKToolkit';

/**
 * A stable 9-char lowercase qualifier derived from sha256(account + ':' +
 * region). Deterministic (no randomness) so the same account+region always
 * bootstraps under the same qualifier, and distinct from the CDK default so a
 * pre-existing default CDKToolkit is treated as foreign. CDK qualifiers must be
 * 1..10 chars of [a-z0-9]; a 9-char hex slice satisfies that with margin.
 */
export function bootstrapQualifier(account: string, region: string): string {
  if (!account || !region) {
    throw new Error('bootstrapQualifier requires both account and region');
  }
  const hex = createHash('sha256')
    .update(`${account}:${region}`)
    .digest('hex')
    .toLowerCase();
  const qualifier = hex.slice(0, 9);
  // Defensive: a 9-char hex slice can never equal the 9-char default, but the
  // guard makes the invariant explicit and survives any future length change.
  if (qualifier === CDK_DEFAULT_QUALIFIER) {
    return hex.slice(1, 10);
  }
  return qualifier;
}

/**
 * The bootstrap/toolkit stack name onboarding deploys, deliberately NOT
 * 'CDKToolkit'. Keeping it under our own name means our bootstrap never
 * adopts, mutates, or is confused with a default CDK toolkit that some other
 * team may have created in a shared account.
 */
export function toolkitStackName(): string {
  return 'ClaudeClawToolkit';
}

/**
 * True when `stackName` is the CDK DEFAULT toolkit (or anything that is not our
 * own toolkit stack name). Onboarding uses this to refuse riding a foreign /
 * default CDKToolkit: we only ever trust the stack WE name.
 */
export function isForeignToolkit(stackName: string): boolean {
  return stackName !== toolkitStackName();
}
