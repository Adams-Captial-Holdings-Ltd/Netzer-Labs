# Security Posture and Gap Register

> This page records repository governance controls that are absent or disabled,
> what currently compensates for each one, and the risk that remains. It does
> not infer a GitHub plan limitation where the live API only proves that a
> control is unconfigured.

**Audience:** maintainers, and anyone doing security or procurement diligence on
Netzar OS. For vulnerability *reporting*, see [SECURITY.md](../SECURITY.md).

**Last reviewed:** 2026-08-28

---

## Summary

The application's own security posture is strong: deploys use short-lived OIDC
credentials with no long-lived AWS keys, CDK synth is hermetic and
credential-free, a secret scanner runs over synth artifacts and lifecycle
fixtures on every PR, rollback is exercised in CI, and workflow tokens default
to `contents: read`.

The material gaps are in **platform-level enforcement of process**. The current
private repository is owned by the `Adams-Captial-Holdings-Ltd` GitHub
Organization. Live API evidence shows no rulesets, no protected promotion
branches, and no Environment protection rules; this audit did not establish
which paid plan or organization policy is required to enable the desired
controls.

Consequence, stated plainly: **the promotion ladder and the review requirement
are conventions, not controls.** We detect violations; we cannot prevent them.

---

## Gap register

### G-1 — Branch protection cannot be enabled

| | |
|---|---|
| **Gap** | No branch is protected. `GET /repos/.../branches/{branch}/protection` returns `404 Branch not protected` for `production`, `staging`, `qa`, and `development`, and the repository rulesets endpoint returns an empty list. Force-pushes and direct commits are possible. |
| **Compensating control** | [`.github/workflows/branch-guard.yml`](../.github/workflows/branch-guard.yml) runs on every push to a promotion branch. A direct (non-merge) push, a merge from the wrong branch, or a force-push fails the job, notifies the admin, and leaves a permanent failed run in the Actions log. |
| **Residual risk** | **Detection, not prevention.** A bad push is already in the branch when the alarm fires. Recovery is manual: `git reflog` / the Actions log identifies the lost range, and it must be restored by hand. |
| **Closes when** | Organization owners select the necessary plan/policy and enable a tested branch/tag ruleset with no bypass for the commercial release path. |

### G-2 — Required reviews cannot be enforced

| | |
|---|---|
| **Gap** | [`.github/CODEOWNERS`](../.github/CODEOWNERS) declares ownership of `/infra/`, `/.github/`, and the deploy and rollback scripts, but nothing requires the review it describes. CODEOWNERS only takes effect through branch protection. |
| **Compensating control** | Single-maintainer repository, so in practice every change is authored by the code owner. `branch-guard` requires that promotion-branch changes arrive as merge commits, which keeps a pull request in the history of each promotion even when its review was self-administered. |
| **Residual risk** | No four-eyes guarantee. If a second collaborator is added, this gap becomes materially worse and should be re-evaluated before granting write access. |
| **Closes when** | Same as G-1, plus at least one independent reviewer/team replaces single-person self-review for commercial releases. |

### G-3 — Deployment environments have no protection rules

| | |
|---|---|
| **Gap** | The `production`, `staging`, `qa`, and `development` environments all report `protection_rules: []`, `deployment_branch_policy: null`, `can_admins_bypass: true`. No required reviewer, no wait timer, no branch restriction. |
| **Compensating control** | [`deploy.yml`](../.github/workflows/deploy.yml) is `workflow_dispatch`-only and requires the operator to type `deploy` into a confirmation input. `scripts/ci/deploy-source-guard.mjs` independently rejects a production deploy from any ref other than `refs/heads/production`, and the CDK OIDC trust is fail-closed on the exact repo and deploy subjects. |
| **Residual risk** | A prod deploy needs no second person's approval. The source guard constrains *which ref* deploys; it cannot constrain *who* triggers it. |
| **Closes when** | Organization owners enable required Environment reviewers, restrict deployment branches/tags, and disable administrator bypass for customer production. |

### G-4 — Auto-merge is disabled

| | |
|---|---|
| **Gap** | `allow_auto_merge` is currently `false`; this is workflow friction, not a commercial security blocker. The historical claim that the current plan cannot enable it was not re-proven. |
| **Compensating control** | None needed; merges are manual. Recorded here only so a future maintainer does not lose time to the silent failure. |
| **Residual risk** | None material. |
| **Closes when** | Enable only if maintainers want it after required-check and review controls are enforced. |

### G-5 — Organization audit-log controls are unverified

| | |
|---|---|
| **Gap** | The repository now lives in `Adams-Captial-Holdings-Ltd`, resolving the historical personal-account ownership finding. Audit-log availability, retention, export, alerting, and access review were not verified in this audit. |
| **Compensating control** | The Actions run history is an immutable record of every deploy, and `cdk-drift.yml` compares deployed infrastructure against source daily, catching out-of-band AWS changes regardless of who made them. AWS CloudTrail covers the account side. |
| **Residual risk** | Commercial evidence cannot yet show who changed repository settings, permissions, secrets, rules, or environments over the required retention period. |
| **Closes when** | Organization owners verify audit-log retention/access, configure export/alerts if required, and retain evidence of settings and permission changes. |

