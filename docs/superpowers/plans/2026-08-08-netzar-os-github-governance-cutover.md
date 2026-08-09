# Netzar OS GitHub Governance Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure the Netzer-Labs repository for staged promotion through `development -> qa -> staging -> production` while preserving `main`, preventing an unintended AWS deployment, and keeping the currently running dashboard unchanged.

**Architecture:** Repository governance is implemented before production authority moves. Workflow policy, CI/build validation, contributor guidance, branches, and GitHub Environments are prepared and proven first; `main` remains the default and production-authorized source until the separate production-proof gate succeeds. Public Netzar OS branding is a separate implementation plan so runtime copy changes cannot be mixed into the governance cutover.

**Tech Stack:** GitHub Actions, GitHub REST/CLI, Git, Node.js 20, npm, TypeScript, Vitest, Preact/Vite, AWS CDK (read-only synth only in this plan).

## Global Constraints

- The deployed production baseline is commit `355c39795decd7f5c1ad6af38a051b57f74e5a85`.
- Work only in the Windows repository copy on `chore/netzar-os-repository-architecture`; do not edit `/home/emmanueladams/projects/Netzer-Labs` during this plan.
- Do not deploy to AWS, trigger the Deploy workflow, run bare `cdk deploy`, run `npm run destroy`, or change the running dashboard.
- Keep `main` as the default branch and an authorized production source until a later production deployment from `production` has passed health verification.
- Create `development`, `qa`, `staging`, and `production` from the recorded baseline before promoting governance changes.
- Preserve all `CCE_*`, `claudeclaw`, AWS resource, browser-storage, release, updater, and migration identifiers.
- Never expose or commit secret values; GitHub variables and Environment configuration are referenced only by name.
- Do not upgrade dependencies and do not run `npm audit fix --force`.
- Do not claim branch protection is enabled while the private repository remains on a GitHub plan that returns HTTP 403 for protection/ruleset APIs.
- Every claimed test result must come from a fresh successful command.

---

### Task 1: Add a testable deployment-source guard

**Files:**
- Create: `scripts/ci/deploy-source-guard.mjs`
- Create: `scripts/ci/deploy-source-guard.test.mjs`
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `TARGET_ENV`, `GITHUB_REF`, and `CCE_ALLOW_LEGACY_MAIN` from GitHub Actions.
- Produces: `validateDeploySource({ targetEnv, ref, allowLegacyMain }) -> { allowed, reason }` and a CLI that exits `0` only for an approved environment/ref pair.

- [ ] **Step 1: Write the failing guard tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeploySource } from './deploy-source-guard.mjs';

test('staging accepts only refs/heads/staging', () => {
  assert.equal(validateDeploySource({ targetEnv: 'staging', ref: 'refs/heads/staging', allowLegacyMain: true }).allowed, true);
  for (const ref of ['refs/heads/main', 'refs/heads/development', 'refs/heads/qa', 'refs/heads/production']) {
    assert.equal(validateDeploySource({ targetEnv: 'staging', ref, allowLegacyMain: true }).allowed, false);
  }
});

test('production accepts production and transitional main only', () => {
  assert.equal(validateDeploySource({ targetEnv: 'prod', ref: 'refs/heads/production', allowLegacyMain: true }).allowed, true);
  assert.equal(validateDeploySource({ targetEnv: 'prod', ref: 'refs/heads/main', allowLegacyMain: true }).allowed, true);
  assert.equal(validateDeploySource({ targetEnv: 'prod', ref: 'refs/heads/main', allowLegacyMain: false }).allowed, false);
  for (const ref of ['refs/heads/development', 'refs/heads/qa', 'refs/heads/staging', 'refs/heads/feature/x']) {
    assert.equal(validateDeploySource({ targetEnv: 'prod', ref, allowLegacyMain: true }).allowed, false);
  }
});

