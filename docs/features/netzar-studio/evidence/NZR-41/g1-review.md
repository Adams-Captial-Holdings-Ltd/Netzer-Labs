# G1 code review, pass 3: NZR-41 (T2)

HEAD f89ea37f5564774d0f66e736ba11039332f6b090. Diff `origin/integration/netzar-studio...HEAD`, excluding docs/features/netzar-studio. 6 files, +739.

## Evidence
- `npx vitest run scripts/factory/review-plan`: 14/14 pass. This includes the ledger selftest, the policy 35/45 case and the lock race.
- `tests/e2e/nzr-41/run.mjs`: read only. The sandbox needed approval to run it, so it was not run here. It drives both CLIs: happy path plus the refusal paths (forbidden L6, NOT RUN, no yes, reused yes, second step reserve).

## Previous findings, re-checked
| # | finding | status |
|---|---|---|
| 1 | [medium] finalSha ignores a later non-ran L0 (fail-open) | FIXED. `review-plan.mjs:59-61` takes the last L0 line of any status and fails with `FINAL L0 DID NOT RUN`. Test at review-plan.test.ts:156. |
| 2 | [low] used-markers keyed by line index | FIXED. `:106-110` requires a non-empty consent `id` and keys the marker on sha256(id). Uses an exclusive `wx` create. Rewrite test at :106. |
| 3 | [low] loose yes regex | FIXED. `:104` uses a leading `yes` with no `?` after it. Tests cover 'not yes', 'yes?' and 'no, yes later'. |
| 4 | [low] one-pass-per-step depends on the coordinator passing --step | PARTIAL. T3 verify now requires `ledger=<id>` on L6 (`:77`, test :167). `review-ledger.mjs reserve` still accepts no `--step`, and the ledger id is not checked against the ledger. Still low. |
| 5 | [info] doc edits (behaviours 1, 3, 5, 6) and the /root/.claude/bin install are not in the diff | OPEN. README lists them as coordinator follow-ups. They must be done before DoD. |
| 6 | [info] scope differs from the story (repo copies, vitest/e2e, rewritten lock recovery) | OPEN, but now recorded in story NOTES line 184. Call it out in the PR. |
| 7 | [info] --slug not validated | FIXED. `:96` rejects path separators and `..`. Test at :122. |

## Acceptance criteria
- S1 (T2 plan/verify), S2 (T1/docs), S3 (T3, two L6 passes, L6 sha mismatch), S4 (single-use yes), S5 (warn 35 / stop 45 with the shipped policy file), S6 (step rule plus selftest assertion), S7 (NOT RUN → exit 2 INCOMPLETE): all have tests and pass.
- Policy file: `hard_stop_pct 90`, `soft_warn_pct 70`, `reserve_units_high_risk 0`. `DEFAULT_POLICY` is unchanged, as the story requires.

## Security
- No network and no keys. Output holds only the layer, a 12-char sha and fixed text. Nothing from sends.jsonl reaches logs.
- verify fails closed on unparseable lines, stale layers, a non-ran final L0 and unsupported skips.
- The ledger refuses a corrupt ledger or policy (exit 5). The lock never steals from a live pid.

## New observations
- [info] The script never creates `sends.jsonl`, and the story says "created on first use, mode 600". The coordinator writes it, so the coordinator must create it with mode 600. Only the `.used.*` markers get 0o600 from the script.

## Verdict
PASS. No high or medium finding is open.
