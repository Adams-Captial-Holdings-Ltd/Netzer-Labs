---
feature: persistent-workspaces
document_role: session-handoff
status: historical
observed_at: 2026-08-13
session_slug: chat-history-raw
imported_from: ~/Downloads/chat-history-handoff.md
imported_at: 2026-09-17
---

> Imported verbatim on 2026-09-17 during the machine transfer. Raw pre-template session log; historical only; paths refer to the old machine.

# Handoff: Persistent chat history (save conversations per session)

## Session Metadata
- Created: 2026-08-13
- Project: `C:\Users\EmmanuelAdams\OneDrive - Personal Growth Counseling Services\Documents\ChatGPT\Netzar OS\work\Netzer-Labs`
- Branch to start from: `development` (at `8a66ba45ff1346642e144627eafb6985ad143fed`)
- Session duration: research + one shipped fix (~1 session)

## Current State Summary

Netzer OS already stores conversations in DynamoDB and already has working API
endpoints to list them and replay their transcripts. **It does not feel
persistent for two reasons only:** every session row carries a 7-day TTL that
auto-deletes it, and the dashboard Chat tab mints a brand-new `chatId` on every
mount and throws it away on reload. There is no conversation sidebar, no resume,
no way back into yesterday's chat.

This handoff covers closing that gap. A separate, already-shipped change
(`feature/persistent-workspaces`) fixed document download delivery and is not
part of this work — but read its notes below, because it touches the same Chat
tab file and will conflict if you branch from the wrong place.

**This is a small change with a large payoff.** The backend is essentially
already built. Most of the work is frontend.

## Codebase Understanding

### Architecture Overview

TypeScript / Node 20. Hono HTTP server (`src/index.ts`, port 3000). Preact +
`@preact/signals` + `wouter-preact` + Tailwind SPA in `web/`, served at
`/dashboard/`. **All state is DynamoDB (32 tables) + S3 (7 buckets) — there is
no SQL database, no ORM, no Redis.** Amazon Bedrock Converse/ConverseStream
powers every agent turn. Deployed on ECS Fargate.

Conversation flow today:

```
Chat.tsx  --POST /api/test-turn/stream-->  handler.ts (SSE)
                                              |
                                              v
                                    agent-loop.ts runAgentTurn()
                                              |
                                              v
                              sessions-repo.ts appendTurns()
                                   PK=AGENT#<agentId>
                                   SK=CHAT#<chatId>
                                   turns[] capped at 20
                                   ttl = now + 7 days   <-- the problem
                                              |
                                   evicted turns are distilled
                                   into memories-repo by
                                   src/agent/memory-ingest.ts
```

Note the important nuance: **turns are never silently lost.** Before a turn
falls off the 20-turn window, `decideIngest()` guarantees it is summarized into
durable memory first. So the *knowledge* survives; only the *verbatim
transcript* is capped.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `src/lib/state/sessions-repo.ts` | Owns the sessions table. `TTL_SECONDS` at line 28, `MAX_TURNS = 20` at line 27 | **The one backend change lives here.** Omit `ttl` for dashboard sessions |
| `web/src/pages/Chat.tsx` | The Chat tab. `freshChatId()` returns `` `dashboard:${Date.now()}` `` (~line 49) | **Most of the work.** Sidebar, resume, persist selected chatId |
| `src/adapters/dashboard/handler.ts` | All `/api/*` routes incl. `GET /api/sessions` and `GET /api/sessions/transcript` | Both endpoints you need **already exist** — read them, don't rebuild |
| `web/src/lib/api.ts` | Fetch wrapper: injects `Authorization: Bearer`, 60s stale-while-revalidate GET cache, `clearApiCache()` | Use `api.get()`; be aware of the 60s cache when a new chat should appear in the list |
| `src/agent/memory-ingest.ts` | Distills evicted turns into durable memory via Haiku | **Do not touch.** Explains why a 20-turn cap is tolerable |
| `src/lib/state/memories-repo.ts` | Durable per-agent memory, no TTL | Context only |
| `docs/adr/0002-single-tenant.md` | Accepted: no `tenantId` anywhere | Constrains the data model — do not add tenant scoping |
| `docs/adr/0009-mission-container-model.md` | Accepted: explicitly rejected Workspace/user scoping for work containers | Do not invent a Workspace entity |
| `development.md` (repo root) | **Canonical process doc.** Read before touching anything | Non-negotiable; see Prevention below |

