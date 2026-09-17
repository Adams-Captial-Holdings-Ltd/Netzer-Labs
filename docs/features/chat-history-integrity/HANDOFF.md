---
feature: chat-history-integrity
document_role: handoff
status: current
observed_at: 2026-09-17
as_of_commit: ef0768f5dad6a02c97ac57e94fc4eb552b8ab891
---

# Chat history integrity — current state

## Where this is

| | |
|---|---|
| Branch | `wip/docgen-crash-turn-ceiling`: the unfinished work below, committed as `ef0768f` on top of `hotfix/empty-turn-poisoning` (`3bffea6`). That hotfix branch is the one that shipped; it is unchanged and on origin. |
| Based on | `production` at `7319083` |
| Next merge target | Shipped hotfix: `production` (done). WIP branch: **none decided**. Reconcile with `fix/backmerge-production-hotfixes` first; see [Work in progress](#work-in-progress-wip-branch). |
| Deployment state | **Live in production** — `DEPLOY_SHA ae62709`, Tier 2 (Pro), rollout COMPLETED, smoke test passed. Observed 2026-08-25. `origin/production` has since moved to `de244e6`, which contains `ae62709`. Live state was not re-checked on 2026-09-17 (no AWS access in that session). |
| Pushed | `hotfix/empty-turn-poisoning`: yes, at `3bffea6`. `wip/docgen-crash-turn-ceiling`: not yet at the time of writing; the coordinator pushes this branch to origin under the same name immediately after this commit as an owner-approved backup (no PR, no merge, no deploy) - confirm with `git ls-remote origin refs/heads/wip/docgen-crash-turn-ceiling` |
| PRs | [#96](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/96) into `development` (landed, promoted to staging), then [#103](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/103), [#104](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/104), [#105](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/105), [#106](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/106) into `production`. No PR for the WIP branch. |
| Work in progress | **Committed, not finished:** `ef0768f` on `wip/docgen-crash-turn-ceiling`. See [Work in progress](#work-in-progress-wip-branch). As of 2026-09-17 nothing in the `.worktrees/docgen-crash` tree is uncommitted. |
| Smallest next action | In `src/agent/agent-loop.max-tokens.test.ts`, move the `getConfig` mock into the `vi.hoisted` block, as `converseStreamTurnWithFallback` already is. Then get both new test blocks passing and run the full `npm test` in a normal (non-worktree) clone. |
| Last commands run (2026-09-17) | `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/docs-links.mjs`: OK before and after. A Node replica of the two WIP helpers passed 14 of 15 checks (below). Vitest, `tsc` and the builds were not run. |

Why hotfixes rather than a `staging -> production` promotion: production has
never carried any Paperclip code, and a full promotion would have shipped about
86,000 lines of it — Paperclip source, `vendor/paperclip`, and the 65,596-line
`tests/contract/openapi.snapshot.json` — to deliver a 59-line fix. `hotfix/*`
branches from `production` and merges to `production`, per the
[branch-to-environment mapping](../../../development.md#branch-to-environment-mapping).

**Two deploy traps, both hit in this work:**

- Production deploys are `workflow_dispatch` only and require typing `deploy`.
  The `tier` input defaults to `3`; production runs **Tier 2 (Pro)**, verified
  on the live task definition. **Always pass `tier=2`**, or the deploy silently
  re-tiers the environment as a side effect of shipping app code.
- Every hotfix PR fails the **Promotion ladder** check. `branch-guard.mjs`
  hardcodes `production: 'staging'` with no hotfix case, while `development.md`
  documents hotfix as branching from and merging to production. The two
  contradict each other. The guard calls itself "a detection control, not a
  block". Unresolved — see [Open](#open-not-addressed-here).

## What landed

Shipped across four rounds. Each round was prompted by evidence that the
previous one was incomplete.

| # | Change | File |
|---|---|---|
| 1 | `repairEmptyTurns`, applied in `getSession` — empty stored turns cannot reach Bedrock, and chats already poisoned heal on read with no migration | `src/lib/state/sessions-repo.ts` |
| 2 | `truncatedNotice` — neither return path can emit empty text; on `max_tokens` it says the reply was cut off | `src/agent/agent-loop.ts` |
| 3 | `TURN_MAX_TOKENS = 8192` replacing the hard-coded `1024`, at **all four** model call sites | `src/agent/agent-loop.ts` |
| 4 | `MAX_TOTAL_CELLS`, `MAX_CELL_LEN`, `cellText` — a build cannot kill the process or hand back a broken file | `src/lib/documents/types.ts` |
| 5 | `assertPdfRenderable` — refuses text the built-in font would render as garbage | `src/lib/documents/pdf.ts` |

**Round one** shipped 1–2 plus the ceiling on the tool loop only. Production
proved that incomplete **four minutes after deploy** — still `outputTokens:
1024, stopReason: max_tokens`. The initial streamed call passes no `maxTokens`
and falls through to `?? 1024` in `lib/bedrock/client.ts`, and for a turn that
never reaches tool use that is the only call there is.

**Round two** (#104) covered the initial call and added
`agent-loop.max-tokens.test.ts`, verified to fail when reverted.

**Round three** (#105) fixed an unrelated live defect found in the same logs:
`infra/lib/constants.ts` had `haiku: 'us.anthropic.claude-haiku-4-5'`, which is
not a valid Bedrock inference profile. It broke memory ingest and tldr
generation on **every turn**. Corrected to
`us.anthropic.claude-haiku-4-5-20251001-v1:0`, verified against the live account
with `list-inference-profiles`. Zero occurrences since deploy.

**Round four** (#106) fixed four confirmed corrupt-but-successful builds plus
two defects in round one's own code. See [README](README.md) sections 2.4–2.5.

## Live state worth knowing

These points come from production logs read on 2026-08-25. They were not re-checked
on 2026-09-17, so XLSX is still recorded as unproven.

- **PDF and DOCX now generate in production.** PDF by `main` (01:48:51, 1,612 B)
  and by `elon-strategy` (02:42:01, 4,748 B and 02:47:21, 5,011 B). DOCX by
  `main` (02:31:59, 9,843 B). Those log lines had never existed before.
- **XLSX has still never been generated in production.** It is validated
  locally (11,198 B, container and content verified) but unproven in prod.
  **This is the last outstanding item of the original bar.**
- **Zero `max_tokens` truncations since the round-two deploy**, and zero
  document-generation errors of any kind.
- **Sub-agents were never blocked.** `generate_document` sets no `allowedAgents`.
  ELON's successful PDFs used **1,934 and 2,021 output tokens** — against the
  old 1,024 ceiling it was arithmetically impossible for it to ever succeed.
  `main` only appeared to work because its two lifetime calls were toy specs.
- **Documents are capped near 10–12 pages** by the 8192-token ceiling. Larger
  requests now truncate cleanly instead of fatally.
- Chat `dashboard:1787596504860` was poisoned and heals on read. Not separately
  confirmed to have produced a successful turn post-deploy.

## Work in progress (WIP branch)

**The unfinished work is committed as `ef0768f` on `wip/docgen-crash-turn-ceiling`.**

- It was written on 2026-08-25 and left uncommitted in the worktree until
  2026-09-17. It was then committed, byte-for-byte, as an owner-approved backup
  for the machine transfer.
- It is a coherent but unfinished feature, not stray edits, and it is **not ready
  to merge**. Decide deliberately whether to finish or drop it; do not merge it
  blind.
- No dated session log was written for the 2026-08-25 work, so this section was its
  only record until the
  [2026-09-17 transfer log](handoffs/2026-09-17-docgen-crash-wip-transfer.md).
- The owner started this with a question, not a request. Ask him before finishing it.

Goal: let an operator raise the output ceiling **without a deploy**, using the
same `runtime-config` mechanism every other tunable here uses.

| Piece | State |
|---|---|
| `resolveTurnMaxTokens()` in `agent-loop.ts` — reads `runtime-config` category `agent`, key `max_output_tokens`; clamps to 1024–32768; falls back to 8192; never throws | Written, wired at all four call sites, typecheck clean |
| `trimTurnsToBudget()` in `sessions-repo.ts` — trims the stored window by bytes as well as count, dropping oldest first, keeping recent turns whole, still feeding memory ingest | Written, wired into `appendTurns`, typecheck clean |
| Tests for both | Written, **not passing**. The `getConfig` mock in `agent-loop.max-tokens.test.ts` is declared inside the `vi.mock` factory and needs hoisting into the `vi.hoisted` block, the way `converseStreamTurnWithFallback` already is. Because the test file names `getConfig` with no binding in scope, "typecheck clean" above describes the source files only. **Found 2026-09-17** (by reading the code and running a Node replica, not Vitest): a whitespace-only value resolves to 1024, not 8192, because `Number('  ')` is `0`. So one junk-input test fails even after hoisting; trim the value before checking it. In the same replica, `trimTurnsToBudget()` passed all six of its test inputs. |

**Why the byte trim is required, not optional.** `MAX_TURNS = 20` caps the turn
window by count but not by bytes. Measured at `TURN_MAX_TOKENS 8192`, twenty
maxed turns reach **284–324KB against DynamoDB's 400KB item limit** — already
about 81% consumed. `appendTurns` only retries
`ConditionalCheckFailedException`; anything else throws and the turn is lost.
So **the ceiling cannot safely be raised above 8192 until the byte trim lands.**
That, not the knob, is the real blocker on a bigger number.

Once both land, the ceiling is set with no deploy, through the dashboard config
route that already exists. The value is **global, not per-agent** — every agent,
including newly created ones, inherits it with no extra setup — and propagates
within the 30-second config cache.

**Reconcile before merging.** `fix/backmerge-production-hotfixes` is bringing this
branch's production hotfixes onto `development`; its session log is
`handoffs/2026-09-10-backmerge-production-hotfixes.md` on that branch. They include
`TURN_MAX_TOKENS` on every call and the empty-turn guard in `sessions-repo.ts`, which
are the same lines this WIP edits. Settle the order with the owner before building on
either branch.

## Open, not addressed here

| Item | Status |
|---|---|
| XLSX has never been generated in production | Unproven. Ask an agent for a spreadsheet and watch for `msg: "document generated"` with `format: xlsx`. |
| The runtime ceiling knob and byte trim | Written but unfinished. Committed on `wip/docgen-crash-turn-ceiling` as `ef0768f`. See [Work in progress](#work-in-progress-wip-branch). |
| PDF cannot render non-Latin text | It now refuses cleanly and points at DOCX. The real fix is embedding a Unicode TTF, which means shipping a font binary — a deliberate decision, not a bug fix. |
| RFP-scale documents | Not solved. 8192 tokens is roughly 10–12 pages. Needs an incremental tool (`document_start` / `document_append` / `document_finish`) so the model never emits the whole spec at once. |
| `branch-guard.mjs` contradicts `development.md` on `hotfix/* -> production` | Unresolved. Every hotfix PR here tripped it. Needs an owner decision on which document is right; gap report not yet filed. |
| `development.md` Automated tests table is stale | Reported, not amended — amendment needs owner approval. Measured on a clean clone: 192 files, 2135 tests, failures present. The table claims 178 files, 1927 tests, all passing. |
| `webhook monitor: getWebhookInfo failed`, every 2 minutes | Separate live warning, ongoing. Not investigated. |
| Test suite is flaky | Three runs of untouched `development` gave 10, 5 and 7 failing files. `audit-writer` and `durability.repro` fail under parallel load and pass in isolation. Re-run before believing any failure. |

## Session index

| Date | Session | Subject |
|---|---|---|
| 2026-09-17 | [docgen-crash-wip-transfer](handoffs/2026-09-17-docgen-crash-wip-transfer.md) | Machine transfer. Committed the uncommitted 2026-08-25 turn-ceiling work as a backup (`ef0768f`, `wip/docgen-crash-turn-ceiling`); the 2026-08-25 work had no session log of its own. Found a second test defect (whitespace value), and recorded the overlap with the back-merge. |
| 2026-08-24 | [empty-turn-poisoning](handoffs/2026-08-24-empty-turn-poisoning.md) | Diagnosed the `max_tokens` → empty turn → dead chat chain from production logs and a live reproduction; shipped the guards above across four rounds; found and fixed the invalid Haiku model id; left the runtime ceiling knob unfinished. |
