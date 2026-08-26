/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/Messages/Content/MessageContent.tsx` (the
 * in-progress branch and its cursor) and
 * `client/src/components/Chat/Messages/Content/InProgressCall.tsx` (the live
 * tool-status line).
 *
 * ── The live turn is the settled turn ──────────────────────────────────────
 *
 * This row renders through the same MessageRow frame and the same AuthorLine as
 * AssistantMessage, at the same width, with the same left edge. That is the
 * whole design: when the stream ends and the message is committed, the only
 * thing that changes is that a caret disappears and a footer appears. Nothing
 * reflows, nothing jumps, and the reader's eye does not have to re-find the
 * line it was on.
 *
 * ── Three states, and why they are one expression ──────────────────────────
 *
 *   tool status  — the agent is working a tool; the wire named it.
 *   text         — tokens are arriving.
 *   neither      — dispatched, nothing back yet.
 *
 * On today's wire these are effectively exclusive: streamTurn clears the status
 * line the moment a chunk lands (`cb.onToolStatus('')`). They are still
 * rendered as an ADDITIVE stack rather than an if/else chain, so a future turn
 * that interleaves a mid-answer tool call shows both instead of silently
 * dropping one — the parity contract in CLAUDE.md is that live tool status is
 * always visible, and an else-branch is exactly how that gets lost.
 *
 * ── The caret rides the last glyph ─────────────────────────────────────────
 *
 * A caret rendered as a sibling <span> after the markdown lands on its own
 * line, because the last thing markdown emits is a block. The caret here is a
 * `::after` on the last block instead (`.chat-md.chat-streaming`, appended to
 * index.css — a NEW selector, nothing existing edited, per the shared-.chat-md
 * rule), so it sits immediately after the final character the way a terminal
 * cursor does. Under `prefers-reduced-motion` the global rule in index.css
 * zeroes its animation, which leaves a steady bar rather than removing the
 * indicator entirely.
 *
 * ── A caret is not a status ────────────────────────────────────────────────
 *
 * A 2px blinking bar is the only thing on screen that says "this turn is
 * alive", and it says it very quietly: it cannot distinguish a fast turn from
 * one that has been hanging for forty seconds, which is exactly the question a
 * reader asks. So the live row also fills the footer slot — the SAME slot, with
 * the same type and the same leading, that RunFooter drops into the moment the
 * turn settles — with an elapsed readout. Nothing reflows at the handover; the
 * line just stops counting and starts reporting model, latency and cost.
 *
 * Cancelling lives in the composer, not here (the donor's Send button becomes a
 * Stop square), which is why this component takes no `onStop`.
 */
import { useEffect, useState } from 'preact/hooks';
import { renderMarkdown } from '../../lib/chat/markdown';
import { MessageRow } from './MessageRow';
import { AuthorLine } from './AssistantMessage';

interface StreamingRowProps {
  agentName: string;
  /** Cumulative markdown received so far ('' before the first chunk). */
  text: string;
  /** Live tool/media status line ('' when text has resumed). */
  toolStatus: string;
  /** Epoch ms the turn was dispatched — drives the elapsed readout. */
  startedAt: number;
}

export function StreamingRow({ agentName, text, toolStatus, startedAt }: StreamingRowProps) {
  return (
    <MessageRow
      role="assistant"
      header={<AuthorLine agentName={agentName} />}
      footer={<LiveFooter startedAt={startedAt} />}
    >
      {toolStatus && <ToolStatusLine status={toolStatus} />}
      {text ? (
        <div
          class="chat-md chat-streaming break-words"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
        />
      ) : (
        !toolStatus && <ThinkingDots />
      )}
    </MessageRow>
  );
}

/** Whole seconds since `startedAt`, re-read once a second while mounted. */
function useElapsedSeconds(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/**
 * The live half of the run footer. Same `font-mono text-caption text-secondary`
 * as RunFooter, in the same sub-row, so the settled footer replaces it in place
 * rather than appearing under it.
 *
 * `tabular-nums` matters more than it looks: without it the row's width jumps
 * every time the seconds digit changes shape, and a number that twitches reads
 * as a glitch rather than as a clock.
 */
function LiveFooter({ startedAt }: { startedAt: number }) {
  const seconds = useElapsedSeconds(startedAt);
  return (
    <div
      data-chat-elapsed={seconds}
      class="flex items-center gap-2 pt-0.5 font-mono text-caption text-secondary"
    >
      <span aria-hidden="true" class="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
      <span>streaming</span>
      <span aria-hidden="true" class="text-muted">
        ·
      </span>
      <span class="tabular-nums">
        <span class="sr-only">Elapsed </span>
        {seconds}s
      </span>
    </div>
  );
}

/**
 * The live tool line — the dashboard's half of the cross-surface `onToolEvent`
 * contract (CLAUDE.md), matching what Telegram and Slack edit into their
 * placeholder message. `role="status"` so the change is announced without
 * stealing focus; `aria-live` is polite by default on that role, which is
 * right for a line that can update several times a second.
 */
function ToolStatusLine({ status }: { status: string }) {
  return (
    <div
      role="status"
      // A stable hook for the capture harness and browser QA. `role="status"`
      // alone is not one — ThinkingDots carries it too, and later phases will
      // add more — so asserting "the live tool line rendered" needs a name that
      // survives restyling.
      data-chat-tool-status
      class="mb-2 flex min-w-0 items-center gap-2 text-caption text-secondary"
    >
      <span
        aria-hidden="true"
        class="size-3.5 shrink-0 animate-spin rounded-full border-2 border-primary-a/25 border-t-primary"
      />
      <span class="min-w-0 truncate">{status}</span>
    </div>
  );
}

/** Dispatched, nothing back yet. The donor's three-dot placeholder. */
function ThinkingDots() {
  return (
    // `bg-primary-a/40`, NOT `bg-muted`: `muted` exists only as a textColor key
    // in tailwind.config.ts, so `bg-muted` compiles to nothing at all and the
    // dots render invisible — which is how a turn with no first chunk yet used
    // to look like a dead canvas. The `-a` triplet is the alpha-capable key.
    <div class="flex items-center gap-1 py-1" role="status" aria-label="Waiting for a reply">
      <span class="size-2 animate-bounce rounded-full bg-primary-a/40" style="animation-delay:0ms" />
      <span class="size-2 animate-bounce rounded-full bg-primary-a/40" style="animation-delay:150ms" />
      <span class="size-2 animate-bounce rounded-full bg-primary-a/40" style="animation-delay:300ms" />
    </div>
  );
}
