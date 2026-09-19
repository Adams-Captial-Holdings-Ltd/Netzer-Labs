---
feature: chat-history-integrity
document_role: handoff
status: current
observed_at: 2026-09-18
as_of_commit: 6d43213faf913fa61aca202bfe924fd99a6a5eca
---

# Chat history integrity — current state

## Where this is

| | |
|---|---|
| Branch | `fix/backmerge-production-hotfixes`: the back-merge of production hotfix PRs #103–#106, plus the `toPdfSafeText`/422 slice of #170 |
| Based on | `development` at `9e8e42b3ba772bd4ec23a8290f829fa12f3fc8e5` (rebased 2026-09-18), plus two test-only commits, two docs commits, nine `-x` picks, two implementation commits and one docs commit |
| Next merge target | `development` |
| Deployment state | **This branch deploys nothing.** Production (`de244e6`, deployed 2026-09-09) runs the hotfixes. `development` and `staging` do not. |
| Pushed | **No.** `origin/fix/backmerge-production-hotfixes` is still the 2026-09-17 backup at `9e832da`. The local branch was rebased, so the next push is a force-push and needs the owner's explicit authorization. |
| PR | None for the back-merge yet. The original fix, [#96](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/96), is on `development` and `staging` as `9d72979`. |

Staging is reachable only by the promotion chain `development → qa → staging`. Each step is its own pull request, because `scripts/ci/deploy-source-guard.mjs` refuses any staging deploy whose ref is not `refs/heads/staging`. Nothing on a `fix/*` branch reaches an AWS environment.

## Current objective

WI-0.1: back-merge the nine commits of #103–#106 into `development` by `git cherry-pick -x`, reconciled with `9d72979`, plus only the `toPdfSafeText` + 422 slice of #170 (`4765612`, not its scroll UI). Owner scope, 2026-09-18.

**Status: implemented, not yet cleaned up or independently verified.** The picks are `81c9d0e`…`246bd2b`. `020fad8` is the #170 slice and `6d43213` the diagram notes, both written by Codex `gpt-5.6-terra`, inspected and proved by Claude. CLEANUP runs next, then VERIFICATION, each in a fresh session.

## Live state worth knowing

- **Proof at `6d43213`, credentials stripped (2026-09-18):** the five target test files pass (58/58). Every content check in [README section 4a](README.md#4a-checking-a-branch-for-these-fixes-by-content-never-by-ancestry) passes. `pdf.ts`, `types.ts`, `sessions-repo.ts` and the four ported tests equal production's blobs.
- **Full validation at `6d43213`:** typecheck, `npm test` (245 files, 3196 tests), build, web typecheck, web build, `local:verify`, docs-links, feature-knowledge, docs-assets, PR-context diagrams-drift and `git diff --check` all exit 0. `local:test:integration` fails only the documented `destroy.integration.test.ts` Floci gap, as on the baseline.
- **Baseline on `9e8e42b`:** green except the same Floci gap (244 files, 3174 tests).
- **BR-002 dry-run:** production + HEAD has 9 conflicted files (14 before the picks). Staging + HEAD is conflict-free.
- **Chat `dashboard:1787596504860` (agent `elon-strategy`)** was poisoned in production on 2026-08-24. It has not been re-checked since production received the empty-turn repair (`8c14b3f`, #103).

## Blockers and open items

| Item | Status |
|---|---|
| Push and PR authorization | Not given for this work. The push is a force-push over the `9e832da` backup. Ask the owner. |
| Authorship of the nine picks | They keep their original author, `e.adams@personalgrowthcs.com`, and name `emmanuelmadams4@gmail.com` as committer. Owner to confirm before the first push. |
| Production-only hotfixes #90, #91, #168 and the rest of #170 are not ancestors of `development` | Deferred: out of scope by owner decision. **Do not promote `staging → production` until they are reconciled.** |
| `1124118` (Haiku id) takes effect only through a CDK deploy | A note for whoever deploys. This branch deploys nothing. |
| The approved `development.md` amendment (Gauntlet plan section 9) | Applied 2026-09-18 as `4b0ed85` on its own local branch `docs/npm-test-credential-strip` (worktree `_netzer-devmd-amend`). Not pushed. The full validation list must run there before a push. |
| The `development.md` Automated tests table is stale | Reported, not amended. The amendment needs owner approval. |
| `npm run local` dies with `spawn npm ENOENT` on Windows (`scripts/local/dev.mjs:79-80`) | Deferred to its own `fix/*` branch. |
| PDF and DOCX had never run in production (as of 2026-08-24) | Not re-checked |
| Does the model reliably *pick* `generate_document`? (open on 2026-08-24; truncation may have been hiding it) | Not re-checked |
| `memory ingest failed — "The provided model identifier is invalid."` (production, 2026-08-24) | Not re-checked |
| `webhook monitor: getWebhookInfo failed`, repeating (2026-08-24) | Not re-checked |

## Smallest next action

Run the WI-0.1 CLEANUP phase from the Gauntlet `DIRECT_COORDINATOR / CLEANUP` handoff, in a fresh session.

## Related

- [README](README.md), including the [content check](README.md#4a-checking-a-branch-for-these-fixes-by-content-never-by-ancestry)
- [2026-09-18 implementation log](handoffs/2026-09-18-wi01-implementation.md): picks, the Codex call, every proof result
- [knowledge-scope-fanout HANDOFF](../knowledge-scope-fanout/HANDOFF.md), which records the closed `staging → production` PR #61
- [Feature knowledge framework](../README.md)

## Session index

| Date | Session | Subject |
|---|---|---|
| 2026-09-18 | [wi01-implementation](handoffs/2026-09-18-wi01-implementation.md) | Applied the nine picks with `-x` (five resolved empty). Codex `gpt-5.6-terra` wrote the #170 slice and the diagram notes, and Claude inspected and proved them. Every content check passes; full validation matches the baseline. Applied the approved `development.md` amendment on its own branch. |
| 2026-09-18 | [wi01-specification](handoffs/2026-09-18-wi01-specification.md) | Rebased onto `9e8e42b`, recorded a green baseline, committed the red state (production's tests + one War Room substitution test), and mapped every pick's conflicts. Nothing applied. |
| 2026-09-17 | [backmerge-machine-transfer](handoffs/2026-09-17-backmerge-machine-transfer.md) | Landed the 09-10 log. Recorded the interrupted claudex loop (round 1 REVISE, baseline, RED-1). Re-verified that the fixes are still missing from development, and parked the back-merge for the machine transfer. |
| 2026-09-17 | [docgen-crash-wip-transfer](handoffs/2026-09-17-docgen-crash-wip-transfer.md) | Parked the 2026-08-25 turn-ceiling work in progress (resolveTurnMaxTokens / trimTurnsToBudget, tests not passing) on `wip/docgen-crash-turn-ceiling`; reconcile with the back-merge before merging. |
| 2026-09-10 | [backmerge-production-hotfixes](handoffs/2026-09-10-backmerge-production-hotfixes.md) | Opened the back-merge of #103–#106 on a fresh clone at `271339b`. Scoped it to the nine commits and recorded the plan. Nothing applied. |
| 2026-08-24 | [empty-turn-poisoning](handoffs/2026-08-24-empty-turn-poisoning.md) | Diagnosed the max_tokens → empty turn → dead chat chain from production logs, and shipped the three guards of #96. |
