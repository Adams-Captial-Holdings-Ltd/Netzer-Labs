---
feature: netzar-chat
document_role: handoff
status: current
observed_at: 2026-09-22
as_of_commit: 3fc3de45b5d1a700e11e7bad21f238ed36782567
---

# Netzar Chat handoff

- Branch state: the work was merged into `development` by PR #129 (merge
  `b3b427497d63d8f4d1faa147b46c9681c19bc460`, 2026-08-27). It is present on
  `origin/qa` and `origin/staging`, and is not present on `origin/production`.
  Per the branch-to-environment mapping, staging is the only AWS environment
  reached; production remains untouched.
- Phases: CHATUI-000 through CHATUI-006 are built and blind-critic accepted.
  CHATUI-007 is superseded; CHATUI-008 owns the remaining authenticated staging
  verification and full-journey blind critic.
- The documentation refresh merged as **PR `#182`** into `development`
  (`08f85db9d264c925ea22272b1386fbaed266b852`, 2026-09-21); its head branch
  `docs/wi-0.4-chat-docs` was deleted on `origin` and locally. That closed the
  last P0 work item, and a fresh whole-goal critic then passed the six-line P0
  exit gate at that commit.
- **F1's LOCAL tier is MERGED.** It landed as PR **`#183`** into `development`;
  the head branch `feat/f1-test-foundations` is deleted on `origin` and locally.
  A file cannot state the commit it is inside (P40), so the merge SHA lives in
  the Gauntlet state file. That landing finished F1's **local** half only.
- Current work lives on **`feat/f1-staging-tier`**, cut from
  `origin/development` at `f7eb6f4`; merge target `development`. It carries
  F1's **STAGING** tier and is **unpushed**, now **5** commits off
  `origin/development`. The latest session is the **CLEANUP** of **Layer A**;
  the IMPLEMENTATION before it added `tests/e2e/staging/`. Neither made a
  **staging call, an AWS API call, a deploy or a promotion**, and neither read
  the token. Deployment: none. The frontmatter stamp **moves to `3fc3de4`**,
  because cleanup edited a test source file, so the source these claims describe
  is no longer byte-identical to the old stamp (P23). The containment statements above were
  re-derived against `origin/qa` `ac0cbcc`, `origin/staging` `8299f04` and
  `origin/production` `de244e6`, all three unmoved since last proved.
- Baseline recorded before any change on this branch, on 2026-09-21 at
  `08f85db`, alone in the checkout and with credentials stripped: the full
  `development.md` step 7 list **matches the baseline** — `npm test` 247 files /
  3215 tests exit 0, `guard-violations: 0`; `npm run local:test:integration` 38
  passed, 25 skipped, 1 failed, the known Floci `ListSecrets` gap
  (`destroy.integration.test.ts > checkSecrets … schedule-deleted`), confirmed by
  name and documented under *Known local limitations* item 9; all 11 other gates
  exit 0; 0 changed paths left behind. The emulator answering on `4566` was
  identified as `netzer-os-floci` / `floci/floci:1.6.0` **before** that
  integration result was read — a stray LocalStack there turns the one expected
  failure into a pass.
- Blockers: CHATUI-008 is blocked on **owner decision 6** — a dedicated
  spend-capped staging token and agent, authorized per run — before the
  authenticated staging QA and the dependent full-journey blind critic can
  start. That token is now on the **critical path**: under the accepted
  roadmap, nothing after F1 can be verified against real Bedrock without it.
  `bar/staging/VERIFY.json` still records 1 pass (HTTP 200) and 4 sign-in
  failures, "no STAGING_TOKEN … cannot verify authed surfaces".
