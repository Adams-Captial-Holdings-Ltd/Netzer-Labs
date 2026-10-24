# [US-003] Clean-clone builder workspace on the VPS (no .env, lockfile installs)

> Backlog task NZR-3 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-006, NFR-007.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** every build session to start in one clean clone of Netzer-Labs that holds no secrets, is freshly fetched from `origin/development`, gets its packages only from the committed lockfiles, and cannot push without my recorded yes
* **So that** no build session can leak a secret, pull in an unreviewed dependency, build on stale code, or push behind my back (measured: 0 secret hits, 0 lockfile diffs, 0 unapproved pushes in the clone's logs)

---

## 2. Business Context & Description
* **Background:**
  - Rewritten for the VPS gauntlet (Q59): the builder factory is Claude Code's gauntlet-loop on the VPS, with Codex building. engdept is parked (Q52, Q59), so this story does **not** use `~/.hermes/engineering/bin/engdept` worktrees.
  - Installs per Q78: run them in a clean clone with no `.env` or secrets; `npm ci` from the lockfile only, never `npm install`; Playwright chromium from its official download; one at a time because the VPS has 3.9 GB RAM (CONSTRAINTS C-55).
  - Fetch before every build (Q74). Every push or merge needs the owner's yes (Q50, CONSTRAINTS C-48).
  - PRD: OBJ-006 (preserve enterprise controls), NFR-007 (zero unauthorized actions). CONSTRAINTS C-14 (0 secret-scan findings, no `.env` in the builder clone) and C-15 (lockfile-only installs).
  - Terms: a **clean clone** is a fresh `git clone` with no untracked files except `node_modules/` and build output. A **lockfile** is `package-lock.json`; `npm ci` installs exactly what it lists and fails if `package.json` disagrees.
* **Current behaviour (verified 2026-10-23, read-only):**
  - `/root/Netzer-Labs` is the owner's working checkout, **not** a clean clone: it holds a real `/root/Netzer-Labs/.env` (4,807 bytes) and an installed `node_modules/`. Builders must never run there.
  - A second clone exists at `/root/work/netzer-baseline` (created 2026-10-23 03:08 at `d1d3a66`, no `.env` present, `node_modules/` being filled by `/root/work/baseline-stage1.sh`, which runs `npm ci --ignore-scripts --no-audit --no-fund` and samples `free -m` every 3 s). It has no push block: `git config remote.origin.pushurl` and `core.hooksPath` are both unset.
  - The VPS **can push today**: `gh auth status` shows a logged-in GitHub account, and `origin` is `https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs`.
  - The repo tracks four `.env*` files that are templates, not secrets: `.env.example`, `.env.local.example`, `.env.reference`, `.env.staging.example` (`git ls-files`). A naive "no `.env*` files" check fails on these.
  - CI installs with `npm ci` (root) and `npm ci --prefix web`, then `npx playwright install --with-deps chromium` (`.github/workflows/ci.yml:288,291,294`). `--with-deps` uses the system package manager (apt), which is a system install, not the "official download".
  - `@playwright/test` is pinned at `1.63.0` in the root `package.json` devDependencies (`package.json:121`), so the browser download runs from the repo root.
  - `scripts/ci/secret-scan.mjs:1-27` skips `.git/` and `node_modules/`, exits 1 on a hit, and knows AWS keys, 40-char secret assignments, ECS env secrets, Slack and Telegram tokens, PEM headers and a denylist. It does **not** know GitHub (`ghp_`, `github_pat_`), Anthropic (`sk-ant-`), OpenRouter (`sk-or-`), NVIDIA (`nvapi-`) keys or JWTs (`/root/.claude/skills/gauntlet-loop/references/review-gauntlet.md:79-80`).
  - Node on the VPS is v26.12.1; `.nvmrc` says `20` and CI uses Node 20 (`ci.yml:29`). The gauntlet records this as a warning (`review-gauntlet.md:230`).
  - The factory helpers live in `/root/.claude/bin/` (not a git repo; verified). Existing bash tests use the pattern in `/root/.claude/bin/test/test-decide.sh` (stub binaries in a temp dir, `fail()` helper).
* **Target behaviour:**
  1. One script, `/root/.claude/bin/netzar-clone.sh`, owns the clean clone at `$NETZAR_CLONE` (default `/root/work/netzer-baseline`). Subcommands: `init`, `fetch`, `check`, `install`, `push`.
  2. `fetch` runs `git fetch origin --prune`, refuses a dirty tree, and prints `FETCHED origin/development <40-hex sha>`. The gauntlet runs it at the start of every step (Q74) and records the line in the step log.
  3. `check` proves the clone is secret-free: no untracked or ignored `.env`-style file, no key file, no secret-shaped string in untracked files, and the repo scanner plus the extra patterns above report nothing. It writes `~/.claude/plans/netzar-logs/clone-check-<ts>.json`.
  4. `install` runs, one at a time and in this order: `npm ci --ignore-scripts`, then `npm ci --prefix web`, then `npx playwright install chromium` (no `--with-deps`). It aborts if free memory falls below 250 MB, then proves both lockfiles are unchanged. It skips the npm steps when the lockfile hashes match the last good install.
  5. Pushing from the clone is blocked twice: `remote.origin.pushurl` is set to an unusable value, and a `pre-push` hook refuses any push whose exact SHA and ref have no owner-yes record. Every attempt, refused or allowed, is logged.
  6. `push <sha> <branch>` is the only way out. It needs a matching record in `~/.claude/plans/netzar-push-approvals.jsonl` that the coordinator writes after the owner says yes in chat, quoting the owner's words.
  7. `/root/.claude/skills/gauntlet-loop/references/review-gauntlet.md` section 10 (Netzer-Labs profile) names this script as the way to get a fresh, fetched, clean tree.
* **Out of scope:**
  - Which model builds or reviews, and keeping secrets out of the builder's process environment: NZR-40 / [US-040](US-040-gauntlet-model-routing-on-the-vps-codex.md).
  - Review layers and third-party sends: NZR-41 / [US-041](US-041-review-gauntlet-v2-wiring-q68-tier-policy.md).
  - Floci, Docker images and the local app stack: NZR-10 / [US-010](US-010-local-model-env-floci-nvidia-dev-backend.md).
  - Any change inside the Netzer-Labs repo. This story changes VPS factory files only.
  - Installing system packages (apt) for Playwright. If chromium fails for missing system libraries, stop and ask the owner.
  - A second build lane (Q69: resize the VPS to 8 GB first).
* **Target Value:** 0 secret hits on every `check` run; 0 lockfile diffs after every `install`; 100% of steps start with a `FETCHED origin/development <sha>` line; 0 pushes without an owner-yes record (count of `allowed` push-log lines with no matching approval = 0).
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: A fresh clone is secret-free
* **Given** `netzar-clone.sh init` created the clone from `origin/development` and it holds only tracked files plus `node_modules/`
* **When** `netzar-clone.sh check` runs
* **Then** it exits 0, prints `CLONE CLEAN <sha>`, and writes a JSON report with `{"sha": "<40-hex>", "env_files": [], "key_files": [], "scanner_hits": 0, "extra_pattern_hits": 0}`; the four tracked `.env*.example`/`.env.reference` templates are listed under `"tracked_templates"` and do not count as findings
* **Test:** `/root/.claude/bin/test/test-netzar-clone.sh` › "check passes on a fresh clone and ignores tracked env templates"

### Scenario 2: A secret in the clone fails the check
* **Given** a clean clone
* **When** an untracked `.env` file, an untracked `id_rsa`, or an untracked file containing `nvapi-` followed by 20+ key characters appears, and `check` runs
* **Then** it exits 1, prints `CLONE NOT CLEAN: <path> (<reason>)` for each one, never prints the matched value, and the report has the paths under `env_files`, `key_files` or `extra_pattern_hits`
* **Test:** `/root/.claude/bin/test/test-netzar-clone.sh` › "check fails on an untracked .env, key file or nvapi- string without echoing the value"

### Scenario 3: Fetch before every build, and a dirty tree is refused
* **Given** the clone is clean and `origin` has a new commit on `development`
* **When** `netzar-clone.sh fetch` runs
* **Then** it prints `FETCHED origin/development <new sha>` and exits 0; if the tree has uncommitted or untracked changes outside `node_modules/` it exits 3 with `REFUSED: dirty tree` and fetches nothing
* **Test:** `/root/.claude/bin/test/test-netzar-clone.sh` › "fetch reports the new origin sha and refuses a dirty tree" (uses a local bare repo as `origin`; no network)

### Scenario 4: Lockfile-only installs, one at a time
* **Given** the clone has no `node_modules/`
* **When** `netzar-clone.sh install` runs
* **Then** it runs exactly `npm ci --ignore-scripts`, then `npm ci --prefix web`, then `npx playwright install chromium`, each starting only after the previous one exited 0; the install report lists the three commands in that order with exit code 0; `git status --porcelain -- package-lock.json web/package-lock.json` is empty; the report records the lowest MemAvailable sample and the peak used memory
* **Test:** `/root/.claude/bin/test/test-netzar-clone.sh` › "install runs the three commands serially and in order" (stub `npm`/`npx` on `PATH` record their argv and start/end times)
* **Test (evidence, attended once on the VPS):** `~/.claude/plans/netzar-logs/install-<ts>.json` from a real run, with all three exit codes 0

### Scenario 5: Install refuses drift and low memory
* **Given** a stub `npm ci` that rewrites `package-lock.json`, or a memory sample below 250 MB MemAvailable
* **When** `install` runs
* **Then** it exits 1 with `LOCKFILE CHANGED: package-lock.json` (and runs no later command), or exits 1 with `ABORTED: low memory (<n> MB available)` after stopping the running command; nothing is retried automatically
* **Test:** `/root/.claude/bin/test/test-netzar-clone.sh` › "install fails on lockfile drift" and › "install aborts below 250 MB available"

### Scenario 6: Push without an owner yes is refused and logged
* **Given** a builder session in the clone with a local commit `<sha>` on branch `gauntlet/<step>`
* **When** it runs `git push`, `git push --no-verify origin HEAD`, or `git push https://github.com/... HEAD`
* **Then** each push fails before any network call (the push URL is unusable, and the hook refuses when it runs), and `~/.claude/plans/netzar-logs/push-attempts.jsonl` gains a line `{"ts", "sha", "ref", "result": "refused", "reason": "no owner yes for <sha12> -> <ref>"}` for each attempt the hook saw
* **Test:** `/root/.claude/bin/test/test-netzar-clone.sh` › "push is refused without an approval record and logged"

### Scenario 7: An approved push goes through only for the approved SHA and ref
* **Given** `netzar-push-approvals.jsonl` holds `{"sha": "<sha>", "ref": "refs/heads/docs/x", "owner_text": "yes push docs/x", "ts"}`
* **When** `netzar-clone.sh push <sha> docs/x` runs, and later the same command runs with a different SHA or branch
* **Then** the first push is allowed and logged with `"result": "allowed"`; the second is refused with `no owner yes for <sha12> -> <ref>`; an approval is single-use (a second push of the same SHA and ref is refused)
* **Test:** `/root/.claude/bin/test/test-netzar-clone.sh` › "approved push is allowed once, only for its sha and ref" (pushes to a local bare repo)

---

## 4. Technical Notes & Constraints
* **Dependencies:** None.
* **UI/UX Design:** N/A: no user interface in this step.
* **Non-Functional Requirements:**
  - Installs run serially; the `install` subcommand aborts the running command when MemAvailable drops below 250 MB (same guard as `/root/work/baseline-stage2.sh`). The report records peak used memory. The backlog line "peak RAM < 3.5 GB" is reported, not enforced, because other VPS services already use about 2.4 GB at idle (`free -m`, 2026-10-23).
  - No credentials in the clone. `check` must finish in under 60 s on the full tree.
  - No network in tests. Real network is used only by the attended `init`, `fetch`, `install` and an approved `push`.
  - Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md) (C-14, C-15, C-48, C-55).