test('unknown environments fail closed', () => {
  assert.equal(validateDeploySource({ targetEnv: 'production', ref: 'refs/heads/production', allowLegacyMain: true }).allowed, false);
});
```

- [ ] **Step 2: Run the tests and confirm they fail because the guard module does not exist**

Run: `node --test scripts/ci/deploy-source-guard.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `deploy-source-guard.mjs`.

- [ ] **Step 3: Implement the minimal guard module and CLI**

```js
import { pathToFileURL } from 'node:url';

export function validateDeploySource({ targetEnv, ref, allowLegacyMain = false }) {
  if (targetEnv === 'staging') {
    const allowed = ref === 'refs/heads/staging';
    return { allowed, reason: allowed ? 'staging source accepted' : 'staging deploys require refs/heads/staging' };
  }
  if (targetEnv === 'prod') {
    const allowed = ref === 'refs/heads/production' || (allowLegacyMain && ref === 'refs/heads/main');
    return { allowed, reason: allowed ? 'production source accepted' : 'production deploys require refs/heads/production' };
  }
  return { allowed: false, reason: `unsupported target environment: ${targetEnv || '<empty>'}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = validateDeploySource({
    targetEnv: process.env.TARGET_ENV ?? '',
    ref: process.env.GITHUB_REF ?? '',
    allowLegacyMain: process.env.CCE_ALLOW_LEGACY_MAIN === '1',
  });
  console.log(result.reason);
  process.exitCode = result.allowed ? 0 : 1;
}
```

- [ ] **Step 4: Run the guard unit tests**

Run: `node --test scripts/ci/deploy-source-guard.test.mjs`

Expected: 3 tests PASS.

- [ ] **Step 5: Wire the guard ahead of AWS credentials or mutation**

Add a `source-guard` job to `.github/workflows/deploy.yml` that checks out the repository and runs:

```yaml
      - name: Validate deployment source
        env:
          TARGET_ENV: ${{ github.event.inputs.env }}
          GITHUB_REF: ${{ github.ref }}
          CCE_ALLOW_LEGACY_MAIN: '1'
        run: node scripts/ci/deploy-source-guard.mjs
```

Make `verify` depend on `source-guard`, and make `deploy` depend on both `source-guard` and `verify`. During the transition, change `CCE_GITHUB_DEPLOY_REFS` to:

```yaml
CCE_GITHUB_DEPLOY_REFS: refs/heads/main,refs/heads/production,refs/heads/staging
```

Do not run the workflow in this plan.

- [ ] **Step 6: Commit the source guard**

```bash
git add scripts/ci/deploy-source-guard.mjs scripts/ci/deploy-source-guard.test.mjs .github/workflows/deploy.yml
git commit -m "ci: guard deployment source branches"
```

---

### Task 2: Expand CI and add real server/dashboard build validation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `web/package.json`

**Interfaces:**
- Consumes: the root and `web` lockfiles and their existing TypeScript configurations.
- Produces: recorded GitHub checks for root type-check, root build, unit tests, LocalStack integration, hermetic synth, secret scan, rollback dry-run, dashboard type-check, and dashboard production build.

- [ ] **Step 1: Add an explicit dashboard type-check script**

Add to `web/package.json`:

```json
"typecheck": "tsc --noEmit"
```

Do not change dependencies or package versions.

- [ ] **Step 2: Expand CI branch triggers**

Set both `pull_request.branches` and `push.branches` in `.github/workflows/ci.yml` to:

```yaml
[development, qa, staging, production, main]
```

- [ ] **Step 3: Add root and dashboard build steps to the existing verify job**

After root type-check and before unit tests, run `npm run build`. Then add:

```yaml
      - name: Install dashboard dependencies
        run: npm ci --prefix web

      - name: Dashboard typecheck
        run: npm --prefix web run typecheck

      - name: Dashboard production build
        run: npm --prefix web run build
```

Update `actions/setup-node` caching in this job to use both lockfiles:

```yaml
cache-dependency-path: |
  package-lock.json
  web/package-lock.json
