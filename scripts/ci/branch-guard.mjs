// Branch guard — the promotion ladder, enforced as far as GitHub Free allows.
//
// This repo's intended flow is development -> qa -> staging -> production.
// On a private repo without GitHub Pro, branch protection and rulesets both
// return 403, so nothing can BLOCK a bad merge or a force-push. What we can do
// is make every violation fail loudly, immediately, and on the record.
//
// This guard therefore detects rather than prevents:
//   * a pull request that skips a rung of the ladder,
//   * a commit pushed straight to a promotion branch instead of merged in,
//   * a force-push to a promotion branch.
//
// Residual risk and the reasoning behind detection-instead-of-prevention are
// recorded in docs/security-posture.md.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Each promotion branch and the single branch allowed to feed it. */
export const PROMOTION_LADDER = {
  production: 'staging',
  staging: 'qa',
  qa: 'development',
};

/**
 * Pull-request rung check.
 *
 * Branches outside the ladder (development, feature branches) accept anything —
 * feature work has to land somewhere.
 */
export function validatePromotionSource({ base, head }) {
  const expected = PROMOTION_LADDER[base];

  if (!expected) {
    return { allowed: true, reason: `${base} is not a promotion branch; any source accepted` };
  }

  if (head === expected) {
    return { allowed: true, reason: `${head} -> ${base} follows the ladder` };
  }

  return {
    allowed: false,
    reason:
      `${head} -> ${base} skips the promotion ladder. ` +
      `${base} only accepts ${expected}. ` +
      `Promote through ${ladderPathTo(base).join(' -> ')} instead.`,
  };
}

/** The full ordered path a change must travel to reach `base`. */
export function ladderPathTo(base) {
  const path = [base];
  let cursor = base;
  while (PROMOTION_LADDER[cursor]) {
    cursor = PROMOTION_LADDER[cursor];
    path.unshift(cursor);
  }
  return path;
}

/**
 * Push check.
 *
 * A healthy push to a promotion branch is a merge commit whose second parent
 * came from the rung below. A single-parent commit means someone committed or
 * cherry-picked directly onto the branch, bypassing review entirely.
 */
export function validatePush({ branch, forced, isMerge, mergedFromUpstream, isNewBranch }) {
  if (!PROMOTION_LADDER[branch]) {
    return { allowed: true, reason: `${branch} is not a promotion branch` };
  }

  if (forced) {
    return {
      allowed: false,
      reason:
        `FORCE-PUSH to ${branch}. History on a promotion branch was rewritten. ` +
        `Verify no reviewed commits were dropped, then record the incident.`,
    };
  }

  if (isNewBranch) {
    return { allowed: true, reason: `${branch} created; nothing to compare against` };
  }

  if (!isMerge) {
    return {
      allowed: false,
      reason:
        `DIRECT PUSH to ${branch}. The head commit is not a merge, so this ` +
        `bypassed the pull request and its review. Expected a merge from ` +
        `${PROMOTION_LADDER[branch]}.`,
    };
  }

  if (!mergedFromUpstream) {
    return {
      allowed: false,
      reason:
        `${branch} received a merge that did not come from ` +
        `${PROMOTION_LADDER[branch]}. The ladder was skipped.`,
    };
  }

  return { allowed: true, reason: `${branch} advanced by a merge from ${PROMOTION_LADDER[branch]}` };
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** True when `commit` is contained in origin/<upstream>. */
function upstreamContains(upstream, commit) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, `origin/${upstream}`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.env.GUARD_EVENT ?? '';
  let result;

  if (event === 'pull_request') {
    result = validatePromotionSource({
      base: process.env.GUARD_BASE ?? '',
      head: process.env.GUARD_HEAD ?? '',
    });
  } else {
    const branch = process.env.GUARD_BRANCH ?? '';
    const before = process.env.GUARD_BEFORE ?? '';
    const upstream = PROMOTION_LADDER[branch];
    const isNewBranch = !before || /^0+$/.test(before);

    let isMerge = false;
    let mergedFromUpstream = false;

    if (upstream && !isNewBranch) {
      const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/).slice(1);
      isMerge = parents.length > 1;
      // Second parent is the branch being merged in; first is the branch itself.
      mergedFromUpstream = isMerge && parents.slice(1).some((p) => upstreamContains(upstream, p));
    }

    result = validatePush({
      branch,
      forced: process.env.GUARD_FORCED === 'true',
      isMerge,
      mergedFromUpstream,
      isNewBranch,
    });
  }

  if (result.allowed) {
    console.log(`branch-guard: ${result.reason}`);
  } else {
    console.error(`branch-guard: ${result.reason}`);
    console.error('');
    console.error('This is a detection control, not a block — the change is already in.');
    console.error('See docs/security-posture.md for the remediation steps.');
  }

  process.exitCode = result.allowed ? 0 : 1;
}
