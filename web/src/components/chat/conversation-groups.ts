/*
 * Date grouping for the conversation sidebar.
 *
 * ── This file is now an ADAPTER, not an implementation ─────────────────────
 *
 * The ladder itself — today, yesterday, the last 7 days, the last 30 days,
 * then a month per month earlier this year, then a bucket per earlier year,
 * with the overlaps resolved first-match-wins and every bucket sorted
 * newest-first — is the donor's, and it now lives as the donor's own code at
 * ./lc/utils/convos.ts (`client/src/utils/convos.ts` lines 3-12 and 17-146,
 * 135 of 142 lines byte-for-byte). This file used to be a hand-written
 * transcription of that ladder; it is now the shape translation that the
 * transcription existed to avoid.
 *
 * Three differences separate this app's data from the donor's, and each one is
 * exactly one step of the adapter:
 *
 *   1. UNITS. `Conversation.updatedAt` is EPOCH SECONDS — the unit
 *      src/lib/state/sessions-repo.ts writes and the unit `relativeAge()` in
 *      ../../lib/chat/helpers.ts already reads. The donor's field is an ISO
 *      string, which is why it can call `parseISO`. `toDonor()` converts.
 *   2. IDENTITY. The donor dedupes on `conversationId`; ours is `chatId`.
 *   3. LABELS. The donor emits i18n keys (`com_ui_date_today`) and, for a year,
 *      the year prefixed with a space — that space is load-bearing inside its
 *      comparator, which parses the label back out to sort. `LABELS` below maps
 *      the keys to the English strings this product ships (there is no
 *      localizer here) and trims the year.
 *
 * The sidebar separates pinned rows before calling this date grouping adapter.
 *
 * ── One deliberate loss ────────────────────────────────────────────────────
 *
 * The previous hand-written version took a `nowMs` parameter so "today" could
 * be pinned in a test. The donor reads `Date.now()` inside `getGroupName` and
 * offers no injection point, so taking the donor's code means losing that
 * seam. It is dropped rather than kept-and-ignored: no caller passed it
 * (ConversationSidebar.tsx calls with one argument) and no test covered it, and
 * a parameter that silently does nothing is worse than one that is gone.
 */

import type { Conversation } from '../../lib/chat/types';
import {
  dateKeys,
  groupConversationsByDate as groupDonorConversationsByDate,
  type TConversation,
} from './lc/utils/convos';

/** A labelled bucket of conversations, in the order it should be rendered. */
export type ConversationGroup = { label: string; conversations: Conversation[] };

/**
 * The donor's i18n keys, resolved to the English labels this product ships.
 * Built from the donor's own `dateKeys` table so a key it adds cannot silently
 * fall through as a raw `com_ui_date_*` string on screen — anything unmapped
 * lands in the trim-the-key fallback below instead.
 */
const LABELS: Record<string, string> = {
  [dateKeys.today]: 'Today',
  [dateKeys.yesterday]: 'Yesterday',
  [dateKeys.previous7Days]: 'Previous 7 days',
  [dateKeys.previous30Days]: 'Previous 30 days',
  [dateKeys.january]: 'January',
  [dateKeys.february]: 'February',
  [dateKeys.march]: 'March',
  [dateKeys.april]: 'April',
  [dateKeys.may]: 'May',
  [dateKeys.june]: 'June',
  [dateKeys.july]: 'July',
  [dateKeys.august]: 'August',
  [dateKeys.september]: 'September',
  [dateKeys.october]: 'October',
  [dateKeys.november]: 'November',
  [dateKeys.december]: 'December',
};

/**
 * Epoch seconds -> the ISO string the donor's `parseISO` expects.
 *
 * A row with no (or a nonsense) timestamp is left WITHOUT one rather than
 * dropped: the donor's own fallback is `date = now`, so an untimed row files
 * under "today" and stays reachable. That is the same outcome the previous
 * hand-written version documented, reached by the donor's own branch instead
 * of by a local guard.
 */
function toDonor(c: Conversation): TConversation {
  const secs = Number(c.updatedAt);
  const valid = Number.isFinite(secs) && secs > 0;
  return {
    conversationId: c.chatId,
    updatedAt: valid ? new Date(secs * 1000).toISOString() : undefined,
  };
}

export function groupConversationsByDate(conversations: Conversation[]): ConversationGroup[] {
  // Keyed by the id the donor dedupes on, so the donor's output — which carries
  // only its own row shape — can be mapped back to this app's rows.
  const byId = new Map<string, Conversation>();
  const donorRows: TConversation[] = [];
  for (const c of conversations) {
    if (!c) continue;
    byId.set(c.chatId, c);
    donorRows.push(toDonor(c));
  }

  return groupDonorConversationsByDate(donorRows).map(([key, rows]) => ({
    // `key.trim()` is what turns the donor's year label (`' 2025'`, spaced so
    // its comparator can tell a year from a month) back into a heading.
    label: LABELS[key] ?? key.trim(),
    conversations: rows
      .map((r) => byId.get(r.conversationId))
      .filter((c): c is Conversation => c !== undefined),
  }));
}