- **The token alone is NOT sufficient, established 2026-09-21.** The archived
  harness cannot make three of the five observations the staging tier scores,
  for reasons a credential does not fix: its in-page `/api/*` fetch uses
  `credentials: 'include'` while the dashboard authenticates only with
  `Authorization: Bearer` and has no cookie auth at all (`web/src/lib/api.ts:88`),
  so the roll-call check always 401s; its prompt ("List three things you can
  help with") dispatches no tool, which its own recorded detail admits, so
  `live tool status` can never pass and `S-c` "zero failing checks" is
  unreachable with it; and the live tool line is cleared the moment the first
  chunk lands (`StreamingRow.tsx:56-57`) while the harness samples every 500 ms.
  An authorized run today would move the tier from `FAILS=4` to **2**, not 0,
  after spending real Bedrock money. The harness is **fixable, not dead**: its
  three product contact points were verified to exist at `origin/staging`
  `8299f04`.
- **The F1 gate's LOCAL tier is GREEN:** `f1-proof.sh` reads `FAILS=0`, exit 0,
  with all 11 rows PASS and the negative control still reading `FAIL`, at
  `e8a0d8c` — and at `2e06d4b` before CLEANUP. It read `FAILS=10` at `e7dc543`
  before this work. The full step 7 list ran on `2e06d4b` and matched the
  baseline above (18:40:16Z-18:40:53Z), because `package.json` and `ci.yml` are
  configuration files; CLEANUP touched **neither**, so P36 did not fire again
  and the list was not re-run. The gate is proved capable of failing: reverting
  the mock's transcript route to its old hard-coded empty array makes the suite
  fail at the post-reload assertion, checked now at **three** separate commits,
  most recently at `e8a0d8c` where it fails at `chat.spec.ts:93`.
- **The gate has THREE tiers, and Layer A is now GREEN** (2026-09-21).
  Re-derived at `9923d9f`: `F1_TIER=local` **`FAILS=0`, exit 0, `ASSESSED=11`**
  — the landed tier is unaffected by the new files; `F1_TIER=staging-harness`
  **`FAILS=0`, exit 0, `ASSESSED=6`, 6/6 PASS** (it read `FAILS=6` at
  `b855b6c`); `F1_TIER=staging` **`FAILS=4`, unchanged** — Layer B is untouched
  and still needs decision 6/33's token plus its own per-run authorization.
  **CONTROL reads `FAIL` in all three.** Layer A is **all shape rows** and
  cannot be otherwise, so `FAILS=0` there means **"capable on paper", never
  "works"**. The one behavioural claim this work makes is narrow: the
  seeded-required-checks fix was executed against a dead local port and recorded
  all 12 checks with none left `not reached`.
- **A86 is RESOLVED (`e8a0d8c`).** The spec used to call `page.reload()` as soon
  as the reply became visible, several chunks before the stream ended, so the
  mock recorded a fraction of the reply — 107 characters on the owner's run, 71
  on CLEANUP's, out of **991** (A86's "1007" counted the source literal, whose
  16 escape sequences are two characters each; M56). It now waits for the
  product's own end-of-turn signal, the Send button returning from "Stop
  generating" to "Send message", so the whole reply is stored and replayed, and
  a new assertion on a phrase from the **last 33 characters** of the fixture
  would catch the race returning. The `stream cut mid-turn` warning no longer
  prints on a green run. The mutation control was re-run after the change and
  still fails.
- **VERIFICATION PASSED at `a7bdb13` (2026-09-21), by a fresh critic that did
  not build it → F1's LOCAL tier is VERIFIED.** Everything was re-derived, not
  carried: the proof (`FAILS=0`, exit 0, 11/11, CONTROL FAIL, at three
  commits); the **mutation control re-run**, failing at `chat.spec.ts:93` — the
  very assertion CLEANUP tightened — then restored to a clean tree; the suite
  run **directly** four times, every run exit 0 with **zero** `[chat-mock]`
  lines, which is also the first evidence it is not flaky; the fixture's
  positional claims re-measured from a running process (991 characters, the
  two phrases at indices **28** and **958**, each occurring exactly once);
  scope; the ledger carry by `diff` (39 additions, 0 deletions, 0
  modifications); and the five docs gates, all exit 0 at that exact commit.
  **P36 was measured, not assumed** — 0 matches for `package.json`,
  `package-lock.json` and `ci.yml` — so the full step 7 list was not required
  and is **not** claimed. Two things were established beyond the brief: putting
  the **pre-fix spec back** reproduces the race exactly (green run, `stream cut
  mid-turn … (71 chars)`), which shows the fix is behavioural rather than
  cosmetic; and with that broken spec in place the proof still reads `FAILS=0`
  and never mentions the warning, which proves **P61** by measurement.
- **LANDING gates, run in this session on the exact HEAD `a88086e` before
  anything was pushed**, alone in the checkout and with credentials stripped:
  the full step 7 list **matches the baseline** in 38 s — `npm test` 247 files /
  3215 tests exit 0, `guard-violations: 0`; integration 38 passed, 25 skipped, 1
  failed, the Floci `checkSecrets` gap confirmed **by name** on an emulator
  identified as `floci/floci:1.6.0` first; all 11 other gates exit 0; 0 changed
  paths. `f1-proof.sh` local tier reads `FAILS=0`, exit 0, 11/11 PASS, CONTROL
  still `FAIL`. The five docs gates exit 0 (`docs-links` 207 files / 3337
  links). Because the push is the trigger, step 7 runs **again** on the HEAD
  this log commit creates (P51); that second result lives in the state file.
