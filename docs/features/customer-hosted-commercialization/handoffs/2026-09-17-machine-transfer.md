---
feature: customer-hosted-commercialization
document_role: session-handoff
status: current
observed_at: 2026-09-17
as_of_commit: 271339bc8b2feea85e6c31b115fdd34e757a72e2
session_slug: machine-transfer
supersedes: 2026-08-28-commercialization-readiness.md
---

# Session handoff: move the customer-hosted readiness work to its own branch

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-17 |
| Feature folder | `docs/features/customer-hosted-commercialization/` |
| Branch worked on | `docs/customer-hosted-commercialization` (new, cut from `origin/development` at `271339bc8b2feea85e6c31b115fdd34e757a72e2`) |
| Branch it merges into next | undecided; the owner chooses. The branch was cut from `development`, but no merge target has been approved. |
| AWS environment that branch reaches | none (a `docs/*` branch deploys nothing) |
| Commit at session start | `271339bc8b2feea85e6c31b115fdd34e757a72e2` (`origin/development`, "Merge pull request #165") |
| Commit at session end | the single commit that adds this file, subject "docs(commercialization): move the customer-hosted readiness work to its own branch"; read its SHA with `git log -1 --format=%H docs/customer-hosted-commercialization` |
| Pushed | not yet at the time of writing; the coordinator pushes this branch to origin under the same name immediately after this commit as an owner-approved backup (no PR, no merge, no deploy) - confirm with `git ls-remote origin refs/heads/docs/customer-hosted-commercialization` |
| PR | none |
| Deployed | no |

## 2. Current state summary

The 2026-08-28 readiness work (draft commercial documents, source npm SBOMs,
narrow lockfile patches, the Paperclip telemetry opt-out, and this feature
folder) was never committed. It sat as uncommitted edits in the main checkout
`C:\dev\Netzer-Labs` on the unrelated branch `fix/knowledge-scope-fanout`, which
has PR #132 open against `development` (verified `OPEN` with `gh pr view 132`
on 2026-09-17). Because the owner is moving development to a new Windows PC and
a Mac, this session moved that work, unchanged in intent, onto its own branch
`docs/customer-hosted-commercialization`, cut from `origin/development`
`271339b`, in the linked worktree `C:\dev\Netzer-Labs\.worktrees\commercialization`.
Untracked files were byte-copied; tracked edits were replayed with
`git apply --3way`; `LICENSE` was removed because the work replaced it with
`LICENSE.md`. Nothing in the main checkout was changed, staged, stashed or
reverted, so the same edits still sit there too. The substantive state is
exactly what the 2026-08-28 session recorded: P0 commercial blockers open,
`COMM-001` next, and the 2026-08-28 after-change checks (typecheck, full
`npm test`, build) still **not run**.

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

- `development` moved three of the replayed files after the 2026-08-28 base
  (`51b39a1`): `infra/lib/paperclip-stack.ts`, `infra/lib/paperclip-stack.test.ts`
  and `web/package-lock.json`. Only `infra/lib/paperclip-stack.ts` conflicted:
  `development` had added `PAPERCLIP_ALLOWED_HOSTNAMES` (with its comment) at
  the same spot in the Paperclip task environment where this work adds
  `PAPERCLIP_TELEMETRY_DISABLED` and `DO_NOT_TRACK`. The two intents are
  independent environment keys, so the conflict was resolved by keeping both,
  `development`'s line first. The test and web lockfile hunks applied cleanly.
- `infra/lib/compute-stack.ts` was deliberately **not** replayed. Its
  uncommitted edit in the main checkout (the `company_id` field comment and the
  `PAPERCLIP_COMPANY_ID` ECS secret) was pre-existing work that the 2026-08-28
  session already called unrelated, and `development` carries the equivalent
  change since `ef2699670f80d34ec258e1b5c9ccc117e7268bc4`
  ("fix(paperclip): make fresh installs self-bootstrapping").
