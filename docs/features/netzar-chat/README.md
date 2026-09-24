---
feature: netzar-chat
document_role: index
status: current
observed_at: 2026-09-24
as_of_commit: d2a65614aa62da175afffecf0c118c246aa5c214
implemented_by:
  - web/src/pages/Chat.tsx
  - web/src/index.css
  - web/tailwind.config.ts
  - web/src/lib/theme.ts
  - web/src/lib/chat/stream.ts
  - web/src/components/chat/Composer.tsx
  - web/src/components/chat/ToolCallsSection.tsx
  - src/lib/state/sessions-repo.ts
  - src/adapters/dashboard/handler.ts
  - src/adapters/dashboard/jarvis.ts
  - src/agent/agent-loop.ts
  - src/agent/turn-errors.ts
  - src/lib/bedrock/client.ts
  - src/lib/safety/exfil-patterns.ts
  - src/lib/tools/dynamodb-tools.ts
  - src/lib/state/legacy-chat-migration.ts
  - src/lib/chat/attachments.ts
  - src/lib/chat/zip-check.ts
  - src/lib/media/process.ts
  - src/lib/vectors/store.ts
  - src/adapters/slack/media.ts
  - web/src/lib/chat/attachment-rules.ts
  - web/src/lib/chat/uploads.ts
  - web/src/components/chat/UserMessage.tsx
tested_by:
  - src/adapters/dashboard/chat-stream.test.ts
  - src/adapters/dashboard/chat-stream-p2.test.ts
  - src/adapters/dashboard/chat-lifecycle.test.ts
  - src/agent/agent-loop.p2.test.ts
  - src/lib/bedrock/client.p2.test.ts
  - src/lib/state/sessions-repo.p2.test.ts
  - src/lib/state/sessions-repo.p2.integration.test.ts
  - tests/e2e/chat/lifecycle.spec.ts
  - src/adapters/dashboard/chat-helpers.test.ts
  - src/lib/jarvis/route-manifest.test.ts
  - src/adapters/dashboard/sessions-ownership.test.ts
  - src/adapters/dashboard/sessions-history.test.ts
  - src/adapters/dashboard/sessions-readers.test.ts
  - src/adapters/dashboard/sessions-containment.test.ts
  - src/lib/state/sessions-repo.durable.test.ts
  - src/lib/state/legacy-chat-migration.test.ts
  - src/lib/state/sessions-repo.p1.integration.test.ts
  - src/lib/tools/dynamodb-tools.test.ts
  - src/adapters/dashboard/chat-uploads.test.ts
  - src/lib/chat/attachments.test.ts
  - src/lib/chat/zip-check.test.ts
  - src/lib/media/process.p3.test.ts
  - src/agent/agent-loop.p3.test.ts
  - src/lib/state/sessions-repo.p3.test.ts
  - src/lib/state/sessions-repo.p3.integration.test.ts
  - src/adapters/slack/media.p3.test.ts
  - tests/e2e/chat/attachments.spec.ts
approved_work:
  - docs/features/netzar-chat/plan.md
---

# LibreChat chat UI port

## 1. Start Here

This folder documents the port of danny-avila/LibreChat's chat UI structure
(layout shell, message list, composer, agent/model picker, conversation sidebar)
into the dashboard Chat tab, re-themed with this product's own design tokens.
Read this README for the durable view, [HANDOFF.md](HANDOFF.md) for where the
work is right now, and the newest file in `handoffs/` for how it got there.
Source code is the ultimate truth for present behavior.

Donor: **danny-avila/LibreChat, MIT license, pinned at commit
`6d499ba3ce17f906a7762429c61018f230ecd64e` (main, 2026-08-25).** Ported files
carry a header comment naming this SHA and the donor path. LibreChat is the
visual/structural donor only; no LibreChat runtime code, state library, or data
layer is used.

## 2. What netzar-chat does today

The shipped Chat tab uses `web/src/pages/Chat.tsx` as a 668-line state and
composition shell. Transport and helpers live in the nine modules under
`web/src/lib/chat/`; the LibreChat-structured, product-themed UI lives in the
17 top-level files under `web/src/components/chat/` — 15 component files plus
the `conversation-groups.ts` helper and the `useChatScroll.ts` hook — alongside
its `lc/` donor-derived support tree. It keeps intact:

- the SSE turn stream (`POST /api/test-turn/stream`; events `chunk` cumulative —
  or, for a client that sends `protocol: 2`, positional `delta {i, t}` —
  `tool {label, step, toolUseId, input, inputTruncated}`,
  `tool_result {toolUseId, output, isError, truncated}`, `media`, `kb`, `image`,
  `artifact`, `reply`, `final`, `error` (`{code, message}` for protocol 2, the
  plain message otherwise), `done` (`ok` or `not_saved`), and a `: ping` comment
  every 15 s);
- agent selection wired to `GET /agents` (active only) and `/chat/:agentId`;
- per-turn model selection wired to `GET /models` and the `modelOverride` field
  (`''` = agent default, no override sent);
- the chat-surface parity obligations (live tool status, streaming placeholder,
  run footer, error bubble, kb/image/artifact renderings) per
  [CLAUDE.md](../../../CLAUDE.md).

The port itself changes no other page, `AgentDetail.tsx`'s ChatTab, or the
backend.

**Conversation identity and the durable transcript (P1, roadmap step 3):**

- A conversation belongs to a **person**, whichever token they signed in with:
  the owner stamped on it is `dashboard:user:<userId>` for a magic-link session,
  or for a token with no user of its own that an admin linked to one (owner
  decision 1; `POST /api/tokens/:hashPrefix/link`, one link per token, never
  moved, audited). A token with no person behind it can still chat, but its
  conversations are not durable: they keep the 7-day TTL the other surfaces use,
  and nothing makes one durable later — not a scheduled task, and not a link
  made afterwards (only the chats a token starts once linked last).
- Every dashboard and Jarvis conversation route enforces that owner (decision
  9): someone else's conversation is refused with a 404 when you send into it or
  export it, reads as empty in the transcript, and is left out of the list, the
  CSV export and Jarvis's `sessions` answer. An admin (`security:write`) may read
  or delete anyone's; every such read is audited as `session_read_override`
  BEFORE anything is returned, and returns nothing if it cannot be. A slash
  command never leaves a conversation nobody owns: `/newchat` and `/model` touch
  only one that exists, and `/warroom` in a new chat creates it for its caller.
  Not owner-scoped, and older than P1: an agent's `dynamodb_query` tool still
  reads the conversation rows of its own partition (never the message records),
  and the memories routes answer for any chat.
- Every message is **also its own record** beside its conversation (owner
  decision 11: a new item type in the existing sessions table, no CDK). The
  20-turn window stays what the model replays; the records are what reopening a
  conversation shows (`GET /api/sessions/transcript` returns the whole history,
  oldest first, with a `truncated` flag past 2,000 messages) and what deleting it
  removes.
- Conversations written before P1 are moved by a one-off migration at the
  staging/production promotion (S1): owners provable through their token are
  re-owned with an immutable source record; the rest are deleted (owner decision
  46: nine dashboard conversations existed in production, four a member's and
  five the master token's, which is linked before the migration runs).

**The turn lifecycle, including the tool-call UX (P2, roadmap step 4):**

- **Stop means stop.** The Stop button, Escape (in the composer or on the Stop
  button), or closing the tab aborts the server's turn — even before the reply
  has begun, because the route watches the request's own signal as well as the
  stream's. The signal reaches the Bedrock request, and no further model call
  or tool round starts. The partial reply is saved marked `stopped` (the fixed
  notice "(Stopped before a reply.)" when nothing had been written, because an
  empty turn poisons a chat). A turn stopped before it began reserves no spend;
  otherwise the stopped turn's spend is recorded, finalized against the spend
  ledger and audited as `agent_turn` with `stopped`, from an estimate that errs
  on the safe side: every call that finished keeps its real usage, and the call
  that was cut counts the text, the attached files (1,600 tokens an image, a
  document by its size), the tool list and the re-sent tool arguments it
  carried, up to the model's context window, and the output it had written —
  text and any tool input a person never sees; a cut call that shows no output
  while it runs (a tool round) counts its output at its ceiling. The reply's
  footer says `stopped — partial reply, cost estimated`.
- **The composer during a run.** It stays editable while a reply streams, but
  nothing can be sent until the reply ends; the cursor returns when it ends
  unless the reader moved it elsewhere; an Escape that belongs to an input
  method (Japanese, Chinese) is left to it. Each conversation keeps its own
  unsent draft in the tab's memory, and a draft typed before anything was sent
  survives New chat and an agent switch.
- **Tool calls.** Under the reply, each call shows its arguments (capped at
  1 KB, "Input shortened" when cut) — only in the tab that ran the turn:
  arguments are never stored anywhere (owner decision 41) — and its result
  (capped at 2 KB; "Output shortened" when cut, "Failed" when the tool errored,
  "No result" for a call the Stop interrupted). Both pass the same
  block-severity redactor as the reply before they leave the server (it also
  catches a key written as a JSON property, the shape tool payloads carry); a failed
  tool's text also loses account ids and ARNs; and the database lookup tool's
  (`dynamodb_query`) raw result is neither shown nor stored, because it can
  return other people's conversations (owner decision 53; who that tool may
  read is still open, A172). The model still gets every raw result. Results are
  stored with the reply, so a reopened conversation shows the results and the
  `stopped` mark, but never the arguments. Under the replay window's byte
  budget, tool results go first, oldest first, before any conversation turn is
  cut (decision 41).