```

- [ ] **Step 4: Run the new checks locally**

Run:

```bash
npm run typecheck
npm run build
npm test
npm ci --prefix web
npm --prefix web run typecheck
npm --prefix web run build
```

Expected: every command exits `0`. Record any platform-only failure honestly; do not weaken the GitHub Linux checks to accommodate a Windows-only limitation.

- [ ] **Step 5: Commit CI build validation**

```bash
git add .github/workflows/ci.yml web/package.json
git commit -m "ci: validate promotion branches and builds"
```

---

### Task 3: Expand documentation validation across promotion branches

**Files:**
- Modify: `.github/workflows/docs-ci.yml`
- Modify: `.github/workflows/cdk-drift.yml`

**Interfaces:**
- Consumes: existing documentation validators and the existing credentialed drift workflow.
- Produces: docs checks on every long-lived branch and clearer production-branch terminology in the drift workflow without changing its AWS behavior.

- [ ] **Step 1: Expand Docs CI branch triggers**

Set both `pull_request.branches` and `push.branches` to:

```yaml
[development, qa, staging, production, main]
```

- [ ] **Step 2: Correct drift-workflow language without changing its execution**

Change the comment `main has undeployed infra changes` to `the production source has undeployed infra changes`. Keep the schedule, permissions, stack selector, credentials, and `cdk diff` command unchanged.

- [ ] **Step 3: Run the dependency-free documentation checks**

Run:

```bash
node scripts/ci/docs-links.mjs
node scripts/ci/diagrams-drift.mjs
node scripts/ci/runnable-blocks.mjs
node scripts/ci/docs-assets.mjs
```

Expected: every command exits `0`.

- [ ] **Step 4: Commit Docs CI coverage**

```bash
git add .github/workflows/docs-ci.yml .github/workflows/cdk-drift.yml
git commit -m "ci: validate docs across promotion branches"
```

---

### Task 4: Add enterprise repository-governance guidance

**Files:**
- Create: `.github/pull_request_template.md`
- Create: `cutover.md`
- Modify: `.github/CODEOWNERS`
- Modify: `CONTRIBUTING.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the branch model and stop conditions in `docs/superpowers/specs/2026-08-08-netzar-os-repository-cutover-design.md`.
- Produces: a contributor contract, PR evidence template, and operator checklist that distinguish automatic configuration from GitHub-plan-dependent manual settings.

- [ ] **Step 1: Create the pull-request template**

Include these exact sections:

```markdown
## Summary
## Why this change
## Risk and rollback
## Validation evidence
## Deployment impact
## Compatibility identifiers
## Promotion source and target
## Checklist
```

The checklist must require full unit tests, root/dashboard type-check and build results, documentation updates when applicable, no secret values, no unintended `CCE_*`/`claudeclaw` renames, and a declared source/target branch.

- [ ] **Step 2: Update CODEOWNERS public naming while retaining ownership paths**

Change only the heading from `EnterpriseOS CODEOWNERS` to `Netzar OS CODEOWNERS`. Keep every path and `@emmanuelmadams4-lgtm` owner entry unchanged.

- [ ] **Step 3: Document the promotion and hotfix flow in CONTRIBUTING**

Add:

```text
feature/fix/chore -> development -> qa -> staging -> production
hotfix/<issue> -> production, then backport to development and promote normally
```

State that promotion branches accept changes from the immediately preceding branch, ordinary work never targets `production`, force pushes are forbidden, and `main` is preserved legacy history after cutover.

- [ ] **Step 4: Create the root cutover checklist**

`cutover.md` must contain checkbox sections for:

1. Preconditions and dashboard health snapshot.
2. Baseline SHA verification.
3. Long-lived branch creation.
4. Initial unprotected bootstrap PR and local evidence.
5. CI warm-up on each new branch.
6. GitHub Environments.
7. GitHub plan/protection limitation.
8. Staging proof.
9. Production proof from `production`.
10. Removal of `main` from workflow and AWS OIDC authorization.
11. Default branch change to `development`.
12. Hotfix, rollback, and recovery.

