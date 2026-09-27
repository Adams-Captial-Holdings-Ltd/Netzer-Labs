---
feature: netzar-chat
document_role: index
status: current
observed_at: 2026-09-27
as_of_commit: f82403946ed1974ca7fd2cc55ca4ba060186f70b
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
  - web/src/components/chat/ArtifactCard.tsx
  - web/src/components/chat/ArtifactPanel.tsx
  - web/src/lib/chat/artifacts.ts
  - web/index.html
  - web/src/components/chat/ConversationSidebar.tsx
  - web/src/components/chat/useChatScroll.ts
  - web/src/lib/chat/export.ts
  - web/src/lib/chat/drafts.ts
  - web/src/lib/chat/model-label.ts
  - web/src/lib/api.ts
  - web/src/components/JarvisWidget.tsx
  - src/lib/chat/artifacts-repo.ts
  - src/lib/chat/artifact-grammar.ts
  - src/lib/chat/artifact-preview.ts
  - src/lib/chat/vendor/librechat-update.ts
  - src/lib/documents/pptx.ts
  - src/lib/tools/document-generation-tools.ts
  - src/lib/tools/document-draft-tools.ts
  - src/lib/tools/artifact-read-tools.ts
  - src/lib/tools/nova-canvas-tools.ts
  - src/lib/tools/privacy-tools.ts
  - infra/lib/iam-stack.ts
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
  - src/lib/chat/artifacts-repo.p4.test.ts
  - src/lib/chat/artifacts-repo.p4.integration.test.ts
  - src/lib/chat/artifact-grammar.p4.test.ts
  - src/adapters/dashboard/artifacts.p4.test.ts
  - src/agent/agent-loop.p4.test.ts
  - src/lib/documents/pptx.p4.test.ts
  - src/lib/state/sessions-repo.p4.test.ts
  - src/lib/tools/artifact-tools.p4.test.ts
  - src/lib/tools/privacy-tools.p4.test.ts
  - infra/lib/iam-stack.p4.test.ts
  - src/adapters/dashboard/artifacts.p5.test.ts
  - src/adapters/dashboard/chat-artifacts-p5.test.ts
  - src/lib/chat/artifact-preview.p5.test.ts
  - src/lib/chat/artifacts-repo.p5.test.ts
  - tests/e2e/chat/artifacts.spec.ts
  - src/adapters/dashboard/chat-regenerate.p6.test.ts
  - src/adapters/dashboard/sessions-meta.p6.test.ts
  - src/lib/state/sessions-repo.p6.test.ts
  - src/lib/state/sessions-repo.p6.integration.test.ts
  - src/adapters/dashboard/chat-ux-p6.test.ts
  - tests/e2e/chat/conversation-ux.spec.ts
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

The shipped Chat tab uses `web/src/pages/Chat.tsx` as an 877-line state and
composition shell. Transport and helpers live in the thirteen modules under
`web/src/lib/chat/`; the LibreChat-structured, product-themed UI lives in the
19 top-level files under `web/src/components/chat/` — 17 component files plus
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
  raise it) and names a file it skips for being past the third or over the size
  limit (a failed Slack download is still reported only generically).

**Artifacts — files the agent makes (P4, roadmap step 6, server only):**

- **A proper home.** In dashboard chat, a generated document (`generate_document`:
  PDF, DOCX, XLSX, editable PPTX through `pptxgenjs`), a generated image, a
  document built across turns (`document_draft`: start, append, finalize) and a
  reply's `:::artifact{…}` block (text, markdown, HTML, SVG, Mermaid, code, JSON,
  CSV; at most 8 a turn and 1 MiB each, parsed by the vendored, fixed LibreChat
  parser) are saved by `saveArtifact` (`src/lib/chat/artifacts-repo.ts`) into the
  versioned CURATED bucket under `artifacts/`, at most 30 MiB, after the
  block-severity safety scan, under a per-conversation lock. Each save is an
  immutable version; a revision names the version it replaces, so "make it
  shorter" keeps the first draft. Only a stable dashboard person's durable
  conversation can hold artifacts; Telegram and Slack keep their existing
  24-hour file links and skip durable artifacts on purpose.
