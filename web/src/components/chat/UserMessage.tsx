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
import { api } from '../../lib/api';
import { toast } from '../Toast';
import { MessageRow, isoFromEpochSeconds } from './MessageRow';

interface UserMessageProps {
  message: Message;
  agentId: string;
  chatId: string;
}

export function UserMessage({ message, agentId, chatId }: UserMessageProps) {
  async function download(id: string) {
    try {
      const path = `/sessions/attachment?agentId=${encodeURIComponent(agentId)}` +
        `&chatId=${encodeURIComponent(chatId)}&id=${encodeURIComponent(id)}`;
      const { url, name } = await api.get<{ url: string; name: string }>(path);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
    } catch {
      toast('Could not download that file. Please try again.', 'error');
    }
  }

  return (
    // The donor row renders the user turn's heading itself, as `sr-only`
    // (headerPrefix + label + timestamp), which is why no `header` node is
    // passed any more. `icon` and `footer` are `null` rather than omitted:
    // they are required props, and the user branch never reads the icon while
    // SubRow's `empty:hidden` collapses the footer slot to nothing.
    <MessageRow
      isCreatedByUser
      label="You said"
      headerPrefix=""
      ariaLabel="Your message"
      timestamp={isoFromEpochSeconds(message.ts)}
      icon={null}
      footer={null}
    >
      {/* `font-sans` overrides the UA monospace: this is prose that must
          preserve its line breaks, not code. `break-words` keeps an unbroken
          URL or token from widening the pill past the column. */}
      {message.text && <pre class="whitespace-pre-wrap break-words font-sans text-body-sm text-primary">
        {message.text}
      </pre>}
      {message.attachments && message.attachments.length > 0 && (
        <ul class="mt-2 flex flex-wrap gap-2" aria-label="Message attachments">
          {message.attachments.map((file) => (
            <li key={file.id} class="rounded-lg border border-border bg-bg px-2 py-1 text-caption text-secondary">
              <button type="button" aria-label={`Download ${file.name}`}
                onClick={() => { void download(file.id); }}
                class="text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {file.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </MessageRow>
  );
}
