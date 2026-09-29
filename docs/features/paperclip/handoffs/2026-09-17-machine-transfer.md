---
feature: paperclip
document_role: session-handoff
status: current
observed_at: 2026-09-17
as_of_commit: 4f1a860355146c34f59a2f35731819cfedb6d2c2
session_slug: machine-transfer
supersedes: 2026-09-15-p0-0b-validate-and-ship.md
---

# Session handoff: P0-0b machine transfer — land the 2026-09-15 WI-1 record and hand off to a new machine

## 1. Session metadata

| Field | Value |
|---|---|
| Session started | 2026-09-17 |
| Feature folder | `docs/features/paperclip/` |
| Branch worked on | `fix/paperclip-p0-0b-image-build` — name it, never say "a feature branch" |
| Branch it merges into next | `development`, and only after agile-hamster STEPS 1–3 pass on the proposed tip (section 6) |
| AWS environment that branch reaches | none. This session built, deployed and called nothing in AWS |
| Commit at session start | `4f1a860355146c34f59a2f35731819cfedb6d2c2` |
| Commit at session end | the docs-only commit that adds this file, whose parent is `4f1a860355146c34f59a2f35731819cfedb6d2c2`. A file cannot contain its own commit's SHA, so read it with `git rev-parse fix/paperclip-p0-0b-image-build` |
| Pushed | Not yet at the time of writing; the coordinator pushes this branch to origin under the same name immediately after this commit as an owner-approved backup (no PR, no merge, no deploy) - confirm with `git ls-remote origin refs/heads/fix/paperclip-p0-0b-image-build` |
| PR | none (`gh pr list --head fix/paperclip-p0-0b-image-build --state all` returned `[]` on 2026-09-17) |
| Deployed | no |

## 2. Current state summary

This was a machine-transfer session, not a build session. The owner is moving
Netzer development off this Windows 11 host, whose `C:` drive is 99% full with
2.6–3.0 GB free on 2026-09-17, to a new Windows PC and a Mac. The session did
three things:

1. Landed the 2026-09-15 session's three documents, which until now existed
   only as drafts in session `968da171`'s `%TEMP%` scratchpad. They went in
   byte for byte: the session handoff, `HANDOFF.md` and `README.md`.
2. Checked that record against its evidence folder and transcript, and
   recorded here what it understates (ledger M74).
3. Wrote this handoff for resuming on the new machine.

**WI-1 (P0-0b) state.** The fix is commit `73f0812`, unchanged. The
`Dockerfile` sha256 is still `5854df9f…`, and `git hash-object Dockerfile`
equals `HEAD:Dockerfile`. On 2026-09-15 (18:45–18:50Z) the plan in force,
`gauntlet-mode-direct-coordinator-gauntle-agile-hamster.md`, reached STEP 1:

| Lane | Result on 2026-09-15 |
|---|---|
| 1.1 image gate | 3/3 |
| 1.2 text tests | 11/11 |
| 1.3 red-first | 5 expected failures against `271339b`'s Dockerfile, then the Dockerfile was restored hash-identical |
| 1.4 no-cache build-stage build | **failed** at `exporting to image` with a containerd input/output error because `C:` reached 0 bytes free. Its install step had already logged `added 5 packages in 5s` |
| 1.5 full amd64 image | never ran |
| 1.6 arm64/QEMU | never ran |

**The rest of the plan.**

- **STEP 2 (docs):** partly done. The docs were drafted and are now committed
  here, and the checklist's dated "WI-1 reconciliation — 2026-09-15" addendum
  exists.
- **STEPS 3–7:** never started. There is no P0-0b PR and no staging deploy; the
  newest staging deploy is still 34180887085, from 2026-09-08.

**What happened on 2026-09-16.** The session tried to free disk and restarted
Docker Desktop, which left its engine damaged: `docker system df` returned
HTTP 500 at 14:12 EDT. At 14:50 EDT the owner rejected the session's "which
deletions" question, and session `968da171` ended interrupted.

**The backup push.** The branch is being pushed now as an owner-approved
backup. That happens *before* STEP 3's "full suite before any push" rule, as a
deliberate owner override (ledger P58); there is no PR.

**Next.** Resume on the new machine from STEP 0 (section 6.1).

## 3. Codebase understanding

### 3.1 Architecture notes discovered this session

No product code was read or changed. Two facts about the docs tooling decided
how this session wrote files:

- `scripts/ci/docs-links.mjs` blanks fenced code blocks before it looks for
  links. That is why Appendix A can embed the plan file verbatim in a fence.
  `scripts/ci/feature-knowledge.mjs` requires every `tested_by` target in
  `README.md` to be Git-tracked, and the two
  `orchestrator-dockerfile*.test.ts` registrations are.
- Every file in this folder is stored with LF in the index
  (`git ls-files --eol` shows `i/lf`). `core.autocrlf=true` is set, and no
  `.gitattributes` rule covers `docs/`, so `HANDOFF.md` and `README.md` are
  checked out with CRLF (`w/crlf`). A CRLF-only change is invisible to
  `git diff`; `git ls-files --eol` and a `\r` count show it.

### 3.2 Critical files

| File | Purpose | Why it mattered this session |
|---|---|---|
| `Dockerfile` (build stage, `73f0812`) | The WI-1 fix | Unchanged. Lanes 1.4–1.6 build it on the new machine |
| `scripts/lib/lifecycle/orchestrator-dockerfile.build.integration.test.ts` | Image gate, lane 1.1 | 3/3 on 2026-09-15 |
| `scripts/lib/lifecycle/orchestrator-dockerfile.test.ts` | The eleven text tests, lanes 1.2 and 1.3 | 11/11, and 5 of 11 fail against `271339b`'s Dockerfile, as designed |
| `docs/features/paperclip/handoffs/2026-09-15-p0-0b-validate-and-ship.md` | The 2026-09-15 record, landed byte for byte | Its sections 2, 4.1, 6.2, 6.4, 7 and 8, and ledger row P54, understate what ran. Ledger M74 below corrects them |
| `docs/features/paperclip/README.md` | Durable view | The draft adds both `tested_by` registrations and the image-test command. It does **not** yet rewrite the section 7 P0-0 row or add the text test to the section 8 focused line (see 6.2) |

### 3.3 Patterns and conventions to follow

- Session handoffs are append-only history. This session did not edit the
  2026-09-15 file; its corrections are ledger rows here.
- Before assigning a ledger ID, take the maxima from the **whole** section 5
  (M72). Before this session they were `M73`, `A64` and `P56`.
- After copying a document, compare what git will store, not only the bytes on
  disk:
  - LF source: `git hash-object --no-filters <source>` equals the staged blob.
  - CRLF source: `git hash-object --path=<repo path> <source>` equals the
    staged blob.

## 4. Work completed

### 4.1 Tasks finished

- [x] Confirmed that the three `968da171` drafts were written against the current worktree versions:
  - `git diff --no-index --stat`: `HANDOFF.md` +14/−9, `README.md` +11.
  - Every context line matches.
- [x] Byte-copied the three drafts in; `cmp` and `sha256sum` match for all three.
- [x] Checked the 2026-09-15 record against:
  - its evidence folder (`1-lanes-summary.txt`, the `1.1`–`1.4` logs, the `1.3` sha files);
  - the `968da171` transcript, which dates the Docker HTTP 500 (18:12:00Z), the disk figures (18:24:39Z) and the rejected question (18:50:59Z).
- [x] Appended the corrections and new precautions to the ledger (section 5.25).
- [x] Updated `HANDOFF.md`: front matter, branch and pushed state, current objective, the P0-0b row, evidence, blockers, smallest next action and session index.
- [x] Wrote this handoff and its resume appendix.
- [ ] agile-hamster STEP 1, lanes 1.4–1.6: not run. This host lacks the headroom and its Docker engine is damaged (P57, A65). See section 6.
- [ ] Rest of STEP 2: not done.
  - Rewrite the README section 7 P0-0 row to M64 plus the real fix.
  - Add `orchestrator-dockerfile.test.ts` to the README section 8 focused line.
  - Add the lane results.
- [ ] STEPS 3–7: never started.

### 4.2 Files modified

| File | Change | Rationale |
|---|---|---|
| `docs/features/paperclip/handoffs/2026-09-15-p0-0b-validate-and-ship.md` | Added: a byte-exact copy of the `968da171` draft (sha256 `fdaf0043…`, LF) | The only copy lived in `%TEMP%` on a nearly full disk (M75) |
| `docs/features/paperclip/README.md` | Replaced with the `968da171` draft (sha256 `785ef727…`, CRLF in the working tree). It adds two `tested_by` entries, a P0-0b status paragraph and the image-test command | Same |
| `docs/features/paperclip/HANDOFF.md` | The `968da171` draft (sha256 `a7c47d5f…`), then this session's minimal update, CRLF kept | Point at this file, state the backup push, and correct the draft's "before any image build could run" claim |
| `docs/features/paperclip/handoffs/2026-09-17-machine-transfer.md` | Added (this file, LF) | `CLAUDE.md`: every session writes its own handoff |

### 4.3 Decisions made

| Decision | Options considered | Why this one |
|---|---|---|
| Land the 2026-09-15 draft byte for byte and correct it here | (a) edit its wrong sentences in place; (b) copy it verbatim and append corrections to the ledger | Session handoffs are append-only. The draft is the only record of that session, and its errors are themselves evidence (M74) |
| Push the branch as a backup before STEP 3 | Owner decision for the machine transfer | Recorded as an override with its limits (P58) |
| Write this file with LF | CRLF, like most working-tree siblings; LF, like the 2026-09-08 and 2026-09-15 files | Git stores LF for every file here, and section 5 must be byte-identical to the LF 2026-09-15 source |

### 4.4 Durable facts promoted out of this log

| Fact learned | Promoted into | Done |
|---|---|---|
| Check for at least 10 GB free, on the drive holding Docker's data, immediately before each image lane | Ledger P57 here. Should also go into `development.md`'s Docker guidance | no. Out of scope for a transfer session; promote the next time a session edits `development.md` |
| After a disk-full event, Docker Desktop's engine can keep answering HTTP 500 | Ledger A65 here. A candidate for `development.md` troubleshooting | no, for the same reason |
| Land drafts in the worktree, never only in `%TEMP%` | Ledger M75 here. A candidate for the handoff rules in [the framework](../../README.md), section 6a | no. The framework spec is outside this task |
| The WI-1 lane results and the real fix | README section 7 P0-0 row | no. That is agile-hamster STEP 2's job, after lanes 1.4–1.6 pass |

## 5. Carried-forward mistakes, assumptions and precautions

> Copied forward verbatim from 2026-09-03-staging-probe-green-and-two-findings.md, then appended to. Nothing is deleted.

> Copied forward verbatim from the previous session handoff,
> [`2026-08-24-paperclip-completion-audit.md`](2026-08-24-paperclip-completion-audit.md),
> then appended to. Nothing is deleted. An entry that is fixed is marked
> `RESOLVED (<commit>)` and stays.

### 5.1 Process precautions

| # | Precaution | Why it exists |
|---|---|---|
| P1 | Record a baseline before changing anything. | Without it a pre-existing failure is indistinguishable from a regression you caused. |
| P2 | Never record a command as passing unless it actually ran. Say what you skipped and why. | See M5: a handoff once carried checks that no runtime could have executed. |
| P3 | Name the branch. Never write "ready for production". | Four long-lived branches exist and only two reach an AWS environment. |
| P4 | Run the FULL `npm test` before pushing, never a scoped run. | Required by [`CLAUDE.md`](../../../../CLAUDE.md). Scoped runs have hidden cross-module regressions here. |
| P5 | When a document and the code disagree, **the code wins**. Fix the document. | The framework's stated tie-break. |
| P6 | Never force-add unrelated uncommitted work you find in the tree. Preserve it and hand it back to its owner. | Stray files found during cleanup are somebody's in-flight work, not yours to merge. |
| P7 | Delete a transient branch once it merges. | Only `development`, `qa`, `staging`, `production` survive, so a handoff that names a branch names something that still exists. |
| P8 | Docs changes must pass `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/docs-links.mjs` before pushing. | Docs CI runs them anyway; failing there costs a round trip. |
| P9 | Never restate feature-documentation rules outside [the framework](../../README.md). | A second copy is exactly how these conventions drifted before — see M1. |
| P10 | Set `PAPERCLIP_TEST_AUTH_SECRET` in **every** process that touches the Paperclip harness — including the vitest process, because the bootstrap fixture shells out to `docker compose`, whose YAML interpolation refuses to parse without it. | The integration file otherwise fails in under a second with `Docker command failed`, which looks like a Docker problem and is not. |
| P11 | Never print, commit, or hand off Paperclip test tokens; probe scripts read the `/dev/shm` cache into memory and print only statuses and bodies. | The fixture's secret-safety contract; tokens exist only inside the disposable container. |

### 5.2 Mistakes already made, and their corrections

