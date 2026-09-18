---
feature: chat-history-integrity
document_role: handoff
status: current
observed_at: 2026-09-17
as_of_commit: a4bad74326bfe00d5c20441424f5c0411c8bf494
---

# Chat history integrity — current state

## Where this is

| | |
|---|---|
| Branch | `fix/backmerge-production-hotfixes`: the back-merge of production hotfix PRs #103–#106 |
| Based on | `development` at `271339bc8b2feea85e6c31b115fdd34e757a72e2`, plus two docs-only commits (the session logs below) |
| Next merge target | `development` |
| Deployment state | **This branch deploys nothing.** Production (`de244e6`, deployed 2026-09-09) runs the hotfixes. `development` and `staging` do not. |
| Pushed | Not yet at the time of writing. The coordinator pushes this branch to origin under the same name immediately after this commit, as an owner-approved backup (no PR, no merge, no deploy). Confirm with `git ls-remote origin refs/heads/fix/backmerge-production-hotfixes`. |
| PR | None for the back-merge yet. The original fix, [#96](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/96), is on `development` and `staging` as `9d72979`. |

Staging is reachable only by the promotion chain `development → qa → staging`. Each step is its own pull request, because `scripts/ci/deploy-source-guard.mjs` refuses any staging deploy whose ref is not `refs/heads/staging`. Nothing on a `fix/*` branch reaches an AWS environment.

## Current objective

Back-merge the nine commits of production hotfix PRs #103–#106 into `development` by cherry-pick, reconciled with `9d72979`. The owner decided on 2026-09-11 to take the four fixes only:

- `8c14b3f`: the empty-turn guard;
- `1abba67`: `TURN_MAX_TOKENS` on every model call, including the initial one;
- `1124118`: the Haiku model id with its version suffix;
- `d828124`: a document build must not hand back a broken file.

**Status: not started.**

- **The loop.** The claudex plan-review loop stopped after round 1. Codex returned REVISE with findings BR-001..BR-003, and the host accepted all three. The revisions are scripted but not applied, and round 2 was never sent. The loop was interrupted, not closed.
- **The picks.** None has been applied.
- **Downstream.** This back-merge blocks WI-2 to WI-9 of the bedrock-all-models campaign.

## Live state worth knowing

- **Development and staging still lack the four fixes.**
  - This was checked on 2026-09-17 against a fetch of 2026-09-16 10:04, which saw `origin/development` = `271339b` and `origin/staging` = `8299f04`.
  - On those branches the initial `converseStreamTurnWithFallback` call (`src/agent/agent-loop.ts:1008`) passes no `maxTokens`. So `src/lib/bedrock/client.ts:273` falls back to 1024, and a real document reply truncates.
- **The 2026-09-11 baseline on `271339b`** (details in the session log):
  - `npm run typecheck` died out of memory (exit 134), so typecheck has no valid baseline yet.
  - `npm test`: 6 of 243 files red.
  - `npm run local:test:integration`: 1 of 11 files red.
  - `node scripts/ci/docs-assets.mjs` fails on a 2.3 MB diagram.
  - build, web typecheck and web build all pass.
- **RED-1 behaved as predicted.** Production's `agent-loop.max-tokens.test.ts` fails 2 of 2 against development, on the maxTokens assertions.
- **Chat `dashboard:1787596504860` (agent `elon-strategy`)** was poisoned in production on 2026-08-24. It has not been re-checked since production received the empty-turn repair (`8c14b3f`, #103).

## Content check: use it instead of ancestry

Cherry-picked commits never become ancestors. After the back-merge lands, `git merge-base --is-ancestor` and `git cherry` will still report these fixes as missing. Verify by content instead. On the merged tree:

- `git grep -n TOOL_LOOP_MAX_TOKENS -- src infra` prints nothing and exits 1. Keep the path scope: docs mention the old name even on production;
- every model call in `runAgentTurn` passes `maxTokens: TURN_MAX_TOKENS`;
- `infra/lib/constants.ts` has `claude-haiku-4-5-20251001-v1:0`;
- `assertPdfRenderable` exists in `src/lib/documents/pdf.ts`;
- these four test files pass: `src/agent/agent-loop.max-tokens.test.ts`, `src/agent/agent-loop.history.test.ts`, `src/lib/state/sessions-repo.persistence.test.ts` and `src/lib/documents/builders.test.ts`.

At `271339b`, every one of these code checks fails.

## Blockers and open items

| Item | Status |
|---|---|
| Round-1 revisions not applied to the plan | Open. Apply `revise-plan-r1.mjs`, scope BR-003's grep to code (ledger M20), then send round 2. |
| `npm run typecheck` has no valid baseline (out of memory) | Open. Re-run it alone on a quiet machine. |
| Which identity commits the picks (`e.adams@personalgrowthcs.com` in the plan, or the transfer's `emmanuelmadams4@gmail.com`) | Open. Ask the owner. |
| The push and PR authorization was given to the 2026-09-11 session | Re-confirm with the owner before pushing the finished back-merge. |
| Production-only hotfixes #90, #91, #168 and #170 are not ancestors of `development` | Deferred: out of scope by owner decision. **Do not promote `staging → production` until they are reconciled.** |
| `npm run local` dies with `spawn npm ENOENT` on Windows (`scripts/local/dev.mjs:79-80`) | Deferred to its own `fix/*` branch. Use `npm run dev` plus `npm --prefix web run dev` instead. |
| `1124118` (Haiku id) takes effect only through a CDK deploy | A note for whoever deploys. This branch deploys nothing. |
| PDF and DOCX had never run in production (as of 2026-08-24) | Not re-checked |
| Does the model reliably *pick* `generate_document`? (open on 2026-08-24; truncation may have been hiding it) | Not re-checked |
| `memory ingest failed — "The provided model identifier is invalid."` (production, 2026-08-24) | Not re-checked |
| `webhook monitor: getWebhookInfo failed`, repeating (2026-08-24) | Not re-checked |
| The `development.md` Automated tests table is stale | Reported, not amended. The amendment needs owner approval. |

## Smallest next action

On the new machine, re-run the baseline on a fresh clone of `fix/backmerge-production-hotfixes`. Then resume the claudex loop at round 2 with the round-1 revisions applied, and continue the cherry-pick sequence. See section 6.1 of the [2026-09-17 session log](handoffs/2026-09-17-backmerge-machine-transfer.md#61-smallest-next-action).

## Related

- [README](README.md)
- [2026-09-17 session log](handoffs/2026-09-17-backmerge-machine-transfer.md), which embeds the back-merge plan, records the loop state, and quotes the two deferred follow-up tasks
- [knowledge-scope-fanout HANDOFF](../knowledge-scope-fanout/HANDOFF.md), which records the closed `staging → production` PR #61
- [Feature knowledge framework](../README.md)

## Session index

| Date | Session | Subject |
|---|---|---|
| 2026-09-17 | [backmerge-machine-transfer](handoffs/2026-09-17-backmerge-machine-transfer.md) | Landed the 09-10 log. Recorded the interrupted claudex loop (round 1 REVISE, baseline, RED-1). Re-verified that the fixes are still missing from development, and parked the back-merge for the machine transfer. |
| 2026-09-17 | [docgen-crash-wip-transfer](handoffs/2026-09-17-docgen-crash-wip-transfer.md) | Parked the 2026-08-25 turn-ceiling work in progress (resolveTurnMaxTokens / trimTurnsToBudget, tests not passing) on `wip/docgen-crash-turn-ceiling`; reconcile with the back-merge before merging. |
| 2026-09-10 | [backmerge-production-hotfixes](handoffs/2026-09-10-backmerge-production-hotfixes.md) | Opened the back-merge of #103–#106 on a fresh clone at `271339b`. Scoped it to the nine commits and recorded the plan. Nothing applied. |
| 2026-08-24 | [empty-turn-poisoning](handoffs/2026-08-24-empty-turn-poisoning.md) | Diagnosed the max_tokens → empty turn → dead chat chain from production logs, and shipped the three guards of #96. |
