/**
 * GitHub Actions OIDC trust resolution — FAIL CLOSED.
 *
 * When CI deploys are enabled (CCE_CICD_ENABLED=1) the deploy role's trust
 * policy must be pinned to an EXPLICIT repository and an EXPLICIT set of
 * deploy subjects (protected branch refs and/or GitHub Environments). There
 * are deliberately no defaults: a default owner/repo would grant the
 * original upstream repository deploy authority into a newcomer's AWS
 * account the moment they flip CI on.
 *
 * Inputs (all read from the synth environment):
 *   CCE_GITHUB_OWNER                 e.g. `my-org`            (required)
 *   CCE_GITHUB_REPO                  e.g. `my-fork`           (required)
 *   CCE_GITHUB_DEPLOY_REFS           CSV of fully-qualified refs,
 *                                    e.g. `refs/heads/main`   (≥1 of refs or
 *   CCE_GITHUB_DEPLOY_ENVIRONMENTS   CSV of GH Environments    environments
 *                                    e.g. `production`         is required)
 *
 * The resulting trust uses StringEquals (exact match, no wildcards) on
 * `token.actions.githubusercontent.com:sub` and requires
 * `token.actions.githubusercontent.com:aud == sts.amazonaws.com`. A
 * repo-wide `repo:owner/name:*` subject is never produced; inputs that
 * contain wildcard characters are rejected.
 */

export interface GithubOidcTrust {
  owner: string;
  repo: string;
  /** Exact `sub` claims trusted to assume the deploy role. */
  subjects: string[];
  /** Condition block for the role's FederatedPrincipal. */
  conditions: {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com';
      'token.actions.githubusercontent.com:sub': string[];
    };
  };
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function rejectWildcards(kind: string, values: string[]): void {
  for (const v of values) {
    if (v.includes('*') || v.includes('?')) {
      throw new Error(
        `CCE_CICD_ENABLED=1: ${kind} "${v}" contains a wildcard. OIDC deploy ` +
          'trust must name exact subjects — a wildcard would let any ref or ' +
          'PR context in the repository assume the deploy role.',
      );
    }
  }
}

export function resolveGithubOidcTrust(
  env: Record<string, string | undefined> = process.env,
): GithubOidcTrust {
  const owner = env.CCE_GITHUB_OWNER?.trim();
  const repo = env.CCE_GITHUB_REPO?.trim();
  if (!owner || !repo) {
    throw new Error(
      'CCE_CICD_ENABLED=1 requires CCE_GITHUB_OWNER and CCE_GITHUB_REPO to be ' +
        'set explicitly (no default). Set them to YOUR GitHub org/user and ' +
        'repository name — a default here would grant the upstream repository ' +
        'deploy authority into your AWS account.',
    );
  }
  rejectWildcards('owner/repo', [owner, repo]);

  const refs = splitCsv(env.CCE_GITHUB_DEPLOY_REFS);
  const environments = splitCsv(env.CCE_GITHUB_DEPLOY_ENVIRONMENTS);
  if (refs.length === 0 && environments.length === 0) {
    throw new Error(
      'CCE_CICD_ENABLED=1 requires at least one deploy subject: set ' +
        'CCE_GITHUB_DEPLOY_REFS (CSV of fully-qualified refs, e.g. ' +
        '"refs/heads/main") and/or CCE_GITHUB_DEPLOY_ENVIRONMENTS (CSV of ' +
        'GitHub Environment names, e.g. "production"). A repo-wide trust ' +
        '(repo:owner/name:*) is never generated.',
    );
  }
  rejectWildcards('deploy ref', refs);
  rejectWildcards('deploy environment', environments);
  for (const ref of refs) {
    if (!ref.startsWith('refs/')) {
      throw new Error(
        `CCE_GITHUB_DEPLOY_REFS entry "${ref}" must be a fully-qualified git ` +
          'ref (e.g. "refs/heads/main"), so the trust subject is exact.',
      );
    }
  }

  const repoSubject = `repo:${owner}/${repo}`;
  const subjects = [
    ...refs.map((ref) => `${repoSubject}:ref:${ref}`),
    ...environments.map((e) => `${repoSubject}:environment:${e}`),
  ];

  return {
    owner,
    repo,
    subjects,
    conditions: {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': subjects,
      },
    },
  };
}
