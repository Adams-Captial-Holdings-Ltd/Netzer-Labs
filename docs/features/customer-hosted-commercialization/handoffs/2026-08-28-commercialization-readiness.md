---
feature: customer-hosted-commercialization
document_role: session-handoff
status: current
observed_at: 2026-08-28
as_of_commit: 51b39a1dc0afe84f32823f3f4fca9c609f1aa346
session_slug: commercialization-readiness
supersedes: none
---

# Session handoff: customer-hosted commercial licensing readiness

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-08-28 |
| Feature folder | `docs/features/customer-hosted-commercialization/` |
| Branch worked on | `fix/knowledge-scope-fanout` |
| Branch it merges into next | undecided; existing branch carries unrelated user work |
| AWS environment that branch reaches | none directly |
| Commit at session start | `51b39a1dc0afe84f32823f3f4fca9c609f1aa346` |
| Commit at session end | uncommitted working tree on the same HEAD |
| Pushed | no |
| PR | none |
| Deployed | no |

## 2. Current state summary

The repository was audited for a customer-hosted proprietary commercial model.
The required draft documentation, source-level npm SBOMs, narrow runtime
dependency patches, and Paperclip telemetry opt-out are present in the working
tree. Commercial release remains blocked by counsel/chain of title, unknown and
copyleft distribution obligations, an excessive deployment role, missing
repository enforcement, absent immutable release infrastructure, and no
customer-shaped canary.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- The customer-hosted data plane is real: CDK targets the configured account and
  creates retained/encrypted data, secrets, logs, and backups there.
- `DOMAIN_NAME` is the customer-domain input; PGN Cloudflare is a separate,
  deliberately `pgnos.ai`-only overlay.
- GitHub OIDC is short-lived and exact-subject, but its role can read Paperclip
  secrets and assume CDK roles, so it is not a data-blind customer role.
- Release/signing/updater code exists, while actual tags, releases, trust roots,
  branch/tag rules, and signed artifacts do not.
- The pinned Paperclip version enables upstream telemetry by default; no current
  task setting disabled it before this session.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `infra/lib/iam-stack.ts` | GitHub/runtime IAM | Proves present vendor deployment authority |
| `infra/lib/paperclip-stack.ts` | Paperclip task | Now explicitly disables upstream telemetry |
| `.github/workflows/deploy.yml` | PGN deploy workflow | Proves moving-branch/direct build behavior |
| `infra/lib/public-dashboard-access.ts` | PGN Cloudflare overlay | Proves `pgnos.ai` is separable from customer domain mode |
| `src/lib/updates/discovery.ts` | Release check | Contains stale default owner/repo and no usable release |
| `Dockerfile` | Distributed runtime | Pulls floating Node Alpine and installs FFmpeg |
| `docs/data-flows.json` | External processor inventory | Required corrections for Salesforce/Cloudflare/Paperclip/runtime registries |

### 3.3 Patterns and conventions to follow

Feature knowledge follows `docs/features/README.md`; source wins over docs;
deployment evidence is never inferred from source tests; changes in a dirty
tree stay path-scoped; full `npm test` is required before pushing.

## 4. Work completed

### 4.1 Tasks finished

- [x] Audit repository governance, live GitHub settings, releases, licensing,
  dependencies, architecture, data flow, domains, AWS IAM, and supply chain.
- [x] Add provisional rights/security/third-party/counsel documents.
- [x] Generate source-level CycloneDX npm SBOMs.
- [x] Patch narrow known runtime vulnerabilities without force/major upgrades.
- [x] Disable Paperclip telemetry in ECS and local harness definitions.
- [ ] Close `COMM-001` through `COMM-008`; see backlog.

### 4.2 Files modified