* **Data & Analytics:** N/A: no product event for this step. Factory logs only: `~/.claude/plans/netzar-logs/{clone-check,install}-<ts>.json`, `push-attempts.jsonl`. They hold paths, SHAs and exit codes, never file contents or secret values.
* **Files to change:**

  | path | change |
  |---|---|
  | `/root/.claude/skills/gauntlet-loop/references/review-gauntlet.md` lines 216-236 (section 10) | Replace "Work from a fresh detached worktree ... `git clean -xdf`" (line 218-219) with: run `netzar-clone.sh fetch` then `check` at the start of every step; branch per step from the fetched SHA; push only via `netzar-clone.sh push` after an owner yes. Replace the CI line `npx playwright install --with-deps chromium` habit with `npx playwright install chromium` and say why. |
  | `/root/.claude/skills/gauntlet-loop/SKILL.md` lines 1109-1116 (Housekeeping) | Add one rule: "Netzer-Labs builds run only in the clean clone (`netzar-clone.sh`); never in `/root/Netzer-Labs`, which holds a real `.env`." |
  | `/root/.hermes/skills/software-development/gauntlet-loop/references/hermes-adaptation.md` line 74-81 | Add one line pointing to `netzar-clone.sh` for Netzer-Labs (the Hermes copy is parked with engdept, Q59; keep it from contradicting). |
  | `/root/work/netzer-baseline/.git/config` | Set by `init`/`check`: `remote.origin.pushurl = DISABLED-owner-yes-required`, `core.hooksPath = /root/.claude/bin/hooks/netzar`. |

