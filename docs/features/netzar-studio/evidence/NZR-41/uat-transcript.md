# NZR-41 UAT transcript

Story is a CLI (non-UI, no HTTP surface): the app on :3900 exposes no endpoint for it, so each "request" below is a real CLI invocation of the repo copies (`scripts/factory/review-plan/review-plan.mjs`, `scripts/factory/review-ledger/review-ledger.mjs`) against temp fixtures in `$TMP`. No token used. Run 2026-10-25T23:35:26.355Z. Driver: `/root/.hermes/netzar-runner/runs/NZR-41/uat-driver.mjs`.

Corroborating named tests (same HEAD): `npx vitest run scripts/factory/review-plan` → 14/14 passed, incl. the story's named tests for Scenarios 1-7; `node scripts/factory/review-ledger/review-ledger.mjs selftest` → `review-ledger selftest: ok` (incl. "a second reserve for one step needs --reason"). Note: the story names `/root/.claude/bin/review-plan.test.mjs`; the repo ships it as `scripts/factory/review-plan/review-plan.test.ts` (vitest) and the install copy to `/root/.claude/bin` is a coordinator step, not checked here.

## Scenario 1: T2 picks critic + free checks + step maid, not Greptile

```
$ node scripts/factory/review-plan/review-plan.mjs plan --tier T2
exit 0
stdout: {"tier":"T2","required":["L0","critic","step-maid"],"forbidden":["L1","L2","L3","L6"]}
stderr: 
```
- OK: plan T2 JSON (want exit 0 + `{"tier":"T2","required":["L0","critic","step-maid"],"forbidden":["L1","L2","L3","L6"]}`, got exit 0)

Log `t2-greptile.log`:
```
REVIEW: L0 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: critic ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: step-maid ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L6 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

```
$ node scripts/factory/review-plan/review-plan.mjs verify --tier T2 --log $TMP/t2-greptile.log
exit 1
stdout: FORBIDDEN LAYER RAN: L6 greptile
stderr: 
```
- OK: verify T2 with L6 (want exit 1 + `FORBIDDEN LAYER RAN: L6 greptile`, got exit 1)

Log `t2-ok.log`:
```
REVIEW: L0 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: critic ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: step-maid ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

```
$ node scripts/factory/review-plan/review-plan.mjs verify --tier T2 --log $TMP/t2-ok.log
exit 0
stdout: TIER OK T2
stderr: 
```
- OK: verify T2 clean (want exit 0 + `TIER OK T2`, got exit 0)

## Scenario 2: T1 and docs get free checks only

