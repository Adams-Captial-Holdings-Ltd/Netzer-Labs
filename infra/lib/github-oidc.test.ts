import { describe, it, expect } from 'vitest';
import { resolveGithubOidcTrust } from './github-oidc.js';

describe('resolveGithubOidcTrust (fail-closed OIDC deploy trust)', () => {
  const base = {
    CCE_GITHUB_OWNER: 'acme',
    CCE_GITHUB_REPO: 'cce-fork',
    CCE_GITHUB_DEPLOY_REFS: 'refs/heads/main',
  };

  it('errors when owner/repo are missing — no default repo identity', () => {
    expect(() => resolveGithubOidcTrust({})).toThrow(/CCE_GITHUB_OWNER/);
    expect(() =>
      resolveGithubOidcTrust({ CCE_GITHUB_OWNER: 'acme' }),
    ).toThrow(/CCE_GITHUB_REPO/);
    // The original upstream repo must never appear as a fallback.
    try {
      resolveGithubOidcTrust({});
    } catch (e) {
      expect(String(e)).not.toContain('legacy-community-owner');
    }
  });

  it('errors when no deploy ref or environment is given — never repo-wide', () => {
    expect(() =>
      resolveGithubOidcTrust({
        CCE_GITHUB_OWNER: 'acme',
        CCE_GITHUB_REPO: 'cce-fork',
      }),
    ).toThrow(/at least one deploy subject/);
  });

  it('produces exact StringEquals subjects with the aud condition', () => {
    const trust = resolveGithubOidcTrust({
      ...base,
      CCE_GITHUB_DEPLOY_ENVIRONMENTS: 'production',
    });
    expect(trust.subjects).toEqual([
      'repo:acme/cce-fork:ref:refs/heads/main',
      'repo:acme/cce-fork:environment:production',
    ]);
    expect(trust.conditions.StringEquals['token.actions.githubusercontent.com:aud']).toBe(
      'sts.amazonaws.com',
    );
    expect(trust.conditions.StringEquals['token.actions.githubusercontent.com:sub']).toEqual(
      trust.subjects,
    );
    // StringEquals only — a StringLike block would re-admit wildcards.
    expect(Object.keys(trust.conditions)).toEqual(['StringEquals']);
  });

  it('an unapproved ref or PR context is not a trusted subject', () => {
    const trust = resolveGithubOidcTrust(base);
    // exact-match semantics: these subjects are simply absent
    expect(trust.subjects).not.toContain('repo:acme/cce-fork:ref:refs/heads/feature-x');
    expect(trust.subjects).not.toContain('repo:acme/cce-fork:pull_request');
    expect(trust.subjects.some((s) => s.endsWith(':*'))).toBe(false);
    expect(trust.subjects.some((s) => s.includes('*'))).toBe(false);
  });

  it('rejects wildcards anywhere in the inputs', () => {
    expect(() =>
      resolveGithubOidcTrust({ ...base, CCE_GITHUB_DEPLOY_REFS: 'refs/heads/*' }),
    ).toThrow(/wildcard/);
    expect(() =>
      resolveGithubOidcTrust({ ...base, CCE_GITHUB_OWNER: '*' }),
    ).toThrow(/wildcard/);
    expect(() =>
      resolveGithubOidcTrust({
        ...base,
        CCE_GITHUB_DEPLOY_REFS: undefined,
        CCE_GITHUB_DEPLOY_ENVIRONMENTS: 'prod*',
      }),
    ).toThrow(/wildcard/);
  });

  it('rejects unqualified refs (must be refs/...)', () => {
    expect(() =>
      resolveGithubOidcTrust({ ...base, CCE_GITHUB_DEPLOY_REFS: 'main' }),
    ).toThrow(/fully-qualified/);
  });
});

describe('immutable subject claims (owner/repo ids in the sub)', () => {
  const base = {
    CCE_GITHUB_OWNER: 'acme',
    CCE_GITHUB_REPO: 'cce-fork',
    CCE_GITHUB_DEPLOY_REFS: 'refs/heads/staging',
    CCE_GITHUB_DEPLOY_ENVIRONMENTS: 'staging',
  };

  it('embeds the ids in every subject when both are given', () => {
    const trust = resolveGithubOidcTrust({
      ...base,
      CCE_GITHUB_OWNER_ID: '318461635',
      CCE_GITHUB_REPO_ID: '1324639154',
    });
    expect(trust.subjects).toEqual([
      'repo:acme@318461635/cce-fork@1324639154:ref:refs/heads/staging',
      'repo:acme@318461635/cce-fork@1324639154:environment:staging',
    ]);
  });

  it('keeps the classic form when they are absent', () => {
    expect(resolveGithubOidcTrust(base).subjects).toEqual([
      'repo:acme/cce-fork:ref:refs/heads/staging',
      'repo:acme/cce-fork:environment:staging',
    ]);
  });

  it('rejects a non-numeric id', () => {
    // An un-interpolated workflow expression would otherwise be baked into
    // the trust policy verbatim.
    expect(() =>
      resolveGithubOidcTrust({ ...base, CCE_GITHUB_REPO_ID: '${{ github.repository_id }}' }),
    ).toThrow(/numeric GitHub id/);
  });
});