* **New files:**
  - `/root/.claude/bin/netzar-clone.sh`: the clone manager (`init | fetch | check | install | push <sha> <branch>`), bash + `jq`, `set -euo pipefail`, env overrides `NETZAR_CLONE`, `NETZAR_ORIGIN`, `NETZAR_LOG_DIR`, `NETZAR_APPROVALS` for tests.
  - `/root/.claude/bin/hooks/netzar/pre-push`: refuses unless stdin's `<local sha> <remote ref>` pair has an unused approval; logs every attempt.
  - `/root/.claude/bin/test/test-netzar-clone.sh`: the tests above, using a temp bare repo as `origin` and stub `npm`/`npx`.
  - `~/.claude/plans/netzar-push-approvals.jsonl`: created empty by `init` (mode 600).
* **API contract:** N/A: no API change. CLI contract instead:

  | command | exit 0 | other exits |
  |---|---|---|
  | `init` | clone exists, push block set | 2 usage; 1 clone failed |
  | `fetch` | prints `FETCHED origin/development <sha>` | 3 dirty tree; 1 git error |
  | `check` | prints `CLONE CLEAN <sha>`, writes report | 1 findings (paths only) |
  | `install` | three steps ok, lockfiles unchanged | 1 step failed, drift, or low memory |
  | `push <sha> <branch>` | pushed, approval consumed | 4 no approval; 1 git error |