Log `l0-only.log`:
```
REVIEW: L0 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

Log `no-l0.log`:
```
step log without review lines
```

```
$ node scripts/factory/review-plan/review-plan.mjs plan --tier T1
exit 0
stdout: {"tier":"T1","required":["L0"],"forbidden":["L1","L2","L3","L6"]}
stderr: 
```
- OK: plan T1 required ["L0"], forbidden has L1,L2,L3,L6

```
$ node scripts/factory/review-plan/review-plan.mjs verify --tier T1 --log $TMP/l0-only.log
exit 0
stdout: TIER OK T1
stderr: 
```
- OK: verify T1 L0 only (want exit 0 + `TIER OK T1`, got exit 0)

```
$ node scripts/factory/review-plan/review-plan.mjs verify --tier T1 --log $TMP/no-l0.log
exit 1
stdout: MISSING LAYER: L0
stderr: 
```
- OK: verify T1 no L0 (want exit 1 + `MISSING LAYER: L0`, got exit 1)

```
$ node scripts/factory/review-plan/review-plan.mjs plan --tier docs
exit 0
stdout: {"tier":"docs","required":["L0"],"forbidden":["L1","L2","L3","L6"]}
stderr: 
```
- OK: plan docs required ["L0"], forbidden has L1,L2,L3,L6

```
$ node scripts/factory/review-plan/review-plan.mjs verify --tier docs --log $TMP/l0-only.log
exit 0
stdout: TIER OK docs
stderr: 
```
- OK: verify docs L0 only (want exit 0 + `TIER OK docs`, got exit 0)

```
$ node scripts/factory/review-plan/review-plan.mjs verify --tier docs --log $TMP/no-l0.log
exit 1
stdout: MISSING LAYER: L0
stderr: 
```
- OK: verify docs no L0 (want exit 1 + `MISSING LAYER: L0`, got exit 1)

## Scenario 3: T3 gets every layer and exactly one Greptile pass

Log `t3-ok.log`:
```
REVIEW: L0 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: critic ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: step-maid ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L1 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L2 skipped (not substantial) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L3 NOT RUN (no owner yes on NVIDIA terms) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L4 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L5 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L6 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ledger=lid1
```

```
$ node scripts/factory/review-plan/review-plan.mjs verify --tier T3 --log $TMP/t3-ok.log
exit 0
stdout: TIER OK T3 (L3 NOT RUN: allowed exception)
stderr: 
```
- OK: verify T3 full (want exit 0 + `TIER OK T3 (L3 NOT RUN: allowed exception)`, got exit 0)

Log `t3-two-l6.log`:
```
REVIEW: L0 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: critic ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: step-maid ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L1 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L2 skipped (not substantial) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L3 NOT RUN (no owner yes on NVIDIA terms) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L4 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L5 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L6 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ledger=lid1
REVIEW: L6 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ledger=lid2
```

```
$ node scripts/factory/review-plan/review-plan.mjs verify --tier T3 --log $TMP/t3-two-l6.log
exit 1
stdout: GREPTILE PASSES: 2 (T3 allows 1)
stderr: 
```
- OK: verify T3 two L6 (want exit 1 + `GREPTILE PASSES: 2 (T3 allows 1)`, got exit 1)

Log `t3-stale-l6.log`:
```
REVIEW: L0 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: critic ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: step-maid ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L1 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L2 skipped (not substantial) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L3 NOT RUN (no owner yes on NVIDIA terms) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L4 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L5 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L6 ran bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ledger=lid1
```

```
$ node scripts/factory/review-plan/review-plan.mjs verify --tier T3 --log $TMP/t3-stale-l6.log
exit 1
stdout: STALE LAYER: L6 (no record on final L0 aaaaaaaaaaaa)
GREPTILE SHA != FINAL SHA
stderr: 
```
- OK: verify T3 L6 on other sha (want exit 1 + `GREPTILE SHA != FINAL SHA`, got exit 1)

## Scenario 4: Third-party send needs a per-run yes

```
$ GAUNTLET_SENDS=$TMP/sends.jsonl node scripts/factory/review-plan/review-plan.mjs send-check --layer kodus --step nzr-5.s1 --sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
exit 4
stdout: ASK OWNER: kodus would send Netzer-Labs@aaaaaaaaaaaa (diff vs origin/development) to Kodus' service. Reply yes for this run only.
stderr: 
```
- OK: no yes record (want exit 4 + `ASK OWNER: kodus would send Netzer-Labs@aaaaaaaaaaaa (diff vs origin/development) to Kodus' service. Reply yes for this run only.`, got exit 4)

Coordinator appends to sends.jsonl:
```
{"layer":"kodus","step":"nzr-5.s1","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","owner_text":"yes kodus this run","id":"consent-uat-1"}
```

```
$ GAUNTLET_SENDS=$TMP/sends.jsonl node scripts/factory/review-plan/review-plan.mjs send-check --layer kodus --step nzr-5.s1 --sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
exit 0
stdout: SEND OK
stderr: 
```
- OK: first send-check after yes (want exit 0 + `SEND OK`, got exit 0)

```
$ GAUNTLET_SENDS=$TMP/sends.jsonl node scripts/factory/review-plan/review-plan.mjs send-check --layer kodus --step nzr-5.s1 --sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
exit 4
stdout: yes already used
stderr: 
```
- OK: second send-check same record (want exit 4 + `yes already used`, got exit 4)

## Scenario 5: Ledger warns at 35 and stops at 45

Setup: 34 base reserves (1 unit each) run silently with the repo policy file (`{ "monthly_units": 50, "soft_warn_pct": 70, "hard_stop_pct": 90, "reserve_units_high_risk": 0 }`).

