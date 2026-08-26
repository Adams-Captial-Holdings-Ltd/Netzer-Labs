---
feature: netzar-chat
document_role: backlog
status: accepted
observed_at: 2026-08-25
as_of_commit: 06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710
---

# LibreChat chat UI port — approved plan and phase backlog

The approved execution queue for the port. The [feature README](README.md) owns
the durable view (donor pin, token mapping); [HANDOFF](HANDOFF.md) owns current
state; session logs live in [handoffs/](handoffs/).

## Context

Adopt the UI structure of danny-avila/LibreChat's `client/` (MIT, pinned — see
README) into the dashboard Chat tab, re-themed with this product's tokens.
LibreChat is the visual/structural donor only; the app's data layer stays
intact and every agent and model reachable today stays reachable.

Confirmed decisions (2026-08-25, session owner):

1. **Preact-native source-level port** — copy donor JSX/Tailwind markup and
   interaction patterns into Preact; no `react`→`preact/compat` aliasing; the
   only new runtime dependency is `highlight.js` (`lib/common`), loaded solely
   by the lazy chat chunk.
2. **Full promotion to staging** — PR into `development`, merge on green CI,
   promote `qa` → `staging` (auto-deploys staging), verify there. Production
   untouched.
3. **ToolCallsSection, UI-only fidelity** — accumulate the existing SSE
   `tool {label, step}` events into `Message.tools` and render a collapsible
   "Used N tools" section under assistant replies (stacked category icons,
   per-call label rows). No backend change; no Input/Output panels (the wire
   does not carry them). Live turns only; historical turns keep the run
   footer's tool count.

## Invariants (behavior preserved byte-for-byte)

- Wire contract of `POST /api/test-turn/stream` and its event set (`chunk`
  cumulative, `tool`, `media`, `kb`, `image`, `artifact`, `reply`, `final`,
  `error`, `done` ignored); `GET /agents` active filter; `GET /models` with
  `''` = agent default (no `modelOverride` sent).
- Documented bug fixes move verbatim: `freshChatId` (`dashboard:` prefix),
  `cce_chat_active` persistence, `friendlyStreamError`, `deletingRef` guard,
  `confirmDelete` snapshot rollback, `clearApiCache()` after send/delete,
  DOMPurify last before `dangerouslySetInnerHTML`.
- `web/src/App.tsx` route paths and `RequireCapability` strings unchanged
  (`src/lib/jarvis/route-manifest.test.ts` parses them).
- `data-tour` anchors survive on equivalent elements.
- `.chat-md` extended additively only (shared with WarRoom and Playground).
- Chat-surface parity obligations per [CLAUDE.md](../../../CLAUDE.md) are
  restyled, never dropped.
- Out of scope: `AgentDetail.tsx` ChatTab, app shell, all other pages, backend.

## Design summary

- Phase 0 extracts `web/src/lib/chat/{types,helpers,stream,uploads,markdown}.ts`
  under golden tests written first; `streamTurn()` gains an optional
  `AbortSignal` and accumulates `tools` (additive).
- Theming adds RGB-triplet vars (`--color-primary-rgb`, `--color-bg-rgb`,
  `--color-danger-rgb`) in `:root` and `.dark`, additive alpha-capable Tailwind
  keys (`primary-a`, `bg-a`, `danger-a`, `*-dim` aliases), and `applyBrand()`
  co-writes the primary triplet. Token translation table: README appendix.
- New components under `web/src/components/chat/`: ChatHeader,
  ConversationSidebar, MessagesView, MessageRow, AssistantMessage, UserMessage,
  StreamingRow, ScrollToBottom, Composer, CommandMenu, AgentMenu, ModelMenu,
  ToolCallsSection. `Chat.tsx` becomes a composition shell; shared content
  column `md:max-w-3xl xl:max-w-4xl`. Ported files carry the donor header
  comment (MIT attribution + pinned SHA + donor path).

## Phase backlog

Each phase is gated by a builder + separate blind critic comparing against the
frozen LibreChat screenshot bar AND the product's own pages; a phase closes
only when the critic picks ours. A dated session handoff closes every phase.

### CHATUI-000 — Phase 0: scaffolding + extraction