Every AWS-changing checkbox must say it is outside this repository-configuration plan and requires a fresh AWS identity check for account `239887088812`. State explicitly that a failed production proof leaves `main` authorized and the default branch unchanged.

- [ ] **Step 5: Add the governance links to README**

Add a short `Repository governance` subsection linking to `CONTRIBUTING.md`, `cutover.md`, and the design spec. Do not perform the wider Netzar OS branding migration in this task.

- [ ] **Step 6: Run docs validation and semantic searches**

Run:

```bash
node scripts/ci/docs-links.mjs
node scripts/ci/runnable-blocks.mjs
git diff --check
rg -n "refs/heads/main,refs/heads/staging" .github infra scripts docs
rg -n -i "force push|delete main|npm run destroy" cutover.md CONTRIBUTING.md
```

Expected: docs checks and `git diff --check` exit `0`; the old deploy-ref pair has no hit in `.github/workflows/deploy.yml`; destructive language appears only as explicit prohibitions or rollback warnings.

- [ ] **Step 7: Commit governance documentation**

```bash
git add .github/pull_request_template.md .github/CODEOWNERS CONTRIBUTING.md README.md cutover.md
git commit -m "docs: add repository promotion governance"
```

---

### Task 5: Run the complete pre-push verification contract

**Files:**
- Verify only; do not modify production configuration to make a check pass.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: a fresh evidence report suitable for the bootstrap pull request.

- [ ] **Step 1: Verify repository state and scope**

Run:

```bash
git status --short --branch
git diff --stat 355c39795decd7f5c1ad6af38a051b57f74e5a85..HEAD
git diff --check 355c39795decd7f5c1ad6af38a051b57f74e5a85..HEAD
```

Expected: only the approved design, plan, workflows, governance docs, guard tests, and dashboard package script are changed.

- [ ] **Step 2: Run root and dashboard verification**

Run:

```bash
node --test scripts/ci/deploy-source-guard.test.mjs
npm run typecheck
npm run build
npm test
npm ci --prefix web
npm --prefix web run typecheck
npm --prefix web run build
```

Expected: all commands exit `0`.

- [ ] **Step 3: Run documentation validation**

Run:

```bash
node scripts/ci/docs-links.mjs
node scripts/ci/diagrams-drift.mjs
node scripts/ci/runnable-blocks.mjs
node scripts/ci/docs-assets.mjs
```

Expected: all commands exit `0`. Run the Mermaid check separately if its pinned renderer can download; report a network limitation without claiming a pass when it cannot.

- [ ] **Step 4: Run a credential-free CDK synth**

Run in an Ubuntu/WSL shell from the Windows repository path:

```bash
node -e '
  const fs = require("fs");
  const p = "cdk.context.json";
  const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  c["availability-zones:account=111111111111:region=us-east-1"] = ["us-east-1a", "us-east-1b"];
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
'
env -u DOMAIN_NAME -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  CDK_DEFAULT_ACCOUNT=111111111111 \
  CDK_DEFAULT_REGION=us-east-1 \
  CCE_TIER=1 \
  CCE_IMAGE_TAG=ci \
  AWS_EC2_METADATA_DISABLED=true \
  npx cdk synth --quiet --output cdk.out
test "$(find cdk.out -maxdepth 1 -name '*.template.json' | wc -l)" -ge 10
```

Expected: at least 10 `cdk.out/*.template.json` files and no AWS API call.

- [ ] **Step 5: Commit any evidence-only documentation correction**

Only if a documentation error was found, commit the correction separately:

```bash
git add cutover.md CONTRIBUTING.md README.md .github/pull_request_template.md .github/CODEOWNERS
git commit -m "docs: correct cutover verification guidance"
```

Do not commit generated `dist`, `web/dist`, `cdk.out`, logs, or secret-bearing files.

---

### Task 6: Bootstrap GitHub branches and Environments without changing production authority

**Files:**
- Remote Git refs and GitHub Environment metadata only.

**Interfaces:**
- Consumes: baseline SHA `355c39795decd7f5c1ad6af38a051b57f74e5a85` and the verified governance branch.
- Produces: remote `development`, `qa`, `staging`, and `production` branches at the identical baseline plus four empty GitHub Environments.

