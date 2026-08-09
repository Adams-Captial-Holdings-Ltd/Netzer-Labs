# Netzar OS repository cutover checklist

This checklist moves repository governance to the promotion path below without changing the running AWS installation by itself:

```text
feature/fix/chore -> development -> qa -> staging -> production
hotfix/<issue> -> production, then backport to development and promote normally
```

Use the approved [repository cutover design](docs/superpowers/specs/2026-08-08-netzar-os-repository-cutover-design.md) as the decision record. Stop on any failed check. Do not bypass CI, force push, delete `main`, rewrite history, expose secrets, or run `npm run destroy` as part of this cutover.

## 1. Preconditions and dashboard health snapshot

- [ ] Confirm the production dashboard, health endpoint, and Knowledge API are healthy before repository changes.
- [ ] Record the observation time and non-secret health results in the cutover ticket or pull request.
- [ ] Confirm the live deployment checkout and the governance checkout are separate, and preserve all runtime edits in the live checkout.
- [ ] Confirm this repository-configuration phase will not trigger a Deploy workflow or make an AWS change.

## 2. Baseline SHA verification

- [ ] Confirm local `main`, remote `main`, and the recorded production source all point to the same approved baseline SHA.
- [ ] Stop if `main` moved unexpectedly; review the new commits before creating any branch.
- [ ] Record the exact baseline SHA without recording credentials or dashboard tokens.

## 3. Long-lived branch creation

- [ ] Create `development`, `qa`, `staging`, and `production` from the exact verified baseline.
- [ ] Confirm each new branch resolves to that baseline before adding governance commits.
- [ ] Do not rename or delete `main`; do not rewrite or force-push any branch.

## 4. Initial unprotected bootstrap pull request and local evidence

- [ ] Publish the governance change branch and open the first pull request into `development`.
- [ ] Attach full Ubuntu-equivalent unit, type-check, server build, dashboard type-check/build, docs, deploy-source guard, and credential-free synth evidence.
- [ ] Review the complete diff before merge and confirm it contains no application deployment or secret changes.
- [ ] Treat this first pull request as an explicit bootstrap exception only if protections cannot yet be enabled; record who reviewed and merged it.

## 5. CI warm-up on each new branch

- [ ] Allow CI and Docs CI to record their real check names on `development`.
- [ ] Promote by pull request from `development` to `qa`, `qa` to `staging`, and `staging` to `production` so checks run on each target.
- [ ] Require only exact check contexts GitHub has already recorded; never invent a required status-check name.
- [ ] Stop promotion on any red or missing required check.

## 6. GitHub Environments

- [ ] Create empty `development`, `qa`, `staging`, and `production` GitHub Environments.
- [ ] Keep development and QA free of deployment credentials unless a separately approved deployment design needs them.
- [ ] Keep staging and production variables, credentials, and approvals isolated from each other.
- [ ] Never copy repository secrets into documentation, files, comments, logs, or chat.
- [ ] After the production-source proof, restrict the `production` Environment to the `production` branch when the repository plan supports deployment branch policies.

## 7. GitHub plan and protection limitation

- [ ] Verify whether this private repository's current GitHub plan supports branch protection or repository rulesets.
- [ ] If GitHub reports that an upgrade or public repository is required, keep the repository private, record the limitation, and do not claim protections are active.
- [ ] When supported, require pull requests, conversation resolution, no force pushes, and no deletion on all long-lived branches.
- [ ] When supported, require at least one approval and CODEOWNERS-compatible review; require exact warmed CI contexts on `development`, `qa`, `staging`, and `production`.
- [ ] Limit emergency bypass to the repository owner and document every use.

## 8. Staging proof

- [ ] AWS-changing — outside this repository-configuration plan. Before any staging action, perform a fresh temporary AWS identity check and verify account `239887088812`.
- [ ] Confirm the deploy-source guard accepts staging only from `refs/heads/staging` before AWS mutation begins.
- [ ] Run the existing Netzer lifecycle deployment workflow from `staging`; never use a bare `cdk deploy`.
- [ ] Require build, deployment, ECS stability, and health smoke checks to pass; stop without bypassing failures.

## 9. Production proof from `production`

- [ ] AWS-changing — outside this repository-configuration plan. Before the production proof, perform a fresh temporary AWS identity check and verify account `239887088812`.
- [ ] Confirm the production workflow is temporarily authorized from both `main` and `production` so recovery remains available.
- [ ] Run the existing Netzer lifecycle deployment workflow from `production`; do not use a bare `cdk deploy` and do not bypass its cost gate.
- [ ] Require build, deployment, ECS stability, dashboard health, and Knowledge API checks to pass.
- [ ] If the proof fails, stop: leave `main` authorized and leave the default branch unchanged.

## 10. Remove `main` deployment authority

- [ ] Only after the successful production proof, remove `main` from the workflow production-source allowlist.
- [ ] AWS-changing — outside this repository-configuration plan. Before changing AWS OIDC trust, perform a fresh temporary AWS identity check and verify account `239887088812`.
- [ ] Remove `refs/heads/main` from AWS OIDC deploy-ref authorization when ref-based trust is used.
- [ ] Confirm a production request from any non-`production` branch is rejected before AWS mutation begins.
- [ ] Preserve `main` as protected legacy history; do not delete it.

## 11. Default branch change

- [ ] Change the GitHub default branch to `development` only after the production proof and authority checks succeed.
- [ ] Update contributor links or automation that relied on GitHub's default branch, without renaming compatibility-sensitive runtime identifiers.
- [ ] Confirm new ordinary work targets `development`, while promotions accept only the immediately preceding branch.

## 12. Hotfix, rollback, and recovery

- [ ] For an urgent production fix, branch `hotfix/<issue>` from `production`, make the smallest change, run full verification, and merge by pull request into `production`.
- [ ] Backport the accepted hotfix to `development`, then promote it normally through `qa` and `staging`; do not merge unrelated production state wholesale into lower branches.
- [ ] AWS-changing — outside this repository-configuration plan. Before a production hotfix deploy or application rollback, perform a fresh temporary AWS identity check and verify account `239887088812`.
- [ ] Use the repository's Netzer lifecycle rollback tooling and deployment manifest for runtime recovery; changing a Git branch is not an application rollback.
- [ ] If repository cutover checks fail before production proof, keep `main` authorized and the default branch unchanged.

## Completion record

- [ ] Record which items were configured automatically and which remain manual or GitHub-plan-blocked.
- [ ] Record the final protected branches, required check names, Environment policies, production source, default branch, and non-secret health evidence.
- [ ] Confirm no secret value was displayed or committed and no unintended `CCE_*` or `claudeclaw` compatibility identifier was renamed.