- **One paid call per message.** Every send carries a fresh `clientMessageId`;
  the server writes a turn record first (`SK=CHAT#<chatId>#TURN#<id>`, 7-day
  `ttl`, conditional on not existing), so a retried request can never start a
  second paid call (`409 turn_duplicate`; an id reused for a different message
  is `409 turn_conflict`; a record that cannot be written refuses the send,
  `503 turn_record_unavailable`). The record ends in exactly one of `complete`,
  `stopped`, `error` or `refused`, and the route saves the reply and ends the
  record BEFORE it writes `final`, so a reader who left cannot hold up the save.
- **Send-time checks.** Both send routes refuse an agent the registry does not
  know (`404 unknown_agent`; before P2 an unknown id silently ran as `main`)
  and a model outside the catalog (`400 unknown_model`) before any spend. An
  agent already in the cached list is not looked up again; the agents table is
  read only for an id the cache has not seen.
- **Failures.** The browser gets a code and a fixed message
  (`cost_cap_exceeded`, `cost_cap_unverifiable`, `kill_switch_active`,
  `model_error`, `internal_error`), never exception text — a paused turn says
  only that an operator paused it, and the operator's reason stays in the
  audit — and the Chat tab shows that message as the server wrote it; a refusal before the stream says what to
  do about it. Telegram and Slack post the same sanitized sentence (surface
  parity). An operator's refusal (the cost cap, a kill switch) is logged as a
  warning, a Stop not at all, so neither pages anyone. Nothing but `done`
  follows the final answer; `done` says `not_saved` when saving failed — the
  server logs it, and the reply says "This reply wasn't saved, so it won't be
  here after a reload."
- **Streaming on the deployed stack.** The Bedrock guardrail now runs alongside
  the stream (`streamProcessingMode: 'async'`, owner decision 50) instead of
  holding the whole answer until it finishes — the measured reason the
  deployed dashboard never streamed (decision 51). A Stop pressed before its
  verdict keeps the partial reply unchecked (owner decision 52). Runtime-config
  `bedrock/guardrail_stream_mode = sync` (any case) puts it back in front with
  no redeploy.

**Attachments (P3, roadmap step 5):**

