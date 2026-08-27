/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Conversations/Convo.tsx`,
 * `client/src/components/Conversations/ConvoLink.tsx`,
 * `client/src/components/Conversations/Conversations.tsx` (its `DateLabel`),
 * `client/src/components/UnifiedSidebar/mobile/Scrim.tsx` and
 * `client/src/components/UnifiedSidebar/constants.ts`.
 *
 * ── What is ported, and what could not be ──────────────────────────────────
 *
 * COPIED (presentational, near-verbatim after token translation): the row
 * chrome — `group relative`, the FLEX row, the rounded hit area, the hover
 * fill, the active state's FILL, and its left rail drawn as a `before:`
 * pseudo-element rather than a border, which is what lets the marker inset
 * from the row's top and bottom edges instead of running its full height.
 * `Convo.tsx`'s action-slot ladder — its `actionVisibilityClassName` /
 * `actionWidthClassName` pair, which is what makes the row's destructive
 * control REACHABLE ON TOUCH and makes it cost nothing when hidden; see
 * ACTION SLOT in the row below, which is the one place this file's behaviour
 * is load bearing rather than decorative. The `DateLabel` heading (its
 * 0.7rem size, its `pl-1 pt-1`, its `mt-0` on the first group and `mt-2` on
 * the rest). The drawer's easing and duration constants, and the Scrim's
 * "stay mounted, fade opacity, drop pointer-events when closed" shape.
 *
 * NOT COPIED, with reasons — the donor's list is not a component that can be
 * lifted whole:
 *
 *   - `Conversations.tsx` is a react-virtualized `List` driven by
 *     `CellMeasurerCache`, Recoil search state, an infinite react-query, a
 *     favorites query, a pinned-conversations query, a projects section and an
 *     active-jobs poll. None of those exist here (`/sessions` returns one
 *     capped array per agent, already sorted), and `react-virtualized` is a
 *     React-DOM-class-component library that would drag `preact/compat`'s
 *     legacy paths into the chat chunk to virtualize a list that is capped at
 *     tens of rows. The flattened `[header, convo, convo, …]` shape it renders
 *     IS reproduced below — as `.map()` over the grouped array.
 *   - `Convo.tsx` reads `useParams`, `useRecoilValue`, `useNavigateToConvo`,
 *     `useUpdateConversationMutation`, `useGetStartupConfig` and `useShiftKey`
 *     in its first ten lines, and its actions slot is a rename form plus a
 *     `ConvoOptions` popover for pin/share/archive/delete. This product has
 *     one action (delete) and it is a plain sibling button, so what survives
 *     is the row's markup and class list, not the component.
 *   - `ConvoLink.tsx`'s gradient fade mask (`textOverflow: clip` plus a 5rem
 *     `bg-gradient-to-l` in the row's own background colour) assumes a
 *     single-line row whose background it can name. This row is two lines —
 *     the title and, below it, the age and turn count that `relativeAge()`
 *     already produces — so it truncates with an ellipsis instead. The mask
 *     would also need a `surface-hover` alpha token that does not exist, to
 *     track the row's hover fill. What IS taken from it is that the title
 *     measures against the width actually left over: it is `min-w-0 flex-1`
 *     beside the action slot, never a fixed right padding held open for a
 *     control that may not be showing.
 *   - `NavToggle.tsx`'s two-bar animated chevron: it is an `@librechat/client`
 *     `TooltipAnchor` with a `useShortcutHint` binding. The collapse control
 *     here is a plain icon button, which is what the rest of this app's chrome
 *     uses.
 *
 * ── What round 3 changed, and why ─────────────────────────────────────────
 *
 * Two defects, both of which were in every delivered frame:
 *
 *   1. THE SCROLL CONTAINER SHIPPED RAW. `overflow-y-auto` and nothing else,
 *      so the list inherited the global `* { scrollbar-color: … }` rule and
 *      painted the PLATFORM's scrollbar — grey, with solid triangle stepper
 *      buttons — down the full height of the rail and of the drawer, and cut
 *      the row under the fold through its x-height at the seam with the
 *      New-chat footer. Both halves are fixed in `ConversationList` below and
 *      in `.chat-rail-list` / `.chat-rail-edge` (index.css), following the
 *      ruling this repo already wrote down for code blocks: a mid-glyph slice
 *      at a hard seam reads as "this panel is broken", not "this panel
 *      scrolls".
 *
 *   2. TWO RAILS READING AS ONE SLAB. The house navigation is 260px of
 *      `--color-surface`, and this rail was parked beside it at 256px of the
 *      SAME `--color-surface`, parted only by a 1px hairline — 515px, 40% of a
 *      1280 viewport, reading as one undifferentiated block against the
 *      donor's single 360px rail. The donor's own answer to two adjacent rails
 *      is a different surface token, not a heavier border: its sidebar shell
 *      is `bg-surface-primary-alt` (`--gray-50` light, `--gray-850` dark),
 *      recessed against the chat surface beside it. That is copied here as
 *      `--color-bg-sunken` (#f5f5f7 / #08080d), the house's exact analogue, on
 *      BOTH shells — and the width comes down to 224px, so the chrome to the
 *      left of the transcript is 484px rather than 515px. The rows' hover and
 *      active states move with the ground (see the row below), or a recessed
 *      panel would have quietly cost them their contrast.
 *
 * ── What round 6 changed, and why ─────────────────────────────────────────
 *
 * Three defects, all three answered by taking the donor's own treatment rather
 * than a second hand-written one:
 *
 *   1. THE CURRENT CONVERSATION WAS NOT MARKED. Round 5 lifted the active row
 *      to `--color-surface` and gave hover `surface-a/70`; on the recessed
 *      panel those measured #ffffff and #fcfcfd — 1.02:1 apart — so in a 1:1
 *      crop a hovered row read as a SECOND selected row, and the only thing
 *      separating them was a 2px bar. The row below now carries a real fill in
 *      the donor's direction and strength, and hover is a measurably weaker
 *      step of the same ladder. See the row, and `--color-row-*` in index.css.
 *
 *   2. THE MOBILE DRAWER OPENER WAS HAND-WRITTEN. It was a bare `<button>`
 *      around an 18px glyph — 30x30, no border, no ground — on a header where
 *      every other control is a bordered pill. `DrawerToggle` at the bottom of
 *      this file is the donor's `Chat/Menus/OpenSidebar.tsx` +
 *      `UnifiedSidebar/mobile/Header.tsx` treatment instead, and it draws BOTH
 *      states of the control from one function.
 *
 *   3. The `inert` flip and the focus handoff were two effects that could only
 *      both be correct by luck; they are one ordered effect now. See it above.
 *
 * ── The delete flow is NOT here ────────────────────────────────────────────
 *
 * This component renders the delete BUTTON and reports the click. Everything
 * that was paid for in blood — the synchronous `deletingRef` double-click
 * guard, the confirm step, the snapshot taken INSIDE the state updater so a
 * concurrent refresh cannot make the rollback resurrect deleted rows, and
 * `clearApiCache()` after success — stays in `pages/Chat.tsx`, untouched, next
 * to the `conversations` state it operates on. Moving that logic would have
 * meant rewriting it, and it is exactly the code that must not be rewritten.
 *
 * ── Desktop collapse and the mobile drawer are ONE component ───────────────
 *
 * Below `lg` the rail is an off-canvas drawer over the conversation; at `lg`
 * and up it is a column in the flow that collapses to a 3rem strip. Both are
 * rendered from this file, from the same list, so the two can never disagree
 * about what a conversation row looks like. The closed drawer is translated
 * fully off the viewport AND made `inert`, so it cannot cover the composer or
 * catch a tab stop — see `mobileOpen` below.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, RefObject } from 'preact';
import { PanelLeftClose, PanelLeftOpen, Plus, Trash2 } from 'lucide-preact';
import type { Conversation } from '../../lib/chat/types';
import { conversationTitle, relativeAge } from '../../lib/chat/helpers';
import { groupConversationsByDate } from './conversation-groups';

/*
 * Donor `constants.ts`: the drawer and its scrim must travel on one easing and
 * one duration or the two read as separate objects mid-slide. The values are
 * this app's own motion tokens rather than the donor's numbers — `duration-normal`
 * is 200ms and `ease-out` is the house curve (index.css) — but the rule that
 * there is exactly ONE declaration of them is the donor's, and it is why these
 * are constants instead of two class lists that happen to match today.
 */
const DRAWER_MOTION = 'transition-transform duration-normal ease-out motion-reduce:transition-none';
const SCRIM_MOTION = 'transition-opacity duration-normal ease-out motion-reduce:transition-none';

/**
 * The id of the control that OPENS the drawer (it lives in ChatHeader, because
 * a control inside the drawer cannot be the thing that reveals it). Focus
 * returns here when the drawer closes — donor `OPEN_SIDEBAR_ID`.
 */
export const OPEN_SIDEBAR_ID = 'chat-open-sidebar';

/** The drawer's own id. Donor `OpenSidebar.tsx`/`mobile/Header.tsx` both carry
 *  `aria-controls="chat-history-nav"`; without it neither toggle says WHAT it
 *  expands, and a screen reader announces two unrelated buttons. */
const DRAWER_ID = 'chat-history-nav';

/** Where the desktop collapse state is remembered. Sibling of the app shell's
 *  own `cce_sidebar_collapsed`, deliberately a different key: collapsing the
 *  conversation rail must not collapse the product's main navigation. */
const COLLAPSE_KEY = 'cce_chat_sidebar_collapsed';

/** Read the remembered desktop collapse state. Never throws — a browser with
 *  storage disabled just starts expanded. */
export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Remember the desktop collapse state across reloads. Never throws. */
export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  } catch {
    /* private mode or quota — the rail still collapses, it just won't persist */
  }
}

interface ConversationSidebarProps {
  conversations: Conversation[];
  /** The conversation currently on screen — the row that is marked active. */
  activeChatId: string;
  loading: boolean;
  /** A turn is in flight: navigating away or deleting is refused, exactly as
   *  the inline rail refused it. */
  streaming: boolean;
  /** A delete is in flight — disables every row's delete control. */
  deleting: boolean;
  onOpen: (chatId: string) => void;
  onRequestDelete: (c: Conversation) => void;
  onNewChat: () => void;
  /** Desktop only. Below `lg` the rail is a drawer and this is ignored. */
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Below `lg` only: is the off-canvas drawer showing? */
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function ConversationSidebar({
  conversations,
  activeChatId,
  loading,
  streaming,
  deleting,
  onOpen,
  onRequestDelete,
  onNewChat,
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
}: ConversationSidebarProps) {
  const groups = groupConversationsByDate(conversations);
  // What the scrolling list is re-measured against (see ConversationList): the
  // rows it holds, and whether the empty-state paragraph is standing in for
  // them. Both change the content height, and neither resizes the scroller.
  const listSignal = `${conversations.length}:${loading}`;
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes the drawer. Bound on the document rather than the panel
  // because the panel is not guaranteed to hold focus (a reader can tab out of
  // it in a browser that ignores `inert`), and "Escape gets me out" has to hold
  // from wherever focus actually is. Same shape as ConfirmDialog/Modal.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseMobile(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen, onCloseMobile]);

  // ONE effect, because `inert` and the focus handoff have to be SEQUENCED and
  // two effects cannot promise that.
  //
  // The drawer stays MOUNTED while closed so it can slide, and a translated
  // element is still focusable — a closed drawer would otherwise sit in the tab
  // order, in front of the composer, invisible. `inert` removes the whole
  // subtree from the tab order and the accessibility tree in one property, and
  // is set imperatively because it is not a JSX attribute Preact types. Feature
  // detection is via the property existing: where it does not, `aria-hidden`
  // and the off-viewport transform still hold, and the pointer cannot reach it.
  //
  // Donor `mobile/Header.tsx` (its `useEffect(… [expanded])`, and the comment
  // above it): opening makes the pane behind inert, so focus has to move INTO
  // the drawer or a keyboard reader is stranded on a control they can no longer
  // see; closing puts it back on the control that opened it. Both directions
  // depend on the order relative to `inert`, and in opposite ways —
  //
  //   opening: clear `inert` FIRST. `focus()` on an element inside an inert
  //            subtree is a silent no-op, so a handoff that ran first would do
  //            nothing at all.
  //   closing: read `document.activeElement` BEFORE setting `inert`. Making a
  //            subtree inert blurs whatever is inside it, so a containment
  //            check made afterwards always answers "focus was not in here" and
  //            the opener never gets focus back.
  //
  // The donor drives this off the commit rather than a timer for the same
  // reason ("a wall-clock timer would race the deferred state flip"), and so
  // does this.
  useEffect(() => {
    const el = drawerRef.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (mobileOpen) {
      if (el) el.inert = false;
      closeRef.current?.focus();
    } else {
      const hadFocus = el?.contains(document.activeElement) ?? false;
      if (el) el.inert = true;
      if (hadFocus) document.getElementById(OPEN_SIDEBAR_ID)?.focus();
    }
  }, [mobileOpen]);

  // ── One list, rendered into both shells ──────────────────────────────────
  const list = (
    <>
      {conversations.length === 0 && !loading && (
        <p class="px-2 py-2 text-caption text-muted">
          No past conversations yet. They appear here once you send a message.
        </p>
      )}
      {groups.map((group, groupIndex) => (
        <div key={group.label} role="group" aria-labelledby={`chat-group-${group.label}`}>
          {/* Donor DateLabel: 0.7rem, secondary ink, flush with the row's
              rounded hit area rather than with its text, and no top margin on
              the first group so the list starts at the panel's padding. */}
          <h3
            id={`chat-group-${group.label}`}
            class={`pl-1 pt-1 text-muted ${groupIndex === 0 ? 'mt-0' : 'mt-3'}`}
            style={{ fontSize: '0.7rem' }}
          >
            {group.label}
          </h3>
          <ul class="mt-1 space-y-0.5">
            {group.conversations.map((c) => {
              const active = c.chatId === activeChatId;
              const title = conversationTitle(c);
              return (
                // Donor `Convo.tsx` row container: `group relative`, and the
                // active marker is a `before:` rail inset from the row's top
                // and bottom edges — a left border would run the full height
                // and read as a table rule. It is a FLEX row (donor: `flex
                // h-12 w-full items-center`) because the action slot has to be
                // a sibling that can take zero width, not an overlay sitting
                // on reserved padding — see ACTION SLOT below.
                //
                // ROUND 6 — THE CURRENT ROW GETS THE FILL BACK. The previous
                // cut lifted the active row to `--color-surface` and gave
                // hover `surface-a/70`, which on this recessed panel measured
                // #ffffff active against #fcfcfd hovered: 1.02:1 apart. Two
                // rows, both pale, and the only thing telling them apart was a
                // 2px bar — so in a 1:1 crop a hovered row read as a SECOND
                // selected row. The donor does not make that trade: its active
                // row is `--gray-200` on a `--gray-50` panel (1.20:1) with a
                // 3px marker on top, a fill you can see across the room.
                //
                // So the ladder is now three legible grounds in the same
                // direction, and the tokens carry the numbers (index.css):
                //   light  #f5f5f7 panel → #e4e4ec hover → #d1d1db active
                //   dark   #08080d panel → #1c1c2e hover → #2a2a3d active
                // measured 1.39:1 / 1.42:1 active-vs-panel and 1.20:1 / 1.19:1
                // active-vs-hover — every one of them at or above the donor's
                // own active-vs-panel step, and hover unambiguously the weaker
                // of the two. The rail widens 2px → 3px to match the donor's.
                <li
                  key={c.chatId}
                  class={`group relative flex items-center rounded-lg transition-colors duration-fast ${
                    active
                      ? "bg-row-active shadow-xs before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-[3px] before:rounded-full before:bg-accent-bar before:content-['']"
                      : 'hover:bg-row-hover'
                  }`}
                >
                  <button
                    type="button"
                    disabled={streaming}
                    onClick={() => onOpen(c.chatId)}
                    aria-current={active ? 'true' : undefined}
                    title={title}
                    class="min-w-0 flex-1 rounded-lg py-2 pl-3 pr-2 text-left outline-none
                      transition-colors duration-fast focus-visible:ring-2
                      focus-visible:ring-inset focus-visible:ring-primary
                      disabled:opacity-50"
                  >
                    {/* The active row carries FOUR marks, not one: the rail
                        and the raised fill above, its shadow, and the title's
                        weight here. No one of them is enough on its own — the
                        fill is a 4% step in light mode, legible on a
                        calibrated display and invisible on a projector, which
                        is the moment the mark exists for. */}
                    <span
                      class={`block truncate text-body-sm text-primary ${
                        active ? 'font-semibold' : ''
                      }`}
                    >
                      {title}
                    </span>
                    {/* `text-secondary`, not `text-muted`. The rail's grounds
                        are darker now (light) and lighter (dark) than the
                        panel, and muted ink on the active row's fill measures
                        1.86:1 light / 2.30:1 dark — worse than the 2.82:1 it
                        had on the old white row. Secondary ink puts the same
                        line at 3.70:1 / 4.98:1 on the active row and 4.44:1 /
                        5.94:1 on a hovered one, so the fill is paid for
                        instead of charged to the metadata. */}
                    <span class="block text-caption text-secondary">
                      {relativeAge(c.updatedAt)}
                      {c.messageCount ? ` · ${c.messageCount} msg` : ''}
                    </span>
                  </button>
                  {/* ── ACTION SLOT ────────────────────────────────────────
                      COPIED from donor `Convo.tsx`'s action wrapper — its
                      `actionVisibilityClassName` / `actionWidthClassName`
                      ladder (donor lines 193-207) and the
                      `<div className={cn('mr-2 flex origin-left items-center
                      justify-center', …)}>` those feed. Three properties of
                      that ladder are the point, and all three are reproduced:

                        1. The hidden state is `pointer-events-none`, not just
                           `opacity-0`. An invisible control that still takes
                           taps is a destructive action fired blind.
                        2. The hidden state is `max-w-0 scale-x-0`, so it takes
                           NO width. Padding reserved for a control that is not
                           there is width stolen from the title on the surface
                           that has the least of it.
                        3. Where there is no hover, the slot is simply VISIBLE
                           — donor: `else if (… || isSmallScreen)`, commented
                           "Touch has no hover, so a reveal-on-hover menu is
                           unreachable there." Every row in the donor's own
                           mobile drawer paints its `…` unconditionally.

                      The donor branches on `useMediaQuery('(max-width: 768px)')`
                      because it already had the hook. This does it in CSS on
                      `hover: hover` — the same guard `AssistantMessage.tsx`
                      uses for its reveal-on-hover timestamp — which is the
                      more accurate test: a narrow window on a laptop still
                      hovers, and a 1024px tablet still does not. So the
                      DEFAULT here is the visible state and the hover-capable
                      media query is what hides it, never the other way round.

                      One deliberate divergence: the donor reveals to a
                      narrower slot on desktop (28px) than on touch (36px).
                      Here both are 36px — a single width, which is what lets
                      `group-hover` stay unguarded. A touch browser that
                      latches `:hover` after a tap then resolves to the width
                      the row already had, instead of shrinking the target out
                      from under the finger. 36px is also exactly what
                      `IconButton` below measures, so the row's control matches
                      the rest of this app's chrome. */}
                  <div
                    class="mr-1 flex shrink-0 origin-right items-center justify-center
                      transition-[max-width,opacity,transform] duration-fast ease-out
                      motion-reduce:transition-none
                      [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:max-w-0
                      [@media(hover:hover)]:scale-x-0 [@media(hover:hover)]:opacity-0
                      group-hover:pointer-events-auto group-hover:max-w-[2.25rem]
                      group-hover:scale-x-100 group-hover:opacity-100
                      group-focus-within:pointer-events-auto
                      group-focus-within:max-w-[2.25rem] group-focus-within:scale-x-100
                      group-focus-within:opacity-100"
                  >
                    {/* A SIBLING of the row button, never nested inside it: a
                        <button> within a <button> is invalid HTML, and nesting
                        would make one click both open and delete the
                        conversation. (Moved verbatim from the inline rail in
                        Chat.tsx — this still only REPORTS the click; the
                        synchronous guard, the confirm step and the rollback
                        stay in Chat.tsx, unchanged.)

                        Disabled is `opacity-40`, not `opacity-0`: on touch the
                        slot is painted, so a control that vanished while a
                        turn streamed would read as the row losing its delete
                        action rather than as it being briefly unavailable. */}
                    <button
                      type="button"
                      disabled={streaming || deleting}
                      onClick={(e) => { e.stopPropagation(); onRequestDelete(c); }}
                      aria-label={`Delete chat: ${title}`}
                      title="Delete chat"
                      class="flex size-9 items-center justify-center rounded-md text-muted
                        transition-colors duration-fast hover:bg-danger-a/10
                        hover:text-danger focus-visible:outline-none focus-visible:ring-2
                        focus-visible:ring-danger disabled:pointer-events-none
                        disabled:opacity-40"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );

  const newChatButton = (
    <button
      type="button"
      disabled={streaming}
      onClick={onNewChat}
      class="flex w-full items-center justify-center gap-2 rounded-lg border border-border
        bg-surface px-3 py-2 text-body-sm font-medium text-primary transition-colors
        duration-fast hover:bg-surface-hover focus-visible:outline-none
        focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
    >
      <Plus size={15} />
      New chat
    </button>
  );

  return (
    <>
      {/* ── Desktop: a column in the flow, collapsing to a 3rem strip ────── */}
      <aside
        class={`hidden shrink-0 flex-col overflow-hidden border-r border-border bg-bg-sunken
          transition-[width] duration-normal ease-out motion-reduce:transition-none lg:flex
          ${collapsed ? 'w-12' : 'w-56'}`}
        aria-label="Conversation history"
      >
        {collapsed ? (
          // The strip. Two controls, both of which the expanded panel also
          // offers, so nothing is only reachable in one state.
          <div class="flex flex-col items-center gap-1 py-3">
            {/* "Expand"/"Collapse", not "Show"/"Hide": the drawer's own control
                in the header is the one that SHOWS the history, and two
                controls in the same product answering to the same accessible
                name is how a screen-reader user ends up in the wrong mode. */}
            <IconButton
              label="Expand conversation history"
              expanded={false}
              onClick={onToggleCollapse}
            >
              <PanelLeftOpen size={18} />
            </IconButton>
            <IconButton label="New chat" disabled={streaming} onClick={onNewChat}>
              <Plus size={18} />
            </IconButton>
            {/* A quiet count, so the collapsed strip still says whether there
                is any history behind it. */}
            {conversations.length > 0 && (
              <span
                // Raised, like the rows: on the rail's recessed ground
                // `surface-hover` is a 2% step and the chip stops reading as a
                // chip at all.
                class="mt-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full
                  border border-border bg-surface px-1 text-overline text-muted"
                title={`${conversations.length} conversations`}
              >
                {conversations.length}
              </span>
            )}
          </div>
        ) : (
          <>
            <div class="flex items-center justify-between gap-2 px-3 pt-3">
              <h2 class="text-overline uppercase tracking-wider text-muted">Conversations</h2>
              <div class="flex items-center gap-1">
                {loading && <span class="text-caption text-muted">…</span>}
                <IconButton
                  label="Collapse conversation history"
                  expanded={true}
                  onClick={onToggleCollapse}
                >
                  <PanelLeftClose size={18} />
                </IconButton>
              </div>
            </div>
            <ConversationList signal={listSignal}>{list}</ConversationList>
            <div class="border-t border-border p-3">{newChatButton}</div>
          </>
        )}
      </aside>

      {/* ── Mobile: scrim + off-canvas drawer ────────────────────────────── */}
      {/* Donor `mobile/Scrim.tsx`: mounted always so it can fade, and
          `pointer-events-none` while closed — that is what keeps a closed
          drawer's scrim from swallowing a tap meant for the composer under it. */}
      <button
        type="button"
        aria-label="Close conversation history"
        tabIndex={mobileOpen ? 0 : -1}
        aria-hidden={!mobileOpen}
        onClick={onCloseMobile}
        class={`fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden ${SCRIM_MOTION}
          ${mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      />
      <div
        ref={drawerRef}
        id={DRAWER_ID}
        role="dialog"
        aria-modal={mobileOpen}
        aria-label="Conversation history"
        aria-hidden={!mobileOpen}
        class={`fixed inset-y-0 left-0 z-50 flex w-[85%] max-w-[20rem] flex-col border-r
          border-border bg-bg-sunken lg:hidden ${DRAWER_MOTION}
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* COPIED from donor `UnifiedSidebar/mobile/Header.tsx` — its row
            (`flex h-14 flex-shrink-0 items-center gap-2 border-b … px-2`) and,
            more importantly, its ORDER: the toggle leads the row in the far
            LEFT slot, wearing the same chrome as the control that opened the
            drawer, because "at full width there is nothing beside the drawer
            left to tap, so this close button is the primary dismissal. It
            mirrors the chat header's `OpenSidebar` toggle — same icon, same
            look, same far-left slot — so opening the drawer reads as the one
            persistent control flipping state, not a new X appearing
            elsewhere."

            The X that used to sit on the right is gone for exactly that
            reason. Both states are drawn by ONE component (`DrawerToggle`), so
            "same look" is guaranteed by construction rather than by two class
            lists that happen to agree. */}
        <div class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2">
          <DrawerToggle
            buttonRef={closeRef}
            label="Close conversation history"
            expanded={true}
            onClick={onCloseMobile}
          />
          <h2 class="min-w-0 flex-1 truncate text-overline uppercase tracking-wider text-muted">
            Conversations
          </h2>
          {loading && <span class="shrink-0 text-caption text-muted">…</span>}
        </div>
        <ConversationList signal={listSignal}>{list}</ConversationList>
        <div class="border-t border-border p-3">
          {/* Selecting anything in the drawer closes it — the donor's
              `toggleNav`, which every row and every action funnels through. */}
          <button
            type="button"
            disabled={streaming}
            onClick={() => { onNewChat(); onCloseMobile(); }}
            class="flex w-full items-center justify-center gap-2 rounded-lg border border-border
              bg-surface px-3 py-2 text-body-sm font-medium text-primary transition-colors
              duration-fast hover:bg-surface-hover focus-visible:outline-none
              focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            <Plus size={15} />
            New chat
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * The rail's scroll container, and the two ramps that say what it is hiding.
 *
 * WHY THIS IS A COMPONENT and not two more `overflow-y-auto` divs: it is
 * rendered into BOTH shells (the desktop column and the mobile drawer), and
 * the defect it fixes was present in both. Round 2 shipped the list as a bare
 * `<div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">`, which
 *
 *   - inherited the GLOBAL `* { scrollbar-color: … }` rule, and so painted the
 *     platform's own non-overlay scrollbar — 6px, grey, with solid triangle
 *     STEPPER BUTTONS at both ends — down the full height of a product panel
 *     that has none of that anywhere else, and
 *   - ended at a hard seam against the New-chat footer, slicing the row under
 *     the fold through its x-height with no ramp at all.
 *
 * The scrollbar half is handled in `.chat-rail-list` (index.css), which hands
 * the standard properties back to `auto` so the styled `::-webkit-scrollbar`
 * rules are honoured again. The ramp half is here, because it has to be
 * MEASURED: a fade parked permanently at the bottom of a three-row list dims a
 * row for no reason, and a fade that is missing when the list is long is the
 * defect this exists to fix. So each edge is mounted only when there is really
 * something beyond it.
 *
 * `signal` is a string the caller rebuilds whenever the row set changes; it is
 * what re-measures after /sessions lands or a row is deleted. A
 * ResizeObserver covers the box changing (the window, the collapse
 * transition), and `onScroll` covers scrolling. No polling, no interval.
 * Same shape as `useListOverflow` in CommandMenu.tsx, which does this for the
 * picker panels; it is not shared because that one also counts `role="option"`
 * rows for its "N more" pill, which a date-grouped rail has no use for.
 *
 * The 1px tolerances are not decoration: `scrollHeight`, `clientHeight` and
 * `scrollTop` are fractional on a zoomed or fractionally-scaled display, and a
 * 0.5px residue at the end of a scroll would otherwise keep claiming there is
 * more below with nothing left to show.
 */
function ConversationList({ children, signal }: { children: ComponentChildren; signal: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ up: false, down: false, more: 0 });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const up = el.scrollTop > 1;
    const down = el.scrollHeight - el.clientHeight - el.scrollTop > 1;
    // Counted from live rects rather than divided out of a row height: a row
    // whose title wraps to a second line is taller than one whose title does
    // not, so "how many fit" has no arithmetic answer.
    let more = 0;
    if (down) {
      const cut = el.getBoundingClientRect().bottom;
      for (const row of el.querySelectorAll('li')) {
        if (row.getBoundingClientRect().bottom > cut + 1) more += 1;
      }
    }
    setEdges((prev) =>
      prev.up === up && prev.down === down && prev.more === more ? prev : { up, down, more },
    );
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, signal]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    // The CONTENT too, not just the viewport: a row added or removed changes
    // what overflows without changing the scroller's own box.
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure, signal]);

  const state = edges.up && edges.down ? 'both' : edges.up ? 'up' : edges.down ? 'down' : 'none';

  return (
    // The wrapper is the flex child and the ramps' containing block; it is
    // exactly the scroller's box, so `top: 0` / `bottom: 0` land on the
    // scroller's own edges. It paints nothing and takes no pointer events of
    // its own.
    <div class="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        onScroll={measure}
        data-rail-overflow={state}
        class="chat-rail-list min-h-0 flex-1 overflow-y-auto px-3 py-2"
      >
        <div>{children}</div>
      </div>
      {edges.up && <div class="chat-rail-edge chat-rail-edge--top" aria-hidden="true" />}
      {edges.down && (
        <div class="chat-rail-edge chat-rail-edge--bottom" aria-hidden="true">
          {/* Only when a WHOLE row is hidden. A list cut two pixels short of
              its end still gets the ramp, but claiming "1 more" there would be
              a lie the reader can check by scrolling. */}
          {edges.more > 0 && <span class="chat-rail-more">{edges.more} more</span>}
        </div>
      )}
    </div>
  );
}

