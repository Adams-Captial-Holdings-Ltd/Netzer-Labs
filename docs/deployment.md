# Development, QA, and Production Deployment

> Netzar OS development is portable: use a local clone from any authorized
> computer, with paid GitHub Codespaces available only as an option. Accepted development changes deploy
> automatically to one private QA environment, while staging and production
> remain protected human gates. Client production updates are signed and never
> install without that client's approval.

**Status:** This page defines the approved target workflow. Automatic QA is not
active until the associated implementation is merged and the GitHub/AWS setup
checklist is completed.

## Authority and Safety

[AGENTS.md](../AGENTS.md) is the primary installation playbook. Follow its
order, act on typed lifecycle output, and use the remediation printed by a
blocker.

- Do not run bare `cdk deploy`.
- Do not run `npm run destroy` without explicit owner authorization.
- Do not place AWS keys, dashboard tokens, signing keys, client data, or other
  secrets in GitHub, development workspaces, source files, logs, or
  documentation.
- Use short-lived authentication and GitHub OIDC for automation.
- Never automatically deploy a release into a client's AWS account.

## The Development Path

```text
feature/* -> development -> qa -> staging -> production -> signed v* release
```

Every arrow is a pull request. Ordinary work starts from `development` and
never targets `qa`, `staging`, or `production` directly.

### Work from any authorized computer

1. Follow [development.md](./development.md) to clone and prepare the
   repository on the computer.
2. Start a short-lived branch from the latest `development`.
3. Install locked dependencies with `npm ci --ignore-scripts`.
4. Make the change without adding AWS or client secrets to the workspace.
5. Run `npm run typecheck` and the full `npm test`.
6. Push the branch and open a pull request into `development`.

Push work before changing computers, then fetch the same branch on the next
computer. GitHub remains the source of truth, so changing computers does not
change the promotion path. Paid GitHub Codespaces is optional.

## Automatic Development to QA

After a pull request merges into `development`:

1. GitHub Actions runs the complete repository checks.
2. A failed check stops the workflow before AWS authentication.
3. A green run obtains short-lived QA credentials through GitHub OIDC.
4. The workflow runs the Netzer lifecycle against the pre-approved persistent
   T0 QA environment.
5. Lifecycle typed blockers stop the run and provide their documented
   remediation.
6. `npm run verify` must be green before the commit becomes the current QA
   baseline.

Only the standing T0 QA cost, approximately $65-95 per month plus bounded
Bedrock usage, is pre-approved. Tier increases and all production or client
cost gates remain human decisions.

## QA to Production

1. Test the deployed `development` commit in private QA.
2. After QA approval, open `development -> qa` and merge only when its checks
   pass.
3. Open `qa -> staging`. The `staging` branch is the release-candidate gate and
   does not require a second paid AWS stack.
4. Run release-candidate checks against the exact QA-tested commit.
5. Open `staging -> production` and obtain final approval.
6. Merge the production pull request. Do not push directly.
7. Create the signed immutable `v*` release from that production commit.
8. Publish release notes and required actions.
9. Each client selects an update window and runs the verified updater in its
   own AWS account.

The signed artifact, not a mutable branch head, is what clients install. See
[release-pipeline.md](./release-pipeline.md).

## Post-Release Refresh

Every production release starts a reconciliation workflow:

1. Merge `production` back into `development` without force pushing or
   rewriting history.
2. Pause automatic QA deployments.
3. Set QA to the exact signed production release.
4. Align schema, configuration structure, feature flags, and runtime image.
5. Replace QA data with the approved versioned synthetic or redacted fixture
   set.
6. Run parity and drift checks.
7. Resume automatic development deployments after all checks pass.

Never copy a client's production data, knowledge base, credentials, or model
configuration into shared QA. Production parity means matching contracts and
versions, not sharing sensitive records.

## Private QA Access

Before a dedicated Netzar domain exists, use the AWS-authenticated private
dashboard tunnel from an authorized computer:

```bash
npm run dashboard:tunnel
```

After the domain is available, use a stable Cloudflare Access link protected by
identity login and MFA. Do not use `salessly.io` or an anonymous public URL.

## Failure and Rollback

- CI failure: fix the feature branch; nothing deploys.
- QA deployment failure: keep the last verified QA version and follow the
  typed blocker remediation.
- QA rejection: fix in a new feature branch and repeat the normal path.
- Release-candidate failure: do not promote `staging` to `production`.
- Production update failure: use the existing lifecycle rollback tooling and
  retain the previous signed release.
- Reconciliation failure: keep QA automation paused until drift is resolved.

Production is never repaired by force-pushing a branch or deleting an
environment.
