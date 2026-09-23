---
feature: netzar-chat
document_role: handoff
status: current
observed_at: 2026-09-22
as_of_commit: 06dd6479cc940217a223ff388e1d3f3624215ff5
---

# Netzar Chat handoff

- **CURRENT: P1 is BUILT on `feature/p1-storage` — the four remaining work items
  of step 3 of 10 (conversation identity + durable transcript), in one session
  (owner decision 45).** Branch `feature/p1-storage`, cut from
  `origin/development` @ `0178980`, where WI-1.0 landed as PR #188; merge target
  `development`. **At this commit: pushed no, PR none, deployment none.** The
  landing will run the full `development.md` step 7 list on this exact commit,
  ask the owner once with the numbers, and only on a yes push, open one pull
  request into `development` and merge it when every check is green; the pull
  request number and the merge commit will live in the Gauntlet state file,
  because a file cannot state the commit it is inside (P40). Nothing is promoted
  (decision 18). The session made ONE AWS call: decision 40's read-only count, on
  production, with the owner present and approving the command (decision 46).
- **What P1 built** (detail: the session log below). **WI-1.1** — a person owns a
  conversation whichever token they sign in with; every dashboard and Jarvis
  conversation route enforces it; an admin's read of someone else's conversation
  is audited before anything is returned, and returns nothing if it cannot be;
  a slash command never leaves a conversation nobody owns; whether a
  conversation lasts is settled once, by whoever starts it — a person's lasts,
  anyone else's expires, and nothing changes that afterwards;
  `POST /api/tokens/:hashPrefix/link` links a token with no user to one person,
  once. **WI-1.2** — every message is its own record, written with the window in
  one transaction; a `#` in a chat id is stored as `_` (decision 47); the four
  conversation listings read to the end and report `truncated`. **WI-1.3** — the
  transcript returns the whole history, and a delete cascades. **WI-1.4** — the
  legacy migration, as code and local Floci tests only.
- **P1's gate** (`~/.claude/plans/netzar-chat-plan/p1-proof.sh`), at the
  frontmatter's commit: `P1_TIER=storage` **`FAILS=0`, `ASSESSED=12`** — S-a..S-h
  frozen in the P1 specification log 4.2, S-i..S-l (WI-1.4) frozen in this
  session before WI-1.4 was built; `P1_TIER=containment` **`FAILS=0`,
  `ASSESSED=6`**; CONTROL reads `FAIL` in both.
- **Three fresh critics.** The first FAILED an earlier head on owner decisions 1
  and 9 although every gate was green: Jarvis still listed everyone's
  conversations, a slash command typed first into a new chat locked its author
  out, the master token's old chats could drop out of the migration, the admin
  override's audit did not wait, and the docs overclaimed. The second confirmed
  all five fixed and FAILED the next head on one more: a scheduled task could make
  a person-less chat permanent (decisions 1 and 46). Each was fixed test-first
  (session log, section 6.6); the third critic's verdict, on the commit that
  carries this file, lives in the Gauntlet state file (P40).
- **The owner's decisions this session.** 46: decision 40's count found 9
  dashboard conversations in production — 4 provable through a member login and
  5 made with the master token, all from the last month, none with `#` — so the
  master token is linked to the owner, whatever is still unprovable is deleted
  by the migration, and there is no claim path. 47: a `#` in a chat id is stored
  as `_`.
- **Next, at S1 only** (the staging/production promotion, never local work):
  link the master token (`POST /api/tokens/<hashPrefix>/link` with the owner's
  userId), run `scripts/p1-migrate-legacy-chats.ts` as a dry run and read its
  counts, then run it with `--apply --tables=<sessions>,<dashboard-tokens>` —
  straight after the deploy and before anyone chats: a pre-P1 turn that leaves
  the 20-turn window before the migration has no record anywhere.
- **Baseline recorded before any change on this branch**, at `0178980` with
  fake credentials planted, alone in the checkout, the emulator named first as
  `floci/floci:1.6.0`: `npm test` 248 files / 3221 tests all passing,
  `guard-violations: 0`; integration 38 passed / 25 skipped / 1 failed, the Floci
  `checkSecrets` gap by name; every other gate exit 0; storage `FAILS=8`,
  containment `FAILS=0`.
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
- The staging-tier work **has landed**; `feat/f1-staging-tier` is deleted on
  `origin` and locally, so no branch carries it any more. Its commit **count** is deliberately
  not written here: every commit this file is part of changes that number, so a
  count stated in it is stale the moment it is committed — the same reason P40
  keeps a merge SHA out of the file it describes. Re-derive it with
  `git rev-list --count origin/development..HEAD`. See **M64**.
  Layer A's last session before it landed was its **VERIFICATION**; the CLEANUP
  before it named two literals, and the IMPLEMENTATION before that added
  `tests/e2e/staging/`. None of the three made a **staging call, an AWS API call,
  a deploy or a promotion**, and none read the token. Deployment: none. Those
  three sessions checked their claims at **`3fc3de4`** (P23); the frontmatter
  stamp has since moved with P1's work.
  The containment statements above were
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
- **Superseded 2026-09-22, kept for context** — owner decision 43 says the
  staging token exists and staging testing is authorized, and Layer B has since
  run (below). Original text: Blockers: CHATUI-008 is blocked on **owner decision 6** — a dedicated
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
  `git diff --check` were re-run at **every commit this work made, including the
  true final one** — deliberately not named here, because naming a HEAD in a file
  that then receives more commits is the same self-invalidation **M64** records
  and **M65** generalises. Derive it with `git rev-parse HEAD`.