- **Upload on attach.** Paperclip, paste and drop all run the same rules
  (`web/src/lib/chat/attachment-rules.ts`, the server's own numbers): documents
  by extension (`.pdf .docx .pptx .txt .md .csv`), media by type (`image/*`,
  `audio/*`, `video/*`), at most 30 MB and 3 files a message. A file that breaks
  a rule is named in one alert with the reason — never dropped. An accepted file
  uploads at once: `POST /api/chat/uploads` (`chat:read`) answers a presigned S3
  PUT with the file's size and type signed in (300 s) under
  `uploads/chat/<callerTag>/<id>/<name>`, where the tag comes from the caller's
  identity; the chip shows a real progress bar, and Send waits for every upload.
- **The send checks before it spends.** `POST /api/test-turn/stream` refuses a
  fourth file (400), and — after the ownership check, before a turn record, a
  read or a model call — checks every file with `HeadObject`: not the caller's
  or missing 404 `upload_not_found` (old-style `uploads/<uuid>/…` keys too,
  owner decision 55), over 30 MB 413 `file_too_large`, not the signed type 415
  `unsupported_type`, S3 unreachable 503 `upload_unavailable`.
- **What the model sees.** `pdf`, `docx`, `txt`, `md`, `csv` as Bedrock
  document blocks up to 4.5 MB, a `pptx` as its extracted text, images up to
  3.75 MB and only when the bytes are PNG, JPEG, GIF or WebP; a document's name
  is cleaned to what Bedrock accepts (200 characters at most). A docx or pptx
  passes a bounded ZIP check (`src/lib/chat/zip-check.ts`: 1,000 entries, 50 MB
  an entry, 100 MB in all, counted by really inflating) before anything opens
  it. A file the model could not read is named to it in a bracketed note; the
  note is never saved into the sender's own words.
- **A message keeps its files.** The user turn stores each file's id, name,
  type, size and raw-bucket key; the transcript returns them without the key;
  each chip is a Download button that asks `GET /api/sessions/attachment`
  (`sessions:read`) for a fresh 300 s link with attachment disposition — the
  owner only (the same 404 for missing and not yours), an admin through the
  audited override that fails closed (decision 1).
- **The knowledge base, only by choice** (owner decision 3). Each chip's "Add to
  knowledge" checkbox is off by default and says on screen that everyone who uses
  the agent can find the file and that it stays if the chat is deleted (decision
  54); an opt-in that did not happen says so. Slack and Telegram never import a
  chat file. Slack reads at most 3 files of 30 MB (a config may lower that, never
  raise it) and names every file it skips.

## 3. Current status and current source commit

The port merged into `development` as PR #129 (merge
`b3b427497d63d8f4d1faa147b46c9681c19bc460`, 2026-08-27). That merge is present
on `origin/qa` and `origin/staging`, and staging is the AWS environment reached
through the branch-to-environment mapping; it is not on `origin/production`.

P1 (roadmap step 3) merged into `development` as PR #189 (merge
`e035f97`, 2026-09-23) and P2 (roadmap step 4) as PR #190 (merge `700821f`,
2026-09-23); neither is on an environment branch yet (owner decision 18:
promotion is separate work). P3 (roadmap step 5) is the change this README
was last updated with; [HANDOFF](HANDOFF.md) and the Gauntlet state file hold
its pull request, because a file cannot state the commit it is inside.

## 4. Source of truth

| Concern | Authority | Use it for |
|---|---|---|
| Current implementation | [web/src/pages/Chat.tsx](../../../web/src/pages/Chat.tsx) | Present runtime behavior |
| Design tokens | [web/src/index.css](../../../web/src/index.css), [web/tailwind.config.ts](../../../web/tailwind.config.ts) | The palette the port must read as |
| White-label theming | [web/src/lib/theme.ts](../../../web/src/lib/theme.ts) | Runtime palette overrides |
| Wire contract (server side) | [src/adapters/dashboard/handler.ts](../../../src/adapters/dashboard/handler.ts) | SSE event names and payloads |
| Approved work | [plan and phase backlog](plan.md) | The only approved execution queue |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, command, next-action state |

## 5. Implementation map

