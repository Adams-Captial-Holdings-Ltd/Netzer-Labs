/*
 * Date grouping for the conversation sidebar.
 *
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor path
 * `client/src/utils/convos.ts` (`getGroupName` + `groupConversationsByDate`).
 *
 * What is ported: the bucket LADDER and its order — today, yesterday, the last
 * 7 days, the last 30 days, then a month name per month earlier in this year,
 * then a bucket per earlier year — the newest-first ordering of the buckets
 * that are not fixed, and the newest-first sort WITHIN each bucket. That
 * ladder is the donor's contribution and it is reproduced exactly, including
 * its overlaps (a row from three days ago satisfies both the 7-day and the
 * 30-day window; first match wins, so it lands in the 7-day bucket).
 *
 * What is NOT ported, and why it is hand-written instead: the donor's
 * predicates are seven `date-fns` imports (`isToday`, `subDays`, `getYear`,
 * `parseISO`, `startOfDay`, `startOfYear`, `isWithinInterval`) plus `format`
 * for the month name. `date-fns` is not a dependency of this app and the chat
 * chunk carries a gzip budget (plan decision 1 rejected a 111 kB markdown
 * pipeline for the same reason), so the six predicates below are plain `Date`
 * arithmetic — each one is three lines and none of them is the interesting
 * part. The donor's i18n keys (`com_ui_date_today`) are likewise replaced by
 * the English labels this product ships, because there is no localizer here.
 *
 * The donor also drops pinned rows out of the date groups into a section of
 * their own. This product has no pinning, so that filter has no analogue and
 * is not carried over.
 *
 * INPUT UNITS. `Conversation.updatedAt` is EPOCH SECONDS — the unit
 * `src/lib/state/sessions-repo.ts` writes ("updatedAt: epoch seconds") and the
 * unit `relativeAge()` in ../../lib/chat/helpers.ts already reads. The donor's
 * field is an ISO string; that is the one shape difference, and it is why
 * `parseISO` has no counterpart here.
 */

import type { Conversation } from '../../lib/chat/types';

/** A labelled bucket of conversations, in the order it should be rendered. */
export type ConversationGroup = { label: string; conversations: Conversation[] };

// Donor `dateKeys`, with this product's English labels standing in for the
// donor's translation keys. The four fixed buckets keep the donor's order.
const TODAY = 'Today';
const YESTERDAY = 'Yesterday';
const PREVIOUS_7_DAYS = 'Previous 7 days';
const PREVIOUS_30_DAYS = 'Previous 30 days';

/** Donor `dateGroupsSet` — the buckets that are pinned to the top, in order. */
const FIXED_GROUPS = [TODAY, YESTERDAY, PREVIOUS_7_DAYS, PREVIOUS_30_DAYS];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_MS = 86_400_000;

/** date-fns `startOfDay`, hand-written. Local midnight, so "today" means the
 *  reader's today rather than UTC's. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** date-fns `startOfYear`, hand-written. */
function startOfYear(d: Date): number {
  return new Date(d.getFullYear(), 0, 1).getTime();
}

/** date-fns `isWithinInterval`, hand-written — inclusive at both ends, as the
 *  donor's is. */
function isWithin(t: number, start: number, end: number): boolean {
  return t >= start && t <= end;
}

/*
 * Donor `getGroupName`, clause for clause. The order of the tests is load
 * bearing: the windows deliberately overlap and the FIRST match wins.
 */
function groupName(t: number, now: number): string {
  const date = new Date(t);
  const nowDate = new Date(now);
  if (startOfDay(date) === startOfDay(nowDate)) return TODAY;
  if (isWithin(t, startOfDay(nowDate) - DAY_MS, now)) return YESTERDAY;
  if (isWithin(t, now - 7 * DAY_MS, now)) return PREVIOUS_7_DAYS;
  if (isWithin(t, now - 30 * DAY_MS, now)) return PREVIOUS_30_DAYS;
  if (isWithin(t, startOfYear(nowDate), now)) return MONTHS[date.getMonth()];
  // Donor: `' ' + getYear(date)`. The leading space is what sorts year buckets
  // apart from month buckets in its comparator; this port sorts on a numeric
  // key instead (see below), so the label is just the year.
  return String(date.getFullYear());
}

/*
 * Donor `groupConversationsByDate`: dedupe by id, bucket by `getGroupName`,
 * emit the fixed buckets first in their declared order, then the year/month
 * buckets newest-first, and sort every bucket's rows newest-first.
 *
 * The donor's month/year comparator parses the label back out of the string
 * (`parseInt(a.trim())` for the year, a `monthOrderMap` lookup for the month).
 * This port keeps the newest timestamp seen in each bucket instead and sorts on
 * that number — same resulting order, and it cannot be broken by a label that
 * happens to parse as a number.
 */
export function groupConversationsByDate(
  conversations: Conversation[],
  nowMs: number = Date.now(),
): ConversationGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, Conversation[]>();
  // Newest row seen per bucket, for ordering the non-fixed buckets.
  const newest = new Map<string, number>();

  for (const c of conversations) {
    if (!c || seen.has(c.chatId)) continue;
    seen.add(c.chatId);
    // A row with no (or a nonsense) timestamp is filed under "today" rather
    // than dropped — the donor does the same with `date = now`. It is still a
    // real conversation and must stay reachable.
    const secs = Number(c.updatedAt);
    const t = Number.isFinite(secs) && secs > 0 ? secs * 1000 : nowMs;
    const label = groupName(t, nowMs);
    const bucket = groups.get(label);
    if (bucket) bucket.push(c);
    else groups.set(label, [c]);
    newest.set(label, Math.max(newest.get(label) ?? 0, t));
  }

  const ordered: ConversationGroup[] = [];
  for (const label of FIXED_GROUPS) {
    const rows = groups.get(label);
    if (rows) ordered.push({ label, conversations: rows });
  }
  const rest = [...groups.keys()]
    .filter((label) => !FIXED_GROUPS.includes(label))
    .sort((a, b) => (newest.get(b) ?? 0) - (newest.get(a) ?? 0));
  for (const label of rest) {
    ordered.push({ label, conversations: groups.get(label) as Conversation[] });
  }

  for (const group of ordered) {
    group.conversations.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  return ordered;
}