The files and rationale are enumerated in the feature README implementation map
and the final `git diff --stat`. Unrelated pre-existing changes in `CLAUDE.md`,
`infra/lib/compute-stack.ts`, `.agents/`, LibreChat documentation, root handoff
notes, and `skills-lock.json` were not edited.

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| V1 entitlement remains contractual | Online license server, offline signed token, contract | User explicitly prohibited a license-server build; contract is sufficient for v1 |
| Customer production excludes PGN Cloudflare | Reuse PGN tunnel, customer DNS/edge | Preserves customer-controlled data/traffic boundary |
| Do not rewrite IAM/workflow in this audit | Immediate mutation, approved design first | Consequential customer trust changes require dedicated review/tests |
| Generate npm SBOM now, label incomplete | Claim full SBOM, wait for Docker, source SBOM | Gives useful evidence without concealing missing Linux/image components |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Current commercial blockers and priorities | `docs/COMMERCIALIZATION_READINESS.md` | yes |
| Customer domain/runtime/external paths | `docs/CUSTOMER_HOSTED_ARCHITECTURE.md` | yes |
| PGN access path and role separation | `docs/CUSTOMER_DATA_BOUNDARY.md` | yes |
| Deployment/release/supply-chain target | dedicated root docs and backlog | yes |

## 5. Carried-forward mistakes, assumptions and precautions

> Copied from the feature handoff template seed, then appended to. Nothing is
> deleted; resolved entries remain with their resolving commit.

### 5.1 Process precautions

| # | Precaution | Why it exists |
|---|---|---|
| P1 | Record a baseline before changing anything. | Without it a pre-existing failure is indistinguishable from a regression you caused. |
| P2 | Never record a command as passing unless it actually ran. Say what you skipped and why. | See M5: a handoff once carried checks that no runtime could have executed. |
| P3 | Name the branch. Never write “ready for production”. | Four long-lived branches exist and only two reach an AWS environment. |
| P4 | Run the FULL `npm test` before pushing, never a scoped run. | Required by `CLAUDE.md`. Scoped runs have hidden cross-module regressions here. |
| P5 | When a document and the code disagree, the code wins. Fix the document. | The framework's stated tie-break. |
| P6 | Never force-add unrelated uncommitted work you find in the tree. Preserve it and hand it back to its owner. | Stray files found during cleanup are somebody's in-flight work, not yours to merge. |
| P7 | Delete a transient branch once it merges. | Only `development`, `qa`, `staging`, `production` survive, so a handoff that names a branch names something that still exists. |
| P8 | Docs changes must pass `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/docs-links.mjs` before pushing. | Docs CI runs them anyway; failing there costs a round trip. |
| P9 | Never restate feature-documentation rules outside the framework. | A second copy is exactly how these conventions drifted before. |
| P10 | A source-level package SBOM is not a release image SBOM. | Platform-native, OS, browser, Paperclip and sidecar components differ from the Windows npm graph. |
| P11 | Short-lived OIDC does not imply least privilege or no data access. | CDK/CloudFormation authority can create access paths even without direct data API actions. |

### 5.2 Mistakes already made, and their corrections

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M1 | Feature-documentation conventions were written on several pages at once. | The copies drifted and no page was trustworthy. | Single specification in the framework, machine-checked by `scripts/ci/feature-knowledge.mjs`. | One rule, one home, enforced by CI rather than discipline. |
| M2 | The repository-root `handoff.md` was used as live operational state. | It became stale and contradicted per-feature state. | Reduced to a compatibility pointer. | Operational state is per feature. |
| M3 | A Dynamo stack comment claimed 14 tables while code creates 32. | Table-count work was misled. | Inspect constants/synth output. | Comments are not authorities. |
| M4 | The CodeBuild default branch was changed to production, then reverted. | Churn on a live CI path. | Reverted in `4ce27a7`. | Establish intent before reapplying. |
| M5 | A handoff recorded checks as complete where Node was unavailable. | Later readers could trust nonexistent evidence. | Disclosed; CI became first execution. | Never convert “not run” into “pass”. |
| M6 | Targeted Vitest ran in a Windows linked worktree. | Vitest could not resolve the root/config. | Run from a normal checkout. | Windows worktree behavior differs. |
| M7 | `test:integration:up` was assumed safe beside the local stack. | It collided with Floci on port 4566. | Use `local:test:integration`. | One emulator on 4566. |
| M8 | `.env` was created while lifecycle scripts default to production. | Previously inert commands became dangerous. | Read the dangerous-command list. | Local config can arm real operations. |
| M9 | Security policy claimed a private advisory channel and N-1 support despite neither existing. | External reporters/customers would receive false instructions. | Replaced with explicit blockers and no invented SLA. | Documentation is part of the control boundary. |

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS when its isolation controls are used. | Existing framework assumption; prove with `npm run local:verify` when relevant. |
| A2 | Existing local-development verification was macOS-specific. | Windows/Linux behavior is not covered by that historical evidence. |
| A3 | Bedrock is a local stub. | Local tests prove plumbing, not model behavior. |
| A4 | `qa` deploys nothing; production deployment is manual dispatch, while staging deploys on push. | Verified from current workflows. |
| A5 | Module-level table names capture environment at import time. | Set overrides before import. |
| A6 | Historical account access used named local profiles. | Not used or changed in this session. |
| A7 | The current repository organization spelling is `Adams-Captial-Holdings-Ltd`. | Verified through live GitHub API; do not silently “correct” the identifier in code. |

