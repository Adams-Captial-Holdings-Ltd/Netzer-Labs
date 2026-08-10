# Netzar OS GitHub Development and Shared QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a no-extra-cost, multi-computer GitHub development workflow that automatically deploys green `development` commits to one persistent T0 QA environment, promotes releases through protected branches, and reconciles QA to every production release with sanitized fixtures.

**Architecture:** Developers clone the private GitHub repository on any authorized computer and work in short-lived branches. GitHub Actions validates changes, assumes a QA-only AWS role through OIDC, renders an ephemeral `.env.qa`, and calls the Netzer lifecycle instead of CDK directly. Production remains manual, signed releases remain client-approved, and a post-release workflow resets QA data and proves manifest parity.

**Tech Stack:** GitHub Actions, Node.js 20+, TypeScript, Node test runner/Vitest, AWS SDK v3, AWS OIDC, S3, DynamoDB, ECS/CDK through existing Netzer lifecycle commands.

## Global Constraints

- GitHub Codespaces is optional and paid; no task may require it.
- Normal work moves `feature/* -> development -> qa -> staging -> production` through pull requests.
- A green `development` commit deploys automatically to the single persistent QA environment.
- QA uses tier T0, stack prefix `CCE-QA`, resource suffix `qa`, `infra-only` mode, and a $1/day Bedrock cap.
- The approved QA fixed cost is approximately $65-95 per month plus bounded Bedrock usage.
- `--yes` is authorized only for the pre-approved QA T0 workflow. A production workflow may use it only after its existing explicit human confirmation gate.
- Never call bare `cdk deploy`; use `npm run up`, `npm run deploy`, `npm run verify`, and other repository lifecycle commands.
- Never run `npm run destroy` as part of development, QA, reconciliation, rollback, or release automation.
- Use GitHub OIDC and short-lived AWS credentials; never store AWS access keys.
- Never copy client production data, knowledge, credentials, secrets, or model configuration into QA.
- Do not use `salessly.io` or expose an anonymous public QA dashboard.
- Client installations remain separate and require a client-approved update window.
- Run the full `npm test` before every push, plus the documentation checks for documentation changes.

## File Structure

- `.github/workflows/deploy-qa.yml`: automatic QA deployment after the existing CI workflow succeeds on `development`.
- `.github/workflows/reconcile-qa.yml`: post-release QA reset, redeploy, and parity proof.
- `.github/workflows/deploy.yml`: manual production deploy migrated from direct CDK to the Netzer lifecycle.
- `scripts/ci/deploy-source-guard.mjs`: fail-closed source policy for QA, staging, and production.
- `scripts/ci/deploy-source-guard.test.mjs`: source-policy tests.
- `scripts/ci/render-qa-env.mjs`: validate inputs and write the ephemeral `.env.qa` without logging values.
- `scripts/ci/render-qa-env.test.mjs`: renderer tests using synthetic values only.
- `scripts/ci/workflow-contract.test.mjs`: static GitHub workflow safety contract.
- `scripts/ci/qa-parity.ts`: compare production and QA lifecycle manifests with explicit allowed differences.
- `scripts/ci/qa-parity.test.ts`: parity tests.
- `scripts/qa/reset.ts`: QA-only guarded data reset and fixture seed.
- `scripts/qa/reset.test.ts`: target guard, purge pagination, and fixture-version tests.
- `scripts/power-setup.ts`: add `--env=<name>` support and remove bare-CDK remediation.
- `scripts/power-setup.test.ts`: environment resolution tests.
- `package.json`: add QA reset/parity scripts.
- `docs/development.md`, `docs/deployment.md`, `docs/github-to-aws.md`: activation and operator instructions.

---

### Task 1: Fail-Closed QA Deployment Source Policy

**Files:**
- Modify: `scripts/ci/deploy-source-guard.mjs`
- Modify: `scripts/ci/deploy-source-guard.test.mjs`

