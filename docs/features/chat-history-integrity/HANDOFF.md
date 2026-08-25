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
| Deployment state | staging deployed (image `88b5fc54c1cf`, rollout COMPLETED); production pending this hotfix |
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

Three changes, all in the chat path:

1. `repairEmptyTurns` in `src/lib/state/sessions-repo.ts`, applied in
   `getSession`.
2. `truncatedNotice` in `src/agent/agent-loop.ts`, applied to the non-tool
   return path.
3. `TOOL_LOOP_MAX_TOKENS = 8192` replacing the hard-coded `1024` at both
   tool-loop call sites.

See the [README](README.md) for what each one does and why it sits where it
does.

## Live state worth knowing

- **Chat `dashboard:1787596504860` (agent `elon-strategy`) is poisoned in
  production right now.** Its stored turn 5 is an empty assistant turn. It will
  heal by itself once change 1 is deployed; until then that chat cannot
  produce a reply. Chat `dashboard:1787588514367` showed the same user-facing
  symptom earlier the same day.
- **Production output ceiling is still 1024** until this ships. Any request
  that makes the model emit a document spec will keep truncating and keep
  poisoning its chat.

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
