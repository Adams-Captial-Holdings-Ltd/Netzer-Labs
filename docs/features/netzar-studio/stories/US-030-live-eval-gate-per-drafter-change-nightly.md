# [US-030] Live eval gate: per drafter change + nightly, hash-checked in CI

> Backlog task NZR-30 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-027.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** every drafter change scored by a live eval and checked in CI
* **So that** the drafter can only get better

Concretely: a pull request that changes the drafter cannot go green unless it carries a live result whose pass count is at least the stored baseline's. A nightly VPS run tells the owner on Telegram when the drafter has slipped below it.

---

## 2. Business Context & Description
* **Background:**
  - **Q66 / Q89** (owner): live eval on each drafter change and nightly, on the VPS only. No model keys in GitHub. CI only checks the committed result's hashes and score. CI fails on a hash mismatch or a lower score.
  - **Q58**: production reach stays blocked until the score is re-measured on Bedrock. CONSTRAINTS C-07; DEPLOY.md:19 and :177 make that a pilot gate.
  - **Q72**: kill rule. Under 70% at the Nov 23 gate stops UI work. The nightly message on Nov 23 is the evidence.
  - **Q50**: every merge and push needs the owner's yes. **Q74**: fetch before every build.
  - SECURITY.md §4 item 8: a lower security score blocks the merge, like the quality score.
  - PRD FR-027 (business-oriented regression tests). CONSTRAINTS C-04, C-05, C-06, C-07.
* **Current behaviour (d1d3a66):**
  - CI (`.github/workflows/ci.yml:1-7`) runs on `pull_request` and `push` to `development`, `qa`, `staging`, `production`. The `verify` job checks out shallow (`ci.yml:23-24`, no `fetch-depth`). Only `branch-guard.yml:36` and `docs-ci.yml:80` fetch full history.
  - `deploy.yml:176` already runs a TypeScript gate with `npx tsx scripts/ci/tier-gate.ts`. Same pattern here.
  - No eval exists. After US-014: `evals/drafter/results/current.json`, `scripts/ci/drafter-eval-gate.ts` (hash checks only), `npm run eval:drafter` (live runner), and the CI job `drafter-eval-gate` with `fetch-depth: 0`.
  - The VPS runs Hermes, which has a cron scheduler (`/root/.hermes/cron/`) and delivers to the owner's Telegram. There is no systemd timer or crontab for the factory (`systemctl list-timers` shows only OS timers). UNVERIFIED: exact Hermes cron job syntax. Load the `hermes-agent` skill before creating the job.
* **Target behaviour:**
  1. `evals/drafter/baseline.json` stores one baseline per provider (`nvidia-dev`, later `bedrock`). The committed `current.json` is always the baseline: the gate checks they match.
  2. The gate compares the PR's baseline with the base branch's. Same dataset and model: passed count and security count must not drop. Changed dataset or model: the result must be a declared re-baseline.
  3. On failure the gate prints both scores in one line, so the owner sees them in the CI log.
  4. A nightly Hermes cron job runs the live eval on a fresh checkout of `origin/development` on the VPS. It writes outside the repo and never commits. It sends one Telegram message when below baseline, below the 70% kill line, or aborted. It sends nothing when fine.
  5. "Per drafter change" is a gauntlet rule. When the gate fails on a drafter hash, the builder runs `npm run eval:drafter -- --trigger=drafter_change` on the VPS and commits both files.
  6. `drafter-eval-gate.ts --require-production-score` fails unless a Bedrock baseline exists at or above 80%. The pilot deploy story (NZR-38) calls it.
* **Out of scope:**
  - The cases, scorer, hashes, runner, drafter v0 → US-014.
  - The drafter product (routes, UI) → US-023. Wiring `--require-production-score` into the deploy path → NZR-38 (US-038).
  - Running any eval in GitHub Actions (Q89). Bedrock credentials on the VPS → NZR-42 follow-up (see NOTES).
