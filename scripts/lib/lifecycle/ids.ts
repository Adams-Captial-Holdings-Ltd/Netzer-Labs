/**
 * Deploy identity (IaC readiness plan, item 10).
 *
 * Every deploy gets a unique `deployId`. The git sha alone is NOT unique,
 * because the same commit can deploy twice (re-runs, rollbacks, re-promotes),
 * and reusing a Secrets Manager staging label silently moves it off the old
 * version. So the id combines a UTC timestamp, the short sha, and a random
 * suffix. The deployId doubles as the per-deploy Secrets Manager staging
 * label: labels are what make recorded secret versions durable (unlabeled
 * versions are deprecated and garbage-collected), and staging labels allow
 * up to 256 chars, so the full deployId is used as the label verbatim.
 */

import { randomBytes } from 'node:crypto';

/** Shape of a deploy id: CCE-<yyyymmddHHMMSS UTC>-<12-char short sha>-<4 hex rand>. */
export const DEPLOY_ID_RE = /^CCE-\d{14}-[0-9a-f]{12}-[0-9a-f]{4}$/;

const GIT_SHA_RE = /^[0-9a-f]{12,40}$/i;

/**
 * Mint a fresh deploy id. `now` is injectable for tests; production callers
 * omit it.
 */
export function newDeployId(gitSha: string, now: Date = new Date()): string {
  if (!GIT_SHA_RE.test(gitSha)) {
    throw new Error(
      `newDeployId: "${gitSha}" is not a git sha (need 12-40 hex chars); ` +
        'pass the full commit sha from `git rev-parse HEAD`',
    );
  }
  // toISOString is always UTC: 2026-06-11T12:34:56.789Z -> 20260611123456
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const shortSha = gitSha.slice(0, 12).toLowerCase();
  const rand = randomBytes(2).toString('hex');
  return `CCE-${ts}-${shortSha}-${rand}`;
}

/**
 * The Secrets Manager staging label for a deploy. Labels may be up to 256
 * chars, so the full deployId is the label; per-deploy labels are what keep
 * recorded secret versions durable for rollback (plan item 10).
 */
export function deployLabel(deployId: string): string {
  if (!DEPLOY_ID_RE.test(deployId)) {
    throw new Error(
      `deployLabel: "${deployId}" is not a valid deploy id (expected ${String(DEPLOY_ID_RE)})`,
    );
  }
  return deployId;
}
