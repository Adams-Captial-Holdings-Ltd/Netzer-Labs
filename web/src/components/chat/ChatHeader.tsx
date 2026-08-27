/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor path
 * `client/src/components/Chat/Header.tsx`.
 *
 * What is ported: the header floats over the top of the conversation rather
 * than being a chrome bar bolted to the app frame, so the transcript scrolls
 * *under* it, and its controls read as free-standing pills rather than as a
 * toolbar. Donor tokens are translated per docs/features/netzar-chat/README.md;
 * no donor colour survives.
 *
 * What is NOT ported: the donor's preset, bookmark and multi-convo menus. This
 * product's header carries the governance controls instead — which agent,
 * which model, and the conversation id the audit trail keys on. The donor's
 * endpoint menu IS ported, as of Phase 5 (CHATUI-005): its structure is what
 * AgentMenu and ModelMenu are built on (see CommandMenu), because a roster of
 * seventeen agent templates and a multi-family model catalog are exactly the
 * problem that menu was shaped to solve.
 *
 * ── It is a FLOATING OVERLAY, and it declares that ─────────────────────────
 *
 * Two earlier cuts each failed in the same way from opposite ends, so the
 * treatment is now committed to explicitly rather than left implied:
 *
 *   1. A single `bg-gradient-to-b from-bg-a … to-transparent` band. Every
 *      pixel of it was partly transparent, so a message scrolled under it
 *      composited THROUGH the title — running body copy drew straight into the
 *      conversation name and produced smears like "/fixturthecoideb", and word
 *      fragments leaked out of the gaps between the pills. A gradient can fade
 *      glyphs; it can never occlude them.
 *   2. An opaque plate with no edge of any kind — no border, no radius, no
 *      shadow, and no bar rule either. That reads as nothing at all: the
 *      controls simply hang in space over the conversation, and the only thing
 *      separating them from the first message is luck.
 *
 * So this header commits to ONE treatment and states it in the class list: an
 * opaque floating panel, hung from the top of the reading column, with a
 * hairline on the three edges it actually has and a soft shadow lifting it off
 * the ground. `bg-surface` (not the canvas's `bg-bg`) is what makes it read as
 * a panel rather than as a hole in the page, and being fully opaque is what
 * makes text passing underneath DISAPPEAR instead of smearing — in both
 * themes, with no blur to depend on.
 *
 * ── It declares no measure of its own ──────────────────────────────────────
 *
 * The header is a child of the shared content column (see ChatCanvas), stuck
 * to its top edge. It is therefore laid out by the same containing block as
 * every message under it, which is the only way its edges can be guaranteed to
 * match theirs. It used to be an `absolute` overlay on the pane instead, with
 * its own `px-3 sm:px-4`; measured at 1280 that left its content box at
 * 532…1264 against a column at 542…1254 — 10px proud on both sides, because a
 * box outside the scrollport cannot see the `scrollbar-gutter` reservation
 * that narrows the boxes inside it. No padding value fixes that; only being in
 * the same containing block does.
 *
 * `COLUMN_BLEED_X` / `COLUMN_PX` are the one padding value, exported as a pair
 * from ChatCanvas: the first bleeds the plate out over the column's padding so
 * the panel spans the scrollport, the second puts the controls back exactly on
 * the column's edges.
 *
 * A sticky element occupies its own height in the flow, so nothing has to
 * measure this header and pad the transcript by it — which is why the
 * `--chat-header-h` custom property, its ResizeObserver and its two fallback
 * breakpoints are gone rather than merely retuned.
 */
import { Plus } from 'lucide-preact';
import type { Agent, Model } from '../../lib/chat/types';
import { Button } from '../Button';
import { InfoTooltip } from '../InfoTooltip';
import { AgentMenu } from './AgentMenu';
import { ModelMenu } from './ModelMenu';
import { OpenSidebarButton } from './ConversationSidebar';
import { COLUMN_BLEED_X, COLUMN_PX } from './ChatCanvas';

interface ChatHeaderProps {
  /** Conversation title — the opening user line, or "New chat". */
  title: string;
  agents: Agent[];
  agentId: string;
  onSelectAgent: (id: string) => void;
  models: Model[];
  modelId: string;
  onSelectModel: (id: string) => void;
  /** The `dashboard:<epoch-ms>` id this turn is filed under. */
  chatId: string;
  streaming: boolean;
  onNewChat: () => void;
  /** Opens the conversation drawer. Rendered only below `lg`, where the
   *  conversation rail is off-canvas and has no control of its own on screen
   *  (donor `Chat/Menus/OpenSidebar.tsx`). Omit it and no button appears. */
  onOpenSidebar?: () => void;
}

export function ChatHeader({
  title,
  agents,
  agentId,
  onSelectAgent,
  models,
  modelId,
  onSelectModel,
  chatId,
  streaming,
  onNewChat,
  onOpenSidebar,
}: ChatHeaderProps) {
  return (
    // The bleed layer: no paint of its own, it only cancels the column's
    // padding so the panel below can span the scrollport.
    <div class={`sticky top-0 z-20 ${COLUMN_BLEED_X}`}>
      {/* THE PANEL. Opaque, so nothing composites through it; a hairline on the
          bottom, a radius and a soft shadow, so it is unambiguously an object
          sitting over the conversation rather than an undeclared band of
          colour.

          The hairline is `border-b` ONLY, and that is a layout decision, not a
          taste one. Tailwind's box model is `border-box`, so a border down the
          left and right sides eats 1px out of the padding box at each end and
          lands the controls at 543…1253 against a column at 542…1254 — the
          same near-miss, one tenth the size, reintroduced by the fix for it.
          The alternatives were a second declaration of the column's padding
          (`px-[calc(1rem-1px)]`) or a bleed that knows about the border
          (`-mx-[17px]`); both re-state a constant this file is not allowed to
          own. `bg-surface` against the canvas's `bg-bg`, plus the shadow, is
          what declares the sides. */}
      <div class={`rounded-b-xl border-b border-border bg-surface shadow-sm ${COLUMN_PX}`}>
        <div class="flex flex-wrap items-center gap-2 py-3">
          {/* Mobile falls back to DOM order (the drawer control + title + New
              chat, then the pickers on their own line because that group is
              w-full); sm+ reorders to title · pickers · New chat on a single
              row. The drawer control keeps DOM order in every case — it is
              `lg:hidden`, and by the breakpoint the reorder matters at, the
              rail it opens is a column in the flow instead. */}
          {onOpenSidebar && <OpenSidebarButton onClick={onOpenSidebar} />}
          <h1
            data-tour="chat-title"
            title={title}
            class="min-w-0 flex-1 truncate text-heading-sm font-semibold text-primary
              sm:order-1 sm:flex-none sm:max-w-[14rem] lg:max-w-[22rem]"
          >
            {title}
          </h1>

          <div
            data-tour="chat-new-chat"
            class="flex shrink-0 items-center gap-2 sm:order-3 sm:ml-auto"
          >
            {/* Which conversation the transcript, cost ledger and audit rows are
                filed under. Governance detail, deliberately visible — it just
                stands down to a quiet monospace chip once the canvas gets narrow.
                `bg-bg` rather than `bg-surface`: the panel is now surface, so a
                surface chip on it would have no edge of its own. */}
            <span
              class="hidden items-center gap-1 rounded-lg border border-border bg-bg px-2 py-1
                font-mono text-caption text-muted xl:inline-flex"
            >
              {chatId}
              <InfoTooltip term="dashboard:" />
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={streaming}
              icon={<Plus size={14} />}
              onClick={onNewChat}
            >
              New chat
            </Button>
          </div>

          {/* w-full on mobile forces the pickers onto their own line; sm:w-auto
              folds them back inline. */}
          <div class="flex w-full min-w-0 items-center gap-2 sm:order-2 sm:w-auto">
            {/* The two pickers are searchable command menus as of Phase 5
                (CHATUI-005); the tour anchors stay on the wrappers, which is
                where they have always been, so the anchor does not depend on
                which control is inside. */}
            <span data-tour="chat-agent-picker" class="min-w-0">
              <AgentMenu
                agents={agents}
                agentId={agentId}
                onSelect={onSelectAgent}
                disabled={streaming}
              />
            </span>
            {/* Rendered unconditionally. The old `models.length > 0` guard made
                the model picker — and its tour anchor — disappear entirely
                whenever /models failed or a deployment configured no catalog,
                which is exactly when an operator most needs to see that the
                turn is running on the agent's own model. With no catalog the
                menu still offers "Agent default", which is the honest state. */}
            <span data-tour="chat-model-picker" class="min-w-0">
              <ModelMenu
                models={models}
                modelId={modelId}
                onSelect={onSelectModel}
                disabled={streaming}
              />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
