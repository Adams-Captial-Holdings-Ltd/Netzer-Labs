/**
 * Update DISCOVERY (IaC readiness plan, item 46).
 *
 * Backend-side check of the public GitHub releases feed so "is there a new
 * version?" never requires watching GitHub. Three hard properties:
 *
 *  1. FAIL-SILENT BY DESIGN. Any error (network, rate limit, malformed
 *     response) returns the cached or an empty result, never throws past
 *     this module, and backs off exponentially in memory. Nothing in
 *     /health, /ready, or `npm run verify` may ever degrade because
 *     GitHub is unreachable — discovery is a banner, not a dependency.
 *  2. VERIFY-BEFORE-DISPLAY. The required-actions count and links must
 *     come from the SIGNED release metadata (plan item 44), verified
 *     against pinned trust roots, before any renderer shows them. Until
 *     real trust roots + signed metadata exist, the default verifier
 *     returns verified:false and the result carries reason:'unverified';
 *     renderers degrade to "update check unavailable/unverified" rather
 *     than displaying unverified claims. The future verifier rides the
 *     pinned trust roots in scripts/update/trust-roots.ts (item 42's
 *     updater shim) — inject it through `verifier` when it lands.
 *  3. OPT-OUT. CCE_UPDATE_CHECK_DISABLED=1 short-circuits with zero
 *     network calls (see the privacy note on the env schema): no payload
 *     telemetry is ever sent, but the request itself necessarily reveals
 *     the install's egress IP and timing to GitHub, so air-gapped/strict
 *     installs opt out and lose nothing but the banner.
 *
 * Discovery is READ-ONLY; nothing here auto-updates anything.
 */

import { createRequire } from 'node:module';

// ─────────────────────────────────────────────────────────────────────
// Release-metadata shape
// ─────────────────────────────────────────────────────────────────────

export interface ReleaseRequiredAction {
  id: string;
  /** automatic | manual-preflight | approval-required (plan item 44). */
  classification: string;
  description: string;
}

/**
 * TODO(release-metadata): scripts/lib/release/metadata.ts is the canonical
 * home of this shape (its ReleaseMetadata is a superset of this). Converge
 * on it — import the type instead of redeclaring — once the src/scripts
 * layering question is settled (the orchestrator should not pull operator
 * tooling into its runtime graph just for a type). The fields here match
 * the minimal contract: { schemaVersion, tag, requiredActions:
 * [{id, classification, description}], upgradingUrl }.
 */
export interface ReleaseMetadataLike {
  schemaVersion: number;
  tag: string;
  requiredActions: ReleaseRequiredAction[];
  upgradingUrl: string;
}

// ─────────────────────────────────────────────────────────────────────
// Verifier seam
// ─────────────────────────────────────────────────────────────────────

/** The slice of a GitHub release the verifier sees. */
export interface GithubReleaseSummary {
  tagName: string;
  htmlUrl?: string;
  publishedAt?: string;
}

export interface VerificationResult {
  verified: boolean;
  /** Present only when verified: the SIGNED metadata for the release. */
  metadata?: ReleaseMetadataLike;
  reason?: string;
}

export type ReleaseVerifier = (
  release: GithubReleaseSummary,
) => Promise<VerificationResult>;

/**
 * Default verifier: ALWAYS unverified. Real trust roots + signed release
 * metadata do not exist yet (plan items 42/44); claiming verification
 * without them would be lying to the renderer. When the updater shim's
 * pinned trust roots land in scripts/update/trust-roots.ts, build a real
 * verifier on top of them and inject it here.
 */
export const unverifiedVerifier: ReleaseVerifier = async () => ({
  verified: false,
  reason: 'unverified',
});

// ─────────────────────────────────────────────────────────────────────
// Result shape
// ─────────────────────────────────────────────────────────────────────

export type UpdateCheckReason =
  | 'disabled'
  | 'unverified'
  | 'unreachable'
  | 'up-to-date';

export interface UpdateCheckResult {
  available: boolean;
  latestTag?: string;
  /** DEPLOY_SHA env when set, else the package.json version. */
  currentVersion: string;
  /**
   * Only ever present when `verified` is true: the count comes from the
   * signed release metadata, never from release-note prose or an
   * unverified API response.
   */
  requiredActionsCount?: number;
  verified: boolean;
  reason?: UpdateCheckReason;
}

// ─────────────────────────────────────────────────────────────────────
// Checker
// ─────────────────────────────────────────────────────────────────────

type EnvBag = Record<string, string | undefined>;

/** Placeholder owner/repo: DISCOVERY defaults only, never deploy authority. */
export const DEFAULT_UPSTREAM_OWNER = 'emmanuelmadams4-lgtm';
export const DEFAULT_UPSTREAM_REPO = 'test';

/** Cached daily, per the plan: "checks the public releases feed … cached daily". */
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Backoff after a failed check: 5 min, doubling, capped at the cache TTL. */
export const UPDATE_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const UPDATE_BACKOFF_MAX_MS = UPDATE_CACHE_TTL_MS;