### G-6 — No code scanning or GitHub secret scanning

| | |
|---|---|
| **Gap** | Live repository settings report code security, secret scanning, and push protection disabled. The code-scanning API rejects access because Code Security is not enabled, and private vulnerability reporting is unavailable. |
| **Compensating control** | `scripts/ci/secret-scan.mjs` runs on every PR over the synthesized `cdk.out` and the lifecycle fixtures with a maintained denylist. `.gitignore` excludes all real `.env` variants; only `.example` and `.reference` files are tracked. Dependabot alerts and security updates **are** enabled and are free on private repos. |
| **Residual risk** | No static analysis for code-level vulnerability patterns. Secret scanning covers synth output and fixtures, not the entire source tree or git history. |
| **Closes when** | Enable GitHub Code Security/secret scanning/push protection/private reporting or an approved equivalent, then prove full-tree and history coverage plus alert ownership. |

---

## Accepted risks

### AR-1 — `exceljs` → `uuid` (GHSA-w5hq-g745-h8pq, moderate)

`exceljs@4.4.0` depends on a `uuid` version missing a buffer bounds check in
v3/v5/v6 — reachable **only when a caller supplies the optional `buf`
argument**, which this codebase does not do.

The only remediation npm offers is `exceljs@3.4.0`: a semver-major **downgrade**
from the installed `^4.4.0`, which would break Excel export. `npm audit fix
--force` will attempt exactly this.

**Decision: accept and hold.** `exceljs` is pinned to `>=4` in
[`.github/dependabot.yml`](../.github/dependabot.yml) so Dependabot does not
re-propose the downgrade. Revisit when an exceljs 4.x release moves off the
affected `uuid` line.

> **Never run `npm audit fix --force` in this repository.** Plain `npm audit
> fix` is safe and is what the remediation workflow uses.

### AR-2 — Development-only advisories

`vitest` (critical) and `aws-cdk-lib` (high) both carry advisories, and both are
`devDependencies` — absent from the runtime image, which installs production
dependencies only.

- **`vitest` / `@vitest/mocker`** — arbitrary file read/execute *while the
  Vitest UI server is listening*. The UI server is never started in CI or in
  the container.
- **`aws-cdk-lib`** — OS command injection in `NodejsFunction` Docker bundling.
  Build/synth-time, not in the running service.

**Decision: patch on the normal Dependabot cadence, not as an incident.** An
`aws-cdk-lib` bump must be verified with `npm run synth` and a diff of `cdk.out`
against the previous templates before it merges — a major bump can silently
move synthesized infrastructure.

---

## Verifying this page

The branch endpoint returns `404 Branch not protected` and the rulesets endpoint
returns an empty list while the gap is open:

```bash
gh api repos/Adams-Captial-Holdings-Ltd/Netzer-Labs/branches/production/protection
```
```bash
gh api repos/Adams-Captial-Holdings-Ltd/Netzer-Labs/rulesets
```

Environment protection state, and confirmation that Dependabot alerts are on
(`204`, not `404`):

```bash
gh api repos/Adams-Captial-Holdings-Ltd/Netzer-Labs/environments --jq '.environments[] | {name, protection_rules, can_admins_bypass}'
```
```bash
gh api repos/Adams-Captial-Holdings-Ltd/Netzer-Labs/vulnerability-alerts -i | head -1
```

Production-runtime advisories only, excluding the dev-only noise in AR-2:

```bash
npm audit --omit=dev --audit-level=high
```

---

## When governance is funded and approved

In priority order:

1. A ruleset on `production` and `staging`: require a pull request, require
   code-owner review, require the `CI`, `Docs CI`, `Hermetic CDK Synth`,
   `Secret Scan`, and `Branch Guard` checks, block force-push and deletion.
2. Restrict `production`'s allowed merge sources to `staging` — this converts
   `branch-guard` from the primary control into a redundant second check.
3. Required reviewers and a `deployment_branch_policy` on the `production` and
   `staging` environments; set `can_admins_bypass: false`.

**Historical migration hazard, now resolved by the organization transfer:**
`infra/lib/github-oidc.ts` builds the AWS OIDC trust from `CCE_GITHUB_OWNER`,
which [`deploy.yml`](../.github/workflows/deploy.yml) derives from
`github.repository_owner`. Transferring the repository changes the owner, so the
deployed `ClaudeClawGitHubDeploy` role can stop trusting the workflow. The
current repository is already organization-owned; any future owner/repository
rename must update customer trust in a customer-approved change before the old
subject is removed.
