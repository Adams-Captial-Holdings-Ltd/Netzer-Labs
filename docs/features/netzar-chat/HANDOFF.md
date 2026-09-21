---
feature: netzar-chat
document_role: handoff
status: current
observed_at: 2026-09-21
as_of_commit: e8a0d8cb0ccd93f314ab057182b483f756edeca6
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
- Current work lives on `feat/f1-test-foundations`, cut from
  `origin/development` at `08f85db`; merge target `development`. HEAD
  `e8a0d8cb0ccd93f314ab057182b483f756edeca6`. Pushed: **no**. **PR: none.**
  Deployment: none. This frontmatter now stamps that commit rather than
  `eee0a83`, because the earlier reason for holding the stamp back has expired:
  F1 is the first work item since then to change source and configuration
  files — `tests/e2e/chat/`, `web/dev/mock-stream-plugin.ts`, `package.json`,
  the lockfile and `.github/workflows/ci.yml` — so the source these claims
  describe is no longer byte-identical to `eee0a83` (P23). The containment
  statements above were re-derived against `origin/qa` `ac0cbcc`,
  `origin/staging` `8299f04` and `origin/production` `de244e6`, all three
  unmoved since they were last proved.
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
  start. That token is now on the **critical path**: under the accepted 9-step
  roadmap, nothing after F1 can be verified against real Bedrock without it.
  `bar/staging/VERIFY.json` still records 1 pass (HTTP 200) and 4 sign-in
  failures, "no STAGING_TOKEN … cannot verify authed surfaces".
- **The F1 gate's LOCAL tier is GREEN:** `f1-proof.sh` reads `FAILS=0`, exit 0,
  with all 11 rows PASS and the negative control still reading `FAIL`, at
  `e8a0d8c` — and at `2e06d4b` before CLEANUP. It read `FAILS=10` at `e7dc543`
  before this work. The full step 7 list ran on `2e06d4b` and matched the
  baseline above (18:40:16Z-18:40:53Z), because `package.json` and `ci.yml` are
  configuration files; CLEANUP touched **neither**, so P36 did not fire again
  and the list was not re-run. The gate is proved capable of failing: reverting
  the mock's transcript route to its old hard-coded empty array makes the suite
  fail at the post-reload assertion, checked now at **three** separate commits,
  most recently at `e8a0d8c` where it fails at `chat.spec.ts:93`. The **staging
  tier is untouched** and reads `FAILS=4`; it is blocked on decision 6's token.
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
- Smallest next action: a fresh **VERIFICATION** at `e8a0d8c`, by a critic that
  did not build it. CLEANUP is complete: all five of its carried items are
  closed — A86 fixed as above; the dev mock's transcript map capped at 200
  conversations with a **loud** eviction (a silent one would return the empty
  transcript this route was changed to stop returning); the prompt assertions
  scoped to the message row's own `role="group"` + `aria-label` rather than the
  whole page, which the mutation control confirms did not weaken them; comments
  updated only where the code moved under them; nothing else. The
  authenticated staging half of F1 cannot start until owner decision 6's token
  exists. Promotion of `development` → `qa` → `staging` is owner decision 18, is
  still due, and needs its own authorization — the `qa` → `staging` merge runs a
  full `cdk deploy --all`.

Session index (newest first):
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