* **Target Value:** 0 drafter merges without a matching eval result. Measured by the CI job `drafter-eval-gate` being a required check on `development`, plus the mutation tests in `scripts/ci/drafter-eval-gate.test.ts`. Nightly: 1 run per night; alert latency ≤ 15 min after the run ends.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Better passes
* **Given** the base branch baseline `nvidia-dev` = 24/30 (security 8/8), and a PR whose `current.json` has 25/30 (security 8/8) with the same dataset and model hashes, and whose `baseline.json.nvidia-dev` equals that result (same `resultSha256`, `passed`, `securityPassed`)
* **When** CI runs `npx tsx scripts/ci/drafter-eval-gate.ts` in a PR to `development`
* **Then** it exits 0 and prints `drafter eval ok: 25/30 (83.3%), baseline 24/30 (80.0%), security 8/8 [nvidia-dev, knowledge: keyword, not representative]`
* **And** an equal score (24/30) also exits 0
* **Test:** `scripts/ci/drafter-eval-gate.test.ts` › "passes a higher score and an equal score against the base baseline"

### Scenario 2: Worse fails
* **Given** base baseline 24/30 and a PR result of 23/30, same hashes
* **When** the gate runs
* **Then** it exits 1 and prints exactly `drafter score dropped: baseline 24/30 (80.0%), this change 23/30 (76.7%)`
* **Test:** `scripts/ci/drafter-eval-gate.test.ts` › "fails with both scores when the pass count drops"

### Scenario 3: Security score drop fails even if quality rose
* **Given** base baseline 24/30 with security 8/8, and a PR result of 26/30 with security 7/8
* **When** the gate runs
* **Then** it exits 1 and prints exactly `drafter security score dropped: baseline 8/8, this change 7/8`
* **Test:** `scripts/ci/drafter-eval-gate.test.ts` › "fails when security passes drop even though the total rose"

### Scenario 4: Baseline file tampered or stale
* **Given** (a) `baseline.json.nvidia-dev.resultSha256` ≠ sha256 of the committed `current.json`, or (b) a PR that lowers `baseline.json` to 20/30 with an old `current.json`
* **When** the gate runs
* **Then** it exits 1 with (a) `baseline.json does not match the committed result` or (b) the Scenario 2 line (the comparison always uses the **base branch's** `baseline.json`, read with `git show <base>:evals/drafter/baseline.json`)
* **Test:** `scripts/ci/drafter-eval-gate.test.ts` › "fails when baseline.json does not match current.json" and › "compares against the base branch, not the PR's own baseline"

### Scenario 5: Dataset or model changed needs a declared re-baseline
* **Given** a PR whose result's dataset hash or model hash differs from the base branch's baseline for that provider (new cases, NVIDIA model swap, or the first Bedrock run)
* **When** the gate runs and `current.json.trigger !== "rebaseline"`
* **Then** it exits 1 with `dataset or model changed: run npm run eval:drafter -- --trigger=rebaseline`
* **And** with `trigger: "rebaseline"` it exits 0 and prints `RE-BASELINE nvidia-dev: 22/30 replaces 24/30 (dataset changed) - owner must approve this merge`
* **And** if the base branch has no `baseline.json` at all, it exits 0 with `no baseline on base branch; this result becomes the baseline`
* **Test:** `scripts/ci/drafter-eval-gate.test.ts` › "requires trigger=rebaseline when dataset or model hash changes" and › "accepts the first baseline"

### Scenario 6: Nightly drift alert
* **Given** the Hermes cron job `netzar-drafter-eval-nightly` at 02:30 UTC, a fresh `git fetch && git checkout --detach origin/development` in the VPS clean clone (NZR-3), and baseline 24/30
* **When** `npm run eval:drafter -- --trigger=nightly` finishes with 22/30
* **Then** it writes `~/.netzar-eval/nightly/<YYYY-MM-DD>.json` (same schema as `current.json`), does not modify any file in the checkout (`git status --porcelain` empty), and exits 3
* **And** the owner gets one Telegram message, exactly: `Drafter nightly eval BELOW baseline: 22/30 (73.3%) vs 24/30 (80.0%) on nvidia-dev @ <short sha>. Security 8/8. Not representative (keyword knowledge).`
* **And** when the score is under 70%, the first line is instead `KILL LINE (Q72): drafter at 20/30 (66.7%), below 70%.`
* **And** at or above baseline it exits 0 and no message is sent
* **Test:** `src/lib/workflows/eval/nightly.test.ts` › "summarizeNightly returns the below-baseline message, the kill-line message, or null"
* **Test:** `src/lib/workflows/eval/runner.test.ts` › "nightly mode writes only under NETZAR_EVAL_OUT and never into the repo"

### Scenario 7: Nightly run cannot finish
* **Given** the NVIDIA backend is down, or the run aborts (US-014 Scenario 8: model fallback or > 3 model errors)
* **When** the nightly job runs
* **Then** it exits 2 and the owner gets exactly `Drafter nightly eval did not finish: <reason>. Last good night: <YYYY-MM-DD or none>.`
* **And** two aborted nights in a row add a second line, `Two nights without a drafter score.`
* **Test:** `src/lib/workflows/eval/nightly.test.ts` › "aborted run message, with the second-night line"

### Scenario 8: Production reach blocked without a Bedrock score
* **Given** `baseline.json` with only `nvidia-dev`, or `bedrock` at 22/30
* **When** `npx tsx scripts/ci/drafter-eval-gate.ts --require-production-score` runs
* **Then** it exits 1 with `production reach blocked: no Bedrock drafter score (Q58)` or `production reach blocked: Bedrock drafter score 22/30 (73.3%) is below 80%`
* **And** with `bedrock` at 24/30, `representative: true`, it exits 0
* **Test:** `scripts/ci/drafter-eval-gate.test.ts` › "--require-production-score blocks without a representative Bedrock score at 80%"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-14 / US-014](US-014-drafter-eval-set-30-cases-scorer-live.md) Drafter eval set (30 cases) + scorer + live baseline; [NZR-23 / US-023](US-023-workflow-drafter-describe-draft-or-clarifying-question.md) Workflow drafter: describe -> draft or clarifying question. Also uses the VPS clean clone (NZR-3) and Hermes cron + Telegram delivery (already on the VPS).
* **UI/UX Design:** N/A: CI gate. User-facing text is the CI log lines and Telegram messages above; they are exact copy.
* **Non-Functional Requirements:**
  - No secrets in CI. The NVIDIA key stays on the VPS. The gate job declares no `env:` secrets and makes no network call (US-014 Scenario 4 test covers the script).
  - Nightly cost: 30 cases × 3 repeats. Rough $1–3/night (DEPLOY.md:122). It goes through the spend ledger of the VPS dev stack.
  - The nightly must not overlap a gauntlet build (3.9 GB RAM, one lane, Q69). The job takes a lock file `~/.netzar-eval/run.lock`. If a lock is held it waits up to 60 min, then sends `Drafter nightly eval skipped: VPS busy.`
  - Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only. The nightly result files under `~/.netzar-eval/nightly/` are the trend record. They are not committed (Q50: no commits without owner yes).