/**
 * THE DRAWER TOGGLE, in both of its states.
 *
 * Ported from donor `Chat/Menus/OpenSidebar.tsx` and
 * `UnifiedSidebar/mobile/Header.tsx`, which are the same control twice: the
 * donor renders each as `<Button size="icon" variant="header-action">` with an
 * `aria-label`, an `aria-expanded` reporting the drawer's state and an
 * `aria-controls` naming the drawer. That is what is copied — the icon
 * BUTTON's identity, not a bare glyph.
 *
 * ── What was wrong, and why a `<button>` was not enough ───────────────────
 *
 * The opener was hand-written here as a bare `<button>` wrapping an 18px glyph:
 * no border, no background, no shadow, 30x30 measured at 375px. On a header
 * whose every other control (both pickers, New chat, the id chip) is a
 * bordered pill on `--color-surface`, the one control that reveals the
 * conversation history was the only thing on the row with no edge — which is
 * precisely why a neutral observer could not find it. It was also under the
 * 44x44 touch minimum on the surface where it is the ONLY way to reach the
 * history at all.
 *
 * So this is `variant="header-action"` expressed in this palette: a real edge
 * (`border-border`), a real ground (`bg-surface`), a shadow lifting it off the
 * header plate, and a 44x44 box. It is the same pill the pickers beside it
 * already are, which is the donor's actual point — the toggle belongs to the
 * header's control set, not to the background.
 *
 * ── One component, both states ────────────────────────────────────────────
 *
 * The donor's Header.tsx comment is explicit that the drawer's close control
 * "mirrors the chat header's OpenSidebar toggle — same icon, same look, same
 * far-left slot". Rendering both from this one function is how that survives
 * the next edit. The icon flips `PanelLeftOpen` → `PanelLeftClose`, which is
 * the same glyph mirrored and is already what this file's desktop strip uses
 * for collapse/expand, so the whole product has one "the rail is over there"
 * icon rather than an X that appears from nowhere.
 */
