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
 * within 2px. That is not something two components can agree on by both
 * quoting the same `max-w-*` class — as long as the column is declared twice,
 * anything that differs between the two boxes (a reserved scrollbar gutter, a
 * stray padding, a viewport that caps one and not the other) moves one edge
 * and not the other, and the surface grows a dead gutter down one side.
 *
 * So the column is declared ONCE, here, and the transcript and the composer
 * are its two children:
 *
 *     canvas (scrolls, full-bleed — the scrollbar rides the pane edge)
 *       └── column  ← mx-auto w-full px-4 md:max-w-3xl xl:max-w-4xl
 *             ├── children   (MessagesView — the transcript)
 *             └── composer   (sticky to the column's bottom edge)
 *
 * Both children are laid out in the same containing block, so their content
 * boxes are identical by construction: same left edge, same right edge, same
 * width, at every viewport, whether or not a scrollbar is drawn. There is no
 * measurement to get wrong and nothing to keep in sync.
 *
 * ── Why the composer is INSIDE the scroller ────────────────────────────────
 *
 * Because that is what makes the guarantee above free. The obvious alternative
 * — scroller and composer as siblings — puts the composer outside the scrolled
 * content box, so the scrollbar gutter narrows the transcript's column and not
 * the composer's, and the two drift apart by half a scrollbar wherever the
 * viewport (rather than `max-w-*`) is what caps the column. The previous cut
 * papered over that by measuring the gutter in JS and mirroring it onto the
 * composer; parenting the composer into the scroller deletes the problem
 * instead of compensating for it.
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
 * without it the whole column, composer included, jumps sideways at that
 * moment. Both children sit inside that reservation, so it never separates
 * them.
 */
import type { ComponentChildren } from 'preact';

/**
 * The shared reading measure. Exported for anything that must line up with the
 * column from OUTSIDE the canvas; the transcript and composer inherit it from
 * the wrapper and must not re-declare it.
 */
export const CONTENT_COLUMN = 'mx-auto w-full min-w-0 px-4 md:max-w-3xl xl:max-w-4xl';

interface ChatCanvasProps {
  /** The transcript (MessagesView) — first child of the column. */
  children: ComponentChildren;
  /** The composer — second child of the column, stuck to its bottom edge. */
  composer: ComponentChildren;
  /**
   * The scroll container itself, handed out so the page's scroll behaviour
   * (useChatScroll) can read and set its position. This element is the only
   * scrollport on the canvas — the transcript and the composer both live
   * inside it — so it is the one thing an outside observer needs.
   */
  scrollRef?: { current: HTMLDivElement | null };
  /**
   * Floating affordance for the scrollport (ScrollToBottom). Rendered inside
   * the STICKY block rather than the scrolled content, and positioned against
   * it, so it stays pinned above the composer instead of scrolling away with
   * the message it was offering to leave — and takes no height in the flow,
   * so its appearing and disappearing cannot move the transcript.
   */
  affordance?: ComponentChildren;
}

export function ChatCanvas({ children, composer, scrollRef, affordance }: ChatCanvasProps) {
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
        {children}

        {/* `sticky` is a positioned element, so it is the containing block the
            affordance's `absolute bottom-full` resolves against — no extra
            wrapper and no `relative` needed. */}
        <div class="sticky bottom-0 z-10">
          {affordance}
          {/* The transcript dissolves into the composer instead of being cut by
              it — the same two-layer trick the header uses (mask-fade over an
              opaque plate), mirrored. `from-bg-a` is the alpha-capable ground
              colour, so the ramp stays in one hue in both themes. Not
              hit-testable: clicks and wheels belong to the message underneath. */}
          <div class="pointer-events-none h-6 bg-gradient-to-t from-bg-a" aria-hidden="true" />
          {/* The plate. Opaque `bg-bg` — the same ground the transcript is on —
              so a message scrolling under the composer is occluded outright
              rather than compositing through it. */}
          <div class="bg-bg pb-4 pt-1">{composer}</div>
        </div>
      </div>
    </div>
  );
}
