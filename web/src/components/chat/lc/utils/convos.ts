/*
 * Copied from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e -- donor path
 * `client/src/utils/convos.ts`, lines 3-12 (the date-fns import) and 17-146
 * (`dateKeys`, `getGroupName`, the comparator tables and
 * `groupConversationsByDate`).
 *
 * Lines 148-796 of the donor file are react-query infinite-cache surgery
 * (`addConversation`, `updateConvoFields`, `deleteConversation`, the cursor
 * page walkers). There is no react-query here -- `/sessions` returns one capped
 * array per agent, already sorted -- so none of it has a counterpart and none
 * of it is copied.
 *
 * ── The edit list, in full ────────────────────────────────────────────────
 *
 * Everything below the import block is the donor's, line for line, except for
 * these SIX changes. Four are `strict` mode (the donor's tsconfig is looser
 * than this app's), two are the missing workspace package.
 *
 *   1. `TConversation` and `GroupedConversations` are declared locally.
 *      The donor imports them from `librechat-data-provider` (its line 13),
 *      which is not on disk. The two declarations are structural stand-ins
 *      carrying exactly the fields the copied code reads.
 *   2. `dateKeys` gains `: Record<string, string>`. The donor indexes it with
 *      a computed month name (`dateKeys[month]`, its line 53); without the
 *      annotation that is TS7053 under `noImplicitAny`.
 *   3. `new Map()` -> `new Map<string, TConversation[]>()` (twice: `groups`
 *      and `sortedGroups`). The donor's bare `Map` is `Map<any, any>`.
 *   4. `groups.get(groupName).push(conversation)` -> a `?? []`-guarded local.
 *      `Map.get` is `T | undefined` under `strict`.
 *   5. `sortedGroups.set(group, groups.get(group))` gains the same guard, for
 *      the same reason.
 *   6. `conversations.sort((a: TConversation, b: TConversation) => ...)` keeps
 *      the donor's cast but the callback parameter of `sortedGroups.forEach`
 *      is now typed, since the Map is.
 *
 * ── What is NOT changed, and is the reason to copy at all ─────────────────
 *
 * The bucket LADDER and its overlaps. `getGroupName`'s tests deliberately
 * overlap -- a row from three days ago satisfies the 7-day window and the
 * 30-day window both -- and FIRST MATCH WINS, so it lands in the 7-day bucket.
 * The fixed buckets emit in declaration order; the month and year buckets sort
 * newest-first by parsing the label back out (`parseInt(a.trim())` for a year,
 * `monthOrderMap` for a month), which is why `getGroupName` prefixes a year
 * with a space. Every row inside a bucket sorts newest-first.
 *
 * That ladder is the donor's contribution and it is reproduced exactly,
 * including the label-parsing comparator this repo's previous hand-written
 * version had replaced with a numeric key. The i18n keys are kept as the donor
 * emits them; `../../conversation-groups.ts` is the adapter that maps this
 * app's `Conversation` shape in and English labels out.
 */

/**
 * Structural stand-in for the donor's `TConversation` (edit 1). Only the
 * fields the copied code below actually reads are declared, so the adapter
 * cannot quietly stop supplying one.
 */
export type TConversation = {
  conversationId: string;
  /** ISO 8601. The donor's wire field; the adapter converts. */
  updatedAt?: string;
  createdAt?: string;
  pinned?: boolean;
};

/** The donor's `GroupedConversations` (edit 1): label first, rows second. */
export type GroupedConversations = Array<[string, TConversation[]]>;

import {
  format,
  isToday,
  subDays,
  getYear,
  parseISO,
  startOfDay,
  startOfYear,
  isWithinInterval,
} from 'date-fns';