* **Data changes:** None in the product. Factory files only (above). Approval record shape: `{"ts": ISO, "sha": "<40-hex>", "ref": "refs/heads/<branch>", "owner_text": "<owner's words, <=200 chars>", "used": false}`; `push` appends `{"ts", "sha", "ref", "event": "used"}` rather than rewriting lines.
* **Security notes:**
  - SECURITY.md assets A6 (secrets) and boundary B8 (factory/CI → repo); risk #11 (factory agents with write access, secret scan blind to `src/`).
  - Never print a matched secret: report path, line number and pattern id only. The repo scanner prints an excerpt of each hit (`scripts/ci/secret-scan.mjs:198`: `${h.file}:${h.line}: [${h.id}] ${h.excerpt}`), so `check` must keep only `file:line:[id]` from its stderr and never copy the excerpt into a log.
  - Extra patterns for `check` (fail closed): `ghp_[A-Za-z0-9]{36}`, `github_pat_[A-Za-z0-9_]{20,}`, `sk-ant-[A-Za-z0-9_-]{20,}`, `sk-or-v1-[a-f0-9]{20,}`, `nvapi-[A-Za-z0-9_-]{20,}`, `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.`, and file names `.env`, `.env.local`, `.env.*` (except the four tracked templates), `*.pem`, `id_rsa*`, `.npmrc` containing `_authToken`.
  - Push block has two layers on purpose: the hook alone is skipped by `--no-verify`; the disabled push URL alone is bypassed by an explicit URL. Together they cover both. `gh` stays logged in for the owner; the guard does not touch `~/.config/gh/`.
  - Approval records are written by the coordinator only after the owner's yes in chat (Q50). A builder work order must say "never write to `netzar-push-approvals.jsonl`" (Codex Work Order `DO NOT` list, `SKILL.md:1527-1528`).
