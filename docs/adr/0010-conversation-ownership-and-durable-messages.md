# ADR 0010 — Conversations get per-user ownership and a full durable transcript, riding the sessions table

**Status:** Accepted (2026-08, persistent-workspaces P0 delta)

## Context

PR #36 made dashboard conversations persistent (session rows whose chatId
starts with `dashboard:` no longer carry a `ttl`) and gave the Chat tab a
sidebar over the pre-existing `GET /sessions?agentId=` and
`GET /sessions/transcript` routes. Two gaps were recorded in the feature README
as approved next work:

1. **Reopening shows at most 20 turns.** The session row's `turns` list is a
   rolling window (`MAX_TURNS = 20`); older turns are distilled into memory and
   their verbatim text is gone. Durable history that truncates itself is not
   durable.
2. **Conversations are org-visible.** The sidebar's source returns every user's
   sessions to any `sessions:read` holder and filters client-side; the send
   path accepts any `chatId` for any `chat:read` principal. The product
   requirement is explicit: every conversation belongs to an authenticated
   user, enforced server-side, with a not-found response for non-owners.

Constraints: `runAgentTurn` is persistence-agnostic (callers load history and
append turns), the session row is a full-item `PutCommand` that drops unlisted
attributes, adding a DynamoDB table costs ~10 infra touchpoints (CDK, IAM,
backup list, demo-reset, posture, docs counts), and two in-repo precedents
exist — `jarvis-memory-repo` rides the sessions table with its own partition
prefix at zero infra cost, and War Room keeps a container row plus per-message
rows with an `allocateSeq` counter.

## Decision

**Ride the existing `claudeclaw-sessions` table with two new item types, and
make the owner's partition the authorization boundary.**

| Entity | PK | SK | ttl |
|---|---|---|---|
| Conversation meta | `USER#<ownerId>` | `CONV#<conversationId>` | absent |
| Message | `CONV#<conversationId>` | `MSG#<pad13(epochMs)>#<0\|1>#<uuid>` | absent |

- **`conversationId` IS the `chatId`** — `dashboard:c_<uuid>`, server-minted on
  the first send of a new conversation (`startConversation: true`) and returned
  to the client as an additive `conversation` SSE event. One identifier, no
  mapping layer; `safeDashboardChatId` passes it through; every M1 TTL rule
  (`isPersistentChat`) applies unchanged.
- **Ownership by partition.** Reading or continuing a conversation resolves the
  meta at `(USER#<caller>, CONV#<id>)`. Absent means not yours or nonexistent —
  uniformly `404 {error:'not_found'}`. There is no cross-partition lookup to
  get wrong, and new ids are unguessable UUIDs.
- **`ownerId`** = `principal.userId` (users-table uuid, stable across
  logins) — falling back to `'root'` for the env break-glass token and
  `token:<hashPrefix16>` for legacy minted operator tokens. Never
  `dashboardIdentity()` (a per-login token hash).
- **Messages are written after each successful turn** (user + assistant, one
  server clock read per turn so the pair sorts adjacently; role tiebreaker in
  the SK). The message SK is time-sorted, jarvis-style, NOT War-Room `SEQ#`:
  both items of a turn are written from one code path at one instant, so a
  counter round-trip buys nothing.
- **The session row remains the model-context machine, byte-for-byte.** Sends
  still read `session.turns` (rolling 20) as history; `appendTurns`, memory
  ingest, eviction and `isPersistentChat` are untouched. The durable messages
  are the product transcript; the session window is the model context. They
  are allowed to differ.
- **Idempotency** is a `lastClientMessageId` attribute on the meta row. The
  client mints a UUID per logical send and reuses it on retry; the stream
  route compares it during the ownership read (no extra I/O) and answers
  `409 {error:'duplicate_message'}` before any model call. The composer sends
  serially, so a retry is always of the most recent message.
- **Listing** is a single Query on the owner's partition
  (`begins_with(SK, 'CONV#')`), sorted by `updatedAt` in memory, sliced to 100
  — the codebase's bounded-list house style; no cursor.

The M1 sidebar is re-pointed at the new owner-scoped routes
(`GET /api/conversations[/:id]`, capability `chat:read`) and gains
`/chat/c/:conversationId` deep links. Legacy pre-delta conversations (raw
timestamp chatIds) keep working on the legacy send path and stay reachable via
the admin Sessions tab, but do not appear in the owner rail.

## Consequences

Good:

- Full-transcript reopen (last 200 messages served; storage unbounded) and
  strict per-user isolation, with zero infrastructure change — no CDK, no IAM,
  no backup-list, no local-provisioning, no docs-count churn.
- The ownership check is one `GetItem` under the caller's own partition; the
  isolation property is structural, not a filter someone can forget.
- The `conversation` SSE event is additive; every existing SSE consumer
  (including AgentDetail's copy) ignores unknown events, so the send contract
  is backward compatible. Legacy `chatId` sends are byte-for-byte unchanged.
- Refresh mid-stream cannot lose a completed turn: hono's `StreamingApi.write`
  swallows write errors, the handler runs to completion, and persistence
  happens after the loop returns (verified against hono 4.12.27).

Bad / accepted:

- Two representations of a conversation's tail exist (session `turns` and
  message items). They can diverge in pathological cases (a crash between the
  two writes); the durable store is authoritative for display, the session for
  model context. Accepted: the write happens in one code path, and a missed
  pair costs one turn of transcript, not the conversation.
- Conversations created before this delta don't appear in the owner rail (no
  owner is knowable for a timestamp id after the fact). Accepted: hours-old
  data, admin Sessions tab still lists it, and inventing retroactive ownership
  would be a guess.
- The owner partition grows without bound (one meta item per conversation).
  Bounded reads keep the list cheap; archive/pagination is P1.
- Guardrail-blocked exchanges and slash-command replies are not persisted
  (mirrors session semantics); kb chips, images and run-meta footers are not
  rehydrated on reopen — text only. P1.

## Alternatives considered

- **New `conversations`/`messages` tables (War Room shape).** Rejected: ~10
  infra touchpoints per table for no P0 benefit; the sessions table's generic
  PK/SK already serves both item types (jarvis precedent), and its
  CMK/PITR/RETAIN properties are what a durable transcript wants anyway.
- **Widen `MAX_TURNS` / stop trimming the session row.** Rejected: the item
  has a ~50 KB budget (400 KB hard cap) and the window feeds memory-ingest
  cadence; unbounded single-item growth is the wrong shape for long chats.
- **A `SEQ#` counter per message (War Room `allocateSeq`).** Rejected: an
  extra RMW per message purely for ordering both halves of a turn that are
  written together; a 13-digit ms timestamp plus role tiebreaker gives the
  same total order for this write pattern.
- **Adopting legacy chatIds into the owner rail** (first-writer ownership
  marker items). Rejected: real machinery (conditional marker, adoption races,
  a DoS edge where a guesser adopts a victim's next timestamp id) to migrate
  hours of single-user data.
- **A GSI on the sessions table for per-user listing.** Rejected: a CDK change
  plus backfill for what a second item type under the owner's partition gives
  structurally; and GSI queries are eventually consistent where the meta
  partition read is not.
- **Per-user encryption or a tenant key.** Out of scope; single-tenant per
  [ADR 0002](0002-single-tenant.md), isolation at the AWS account level.