- **VERIFICATION PASSED (2026-09-22) → F1's Layer A is VERIFIED.** By a fresh
  read-only critic that built none of it, at the true final HEAD: **12 of 12
  criteria PASS**, nothing routed back. Everything was re-derived rather than
  carried — scope (3 paths, 0 production src, only the code commit touches the
  source), the arithmetic computed not read, all three gate tiers with CONTROL
  failing in each, the gate's own `H-1..H-6` predicates re-read to confirm the
  extraction could not have broken a row, the five docs gates, the ledger carry
  by `diff` (2 hunks, 31 additions, **0** deletions), and containment against all
  four tips. **The critic did two things beyond the brief that matter.** First, it
  caught that the mutation test the brief prescribed was *dead on arrival*: after
  an Extract-Constant refactor, changing the constant's value moves every reader
  in lockstep, so it cannot discriminate — a lazier critic would have reported "no
  change" and called the constant dead code. It built the correct probe instead,
  a **decoupling** mutation, and got the expected regression: `recIfUnreached()`
  stops firing and **11 of 12 checks lose their real failure reason**. Second, it
  returned six findings the brief never asked for, four of them accuracy defects
  in the cleanup session's own log; all four are corrected and recorded in that
  log's section 8 rather than quietly edited.
- **F1's STAGING tier, LAYER A, is MERGED into `development`** (2026-09-22). The
  first push attempt was refused by the execution environment's own permission
  layer — not by any rule in this repository — and was **not** routed around,
  because using different tooling for the same push bypasses the intent of a
  denial rather than finding a safer route. The owner was asked what was needed,
  answered **"go ahead and push"** in the same session, and that direct
  authorization is what this landing rests on (**constraint 8**). All **10** CI
  checks green; the commit CI tested confirmed equal to the commit on origin and
  to the commit validated locally before the merge; head branch deleted on origin
  and locally. The merged tree is the **same object** as the validated commit's
  tree, so the merge introduced nothing. The pull request number and merge commit
  live in the Gauntlet state file (**P40**). Full detail in section 9 of the
  landing log. Earlier authorization reasoning was decided in writing
  **before** the first push, because both overnight windows had expired and an
  expired window is never standing permission: the `/goal` directive driving this
  loop states the objective as *"every roadmap step that can land unattended is
  merged into `development`"*, restricts pull requests to `development` only, and
  demands *"the FULL development.md step 7 list on the exact HEAD pushed"* —
  meaningless unless pushing is expected. That reading covers landing into
  `development` **and nothing more**; promotion, `qa`/`staging`/`production`,
  force-push and deploy stay forbidden and are not implied. The reasoning is
  quoted in full in section 2.1 of the landing log (**P76**). The full step 7 list
  ran **three times**, alone in the checkout — at `8fbe1db`, at `7f857e4`, and
  finally on `a5e3ee0`, **the commit actually pushed** (**P77/P51**) — and matched
  the baseline every time. The third run mattered: the **M67** correction commit
  had moved the tip after the second, and pushing on the strength of a run against
  the older commit is exactly the stale-HEAD claim **M65** records.
- **LAYER B RAN FOR THE FIRST TIME (2026-09-22), by the owner, with their own
  token — and it was worth it.** 10 of 12 passed. **Proved for the first time:**
  sign-in works on staging on all four surfaces, and the bearer roll-call returns
  `3 active agents, 5 models from real Bedrock (HTTP 200/200)` — so **D1 is now
  behaviourally proven**, having only ever been closed against re-derived source.
  **The two turn checks read `not reached`** — the seeded sentinel, meaning never
  attempted. The cause was navigation, not the token: `App.tsx` redirects to
  `/getting-started` when neither onboarding key is in `localStorage`, and every
  automated run is a fresh profile by design, so **every deep link into the
  dashboard lands on the onboarding checklist**. The run's own landing screenshot
  shows the breadcrumb. **It cost nothing** — the message is sent inside the
  skipped block, so no model turn ever ran. Three defects fixed: the harness now
  seeds the onboarding key before any page script; the composer-missing branch
  records both checks failed **with the URL it was actually on**; and the gate,
  outside the repo, now reads the file the harness writes instead of a September
  snapshot of an **August** run — under which a perfect run would still have
  scored `FAILS=4`. Verified against the local dashboard: all 12 checks carry a
  real verdict, **zero** left `not reached`, conversation screenshots on all four
  surfaces, and the two turn checks failing for the correct local reason, which
  is a free negative control. Full detail in the Layer B session log.