- [ ] **Step 1: Reconfirm remote state immediately before mutation**

Run:

```bash
git fetch origin --prune
git rev-parse origin/main
git ls-remote --heads origin main development qa staging production
gh repo view emmanuelmadams4-lgtm/Netzer-Labs --json defaultBranchRef,visibility,viewerPermission
```

Stop if `origin/main` is not the recorded baseline or if any target branch exists at an unexpected SHA.

- [ ] **Step 2: Create missing long-lived branches from the baseline**

For each missing branch, push the exact baseline SHA:

```bash
git push origin 355c39795decd7f5c1ad6af38a051b57f74e5a85:refs/heads/development
git push origin 355c39795decd7f5c1ad6af38a051b57f74e5a85:refs/heads/qa
git push origin 355c39795decd7f5c1ad6af38a051b57f74e5a85:refs/heads/staging
git push origin 355c39795decd7f5c1ad6af38a051b57f74e5a85:refs/heads/production
```

Never force push. Skip a branch only when it already points to the exact baseline.

- [ ] **Step 3: Create the four GitHub Environments**

Run these idempotent requests. Add no secrets and no variables in this task.

```bash
gh api --method PUT repos/emmanuelmadams4-lgtm/Netzer-Labs/environments/development
gh api --method PUT repos/emmanuelmadams4-lgtm/Netzer-Labs/environments/qa
gh api --method PUT repos/emmanuelmadams4-lgtm/Netzer-Labs/environments/staging
gh api --method PUT repos/emmanuelmadams4-lgtm/Netzer-Labs/environments/production
```

- [ ] **Step 4: Verify branch and Environment creation**

Run:

```bash
git ls-remote --heads origin development qa staging production
gh api repos/emmanuelmadams4-lgtm/Netzer-Labs/environments --jq '.environments[].name'
```

Expected: all four refs point to the recorded baseline and all four Environment names are present.

- [ ] **Step 5: Keep the default branch and deployment authority unchanged**

Verify that the default branch is still `main`. Do not modify AWS OIDC trust, `CCE_GITHUB_BRANCH`, GitHub production-branch policy, or the deployed stacks.

---

### Task 7: Publish the governance branch and warm CI safely

**Files:**
- GitHub branch and pull-request metadata only.

**Interfaces:**
- Consumes: the verified `chore/netzar-os-repository-architecture` branch and remote `development` baseline.
- Produces: a reviewable bootstrap PR, then recorded workflow check names on the long-lived branches.

- [ ] **Step 1: Push the governance branch without force**

Run:

```bash
git push -u origin chore/netzar-os-repository-architecture
```

- [ ] **Step 2: Open the bootstrap PR into development**

Create a PR from `chore/netzar-os-repository-architecture` to `development` with this body, replacing only the PASS/FAIL result lines with the fresh Task 5 outcomes:

```markdown
## Summary
Bootstrap the Netzar OS promotion workflow and repository governance.

## Risk and rollback
Repository configuration only. Close or revert this PR to roll back; no AWS resources are changed.

## Validation evidence
- Deploy source guard: PASS/FAIL
- Root typecheck/build/unit tests: PASS/FAIL
- Dashboard typecheck/build: PASS/FAIL
- Documentation checks: PASS/FAIL
- Credential-free CDK synth: PASS/FAIL

## Deployment impact
- AWS deployment: none
- Live dashboard impact: none

## Bootstrap note
The first PR may not have target-branch checks because `development` started from the old workflow definition. Fresh local evidence is attached; the merge push must warm and pass the new checks before promotion continues.
```

- [ ] **Step 3: Review the PR diff before merge**

Confirm the PR contains no `.env`, secrets, generated build output, dependency upgrades, AWS resource renames, dashboard runtime changes, or branding migration.

- [ ] **Step 4: Merge the bootstrap PR only after review**

Use a merge commit so the bootstrap boundary is visible. Do not delete `main`, rewrite history, or change the default branch.