| Area | Verified location | Present behavior |
|---|---|---|
| Chat composition and state | `web/src/pages/Chat.tsx` | Page shell coordinating chat state, routes, API calls, and the extracted UI |
| SSE client and chat helpers | `web/src/lib/chat/stream.ts`, `web/src/lib/chat/helpers.ts` | SSE framing, event handling, conversation identifiers, and client-side helpers |
| Chat UI | `web/src/components/chat/` | Header, transcript, live-tool state, composer, agent/model menus, and conversation sidebar |
| Markdown | `web/src/lib/chat/markdown.ts`, `web/src/lib/chat/code-block.ts`, `.chat-md` in `web/src/index.css` | marked → DOMPurify, chat-scoped highlighted code blocks |
| Route | `web/src/App.tsx` (`/chat`, `/chat/:agentId`) | Parsed by `src/lib/jarvis/route-manifest.test.ts` — do not change |
| Conversation storage | `src/lib/state/sessions-repo.ts` | The window row plus one record per message, written in one version-fenced transaction; `getFullHistory`; the cascading `deleteSession`; `reownLegacyConversation` |
| Ownership and the conversation routes | `src/adapters/dashboard/handler.ts` | `dashboardIdentity`, `ownsConversation`, the send/transcript/list/export/delete routes, `readConversationRows`, `POST /tokens/:hashPrefix/link` |
| Legacy migration | `src/lib/state/legacy-chat-migration.ts`, `scripts/p1-migrate-legacy-chats.ts` | Dry run by default; `--apply` only with the resolved table names typed out |
| Turn lifecycle (server) | `src/adapters/dashboard/handler.ts` (the stream route), `src/agent/agent-loop.ts`, `src/lib/bedrock/client.ts`, `beginTurn`/`endTurn` in `src/lib/state/sessions-repo.ts` | Abort, heartbeat, deltas, tool start/end, typed errors, send-time checks, turn records, the stopped turn's spend, the guardrail stream mode |
| Turn lifecycle (web) | `web/src/lib/chat/stream.ts`, `web/src/components/chat/Composer.tsx`, `web/src/components/chat/ToolCallsSection.tsx`, `web/dev/` (the dev-only chat mock) | Protocol 2 parsing, the composer during a run, the tool panel; the mock mirrors the route for `npm run e2e:chat` |
| Attachments (server) | `src/adapters/dashboard/handler.ts` (`/chat/uploads`, the send's preflight, `/sessions/attachment`), `src/lib/chat/attachments.ts`, `src/lib/chat/zip-check.ts`, `src/lib/media/process.ts`, `src/lib/vectors/store.ts`, `deleteSession` in `src/lib/state/sessions-repo.ts`, `src/adapters/slack/media.ts` | The format table, the signed upload link, the `HeadObject` preflight, the media rules and the knowledge opt-in, the owner's download link, the file cascade on delete, Slack's ceiling |
| Attachments (web) | `web/src/lib/chat/attachment-rules.ts`, `web/src/lib/chat/uploads.ts`, `web/src/components/chat/Composer.tsx`, `web/src/components/chat/UserMessage.tsx`, `web/src/pages/Chat.tsx` | The same rules in the browser, upload on attach with progress, the chips and their knowledge switch, the Download buttons |

## 6. Current business/state rules

- Conversation ids are `dashboard:<epoch-ms>`; the sidebar filters on that
  prefix and the server's `safeDashboardChatId` depends on it.
- The active conversation is remembered in `sessionStorage['cce_chat_active']`.
- Switching agents mints a fresh chatId (guardrail false-positive fix).
- Delete uses a synchronous ref guard against double-click plus an
  in-state-updater snapshot for rollback (documented bug fixes — preserved
  verbatim).
- `clearApiCache()` must run after send and after delete (send bypasses the api
  wrapper's cache invalidation).
- DOMPurify sanitizes after all markdown transforms, immediately before
  `dangerouslySetInnerHTML`.
- **The sessions table is shared and has no secondary index** (`infra/lib/dynamo-stack.ts`,
  PK/SK/ttl only). Beside conversation rows (`PK=AGENT#<agentId>`,
  `SK=CHAT#<chatId>`) it holds each message's record (`SK=CHAT#<chatId>#MSG#<seq>`),
  a migrated conversation's source record (`SK=CHAT#<chatId>#SRC`), and Jarvis
  long-term memory (`PK=JARVIS#…`, `jarvis-memory-repo.ts`). Every reader that
  lists conversations therefore selects them with `isConversationRow` (WI-1.0) —
  the per-agent and cross-agent `GET /api/sessions`, the CSV export and the Jarvis
  `sessions` action — and reads to the end, reporting `truncated` at a ceiling
  rather than undercounting. With no index, "the conversations owned by user X"
  cannot be a Query: listing reads the partition (or the table) and filters.
- A chat id never carries `#` into a key: the storage layer stores it as `_`
  (owner decision 47), so a chat can neither pose as another's message record nor
  vanish behind the containment rule.
- A conversation's owner is stamped when it first has one and never
  overwritten, and whether it lasts is settled at that moment: a person's
  lasts, a principal with no person's expires, and nothing changes that
  afterwards, whoever continues it. A conversation nobody owns yet — a scheduled
  task's reply saved before its chat's first turn — expires until its first
  owner saves in it; a person's arrival makes it, and the messages already in
  it, last. One nobody ever claims keeps expiring and only an admin can see it.
  An expiring conversation's records each expire a week after they were
  written. `/newchat` empties the model's window but keeps the records.
- A turn record (`SK=CHAT#<chatId>#TURN#<clientMessageId>`, P2) is a child of
  its conversation's key like a message record: `isConversationRow` hides it,
  `deleteSession` removes it, and its 7-day `ttl` expires it.
- Tool arguments are stored nowhere — not in a message record, a turn record,
  the audit log or the dev mock's transcript (decision 41); the server's
  existing `invoking tool` log line keeps them, as before P2. A tool result
  rides on its reply's message record, capped at 2 KB, and that record's text
  cap is 350,000 bytes minus the results' bytes, so text and results together
  stay under DynamoDB's 400 KB item limit (the text gives way, marked
  `truncated`); results that alone pass that budget give way first, oldest
  output first, every call still listed.
- A message's files ride on its user record (`attachments`: id, name, type,
  size and the raw-bucket key), counted in that record's byte budget; no client
  response carries a key except the two short-lived capability links (the
  upload PUT and the download GET). Deleting a conversation deletes those raw
  copies with `DeleteObjects` BEFORE any row, and keeps every row when S3 throws
  or reports an error, so a retry finds it whole; a conversation without files
  makes no S3 call. An opted-in knowledge-base copy is a separate document and
  stays (decision 54).

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| Authenticated staging UI is not yet verified | Floci Bedrock stub: one chunk, no tool events; staging verification needs an owner-authorized spend-capped token | [CHATUI-008](plan.md) |
| P2 is proven locally only: streaming to the browser, tool start/end and Stop have not run against real Bedrock through the deployed dashboard — including whether the deployed edge (Cloudflare tunnel, load balancer) closes the origin connection when a browser stops, which is what Stop depends on | staging runs `origin/staging` `8299f04`, which predates P1 and P2; the guardrail cause itself is measured on real Bedrock (decision 51) | the P2 staging rows (`p2-proof.sh` tier `staging`) run after promotion (decision 18) |
| How Bedrock bills a call cut mid-way is unverified | a stopped turn's usage is an estimate built to over-count (the call's files, tool list and re-sent arguments; a cut tool round's output at its ceiling), never to under-count the daily cap | none open |
| A Stop pressed before the async guardrail's verdict keeps the partial reply unchecked; a partial that held something the guardrail blocks can make that chat trip the filter on later turns | owner decision 52 (keep the partial): rare, and a new chat clears it | none open — the `sync` switch restores "check first" |
| The guardrail's async mode lets a harmful sentence reach the screen before the guardrail blocks the rest of the reply (AWS's documented trade-off) | owner decision 50; the app's own streaming redactor still scrubs every chunk against the block-severity patterns first | none open — runtime-config `bedrock/guardrail_stream_mode = sync` restores "check first" with no redeploy |
| P3 is proven locally only: a real browser PUT to real S3 through the signed link, the `HeadObject` preflight on real S3 and a real download have not run | the staging tier ST-1..ST-3 of `p3-proof.sh`; the grants and the staging bucket's CORS were read from `infra/`, not exercised | `P3_TIER=staging` after promotion (decision 18) |
| The raw bucket expires objects after 365 days, so an old message's file stops downloading (the chip stays; the click opens S3's error page) | `infra/lib/storage-stack.ts` lifecycle rule | none open — deferred in the P3 session log |
| Listing reads every message row it skips (no index, owner decision 11) | `readConversationRows` in `src/adapters/dashboard/handler.ts`; ceiling 100,000 items, then `truncated` | none open — a GSI means reopening decision 11 with the owner |
| Conversations written before P1 still carry a token-hash owner until the migration runs, and a pre-P1 turn that leaves the 20-turn window before then has no record anywhere | `src/lib/state/legacy-chat-migration.ts`; decision 46 | the S1 promotion: link the master token and run the migration (dry run, then `--apply`) straight after the deploy, before anyone chats |
| An opacity modifier on a plain semantic token still emits no CSS, so `bg-primary/10` is silently a no-op | the semantic keys in [web/tailwind.config.ts](../../../web/tailwind.config.ts) are raw `var()` strings with nowhere to inject an alpha channel; the alpha-capable `-a` siblings added by CHATUI-001 sit beside them rather than replacing them | none open — the mitigation landed in [CHATUI-001](plan.md); the standing rule is the appendix mapping (`any <color>/<opacity>` → `-a` triplet keys or `*-dim` vars only). The chat subtree observed 2026-09-20 has zero occurrences; the rest of `web/src` still has them |

