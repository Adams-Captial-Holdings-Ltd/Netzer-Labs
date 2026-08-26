/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor path
 * `client/src/components/Chat/Messages/ui/MessageRow.tsx` (the
 * `isCreatedByUser` branch) and `client/src/components/Chat/Messages/Content/
 * Parts/Text.tsx`.
 *
 * A user turn is deliberately the DUMB one: it is a verbatim quotation of what
 * was typed, so it is never run through the markdown pipeline. That is a
 * safety property as much as a stylistic one — a prompt containing `<img
 * onerror=…>` or a stray backtick fence must appear on screen as the literal
 * characters the user entered, never as rendered HTML. `<pre>` in the sans
 * face gives that for free: newlines survive, nothing is interpreted.
 *
 * The header is `sr-only`. Sighted readers get the turn's author from its
 * alignment and its pill; a screen reader gets nothing from either, so the
 * heading is what keeps the transcript reading as an alternating dialogue.
 */
import type { Message } from '../../lib/chat/types';
import { MessageRow } from './MessageRow';

interface UserMessageProps {
  message: Message;
}

export function UserMessage({ message }: UserMessageProps) {
  return (
    <MessageRow role="user" header={<h3 class="sr-only">You said</h3>}>
      {/* `font-sans` overrides the UA monospace: this is prose that must
          preserve its line breaks, not code. `break-words` keeps an unbroken
          URL or token from widening the pill past the column. */}
      <pre class="whitespace-pre-wrap break-words font-sans text-body-sm text-primary">
        {message.text}
      </pre>
    </MessageRow>
  );
}
