/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/Messages/MessagesView.tsx` and
 * `client/src/components/Chat/ChatView.tsx`.
 *
 * What is ported: the transcript is an unboxed run of turns on the page ground,
 * not a panel — no card, no border, no scrollbar of its own. It is the first
 * child of the shared content column (see ChatCanvas, which owns both the
 * scrolling and the measure); the composer is the second, which is why the two
 * cannot disagree about where the column starts and ends.
 *
 * On the landing state the donor pins the greeting directly above the composer
 * rather than floating it in the middle of the void, so an empty chat reads as
 * "start typing here" instead of "nothing loaded".
 *
 * CHATUI-003 moved the row rendering out of Chat.tsx and in here, so the page
 * is composition only and one file owns the transcript's rhythm: which turn
 * types exist (UserMessage / AssistantMessage / StreamingRow), the gap between
 * them, and where the scroll sentinel sits.
 */
import type { ComponentChildren } from 'preact';
import type { Message } from '../../lib/chat/types';
import { AssistantMessage } from './AssistantMessage';
import { StreamingRow } from './StreamingRow';
import { UserMessage } from './UserMessage';

interface MessagesViewProps {
  /** Settled turns, oldest first. */
  messages: Message[];
  /** Display name of the agent answering — the author line on every reply. */
  agentName: string;
  /** Landing state: no turns yet, so hug the composer instead of filling. */
  landing: boolean;
  /** True while a turn is in flight; renders the live row. */
  streaming: boolean;
  /** Cumulative text of the in-flight turn. */
  streamText: string;
  /** Live tool/media status of the in-flight turn. */
  toolStatus: string;
  /** Epoch ms the in-flight turn was dispatched (0 when nothing is in flight). */
  streamStartedAt: number;
  /** Scroll target kept at the foot of the transcript. */
  endRef: { current: HTMLDivElement | null };
  /** Pre-transcript slot: the load-error notice and the landing block. */
  children?: ComponentChildren;
}

export function MessagesView({
  messages,
  agentName,
  landing,
  streaming,
  streamText,
  toolStatus,
  streamStartedAt,
  endRef,
  children,
}: MessagesViewProps) {
  return (
    // `flex-1` claims the column's free height so the block below can push
    // itself to the bottom on the landing state. `pt-[var(--chat-header-h)]`
    // is the whole reason the overlay header is readable: the property carries
    // the header's MEASURED height (plate + mask-fade), published by
    // ChatHeader's ResizeObserver and written onto the canvas by Chat.tsx. A
    // hard-coded constant was wrong on every viewport it was not tuned for —
    // at 1280px the old `pt-16` (64px) sat 12px inside a 76px header, which is
    // exactly how a line of body copy ended up sliced through its x-height by
    // the header's edge. The page seeds a static fallback for the frames
    // before the first measurement, so this is never 0.
    <div class="flex flex-1 flex-col pt-[var(--chat-header-h)]">
      {/* `mt-auto`, NOT `justify-end` on the parent: a centring or end-aligned
          justification overflows a too-tall child out the TOP of a scroll
          container, where it is clipped and unreachable (verified at 800px
          tall — the greeting lost its mark). An auto margin takes only the
          FREE space, so it collapses to 0 the moment content exceeds the box
          and the same layout degrades into an ordinary scroll with the header
          padding still protecting the first line. */}
      <div class={landing ? 'mt-auto pb-2' : 'flex flex-col gap-7 pb-6'}>
        {children}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <UserMessage key={i} message={m} />
          ) : (
            <AssistantMessage key={i} message={m} agentName={agentName} />
          ),
        )}
        {streaming && (
          <StreamingRow
            agentName={agentName}
            text={streamText}
            toolStatus={toolStatus}
            startedAt={streamStartedAt}
          />
        )}
      </div>
      {/* OUTSIDE the gap container on purpose: a zero-height sentinel inside a
          `gap-7` stack still takes a 28px gap before it, which is dead space
          the composer then sits on top of. */}
      <div ref={endRef} class="h-0 w-full shrink-0" />
    </div>
  );
}
