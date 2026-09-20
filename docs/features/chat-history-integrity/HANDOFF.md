---
feature: chat-history-integrity
document_role: handoff
status: current
observed_at: 2026-09-19
as_of_commit: c195a6e9e34d64d097ccebb18de37c8206b05278
---

# Chat history integrity — current state

## Where this is

| | |
|---|---|
| Branch | `chore/wi02-cleanup` (WI-0.2 CLEANUP): comment and doc precision on the merged WI-0.2 lines. Cut from `origin/development` at `b152b7a`. On top: the cleanup (`d1876b1`), its docs commit (`974399b`), the VERIFICATION session's docs commit (`e036f7a`), the CLEANUP rerun's README correction (`e1cdc11`) and its docs commits (`6f22e55`, `45fe425`), the SPECIFICATION amendment's test (`7b6bbf3`) and its docs commit (`c195a6e`), and this VERIFICATION's docs commit. |
| Based on | `development` at `b152b7a96bb5f9c64f9654184029fe2b276d07b7`, the merge of PR #177 (WI-0.2). Its tree equals `c58da7c`'s. PR #176 (WI-0.1) merged before it as `264d024`. |
| Next merge target | `development` |
| Deployment state | **Nothing here deploys.** `development` now holds WI-0.1 and WI-0.2. Neither has been promoted: `qa`, `staging` and `production` do not have WI-0.2, and `staging` deploys on push, so promotion needs its own authorization. Production (`de244e6`, deployed 2026-09-09) runs the hotfixes that WI-0.1 back-merged. |
| Pushed | Cleanup: **no**, local only. WI-0.1 and WI-0.2: yes, both merged into `development` on 2026-09-19 on the owner's instruction. Both head branches are deleted on `origin`. |
| PR | WI-0.1: [#176](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/176), merged as `264d024`. WI-0.2: [#177](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/177), merged as `b152b7a`, CI 9/9 green. Cleanup: none yet; it needs its own push and PR authorization. |

Staging is reachable only by the promotion chain `development → qa → staging`. Each step is its own pull request, because `scripts/ci/deploy-source-guard.mjs` refuses any staging deploy whose ref is not `refs/heads/staging`. Nothing on a `chore/*` branch reaches an AWS environment.

## Current objective

WI-0.2 (plan section 10, P0 step 2): make the turn output ceiling tunable at runtime and bound the stored window by bytes.
- The ceiling comes from `resolveTurnMaxTokens()`, which reads runtime-config `agent/max_output_tokens`. The default is 8192, the clamp is 1024-32768, and writing it through `/config` is admin-only. It is read once per turn and used by all three model calls.
- The byte budget is `trimTurnsToBudget()` in `appendTurns`, at 300,000 bytes. It drops the oldest exchanges first, cuts only at a user turn, and never stores turns over budget.

**Status: WI-0.2 is VERIFIED (2026-09-19, PASS at `c195a6e`)** ([log](handoffs/2026-09-19-wi02-verification-final.md), sections 2 and 7). A fresh critic re-derived all seven criteria from the code: README 2.1's replay set, the section 4 correction, every other README code claim, the proof, the full step 7 list, the whole item's scope, and the pinning test with its mutation. No defect found, so nothing routes back.
- One test pins a `max_output_tokens` value stored as a number (`7b6bbf3`). It passes. With line 104 back on `raw?.trim()`, it is the only failure in the **whole** suite (1 of 3210), with `TypeError: raw?.trim is not a function`.
- Frozen counts: AC-0.2-2 has 8 ceiling tests, and AC-0.2-7's `npm test` gives 246 files and 3210 tests.

Before that, the CLEANUP rerun ([log](handoffs/2026-09-19-wi02-cleanup-rerun.md), sections 4.3 and 6.5):
- It fixes the one VERIFICATION failure ([log](handoffs/2026-09-19-wi02-verification.md), section 4.3). README 2.1 now names the paths that replay a stored chat transcript through `getSession`: the dashboard, Slack and Telegram adapters, both scheduled-task runners and the Paperclip dispatch worker. It also says why Jarvis and the TLDR bar are not among them.
- The full claim re-check found one more false claim: section 4 said `generate_document`'s spec validation was unchanged. That is corrected too, and 2.3's production observation is now dated.
- The stamp is `e036f7a`, where 56 claim checks pass. The fixes are docs only, with no code defect and no runtime risk.
- WI-0.2 itself was merged into `development` (`b152b7a`) before CLEANUP and VERIFICATION ran, on the owner's instruction.

## Live state worth knowing

- **Green at `974399b`, checked by the fresh critic** ([log](handoffs/2026-09-19-wi02-verification.md), section 7):
  - `WI02_BASE=development bash wi-0.2-proof.sh`: every line PASS, exit 0, 0 changed paths.
  - The full step 7 list (`wi-0.2-full-validation.sh`) equals the baseline. `npm test`: 246 files and 3209 tests. Integration: 38 passed, 25 skipped, 1 failed, the Floci gap.
  - Both mapped diagrams render with the pinned `mmdc` 10.9.1.
  - The cleanup is comment-only in `src/` (identical comment-stripped transpile) and changes no test.
  - Fixes 1-4, 6 and 7, and fix 5's `tested_by` and its dates, are true against the code.
- **At `e1cdc11` (the CLEANUP rerun, [log](handoffs/2026-09-19-wi02-cleanup-rerun.md), section 7):** the proof passes every line, exit 0, 0 changed paths, and the code is identical to `974399b`'s. The README's 56 claim checks pass at `e036f7a`. Not yet independently verified.
- **At `7b6bbf3` (the SPECIFICATION amendment, [log](handoffs/2026-09-19-wi02-spec-amendment.md), section 7):** the proof passes every line, exit 0, with 72 tests and 0 changed paths. `npm test` gives 246 files and 3210 tests.
- **Green at `c195a6e`, checked by a fresh critic** ([log](handoffs/2026-09-19-wi02-verification-final.md), section 7):
  - `WI02_BASE=development bash wi-0.2-proof.sh`: every line PASS, exit 0, 6 files / 72 tests, 0 changed paths.
  - The full step 7 list equals the baseline. `npm test`: 246 files and 3210 tests. Integration: 38 passed, 25 skipped, 1 failed — the Floci `checkSecrets` gap, confirmed by name.
  - Every Mermaid block renders (`node scripts/ci/docs-mermaid.mjs`, exit 0).
  - Scope: `e036f7a..HEAD` is this feature's docs plus the test file; `45fe425..HEAD` under `src/` is 12 added lines in that test file and nothing else; the whole item `b152b7a^1..HEAD` is 15 paths, none under `src/adapters/` and none outside AC-0.2-6's filter.
  - README 2.1's replay set re-derived from the code: 11 agent-loop call sites, the 8 that replay stored turns all read through `getSession`. The other three pass `history: []`.
- **A comment-only change to a mapped source fails the diagram drift gate.** `scripts/ci/diagrams-drift.mjs` cannot tell a comment from code. The cleanup touched both mapped diagrams' notes, each fixing a real imprecision ([log](handoffs/2026-09-19-wi02-cleanup.md), section 4.3).
- **Two defects in the first Codex build were caught by inspection, not by the tests** ([implementation log](handoffs/2026-09-18-wi02-implementation.md), section 4.3):
  - `raw?.trim()` threw on a config value stored as a number, which would have failed every turn.
  - A `;` in a Mermaid sequence message broke `request-lifecycle.md`'s render.
  - Both were fixed in the correction round. Since `7b6bbf3`, a test pins the non-string case.
- **The spec departs from the parked code in two places.**
  - The trim cuts only at a user turn and never keeps turns over budget ([spec log](handoffs/2026-09-18-wi02-specification.md), M29).
  - A whitespace-only config value falls back to 8192.
- **BR-002 dry-run (at `6d43213`, not rerun since):** merging production into HEAD gives 9 conflicted files. Merging staging into HEAD is conflict-free.
- **Chat `dashboard:1787596504860` (agent `elon-strategy`)** was poisoned in production on 2026-08-24. It has not been re-checked since production received the empty-turn repair (`8c14b3f`, #103).

## Blockers and open items

| Item | Status |
|---|---|
| README 2.1 named Jarvis as a `getSession` consumer, and section 4 called the spec validation unchanged | Both corrected in `e1cdc11` by the CLEANUP rerun ([log](handoffs/2026-09-19-wi02-cleanup-rerun.md), sections 3.1 and 4.3), and both **verified true** at `c195a6e` ([log](handoffs/2026-09-19-wi02-verification-final.md), sections 7.2 and 7.3). Closed. |
| Push and PR for `chore/wi02-cleanup` | **Now due.** The VERIFICATION passed (2026-09-19). The owner said yes (2026-09-19), once `WI02_BASE=development bash wi-0.2-full-validation.sh` has run on the exact HEAD being pushed — it ran on `c195a6e`, so rerun it on the docs commit on top — and after one more confirmation from the owner. The owner also said yes to promoting `development → qa → staging` after that PR merges. Each step is its own PR, and the `staging` merge deploys. |
| Raising `agent/max_output_tokens` above 8192 in production | Unknown whether a non-streaming tool round (`ConverseCommand`, no client timeout set) finishes at that length. Exercise one long tool round first. The default stays 8192. On the "unlimited ceiling", the owner chose (c) on 2026-09-19: large documents go through the incremental document tool, which is approved for P4 but not built yet. No separate ceiling item is planned. |
| Documents of unbounded size | A higher ceiling still caps a document at one call's output (README section 2.3). The owner said yes (2026-09-19) to an incremental document tool as a proposed P4 item. It needs its own SPECIFICATION and is outside WI-0.2. |
| Documentation debts found in CLEANUP | Classified and not patched ([log](handoffs/2026-09-19-wi02-cleanup.md), section 6.4): the README's `tested_by` and `implemented_by` omit the builder files and `builders.test.ts`; section 2.4 sits after 3a; and sections 3a and 4 disagree about production PDFs as of 2026-08-24. |
| The knowledge Q&A route (`handler.ts:2826-2828`) sends browser-posted history text to Bedrock with no empty-text guard | Technical debt, unrelated to WI-0.2. It is per request and never stored, so it cannot poison a chat. Not patched ([log](handoffs/2026-09-19-wi02-cleanup-rerun.md), section 4.3). |
| Production-only hotfixes #90, #91, #168 and the rest of #170 are not ancestors of `development` | Deferred: out of scope by owner decision. **Do not promote `staging → production` until they are reconciled.** The two sides' War Room notes in `architecture-security.md` each describe their own branch: production's (#170) the route's port, the back-merge's only the slice. |
| `1124118` (Haiku id) takes effect only through a CDK deploy | A note for whoever deploys. Nothing on a `chore/*` branch deploys. |
| The approved `development.md` amendment (Gauntlet plan section 9) | Rebased onto `b152b7a` as `b7ab004`, with the test-table refresh `aeb20a7` on top. The full validation list on `aeb20a7` equals the baseline. Pushed 2026-09-19 on the owner's yes: [PR #178](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/178) into `development`, not merged. |
| The `development.md` Automated tests table is stale | The owner approved the fix (2026-09-19). It is `aeb20a7`, in PR #178. |
| `src/lib/state/runtime-config-repo.ts` holds literal NUL bytes (`:57`, `:238`), so git shows its diffs only as "Binary files ... differ" and `git grep -n` prints nothing for it | Technical debt, unrelated to WI-0.2. Not patched ([log](handoffs/2026-09-19-wi02-spec-amendment.md), section 4.3). |
| `npm run local` dies with `spawn npm ENOENT` on Windows (`scripts/local/dev.mjs:79-80`) | Deferred to its own `fix/*` branch. |
| PDF and DOCX had never run in production (as of 2026-08-24) | Not re-checked |
| Does the model reliably *pick* `generate_document`? (open on 2026-08-24; truncation may have been hiding it) | Not re-checked |
| `memory ingest failed — "The provided model identifier is invalid."` (production, 2026-08-24) | Not re-checked |
| `webhook monitor: getWebhookInfo failed`, repeating (2026-08-24) | Not re-checked |

## Smallest next action

Start WI-0.3 SPECIFICATION in a new session, from the Gauntlet handoff (plan section 10, P0 step 3): credential-stripping setup/tripwire and a budget-writer mock, without changing `npm test`.

In parallel, this branch is ready for its push and PR once the owner confirms again (decision 17). WI-0.2 itself needs no further work.

## Related

- [README](README.md), including the [content check](README.md#4a-checking-a-branch-for-these-fixes-by-content-never-by-ancestry)
- [2026-09-19 WI-0.2 verification (final) log](handoffs/2026-09-19-wi02-verification-final.md): the PASS verdict for the whole item, each criterion's command and result at `c195a6e`, and the replay set enumerated from the code
- [2026-09-19 WI-0.2 specification amendment log](handoffs/2026-09-19-wi02-spec-amendment.md): the pinning test, its mutation run, and the new counts
- [2026-09-19 WI-0.2 cleanup rerun log](handoffs/2026-09-19-wi02-cleanup-rerun.md): the replay paths and readers of the sessions table, all 56 README claim checks with their commands, and the proof at `e1cdc11`
- [2026-09-19 WI-0.2 verification log](handoffs/2026-09-19-wi02-verification.md): the verdict per criterion, the one FAIL (README 2.1's Jarvis claim), and every command and its result at `974399b`
- [2026-09-19 WI-0.2 cleanup log](handoffs/2026-09-19-wi02-cleanup.md): the seven comment and doc fixes, the drift-gate finding, and the README claim re-check
- [2026-09-18 WI-0.2 implementation log](handoffs/2026-09-18-wi02-implementation.md): the Codex build and its correction, the two defects, and the proof at `3ae63b4`
- [2026-09-18 WI-0.2 specification log](handoffs/2026-09-18-wi02-specification.md): G0, the landing of WI-0.1, the seam, the red state and the acceptance criteria
- [2026-09-18 verification log](handoffs/2026-09-18-wi01-verification.md): the PASS verdict for WI-0.1, with each criterion's command and output at `fdda55c`
- [2026-09-17 docgen-crash-wip-transfer](handoffs/2026-09-17-docgen-crash-wip-transfer.md): the parked turn-ceiling work and its two known test defects
- [knowledge-scope-fanout HANDOFF](../knowledge-scope-fanout/HANDOFF.md), which records the closed `staging → production` PR #61
- [Feature knowledge framework](../README.md)

## Session index

| Date | Session | Subject |
|---|---|---|
| 2026-09-19 | [wi02-verification-final](handoffs/2026-09-19-wi02-verification-final.md) | A fresh critic verified the whole of WI-0.2 at `c195a6e`: **PASS** on all seven criteria. README 2.1's replay set was re-derived from the agent loop's 11 call sites (the 8 that replay stored turns all read through `getSession`, Paperclip's through its injected aliases); section 4's correction and 2.3's date check out against `git log`; every other README code claim was checked sentence by sentence; the proof passed every line with 72 tests; the full step 7 list equalled the baseline (246 files, 3210 tests; integration 38/25/1, the Floci gap by name); the scope filters passed; and under the `raw?.trim()` mutation the pinning test was the only failure in the whole suite. The carried "fails 3 tests" check was re-run and now fails 4. |
| 2026-09-19 | [wi02-spec-amendment](handoffs/2026-09-19-wi02-spec-amendment.md) | Added the test the owner approved: a `max_output_tokens` value stored as a number resolves to that number, and the turn still runs (`7b6bbf3`). It passes. When line 104 goes back to `raw?.trim()`, it is the only test that fails, with `TypeError: raw?.trim is not a function`. New counts: 8 ceiling tests, and `npm test` 246 files and 3210 tests. The proof passed on every line with 72 tests. |
| 2026-09-19 | [wi02-cleanup-rerun](handoffs/2026-09-19-wi02-cleanup-rerun.md) | Fixed VERIFICATION's one failure on `chore/wi02-cleanup`, docs only (`e1cdc11`). README 2.1 now names the eight call sites that replay a stored chat transcript through `getSession`, Paperclip's dependency-injected one included, and says why Jarvis and the TLDR bar are not among them. A full re-check (56 checks at `e036f7a`, each command recorded) found section 4's false "spec validation unchanged" and corrected it, and 2.3's production observation is now dated. The proof passed on every line at `e1cdc11`. |
| 2026-09-19 | [wi02-verification](handoffs/2026-09-19-wi02-verification.md) | A fresh critic verified WI-0.2 as merged plus the cleanup, at `974399b`: FAIL on one criterion. Everything else passed: the proof on every line, the full step 7 list at baseline, both diagrams rendering, a comment-only cleanup with no test change, the whole-item scope, and a mutation check. The failure is the README stamp, which certifies section 2.1's false claim that Jarvis reads through `getSession`. Routed to a CLEANUP rerun. |
| 2026-09-19 | [wi02-cleanup](handoffs/2026-09-19-wi02-cleanup.md) | After #176 and #177 merged, cleaned up WI-0.2 on `chore/wi02-cleanup` off `development`. Fixed comments and docs only (`d1876b1`): the clamp comment, the trim's reason and pointer, the restored evict-backstop comment, README 2.3 and `tested_by`, and two diagram notes the drift gate forced a review of. Re-checked the README's code claims and moved its stamp. The proof passed on every line, and `npm test` gave 246 files and 3209 tests. |
| 2026-09-18 | [wi02-implementation](handoffs/2026-09-18-wi02-implementation.md) | Codex `gpt-5.6-terra` built WI-0.2 from the work order. Claude rejected the first build on two defects the tests could not see (a non-string config value threw; a `;` broke the Mermaid render) and sent the one allowed correction. Committed `3ae63b4`. The proof passed on every line twice, and `npm test` gave 246 files and 3209 tests. Promoted the byte budget into README 2.3. |
| 2026-09-18 | [wi02-specification](handoffs/2026-09-18-wi02-specification.md) | G0 failed (WI-0.1 not on `development`). Owner decisions: authorship kept; push, PR and stack now; line 51 fixed in WI-0.2. Ran step 7 on `9f1cd58`, force-pushed with lease, opened PR #176 (green). WI-0.2 red at `56e37b0`: the parked tests ported with both defects fixed, plus a user-turn boundary rule for the byte trim and an `appendTurns` storage-seam test. Codex work order written. |
| 2026-09-18 | [wi01-verification](handoffs/2026-09-18-wi01-verification.md) | A fresh critic verified WI-0.1: PASS. The proof, AC-0.1-1 to AC-0.1-8, the seven blobs, the route, RED-2 and full validation were all rerun at `fdda55c`, and each matches production or the baseline. No pick adds a line its production original lacks. Both CLEANUP findings upheld as classified, with (b)'s rationale corrected. |
| 2026-09-18 | [wi01-cleanup](handoffs/2026-09-18-wi01-cleanup.md) | Reviewed `020fad8` and `6d43213` with `/refactor`: no change. `pdf.ts` and the War Room route are still production's bytes. The proof and every content check pass at `31b2660`. Classified two findings and patched neither: a cosmetic note reference, and a stale `TOOL_LOOP_MAX_TOKENS` sentence carried verbatim from production. |
| 2026-09-18 | [wi01-implementation](handoffs/2026-09-18-wi01-implementation.md) | Applied the nine picks with `-x` (five resolved empty). Codex `gpt-5.6-terra` wrote the #170 slice and the diagram notes, and Claude inspected and proved them. Every content check passes; full validation matches the baseline. Applied the approved `development.md` amendment on its own branch. |
| 2026-09-18 | [wi01-specification](handoffs/2026-09-18-wi01-specification.md) | Rebased onto `9e8e42b`, recorded a green baseline, committed the red state (production's tests + one War Room substitution test), and mapped every pick's conflicts. Nothing applied. |
| 2026-09-17 | [backmerge-machine-transfer](handoffs/2026-09-17-backmerge-machine-transfer.md) | Landed the 09-10 log. Recorded the interrupted claudex loop (round 1 REVISE, baseline, RED-1). Re-verified that the fixes are still missing from development, and parked the back-merge for the machine transfer. |
| 2026-09-17 | [docgen-crash-wip-transfer](handoffs/2026-09-17-docgen-crash-wip-transfer.md) | Parked the 2026-08-25 turn-ceiling work in progress (resolveTurnMaxTokens / trimTurnsToBudget, tests not passing) on `wip/docgen-crash-turn-ceiling`; reconcile with the back-merge before merging. |
| 2026-09-10 | [backmerge-production-hotfixes](handoffs/2026-09-10-backmerge-production-hotfixes.md) | Opened the back-merge of #103–#106 on a fresh clone at `271339b`. Scoped it to the nine commits and recorded the plan. Nothing applied. |
| 2026-08-24 | [empty-turn-poisoning](handoffs/2026-08-24-empty-turn-poisoning.md) | Diagnosed the max_tokens → empty turn → dead chat chain from production logs, and shipped the three guards of #96. |