#### Baseline file (`evals/drafter/baseline.json`, zod `DrafterBaselineSchema` in `src/lib/workflows/eval/result-schema.ts`)
```jsonc
{
  "schemaVersion": 1,
  "baselines": {
    "nvidia-dev": {
      "runId": "2026-11-05T0230Z-3f9c1a",
      "resultSha256": "<sha256 of evals/drafter/results/current.json bytes, LF>",
      "passed": 24, "cases": 30,
      "securityPassed": 8, "securityCases": 8,
      "datasetHash": "<= current.hashes.dataset>",
      "modelHash": "<= current.hashes.model>",
      "drafterFilesHash": "<= current.hashes.drafterFiles>",
      "representative": false,
      "setAt": "2026-11-05T03:10:00Z",
      "trigger": "manual"
    }
    // "bedrock": { … } after NZR-42; one current.json per provider is NOT supported, see gotchas
  }
}
```
Comparison uses integer counts (`passed`, `securityPassed`), never floats. Percentages are display only, one decimal.

#### Gate algorithm (`scripts/ci/drafter-eval-gate.ts`, extends US-014)
1. US-014 hash checks (drafter, dataset, model, `mode: live`, file present).
2. `baseline.json.baselines[current.provider]` exists and matches `current.json` (`resultSha256`, counts, hashes). Else `baseline.json does not match the committed result`.
3. Find the base: `GITHUB_BASE_REF` set (PR) → `origin/$GITHUB_BASE_REF`. Push event → `HEAD^1`. Local run → `origin/development`. Read `git show <base>:evals/drafter/baseline.json`; missing → first-baseline notice, exit 0.
4. Base entry for the provider exists with equal `datasetHash` and `modelHash` → ratchet: `passed >= base.passed` and `securityPassed >= base.securityPassed`. Else → require `current.trigger === 'rebaseline'`.
5. Flag `--require-production-score` → check `baselines.bedrock` exists, `representative === true`, `passed / cases >= 0.80`.
6. Exit codes: 0 ok, 1 gate failure. Every failure line is printed before exit, so one run shows all problems.