### Key Patterns Discovered

- **DynamoDB single-table style.** `PK`/`SK` strings with prefixes. Multiple row
  types share a table with disjoint key prefixes (see ADR 0009 for precedent).
  Adding a row type ships via `npm run deploy:cloud`; adding a *table* needs a
  full `cdk deploy`, which `CLAUDE.md` warns can shift env-backed tunables.
  **Prefer a new key prefix over a new table.**
- **DynamoDB TTL only deletes items that carry the TTL attribute.** So making a
  row permanent means `REMOVE #t`, not setting a far-future value.
- **Two auth gates on `/api/*`**: a legacy `ROLE_RANK` check *and* a
  `hasCapability(c, 'x')` check. Sessions routes use `sessions:read`.
- **Tailwind: semantic tokens only.** `bg-surface`, `bg-surface-hover`,
  `border-border`, `text-primary`, `text-secondary`, `text-muted`. Never raw
  palette colors. Type scale is named: `text-body`, `text-body-sm`,
  `text-caption`, `text-overline` — never `text-sm`.
- **Reuse `web/src/components/`**: `Button`, `Badge`, `EmptyState`, `Skeleton`,
  `Modal`, `ConfirmDialog`, `Toast`, `Pagination`.
- **Chat surface parity rule** (`CLAUDE.md`): a chat UX change on one surface
  should be mirrored on Telegram and Slack, *or* explicitly skipped with a
  comment at the call site and a note in the PR. A conversation sidebar is
  dashboard-only by nature — say so rather than omitting silently.

## Work Completed

### Tasks Finished

- [x] Full feasibility study of persistent conversations + artifacts, verified against source
- [x] Confirmed the exact cause of non-persistence (TTL + client-side `chatId` churn)
- [x] Confirmed `GET /api/sessions` and `GET /api/sessions/transcript` already work
- [x] Shipped an unrelated fix on `feature/persistent-workspaces`: generated documents now deliver over the `ToolMedia` channel instead of a model-retyped presigned URL

### Files Modified

Only on `feature/persistent-workspaces` (**not** this work — listed so you can
avoid conflicts):

| File | Changes | Rationale |
|------|---------|-----------|
| `src/lib/tools/registry.ts` | `ToolMedia.kind` widened to `'image' \| 'artifact'` | Documents must not travel the image path |
| `src/lib/tools/document-generation-tools.ts` | Added pure `buildDocumentResult` + `documentFileName`; returns `media[]` | Fix broken downloads |
| `src/adapters/dashboard/handler.ts` | Emits a new `artifact` SSE event | Download card |
| `src/adapters/slack/handler.ts` | `deliverSlackImages` → `deliverSlackMedia`, real filenames | Native document upload |
| `src/adapters/telegram/handler.ts` | Skips non-image media with a comment | No `sendDocument` helper exists |
| **`web/src/pages/Chat.tsx`** | Added `artifacts` to `Message`, an `artifact` SSE branch, a download card | **CONFLICT RISK — same file you will edit** |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Conversation is the container; no Workspace entity | Workspace/Project hierarchy; reuse Missions; conversation-only | ADR 0009 explicitly rejected workspace scoping; sessions already key cleanly per `(agentId, chatId)` |
| Stay single-tenant | Add `tenantId`; full multi-tenant refactor | ADR 0002 is Accepted; isolation is at the AWS-account level |
| Persist dashboard sessions only; bots keep the 7-day TTL | Remove TTL entirely; make it runtime-configurable | Smallest behavioural change; Telegram/Slack have no UI to browse history, so permanence there is pure storage growth and a retention question |