- **Only the owner reads it.** `GET /api/artifacts`, `/api/artifacts/versions`
  and `/api/artifacts/download` (`sessions:read`) list descriptors with no key or
  URL and re-mint a 300 s link to one exact version; another person, a missing
  chat and a missing file get the same 404; an admin reads through the audited
  override, which fails closed. The stream sends `artifact_ref` (a URL-free
  descriptor) only after the turn is saved; the transcript restores the
  references. The model can read its owner's own artifact back
  (`read_artifact`, up to 9,000 bytes, scanned first); the tool status and the
  saved tool record show only a short hidden-result notice.
- **Deleting really deletes.** Deleting a chat, and `forget_me`, erase every
  artifact object version and delete marker, then confirm none is left, before
  any row goes; a partial failure keeps the rows for a retry and forget-me
  records it.
- **Not yet:** no themed builds (ART-15, its own step). The Chat tab's card and
  panel are P5, below.

**Artifacts in the Chat tab — the card and the panel (P5, roadmap step 7):**

- **A card that holds no link** (owner decision 58). Every URL-free reference —
  the live `artifact_ref` event, or a reloaded turn's `artifacts` — becomes a
  card (`web/src/components/chat/ArtifactCard.tsx`) with a short type badge
  (HTML, MD, PY, PPTX, …) and a Download button; it fetches nothing until a
  click. Download fetches `/api/artifacts/download` for that exact version on
  every click, outside the page's read cache, and uses the link once; the file
  is named with its type's extension (`downloadFileName`; stored names are
  unchanged). A turn carries at most eight references. Older turns' link cards
  keep their download.
- **A panel that previews safely** (`web/src/components/chat/ArtifactPanel.tsx`,
  `web/src/lib/chat/artifacts.ts`). A right-hand column on a wide screen, a
  full-screen sheet below 1024 px that keeps keyboard focus inside it; Escape
  closes it. A version picker (only when there is more than one version), Copy
  for text and Download. The preview is chosen by the content type AND the
  file's own bytes (a spoofed type falls back): HTML and Mermaid run only in an
  `<iframe sandbox="allow-scripts">` built from `srcdoc` — an opaque origin that
  cannot reach the page, its storage or its token — under its own
  Content-Security-Policy that loads scripts only inline or from
  `cdn.jsdelivr.net/npm/` and `cdnjs.cloudflare.com/ajax/libs/` (owner decision
  4), styles only inline or from those same two paths, fonts only as `data:` or
  from them, pictures and media only as `data:` or `blob:`, and blocks every other
  request; Mermaid is
  one pinned jsDelivr build with
  integrity. SVG is shown only as an image; pictures and PDFs come from the
  bytes as `blob:` URLs, revoked when the panel closes or switches version;
  markdown is sanitised to HTML only, with remote
  media, form controls and popovers removed; code, CSV (100 cells a row, 1,000
  characters a cell, 500 rows) and a deck's slide text (from the server,
  `view=outline`, after the P3 ZIP check) are plain text. Anything else says
  "No preview available" and offers the download.
- **The content route.** `GET /api/artifacts/content` repeats every guard of
  `/artifacts/download` (`sessions:read`, the owner or an audited admin, the
  exact version, one 404) and returns the bytes as an inert attachment
  (`application/octet-stream`, `nosniff`, a sandbox CSP, `no-store`).
- **Not yet:** the export bridge that lets an HTML artifact build a deliverable
  in the browser (ART-16, deferred to its own item — the page accepts no message
  from a preview); model capabilities (WI-5.4 / ART-10, waiting for
  `bedrock-all-models`; carried to P7).

**Conversation controls, regenerate and accessibility (P6, roadmap step 8):**