#### Nightly job (VPS)
- **Hermes cron job** `netzar-drafter-eval-nightly`, schedule `30 2 * * *` (UTC), delivers to the owner's Telegram. Its command:
  `cd <clean clone> && git fetch origin && git checkout --detach origin/development && npm ci && NETZAR_EVAL_Q65_ACCEPTED=1 NETZAR_EVAL_OUT=$HOME/.netzar-eval npm run eval:drafter -- --trigger=nightly`
- The job forwards stdout to Telegram only when the exit code is non-zero. UNVERIFIED: whether Hermes cron supports "deliver only on failure". If not, the script prints nothing on success and the job is configured to skip empty output. Check with the `hermes-agent` skill.
- `scripts/eval/drafter-live.ts --trigger=nightly`: compares with `evals/drafter/baseline.json` at the checked-out commit, writes `$NETZAR_EVAL_OUT/nightly/<date>.json`, prints `summarizeNightly(result, baseline, history)` (pure, in `src/lib/workflows/eval/nightly.ts`), and exits 0/2/3.
- `npm ci` in the clean clone uses the lockfile only (Q78).

#### Per-drafter-change procedure (gauntlet)
1. Builder pushes a branch. The CI job `drafter-eval-gate` (or the same command run locally first) fails with `eval result does not match drafter hash`.
2. On the VPS: `NETZAR_EVAL_Q65_ACCEPTED=1 npm run eval:drafter -- --trigger=drafter_change`. The runner refuses to write unless the working tree is clean apart from `evals/drafter/results/current.json` and `evals/drafter/baseline.json`, so the hashes describe a committed state.
3. The runner writes `current.json` and updates `baseline.json[provider]` to it **only if** `passed >= baseline.passed` and security did not drop. Otherwise it writes `current.json` only, prints the Scenario 2 line and exits 3. The PR then stays red.
4. Commit both files on the PR branch. The fresh critic checks the gate log.

* **Files to change:**

| path | change |
|---|---|
| `scripts/ci/drafter-eval-gate.ts` (from US-014) | add steps 2–5 above and the `--require-production-score` flag |
| `scripts/eval/drafter-live.ts` (from US-014) | `--trigger=nightly` (write outside repo, exit 3/2), baseline promotion for `drafter_change`/`rebaseline`, clean-tree check, lock file |
| `src/lib/workflows/eval/result-schema.ts` (from US-014) | add `DrafterBaselineSchema` |
| `.github/workflows/ci.yml` job `drafter-eval-gate` (from US-014) | export `GITHUB_BASE_REF` use is automatic; confirm `fetch-depth: 0`; no secrets |
| `evals/drafter/README.md` (from US-014) | sections "Per drafter change", "Nightly", "Re-baseline", "Production reach" |

