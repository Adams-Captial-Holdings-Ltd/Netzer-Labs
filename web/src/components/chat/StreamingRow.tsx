/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/Messages/Content/MessageContent.tsx` (the
 * in-progress branch and its cursor) and
 * `client/src/components/Chat/Messages/Content/ProgressText.tsx` (the live
 * tool-status line).
 *
 * ── CORRECTION: this comment used to name the wrong donor file ─────────────
 *
 * It credited `Content/InProgressCall.tsx` as "the live tool-status line". That
 * file is 19 lines and renders no status text at all — it is ENTIRELY a guard
 * that swaps its children for a CancelledIcon when `(!isSubmitting && progress
 * < 1) || error`. It is copied verbatim at
 * ./lc/components/Chat/Messages/Content/InProgressCall.tsx so the claim can be
 * checked rather than taken on trust.
 *
 * The donor's actual live tool line is `ProgressText.tsx`, 158 lines. Almost
 * none of it can be fed from here, and the reason is the wire, not the code:
 *
 *   - `phase` (running / completed / failed / cancelled) — our wire has ONE
 *     state. `event: tool` carries `{label, step}`; nothing reports that a call
 *     finished, let alone that it failed. So there is no finished label, no
 *     `com_ui_tool_failed` suffix and no cancelled icon to swap in.
 *   - `durationMs` (`PartMetadata.runStepDurationMs`) — not on our wire, so the
 *     `· 1.4s` reading and its `sr-only` spoken twin render nothing.
 *   - `hasInput` / `isExpanded` / `onClick` — the donor's line is a DISCLOSURE
 *     that opens an input/output panel. We have neither payload (see
 *     ToolCallsSection's header), so there is nothing to disclose and the line
 *     is not a button.
 *   - `@radix-ui/react-popover` — the `popover` variant's Trigger. Not a
 *     dependency here and it wraps the disclosure we do not have.
 *
 * What IS taken from ProgressText, and is visible in ToolStatusLine below: its
 * `shimmer` on the running label, its `min-w-0 truncate font-medium` on the
 * label span, and its rule that the SUBTITLE takes essentially all of the
 * shrink (`shrink-[100]`) because the label names the card and must stay whole.
 * That is three class decisions out of 158 lines, which is the honest size of
 * the harvest here.
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
import { AgentMark, MessageRow } from './MessageRow';

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
      isCreatedByUser={false}
      icon={<AgentMark name={agentName} />}
      label={agentName}
      headerPrefix="Assistant: "
      ariaLabel="Assistant message"
      // No timestamp: the live turn has not landed one, and the donor's
      // MessageTimestamp renders nothing at all for a null value — which is
      // what keeps the header the SAME height before and after the stream ends.
      timestamp={null}
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
      {/* Donor ProgressText.tsx:117 — `min-w-0 truncate font-medium` on the
          running label. The weight is the part that matters: this line sits
          above prose at the same size, and without it the status reads as the
          reply's first sentence. */}
      <span class="min-w-0 truncate font-medium">{status}</span>
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