## Errors, Mistakes & Learnings

### Errors Encountered

| Error / Symptom | Cause | Resolution | Status |
|-----------------|-------|------------|--------|
| `The token '&&' is not a valid statement separator in this version.` | User runs **Windows PowerShell 5.1**, which has no `&&` operator | Use `; if ($?) { ... }` or one command per line | Resolved |
| `npm test` fails 5 files locally, CI is green | 4 test files import `.mjs` helpers that begin with `#!/usr/bin/env node`; vitest's transform chokes on the shebang. 5th asserts POSIX paths | **Not fixed** — spun off as separate work. Proven by deleting one shebang: 7 tests immediately passed | Open (pre-existing) |
| `failed to connect to the docker API at npipe:...` | Docker Desktop not running | Docker Desktop is at `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe`, **not** Program Files | Resolved |
| S3 `AccessDenied` on a generated `.xlsx` link | Presigned URL was returned as text, the model retyped it into its reply and dropped the entire `X-Amz-*` query string | Deliver over the `ToolMedia` channel instead | Resolved |

### Mistakes Made & Corrections

| Mistake | Impact | Correction | Lesson |
|---------|--------|------------|--------|
| Planned to add a `claudeclaw-artifacts` DynamoDB table | Would have required a `cdk deploy` and duplicated data S3 already holds | Dropped it — S3 prefix listing *is* the index | Check whether the storage layer already answers the query before adding a table |
| Planned to remove the presigned URL from the tool's reply text | Would have regressed Telegram to **no** link at all | Kept it as a fallback, matching what `generate_image` already does | Read how the working sibling feature behaves before changing a shared contract |
| Planned to tag documents as `kind: 'image'` | Telegram would have posted a `.xlsx` as a photo named `image.png` | Added a distinct `'artifact'` kind and branched per surface | Trace every consumer of a shared type before widening it |
| Trusted a stale note claiming vitest can't run in a Windows worktree | Nearly avoided worktrees entirely | Tested it: the full 1949-test suite runs fine | Verify remembered environment claims before designing around them |

### Key Learnings

- **Learning 1:** The "hybrid memory architecture" people usually design for this
  is already implemented — sliding window + periodic LLM distillation +
  retrieval + structured memory, with a backstop guaranteeing no turn is evicted
  before it is summarized. **Do not redesign it.**
- **Learning 2:** `GET /api/sessions?agentId=X` does a clean Query on
  `PK=AGENT#<id>`, and the row already carries `firstMessage` (first 120 chars —
  a de-facto conversation title), `messageCount`, `createdAt`, `updatedAt`.
  A conversation sidebar is nearly free.
- **Learning 3:** `GET /api/sessions` **without** `agentId` does a full table
  **Scan** and returns every user's sessions to any `sessions:read` holder.
  Conversations are currently org-visible, not per-user private.
- **Learning 4:** Local development **cannot** exercise the agent tool path at
  all. Floci's Bedrock stub always returns `stopReason: 'end_turn'`, so the tool
  dispatch loop never runs. Plumbing is testable locally; model behavior is not.

### Prevention / Future Guidance

- **Read root `development.md` before your first edit** and declare which
  sections govern your work. Note: **not** `docs/development.md`, a different
  and partly contradictory file. The root one wins by its own precedence clause.
- **Record a baseline `npm test` before changing anything** and write it into
  your HANDOFF. On Windows expect **5 failing files / 1 failing test**, all in
  `scripts/`, none in `src/`. Anything beyond that is yours.
- **Never run `npm run test:integration:up`** — it starts LocalStack on port
  4566 and collides with Floci. Use `npm run local:test:integration`.