* **Test plan:**
  - Frozen failing tests first: all seven cases in `/root/.claude/bin/test/test-netzar-clone.sh`, committed (see Agent gotchas on git) before `netzar-clone.sh` exists, so the red run fails with "No such file".
  - Fixtures: a temp bare repo seeded with a tracked `.env.example`, `package.json`, `package-lock.json`, `web/package-lock.json`; stub `npm`, `npx`, and `free` scripts on `PATH`. Synthetic only; the fake `nvapi-` string is built at run time from pieces so the test file itself never matches a scanner.
  - Commands: `bash /root/.claude/bin/test/test-netzar-clone.sh`; regression for the neighbours: `bash /root/.claude/bin/test/test-decide.sh` and `python3 -m unittest /root/.claude/bin/test/test_lane_guard.py`.
  - Attended evidence run (owner present, Q78): `netzar-clone.sh init && netzar-clone.sh fetch && netzar-clone.sh check && netzar-clone.sh install && netzar-clone.sh check`, logs kept under `~/.claude/plans/netzar-logs/`.
* **Repo rules that apply:** No Netzer-Labs repo change, so nav sync, `docs/diagrams.map`, `CAPABILITY_MIN_ROLE` and audit rules do not apply. Applies: no new dependency (bash, git, jq, node only); never `npm install` (Q78); never run `npm run local:test:integration` in the clone (it reads `.env`, `review-gauntlet.md:229`).
* **Rollback:** Delete `/root/.claude/bin/netzar-clone.sh`, `hooks/netzar/`, and the test; in the clone run `git config --unset remote.origin.pushurl` and `git config --unset core.hooksPath`; revert the three doc edits from the snapshot taken in slice 1. The clone itself can be deleted and re-created with `init`.
* **Build slices (proposal):**
  1. **Snapshot + tests (red):** put `/root/.claude/bin` and `/root/.claude/skills/gauntlet-loop` under a local-only git repo, or take dated copies if the owner says no (see NOTES); write `test-netzar-clone.sh` (all 7 cases fail).
  2. **init / fetch / check:** turns Scenarios 1-3 green.
  3. **install:** serial runner, memory guard, lockfile proof, hash stamp; turns Scenarios 4-5 green; then the attended real install.
  4. **push guard + docs:** hook, `push`, approvals; turns Scenarios 6-7 green; edit `review-gauntlet.md` §10, `SKILL.md` Housekeeping, `hermes-adaptation.md`.
* **Agent gotchas:**
  - `/root/Netzer-Labs` has a real `.env`. Never point a builder, a test or `check` at it.
  - The tracked `.env.example`, `.env.local.example`, `.env.reference`, `.env.staging.example` are templates: match file names exactly; do not treat `.env*` as a secret.
  - `/root/.claude/bin` and the skill folder are not git repos, so there is no red SHA until slice 1 creates one.
  - `npx playwright install --with-deps` (as in CI) runs apt as root: do not copy it. Without `--with-deps`, chromium may fail to start for a missing system library; that is a stop-and-ask, not a reason to add `--with-deps`.
  - `npm ci --prefix web` runs without `--ignore-scripts` because that is the owner's exact command (Q78); do not "harmonise" it. UNVERIFIED: whether any root dependency (e.g. `tsx` → `esbuild`) needs its install script to work after `--ignore-scripts`; the attended run's `npm run typecheck` answers it.
  - `/root/work/baseline-stage1.sh` may still be running in the same clone. Check `pgrep -f "npm ci"` before `install`; two installs at once break the RAM rule.
  - `git fetch` does not move the current branch. Start each step with `git switch -c gauntlet/<step> <fetched sha>`, not `git pull`.
  - Node 26 on the VPS vs Node 20 in CI: record the warning in the step log; do not change the system Node.
  - The hook reads `<local ref> <local sha> <remote ref> <remote sha>` lines on stdin; a push of several refs sends several lines, and each one needs its own approval.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Factory ready (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** factory, urgent

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (Factory operator; 0 secrets, 0 drift, 0 unapproved pushes).
- [ ] Acceptance criteria cover both happy paths and edge cases (7 scenarios: clean, secret found, dirty fetch, serial install, drift/low memory, refused push, approved push).
- [ ] UX/UI designs: N/A: no user interface in this step.
- [ ] Dependencies have been identified and are unblocked (none). Owner has said whether `/root/.claude/bin` and the skill folder may become local-only git repos (NOTES-B-factory item 1).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail): one script, one hook, one test file, three doc edits.
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (`bash -n` and `shellcheck` if present, else N/A; the new `check` run on the clone) + step maid (Q68, T2). No Greptile, Kodus or CodeRabbit.
- [ ] A frozen failing test came first (red SHA recorded in the local factory repo or the dated snapshot); the gate `bash /root/.claude/bin/test/test-netzar-clone.sh` is green, and `test-decide.sh` and `test_lane_guard.py` still pass.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner accepts the evidence summary (attended `init → fetch → check → install → check` logs, plus one refused push line).
- [ ] Documentation is updated: `review-gauntlet.md` §10, `SKILL.md` Housekeeping, `hermes-adaptation.md`; a dated session handoff in `~/.claude/plans/`; the clone path recorded in the Netzar STATE FILE.
- [ ] Done = installed on the VPS and verified locally (factory change; nothing merges to `development`). Any push stays behind the owner's yes (Q50). Staging: N/A for factory files.

