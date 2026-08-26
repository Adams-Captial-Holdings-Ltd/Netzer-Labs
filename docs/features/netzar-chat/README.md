---
feature: netzar-chat
document_role: index
status: current
observed_at: 2026-08-25
as_of_commit: 06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710
implemented_by:
  - web/src/pages/Chat.tsx
  - web/src/index.css
  - web/tailwind.config.ts
  - web/src/lib/theme.ts
tested_by:
  - src/lib/jarvis/route-manifest.test.ts
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

Today the Chat tab is a single 838-line component (`web/src/pages/Chat.tsx`)
with a basic bubble UI. The port decomposes it into `web/src/lib/chat/*`
(transport + helpers, behavior-identical) and `web/src/components/chat/*`
(LibreChat-structured UI re-themed to this product), keeping intact:

- the SSE turn stream (`POST /api/test-turn/stream`; events `chunk` cumulative,
  `tool {label, step}`, `media`, `kb`, `image`, `artifact`, `reply`, `final`,
  `error`, `done` ignored);
- agent selection wired to `GET /agents` (active only) and `/chat/:agentId`;
- per-turn model selection wired to `GET /models` and the `modelOverride` field
  (`''` = agent default, no override sent);
- the chat-surface parity obligations (live tool status, streaming placeholder,
  run footer, error bubble, kb/image/artifact renderings) per
  [CLAUDE.md](../../../CLAUDE.md).

It is **not yet** any of: implemented (work in progress — see HANDOFF), a change
to any other page, a change to `AgentDetail.tsx`'s ChatTab, or a change to the
backend.

## 3. Current status and current source commit

Planned and in progress on branch `feature/netzar-chat`, based on
`development` at `06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710`. This is source
evidence only; nothing is deployed.

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
| Chat page (pre-port) | `web/src/pages/Chat.tsx` | Monolith: sidebar, header, list, composer, dialogs |
| SSE client | `web/src/pages/Chat.tsx` (send()) | fetch+reader, hand-rolled SSE framing |
| Markdown | `web/src/pages/Chat.tsx` + `.chat-md` in `web/src/index.css` | marked → DOMPurify, shared prose block |
| Route | `web/src/App.tsx` (`/chat`, `/chat/:agentId`) | Parsed by `src/lib/jarvis/route-manifest.test.ts` — do not change |

(The port updates this table as files land; each phase's handoff records the
delta.)

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

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| Opacity-modifier Tailwind classes on semantic tokens emit no CSS | raw `var()` strings in `web/tailwind.config.ts` lack `<alpha-value>` | [CHATUI-001](plan.md) |
| Streaming/tool UX unverifiable locally | Floci Bedrock stub: one chunk, no tool events (`development.md` known limitations) | [CHATUI-000](plan.md) mock harness; [CHATUI-007](plan.md) staging QA |

## 8. Exact focused and full validation commands

Focused: `npx vitest run src/adapters/dashboard/chat-stream.test.ts
src/adapters/dashboard/chat-helpers.test.ts` (once they exist), plus
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
git diff --check
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
