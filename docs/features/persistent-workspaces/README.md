---
feature: persistent-workspaces
document_role: index
status: current
observed_at: 2026-08-13
as_of_commit: 73383d0e0c0f06aa8010f5e0d4d246dfe7740e97
implemented_by:
  - src/lib/tools/document-generation-tools.ts
  - src/lib/tools/registry.ts
  - src/lib/state/sessions-repo.ts
  - src/adapters/dashboard/handler.ts
  - web/src/pages/Chat.tsx
tested_by:
  - src/lib/tools/document-generation-tools.test.ts
  - src/lib/state/sessions-repo.persistence.test.ts
  - src/lib/state/sessions-repo.integration.test.ts
decisions:
  - docs/adr/0002-single-tenant.md
  - docs/adr/0009-mission-container-model.md
---

# Persistent agent workspaces

## 1. Start Here

This feature makes agent conversations survive across sessions and makes the
files agents generate durable, listable and downloadable — the "reopen it two
days later and ask for a change" loop.

Read in this order:

1. This README — what is true now and what is being built.
2. [HANDOFF.md](HANDOFF.md) — branch, commands actually run, next action.
3. [ADR 0002](../../adr/0002-single-tenant.md) and
   [ADR 0009](../../adr/0009-mission-container-model.md) — the two accepted
   decisions that constrain the data model.

Source code is the ultimate truth for present behavior. Where this document and
the implementation disagree, the code wins.

## 2. What persistent-workspaces does today

**Dashboard conversations persist and can be reopened. Generated documents are
delivered reliably.** What is still missing is durable *artifact* storage.

Working now:

- **Dashboard conversations never expire.** `appendTurns` omits the `ttl`
  attribute entirely for chats whose id starts with `dashboard:`; DynamoDB TTL
  only deletes items that carry the attribute. All three write paths honour this
  (`appendTurns`, `setModelOverride`, `clearSession`) — missing any one would
  silently re-arm the expiry.
- **Telegram and Slack sessions still expire after 7 days**, deliberately.
  Neither surface can browse history, so a permanent row there is storage growth
  and an unasked-for retention change.
- **The Chat tab lists prior conversations and reopens them.** The sidebar reads
  `GET /api/sessions?agentId=` (a single Query on `PK=AGENT#<id>`), titles each
  row by `firstMessage`, and replays turns from
  `GET /api/sessions/transcript`. The active `chatId` is kept in
  `sessionStorage`, so a reload resumes instead of silently abandoning the
  conversation. No new endpoint was added — both already existed.
- **Generated documents ride the `ToolMedia` channel**, so the download link
  never passes through the model. Dashboard renders a download card; Slack
  uploads the file natively.

Explicitly **not** yet:

- Conversations keep only the **20 most recent turns** (`MAX_TURNS`). Reopening
  an old conversation shows at most 20 turns, not the whole history. Earlier
  turns are distilled into durable memory, not retained verbatim.
- **Artifacts are still not durable.** Documents land in `RAW_BUCKET` under
  `generations/<chatId>/<uuid>.<ext>` with a 24h presigned URL, no database
  record, no list route, and no download route. `RAW_BUCKET` has **no
  versioning** and a hard **365-day expiration lifecycle**.
- **No PPTX support** anywhere in the repository.
- No conversation search, rename, pin or archive.
- The sidebar is dashboard-only. Telegram and Slack have no history UI to mirror
  it into — noted here rather than silently omitted, per the parity rule in
  [CLAUDE.md](../../../CLAUDE.md).

### Known defect this feature fixes

`generate_document` returns its presigned URL only as **text**, which is placed
in the model's context and reproduced by the model in its own reply
(`src/lib/tools/document-generation-tools.ts`). A signed S3 URL does not
reliably survive that round trip — an observed production `.xlsx` link arrived
with the entire `X-Amz-*` query string missing and returned S3 `AccessDenied`,
which is correct behavior for an unsigned GET against a
`BlockPublicAccess.BLOCK_ALL` bucket.

`generate_image` does **not** have this problem because it also returns
`media: [{ kind: 'image', ..., presignedUrl }]`, and each surface delivers from
that channel without the URL passing through the model
(`src/lib/tools/nova-canvas-tools.ts`). Documents have no such channel.