Golden tests, lib/chat extraction (zero visual change), dev mock-SSE Vite
plugin + fixtures behind `CCE_CHAT_MOCK=1`, frozen LibreChat bar screenshots,
baseline recorded.

```yaml
outcome: landed
reachable_commit: 9c8adcd404ea92a8ca54b58ef6f4ecdde7c7e929
present_in_current_source: true
deployment: none
verification: code_verified
```

### CHATUI-001 — Phase 1: theming foundation

Alpha tokens, `.chat-md` code-block chrome + scoped hljs palette,
`highlight.js` dep, white-label support. Chat-chunk bundle delta ≤ 70 KB gzip.

```yaml
work_state: in_progress
```

### CHATUI-002 — Phase 2: layout shell + header

Open canvas, shared column, ChatHeader overlay; tour anchors and NEW CHAT
dialog unchanged.

```yaml
work_state: in_progress
```

### CHATUI-003 — Phase 3: message list

MessageRow port, event renderings, scroll behavior, streaming states. Includes
Phase 3b: ToolCallsSection (decision 3 above).

Phase 3b is evidenced by the `tools` fixture, which is the only one that drives
both of its deliverables: the live tool-status line and the settled "Used N
tools" section. Its `delayMs` holds each status window ~1s so the live line is
observable at all — at token cadence it exists for a single frame and no
capture can show it. The capture harness asserts the heading, `aria-expanded`,
the per-call `{step, label}` rows and the run footer out of the live DOM into
PROVENANCE.json, so the section's existence is a recorded fact rather than a
claim. Cancelling a live turn (Send↔Stop, partial text kept) landed here rather
than in CHATUI-004 because a turn that cannot be read or stopped is a message
list defect, not a composer feature.

```yaml
work_state: in_progress
```

### CHATUI-004 — Phase 4: composer

Autosize card, Send↔Stop with abort keeping partial text, attachments,
identical disabled logic.

```yaml
work_state: approved
```

### CHATUI-005 — Phase 5: agent + model picker

CommandMenu/AgentMenu/ModelMenu; gate includes the roll-call: every active
agent and every model plus "Agent default" reachable and selectable; deep-link
preselect; keyboard-only selection.

```yaml
work_state: approved
```

### CHATUI-006 — Phase 6: conversation sidebar

Date groups, delete flow preserved, desktop collapse + minimal mobile drawer.

```yaml
work_state: approved
```

### CHATUI-007 — Phase 7: polish, docs, ship

Full validation suite, doc owners refreshed (`delete-chat`,
`persistent-workspaces`, `paperclip/bar-and-phases.md` line pins),
PR → `development`, promote `qa` → `staging`, staging QA, final full-journey
blind critic.

```yaml
work_state: approved
```

## Verification

- Unit tests in the root suite: `src/adapters/dashboard/chat-stream.test.ts`,
  `chat-helpers.test.ts`, `chat-source-contract.test.ts`.
- Local streaming UX via the mock-SSE fixtures (Floci's Bedrock stub cannot
  stream or emit tool events — see
  [development.md known limitations](../../../development.md#known-local-limitations)).
- Browser QA per phase: both themes, 1280×800 + 375×812, keyboard-only,
  reduced-motion, WarRoom/Playground markdown unchanged, tour anchors resolve.
- Staging (Phase 7): real streaming cadence, live tool statuses, image and
  artifact turns, `modelOverride` verified via the run footer's modelId, agent
  roll-call, delete + reload-resume, mobile spot check.

## Top risks and mitigations

1. Refactor breaks documented bug fixes → verbatim moves, golden tests first,
   source-contract test.
2. SSE semantics drift → golden tests recorded before extraction; injectable
   fetch for split-read cases.
3. White-label drift → `applyBrand` co-writes the triplet; theme-switch step in
   every critic pass.
4. `.chat-md` regression in WarRoom/Playground → additive selectors +
   screenshot checks.
5. Preact CommandMenu a11y depth vs Ariakit → scope to donor-visible behavior;
   keyboard-only gate; old Selects stay until the Phase-5 swap commit.
6. Bar drift between critic loops → bar captured once in Phase 0 and frozen.
7. Streaming truth only on staging → mock harness locally + explicit staging
   script before claiming completion.
8. Bundle bloat → `highlight.js/lib/common` only, in the lazy chat chunk;
   measured against the ≤ 70 KB budget.