## 8. Exact focused and full validation commands

Focused: `npx vitest run src/adapters/dashboard/chat-stream.test.ts
src/adapters/dashboard/chat-stream-p2.test.ts
src/adapters/dashboard/chat-helpers.test.ts
src/adapters/dashboard/chat-lifecycle.test.ts src/agent/agent-loop.p2.test.ts
src/lib/bedrock/client.p2.test.ts src/lib/state/sessions-repo.p2.test.ts
src/adapters/dashboard/chat-uploads.test.ts src/lib/chat src/lib/media
src/agent/agent-loop.p3.test.ts src/lib/state/sessions-repo.p3.test.ts
src/adapters/slack/media.p3.test.ts`, plus
`npm --prefix web run typecheck && npm --prefix web run build` and the browser
suite against the dev-only chat mock, `npm run e2e:chat`.

Full pre-push suite (all must actually run):

```powershell
npm run typecheck
npm test
npm run build
npm --prefix web run typecheck
npm --prefix web run build
npm run local:test:integration
node scripts/ci/docs-links.mjs
node scripts/ci/feature-knowledge.mjs
git diff --check origin/development...HEAD
```

Note (ledger M6): run Vitest from a normal checkout, never a Windows linked
worktree.

## 9. Related documents

- [Operational HANDOFF](HANDOFF.md)
- [Feature knowledge framework](../README.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)

