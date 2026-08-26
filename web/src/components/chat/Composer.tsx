/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/Input/ChatForm.tsx`,
 * `client/src/components/Chat/Input/SendButton.tsx` and
 * `client/src/components/Chat/Input/StopButton.tsx`.
 *
 * What is ported: the composer is a CARD, not a toolbar. One autosizing
 * textarea fills its top, the controls live on a row along its bottom inside
 * the same border, and the primary control is a single round button on the
 * right that carries the turn's state — an arrow to send, a square to stop.
 * Donor tokens are translated onto this app's own; no donor colour survives.
 *
 * What is NOT ported: the donor's badge row, prompt/skill command popovers,
 * mention menus, audio recorder, token-usage meter and collapse control. This
 * product's composer carries exactly what the turn needs — text, attachments,
 * and the ability to end a run you are paying for.
 *
 * ── One line, then more, then a scroller ───────────────────────────────────
 *
 * A single-line <input> cannot show what you are about to send. Anything past
 * the visible width scrolls out of sight to the left, so a three-sentence
 * prompt is composed through a keyhole — and this surface's users write
 * paragraphs, paste stack traces and quote logs. The textarea therefore grows
 * with its content and then stops: `height` is recomputed to `scrollHeight` on
 * every keystroke, and a `max-height` in CSS clamps the growth so the box
 * turns into its own scroller instead of eating the conversation above it.
 *
 * The cap is `min(<lines>, <share of viewport>)` on purpose. A rem-only cap is
 * right on a laptop and absurd in a 500px-tall window, where a composer that
 * grows to 15rem plus its control row leaves no transcript at all; a vh-only
 * cap is the reverse on a tall monitor. Whichever is smaller is the one that
 * was going to be wrong.
 *
 * `height` is written to the element's inline style rather than being tracked
 * in state, because the value being computed IS a measurement of the DOM —
 * routing it through a render only means measuring the previous frame.
 *
 * Once it caps, the box is a scroll container, and it is finished as one: no
 * scrollbar furniture (the donor's composer paints none either, and Windows
 * Chromium's stepper buttons were punching a triangle through the card's own
 * rounded corner), and a fade at each end of the viewport instead of a hard
 * seam. The padding here is sized against that fade so it can only ever touch
 * a line that is genuinely half out of view — the rules and the reasoning live
 * with the rule, on `.chat-composer__input` in index.css.
 *
 * ── Enter sends, Shift+Enter is a newline ──────────────────────────────────
 *
 * A textarea's native Enter is a newline, and a <form> does not submit on
 * Enter from one, so the send is explicit here. Two guards ride with it:
 * `isComposing`/`keyCode === 229` means an IME is mid-candidate and Enter is
 * choosing a character, not sending a message — sending there would truncate
 * the sentence of every CJK user on their first turn.
 *
 * ── Send BECOMES Stop, and Stop keeps the words ────────────────────────────
 *
 * While a turn is in flight the same slot renders Stop, which aborts through
 * the AbortSignal `streamTurn()` already accepts. The partial answer is NOT
 * discarded: the page's `send()` catch recognises the AbortError and commits
 * whatever text arrived as a settled turn (see pages/Chat.tsx). That is the
 * difference between a run you can end and a spinner you can only wait out —
 * and on a metered platform, ending it is the point.
 *
 * The glyph is a solid square (universal stop), not a spinner: a spinner says
 * "wait", and this control says "you don't have to".
 *
 * ── It declares no measure of its own ──────────────────────────────────────
 *
 * The <form> carries no width, no centring, no padding and no border. It is a
 * child of the ONE shared content column (see ChatCanvas), so its content box
 * is the column's content box by construction — the same box the header's
 * controls and every message are laid on. All of the composer's own padding is
 * on the card INSIDE the form, which is what keeps the card's outer edge on
 * the column's edge instead of one padding value inboard of it.
 */
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { ArrowUp, Paperclip, X } from 'lucide-preact';

/**
 * How tall the textarea may grow before it becomes its own scroller.
 * `min()` of a line-count cap and a share of the viewport — see the header.
 */
const TEXTAREA_MAX = 'max-h-[min(9.5rem,30vh)] md:max-h-[min(15rem,45vh)]';

/**
 * The turn's one primary control, in both of its states. Same height, same
 * fill, same radius — what changes is the glyph and, deliberately, the width.
 *
 * Send is icon-only (an up arrow in a circle is universal, and the placeholder
 * beside it already says what the box is for). STOP IS NOT: it keeps its word.
 * An unlabelled square asks the reader to guess what a click will do to a run
 * that is spending their money, and the widening of the slot is itself the
 * signal that the composer has changed state — a glyph swap inside a fixed
 * circle is easy to miss in peripheral vision, a control that grows a word is
 * not. It is also the only label a screen reader and a QA harness can agree
 * on without an `aria-label` being the sole source of truth.
 *
 * Disabled REPAINTS rather than fades. A brand-filled circle at 40% opacity is
 * a light purple button on a white card and a muted purple one on a dark
 * card — in both cases still the accent colour, still reading as the thing you
 * are meant to press. Swapping the fill for `surface-hover` and the glyph for
 * `text-muted` says "not yet" in one token pair that holds in both themes.
 */
const PRIMARY_BTN =
  'ml-auto inline-flex h-9 shrink-0 items-center justify-center rounded-full bg-primary text-inverse ' +
  'shadow-sm transition-all duration-fast hover:bg-primary-hover ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-muted disabled:shadow-none';

interface ComposerProps {
  /** The draft. Owned by the page so a starter chip can drop text into it. */
  value: string;
  onInput: (value: string) => void;
  /** Dispatch the turn. Only ever called when `canSend` below is true. */
  onSend: () => void;
  /** Abort the in-flight turn (the page holds the AbortController). */
  onStop: () => void;
  streaming: boolean;
  /**
   * False until `/agents` has resolved and one is selected. The page's `send()`
   * early-returns without an agent, so this only makes that refusal visible
   * instead of silent — the control is dead either way.
   */
  agentReady: boolean;
  /** Display name of the selected agent, for the placeholder. */
  agentName: string;
  /** Files staged for the next send, shown as removable chips. */
  files: File[];
  /** Newly picked files. The page owns the cap and the staging list. */
  onAttach: (picked: File[]) => void;
  onRemoveFile: (index: number) => void;
  /**
   * Handed in by the page so a landing starter chip can put the caret where
   * the reader will keep typing.
   */
  textareaRef?: { current: HTMLTextAreaElement | null };
}

/**
 * Recompute the box to fit its content, SNAPPED to whole line boxes.
 *
 * Sizing to raw `scrollHeight` and letting a `max-height` in rem do the
 * clamping shears the last line in half at the cap: the cap is a round
 * typographic value, the line box is whatever the font metrics make it, and
 * the two do not divide. A half-row of sliced glyphs reads as a rendering
 * fault rather than as "there is more text above", so the height is quantised
 * here instead — both while growing and at the cap, which is itself floored to
 * a whole number of lines. The CSS cap stays as the source of the maximum.
 */
function fit(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight);
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const cap = parseFloat(cs.maxHeight);
  if (!Number.isFinite(line) || line <= 0) {
    // No resolvable line box (e.g. `line-height: normal`): fall back to the
    // unquantised behaviour rather than guessing a metric.
    el.style.height = `${el.scrollHeight}px`;
    return;
  }
  const content = Math.max(0, el.scrollHeight - pad);
  // `scrollHeight` is an INTEGER, but a line box rarely is (14px text at 1.6
  // gives 22.4px here). Two full lines measure 44.8px and are reported as 45,
  // and a bare `Math.ceil(45 / 22.4)` reads that 0.2px of rounding noise as a
  // third line — so every Shift+Enter left the box one whole row taller than
  // its own text, with an empty band under the caret that never went away
  // (measured: 2 lines of content sized to 99.2px instead of 76.8px). On the
  // mobile cap that also cost a line of real capacity: four lines of text hit
  // a five-line cap and started scrolling with the box not yet full.
  //
  // One pixel is the most `scrollHeight` can round up by, so discount exactly
  // that before quantising. Content genuinely past a line boundary is more
  // than 1px past it and still rounds up.
  const wanted = Math.max(1, Math.ceil((content - 1) / line));
  const capLines = Number.isFinite(cap) ? Math.max(1, Math.floor((cap - pad) / line)) : wanted;
  el.style.height = `${Math.min(wanted, capLines) * line + pad}px`;
}

export function Composer({
  value,
  onInput,
  onSend,
  onStop,
  streaming,
  agentReady,
  agentName,
  files,
  onAttach,
  onRemoveFile,
  textareaRef,
}: ComposerProps) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const area = textareaRef ?? ownRef;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Before paint, so the box never renders at the wrong height for a frame.
  // Runs on every value change, which covers typing, pasting, a starter chip
  // dropping text in, and the reset to one row after a send.
  useLayoutEffect(() => { fit(area.current); }, [value]);

  // A narrower window rewraps the text, which changes how many rows it needs.
  useEffect(() => {
    const onResize = () => fit(area.current);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The one gate, used by Enter, by submit and by the button's `disabled` —
  // three call sites that would otherwise drift apart. Identical to the
  // pre-Phase-4 rules: nothing while a turn is streaming, nothing without an
  // agent to route to, and nothing for an empty or whitespace-only draft
  // (attachments alone are a valid send, as before).
  const canSend = !streaming && agentReady && (value.trim().length > 0 || files.length > 0);

  function submit() {
    if (canSend) onSend();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // An IME is mid-candidate: this Enter picks a character, it does not send.
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      // No measure, no padding, no border — see the header. This element's
      // content box IS the shared column's.
      class="flex flex-col"
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.pdf,.docx,.pptx,.txt,.md,.csv"
        class="hidden"
        onChange={(e) => {
          const list = (e.target as HTMLInputElement).files;
          if (list) onAttach(Array.from(list));
          // Clear it, or picking the same file twice in a row fires no change.
          (e.target as HTMLInputElement).value = '';
        }}
      />

      {/* THE CARD. `bg-surface` against the canvas's `bg-bg`, a hairline and a
          shadow that deepens on focus, so the composer reads as an object you
          write into rather than as a strip of chrome at the bottom of the
          page. The focus ring lives here, not on the textarea: the textarea's
          own outline is suppressed so the caret sits in an unbroken card, and
          a keyboard user still has to be able to see where they are. */}
      <div
        class="rounded-xl border border-border bg-surface shadow-md transition-all duration-normal
          focus-within:border-primary focus-within:shadow-lg focus-within:ring-2
          focus-within:ring-primary-a/30"
      >
        {files.length > 0 && (
          // Inside the card, above the text: what is about to be sent belongs
          // in the thing that sends it, not floating above it.
          <ul class="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached files">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                class="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border
                  bg-bg px-2 py-1 text-caption text-secondary"
              >
                {/* `bg-bg` rather than `bg-surface`: the card is surface, so a
                    surface chip on it would have no edge of its own. */}
                <Paperclip size={12} class="shrink-0 text-muted" aria-hidden="true" />
                {/* `min-w-0` or a long filename refuses to shrink and pushes
                    its own remove button off the chip. */}
                <span class="min-w-0 truncate">{f.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveFile(i)}
                  aria-label={`Remove ${f.name}`}
                  class="shrink-0 rounded text-muted transition-colors duration-fast
                    hover:text-danger focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-danger"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <textarea
          ref={area}
          data-tour="chat-input"
          rows={1}
          value={value}
          onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${agentName}...`}
          aria-label={`Message ${agentName}`}
          // Unchanged from the single-line composer: a second turn cannot be
          // composed on top of the one in flight.
          disabled={streaming}
          autoFocus
          // `chat-composer__input` is where the CAPPED state is finished (see
          // index.css): no scrollbar furniture, and a fade at both ends so a
          // half-scrolled line reads as "there is more" rather than as a line
          // guillotined against the card's stroke.
          //
          // `py-4` is load-bearing, not taste. It is 16px against that fade's
          // 12px, and the 4px of spare is what keeps the fade honest: every
          // line of a draft that FITS sits inside the padding, so the ramp only
          // ever touches ink that is genuinely half out of view. It is also
          // what stops a descender from meeting the 2px focus stroke — the
          // previous 8px bottom padding did not, and that seam was the one
          // thing on this card that still looked unfinished.
          class={`chat-composer__input block w-full resize-none overflow-y-auto bg-transparent
            px-4 py-4 text-body-sm text-primary outline-none placeholder:text-muted
            disabled:cursor-not-allowed disabled:opacity-50 ${TEXTAREA_MAX}`}
        />

        {/* The control row, inside the card's border — the donor's arrangement:
            attachments on the left, the turn's one primary control on the
            right, and nothing in between competing for the eye. */}
        <div class="flex items-center gap-1 px-2 pb-2">
          <button
            type="button"
            disabled={streaming}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
            title="Attach files"
            class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted
              transition-colors duration-fast hover:bg-surface-hover hover:text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
              disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Paperclip size={18} aria-hidden="true" />
          </button>

          {/* `ml-auto` rides on PRIMARY_BTN itself rather than on a spacer
              element, so both states of the control are pinned right without a
              second empty box in the row. */}
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop generating"
              // The QA harness clicks this by attribute; it is also how the
              // capture proves a cancelled turn keeps its partial answer.
              data-chat-stop
              class={`${PRIMARY_BTN} gap-2 px-3.5 text-caption font-medium`}
            >
              <span aria-hidden="true" class="size-3 shrink-0 rounded-[2px] bg-current" />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              title="Send message"
              class={`${PRIMARY_BTN} w-9`}
            >
              <ArrowUp size={18} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
