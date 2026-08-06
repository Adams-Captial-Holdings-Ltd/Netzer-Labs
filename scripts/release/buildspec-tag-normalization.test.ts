/**
 * Item 47: the buildspec's deploy-tag NORMALIZATION proven as real shell.
 *
 * The deploy tag is an authorization trigger only; the buildspec derives
 * the upstream RELEASE_TAG from it by stripping the deploy-tag pattern's
 * NAMESPACE PREFIX — the literal prefix up to and including its LAST '/',
 * or the whole literal prefix when it contains no '/' — plus the literal
 * suffix. Each case below runs the EXACT logic from buildspec.yml through
 * `sh -c` (POSIX sh, the dialect CodeBuild runs), and a sync guard
 * asserts the load-bearing lines still exist in buildspec.yml verbatim.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The normalization snippet, kept byte-identical (modulo the YAML
 * indentation) to the buildspec block — the sync test below enforces it.
 */
const NORMALIZE = `
TAG_NAME="\${CODEBUILD_WEBHOOK_TRIGGER#tag/}"
PATTERN_PREFIX="\${DEPLOY_TAG_PATTERN%%\\**}"
PATTERN_SUFFIX="\${DEPLOY_TAG_PATTERN#*\\*}"
case "$PATTERN_PREFIX" in
  */*) NAMESPACE_PREFIX="\${PATTERN_PREFIX%/*}/" ;;
  *)   NAMESPACE_PREFIX="$PATTERN_PREFIX" ;;
esac
UPSTREAM_TAG="\${TAG_NAME#"$NAMESPACE_PREFIX"}"
if [ -n "$PATTERN_SUFFIX" ]; then
  UPSTREAM_TAG="\${UPSTREAM_TAG%"$PATTERN_SUFFIX"}"
fi
printf '%s' "$UPSTREAM_TAG"
`;

function normalize(pattern: string, webhookTrigger: string): string {
  return execFileSync('sh', ['-c', NORMALIZE], {
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      DEPLOY_TAG_PATTERN: pattern,
      CODEBUILD_WEBHOOK_TRIGGER: webhookTrigger,
    },
  });
}

describe('deploy-tag normalization (sh -c, the buildspec logic)', () => {
  it('default pattern: deploy/v1.2.3 -> v1.2.3', () => {
    expect(normalize('deploy/v*', 'tag/deploy/v1.2.3')).toBe('v1.2.3');
  });

  it('custom pattern release/cce-*: release/cce-1.2.3 -> cce-1.2.3', () => {
    expect(normalize('release/cce-*', 'tag/release/cce-1.2.3')).toBe('cce-1.2.3');
  });

  it('deep namespace: strips up to the LAST slash only', () => {
    expect(normalize('team/deploy/v*', 'tag/team/deploy/v2.0.0')).toBe('v2.0.0');
  });

  it('no-slash pattern: the whole literal prefix is stripped (documented fallback)', () => {
    // With ship-*, the star-content must itself BE the upstream tag.
    expect(normalize('ship-*', 'tag/ship-1.2.3')).toBe('1.2.3');
  });

  it('strips a literal suffix when the pattern carries one', () => {
    expect(normalize('deploy/v*-prod', 'tag/deploy/v1.2.3-prod')).toBe('v1.2.3');
  });

  it('pre-release upstream tags survive normalization', () => {
    expect(normalize('deploy/v*', 'tag/deploy/v2.0.0-rc1')).toBe('v2.0.0-rc1');
  });
});

describe('buildspec.yml stays in sync with the tested snippet', () => {
  const buildspec = readFileSync(join(repoRoot, 'buildspec.yml'), 'utf-8');

  it.each([
    'TAG_NAME="${CODEBUILD_WEBHOOK_TRIGGER#tag/}"',
    'PATTERN_PREFIX="${DEPLOY_TAG_PATTERN%%\\**}"',
    'PATTERN_SUFFIX="${DEPLOY_TAG_PATTERN#*\\*}"',
    'NAMESPACE_PREFIX="${PATTERN_PREFIX%/*}/"',
    'UPSTREAM_TAG="${TAG_NAME#"$NAMESPACE_PREFIX"}"',
    'UPSTREAM_TAG="${UPSTREAM_TAG%"$PATTERN_SUFFIX"}"',
    'export RELEASE_TAG="$UPSTREAM_TAG"',
  ])('contains %s', (line) => {
    expect(buildspec).toContain(line);
  });

  it('documents the identity rule at the normalization site', () => {
    expect(buildspec).toContain('AUTHORIZATION TRIGGER ONLY');
  });

  it('keeps the dogfood path double-guarded (shim existence + CCE_UPDATE_PIPELINE=1)', () => {
    expect(buildspec).toContain('if [ -f scripts/update/shim.ts ] && [ "${CCE_UPDATE_PIPELINE:-}" = "1" ]');
    expect(buildspec).toContain('manifests/latest.json');
    expect(buildspec).toContain('jq -r .gitSha');
  });
});
