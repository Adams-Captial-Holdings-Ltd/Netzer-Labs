# Netzar OS Repository and Production Cutover Design

**Status:** Approved in conversation on 2026-08-08
**Baseline:** `main` at `355c39795decd7f5c1ad6af38a051b57f74e5a85`
**Repository:** `emmanuelmadams4-lgtm/Netzer-Labs`

## Purpose

Establish a disciplined Git and GitHub promotion model, move production deployment authority from `main` to `production` without disrupting the deployed application, and change the public product name to **Netzar OS** while preserving compatibility-sensitive identifiers.

The work is intentionally conservative. It does not redesign the application, migrate AWS resources, change databases, rotate secrets, replace deployment tooling, or upgrade dependencies.

## Current State

- The private repository has one remote branch, `main`, and no release tags.
- `main` is the default branch and current production baseline.
- CI and documentation checks target `main` only.
- The manual GitHub Actions deploy workflow supports staging and production and references the GitHub Environments `staging` and `production`.
- AWS OIDC configuration currently trusts subjects derived from `main`, `staging`, and the named deployment environments.
- Optional AWS CodeBuild deployment defaults to `main` and deploys only from the guarded `deploy/v*` tag namespace.
- The root npm project contains the TypeScript/Hono service and AWS CDK code. The independently locked `web` npm project contains the Preact/Vite dashboard.
- User-facing branding is split among `ClaudeClaw`, `ClaudeClaw Enterprise`, and `EnterpriseOS`.
- Historical `claudeclaw` and `CCE` values are embedded in live-compatible AWS, environment, browser-storage, deployment, and upgrade contracts.

## Goals

1. Use the long-lived branches `development`, `qa`, `staging`, and `production`.
2. Make `production` the sole production deployment branch after a controlled cutover.
3. Preserve `main` as protected legacy history instead of deleting or rewriting it.
4. Require pull-request promotion through the branch sequence.
5. Run the repository's real checks on pull requests targeting every long-lived branch.
6. Add missing server and dashboard build validation without inventing a new build system.
7. Document branch promotion, rollback, and hotfix handling in clear contributor guidance and an easy root-level `cutover.md` checklist.
8. Present the product publicly as **Netzar OS**.
9. Change only genuine personal attribution from Mark to Emmanuel; retain every non-person use of “mark.”
10. Keep secrets isolated and never expose secret values in files, commands, or reports.

## Non-Goals

- No AWS resource rename or replacement.
- No migration of DynamoDB tables, S3 buckets, KMS aliases, Secrets Manager paths, ECS/ECR resources, IAM roles, CloudWatch namespaces, or CDK stack names.
- No DNS, certificate, webhook, or OAuth hostname migration.
- No rename of `CCE_*` environment variables.
- No rename of persisted browser keys or existing theme identifiers.
- No package dependency upgrades or automatic vulnerability remediation.
- No application architecture refactor.
- No deployment to AWS during repository implementation. The production cutover remains an explicit operator procedure.

## Branch Architecture

Normal work follows this direction:

```text
feature/* | fix/* | chore/*
              |
              v
        development
              |
              v
             qa
              |
              v
           staging
              |
              v
         production
```

### Working branches

- Start ordinary feature, fix, and chore branches from `development`.
- Merge them into `development` through pull requests.
- Delete merged short-lived branches when practical.
- Do not merge ordinary feature work directly into `qa`, `staging`, or `production`.

### Promotion branches

- Promote `development` to `qa` by pull request.
- Promote `qa` to `staging` by pull request.
- Promote `staging` to `production` by pull request.
- Do not accumulate unrelated direct commits on promotion branches.
- Prefer merge commits for promotion pull requests so the promotion boundary remains visible. Feature pull requests may use squash merge if the team prefers.

## Controlled Production Cutover

`production` becomes the exclusive production source, but `main` remains temporarily authorized until the identical baseline is proven deployable from `production`.

### Phase A: bootstrap

1. Confirm `main` is clean, healthy, and still points at the recorded production baseline.
2. Create `development`, `qa`, `staging`, and `production` from that same baseline commit.
3. Add CI coverage and repository guidance through a short-lived chore branch.
4. Protect the long-lived branches without requiring status-check names that have never run.

### Phase B: prove the new source