- **Try again and Regenerate.** A failed reply is an alert (text that arrived
  before the failure stays above it as an ordinary reply, and in the export);
  the LAST one offers Try again, which re-sends its text as a new turn with a
  new message id (a
  failed turn stores nothing); one whose message carried files asks for them
  again instead. The last saved reply offers Regenerate: `POST
  /api/test-turn/stream` with `regenerate: true` (no text, no files) answers the
  stored last message again and replaces that reply in place —
  `replaceLastReply`, one version-fenced transaction over the window row and the
  reply's own record, the same message number, `turnsTotal` unchanged, nothing
  trimmed (the next append trims, with its memory summary; a reply memory had
  already summarised is queued again, while what memory took from the replaced
  reply stays). The save names the message count and the
  owner the route authorized, retries a version race while both still match, and
  is refused if the conversation moved on or changed hands. Only stored images
  and documents under their caps are re-read from the raw bucket (nothing
  archived, transcribed or ingested again; audio and video contribute their
  stored text, and a video's keyframes are not replayed); the media kill switch
  stops it, and a file that cannot be read again refuses it as
  `attachment_unavailable` before any model call. A blocked, refused or unsaved
  regenerate leaves the old reply in place and shows an alert: for a block or a
  refusal it holds the notice; for a reply the server could not save (say, the
  conversation moved on or changed hands, or the write failed) it holds that
  unsaved reply itself, with no reason given (carried to P7). Owner only (a
  stranger's or missing conversation: one 404), metered and idempotent like a
  send.
- **The stopped text.** Both stop paths — during the model call, and a stop that
  interrupts a tool round — save only what the reader saw (the guarded writer's
  visible text, so a withheld `:::artifact` block is never saved), after the same
  fail-closed outbound scan a finished reply passes.
- **Rename, pin and search.** `PATCH /api/sessions {agentId, chatId, title?,
  pinned?}` is the owner's only (anyone else, an admin included, gets the
  missing-conversation 404): one conditional update that never creates a row and
  bumps the version. A title is refused if it holds a control, format, surrogate
  or separator character (the artifact title rule), then trimmed and capped at
  120; an empty title clears it. Every conversation writer carries the title and
  the pin forward. `GET /api/sessions` lists pinned conversations first, even
  past the newest fifty, and takes an optional `q` (at most 100 characters, a
  plain case-insensitive match on the title and the first message). The rail and
  the drawer have Rename and Pin beside Delete, a Pinned group and a debounced
  server search; the rename field opens with its title selected and shows its
  own Save title and Cancel rename, and the delete confirmation names the
  conversation it deletes.
- **The page.** One-click New chat (the "type NEW CHAT" confirmation is gone); a
  loading status while a conversation opens and load-failure alerts with Try
  again for the transcript and the list, a slower load never replacing a newer
  one; one polite announcer ("Reply finished." / "Reply stopped."); the phone
  drawer traps focus with the page behind it inert, both set in layout effects,
  and closes at the lg breakpoint; an `h1` at every width; bound `aria-expanded`;
  chat-scoped contrast fixes (the global tokens are unchanged); tables that
  scroll inside the reply; the end of a finished or stopped reply left in view
  above the composer (reduced motion included); the voice orb's default moved
  off the chat on the chat route — at 1024 px and up into the house
  navigation's empty lower band, its hint beside it on hover or focus and never
  over the navigation, below that lifted above the composer (owner decision 61;
  a dragged position still wins); a staged image shows its thumbnail.
- **Drafts, shortcuts and downloads.** Unsent drafts per conversation in the
  tab's sessionStorage, restored across a reload and cleared on send, keyed —
  with the remembered conversation — by the signed-in identity; the
  not-yet-known identity's slot is wiped at every sign-in and sign-out (a
  signed-out person's drafts are never shown to the next person, but stay in
  the tab's storage until the tab closes). Ctrl/Cmd
  + Shift + O starts a new chat, Shift + Escape focuses the message box, Ctrl/Cmd
  + / focuses the search (none of them while an artifact sheet is open on a
  phone). A code block's Download code names the file by its language
  (`snippet.<ext>`); Export chat downloads the conversation as Markdown built in
  the page (no links or keys). The model picker's trigger shows the family and
  the context size (no capability badges, decision 36).
- **Not yet:** edit and branch (P6b, excluded from this step); a video's
  keyframes on a regenerate (carried).

## 3. Current status and current source commit

The port merged into `development` as PR #129 (merge
`b3b427497d63d8f4d1faa147b46c9681c19bc460`, 2026-08-27). That merge is present
on `origin/qa` and `origin/staging`, and staging is the AWS environment reached
through the branch-to-environment mapping; it is not on `origin/production`.

