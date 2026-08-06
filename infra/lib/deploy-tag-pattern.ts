/**
 * Deploy-tag namespace split, ONE source of truth (IaC readiness item 39).
 *
 * Upstream releases live in the `v*` tag namespace (v1.2.3, v2.0.0-rc1).
 * Customer deploy triggers live in a SEPARATE namespace, default `deploy/v*`,
 * configurable via CCE_DEPLOY_TAG_PATTERN. The two must never collide, an
 * upstream release tag landing in a fork must NOT ship to the fork owner's
 * AWS account.
 *
 * Everything that enforces the split derives from this module's single
 * normalized pattern:
 *   - the CodeBuild webhook filter (anchored HEAD_REF regex,
 *     `webhookHeadRefPattern`), wired in codebuild-stack.ts;
 *   - the buildspec runtime refusal (POSIX shell case pattern,
 *     `buildspecGuardPattern`), consumed by buildspec.yml via the
 *     CCE_DEPLOY_TAG_PATTERN project env var that codebuild-stack.ts
 *     injects with the NORMALIZED value;
 *   - GitHub repository rulesets (operators target the same raw pattern,
 *     see docs/github-to-aws.md).
 *
 * Pattern grammar is deliberately tiny so the shell-glob form and the regex
 * form are provably equivalent: exactly one `*`, and every other character
 * restricted to [A-Za-z0-9._/-]. Within that charset, glob `*` <=> regex
 * `.*` and every literal char means the same thing in both dialects (`.` is
 * the only regex metachar admitted, and it is escaped below; no shell-glob
 * metachars `?` `[` `]` are admitted at all).
 */

export const DEFAULT_DEPLOY_TAG_PATTERN = 'deploy/v*';

/** Charset allowed in the literal (non-`*`) parts of the pattern. */
const LITERAL_CHARSET = /^[A-Za-z0-9._/-]*$/;

/** Regex metachars that may appear in the allowed charset (only `.` can). */
function escapeRegexLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface NormalizedDeployTagPattern {
  /** The validated raw pattern, e.g. `deploy/v*`. */
  pattern: string;
  /** Literal text before the single `*` (never empty, never `v`). */
  prefix: string;
  /** Literal text after the single `*` (usually empty). */
  suffix: string;
  /**
   * Anchored regex for CodeBuild's HEAD_REF webhook filter, e.g.
   * `^refs/tags/deploy/v.*$`. Regex metachars in the literal parts are
   * escaped. CodeBuild evaluates HEAD_REF filters as regex; the anchors
   * make "prefix" mean prefix, not substring.
   */
  webhookHeadRefPattern: string;
  /**
   * POSIX shell case pattern for the buildspec runtime refusal, e.g.
   * `tag/deploy/v*`. CODEBUILD_WEBHOOK_TRIGGER is `tag/<name>` for tag
   * pushes, so the guard is:
   *   case "$CODEBUILD_WEBHOOK_TRIGGER" in $GUARD) ok ;; *) refuse ;; esac
   * Equivalence with webhookHeadRefPattern holds because the validated
   * charset admits no glob metachars besides the one `*`.
   */
  buildspecGuardPattern: string;
  /** True when a fully-qualified git ref (e.g. `refs/tags/deploy/v1.2.3`) is a deploy trigger. */
  matchesDeployTag(ref: string): boolean;
}

/**
 * Read CCE_DEPLOY_TAG_PATTERN (default `deploy/v*`), validate it, and derive
 * every enforcement artifact from the one normalized value. Throws on any
 * pattern that is ambiguous or that overlaps the upstream `v*` release
 * namespace, an overlap would let an upstream release tag deploy to a
 * customer account.
 */
export function normalizeDeployTagPattern(
  env: Record<string, string | undefined> = process.env,
): NormalizedDeployTagPattern {
  const raw = env.CCE_DEPLOY_TAG_PATTERN?.trim();
  const pattern = raw || DEFAULT_DEPLOY_TAG_PATTERN;

  const starCount = (pattern.match(/\*/g) ?? []).length;
  if (starCount !== 1) {
    throw new Error(
      `CCE_DEPLOY_TAG_PATTERN "${pattern}" must contain exactly one "*" ` +
        `(got ${starCount}). The deploy-tag pattern is <literal-prefix>*` +
        `<literal-suffix>, e.g. "${DEFAULT_DEPLOY_TAG_PATTERN}".`,
    );
  }

  const star = pattern.indexOf('*');
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);

  if (!LITERAL_CHARSET.test(prefix) || !LITERAL_CHARSET.test(suffix)) {
    throw new Error(
      `CCE_DEPLOY_TAG_PATTERN "${pattern}" contains characters outside ` +
        '[A-Za-z0-9._/-]. The charset is restricted so the shell-glob guard ' +
        'in buildspec.yml and the regex webhook filter are provably ' +
        'equivalent (no glob metachars like "?" or "[").',
    );
  }

  if (prefix.length === 0) {
    throw new Error(
      `CCE_DEPLOY_TAG_PATTERN "${pattern}" has an empty literal prefix. ` +
        'A bare or leading "*" would match every tag, including upstream ' +
        `v* releases. Use a distinct namespace like "${DEFAULT_DEPLOY_TAG_PATTERN}".`,
    );
  }

  // Overlap guard for the upstream release namespace `v*`: any deploy-tag
  // prefix that itself starts with "v" produces tags that ALSO live inside
  // the upstream glob namespace (a tag `v-deploy-1` matches both `v*` and
  // `v-deploy-*`), so rulesets and humans could no longer tell the two
  // apart. Reject the whole class, not just the literal "v".
  if (prefix.startsWith('v')) {
    throw new Error(
      `CCE_DEPLOY_TAG_PATTERN "${pattern}" overlaps the upstream release ` +
        'namespace "v*": its literal prefix starts with "v", so every ' +
        'matching tag is also an upstream-release-shaped tag. Pick a ' +
        `prefix outside "v*", e.g. "${DEFAULT_DEPLOY_TAG_PATTERN}".`,
    );
  }

  const webhookHeadRefPattern = `^refs/tags/${escapeRegexLiteral(prefix)}.*${escapeRegexLiteral(suffix)}$`;
  const buildspecGuardPattern = `tag/${pattern}`;
  const headRefRegex = new RegExp(webhookHeadRefPattern);

  return {
    pattern,
    prefix,
    suffix,
    webhookHeadRefPattern,
    buildspecGuardPattern,
    matchesDeployTag: (ref: string) => headRefRegex.test(ref),
  };
}
