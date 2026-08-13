# Netzar OS Cross-Device Development and Shared QA Design

**Status:** Approved in conversation on 2026-08-09  
**Repository:** `emmanuelmadams4-lgtm/Netzer-Labs`  
**Authority:** [AGENTS.md](../../../AGENTS.md) remains the installation playbook.

## Purpose

Provide a GitHub-centered development path that works from any authorized
device, automatically places accepted development changes into one persistent
QA environment, and promotes the exact tested code through protected branches
to signed, client-approved production releases.

## Decisions

- GitHub is the source of truth. The default no-extra-cost path is to clone the
  repository on any authorized computer. GitHub Codespaces is optional and is
  not required by the workflow.
- Normal work moves through `feature/* -> development -> qa -> staging ->
  production`.
- A successful merge into `development` automatically deploys that exact
  commit to one persistent AWS T0 QA environment.
- QA is the only paid nonproduction AWS environment. The expected fixed cost
  is approximately $65-95 per month, plus bounded Bedrock usage.
- `qa` and `staging` remain protected promotion branches. `staging` is a
  release-candidate gate, not a second paid AWS stack.
- Merging an approved release into `production` creates the source for a
  signed, immutable `v*` release. Each client approves installation in its own
  AWS account.
- After every production release, QA is reconciled to the signed production
  baseline and refreshed with versioned synthetic or redacted data.
- Client production data, credentials, knowledge, and models never enter the
  shared QA environment.

## Architecture

```text
Authorized development computer
                  |
                  v
             feature branch
                  |
               PR + CI
                  v
             development
                  |
       automatic QA deployment
                  v
       persistent AWS T0 QA environment
                  |
            human QA approval
                  v
          qa -> staging -> production
             protected PRs only
                  |
                  v
         signed GitHub v* release
                  |
          client-approved update
                  v
          each client's AWS account
```

## Cross-Device Development

[development.md](../../development.md) defines the supported Node 20, Git,
Docker, dependency, validation, and branch setup. A developer can repeat that
setup on any authorized Windows/WSL, macOS, or Linux computer, then continue a
pushed feature branch from that device. GitHub Codespaces may be used as a paid
convenience, but no workflow depends on it. Development computers do not
receive production AWS credentials and cannot deploy production.

Pull requests targeting `development` must pass the existing typecheck, build,
unit, LocalStack integration, hermetic synth, secret scan, rollback, and
documentation checks. A failed check blocks the merge and therefore blocks QA
deployment.

## Persistent QA Deployment

The QA deployment workflow runs only after CI succeeds on `development`. It
uses GitHub OIDC and a QA-scoped AWS role, never stored AWS access keys. The
workflow deploys the exact Git commit with the repository's Netzer lifecycle
command and its typed output. It must not call bare `cdk deploy`.

The standing T0 cost is approved for this one environment. The QA workflow may
use the lifecycle cost confirmation only for the pre-approved T0 target. That
approval does not authorize unattended staging, production, tier changes, or
client-account spending.

The workflow has one concurrency group. A newer development commit cancels a
queued older deployment, but it does not interrupt an AWS mutation already in
progress. Verification must be green before the commit is recorded as the
current QA version.

## Promotion and Production

QA approval promotes the tested commit by pull request from `development` to
`qa`. Release-candidate checks then promote `qa` to `staging`. Final approval
promotes `staging` to `production`. Direct ordinary pushes, force pushes,
branch deletion, and skipping a promotion branch are prohibited.

The production merge identifies the release commit. Release tooling creates
signed metadata, the artifact manifest, signature, and promotion attestation
described in [release-pipeline.md](../../release-pipeline.md). No client deploy
is triggered by the release tag. Clients approve an update window and install
the signed release into their own AWS account.

## Post-Release Reconciliation

After a production release:

1. Merge `production` back into `development` without resetting or rewriting
   history.
2. Pause automatic development-to-QA deployment.
3. Rebuild or update QA from the exact signed production release.
4. Apply the production schema and configuration contract.
5. Replace QA data with versioned synthetic or approved redacted fixtures.
6. Run schema, configuration, feature-flag, image, and release-version drift
   checks.
7. Resume automatic QA deployment only when reconciliation is green.

This produces production parity without copying client production records or
discarding development history.

## Access and Security

Until Netzar has a dedicated domain, authorized computers use the documented
AWS-authenticated private tunnel. After a domain is available, the preferred
path is a stable Cloudflare Access URL with identity-based login and MFA. The
design does not use `salessly.io`, anonymous public dashboard access, or
long-lived AWS keys.

GitHub environments separate QA and production policy. QA OIDC trust is scoped
to the approved repository, workflow, branch, role, account, and region.
Production remains a human gate and is not accessible from development
workstations.

## Failure and Recovery

- A failed CI run does not deploy QA.
- A failed QA deploy leaves the previously verified QA version current and
  reports the typed lifecycle blocker.
- A failed reconciliation keeps automatic QA deployment paused.
- A failed promotion does not advance the next branch.
- A failed client update leaves the client on its prior signed release and uses
  the existing rollback classes.
- Never use `npm run destroy` unless the installation owner explicitly requests
  destruction.

## Documentation and Implementation Scope

The developer setup is documented in [development.md](../../development.md),
and the operator workflow is documented in
[deployment.md](../../deployment.md). Implementation will add the scoped
automatic QA workflow, parity checks, protected promotion guidance, and
documentation validation. It will also replace the existing manual deploy
workflow's direct CDK invocation with the Netzer lifecycle entrypoint without
making production automatic. The work will reuse the repository's lifecycle
and release tooling rather than inventing a second deployment system.

## Acceptance Criteria

- An authorized user can clone the repository on any supported computer and
  run the normal development checks. Codespaces remains optional.
- A green merge into `development` automatically deploys the exact commit to
  the persistent QA T0 environment.
- Failed checks or deploy verification stop promotion.
- Production is reachable only through `development -> qa -> staging ->
  production` pull requests.
- Every final release is immutable, signed, and installed only after client
  approval.
- QA is reconciled after every production release and contains no client
  production data or credentials.
- No workflow uses bare `cdk deploy`, stores long-lived AWS keys, deletes a
  long-lived branch, or automatically deploys clients.
