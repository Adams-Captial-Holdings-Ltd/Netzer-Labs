# G1 review 3 — NZR-40 @ c31844ac2a9c18685c708be8737f38ec81cd8809

Diff: `origin/integration/netzar-studio...HEAD` excl. docs/features/netzar-studio. 4 files: route-guard.mjs, route-guard.test.ts, README.md, tests/e2e/nzr-40/run.mjs.

Ran: `npx vitest run scripts/factory/route-guard` → 11/11 pass (incl. selftest, lock race test). Not run: tsc, full `npm test`, e2e script.

## Verdict: PASS (no high/medium open)

## Re-check of previous findings
- [medium] order-dependent critic/builder separation — **FIXED**. `decide()` now refuses a builder whose session already has an allowed critic line on the step (route-guard.mjs:105-107, reason `builder_was_critic`); test "refuses a builder session that already criticised the step" covers A→B→builder B. Concurrent race covered by the lock-recovery test (route-guard.test.ts:129).
- [low] nvidia critic without consent → `no_nvidia_consent` + `L3 NOT RUN` instead of `critic_not_claude` — OPEN (route-guard.mjs:88-93 runs before :99). Refuses either way.
- [low] `decide({log, consent, ...flags})` lets `--log`/`--consent` overwrite parsed inputs — OPEN (route-guard.mjs:146). Fails closed today (string log → TypeError → exit 5; string consent → no nvidia).
- [low] `--slug` unsanitized in default log path (`../` escapes ~/.claude/plans) — OPEN (route-guard.mjs:20).
- [low] Doc edits (SKILL.md section + 2 amendments, review-gauntlet.md L3, hermes-adaptation.md) not applied and helper not installed in /root/.claude/bin — OPEN (grep finds no `route-guard` in skill dir; no file in /root/.claude/bin). Required before DoD.
- [info] Helper/test are repo vitest .ts, not /root/.claude/bin node:test .mjs — OPEN; update story test refs at exit gate.
- [info] Scenario 8 `JEV_SH` stub unused — OPEN; behaviour covered.
- [info] Jev records in routes.jsonl as `kind:'jev'` outside route-line schema — OPEN.
- [info] No validation of numeric `--confidence`, consent mode 600, owner_text ≤200 — OPEN.

## New
- [info] New reason `builder_was_critic` is not in the story's route-log `reason` enum; add it to the story contract at exit gate.
- [info] Stale recovery guard (>30s) is removed unguarded (route-guard.mjs:45); two processes clearing a crashed guard at once can reopen the double-delete race. Documented as a shortcut; only after a crash mid-recovery.

## Checks
- Security: no network, no key reads, log stores ids only; corrupt consent/log fail closed (exit 5, nothing appended). No secret leaks found.
- Callers: new standalone files; nothing in repo imports them.
- Scope: matches story; README + e2e script are small and fitting.
