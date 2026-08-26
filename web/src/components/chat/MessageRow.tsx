/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/Messages/ui/MessageRow.tsx` and
 * `client/src/components/Chat/Messages/SubRow.tsx`.
 *
 * ── The one rhythm the whole transcript is built on ────────────────────────
 *
 * The donor's two turn types are not two bubbles in different colours; they are
 * two different KINDS of object, and that is what makes a long conversation
 * readable at a glance:
 *
 *   user       → hugs its own text, hangs off the RIGHT edge of the column,
 *                sits in a tinted pill. It is a quotation of what you said.
 *   assistant  → fills the column, has NO box at all, and is introduced by a
 *                small author line (mark · name · time). It is the document.
 *
 * Boxing the assistant turn is the mistake this file exists to prevent. A card
 * around running prose puts a second frame inside the reading column, so every
 * code block, table and image ends up double-framed, and the measure the eye
 * follows stops being the column and becomes the card. The donor draws no card,
 * and neither do we — the author line is what separates one reply from the next.
 *
 * ── Why the row is a frame and not a component per turn type ───────────────
 *
 * Three callers need the identical geometry: UserMessage, AssistantMessage and
 * StreamingRow. The live row in particular must occupy EXACTLY the box the
 * settled row lands in, or the transcript twitches at the moment a stream ends
 * and the message is committed. One frame, three fillings, nothing to keep in
 * sync.
 *
 * The row declares NO width and NO horizontal padding: ChatCanvas owns the
 * single shared content column, and a second `max-w-*` here would be exactly
 * the drift that file was written to delete.
 */
import type { ComponentChildren } from 'preact';

interface MessageRowProps {
  role: 'user' | 'assistant';
  /**
   * The author line. Assistant turns render a visible one (mark, name, time);
   * user turns pass a `sr-only` heading so the transcript still reads as an
   * alternating dialogue to a screen reader, which cannot see the alignment.
   */
  header?: ComponentChildren;
  /** The turn body — prose, panels, attachments. */
  children: ComponentChildren;
  /** Quiet sub-row under the body (the run footer). */
  footer?: ComponentChildren;
}

export function MessageRow({ role, header, children, footer }: MessageRowProps) {
  const isUser = role === 'user';

  return (
    // `group` is load-bearing: the timestamp and any other reveal-on-hover
    // affordance in the header key off it (see MessageMeta).
    <div
      role="group"
      aria-label={isUser ? 'Your message' : 'Assistant message'}
      class={`group flex min-w-0 ${isUser ? 'justify-end' : 'items-start'}`}
    >
      <div
        class={`relative flex min-w-0 flex-col ${
          isUser ? 'ml-auto w-fit max-w-[90%] items-end sm:max-w-[85%]' : 'w-full flex-1'
        }`}
      >
        {header}
        <div class={`flex w-full min-w-0 flex-col gap-1 ${isUser ? 'items-end' : ''}`}>
          <div
            class={
              isUser
                ? // The pill. `w-fit` so it hugs; `rounded-br-md` clips the one
                  // corner nearest the composer, which is what points the shape
                  // back at the person who typed it. Neutral, NOT the brand
                  // colour: a transcript of indigo slabs buries the reply, and
                  // the donor's own user turn is a quiet tinted pill for the
                  // same reason. The hairline border is this product's language
                  // (README style bar), not the donor's borderless fill.
                  'w-fit min-w-0 rounded-2xl rounded-br-md border border-border bg-surface-elevated px-4 py-2.5'
                : // No card. The reply IS the column.
                  'w-full min-w-0'
            }
          >
            {children}
          </div>
          {footer && <div class={`w-full ${isUser ? 'flex justify-end' : ''}`}>{footer}</div>}
        </div>
      </div>
    </div>
  );
}