**Interfaces:**
- Consumes: `TARGET_ENV`, `GITHUB_REF`, and `CCE_RECONCILE_RELEASE` from a workflow.
- Produces: `validateDeploySource({ targetEnv, ref, allowLegacyMain, reconcileRelease }): { allowed: boolean; reason: string }`.

- [ ] **Step 1: Add failing QA source tests**

```js
test('qa accepts development only for normal deploys', () => {
  assert.equal(validateDeploySource({ targetEnv: 'qa', ref: 'refs/heads/development' }).allowed, true);
  for (const ref of ['refs/heads/qa', 'refs/heads/staging', 'refs/heads/production', 'refs/heads/feature/x']) {
    assert.equal(validateDeploySource({ targetEnv: 'qa', ref }).allowed, false);
  }
});

test('qa reconciliation accepts final semver tags only', () => {
  assert.equal(validateDeploySource({ targetEnv: 'qa', ref: 'refs/tags/v1.2.3', reconcileRelease: true }).allowed, true);
  for (const ref of ['refs/tags/rc/v1.2.3', 'refs/tags/v1.2', 'refs/heads/production']) {
    assert.equal(validateDeploySource({ targetEnv: 'qa', ref, reconcileRelease: true }).allowed, false);
  }
});
```

- [ ] **Step 2: Run the tests and confirm failure**

Run: `node --test scripts/ci/deploy-source-guard.test.mjs`  
Expected: FAIL because `targetEnv: 'qa'` is unsupported.

- [ ] **Step 3: Implement the QA branch and tag policy**

```js
const FINAL_RELEASE_REF = /^refs\/tags\/v\d+\.\d+\.\d+$/;

if (targetEnv === 'qa') {
  const allowed = reconcileRelease
    ? FINAL_RELEASE_REF.test(ref)
    : ref === 'refs/heads/development';
  return {
    allowed,
    reason: allowed
      ? reconcileRelease ? 'qa release reconciliation source accepted' : 'qa development source accepted'
      : reconcileRelease ? 'qa reconciliation requires refs/tags/v<major>.<minor>.<patch>' : 'qa deploys require refs/heads/development',
  };
}
```

Pass `reconcileRelease: process.env.CCE_RECONCILE_RELEASE === '1'` in the CLI entrypoint.

- [ ] **Step 4: Run the source-policy tests**

Run: `node --test scripts/ci/deploy-source-guard.test.mjs`  
Expected: PASS for QA, staging, production, legacy-main transition, and fail-closed unknown targets.

- [ ] **Step 5: Commit**

```bash
git add scripts/ci/deploy-source-guard.mjs scripts/ci/deploy-source-guard.test.mjs
git commit -m "test(ci): guard automatic qa deployment sources"
```

### Task 2: Render an Ephemeral QA Environment Safely

**Files:**
- Create: `scripts/ci/render-qa-env.mjs`
- Create: `scripts/ci/render-qa-env.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: a plain object with repository variables and GitHub `qa` Environment secrets.
- Produces: `renderQaEnv(input): string` and CLI output file `.env.qa` with mode `0600`; stdout contains key names only.

- [ ] **Step 1: Write failing renderer tests**

```js
test('renders the fixed isolated QA identity', () => {
  const text = renderQaEnv({
    AWS_ACCOUNT_ID: '111111111111',
    AWS_REGION: 'us-east-1',
    QA_DASHBOARD_TOKEN: 'synthetic-dashboard-token',
    QA_APP_ENCRYPTION_KEY: 'a'.repeat(64),
  });
  assert.match(text, /^CDK_STACK_NAME=CCE-QA$/m);
  assert.match(text, /^CCE_NAME_SUFFIX=qa$/m);
  assert.match(text, /^ECR_REPO_NAME=claudeclaw-qa-orchestrator$/m);
  assert.match(text, /^DEPLOY_TIER=0$/m);
  assert.match(text, /^CCE_DEPLOY_MODE=infra-only$/m);
  assert.match(text, /^CCE_DAILY_COST_CAP_USD=1$/m);
});

