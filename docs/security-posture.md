# Security Posture and Gap Register

> This page records the governance controls this repository **cannot enforce**
> at its current GitHub plan tier, what compensates for each one, and the risk
> that remains after the compensation. It exists so that the gaps are known
> gaps rather than unknown ones.

**Audience:** maintainers, and anyone doing security or procurement diligence on
Netzar OS. For vulnerability *reporting*, see [SECURITY.md](../SECURITY.md).

**Last reviewed:** 2026-08-12

---

## Summary

The application's own security posture is strong: deploys use short-lived OIDC
credentials with no long-lived AWS keys, CDK synth is hermetic and
credential-free, a secret scanner runs over synth artifacts and lifecycle
fixtures on every PR, rollback is exercised in CI, and workflow tokens default
to `contents: read`.

The gaps are all in **platform-level enforcement of process**, and they share a
single root cause: this is a private repository on **GitHub Free**. Branch
protection, rulesets, and environment protection rules are Pro/Team features on
private repos. The GitHub API returns `403 "Upgrade to GitHub Pro"` for all of
them.

Consequence, stated plainly: **the promotion ladder and the review requirement
are conventions, not controls.** We detect violations; we cannot prevent them.

---

## Gap register

### G-1 — Branch protection cannot be enabled

| | |
|---|---|
| **Gap** | No branch is protected. `GET /repos/.../branches/{branch}/protection` returns `403` for `production`, `staging`, `qa`, and `development`. Force-pushes and direct commits to any branch are possible. |
| **Compensating control** | [`.github/workflows/branch-guard.yml`](../.github/workflows/branch-guard.yml) runs on every push to a promotion branch. A direct (non-merge) push, a merge from the wrong branch, or a force-push fails the job, notifies the admin, and leaves a permanent failed run in the Actions log. |
| **Residual risk** | **Detection, not prevention.** A bad push is already in the branch when the alarm fires. Recovery is manual: `git reflog` / the Actions log identifies the lost range, and it must be restored by hand. |
| **Closes when** | The account moves to GitHub Pro (personal, ~$4/mo) or an organization on Team. Both unlock branch protection and rulesets on private repos. |

### G-2 — Required reviews cannot be enforced

| | |
|---|---|
| **Gap** | [`.github/CODEOWNERS`](../.github/CODEOWNERS) declares ownership of `/infra/`, `/.github/`, and the deploy and rollback scripts, but nothing requires the review it describes. CODEOWNERS only takes effect through branch protection. |
| **Compensating control** | Single-maintainer repository, so in practice every change is authored by the code owner. `branch-guard` requires that promotion-branch changes arrive as merge commits, which keeps a pull request in the history of each promotion even when its review was self-administered. |
| **Residual risk** | No four-eyes guarantee. If a second collaborator is added, this gap becomes materially worse and should be re-evaluated before granting write access. |
| **Closes when** | Same as G-1. |

### G-3 — Deployment environments have no protection rules

| | |
|---|---|
| **Gap** | The `production`, `staging`, `qa`, and `development` environments all report `protection_rules: []`, `deployment_branch_policy: null`, `can_admins_bypass: true`. No required reviewer, no wait timer, no branch restriction. |
| **Compensating control** | [`deploy.yml`](../.github/workflows/deploy.yml) is `workflow_dispatch`-only and requires the operator to type `deploy` into a confirmation input. `scripts/ci/deploy-source-guard.mjs` independently rejects a production deploy from any ref other than `refs/heads/production`, and the CDK OIDC trust is fail-closed on the exact repo and deploy subjects. |
| **Residual risk** | A prod deploy needs no second person's approval. The source guard constrains *which ref* deploys; it cannot constrain *who* triggers it. |
| **Closes when** | Same as G-1 — required reviewers on environments are a Pro/Team feature on private repos. |

### G-4 — Auto-merge cannot be enabled

| | |
|---|---|
| **Gap** | `allow_auto_merge` cannot be turned on. The API accepts the `PATCH` with a `200` and silently leaves the field `false` — a plan limitation surfaced as a no-op rather than an error. |
| **Compensating control** | None needed; merges are manual. Recorded here only so a future maintainer does not lose time to the silent failure. |
| **Residual risk** | None material. |
| **Closes when** | Same as G-1. |

### G-5 — No organization audit log

| | |
|---|---|
| **Gap** | The repository lives on a personal account (`GET /user/orgs` is empty), so there is no organization audit log for settings changes, permission grants, or secret access. |
| **Compensating control** | The Actions run history is an immutable record of every deploy, and `cdk-drift.yml` compares deployed infrastructure against source daily, catching out-of-band AWS changes regardless of who made them. AWS CloudTrail covers the account side. |
| **Residual risk** | Changes to GitHub repository settings themselves are unlogged. |
| **Closes when** | The repository moves into an organization. |

### G-6 — No code scanning or GitHub secret scanning

| | |
|---|---|
| **Gap** | CodeQL and GitHub's secret scanning are part of Advanced Security, a paid add-on not available here. `security_and_analysis` is `null`. |
| **Compensating control** | `scripts/ci/secret-scan.mjs` runs on every PR over the synthesized `cdk.out` and the lifecycle fixtures with a maintained denylist. `.gitignore` excludes all real `.env` variants; only `.example` and `.reference` files are tracked. Dependabot alerts and security updates **are** enabled and are free on private repos. |
| **Residual risk** | No static analysis for code-level vulnerability patterns. Secret scanning covers synth output and fixtures, not the entire source tree or git history. |
| **Closes when** | Advanced Security is purchased, which requires an organization first. |

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

The claims above are checkable. Each returns `403` while the gap is open:

```bash
gh api repos/emmanuelmadams4-lgtm/Netzer-Labs/branches/production/protection
```
```bash
gh api repos/emmanuelmadams4-lgtm/Netzer-Labs/rulesets
```

Environment protection state, and confirmation that Dependabot alerts are on
(`204`, not `404`):

```bash
gh api repos/emmanuelmadams4-lgtm/Netzer-Labs/environments --jq '.environments[] | {name, protection_rules, can_admins_bypass}'
```
```bash
gh api repos/emmanuelmadams4-lgtm/Netzer-Labs/vulnerability-alerts -i | head -1
```

Production-runtime advisories only, excluding the dev-only noise in AR-2:

```bash
npm audit --omit=dev --audit-level=high
```

---

## If the plan tier changes

G-1 through G-5 all close with the same purchase. In priority order once it is
available:

1. A ruleset on `production` and `staging`: require a pull request, require
   code-owner review, require the `CI`, `Docs CI`, `Hermetic CDK Synth`,
   `Secret Scan`, and `Branch Guard` checks, block force-push and deletion.
2. Restrict `production`'s allowed merge sources to `staging` — this converts
   `branch-guard` from the primary control into a redundant second check.
3. Required reviewers and a `deployment_branch_policy` on the `production` and
   `staging` environments; set `can_admins_bypass: false`.

**One migration hazard, if moving to an organization rather than buying Pro:**
`infra/lib/github-oidc.ts` builds the AWS OIDC trust from `CCE_GITHUB_OWNER`,
which [`deploy.yml`](../.github/workflows/deploy.yml) derives from
`github.repository_owner`. Transferring the repository changes the owner, so the
deployed `ClaudeClawGitHubDeploy` role stops trusting the workflow — including
the workflow that would redeploy the fix. Deploy the IAM stack **locally with
admin credentials** to accept both the old and new subjects *before*
transferring, then drop the old subject afterwards.