1. Permit production deployment from `main` or `production` temporarily.
2. Add a workflow-level guard that rejects production deployment from every other branch.
3. Permit staging deployment only from `staging`.
4. Run the existing production deployment workflow from `production` using the unchanged baseline.
5. Require the existing build, deployment, ECS-stability, and health-smoke steps to succeed.
6. Stop the cutover if any check fails. Keep `main` authorized and diagnose without forcing or bypassing the failure.

### Phase C: cut authority over

After a successful production deployment from `production`:

1. Remove `main` from the workflow's production-source allowlist.
2. Remove `refs/heads/main` from AWS OIDC deploy-ref configuration when ref-based trust is used.
3. Restrict the GitHub `production` Environment to the `production` branch and add required reviewers when the repository plan supports them.
4. Confirm a production deployment request from another branch is refused before AWS mutation begins.
5. Change the repository default branch to `development`.
6. Protect and freeze `main` as a legacy baseline. Do not delete it.

The cutover does not use force pushes, branch renames, history rewriting, or destructive AWS operations.

## Hotfix Design

1. Branch `hotfix/<issue>` from `production`.
2. Apply the smallest production fix and run the full verification suite.
3. Merge the hotfix into `production` through a pull request.
4. Deploy and verify production normally.
5. Open a backport pull request that applies the accepted hotfix to `development`.
6. Promote the backport through `development -> qa -> staging` so lower environments and future releases contain the fix.
7. Do not force-merge `production` wholesale into lower branches when that would unintentionally move unrelated release state.

## GitHub Protection Design

### All long-lived branches

- Require pull requests before merging.
- Require conversation resolution.
- Block force pushes.
- Block deletion.
- Apply protections to administrators where practical, with emergency bypass limited to the repository owner.
- Require branches to be up to date when this does not create a circular promotion dependency.
- Do not require a status-check context until GitHub has recorded that exact context on the branch.

### `development`

- Require at least one approval when repository-plan capabilities allow it.
- Require applicable CI, build, and documentation checks after their first successful run.
- Prevent ordinary direct pushes.

### `qa` and `staging`

- Accept normal changes only through promotion pull requests from the immediately preceding branch.
- Require CI and builds.
- Require at least one approval when supported.
- Use CODEOWNERS review for sensitive paths when supported.

### `production`

- Require pull requests, successful CI/build/test checks, conversation resolution, and CODEOWNERS-compatible review.
- Require at least one approval; use two approvals only if the available team size makes that practical.
- Reject direct ordinary development.
- Block deletion and force pushes without broad bypass.
- Restrict deployment through the `production` GitHub Environment.

Rulesets or protections will only be reported as automatic when the active credentials actually apply them. Otherwise, `cutover.md` will provide the exact GitHub UI steps.

## GitHub Environments

Use four named environments:

- `development`
- `qa`
- `staging`
- `production`

The repository currently implements AWS deployments only for staging and production. Creating development and QA GitHub Environments does not imply new AWS infrastructure or automatic deployments.

- Development and QA may initially contain no deployment secrets.
- Staging credentials, variables, and approval rules remain isolated to staging.
- Production credentials, variables, and approval rules remain isolated to production.
- Repository-level secrets will not be copied into environment files or documentation.
- Production deployment branch policy must name `production` after cutover.

## CI/CD Design

### Pull-request validation

Update CI and Docs CI triggers to cover pull requests targeting:

- `development`
- `qa`
- `staging`
- `production`
- `main` during the transition, so the legacy baseline remains protected

Use the repository's actual npm commands and lockfiles.

### Existing checks retained

- Root dependency installation
- Root type-check
- Full unit suite
- LocalStack integration suite in GitHub Actions
- Hermetic CDK synth
- Synth secret scan
- Rollback dry-run checks
- Documentation links, diagrams, Mermaid, and asset budgets

### Minimal build additions

- Run the root compiled server build.
- Install the independently locked `web` dependencies.
- Type-check the dashboard using its existing TypeScript configuration.
- Run the existing Vite dashboard build.

No lint or formatting gate will be invented because the repository does not currently define those scripts.

### Deployment guard

The manual deploy workflow must fail before credential configuration or AWS mutation unless:

- staging input is paired with `refs/heads/staging`, or
- production input is paired with `refs/heads/production`, with `refs/heads/main` allowed only during the documented transition.

Existing AWS resource names and deployment commands remain unchanged.

## Repository Governance