test('refuses missing or placeholder secrets', () => {
  assert.throws(() => renderQaEnv({ AWS_ACCOUNT_ID: '111111111111' }), /QA_DASHBOARD_TOKEN/);
  assert.throws(() => renderQaEnv({
    AWS_ACCOUNT_ID: '111111111111',
    QA_DASHBOARD_TOKEN: 'REPLACE_ME',
    QA_APP_ENCRYPTION_KEY: 'a'.repeat(64),
  }), /placeholder/i);
});
```

- [ ] **Step 2: Run the tests and confirm failure**

Run: `node --test scripts/ci/render-qa-env.test.mjs`  
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic rendering and validation**

```js
export function renderQaEnv(input) {
  const required = ['AWS_ACCOUNT_ID', 'QA_DASHBOARD_TOKEN', 'QA_APP_ENCRYPTION_KEY'];
  for (const key of required) {
    const value = String(input[key] ?? '').trim();
    if (!value) throw new Error(`${key} is required`);
    if (/replace[_ -]?me|example/i.test(value)) throw new Error(`${key} contains a placeholder`);
  }
  if (!/^\d{12}$/.test(input.AWS_ACCOUNT_ID)) throw new Error('AWS_ACCOUNT_ID must contain 12 digits');
  const values = {
    AWS_ACCOUNT_ID: input.AWS_ACCOUNT_ID,
    AWS_REGION: input.AWS_REGION || 'us-east-1',
    CDK_STACK_NAME: 'CCE-QA',
    CCE_NAME_SUFFIX: 'qa',
    ECR_REPO_NAME: 'claudeclaw-qa-orchestrator',
    DEPLOY_TIER: '0',
    CCE_TIER: '0',
    CCE_DEPLOY_MODE: 'infra-only',
    CCE_DAILY_COST_CAP_USD: '1',
    CCE_COST_CAP_ENFORCED: '1',
    DASHBOARD_TOKEN: input.QA_DASHBOARD_TOKEN,
    APP_ENCRYPTION_KEY: input.QA_APP_ENCRYPTION_KEY,
    SECURITY_PIN_HASH: input.QA_SECURITY_PIN_HASH || '',
    EMERGENCY_KILL_PHRASE: input.QA_EMERGENCY_KILL_PHRASE || '',
    BEDROCK_DEFAULT_MODEL: input.BEDROCK_DEFAULT_MODEL || '',
    BEDROCK_SONNET_MODEL: input.BEDROCK_SONNET_MODEL || '',
    BEDROCK_HAIKU_MODEL: input.BEDROCK_HAIKU_MODEL || '',
    BEDROCK_OPUS_MODEL: input.BEDROCK_OPUS_MODEL || '',
    BEDROCK_EMBED_MODEL: input.BEDROCK_EMBED_MODEL || 'amazon.titan-embed-text-v2:0',
  };
  return Object.entries(values).filter(([, value]) => value !== '').map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}
```

The CLI accepts `--output=.env.qa`, writes with `{ mode: 0o600 }`, and prints only `wrote .env.qa with <count> validated keys`.

- [ ] **Step 4: Ensure every named environment file is ignored**

Add `.env.*` with explicit negations for checked-in examples:

```gitignore
.env.*
!.env.*.example
```

- [ ] **Step 5: Run renderer and secret-scan tests**

Run: `node --test scripts/ci/render-qa-env.test.mjs`  
Expected: PASS.  
Run: `node scripts/ci/secret-scan.mjs --denylist scripts/ci/denylist.txt scripts/ci/render-qa-env.mjs scripts/ci/render-qa-env.test.mjs`  
Expected: `secret-scan: clean`.

- [ ] **Step 6: Commit**

```bash
git add .gitignore scripts/ci/render-qa-env.mjs scripts/ci/render-qa-env.test.mjs
git commit -m "feat(ci): render isolated qa configuration"
```

### Task 3: Automatic Development-to-QA Deployment

**Files:**
- Create: `.github/workflows/deploy-qa.yml`
- Create: `scripts/ci/workflow-contract.test.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: successful `CI` workflow runs on `development`, GitHub variable `QA_DEPLOY_ROLE_ARN`, repository variable `AWS_ACCOUNT_ID`, and QA Environment secrets from Task 2.
- Produces: a verified T0 QA deployment whose lifecycle manifest `gitSha` equals `workflow_run.head_sha`.

