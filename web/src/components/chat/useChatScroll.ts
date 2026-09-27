/*
 * Behaviour ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/hooks/Messages/useMessageScrolling.ts` and
 * `client/src/components/Messages/ScrollToBottom.tsx`.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * The transcript rides the end of a streaming answer, and STOPS riding it the
 * moment the reader scrolls away — permanently, until they come back. Two
 * failure modes bracket this, and both are worse than no auto-scroll at all:
 *
 *   - never letting go: the reader scrolls up to re-read a code block and the
 *     next token yanks them back to the bottom. The page fights them.
 *   - never picking it back up: they scroll to the end to watch the answer and
 *     it keeps growing past the fold anyway.
 *
 * ── Why the thresholds are asymmetric (the donor's insight) ────────────────
 *
 * Arriving is judged from 150px out, leaving from 24px. That looks arbitrary
 * and is not. While an answer streams the end is a MOVING TARGET: it recedes
 * between the reader's last wheel tick and the frame that measures it, so a
 * reader who scrolls all the way down still lands tens of pixels short of the
 * bottom. Judging arrival as tightly as departure means they can never quite
 * catch the stream. Judging departure as loosely as arrival means a one-line
 * nudge unsticks them.
 *
 * ── Why direction is read from scrollTop, not from the wheel ───────────────
 *
 * A wheel event is one of several ways to move a scroller (trackpad, dragged
 * scrollbar, PageUp, a focused element scrolling itself into view). Comparing
 * successive `scrollTop` samples covers all of them with one rule.
 *
 * The first sample is thrown away deliberately. A transcript opens already
 * scrolled to its end, so the first event carries a large positive scrollTop
 * with nothing to compare against; measuring it from 0 reads as a big move
 * DOWN, and the gesture that actually produced it — the reader pushing up and
 * away — is swallowed. `lastTopRef` starts at -1 to mean "no baseline yet".
 *
 * ── Why streaming scrolls instantly and a settled turn scrolls smoothly ────
 *
 * A smooth scroll is an animation with a duration. Restarting one on every
 * cumulative chunk (tens per second) means it never lands, and the transcript
 * appears to drift and stutter. While tokens arrive, the end is pinned by
 * assignment; only the discrete events — a turn committed, a conversation
 * opened — are worth animating, and even then only when the reader has not
 * asked for reduced motion.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/** Coming back: generous, because the end recedes while an answer streams. */
const ATTACH_PX = 150;
/** Leaving: tight, so an intentional nudge upward is obeyed immediately. */
const DETACH_PX = 24;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface ChatScrollInput {
  /**
   * Any value that changes when the transcript's height changes — turn count,
   * streamed length, status line. Recomputed by the caller each render; this
   * hook only cares that it differs.
   */
  revision: string;
  /** True while a turn is in flight. */
  streaming: boolean;
}

interface ChatScroll {
  /** Attach to the scroll container (ChatCanvas). */
  scrollRef: { current: HTMLDivElement | null };
  /** Attach to the zero-height sentinel at the foot of the transcript. */
  endRef: { current: HTMLDivElement | null };
  /** True when the reader has left the end — show the affordance. */
  showJump: boolean;
  /** Take them back and re-attach to the stream. */
  jumpToBottom: () => void;
}

export function useChatScroll({ revision, streaming }: ChatScrollInput): ChatScroll {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // The single authority for "is the transcript riding the end". A ref, not
  // state: it is written from a scroll handler that can fire many times a
  // frame, and nothing about it needs to paint on its own.
  const stuckRef = useRef(true);
  const lastTopRef = useRef(-1);
  const [showJump, setShowJump] = useState(false);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stuckRef.current = true;
    setShowJump(false);
    el.scrollTo({
      top: el.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      const top = el.scrollTop;
      const previous = lastTopRef.current;
      lastTopRef.current = top;
      // No baseline yet (see the header note) — take this sample and judge
      // direction from the next one.
      if (previous < 0) return;

      const distance = el.scrollHeight - top - el.clientHeight;
      const movingDown = top >= previous;
      if (movingDown) {
        if (distance <= ATTACH_PX) stuckRef.current = true;
      } else if (distance > DETACH_PX) {
        stuckRef.current = false;
      }
      setShowJump(!stuckRef.current && distance > ATTACH_PX);
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Sending re-attaches. The reader who just pressed Send is asking to watch
  // the answer, whatever they were reading a second ago.
  useEffect(() => {
    if (!streaming) return;
    stuckRef.current = true;
    setShowJump(false);
  }, [streaming]);

  useEffect(() => {
    if (!stuckRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    if (streaming) {
      // Pinned by assignment, not animated — see the header note.
      el.scrollTop = el.scrollHeight;
      lastTopRef.current = el.scrollTop;
      return;
    }
    // The sticky composer follows the end marker inside this scrollport.
    // Scrolling the marker into the viewport can leave the reply underneath
    // that plate; the scrollport's actual end reserves the plate's full height.
    el.scrollTo({
      top: el.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    lastTopRef.current = el.scrollTop;
  }, [revision, streaming]);

  return { scrollRef, endRef, showJump, jumpToBottom };
}