```
$ GAUNTLET_LEDGER=$TMP/ledger5.jsonl GAUNTLET_POLICY=/root/wt/nzr-41/scripts/factory/review-ledger/gauntlet-review-policy.json node scripts/factory/review-ledger/review-ledger.mjs status
exit 0
stdout: month 2026-10  used 34/50  pending 34  remaining 16  high-risk reserve 0
stderr: WEIGHTS UNVERIFIED: tier weights and the monthly budget are planning assumptions; confirm them from the Greptile account.
```
- OK: status shows 34 used (want exit 0 + `used 34/50`, got exit 0)

```
$ GAUNTLET_LEDGER=$TMP/ledger5.jsonl GAUNTLET_POLICY=/root/wt/nzr-41/scripts/factory/review-ledger/gauntlet-review-policy.json node scripts/factory/review-ledger/review-ledger.mjs reserve base 0000000000000000000000000000000000000023
exit 0
stdout: mvogu32c-2ef5ed
stderr: WEIGHTS UNVERIFIED: tier weights and the monthly budget are planning assumptions; confirm them from the Greptile account.
soft warning: 35/50 units after this review
```
- OK: reserve to 35 warns (want exit 0 + `soft warning: 35/50 units after this review`, got exit 0)

Setup: reserves 36..44 run silently.

```
$ GAUNTLET_LEDGER=$TMP/ledger5.jsonl GAUNTLET_POLICY=/root/wt/nzr-41/scripts/factory/review-ledger/gauntlet-review-policy.json node scripts/factory/review-ledger/review-ledger.mjs reserve base 000000000000000000000000000000000000002d
exit 0
stdout: mvogu3dx-5721d5
stderr: WEIGHTS UNVERIFIED: tier weights and the monthly budget are planning assumptions; confirm them from the Greptile account.
soft warning: 45/50 units after this review
```
- OK: reserve at 45 succeeds (want exit 0 + `soft warning: 45/50`, got exit 0)

```
$ GAUNTLET_LEDGER=$TMP/ledger5.jsonl GAUNTLET_POLICY=/root/wt/nzr-41/scripts/factory/review-ledger/gauntlet-review-policy.json node scripts/factory/review-ledger/review-ledger.mjs reserve base 000000000000000000000000000000000000002e
exit 4
stdout: NOT RUN: hard stop: 45+1 > 45 units this month
stderr: WEIGHTS UNVERIFIED: tier weights and the monthly budget are planning assumptions; confirm them from the Greptile account.
```
- OK: next reserve hard-stops (want exit 4 + `NOT RUN: hard stop: 45+1 > 45 units this month`, got exit 4)

## Scenario 6: One Greptile reserve per step

```
$ GAUNTLET_LEDGER=$TMP/ledger6.jsonl GAUNTLET_POLICY=/root/wt/nzr-41/scripts/factory/review-ledger/gauntlet-review-policy.json node scripts/factory/review-ledger/review-ledger.mjs reserve base aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --step nzr-5.s1
exit 0
stdout: mvogu3ga-9cb085
stderr: WEIGHTS UNVERIFIED: tier weights and the monthly budget are planning assumptions; confirm them from the Greptile account.
```

```
$ GAUNTLET_LEDGER=$TMP/ledger6.jsonl GAUNTLET_POLICY=/root/wt/nzr-41/scripts/factory/review-ledger/gauntlet-review-policy.json node scripts/factory/review-ledger/review-ledger.mjs commit mvogu3ga-9cb085
exit 0
stdout: 
stderr: 
```
- OK: commit the first reserve (want exit 0, got exit 0)

```
$ GAUNTLET_LEDGER=$TMP/ledger6.jsonl GAUNTLET_POLICY=/root/wt/nzr-41/scripts/factory/review-ledger/gauntlet-review-policy.json node scripts/factory/review-ledger/review-ledger.mjs reserve base bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --step nzr-5.s1
exit 4
stdout: NOT RUN: step nzr-5.s1 already had a paid review this month; a second needs --reason
stderr: WEIGHTS UNVERIFIED: tier weights and the monthly budget are planning assumptions; confirm them from the Greptile account.
```
- OK: second reserve same step, new sha, no reason (want exit 4 + `NOT RUN: step nzr-5.s1 already had a paid review this month; a second needs --reason`, got exit 4)