| # | Mistake | Impact | Correction | Lesson |
|---|---|---|---|---|
| M1 | Feature-documentation conventions were written on several pages at once. | The copies drifted and no page was trustworthy. | Single specification in [the framework](../../README.md), machine-checked by `scripts/ci/feature-knowledge.mjs`. | One rule, one home, enforced by CI rather than by discipline. |
| M2 | The repository-root `handoff.md` was used as live, writable operational state. | It became a stale global handoff that contradicted the per-feature ones. | Reduced to a one-sentence compatibility pointer; CI now fails if it grows back. | Operational state is per-feature. A global handoff always rots. |
| M3 | `infra/lib/dynamo-stack.ts` carries a header comment claiming "All 14 DynamoDB tables". | It creates **32**. The comment misled table-count work. | Read the synthesized template, never the comment. | Comments are not authorities. `infra/lib/constants.ts` and the synth output are. |
| M4 | The CodeBuild deploy branch default was changed from `main` to `production`, then reverted. | Churn on a live CI path; the doc fixes from that change were kept, the behaviour change was not. | Reverted in `4ce27a7`, doc fixes retained. | Do not re-apply this without first establishing why it was reverted. |
| M5 | A feature handoff recorded required checks as complete when the authoring machine had no Node runtime, so they could not have run. | The next reader would have trusted an unverified contract. | Disclosed explicitly in the handoff; Docs CI on `development` became the first real execution. | This is precisely what P2 exists to prevent. Disclosure is the minimum; running the check is the goal. |
| M6 | Targeted Vitest was run inside a Windows **linked worktree**. | Startup failed with `Cannot read directory "../../../../../../../.."` and could not resolve `vitest.config.ts`; no tests collected. | Ran from a normal checkout instead. | On Windows, run test suites from a normal clone. Dependency-free Node CI scripts are fine in a worktree; Vitest is not. |
| M7 | `npm run test:integration:up` was assumed safe alongside the local stack. | It starts LocalStack on port 4566 and collides with Floci. Two emulators must never run at once. | Use `npm run local:test:integration`, which passes `--env-file=.env`. | One emulator on 4566, ever. |
| M8 | `.env` was created for local development while several lifecycle scripts default their environment flag to **prod** and read `.env`. | Commands that were previously inert became genuinely dangerous. | Catalogued in [dangerous commands](../../../../development.md#dangerous-commands-never-run-locally). | Read that list before running any unfamiliar `npm run` script. |
| M9 | The first `updatedSince` patch draft carried the watermark into Paperclip's request-coordination key as a `Date`, which `normalizeIssueListCacheValue` normalizes to `{}`. | Two different watermarks would share one in-flight compute and could return each other's results. | Key on `updatedSince?.toISOString()` explicitly (`527512d`). RESOLVED (`527512d`). | Trace a new parameter through every layer that fingerprints the request, not just the query. |
| M10 | A naive strict `>` watermark predicate was almost used against microsecond-stored `timestamptz`. | A row would be re-returned at its own millisecond-truncated watermark, failing I3 and duplicating reconciler work. | `updated_at >= watermark + 1ms` (`527512d`). RESOLVED (`527512d`). | API callers observe truncated timestamps; compare at the resolution the caller can actually observe. |
| M11 | The vendored `.patch` was first committed with no line-ending pin. | A Windows `autocrlf` checkout would deliver CRLF and `patch`(1) inside the Debian build container would reject it — the image build breaks only on other machines. | `.gitattributes` pins `eol=lf` (`a7ab7a3`). RESOLVED (`a7ab7a3`). | Any file consumed byte-exactly inside a Linux container needs an explicit `eol=lf`. |
| M12 | A first clone of the Paperclip release on Windows silently checked out incomplete (4,000+ files missing) with `Filename too long`. | Greps against the partial tree would have "proven" code absent that exists. | `git config core.longpaths true` + `git reset --hard HEAD`, then verify `git status` is clean before trusting the tree. | On Windows, verify a clone is complete before drawing any conclusion from it. |

### 5.3 Standing assumptions

| # | Assumption | Confidence and caveat |
|---|---|---|
| A1 | Local development never reaches real AWS; `AWS_ENDPOINT_URL` is the isolation control and `scripts/local/guard.ts` fails closed. | Verified. Prove it any time with `npm run local:verify`, which requires account id `000000000000`. |
| A2 | [`development.md`](../../../../development.md) was verified on **macOS**, Floci 1.6.0, Docker 28.3.2, Node 24.3.0, on 2026-08-10. | Windows and Linux behaviour is **not** covered by that verification. See M6. |
| A3 | Bedrock is a **stub** locally: fixed placeholder text, `stopReason` always `end_turn`, no `ConverseStream`, no embeddings. | Local development validates plumbing, never model behaviour. Tool use is unreachable locally by design. |
| A4 | `qa` deploys nothing, and merging to `production` deploys nothing on its own. | Verified in `.github/workflows/deploy.yml`; deployment is `workflow_dispatch` only and requires typing `deploy`. |
| A5 | Table names are compiled in at import time (`process.env.TABLE_X ?? 'claudeclaw-<literal>'` in a module-level const). | A `TABLE_*` override must be set before the first import. `src/lib/state/agents-repo.ts` is the lone lazy exception. |
| A6 | AWS console access for this account is root-user sign-in via `aws login` with the `netzer-root` profile. | The `netzer-dev` SSO profile is known broken. Do not burn time on it. |
| A7 | The pinned Paperclip image contains full source and toolchain and runs as root, so a derived image can patch + `tsc` in place. | Verified against `2026.722.0`. Re-verify on every re-pin; upstream could slim the image. |
| A8 | Paperclip stamps `updated_at` from two clocks (DB `now()` on insert, Node `new Date()` on update). | Verified in pinned source. The reconciler must tolerate skew; do not treat watermarks as exact. |
| A9 | The Windows baseline failures (4 `scripts/ci` parser suites, buildspec `sh` missing, rollback path separator, intermittent Jarvis timeouts) are environmental and predate this work. | Verified at `4bdbf08` and unchanged since. Compare failing file *names*, not counts. |

### 5.4 Known traps that cost time

Short pointers only. The owning document has the detail; do not copy it here.

| Trap | Where the detail lives |
|---|---|
| A bare `KEY=` in `.env` becomes `''`, and zod's `.optional()`/`.default()` only fire on `undefined`. Omit the line instead. | [Environment variables](../../../../development.md#environment-variables) |
| `.env.example`, `.env.reference` and `.env.staging.example` all fail `loadEnv()`. Only `.env.local.example` works. | [Environment variables](../../../../development.md#environment-variables) |
| `NODE_ENV=production` locally arms a deployed-task fail-fast; the orchestrator refuses to start. | [Environment variables](../../../../development.md#environment-variables) |
| `CCE_NAME_SUFFIX` renames tables but four modules read the unsuffixed literal anyway. | [Environment variables](../../../../development.md#environment-variables) |
| Vite does **not** always use port 5173, and binds `localhost` (IPv6 `::1`), so the IPv4 literal fails. Read the URL Vite prints. | [Troubleshooting](../../../../development.md#troubleshooting) |
| `GET /ready` returning `503` locally is **correct** — Slack and Telegram are genuinely unconfigured. | [Starting development](../../../../development.md#starting-development) |
| A poisoned row in `claudeclaw-dashboard-tokens` causes a permanent `401` with a correct token. Fix: `npm run local:provision`. | [Troubleshooting](../../../../development.md#troubleshooting) |
| Floci answers `ConverseStream` with 501; the replay-as-non-streaming fallback fires **only** when `AWS_ENDPOINT_URL` is set. | [Troubleshooting](../../../../development.md#troubleshooting) |
| `src/adapters/dashboard/jarvis.flow.test.ts` intermittently times out at 5000 ms. Pre-existing flake. Reproduce twice before chasing it. | [Troubleshooting](../../../../development.md#troubleshooting) |
| The IAM Copilot **degrades invisibly** locally: an empty findings list renders identically to "validated clean". | [Known local limitations](../../../../development.md#known-local-limitations) |
| The cost waste scan reports a **false clean** and caches it for 30 minutes. Local cost output is not meaningful. | [Known local limitations](../../../../development.md#known-local-limitations) |
| `npm run doctor`, `status` and `verify` fail rather than skip against an empty emulator. They give no useful local signal. | [Known local limitations](../../../../development.md#known-local-limitations) |
| `npm run test:paperclip:all` chains with `&&`, so when a test fails the `down` step never runs; clean up the disposable stack explicitly. | [Paperclip README §8](../README.md#8-exact-focused-and-full-validation-commands) |
| Docker Desktop's CLI is outside `PATH` on this machine; npm lifecycle scripts need it prepended, fixtures auto-detect via `LOCALAPPDATA` or `DOCKER_BIN`. | [Paperclip README §8](../README.md#8-exact-focused-and-full-validation-commands) |

### 5.5 Appended 2026-08-19 (docs consolidation)

| # | Entry | Detail |
|---|---|---|
| M13 | The single most load-bearing document in this feature — the 822 KB implementation plan — was left in a Claude temporary scratchpad for a day, and the feature README recorded that as an acceptable state ("an external session artifact (not tracked in this repository)"). | A temp directory is not a location. Anything a future phase must be built from belongs in the repository the moment it is written, even if it is large and even if it is historical. RESOLVED (that session). |
| M14 | The first session log was written before the feature folder existed and then never brought into the framework: untracked, no frontmatter, absent from the session index. | The origin record of a feature is the one log most likely to be needed and least likely to be reproducible. When a feature folder is created after work has started, back-fill the earlier logs into it in the same session. RESOLVED (that session). |
| M15 | The README and HANDOFF drifted three commits behind the code they described — the README still said "first-milestone validation only" after Phase 1 infrastructure landed, and the HANDOFF called a merged PR open. | Phase-completion commits must update the canonical two files in the same commit, not in a later documentation pass. |
| P12 | An adversarial audit of a plan is worth as much as the plan and must be stored beside it. | The audit found two cited paths that do not exist and a five-citation cluster with a systematic +92-line offset anchoring an architecture argument. A plan without its audit reads as more certain than it is. |
| A10 | The implementation plan is **historical**, not current. ADR 0010's amendment and `plan-audit.md` both outrank it. | Its "Paperclip source changes required: **None**" premise is dead — the harness runs a patched artifact. Do not quote the plan as a live constraint. |

### 5.6 Appended 2026-08-19 (OIDC and staging deploy)

| # | Entry | Detail |
|---|---|---|
| M18 | `infra/lib/{database,filesystem}-stack.ts` described their security groups with an em dash. EC2 rejects `GroupDescription` outside ASCII, so `CCE-STAGING-Filesystem` rolled back on first create. | The repo's prose style uses em dashes everywhere, so this will recur. Both stacks carried it; fixing only the one CloudFormation named would have failed again on the next stack. Guarded by a synth assertion in both stack test files. RESOLVED (`dac255a`). |
| M19 | The rolled-back `CCE-STAGING-Filesystem` left **orphans**: EFS `fs-08f70326911d2ae49` and log group `/claudeclaw-staging/paperclip` are `RemovalPolicy.RETAIN`, so CloudFormation logged `DELETE_SKIPPED` and abandoned them. | A rolled-back stack is not necessarily a clean slate. EFS names are tags, not unique keys, so a retry silently creates a *second* filesystem and bills for both. Check for orphans after any rollback of a RETAIN-bearing stack. |
| A14 | A staging deploy does **not** touch `ClaudeClawGitHubDeploy`: `iam-stack.ts` gates the role on `!isStagingDeploy` and staging sets `CCE_NAME_SUFFIX`. | Verified in source. Only a production deploy regenerates that trust policy, so an IAM hand-fix survives staging deploys indefinitely. This corrects the broader claim first written in P13. |
| M16 | After the org transfer, the trust policy was updated to the new **repo path** and the deploy still failed — a second session lost to an `AssumeRoleWithWebIdentity` error that reads like an AWS permissions problem. | An org transfer can change the claim **format**, not merely its contents. Decode the token's real `sub` before touching IAM. RESOLVED (`07a2570`). |
| M17 | A session committed with explicit `git add <paths>`, believing that scoped the commit — but a concurrent agent had staged its own work into the **shared index**, and `git commit` committed the index, sweeping ~900 KB of another session's docs into a commit whose message described a small refactor. | `git add <paths>` scopes what *you* add, not what the commit contains. When another process may share the working tree, verify with `git status`/`git diff --cached` immediately before committing, or use `git commit <paths>`. Corrected by splitting the commit in two. RESOLVED (`04c9f90`). |
| P13 | Set `CCE_GITHUB_IMMUTABLE_SUBJECT` **before the next production deploy**. Only the prod IAM stack creates this role (`iam-stack.ts` gates on `!isStagingDeploy`), so a prod deploy with the variable unset rewrites a hand-patched trust policy back to the classic form. Staging deploys never touch it. | The fix has two halves with a required order; reversing it re-creates the outage and looks like a regression. First stated without the prod-only qualifier — corrected against the code, per **P5**. |
| P14 | When an OIDC assume-role fails, decode the token's real `sub` before changing IAM. | The error names AWS; the cause was on GitHub's side. |
| A11 | `Adams-Captial-Holdings-Ltd/Netzer-Labs` mints **immutable** OIDC subjects: `repo:Adams-Captial-Holdings-Ltd@318461635/Netzer-Labs@1324639154:...`. | Verified twice on 2026-08-19 — a decoded token from run `32280530601`, and `sub_claim_prefix` from the OIDC customization API. Re-verify if the repo moves again. |
| A12 | The deploy workflow needs no repository or environment **secrets**; it reads only `vars`, all of which survived the transfer. | Verified with `gh variable list` and the per-environment variables/secrets API. `CDK_DIFF_ROLE_ARN` is still absent and still only affects the scheduled drift workflow. |
| A13 | The live `ClaudeClawGitHubDeploy` trust policy now lists the four id-bearing subjects and matches the fixed generator's output exactly. | Verified with `aws iam get-role` against the regenerated policy on 2026-08-19, so the next `cdk deploy` is a no-op on the trust rather than a flip-back. |
| Trap | A **production** `cdk deploy` rewrites `ClaudeClawGitHubDeploy`'s own trust policy; staging deploys skip the role entirely (`iam-stack.ts` gates on `!isStagingDeploy`). | [github-to-aws.md](../../../github-to-aws.md), `infra/lib/iam-stack.ts` |
| Trap | Phase 1's Aurora and EFS stacks have **no tier gate**, so Tier 0 staging provisions the same retained, deletion-protected cluster as production. | `infra/bin/app.ts`, `infra/lib/database-stack.ts` |
| Trap | The Paperclip bootstrap fixture aborts on a **stale** stack (`Active Paperclip integration keys exist without the in-memory credential cache`), not only a missing one. Reset the disposable stack per run rather than reusing one a previous session left up. | `tests/fixtures/paperclip-bootstrap.ts`, [README §8](../README.md) |

### 5.7 Appended 2026-08-19 (staging deploy green)

| # | Entry | Detail |
|---|---|---|
| M20 | Infrastructure that nothing consumes was wired unconditionally into the deploy path, so a failure in an unused experiment reported as a failure to ship application code. The orchestrator was healthy at 1/1 throughout. | Ship unconsumed infrastructure behind a flag from the first commit, not after it breaks a pipeline. `void database; void filesystem;` in `app.ts` was the tell — bindings that exist only to silence "unused" are infrastructure with no consumer. RESOLVED (`bc4909b`). |
| M21 | A local `scripts/ci/docs-mermaid.mjs` run reported 15 failures where CI reported 1, including blocks CI renders successfully. | The pinned renderer does not work on this Windows machine. Do not treat local mermaid output as signal; push and read CI. Add to the Windows environmental set with the four parser suites and the rollback path separator. |
| P15 | Before committing in a tree another agent may share, check `git diff --cached --name-only`. `git add <paths>` scopes what *you* add, not what the commit contains. | See M17. The index is shared; a concurrent `git add` rides along on your `git commit`. |
| A15 | Only a **production** deploy rewrites `ClaudeClawGitHubDeploy` (`iam-stack.ts` gates on `!isStagingDeploy`). | Proven from synthesized artifacts: 15 staging templates contain zero `ClaudeClawGitHubDeploy`; the prod template contains `GithubDeployRoleB0CF66A5`. Supersedes the broader claim first written in P13. |
| A16 | The EC2 non-ASCII constraint applies to security group descriptions, not to CloudFormation generally. | 9 live CloudWatch alarms in this account carry non-ASCII descriptions and are deployed and healthy. Do not "fix" em dashes outside EC2 SG descriptions. |
| A17 | Staging is green at `e8ba485` on task definition `claudeclaw-staging-orchestrator:8`, with `CCE_PAPERCLIP_ENABLED` unset so the Paperclip substrate is not deployed. | Verified 2026-08-19 by deploy run, `describe-services`, `describe-stacks`, and `GET https://staging.pgnos.ai/health`. |
| Trap | A rolled-back stack is not a clean slate: `RemovalPolicy.RETAIN` makes CloudFormation log `DELETE_SKIPPED` and abandon the resource. EFS names are tags, not unique keys, so a retry silently creates a second filesystem and bills for both. | `infra/lib/filesystem-stack.ts`; check for orphans after any rollback of a RETAIN-bearing stack. |
| Trap | `infra/bin/app.ts` is mapped to `docs/diagrams/architecture-compute.md` in `docs/diagrams.map`. Any change to it fails the drift gate without a diagram update or a verification note. | `docs/diagrams.map`, `scripts/ci/diagrams-drift.mjs` |

### 5.8 Appended this session (2026-08-19, Phase 1 ponytail audit)

| # | Entry | Detail |
|---|---|---|
| M22 | `bc4909b` gated the Paperclip stacks in `infra/bin/app.ts` and nowhere else, while `scripts/deploy.ts` phase a still named them and `cdkEnvBag` never forwarded the flag. Arming `CCE_PAPERCLIP_ENABLED=1` in `.env` therefore deployed **nothing**, and said so with a green deploy. | A feature flag in this repo has five homes (§3.1). Gating one is not gating the feature; it is creating a disagreement between synth and the deploy driver. When adding a flag, grep for how `CCE_CODEBUILD_ENABLED` is handled and match it in all five. RESOLVED (`e9de42b`). |
| M23 | Phase 1 shipped three ungated Paperclip side-effects that the later gate never covered: an ECR repo created on every deploy for an image nothing pushes, cost copy naming an Aurora cluster the deploy does not create, and a budget alarm raised $50 for a substrate that is off. | "Gate the stacks" is not the same as "gate the feature". After adding a gate, grep the whole repo for the feature's name and check every hit for whether it is now lying. RESOLVED (`e9de42b`). |
| A18 | **`cdk deploy`/`ls`/`diff` do not fail on an unmatched stack name when another pattern in the same invocation matches.** `validateStacksSelected` (`node_modules/aws-cdk/lib/cli/cdk-toolkit.js:1250-1254`) throws only when the total selected count is zero. | Verified by reading the installed `aws-cdk@2.1124.1` and demonstrated with `npx cdk ls CCE-Network CCE-Database` against a flag-off assembly: exit 0, `CCE-Database` silently absent. Never trust a green deploy to mean a named stack was deployed. |
| A19 | `estimateLine`'s estimator branch returns before the `privateEndpoints` clause is built, so the ~$220 endpoint note only ever appears when the estimator has **failed**. `scripts/cost-estimate.mjs` also prices no Aurora, EFS or RDS line item. | Do not copy the endpoints clause as a pattern — it is the buggy branch. Anything appended to the fallback alone is invisible on the path that normally runs. |
| A20 | `RESOURCE_NAMES` is derived from `CCE_NAME_SUFFIX` at import time, so asserting a synthesized name equals `RESOURCE_NAMES.x` compares the constant with itself. | `infra/lib/constants.test.ts:82,107-109` is the house precedent: assert literals, or call `buildResourceNames('')` explicitly. A test written the other way passes under any rename. |
| P16 | Do **not** gate the `/claudeclaw/paperclip` secret, or any other already-deployed `RETAIN` resource with a fixed name, behind a flag after the fact. | Removing it from the template makes CloudFormation `DELETE_SKIPPED` it. Secrets Manager names are unique keys, so a later re-arm fails `ResourceExistsException` — and the 7-day recovery window means even a deliberate cleanup is not instant. Gate before first deploy or not at all. |
| P17 | Do not merge `CCE-Database` into `CCE-Filesystem` or vice versa. | Both are `RETAIN`; Aurora is `deletionProtection: true`. A merged stack turns an EFS create failure into an orphaned, deletion-protected Aurora cluster. The plan's §14.6 describes a single combined stack that was never built — do not "restore" it. |
| A21 | Git Bash on this machine has **no coreutils**: `ls`, `cat`, `head`, `tail`, `grep`, `sed`, `sh` and `npm` are all absent from its PATH. | Use PowerShell for commands and the editor's own file tools. This is also why `scripts/release/buildspec-tag-normalization.test.ts` fails with `spawnSync sh ENOENT` — it is the same environmental cause as the rest of the **A9** set, not a code fault. |

### 5.9 Appended this session (2026-08-20, Phase 2 readiness)

| # | Entry | Detail |
|---|---|---|
| M24 | The out-of-band catalog was treated as if it drove teardown. It does not. `plan.catalogAppOwned` is parsed, classified and **printed** (`teardown.ts:582`); every actual deletion is hand-written, including the orchestrator ECR repo at `teardown.ts:801`. | The previous handoff's ECR instruction was "add it to `docs/out-of-band-catalog.json` so teardown removes it" — which would have produced a documented orphan. When a resource is created out of band, write the catalog row **and** the delete. Verified by grepping every use of `catalogAppOwned` before writing the comment that claims teardown removes it. |
| M25 | The Phase 1 audit deferred `observability-stack.ts:742`'s `retentionFromDays` as "still has its own dead `retentionFromDays`". It was **not dead** — `:80` called it. | "Dead" is a claim about callers, and it costs one grep to check. A deferred item inherited from a handoff is still unverified until you verify it. RESOLVED (`be807dd`). |
| M26 | Two consecutive handoffs carried "the ARM64 question is unanswered" as an unmet Phase 2 precondition requiring a `docker buildx` run. The base image had carried `linux/arm64` all along. | A precondition phrased as work-to-do can often be settled by **reading** instead. One anonymous GHCR token and one manifest GET closed a blocker that had been open across three sessions. Check whether a blocker is a question before scheduling it as a task. RESOLVED (**A22**). |
| A22 | The pinned artifact `ghcr.io/paperclipai/paperclip:2026.722.0@sha256:6b9daa3c…` is an **OCI image index** carrying `linux/amd64` (`sha256:6936579e…`), `linux/arm64` (`sha256:6ab3c816de36f9a69e9f462e950a153e3d30b6cbc03f9a78c5b140277fbafa25`) and two attestation manifests. | Verified 2026-08-20 by anonymous token + manifest GET against ghcr.io, HTTP 200. `vendor/paperclip/Dockerfile` pins the **index** digest, which is correct for multi-arch: the builder selects the platform. Re-verify on every re-pin — a slimmed upstream could drop arm64, and the whole compute plane is `CpuArchitecture.ARM64`. |
| A23 | `ComputeStack`'s HTTPS:443 listener exists **only** when `DOMAIN_NAME` is set, defaults to a **403** when `tier.cloudFrontEnabled`, and has priorities **1 and 2** already taken by `CloudFrontOnly` and `DirectHost`. | Now exported as an optional `httpsListener`. A Phase 2 listener rule must start at priority 3, carry its own condition, and handle the field being `undefined`. Target-group health checks bypass listener rules and stay green regardless. |
| A24 | `EnvBag` in `deploy.ts` has an index signature, so a new `.env` key reaches the deploy driver with no plumbing. `cdkEnvBag` is the `.env` → **synth** allowlist and matters only for values read during `cdk synth`. | `PAPERCLIP_BETTER_AUTH_SECRET` is consumed in phase b, so it correctly needs **no** `cdkEnvBag` entry. Do not cargo-cult the **M22** fix onto every new variable; ask whether synth reads it. |
| P18 | Never mint a secret value inside `planSecretWrites`. It runs on **every** deploy, so the value would be regenerated every deploy. | Generate once in `npm run setup` into `.env`, the shape `state.appEncryptionKey = state.appEncryptionKey ?? generateHexToken(32)` already uses. Rotating Paperclip's `better_auth_secret` invalidates every session. |
| P19 | `PutSecretValue` replaces the **whole** `SecretString`. A secret whose fields are owned by different phases needs `mergeExisting`, not a plain plan. | `/claudeclaw/paperclip` has one deploy-owned field and three minted against the running instance later. Before adding any secret plan, ask which phase owns each field. |
| P20 | `scripts/ci/diagrams-drift.mjs` diffs `origin/<base>...HEAD` — **committed** changes only. Editing a diagram without committing it does not clear the gate. | Costs a confusing re-run otherwise. Also: `compute-stack.ts` is mapped to **three** diagrams, so one source edit can require three notes. |
| Trap | `git commit -- <paths> -m "<msg>"` fails: everything after `--` is a pathspec. | Use `git commit -m "<msg>" -- <paths>`. |
| M27 | The Paperclip ECR create was added to `scripts/deploy.ts` phase a only. **CI does not run `scripts/deploy.ts`** — it runs `npx cdk deploy --all` and mirrors the phased driver with its own steps, so the fix would not have executed on the path that reaches staging. | The deploy driver has **two homes**, exactly as a feature flag has five (**M22**). The CI step's own comment already recorded the previous round of this: "scripts/deploy.ts does this for local deploys; the CI workflow never did, so the first staging deploy hit a 403". Grep `.github/workflows/deploy.yml` for anything you add to `deploy.ts`. RESOLVED (`c6d491f`). |
| A25 | **Staging deploys automatically on a push to the `staging` branch** (`on: push: branches: [staging]`). It is not `workflow_dispatch`-only. | **A4** says deployment "is `workflow_dispatch` only and requires typing `deploy`". That is correct for **production** and wrong for staging. Merging to `staging` IS a deploy. |
| A26 | **CI populates no secrets at all.** `put-secret-value` appears **zero** times in `.github/workflows/deploy.yml`, so `populateSecretsV2` never runs on the CI path — for any secret, not just Paperclip. | A staging deploy therefore leaves `/claudeclaw-staging/paperclip` at `REPLACE_ME` regardless of the phase-b plan. Pre-existing and architectural. Phase 2 needs a decision on how staging gets `better_auth_secret`. |
| P21 | Before re-deploying a `RETAIN`-bearing stack that previously rolled back, **check for orphans with FIXED names first**. | `filesystem-stack.ts:71` creates `/claudeclaw-staging/paperclip` with an explicit `logGroupName`, and **M19** says the 2026-08-19 rollback abandoned exactly that log group. CloudFormation cannot create a fixed-name log group that already exists, so the stack rolls back at the same point again. A tag-named resource like EFS fails differently and worse: it succeeds, and you pay twice. |

### 5.10 Appended this session (2026-08-20, image pipeline and Phase 2)

(entries appended as they are earned)

### 5.11 Appended this session (2026-08-20, Paperclip end to end)

| # | Entry | Detail |
|---|---|---|
| M28 | **Paperclip silently ignores unknown query parameters.** Sending `updatedSince` to a build without the vendored patch returns **HTTP 200 with the full, unfiltered issue list** — not a 400, not an error. | This is a silent data-correctness trap, and it is the failure mode a reconciler is least able to detect: it looks like a successful poll that just happened to return a lot of rows. Mitigated by the **A1-8 boot probe**, which asserts that `updatedSince=<now + 1h>` returns `[]` and refuses to start the reconciler if it does not. |
| M29 | The historical implementation plan's Paperclip line-number citations are from a **different revision** than the pinned tag, systematically — not the 16 one-off errors `plan-audit.md` catalogued. Checkout, release, comments and force-release all disagree by hundreds to thousands of lines. | Recorded as hard rule **A1-16**: never cite a Paperclip source line number as authority. Cite method + path + observed behaviour + the probe name that proves it. |
| M30 | ADR 0010's ratified watermark predicate `updated_at >= watermark + 1ms` is a **correctness hazard**, not merely a conservative choice. `updated_at` is microsecond-stored `timestamptz` while every API caller observes millisecond-truncated values, so querying `>= T + 1ms` permanently loses any row whose true timestamp falls in `[T, T+1ms)` and was not already in the processed page. | Superseded by C-2: query `>= (maxUpdatedAt − poll_overlap_ms)` and dedupe client-side on `(id, updatedAt)`. The ADR must be amended in the same PR as the reconciler. Prove it with a probe that writes two issues inside one millisecond. |
| M31 | `src/lib/paperclip/mission-projection.ts` hardcodes `createdByChat: 'paperclip'`, while `privacy-tools.ts` filters a subject's missions by `m.createdByChat === chatId`. Every Paperclip-origin mission would therefore **silently disappear from a user's GDPR export**. | A compliance regression with no test coverage, invisible until audited. Fixed by a Netzar-side provenance row written at create time; the test ships in the same PR. Blocking gate on Phase 7. |
| A27 | **The `updatedSince` patch is present and working in the running artifact.** Verified 2026-08-20 by grepping the built image: 14 occurrences across `/app/server/dist/routes/issues.js`, `/app/server/dist/services/issues.js` and `services/issues.d.ts`. | This is the first execution-time confirmation of ADR 0010's amendment; every prior statement was source-only. Re-verify on every re-pin. |
| A28 | Upstream now implements `updatedSince` natively: absent at `v2026.722.0` and `v2026.817.0`, present on master via PR #9050, released in `v2026.818.0-beta.1`. | The ADR amendment's re-pin rule is now live rather than hypothetical — **drop the patch** in the same change that bumps to a release carrying it. Until then the patch stays and A1-8 guards it. |
| A29 | **`A21` does not hold for every Bash in this repository.** The Bash tool in this session has coreutils, `sh`, `git`, `node` and `npm` on PATH. | `scripts/release/buildspec-tag-normalization.test.ts` passes here, which is why this session's baseline is 5 failing files where the previous session's was 6. Compare failing file **names**, never counts — exactly what **A9** already says. |
| A30 | `paperclip_disabled` is registered in all three places but has **zero callers** — it is inert. `neutralizeForPrompt` is likewise implemented, tested, and called by nothing. | Both are latent no-ops that read as shipped safety. The kill switch goes inside the client at every invoke so no caller can bypass it; `neutralizeForPrompt` is wired at the Jarvis and dispatch-ingest boundaries. |
| P22 | Set `PAPERCLIP_TEST_AUTH_SECRET` in **every** shell that touches the harness — including plain `docker compose ps`, which fails to interpolate the Compose file without it. | Broadens **P10**, which named only the vitest process. The failure message names the variable, but it looks like a Docker fault at a glance. |
| P23 | `/gsd-phase` and the GSD skill family operate on `.planning/ROADMAP.md`. This repository has no such directory and its process documentation forbids second copies of planning conventions. | Phase plans belong in `docs/features/paperclip/`. Do not stand up a parallel planning tree here; it is the exact drift **M1** records. |

### 5.12 Appended after the first live probe run (2026-08-20)

Eleven of thirteen contract probes ran green against the pinned artifact. These
are the facts that run produced, and several of them correct a document.

| # | Entry | Detail |
|---|---|---|
| A31 | **`GET /api/openapi.json` is reachable unauthenticated** and returns the full document: 475 paths, 704 KB, at the pinned digest. | This is the authoritative machine-readable contract (**A1-15**) and it needs no credentials, so the snapshot can be taken by anything that can reach the port. It settled two probe failures in minutes that a source read had left open. Take the snapshot from the running artifact, never from a source read. |
| A32 | The agent-key scope payload is `{name, scope: {kind: 'standard' \| 'task_bridge', …}}` — **nested under `scope`, with `name` required**. The `task_bridge` variant requires only `kind`; `projectId`/`projectIds`/`parentIssueId`/`parentIssueIds`/`allowedAssigneeAgentIds` are all optional. | The first A1-9 probe sent `{kind:'task_bridge'}` flat and omitted `name`, and got a bare `400 Validation error` that named nothing. Paperclip's validation errors do not tell you the shape; the OpenAPI does. |
| M32 | **The bar's own criterion A1-12 was wrong.** It asserted `/wakeup` answers **202** for both the run and the skipped envelope. The live OpenAPI declares **200** (plus 400/401/403) and types the response as an undocumented `additionalProperties: {}`. The probe observed `status: 'queued'`, not `'skipped'`. | The claim came from a source read of a 400 KB route file, which is exactly the class of claim **A1-16** already distrusts — it turns out status codes are as unreliable as line numbers when read at that scale. The bar's stated precedence already covers this: *a green contract probe against the pinned artifact beats all four documents*, and that includes the bar itself. Correct A1-12 against the artifact, and do not treat any unprobed status code in A1 as settled. |
| A33 | **C-3 is settled, and Packet 4 was right where Packet 1 was wrong.** A run-less agent actor can POST a comment and PATCH an issue: `commentRequiresRunId: false`, `patchRequiresRunId: false`, observed. | This is load-bearing for the ACL, which comments as a run-less actor. The ACL does **not** need to degrade to `wakeup` for comments. Recorded by characterization, not assertion. |
| A34 | **A1-8 is green against the patched artifact**: `updatedSince` one hour in the future returns `[]`. **C-2 is green**: an overlap-and-dedupe read sees same-millisecond writes exactly once. | These are the two blocking probes. A34 is the first end-to-end proof that the vendored patch does what ADR 0010's amendment claims, and that the C-2 predicate (`>= maxUpdatedAt − poll_overlap_ms` with `(id, updatedAt)` dedupe) is lossless where the ADR's `+1ms` is not. The reconciler may now be built on it. |
| P24 | **Reset the disposable stack before every probe run**, not just when one looks stale. | The fixture fails closed with `Active Paperclip integration keys exist without the in-memory credential cache` whenever a previous bootstrap left keys behind — and its credential cache is in `/dev/shm`, which **does not exist on Windows**, so on this platform the cache never survives a process boundary and the second run in a session always trips it. `npm run test:paperclip:down && :up` between runs. This broadens the existing Trap from "a stale stack" to "any second run on Windows". |

### 5.13 Appended at session close (2026-08-21)

| # | Entry | Detail |
|---|---|---|
| M33 | **A readiness gate can be catastrophic in the direction nobody checked.** Phase 4 made the Paperclip service's *existence* depend on a probe reading `cdk-outputs.json` — a **gitignored, machine-local** file — with a failure default of **omit the service**. On CI, a fresh clone, or a second engineer's machine the probe can never succeed, so `cdk deploy --all` would **delete a running Paperclip service and its listener rule**, print "re-run the deploy", and **exit 0**. | This is the cloudflared post-mortem repeating, whose own conclusion is quoted in `.github/workflows/deploy.yml`: *"Both directions have to be safe."* A gate that protects against starting a container against an unpopulated secret must not create a silent-delete path going the other way. When adding a readiness gate, write down what happens when the probe fails **on the resource that already exists**. |
| M34 | The five Paperclip CodeBuild IAM grants were written onto `cicdRole`, which `iam-stack.ts` creates **only** in the `!isStagingDeploy` branch — making a staging arm depend on a **production** IAM deploy. Verified against the live `ClaudeClawGitHubDeploy` role: every ECR grant was orchestrator-scoped and there were zero Paperclip statements, so an armed staging run would have failed `AccessDenied` at the ECR repo create **after Aurora already existed**. | Third instance of the shape **M22** and **M27** record. Fixed by mirroring into the staging branch with `Role.fromRoleName(...).addToPrincipalPolicy(...)` — the pattern `PublicTunnelReadinessStaging` already proves live in this account — narrowed to `claudeclaw-staging-paperclip*`. **Before granting anything to CI, read the LIVE role; the code is a plan, the role is the fact.** |
| M35 | Every one of the eight critic rejections across Phases 1 and 1.5 was the same defect class: **a claim no probe supported.** A wrong discriminator, a wrong status code, a wrong endpoint purpose, a fabricated `retryAfterSeconds` comment, a placeholder snapshot presented as a contract. | The remedy that finally worked was making "an honest `UNVERIFIED` marker beats a claim no probe supports" an explicit instruction. `ISSUE_LIST_DEFAULT_LIMIT` and friends now carry that marker, because the harness board is smaller than the thresholds and no probe can distinguish 500 from 5000. |
| A35 | **The pinned image ships its built UI and it serves.** `/app/ui/dist` (13 MB, with `index.html`) exists; the server resolves `../ui-dist`, which does not. With a symlink and `SERVE_UI=true`, `GET /` answers 200 `text/html` and `/assets/index-*.js` answers 200 with **6,484,747 bytes**. Runtime branding hooks exist (`PAPERCLIP_LOGO_SVG`, favicon markers). | Amends plan §16.6, which ruled "rebuild in Netzar". Its four reasons still hold but argue for controlling **access**, not rewriting. Re-verify on every re-pin: this is a path convention, not a supported contract — and §33 records upstream saying branding must not be counted on. |
| A36 | **Delegation needs no Paperclip change**, and the turn budget survives: `POST /api/issues/{id}/children` takes an **array** with per-child `assigneeAgentId`, so a fan-out to five agents costs **one** tool turn, not five. `wakeup` takes an `idempotencyKey`, so retries are safe. | But `suggest_tasks` is a trap: it looks ideal and its `/accept` is **board-only**, so an agent calling it stalls until a human clicks. And **co-owned projects have no model at all** — `leadAgentId` is a single uuid, zero hits for participant/watcher/collaborator across 475 paths, and `checkout` is an exclusive lock. Co-ownership must be one parent + N assigned sibling children, a Netzar convention. |
| A37 | `GET /api/companies/{cid}/timeline` is the **only fully-typed response schema** in the delegation area and returns `edges[]` with `kind: delegation\|assignment\|mention` — an **observed** collaboration graph, filterable by project. | Better than the org chart for the client-facing "see how agents work together" goal: `reportsTo` is hand-set and rots, the timeline is self-maintaining. Lead with the timeline, scoped by project. |
| A38 | **Open self-registration.** Probed live: `POST /api/auth/sign-up/email` returns **200 with no credential** even under `PAPERCLIP_DEPLOYMENT_MODE=authenticated`. | Matters the moment the board is reachable. Must be closed or fronted before any Netzar user can reach the UI. |
| P25 | Run one gauntlet per working tree. Two concurrent builder/critic loops sharing a checkout produced a red typecheck attributed to the wrong phase. | No damage — the builder proved attribution before proceeding — but it costs a confusing round. Serialize phases that share a tree, or give each a worktree. |
| P26 | `node scripts/ci/docs-mermaid.mjs --extract-only` runs the **node-budget** check WITHOUT rendering, so it is trustworthy on this machine despite **M21**. | M21 says local mermaid output is not signal. That applies to the *renderer* only. The budget check caught a 41-vs-40 failure locally in one second that would otherwise have cost a CI round trip. |


### 5.14 Appended this session (2026-08-21, phases 2 through 9)

| # | Entry | Detail |
|---|---|---|
| M36 | The Phase 2 client shipped a create body carrying `status`, and an `idempotencyKey` **without** `allowDuplicate: true`, while a comment cited A1-13's `200 + deduplicated: true` as proven. A1-13 proved that only for a body carrying `allowDuplicate: true` — and `client.ts` auto-retries any write that has an idempotency key. | Two independently harmless-looking choices combined into a duplicate-issue-on-retry bug. Caught only because the critic checked the *cited* probe rather than trusting the citation. **When a comment cites a probe as authority, open the probe and check that it proves the shape actually being sent.** RESOLVED this session — `status` deleted from `missionToIssueCreate`, `allowDuplicate: true` added, key made deterministic (`netzar-mission:<mission.id>`), pinned by a test asserting `not.toHaveProperty('status')`. |
| M37 | `types.ts` and `error.ts` shipped in the same changeset giving **opposite normative instructions** about the same two strings: `types.ts` said "Do not map them from prose; produce them first", while `error.ts` mapped them behind an UNVERIFIED marker. | Neither was wrong on its own; together they guarantee the next maintainer deletes one of them. A doc-vs-code disagreement inside one changeset is a defect even when the code is right — **P5** says fix the document, so `types.ts` now records what `error.ts` does and why. RESOLVED this session. |
| A39 | **A blind head-to-head is worth running and this project can win it.** Five rounds, three judges each (craft / three-year maintainer / consumer), both files anonymized and the A/B order deliberately flipped every round: ours was B, A, B, A, B and won **15 of 15**. | The alternating order is the control — without it a sweep proves position bias, not quality. Note what it did *not* do: the blind judges passed our client in round 1, while the bar critic kept rejecting it through round 4. **Winning blind is necessary, not sufficient** — beating a rival file says nothing about matching *this* artifact's observed contract. |
| A40 | `Agent(isolation: "remote")` does **not** reach a cloud machine from this session — the probe reported it running in a local git worktree under `.claude/worktrees/` with the same local Docker daemon. | So "run it in the cloud" is not available by that route. Do not assume the flag means what it says; probe it with `pwd` + `docker --version` before planning around it. |
| A41 | Creating a claude.ai cloud **routine** against this repo fails `HTTP 403 — You don't have access to a repository this routine uses`. `Netzer-Labs` is PRIVATE under the `Adams-Captial-Holdings-Ltd` org, and the Claude GitHub integration has not been granted access to it. A local `gh` login (scopes `repo`, `workflow`, `read:org`) does **not** carry over — the cloud has its own grant. | Probably a consequence of the org transfer (**M16**, **A11**). Unblocked only by an org owner authorizing the integration for that repo; it cannot be fixed from a non-interactive session and must never be worked around with a pasted token. |
| M41 | Phase 6's first critic passed every acceptance item, then named a loss channel: the route takes a durable 24 h claim BEFORE the work runs and the worker never rejects, so any post-ack failure was permanently swallowed — Paperclip got its 202 and would not retry. The compensating control its own contract names ("the reconciler is the mandatory mitigation for dispatch loss and must be live first") **does not exist**: Phase 5 ships observing-only and writes nothing even at `mode:'live'`. | A phase can satisfy every enumerated acceptance item and still ship a defect the acceptance list never thought to enumerate. Ask separately: *what does this lose, and what recovers it?* RESOLVED — transient failures release the claim, deterministic ones stay terminal. |
| M42 | The first fix released the claim on the THROW paths and missed that `runAgentTurn` has three refusal paths that **return normally**: the `sessions_frozen` kill switch, the turn-level rate limit, and the kill-phrase halt. They never reach the `catch`, so the claim was never released — a maintenance freeze silently ate the dispatch, and the board was told *"Please try again shortly"* when nothing ever would. **538 green tests said nothing**, because every test drove `Promise.reject` and none resolved a refusal-shaped result. | Found only because the verifier was told to prove it by EXECUTION. When classifying failures, enumerate what a function RETURNS as well as what it THROWS — and check whether your tests only ever exercise one of the two. RESOLVED by a typed `refusal` marker on `AgentTurnResponse`; the heuristic alternative (zero-cost/zero-token/empty-modelId) was deliberately rejected as fragile. |
| M43 | **A fix of mine was worse than the bug it closed.** Gating the kill phrase on `origin === 'human_chat'` correctly closed a low-severity Paperclip hole — and silently disabled the emergency stop for a human typing that phrase into an active **War Room** on Telegram and the dashboard, because that path diverts through `orchestrateWarroomTurn` with no origin. | This is **M33** in a new place: both directions have to be safe. Weigh what a fix BREAKS against what it closes; a silent loss of an emergency stop during an incident beats a hole that needs a high-entropy secret. Also note the trap in the obvious repair: the check does NOT go at the orchestrator, whose `userText` is a multi-speaker transcript — an agent's words would halt the fleet and a stale line would re-halt every round. It belongs at the entry points, on the human's raw message. RESOLVED via a shared check in `src/lib/warroom/kill-phrase.ts` (A3-1: the surface-agnostic layer, not duplicated into two adapters). |
| A45 | **11 production call sites reach `runAgentTurn`.** Every human-typed path halts on the kill phrase; five machine callers correctly do not. Two in-between states that nobody had enumerated also halt correctly: a stale `activeWarroomId` pointing at an ENDED room, and an active room plus an attachment (the divert is gated on `!attachment`) — both fall through to the ordinary chat call site. Slack has no War Room divert. | Verified by execution, not by reading. Re-verify this enumeration whenever a new divert, queue or orchestrator is added between an adapter and the turn loop; that is exactly the shape that was missed twice. |
| A46 | **Dispatch rollback is a BOARD-UI operation, not a scripted one.** There is no agent-UPDATE call anywhere in this repo — `bootstrap-core.ts` has `listAgents` and `createAgent` and nothing else — and none of the 21 probes exercises one, so the method and path that would rewrite an existing `adapter_config` are established by nothing green. | The acceptance item ("rollback is blanking that URL — a data edit, no deploy") still holds, but the edit is made in the Paperclip board by hand. Marked UNVERIFIED rather than guessed from the plan document, which A1-16 forbids and which is already wrong about this route's auth. |
| P29 | **Prove it by execution, not by reading.** Three consecutive verification rounds on Phase 6 each found a real defect with a throwaway probe, after a reading-based review had passed the same code. One of those verifiers caught its OWN false positive — a malformed mock threw before the code under test, so the right thing happened for the wrong reason — and re-ran. | Make "write a throwaway probe, then delete it and confirm `git status` is clean" an explicit instruction for any verifier of a failure-classification path. Reading finds the throws; only execution finds the returns. |
| P30 | **Follow-up owed, not done:** `src/lib/scheduler/queue-drain.ts:126` has the identical loss-channel shape and is PRE-EXISTING and outside Phase 6 — a scheduled task firing during a maintenance freeze is permanently consumed, because the refusal returns normally and the SQS message is then deleted. | Now trivially fixable using the `refusal` marker Phase 6 added to `AgentTurnResponse`. Recorded here rather than fixed so it is not lost; `src/agent/canary.ts:75` scoring a freeze as a canary failure is a cosmetic sibling. |
| M44 | **Six phases were validated with the feature flag OFF.** The whole integration is gated behind `CCE_PAPERCLIP_ENABLED`, so every "full validation, clean" exercised the LEGACY path. Phase 7's critic proved it: with the flag armed, `mission-tools.authz.test.ts` went 5/5 → 3/5, and CI runs flag-off so it would have stayed green forever while the new code's behaviour was asserted nowhere. | Bounded by luck, not diligence — a flag-on sweep found exactly the one file the critic named and nothing from Phases 2-6. **Validate a flag-gated feature in BOTH configurations, every time.** `npm test` AND `CCE_PAPERCLIP_ENABLED=1 npm test` are now both part of the pre-push list for this feature. RESOLVED — both now report 213 files passing with the identical 5-file environmental baseline. |
| A47 | `resolveOwned` swept the whole owner board TWICE per mutation via `paginateAll` (up to 100 pages) where legacy did one bounded `Limit=100`. This is not merely slow: **A1-10's refusal counts DISTINCT list reads in flight per actor**, so a mutation-heavy dashboard fan-out is exactly the shape that trips it. | Bounded in the same change. When porting a bounded query onto a paginating client, the bound is part of the contract, not an implementation detail. |
| A48 | **C-16's 8-char-prefix ambiguity was real, not theoretical.** `startsWith` silently picked the first match, so two missions sharing a prefix meant a mutation hit the WRONG mission. | Closed with a deterministic ambiguity error. That is a fix rather than a contract break: the ambiguous case could not previously succeed correctly, and the unambiguous cases stay byte-identical. |
| A49 | `infra/lib/compute-stack.ts` had to plumb `CCE_PAPERCLIP_ENABLED` into the Fargate task environment. Without it the flag is synth-time only and the ACL never arms in a deployed task. | The fifth home of the flag (**M22**). It defaults to unset, so the legacy stack serves — the safe direction. |
| P27 | A builder/critic loop must be capped, and the cap must be **reported as a cap**. Phase 2's first workflow exited `passed: false` at `rounds < 3` — not because it converged, but because it ran out of rounds with two criteria still failing. | Read the exit condition before concluding a phase failed on quality. A capped loop that is *close* deserves a focused follow-up round on the named failures, not a rebuild — the follow-up cleared both in two rounds while touching nothing that already passed. |
| M15 | A decision was put to the repository owner on a premise taken from **comments in the shipping code** rather than from the code's behaviour. Six comments — `infra/lib/iam-stack.ts:760, :838, :996` and `.github/workflows/deploy.yml:249, :354, :477` — all still assert that arming Paperclip in staging "depends on a production IAM deploy having run first". That was true before **M34** and has not been true since: `CCE-STAGING-Iam` exists, and already attaches all five `PaperclipCloudBuild*Staging` statements plus `PaperclipSecretPopulateStaging`, `EcrPushPaperclipStaging`, `EcrCreatePaperclipRepoStaging` and both migration grants to the shared `ClaudeClawGitHubDeploy` role via `Role.fromRoleName(...).addToPrincipalPolicy(...)`. | **P5 says the code wins when a document disagrees — a comment is a document.** The rule was applied to every external doc this session and not to the comments sitting beside the code being read. Verify a comment by synthesizing the stack and enumerating what it actually produces, exactly as an OpenAPI claim is verified by a probe. The six comments are corrected in this change. |
| P33 | The genuine defect the stale comments were hiding is **step ordering, not environment scoping**: an existing CI-enabled installation upgrading to this version runs the ECR, CodeBuild, secret-populate and migrate steps **before** the `CDK deploy` that creates their grants, so at the default tier (`clampTier('')` → Tier 1, which provisions Paperclip) all four fail `AccessDenied`. `deploy.yml:353` acknowledges it and offers a manual workaround. | Resolved by deploying `${CDK_STACK_NAME}-Iam --exclusively` early in the job so an upgrading installation grants itself what it needs in one unattended run. A **first** install is unaffected: `CCE_CICD_ENABLED` defaults empty so the role is never created, and opting into CI does one local deploy that lands the role and all fifteen statements at once. |
| P32 | `node scripts/ci/diagrams-drift.mjs` is **inert locally**. Without `GITHUB_BASE_REF` it prints "not a PR context, path validation only" and exits 0 — it validates that the mapped paths exist, and checks no drift at all. | A local green from this gate is not evidence a diagram is in step with the code it maps. `infra/bin/app.ts` is mapped (`docs/diagrams.map:4`), so any Phase 9 edit to it must update `docs/diagrams/architecture-compute.md` or carry a `drift-gate:` note — and only CI will actually enforce that. Verify the diagram by reading it, never by running the gate locally. |

### 5.15 Appended this session (2026-08-21, Phase 4 rework round 2)

| # | Entry | Detail |
|---|---|---|
| M38 | **M27 for the fourth time, and the most expensive shape of it yet.** Phase b.5 — compose `DATABASE_URL`, run the one-shot migration, abort on a non-zero exit — existed only in `scripts/deploy.ts`. CI does **not** run that script; it hand-mirrors each phase and then runs `npx cdk deploy --all`. `grep -n "migrat\|run-task" .github/workflows/deploy.yml` returned exactly one hit and it was a comment. So on the only driver that reaches staging and production, the schema was never migrated by anything: the service deliberately carries no `PAPERCLIP_MIGRATION_AUTO_APPLY`, so deploy 2 would have started an essential container against an empty schema, failed the rollout, and left `CCE-Paperclip` in `UPDATE_ROLLBACK` beside RETAIN + `deletionProtection` substrate (**P21**). | It failed *safely* — nothing would have been deleted — which is exactly why it survived a full review round: an M33-clean design can still be an unreachable one. **When a phase adds a step to `scripts/deploy.ts`, open `.github/workflows/deploy.yml` in the same edit and either mirror it or write down why it does not need mirroring.** RESOLVED this session — a `Migrate Paperclip database` step now sits between `Populate Paperclip secret` and `CDK deploy`, running `aws ecs run-task` + `ecs wait tasks-stopped` + an exit-code check, and hard-failing before the deploy rather than after it. |
| M39 | The round-1 workflow wrote the Paperclip secret and nothing granted it. `grep secretsmanager infra/lib/iam-stack.ts` returned only power-switch and public-tunnel statements — **zero** Paperclip statements in either branch — so the step would have died `AccessDenied` on its first armed run. | A capability added to a workflow is not added until the role can do it, and the role has two homes (**M34**). RESOLVED this session — three statements in the `!isStagingDeploy` branch and three mirrored `*Staging` ones, asserted by name in `paperclip-stack.test.ts`. **Still a prerequisite, not a fix:** the grants are created by the CDK deploy later in the same job, so they must land in a prior UNARMED deploy, and the live `ClaudeClawGitHubDeploy` role is the fact worth reading before arming. |
| M40 | `SYNTH_INPUT_ALLOWLIST` still carried `CCE_PAPERCLIP_SERVICE_READY` — a variable from the **rejected** design, referenced nowhere else in the tree — under a comment claiming synth "creates the FargateService only when the readiness gate is '1'", which is precisely the behaviour **M33** forbade and the code no longer has. Meanwhile the flag that *does* change synth output, `CCE_PAPERCLIP_BOOTSTRAP`, was missing from the list. | A replay list is executable documentation: a stale name there is a promise that a rollback will re-apply a gate that no longer exists. Worse, that particular name could only ever *remove* a resource. RESOLVED this session — removed, `CCE_PAPERCLIP_BOOTSTRAP` added, the comment rewritten to say why the old name must never come back, and a colocated test asserts both directions. Two diagram files carried the same stale claim and were corrected. |
| A42 | A comment can be *right about the decision and wrong about the evidence*. `paperclip-stack.ts` justified using `curl` in the health check by asserting the orchestrator's `wget` "is not" in the image. `curl` is genuinely there and `wget` is genuinely there too, at `/usr/bin/wget`. | The choice was fine; the reason given was false, and a false reason is what the next reader deletes the choice on. **A1-16 in miniature: state what the probe proved, not what it implied.** The comment now says `curl` was probed present and names the cost of naming a binary the image lacks (UNHEALTHY forever, which at `minHealthyPercent: 0` is an outage). |
| A43 | `resolvePaperclipMigrationTargets()` read the **gitignored** `cdk-outputs.json`. That was already M33-safe (its only consumer aborts, it removes nothing), but `null` still meant "a fresh clone" far more often than "not deployed" — and an operator on a fresh clone of a *working* environment would have been told to set `CCE_PAPERCLIP_BOOTSTRAP=1`, which scales the running service to zero. | Live CloudFormation answers the same question identically from anywhere, and `cloudformation:DescribeStacks` was already granted. Re-sourced this session; a non-`ValidationError` failure now aborts instead of masquerading as "not deployed". It is also what let the CI step reuse the same four outputs instead of inventing a second protocol. |
| A44 | **The image bump is the same two-deploy protocol as the first arm, and that is stated rather than hidden.** Both drivers run the migration task definition the *previous* deploy created, so an image that introduces a migration must ship with `CCE_PAPERCLIP_BOOTSTRAP=1` and then be cleared. | `vendor/paperclip` is content-tagged and changes only when its Dockerfile or patch changes, so this is rare. Named in `.github/workflows/deploy.yml` at the migration step, because an unnamed constraint is one somebody hits at 3am. |
| P28 | Both critics that mattered here disagreed about *what kind* of defect blocks a phase: the bar critic rejected on a reachability gap (the migration never running on CI), the blind judges passed the same file three times. | Blind head-to-heads test whether the artifact reads well; they do not test whether it *works on the path that reaches a customer*. Run both, and let the bar critic's verdict govern (**A39** already says winning blind is necessary, not sufficient — this is the second instance). |

### 5.6 Appended 2026-08-22 (phase 8 verification and phase 9)

| # | Entry | Detail |
|---|---|---|
| M14 | A red test was carried across a session boundary as evidence of a product defect. It was a defect in the **probe**: `PROBE 7` invoked `schedule_task` with `prompt` where the tool's parameter is `prompt_text`, so the tool refused the call, `createScheduledTask` was never reached, and the assertion read `undefined` — indistinguishable from an unimplemented feature. | Instrument a failing probe before believing it. One line printing the tool's own return value (`{"text":"prompt_text is required","isError":true}`) and the spy's call count (`0`) settled in one run what the handoff had carried forward as an open defect. **A red test that means the opposite of what it says is worse than no test.** |
| P31 | A verifier's throwaway probe must assert that the call it is probing actually **happened**, not only that the result looks right. `expect(created[0]?.deliveryTarget)` reads `undefined` both when the field is missing and when nothing was ever created. | Assert the arrange step (`expect(spy).toHaveBeenCalledTimes(1)`) before asserting the outcome, so a refused call fails loudly as a refused call. |
| A47 | Phase 8's identity scheme is verified on the wire, not inferred: the Telegram push from the research bot's conversation leaves over `botTOKEN-RESEARCH`; the per-agent Slack push carries that app's own bearer token; `schedule_task` stamps `42:bot-research` and the reply fires over the research token when the task runs. | Established by 12 probe cases driving the real routers with only `fetch` and the DDB-backed lookups stubbed. This supersedes the previous handoff's "Phase 8 was closing the wrong Telegram bot token" as an **open** item — it is closed. |

### 5.16 Appended 2026-08-24 (completion audit reconstruction)

- **RESOLVED (`7220d3e`)**: the assignment push uses the conversation's bot/app
  identity and propagates the real send result. The real-router probe observed
  the research Telegram token, correct Slack main/per-agent/thread identities,
  and honest 403/`not_in_channel` failure text.
- **RESOLVED (`7220d3e`)**: dispatch's genuine Paperclip run id now reaches
  `ToolContext`; ordinary chat omits it. Successful comment and subtask writes
  each produce exactly one audit event with actor, surface, chat, issue/parent,
  action, tool, and run when present.
- **A48 supersedes A36's request-shape claim**: the 2026-08-24 pinned live probe
  proves `POST /api/issues/{id}/children` rejects an array and accepts one
  object. Title-only defaults to backlog/medium/unassigned with
  `requestDepth: 1`; explicit parent and assignee persist. The company issue-
  create route with `parentId` remains the safer tool implementation because its
  deterministic idempotency behavior is already proven.
- The live characterization also proved that run-less work-product creation
  records no actor/run attribution and that complete/release after the fixture
  adapter fails both return `409 Issue run ownership conflict`. Do not add those
  verbs until a genuine-run lifecycle is proven.
- **M45 — corrected before implementation spread:** the critic shorthand
  "priority numeric remains, `dueAt` remains" was initially misread as a request
  to preserve both. The Phase 9 authority at `bar-and-phases.md:472-476` says the
  opposite: switch to Paperclip's four priority bands and remove public
  `dueAt`. The builder was corrected before applying domain edits. Read the
  phase authority, not a compressed verdict, whenever wording is directional.
- **P32 — interruption boundary:** both builders were stopped mid-phase. A
  read-only inspection found the intended workflow occurrence cleanup and the
  `paperclip-tools.ts` priority patch present, but no command has verified that
  state. Inspect current diffs before applying anything; never replay a patch
  from this prose blindly.
### 5.17 Appended 2026-09-01 (staging readiness and per-install auth model)

| ID | Type | New finding | Required correction or precaution |
|---|---|---|---|
| M46 | Mistake | Healthy staging endpoints masked broken sign-in because a placeholder Better Auth secret was nonfatal. | Keep deployment fail closed for missing, placeholder, or short secrets and rerun staging before declaring sign-in ready. |
| M47 | Mistake | The initial probe reused the orchestrator task without deployment permissions to run it and inspect its logs. | Add least-privilege ECS, Compute-role PassRole, and orchestrator log-read grants. |
| P34 | Precaution | CloudWatch ingestion is asynchronous; an empty first read is not a passing probe. | Retry for a bounded interval and require every expected redacted marker. |
| A50 | Assumption clarified | One customer installation owns one Paperclip instance/company; `BETTER_AUTH_SECRET` is an internal per-install secret. | Promote the decision to README/ADR; keep generation and storage in per-install setup and AWS Secrets Manager. |
| P35 | Precaution | A repository-wide secret would incorrectly centralize customer authentication material. | Use GitHub environment secrets only for Netzer-operated environments; never use one fleet-wide customer secret. |

### 5.18 Appended 2026-09-02 (staging probe cut and deploy)

> Sections 5 through 5.17 above are the 2026-09-01 file's section 5 copied
> verbatim, including its own pointer to the 2026-08-24 file. Numbering
> continues from the highest IDs used there: M47, P35, A50.

| ID | Type | New finding | Required correction or precaution |
|---|---|---|---|
| A51 | Assumption re-verified | M6 (Vitest fails in a Windows linked worktree) does **not** reproduce in `C:\dev\Netzer-Labs\.worktrees\paperclip-promote` on 2026-09-02: focused runs of 148 tests in 4 files, then 76 and 37, all passed, and the full `npm test` collected 240 files and ran 3010 tests here. | Keep M6; it is machine- or checkout-specific, not universal. Try the worktree first; fall back to a normal clone only if the `Cannot read directory` startup error appears. |
| M48 | Mistake | `HANDOFF.md` (2026-09-01) said the work was committed through `9b5edad` and PR #133 was green while six files — `infra/lib/iam-stack.ts`, `infra/lib/paperclip-stack.test.ts`, `scripts/lib/paperclip/bootstrap-core.test.ts`, `scripts/paperclip-bootstrap.ts`, `src/ops/paperclip-phase-probe.ts`, `src/ops/paperclip-phase-probe.test.ts` (189 insertions) — were uncommitted in the worktree, and the session file called itself a "handoff-only closeout". | Run `git status --short` and `git diff HEAD --stat` before writing source state, and paste the file list. "Committed" means the working tree is clean for every file you name. |
| M49 | Mistake | `HANDOFF.md` recorded "all eight checks PASS" for PR #133; GitHub reports nine (five CI jobs, four Docs CI jobs). | Count from the checks list and name the jobs. |
| M50 | Mistake | Three test counts in the 2026-09-01 file's section 7 were wrong: "2 files, 73 tests" was 87 (73 is `paperclip-image-pipeline.test.ts` alone); "49 tests" in `infra/lib/paperclip-stack.test.ts` was 52; "189 tests in 5 files" measured 190. That file is history and is left unedited. | Record test **file names** with cause; if you record a count, copy it from the runner's own summary line, never from memory. |
| M51 | Mistake | An uncommitted probe change renamed every object key to `<field-N>`, so the redacted shape no longer said which fields exist — the one thing Phase 8.5 needs from the probe. | Reverted to `safeShapeKey`: real field names stay, UUID-shaped keys become `<uuid-key>`, values are always typed placeholders. Redaction must remove values and identifiers, not schema. |
| M52 | Mistake | `scripts/paperclip-bootstrap.ts` carried dry-run branches after an unconditional `return`; `reconcileKey` had a `dryRun` parameter that all 10 call sites passed as `false`; `bootstrap-secret.ts` exported `dryRun`/`warn`/`errorName`/`writeBootstrapSecretFields` that no live caller used. | Dead-by-construction code deleted (`bootstrap-secret.ts` 130 → 96 lines). A parameter with one constant value is not a feature; it is a lie the tests then keep alive. |
| M53 | Mistake | `PAPERCLIP_DISPATCH_URL` / `CCE_PAPERCLIP_ADMIN_EMAIL` were threaded into the orchestrator task definition (`compute-stack.ts`, `scripts/deploy.ts`, `manifest.ts`, `env.ts`, `deprecations.json`, two `deploy.yml` synth steps, a diagram drift note, a vars-presence test) although no runtime code read them; only the local bootstrap script does. | Cut with every ripple; `git diff origin/development` is empty for `manifest.ts`, `deploy.ts`, `env.ts`, `deprecations.json`, `rollback-classes.md`. Before injecting an env var, name its reader. |
| M54 | Mistake | Source-text assertions (`readFileSync` + `toContain`/`indexOf` on a sibling `.ts` file) in `paperclip-stack.test.ts` and `bootstrap-core.test.ts` were counted as proof of behaviour. | Deleted; replaced by seven behavioural `bootstrap-secret` tests (fail-closed ×3, `REPLACE_ME`/empty, corrupt `agent_keys`, valid map unchanged, merge preserves prior fields). A test that reads source text proves the text exists, nothing more. |
| M55 | Mistake | The bootstrap wrote a `dispatch_secret` checkpoint with a second `PutSecretValue`, producing two Secrets Manager versions per run and breaking the "one bootstrap, one version" contract the no-op re-run check depends on. | Removed; exactly one `PutSecretValueCommand` call site remains (`scripts/paperclip-bootstrap.ts:382`). Verify with the version count before and after a run (2 → 3, then 3 → 3 on the no-op). |
| A52 | Assumption | On this Windows checkout (`core.autocrlf=true`) `npm test` exits 1 on exactly five files this branch does not touch: `scripts/ci/docs-links.test.ts`, `scripts/ci/feature-knowledge.test.ts`, `scripts/ci/runnable-blocks.test.ts`, `scripts/release/sync-deprecations.test.ts` (each `SyntaxError: Invalid or unexpected token` at collect; the `.mjs` each imports is `i/lf w/crlf` including its `#!/usr/bin/env node` line and runs directly with exit 0) and `scripts/lib/lifecycle/rollback-classes.test.ts > deploys the archived assembly with --app and diffs first` (`/tmp/fake/cdk.out` vs `\tmp\fake\cdk.out`). CI's Linux `Typecheck + Unit Tests` job passed at `291a457` (run 33639063032). | Treat these five, by name, as the Windows baseline. Any other failing file is a regression. |
| P36 | Precaution | Record failing test **file names** with cause; never counts alone. | Counts change with every cut and were wrong three times in one session file (M50). |
| P37 | Precaution | In Git Bash, prefix `aws` calls that take a leading-slash argument (`--secret-id /claudeclaw-staging/paperclip`, log-group names) with `MSYS_NO_PATHCONV=1`. | MSYS rewrites the argument into a Windows path and the call fails validation. |
| P38 | Precaution | Diff secrets by field name and set/`REPLACE_ME` state only; the dry-run prints names, the deploy step prints "value not shown". | No handoff, log, PR or chat ever carries a value. |
| P39 | Precaution | The probe cannot be pre-flighted against the running orchestrator: task definition `:13` predates `dist/ops`. Its first live run is inside the staging deploy run, after the tenant bootstrap. | Do not open the `qa` → `staging` PR until the bootstrap's no-op re-run has been proven; the probe fails correctly on `REPLACE_ME` fields. |
| M56 | Mistake (found by the probe) | Paperclip's `privateHostnameGuard` (authenticated/private mode, pinned `v2026.722.0`) answers 403 to every request — `/api/health` included — whose Host is neither loopback nor in `PAPERCLIP_ALLOWED_HOSTNAMES`. The stack never set that variable and `config.json` holds `server.allowedHostnames: []`, while the orchestrator dials the Cloud Map name `paperclip.claudeclaw-staging.internal`. The probe's first live run (staging Deploy run 33733071639 attempt 4, task `e071943c4f2c45b2be381ddd3073c0b7`) was refused on its first `GET`; every earlier check had gone through the SSM tunnel, whose Host is `127.0.0.1`. | Set `PAPERCLIP_ALLOWED_HOSTNAMES` on the Paperclip task definition to the bare Cloud Map hostname (upstream `server/src/config.ts`: comma list, lowercased, replaces the file list; the guard compares `URL.hostname`). Pinned by a literal test. When a private service is reached through a tunnel, force the real Host header at least once. |
| P40 | Precaution | The guard reads `x-forwarded-host` before `Host`, so a forged forwarded header (`127.0.0.1:3100`) bypasses it — observed 200 over the tunnel. | Never use it as a workaround; it disables the control silently. |
| M57 | Mistake | `stop_forward` in the operator helper used `pkill`, which this Git Bash does not have, so the first dry port-forward check leaked a `session-manager-plugin.exe` (PID 106732) for six hours; the piece-5 critic found it. | Kill the plugin by image name with `taskkill //PID … //F` (`tasklist //FI "IMAGENAME eq session-manager-plugin.exe"`); verify with `netstat -ano \| findstr :3100`. |
| A53 | Assumption | The orchestrator image's `[build]` stage (`npm install` with devDependencies, `aws-cdk-lib` included, under QEMU arm64) sits on npm's socket-inactivity timeout: 259 s in the bar run, `read ETIMEDOUT` at ~266-274 s in two consecutive attempts, one 83-minute stall before that; `deps` and `web` stage timings matched the bar to the second; lockfiles and Dockerfile unchanged since `ac70509`. | Re-running is the current remedy (attempt 4 built in 9 m 19 s). The durable fix is one `ENV npm_config_fetch_timeout=…` line in the `[build]` stage, or not installing `aws-cdk-lib` in the image build at all; it belongs to its own PR. |
| P41 | Precaution | ECS forgets stopped tasks after about an hour, so the probe task cannot be found by `list-tasks --desired-status STOPPED` later. | Find it in CloudWatch: `describe-log-streams --order-by LastEventTime --descending` (no prefix — the API refuses prefix + LastEventTime), then `filter-log-events` for `PAPERCLIP_PHASE_PROBE` on each candidate stream. |
| M58 | Mistake (found by the probe) | With the hostname allowed (run 33773788920), the probe's fetch never got a response, in two attempts, the second with no Paperclip change. Upstream `server/src/config.ts` resolves the bind mode as `PAPERCLIP_BIND` ?? `config.json` `server.bind` ?? inferred from `HOST`, and `resolveRuntimeBind` maps `loopback` to `127.0.0.1` whatever `HOST` says. The EFS `config.json` holds `server.bind: loopback` (writer not identified: `auth bootstrap-ceo` only reads; quickstart onboarding would have written `lan` from `HOST=0.0.0.0`), so the task booted after the hostname fix listened on loopback only while its localhost health check kept passing. The task it replaced had booted before the file said that, which is why it could answer the 403. | Set `PAPERCLIP_BIND=lan` explicitly on the task definition beside `HOST`; pinned by a literal test. Every knob the file can override must be set by the task definition, or a re-boot silently inherits whatever the file accumulated. |
| P42 | Precaution | A container health check on `localhost` cannot see a listener that shrank to loopback; ECS, CloudFormation and the deploy all report green while nothing in the VPC can connect. | The probe is the only check on that path; read its failure code literally — `request-failed-before-response` means no TCP/HTTP answer at all, not a refusal. |
| A54 | Assumption (now evidence) | Run 33783021194 recorded the live shapes: `/api/companies/{cid}/org` is an array of agents with nested `reports`; `/api/agents/me` is a wide object (`access`, `chainOfCommand`, `orgChainHealth`, `reportsTo`, `permissions` among its keys); goals are `{companyId, createdAt, description, id, level, ownerAgentId, parentId, status, title, updatedAt}`; `goals-list` is an empty array on a fresh company; `org.svg` is served as `image/svg+xml`. Values were never logged, only types. | Phase 8.5 types `org.ts` and `goals.ts` against these shapes (promoted to README section 6), not against the OpenAPI's `additionalProperties: {}`. |
| P43 | Precaution | Seven deploy attempts were needed for three green-capable runs: two npm timeouts and one stall in the emulated image build (A53), then two probe findings. Each attempt costs ~30 minutes. | Budget an hour per staging round trip and keep the AWS session alive across it (`aws login` lasts less than the ladder did). |
| M56 | Mistake | This file's first draft copied the comment at `infra/lib/compute-stack.ts:236-244` ("secrets-stack.ts creates all four … `company_id` … with the secret itself") into section 3.3 as a convention. The code disagrees: `infra/lib/secrets-stack.ts:113-118` creates `better_auth_secret`, `reconciler_key`, `agent_keys`, `dispatch_secret` only, and `company_id` is merge-added as `REPLACE_ME` by deploy phase b (`scripts/lib/lifecycle/deploy-phases.ts:300-302`). Caught by the piece-4 critic. | M15 again: a comment is a document, and P5 applies to it. Before writing "X creates Y", open the constructor or the plan that creates Y, not the comment beside its consumer. The comment itself stays wrong in source until the deferred fix in section 6.4 lands. |

### 5.19 Appended 2026-09-03 (staging probe green and two findings)

| ID | Kind | What happened | What to do about it |
|---|---|---|---|
| M59 | Mistake | The closing docs critic found a stale sentence (README section 2: the probe completion "remains local and has not yet produced deployment evidence") that a literal grep sweep for "not yet deployed" had missed. | Sweep for meaning, not strings: read sections 2 and 3 of the README together whenever section 3 changes; the critic's job includes semantic staleness. |
| A55 | Assumption (now evidence) | A full staging round trip on this pipeline costs about an hour and the ladder about 15 minutes; `aws login` expires in roughly two hours. Three of seven deploy attempts this session died in the emulated image build before any code ran. | Renew the AWS session at the start of each round trip; budget an hour per attempt; ship the `npm_config_fetch_timeout` fix (A53) before the next long campaign. |
| P44 | Precaution | The previous Claude Code process died on a memory-starved machine (309 MB free of 16 GB) while several vitest and synth processes from concurrent critics were running; every external command then hung. | Do not run two critics that both synthesize or run vitest at the same time on this machine; check free memory when commands start timing out; the harness may then report completed agents as lost after a restart even though their verdicts were received. |
| P45 | Precaution | The harness reported the three critics of this session as "did not complete" after a process restart; all three verdicts had in fact been received and acted on before the restart. | Trust the journal and the recorded verdicts, not the restart notification. |


### 5.20 Appended 2026-09-05 (goal-first missions engine)

| ID | Type | New finding | Required correction or precaution |
|---|---|---|---|
| A56 | Assumption (one green run) | Staging run 33989570600's build stage took 251.6 s vs 230.9 s in the bar, both under the old 300 s default fetch timeout. | Run 33989570600 did not exercise the new timeout, so the causal claim for A53 stays open. |
| P46 | Precaution | A process restart orphaned a Monitor, a background watch and the running P0-3 workflow; the builder result was already in the journal and only the critic needed to be re-run by resuming the workflow. | Read the journal before rebuilding anything a restart appears to have lost. |
| M60 | Mistake | `create_mission` stamped the SESSION scope `ctx.agentId` as creator while `list_missions`/`update_mission` judged the BOARD scope `ctx.boardAgentId ?? ctx.agentId`, so under Telegram's sticky default the agent that opened a mission could not transition it. Corrected by `boardSelf`. | Provenance and authorization must use one identity; a test must exercise the surface where the two scopes differ. |
| P47 | Precaution | graft indexes the main checkout, not a branch with uncommitted edits. | On such a branch, use grep/sed in the worktree for changed files instead of graft. |
| M61 | Mistake | Focused critic sets passed while the full suite failed on two adapter parity tests whose partial vi.mock omitted the new exports; P4 caught it. | A critic for a src/lib change runs the full suite; partial module mocks spread importOriginal. |
| A57 | Assumption (now evidence) | Another session promoted unrelated work (#151-#155) through the ladder while this session was blocked; staging run 34004002068 armed Paperclip before the Phase 0 branch deployed. | Check `git log origin/development` and `gh run list --branch staging` at every resume; a variable set for the next deploy is consumed by whichever deploy comes next. |

### 5.21 Appended 2026-09-06 (P0-2 dispatch-push fix)

| ID | Type | New finding | Required correction or precaution |
|---|---|---|---|
| M62 | Mistake | The ADR 0010 :316-321 push payload was a source reading, marked UNVERIFIED; measured 2026-09-06 as `{netzarAgentId, agentId, runId, context{issueId, ...}}`: the dispatch parser wanted a top-level `issueId` and 400'd every push; no agent turn was ever driven by Paperclip in staging until the fix landed. | A shape marked UNVERIFIED that gates a whole path must be probed before the flag flips, not left unverified until an incident. |
| M63 | Mistake | The bootstrap armed only `dispatchSlugs=['main']` and never patched a reused agent, so Research had no `url` and Paperclip escalated its issues to Main. | Idempotent create is not reconcile; a bootstrap re-run must repair drift on existing agents, not skip them. |
| A58 | Assumption (now evidence) | Paperclip 2026.722.0 does not dedupe wakeups by `idempotencyKey` -- the field is only stored, never looked up. | Netzar's own `(runId, issueId)` claim in `paperclip-dispatch.ts` is the only de-dupe guard; do not rely on upstream idempotency. |
| A59 | Assumption (now evidence) | The same legacy DynamoDB mission-tasks table also stores provenance sidecar rows (`{PK,SK,missionId,createdByAgent,createdByChat,assignmentReason}`) written by the Paperclip branch. | Its raw item COUNT is not the legacy mission count; filter by row shape before citing a count. |
| A60 | Assumption (now evidence) | `status:"blocked"` is not dependency state on this artifact -- Paperclip rewrites status to `blocked` after an `adapter_failed` run, independent of the blocking graph. | Read `blockerAttention` (list) or `blockedBy` (detail) for dependency state, never `status`. |
| P48 | Precaution | A characterization issue assigned to an agent whose adapter is broken (no `url`) gets reassigned by Paperclip's escalation path within about a second. | Assign characterization issues only to an agent whose adapter is known-working, or the probe measures the escalation path instead of the intended one. |
| P49 | Precaution | `tool_invoke` audit rows are written only by tools that call `writeAudit` (`paperclip_add_comment`, `paperclip_create_subtask`); `mission-tools.ts` has none. | Expect audit coverage per-tool, not per-surface; a missing `tool_invoke` row for a mission mutation is a known gap (P49), not evidence of a broken guarantee. |

### 5.22 Appended 2026-09-06 (P0/P1 state and 8.5 bridge)

| ID | Kind | What happened | What to do |
|---|---|---|---|
| M64 | Mistake | P0-0's fetch-timeout knob shipped on a source reading; the next failure (run 34045747255 attempt 1, 268.6 s) proved it irrelevant: the kernel socket timeout fires first and npm already retries it. | Fix the cause (do not download the 117 MB dev tree under QEMU), not the timer. |
| M65 | Mistake | Ledger A53 attributed two 2026-09-03 deaths to run 33773788920; the API shows both its attempts passed Build + Push. | Cite run ids and attempts from `gh api .../runs/<id>/attempts/<n>/jobs`, never from memory. |
| A61 | Assumption now evidence | Paperclip's http adapter treats the POST response as the run result: a run is `succeeded` in under a second; recovery re-dispatches under new run ids; the agent's own status PATCH is refused while a run holds the issue. | Characterize the disposition protocol from the image before touching the worker (next action 3). |
| A62 | Assumption now evidence | A foreign board's rows are projected without the provenance join, so `createdByAgent` reads `paperclip` there. | P0-3b. |
| P50 | Precaution | Agents that must read credentials into the shell trip the safety classifier when the brief says so in credential words; phrase such briefs as the repository's documented runbook. | Two agents were blocked before their first command this session. |
| P51 | Precaution | Resume paths under a worktree-keyed session directory are refused by the Workflow tool; relaunch inline. | Cost two turns this session. |

### 5.23 Appended 2026-09-07 (P1 hierarchy closeout)

| ID | Kind | New finding | Required correction or precaution |
|---|---|---|---|
| M66 | Mistake | `npm run deploy:cloud` is hardcoded to PRODUCTION's CodeBuild project (`claudeclaw-orchestrator-deploy`, us-east-1) with no `--env`, no confirmation and no source-branch guard, yet `CLAUDE.md` recommends it for "normal feature work"; `npm run deploy` likewise defaults to `--env=prod`. | The only safe staging deploy is merging the `qa`→`staging` promotion PR; never run either `deploy` command against a feature branch. |
| M67 | Mistake/Assumption | A feature can be "critic-passed piece by piece" and still never have been run through the full suite or pushed — `ci.yml` triggers only on `development`/`qa`/`staging`/`production`, so a `feat/*` branch is invisible to CI for its entire life. | Piecewise critic passes are necessary, not sufficient; schedule a full-suite, both-flag-states close-out pass before calling a feature done, exactly as this session did for Phase 1. |
| A63 | Assumption (now evidence) | The CI test job never sets `CCE_PAPERCLIP_ENABLED`: `ci.yml` does not mention it at all, so the flag-ON suite M44 made mandatory exists ONLY as a local, manually-run gate. (`deploy.yml:943` and `:1053` DO set it, but those populate the deployed task environment, not the suite that gates a PR.) | Nothing in CI will ever catch a flag-ON regression; a flag-on pass recorded in a session handoff is the only evidence that configuration was ever exercised, and it must be re-run by hand every session that touches Paperclip-gated code. |
| P52 | Precaution | A usage-limit kill can leave a workflow journal with ZERO result lines while a dead builder subagent has already written real files into the worktree. | `git status` the tree before relaunching a killed workflow, or the already-finished work is silently discarded and rebuilt from scratch. |
| P53 | Precaution | Graft indexes the MAIN checkout only (whatever branch is checked out at the repo root), not a worktree — sharper than P47's "not a branch with uncommitted edits": even fully committed work on a worktree's own branch is invisible to it. | Use graft for pre-existing, branch-independent structure; read the worktree's own file directly for any claim specific to that branch. |


| M66 | Evidence | A text assertion over a build file proved nothing: nine `readFileSync` + `String.includes` tests were green against a build stage that could not build at all. | Where the artifact can be produced, produce it and assert INSIDE it. `orchestrator-dockerfile.build.integration.test.ts` is the pattern. |
| M67 | Evidence | `--omit=dev` silently suppresses a package named explicitly on the npm command line when that name already carries a dev edge in the lockfile. The install exits 0 reporting `up to date`. | Never assume an explicit spec beats a filter flag. Isolate the install instead, and assert the result, not the command. |
| M68 | Evidence | `npx` resolves a missing binary by FETCHING one: with no local compiler it installed the unrelated registry package `tsc@2.0.4`. | A build stage must never use `npx`. Invoke the package's own bin through `node`. |
| M69 | Assumption now evidence | A1-15 applied to A61: the live service has NO route that reports a run's outcome (`disposition`, `complete`, `completion`, `succeed`, `result` all match nothing). `watchdog-decisions` is a watchdog control. | The issue-level claim carries A61 alone. Do not design a disposition call. |
| M70 | Correction | Ledger row A62 stated a mechanism the code makes impossible (`slugForUuid` throws; it never returns `'paperclip'`), and live rows read the real creator. The P0-3 update failure is Paperclip's own 403, not provenance. | Before filing a cause, check that the code can produce it. A62 is struck. |
| M71 | Constraint | Netzar's ACL can authorise a cross-board write that Paperclip then refuses, because writes go out with the acting agent's key. | Owner ruling: ACL authorises, the assignee's key executes, and the audit row records actor-vs-executor. |
| A63 | Assumption now evidence | Paperclip has never run in production: `claudeclaw-orchestrator:13` is both running and latest ACTIVE with no `CCE_PAPERCLIP_ENABLED`, and the mission table holds 8 legacy rows with zero provenance sidecars. | Nothing in this campaign is load-bearing in production. Re-measure before costing any migration. |
| P46 | Precaution | Querying ECS container env by index returned a false empty: `containerDefinitions[0]` is `cloudflared`, `[1]` is `xray-daemon`. | Always query by container NAME. |
| P47 | Precaution | Three test files can join the A52 failing set without being regressions: `authz-matrix.test.ts` and `jarvis.ws-handshake.test.ts` time out at 5000 ms under load, and `buildspec-tag-normalization.test.ts` fails 6x on `spawnSync sh ENOENT` from PowerShell only. | Run the suite from Git Bash, serially. `authz-matrix` is the dangerous one — its failure looks exactly like a broken ACL contract; re-run it alone (113/113 in isolation) before believing it. |
| P48 | Precaution | Git Bash rewrites POSIX-looking paths inside AWS arguments, and `MSYS_NO_PATHCONV=1` then breaks node file paths (`/c/...` becomes `C:\c\...`). An AWS session also expired mid-probe and looked like a code failure. | Use `MSYS_NO_PATHCONV=1` only around AWS args; pipe JSON to node via stdin and avoid file paths. Verify the tunnel is up before attributing an empty response to the product. |

### 5.24 Appended 2026-09-15 (P0-0b validate-and-ship, interrupted)

| ID | Type | New finding | Required correction or precaution |
|---|---|---|---|
| M72 | Correction | This ledger reuses ten IDs for two unrelated entries each: `A47` (§5.14 and §5.6), `A63` (§5.23, two separate rows), `M14` (§5.5 and §5.6), `M15` (§5.5 and §5.14), `M56` (§5.18, two separate rows), `M66` (§5.23, two separate rows), `M67` (§5.23, two separate rows), `P46` (§5.20 and the unlabeled block right after §5.23), `P47` (§5.20 and that same unlabeled block), `P48` (§5.21 and that same unlabeled block). The maxima across the whole file are `M71`, `A63`, and `P53`. | Before assigning a new ledger ID, grep the **whole** file for the highest number in each of `A`, `M`, and `P` — not just the nearest subsection heading. The block right after §5.23 has no heading of its own and is exactly what a quick scan misses. Cite any of these ten by ID **and** subsection until they are disambiguated; new entries from this session onward start at `M72`, `A64`, and `P54`. |
| P54 | Precaution | This session found the host `C:` drive at 0 bytes free (confirmed three ways: `df -h`, PowerShell `Get-PSDrive`, and a direct ~60 KB Node write failing `ENOSPC`) before any image-build command ran. A trivial 5-byte write had succeeded first, which is why the drive looked fine — that was filesystem block-rounding slack, not real headroom. | Check free space with a realistic-sized probe (or `df`/`Get-PSDrive` directly), not a trivial write, before starting an image build or any other large-output step on this machine. A multi-stage amd64+arm64 `docker buildx` run needs several GB of scratch; confirm headroom immediately before starting, not earlier in the session. |
| M73 | Correction | The Phase 0 criterion checklist's WI-1 rows were written against the pre-`73f0812` build stage and describe a mechanism the shipped fix deliberately abandons: "the nine literal tests" (there are eleven), "`--omit=dev` on every build-stage install" (removed by design — installing against `/app`'s own manifest is precisely why nothing reified), and "`git status --short` shows exactly two files" (the branch adds the image-build gate as a third). A critic ruling on that text as written would FAIL a working fix. | Reconcile a criterion list against the code before a critic rules on it, in a dated addendum that replaces mechanisms and counts only — never intent — with each entry carrying the command that proves it. Never relax a criterion to match an implementation. |
| A64 | Assumption now evidence | `deploy.yml` passes `--build-arg DEPLOY_TIER="$CCE_TIER"` to the orchestrator image build, but the Dockerfile declares no `ARG DEPLOY_TIER` in any stage. buildx warns and ignores it, so the value reaches nothing. | Harmless today, and NOT to be "fixed" by adding an unused `ARG`: that would change the build cache key for no gain. Any future use of the tier inside the image must add the `ARG` to the stage that reads it, with a test asserting it. |
| P55 | Precaution | The build stage pins `typescript@5.9.3`, `@types/pdfkit@0.17.6` and `@types/ws@8.18.1` as literals, asserted against `package-lock.json` by `orchestrator-dockerfile.test.ts`. Dependabot PRs #27 (root `typescript` → 7.0.2) and #22 (web) are open. | A lockfile bump fails that test until the Dockerfile literal moves with it. The failure is by design, not a regression — bump the lockfile and the Dockerfile literal in one commit. |
| P56 | Precaution | `src/lib/paperclip/test-helpers.ts` imports `vitest` and is kept out of the image compile only by `tsconfig.build.json`'s `**/test-helpers.ts` exclude; `.dockerignore` excludes `**/*.test.ts` but not that file. | If any compiled `src` file ever imports it, the image build breaks, because vitest is not installed in the build stage. `orchestrator-dockerfile.build.integration.test.ts` is what catches that; a grep corroborates but cannot prove it. |

### 5.25 Added 2026-09-17 (machine transfer)

> New IDs continue from the whole-file maxima that M72 and section 5.24 left: `M73`, `A64`, `P56`. None of the IDs below appears earlier in this ledger.

| ID | Type | New finding | Required correction or precaution |
|---|---|---|---|
| M74 | Correction | **Claim.** The 2026-09-15 handoff says only the image gate ran, and that the disk was found full "before any image-build command ran". This appears in its sections 2, 4.1, 6.2, 6.4, 7 and 8 and in row P54. Its docs builder wrote that without the lane log. **Evidence.** The coordinator's evidence (`1-lanes-summary.txt`: HEAD `4f1a860`, `dirty=0`, docker server 29.7.2 linux/amd64; the `1.1`–`1.4` logs; `1.3-sha-before/after.txt`) shows lanes 1.1–1.4 ran on 2026-09-15 between 18:45 and 18:50Z. **Results.** 1.1: image gate 3/3 in 47 s. 1.2: text tests 11/11. 1.3: with `271339b`'s Dockerfile, 5 of 11 fail as designed, and the restored Dockerfile's sha256 was `5854df9f…` before and after. 1.4: `docker buildx build --platform linux/amd64 --target build --no-cache --load -t p0-0b:build --progress=plain .` exited 1 after 68 s. Its install step logged `added 5 packages in 5s`, and `node node_modules/typescript/bin/tsc` finished in 12.8 s. Then `exporting to image` failed with `failed to create temp dir: mkdir /var/lib/desktop-containerd/daemon/tmpmounts/…: input/output error`. The disk-full finding (about 18:54Z) came after that failure. | Read the 2026-09-15 file with this row in mind. Lane 1.4 was attempted and failed on infrastructure, not on the fix, and lanes 1.5 and 1.6 were never attempted. Re-run 1.1–1.4 on the new machine before 1.5. A docs builder can only report what it ran, so the coordinator reconciles every draft against the evidence log before it lands. |
| M75 | Mistake | The 2026-09-15 session kept its worktree read-only and drafted all three deliverables only in its `%TEMP%` scratchpad (its section 4.3). They were last written on 2026-09-16 between 13:05 and 13:19 EDT and stayed uncommitted until this session, on a disk with 0–3 GB free. The 2026-09-16 session's own disk-freeing proposal listed `AppData\Local\Temp` (3.31 GB) for deletion, which would have destroyed the only copy. | Land drafts in the worktree and commit them locally as soon as they exist; a local commit is not a push. If an instruction keeps the worktree read-only, ask the owner where drafts should go before writing them. Never propose deleting `%TEMP%` while a session's only copy of work lives there. |
| P57 | Precaution | A full disk stops the image lanes. Lane 1.4 died at export when `C:` hit 0 bytes free. On 2026-09-16 the host still had only 3.23 GB free. Its largest consumers were `pagefile.sys` (26.2 GB), `hiberfil.sys` (6.29 GB) and Docker Desktop's data under `AppData\Local\Docker` (25.09 GB). On 2026-09-17 it showed 2.6–3.0 GB free. | Preflight gate before lanes 1.1, 1.4, 1.5 and 1.6: check free space on the drive that holds Docker's data (`df -h` or `Get-PSDrive`, plus `docker system df`). Do not start a lane below 10 GB free. Check immediately before each lane, not once per session. The same 10 GB floor applies on the new machine. |
| A65 | Assumption now evidence | Docker Desktop's engine can stay damaged after a disk-full event. **Sequence on 2026-09-16:** at 13:14 EDT the session ended the `docker.exe` and `Docker Desktop.exe` processes (`kill1.log`, `kill2.log`) and restarted Docker Desktop with the owner's authorization. The daemon then gave no answer across 48 polls. At 14:12 EDT, and again at 14:40, `docker system df` returned `500 Internal Server Error` on the `dockerDesktopLinuxEngine` pipe. The engine was left in that state. | Do not run any lane on this host's engine. On any host, after a disk-full event, require both `docker info` and `docker system df` to answer before lane 1.1. If they do not, repair or reset Docker Desktop before building. A reset destroys local images and volumes, so it is the owner's decision. |
| P58 | Precaution (owner override) | The owner approved pushing `fix/paperclip-p0-0b-image-build` to origin under its own name as a backup before the machine transfer. For this one push, that deliberately overrides agile-hamster STEP 3 and `CLAUDE.md`'s "full `npm test` before pushing". The pushed tip has not been through the full suite in either flag state, or through lanes 1.4–1.6. | The backup push is not a ladder rung. Open no PR from this branch, and merge nothing, until STEP 1 (all six lanes) and STEP 3 (full suite in both flag states, failing set equal to that host's recorded baseline) pass on the exact tip being proposed. STEP 4's own `git push -u` then updates the same remote branch. CI does not run on `fix/*` branches (M67, section 5.23), so the backup push proves nothing about the code. |

## 6. Pending work

### 6.1 Smallest next action

On the new machine, run agile-hamster **STEP 0 preflight**:

1. Make a fresh clone of origin, with a worktree of
   `fix/paperclip-p0-0b-image-build` at its pushed tip. That tip is this
   docs-only commit, whose parent is `4f1a860`. The plan's "HEAD is `4f1a860`"
   check therefore becomes: `git diff --stat 4f1a860 HEAD` touches only
   `docs/features/paperclip/`.
2. Re-check the three reads the plan names, and compare them with the
   2026-09-17 values:
   - `git log -1 origin/development`: expect `271339b`.
   - `gh run list --workflow deploy.yml --branch staging -L 3`: newest should
     be 34180887085.
   - Open PRs to qa and staging: expect none.
3. Confirm the tree is clean.
4. Start Docker and pass the P57/A65 gate: `docker info` and
   `docker system df` both answer, with at least 10 GB free.

Then STEP 1 from lane 1.1 (section 6.2, item 1).

### 6.2 Immediate next steps

1. **STEP 1 on the new machine.**
   - First re-prove lanes 1.1 (3/3), 1.2 (11/11) and 1.3 (five expected
     failures, then `git hash-object Dockerfile` equals `HEAD:Dockerfile`).
   - Then run 1.4 → 1.5 → 1.6 exactly as the plan words them, stopping at the
     first failure.
   - Before each lane, re-run the P57 free-space gate.
2. **Apple Silicon changes what each lane proves.** On Apple Silicon, Docker
   builds arm64 natively and amd64 under emulation, the reverse of this
   Windows host.
   - Lane 1.6 (`--platform linux/arm64`) no longer runs under QEMU there. It
     proves the arm64 build works, but it does not reproduce the CI's
     emulated arm64 build. Even on this host, local QEMU could not prove the
     CI `ETIMEDOUT` is gone. The checklist's M54 and A56 rows (checklist IDs,
     not this ledger's) say only the next staging deploy's attempt-1
     `Build + Push (linux/arm64)` log can.
   - Lanes 1.1, 1.4 and 1.5 (`linux/amd64`) run emulated there and will be
     slower.
   - If the new x86-64 Windows PC is available, it reproduces the original
     semantics (amd64 native, arm64 under QEMU). Prefer it for lane 1.6, or
     record which host and architecture ran each lane.
   - On macOS, write env vars POSIX-style
     (`ORCHESTRATOR_IMAGE_BUILD_TEST=1 npx vitest …`, as the plan does), not
     with README section 8's PowerShell `$env:` form.
3. **Record a fresh full-suite baseline before STEP 3.** The A52 failing set
   (`docs-links.test.ts`, `feature-knowledge.test.ts`, `runnable-blocks.test.ts`,
   `sync-deprecations.test.ts`, `rollback-classes.test.ts`) was measured on
   this Windows host. On macOS or the new PC, run
   `npm test -- --minWorkers=1 --maxWorkers=1` in both flag states on
   untouched `origin/development` first, and diff STEP 3's failing set against
   that recorded set (P1).
4. **STEP 2 reuses the docs committed here instead of regenerating them.**
   Add only what is missing:
   - README section 7's P0-0 row rewritten to M64 plus the real fix.
   - `scripts/lib/lifecycle/orchestrator-dockerfile.test.ts` added to README
     section 8's focused test line.
   - The new lane results in README, `HANDOFF.md` and that session's handoff.
     Carry this file's section 5 forward verbatim.
   - The checklist's "WI-1 reconciliation — 2026-09-15" addendum already
     exists. Re-read it; do not append it again.
   - Commit locally.
5. **STEP 3, then STEPS 4–7, exactly as agile-hamster words them.** Re-read the
   plan's "Owner touchpoints" before STEP 4's first push and PR. The backup
   push is not STEP 4 (P58).
6. **Before any publish to the progress page, read it first** (section 6.3).
   Its local generator is lost, so rebuild the page from the Artifact's own
   content.

### 6.3 Blockers and open questions

- [ ] Blocker: this Windows host cannot run lanes 1.4–1.6. It had 2.6–3.0 GB free on 2026-09-17, and its Docker engine has answered HTTP 500 since 2026-09-16 (P57, A65). Needs: the new machine, with at least 10 GB free and a healthy Docker.
- [ ] Blocker: the progress Artifact is cloud-hosted, but its local generator (`state.json`, `render.mjs`) is lost. No copy exists under this host's `%TEMP%\claude` tree (searched 2026-09-17). Needs: an Artifact `read` of the page, then a regenerated publisher built from that content, before the next publish.
- [ ] Question: which URL is the progress page? The campaign memory cites https://claude.ai/code/artifact/de1aa8aa-508f-4617-a9bc-2819a927e6af. The 2026-09-17 Artifact list shows "Missions Engine Campaign" at https://claude.ai/artifact/URjJ3ig2g6zAtKXYVRvZcz, last updated 2026-09-07, so the 2026-09-15 session never published. Suggested resolution: `read` both, and update the one that matches rather than creating a new page.
- [ ] Question: does A52's five-file failing set hold on macOS and on the new PC? Suggested resolution: section 6.2, item 3.

### 6.4 Deferred, and why

- WI-2 (the A61 issue-level in-flight claim) and WI-3 (P0-3b): excluded by agile-hamster's "Not doing" list. WI-3 needs the owner's go-ahead before any build.
- Production deploy 34184592522 (failed 2026-09-08), with `origin/production` since moved to `de244e6` (confirmed by `git ls-remote` on 2026-09-17): out of scope for this campaign. The plan flags it only.
- Promoting P57, A65 and M75 out of this log (section 4.4): out of scope for a transfer session.

## 7. Verification actually performed

Only commands this session ran, in order, with their real results. Baseline first.

| Command | Baseline (before changes) | After changes |
|---|---|---|
| `df -h /c` | 3.0 G free | 2.6 G free just before the copy; 3.3 G free after the files were written |
| `git rev-parse HEAD`, `git branch --show-current`, `git status --porcelain` (worktree) | `4f1a860355146c34f59a2f35731819cfedb6d2c2`, `fix/paperclip-p0-0b-image-build`, clean | — |
| `node scripts/ci/feature-knowledge.mjs` | exit 0, `feature-knowledge: OK` | exit 0, `feature-knowledge: OK` |
| `node scripts/ci/docs-links.mjs` | exit 0; 136 markdown files, 1674 internal links checked, 71 external skipped; OK | exit 0; 138 markdown files, 1742 internal links checked, 71 external skipped; OK |
| `git diff --no-index --stat` (each worktree file vs its draft) | `HANDOFF.md` 14+/9−; `README.md` 11+; context lines match | — |
| `cp` each draft, then `cmp` and `sha256sum` | — | all three identical (`fdaf0043…`, `a7c47d5f…`, `785ef727…`) |
| `git ls-files --eol docs/features/paperclip/` | every file `i/lf`; `HANDOFF.md` and `README.md` `w/crlf`; the 2026-09-08 file `w/lf` | `HANDOFF.md` and `README.md` still `i/lf w/crlf`; both new session files `i/lf w/lf` |
| `git hash-object --no-filters` (2026-09-15 draft) vs `git ls-files -s` | — | both `a4bd6e2ba3eb2a1f3702144f83035ec317ca2c3d`: stored byte-identical |
| `git hash-object --path=docs/features/paperclip/README.md` (README draft) vs `git ls-files -s` | — | both `46c79f4e951b01865809ad7cfa88c80d201b8c3d`: CRLF normalised to LF, like the existing blob |
| `sha256sum Dockerfile`; `git hash-object Dockerfile`; `git rev-parse HEAD:Dockerfile` | `5854df9f…` (equals the 1.3 evidence); `8b14a583…` twice | — |
| `git rev-list --left-right --count origin/development...HEAD` | `0 4` | — |
| `git ls-remote origin refs/heads/fix/paperclip-p0-0b-image-build` | empty (never pushed) | — |
| `git ls-remote origin` for `development` / `qa` / `staging` / `production` | `271339bc…` / `ac0cbcc0…` / `8299f046…` / `de244e63…` | — |
| `gh pr list --head fix/paperclip-p0-0b-image-build --state all` | `[]` | — |
| `gh pr list --base staging --state open`; the same with `--base qa` | `[]`; `[]` | — |
| `gh run list --workflow deploy.yml --branch staging -L 3` | newest 34180887085, `success`, 2026-09-08T02:40:47Z, head `8299f046…` | — |
| `git worktree list` | no `.worktrees/conversation-history`, `C:/dev/_netzer-ha`, `.worktrees/remove-unattended-auto-pause` or `.worktrees/warroom-scroll-pdf` | — |
| Artifact `list` | "Missions Engine Campaign" last updated 2026-09-07 | — |
| Read-only node scans of the `968da171` transcript | `docker system df` HTTP 500 at 2026-09-16T18:12:00Z; root-file sizes at 18:24:39Z; "which deletions" question asked 18:25:23Z and rejected 18:50:59Z | — |
| `git diff --cached --check` | — | exit 0, no whitespace errors |
| Secret-pattern scan of the staged diff (AWS access-key ids, GitHub token prefixes, Slack token prefixes, the Anthropic key prefix, PEM private-key headers, long base64 runs) | — | no key, token or private-key match; every flagged 40+ character run was a file path, URL or hex SHA |
| `npm run typecheck`, `npm test`, `npm run build`, `npm --prefix web run typecheck`, `npm --prefix web run build`, `npm run local:test:integration` | not run | not run |

Anything not run, and why: no build, test or Docker command ran. This was a
docs-only transfer session, and this host has neither the disk headroom (P57)
nor a working Docker engine (A65). The 32 removed local branch refs (section 8)
were not recounted here.

## 8. Environment state

- **Branch and tip.** `fix/paperclip-p0-0b-image-build`. The tip is the
  docs-only commit that adds this file; its parent is
  `4f1a860355146c34f59a2f35731819cfedb6d2c2`.
- **Pushed.** Not yet at the time of writing; the coordinator pushes this
  branch to origin under the same name immediately after this commit as an
  owner-approved backup (no PR, no merge, no deploy) - confirm with
  `git ls-remote origin refs/heads/fix/paperclip-p0-0b-image-build`.
- **Tools and services.** Windows 11 host, `C:` at 99% (2.6–3.0 GB free on
  2026-09-17). Docker Desktop's engine has been damaged since 2026-09-16 (A65)
  and was not touched this session. No AWS session was used.
- **Active processes.** None started by this session.
- **Environment variables.** None set or changed.
- **Uncommitted work left in the tree.** None from this session once the
  commit lands; the worktree had no other changes.
- **Git housekeeping by another tool.** On 2026-09-16 a Codex session removed
  four verified-clean worktrees (`.worktrees/conversation-history`,
  `C:/dev/_netzer-ha`, `.worktrees/remove-unattended-auto-pause`,
  `.worktrees/warroom-scroll-pdf`) and 32 local branch refs. The record is in
  the devkit at `codex/netzar-local-git-cleanup-2026-09-16.md`. This session
  confirmed the four worktrees are absent and did not recount the refs.
- **Non-git state, and where it lives in the devkit**
  (https://github.com/emmanuelmadams4-lgtm/netzer-devkit, private):

  | State | Devkit path |
  |---|---|
  | Session `968da171` scratchpad: `evidence/` (lane logs, disk scans, Docker logs, deploy-run JSON), `compare-runs.mjs`, `docs-draft/` | `archive/scratch/968da171/` |
  | The plan in force and the Phase 0 control files (Appendix A) | `claude/plans/` |
  | Launch prompt `.scratch/missions-engine-gauntlet.md` | `repo-local/netzer-labs/.scratch/missions-engine-gauntlet.md` |
  | Session `968da171` transcript | `claude/transcripts/968da171-b18e-4ee3-aa88-297efc24bab0.jsonl.gz` |
  | Campaign memory `paperclip-missions-engine-campaign.md`. It was stale (modified 2026-09-07, and it still names the `paperclip-promote` worktree) and is being refreshed by the coordinator | `claude/memory/` |
  | Codex cleanup record | `codex/netzar-local-git-cleanup-2026-09-16.md` |
  | Progress Artifact | Cloud-hosted, not in the devkit. Its generator is lost (6.3) |
  | Local Docker images and build cache | Not transferred. The new machine starts empty, which is what lanes 1.1–1.6 need anyway |

## 9. Related documents

- [Feature README](../README.md)
- [Feature HANDOFF (current state)](../HANDOFF.md)
- [Previous session handoff](./2026-09-15-p0-0b-validate-and-ship.md): section 5 is carried forward here verbatim
- [Phase 0 completion handoff](./2026-09-08-p0-completion-and-workflows-direction.md): its section 6 is still the campaign's ordered next-action list
- [Missions engine plan](../missions-engine-plan.md)
- [Feature knowledge framework](../../README.md)
- [Session handoff template](../../HANDOFF-TEMPLATE.md)
- [Local development guide](../../../../development.md)
- [Contributing and branch promotion](../../../../CONTRIBUTING.md)

## Appendix A - Resume on a new machine

### A.1 Path map

| On this Windows host | On a new machine | Source |
|---|---|---|
| `C:\Users\EmmanuelAdams\.claude\plans\<file>`, for the four plan files listed in A.3 | `~/.claude/plans/<file>`, after running the devkit restore | devkit `claude/plans/<file>` |
| `C:\Users\EmmanuelAdams\.claude\gauntlet\<campaign>` | `~/.claude/gauntlet/<campaign>` | devkit `claude/gauntlet/`. This campaign has no gauntlet folder; the devkit carries only `bedrock-all-models` and `seats-pickers-hotfix` |
| `C:\dev\Netzer-Labs\.worktrees\p0-0b-image-build` | `<dev-root>/Netzer-Labs`: a fresh clone of origin, then a worktree (or checkout) of `fix/paperclip-p0-0b-image-build` | origin |
| `C:\dev\Netzer-Labs\.scratch\missions-engine-gauntlet.md` | `<dev-root>/Netzer-Labs/.scratch/missions-engine-gauntlet.md` | devkit `repo-local/netzer-labs/.scratch/missions-engine-gauntlet.md` |
| `%TEMP%\claude\C--dev-Netzer-Labs\968da171-b18e-4ee3-aa88-297efc24bab0\scratchpad\` (`evidence\`, `compare-runs.mjs`, `docs-draft\`) | Read from the devkit, not restored into a temp folder | devkit `archive/scratch/968da171/` |
| The plan's `$EV` (`<session scratchpad>/evidence/`) | The new session's own scratchpad `evidence/`. Old evidence stays in the devkit | new |
| `codex.exe` under `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>` | The `codex` CLI on PATH. Pass its absolute path to `--cli` | — |
| `-c windows.sandbox="elevated"` | Windows only; drop it on macOS | — |
| `cygpath`, `MSYS_NO_PATHCONV` (ledger P48), PowerShell 5.1 notes, README section 8's `$env:` commands | Windows / Git Bash only. On macOS use POSIX `VAR=value cmd` | — |
| Docker Desktop at `%LOCALAPPDATA%\Programs\DockerDesktop` (the plan's STEP 0 start command) | macOS: `open -a Docker`. New PC: its own install path | — |
| Emulation on this host: amd64 native, arm64 under QEMU (lane 1.6) | Apple Silicon: arm64 native, amd64 emulated (section 6.2, item 2) | — |

### A.2 Fresh-session resume prompt: the plan in force

The resume prompt for this campaign is the approved plan in force,
`~/.claude/plans/gauntlet-mode-direct-coordinator-gauntle-agile-hamster.md`.
Its devkit path is
`claude/plans/gauntlet-mode-direct-coordinator-gauntle-agile-hamster.md`; its
sha256 on 2026-09-17 was
`3ea84186811d7803785e19a933e40fc0efea1358445192f678c1392d7a9575b4`. It is
embedded verbatim below.

It was written on 2026-09-15 on the old host. Its "State measured" block, its
`4f1a860` HEAD check and its Docker start command are as of that date and
host. Only three things change it, all from this handoff:

- the new tip (section 6.1);
- lanes 1.1–1.3 are re-proved on the new machine before 1.4 (section 6.2, item 1);
- STEP 2 reuses the docs committed here (section 6.2, item 4).

Start a fresh session with:
"Resume the Paperclip Phase 0 WI-1 campaign. Read
`docs/features/paperclip/HANDOFF.md` and
`docs/features/paperclip/handoffs/2026-09-17-machine-transfer.md`, then
execute `~/.claude/plans/gauntlet-mode-direct-coordinator-gauntle-agile-hamster.md`
from STEP 0 with that handoff's section 6 adjustments."

`````text
# Plan — Phase 0 STEP 1: validate and ship WI-1 (P0-0b image build) to staging

## Context

WI-1 (P0-0b) repairs the orchestrator `Dockerfile` build stage. The build died on arm64 with
`ETIMEDOUT`, and the fetch-timeout knob didn't fix it. The interim fix installed nothing: all
three compile packages are devDependencies, so `--omit=dev` added none of them and `npx tsc`
fetched the registry stub `tsc@2.0.4`.

The repair is commit `73f0812`. It installs `typescript` / `@types/pdfkit` / `@types/ws` in
`/opt/compiler`, a directory with no package.json, copies them next to the runtime tree, and
compiles with `node node_modules/typescript/bin/tsc`. It is coded and image-gated but not shipped.

This session:
1. Validates the fix end to end.
2. Ships it development → qa → staging.
3. Gets a fresh critic's PASS on every WI-1 criterion.
4. Writes the next handoff and stops.

WI-2 and WI-3 are not touched.

**State measured 2026-09-15 (resume checks):**
- **Worktree:** `.worktrees/p0-0b-image-build`, branch `fix/paperclip-p0-0b-image-build`.
  - HEAD `4f1a860`, tree clean, 4 ahead / 0 behind `origin/development` `271339b`.
  - Never pushed, no PR.
- **Handoff step 1a (merge development) is already done** (`85737b5`).
- **Docs already landed by another session in `4f1a860`** (that session has been idle since 2026-09-08):
  - the HANDOFF.md correction
  - the Phase 0 corrections in `missions-engine-plan.md`
  - session handoff `2026-09-08-p0-completion-and-workflows-direction.md`
- **Ladder is quiet.**
  - qa `ac0cbcc` and staging `8299f04` both contain development.
  - Last staging deploy 34180887085 was green on 2026-09-08.
  - No open PR targets qa or staging; #166 is gone.
- **Docker Desktop is not running.** The AWS session has expired (not needed, see below).
- **Noticed, not touched:** production deploy 34184592522 (workflow_dispatch, 2026-09-08) failed at
  `Build + CDK Deploy + Smoke`, and `origin/production` has since moved to `de244e6`. Out of scope;
  flagged only.

## Owner touchpoints

**Approving this plan authorizes exactly:**
1. Starting Docker Desktop:
   `powershell.exe -NoProfile -Command 'Start-Process "$env:LOCALAPPDATA/Programs/DockerDesktop/Docker Desktop.exe"'`
2. Pushing the branch and merging two ladder passes, development → qa → staging. Each staging merge
   triggers the staging Deploy.

**No `aws login` is needed.** Every WI-1 criterion is checked locally, from the diff, or from `gh`
build logs. If anything turns out to need AWS, I stop and ask.

**Never:** production, `npm run deploy:cloud`, `npm run deploy`, tags, releases.

## Steps

Run everything serially, one heavy process at a time.

**Evidence logs:** `$EV` = `<session scratchpad>/evidence/`. Logs are saved in full and never
pasted; a failure quotes its last ~20 lines.

### 0. Preflight
- **Read the progress artifact first.**
- **Re-check:**
  - `git log -1 origin/development`
  - `gh run list --workflow deploy.yml --branch staging -L 3`
  - open PRs to qa/staging
  - worktree HEAD is `4f1a860` and the tree is clean
- If HEAD moved or the tree is dirty, **stop**: another writer is live.
- Start Docker Desktop and wait until `docker info` answers.

### 1. Image lanes (fail fast; covers handoff 1a's re-run, 1b and 1c)

**1. Image gate after the merge** → 3/3:
`ORCHESTRATOR_IMAGE_BUILD_TEST=1 npx vitest run --config vitest.integration.config.ts scripts/lib/lifecycle/orchestrator-dockerfile.build.integration.test.ts`

**2. Text tests** → 11/11; record all 11 names:
`npx vitest run scripts/lib/lifecycle/orchestrator-dockerfile.test.ts`

**3. Red-first re-proof:**
- Copy the Dockerfile to `$EV`.
- `git show 271339b:Dockerfile > Dockerfile`, run the text tests, and record the failing names.
- Restore the Dockerfile.
- Prove `git hash-object Dockerfile` == `git rev-parse HEAD:Dockerfile`.

**4. M64 inside the build stage:**
- Build: `docker buildx build --platform linux/amd64 --target build --load -t p0-0b:build --progress=plain .`
- Inspect with `docker run --rm --entrypoint sh p0-0b:build -c '…'`:
  - `node_modules/typescript` is present.
  - `aws-cdk-lib`, `vitest`, `tsx`, `constructs` are absent.
- The build log shows a small `added N packages`, and neither `up to date` nor `tsc@2.0.4`.

**5. Full amd64 image (handoff 1b):**
- Build: `docker buildx build --platform linux/amd64 --build-arg DEPLOY_TIER=staging --provenance=false --progress=plain --load -t p0-0b:amd64 -f Dockerfile .` → exit 0.
- In the runtime image:
  - `dist/index.js`, `dist/web` and `dist/adapters/dashboard/public` exist.
  - `node_modules/typescript` is absent. The runtime stage copies `node_modules` from `deps`,
    so the build stage's edits must not leak into it.

**6. arm64/QEMU lane (handoff 1c):**
- Mirrors `deploy.yml:316-324`, without tags or push:
  `docker buildx build --platform linux/arm64 --build-arg DEPLOY_TIER=staging --provenance=false --progress=plain -f Dockerfile .`
- Takes ~9 min. Expect exit 0.
- Record the install's package count, the absence of ETIMEDOUT, and step durations.
- Local QEMU cannot prove the CI ETIMEDOUT is gone (M54); only step 4's deploy can.

**Any failure → stop.** The fix is frozen, so a failure goes to a correction handoff
(IMPLEMENTATION) instead of being rewritten here.

**Then:** publish the artifact (read it first) with the lane results in the WI-1 row.

### 2. PR #1 docs and checklist reconciliation

A fresh sonnet agent builds the docs. **WI-1 items only** — WI-2 and WI-3 docs ride their own PRs.

**`docs/features/paperclip/README.md`**
- Rewrite the §7 P0-0 row (~:428) to M64 plus the real fix. The run id is added in step 4.
- Add `scripts/lib/lifecycle/orchestrator-dockerfile.test.ts` to the `tested_by` front matter and
  to the focused test line (~:448). This is checklist gap 8.

**`docs/features/paperclip/HANDOFF.md`**
- Update the branch/PR state and point "Now" at this session's handoff.

**New `docs/features/paperclip/handoffs/2026-09-15-p0-0b-validate-and-ship.md`**
- Built from `docs/features/HANDOFF-TEMPLATE.md`, with numbered §1–9.
- §5 is carried verbatim from the 2026-09-08 handoff. Only appended rows are allowed:
  - M64/M65, if missing.
  - An A62 correction row. The old row names a mechanism the code makes impossible; append the
    correction, don't rewrite the row.
  - The literal `typescript@5.9.3` pin vs open dependabot PRs #27/#22. A lockfile bump makes the
    text test fail loudly, by design.
  - `--build-arg DEPLOY_TIER` has no matching `ARG` in the Dockerfile (a harmless warning).

**Line endings:** keep each file's existing line endings; the new handoff copies the template's.
Count `\r` before and after, because `git diff` hides CRLF-only churn.

**Gates:** `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/docs-links.mjs`.

**Checklist reconciliation (me):** append a dated "WI-1 reconciliation" section to
`~/.claude/plans/phase0-criterion-checklist.md`. It replaces stale mechanisms and counts only,
never intent, and cites the evidence command for each change:
- "nine tests" → 11.
- T-row "`--omit=dev` on every build-stage install" → removed by design; M64 is now judged by step 1.4.
- Red-first test names → the names measured in step 1.3.
- "exactly two files" and the own-PR file list → the Dockerfile, the two orchestrator-dockerfile
  tests, and docs. `package.json` and `package-lock.json` stay untouched, and the Dockerfile diff
  stays inside the build stage.

**Then:** commit locally.

### 3. Full validation on that exact commit (handoff 1d)
Git Bash, serial, Docker idle.

**Run both flag states:**
- `npm test -- --minWorkers=1 --maxWorkers=1`
- `CCE_PAPERCLIP_ENABLED=1 npm test -- --minWorkers=1 --maxWorkers=1`

**Diff the failing SET against the A52 five:**
- `scripts/ci/docs-links.test.ts`
- `scripts/ci/feature-knowledge.test.ts`
- `scripts/ci/runnable-blocks.test.ts`
- `scripts/release/sync-deprecations.test.ts`
- `scripts/lib/lifecycle/rollback-classes.test.ts`

**Extra failing names:**
- If one is a known impostor (`authz-matrix.test.ts`, `jarvis.ws-handshake.test.ts`,
  `buildspec-tag-normalization.test.ts`), re-run it alone before believing it.
- Any other name is a regression → **stop**.

**Then:** `npm run typecheck`, `npm run build`, `npm --prefix web run typecheck`,
`npm --prefix web run build`, and both docs gates.

### 4. Ladder pass #1 → staging Deploy #1 (handoff 1e)

**Before each rung:** re-check origin/development, the staging runs, and open PRs. If development
moved: merge it, then re-run steps 1.1–1.2 and step 3 before pushing.

**Rungs:**
1. `git push -u origin fix/paperclip-p0-0b-image-build`.
2. PR → development, using the repo PR template if one exists. Body: the fix, its evidence, the
   file list, the own-PR note, staging-only, and the 🤖 footer.
   `gh pr checks --watch`, then merge with `--merge`.
3. PR development → qa; checks; merge.
4. PR qa → staging; checks; merge → this triggers Deploy #1.

**While Deploy #1 runs** (~28 min, remote, so local work is safe):
- **4a.** Make a local-only follow-up docs commit that adds Deploy #1's run id to README §7,
  HANDOFF.md, and the session handoff §4/§7.
- **4b.** Re-run step 3 in full on that commit (CLAUDE.md: full suite before any push).
- **4c.** A fresh sonnet docs critic checks:
  - the Docs row
  - §5 is verbatim (diffed against the 2026-09-08 §5)
  - line endings
  - no command cited that wasn't run
  - the docs gates

**After Deploy #1 completes**, extract the evidence. Every read is attempt-qualified (M65) via
`gh api repos/Adams-Captial-Holdings-Ltd/Netzer-Labs/actions/runs/<id>/attempts/1/jobs`.
- **Equal to bar 33783021194**, also read at attempt 1, compared with a node script rather than by eye:
  - 3 jobs with the same names and conclusions
  - 5/9/30 steps, names in the same order
  - job 3: steps 19 and 21 skipped; steps 14, 23 and 24 success
- **A56:** the attempt-1 `Build + Push (linux/arm64)` log shows the build-stage install with a small
  `added N packages`, no `ETIMEDOUT`, and no `tsc@2.0.4`. Record step durations.
- **A1-18:** `--platform linux/arm64` appears in the log, and `Smoke test (health)` succeeded.
- **CI runs the test:** `orchestrator-dockerfile.test.ts` appears in the `Typecheck + Unit Tests` log.

**If Build + Push fails on attempt 1: do NOT re-run it.**
- A re-run would make A56 unprovable.
- Staging keeps serving the previous image, because the CDK deploy never ran.
- Stop and write the correction handoff.

### 5. Critic panel on Deploy #1

Runs as a Workflow of fresh, read-only agents: no vitest, no docker.

**Inputs:** the checklist's WI-1 section plus the reconciliation addendum, the raw evidence in
`$EV`, the run ids, and the diff. No builder narrative.

**Agents:**
- **Critic A (sonnet): build-log IDs** — A56, M65, Deploy bar, A1-18, CI runs the test.
- **Critic B (sonnet): local and diff IDs** — P0-0 own PR, M64, T-tests, Red-first, M54,
  Compile completeness, Runtime unchanged, Validation.
- **Refuter (opus):** tries to overturn every PASS from A, B, and the 4c docs critic.

**Output per ID:** `{id, verdict: PASS|FAIL, command, evidence}`.

**Any FAIL the refuter doesn't overturn** is routed per the skill:
- docs defect → fix and re-validate
- code defect → correction handoff, then stop

**Then:** publish the artifact (read it first).

### 6. Ladder pass #2 → staging Deploy #2
- Push the follow-up commit and run the ladder development → qa → staging, as in step 4.
- Deploy #2 gives a second attempt-1 A56 sample.
- Confirm Deploy #2 is green and equal to the bar.
- Confirm `git merge-base --is-ancestor <follow-up sha> origin/staging`.
- The refuter gives the final ruling on the Docs row.

**Why step 6 exists:** the Docs row needs the attempt-1 run id merged to staging, and that id only
exists once Deploy #1 has run. If you'd rather the run id ride WI-2's PR, strike step 6. That saves
~2 h, but WI-1's Docs row stays FAIL until then.

### 7. Close
- Publish the final artifact (read it first): WI-1 PASS per ID with its command, the run ids, and a
  log entry.
- Write the next Gauntlet handoff to `~/.claude/plans/p0-wi2-specification-handoff.md`:
  - Markers: `GAUNTLET_MODE: DIRECT_COORDINATOR` / `GAUNTLET_PHASE: SPECIFICATION`, WI-2.
  - Carried forward verbatim: WI-2's three builds and the red-test spec.
  - WI-3: ask the owner before building.
  - Remaining STEP 4 docs:
    - README §6 route inventory
    - the `active-run` route
    - the wakeup path fix
    - the `covered`/`active_child` state
    - README:357 and ADR10:325-327, in WI-2's PR
  - STEP 5 probe-mission cleanup, run as research (needs a fresh aws login).
  - Every constraint.
  - `CODEX_POLICY: CONSERVE`. Eligibility: the log line = yes; the claim/concurrency work = no (opus).
- Update the campaign memory.
- **Stop.** No STEP 2 in this session.

## Not doing
- Rewriting the fix.
- Any WI-2 or WI-3 code.
- README §6 or ADR10 edits.
- Probe-mission cleanup.
- Touching `authz-matrix.test.ts`.
- Renaming agent tools.
- Bare `git stash`.
- Anything in production.

## Verification (end state)
- `git merge-base --is-ancestor 73f0812 origin/staging` is true, and the same holds for the
  follow-up sha.
- Deploys #1 and #2 are both green and equal to bar 33783021194 at attempt 1. Build + Push passed on
  attempt 1 with no ETIMEDOUT, and the logs were read.
- The critic panel returns PASS, each with its command, for every WI-1 ID in the checklist and in
  the reconciliation addendum.
- Local checks:
  - gate 3/3
  - text tests 11/11
  - the full suite's failing set equals the A52 five in both flag states
  - typecheck, build, web typecheck, web build and both docs gates are green
- The artifact is updated, the next handoff file exists, and memory is updated.

**Routing:**
- **Coordinator:** runs the shell lanes directly (mechanical work).
- **Sonnet:** builds the docs and runs critics A, B and the docs critic.
- **Opus:** the refuter.
- **Codex:** CONSERVE and unused, because no implementation remains.
`````

### A.3 The other Phase 0 control files

| File | Role | Devkit path | sha256 on 2026-09-17 |
|---|---|---|---|
| `~/.claude/plans/phase0-criterion-checklist.md` | The critic's only legal vocabulary, including the dated "WI-1 reconciliation — 2026-09-15" addendum (its line 156) that replaces stale WI-1 mechanisms and counts | `claude/plans/phase0-criterion-checklist.md` | `9373a22b09d797f441869ae43417497b89242c6d31a33352205caf3b1962f4ba` |
| `~/.claude/plans/please-follow-the-structure-rosy-sifakis.md` | The approved Phase 0 completion plan (Gauntlet blueprint, three work items). Later phases point back to it and never rewrite it | `claude/plans/please-follow-the-structure-rosy-sifakis.md` | `696cb30a975743dfed5c21240a144168c8aac03ca124cd4d95a0b59af1692a54` |
| `~/.claude/plans/phase0-live-evidence-recipe.md` | Annex to the Phase 0 plan: the SSM tunnel recipe for live staging evidence. WI-1 does not need it. It is needed for the Phase 0 plan's live steps, such as the probe-mission cleanup that agile-hamster STEP 7 hands forward, and it needs `aws login` | `claude/plans/phase0-live-evidence-recipe.md` | `86a14044777812e72c9600c6e5d39f905d3a9283ef26432920a6a1171f41e8fa` |
| `<dev-root>/Netzer-Labs/.scratch/missions-engine-gauntlet.md` | The campaign's original launch prompt. It still names the `paperclip-promote` worktree and `.scratch/missions-engine-plan.md`, which now lives at `docs/features/paperclip/missions-engine-plan.md` | `repo-local/netzer-labs/.scratch/missions-engine-gauntlet.md` | `ef9574ffa66afd5cd2718ea77f0540350d3001b6e317d8217cee86b26039f07f` |
| Session `968da171` evidence and `compare-runs.mjs` | The 2026-09-15/16 lane logs, disk scans and Docker logs cited by M74, P57 and A65 | `archive/scratch/968da171/` | — |
