/*
 * `date-fns` — the eight functions `utils/convos.ts` imports, hand-written.
 *
 * Aliased as the bare specifier `date-fns` in BOTH web/vite.config.ts
 * (`resolve.alias`) and web/tsconfig.json (`paths`), so the donor's import
 * block (its lines 3-12) is copied unmodified.
 *
 * ── Why a shim and not the package ────────────────────────────────────────
 *
 * `date-fns` is not a dependency of this app, and the chat chunk carries a
 * gzip budget — the same budget that rejected the donor's markdown pipeline
 * (111 kB gzip against the 12.87 kB we ship). Each function below is three to
 * six lines of plain `Date` arithmetic and none of them is the interesting
 * part; the interesting part is the donor's bucket ladder, which is what the
 * copy exists to take.
 *
 * THREE OF THE EIGHT ARE LIFTED, not written fresh: `startOfDay`, `startOfYear`
 * and `isWithinInterval` are the hand-written predicates that already lived
 * inside web/src/components/chat/conversation-groups.ts, moved here so there is
 * one copy rather than two. Their bodies are unchanged; only the signatures
 * differ, because date-fns takes and returns `Date` where the old private
 * versions took and returned epoch milliseconds.
 *
 * ── The subset is deliberate ──────────────────────────────────────────────
 *
 * This is not a date-fns implementation. It is exactly the surface one donor
 * file uses, at exactly the fidelity that file needs. `format` in particular
 * supports the tokens listed on it and passes anything else through as a
 * literal, which is what the real date-fns does for unrecognised characters
 * anyway — but the honest statement is that only `'MMMM'` is exercised here.
 */

const DAY_MS = 86_400_000;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Local midnight, so "today" means the reader's today rather than UTC's. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function startOfYear(date: Date): Date {
  return new Date(date.getFullYear(), 0, 1);
}

export function subDays(date: Date, amount: number): Date {
  return new Date(date.getTime() - amount * DAY_MS);
}

export function getYear(date: Date): number {
  return date.getFullYear();
}

export function isToday(date: Date): boolean {
  return startOfDay(date).getTime() === startOfDay(new Date(Date.now())).getTime();
}

/** Inclusive at both ends, as date-fns' is. */
export function isWithinInterval(date: Date, interval: { start: Date; end: Date }): boolean {
  const t = date.getTime();
  return t >= interval.start.getTime() && t <= interval.end.getTime();
}

/**
 * date-fns `parseISO`. The real one accepts partial ISO forms; this defers to
 * `new Date(...)`, which handles the full ISO-8601 strings the donor's callers
 * produce. An unparseable value yields an Invalid Date, exactly as date-fns
 * does, so callers that guard on `isNaN` behave identically.
 */
export function parseISO(value: string): Date {
  return new Date(value);
}

/**
 * date-fns `format`, restricted to the tokens the ported code uses:
 *
 *   MMMM  full month name        yyyy  four-digit year
 *   MMM   short month name       MM    zero-padded month
 *   dd    zero-padded day        HH    zero-padded hour (24h)
 *   mm    zero-padded minute
 *
 * Only `'MMMM'` is exercised by the ported tree (donor convos.ts:52). The month
 * names are English because this app ships no localizer; the donor lowercases
 * the result and uses it as an i18n key, and the adapter that consumes it maps
 * that key back to an English label.
 */
export function format(date: Date, pattern: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return pattern.replace(/MMMM|MMM|yyyy|MM|dd|HH|mm/g, (token) => {
    switch (token) {
      case 'MMMM':
        return MONTHS[date.getMonth()];
      case 'MMM':
        return MONTHS[date.getMonth()].slice(0, 3);
      case 'yyyy':
        return String(date.getFullYear());
      case 'MM':
        return pad(date.getMonth() + 1);
      case 'dd':
        return pad(date.getDate());
      case 'HH':
        return pad(date.getHours());
      case 'mm':
        return pad(date.getMinutes());
      default:
        return token;
    }
  });
}