### 5.4 Known traps that cost time

| Trap | Where the detail lives |
|---|---|
| Blank `.env` values differ from omitted values. | `development.md` environment variables |
| Example env files are not all loadable. | `development.md` environment variables |
| `NODE_ENV=production` arms deployed-task behavior. | `development.md` dangerous commands |
| Suffix overrides are not uniformly lazy. | `development.md` environment variables |
| Vite port/address can differ. | `development.md` troubleshooting |
| Local `/ready` 503 can be correct. | `development.md` starting development |
| Floci lacks complete Bedrock/Secrets behavior. | `development.md` known limitations |
| Windows lacks `sh` on default PATH. | Baseline test record in this handoff |
| `npm audit fix --force` proposes breaking downgrades. | `docs/security-posture.md` accepted risks |
| PGN Cloudflare values are not customer-domain configuration. | `docs/CUSTOMER_HOSTED_ARCHITECTURE.md` |

## 6. Pending work

### 6.1 Smallest next action

Open `infra/lib/iam-stack.ts` at the GitHub OIDC role and review the
`COMM-001` data-blind deployment design before editing IAM.

### 6.2 Immediate next steps

1. Approve/design `COMM-001` and its IAM deny tests.
2. Resolve `COMM-003` with counsel and a Linux image scan environment.
3. Enable repository governance/security settings and build `COMM-002`.

### 6.3 Blockers and open questions

- [ ] Blocker: legal licensor/chain of title/customer grant; needs counsel.
- [ ] Blocker: full built-image license/SBOM evidence; needs Docker/Linux build.
- [ ] Blocker: branch/tag/environment protection; needs organization plan/admin.
- [ ] Question: customer-push versus customer-operated pull deployment; suggested
  resolution is data-blind vendor push with customer approval plus a pull option.

### 6.4 Deferred, and why

- Offline signed license token: deferred beyond v1 because the agreement is the
  entitlement and no call-home is needed.
- Repository transfer: already in an organization and never authorized here.
- Production IAM/workflow mutation: requires approved design and clean branch.

## 7. Verification actually performed

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `npm run typecheck` | not run | pending |
| `npm test` | 229 files passed, 6 failed, 1 skipped; 2,894 passed, 7 failed, 6 skipped | pending |
| `npm run build` | not run | pending |
| `npm --prefix web run typecheck` | not run | pending |
| `npm --prefix web run build` | not run | pending |
| `npm run local:test:integration` | not run | not run; Docker unavailable |
| `node scripts/ci/docs-links.mjs` | not run | pending |
| `node scripts/ci/feature-knowledge.mjs` | not run | pending |
| `git diff --check` | not run | pending |

Also run/recorded: live GitHub settings, `npm audit` before and after narrow
patches, local license evidence, CycloneDX JSON parse, and current-tree secret
pattern scan (only known fake fixtures). Full-history secret scan and image scan
were not available.

## 8. Environment state

- Tools: Windows PowerShell, Node/npm repository toolchain, GitHub CLI.
- Docker, Syft, Trivy, Gitleaks, and CycloneDX CLI were not preinstalled;
  CycloneDX npm generation used `npx`.
- No dev server, watcher, container, or AWS deployment was left running.
- No secret values or environment values were printed.
- Pre-existing uncommitted work remains in `CLAUDE.md`,
  `infra/lib/compute-stack.ts`, `.agents/`, `docs/features/librechat-chat-ui/`,
  two root handoff notes, and `skills-lock.json`.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF](../HANDOFF.md)
- [Commercialization backlog](../backlog.md)
- [Feature knowledge framework](../../README.md)
- [Repository development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)
