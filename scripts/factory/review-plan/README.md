# review-plan (NZR-41)

Factory helper for the VPS gauntlet. Applies the Q68 tier policy: which review layers a Netzar step must run, which it must not, and whether a third-party send has the owner's yes for this run. Node built-ins only; no network; reads no key. The ledger copy in `../review-ledger/` adds the one-paid-pass-per-step rule and ships the policy file (warn at 35, stop at 45 of 50).

Install: copy `review-plan.mjs` and `../review-ledger/review-ledger.mjs` to `/root/.claude/bin/`, and `../review-ledger/gauntlet-review-policy.json` to `/root/.claude/gauntlet-review-policy.json`. Tests: `npx vitest run scripts/factory/review-plan`. Self-check: `node review-ledger.mjs selftest`.

```
review-plan.mjs plan       --tier T3|T2|T1|docs
review-plan.mjs verify     --tier T --log FILE
review-plan.mjs send-check --layer kodus|coderabbit|greptile --step ID --sha SHA [--slug S]
review-ledger.mjs reserve  <base|plus|apex> <sha> --step ID [--reason TEXT]
```

| tier | required | forbidden |
|---|---|---|
| T3 | L0, critic, step-maid, L1, L2 (or `skipped (not substantial)`), L3 (`NOT RUN` allowed), L4, L5, one L6 on the final L0 sha | none (L7 optional) |
| T2 | L0, critic, step-maid | L1, L2, L3, L6 |
| T1, docs | L0 | L1, L2, L3, L6 |

`verify` exit codes: 0 `TIER OK`, 1 forbidden layer ran / missing layer / more than one Greptile pass / Greptile sha differs from the last L0 sha / unparseable `REVIEW:` line, 2 `INCOMPLETE: <layer> NOT RUN`. `send-check`: 0 `SEND OK` (consumes the record), 4 `ASK OWNER: ...` or `yes already used`, 2 usage. Env: `GAUNTLET_SENDS` (default `~/.claude/plans/<slug>-reviews/sends.jsonl`, slug default `netzar`). A yes record is `{"layer","step","sha","owner_text","id"}` appended by the coordinator only after the owner's yes, with a fresh unique `id` minted for that approval (a record without an `id` is not consent); `owner_text` must start with "yes" ("not yes" and "yes?" are refused). Each record is consumed once by creating `sends.jsonl.used.<hash of id>`, so rewriting or reformatting the record does not revive a used yes. `--slug` must be a plain name (no path separators or `..`). `verify` takes the last `L0` line of any status as final and fails if it did not run; a T3 `L6 ran` line needs `ledger=<id>`.

`REVIEW:` grammar: `REVIEW: <L0|critic|step-maid|L1..L7> <ran|NOT RUN (reason)|skipped (reason)> <40-hex sha> [ledger=<id>]`.

## Doc edits for the factory skill copies (outside this repo)

These files live under `/root/.claude`, outside the builder's reach. The coordinator applies them.

1. `references/review-gauntlet.md` lines 41-45: add "Netzer-Labs uses the Q68 table in section 10 instead of this paragraph."
2. `references/review-gauntlet.md` section 10: add the table above, Q68's T3 list (schema, versions, security, engine, ADRs), the per-run yes rule for Kodus and CodeRabbit, "one Greptile pass per T3 step", and the three commands.
3. `references/review-gauntlet.md` lines 10-12: for Netzer-Labs the standing yes does not cover Kodus or CodeRabbit (a yes per run), and Greptile is limited to one pass per T3 step.
4. `SKILL.md` lines 318, 350, 3789, 3894: append "(Netzer-Labs: the Q68 table in `references/review-gauntlet.md` section 10)".
5. Run the attended preflight (no paid call) and save it to `~/.claude/plans/netzar-logs/review-preflight.log`.
