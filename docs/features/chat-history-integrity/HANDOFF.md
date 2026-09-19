---
feature: chat-history-integrity
document_role: handoff
status: current
observed_at: 2026-09-18
as_of_commit: b7990c777bbf912a2918337e2c1bba77d6e258d9
---

# Chat history integrity — current state

## Where this is

| | |
|---|---|
| Branch | `fix/backmerge-production-hotfixes`: the back-merge of production hotfix PRs #103–#106, plus the `toPdfSafeText`/422 slice of #170 |
| Based on | `development` at `9e8e42b3ba772bd4ec23a8290f829fa12f3fc8e5` (rebased 2026-09-18), plus two local test-only commits and one docs commit |
| Next merge target | `development` |
| Deployment state | **This branch deploys nothing.** Production (`de244e6`, deployed 2026-09-09) runs the hotfixes. `development` and `staging` do not. |
| Pushed | **No.** `origin/fix/backmerge-production-hotfixes` is still the 2026-09-17 backup at `9e832da`. The local branch was rebased, so the next push is a force-push and needs the owner's explicit authorization. |
| PR | None for the back-merge yet. The original fix, [#96](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/96), is on `development` and `staging` as `9d72979`. |

Staging is reachable only by the promotion chain `development → qa → staging`. Each step is its own pull request, because `scripts/ci/deploy-source-guard.mjs` refuses any staging deploy whose ref is not `refs/heads/staging`. Nothing on a `fix/*` branch reaches an AWS environment.

## Current objective

Back-merge the nine commits of #103–#106 into `development` by `git cherry-pick -x`, reconciled with `9d72979`, plus only the `toPdfSafeText` + 422 slice of #170 (`4765612`, not its scroll UI). Owner scope, 2026-09-18:

- `8c14b3f`: the empty-turn guard (already on development as `9d72979`: same `src` patch-id);
- `1abba67`: `TURN_MAX_TOKENS` on every model call, including the initial one;
- `1124118`: the Haiku model id with its version suffix;
- `d828124`: a document build must not hand back a broken file;
- the #170 slice, because `d828124`'s guard would otherwise make development's War Room transcript export 500.

**Status: specified, not implemented.** Baseline recorded and the red state committed (2026-09-18). The implementation runs next, from a Gauntlet handoff.

## Live state worth knowing

- **Baseline on `9e8e42b`, credentials stripped (2026-09-18):** typecheck, `npm test` (244 files, 3174 tests, twice), build, web typecheck, web build and the docs gates all exit 0. `npm run local:test:integration` fails only the documented `destroy.integration.test.ts` Floci gap.
- **Red state at `b7990c7`:** `agent-loop.max-tokens.test.ts` 0/2, `builders.test.ts` 15/28, `sessions-repo.persistence.test.ts` 11/14, `warroom-transcript.test.ts` 6/7, `npm run typecheck` exit 2 (three missing exports). `agent-loop.history.test.ts` 7/7 already.
- **Development's War Room PDF export garbles emoji with a 200** (`Ship it Ø=Þ€ done '`). With `d828124`'s guard alone it would 500.
- **Chat `dashboard:1787596504860` (agent `elon-strategy`)** was poisoned in production on 2026-08-24. It has not been re-checked since production received the empty-turn repair (`8c14b3f`, #103).

## Content check: use it instead of ancestry

Cherry-picked commits never become ancestors. After the back-merge lands, `git merge-base --is-ancestor` and `git cherry` will still report these fixes as missing. Verify by content instead. On the merged tree:

- `git grep -n TOOL_LOOP_MAX_TOKENS -- src infra` prints nothing and exits 1. Keep the path scope: docs mention the old name even on production;
- `src/agent/agent-loop.ts` has `maxTokens: TURN_MAX_TOKENS` five times, covering all three model calls in `runAgentTurn`;
- `infra/lib/constants.ts` has `claude-haiku-4-5-20251001-v1:0`;
- `src/lib/documents/pdf.ts` exports `assertPdfRenderable` and `toPdfSafeText`;
- exactly one `function repairEmptyTurns` exists (`src/lib/state/sessions-repo.ts`);
- these five test files pass: `src/agent/agent-loop.max-tokens.test.ts`, `src/agent/agent-loop.history.test.ts`, `src/lib/state/sessions-repo.persistence.test.ts`, `src/lib/documents/builders.test.ts` and `src/adapters/dashboard/warroom-transcript.test.ts`.

At `b7990c7`, every code check fails except the single `repairEmptyTurns` definition.

## Blockers and open items

| Item | Status |
|---|---|
| Push and PR authorization | Not given for this work. The push is a force-push over the `9e832da` backup. Ask the owner. |
| Production-only hotfixes #90, #91, #168 and the rest of #170 are not ancestors of `development` | Deferred: out of scope by owner decision. **Do not promote `staging → production` until they are reconciled.** |
| `1124118` (Haiku id) takes effect only through a CDK deploy | A note for whoever deploys. This branch deploys nothing. |
| The approved `development.md` amendment (Gauntlet plan section 9) | Approved 2026-09-18, not applied. Re-confirm in the applying session; its own docs-only branch off `development`. |
| The `development.md` Automated tests table is stale | Reported, not amended. The amendment needs owner approval. |
| `npm run local` dies with `spawn npm ENOENT` on Windows (`scripts/local/dev.mjs:79-80`) | Deferred to its own `fix/*` branch. |
| PDF and DOCX had never run in production (as of 2026-08-24) | Not re-checked |
| Does the model reliably *pick* `generate_document`? (open on 2026-08-24; truncation may have been hiding it) | Not re-checked |
| `memory ingest failed — "The provided model identifier is invalid."` (production, 2026-08-24) | Not re-checked |
| `webhook monitor: getWebhookInfo failed`, repeating (2026-08-24) | Not re-checked |

## Smallest next action

Run the WI-0.1 implementation from the Gauntlet `DIRECT_COORDINATOR / IMPLEMENTATION` handoff, following the conflict map in section 3.1 of the [2026-09-18 session log](handoffs/2026-09-18-wi01-specification.md#31-architecture-notes-discovered-this-session).

## Related

- [README](README.md)
- [2026-09-18 session log](handoffs/2026-09-18-wi01-specification.md): baseline, red state, conflict map, target blobs
- [knowledge-scope-fanout HANDOFF](../knowledge-scope-fanout/HANDOFF.md), which records the closed `staging → production` PR #61
- [Feature knowledge framework](../README.md)

## Session index

| Date | Session | Subject |
|---|---|---|
| 2026-09-18 | [wi01-specification](handoffs/2026-09-18-wi01-specification.md) | Rebased onto `9e8e42b`, recorded a green baseline, committed the red state (production's tests + one War Room substitution test), and mapped every pick's conflicts. Nothing applied. |
| 2026-09-17 | [backmerge-machine-transfer](handoffs/2026-09-17-backmerge-machine-transfer.md) | Landed the 09-10 log. Recorded the interrupted claudex loop (round 1 REVISE, baseline, RED-1). Re-verified that the fixes are still missing from development, and parked the back-merge for the machine transfer. |
| 2026-09-17 | [docgen-crash-wip-transfer](handoffs/2026-09-17-docgen-crash-wip-transfer.md) | Parked the 2026-08-25 turn-ceiling work in progress (resolveTurnMaxTokens / trimTurnsToBudget, tests not passing) on `wip/docgen-crash-turn-ceiling`; reconcile with the back-merge before merging. |
| 2026-09-10 | [backmerge-production-hotfixes](handoffs/2026-09-10-backmerge-production-hotfixes.md) | Opened the back-merge of #103–#106 on a fresh clone at `271339b`. Scoped it to the nine commits and recorded the plan. Nothing applied. |
| 2026-08-24 | [empty-turn-poisoning](handoffs/2026-08-24-empty-turn-poisoning.md) | Diagnosed the max_tokens → empty turn → dead chat chain from production logs, and shipped the three guards of #96. |
