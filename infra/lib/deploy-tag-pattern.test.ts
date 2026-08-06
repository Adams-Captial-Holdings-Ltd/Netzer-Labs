import { describe, it, expect } from 'vitest';
import {
  normalizeDeployTagPattern,
  DEFAULT_DEPLOY_TAG_PATTERN,
} from './deploy-tag-pattern.js';

describe('normalizeDeployTagPattern (deploy-tag namespace split, item 39)', () => {
  it('defaults to deploy/v* when CCE_DEPLOY_TAG_PATTERN is unset or blank', () => {
    expect(normalizeDeployTagPattern({}).pattern).toBe(DEFAULT_DEPLOY_TAG_PATTERN);
    expect(
      normalizeDeployTagPattern({ CCE_DEPLOY_TAG_PATTERN: '  ' }).pattern,
    ).toBe('deploy/v*');
  });

  // The two cases item 39 demands proof of, verbatim.
  it('DEFAULT pattern: refs/tags/deploy/v1.2.3 TRIGGERS a deploy', () => {
    const p = normalizeDeployTagPattern({});
    expect(p.matchesDeployTag('refs/tags/deploy/v1.2.3')).toBe(true);
  });

  it('DEFAULT pattern: refs/tags/v1.2.3 (upstream release) does NOT trigger', () => {
    const p = normalizeDeployTagPattern({});
    expect(p.matchesDeployTag('refs/tags/v1.2.3')).toBe(false);
  });

  it('derives the anchored CodeBuild HEAD_REF regex and the shell guard', () => {
    const p = normalizeDeployTagPattern({});
    expect(p.webhookHeadRefPattern).toBe('^refs/tags/deploy/v.*$');
    expect(p.buildspecGuardPattern).toBe('tag/deploy/v*');
    expect(p.prefix).toBe('deploy/v');
    expect(p.suffix).toBe('');
  });

  it('anchoring: branch refs and look-alike refs never match', () => {
    const p = normalizeDeployTagPattern({});
    expect(p.matchesDeployTag('refs/heads/main')).toBe(false);
    expect(p.matchesDeployTag('refs/heads/deploy/v1')).toBe(false);
    // Prefix means prefix: a nested namespace must not sneak in.
    expect(p.matchesDeployTag('refs/tags/foo/deploy/v1.2.3')).toBe(false);
    // Anchored at the end too (relevant once a suffix exists).
    const q = normalizeDeployTagPattern({ CCE_DEPLOY_TAG_PATTERN: 'deploy/*-prod' });
    expect(q.matchesDeployTag('refs/tags/deploy/1.2.3-prod')).toBe(true);
    expect(q.matchesDeployTag('refs/tags/deploy/1.2.3-prod-extra')).toBe(false);
  });

  it('rejects an empty literal prefix (bare or leading *)', () => {
    expect(() =>
      normalizeDeployTagPattern({ CCE_DEPLOY_TAG_PATTERN: '*' }),
    ).toThrow(/empty literal prefix/);
    expect(() =>
      normalizeDeployTagPattern({ CCE_DEPLOY_TAG_PATTERN: '*-deploy' }),
    ).toThrow(/empty literal prefix/);
  });

  it('rejects v* and anything else overlapping the upstream release namespace', () => {
    expect(() =>
      normalizeDeployTagPattern({ CCE_DEPLOY_TAG_PATTERN: 'v*' }),
    ).toThrow(/overlaps the upstream release namespace/);
    // Any prefix starting with "v" produces tags that also match glob v*.
    expect(() =>
      normalizeDeployTagPattern({ CCE_DEPLOY_TAG_PATTERN: 'v-deploy-*' }),
    ).toThrow(/overlaps the upstream release namespace/);
  });

  it('rejects patterns with zero or two stars', () => {
    expect(() =>
      normalizeDeployTagPattern({ CCE_DEPLOY_TAG_PATTERN: 'deploy/v' }),
    ).toThrow(/exactly one "\*"/);
    expect(() =>
      normalizeDeployTagPattern({ CCE_DEPLOY_TAG_PATTERN: 'deploy/*/v*' }),
    ).toThrow(/exactly one "\*"/);
  });

  it('custom pattern release/cce-* works end to end', () => {
    const p = normalizeDeployTagPattern({ CCE_DEPLOY_TAG_PATTERN: 'release/cce-*' });
    expect(p.webhookHeadRefPattern).toBe('^refs/tags/release/cce-.*$');
    expect(p.buildspecGuardPattern).toBe('tag/release/cce-*');
    expect(p.matchesDeployTag('refs/tags/release/cce-1.2.3')).toBe(true);
    expect(p.matchesDeployTag('refs/tags/v1.2.3')).toBe(false);
    expect(p.matchesDeployTag('refs/tags/release/other-1.2.3')).toBe(false);
  });

  it('escapes regex metachars in the literal parts (dot is literal)', () => {
    const p = normalizeDeployTagPattern({ CCE_DEPLOY_TAG_PATTERN: 'ship.v*' });
    expect(p.webhookHeadRefPattern).toBe('^refs/tags/ship\\.v.*$');
    expect(p.matchesDeployTag('refs/tags/ship.v1')).toBe(true);
    // An unescaped "." would let any character through here.
    expect(p.matchesDeployTag('refs/tags/shipXv1')).toBe(false);
  });

  it('rejects glob/regex metachars outside the safe charset', () => {
    for (const bad of ['deploy/v?*', 'deploy/[v]*', 'dep loy/v*', 'deploy/v*+']) {
      expect(() =>
        normalizeDeployTagPattern({ CCE_DEPLOY_TAG_PATTERN: bad }),
      ).toThrow(/charset|exactly one/);
    }
  });
});