- Expect `local:test:integration` to be **31/32**. The `checkSecrets` failure is
  a documented Floci gap, not a regression.
- **Do not run** `npm run demo:reset`, `destroy`, `teardown`, `deploy`,
  `restore:ddb`, or `cdk deploy` locally — several default their environment
  flag to prod and read `.env`.
- The `diagrams.map` drift gate will fail your PR if you touch
  `src/adapters/dashboard/handler.ts` (it owns `docs/diagrams/architecture-security.md`)
  or `src/lib/state/sessions-repo.ts` (it owns `docs/diagrams/request-lifecycle.md`).
  Update the diagram or get owner approval.

## Pending Work

### Immediate Next Steps

1. **Create `docs/features/chat-history/README.md` and `HANDOFF.md` before
   writing code.** Use the templates in `docs/features/README.md` — that format
   is machine-validated by `node scripts/ci/feature-knowledge.mjs` and is
   *different* from this document. Reference implementation: `docs/features/missions/`.
2. **Backend, one conditional.** In `sessions-repo.ts` `appendTurns()`, when
   `enrichment.surface === 'dashboard'`, issue `REMOVE #t` instead of
   `SET #t = :t`. Both the create path (~line 235) and the update path
   (~lines 285, 351) set `ttl` — handle all of them.
3. **Frontend sidebar.** In `Chat.tsx`, call `GET /api/sessions?agentId=<id>`,
   render a list titled by `firstMessage`, sorted by `updatedAt` descending.
4. **Frontend resume.** On selecting a conversation, set `chatId` to that row's
   value and load `GET /api/sessions/transcript?agentId=&chatId=` into
   `messages`.
5. **Persist the selection.** Write the active `chatId` to `sessionStorage` so a
   refresh does not silently start a new conversation.
6. **Keep "New conversation."** `startNewChat()` already exists; it should mint a
   fresh id and clear `messages` as it does now.

### Blockers/Open Questions

- [ ] Question: should the sidebar show **the caller's** conversations or **all**
      conversations for that agent? The endpoint currently returns everything.
      Suggested: filter client-side by the `userId` on each row for now, and
      treat true per-user privacy as a separate decision.
- [ ] Question: a resumed conversation will show **at most 20 turns**, because
      that is all the row stores. Is that acceptable, or does this work also need
      full transcript retention? Suggested: ship the 20-turn version, state the
      limit in the feature README, and treat full history as a follow-up.
- [ ] Question: should existing sessions be backfilled (their `ttl` removed), or
      does persistence only apply to conversations created from now on?
      Suggested: from now on. Backfill is a one-off script if wanted.

### Deferred Items

- Conversation rename, search, pin/favorite, archive (deferred: decoration on an
  unproven flow — ship the sidebar first)
- Full verbatim transcript beyond 20 turns (deferred: needs a storage decision)
- Per-user conversation privacy (deferred: needs a product decision)
- Mirroring history UX to Telegram/Slack (deferred: those surfaces have no
  browsable history UI; note the skip in the PR per the parity rule)

## Context for Resuming Agent

### Important Context

**The backend for listing and replaying conversations already exists and
works.** Do not build new endpoints. Read `GET /api/sessions` and
`GET /api/sessions/transcript` in `src/adapters/dashboard/handler.ts` first —
almost everyone's instinct is to design a conversations API, and it is already
there.

**The single reason conversations disappear is `TTL_SECONDS` at
`src/lib/state/sessions-repo.ts:28`.** Everything else about persistence works.
This is genuinely a one-conditional backend change plus a frontend sidebar.

**`web/src/pages/Chat.tsx` was modified on `feature/persistent-workspaces`.**
If that branch has merged into `development` by the time you start, branch from
`development` and you are fine. If it has not, coordinate — you will both be
editing the `Message` interface, the SSE event parser, and the render block.