Retain and update the existing CODEOWNERS, issue templates, CONTRIBUTING.md, SECURITY.md, README, and release documentation only where the requested workflow or branding requires it.

Add:

- A pull-request template with change summary, risk, validation, deployment impact, compatibility identifiers, and promotion source/target.
- Root-level `cutover.md` containing plain-language, checkbox-style instructions.

The cutover guide will include:

1. Preconditions and stop conditions.
2. Branch creation.
3. CI warm-up before requiring checks.
4. Branch protection and Environment setup.
5. Staging verification.
6. First production deployment from `production`.
7. Removal of `main` deployment authority.
8. Default-branch change.
9. Normal promotion and hotfix examples.
10. Rollback and recovery steps.
11. A clear split between automatically configured items and manual GitHub settings.

Instructions will avoid jargon where possible and will never contain secret values.

## Branding Migration

The exact public product name is **Netzar OS**. The company and repository owner remain **Netzer Labs** and **Emmanuel Adams**.

### Change safely

- User-facing dashboard names, titles, descriptions, login screens, status pages, invitations, and prompts
- README and current product documentation
- `BRAND.md`
- Private package metadata and lockfile package names
- Current comments, examples, and owned metadata where they describe the product rather than an internal compatibility contract
- Tests that assert user-facing branding

### Preserve for compatibility

- `claudeclaw` AWS resource names and fallbacks
- `CCE` CDK, environment, and configuration identifiers
- AWS role, ECR, ECS, CodeBuild, DynamoDB, S3, KMS, Secrets Manager, CloudWatch, and stack identifiers
- Existing domains, certificates, webhook URLs, OAuth redirect bases, and external handles
- Browser local-storage and session-storage keys
- Persisted theme IDs
- Deploy tag, release metadata, updater, and migration contracts
- Historical transfer archive names, provenance facts, and hashes
- `CLAUDE.md` filenames used as agent configuration conventions
- Anthropic Claude model names and documentation references

Documentation that shows preserved identifiers will label them as legacy compatibility identifiers so readers do not mistake them for the public brand.

## Mark to Emmanuel Audit

The repository contains no project-owner reference to a person named Mark. Existing exact matches use “mark” as an action or interface label, including “Mark all read.” Those strings remain unchanged.

Current ownership, copyright, CODEOWNERS, repository links, test aliases, and provenance already identify Emmanuel Adams where appropriate.

## Verification and Evidence

After implementation, run and report:

- Root dependency integrity using npm and `package-lock.json`
- Dashboard dependency integrity using npm and `web/package-lock.json`
- Root type-check
- Dashboard type-check
- Full unit suite
- Integration tests when LocalStack becomes healthy
- Root server build
- Dashboard production build
- Applicable documentation checks
- Git diff and status
- Case-insensitive old-brand search
- Semantic `Mark` search

Known baseline constraints must not be hidden:

- The Windows baseline has Unix-shell and `/tmp` assumptions in several tests.
- The local integration compose health check currently marks LocalStack unhealthy before tests start.
- Existing dependency audits report advisories; they are reported but not automatically upgraded in this task.

No check will be described as passing unless its fresh command exits successfully.

## Failure and Rollback Handling

- If branch creation or workflow validation fails, leave `main` unchanged and production-authorized.
- If the first production deployment from `production` fails, do not remove `main` authorization.
- If GitHub protections would deadlock merging, remove only the unproven required-check reference, allow the real workflow to run, then configure the exact recorded context.
- If a branding change touches an internal identifier unexpectedly, revert that individual change and retain the compatibility identifier.
- Do not bypass failing tests, disable CI, force push, delete branches, or rewrite history.
- Application rollback continues to use the repository's existing deployment manifest and rollback tooling; changing a Git branch is not the runtime rollback mechanism.

## Acceptance Criteria

- `production` is the sole authorized production deployment branch after the controlled cutover.
- `main` remains preserved and protected.
- New work enters through `development`, then promotes through QA and staging.
- CI validates pull requests to all long-lived branches using real repository commands.
- Production deployment cannot start from development, QA, staging, or feature branches.
- The product is presented publicly as Netzar OS.
- Compatibility-sensitive historical identifiers remain functional and documented.
- No personal Mark references remain because none existed; semantic uses of “mark” are untouched.
- No secrets are committed or displayed.
- Verification results and any remaining risks are reported accurately.