- [ ] **Step 5: Confirm the development push checks run and pass**

Wait for these workflow groups to record successful contexts on `development`:

- CI: root type-check/build/tests, dashboard type-check/build, LocalStack integration, hermetic synth, secret scan, rollback dry-run.
- Docs CI: links/runnable schema, Mermaid, diagram drift, asset budget.

Do not configure a required check until GitHub has recorded its exact context name.

- [ ] **Step 6: Promote governance configuration without AWS deployment**

Open and merge, one at a time, these PRs after the preceding branch checks are green:

```text
development -> qa
qa -> staging
staging -> production
```

Use merge commits. The Deploy workflow is manual-only; do not trigger it. Confirm push checks pass on each target branch before continuing.

---

### Task 8: Apply enforceable GitHub settings or stop at the plan boundary

**Files:**
- GitHub repository settings only.

**Interfaces:**
- Consumes: recorded check names and repository-plan capabilities.
- Produces: branch protections when supported, or an explicit blocked item when the GitHub plan does not support private-repository protections.

- [ ] **Step 1: Recheck repository-plan capabilities**

Read `main` protection and repository rulesets through the GitHub API.

Expected current result: HTTP `403` with `Upgrade to GitHub Pro or make this repository public to enable this feature.`

- [ ] **Step 2: Never make the repository public as a workaround**

Keep visibility `private`. Public visibility is not an acceptable substitute for branch protection because the repository contains proprietary deployment and security architecture.

- [ ] **Step 3: If protection APIs remain unavailable, record the blocker and stop authority cutover**

Do not claim `development`, `qa`, `staging`, `production`, or `main` is protected. Keep `main` as default and production-authorized. Point the operator to the exact GitHub Pro upgrade and protection checklist in `cutover.md`.

- [ ] **Step 4: If GitHub Pro is enabled, apply protections in dependency order**

For every long-lived branch: block force pushes and deletion, require pull requests and conversation resolution, and include administrators where supported. Then add only recorded check contexts. Require CODEOWNERS-compatible approval on `production`; require one approval on the other promotion branches when the available reviewer count makes that feasible.

- [ ] **Step 5: Configure Environment deployment branch policies after protection is available**

- `staging` Environment: only `staging`.
- `production` Environment: `main` and `production` during transition; only `production` after production proof.
- `development` and `qa`: no AWS deployment secrets or variables.

Do not add secret values through chat, tracked files, logs, or PR bodies.

---

### Task 9: Prove no dashboard or AWS change occurred

**Files:**
- Verification only.

**Interfaces:**
- Consumes: the local dashboard tunnel and the unchanged deployed checkout.
- Produces: final evidence that repository configuration did not mutate production.

- [ ] **Step 1: Verify the live checkout baseline and preserve its local PowerSwitch changes**

Run read-only commands in `/home/emmanueladams/projects/Netzer-Labs`:

```bash
git rev-parse HEAD
git status --short --branch
```

Expected HEAD: `355c39795decd7f5c1ad6af38a051b57f74e5a85`. Do not discard or overwrite the existing local modifications.

- [ ] **Step 2: Verify dashboard and Knowledge health without displaying the bearer token**

Use the locally stored token internally and print only status codes.

Expected:

```text
DASHBOARD_HEALTH_HTTP=200
KNOWLEDGE_API_HTTP=200
```

- [ ] **Step 3: Verify no deployment workflow ran**

List Actions runs created during the implementation window. Expected: only CI/Docs CI runs for pushes and PRs; no Deploy workflow run.

- [ ] **Step 4: Report the exact remaining cutover gates**

Report separately:

1. GitHub Pro/private branch-protection availability.
2. Production deployment proof from `production`.
3. Removal of `main` from the workflow and AWS OIDC ref allowlist.
4. Production Environment restriction to `production`.
5. Default branch change to `development`.
6. Separate Netzar OS public-brand migration plan.

Do not mark the overall production-authority cutover complete until all five authority gates are finished.