```
$ GAUNTLET_LEDGER=$TMP/ledger6.jsonl GAUNTLET_POLICY=/root/wt/nzr-41/scripts/factory/review-ledger/gauntlet-review-policy.json node scripts/factory/review-ledger/review-ledger.mjs reserve base bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --step nzr-5.s1 --reason owner yes: rerun after blocker fix
exit 0
stdout: mvogu3iy-2b7af6
stderr: WEIGHTS UNVERIFIED: tier weights and the monthly budget are planning assumptions; confirm them from the Greptile account.
```
- OK: second reserve with --reason (want exit 0, got exit 0)

## Scenario 7: A layer that cannot run is NOT RUN, never faked

Log `t3-l1-notrun-kodus.log`:
```
REVIEW: L0 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: critic ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: step-maid ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L1 NOT RUN (kodus signed out) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L2 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L3 NOT RUN (no owner yes on NVIDIA terms) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L4 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L5 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L6 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ledger=lid1
```

```
$ node scripts/factory/review-plan/review-plan.mjs verify --tier T3 --log $TMP/t3-l1-notrun-kodus.log
exit 2
stdout: INCOMPLETE: L1 NOT RUN
stderr: 
```
- OK: verify T3 with L1 NOT RUN (kodus signed out) (want exit 2 + `INCOMPLETE: L1 NOT RUN`, got exit 2)

Log `t3-l1-notrun-coderabbit.log`:
```
REVIEW: L0 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: critic ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: step-maid ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L1 NOT RUN (coderabbit over free limit) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L2 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L3 NOT RUN (no owner yes on NVIDIA terms) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L4 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L5 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REVIEW: L6 ran aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ledger=lid1
```

```
$ node scripts/factory/review-plan/review-plan.mjs verify --tier T3 --log $TMP/t3-l1-notrun-coderabbit.log
exit 2
stdout: INCOMPLETE: L1 NOT RUN
stderr: 
```
- OK: verify T3 with L1 NOT RUN (coderabbit over free limit) (want exit 2 + `INCOMPLETE: L1 NOT RUN`, got exit 2)

```
$ GAUNTLET_LEDGER=$TMP/ledger7.jsonl GAUNTLET_POLICY=/root/wt/nzr-41/scripts/factory/review-ledger/gauntlet-review-policy.json node scripts/factory/review-ledger/review-ledger.mjs reserve base aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --step nzr-5.s1
exit 0
stdout: mvogu3m5-e58e31
stderr: WEIGHTS UNVERIFIED: tier weights and the monthly budget are planning assumptions; confirm them from the Greptile account.
```

```
$ GAUNTLET_LEDGER=$TMP/ledger7.jsonl GAUNTLET_POLICY=/root/wt/nzr-41/scripts/factory/review-ledger/gauntlet-review-policy.json node scripts/factory/review-ledger/review-ledger.mjs release mvogu3m5-e58e31 greptile refused: no git remote
exit 0
stdout: 
stderr: 
```
- OK: release open reserve with reason (want exit 0, got exit 0)

```
$ GAUNTLET_LEDGER=$TMP/ledger7.jsonl GAUNTLET_POLICY=/root/wt/nzr-41/scripts/factory/review-ledger/gauntlet-review-policy.json node scripts/factory/review-ledger/review-ledger.mjs status
exit 0
stdout: month 2026-10  used 0/50  pending 0  remaining 50  high-risk reserve 0
stderr: WEIGHTS UNVERIFIED: tier weights and the monthly budget are planning assumptions; confirm them from the Greptile account.
```
- OK: released reserve not spent (want exit 0 + `used 0/50`, got exit 0)
- OK: ledger release line carries the reason: `{"ts":"2026-10-25T23:35:29.011Z","month":"2026-10","id":"mvogu3m5-e58e31","event":"release","reason":"greptile refused: no git remote"}`

## Summary

| # | title | result |
|---|---|---|
| 1 | T2 picks critic + free checks + step maid, not Greptile | PASS |
| 2 | T1 and docs get free checks only | PASS |
| 3 | T3 gets every layer and exactly one Greptile pass | PASS |
| 4 | Third-party send needs a per-run yes | PASS |
| 5 | Ledger warns at 35 and stops at 45 | PASS |
| 6 | One Greptile reserve per step | PASS |
| 7 | A layer that cannot run is NOT RUN, never faked | PASS |
