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
import type { ArtifactRef, Message } from '../../lib/chat/types';
import { AssistantMessage } from './AssistantMessage';
import { StreamingRow } from './StreamingRow';
import { UserMessage } from './UserMessage';

interface MessagesViewProps {
  /** Settled turns, oldest first. */
  messages: Message[];
  /** Display name of the agent answering — the author line on every reply. */
  agentName: string;
  agentId: string;
  chatId: string;
  onOpenArtifact: (ref: ArtifactRef, opener: HTMLButtonElement) => void;
  onRetry: (index: number) => void;
  onRegenerate: () => void;
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
  agentId,
  chatId,
  onOpenArtifact,
  onRetry,
  onRegenerate,
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
    // itself to the bottom on the landing state.
    //
    // THERE IS NO TOP PADDING HERE, and that is now a positive statement rather
    // than an omission. The header is a sticky sibling inside this same column
    // (ChatCanvas), so it occupies its own height in the flow and the first
    // message cannot be laid out underneath it — there is nothing to measure
    // and nothing to keep in sync. It used to be `pt-[var(--chat-header-h)]`, a
    // property carrying the measured height of an absolutely-positioned header;
    // every frame before the first measurement landed, and every viewport its
    // static fallback was not tuned for, showed the top line of a reply sliced
    // through its x-height.
    //
    // Round 2 left a bare `pt-4` behind as a GAP. Round 3 gave the header a
    // 24px fade ramp below its plate (ChatHeader), which occupies its own space
    // in the flow and IS that gap — so the padding went with it. Keeping both
    // would put two elements in two files in charge of one clearance, which is
    // the shape of the `--chat-header-h` mistake, one size down.
    <div class="flex flex-1 flex-col">
      {/* `mt-auto`, NOT `justify-end` on the parent: a centring or end-aligned
          justification overflows a too-tall child out the TOP of a scroll
          container, where it is clipped and unreachable (verified at 800px
          tall — the greeting lost its mark). An auto margin takes only the
          FREE space, so it collapses to 0 the moment content exceeds the box
          and the same layout degrades into an ordinary scroll, with the sticky
          header above still occluding whatever passes under it. */}
      <div class={landing ? 'mt-auto pb-2' : 'flex flex-col gap-7 pb-6'}>
        {children}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <UserMessage key={i} message={m} agentId={agentId} chatId={chatId} />
          ) : (
            <AssistantMessage key={i} message={m} agentName={agentName}
              agentId={agentId} chatId={chatId} onOpenArtifact={onOpenArtifact}
              canRetry={!messages[i - 1]?.attachments?.length} onRetry={() => onRetry(i)}
              canRegenerate={!streaming && i === messages.length - 1 && !m.error && !m.notSaved && !m.isReply}
              onRegenerate={onRegenerate} />
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