function DrawerToggle({
  label,
  expanded,
  onClick,
  buttonRef,
  id,
  class: extra = '',
}: {
  label: string;
  expanded: boolean;
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement>;
  id?: string;
  class?: string;
}) {
  return (
    <button
      ref={buttonRef}
      id={id}
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={DRAWER_ID}
      title={label}
      // `size-11` is 44px — the touch minimum, and the reason this is a sized
      // box rather than padding around an 18px glyph.
      class={`flex size-11 shrink-0 items-center justify-center rounded-lg border border-border
        bg-surface text-secondary shadow-xs transition-colors duration-fast
        hover:border-border-strong hover:bg-surface-hover hover:text-primary
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${extra}`}
    >
      {expanded ? (
        <PanelLeftClose size={18} aria-hidden="true" />
      ) : (
        <PanelLeftOpen size={18} aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * The control that OPENS the drawer. Lives in the chat header (below `lg`
 * only), because a control inside the drawer cannot be the thing that reveals
 * it — donor `Chat/Menus/OpenSidebar.tsx`, which likewise sits in the chat
 * header and not in the nav it opens. `-ml-0.5` only nudges the pill's edge
 * onto the column's, nothing more.
 */
export function OpenSidebarButton({ onClick }: { onClick: () => void }) {
  return (
    <DrawerToggle
      id={OPEN_SIDEBAR_ID}
      label="Show conversation history"
      expanded={false}
      onClick={onClick}
      class="-ml-0.5 lg:hidden"
    />
  );
}

/** House icon button: same focus ring and hover fill as the rest of the chat
 *  chrome, sized for a 3rem strip. */
function IconButton({
  label,
  onClick,
  children,
  disabled = false,
  expanded,
  buttonRef,
}: {
  label: string;
  onClick: () => void;
  children: ComponentChildren;
  disabled?: boolean;
  expanded?: boolean;
  buttonRef?: RefObject<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
      class="rounded-lg p-1.5 text-secondary transition-colors duration-fast
        hover:bg-surface-hover hover:text-primary focus-visible:outline-none
        focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
    >
      {children}
    </button>
  );
}