- **Last required checks, at the frontmatter's commit**, run by the fresh critic
  with fake credentials planted and — **for the first time in P1 — alone in the
  checkout**: the owner cleared the two orphaned `tsx watch` trees after CLEANUP,
  and that was re-checked rather than assumed (no process names the checkout, none
  has its working directory in it, nothing listens on port 3000). The full
  `development.md` step 7 list carries **no failure but the known Floci gap** —
  `npm test` **248 files / 3221 tests, all passing**, `guard-violations: 0`;
  integration 38 passed / 25 skipped / 1 failed, the Floci `checkSecrets …
  schedule-deleted` gap **by name** on an emulator identified as
  `floci/floci:1.6.0` first; typecheck, build, both web gates, `local:verify`,
  `docs-links`, `feature-knowledge`, `docs-assets` and the PR-context drift gate
  exit 0; `git diff --check` 0; 0 changed paths. **The baseline was re-measured,
  not quoted:** at `3393f6c`, `npm test` is 247 files / 3215 tests, and the two
  commits' collected-file lists differ by exactly one file, the containment test
  — so +1 file and +6 tests is measured, not arithmetic. Both P1 tiers:
  containment `FAILS=0`, `ASSESSED=6`; storage `FAILS=8`; CONTROL `FAIL` in both.
  The landing runs the same list again on the commit it pushes; that result
  lives in the Gauntlet state file (P40).
- **Smallest next action: the landing's gates on this commit, then the owner's
  yes or no — push, open the pull request into `development`, and merge it when
  every check is green.** After WI-1.0 lands, the next work item is **WI-1.1's
  specification**: ownership binds to an immutable user, and the send route
  enforces it. The carried review findings — filtering after a bounded read can
  under-report, and nothing signals a dropped row — plus the verification's
  untested `PK` half are **not** landing blockers; all three belong to WI-1.2's
  specification, because WI-1.2's per-message rows are what make them
  consequential. A push, a PR and any promotion each need their own
  authorization in the conversation that performs them.
- **Awaiting the owner:** the landing's yes or no, asked after its gates run; whether a `#`-bearing
  chatId should be fixed at the write path, by relaxing the predicate, or by
  giving WI-1.2 an unambiguous key shape (the recommendation, because it is the
  only one still correct after P3 adds attachments) — the silent drop is now
  proved by running it through the real route, not only by reading the
  predicate; decision 8's unmapped-row retention date (WI-1.4 cannot be specified
  without it); whether the ownership-takeover finding should be closed sooner
  than WI-1.1, which would mean reopening decision 9's "no hotfix"; and whether
  owner-scoped listing must be fast, since the sessions table has **no GSI** and
  decision 11 forbids adding one, so "show me only my conversations" stays a
  scan-and-filter.
- F1 status, unchanged by this phase: **Layer B has run and sits at 11 of 12**,
  with the twelfth a real product gap — the deployed dashboard does not stream
  replies to the browser — routed to **P2** and deliberately not fixed here.
- Superseded next action, kept for context: **a second authorized staging run.** It is
  the first that will actually spend, because the turn will now be sent. It tests
  what the first could not: **D2** (a prompt that really dispatches a tool) and
  **D3** (the subscribed tool observer), both still source-derived only, plus real
  streaming against real Bedrock. **Layer B is what actually finishes F1** — one
  authorized run against real staging — and it still needs decision 6/33's token
  *and* its own fresh authorization in the conversation that performs it.
  Nothing is pushed; a push, a PR and any promotion each need their own
  authorization. Do **not** add a CI job for the staging suite: it costs real
  money and must never run on every pull request. Promotion of `development` →
  `qa` → `staging` is owner decision 18, is still due, and the `qa` → `staging`
  merge runs a full `cdk deploy --all`.

Session index (newest first):
- [2026-09-22-p1-one-shot.md](handoffs/2026-09-22-p1-one-shot.md)
- [2026-09-22-p1-wi-1.0-landing.md](handoffs/2026-09-22-p1-wi-1.0-landing.md)
- [2026-09-22-p1-wi-1.0-verification.md](handoffs/2026-09-22-p1-wi-1.0-verification.md)
- [2026-09-22-p1-wi-1.0-cleanup.md](handoffs/2026-09-22-p1-wi-1.0-cleanup.md)
- [2026-09-22-p1-wi-1.0-implementation.md](handoffs/2026-09-22-p1-wi-1.0-implementation.md)
- [2026-09-22-p1-specification.md](handoffs/2026-09-22-p1-specification.md)
- [2026-09-22-f1-layer-b-first-run.md](handoffs/2026-09-22-f1-layer-b-first-run.md)
- [2026-09-22-f1-staging-landing.md](handoffs/2026-09-22-f1-staging-landing.md)
- [2026-09-22-f1-staging-verification.md](handoffs/2026-09-22-f1-staging-verification.md)
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
