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
 * with its content and then stops, turning into its own scroller instead of
 * eating the conversation above it.
 *
 * The growth itself is the DONOR'S, not ours: `react-textarea-autosize`, the
 * same package `client/src/components/Chat/Input/ChatForm.tsx` composes with,
 * 1.70 kB gzip. This file used to hand-roll it, and the hand-rolled version
 * needed two corrections that the dependency does not need at all — both of
 * them arithmetic. It quantised the height to whole line boxes so the cap
 * could not land mid-glyph, and then had to discount a 1px `scrollHeight`
 * rounding error that its own division read as an extra row on every
 * Shift+Enter. The library never divides: it measures a hidden clone of this
 * textarea carrying the same font, padding and WIDTH, takes that clone's
 * `scrollHeight` as the wanted height, and measures ONE row separately by
 * putting a single `x` in the same clone. With no division there is nothing
 * for a rounding error to be multiplied by, and a whole class of bug this
 * component has already paid for twice stops being ours to get wrong.
 *
 * The cap rides on that same measured row: `maxRows` is a row COUNT, so the
 * box can only ever stop on a whole line, at whatever the font metrics
 * actually are — through a token change or a browser zoom, which a px cap
 * cannot follow. The `min(rem, vh)` rule survives underneath it in CSS as an
 * outer clamp for short windows (see TEXTAREA_MAX).
 *
 * `height` still reaches the element as inline style rather than through
 * state, for the reason the hand-rolled version gave: the value being computed
 * IS a measurement of the DOM, and routing it through a render only means
 * measuring the previous frame. The library also re-measures on window resize
 * and on `document.fonts` `loadingdone` — the second of which the hand-rolled
 * version never did, and which is precisely when a webfont swap changes the
 * line box under a draft already on screen.
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
import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowUp, Paperclip, X } from 'lucide-preact';
import TextareaAutosize from 'react-textarea-autosize';
import { ACCEPT } from '../../lib/chat/attachment-rules';
import type { StagedFile } from '../../lib/chat/uploads';

/**
 * How tall the textarea may grow before it becomes its own scroller, in whole
 * ROWS — the two breakpoints' caps restated in the only unit that cannot land
 * mid-glyph. Five and nine are today's 9.5rem and 15rem at this composer's
 * 14px/1.6 line box and 2rem of vertical padding; the library multiplies them
 * by a row it measured rather than by a number written here, so they stay the
 * same two caps after a font-size token change or a browser zoom.
 */
const MAX_ROWS_SM = 5;
const MAX_ROWS_MD = 9;
/** The boundary `md:` compiles to. `maxRows` is a number, so it must be read. */
const MD_QUERY = '(min-width: 768px)';

/**
 * The OUTER clamp, kept from the hand-rolled version and still expressed in
 * CSS because only CSS can weigh a rem against a share of the viewport. In an
 * ordinary window `maxRows` is the smaller of the two and this never bites; it
 * takes over in a window short enough that a nine-row composer plus its
 * control row would leave no transcript at all. A rem-only cap is right on a
 * laptop and absurd in a 500px-tall window; a vh-only cap is the reverse on a
 * tall monitor. Whichever is smaller is the one that was going to be wrong.
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
  files: StagedFile[];
  attachmentAlert: string;
  /** Newly picked files. The page owns the cap and the staging list. */
  onAttach: (picked: File[]) => void;
  onRemoveFile: (id: number) => void;
  onToggleKnowledge: (id: number, checked: boolean) => void;
  /**
   * Handed in by the page so a landing starter chip can put the caret where
   * the reader will keep typing.
   */
  textareaRef?: { current: HTMLTextAreaElement | null };
}

/**
 * Which of the two row caps is in force.
 *
 * The rest of this component states its breakpoints in `md:` classes, which
 * cost nothing to read. `maxRows` cannot: it is a number handed to a
 * component, so the same 768px boundary has to be *subscribed to* rather than
 * declared — otherwise a window dragged across it leaves an open composer
 * capped for the breakpoint it is no longer at.
 *
 * Defaults to the desktop count where `matchMedia` is missing, which is the
 * generous end: a cap that is too tall clamps against TEXTAREA_MAX, while one
 * that is too short would silently take four rows off a laptop composer.
 */
/**
 * Whether nothing else took the focus while a reply streamed: no active element,
 * the body (the Send button that had it was replaced by Stop), or something
 * inside the composer's own form.
 */
function focusIsFree(form: HTMLFormElement | null): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || (form !== null && form.contains(active));
}

