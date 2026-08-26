/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/ChatView.tsx` and
 * `client/src/components/Chat/Input/ChatForm.tsx`.
 *
 * ── This file IS the shared content column ─────────────────────────────────
 *
 * The donor's surface reads as one measure: in the reference frame its prose,
 * both code blocks and the composer share a left edge and a right edge to
 * within 2px. That is not something several components can agree on by each
 * quoting the same `max-w-*` class — as long as the column is declared more
 * than once, anything that differs between the boxes (a reserved scrollbar
 * gutter, a stray padding, a viewport that caps one and not the other) moves
 * one edge and not the other, and the surface grows a dead gutter down one
 * side.
 *
 * So the column is declared ONCE, here, and the header, the transcript and the
 * composer are its three children:
 *
 *     canvas (scrolls, full-bleed — the scrollbar rides the pane edge)
 *       └── column  ← mx-auto w-full px-4 md:max-w-3xl xl:max-w-4xl
 *             ├── header    (sticky to the column's TOP edge)
 *             ├── children  (MessagesView — the transcript)
 *             └── composer  (sticky to the column's BOTTOM edge)
 *
 * All three are laid out in the same containing block, so their content boxes
 * are identical by construction: same left edge, same right edge, same width,
 * at every viewport, whether or not a scrollbar is drawn. There is no
 * measurement to get wrong and nothing to keep in sync.
 *
 * ── Why the header is INSIDE the scroller too (CHATUI-00x) ─────────────────
 *
 * It used to be a sibling of the canvas — `absolute inset-x-0 top-0` over the
 * pane — re-declaring the measure with its own `px-3 sm:px-4`. Measured at
 * 1280 that put the header's content box at 532…1264 against a column at
 * 542…1254: the title's ink started 10px left of every message and the New
 * chat button's right border finished 10px right of the composer. The 10px is
 * not a typo in a padding value, and no padding value can fix it — it is the
 * `scrollbar-gutter` reservation, which narrows boxes INSIDE the scrollport
 * and cannot narrow a box outside it. A near-miss like that reads as a bug
 * precisely because it is too small to be a choice.
 *
 * Parenting the header into the column deletes the arithmetic: it is now
 * measured by the same containing block as the messages under it. `-mx-4`
 * bleeds its plate back out over the column's own padding so the bar spans the
 * scrollport, and `px-4` — THE SAME CONSTANT, exported below so neither can
 * drift from the other — puts its contents back on the column's edges.
 *
 * It also deletes the `--chat-header-h` machinery this file used to depend on.
 * A sticky element occupies its own height in the flow, so the first message
 * cannot be laid out underneath it; there is no height to measure, publish as
 * a custom property, and pad the transcript by.
 *
 * ── Why the composer is INSIDE the scroller ────────────────────────────────
 *
 * Same reason. The obvious alternative — scroller and composer as siblings —
 * puts the composer outside the scrolled content box, so the scrollbar gutter
 * narrows the transcript's column and not the composer's, and the two drift
 * apart by half a scrollbar wherever the viewport (rather than `max-w-*`) is
 * what caps the column.
 *
 * `position: sticky` keeps it pinned to the bottom of the scrollport, so it
 * behaves exactly like a fixed footer, with two things falling out for free:
 * at full scroll its natural position IS the foot of the transcript (no
 * overlap, no reserved padding to keep in sync with its height), and a wheel
 * gesture over the composer scrolls the conversation, because the pointer is
 * over the scroll container.
 *
 * `scrollbar-gutter: stable both-edges` stays on the canvas so the column
 * keeps its axis when a short chat grows long enough to need a scrollbar —
 * without it the whole column, header and composer included, jumps sideways at
 * that moment. All three children sit inside that reservation, so it never
 * separates them.
 */
import type { ComponentChildren } from 'preact';

/**
 * The column's horizontal padding, and the exact negative margin that undoes
 * it. Exported as a pair because the header's plate has to bleed out over the
 * padding and then put its contents back on it — two classes that must always
 * name the same number. Spelled literally (`px-4`, `-mx-4`) so Tailwind's
 * source scanner still sees them.
 */
export const COLUMN_PX = 'px-4';
export const COLUMN_BLEED_X = '-mx-4';

/**
 * The shared reading measure. Exported for anything that must line up with the
 * column from OUTSIDE the canvas; the header, the transcript and the composer
 * inherit it from the wrapper and must not re-declare it.
 */
export const CONTENT_COLUMN = 'mx-auto w-full min-w-0 px-4 md:max-w-3xl xl:max-w-4xl';

interface ChatCanvasProps {
  /**
   * The chat header (ChatHeader) — first child of the column, stuck to its top
   * edge. It declares no measure of its own; it is on the column's edges
   * because it is IN the column.
   */
  header?: ComponentChildren;
  /** The transcript (MessagesView) — second child of the column. */
  children: ComponentChildren;
  /** The composer — last child of the column, stuck to its bottom edge. */
  composer: ComponentChildren;
  /**
   * The scroll container itself, handed out so the page's scroll behaviour
   * (useChatScroll) can read and set its position. This element is the only
   * scrollport on the canvas — header, transcript and composer all live inside
   * it — so it is the one thing an outside observer needs.
   */
  scrollRef?: { current: HTMLDivElement | null };
  /**
   * The scroll-to-bottom affordance. Rendered in the STICKY block's own flow,
   * in a lane of constant height above the composer, NOT floating over the
   * transcript — see the note at the call site.
   */
  affordance?: ComponentChildren;
}

export function ChatCanvas({
  header,
  children,
  composer,
  scrollRef,
  affordance,
}: ChatCanvasProps) {
  return (
    // `data-tour="chat-messages"` stays on the scroll container: it is the
    // element the tour points at and the element a driver scrolls, and it is
    // still the box the conversation lives in.
    <div
      ref={scrollRef}
      data-tour="chat-messages"
      class="relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden
        [scrollbar-gutter:stable_both-edges]"
    >
      {/* THE COLUMN. `flex-1` makes it at least as tall as the canvas, which is
          what keeps the composer at the bottom of an empty chat instead of
          floating up under the greeting. */}
      <div class={`${CONTENT_COLUMN} flex flex-1 flex-col`}>
        {header}
        {children}

        <div class="sticky bottom-0 z-10">
          {/* The transcript dissolves into the composer instead of being cut by
              it. `from-bg-a` is the alpha-capable ground colour, so the ramp
              stays in one hue in both themes. Not hit-testable: clicks and
              wheels belong to the message underneath. */}
          <div class="pointer-events-none h-6 bg-gradient-to-t from-bg-a" aria-hidden="true" />
          {/* The plate. Opaque `bg-bg` — the same ground the transcript is on —
              so a message scrolling under the composer is occluded outright
              rather than compositing through it.

              The affordance is INSIDE the plate, above the composer, and its
              lane is reserved whether or not the button is showing. Floating it
              over the transcript (`absolute bottom-full`, which is what this
              was) is what put a 36px circle on top of a code panel's rounded
              corner, 30px from its Copy control on desktop and directly over
              `onText(this.buffer);` on mobile. A floating control cannot be
              positioned clear of content, because the content moves under it;
              only a reserved lane can. Constant height, so the transcript does
              not move when the button comes and goes. */}
          <div class="bg-bg pb-4 pt-1">
            {affordance}
            {composer}
          </div>
        </div>
      </div>
    </div>
  );
}
