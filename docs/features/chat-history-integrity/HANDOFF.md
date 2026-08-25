---
feature: chat-history-integrity
document_role: handoff
status: current
observed_at: 2026-08-24
as_of_commit: f64d1e04b2d85853752e393b310ef243460958dd
---

# Chat history integrity — current state

## Where this is

| | |
|---|---|
| Branch | `hotfix/empty-turn-poisoning` |
| Based on | `production` at `7319083` |
| Next merge target | `production` |
| Deployment state | **Live in production** — `DEPLOY_SHA 8c6a244`, task def `claudeclaw-orchestrator:11`, Tier 2 (Pro), 3/3 tasks, rollout COMPLETED. Staging on `88b5fc54c1cf`. |
| Pushed | yes |
| PR | [#96](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/96) into `development` (landed, promoted to staging); this hotfix into `production` |

Why a hotfix rather than a `staging -> production` promotion: production has
never carried any Paperclip code, and the full promotion would have shipped
about 86,000 lines of it — Paperclip source, `vendor/paperclip`, and the 65,596
line `tests/contract/openapi.snapshot.json` — to deliver a 59-line fix.
`hotfix/*` branches from `production` and merges to `production`, per the
[branch-to-environment mapping](../../../development.md#branch-to-environment-mapping),
and carries only the two source files plus their tests and these docs.

Production deploys are `workflow_dispatch` only and require typing `deploy`.
The `tier` input defaults to `3`; production runs **Tier 2 (Pro)**, verified on
the live task definition, so the dispatch must pass `tier=2` or it would
silently re-tier the environment.

## What landed

Four changes, all in the chat path, shipped in two rounds:

1. `repairEmptyTurns` in `src/lib/state/sessions-repo.ts`, applied in
   `getSession`.
2. `truncatedNotice` in `src/agent/agent-loop.ts`, applied to the non-tool
   return path.
3. `TURN_MAX_TOKENS = 8192` replacing the hard-coded `1024` — **at all four
   model call sites**, including the initial streamed call.
4. `src/agent/agent-loop.max-tokens.test.ts`, which pins the initial call and
   was verified to fail when the fix is reverted.

Round one shipped 1–3 but applied the ceiling to the tool loop only. Production
proved that incomplete four minutes after deploy — still `outputTokens: 1024,
stopReason: max_tokens`. Round two (PR #104) covered the initial call and added
the test. See the [README](README.md) for what each one does and why.

## Live state worth knowing

- **One PDF has now been generated in production** — 2026-08-24 01:48:51, 1,612
  bytes, 138 ms, chat `dashboard:1787622506151`, agent `main`. That log line
  (`msg: "document generated"`, `format: pdf`) had never existed before.
- **DOCX and XLSX have still never been generated in production.** Proving those
  two is the last outstanding item of the original bar.
- Chat `dashboard:1787596504860` was poisoned and should now heal on read.
  Whether it has actually produced a successful turn since the deploy was not
  confirmed at the time of writing.
- **Documents are still capped at roughly 10–12 pages** by the 8192-token
  ceiling. Larger requests truncate cleanly rather than fatally.

## Open, not addressed here

| Item | Status |
|---|---|
| PDF and DOCX have never run in production, ever | Unproven. 90 days of logs contain 2 `generate_document` calls, both `xlsx`. |
| Does the model reliably *pick* `generate_document`? | Open. In the reproduced incident it never called the tool — but it was being truncated before it could, so this may resolve itself with change 3. Re-check after deploy. |
| `memory ingest failed — "The provided model identifier is invalid."` | Separate live defect, seen in production 2026-08-24. Not investigated. |
| `webhook monitor: getWebhookInfo failed` repeating every 2 minutes | Separate live warning, ongoing for hours. Not investigated. |
| `development.md` Automated tests table is stale | Reported, not amended — amendment needs owner approval. See session log. |

## Session index

| Date | Session | Subject |
|---|---|---|
| 2026-08-24 | [empty-turn-poisoning](handoffs/2026-08-24-empty-turn-poisoning.md) | Diagnosed the max_tokens → empty turn → dead chat chain from production logs; shipped the three guards above. |
