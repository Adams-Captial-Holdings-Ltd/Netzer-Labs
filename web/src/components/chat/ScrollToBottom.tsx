/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor path
 * `client/src/components/Messages/ScrollToBottom.tsx`.
 *
 * A round icon button that floats just above the composer, right-aligned to the
 * content column, and appears only once the reader has left the end of the
 * conversation.
 *
 * Two details are ported verbatim because they are the difference between a
 * control and a trap:
 *
 *   1. The wrapper is `pointer-events-none` and only the button opts back in.
 *      The wrapper spans the column, so without this it would swallow clicks
 *      aimed at the last line of the reply underneath it.
 *   2. While hidden, the button is BOTH `pointer-events-none` and `disabled`.
 *      Fading alone is not hiding: a fully transparent enabled button still
 *      takes the click and still answers Enter from the tab order, so a reader
 *      tabbing through a finished conversation would hit an invisible control.
 *      The donor's `disabled:opacity-100` note applies here too — the wrapper
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
    // `bottom-full` against the sticky composer block: the button rides
    // directly above the composer without taking any height in the flow, so it
    // can never push the transcript around as it comes and goes.
    <div
      class={`pointer-events-none absolute inset-x-0 bottom-full z-10 flex justify-end pb-3
        transition-opacity duration-normal ${visible ? 'opacity-100' : 'opacity-0'}`}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={!visible}
        aria-label="Scroll to the latest message"
        title="Scroll to the latest message"
        class={`flex size-9 items-center justify-center rounded-full border border-border
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
