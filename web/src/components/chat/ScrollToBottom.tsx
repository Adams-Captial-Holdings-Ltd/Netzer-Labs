/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor path
 * `client/src/components/Messages/ScrollToBottom.tsx`.
 *
 * A round icon button that sits in its own lane directly above the composer,
 * centred in the content column, and appears only once the reader has left the
 * end of the conversation.
 *
 * ── Why it has a LANE instead of floating (CHATUI-00x) ─────────────────────
 *
 * The donor floats this control over the transcript (`absolute bottom-full`,
 * right-aligned), and so did the first cut here. Measured, that put a 36px
 * circle on top of the message underneath it at every breakpoint: on desktop
 * over the rounded top-right corner of a bash panel, ~30px from its Copy
 * control, drawing the panel's own corner underneath itself; on mobile
 * squarely over the code body, obscuring `onText(this.buffer);` and the
 * closing brace.
 *
 * That is not a positioning bug with a better offset waiting to be found. A
 * floating control cannot be placed clear of content, because the content
 * moves under it — whatever is at that coordinate is a function of scroll
 * position, and every scroll position is reachable. The only arrangement that
 * is clear of content at EVERY scroll position is one that content cannot
 * occupy, so the button gets a lane of its own inside the composer's opaque
 * plate (ChatCanvas), between the transcript's fade and the input.
 *
 * The lane's height is CONSTANT — reserved whether or not the button is
 * showing — for the reason the floating version was chosen in the first place:
 * a control that takes height only while visible moves the transcript every
 * time it appears or disappears, which is worse than the overlap it fixes.
 *
 * Two details are ported verbatim because they are the difference between a
 * control and a trap:
 *
 *   1. The lane is `pointer-events-none` and only the button opts back in.
 *      The lane spans the column, so without this it would swallow clicks
 *      aimed at whatever sits beside the button.
 *   2. While hidden, the button is BOTH `pointer-events-none` and `disabled`.
 *      Fading alone is not hiding: a fully transparent enabled button still
 *      takes the click and still answers Enter from the tab order, so a reader
 *      tabbing through a finished conversation would hit an invisible control.
 *      The donor's `disabled:opacity-100` note applies here too — the lane
 *      owns the fade, so `disabled` must not add a second one on top of it.
 *      That is why this is a raw <button> and not the app's <Button>, whose
 *      `disabled:opacity-50` would fight the transition.
 */
import { ChevronDown } from 'lucide-preact';

interface ScrollToBottomProps {
  /** True once the reader has scrolled away from the end. */
  visible: boolean;
  onClick: () => void;
}

export function ScrollToBottom({ visible, onClick }: ScrollToBottomProps) {
  return (
    // The lane. `h-9` is the button's own height and never changes, so the
    // composer below it does not move and neither does the transcript above.
    <div
      class={`pointer-events-none flex h-9 items-center justify-center pb-1
        transition-opacity duration-normal ${visible ? 'opacity-100' : 'opacity-0'}`}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={!visible}
        aria-label="Scroll to the latest message"
        title="Scroll to the latest message"
        class={`flex size-8 items-center justify-center rounded-full border border-border
          bg-surface text-secondary shadow-md transition-colors duration-fast
          hover:bg-surface-hover hover:text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
          ${visible ? 'pointer-events-auto' : 'pointer-events-none'}`}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
