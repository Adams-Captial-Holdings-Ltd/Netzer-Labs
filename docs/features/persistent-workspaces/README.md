---
feature: persistent-workspaces
document_role: index
status: current
observed_at: 2026-08-13
as_of_commit: 8a66ba45ff1346642e144627eafb6985ad143fed
implemented_by:
  - src/lib/tools/document-generation-tools.ts
  - src/lib/tools/registry.ts
  - src/lib/state/sessions-repo.ts
  - src/adapters/dashboard/handler.ts
tested_by:
  - src/lib/tools/registry.test.ts
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

**Today, before this feature lands, it does not persist anything.** Stated
precisely, because the gap is smaller than it looks:

- Conversations **are** stored (`claudeclaw-sessions`, `PK=AGENT#<agentId>`,
  `SK=CHAT#<chatId>`) but carry a **7-day TTL** and keep only the **20 most
  recent turns**.
- The dashboard Chat tab mints `chatId = dashboard:${Date.now()}` in component
  state and discards it on reload. **There is no conversation list, no resume,
  and no session picker.**
- `generate_document` produces real PDF / DOCX / XLSX, stores them in
  `RAW_BUCKET` under `generations/<chatId>/<uuid>.<ext>`, and returns a **24h
  presigned URL inside the reply text**. No database record is written, so after
  24 hours the object is unreachable and unlisted. `RAW_BUCKET` also carries a
  hard 365-day expiration lifecycle and has **no versioning**.
- There is **no PPTX support** anywhere in the repository.
- There is **no artifact list or download route**; nothing reads `generations/`
  back.

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

Source evidence only, verified against `8a66ba45ff1346642e144627eafb6985ad143fed`
on 2026-08-13. **No deployment evidence** — nothing from this feature has been
deployed, and the defect above was observed in the running production
environment, not reproduced locally.

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
| Media channel | `src/lib/tools/registry.ts` | `ToolMedia.kind` is `'image'` only |
| Image delivery (reference pattern) | `src/lib/tools/nova-canvas-tools.ts` | Returns `media[]`; surfaces deliver bytes, URL in text is a fallback |
| Surface delivery | `src/adapters/telegram/handler.ts`, `src/adapters/slack/handler.ts`, `src/adapters/dashboard/handler.ts` | Each iterates `result.media` and treats every entry as an image |
| Conversation storage | `src/lib/state/sessions-repo.ts` | 20-turn window, 7-day TTL, `decideIngest` distillation backstop |
| Conversation read API | `src/adapters/dashboard/handler.ts` | `GET /api/sessions`, `GET /api/sessions/transcript` both exist and work |
| Chat UI | `web/src/pages/Chat.tsx` | Mints a fresh `chatId` per mount; no sidebar, no resume |

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

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| Document download links fail — signed URL does not survive the model round trip | Production `.xlsx` link observed with no `X-Amz-*` parameters, S3 `AccessDenied` | Return documents through the `media` channel (M0) |
| Generated documents expire silently | `RAW_BUCKET` 365-day expiration lifecycle, no versioning, no DB record | Store artifacts in `CURATED_BUCKET` (versioned, no expiry) (M2) |
| Conversations vanish after 7 days idle | `TTL_SECONDS` in `sessions-repo.ts` | Omit `ttl` for `surface === 'dashboard'` (M1) |
| Artifacts inherit conversation visibility | `GET /api/sessions` scans and returns all sessions to any `sessions:read` holder | Product decision required before M2 ships |
| `forget_me` does not erase generated documents | `src/lib/tools/privacy-tools.ts` has no artifact path | Extend erasure to the artifact prefix (M2) |
| Bot surfaces cannot deliver non-image media | Telegram `sendPhoto` hardcodes `filename: 'image.png'`; no `sendDocument` helper exists | Deferred; skipped explicitly at the call site per the parity rule in [CLAUDE.md](../../../CLAUDE.md) |

## 8. Exact focused and full validation commands

Focused:

```powershell
npx vitest run src/lib/tools/document-generation-tools.test.ts
npx vitest run src/lib/state/sessions-repo.test.ts
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