P1 (roadmap step 3) merged into `development` as PR #189 (merge
`e035f97`, 2026-09-23) and P2 (roadmap step 4) as PR #190 (merge `700821f`,
2026-09-23); neither is on an environment branch yet (owner decision 18:
promotion is separate work). P3 (roadmap step 5) merged as PR #191 (merge
`6c49661`, 2026-09-24), on no environment branch either, P4 (roadmap step 6)
as PR #192 (merge `e2cd11e`, 2026-09-26) and P5 (roadmap step 7) as PR #193
(merge `ed8a3dc`, 2026-09-27), on none either. P6 (roadmap step 8) is the
change this README was last updated with; [HANDOFF](HANDOFF.md) and the
Gauntlet state file hold its pull request, because a file cannot state the
commit it is inside. The P6 paragraphs and rows, and the counts in section 2,
were checked at the frontmatter's commit; the P5 statements were last checked
at `9905de3`, the P4 ones at `b1e8bdd` and the P1-P3 ones at `97f8e79`,
re-derived here only where a later step changed their code (P6 changed the
remembered conversation's key, the new-chat control and the rule that a taken
message number is never overwritten).

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
| Artifacts (server) | `src/lib/chat/artifacts-repo.ts`, `src/lib/chat/artifact-grammar.ts` + `src/lib/chat/vendor/`, `src/lib/tools/{document-generation,document-draft,artifact-read,nova-canvas,privacy}-tools.ts`, `src/lib/documents/pptx.ts`, the `/artifacts*` routes and `artifact_ref` in `src/adapters/dashboard/handler.ts`, `deleteSession` in `src/lib/state/sessions-repo.ts`, `infra/lib/iam-stack.ts` | Versioned CURATED storage and its lock, the grammar, the tools, the owner routes, version-aware erasure and its IAM grant |
| Artifacts (web) | `web/src/components/chat/ArtifactCard.tsx`, `web/src/components/chat/ArtifactPanel.tsx`, `web/src/lib/chat/artifacts.ts`, `artifact_ref` in `web/src/lib/chat/stream.ts`, `transcriptToMessages` in `web/src/lib/chat/helpers.ts`, `web/index.html` (the page's frame policy); `GET /artifacts/content` in `src/adapters/dashboard/handler.ts` and `src/lib/chat/artifact-preview.ts` on the server | The card, the panel and its per-type previews, the sandbox document and its policy, the deck outline, download naming |
| Conversation controls and regenerate (server, P6) | `src/adapters/dashboard/handler.ts` (the stream route's `regenerate`, `replayStoredAttachments`, `saveRegeneratedReply`, the stopped paths, `PATCH /sessions`, the list's `q` and pins), `replaceLastReply` and `setConversationMeta` in `src/lib/state/sessions-repo.ts`, `buildMediaBlocks` in `src/lib/media/process.ts`, `AttachmentUnavailableError` in `src/agent/turn-errors.ts`, `scanOutboundReply` in `src/agent/agent-loop.ts`, `UNSAFE_ARTIFACT_TITLE_PATTERN` in `src/lib/chat/artifact-grammar.ts` | Regenerate in place and its refusals, the stopped text through the outbound scan, rename, pin, search |
| Conversation controls and accessibility (web, P6) | `web/src/pages/Chat.tsx`, `web/src/components/chat/{ConversationSidebar,MessagesView,AssistantMessage,ChatHeader,ModelMenu,CommandMenu,Composer}.tsx`, `web/src/components/chat/useChatScroll.ts`, `web/src/lib/chat/{export,drafts,model-label,code-block,markdown}.ts`, `web/src/lib/api.ts` (the identity slots wiped at sign-in and sign-out), `web/src/components/JarvisWidget.tsx`, `web/dev/` (the mock mirrors the new routes) | Try again, Regenerate, rename, pin, search, load states, the announcer, the drawer, drafts, shortcuts, downloads, the model pill, the orb |
| Attachments (web) | `web/src/lib/chat/attachment-rules.ts`, `web/src/lib/chat/uploads.ts`, `web/src/components/chat/Composer.tsx`, `web/src/components/chat/UserMessage.tsx`, `web/src/pages/Chat.tsx` | The same rules in the browser, upload on attach with progress, the chips and their knowledge switch, the Download buttons |

## 6. Current business/state rules

- Conversation ids are `dashboard:<epoch-ms>`; the sidebar filters on that
  prefix and the server's `safeDashboardChatId` depends on it.
- The active conversation is remembered per signed-in identity in
  `sessionStorage['cce_chat_active:<identity>']` and an unsent draft in
  `sessionStorage['cce_chat_draft:<identity>/<agentId>/<chatId>']` (P6); before
  the identity is known both use the slot `unknown`, which sign-in and sign-out
  wipe, together with the unscoped `cce_chat_active` the page also keeps.
- Regenerate replaces only the LAST reply, in place, and only the one it
  answered (the authorized message count and owner) — the stored last reply,
  which is not always the one on screen (two tabs; a stopped reply whose save
  failed; carried to P7); that replacement is the one
  write that may overwrite a taken message number (P6). Rename and pin are the
  owner's only and never create a row; every conversation writer carries `title`
  and `pinned`.
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
- An artifact's rows share its conversation's partition (`CHAT#<id>#ARTIFACT#…`:
  a head, one immutable version per save carrying the exact S3 version id, and a
  pending row while an upload is in flight); its bytes live at a base64url key
  under `artifacts/` in CURATED. The bytes are written before any descriptor is
  published, a failed record write deletes the uploaded version, and an upload
  without a version id keeps its pending row for recovery. Every save and every
  delete takes the conversation's child lock, and a save (and a draft's start)
  re-reads the parent with a consistent read under it; a finalizing draft may never re-create a
  deleted parent. No response or stored turn carries a key or a URL except the
  owner's 300 s download link.