export interface UpdateDiscoveryDeps {
  /** Injected fetch; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injected verifier; defaults to the always-unverified one. */
  verifier?: ReleaseVerifier;
  /** Injectable clock for tests. */
  now?: () => number;
  cacheTtlMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Override for tests; defaults to DEPLOY_SHA / package.json version. */
  currentVersion?: string;
}

let pkgVersion: string | null = null;

function packageVersion(): string {
  if (pkgVersion !== null) return pkgVersion;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../../package.json') as { version?: string };
    pkgVersion = pkg.version ?? '0.0.0';
  } catch {
    pkgVersion = '0.0.0';
  }
  return pkgVersion;
}

function resolveCurrentVersion(env: EnvBag, override?: string): string {
  if (override) return override;
  const sha = (env.DEPLOY_SHA ?? '').trim();
  if (sha !== '') return sha;
  return packageVersion();
}

/** 'v1.4.0' and '1.4.0' name the same release. */
function normalizeTag(tag: string): string {
  return tag.trim().replace(/^v/i, '');
}

export type UpdateChecker = (env?: EnvBag) => Promise<UpdateCheckResult>;

/**
 * Build a checker with its own in-memory cache + backoff state. Production
 * uses the module-level singleton below (one cache per process); tests
 * create isolated instances with fakes.
 */
export function createUpdateChecker(deps: UpdateDiscoveryDeps = {}): UpdateChecker {
  const fetchFn = deps.fetchFn ?? fetch;
  const verifier = deps.verifier ?? unverifiedVerifier;
  const now = deps.now ?? Date.now;
  const ttl = deps.cacheTtlMs ?? UPDATE_CACHE_TTL_MS;
  const backoffBase = deps.backoffBaseMs ?? UPDATE_BACKOFF_BASE_MS;
  const backoffMax = deps.backoffMaxMs ?? UPDATE_BACKOFF_MAX_MS;

  let cached: { result: UpdateCheckResult; at: number } | null = null;
  let failures = 0;
  let nextAttemptAt = 0;

  return async function checkForUpdates(env: EnvBag = process.env): Promise<UpdateCheckResult> {
    const currentVersion = resolveCurrentVersion(env, deps.currentVersion);

    // Opt-out: zero network calls, zero cache consultation.
    if (env.CCE_UPDATE_CHECK_DISABLED === '1') {
      return { available: false, currentVersion, verified: false, reason: 'disabled' };
    }

    const at = now();
    if (cached && at - cached.at < ttl) return cached.result;
    if (at < nextAttemptAt) {
      // Inside the backoff window: serve the stale cache if any, else the
      // honest empty result. Never an error.
      return (
        cached?.result ?? {
          available: false,
          currentVersion,
          verified: false,
          reason: 'unreachable',
        }
      );
    }

    const owner = env.CCE_UPSTREAM_OWNER?.trim() || DEFAULT_UPSTREAM_OWNER;
    const repo = env.CCE_UPSTREAM_REPO?.trim() || DEFAULT_UPSTREAM_REPO;

    try {
      const res = await fetchFn(
        `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
        {
          headers: {
            accept: 'application/vnd.github+json',
            // GitHub requires a UA; name the product, never the install.
            'user-agent': 'claudeclaw-enterprise-update-check',
          },
        },
      );
      if (!res.ok) throw new Error(`GitHub releases API returned ${res.status}`);
      const body = (await res.json()) as {
        tag_name?: string;
        html_url?: string;
        published_at?: string;
      };
      const tagName = (body.tag_name ?? '').trim();
      if (tagName === '') throw new Error('GitHub release response had no tag_name');

      const release: GithubReleaseSummary = {
        tagName,
        htmlUrl: body.html_url,
        publishedAt: body.published_at,
      };

      // Verifier failures are unverified, never errors (fail-silent).
      let verification: VerificationResult;
      try {
        verification = await verifier(release);
      } catch {
        verification = { verified: false, reason: 'unverified' };
      }

      const available = normalizeTag(tagName) !== normalizeTag(currentVersion);
      const result: UpdateCheckResult = verification.verified
        ? {
            available,
            latestTag: tagName,
            currentVersion,
            requiredActionsCount: verification.metadata?.requiredActions.length ?? 0,
            verified: true,
            ...(available ? {} : { reason: 'up-to-date' as const }),
          }
        : {
            // VERIFY-BEFORE-DISPLAY: no requiredActionsCount and an explicit
            // 'unverified' reason — renderers must degrade, not display.
            available,
            latestTag: tagName,
            currentVersion,
            verified: false,
            reason: 'unverified',
          };

      cached = { result, at };
      failures = 0;
      nextAttemptAt = 0;
      return result;
    } catch {
      // FAIL-SILENT: exponential in-memory backoff, cached/empty result.
      failures += 1;
      nextAttemptAt = at + Math.min(backoffBase * 2 ** (failures - 1), backoffMax);
      return (
        cached?.result ?? {
          available: false,
          currentVersion,
          verified: false,
          reason: 'unreachable',
        }
      );
    }
  };
}

/**
 * Process-wide checker: one 24h cache shared by the dashboard route and
 * any other in-process caller.
 */
export const checkForUpdates: UpdateChecker = createUpdateChecker();