### What it is not

Not a workspace or project hierarchy — per [ADR 0009](../../adr/0009-mission-container-model.md)
the conversation is the container. Not multi-tenant — per
[ADR 0002](../../adr/0002-single-tenant.md) isolation is at the AWS-account
level. Not a code sandbox: there is no code execution path in this repository
and none is being added.

## 3. Current status and current source commit

Source evidence only, verified against `73383d0e0c0f06aa8010f5e0d4d246dfe7740e97`
on 2026-08-13. **No deployment evidence** — nothing from this feature has been
deployed, and the defect above was observed in the running production
environment, not reproduced locally.

The conversation-persistence claims are stronger than source evidence alone:
`sessions-repo.integration.test.ts` proves against a real DynamoDB that a
dashboard row carries no `ttl` attribute after `appendTurns`, `setModelOverride`
and `clearSession`, that a bot row still does, and that a pre-existing `ttl` on
a dashboard row is stripped on the next write.

Local reproduction of the agent tool path is **not possible**: Floci's Bedrock
stub always returns `stopReason: 'end_turn'`, so the tool-dispatch loop never
runs on a developer machine (see
[Known local limitations](../../../development.md#known-local-limitations)).
Builders and repositories are therefore tested directly, and the agent-driven
flow must be verified in staging.

## 4. Source of truth

| Concern | Authority | Use it for |
|---|---|---|
| Document generation | [document-generation-tools.ts](../../../src/lib/tools/document-generation-tools.ts) | Present tool behavior, gating, storage key |
| Media delivery contract | [registry.ts](../../../src/lib/tools/registry.ts) | `ToolMedia` / `ToolResult` shape |
| Conversation storage | [sessions-repo.ts](../../../src/lib/state/sessions-repo.ts) | Key schema, TTL, turn window, ingest cadence |
| Dashboard API + SSE | [handler.ts](../../../src/adapters/dashboard/handler.ts) | Routes, auth gates, SSE event names |
| Tenancy | [ADR 0002](../../adr/0002-single-tenant.md) | Why there is no `tenantId` |
| Work containers | [ADR 0009](../../adr/0009-mission-container-model.md) | Why there is no Workspace entity |
| Local limits | [development.md](../../../development.md) | What can and cannot be verified locally |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, commands, next action |

## 5. Implementation map

| Area | Verified location | Present behavior |
|---|---|---|
| Document build | `src/lib/documents/{pdf,docx,xlsx}.ts` | `pdfkit` / `docx` / `exceljs` produce bytes from a validated spec |
| Spec validation | `src/lib/documents/types.ts` | `validateDocumentSpec`, `validateSpreadsheetSpec` throw on malformed input |
| Tool + storage | `src/lib/tools/document-generation-tools.ts` | Kill switch, fail-closed cost cap, S3 PUT to `RAW_BUCKET`, 24h presign, audit row |
| Media channel | `src/lib/tools/registry.ts` | `ToolMedia.kind` is `'image' \| 'artifact'` |
| Image delivery (reference pattern) | `src/lib/tools/nova-canvas-tools.ts` | Returns `media[]`; surfaces deliver bytes, URL in text is a fallback |
| Surface delivery | `src/adapters/telegram/handler.ts`, `src/adapters/slack/handler.ts`, `src/adapters/dashboard/handler.ts` | Slack uploads both kinds natively; dashboard emits `image` or `artifact` SSE; Telegram skips artifacts (no `sendDocument` helper) |
| Conversation persistence | `src/lib/state/sessions-repo.ts` | `isPersistentChat` — dashboard chats omit `ttl`; all three write paths honour it |
| Conversation storage | `src/lib/state/sessions-repo.ts` | 20-turn window, `decideIngest` distillation backstop |
| Conversation read API | `src/adapters/dashboard/handler.ts` | `GET /api/sessions`, `GET /api/sessions/transcript` — both pre-existing, unchanged |
| Chat UI | `web/src/pages/Chat.tsx` | Conversation sidebar, resume-on-select, `chatId` persisted to `sessionStorage`, artifact download card |

## 6. Current business/state rules

Rules the code enforces today and that this feature must preserve:

- Document generation is refused when the `document_gen_disabled` kill switch is
  active, when `RAW_BUCKET` is unset, or when the daily cost cap is reached.
  A **spend total that cannot be determined fails closed** — the call is refused
  rather than allowed on a partial figure.
- Every generation writes an audit row (`action: 'tool_invoke'`).
- The S3 key is derived server-side from `ctx.chatId`, sanitized
  `[^A-Za-z0-9_-] → _`. **The model never supplies a storage key.**
- At most 4 media items are attached per turn (`MAX_TURN_MEDIA`).
- Guardrail-blocked exchanges are never persisted to the session.
- Sessions are keyed per `(agentId, chatId)`; the sessions table is the only
  place conversation turns live.
- **A chat persists iff its id starts with `dashboard:`** (`isPersistentChat`).
  Persisting means the `ttl` attribute is **absent**, because DynamoDB TTL only
  deletes items that carry it. Every write path must honour this — three do
  (`appendTurns`, `setModelOverride`, `clearSession`), and a fourth that
  refreshed the TTL would silently re-arm expiry on a visible conversation.
- The conversation sidebar lists **only** `dashboard:`-prefixed chats. Bot rows
  share the table but have no UI to reopen them.
- Conversation history is capped at 20 turns per `MAX_TURNS`; persistence does
  not widen that window.

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| Generated documents expire silently | `RAW_BUCKET` 365-day expiration lifecycle, no versioning, no DB record | Store artifacts in `CURATED_BUCKET` (versioned, no expiry) (M2) |
| Reopened conversations show at most 20 turns | `MAX_TURNS` in `sessions-repo.ts` | Accepted for now; full transcript retention is the strongest follow-up |
| Conversations are org-visible, not per-user | `GET /api/sessions` without `agentId` Scans and returns every user's sessions to any `sessions:read` holder; the sidebar filters client-side only | Product decision required before artifacts become durable (M2) |
| Persistent conversations grow storage without bound | No archive, no retention policy, no per-user quota | Revisit if a customer raises retention or cost |
| `forget_me` does not erase generated documents | `src/lib/tools/privacy-tools.ts` has no artifact path | Extend erasure to the artifact prefix (M2) |
| Bot surfaces cannot deliver non-image media | Telegram `sendPhoto` hardcodes `filename: 'image.png'`; no `sendDocument` helper exists | Deferred; skipped explicitly at the call site per the parity rule in [CLAUDE.md](../../../CLAUDE.md) |

## 8. Exact focused and full validation commands

Focused:

```powershell
npx vitest run src/lib/tools/document-generation-tools.test.ts
```

```powershell
npx vitest run src/lib/state/sessions-repo.persistence.test.ts src/lib/state/sessions-repo.ingest.test.ts
```

The TTL behaviour is only meaningfully provable against a real DynamoDB, so it
has an integration test. Needs Docker running:

```powershell
npm run local:test:integration -- src/lib/state/sessions-repo.integration.test.ts
```

Full pre-push suite, run in full and never scoped:

```powershell
npm run typecheck; if ($?) { npm test }; if ($?) { npm run build }; if ($?) { npm --prefix web run typecheck }; if ($?) { npm --prefix web run build }; if ($?) { npm run local:test:integration }; if ($?) { node scripts/ci/docs-links.mjs }; if ($?) { node scripts/ci/feature-knowledge.mjs }; if ($?) { git diff --check }
```

**Windows PowerShell 5.1 has no `&&` operator** — chaining with it is a parser
error (`The token '&&' is not a valid statement separator in this version`), so
the list above uses `; if ($?) { ... }`. On bash or PowerShell 7+, `&&` works.

Bringing the emulator up before the integration suite, as separate statements
for the same reason:

```powershell
npm run local:up
```

```powershell
npm run local:provision
```

Use `npm run local:test:integration`, never `npm run test:integration:up` — the
latter starts LocalStack on port 4566 and collides with Floci.

## 9. Related documents

- [Operational HANDOFF](HANDOFF.md)
- [Feature knowledge framework](../README.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)