// Date group helpers
export const dateKeys: Record<string, string> = {
  today: 'com_ui_date_today',
  yesterday: 'com_ui_date_yesterday',
  previous7Days: 'com_ui_date_previous_7_days',
  previous30Days: 'com_ui_date_previous_30_days',
  january: 'com_ui_date_january',
  february: 'com_ui_date_february',
  march: 'com_ui_date_march',
  april: 'com_ui_date_april',
  may: 'com_ui_date_may',
  june: 'com_ui_date_june',
  july: 'com_ui_date_july',
  august: 'com_ui_date_august',
  september: 'com_ui_date_september',
  october: 'com_ui_date_october',
  november: 'com_ui_date_november',
  december: 'com_ui_date_december',
};

const getGroupName = (date: Date) => {
  const now = new Date(Date.now());
  if (isToday(date)) {
    return dateKeys.today;
  }
  if (isWithinInterval(date, { start: startOfDay(subDays(now, 1)), end: now })) {
    return dateKeys.yesterday;
  }
  if (isWithinInterval(date, { start: subDays(now, 7), end: now })) {
    return dateKeys.previous7Days;
  }
  if (isWithinInterval(date, { start: subDays(now, 30), end: now })) {
    return dateKeys.previous30Days;
  }
  if (isWithinInterval(date, { start: startOfYear(now), end: now })) {
    const month = format(date, 'MMMM').toLowerCase();
    return dateKeys[month];
  }
  return ' ' + getYear(date).toString();
};

const monthOrderMap = new Map([
  ['december', 11],
  ['november', 10],
  ['october', 9],
  ['september', 8],
  ['august', 7],
  ['july', 6],
  ['june', 5],
  ['may', 4],
  ['april', 3],
  ['march', 2],
  ['february', 1],
  ['january', 0],
]);
const dateKeysReverse = Object.fromEntries(Object.entries(dateKeys).map(([k, v]) => [v, k]));
const dateGroupsSet = new Set([
  dateKeys.today,
  dateKeys.yesterday,
  dateKeys.previous7Days,
  dateKeys.previous30Days,
]);

export const groupConversationsByDate = (
  conversations: Array<TConversation | null>,
  dateField: 'updatedAt' | 'createdAt' = 'updatedAt',
): GroupedConversations => {
  if (!Array.isArray(conversations)) {
    return [];
  }
  const seenConversationIds = new Set();
  const groups = new Map<string, TConversation[]>();
  const now = new Date(Date.now());

  conversations.forEach((conversation) => {
    if (
      !conversation ||
      seenConversationIds.has(conversation.conversationId) ||
      conversation.pinned
    ) {
      return;
    }
    seenConversationIds.add(conversation.conversationId);

    let date: Date;
    const dateValue = conversation[dateField] ?? conversation.updatedAt ?? conversation.createdAt;
    if (dateValue) {
      date = parseISO(dateValue);
    } else {
      date = now;
    }
    const groupName = getGroupName(date);
    if (!groups.has(groupName)) {
      groups.set(groupName, []);
    }
    (groups.get(groupName) ?? []).push(conversation);
  });

  const sortedGroups = new Map<string, TConversation[]>();
  dateGroupsSet.forEach((group) => {
    const rows = groups.get(group);
    if (rows) {
      sortedGroups.set(group, rows);
    }
  });

  const yearMonthGroups = Array.from(groups.keys())
    .filter((group) => !dateGroupsSet.has(group))
    .sort((a, b) => {
      const [yearA, yearB] = [parseInt(a.trim()), parseInt(b.trim())];
      if (yearA !== yearB) {
        return yearB - yearA;
      }
      const [monthA, monthB] = [dateKeysReverse[a], dateKeysReverse[b]];
      const bOrder = monthOrderMap.get(monthB) ?? -1,
        aOrder = monthOrderMap.get(monthA) ?? -1;
      return bOrder - aOrder;
    });
  yearMonthGroups.forEach((group) => {
    sortedGroups.set(group, groups.get(group) ?? []);
  });

  sortedGroups.forEach((conversations) => {
    conversations.sort(
      (a: TConversation, b: TConversation) =>
        new Date(b[dateField] ?? b.updatedAt ?? 0).getTime() -
        new Date(a[dateField] ?? a.updatedAt ?? 0).getTime(),
    );
  });
  return Array.from(sortedGroups, ([key, value]) => [key, value]);
};