---

<!-- runner:evidence:start -->
### Story exit gate evidence (runner)

```
Story: NZR-3   HEAD: eec716f6f38feab03857e7d54386de9477d0b8bc
G1 code review : PASS  reviewer=claude-opus fresh critic session=bd55ae03-61ea-4461-927d-06477e3a5ae1 findings=6/16 open_low=10 greptile=GR:PASS
GR greptile    : PASS confidence=5 comments=1 plus=False
G2 unit tests  : PASS        red=eeef987 green=eec716f counts=4692/4692 story_files=21/21 typecheck=ok
G2b integration: PENDING run=- (not in runner scope yet, Goal v1)
G3 UAT         : PENDING scenarios=7/7 pending_owner=0 accepted_by=- date=-
G4 E2E         : PASS run=docs/features/netzar-studio/evidence/NZR-3/e2e-run.txt counts=17/17
G5 Opik eval   : N/A     experiment=- (not in runner scope yet, Goal v1)
Lessons checked: L-001,L-002,L-003,L-004,L-005,L-006,L-007,L-008,L-009,L-010,L-011,L-012   New lessons: L-005, L-006, L-007, L-008, L-009, L-010, L-011, L-012
```

- [e2e-run.txt](../evidence/NZR-3/e2e-run.txt)
- [g1-review.md](../evidence/NZR-3/g1-review.md)
- [gates.md](../evidence/NZR-3/gates.md)
- [uat-transcript.md](../evidence/NZR-3/uat-transcript.md)
- [uat.json](../evidence/NZR-3/uat.json)
<!-- runner:evidence:end -->

## 8. NOTES

- **Waiver (owner decision, 2026-10-24): push-bypass limit.** A builder sharing the unix user can borrow the owner's `gh` credentials and push around the clone guard. The owner WAIVED this limit to NZR-40 (separate unix user for builders). It is not solved here; `cmd_push` keeps its `shortcut:` comment.
- **Owner decision (2026-10-24): fetch credentials.** The clone holds no credentials (`init`), so `fetch` injects a per-command helper (`NETZAR_FETCH_CRED`, default `!gh auth git-credential`) for the read only, the way `push` does. Test `t_fetch_cred` uses a stub helper.
- **Script placement decision.** The scripts live in the repo at `scripts/factory/netzar-clone/` (reviewable, tested in CI), not only in `/root/.claude/bin`. `init` installs the hook to `$HOME/.claude/bin/hooks/netzar` (outside any checkout); `check` fails if that copy differs by sha256 from the repo copy.
- **Cheap lows fixed:** low-memory abort kills the whole process group (`setsid`); the hook ignores approvals with `used:true` or an empty `owner_text`; the install stamp is removed before either package dir is touched and written only after success (`t_install_stamp`).
