/*
 * The transcript's one frame — now the DONOR'S implementation of it.
 *
 * This file used to hand-write the row (its lines 55-91). Those 37 lines are
 * gone; what stands in their place is
 * `./lc/components/Chat/Messages/ui/MessageRow.tsx`, copied from
 * danny-avila/LibreChat (MIT) at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e, donor path
 * `client/src/components/Chat/Messages/ui/MessageRow.tsx` — three edits,
 * itemised in that file's own header. Its sibling `SubRow.tsx` (19 lines) is
 * byte-for-byte.
 *
 * The rationale below is kept HERE, above the re-export, because it is the
 * reason the frame is shaped the way it is and it is the thing a future change
 * has to argue with. Nothing in it changed; the donor's row implements all of
 * it, which is precisely why the copy was worth taking.
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
 * the drift that file was written to delete. That is edit 1 in the donor copy —
 * the donor's own `getMessageRowWidthClass` is deleted for exactly this reason.
 *
 * ── What the copy BOUGHT that the hand-written frame did not have ──────────
 *
 * The author line moved INSIDE the row. It used to be a node the caller built
 * and passed as `header`; the donor's row builds it from `icon`, `label`,
 * `hoverLabel` and `timestamp`, which is what makes the two harvested header
 * components reachable at all:
 *
 *   HeaderLabel.tsx (81 lines, verbatim) — crossfades the agent name to the
 *     model that answered, both in one grid cell so neither reflows the header.
 *   MessageTimestamp.tsx (99 lines, 3 edited) — a real `<time dateTime>` that
 *     reads "5 minutes ago" while a turn is recent and the absolute date after,
 *     with only the recent rows subscribed to a shared minute ticker.
 */
export { default as MessageRow } from './lc/components/Chat/Messages/ui/MessageRow';

/** Up to two initials for the agent mark ("Netzar Prime" → "NP"). */
export function agentInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

/**
 * The agent's mark, passed as the donor row's `icon`. Two initials rather than
 * an avatar, because WHICH of the seventeen agents answered is a governance
 * fact and there is no per-agent image to serve.
 *
 * Shared by AssistantMessage and StreamingRow so the live turn is introduced by
 * exactly the mark the settled turn keeps. `rounded-md`, not the donor's
 * `rounded-full`: the donor's slot is a circular avatar, and a two-letter
 * monogram in a circle crops its own descenders at this size.
 */
export function AgentMark({ name }: { name: string }) {
  return (
    <span
      class="flex size-6 shrink-0 items-center justify-center rounded-md border border-primary-a/25
        bg-primary-a/10 text-[10px] font-bold leading-none tracking-tight text-primary-a"
    >
      {agentInitials(name)}
    </span>
  );
}

/**
 * Epoch SECONDS → the ISO string the donor's MessageTimestamp expects.
 *
 * `Message.ts` is minted as `Date.now() / 1000` by both the transcript loader
 * and the send path. Returns null for a missing or nonsense value, which is the
 * shape MessageTimestamp's own `isValidTimestamp` guard treats as "render no
 * timestamp at all".
 */
export function isoFromEpochSeconds(ts: number | undefined): string | null {
  if (ts === undefined) return null;
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
