---
feature: chat-history-integrity
document_role: handoff
status: current
observed_at: 2026-09-18
as_of_commit: 3ae63b454381db5a8f02ec8679ab2d65316bf9d4
---

# Chat history integrity — current state

## Where this is

| | |
|---|---|
| Branch | `fix/turn-ceiling-byte-budget` (WI-0.2): a runtime-tunable turn output ceiling and a byte budget on the stored turn window. It is transplanted from the parked `wip/docgen-crash-turn-ceiling` (`ef0768f`), which stays untouched as the source. |
| Based on | `fix/backmerge-production-hotfixes` at `9f1cd584da37b0de3c0de8615f46fab4d321b7fe`, WI-0.1's verified back-merge. On top: the red tests (`56e37b0`), the specification docs (`d14a439`), the implementation (`3ae63b4`) and one implementation docs commit. |
| Next merge target | `development`, after WI-0.1 lands there |
| Deployment state | **Nothing here deploys.** Production (`de244e6`, deployed 2026-09-09) runs the hotfixes. `development` and `staging` do not have them yet. |
| Pushed | WI-0.2: **no**, local only. WI-0.1: **yes**. `fix/backmerge-production-hotfixes` was force-pushed 2026-09-18 on the owner's authorization (`9e832da...9f1cd58`, with lease). |
| PR | WI-0.1: [#176](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/176) into `development`. 9/9 checks green, `OPEN`, **not merged** (checked 2026-09-18 in the WI-0.2 implementation session); merging is the owner's call. #176's own copy of this file predates the push. WI-0.2: none yet. |

Staging is reachable only by the promotion chain `development → qa → staging`. Each step is its own pull request, because `scripts/ci/deploy-source-guard.mjs` refuses any staging deploy whose ref is not `refs/heads/staging`. Nothing on a `fix/*` branch reaches an AWS environment.

## Current objective

WI-0.2 (plan section 10, P0 step 2): make the turn output ceiling tunable at runtime and bound the stored window by bytes.
- The ceiling comes from `resolveTurnMaxTokens()`, which reads runtime-config `agent/max_output_tokens`. The default is 8192, the clamp is 1024-32768, and the write is admin-only. It is read once per turn and used by all three model calls.
- The byte budget is `trimTurnsToBudget()` in `appendTurns`, at 300,000 bytes. It drops the oldest exchanges first, cuts only at a user turn, and never stores turns over budget.

**Status: IMPLEMENTATION complete 2026-09-18 at `3ae63b4`.** Codex `gpt-5.6-terra` wrote it: one build plus the one allowed narrow correction. Claude Opus inspected the diff and proved it. Next are CLEANUP and then VERIFICATION, each in a fresh session.

## Live state worth knowing

- **Green at `3ae63b4`:**
  - `wi-0.2-proof.sh`: every line PASS, exit 0, on two consecutive runs; the tree was clean after both.
  - Full `npm test` with credentials stripped: 246 files and 3209 tests pass. That is the baseline plus the new file and 13 tests.
  - `AC-0.2-7`, the full step 7 list, has **not** run on this HEAD. It is due in VERIFICATION and before any push.
- **Two defects in the first Codex build were caught by inspection, not by the tests** ([log](handoffs/2026-09-18-wi02-implementation.md), section 4.3):
  - `raw?.trim()` threw on a config value stored as a number, which would have failed every turn.
  - A `;` in a Mermaid sequence message broke `request-lifecycle.md`'s render.
  - Both were fixed in the correction round. No test pins the non-string case.
- **The spec departs from the parked code in two places.**
  - The trim cuts only at a user turn and never keeps turns over budget ([spec log](handoffs/2026-09-18-wi02-specification.md), M29).
  - A whitespace-only config value falls back to 8192.
- **Baseline on `9f1cd58`:** the full step 7 list matches the WI-0.1 baseline: `npm test` 245 files and 3196 tests, and the only failure is the documented `destroy.integration.test.ts` Floci gap.
- **BR-002 dry-run (at `6d43213`, not rerun since):** merging production into HEAD gives 9 conflicted files. Merging staging into HEAD is conflict-free.
- **Chat `dashboard:1787596504860` (agent `elon-strategy`)** was poisoned in production on 2026-08-24. It has not been re-checked since production received the empty-turn repair (`8c14b3f`, #103).

## Blockers and open items

| Item | Status |
|---|---|
| Merge PR #176 (WI-0.1) | Owner's call, and CI is green. WI-0.2 lands after it. Once it merges, confirm `origin/development` by content (README section 4a). If `development` moved past `9f1cd58`'s tree, rebase WI-0.2 and rerun the proof with `WI02_BASE=development`. |
| No test pins a non-string `max_output_tokens` value | The fix is a `typeof` guard with a comment, and a scratchpad replica check exercised it. A pinning test would change AC-0.2-2 (7 ceiling tests) and AC-0.2-7 (3209), so it needs a SPECIFICATION amendment. It is the owner's call ([log](handoffs/2026-09-18-wi02-implementation.md), section 6.3). |
| CLEANUP findings | Five comment and doc-precision items, all phase-scoped ([log](handoffs/2026-09-18-wi02-implementation.md), section 6.2). |
| Line 51 of `request-lifecycle.md` | **Done in `3ae63b4`**, owner decision 2026-09-18. Only its last sentence changed. Line 1's dated #96 record stays. The fix makes line 51 differ from production's, so the promotion takes `development`'s side. |
| Raising `agent/max_output_tokens` above 8192 in production | Unknown whether a non-streaming tool round (`ConverseCommand`, no client timeout set) finishes at that length. Exercise one long tool round first. The default stays 8192. |
| Documents of unbounded size | The owner asked. The answer: a higher ceiling still caps a document at one call's output, and unbounded size needs an incremental tool (README section 2.3). Offered as a proposed P4 work item, not approved. Outside WI-0.2. |
| `web/node_modules` missing in `_netzer-turn-ceiling` | Run `npm --prefix web ci` before the step 7 list there. |
| Production-only hotfixes #90, #91, #168 and the rest of #170 are not ancestors of `development` | Deferred: out of scope by owner decision. **Do not promote `staging → production` until they are reconciled.** The two sides' War Room notes in `architecture-security.md` each describe their own branch: production's (#170) the route's port, the back-merge's only the slice. |
| `1124118` (Haiku id) takes effect only through a CDK deploy | A note for whoever deploys. Nothing on a `fix/*` branch deploys. |
| The approved `development.md` amendment (Gauntlet plan section 9) | Applied 2026-09-18 as `4b0ed85` on its own local branch `docs/npm-test-credential-strip` (worktree `_netzer-devmd-amend`). Not pushed. The full validation list must run there before a push. |
| The `development.md` Automated tests table is stale | Reported, not amended. The amendment needs owner approval. |
| `npm run local` dies with `spawn npm ENOENT` on Windows (`scripts/local/dev.mjs:79-80`) | Deferred to its own `fix/*` branch. |
| PDF and DOCX had never run in production (as of 2026-08-24) | Not re-checked |
| Does the model reliably *pick* `generate_document`? (open on 2026-08-24; truncation may have been hiding it) | Not re-checked |
| `memory ingest failed — "The provided model identifier is invalid."` (production, 2026-08-24) | Not re-checked |
| `webhook monitor: getWebhookInfo failed`, repeating (2026-08-24) | Not re-checked |

## Smallest next action

Start WI-0.2 CLEANUP in a fresh session from the Gauntlet handoff. Claude applies `/refactor` to the lines this work item touched and addresses the five findings in the log's section 6.2, then reruns `wi-0.2-proof.sh`.

## Related

- [README](README.md), including the [content check](README.md#4a-checking-a-branch-for-these-fixes-by-content-never-by-ancestry)
- [2026-09-18 WI-0.2 implementation log](handoffs/2026-09-18-wi02-implementation.md): the Codex build and its correction, the two defects, and the proof at `3ae63b4`
- [2026-09-18 WI-0.2 specification log](handoffs/2026-09-18-wi02-specification.md): G0, the landing of WI-0.1, the seam, the red state and the acceptance criteria
- [2026-09-18 verification log](handoffs/2026-09-18-wi01-verification.md): the PASS verdict for WI-0.1, with each criterion's command and output at `fdda55c`
- [2026-09-17 docgen-crash-wip-transfer](handoffs/2026-09-17-docgen-crash-wip-transfer.md): the parked turn-ceiling work and its two known test defects
- [knowledge-scope-fanout HANDOFF](../knowledge-scope-fanout/HANDOFF.md), which records the closed `staging → production` PR #61
- [Feature knowledge framework](../README.md)

## Session index

| Date | Session | Subject |
|---|---|---|
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
