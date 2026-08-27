/*
 * Copied from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e -- donor path
 * `client/src/utils/messages.ts`, lines 607-696 only.
 *
 * That file is 900+ lines of message-tree surgery; this is the timestamp
 * formatter out of the middle of it, which is the part MessageTimestamp.tsx
 * needs. Everything below is byte-for-byte from the donor except:
 *
 *   - the donor's `import { LocalStorageKeys } from 'librechat-data-provider'`
 *     and the rest of the file's imports are dropped -- none of the 90 lines
 *     kept here uses any of them.
 *
 * That is the whole edit list. The formatter itself is Intl-only, which is why
 * it lifts cleanly: `Intl.RelativeTimeFormat` for the relative form,
 * `Intl.DateTimeFormat` for the absolute one, and no dependency on the donor's
 * i18n layer at all.
 */

export type MessageTimestamp = {
  /** Localized relative time, e.g. "2 hours ago". */
  relative: string;
  /** Localized absolute date and time, e.g. "Jun 12, 2026, 3:42 PM". */
  absolute: string;
  /** ISO 8601 string for the `<time>` element's `dateTime` attribute. */
  iso: string;
  /**
   * True when the message is recent enough that the relative form ("10 minutes ago")
   * reads better than the absolute date. Past this window the absolute date is clearer.
   */
  isRecent: boolean;
};

/** Below this age the relative form is preferred over the absolute date. */
const RECENT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Returns true when `value` parses to a valid date. */
export const isValidTimestamp = (value?: string | null): value is string => {
  if (!value) {
    return false;
  }
  return !Number.isNaN(new Date(value).getTime());
};

const RELATIVE_TIME_DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

/** Returns the locale only when it is a syntactically valid BCP-47 tag, else undefined. */
const resolveLocale = (locale?: string): string | undefined => {
  if (!locale) {
    return undefined;
  }
  try {
    Intl.DateTimeFormat.supportedLocalesOf(locale);
    return locale;
  } catch {
    return undefined;
  }
};

const formatRelativeTime = (from: Date, to: Date, locale?: string): string => {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  let duration = (from.getTime() - to.getTime()) / 1000;
  for (const division of RELATIVE_TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return formatter.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return formatter.format(Math.round(duration), 'year');
};

/**
 * Formats a message timestamp into locale-aware relative and absolute strings.
 * Returns null when the value is missing or unparseable, so callers can skip
 * rendering the timestamp entirely.
 */
export const getMessageTimestamp = (
  value?: string | null,
  locale?: string,
  hour12?: boolean,
): MessageTimestamp | null => {
  if (!isValidTimestamp(value)) {
    return null;
  }

  const date = new Date(value);
  const now = new Date(Date.now());
  const safeLocale = resolveLocale(locale);

  return {
    iso: date.toISOString(),
    relative: formatRelativeTime(date, now, safeLocale),
    absolute: new Intl.DateTimeFormat(safeLocale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      hour12,
    }).format(date),
    isRecent: Math.abs(now.getTime() - date.getTime()) < RECENT_THRESHOLD_MS,
  };
};