## Appendix: LibreChat → Netzar OS token mapping

Fixed translation table used by every ported file (critics judge against it):

| LibreChat token/utility | Netzar OS replacement |
|---|---|
| `bg-presentation` | `bg-bg` |
| `bg-surface-primary` | `bg-bg` or `bg-surface` (context) |
| `bg-surface-secondary` | `bg-surface` |
| `bg-surface-tertiary` | `bg-surface-elevated` |
| `bg-surface-chat` | `bg-surface` |
| `bg-surface-hover` | `bg-surface-hover` |
| `text-text-primary` | `text-primary` |
| `text-text-secondary` | `text-secondary` |
| `text-text-tertiary` / `-quaternary` | `text-muted` |
| `border-border-light` / `-xlight` | `border-border` |
| `border-border-medium` / `-heavy` | `border-strong` |
| donor shadows | app `shadow-sm` / `shadow-md` / `shadow-lg` |
| gradient `from-presentation` | `from-bg-a` (alpha-capable triplet) |
| any `<color>/<opacity>` | `-a` triplet keys or `*-dim` vars only |

Style bar: the app's Linear/Vercel/Stripe language (violet-tinted neutrals,
indigo accent, hairline borders, whisper shadows). Never the Jarvis HUD
language; never LibreChat's stock gray palette.

### Syntax-highlighting palette (Phase 1)

The donor hand-writes its highlight.js theme in `client/src/style.css` as five
token groups plus a comment/meta pair, once for light and once under `.dark`.
The port keeps that *structure* and retints every value from this app's own
primitive ramps, so a code block reads as Netzar rather than as LibreChat:

| highlight.js group | Donor (light / dark) | This app (light / dark) |
|---|---|---|
| `comment`, `meta` | grays | `--color-text-muted` / same |
| `keyword`, `literal`, `doctag`, `formula` | `#0550ae` / `#2e95d3` | indigo 600 `#4f46e5` / indigo 300 `#a5b4fc` |
| `string`, `attribute`, `regexp`, `addition` | `#0a7b62` / `#00a67d` | green 600 `#16a34a` / green 400 `#4ade80` |
| `built_in`, `class .title` | `#9a6700` / `#e9950c` | amber 500 `#f59e0b` / amber 400 `#fbbf24` |
| `attr`, `number`, `type`, `variable` | `#9a2f6a` / `#df3079` | pink 500 `#ec4899` / pink 500 `#ec4899` |
| `title`, `link`, `symbol`, `bullet` | `#b42318` / `#f22c3d` | red 600 `#dc2626` / red 400 `#f87171` |

All six rules are scoped under `.chat-md` so they cannot leak into any other
surface, and they are appended rather than edited into the existing block —
WarRoom and Playground share `.chat-md` and must render unchanged.
