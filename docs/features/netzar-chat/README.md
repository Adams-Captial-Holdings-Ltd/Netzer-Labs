---
feature: netzar-chat
document_role: index
status: current
observed_at: 2026-09-22
as_of_commit: bbee525a135612abf89d5afa8c24ac0c72d8de06
implemented_by:
  - web/src/pages/Chat.tsx
  - web/src/index.css
  - web/tailwind.config.ts
  - web/src/lib/theme.ts
  - src/lib/state/sessions-repo.ts
  - src/adapters/dashboard/handler.ts
  - src/adapters/dashboard/jarvis.ts
  - src/lib/tools/dynamodb-tools.ts
  - src/lib/state/legacy-chat-migration.ts
tested_by:
  - src/adapters/dashboard/chat-stream.test.ts
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

The shipped Chat tab uses `web/src/pages/Chat.tsx` as a 591-line state and
composition shell. Transport and helpers live in the eight modules under
`web/src/lib/chat/`; the LibreChat-structured, product-themed UI lives in the
17 top-level files under `web/src/components/chat/` — 15 component files plus
the `conversation-groups.ts` helper and the `useChatScroll.ts` hook — alongside
its `lc/` donor-derived support tree. It keeps intact:

- the SSE turn stream (`POST /api/test-turn/stream`; events `chunk` cumulative,
  `tool {label, step}`, `media`, `kb`, `image`, `artifact`, `reply`, `final`,
  `error`, `done` ignored);
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
  conversations are not durable: they keep the 7-day TTL the other surfaces use.
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

## 3. Current status and current source commit

Merged into `development` as PR #129 (merge
`b3b427497d63d8f4d1faa147b46c9681c19bc460`, 2026-08-27). The merge is present
on `origin/qa` and `origin/staging`, and staging is the AWS environment reached
through the branch-to-environment mapping; it is not on `origin/production`.

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
- The owner is stamped when a conversation is created and never overwritten,
  and so is whether it expires: a principal with no person never makes a durable
  conversation expire by continuing it. `/newchat` empties the model's window but
  keeps the records.

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| Authenticated staging UI is not yet verified | Floci Bedrock stub: one chunk, no tool events; staging verification needs an owner-authorized spend-capped token | [CHATUI-008](plan.md) |
| Listing reads every message row it skips (no index, owner decision 11) | `readConversationRows` in `src/adapters/dashboard/handler.ts`; ceiling 100,000 items, then `truncated` | none open — a GSI means reopening decision 11 with the owner |
| Conversations written before P1 still carry a token-hash owner until the migration runs, and a pre-P1 turn that leaves the 20-turn window before then has no record anywhere | `src/lib/state/legacy-chat-migration.ts`; decision 46 | the S1 promotion: link the master token and run the migration (dry run, then `--apply`) straight after the deploy, before anyone chats |
| An opacity modifier on a plain semantic token still emits no CSS, so `bg-primary/10` is silently a no-op | the semantic keys in [web/tailwind.config.ts](../../../web/tailwind.config.ts) are raw `var()` strings with nowhere to inject an alpha channel; the alpha-capable `-a` siblings added by CHATUI-001 sit beside them rather than replacing them | none open — the mitigation landed in [CHATUI-001](plan.md); the standing rule is the appendix mapping (`any <color>/<opacity>` → `-a` triplet keys or `*-dim` vars only). The chat subtree observed 2026-09-20 has zero occurrences; the rest of `web/src` still has them |

## 8. Exact focused and full validation commands

Focused: `npx vitest run src/adapters/dashboard/chat-stream.test.ts
src/adapters/dashboard/chat-helpers.test.ts`, plus
`npm --prefix web run typecheck && npm --prefix web run build`.

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