- **The review fan-out found two defects no gate row could see** (2026-09-21),
  both inherited verbatim from the archived harness and both passing all six
  shape rows. The sign-in verdict tested `page.url()` for `/login`, but this SPA
  has **no `/login` route** — `AuthGate` renders `<Login/>` in place and a
  rejected token only sets local error state — so it reported a successful
  sign-in for **any** token, valid or not. And the streaming-cadence check
  measured the whole transcript container, which also holds `LiveFooter`'s
  wall-clock elapsed-seconds counter, so a single-shot reply could have scored
  as genuine streaming. Both fixed in `9923d9f`; the three reports live outside
  the repository in the Gauntlet review directory.
- **CLEANUP is COMPLETE (`3fc3de4`, 2026-09-22) and it changed no behaviour.**
  Two named-constant extractions in `tests/e2e/staging/run.mjs` and nothing
  else: the `'not reached'` sentinel, which `recIfUnreached()` compares against
  and `results` seeds, now has one home as `NOT_REACHED`; and the cadence
  sampler's 60-second window, which existed only as the product of `120` and
  `500 ms` and is this file's whole cost profile on a paid run, is now
  `WINDOW_MS / SAMPLE_MS` — the arithmetic asserted, not eyeballed. All three
  tiers re-run at that commit are **string-identical to the pre-edit run**:
  `staging-harness` `FAILS=0` 6/6, `local` `FAILS=0` 11/11, `staging` `FAILS=4`,
  CONTROL `FAIL` in all three. The gate's own `H-1..H-6` predicates were read
  **before** the first edit to confirm none asserts on the literals being moved
  (P73). Six of the seven findings the implementation phase carried are
  deliberately **still unpatched**: each changes what the harness reports or
  what it checks, which is a behaviour change and not cleanup's to make.
  **P36 does not fire** — the only source file changed is under `tests/e2e/`,
  which no gate in the step 7 list reads (A110, re-measured) — so the full list
  ran once as the baseline at `4638004` and matched; the five docs gates and
  `git diff --check` were re-run at the exact final HEAD.
- Smallest next action: **VERIFICATION of F1's staging tier, Layer A**, by a
  fresh critic that built none of it. **Layer B is what actually finishes F1** — one
  authorized run against real staging — and it still needs decision 6/33's token
  *and* its own fresh authorization in the conversation that performs it.
  Nothing is pushed; a push, a PR and any promotion each need their own
  authorization. Do **not** add a CI job for the staging suite: it costs real
  money and must never run on every pull request. Promotion of `development` →
  `qa` → `staging` is owner decision 18, is still due, and the `qa` → `staging`
  merge runs a full `cdk deploy --all`.

Session index (newest first):
- [2026-09-22-f1-staging-cleanup.md](handoffs/2026-09-22-f1-staging-cleanup.md)
- [2026-09-21-f1-staging-implementation.md](handoffs/2026-09-21-f1-staging-implementation.md)
- [2026-09-21-f1-staging-specification.md](handoffs/2026-09-21-f1-staging-specification.md)
- [2026-09-21-f1-landing.md](handoffs/2026-09-21-f1-landing.md)
- [2026-09-21-f1-verification.md](handoffs/2026-09-21-f1-verification.md)
- [2026-09-21-f1-cleanup.md](handoffs/2026-09-21-f1-cleanup.md)
- [2026-09-21-f1-implementation.md](handoffs/2026-09-21-f1-implementation.md)
- [2026-09-21-f1-specification.md](handoffs/2026-09-21-f1-specification.md)
- [2026-09-21-final-p0-verification.md](handoffs/2026-09-21-final-p0-verification.md)
- [2026-09-21-wi-0.4-landing.md](handoffs/2026-09-21-wi-0.4-landing.md)
- [2026-09-20-wi-0.4-verification.md](handoffs/2026-09-20-wi-0.4-verification.md)
- [2026-09-20-wi-0.4-cleanup.md](handoffs/2026-09-20-wi-0.4-cleanup.md)
- [2026-09-20-wi-0.4-implementation.md](handoffs/2026-09-20-wi-0.4-implementation.md)
- [2026-09-20-wi-0.4-specification.md](handoffs/2026-09-20-wi-0.4-specification.md)
- [2026-08-27-phases-1-6-and-harvest.md](handoffs/2026-08-27-phases-1-6-and-harvest.md)
- [2026-08-25-phase-0-extraction.md](handoffs/2026-08-25-phase-0-extraction.md)
- [2026-08-25-phase-0-scaffolding.md](handoffs/2026-08-25-phase-0-scaffolding.md)

Authorities: [README](README.md), [approved plan / phase backlog](plan.md).