- [ ] **Step 1: Write a failing workflow contract test**

```js
test('qa deploy waits for green CI and uses the lifecycle', () => {
  const yaml = readFileSync('.github/workflows/deploy-qa.yml', 'utf8');
  assert.match(yaml, /workflow_run:/);
  assert.match(yaml, /branches:\s*\[development\]/);
  assert.match(yaml, /conclusion\s*==\s*'success'/);
  assert.match(yaml, /environment:\s*qa/);
  assert.match(yaml, /id-token:\s*write/);
  assert.match(yaml, /npm run up -- --env=qa --yes --json/);
  assert.doesNotMatch(yaml, /npx cdk deploy|npm run destroy/);
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `node --test scripts/ci/workflow-contract.test.mjs`  
Expected: FAIL because `deploy-qa.yml` does not exist.

- [ ] **Step 3: Create the QA workflow**

Use this job sequence in `.github/workflows/deploy-qa.yml`:

```yaml
name: Deploy QA
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [development]
concurrency:
  group: deploy-qa
  cancel-in-progress: false
permissions:
  contents: read
  id-token: write
jobs:
  deploy:
    if: github.event.workflow_run.conclusion == 'success'
    environment: qa
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci --ignore-scripts
      - name: Guard source
        env:
          TARGET_ENV: qa
          GITHUB_REF: refs/heads/development
        run: node scripts/ci/deploy-source-guard.mjs
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.QA_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1
          role-session-name: netzar-qa-${{ github.run_id }}
      - name: Verify AWS identity
        run: test "$(aws sts get-caller-identity --query Account --output text)" = "${{ vars.AWS_ACCOUNT_ID }}"
      - name: Render QA environment
        env:
          AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
          QA_DASHBOARD_TOKEN: ${{ secrets.QA_DASHBOARD_TOKEN }}
          QA_APP_ENCRYPTION_KEY: ${{ secrets.QA_APP_ENCRYPTION_KEY }}
          QA_SECURITY_PIN_HASH: ${{ secrets.QA_SECURITY_PIN_HASH }}
          QA_EMERGENCY_KILL_PHRASE: ${{ secrets.QA_EMERGENCY_KILL_PHRASE }}
          BEDROCK_DEFAULT_MODEL: ${{ vars.BEDROCK_DEFAULT_MODEL }}
          BEDROCK_SONNET_MODEL: ${{ vars.BEDROCK_SONNET_MODEL }}
          BEDROCK_HAIKU_MODEL: ${{ vars.BEDROCK_HAIKU_MODEL }}
          BEDROCK_OPUS_MODEL: ${{ vars.BEDROCK_OPUS_MODEL }}
        run: node scripts/ci/render-qa-env.mjs --output=.env.qa
      - name: Deploy and verify QA
        run: npm run up -- --env=qa --yes --json
      - name: Wire power controls
        run: npm run power:setup -- --env=qa