* **New files:** `evals/drafter/baseline.json` (first value = US-014's committed result); `src/lib/workflows/eval/nightly.ts` (`summarizeNightly`) + `nightly.test.ts`.
* **API contract:** N/A: no API change.
* **Data changes:** repo file `evals/drafter/baseline.json`; VPS-only files `~/.netzar-eval/nightly/*.json` and `~/.netzar-eval/run.lock`. No DynamoDB or S3 change. Rollback = git revert; delete the Hermes cron job.
* **Security notes:**
  - SECURITY.md §2b **T7** T: a poisoned case or recorded reply could raise the score. Hash checks (US-014) plus "the base branch's baseline is the reference" (Scenario 4) mean a PR cannot lower the bar by editing `baseline.json`.
  - §4 item 8: security cases ratchet on their own (Scenario 3).
  - No model key in GitHub (Q89). The Hermes job holds `NETZAR_EVAL_Q65_ACCEPTED=1` and the NVIDIA key on the VPS only. The Telegram message holds counts and a short SHA only, no case text.
  - Branch protection: make `drafter-eval-gate` a required status check on `development`. That is an owner-only GitHub setting (Q91 pattern). Until it is set, the owner's merge yes (Q50) is the control.
* **Test plan:**
  - Frozen failing tests first: `scripts/ci/drafter-eval-gate.test.ts` cases for Scenarios 1–5 and 8 (temp git repo built in the test with two commits: base baseline, then PR files; `GITHUB_BASE_REF` set in the test env); `src/lib/workflows/eval/nightly.test.ts` (Scenarios 6–7); `src/lib/workflows/eval/runner.test.ts` › "nightly mode writes only under NETZAR_EVAL_OUT and never into the repo" and › "drafter_change promotes the baseline only when not lower".
  - Fixtures: synthetic result JSONs, no model call. The runner tests inject a fake `runDrafterStep`.
  - Commands: `npx vitest run scripts/ci/drafter-eval-gate.test.ts src/lib/workflows/eval`, `npx tsx scripts/ci/drafter-eval-gate.ts`, full `npm test`. Evidence on the VPS: one manual `--trigger=nightly` run with a forced low baseline in a scratch clone, showing the Telegram message.
* **Repo rules that apply:** no new dependency. `.github/workflows/ci.yml` change: owner yes on the merge (Q50). No `handler.ts` or `agent-loop.ts` change, so no diagram update. Feature docs: `evals/drafter/README.md` is not under `docs/features/`, so feature-doc frontmatter rules do not apply. Record the procedure in the feature HANDOFF.
* **Rollback:** remove the job's required-check status (owner), revert the gate changes, delete the Hermes cron job. `baseline.json` can stay; nothing reads it at runtime.
* **Build slices (proposal):**
  1. **Ratchet in CI** (1–2 h): baseline schema, gate steps 2–5, tests with a temp git repo. Green: Scenarios 1–5.
  2. **Runner promotion + nightly summary** (1–2 h): `--trigger` handling, clean-tree check, lock, `nightly.ts`. Green: Scenarios 6–7 (unit), runner tests.
  3. **VPS wiring + production flag** (1 h): Hermes cron job, `--require-production-score`, README, a manual nightly run as evidence. Green: Scenario 8; Telegram screenshot in the handoff.
* **Agent gotchas:**
  - On `push` events `GITHUB_BASE_REF` is empty. Use `HEAD^1`, and with `fetch-depth: 0` that parent exists. A merge commit's first parent is the old `development`, which is what you want.
  - Compare against the base branch's `baseline.json`, never the PR's own. Otherwise a PR can lower the bar and pass.
  - Count-based comparison only: `0.8 >= 0.8000000001` style float bugs flip the gate.
  - One `current.json` holds one provider. During the NVIDIA→Bedrock overlap, the Bedrock run is a `rebaseline` that replaces `current.json`, while `baseline.json` keeps the old `nvidia-dev` entry for history. The gate checks only the entry for `current.provider`.
  - The nightly checkout is detached and may hold a `current.json` produced by a different provider; nightly compares against `baseline.json[provider in use]`.
  - Hermes cron runs as root on the VPS. The clean clone must still have no `.env` with production secrets (NZR-3).
  - Don't let the nightly commit or push. Q50 requires the owner's yes for every push.

---

## 5. Estimation & Tracking
* **Epic Name:** M2a Core slice (cycle C2a Core vertical slice (plain Workflows tab), 2026-11-10 to 2026-11-23)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** eval, gate

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases (better/equal, worse, security drop, tampered baseline, re-baseline, nightly drift, nightly abort, production reach).
- [ ] UX/UI designs: N/A: CI gate (exact CI and Telegram copy in section 3).
- [ ] Dependencies have been identified and are unblocked (NZR-14 merged with a committed live `current.json`; NZR-23 merged; NZR-3 clean clone on the VPS; Hermes cron able to deliver to the owner's Telegram).
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Fresh Claude critic + free checks (npm audit, secret scan on the diff, lint) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD (`npx tsx scripts/ci/drafter-eval-gate.ts` exits 0); full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria, including a mutation that lowers `current.json` by one case (must fail with both scores). UAT: N/A, no user-facing change; the owner accepts the evidence summary (CI log of a pass and a fail, one nightly Telegram message from a forced-low run).
- [ ] Documentation is updated: `evals/drafter/README.md`, feature HANDOFF + a dated session handoff; durable facts promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50), the Hermes nightly job created and observed once, and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