- The dashboard never runs artifact content in its own origin (P5): HTML and
  Mermaid only in the opaque-origin `srcdoc` sandbox whose own policy comes
  before any artifact markup; the page itself carries a frames-only policy
  (`frame-src 'self' blob:` in `web/index.html`) because a frame's own
  navigation is judged by its parent's policy. The page listens to no message
  from a preview. The artifact markdown preview uses a stricter sanitiser than
  chat replies (no remote media, no form controls).

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
| WebRTC is not fully blocked in an HTML preview: the guard removes it from the preview's own window, but a frame the preview creates (or a `blob:` document it navigates to) gets it back, and no browser policy can block WebRTC today (CSP `webrtc` is not recognised). Every other exit — fetch, XHR, WebSocket, beacon, remote images, frames, forms, popups, top navigation, and any style or font not from the two library paths — is blocked in every such frame | measured in the P5 session log (the sandbox probes); `web/src/lib/chat/artifacts.ts` | none open — carried in the P5 session log; revisit when browsers support a WebRTC policy |
| P5 is proven locally only: the browser suite runs against the dev-only mock; the deployed page's frame policy, the content route on real S3 and a real PDF viewer have not run on staging | `tests/e2e/chat/artifacts.spec.ts` against `web/dev/`; the route tests in `src/adapters/dashboard/artifacts.p5.test.ts` | after promotion (decision 18) |
| Chat REPLY markdown (not the artifact preview) still lets a reply load a remote image in the dashboard page | found by the P5 React review (outside P5's range, pre-existing): `renderMarkdown` uses DOMPurify's default profile | carried in the P5 session log (A213) for the owner |
| P6 is proven locally only: the browser suite runs against the dev-only mock; a regenerate against real Bedrock and S3, the rename race on real DynamoDB (proved on Floci) and the deployed page have not run on staging | `tests/e2e/chat/conversation-ux.spec.ts` against `web/dev/`; `src/lib/state/sessions-repo.p6.integration.test.ts` on Floci | after promotion (decision 18) |
| A regenerated question that carried a video is answered from its stored transcript without the video's keyframes | `replayStoredAttachments` in `src/adapters/dashboard/handler.ts` | carried in the P6 session log (Jev 0.86: extracting keyframes from raw bytes needs processVideo's probe step) |
| The list search term travels in the GET URL, so it reaches the load balancer's access logs | `router.get('/sessions')` in `src/adapters/dashboard/handler.ts` | carried in the P6 session log — a POST search if those logs ever leave the account |
| An admin's list shows every member's pinned conversations first, and the audited list override does not record `q` | `visibleConversations` in `src/adapters/dashboard/handler.ts`; the P6 security review, INFO-1 | carried in the P6 session log (decision 1: an admin sees every conversation, audited) |
| Regenerate re-answers the conversation's stored last exchange, which is not always the one on screen (the same chat open in two tabs, or a stopped reply whose save failed); the page then shows the new answer under its own older question until a reload | the regenerate branch of `router.post('/test-turn/stream')` in `src/adapters/dashboard/handler.ts` and `regenerate()` in `web/src/pages/Chat.tsx`; the P6 fresh critic's F-1 | carried to P7 as its first item (the P6 session log, A233): tie the request to the reply shown and refuse a mismatch |
| A whole-row conversation write (regenerate's `replaceLastReply`, and `appendTurns`) can undo a /newchat, /model or war-room change that lands between its read and its write, because those three writers never bump the version | `updateIfExists` in `src/lib/state/sessions-repo.ts`; the P6 fresh critic's F-7 (a code trace, not reproduced) | carried to P7 (the P6 session log, A232) |
| Renaming a chat whose first message has a line break or tab fails when saved untouched, and the page says "Please try again" | the rename pre-fill in `web/src/components/chat/ConversationSidebar.tsx`; the P6 fresh critic's F-8 | carried to P7 (the P6 session log, A234) |
| P4's erasure needs its new IAM grant (`s3:ListBucketVersions` on `artifacts/*`, `s3:DeleteObjectVersion` on `CURATED/artifacts/*`); an image-only `npm run deploy:cloud` would ship the code without it and erasure would fail | `infra/lib/iam-stack.ts`, `npm run synth` only; P4 is proven locally only (Floci versioning, no real presigned download) | the promotion that carries P4 deploys the IAM stack (a `qa -> staging` merge runs `cdk deploy --all`) |
| A reply still generating when its chat is deleted re-creates the chat when it saves a file (visible and deletable); a crash mid-save leaves the chat's lock row, so delete stays "busy" until an operator clears it | the P4 Claude security review, M1 and M3 | hardening (P7), owner decision 59 |
| `pptxgenjs` pulls `image-size` 1.2.1 with two HIGH advisories (a crafted image can hang it); the code never reaches it — slides carry text only | `npm audit`; the P4 session log, A202 | owner decision 56; re-check before slides carry images |
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
src/adapters/slack/media.p3.test.ts src/lib/chat/artifacts-repo.p4.test.ts
src/lib/chat/artifact-grammar.p4.test.ts src/adapters/dashboard/artifacts.p4.test.ts
src/agent/agent-loop.p4.test.ts src/lib/documents/pptx.p4.test.ts
src/lib/state/sessions-repo.p4.test.ts src/lib/tools/artifact-tools.p4.test.ts
src/lib/tools/privacy-tools.p4.test.ts infra/lib/iam-stack.p4.test.ts
src/adapters/dashboard/artifacts.p5.test.ts src/adapters/dashboard/chat-artifacts-p5.test.ts
src/lib/chat/artifact-preview.p5.test.ts src/lib/chat/artifacts-repo.p5.test.ts
src/adapters/dashboard/chat-regenerate.p6.test.ts src/adapters/dashboard/sessions-meta.p6.test.ts
src/lib/state/sessions-repo.p6.test.ts src/adapters/dashboard/chat-ux-p6.test.ts`, the Floci
tests `node --env-file=.env node_modules/vitest/vitest.mjs run --config
vitest.integration.config.ts src/lib/chat/artifacts-repo.p4.integration.test.ts
src/lib/state/sessions-repo.p6.integration.test.ts`, plus
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