```

- [ ] **Step 4: Add the workflow contract to CI**

After dependency installation in the main `verify` job, add:

```yaml
- name: Workflow safety contracts
  run: node --test scripts/ci/*.test.mjs
```

- [ ] **Step 5: Run tests**

Run: `node --test scripts/ci/*.test.mjs`  
Expected: PASS.  
Run: `npm test`  
Expected: PASS with the complete Vitest suite.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/deploy-qa.yml scripts/ci/workflow-contract.test.mjs
git commit -m "feat(ci): deploy green development commits to qa"
```

### Task 4: Environment-Aware Power Setup

**Files:**
- Modify: `scripts/power-setup.ts`
- Create: `scripts/power-setup.test.ts`

**Interfaces:**
- Consumes: `--env=qa` and `.env.qa` through existing `resolveEnvFlag`, `envFileNameFor`, and `parseEnvFile` helpers.
- Produces: `resolvePowerSetupContext(argv, cwd): { region: string; stack: string; envFlag: string }` and the existing runtime-config `power/url` write.

- [ ] **Step 1: Write failing context tests**

```ts
it('resolves qa from .env.qa', () => {
  writeFileSync(join(dir, '.env.qa'), 'AWS_REGION=us-east-1\nCDK_STACK_NAME=CCE-QA\n');
  expect(resolvePowerSetupContext(['--env=qa'], dir)).toEqual({
    envFlag: 'qa',
    region: 'us-east-1',
    stack: 'CCE-QA-PowerSwitch',
  });
});

it('does not recommend bare cdk when the stack is missing', () => {
  expect(powerStackMissingMessage('CCE-QA-PowerSwitch', 'qa')).toContain('npm run up -- --env=qa');
  expect(powerStackMissingMessage('CCE-QA-PowerSwitch', 'qa')).not.toContain('cdk deploy');
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npx vitest run scripts/power-setup.test.ts`  
Expected: FAIL because the exported helpers do not exist.

- [ ] **Step 3: Move environment resolution inside `main`**

Use the existing env-file helpers, let file values override ambient values, and add `--env=<name>` to help. Replace the missing-stack remediation with:

```ts
export function powerStackMissingMessage(stack: string, envFlag: string): string {
  return `Stack ${stack} not found. Run the Netzer lifecycle first: npm run up -- --env=${envFlag}`;
}
```

Do not change `--show-token` behavior, but never use it in GitHub Actions.

- [ ] **Step 4: Run focused and full tests**

Run: `npx vitest run scripts/power-setup.test.ts`  
Expected: PASS.  
Run: `npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/power-setup.ts scripts/power-setup.test.ts
git commit -m "fix(power): support namespaced qa setup"
```

### Task 5: QA Manifest Parity Proof

**Files:**
- Create: `scripts/ci/qa-parity.ts`
- Create: `scripts/ci/qa-parity.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: production and QA `DeployManifest` values from `manifests/latest.json` in their lifecycle state buckets.
- Produces: `compareQaToProduction(prod, qa): ParityIssue[]` and `npm run qa:parity -- --env=qa`.

- [ ] **Step 1: Write failing parity tests**

```ts
it('accepts intentional tier and namespace differences', () => {
  expect(compareQaToProduction(prod, {
    ...prod,
    tier: 0,
    account: prod.account,
    ecrRepo: 'claudeclaw-qa-orchestrator',
    synthInputs: { ...prod.synthInputs, CDK_STACK_NAME: 'CCE-QA', CCE_NAME_SUFFIX: 'qa', CCE_TIER: '0' },
  })).toEqual([]);
});

it('reports stale code, schema, feature flags, and model IDs together', () => {
  const issues = compareQaToProduction(prod, {
    ...prod,
    gitSha: 'b'.repeat(40),
    appSchemaVersion: prod.appSchemaVersion + 1,
    featureFlags: { ...prod.featureFlags, knowledge: false },
    synthInputs: { ...prod.synthInputs, BEDROCK_DEFAULT_MODEL: 'different-model' },
  });
  expect(issues.map((issue) => issue.id)).toEqual(['git-sha', 'app-schema', 'feature-flags', 'bedrock-models']);
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npx vitest run scripts/ci/qa-parity.test.ts`  
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement explicit parity rules**

Compare `gitSha`, `appSchemaVersion`, `featureFlags`, and the five `BEDROCK_*_MODEL` synth inputs. Allow only `tier`, stack/resource names, ECR repository, domain/certificate, deployment timestamps, secret version IDs, seed revision, and expected T0 capacity to differ. Return all issues in stable order and never print secret values.

The CLI must use `resolveStateNames()` and `readLatestManifest()` twice: production with suffix `''`, QA with suffix `qa`. It exits 0 with one JSON envelope when no issues exist and exits 1 with issue IDs when drift exists.

- [ ] **Step 4: Add the package script**

```json
"qa:parity": "tsx scripts/ci/qa-parity.ts"
```

- [ ] **Step 5: Run focused and full tests**

Run: `npx vitest run scripts/ci/qa-parity.test.ts`  
Expected: PASS.  
Run: `npm test`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/ci/qa-parity.ts scripts/ci/qa-parity.test.ts
git commit -m "feat(ci): prove qa production parity"
```

### Task 6: QA-Only Synthetic Data Reset

**Files:**
- Create: `scripts/qa/reset.ts`
- Create: `scripts/qa/reset.test.ts`
- Create: `scripts/qa/fixtures.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: exactly `--env=qa --confirm=reset-qa`, `.env.qa`, and versioned synthetic fixture revision `2026-08-09.1`.
- Produces: a typed JSON summary containing table delete counts, S3 delete counts, fixture revision, and no record contents.

- [ ] **Step 1: Write target-guard and purge tests**

```ts
it('refuses every target except qa', () => {
  for (const envFlag of ['prod', 'production', 'staging', 'development']) {
    expect(() => assertQaResetTarget(envFlag, 'CCE-QA', 'reset-qa')).toThrow(/QA only/);
  }
});

it('requires both the QA stack prefix and confirmation', () => {
  expect(() => assertQaResetTarget('qa', 'CCE', 'reset-qa')).toThrow(/CCE-QA/);
  expect(() => assertQaResetTarget('qa', 'CCE-QA', '')).toThrow(/--confirm=reset-qa/);
});

it('paginates and deletes index and upload objects', async () => {
  const result = await purgeQaObjects(fakeS3, 'qa-vectors-bucket');
  expect(result).toEqual({ index: 3, uploads: 2 });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npx vitest run scripts/qa/reset.test.ts`  
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the reset guard before any AWS client is created**

```ts
export function assertQaResetTarget(envFlag: string, stack: string, confirmation: string): void {
  if (envFlag !== 'qa') throw new Error('QA only: --env=qa is required');
  if (stack !== 'CCE-QA') throw new Error('QA only: CDK_STACK_NAME must be CCE-QA');
  if (confirmation !== 'reset-qa') throw new Error('QA reset requires --confirm=reset-qa');
}
```

After the guard passes, delete all items from the QA conversational tables using `DescribeTable`, paginated `Scan`, and 25-item `BatchWrite` requests with unprocessed-item retries. Purge every object under `index/` and `uploads/` in the QA vectors bucket using paginated `ListObjectsV2` and 1,000-key `DeleteObjects` batches. Never touch buckets or tables whose resolved names do not start with `claudeclaw-qa-`.

Seed only the synthetic fixture file. `fixtures.json` contains fictional agents and knowledge under the `Beacon` example already used by the repository, plus `fixtureRevision: "2026-08-09.1"`. Store that revision in runtime-config as `qa/fixture_revision`.

- [ ] **Step 4: Add the package script**

```json
"qa:reset": "tsx scripts/qa/reset.ts"
```

- [ ] **Step 5: Run focused and full tests**

Run: `npx vitest run scripts/qa/reset.test.ts`  
Expected: PASS.  
Run: `npm test`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/qa/reset.ts scripts/qa/reset.test.ts scripts/qa/fixtures.json
git commit -m "feat(qa): reset to versioned synthetic fixtures"
```

### Task 7: Reconcile QA After a Signed Production Release

**Files:**
- Create: `.github/workflows/reconcile-qa.yml`
- Modify: `scripts/ci/workflow-contract.test.mjs`

**Interfaces:**
- Consumes: a published final `v<major>.<minor>.<patch>` GitHub release and the same QA Environment configuration used by `deploy-qa.yml`.
- Produces: QA deployed at the release commit, refreshed synthetic data, and a green parity result before normal automatic QA deployment resumes.

- [ ] **Step 1: Add failing reconciliation workflow assertions**

```js
test('release reconciliation is final-tag-only and qa-scoped', () => {
  const yaml = readFileSync('.github/workflows/reconcile-qa.yml', 'utf8');
  assert.match(yaml, /release:\s*\n\s*types:\s*\[published\]/);
  assert.match(yaml, /environment:\s*qa/);
  assert.match(yaml, /CCE_RECONCILE_RELEASE:\s*'1'/);
  assert.match(yaml, /npm run qa:reset -- --env=qa --confirm=reset-qa/);
  assert.match(yaml, /npm run qa:parity -- --env=qa/);
  assert.doesNotMatch(yaml, /npm run destroy|npx cdk deploy/);
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `node --test scripts/ci/workflow-contract.test.mjs`  
Expected: FAIL because `reconcile-qa.yml` does not exist.

- [ ] **Step 3: Create the release reconciliation workflow**

Use the `qa` concurrency group so automatic development deploys wait while reconciliation runs. Check out `github.event.release.tag_name`, reject drafts/prereleases and non-final tags with Task 1's source guard, configure the QA OIDC role, render `.env.qa`, run `npm run up -- --env=qa --yes --json`, run the guarded QA reset, and finish with `npm run qa:parity -- --env=qa`.

The workflow must not continue if release signature verification fails. Invoke the existing `verifyReleaseArtifacts()` path with the release's `metadata.json`, `artifact-manifest.json`, `signature.json`, and `promotion-attestation.json` before AWS authentication.

- [ ] **Step 4: Run workflow contracts and full tests**

Run: `node --test scripts/ci/*.test.mjs`  
Expected: PASS.  
Run: `npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/reconcile-qa.yml scripts/ci/workflow-contract.test.mjs
git commit -m "feat(ci): reconcile qa after signed releases"
```

### Task 8: Remove Direct CDK from the Manual Production Workflow

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `scripts/ci/workflow-contract.test.mjs`
- Modify: `docs/github-to-aws.md`

**Interfaces:**
- Consumes: the existing manual `confirm=deploy` gate on `production` and production GitHub Environment values.
- Produces: a manual production deploy that invokes the Netzer lifecycle and retains human approval.

- [ ] **Step 1: Add a failing repository-wide direct-CDK assertion**

```js
test('deployment workflows use only Netzer lifecycle entrypoints', () => {
  for (const file of ['deploy.yml', 'deploy-qa.yml', 'reconcile-qa.yml']) {
    const yaml = readFileSync(`.github/workflows/${file}`, 'utf8');
    assert.doesNotMatch(yaml, /npx cdk deploy|npm run destroy/);
  }
  const prod = readFileSync('.github/workflows/deploy.yml', 'utf8');
  assert.match(prod, /workflow_dispatch:/);
  assert.match(prod, /inputs\.confirm == 'deploy'/);
  assert.match(prod, /npm run up -- --yes --json/);
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `node --test scripts/ci/workflow-contract.test.mjs`  
Expected: FAIL because the current production workflow calls `npx cdk deploy --all`.

- [ ] **Step 3: Replace build/CDK/smoke duplication with the lifecycle**

Keep `workflow_dispatch`, source guard, `confirm=deploy`, OIDC, production Environment, and AWS identity assertion. Render the production env from production Environment values without printing secrets, then call:

```yaml
- name: Deploy and verify production
  if: inputs.confirm == 'deploy'
  run: npm run up -- --yes --json
```

Do not add a scheduled or push trigger. Remove the paid staging-stack option because `staging` is now a logical release-candidate gate using QA.

- [ ] **Step 4: Update GitHub-to-AWS documentation**

Document exact OIDC subjects:

```text
repo:emmanuelmadams4-lgtm/Netzer-Labs:environment:qa
repo:emmanuelmadams4-lgtm/Netzer-Labs:environment:production
```

State that QA is automatic only after CI on `development`, production is manual only, and neither workflow stores AWS keys.

- [ ] **Step 5: Run tests**

Run: `node --test scripts/ci/*.test.mjs`  
Expected: PASS.  
Run: `npm test`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/deploy.yml scripts/ci/workflow-contract.test.mjs docs/github-to-aws.md
git commit -m "fix(ci): route production through Netzer lifecycle"
```

### Task 9: Activation Checklist, Documentation, and Final Verification

**Files:**
- Modify: `docs/development.md`
- Modify: `docs/deployment.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-08-09-netzar-os-cross-device-development-design.md`

**Interfaces:**
- Consumes: implemented workflows and scripts from Tasks 1-8.
- Produces: exact operator activation steps and evidence that the branch is safe to promote.

- [ ] **Step 1: Add the GitHub activation checklist**

Document these exact settings without secret values:

```text
Repository variables:
  AWS_ACCOUNT_ID
  QA_DEPLOY_ROLE_ARN
  BEDROCK_DEFAULT_MODEL
  BEDROCK_SONNET_MODEL
  BEDROCK_HAIKU_MODEL
  BEDROCK_OPUS_MODEL

GitHub Environment: qa
  Branch policy: development and final v* tags through the named workflows
  Secrets: QA_DASHBOARD_TOKEN, QA_APP_ENCRYPTION_KEY,
           QA_SECURITY_PIN_HASH, QA_EMERGENCY_KILL_PHRASE

GitHub Environment: production
  Branch policy: production only
  Human confirmation: required by the manual workflow input and repository protection
```

State that secret values are entered directly in GitHub or generated during the one-time QA bootstrap and are never pasted into an issue, pull request, log, or chat.

- [ ] **Step 2: Document branch protection**

Require pull requests, conversation resolution, no deletion, no force push, and successful CI for `development`, `qa`, `staging`, and `production`. Set the default branch to `development`; preserve protected `main` as legacy history.

- [ ] **Step 3: Run the full repository verification**

Run:

```bash
npm run typecheck
npm run build
npm --prefix web run typecheck
npm --prefix web run build
npm test
npm run test:integration:all
node --test scripts/ci/*.test.mjs
node scripts/ci/docs-links.mjs
node scripts/ci/diagrams-drift.mjs
node scripts/ci/runnable-blocks.mjs
node scripts/ci/docs-mermaid.mjs
git diff --check
git status --short
```

Expected: every command exits 0; Git status contains only intentional implementation files before the final commit.

- [ ] **Step 4: Run a credential-free workflow review**

Confirm no workflow contains AWS key variable names, `npx cdk deploy`, `npm run destroy`, `pull_request_target`, or a production `push`/`schedule` trigger:

```bash
rg -n "AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|npx cdk deploy|npm run destroy|pull_request_target|schedule:" .github/workflows
```

Expected: no unsafe deployment workflow match. Test-only LocalStack credentials in `ci.yml` may remain because they are fixed fake values scoped to LocalStack.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/development.md docs/deployment.md docs/README.md docs/superpowers/specs/2026-08-09-netzar-os-cross-device-development-design.md
git commit -m "docs: activate portable development and qa promotion"
```

- [ ] **Step 6: Open the implementation pull request**

Push the feature branch and open a pull request into `development`. Do not target `qa`, `staging`, or `production` directly. The pull-request description must record the approved QA T0 cost, verification commands, OIDC setup still requiring a repository owner, and the explicit statement that no AWS deployment was performed while implementing the branch.

## Plan Self-Review

- Every approved design requirement maps to a task: portable development documentation, automatic QA, lifecycle-only deploys, power setup, protected promotion, signed-release reconciliation, data refresh, parity proof, private credentials, cost controls, and client approval.
- The plan contains no incomplete implementation markers.
- Interfaces use `qa`, `CCE-QA`, `qa` resource suffix, T0, `infra-only`, and `$1/day` consistently.
- Production remains manual and client installation remains outside repository automation.