**Do not touch the memory system.** `memory-ingest.ts`, `memories-repo.ts` and
`hive-mind-repo.ts` implement a careful design including a prompt-injection
trust boundary. Removing the TTL does not require any change there.

### Assumptions Made

- Assumption: dashboard conversations should persist indefinitely; Telegram and
  Slack keep the 7-day TTL. Confirmed with the user on 2026-08-13.
- Assumption: no Workspace/Project entity and no `tenantId`. Confirmed with the
  user, and consistent with ADR 0009 and ADR 0002.
- Assumption: DynamoDB TTL ignores items lacking the attribute, so omitting
  `ttl` makes a row permanent. This is documented AWS behavior but **should be
  proven with one integration test against Floci**, not assumed.

### Potential Gotchas

- **`appendTurns` sets `ttl` in more than one place** — a create path and update
  paths. Missing one leaves conversations expiring anyway.
- **Optimistic concurrency:** `appendTurns` retries up to 3 times on
  `ConditionalCheckFailedException` using a `version` fence. Do not restructure
  the write without preserving that.
- **The 60s GET cache in `web/src/lib/api.ts`** means a newly created
  conversation may not appear in the sidebar immediately. Any non-GET clears the
  cache; a pure-read flow does not. You may need `clearApiCache()`.
- **`chatId` is not a plain id.** Dashboard ids are forced through
  `safeDashboardChatId()` server-side; anything not prefixed
  `dashboard:|system:|smoke:|test:` is re-keyed under `dashboard:`. Round-trip
  the value the server returns rather than constructing your own.
- **Guardrail-blocked turns are deliberately not persisted.** A conversation may
  legitimately have fewer stored turns than the user remembers sending.
- **Adding a whole new nav tab requires three synchronized edits** (`App.tsx`
  route `need=`, `Sidebar.tsx` `NAV_ITEMS` `minCapability`, and the Jarvis
  `ROUTE_TABLE`). A sidebar *inside* the existing Chat tab avoids all of that —
  prefer it.

## Environment State

### Tools/Services Used

- **Floci 1.6.0** — local AWS emulator on `127.0.0.1:4566`, started by
  `npm run local:up`. Was left **running** at the end of this session;
  `npm run local:down` stops it.
- **Docker Desktop 29.7.2** — installed at
  `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe`
- **`gh` CLI** — authenticated as `emmanuelmadams4-lgtm` and works against this
  repo. The GitHub *MCP connector* does not (404s on the private repo).
- **Git worktrees** — `.worktrees/persistent-workspaces` holds the shipped
  document fix. The main tree is usually on an in-flight branch with uncommitted
  changes; **use a worktree rather than switching branches.**

### Active Processes

- Floci container `netzer-os-floci` may still be running on port 4566.

### Environment Variables

Names only, no values. Local values come from `.env`, created from
`.env.local.example` (**never** from `.env.example`, `.env.reference` or
`.env.staging.example` — all three fail `loadEnv()`).

- `AWS_ENDPOINT_URL` — the isolation control; routes all AWS SDK calls to Floci
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (fake locally)
- `DASHBOARD_TOKEN` — dashboard bearer login
- `BEDROCK_DEFAULT_MODEL` — agent loop throws without at least one model id
- `TABLE_SESSIONS` — optional override; defaults to `claudeclaw-sessions`
- `NODE_ENV` — **never** set to `production` locally

## Related Resources

- `development.md` (repo root) — canonical local development + process doc
- `docs/features/README.md` — the machine-validated feature doc contract
- `docs/features/missions/` — reference implementation of that contract
- `docs/adr/0002-single-tenant.md`, `docs/adr/0009-mission-container-model.md`
- `CLAUDE.md` — chat surface parity rule, deploy guidance
- `C:\Users\EmmanuelAdams\.claude\plans\prompt-research-dynamic-lamport.md` —
  the full 15-section architecture proposal this work came from; read §5, §7 and
  §12 Milestone 1