- `scripts/ci/feature-knowledge.mjs` builds its snapshot from `git ls-files`
  (line 234), so a new feature folder is invisible to the gate until it is
  staged. The gate was re-run with this folder staged, and it passes.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `infra/lib/paperclip-stack.ts:468` | Paperclip task environment | The only conflict; both `development`'s hostname allow-list and this work's telemetry opt-out are kept |
| `infra/lib/paperclip-stack.test.ts:367` | Asserts the telemetry opt-out | Applied cleanly on top of `development`'s larger test changes |
| `package-lock.json`, `web/package-lock.json` | Narrow 2026-08-28 dependency patches | Applied without conflict; not re-validated with `npm install` |
| `LICENSE` / `LICENSE.md` | Rights notice | `LICENSE` removed, `LICENSE.md` added, matching the main checkout |
| `scripts/ci/feature-knowledge.mjs:234` | Docs gate snapshot | Reads only Git-tracked files |

### 3.3 Patterns and conventions to follow

Same as 2026-08-28: the feature framework in
[`docs/features/README.md`](../../README.md) governs; source wins over docs;
dirty-tree work stays path-scoped; run the FULL `npm test` before any push that
is meant for review (this branch's first push is a backup only).

## 4. Work completed

### 4.1 Tasks finished

- [x] Create worktree `.worktrees/commercialization` on new branch
  `docs/customer-hosted-commercialization` from `origin/development`; the
  branch's upstream was unset so a bare `git push` or `git pull` cannot target
  `development` by accident.
- [x] Byte-copy the untracked set from the main checkout (16 files, every copy
  confirmed with `cmp`, and every staged blob equal to
  `git hash-object --no-filters` of its source).
- [x] Replay the 21 tracked edits with `git apply --3way --whitespace=nowarn`;
  resolve the one conflict; confirm the 18 files `development` had not moved
  stage blobs identical to the main checkout's content.
- [x] `git rm LICENSE`.
- [x] Write this session log and update the canonical `HANDOFF.md`.
- [ ] Close `COMM-001` through `COMM-008`; see the backlog. Untouched.
- [ ] 2026-08-28 after-change checks (typecheck, full `npm test`, build). Still
  not run; see section 7.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/customer-hosted-commercialization/{README.md,HANDOFF.md,backlog.md,handoffs/2026-08-28-commercialization-readiness.md}` | added, byte-copied | The feature folder |
| `docs/AWS_CUSTOMER_DEPLOYMENT.md`, `docs/COMMERCIALIZATION_READINESS.md`, `docs/CUSTOMER_DATA_BOUNDARY.md`, `docs/CUSTOMER_HOSTED_ARCHITECTURE.md`, `docs/LEGAL_REVIEW_CHECKLIST.md`, `docs/RELEASE_PROCESS.md`, `docs/SOFTWARE_SUPPLY_CHAIN.md` | added, byte-copied | Draft commercial documents |
| `LICENSE.md`, `THIRD_PARTY_NOTICES.md`, `sbom/` (3 files) | added, byte-copied | Rights notice, notices, source npm SBOMs |
| `LICENSE` | removed | Replaced by `LICENSE.md` in the 2026-08-28 work |
| `BRAND.md`, `PROVENANCE.md`, `README.md`, `SECURITY.md`, `development.md`, `docs/development.md`, `docs/README.md`, `docs/assets/README.md`, `docs/data-flows.json`, `docs/launch-checklist.md`, `docs/security-model.md`, `docs/security-posture.md`, `docker-compose.paperclip.yml`, `scripts/launch/repo-settings.sh`, `scripts/release/build-release.ts`, `scripts/update/shim.ts`, `src/lib/updates/discovery.ts`, `package-lock.json` | replayed, identical to the main checkout | 2026-08-28 edits |
| `infra/lib/paperclip-stack.test.ts`, `web/package-lock.json` | replayed cleanly onto `development`'s newer versions | 2026-08-28 edits |
| `infra/lib/paperclip-stack.ts` | replayed; conflict resolved keeping both sides | See 3.1 |
| `docs/features/customer-hosted-commercialization/handoffs/2026-09-17-machine-transfer.md` | added | This log |
| `docs/features/customer-hosted-commercialization/HANDOFF.md` | edited after the copy | Branch, pushed state, session index |

Excluded on purpose, still uncommitted in the main checkout:

| File | Why excluded | Where it goes instead |
|---|---|---|
| `infra/lib/compute-stack.ts` | Superseded on `development` by `ef26996`; unrelated to this feature | nowhere; `development` already has it |
| `CLAUDE.md` | Unrelated session-rule edit | Its own branch `docs/claude-md-session-rules` |
| `.gitignore`, `AGENTS.md` | graft tooling wiring, not commercialization | Saved as a patch for the devkit: `repo-local/netzer-labs/patches/B7-graft-wiring.patch` |
| `.agents/`, `docs/features/librechat-chat-ui/`, root handoff notes, `skills-lock.json`, `.scratch/` | Other work (see 2026-08-28 section 8) | Handled by other transfer steps |

Lockfile handling: no lockfile conflict occurred, so no lockfile patch was set
aside. Both lockfiles carry the 2026-08-28 narrow bumps on top of `development`.
They were **not** regenerated or checked with `npm install`/`npm ci`; before
review, run `npm install` and `npm --prefix web install` and confirm the
lockfiles do not change beyond the bumps the 2026-08-28 session lists in
`docs/security-posture.md`.

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Cut the branch from `origin/development` | `fix/knowledge-scope-fanout`, `production`, `development` | The coordinator's plan; keeps PR #132 free of unrelated work |
| Keep both sides of the `paperclip-stack.ts` conflict | keep ours, keep theirs, keep both | Two independent environment keys; neither intent removes the other |
| Merge target left undecided | `development` now, later | The owner has not chosen one |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| `feature-knowledge.mjs` validates only Git-tracked files, so a new feature folder must be staged before the gate says anything about it | `docs/features/README.md` section 7 | no - the transfer task forbids README edits; promote in a normal docs session |
| The commercialization work lives on `docs/customer-hosted-commercialization` | `HANDOFF.md` (volatile state, not durable) | yes |

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

### Added 2026-09-17 (machine transfer)

> Appended by the 2026-09-17 machine-transfer session. Everything above this
> heading is carried verbatim from `2026-08-28-commercialization-readiness.md`.
> IDs continue that ledger's P/M/A scheme.

#### 5.1 Process precautions (continued)

| # | Precaution | Why it exists |
|---|---|---|
| P12 | Start feature work on its own branch before the first edit; never leave it as uncommitted changes in another branch's checkout. | The 2026-08-28 work sat on `fix/knowledge-scope-fanout` (PR #132 open) and could not be pushed or reviewed without contaminating that PR; see M10. |
| P13 | When replaying a dirty-tree diff onto a newer base, use `git apply --3way` and compare each staged blob with `git hash-object` of its source for every file the base did not move. | It proves the replay is exact where it should be, and isolates the files that genuinely needed a merge. |

#### 5.2 Mistakes already made, and their corrections (continued)

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M10 | The 2026-08-28 session left its work uncommitted in the working tree of an unrelated branch. | The work was unpushable and exposed to loss during the machine transfer (C: 99% full). | Moved on 2026-09-17 to `docs/customer-hosted-commercialization`, cut from `origin/development` `271339b`. | Branch first, edit second (P12). |

#### 5.3 Standing assumptions (continued)

| # | Assumption | Confidence and caveat |
|---|---|---|
| A8 | The replay onto `271339b` preserves the 2026-08-28 intent: 18 replayed files are identical to the main checkout, and the three that `development` had moved differ only by `development`'s own changes. | Checked by blob comparison and a TypeScript syntax pass only; not typechecked, tested or built (section 7). |
| A9 | The 2026-08-28 lockfile bumps are still consistent with `development`'s `package.json` files. | Unverified: they applied without conflict, but no `npm install` or `npm ci` ran. |

#### 5.4 Known traps that cost time (continued)

| Trap | Where the detail lives |
|---|---|
| `scripts/ci/feature-knowledge.mjs` reads only Git-tracked files, so an unstaged new feature folder passes silently. | `scripts/ci/feature-knowledge.mjs:234`; section 3.1 of this log |
| `git apply --3way` implies `--index` and leaves a conflicted file as `UU`; under `core.autocrlf=true` the worktree copy is CRLF while the staged blob is LF. | Section 3.1 of this log |

## 6. Pending work

### 6.1 Smallest next action

Open `infra/lib/iam-stack.ts` at the GitHub OIDC role and review the
`COMM-001` data-blind deployment design before editing IAM.

### 6.2 Immediate next steps

1. Decide this branch's merge target (owner).
2. On a full clone with dependencies installed, run the 2026-08-28 after-change
   checks: `npm run typecheck`, `npm run build`, `npm --prefix web run typecheck`,
   `npm --prefix web run build`, the FULL `npm test`, and
   `npx vitest run infra/lib/paperclip-stack.test.ts`; compare against the
   2026-08-28 baseline (229 files passed, 6 failed, 1 skipped).
3. Approve/design `COMM-001` and its IAM deny tests; then `COMM-003` and
   `COMM-002` per the 2026-08-28 order.

### 6.3 Blockers and open questions

- [ ] Blocker: legal licensor/chain of title/customer grant; needs counsel.
- [ ] Blocker: full built-image license/SBOM evidence; needs Docker/Linux build.
- [ ] Blocker: branch/tag/environment protection; needs organization plan/admin.
- [ ] Question: merge target for `docs/customer-hosted-commercialization` -
  suggested resolution: `development`, after the section 6.2 checks pass.
- [ ] Question: should the main checkout's copy of these edits be discarded
  once this branch is safely on origin? Suggested resolution: only the owner
  decides; nothing was discarded here.

### 6.4 Deferred, and why

- Everything the 2026-08-28 session deferred, unchanged.
- Regenerating lockfiles: needs `npm install`, which this disk-constrained
  transfer session did not run.

## 7. Verification actually performed

| Command | Baseline (untouched `origin/development` `271339b`) | After changes |
|---|---|---|
| `npm run typecheck` | not run | not run |
| `npm test` | not run (2026-08-28 baseline on `51b39a1`: 229 files passed, 6 failed, 1 skipped) | not run |
| `npm run build` | not run | not run |
| `npm --prefix web run typecheck` | not run | not run |
| `npm --prefix web run build` | not run | not run |
| `npm run local:test:integration` | not run | not run |
| `node scripts/ci/docs-links.mjs` | OK: 135 markdown files, 1647 internal links, exit 0 | OK: 147 markdown files, 1696 internal links, exit 0 (files staged) |
| `node scripts/ci/feature-knowledge.mjs` | OK, exit 0 | OK, exit 0 (new folder staged, so validated) |
| `git diff --cached --check` | clean (nothing staged) | clean, exit 0 |

Also run: `cmp` on all 16 byte-copied files (all identical); staged blob versus
`git hash-object --no-filters` of each source (all 16 identical); staged blob
versus `git hash-object` of the main checkout for the 21 replayed files (18
identical, the 3 files `development` had moved differ as expected); a
TypeScript `transpileModule` syntax pass (using the main checkout's
`node_modules/typescript`) over `infra/lib/paperclip-stack.ts`,
`infra/lib/paperclip-stack.test.ts`, `scripts/release/build-release.ts`,
`scripts/update/shim.ts` and `src/lib/updates/discovery.ts`: 0 diagnostics
each. That is a syntax check only, not a typecheck.

Not run, and why: the worktree has no `node_modules` and C: had about 3.3 GB
free, so no `npm install`; Vitest must not run in a Windows linked worktree
(M6). The 2026-08-28 after-change checks therefore remain outstanding.

## 8. Environment state

- Branch `docs/customer-hosted-commercialization`, tip before this session's
  commit `271339bc8b2feea85e6c31b115fdd34e757a72e2`; upstream unset.
- Pushed: not yet at the time of writing; the coordinator pushes this branch to
  origin under the same name immediately after this commit as an owner-approved
  backup (no PR, no merge, no deploy) - confirm with
  `git ls-remote origin refs/heads/docs/customer-hosted-commercialization`.
- Worktree `C:\dev\Netzer-Labs\.worktrees\commercialization` was left in place
  for the coordinator, who removes it after pushing. The same worktree was then
  reused for the branches `docs/claude-md-session-rules` and
  `docs/session-handoff-backfill`.
- No dev server, watcher, container or AWS call. No secret values printed.
- Non-git files this feature depends on, and where they live in the devkit
  (`https://github.com/emmanuelmadams4-lgtm/netzer-devkit`):
  - dependency-license audit:
    `repo-local/netzer-labs/.scratch/commercialization-dependency-license-audit.md`
    (was `C:\dev\Netzer-Labs\.scratch\commercialization-dependency-license-audit.md`,
    untracked);
  - the exact patch replayed here:
    `repo-local/netzer-labs/patches/B7-commercialization.patch`;
  - the excluded graft wiring (`.gitignore`, `AGENTS.md`):
    `repo-local/netzer-labs/patches/B7-graft-wiring.patch`.
- Uncommitted work left in the main checkout (not this session's, per P6): the
  same 2026-08-28 edits, plus `infra/lib/compute-stack.ts`, `CLAUDE.md`,
  `.gitignore`, `AGENTS.md`, `.agents/`, `.ignore`, `.mcp.json`, `.scratch/`,
  `docs/features/librechat-chat-ui/`, two root handoff notes, `skills-lock.json`
  and an untracked Paperclip session handoff.

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-08-28-commercialization-readiness.md)
- [Commercialization backlog](../backlog.md)
- Readiness evidence (`COMMERCIALIZATION_READINESS.md` on branch `docs/customer-hosted-commercialization`)
- [Feature knowledge framework](../../README.md)
- [Repository development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)

## Appendix A - Resume on a new machine

### A.1 Path map

| Old machine | New machine |
|---|---|
| `C:\dev\Netzer-Labs` (and its `.worktrees\commercialization`) | `<dev-root>/Netzer-Labs`: a fresh clone of origin, then `git switch docs/customer-hosted-commercialization` |
| `C:\dev\Netzer-Labs\.scratch\commercialization-dependency-license-audit.md` | devkit `repo-local/netzer-labs/.scratch/commercialization-dependency-license-audit.md` |
| `C:\Users\EmmanuelAdams\.claude\plans\X` | `~/.claude/plans/X` after running the devkit restore (source: devkit `claude/plans/X`) |
| `C:\Users\EmmanuelAdams\.claude\gauntlet\Y` | `~/.claude/gauntlet/Y` (none exists for this feature) |
| `%TEMP%` scratchpad paths (this session: `...\26ee85c7-e640-427d-875c-da81e9a7707d\scratchpad\transfer\B7\`) | devkit `repo-local/netzer-labs/patches/B7-*.patch` for the patches this log cites; other past scratchpads under devkit `archive/scratch/<session-id>/` |
| `codex.exe` under `AppData` | the `codex` CLI on PATH (pass its absolute path to `--cli`) |
| `-c windows.sandbox="elevated"` | Windows-only; drop it on macOS |
| `cygpath`, `MSYS_NO_PATHCONV`, PowerShell 5.1 notes | Windows/Git Bash only |
| Docker builds | On Apple Silicon, arm64 builds natively and amd64 runs under emulation; the built-image SBOM for `COMM-003` must be taken from the amd64 image that ships |

### A.2 Resume prompt

No Gauntlet or other fresh-session resume prompt exists for this feature: there
is no `~/.claude/gauntlet/` campaign for it and no `~/.claude/plans/` file
written as its resume prompt. Resume by reading this log, then
[`HANDOFF.md`](../HANDOFF.md), then [the backlog](../backlog.md). For context
only (neither is a resume prompt for this feature): the release-pipeline plan
that cites the readiness document is devkit
`claude/plans/plan-the-netzer-enterprise-ticklish-engelbart.md`, and the
machine-transfer plan that created this branch is devkit
`claude/plans/we-have-alot-of-eager-spindle.md`.