function useMaxRows(): number {
  const mediaQuery = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(MD_QUERY)
      : null;

  const [wide, setWide] = useState(() => mediaQuery()?.matches ?? true);

  useEffect(() => {
    const mq = mediaQuery();
    if (!mq) return;
    const onChange = () => setWide(mq.matches);
    // Read once here as well: a resize landing between first render and this
    // effect would otherwise leave the cap a breakpoint behind for good.
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return wide ? MAX_ROWS_MD : MAX_ROWS_SM;
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
  attachmentAlert,
  onAttach,
  onRemoveFile,
  onToggleKnowledge,
  textareaRef,
}: ComposerProps) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const area = textareaRef ?? ownRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const maxRows = useMaxRows();
  const wasStreaming = useRef(streaming);

  // The cursor comes back to the composer when a reply ends — unless something
  // else took the focus while the reply streamed, which is theirs to keep.
  useEffect(() => {
    if (wasStreaming.current && !streaming && focusIsFree(formRef.current)) area.current?.focus();
    wasStreaming.current = streaming;
  }, [streaming]);

  // No sizing effect of our own any more. TextareaAutosize re-measures in a
  // layout effect on every render — which is every keystroke, paste, starter
  // chip and the reset to one row after a send — plus on window resize and on
  // webfont load. All four cases the hand-rolled version handled, and one it
  // did not.

  // The one gate, used by Enter, by submit and by the button's `disabled` —
  // three call sites that would otherwise drift apart. Identical to the
  // pre-Phase-4 rules: nothing while a turn is streaming, nothing without an
  // agent to route to, and nothing for an empty or whitespace-only draft
  // (attachments alone are a valid send, as before).
  const canSend = !streaming && agentReady && files.every((f) => f.status === 'ready') &&
    (value.trim().length > 0 || files.length > 0);

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

  // Escape stops a streaming reply from anywhere in the composer: the form
  // receives the keydown from the textarea and from the Stop button alike.
  function handleEscape(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !streaming) return;
    // The Escape that closes a Japanese or Chinese input method's candidates is
    // the input method's, not a Stop.
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    // The page-wide Jarvis Escape listener (JarvisWidget.tsx, on `window`) must
    // not also fire and end a voice session.
    e.stopPropagation();
    onStop();
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onKeyDown={handleEscape}
      onPaste={(e: ClipboardEvent) => {
        const picked = Array.from(e.clipboardData?.files ?? []);
        if (picked.length > 0) { e.preventDefault(); onAttach(picked); }
      }}
      onDragOver={(e: DragEvent) => e.preventDefault()}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        const picked = Array.from(e.dataTransfer?.files ?? []);
        if (picked.length > 0) onAttach(picked);
      }}
      // No measure, no padding, no border — see the header. This element's
      // content box IS the shared column's.
      class="flex flex-col"
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPT}
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
        {attachmentAlert && <div role="alert" class="px-3 pt-2 text-caption text-danger">{attachmentAlert}</div>}
        {files.length > 0 && (
          // Inside the card, above the text: what is about to be sent belongs
          // in the thing that sends it, not floating above it.
          <ul class="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached files">
            {files.map((f) => (
              <li
                key={f.localId}
                class="inline-flex max-w-full flex-col gap-1 rounded-lg border border-border
                  bg-bg px-2 py-1 text-caption text-secondary"
              >
                <div class="flex min-w-0 items-center gap-1.5">
                {/* `bg-bg` rather than `bg-surface`: the card is surface, so a
                    surface chip on it would have no edge of its own. */}
                <Paperclip size={12} class="shrink-0 text-muted" aria-hidden="true" />
                {/* `min-w-0` or a long filename refuses to shrink and pushes
                    its own remove button off the chip. */}
                <span class="min-w-0 truncate">{f.file.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveFile(f.localId)}
                  aria-label={`Remove ${f.file.name}`}
                  class="shrink-0 rounded text-muted transition-colors duration-fast
                    hover:text-danger focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-danger"
                >
                  <X size={12} aria-hidden="true" />
                </button>
                </div>
                {f.status === 'uploading' && (
                  <div role="progressbar" aria-label={`Uploading ${f.file.name}`}
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={f.progress}
                    class="h-1 w-full overflow-hidden rounded-full bg-surface-hover">
                    <div class="h-full bg-primary" style={{ width: `${f.progress}%` }} />
                  </div>
                )}
                {f.status === 'failed' && <span class="text-danger">{f.error}</span>}
                <label class="flex items-center gap-1.5">
                  <input type="checkbox" checked={f.addToKnowledge}
                    onChange={(e) => onToggleKnowledge(f.localId, (e.target as HTMLInputElement).checked)}
                    aria-label={`Add ${f.file.name} to knowledge`}
                    aria-describedby={`chat-knowledge-${f.localId}`} />
                  <span>Add to knowledge</span>
                </label>
                <span id={`chat-knowledge-${f.localId}`} class="text-muted">
                  Everyone who uses this agent can find it, and it stays if you delete this chat.
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* The donor's call-site shape (ChatForm.tsx): a controlled
            TextareaAutosize with `rows={1}`, its own ref, the composer's
            keydown handler and nothing else between it and the DOM element.
            What differs is the cap — the donor leaves it to a CSS max-height
            and accepts a sheared row there; `maxRows` is what makes ours stop
            on a line box. */}
        <TextareaAutosize
          ref={area}
          data-tour="chat-input"
          rows={1}
          maxRows={maxRows}
          value={value}
          // `e` is annotated rather than inferred: the package ships React
          // types, and this app has no React types installed for them to
          // resolve against, so its props widen to `any` and `strict` refuses
          // the implicit parameter. The annotation is the honest one — Preact
          // has no synthetic event system, so what arrives here is the native
          // DOM event off the textarea.
          onInput={(e: Event) => onInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${agentName}...`}
          aria-label={`Message ${agentName}`}
          // The next turn can be composed during a run; canSend waits for it to end.
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
